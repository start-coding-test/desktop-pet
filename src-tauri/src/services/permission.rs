use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;
use tokio::time::Instant;

use super::store::StoreState;
use crate::fsutil::write_atomic;
use crate::host_error::{HostError, DENIED, INTERNAL, INVALID_ARG, NOT_FOUND};
use crate::ids::is_safe_id;

/// 同意框的组级等待上限。窗口/组从第一个请求起算，后续追加的请求共享剩余时间。
const CONSENT_TIMEOUT: Duration = Duration::from_secs(60);

/// 插件权限管理：授权表持久化 + 首次调用未授权能力时弹同意框。
/// 进程内插件不是硬安全边界，这里是策略层（见 ARCHITECTURE.md 信任模型）。
pub struct PermissionState {
    file: Mutex<Option<PathBuf>>,
    granted: Mutex<HashMap<String, Vec<String>>>,
    consent: Mutex<ConsentBook>,
}

struct PendingConsent {
    plugin_id: String,
    plugin_name: String,
    caps: Vec<String>,
    waiters: Vec<oneshot::Sender<bool>>,
    window_label: String,
    deadline: Instant,
}

/// pending 与拒绝锁共用一把锁：答复拒绝、停用清锁、追加能力必须原子，
/// 否则新请求会插在「已答复拒绝」和「已写拒绝锁」之间再开一扇窗。
#[derive(Default)]
struct ConsentBook {
    pending: HashMap<String, PendingConsent>,
    denied: HashSet<String>,
}

enum BeginOutcome {
    AlreadyGranted,
    Denied,
    Joined {
        rx: oneshot::Receiver<bool>,
    },
    Created {
        req_id: String,
        rx: oneshot::Receiver<bool>,
        window_label: String,
        deadline: Instant,
    },
}

#[derive(Clone, Copy, Debug)]
enum ConsentEnd {
    Allow,
    Deny,
    Closed,
    Timeout,
    Disabled,
    Uninstalled,
    WindowFailed,
}

impl ConsentEnd {
    fn grants(self) -> bool {
        matches!(self, Self::Allow)
    }

    fn latches(self) -> bool {
        matches!(self, Self::Deny | Self::Closed | Self::Timeout)
    }

    fn clears_denied(self) -> bool {
        matches!(self, Self::Disabled)
    }
}

/// 请求里尚未授权且本轮请求内不重复的能力（保序）。pending 里已有的能力由调用方再过滤。
fn unique_ungranted(requested: &[String], granted: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for cap in requested {
        if granted.contains(cap) || out.contains(cap) {
            continue;
        }
        out.push(cap.clone());
    }
    out
}

/// 未启用（清单缺失/读坏也是未启用）时不弹窗。纯函数便于单测启用门禁。
fn plugin_enabled_for_consent(enabled: Option<&[String]>, plugin_id: &str) -> bool {
    enabled
        .map(|ids| ids.iter().any(|id| id == plugin_id))
        .unwrap_or(false)
}

/// pending 里已经不在盘的插件 id（去重、保序）。只用于取消，不碰授权表。
fn orphan_pending_ids(pending: &[String], known: &HashSet<String>) -> Vec<String> {
    let mut out = Vec::new();
    for id in pending {
        if !known.contains(id) && !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

#[derive(Serialize, Clone)]
pub struct ConsentDetails {
    pub req_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub caps: Vec<String>,
}

impl PermissionState {
    pub fn new() -> Self {
        Self {
            file: Mutex::new(None),
            granted: Mutex::new(HashMap::new()),
            consent: Mutex::new(ConsentBook::default()),
        }
    }

    pub fn init(&self, app: &AppHandle) -> Result<(), HostError> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| HostError::new(INTERNAL, e.to_string()))?;
        let file = dir.join("authorizations.json");
        if let Some(map) = restore_from(&file) {
            *self.granted.lock().unwrap_or_else(|p| p.into_inner()) = map;
        }
        *self.file.lock().unwrap_or_else(|p| p.into_inner()) = Some(file);
        Ok(())
    }

    fn save(&self) {
        let Some(file) = self.file.lock().unwrap_or_else(|p| p.into_inner()).clone() else {
            log::warn!("授权存储尚未初始化，本次授权变更未落盘");
            return;
        };
        if let Some(parent) = file.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                log::warn!("创建授权目录失败: {e}");
            }
        }
        let json = match serde_json::to_string_pretty(
            &*self.granted.lock().unwrap_or_else(|p| p.into_inner()),
        ) {
            Ok(j) => j,
            Err(e) => {
                log::error!("序列化授权表失败: {e}");
                return;
            }
        };
        // 原子写：半截的 authorizations.json 会让下次启动把所有授权当成空表
        if let Err(e) = write_atomic(&file, json.as_bytes()) {
            log::warn!("授权落盘失败: {e}");
        }
    }

    pub fn is_granted(&self, plugin_id: &str, cap: &str) -> bool {
        self.granted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(plugin_id)
            .map(|caps| caps.iter().any(|c| c == cap))
            .unwrap_or(false)
    }

    /// 某插件当前已授权的能力快照。阻塞线程里拿不到 `State`，
    /// 需要在别处逐跳复核域名的话（见 services::http）带这份快照过去。
    pub fn granted_caps(&self, plugin_id: &str) -> Vec<String> {
        self.granted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(plugin_id)
            .cloned()
            .unwrap_or_default()
    }

    /// 只改内存，不落盘。allow 收口在 consent 锁内调用它，随后在锁外 `save()`，
    /// 这样「移除 pending」和「新授权可见」之间不会被新请求看到旧快照。
    fn grant_in_memory(&self, plugin_id: &str, caps: &[String]) {
        let mut map = self.granted.lock().unwrap_or_else(|p| p.into_inner());
        let entry = map.entry(plugin_id.to_string()).or_default();
        for c in caps {
            if !entry.contains(c) {
                entry.push(c.clone());
            }
        }
    }

    /// 测试与其他能力域的单测用：内存授权 + 落盘。生产 allow 路径走
    /// `grant_in_memory` + 锁外 `save()`，避免在 consent 锁里做文件 IO。
    #[cfg(test)]
    pub fn grant(&self, plugin_id: &str, caps: &[String]) {
        self.grant_in_memory(plugin_id, caps);
        self.save();
    }

    pub fn revoke_all(&self, plugin_id: &str) -> Vec<String> {
        let revoked = self
            .granted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(plugin_id)
            .unwrap_or_default();
        self.save();
        revoked
    }

    /// 在 consent 锁内完成查找/创建与追加。锁序固定为 consent → granted：
    /// allow 路径也会在同一把 consent 锁里写入内存授权，避免新请求读到过期 granted 快照。
    fn begin_consent(
        &self,
        plugin_id: &str,
        plugin_name: &str,
        requested: &[String],
        req_id: String,
        ttl: Duration,
    ) -> BeginOutcome {
        let mut book = self.consent.lock().unwrap_or_else(|p| p.into_inner());
        let granted = self
            .granted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(plugin_id)
            .cloned()
            .unwrap_or_default();
        let ungranted = unique_ungranted(requested, &granted);
        if ungranted.is_empty() {
            return BeginOutcome::AlreadyGranted;
        }
        if book.denied.contains(plugin_id) {
            return BeginOutcome::Denied;
        }

        let existing = book
            .pending
            .iter()
            .find(|(_, pending)| pending.plugin_id == plugin_id)
            .map(|(id, _)| id.clone());
        if let Some(existing_req) = existing {
            let pending = book
                .pending
                .get_mut(&existing_req)
                .expect("刚按 plugin_id 找到的 pending 不该消失");
            for cap in ungranted {
                if !pending.caps.contains(&cap) {
                    pending.caps.push(cap);
                }
            }
            let (tx, rx) = oneshot::channel();
            pending.waiters.push(tx);
            return BeginOutcome::Joined { rx };
        }

        let (tx, rx) = oneshot::channel();
        let window_label = format!("consent-{req_id}");
        let deadline = Instant::now() + ttl;
        book.pending.insert(
            req_id.clone(),
            PendingConsent {
                plugin_id: plugin_id.to_string(),
                plugin_name: plugin_name.to_string(),
                caps: ungranted,
                waiters: vec![tx],
                window_label: window_label.clone(),
                deadline,
            },
        );
        BeginOutcome::Created {
            req_id,
            rx,
            window_label,
            deadline,
        }
    }

    /// 移除 pending 并按收口类型处理授权/拒绝锁。等待方已全部离开时不授权、不写拒绝锁，
    /// 只把 pending 移除（既有 `receiver dropped` 口径）；停用仍会先清掉旧拒绝锁。
    fn finish_consent(&self, req_id: &str, end: ConsentEnd) -> Result<PendingConsent, HostError> {
        let mut book = self.consent.lock().unwrap_or_else(|p| p.into_inner());
        let Some(pending) = book.pending.remove(req_id) else {
            return Err(HostError::new(NOT_FOUND, "request not found"));
        };
        let PendingConsent {
            plugin_id,
            plugin_name,
            caps,
            waiters,
            window_label,
            deadline,
        } = pending;
        let live: Vec<_> = waiters
            .into_iter()
            .filter(|sender| !sender.is_closed())
            .collect();
        if end.clears_denied() {
            book.denied.remove(&plugin_id);
        }
        if live.is_empty() {
            return Err(HostError::new(INTERNAL, "receiver dropped"));
        }
        if end.grants() {
            self.grant_in_memory(&plugin_id, &caps);
        } else if end.latches() {
            book.denied.insert(plugin_id.clone());
        }
        Ok(PendingConsent {
            plugin_id,
            plugin_name,
            caps,
            waiters: live,
            window_label,
            deadline,
        })
    }

    fn pending_exists(&self, req_id: &str) -> bool {
        self.consent
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pending
            .contains_key(req_id)
    }

    fn pending_plugin_ids(&self) -> Vec<String> {
        let book = self.consent.lock().unwrap_or_else(|p| p.into_inner());
        let mut ids = Vec::new();
        for pending in book.pending.values() {
            if !ids.contains(&pending.plugin_id) {
                ids.push(pending.plugin_id.clone());
            }
        }
        ids
    }

    fn clear_denied(&self, plugin_id: &str) {
        self.consent
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .denied
            .remove(plugin_id);
    }

    pub fn list(&self) -> HashMap<String, Vec<String>> {
        self.granted
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// 只保留仍在盘的插件的授权，返回被回收的 id。
    pub fn retain_known(&self, known: &HashSet<String>) -> Vec<String> {
        let gone: Vec<String> = {
            let mut map = self.granted.lock().unwrap_or_else(|p| p.into_inner());
            let gone: Vec<String> = map
                .keys()
                .filter(|id| !known.contains(*id))
                .cloned()
                .collect();
            for id in &gone {
                map.remove(id);
            }
            gone
        };
        if !gone.is_empty() {
            self.save();
        }
        gone
    }
}

// 插件 id 一律用 `crate::ids::is_safe_id`（S4）。
// 这里以前另有一份 `valid_id`（只挡 `..` `/` `\`），比 overlay/store 那两份都松 ——
// 三份各写各的正是一个 id 能穿过某道门、又被另一道挡住的来源。

/// 从落盘的授权表恢复。返回 None 表示「没有文件」或「文件读坏了」——
/// 两种情况本次启动都按空表运行，且绝不覆盖原文件（半截的 authorizations.json 要是
/// 被当成空表写回去，用户给过的所有授权就没了）。
fn restore_from(file: &Path) -> Option<HashMap<String, Vec<String>>> {
    let raw = fs::read_to_string(file).ok()?;
    match serde_json::from_str::<HashMap<String, Vec<String>>>(&raw) {
        Ok(map) => Some(map),
        Err(e) => {
            log::error!("authorizations.json 解析失败，本次启动按空授权表运行: {file:?}: {e}");
            None
        }
    }
}

/// 授权表查询的唯一口径：非法 id 一律视为未授权（挡住冒名与路径式 id）。
pub fn check_capability(state: &PermissionState, plugin_id: &str, capability: &str) -> bool {
    is_safe_id(plugin_id) && state.is_granted(plugin_id, capability)
}

/// 申请/撤销入口的 id 词表检查单列成函数：两个命令共用同一文案与码，
/// 命令体要真实窗口构造不出来，只有它能直连这条路径钉住码与文案。
fn checked_plugin_id(plugin_id: &str) -> Result<(), HostError> {
    if is_safe_id(plugin_id) {
        Ok(())
    } else {
        Err(HostError::new(INVALID_ARG, "invalid plugin id"))
    }
}

/// 请求里 manifest 没声明的那些能力。唯一放宽是 http：`http:<host>` 视为被 `http` 覆盖。
/// 其余一律精确匹配 —— 别改成前缀匹配，否则声明一个 `ble` 就等于给了 `ble:connect`。
fn undeclared_caps(declared: &[String], requested: &[String]) -> Vec<String> {
    requested
        .iter()
        .filter(|c| {
            !declared.iter().any(|d| {
                d == *c
                    || (d == crate::plugin_caps::HTTP
                        && c.starts_with(crate::plugin_caps::http_host_prefix()))
            })
        })
        .cloned()
        .collect()
}

/// 插件目录变动后回收孤儿授权与孤儿 pending。
/// 读不到目录时什么都不做 —— 宁可留着过期授权，也不要在一次临时 IO 失败上把用户给过的权限抹掉。
pub fn prune_orphan_grants(app: &AppHandle) {
    let Ok(ids) = crate::commands::plugins::installed_plugin_ids(app) else {
        return;
    };
    let known: HashSet<String> = ids.into_iter().collect();
    let state = app.state::<PermissionState>();
    let removed = state.retain_known(&known);
    // 正在弹窗的插件通常还没有授权，不会出现在 removed 里；必须独立遍历 pending。
    for id in orphan_pending_ids(&state.pending_plugin_ids(), &known) {
        cancel_pending_for_plugin(app, &id, false);
    }
    if !removed.is_empty() {
        log::info!("回收已卸载插件的授权: {}", removed.join(", "));
        // 目录都没了，能力也收走了，它的悬浮层再没人能关（同 permission_revoke 那条理由）
        for id in &removed {
            crate::window::overlay::reclaim_for_permission(app, id);
        }
    }
}

/// 检查单个能力是否已授权
#[tauri::command]
pub fn permission_check(
    state: tauri::State<PermissionState>,
    plugin_id: String,
    capability: String,
) -> bool {
    check_capability(&state, &plugin_id, &capability)
}

/// 请求授权：只受理 manifest 已声明的能力；已全部授权则立即放行；
/// 未启用直接拒绝、不弹窗；其余按 plugin_id 合流到同一 pending。
#[tauri::command]
pub async fn permission_request(
    app: AppHandle,
    state: tauri::State<'_, PermissionState>,
    plugin_id: String,
    capabilities: Vec<String>,
) -> Result<bool, HostError> {
    checked_plugin_id(&plugin_id)?;
    let declared = crate::commands::plugins::declared_capabilities(&app, &plugin_id)?;
    ensure_declared(&plugin_id, &declared, &capabilities)?;
    request_consent(app, state.inner(), plugin_id, capabilities).await
}

/// 「未声明就不许申请」这条规则单独成函数（ADR-0005）。
/// 磁盘 manifest 是声明能力的唯一事实来源，未声明直接拒绝、不弹框；
/// 例外口径照旧：http:<host> 视为被 http 覆盖，判定收在 undeclared_caps 里。
fn ensure_declared(
    plugin_id: &str,
    declared: &[String],
    requested: &[String],
) -> Result<(), HostError> {
    let undeclared = undeclared_caps(declared, requested);
    if undeclared.is_empty() {
        return Ok(());
    }
    Err(HostError::new(
        DENIED,
        format!(
            "{} 未在 manifest 声明这些能力: {}",
            plugin_id,
            undeclared.join(", ")
        ),
    ))
}

/// 请求授权的主路径：全授权 → 启用门禁 → 锁内合流；只有新组才开窗。
/// 命令体只做 id/声明校验与一次委托（ADR-0005）。
async fn request_consent(
    app: AppHandle,
    state: &PermissionState,
    plugin_id: String,
    capabilities: Vec<String>,
) -> Result<bool, HostError> {
    if capabilities.iter().all(|c| state.is_granted(&plugin_id, c)) {
        return Ok(true);
    }
    // 未启用（清单缺失/读坏也算）一律不弹；已全授权的情况已在上面直接放行。
    if !plugin_enabled_for_consent(
        crate::services::enabled::list_ids(&app).as_deref(),
        &plugin_id,
    ) {
        return Ok(false);
    }
    let plugin_name = crate::commands::plugins::manifest_display_name(&app, &plugin_id)?;
    let req_id = format!("r{}", uuid::Uuid::new_v4().simple());
    match state.begin_consent(
        &plugin_id,
        &plugin_name,
        &capabilities,
        req_id,
        CONSENT_TIMEOUT,
    ) {
        BeginOutcome::AlreadyGranted => Ok(true),
        BeginOutcome::Denied => Ok(false),
        BeginOutcome::Joined { rx, .. } => Ok(rx.await.unwrap_or(false)),
        BeginOutcome::Created {
            req_id,
            rx,
            window_label,
            deadline,
        } => open_consent_window(app, state, &plugin_id, req_id, rx, window_label, deadline).await,
    }
}

/// 新组才走到这里。开窗前复核启用状态，开窗后复核 pending 是否仍在；
/// 停用/卸载与首次开窗交错时，保证不留下没有 pending 的孤窗。
async fn open_consent_window(
    app: AppHandle,
    state: &PermissionState,
    plugin_id: &str,
    req_id: String,
    rx: oneshot::Receiver<bool>,
    window_label: String,
    deadline: Instant,
) -> Result<bool, HostError> {
    if !plugin_enabled_for_consent(
        crate::services::enabled::list_ids(&app).as_deref(),
        plugin_id,
    ) {
        resolve_consent(&app, state, &req_id, ConsentEnd::Disabled);
        return Ok(false);
    }
    let win = match WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::App("src/consent.html".into()),
    )
    .title("权限确认")
    .inner_size(420.0, 320.0)
    .resizable(false)
    .always_on_top(true)
    .decorations(false)
    .build()
    {
        Ok(win) => win,
        Err(e) => {
            resolve_consent(&app, state, &req_id, ConsentEnd::WindowFailed);
            return Err(consent_window_error(e));
        }
    };
    let _ = win.set_focus();
    // 用户把同意框直接关掉（Alt+F4 / 托盘退出等）时必须立刻收口整组等待方，
    // 否则那次插件调用要空等满 60s 超时。
    {
        let app_for_close = app.clone();
        let req_for_close = req_id.clone();
        win.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                if let Some(state) = app_for_close.try_state::<PermissionState>() {
                    resolve_consent(
                        &app_for_close,
                        state.inner(),
                        &req_for_close,
                        ConsentEnd::Closed,
                    );
                }
            }
        });
    }
    if !state.pending_exists(&req_id) {
        let _ = win.close();
        return Ok(rx.await.unwrap_or(false));
    }
    spawn_consent_timeout(app, req_id.clone(), deadline);
    Ok(rx.await.unwrap_or(false))
}

fn spawn_consent_timeout(app: AppHandle, req_id: String, deadline: Instant) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep_until(deadline).await;
        if let Some(state) = app.try_state::<PermissionState>() {
            resolve_consent(&app, state.inner(), &req_id, ConsentEnd::Timeout);
        }
    });
}

/// 统一收口：移除 pending、按类型授权/写拒绝锁、逐个 waiter 发送、关闭旧窗。
/// 找不到 pending 时只尝试关掉旧 label（迟到 Destroyed/超时不能误伤新 pending）。
fn resolve_consent(app: &AppHandle, state: &PermissionState, req_id: &str, end: ConsentEnd) {
    match state.finish_consent(req_id, end) {
        Ok(pending) => {
            if end.grants() {
                state.save();
            }
            deliver_pending(app, pending, end.grants());
        }
        Err(_) => {
            if let Some(win) = app.get_webview_window(&format!("consent-{req_id}")) {
                let _ = win.close();
            }
        }
    }
}

fn deliver_pending(app: &AppHandle, pending: PendingConsent, granted: bool) {
    // 单个 waiter 已离开不影响其余等待方；全部离开的情况已在 finish_consent 收口。
    for sender in pending.waiters {
        let _ = sender.send(granted);
    }
    if let Some(win) = app.get_webview_window(&pending.window_label) {
        let _ = win.close();
    }
}

/// 停用/卸载时要做的收口决策。抽出来的唯一理由：`resolve_consent` 往下三层都要真 `AppHandle`，
/// 单测造不出它，于是「找 pending → 选收口类型」这一步过去只能靠源码文本断言钉（见 D03 审计 F-3）。
enum CancelPlan {
    Resolve { req_id: String, end: ConsentEnd },
    ClearDenied,
    Nothing,
}

fn cancel_plan(state: &PermissionState, plugin_id: &str, clear_denied: bool) -> CancelPlan {
    let req_id = {
        let book = state.consent.lock().unwrap_or_else(|p| p.into_inner());
        book.pending
            .iter()
            .find(|(_, pending)| pending.plugin_id == plugin_id)
            .map(|(id, _)| id.clone())
    };
    match req_id {
        Some(req_id) => CancelPlan::Resolve {
            req_id,
            end: if clear_denied {
                ConsentEnd::Disabled
            } else {
                ConsentEnd::Uninstalled
            },
        },
        None if clear_denied => CancelPlan::ClearDenied,
        None => CancelPlan::Nothing,
    }
}

/// 停用/卸载时的取消入口。`clear_denied` 为 true 时同时清掉该插件的旧拒绝锁；
/// 两者都不写新锁。找不到 pending 时仍可以只清锁（停用路径）。
pub fn cancel_pending_for_plugin(app: &AppHandle, plugin_id: &str, clear_denied: bool) {
    let state = app.state::<PermissionState>();
    // 决策在 `cancel_plan` 里做完（锁已释放），这里只按它收口 —— 与抽取前的持锁范围、调用顺序一致。
    match cancel_plan(state.inner(), plugin_id, clear_denied) {
        CancelPlan::Resolve { req_id, end } => resolve_consent(app, state.inner(), &req_id, end),
        CancelPlan::ClearDenied => state.clear_denied(plugin_id),
        CancelPlan::Nothing => {}
    }
}

/// 同意框开窗失败映射单列成函数：单测里构造不出 AppHandle，只有它能直连这条路径钉码
fn consent_window_error(e: tauri::Error) -> HostError {
    HostError::new(INTERNAL, e.to_string())
}

/// 同意框的答复只有「明确答了是」才算授权：超时、通道断开、窗口被直接关掉一律按拒绝收口。
/// 生产路径已按 ConsentEnd 收口；保留这层判定供既有语义单测。
#[cfg(test)]
fn consent_outcome(answered: Option<bool>) -> bool {
    matches!(answered, Some(true))
}

/// 同意框只能由它自己的窗口应答：req_id 会从窗口 label 泄露，
/// 不绑定调用方的话任何窗口都能自问自答地放行。
fn assert_consent_caller(label: &str, req_id: &str) -> Result<(), HostError> {
    if label == format!("consent-{req_id}") {
        Ok(())
    } else {
        Err(HostError::new(
            DENIED,
            "consent window does not own this request",
        ))
    }
}

/// 拉取挂起同意请求的详情（ADR-0005：判定内核与开窗分开，单测直连这条路径钉码）
fn pending_details(state: &PermissionState, req_id: &str) -> Result<ConsentDetails, HostError> {
    state
        .consent
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .pending
        .get(req_id)
        .map(|p| ConsentDetails {
            req_id: req_id.to_string(),
            plugin_id: p.plugin_id.clone(),
            plugin_name: p.plugin_name.clone(),
            caps: p.caps.clone(),
        })
        .ok_or_else(|| HostError::new(NOT_FOUND, "request not found"))
}

/// 回传用户的决定：allow 在 consent 锁内写内存授权，锁外落盘，再把 `true` 发给所有等待方；
/// 全部 sender 已关闭时保持既有 `receiver dropped` 口径，不授权、不写拒绝锁。
fn answer_pending(state: &PermissionState, req_id: &str, granted: bool) -> Result<(), HostError> {
    let end = if granted {
        ConsentEnd::Allow
    } else {
        ConsentEnd::Deny
    };
    let pending = state.finish_consent(req_id, end)?;
    if granted {
        state.save();
    }
    for sender in pending.waiters {
        let _ = sender.send(granted);
    }
    Ok(())
}

/// 同意框页面拉取详情
#[tauri::command]
pub fn consent_details(
    window: tauri::Window,
    state: tauri::State<PermissionState>,
    req_id: String,
) -> Result<ConsentDetails, HostError> {
    assert_consent_caller(window.label(), &req_id)?;
    pending_details(&state, &req_id)
}

/// 同意框页面回传用户决定
#[tauri::command]
pub fn consent_answer(
    window: tauri::Window,
    state: tauri::State<PermissionState>,
    req_id: String,
    granted: bool,
) -> Result<(), HostError> {
    assert_consent_caller(window.label(), &req_id)?;
    let result = answer_pending(&state, &req_id, granted);
    // 无论答复是否被接受（例如全部等待方已离开），这扇窗都该关掉。
    let _ = window.close();
    result
}

/// 授权表：只认设置窗。插件 JS 就跑在宠物窗里，
/// 不门禁的话任意插件一行 invoke 就能抹掉别人的授权并连带清掉其存储。
#[tauri::command]
pub fn permission_list(
    window: tauri::Window,
    state: tauri::State<PermissionState>,
) -> Result<HashMap<String, Vec<String>>, HostError> {
    crate::gate::settings(&window, "查看授权表")?;
    Ok(state.list())
}

/// 设置窗：撤销某插件的全部授权，并连带清掉它落盘的存储
#[tauri::command]
pub fn permission_revoke(
    app: AppHandle,
    window: tauri::Window,
    plugin_id: String,
    state: tauri::State<PermissionState>,
    store: tauri::State<StoreState>,
) -> Result<Vec<String>, HostError> {
    crate::gate::settings(&window, "撤销授权")?;
    checked_plugin_id(&plugin_id)?;
    let revoked = state.revoke_all(&plugin_id);
    if let Err(e) = store.clear_plugin(&plugin_id) {
        log::warn!("清理 {plugin_id} 存储失败: {e}");
    }
    // 能力已经收走了，插件面的 overlay 门禁此后过不去 —— 那扇置顶透明窗必须由宿主先收掉，
    // 否则撤销授权反而留下一张再也没人能关的卡片（信息泄露 + 窗口泄漏）
    crate::window::overlay::reclaim_for_permission(&app, &plugin_id);
    // 前端桥会缓存「这个能力已授权」来省掉逐次 IPC（见 runtime/bridge.ts）。
    // 撤销必须让这份缓存失效，否则已加载的插件还能继续用刚被收回的能力。
    let _ = app.emit("host:permission-revoked", &plugin_id);
    Ok(revoked)
}

#[cfg(test)]
#[path = "permission.tests.rs"]
mod tests;
