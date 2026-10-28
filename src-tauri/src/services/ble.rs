use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use btleplug::api::{Central, Characteristic, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager as BtleManager, Peripheral};
use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::permission::PermissionState;

use crate::host_error::{HostError, DEVICE_UNAVAILABLE, INVALID_STATE, SCAN_START};

const HR_SERVICE: Uuid = Uuid::from_u128(0x0000180d_0000_1000_8000_00805f9b34fb);
const HR_MEASUREMENT: Uuid = Uuid::from_u128(0x00002a37_0000_1000_8000_00805f9b34fb);

/// BLE 服务：btleplug（WinRT 后端）
/// - 扫描：轮询发现的外设，去重后向所有窗口广播 ble:device-found
/// - 连接：GATT 0x180D 服务订阅 0x2A37 心率通知，解析后广播 ble:heart-rate
pub struct BleState {
    core: Mutex<Option<Core>>,
    connected: Mutex<Option<String>>,
    /// 每次连接自增。通知流退出时只清理属于自己那一代的记录，
    /// 否则会抹掉更新的连接（同设备重连尤其明显）
    generation: AtomicU64,
    scanning: Arc<AtomicBool>,
    notify_task: Mutex<Option<(u64, tauri::async_runtime::JoinHandle<()>)>>,
}

struct Core {
    _manager: BtleManager,
    adapter: Adapter,
    /// 扫描期间累积的外设句柄，供按 id 连接
    peripherals: HashMap<String, Peripheral>,
    seen: HashSet<String>,
}

#[derive(Serialize, Clone)]
pub struct DeviceFound {
    pub id: String,
    pub name: Option<String>,
    pub rssi: Option<i16>,
}

#[derive(Serialize, Clone)]
pub struct HeartRate {
    pub bpm: u16,
    pub device_id: String,
}

impl BleState {
    pub fn new() -> Self {
        Self {
            core: Mutex::new(None),
            connected: Mutex::new(None),
            generation: AtomicU64::new(0),
            scanning: Arc::new(AtomicBool::new(false)),
            notify_task: Mutex::new(None),
        }
    }
}

fn parse_heart_rate(data: &[u8]) -> Option<u16> {
    if data.len() < 2 {
        return None;
    }
    let bpm = if data[0] & 0x01 != 0 {
        if data.len() < 3 {
            return None;
        }
        u16::from_le_bytes([data[1], data[2]])
    } else {
        data[1] as u16
    };
    (1..=250).contains(&bpm).then_some(bpm)
}

fn find_hr_char(peripheral: &Peripheral) -> Option<Characteristic> {
    peripheral
        .characteristics()
        .into_iter()
        .find(|c| c.uuid == HR_MEASUREMENT)
}

/// 通知流任务：流结束（断开）后自清理。
/// `gen` 是本次连接的代际号：只有仍属于自己那一代时才清状态，
/// 否则同设备重连后，旧流退出会把新连接的状态抹掉。
async fn notify_pump(app: AppHandle, peripheral: Peripheral, device_id: String, gen: u64) {
    // 无论走到哪条退出路径，都要把「我这一代」的连接记录清掉：
    // 否则 ble_connect 已经成功、但订阅失败时 ble_connected_device 会永久谎报已连接
    let hr_char = match find_hr_char(&peripheral) {
        Some(c) => c,
        None => {
            fail_pump(&app, &device_id, gen, "设备没有心率服务 (0x180D)").await;
            return;
        }
    };
    if let Err(e) = peripheral.subscribe(&hr_char).await {
        fail_pump(&app, &device_id, gen, &format!("订阅心率通知失败: {e}")).await;
        return;
    }
    let mut stream = match peripheral.notifications().await {
        Ok(s) => s,
        Err(e) => {
            fail_pump(&app, &device_id, gen, &format!("打开通知流失败: {e}")).await;
            return;
        }
    };
    while let Some(item) = stream.next().await {
        if item.uuid == HR_MEASUREMENT {
            if let Some(bpm) = parse_heart_rate(&item.value) {
                let _ = app.emit(
                    "ble:heart-rate",
                    HeartRate {
                        bpm,
                        device_id: device_id.clone(),
                    },
                );
            }
        }
    }
    let _ = app.emit("ble:disconnected", device_id.clone());
    clear_generation(&app, &device_id, gen).await;
}

/// 订阅前就失败：报错误 + 报断开，并清掉这一代的连接状态
async fn fail_pump(app: &AppHandle, device_id: &str, gen: u64, reason: &str) {
    let _ = app.emit("ble:error", reason);
    let _ = app.emit("ble:disconnected", device_id.to_string());
    clear_generation(app, device_id, gen).await;
}

/// 通知流退出时该不该清掉 task 槽位：只有仍属于自己那一代才清。
/// 同设备重连后旧流才退出，代际已经不是当前那个 —— 不清就把新连接的记录抹了。
fn task_is_this_generation(held: Option<u64>, gen: u64) -> bool {
    held == Some(gen)
}

/// 该不该清掉「当前连接」：只有连着的就是这台设备才清（断开 A 不该影响 B）。
fn connected_is_this_device(held: Option<&str>, device_id: &str) -> bool {
    held == Some(device_id)
}

async fn clear_generation(app: &AppHandle, device_id: &str, gen: u64) {
    let state = app.state::<BleState>();
    {
        let mut task = state.notify_task.lock().await;
        if task_is_this_generation(task.as_ref().map(|(g, _)| *g), gen) {
            *task = None;
        }
    }
    let mut connected = state.connected.lock().await;
    if connected_is_this_device(connected.as_deref(), device_id) {
        *connected = None;
    }
}

/// 初始化蓝牙（首次调用时创建 Manager/Adapter）
async fn init_ble(state: &BleState) -> Result<(), HostError> {
    let mut guard = state.core.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let manager = BtleManager::new()
        .await
        .map_err(|e| HostError::new(DEVICE_UNAVAILABLE, format!("BLE manager: {e}")))?;
    let adapters = manager
        .adapters()
        .await
        .map_err(|e| HostError::new(DEVICE_UNAVAILABLE, format!("BLE adapters: {e}")))?;
    let adapter = adapters.into_iter().next().ok_or_else(|| {
        HostError::new(DEVICE_UNAVAILABLE, "未找到蓝牙适配器（本机蓝牙可能未开启）")
    })?;
    *guard = Some(Core {
        _manager: manager,
        adapter,
        peripherals: HashMap::new(),
        seen: HashSet::new(),
    });
    Ok(())
}

/// BLE 命令一律带调用方插件 id，并逐项查授权表。
/// JS 能力桥本来就按 manifest 校验，这一步是为了让「绕过桥直接 invoke」也拿不到别人的权限；
/// 插件之间仍无法区分（同一个宠物窗），那要等 Web Worker 宿主。
/// 判定收在 `crate::gate::plugin_capability`（S4/S5：全项目一把门禁，别再各写一份）。
/// G3-01：先过窗口归属 —— 插件自己的悬浮窗只能替自己操作蓝牙。
fn require_granted(
    window: &tauri::Window,
    perms: &PermissionState,
    plugin_id: &str,
    cap: &str,
) -> Result<(), HostError> {
    // gate 已迁 HostError（ADR-0007），这里不再过 `From<HostError> for String` 那道转换
    crate::gate::plugin_capability(window, perms, plugin_id, cap)
}

/// 开始扫描；发现的新设备通过 ble:device-found 事件广播
#[tauri::command]
pub async fn ble_start_scan(
    window: tauri::Window,
    app: AppHandle,
    state: tauri::State<'_, BleState>,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
) -> Result<(), HostError> {
    require_granted(&window, &perms, &plugin_id, crate::plugin_caps::BLE_SCAN)?;
    init_ble(&state).await?;
    reset_seen(&state).await;
    begin_adapter_scan(&state).await?;
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Ok(()); // 扫描已在进行，不重复起泵
    }
    spawn_scan_pump(app, state.scanning.clone());
    Ok(())
}

/// 只重置去重集合：已上报过的设备允许重新上报（设置窗重开后也能刷新列表）。
/// peripherals 是句柄缓存，不能跟着一起清 —— 清掉之后 UI 里那行设备还在，
/// 点「连接」就必然报「未在扫描结果中」，同一次运行里连不上刚才那台设备。
async fn reset_seen(state: &tauri::State<'_, BleState>) {
    let mut core_guard = state.core.lock().await;
    if let Some(core) = core_guard.as_mut() {
        core.seen.clear();
    }
}

async fn begin_adapter_scan(state: &BleState) -> Result<(), HostError> {
    let core_guard = state.core.lock().await;
    let core = core_guard
        .as_ref()
        .ok_or_else(|| HostError::new(INVALID_STATE, "BLE init failed"))?;
    core.adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| HostError::new(SCAN_START, format!("启动扫描失败: {e}")))
}

/// 设备上报泵（ADR-0005：从命令体里搬出来，命令只负责「要不要起这一路」）。
/// 锁内只借一次 adapter 句柄；peripherals / properties 都是 WinRT 往返，
/// 占着 core 锁会让连接路径全程排队。
fn spawn_scan_pump(app: AppHandle, scanning: Arc<AtomicBool>) {
    tauri::async_runtime::spawn(async move {
        while scanning.load(Ordering::SeqCst) {
            // 锁内只借一次 adapter 句柄； peripherals / properties 都是 WinRT 往返，
            // 占着 core 锁会让连接路径全程排队
            let adapter = {
                let app_state = app.state::<BleState>();
                let core_guard = app_state.core.lock().await;
                match core_guard.as_ref() {
                    Some(core) => core.adapter.clone(),
                    None => break,
                }
            };
            let known = {
                let app_state = app.state::<BleState>();
                let core_guard = app_state.core.lock().await;
                core_guard
                    .as_ref()
                    .map(|core| core.seen.clone())
                    .unwrap_or_default()
            };
            let peripherals = adapter.peripherals().await.unwrap_or_default();

            let mut report: Vec<DeviceFound> = Vec::new();
            for p in peripherals {
                let id = format!("{}", p.id());
                if known.contains(&id) {
                    continue;
                }
                let (name, rssi) = match p.properties().await {
                    Ok(Some(props)) => (props.local_name, props.rssi),
                    _ => (None, None),
                };
                {
                    let app_state = app.state::<BleState>();
                    let mut core_guard = app_state.core.lock().await;
                    if let Some(core) = core_guard.as_mut() {
                        core.seen.insert(id.clone());
                        core.peripherals.insert(id.clone(), p.clone());
                    }
                }
                report.push(DeviceFound { id, name, rssi });
            }
            for d in report {
                let _ = app.emit("ble:device-found", d);
            }
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
    });
}

#[tauri::command]
pub async fn ble_stop_scan(
    window: tauri::Window,
    state: tauri::State<'_, BleState>,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
) -> Result<(), HostError> {
    require_granted(&window, &perms, &plugin_id, crate::plugin_caps::BLE_SCAN)?;
    state.scanning.store(false, Ordering::SeqCst);
    let core_guard = state.core.lock().await;
    if let Some(core) = core_guard.as_ref() {
        let _ = core.adapter.stop_scan().await;
    }
    Ok(())
}

/// 连接指定设备并订阅心率通知（会自动断开旧连接）
#[tauri::command]
pub async fn ble_connect(
    window: tauri::Window,
    app: AppHandle,
    state: tauri::State<'_, BleState>,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    device_id: String,
) -> Result<(), HostError> {
    require_granted(&window, &perms, &plugin_id, crate::plugin_caps::BLE_CONNECT)?;
    init_ble(&state).await?;
    drop_old_connection(&state).await;
    let peripheral = lookup_peripheral(&state, &device_id).await?;
    connect_and_discover(&peripheral).await?;
    if device_lacks_heart_rate(
        find_hr_char(&peripheral).is_some(),
        has_hr_service(&peripheral),
    ) {
        let _ = peripheral.disconnect().await;
        return Err(HostError::new(
            DEVICE_UNAVAILABLE,
            "该设备没有标准心率服务 (0x180D)",
        ));
    }
    start_notify_pump(app, &state, peripheral, device_id).await;
    Ok(())
}

/// 连上并枚举服务：两段的错误文案都在这里定，命令体只管调用（ADR-0005）。
async fn connect_and_discover(peripheral: &Peripheral) -> Result<(), HostError> {
    peripheral
        .connect()
        .await
        .map_err(|e| HostError::new(DEVICE_UNAVAILABLE, format!("连接失败: {e}")))?;
    peripheral
        .discover_services()
        .await
        .map_err(|e| HostError::new(DEVICE_UNAVAILABLE, format!("发现服务失败: {e}")))
}

/// 一律先摘掉旧连接：同设备重连也必须换下旧通知流，
/// 否则两条流同时广播心率，且旧句柄被覆盖后再也没人 abort
async fn drop_old_connection(state: &tauri::State<'_, BleState>) {
    if let Some(old) = state.connected.lock().await.clone() {
        let _ = ble_disconnect_inner(state, old).await;
    }
}

/// 取外设句柄：缓存没命中就现问适配器一次（btleplug 自己保留已发现的设备）。
/// 不能把「再扫一遍」当成重连的前置条件，否则断开后立刻重连就会失败。
async fn lookup_peripheral(state: &BleState, device_id: &str) -> Result<Peripheral, HostError> {
    let mut core_guard = state.core.lock().await;
    let core = core_guard
        .as_mut()
        .ok_or_else(|| HostError::new(INVALID_STATE, "BLE init failed"))?;
    if let Some(p) = core.peripherals.get(device_id).cloned() {
        return Ok(p);
    }
    let found = core
        .adapter
        .peripherals()
        .await
        .map_err(|e| HostError::new(DEVICE_UNAVAILABLE, format!("查询已发现设备失败: {e}")))?
        .into_iter()
        .find(|p| format!("{}", p.id()) == device_id)
        .ok_or_else(|| {
            HostError::new(
                DEVICE_UNAVAILABLE,
                format!("设备 {device_id} 未被适配器发现，请重新扫描"),
            )
        })?;
    core.peripherals
        .insert(device_id.to_string(), found.clone());
    Ok(found)
}

/// 心率判定拆成两个条件（ADR-0005：分支条件要能在单测里逐条组合，
/// 而 Peripheral 在离线测试里构造不出来，所以判定只吃两个布尔）。
fn device_lacks_heart_rate(has_char: bool, has_service: bool) -> bool {
    !(has_char && has_service)
}

fn has_hr_service(peripheral: &Peripheral) -> bool {
    peripheral.services().iter().any(|s| s.uuid == HR_SERVICE)
}

async fn start_notify_pump(
    app: AppHandle,
    state: &tauri::State<'_, BleState>,
    peripheral: Peripheral,
    device_id: String,
) {
    *state.connected.lock().await = Some(device_id.clone());
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let task = tauri::async_runtime::spawn(notify_pump(app, peripheral, device_id, gen));
    *state.notify_task.lock().await = Some((gen, task));
}

async fn ble_disconnect_inner(state: &BleState, device_id: String) -> Result<(), HostError> {
    if let Some((_, task)) = state.notify_task.lock().await.take() {
        task.abort();
    }
    let core_guard = state.core.lock().await;
    if let Some(core) = core_guard.as_ref() {
        if let Ok(peripherals) = core.adapter.peripherals().await {
            if let Some(p) = peripherals
                .into_iter()
                .find(|p| format!("{}", p.id()) == device_id)
            {
                let _ = p.disconnect().await;
            }
        }
    }
    drop(core_guard);
    *state.connected.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn ble_disconnect(
    window: tauri::Window,
    state: tauri::State<'_, BleState>,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
) -> Result<(), HostError> {
    require_granted(&window, &perms, &plugin_id, crate::plugin_caps::BLE_CONNECT)?;
    let current = state.connected.lock().await.clone();
    match current {
        Some(id) => ble_disconnect_inner(&state, id).await,
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn ble_connected_device(
    window: tauri::Window,
    state: tauri::State<'_, BleState>,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
) -> Result<Option<String>, HostError> {
    require_granted(&window, &perms, &plugin_id, crate::plugin_caps::BLE_CONNECT)?;
    Ok(state.connected.lock().await.clone())
}

#[cfg(test)]
#[path = "ble.tests.rs"]
mod tests;
