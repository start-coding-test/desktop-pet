//! 插件启停与 hook 装卸的联动（方案 §1.2）。
//!
//! 为什么联动必须住在宿主而不是插件里：插件的 `deactivate()` 在崩溃、被强杀或卸载时
//! 不一定跑得起来，而 `plugin_enabled_set`（services/enabled.rs）本来就是启停清单的唯一
//! 写入口 —— 在那里比较新旧清单，装和卸都拦得住。
//!
//! 落盘的只有一件事：用户的显式选择（`agent`）。联动开合本身**不落盘** ——
//! 它由「已启用插件里有没有任一 manifest 声明 `agent:hooks`」现算，写下来只会多一个
//! 会和磁盘打架的事实源。
//!
//! 谁能写 `agent`（口径来自派单，不在此重议）：
//!   * 写：只有用户的显式操作 —— 设置页装成功（`agent = "qoder"`）、设置页卸载或撤销授权
//!     连带的卸载（`agent = null`）。
//!   * 不写：启停差异、删除插件、启动清理、`--pet-hook-cleanup`。停用导致的卸载不是退出，
//!     重新启用时全靠这个字段把安装恢复回来。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::plugin_caps::AGENT_HOOKS;
use crate::services::agent::phases::DEFAULT_AGENT;
use crate::services::agent::AgentState;
use crate::services::agent_hooks::{self, FileReport};
use crate::services::permission::PermissionState;

/// 宿主状态文件名（`<app_data>/agent-linkage.json`，原子写）
const FILE_NAME: &str = "agent-linkage.json";

/// PR-1 里唯一可写的 Agent 值。PR-2 接进适配器与四选一设置页之后，
/// 「关→开」的判据才会从「等于 qoder」放宽成「非空」，那时这张表才长第二行。
pub const QODER: &str = "qoder";

/// 联动开着时 watcher 才广播。默认 true：启动阶段还没算出现状之前不该把既有行为
/// 改成「静默」—— 那会让宠物看起来坏了。
static BROADCAST: AtomicBool = AtomicBool::new(true);

/// 用户显式选择的三种读回结果。「说不出」分两种，而且对写入的态度不同：
/// 从没写过（升级上来的老用户，需要补写）与读坏了（绝不覆盖，让用户自己修）。
#[derive(Debug, PartialEq, Eq)]
enum Loaded {
    Absent,
    Corrupt,
    Known(Option<String>),
}

/// 迁移结果，单测靠它区分「补写了」与「本来就有记录」
#[derive(Debug, PartialEq, Eq)]
pub enum Migrate {
    /// 本次补写进状态文件的 agent 值（None = 显式记成「没选过」）
    Wrote(Option<String>),
    /// 状态文件已有记录，原样保留（PR-2 的 prevHooksEnabled 等键靠这条不被抹掉）
    AlreadyRecorded,
    /// 状态文件读坏或写不进：不动它，本次按「没选过」处理
    Corrupt,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Install,
    Uninstall,
    None,
}

impl Action {
    fn report_name(&self) -> &'static str {
        match self {
            Action::Install => "install",
            Action::Uninstall => "uninstall",
            Action::None => "",
        }
    }
}

pub fn state_path(app_data: &Path) -> PathBuf {
    app_data.join(FILE_NAME)
}

pub fn broadcast_allowed() -> bool {
    BROADCAST.load(Ordering::Relaxed)
}

fn set_broadcast(on: bool) {
    BROADCAST.store(on, Ordering::Relaxed);
}

/// 当前 Agent 的进程内缓存。来源过滤要对**每一行**事件比对它，不能每行去开磁盘；
/// 而这个文件只有本进程会写（设置页与启停联动都在宿主里），所以写完即刷新就足够一致。
/// 独立的 `--pet-hook-cleanup` 进程只读不写 `agent`，不会把这个缓存带歪。
static CURRENT_AGENT: RwLock<Option<String>> = RwLock::new(None);

/// 缓存里认定的当前 Agent。还没读过状态文件时按 `qoder` —— 与 `--agent` 缺省同一口径，
/// 所以 A01 时代不带来源字段的事件与 hook 条目都不会被自己的过滤器误杀。
pub fn current_agent() -> String {
    CURRENT_AGENT
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_else(|| DEFAULT_AGENT.to_string())
}

/// 从状态文件把缓存刷成新值，并回传该值。写完之后、启动补写之后都必须调用，
/// 否则来源过滤会拿旧值去判新到的事件。
pub fn sync_current_agent(app_data: &Path) -> Option<String> {
    let agent = agent_choice(app_data);
    *CURRENT_AGENT.write().unwrap_or_else(|p| p.into_inner()) = agent.clone();
    agent
}

fn load(app_data: &Path) -> Loaded {
    let path = state_path(app_data);
    let raw = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded::Absent,
        // 读不动不等于没写过：按「说不出」处理，且绝不因此改写文件
        Err(_) => return Loaded::Corrupt,
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) if value.is_object() => Loaded::Known(
            value
                .get("agent")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        _ => Loaded::Corrupt,
    }
}

/// 当前记录的用户选择。读不出来一律按「没选过」，但**不写回** ——
/// 半截文件被当成空文件覆盖，等于把用户的选择抹了。
pub fn agent_choice(app_data: &Path) -> Option<String> {
    match load(app_data) {
        Loaded::Known(agent) => agent,
        _ => None,
    }
}

pub fn record_choice(app_data: &Path, agent: Option<&str>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&json!({ "schema": 1, "agent": agent }))
        .map_err(|e| e.to_string())?;
    crate::fsutil::write_atomic(&state_path(app_data), text.as_bytes())
        .map_err(|e| e.message.clone())
}

/// 设置页装成功 = 用户的显式选择，记下来供「停用→再启用」恢复。
/// 全部文件都失败时不记：否则下次启用插件会去装一个从没成功过的 hook。
///
/// 命令体只加这一行调用 —— `check:shape` 把命令体限在 20 行且不许出现 IO 原语，
/// 状态文件读写必须住在服务层。
pub fn note_installed(app: &AppHandle, reports: &[FileReport]) {
    if !agent_hooks::any_installed(reports) {
        return;
    }
    note_choice(app, Some(QODER));
}

/// 设置页主动卸载，或「撤销授权」连带的宿主卸载：都算用户明确退出，记成 null。
pub fn note_uninstalled(app: &AppHandle) {
    note_choice(app, None);
}

/// 写状态文件。**失败只记日志**：装卸本身已经落到 Agent 的配置里了，
/// 不该因为状态文件写不进去而让命令报错、把成功的事说成失败。
fn note_choice(app: &AppHandle, agent: Option<&str>) {
    let Some(data) = app_data(app) else { return };
    if let Err(e) = record_choice(&data, agent) {
        log::warn!("写入联动状态失败: {e}");
    }
    // 写完立刻刷新：来源过滤与「切换清会话」都读这个缓存，不能等下次启动再对齐
    let before = current_agent();
    let after = sync_current_agent(&data)
        .map(|a| a.to_string())
        .unwrap_or_else(|| before.clone());
    if after != before {
        // 换人了：旧 Agent 的会话表必须清空，否则状态卡会拿着上一个 Agent 的会话继续演
        let n = app.state::<std::sync::Arc<AgentState>>().clear_sessions();
        log::info!("当前 Agent 由 {before} 切到 {after}，清掉 {n} 条会话");
    }
}

/// 升级路径：「用户装过 hook」这件事在老版本里只写在 Agent 的配置文件中，宿主没有状态文件。
///
/// **必须在清理之前调用**（顺序即判据，见 startup 的源码断言）：清理会把自家条目摘掉，
/// 先摘就再也看不出用户装过，于是「停用摘掉、再启用恢复」对升级上来的用户永远不成立。
pub fn migrate_from_legacy(app_data: &Path, files: &[PathBuf]) -> Migrate {
    match load(app_data) {
        Loaded::Known(_) => return Migrate::AlreadyRecorded,
        Loaded::Corrupt => return Migrate::Corrupt,
        Loaded::Absent => {}
    }
    let installed = agent_hooks::status_reports(files)
        .iter()
        .map(|r| r.managed)
        .sum::<usize>()
        > 0;
    let agent = if installed {
        Some(QODER.to_string())
    } else {
        None
    };
    match record_choice(app_data, agent.as_deref()) {
        Ok(()) => Migrate::Wrote(agent),
        Err(e) => {
            log::warn!("补写联动状态失败: {e}");
            Migrate::Corrupt
        }
    }
}

/// 「该装还是该卸」的唯一判据。纯函数：命令层与 AppHandle 那侧只负责凑参数。
///
/// `prev_on = None` 表示启停清单还不存在（老用户尚未迁移）。那一次写入不是用户点开关，
/// 所以既不装也不卸 —— 否则「第一次迁移」就成了「宿主替用户悄悄装 hook」。
pub fn decide(prev_on: Option<bool>, now_on: bool, consented: bool, agent: Option<&str>) -> Action {
    match prev_on {
        None => Action::None,
        Some(false) if now_on => {
            // 关 → 开：同意过、且用户显式选过 Agent，才装
            if consented && agent == Some(QODER) {
                Action::Install
            } else {
                Action::None
            }
        }
        Some(true) if !now_on => Action::Uninstall,
        Some(_) => Action::None,
    }
}

/// 联动的唯一判据：已启用插件里有没有任一 manifest 声明 `agent:hooks`。不写死插件 id。
/// manifest 读不到（插件目录被删）就按「没声明」算 —— 那正是「删除插件等于关闭联动」。
pub fn linkage_on(app: &AppHandle, ids: &[String]) -> bool {
    ids.iter().any(|id| {
        crate::commands::plugins::declared_capabilities(app, id)
            .map(|caps| caps.iter().any(|c| c == AGENT_HOOKS))
            .unwrap_or(false)
    })
}

/// 这些 id 里有没有任一已经同意过 `agent:hooks`（ADR-0001 同意框的结果）。
fn any_consented(app: &AppHandle, ids: &[String]) -> bool {
    let perms = app.state::<PermissionState>();
    ids.iter().any(|id| perms.is_granted(id, AGENT_HOOKS))
}

fn app_data(app: &AppHandle) -> Option<PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => Some(dir),
        Err(e) => {
            log::warn!("拿不到宿主数据目录，本次不做联动: {e}");
            None
        }
    }
}

/// 候选配置文件。一个都没有 = 没装那个 Agent，不是失败。
fn candidate_files(app: &AppHandle) -> Vec<PathBuf> {
    match app.path().home_dir() {
        Ok(home) => agent_hooks::candidate_files(&home),
        Err(e) => {
            log::warn!("拿不到用户主目录，跳过 hook 文件: {e}");
            Vec::new()
        }
    }
}

fn install(files: &[PathBuf]) -> Vec<FileReport> {
    if files.is_empty() {
        log::info!("没有 Qoder 配置目录，跳过安装");
        return Vec::new();
    }
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(e) => {
            return vec![FileReport {
                path: String::new(),
                managed: 0,
                error: Some(format!("取不到自身路径: {e}")),
            }]
        }
    };
    agent_hooks::install_files(files, &exe)
}

fn uninstall(files: &[PathBuf]) -> Vec<FileReport> {
    agent_hooks::uninstall_files(files)
}

/// 装卸结果广播给设置页（PR-1 只发不接：agent 桥设置页的消费端在 PR-2）。
fn report(app: &AppHandle, action: &str, files: &[FileReport]) {
    let _ = app.emit(
        "host:agent-hooks-report",
        json!({ "action": action, "files": files }),
    );
}

/// 算出该做的动作、执行并广播。`prev_on` 是差异基线：启停路径取旧清单算出的值，
/// 磁盘重算路径取「宿主上一次认定的联动状态」。
fn apply(app: &AppHandle, prev_on: Option<bool>, now_on: bool, ids: &[String]) {
    // 广播闸门先按现状拨过去：卸载失败也不该让 watcher 继续把事件推给宠物
    set_broadcast(now_on);
    let Some(data) = app_data(app) else { return };
    let agent = sync_current_agent(&data);
    let action = decide(prev_on, now_on, any_consented(app, ids), agent.as_deref());
    if action == Action::None {
        return;
    }
    let name = action.report_name();
    let files = candidate_files(app);
    let reports = match action {
        Action::Install => install(&files),
        _ => uninstall(&files),
    };
    for r in &reports {
        if let Some(e) = &r.error {
            log::warn!("hook {name} 失败: {e} (path: {})", r.path);
        }
    }
    report(app, name, &reports);
}

/// 启停清单写入后的联动。
///
/// 调用方（`plugin_enabled_set` / `plugin_enabled_migrate`）都已把清单落盘才走到这里，
/// 而且这个函数没有 Result —— **装卸失败绝不拦启停**是构造出来的，不是靠调用方记得忽略错误。
pub fn reconcile(app: &AppHandle, previous: Option<&[String]>, next: &[String]) {
    let now_on = linkage_on(app, next);
    apply(app, previous.map(|ids| linkage_on(app, ids)), now_on, next);
}

/// 插件目录被改动（含整目录删除）后的重算。运行期没有「卸载插件」命令，
/// 删除只体现在磁盘上，所以差异基线取宿主上次认定的状态。
pub fn resync(app: &AppHandle) {
    let Some(ids) = crate::services::enabled::list_ids(app) else {
        // 清单还不存在 = 现状说不出，保持原样（与 startup 的 Unknown 同一口径）
        return;
    };
    let now_on = linkage_on(app, &ids);
    apply(app, Some(broadcast_allowed()), now_on, &ids);
}

/// 启动阶段广播闸门该拨到哪；返回 `None` 表示**不拨**，保持默认（开）。
///
/// 启停清单还不存在时不能推出「联动是关的」：那样宠物对 Agent 一律不响应，要等
/// `plugin_enabled_migrate` 跑完才恢复 —— 老用户升级后第一次启动正是这个形状，症状与
/// 「agent 桥坏了」无异。另一个受害者是 `resync`：它拿 `broadcast_allowed()` 当差异基线，
/// 基线错了后面每一步的装/卸判断都错。
pub fn startup_broadcast(ids: Option<&[String]>, linkage_on: bool) -> Option<bool> {
    ids.map(|_| linkage_on)
}

/// 按 `startup_broadcast` 的结论拨闸；结论是「不拨」就保持原样。单独成函数是为了让
/// 「清单不存在 → 广播照旧开着」这条能在单测里真的跑一遍，而不是只查判据表。
fn apply_startup_broadcast(ids: Option<&[String]>, linkage_on: bool) {
    if let Some(on) = startup_broadcast(ids, linkage_on) {
        set_broadcast(on);
    }
}

/// 应用启动：先补写老用户的选择，再按现状清理。
///
/// 「先补写、后清理」这个顺序本身就是判据，所以它写在 `startup_sequence` 里 —— 那边没有
/// AppHandle，单测能真的把顺序跑红；这里只负责把路径与现状凑出来。
pub fn startup(app: &AppHandle) {
    let Some(data) = app_data(app) else { return };
    let files = candidate_files(app);
    let ids = crate::services::enabled::list_ids(app);
    // 清单还不存在（尚未迁移）= 说不出现状：既不拨广播闸门，也不动手清理
    let on = ids.as_ref().is_some_and(|v| linkage_on(app, v));
    apply_startup_broadcast(ids.as_deref(), on);
    let migrated = startup_sequence(&data, &files, ids.as_deref(), on, &mut |files| {
        let reports = uninstall(files);
        for r in &reports {
            if let Some(e) = &r.error {
                log::warn!("启动清理失败: {e} (path: {})", r.path);
            }
        }
        report(app, "startup-cleanup", &reports);
    });
    log::info!("启动补写联动状态: {migrated:?}");
    // 补写可能刚刚新建了状态文件，缓存要在第一次读事件之前对齐
    sync_current_agent(&data);
}

/// 启动阶段的两步及其顺序。
///
/// `strip` 由调用方给（宿主那边是真的摘条目 + 广播），所以这个函数**没有装的能力** ——
/// 「启动只清不装」是签名层面的事实，不是注释里的约定。
/// `ids = None` 表示启停清单还不存在：说不出现状就不动手。
pub fn startup_sequence(
    app_data_dir: &Path,
    files: &[PathBuf],
    ids: Option<&[String]>,
    linkage_on: bool,
    strip: &mut dyn FnMut(&[PathBuf]),
) -> Migrate {
    let migrated = migrate_from_legacy(app_data_dir, files);
    if ids.is_some() && !linkage_on {
        strip(files);
    }
    migrated
}

/// `desktop-pet.exe --pet-hook-cleanup` 的实体：卸载应用前把自家条目摘净。
///
/// 这一分支跑在建窗与单实例锁之前，没有 AppHandle，所以路径全按环境变量和 Windows
/// 的约定自己解析。**任何失败都只打印，退出码恒为 0** —— 清理不能拦住卸载。
/// 与启动清理同一条口径：只读 `agent`，不写。
///
/// 输出是 ASCII 的 `key=value`：它要么被 NSIS 的 ExecWait 吞掉，要么在 e2e 里被解析，
/// 两种场合都不该依赖控制台代码页 —— 中文文案一旦变 mojibake，套件断言就红得没道理。
pub fn run_cleanup_cli() {
    let Some(home) = standalone_home() else {
        eprintln!("desktop-pet: hook cleanup result=skipped reason=no-home");
        return;
    };
    let files = agent_hooks::candidate_files(&home);
    if files.is_empty() {
        println!("desktop-pet: hook cleanup result=nothing-to-do files=0 stripped=0");
        return;
    }
    let reports = uninstall(&files);
    let stripped: usize = reports.iter().map(|r| r.managed).sum();
    let failed = reports.iter().filter(|r| r.error.is_some()).count();
    println!(
        "desktop-pet: hook cleanup result=done files={} stripped={stripped} failed={failed}",
        reports.len()
    );
    // 失败明细走 stderr：stdout 只留那行可解析的汇总
    for r in reports.iter().filter_map(|r| r.error.as_ref()) {
        eprintln!("desktop-pet: hook cleanup error: {r}");
    }
}

/// hook 分支与清理分支都在建窗之前，拿不到 `app.path().home_dir()`，
/// 只能按 Windows 约定自己拼（与 inbox.rs 的 app_data_dir_standalone 同一类做法）。
fn standalone_home() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("USERPROFILE") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let drive = std::env::var_os("HOMEDRIVE")?;
    let path = std::env::var_os("HOMEPATH")?;
    if drive.is_empty() || path.is_empty() {
        return None;
    }
    Some(PathBuf::from(format!(
        "{}{}",
        drive.to_string_lossy(),
        path.to_string_lossy()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pet-linkage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn managed_entry(phase: &str) -> Value {
        json!({
            "type": "command",
            "command": format!("\"C:\\app\\desktop-pet.exe\" --pet-hook {phase}"),
            "timeout": 2
        })
    }

    fn foreign_entry() -> Value {
        json!({ "type": "command", "command": "other-tool --notify", "timeout": 5 })
    }

    #[test]
    fn decide_installs_only_with_consent_and_a_recorded_agent() {
        assert_eq!(
            decide(Some(false), true, true, Some("qoder")),
            Action::Install,
            "关→开、同意过、选过 Agent 才装"
        );
        assert_eq!(
            decide(Some(false), true, false, Some("qoder")),
            Action::None,
            "没同意过就不装，交给设置页"
        );
        assert_eq!(
            decide(Some(false), true, true, None),
            Action::None,
            "agent 为空（从没从设置页装过）不装"
        );
        assert_eq!(
            decide(Some(false), true, true, Some("zcode")),
            Action::None,
            "PR-1 只认 qoder：状态文件里的别的值说明它被改坏了，不能拿它去装 Qoder 的 hook"
        );
    }

    #[test]
    fn decide_uninstalls_on_open_to_closed_and_does_nothing_else() {
        assert_eq!(
            decide(Some(true), false, true, Some("qoder")),
            Action::Uninstall
        );
        assert_eq!(
            decide(Some(true), true, true, Some("qoder")),
            Action::None,
            "开→开 幂等，不反复改写配置文件"
        );
        assert_eq!(
            decide(Some(false), false, false, None),
            Action::None,
            "关→关 不动文件"
        );
    }

    #[test]
    fn decide_never_acts_when_the_enabled_list_did_not_exist_yet() {
        // 第一次写清单（迁移）不是用户点开关：既不装也不卸
        assert_eq!(decide(None, true, true, Some("qoder")), Action::None);
        assert_eq!(decide(None, false, true, Some("qoder")), Action::None);
    }

    #[test]
    fn choice_roundtrip_and_explicit_null() {
        let dir = tmp_dir("roundtrip");
        assert_eq!(agent_choice(&dir), None, "没有状态文件 = 没选过");
        record_choice(&dir, Some(QODER)).unwrap();
        assert_eq!(agent_choice(&dir).as_deref(), Some(QODER));
        // 卸载是显式退出：写成 null 而不是删文件
        record_choice(&dir, None).unwrap();
        assert_eq!(agent_choice(&dir), None);
        assert!(state_path(&dir).is_file(), "写 null 不删状态文件");
        let text = fs::read_to_string(state_path(&dir)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap()["schema"], 1);
        // 原子写不该留下临时文件
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(vec![FILE_NAME.to_string()], leftovers);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_records_an_existing_install_and_never_overwrites_a_record() {
        let dir = tmp_dir("migrate");
        let cfg = dir.join("settings.json");
        let with_ours = json!({
            "theme": "dark",
            "hooks": { "Stop": [ { "hooks": [ foreign_entry(), managed_entry("stop") ] } ] }
        });
        fs::write(&cfg, with_ours.to_string()).unwrap();

        // ① 从没写过 + 配置里有自家条目 → 补写 qoder
        assert_eq!(
            migrate_from_legacy(&dir, std::slice::from_ref(&cfg)),
            Migrate::Wrote(Some(QODER.to_string()))
        );
        assert_eq!(agent_choice(&dir).as_deref(), Some(QODER));
        // ② 已有记录就不动：PR-2 会往同一个文件写 prevHooksEnabled
        record_choice(&dir, None).unwrap();
        assert_eq!(migrate_from_legacy(&dir, &[cfg]), Migrate::AlreadyRecorded);
        assert_eq!(agent_choice(&dir), None, "已有记录（哪怕是 null）不被覆盖");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_writes_null_when_nothing_is_installed() {
        let dir = tmp_dir("migrate-empty");
        let cfg = dir.join("settings.json");
        fs::write(
            &cfg,
            json!({ "hooks": { "Stop": [ { "hooks": [ foreign_entry() ] } ] } }).to_string(),
        )
        .unwrap();
        assert_eq!(migrate_from_legacy(&dir, &[cfg]), Migrate::Wrote(None));
        assert_eq!(agent_choice(&dir), None);
        assert!(state_path(&dir).is_file(), "「没装过」也是显式状态，要落盘");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_state_file_is_never_overwritten() {
        let dir = tmp_dir("corrupt");
        fs::write(state_path(&dir), "{ 这不是合法 json").unwrap();
        assert_eq!(migrate_from_legacy(&dir, &[]), Migrate::Corrupt);
        assert_eq!(agent_choice(&dir), None, "读坏按没选过处理");
        assert!(
            fs::read_to_string(state_path(&dir))
                .unwrap()
                .contains("这不是合法"),
            "补写那一步绝不能覆盖读坏的状态文件 —— 抹掉用户的选择比装不上更糟"
        );
        record_choice(&dir, Some(QODER)).unwrap();
        assert_eq!(
            agent_choice(&dir).as_deref(),
            Some(QODER),
            "显式写入仍然有效"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_strips_only_ours_and_keeps_everything_else() {
        let dir = tmp_dir("cleanup");
        let cfg = dir.join("settings.json");
        let before = json!({
            "theme": "dark",
            "mcpServers": { "fake": { "command": "npx" } },
            "hooks": {
                "Stop": [ { "hooks": [ foreign_entry(), managed_entry("stop") ] } ],
                "PreToolUse": [ { "hooks": [ managed_entry("pre") ] } ]
            }
        });
        fs::write(&cfg, before.to_string()).unwrap();

        let reports = uninstall(std::slice::from_ref(&cfg));
        assert_eq!(reports.iter().map(|r| r.managed).sum::<usize>(), 2);
        assert!(reports.iter().all(|r| r.error.is_none()));
        let after: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(after["theme"], "dark", "其他键原样");
        assert_eq!(after["mcpServers"]["fake"]["command"], "npx");
        // 别人的条目一字未动；只剩我们那条分组的事件键已被删空
        assert_eq!(after["hooks"]["Stop"][0]["hooks"], json!([foreign_entry()]));
        assert!(after["hooks"].get("PreToolUse").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_survives_a_malformed_config_without_touching_it() {
        let dir = tmp_dir("cleanup-bad");
        let cfg = dir.join("settings.json");
        fs::write(&cfg, "{ 半截 JSON").unwrap();
        // 卸载应用时撞到坏配置也必须走完：清理失败不能拦住卸载，所以只出报告不抛错
        let reports = uninstall(std::slice::from_ref(&cfg));
        assert_eq!(reports.len(), 1);
        assert!(reports[0].error.is_some(), "坏文件要在报告里留痕");
        assert_eq!(
            fs::read_to_string(&cfg).unwrap(),
            "{ 半截 JSON",
            "坏配置一字不改"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// `--pet-hook-cleanup` 绝不能被 hook 接收分支当成 phase：那样卸载时那一次调用会被
    /// 当成「一条 Agent 事件」吞掉，清理根本不发生。这条判据在 phases.rs 的白名单匹配上，
    /// 看起来是显然的，但它是 NSIS 钩子与 stdin 采集共用同一个 exe 的唯一分流点。
    #[test]
    fn the_cleanup_flag_is_not_a_hook_phase() {
        use crate::services::agent::phases::{HookArgs, HookCommand};
        let mut cleanup = ["desktop-pet.exe", "--pet-hook-cleanup"]
            .iter()
            .map(|s| (*s).to_string());
        // 判定不变（「它不是一条 hook 事件」），期望值比原来更具体：
        // 旧写法只说「拿不到 phase」（None 把「不是给我们的」和「被拒」混成一个值）
        assert_eq!(
            crate::services::agent::hook_phase_from_args(&mut cleanup),
            HookArgs::NotForUs
        );
        // 对照：真的 hook 分支照旧解析得到，别把这条测试写成两边都不认
        let mut real = ["desktop-pet.exe", "--pet-hook", "pre"]
            .iter()
            .map(|s| (*s).to_string());
        assert_eq!(
            crate::services::agent::hook_phase_from_args(&mut real),
            HookArgs::Event(HookCommand {
                phase: "pre",
                agent: "qoder"
            })
        );
    }

    /// 显式选择只有两个记录点，都在设置页那两条命令上，且都必须排在真正写完配置文件之后。
    /// 生命周期那三条（启停差异、启动清理、CLI 清理）只许读不许写 —— 把「停用」记成退出，
    /// 再启用就装不回来了。启动补写是唯一的例外，那是升级路径而不是本次的写入。
    #[test]
    fn only_the_settings_page_commands_record_the_choice() {
        let agent_cmd = include_str!("../../commands/agent.rs");

        let install = function_body(agent_cmd, "pub fn agent_hooks_install(");
        let written = install
            .find("install_files(&files, &exe_path()?)")
            .expect("找不到安装调用点");
        let noted = install
            .find("linkage::note_installed(&app, &reports)")
            .expect("安装成功后没记录用户的选择");
        assert!(written < noted, "记录必须晚于真的装完");

        let uninstall = function_body(agent_cmd, "pub fn agent_hooks_uninstall(");
        let removed = uninstall
            .find("uninstall_files(&files)")
            .expect("找不到卸载调用点");
        let cleared = uninstall
            .find("linkage::note_uninstalled(&app)")
            .expect("卸载没把 agent 记成 null");
        assert!(removed < cleared, "记录必须晚于摘完");

        let myself = include_str!("linkage.rs");
        for name in [
            "pub fn reconcile(",
            "pub fn resync(",
            "pub fn startup(",
            "pub fn run_cleanup_cli(",
            "fn apply(",
        ] {
            let body = function_body(myself, name);
            assert!(
                !body.contains("record_choice(") && !body.contains("note_choice("),
                "{name} 是生命周期路径，不许写 agent 字段"
            );
        }
    }

    /// 顺序判据：启动必须先补写用户的选择，再摘残余。反了就把证据先擦掉 ——
    /// 「停用摘掉、再启用装回来」对升级上来的用户从此永不成立。
    /// 这条以前是查源码文本的，现在跑真的是两步：把顺序放进 `startup_sequence`，
    /// 它不需要 AppHandle，所以能把行为本身跑红（文本断言挡不住「把 files 传成空表」）。
    #[test]
    fn startup_records_the_choice_before_it_strips_the_evidence() {
        let dir = tmp_dir("startup-seq");
        let cfg = dir.join("settings.json");
        fs::write(
            &cfg,
            json!({ "hooks": { "Stop": [ { "hooks": [ managed_entry("stop"), foreign_entry() ] } ] } })
                .to_string(),
        )
        .unwrap();
        let mut stripped = 0usize;
        // 插件已停用（清单里不包括它）→ 该摘残余
        let migrated = startup_sequence(
            &dir,
            std::slice::from_ref(&cfg),
            Some(&[]),
            false,
            &mut |files| {
                stripped += uninstall(files).iter().map(|r| r.managed).sum::<usize>();
            },
        );
        assert_eq!(migrated, Migrate::Wrote(Some(QODER.to_string())));
        assert_eq!(stripped, 1, "联动关着就要把残余摘掉");
        assert_eq!(
            agent_choice(&dir).as_deref(),
            Some(QODER),
            "补写必须早于摘除：先摘就再也看不出用户装过"
        );
        let after = fs::read_to_string(&cfg).unwrap();
        assert_eq!(after.matches("--pet-hook").count(), 0);
        assert!(after.contains("other-tool --notify"), "别人条目不受影响");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 评审 P0：启停清单还不存在时，启动**不许**把广播闸门关掉 —— 那样宠物对 Agent 一律不
    /// 响应，要等 `plugin_enabled_migrate` 跑完才恢复（老用户升级后第一次启动正是这个形状，
    /// 症状与「agent 桥坏了」无异）；`resync` 拿 `broadcast_allowed()` 当差异基线也会跟着错。
    /// 全仓库只有这一条测试读 `BROADCAST`，且「拨闸」只在这个函数里发生，不会被并行用例踩到。
    #[test]
    fn startup_does_not_mute_the_pet_before_the_enabled_list_is_known() {
        let empty: &[String] = &[];
        let one = vec!["com.pet.agent-bridge".to_string()];

        assert_eq!(startup_broadcast(None, false), None, "清单不存在 = 不拨");
        assert_eq!(
            startup_broadcast(None, true),
            None,
            "同上：这种情况下去判断「联动开没开」没有意义"
        );
        assert_eq!(startup_broadcast(Some(empty), false), Some(false));
        assert_eq!(startup_broadcast(Some(one.as_slice()), true), Some(true));

        set_broadcast(true);
        apply_startup_broadcast(None, false);
        assert!(
            broadcast_allowed(),
            "清单不存在时必须保持开 —— 关掉就是升级后宠物对 Agent 静默失灵"
        );

        apply_startup_broadcast(Some(empty), false);
        assert!(!broadcast_allowed(), "现状说得出、且确实关着，才该暂停广播");

        set_broadcast(false);
        apply_startup_broadcast(None, false);
        assert!(!broadcast_allowed(), "「不拨」就是不动：不许顺手把它打开");

        set_broadcast(true);
    }

    /// 启动「只清不装」的另一半：联动开着、或现状还说不出来时，配置文件一个字都不许动。
    /// `startup_sequence` 拿到的闭包只能摘不能装，所以重装这条路在签名上就不存在。
    #[test]
    fn startup_leaves_the_configs_alone_when_linkage_is_on_or_unknown() {
        let cases: Vec<(Option<Vec<String>>, bool, &str)> = vec![
            (
                Some(vec!["com.pet.agent-bridge".to_string()]),
                true,
                "联动开着：用户在 Agent 那边故意删掉的条目不该被开机加回去",
            ),
            (None, false, "启停清单还不存在：说不出现状就别动手"),
        ];
        for (ids, on, why) in cases {
            let dir = tmp_dir("startup-keep");
            let cfg = dir.join("settings.json");
            fs::write(
                &cfg,
                json!({ "hooks": { "Stop": [ { "hooks": [ managed_entry("stop") ] } ] } })
                    .to_string(),
            )
            .unwrap();
            let mut called = false;
            startup_sequence(
                &dir,
                std::slice::from_ref(&cfg),
                ids.as_deref(),
                on,
                &mut |_| called = true,
            );
            assert!(!called, "{why}：还是去摘了条目");
            assert_eq!(
                fs::read_to_string(&cfg)
                    .unwrap()
                    .matches("--pet-hook")
                    .count(),
                1,
                "{why}：配置文件被动过了"
            );
            let _ = fs::remove_dir_all(&dir);
        }
    }

    /// 挂点判据：联动只能挂在启停清单的唯一写入口上，且必须在清单落盘之后
    #[test]
    fn the_linkage_hooks_are_wired_at_the_only_write_entries() {
        let enabled = include_str!("../enabled.rs");
        for command in [
            "pub fn plugin_enabled_set(",
            "pub fn plugin_enabled_migrate(",
        ] {
            let body = function_body(enabled, command);
            assert!(body.contains("linkage::reconcile("), "{command} 没接联动");
            let written = body
                .find("write_ids(&app, &cleaned)?")
                .unwrap_or_else(|| panic!("{command} 找不到清单写入点"));
            let reacted = body.find("linkage::reconcile(").expect("reconcile 调用点");
            assert!(
                written < reacted,
                "{command}：清单必须先落盘 —— 装卸失败不能拦启停"
            );
        }

        let plugins = include_str!("../../commands/plugins.rs");
        assert!(
            plugins.contains("linkage::resync("),
            "插件目录 watcher 没接联动 —— 删插件目录就摘不掉 hook"
        );

        // 「暂停广播」这条口径住在 watcher.rs，行为要 CDP 才看得见，这里先把形状钉住：
        // 偏移量必须先推进、再拦广播 —— 反过来说就是「停用期间的事件永久丢失」，
        // 那比多播几条严重得多，而且 e2e 的红会落在离根因很远的地方。
        let watcher = include_str!("watcher.rs");
        let drain = function_body(watcher, "fn drain_file(");
        let advanced = drain
            .find(".insert(path.to_path_buf(), next)")
            .expect("找不到偏移量推进点");
        let guarded = drain
            .find("broadcast_allowed()")
            .expect("watcher 没有暂停判据");
        assert!(
            advanced < guarded,
            "偏移量(第{advanced}字)必须先推进，暂停(第{guarded}字)在后"
        );
        assert!(
            watcher.matches("broadcast_allowed()").count() >= 3,
            "drain、一轮结束、ticker 三处都得判暂停，少一处就会在停用期间往外拨状态"
        );

        let lib = include_str!("../../lib.rs");
        assert!(lib.contains("linkage::startup("), "lib.rs 没接启动清理");
        let cleanup_at = lib
            .find("--pet-hook-cleanup")
            .expect("lib.rs 缺 --pet-hook-cleanup 分流");
        let handler_at = lib.find("generate_handler!").unwrap_or(usize::MAX);
        assert!(
            cleanup_at < handler_at,
            "清理分支必须在建窗之前分流，否则会被单实例插件转给已运行的实例"
        );
    }

    /// 从 `marker` 起截到下一个顶层 `pub fn ` 或 `#[cfg(test)]` 之前，近似取出函数体。
    /// 两个截断点都要：enabled.rs 的 `plugin_enabled_migrate` 是最后一个公开函数，
    /// 只认 `pub fn` 会把整个测试模块也捞进来，那里的字面量会自己命中这些判据。
    fn function_body<'a>(src: &'a str, marker: &str) -> &'a str {
        let start = src
            .find(marker)
            .unwrap_or_else(|| panic!("源码里找不到 {marker}"));
        let rest = &src[start..];
        let mut end = rest.len();
        for needle in ["\npub fn ", "\n#[cfg(test)]"] {
            // 偏移是相对 rest[1..] 量的（跳过 marker 自己那一行的 "pub fn" 开头）
            if let Some(offset) = rest[1..].find(needle) {
                end = end.min(offset + 1);
            }
        }
        &rest[..end]
    }
}
