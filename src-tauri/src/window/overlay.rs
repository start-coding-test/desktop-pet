use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::host_error::{HostError, DENIED, INTERNAL, INVALID_ARG, NOT_FOUND};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::services::permission::PermissionState;

/// 每个插件一扇自己的悬浮窗（`overlay-<插件 id>`）。
///
/// 早先所有插件共用一扇 `overlay` 窗，位置与高度由第一个 show 的人定死：
/// 心率波形要留在桌面左上角、Agent 状态卡要贴着宠物头顶，两者不可能同时成立，
/// 结果后打开的那个被塞进同一扇窗里显示不出来。窗口按插件分开之后，
/// 每扇窗的位置、高度、显隐都只属于它自己的插件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct OverlayState {
    /// 插件的意愿：调过 show 且还没 hide
    wanted: bool,
    /// 实际是否在显示（游戏模式压制时 wanted 也不显示）
    visible: bool,
}
static OVERLAYS: OnceLock<Mutex<HashMap<String, OverlayState>>> = OnceLock::new();

/// 游戏模式隐身：对**所有**悬浮层生效，不只是某一只插件的
static SUPPRESSED: AtomicBool = AtomicBool::new(false);

fn table() -> &'static Mutex<HashMap<String, OverlayState>> {
    OVERLAYS.get_or_init(Default::default)
}

/// 窗口标签只允许字母数字与 `-` `/` `:` `_`，而插件 id 里带点号（`com.pet.hr-ble`），
/// 所以标签是净化过的、**不能反推**出 id：页面要确认自己服务哪个插件得回头问宿主
/// （`overlay_owner`），注册表才是归属的唯一来源。
///
/// `.` 编码成 `_` 而不是同样压成 `-`：插件 id 的字符集（见 commands::plugins::is_safe_id）
/// 里没有下划线，所以这个映射是单射。原先把两者都压成 `-` 会让 `a.b` 与 `a-b`
/// 撞进同一个标签，`owner_of_label` 按 HashMap 迭代序取第一个，归属就张冠李戴了。
pub fn overlay_label(plugin_id: &str) -> String {
    let cleaned: String = plugin_id
        .chars()
        .map(|c| {
            if c == '.' {
                '_'
            } else if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("overlay-{cleaned}")
}

pub(crate) fn owner_of_label(label: &str) -> Option<String> {
    let guard = table().lock().unwrap_or_else(|p| p.into_inner());
    guard.keys().find(|id| overlay_label(id) == label).cloned()
}

/// 悬浮窗页面问宿主「这扇窗是给谁的」——按调用者的窗口标签回答，前端伪造不了归属
#[tauri::command]
pub async fn overlay_owner(window: tauri::Window) -> Result<Option<String>, HostError> {
    Ok(owner_of_label(window.label()))
}

const WIDTH: f64 = 320.0;
const DEFAULT_HEIGHT: u32 = 200;

fn clamp_height(h: u32) -> u32 {
    h.clamp(48, 900)
}

fn snapshot(plugin_id: &str) -> Option<OverlayState> {
    table()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(plugin_id)
        .copied()
}

/// 显示器工作区（逻辑像素）
#[derive(Debug, Clone, Copy, PartialEq)]
struct WorkArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// 悬浮窗的最终矩形（逻辑像素）
#[derive(Debug, Clone, Copy, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// 把插件的请求（逻辑像素）夹进工作区（ADR-0005：规则抽成纯函数好离线钉住）——
/// - `x`/`y` 缺省落 (24,24)：插件第一次显示时不知道屏幕多大，不能指望它自己给合理坐标；
/// - 整块留在屏内：宽度（`WIDTH`）与高度（`clamp_height`）都参与夹紧；
/// - 请求点不在任何工作区里就退回主屏 —— 调用面把主屏排在 `areas` 第一位。
fn resolve_rect(x: Option<f64>, y: Option<f64>, height: Option<u32>, areas: &[WorkArea]) -> Rect {
    let width = WIDTH;
    let height = clamp_height(height.unwrap_or(DEFAULT_HEIGHT)) as f64;
    let req_x = x.unwrap_or(24.0);
    let req_y = y.unwrap_or(24.0);
    let Some(area) = areas
        .iter()
        .find(|a| req_x >= a.x && req_x < a.x + a.width && req_y >= a.y && req_y < a.y + a.height)
        .or_else(|| areas.first())
    else {
        // 一块屏都拿不到（理论上不会）：按请求原样落座，不夹
        return Rect {
            x: req_x,
            y: req_y,
            width,
            height,
        };
    };
    // 工作区比窗还小时「上限」会小于下限，f64::clamp 当场 panic —— 用 max 兜成「贴原点」
    Rect {
        x: req_x.clamp(area.x, (area.x + area.width - width).max(area.x)),
        y: req_y.clamp(area.y, (area.y + area.height - height).max(area.y)),
        width,
        height,
    }
}

/// 全部显示器的工作区（逻辑像素，主屏排第一）—— `resolve_rect` 的「退回主屏」靠这个顺序
fn work_areas(app: &AppHandle) -> Vec<WorkArea> {
    let area_of = |m: &tauri::Monitor| {
        let sf = m.scale_factor();
        let wa = m.work_area();
        WorkArea {
            x: f64::from(wa.position.x) / sf,
            y: f64::from(wa.position.y) / sf,
            width: f64::from(wa.size.width) / sf,
            height: f64::from(wa.size.height) / sf,
        }
    };
    let primary = app.primary_monitor().ok().flatten().map(|m| area_of(&m));
    let mut out: Vec<WorkArea> = Vec::new();
    if let Some(area) = primary {
        out.push(area);
    }
    if let Ok(monitors) = app.available_monitors() {
        for area in monitors.iter().map(area_of) {
            if Some(area) != primary {
                out.push(area);
            }
        }
    }
    out
}

/// 把悬浮窗压回宠物窗**正下方**，落实「本体永远压住 overlay」这条对外承诺
/// （ADR-0010 决策 5，路线 b）。宠物窗与 overlay 同在 topmost 层内，`show()` 会把
/// 窗口抬到层顶（现场三次采样都是 overlay 压着宠物），所以每次 show 之后重放一次层内相对次序。
///
/// 全程安静失败：句柄拿不到、`SetWindowPos` 报错都只记一条 warn ——
/// 宁可少一次抬升，不能让整条显示链路挂掉（宿主对 GUI 稳定性的口径）。
#[cfg(windows)]
fn raise_above_pet(app: &AppHandle, label: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    let (Some(pet), Some(overlay)) = (app.get_webview_window("pet"), app.get_webview_window(label))
    else {
        return;
    };
    let (Ok(pet_hwnd), Ok(overlay_hwnd)) = (pet.hwnd(), overlay.hwnd()) else {
        log::warn!("z 序重放：拿不到窗口句柄（pet 或 {label}），跳过");
        return;
    };
    // SAFETY: 两个句柄都来自本进程存活中的窗口；只调 overlay 的层内次序，
    // SWP_NOMOVE|SWP_NOSIZE 保证不碰位置尺寸，SWP_NOACTIVATE 保证不抢焦点。
    let placed = unsafe {
        SetWindowPos(
            overlay_hwnd,
            Some(pet_hwnd),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
    if let Err(e) = placed {
        log::warn!("z 序重放失败（{label}）：{e}");
    }
}

#[cfg(not(windows))]
fn raise_above_pet(_app: &AppHandle, _label: &str) {}

fn apply_visibility(app: &AppHandle, plugin_id: &str) {
    let Some(state) = snapshot(plugin_id) else {
        return;
    };
    let label = overlay_label(plugin_id);
    let Some(win) = app.get_webview_window(&label) else {
        // 窗还没建（或已被页面自己关掉）：意愿留着，下次 show 再建
        return;
    };
    let show = state.wanted && !SUPPRESSED.load(Ordering::SeqCst);
    if show {
        let _ = win.show();
        raise_above_pet(app, &label);
    } else {
        let _ = win.hide();
    }
    if state.visible != show {
        if let Some(entry) = table()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(plugin_id)
        {
            entry.visible = show;
        }
    }
}

/// 宠物隐身/恢复时由宿主调用（见 window::pet::set_pet_hidden）：
/// 卡片贴在宠物身上或桌面上，宠物隐身时留着既难看又泄露信息，所以一起收掉；
/// 恢复时按各插件当时的意愿决定显不显示。
///
/// 这里同时是「本体压住 overlay」在恢复路径上的**唯一**重放点：`show()` 会把窗口抬到
/// topmost 层顶，所以每扇窗 show 之后紧跟一次 `raise_above_pet`（ADR-0010 修订 2026-10-16）。
pub fn set_suppressed(app: &AppHandle, suppressed: bool) {
    SUPPRESSED.store(suppressed, Ordering::SeqCst);
    let ids: Vec<String> = table()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .keys()
        .cloned()
        .collect();
    for id in ids {
        apply_visibility(app, &id);
    }
}

fn ensure_window(app: &AppHandle, plugin_id: &str, rect: Rect) -> Result<(), HostError> {
    let label = overlay_label(plugin_id);
    if let Some(win) = app.get_webview_window(&label) {
        // 窗已存在：这一轮请求的坐标/高度也要落下去，否则「插件改了位置再 show」
        // 只在第一次建窗时生效（ADR-0010 落地口径第 3 条）
        let _ = win.set_size(LogicalSize::new(rect.width, rect.height));
        let _ = win.set_position(LogicalPosition::new(rect.x, rect.y));
        return Ok(());
    }
    // 页面靠自己的窗口标签（overlay-<插件 id>）认卡片属于谁，不必再传查询串
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("src/overlay.html".into()))
        // 标题带上插件 id：多扇悬浮窗在 CDP / 任务管理器里才分得清是谁的
        .title(format!("DesktopPet Overlay · {plugin_id}"))
        .position(rect.x, rect.y)
        .inner_size(rect.width, rect.height)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|e| HostError::new(INTERNAL, e.to_string()))?;
    // 死条目清理的第三个挂点（原来在跟随线程的 retain 里）：窗被页面自己关掉
    // （插件停用换茬）或被回收时，摘掉「窗已不在、意愿也收了」的条目
    {
        let close_app = app.clone();
        let close_label = label.clone();
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                sweep_dead_entries(|id| {
                    let label = overlay_label(id);
                    label != close_label && close_app.get_webview_window(&label).is_some()
                });
            }
        });
    }
    // 悬浮层永远不拦截鼠标
    let _ = win.set_ignore_cursor_events(true);
    Ok(())
}

/// 插件 id 会进窗口标签，先过宿主既有的 id 规则
fn check_id(plugin_id: &str) -> Result<(), HostError> {
    if crate::ids::is_safe_id(plugin_id) {
        Ok(())
    } else {
        Err(HostError::new(INVALID_ARG, "非法的插件 id"))
    }
}

/// S3：悬浮层是插件的脸面，也得按能力放行。以前只有 JS 桥 `ctx.overlay` 上的 gated
/// 一层在挡，绕过桥的插件可以凭空开一扇置顶透明窗，既不消耗配额也不留授权记录。
/// 同 realm 的插件冒名他人 id 仍拦不住（见 gate.rs）。
/// G3-01：先过窗口归属 —— 悬浮窗只能替自己那个插件开/收悬浮层，别的 id 一律拒。
fn check_grant(
    window: &tauri::Window,
    perms: &PermissionState,
    plugin_id: &str,
) -> Result<(), HostError> {
    check_id(plugin_id)?;
    crate::gate::plugin_capability(window, perms, plugin_id, crate::plugin_caps::OVERLAY)
}

/// 收掉某插件的悬浮层（移出注册表 + 关窗）。
/// 命令面与宿主内部回收共用这一份，差别只在调用前要过谁的门禁。
fn reclaim(app: &AppHandle, plugin_id: &str) {
    table()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(plugin_id);
    if let Some(win) = app.get_webview_window(&overlay_label(plugin_id)) {
        let _ = win.close();
    }
}

/// 宿主内部的回收（撤销授权时调用）：那时能力已经没了，走不了命令面的门禁
pub fn reclaim_for_permission(app: &AppHandle, plugin_id: &str) {
    reclaim(app, plugin_id);
}

/// 死条目清理：窗已经不在、意愿也收了的条目（原来挂在跟随线程的 `retain` 上，
/// 线程删除后由 hide / destroy / overlay 窗关闭事件接手）。「窗在不在」由调用面注入，
/// 单测喂假的存在性即可，不必造 AppHandle。
fn sweep_dead_entries<F: Fn(&str) -> bool>(window_alive: F) {
    table()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|id, s| s.wanted || s.visible || window_alive(id));
}

/// `overlay_hide` 的尾部主体：收掉这个插件的意愿，并顺手清死条目。
fn release_wanted_and_sweep<F: Fn(&str) -> bool>(plugin_id: &str, window_alive: F) {
    if let Some(entry) = table()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(plugin_id)
    {
        entry.wanted = false;
    }
    sweep_dead_entries(window_alive);
}

/// 迁移期简写：窗口归属判定的拒绝（文案一字不改，只补码 —— ADR-0007）
fn denied(msg: String) -> HostError {
    HostError::new(DENIED, msg)
}

/// 谁能代表某个插件动它的悬浮层：宠物窗（运行时与插件同 realm）、设置窗（插件设置页）、
/// 以及该插件自己那扇悬浮窗 —— 后者的归属由注册表判定，页面自报的 id 在这一路不算。
fn caller_may_act_for(label: &str, plugin_id: &str) -> bool {
    label == "pet" || label == "settings" || owner_of_label(label).as_deref() == Some(plugin_id)
}

/// 显示（或创建）本插件的悬浮层。位置由插件直传**逻辑像素** `x`/`y`（缺省落 24,24），
/// 宿主只做「按所在显示器工作区整块夹进屏内」这一件事；`placement` 已废弃（ADR-0010 决策 3）：
/// 接受但忽略，带值时记一条 warn —— 过渡期不破坏还在传它的老插件。
#[tauri::command]
pub async fn overlay_show(
    perms: tauri::State<'_, PermissionState>,
    window: tauri::Window,
    plugin_id: String,
    placement: Option<String>,
    height: Option<u32>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), HostError> {
    // app 从调用窗取：平铺 IPC 参数刚好卡在 clippy 的参数上限内，少注入一个就够
    let app = window.app_handle();
    check_grant(&window, &perms, &plugin_id)?;
    if !caller_may_act_for(window.label(), &plugin_id) {
        return Err(denied(format!(
            "窗口 {} 不能为插件 {plugin_id} 开悬浮层",
            window.label()
        )));
    }
    require_installed(app, &plugin_id)?;
    if let Some(requested) = placement.as_deref() {
        log::warn!("overlay_show：placement（{requested}）已废弃，本次按 x/y 定位");
    }
    mark_wanted(&plugin_id);
    let rect = resolve_rect(x, y, height, &work_areas(app));
    ensure_window(app, &plugin_id, rect)?;
    apply_visibility(app, &plugin_id);
    Ok(())
}

/// 只为确实装着的插件开窗：凭空的 id 会留下一扇没人认领、也没人能收掉的窗
/// （插件之间的越权仍拦不住，那是自报 plugin_id 的固有问题，见 gate.rs 与 R2）
fn require_installed(app: &AppHandle, plugin_id: &str) -> Result<(), HostError> {
    let installed = crate::commands::plugins::installed_plugin_ids(app)
        .map(|ids| ids.iter().any(|id| id == plugin_id))
        .unwrap_or(false);
    if installed {
        Ok(())
    } else {
        Err(HostError::new(
            NOT_FOUND,
            format!("插件 {plugin_id} 没有安装，不能开悬浮层"),
        ))
    }
}

/// 记下「这个插件想要一扇悬浮窗」。新建的状态一律 `visible: false`，
/// 由 `apply_visibility` 按当前压制状态决定要不要真的显示出来。
/// 位置不在这里存：按 ADR-0010 决策 4，坐标归插件自己（`ctx.storage`），宿主不记。
fn mark_wanted(plugin_id: &str) {
    table().lock().unwrap_or_else(|p| p.into_inner()).insert(
        plugin_id.to_string(),
        OverlayState {
            wanted: true,
            visible: false,
        },
    );
}

#[tauri::command]
pub async fn overlay_hide(
    app: AppHandle,
    perms: tauri::State<'_, PermissionState>,
    window: tauri::Window,
    plugin_id: String,
) -> Result<(), HostError> {
    check_grant(&window, &perms, &plugin_id)?;
    if !caller_may_act_for(window.label(), &plugin_id) {
        return Err(denied(format!(
            "窗口 {} 不能收起插件 {plugin_id} 的悬浮层",
            window.label()
        )));
    }
    release_wanted_and_sweep(&plugin_id, |id| {
        app.get_webview_window(&overlay_label(id)).is_some()
    });
    apply_visibility(&app, &plugin_id);
    Ok(())
}

/// 插件主动销毁自己那扇悬浮层，释放资源
#[tauri::command]
pub async fn overlay_destroy(
    app: AppHandle,
    perms: tauri::State<'_, PermissionState>,
    window: tauri::Window,
    plugin_id: String,
) -> Result<(), HostError> {
    check_grant(&window, &perms, &plugin_id)?;
    if !caller_may_act_for(window.label(), &plugin_id) {
        return Err(denied(format!(
            "窗口 {} 不能销毁插件 {plugin_id} 的悬浮层",
            window.label()
        )));
    }
    reclaim(&app, &plugin_id);
    sweep_dead_entries(|id| app.get_webview_window(&overlay_label(id)).is_some());
    Ok(())
}

/// 宿主的回收通道（宠物窗里的运行时在插件停用/卸载时调用）：
/// 撤销授权会把能力收走，那时插件面的门禁已经过不去，窗却还留着 —— 等于泄露信息。
#[tauri::command]
pub async fn overlay_reclaim(
    app: AppHandle,
    window: tauri::Window,
    plugin_id: String,
) -> Result<(), HostError> {
    crate::gate::pet(&window, "回收插件悬浮层")?;
    check_id(&plugin_id)?;
    reclaim(&app, &plugin_id);
    Ok(())
}

/// overlay_list 的单行。第三元是常量 `"custom"`：位置由插件自定后宿主不再分档
/// （ADR-0010 决策 3/4），旧档位词不再从这条路径产出。
fn list_row(id: &str, visible: bool) -> (String, bool, String) {
    (id.to_string(), visible, "custom".to_string())
}

/// 当前有哪些悬浮层在显示（回归与诊断用）
#[tauri::command]
pub async fn overlay_list(app: AppHandle) -> Result<Vec<(String, bool, String)>, HostError> {
    let guard = table().lock().unwrap_or_else(|p| p.into_inner());
    Ok(guard
        .iter()
        .map(|(id, s)| {
            list_row(
                id,
                s.visible && app.get_webview_window(&overlay_label(id)).is_some(),
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        caller_may_act_for, list_row, mark_wanted, overlay_label, release_wanted_and_sweep,
        resolve_rect, table, OverlayState, Rect, WorkArea,
    };

    #[test]
    fn dots_and_hyphens_do_not_share_a_label() {
        assert_eq!(overlay_label("com.pet.hr-ble"), "overlay-com_pet_hr-ble");
        // 早先两者都压成 `-`，a.b 与 a-b 会抢同一扇窗，归属按迭代序乱认
        assert_ne!(overlay_label("a.b"), overlay_label("a-b"));
    }

    #[test]
    fn labels_stay_inside_the_tauri_charset() {
        for id in ["todo", "com.pet.hr-ble", "zz.probe", "a1.2-3"] {
            let label = overlay_label(id);
            assert!(
                label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')),
                "{label} 含非法字符"
            );
        }
    }

    /// S3：动得了悬浮层的只有三类调用面 —— 宠物窗、设置窗、以及该插件自己那扇窗。
    /// 「自己那扇」的归属来自注册表，不是来自页面自报的 id。
    #[test]
    fn only_host_windows_or_the_own_overlay_may_act_for_a_plugin() {
        let id = "com.pet.hr-ble".to_string();
        table()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone(), OverlayState::default());
        let label = overlay_label(&id);
        assert!(caller_may_act_for("pet", &id));
        assert!(caller_may_act_for("settings", &id));
        assert!(caller_may_act_for(&label, &id));
        // 别人的悬浮窗里动不了这扇（归属不匹配）
        assert!(!caller_may_act_for(&label, "todo"));
        // 同意框一类窗口既不是宿主窗，也不属于这个插件
        assert!(!caller_may_act_for("consent-r1", &id));
        table()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
    }

    /// 转换自 mark_wanted_records_placement_and_starts_unseen（原断言把 placement 当作
    /// 必须记住的输入；位置不再落宿主 state —— ADR-0010 决策 4 宿主不记坐标，替换断言是
    /// 同位置那组 resolve_rect 表驱动）。留下的两条语义逐字不变。
    #[test]
    fn mark_wanted_starts_hidden() {
        let id = "zz.shape-probe";
        mark_wanted(id);
        let state = table()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned();
        table().lock().unwrap_or_else(|p| p.into_inner()).remove(id);
        let state = state.expect("mark_wanted 该留下一条状态");
        assert!(state.wanted, "调用即表示这个插件想要一扇窗");
        assert!(
            !state.visible,
            "可见性交给 apply_visibility，不在这里预先置真"
        );
    }

    /// ADR-0010 落地口径第 3 条：坐标夹紧规则抽出命令体后逐条钉住 ——
    /// 缺省、原样、负坐标、越右/越下、高度钳制、负原点屏、第二屏、退回主屏、屏幕比窗还小。
    #[test]
    fn resolve_rect_clamps_into_the_work_area() {
        let primary = WorkArea {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let second = WorkArea {
            x: 1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let left_of_origin = WorkArea {
            x: -1920.0,
            y: -100.0,
            width: 1920.0,
            height: 1080.0,
        };
        let tiny = WorkArea {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 100.0,
        };
        /// 一行样例：说明、x、y、height、工作区表、期望矩形
        type RectCase = (
            &'static str,
            Option<f64>,
            Option<f64>,
            Option<u32>,
            Vec<WorkArea>,
            Rect,
        );
        let cases: Vec<RectCase> = vec![
            (
                "缺省落 (24,24)：插件第一次显示时不知道屏幕多大",
                None,
                None,
                None,
                vec![primary],
                Rect {
                    x: 24.0,
                    y: 24.0,
                    width: 320.0,
                    height: 200.0,
                },
            ),
            (
                "工作区内的坐标原样保留",
                Some(100.0),
                Some(200.0),
                Some(300),
                vec![primary],
                Rect {
                    x: 100.0,
                    y: 200.0,
                    width: 320.0,
                    height: 300.0,
                },
            ),
            (
                "负坐标夹回工作区左上角",
                Some(-50.0),
                Some(-10.0),
                None,
                vec![primary],
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 320.0,
                    height: 200.0,
                },
            ),
            (
                "越右/越下按整块（含宽度 320）留在屏内",
                Some(1900.0),
                Some(1000.0),
                None,
                vec![primary],
                Rect {
                    x: 1600.0,
                    y: 880.0,
                    width: 320.0,
                    height: 200.0,
                },
            ),
            (
                "高度先钳进 48~900，再算纵向夹紧",
                Some(700.0),
                Some(900.0),
                Some(9999),
                vec![primary],
                Rect {
                    x: 700.0,
                    y: 180.0,
                    width: 320.0,
                    height: 900.0,
                },
            ),
            (
                "负原点的屏：请求点在屏外也夹回它的边界",
                Some(-2000.0),
                Some(50.0),
                None,
                vec![left_of_origin],
                Rect {
                    x: -1920.0,
                    y: 50.0,
                    width: 320.0,
                    height: 200.0,
                },
            ),
            (
                "请求点落在第二块屏就用第二块的工作区",
                Some(2000.0),
                Some(100.0),
                None,
                vec![primary, second],
                Rect {
                    x: 2000.0,
                    y: 100.0,
                    width: 320.0,
                    height: 200.0,
                },
            ),
            (
                "请求点不在任何屏内退回主屏（列表第一个）",
                Some(5000.0),
                Some(100.0),
                None,
                vec![primary, second],
                Rect {
                    x: 1600.0,
                    y: 100.0,
                    width: 320.0,
                    height: 200.0,
                },
            ),
            (
                "屏幕比窗还小也整块贴在原点（夹紧不许 panic）",
                None,
                None,
                None,
                vec![tiny],
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 320.0,
                    height: 200.0,
                },
            ),
        ];
        for (name, x, y, h, areas, want) in cases {
            assert_eq!(resolve_rect(x, y, h, &areas), want, "{name}");
        }
    }

    /// ADR-0010 落地口径第 2 条：跟随线程删了，它兼的「死条目清理」由 hide/destroy/关闭事件接手。
    /// 这里走 overlay_hide 的尾部（release_wanted_and_sweep），证明死条目会被摘掉、其余条目不受影响。
    #[test]
    fn overlay_hide_tail_sweeps_dead_entries_only() {
        let dead = "zz.dead-entry";
        let still_wanted = "zz.still-wanted";
        let live_window = "zz.live-window";
        {
            let mut guard = table().lock().unwrap_or_else(|p| p.into_inner());
            for id in [dead, still_wanted, live_window] {
                guard.insert(
                    id.to_string(),
                    OverlayState {
                        wanted: true,
                        visible: false,
                    },
                );
            }
        }
        // 清理跑在共享注册表上：谓词按 id 保护其余条目，「窗没了」只对 dead 这一个 id 成立
        release_wanted_and_sweep(dead, |id: &str| id != dead);
        release_wanted_and_sweep(live_window, |_| true);
        let guard = table().lock().unwrap_or_else(|p| p.into_inner());
        assert!(
            !guard.contains_key(dead),
            "窗没了、意愿也收了的条目必须被摘掉"
        );
        assert!(
            guard.contains_key(still_wanted),
            "意愿还在的条目不许清（下次 show 复用条目、重建窗）"
        );
        assert!(guard.contains_key(live_window), "窗还在的条目不许清");
        drop(guard);
        let mut guard = table().lock().unwrap_or_else(|p| p.into_inner());
        guard.remove(still_wanted);
        guard.remove(live_window);
    }

    /// ADR-0010 决策 3/4：位置归插件自定后宿主不再分档 —— overlay_list 第三元恒为常量 "custom"，
    /// 旧档位词从这个文件里整体退场，一个字面都不该再产出。
    #[test]
    fn overlay_list_rows_are_always_custom() {
        let (id, visible, kind) = list_row("zz.probe", true);
        assert_eq!(id, "zz.probe");
        assert!(visible);
        assert_eq!(kind, "custom", "第三元是常量档位：宿主不再分档");
        let flat = include_str!("overlay.rs")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            !flat.contains(concat!("ab", "ove-pet")),
            "旧档位词不该再出现在宿主源码里"
        );
        assert!(
            !flat.contains(concat!("cor", "ner")),
            "旧档位词不该再出现在宿主源码里"
        );
    }

    /// A03 同款口径：命令不能取符号，参数名却是 JS 侧逐字对上的 IPC 契约 ——
    /// 少一个或改个名，调用会安静地按 None 落缺省（「窗开在 24,24」而不是报错）。
    /// 期望串拆两段写：整串字面量会匹配到本测试自己、恒真。
    #[test]
    fn overlay_show_signature_keeps_position_params() {
        let flat = include_str!("overlay.rs")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            flat.contains(concat!(
                "placement: Option<String>, height: Option<u32>, x: Option<f64>, y: Option<f64>,",
                " ) -> Result<(), HostError> {"
            )),
            "overlay_show 的平铺参数（pluginId/placement/height/x/y）必须与 JS 侧逐字对上"
        );
    }

    /// 同一个 pin 口径补调用点那一半：参数名对上了，**传参顺序**还得对。
    /// `x`/`y` 同为 `Option<f64>`，写成 `resolve_rect(y, x, …)` 编译照过、
    /// `resolve_rect` 自己的表驱动也照样绿（它收到什么算什么），所以这一半只能钉源码文本。
    /// 拆两段写同一个理由：整串字面量会匹配到本测试自己。
    #[test]
    fn overlay_show_passes_x_before_y_into_resolve_rect() {
        let flat = include_str!("overlay.rs")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            flat.contains(concat!("let rect = resolve_rect(", "x, y, height,")),
            "命令体必须按 (x, y, height) 的顺序喂 resolve_rect，对调不会编译报错"
        );
    }

    /// A2 / ADR-0007：overlay_list 体内没有错误产生点（一条 `?` 都没有），签名照样要改 ——
    /// 在源码文本层钉住（命令函数不能取符号，会把 tauri 命令机制拉进测试 exe 链接，A03 实测）。
    /// 期望串用 concat! 拆两段：本测试就在被 include_str! 读的文件里，
    /// 整串写字面量的话断言会匹配到自己、恒真。拆开后任何一段都不是完整签名。
    #[test]
    fn overlay_list_signature_declares_host_error() {
        let flat = include_str!("overlay.rs")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            flat.contains(concat!(
                "pub async fn overlay_list(app: AppHandle) -> Result<Vec<(String, bool, String)>",
                ", HostError> {"
            )),
            "overlay_list 的 Err 侧必须是 HostError"
        );
    }
}
