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
//!   * 写：只有用户的显式操作 —— 设置页装成功（`agent` = 那个适配器的 id）、设置页卸载或
//!     撤销授权连带的卸载（`agent = null`）。
//!   * 不写：启停差异、删除插件、启动清理、`--pet-hook-cleanup`。停用导致的卸载不是退出，
//!     重新启用时全靠这个字段把安装恢复回来。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::host_error::{HostError, INTERNAL, INVALID_ARG, INVALID_STATE, NOT_FOUND};
use crate::plugin_caps::AGENT_HOOKS;
use crate::services::agent::adapters::{self, claude_style, zcode, AgentAdapter};
use crate::services::agent::phases::{AGENT_FLAG, DEFAULT_AGENT};
use crate::services::agent::AgentState;
use crate::services::agent_hooks::{self, FileReport};
use crate::services::permission::PermissionState;

/// 宿主状态文件名（`<app_data>/agent-linkage.json`，原子写）
const FILE_NAME: &str = "agent-linkage.json";

/// 老用户迁移的落点，也是 `--agent` 的缺省值：PR-1 之前宿主只接过 Qoder，所以状态文件
/// 不存在而配置里有自家条目时，那位用户选的只能是它。
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

/// 状态文件里的整份对象。`None` = 文件不存在，或读不出对象（后者绝不写回，见 `update_state`）。
fn read_state(app_data: &Path) -> Option<Value> {
    let raw = fs::read_to_string(state_path(app_data)).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value.is_object().then_some(value)
}

/// 状态文件唯一的写入口：读出来 → 用闭包改 → 原子写回。
///
/// 为什么合并而不是整份重写：除了 `agent`，这里还住着 `hooksEnabled`（装 ZCode 时抄的
/// 总开关旧值）。谁写自己那一段、别的全留着，才不会「记录用户选择」顺手抹掉恢复所需的证据。
///
/// `overwrite_unreadable` 分两种态度，这条不对称是故意的：
///   * 记账（写或清 `hooksEnabled`）遇到读不出的文件就不写 —— 抹掉一个读不懂的文件没意义；
///   * 用户的显式选择必须写得进去，否则状态文件一旦坏掉，设置页永远再也记不下选择。
///     判据在 `corrupt_state_file_is_never_overwritten`：迁移那步不覆盖，显式那步覆盖。
fn update_state(
    app_data: &Path,
    overwrite_unreadable: bool,
    patch: &dyn Fn(&mut serde_json::Map<String, Value>),
) -> Result<(), String> {
    let mut object = match read_state(app_data) {
        Some(value) => value,
        None if state_path(app_data).exists() && !overwrite_unreadable => {
            return Err("状态文件读不出对象，未改动".into())
        }
        None => json!({}),
    };
    patch(object.as_object_mut().expect("上面判过是对象"));
    let text = serde_json::to_string_pretty(&object).map_err(|e| e.to_string())?;
    crate::fsutil::write_atomic(&state_path(app_data), text.as_bytes())
        .map_err(|e| e.message.clone())
}

/// 写「用户显式选了哪个 Agent」这一段（`agent` 与 `schema`）。其他键原样保留。
pub fn record_choice(app_data: &Path, agent: Option<&str>) -> Result<(), String> {
    update_state(app_data, true, &|map| {
        map.insert("schema".into(), json!(1));
        map.insert(
            "agent".into(),
            match agent {
                Some(a) => json!(a),
                None => Value::Null,
            },
        );
    })
}

/// 装之前各文件的总开关旧值（`{"<路径>": false}`；`null` = 原来根本没这个键）。
/// 读不出来或没记过就回空对象 —— 空对象意味着「一个开关都不许动」，是安全方向。
pub fn recorded_switches(app_data: &Path) -> Value {
    read_state(app_data)
        .and_then(|value| value.get("hooksEnabled").cloned())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// 把这次安装真正拨开过的开关抄进状态文件。一条都没拨（Qoder 恒如此）就不写，
/// 免得给只装 Qoder 的用户多出一个空键。
pub fn record_switches(app_data: &Path, reports: &[FileReport]) {
    let mut additions = serde_json::Map::new();
    for report in reports {
        if let Some(value) = &report.switch_before {
            additions.insert(report.path.clone(), value.clone());
        }
    }
    if additions.is_empty() {
        return;
    }
    if let Err(e) = update_state(app_data, false, &|map| {
        let table = map.entry("hooksEnabled").or_insert_with(|| json!({}));
        let Some(table) = table.as_object_mut() else {
            return;
        };
        for (path, value) in additions.iter() {
            table.insert(path.clone(), value.clone());
        }
    }) {
        log::warn!("写入总开关记录失败: {e}");
    }
}

/// 卸载把开关恢复回去之后清掉这份记录：它是**一次性**的，留着下次卸载会照着
/// 早已不相关的旧值再改一次用户的配置。
fn clear_switches(app_data: &Path) {
    if let Err(e) = update_state(app_data, false, &|map| {
        map.remove("hooksEnabled");
    }) {
        log::warn!("清理总开关记录失败: {e}");
    }
}

/// 设置页装成功 = 用户的显式选择，记下来供「停用→再启用」恢复。
/// 全部文件都失败时不记：否则下次启用插件会去装一个从没成功过的 hook。
///
/// `agent` 由调用方给（就是它刚装的那个适配器 id），这里不猜 —— 状态文件里写的必须是
/// 「刚才那次成功的安装属于谁」。
///
/// 命令体只加这一行调用 —— `check:shape` 把命令体限在 20 行且不许出现 IO 原语，
/// 状态文件读写必须住在服务层。
pub fn note_installed(app: &AppHandle, agent: &str, reports: &[FileReport]) {
    if !agent_hooks::any_installed(reports) {
        return;
    }
    note_choice(app, Some(agent));
    // 顺手把「装之前我们拨动过的总开关」抄进同一个状态文件：ZCode 的 hooks.enabled
    // 没有这条记录，卸载时就恢复不回去（方案 §3.4）
    if let Some(data) = app_data(app) {
        record_switches(&data, reports);
    }
}

/// 设置页主动卸载，或「撤销授权」连带的宿主卸载：都算用户明确退出，记成 null。
pub fn note_uninstalled(app: &AppHandle) {
    note_choice(app, None);
    // 恢复已经发生（或本来就没记过），这份一次性凭证就不该留着
    if let Some(data) = app_data(app) {
        clear_switches(&data);
    }
}

/// 命令层卸载前要拿的那份旧值记录（`app_data` 的解析失败按「没记过」处理）。
pub fn recorded_switches_of(app: &AppHandle) -> Value {
    match app_data(app) {
        Some(data) => recorded_switches(&data),
        None => json!({}),
    }
}

/// 卸旧之后、装新的之前的判定（纯函数）。抽出来是因为 `switch_agent` 那层要 AppHandle 与真文件，
/// 而「哪一步先、哪一步失败就停」正是这条命令最需要被跑红的部分 —— 与 `startup_sequence` 同一手法。
#[derive(Debug, PartialEq, Eq)]
pub enum SwitchPlan {
    /// 卸旧失败：停在原状态，不装新的
    StopAfterRemoveFailure,
    /// 没找到新 Agent 的配置目录：旧的已摘，新的不装（要如实报出去）
    NothingToInstall,
    Install,
}

/// 确认门：**动任何文件之前**判。返回 `true` 就一条命令也不该改配置文件 ——
/// 反过来（先摘旧的再问）会变成「用户按了取消，hook 已经没了」。
pub fn consent_gate(consent: Option<usize>, confirm: bool) -> bool {
    consent.is_some() && !confirm
}

/// 「要先问用户」那条拒绝的机器可读前缀。为什么塞在 message 里而不是加字段：
/// IPC 错误的形状被 ADR-0007 钉成 `{code, message}`，而 `invalid-state` 这个码同时也被
/// 「卸旧失败」用 —— 让设置页去猜中文字串，猜错的表现是把一次真失败显示成确认框。
/// 前缀是 ASCII 的固定串，界面显示前会剥掉，用户看不到它。
pub const NEED_CONFIRM: &str = "[need-confirm]";

/// 确认框那句话。抽成函数是为了让「前缀在、条数在」这条契约能被离线钉住
/// （`switch_agent` 那层要 AppHandle 与真文件，跑不了）。
/// 正文交给适配器（`AgentAdapter::consent_prompt`）：ZCode 的开关是我们去打开的，
/// WorkBuddy 的 `disableAllHooks` 我们**不动**，两句话不能共用一个模板，否则界面会在骗用户。
pub fn confirm_prompt(adapter: &dyn AgentAdapter, user_hooks: usize) -> HostError {
    HostError::new(
        INVALID_STATE,
        format!("{NEED_CONFIRM} {}", adapter.consent_prompt(user_hooks)),
    )
}

/// 卸完旧的了：该装、该停、还是没地方装。三个分支都可达，所以没有兜底分支。
pub fn plan_install(remove_failed: bool, has_targets: bool) -> SwitchPlan {
    if remove_failed {
        SwitchPlan::StopAfterRemoveFailure
    } else if !has_targets {
        SwitchPlan::NothingToInstall
    } else {
        SwitchPlan::Install
    }
}

/// 设置页四选一的落点：把联动切到另一个 Agent。口径（派单 §3）：
/// **先卸旧、成功后再装新**；卸旧失败就停在原状态。
///
/// 为什么顺序不能反：同一时间只挂一个 Agent 是本卡的不变量（ADR-0002 定为长期路线）。
/// 先装新的再摘旧的，中途任何一次失败都会留下两份条目并存 —— 桌宠会同时被两家驱动，
/// 而且下一次卸载只摘得掉其中一份。
///
/// 需要用户确认的那一步（ZCode 的总开关显式关着、且用户自己配过条目）必须在**动任何文件之前**
/// 问，所以它排在卸旧之前；`confirm = false` 时一条命令也不改。
pub fn switch_agent(
    app: &AppHandle,
    agent: &str,
    confirm: bool,
    home: &Path,
) -> Result<Value, HostError> {
    let Some(adapter) = adapters::by_id(agent) else {
        let wired: Vec<&str> = adapters::wired().iter().map(|a| a.id()).collect();
        return Err(HostError::new(
            INVALID_ARG,
            format!(
                "还不认识这个 Agent: {agent}（已接线的只有 {}）",
                wired.join(" / ")
            ),
        ));
    };
    let data = app_data(app)
        .ok_or_else(|| HostError::new(INVALID_STATE, "拿不到宿主数据目录，切换无从记录"))?;
    let targets = adapter.targets(home);
    let consent = agent_hooks::pending_consent(adapter, &targets);
    if consent_gate(consent, confirm) {
        return Err(confirm_prompt(adapter, consent.unwrap_or_default()));
    }
    let removed = agent_hooks::uninstall_everywhere(home, &recorded_switches(&data));
    let first_error = removed
        .iter()
        .filter_map(|r| r.error.as_ref())
        .next()
        .cloned()
        .unwrap_or_default();
    match plan_install(!first_error.is_empty(), !targets.is_empty()) {
        // 停在原状态：不装新的，但要把「哪些文件没摘干净」如实说清（已经摘掉的部分不假装没发生）
        SwitchPlan::StopAfterRemoveFailure => Err(HostError::new(
            INVALID_STATE,
            format!("卸下旧的 hook 失败，未安装新的: {first_error}"),
        )),
        SwitchPlan::NothingToInstall => Err(HostError::new(
            NOT_FOUND,
            format!(
                "没找到 {} 的配置目录；旧的 hook 已卸下（{} 条），新的未安装",
                adapter.display_name(),
                removed.iter().map(|r| r.managed).sum::<usize>()
            ),
        )),
        SwitchPlan::Install => {
            let exe = std::env::current_exe()
                .map_err(|e| HostError::new(INTERNAL, format!("取不到自身路径: {e}")))?;
            // 装之前先记下 ZCode 日志写到哪了 —— 装后自检只看这之后的行（方案 §3.5）。
            // 别的客户端没有这份日志，所以 selfCheck 直接给 null，不假装「查过且没问题」。
            let mark = (adapter.id() == zcode::ZCODE.id())
                .then(|| agent_hooks::mark_zcode_log(home))
                .flatten();
            let reports = agent_hooks::install_files(adapter, &targets, &exe);
            let self_check = (adapter.id() == zcode::ZCODE.id()).then(|| {
                agent_hooks::zcode_self_check(mark.as_ref(), home, &format!("{} zcode", AGENT_FLAG))
            });
            // 只有真装上才算用户的选择（note_installed 里判），全失败时状态文件保持「没选过」
            note_installed(app, adapter.id(), &reports);
            Ok(json!({
                "agent": adapter.id(),
                "displayName": adapter.display_name(),
                "removed": removed.iter().map(|r| r.managed).sum::<usize>(),
                "files": reports,
                "hint": adapter.post_install_hint(),
                // null = 这个客户端没有「装后读日志自检」这回事，不是「查过且干净」
                "selfCheck": self_check,
            }))
        }
    }
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
///
/// 只按 Qoder 的形状数条目，这是事实而不是偷懒：状态文件出现之前宿主只接过 Qoder，
/// 所以「有自家条目但没有选择记录」这一种情况只可能是 Qoder。
pub fn migrate_from_legacy(app_data: &Path, files: &[PathBuf]) -> Migrate {
    match load(app_data) {
        Loaded::Known(_) => return Migrate::AlreadyRecorded,
        Loaded::Corrupt => return Migrate::Corrupt,
        Loaded::Absent => {}
    }
    let installed = agent_hooks::status_reports(&claude_style::QODER, files)
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
///
/// 「关→开」时 Agent 那一维的判据是**已接线的适配器 id**（`adapters::is_wired`），
/// 不是「等于 qoder」，也不是「任意非空字符串」：
///   * 等于 qoder 会在接第二个适配器时又要改这里；
///   * 任意非空会把 `codex` 这种「命令行认得但还没接线」的槽位、以及脏值都当成选择，
///     后果是宿主去装一个自己不知道怎么卸的 hook。
pub fn decide(prev_on: Option<bool>, now_on: bool, consented: bool, agent: Option<&str>) -> Action {
    match prev_on {
        None => Action::None,
        Some(false) if now_on => {
            // 关 → 开：同意过、且用户显式选过一个已经接线的 Agent，才装
            let chosen = agent.is_some_and(adapters::is_wired);
            if consented && chosen {
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

/// 某个适配器的候选配置文件。一个都没有 = 没装那个客户端，不是失败。
fn targets(app: &AppHandle, adapter: &dyn AgentAdapter) -> Vec<PathBuf> {
    match app.path().home_dir() {
        Ok(home) => adapter.targets(&home),
        Err(e) => {
            log::warn!("拿不到用户主目录，跳过 {} 的 hook 文件: {e}", adapter.id());
            Vec::new()
        }
    }
}

/// 状态页与命令层用的「当前该按哪家看」：直接读状态文件，不走 `CURRENT_AGENT` 缓存
/// （缓存是给每行事件比对用的，状态查询要拿磁盘上的事实）。
pub fn recorded_agent_of(app: &AppHandle) -> Option<String> {
    app_data(app).and_then(|data| agent_choice(&data))
}

/// 当前联动的适配器；记录缺失或指向还没接线的槽位时退回 Qoder（与 `adapter_for` 同一条口径）。
pub fn current_adapter(app: &AppHandle) -> &'static dyn AgentAdapter {
    adapter_for(recorded_agent_of(app).as_deref())
}

/// 这批装卸走哪个适配器。状态文件里的选择缺失、或指向还没接线的槽位时退回 Qoder ——
/// 与 `--agent` 的缺省同一口径，而且那是 PR-1 之前唯一存在过的形状：
/// 配置里的陈旧条目只能按它自己的形状摘，退回 Qoder 不会摘坏别人的文件。
fn adapter_for(agent: Option<&str>) -> &'static dyn AgentAdapter {
    agent
        .and_then(adapters::by_id)
        .unwrap_or(&claude_style::QODER)
}

fn install(adapter: &dyn AgentAdapter, files: &[PathBuf]) -> Vec<FileReport> {
    if files.is_empty() {
        log::info!("没有 {} 的配置目录，跳过安装", adapter.display_name());
        return Vec::new();
    }
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(e) => {
            return vec![FileReport {
                path: String::new(),
                managed: 0,
                error: Some(format!("取不到自身路径: {e}")),
                switch_before: None,
            }]
        }
    };
    agent_hooks::install_files(adapter, files, &exe)
}

fn uninstall(adapter: &dyn AgentAdapter, files: &[PathBuf], switches: &Value) -> Vec<FileReport> {
    agent_hooks::uninstall_files(adapter, files, switches)
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
        // 「选了但没接线」与「没选过」在 decide 里都是 None，日志要分开：
        // 前者是用户看得见的一次点击没生效，必须能被追查
        if let Some(unknown) = agent.as_deref().filter(|a| !adapters::is_wired(a)) {
            log::info!("联动记录里的 Agent 是 {unknown}，但它还没接线，配置文件保持原样");
        }
        return;
    }
    let adapter = adapter_for(agent.as_deref());
    let name = action.report_name();
    let files = targets(app, adapter);
    let reports = match action {
        Action::Install => {
            let reports = install(adapter, &files);
            // 拨过的总开关要立刻记下来：这条路径是「停用→再启用」自动装的，没有设置页
            // 帮忙记，漏记就等于卸载时把用户的开关留在开着的状态
            record_switches(&data, &reports);
            reports
        }
        _ => {
            let reports = uninstall(adapter, &files, &recorded_switches(&data));
            if reports.iter().any(|r| r.managed > 0) {
                clear_switches(&data);
            }
            reports
        }
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
    // 迁移的证据只可能是 Qoder 形状的条目（见 migrate_from_legacy），所以这一步按 Qoder 取文件
    let files = targets(app, &claude_style::QODER);
    let ids = crate::services::enabled::list_ids(app);
    // 清单还不存在（尚未迁移）= 说不出现状：既不拨广播闸门，也不动手清理
    let on = ids.as_ref().is_some_and(|v| linkage_on(app, v));
    apply_startup_broadcast(ids.as_deref(), on);
    let adapter = adapter_for(agent_choice(&data).as_deref());
    let switches = recorded_switches(&data);
    let migrated = startup_sequence(&data, &files, ids.as_deref(), on, &mut |files| {
        let reports = uninstall(adapter, files, &switches);
        for r in &reports {
            if let Some(e) = &r.error {
                log::warn!("启动清理失败: {e} (path: {})", r.path);
            }
        }
        if reports.iter().any(|r| r.managed > 0) {
            clear_switches(&data);
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
/// 摘的范围是**每个已接线适配器**的候选文件（`uninstall_everywhere`），不是「当前联动的那个」：
/// 应用都没了，状态文件里写的是谁已经不重要，留着指向不存在 exe 的条目就是每次事件失败一次。
///
/// 输出是 ASCII 的 `key=value`：它要么被 NSIS 的 ExecWait 吞掉，要么在 e2e 里被解析，
/// 两种场合都不该依赖控制台代码页 —— 中文文案一旦变 mojibake，套件断言就红得没道理。
pub fn run_cleanup_cli() {
    let Some(home) = standalone_home() else {
        eprintln!("desktop-pet: hook cleanup result=skipped reason=no-home");
        return;
    };
    let switches = app_data_standalone()
        .map(|dir| recorded_switches(&dir))
        .unwrap_or_else(|| json!({}));
    let reports = agent_hooks::uninstall_everywhere(&home, &switches);
    if reports.is_empty() {
        println!("desktop-pet: hook cleanup result=nothing-to-do files=0 stripped=0");
        return;
    }
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

/// 状态文件在 hook/cleanup 分支里的落点：`%APPDATA%\<identifier>`。
/// 与 `inbox.rs` 里那份 `app_data_dir_standalone` 是同一条 Windows 约定 —— 那份是私有的，
/// 而 `inbox.rs` 的获批改动只限 `hook_ingest`，所以这里重复一次而不是去改它。
fn app_data_standalone() -> Option<PathBuf> {
    let base = std::env::var("APPDATA").ok()?;
    Some(PathBuf::from(base).join(super::state::identifier()))
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
        // 已知的 CLI 取值但还没接线的槽位不许装（接线之后这里自动放行，判据不用再改，
        // 见 every_wired_adapter_id_can_trigger_install…）
        for slot in ["zcode", "codex", "workbuddy"] {
            if adapters::is_wired(slot) {
                continue;
            }
            assert_eq!(
                decide(Some(false), true, true, Some(slot)),
                Action::None,
                "{slot} 还没接线：拿它去装 Qoder 形状的 hook，会写出一条我们不知道怎么卸的条目"
            );
        }
    }

    /// Q3 的正面判据：**能装的集合就是已接线的适配器**，逐个真跑一遍 ——
    /// 而不是把 qoder 写死在这条断言里。反面判据同一条：任何未接线的值都不许装。
    #[test]
    fn every_wired_adapter_id_can_trigger_install_and_nothing_else_can() {
        for adapter in adapters::wired() {
            assert_eq!(
                decide(Some(false), true, true, Some(adapter.id())),
                Action::Install,
                "{} 已接线，关→开就该装",
                adapter.id()
            );
        }
        // 「放宽成任意非空字符串」这个变异必须由下面这几条打死：空串、带空格的、
        // 大小写不对的显示名、以及根本不在 `--agent` 白名单里的值
        for not_wired in ["", " ", "qoder ", "Qoder", "nope", "qoder,zcode"] {
            assert_eq!(
                decide(Some(false), true, true, Some(not_wired)),
                Action::None,
                "「{not_wired}」不是已接线的适配器 id，不能装"
            );
        }
        assert_eq!(decide(Some(false), true, true, None), Action::None);
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

    /// 两段记录住同一个文件，谁也不许抹掉谁：`record_choice` 从前是整份重写，
    /// 接 ZCode 之后那一步会顺手抹掉恢复总开关所需的凭证 —— 症状是卸载后
    /// 用户的 `hooks.enabled` 永远留在开着。
    #[test]
    fn the_choice_record_and_the_switch_record_do_not_clobber_each_other() {
        let dir = tmp_dir("two-records");
        let report = |path: &str, switch: Option<Value>| FileReport {
            path: path.to_string(),
            managed: 7,
            error: None,
            switch_before: switch,
        };

        record_switches(&dir, &[report(r"C:\cfg\config.json", Some(json!(false)))]);
        assert_eq!(
            recorded_switches(&dir)[r"C:\cfg\config.json"],
            json!(false),
            "抄下来的旧值得按路径存住"
        );

        // 关键一步：写用户的选择，不能把上面那段抹掉
        record_choice(&dir, Some("zcode")).unwrap();
        assert_eq!(agent_choice(&dir).as_deref(), Some("zcode"));
        assert_eq!(
            recorded_switches(&dir)[r"C:\cfg\config.json"],
            json!(false),
            "记录选择之后开关凭证还在"
        );

        // 恢复完就清掉：它是**一次性**的，留着下次卸载会照着早已不相关的旧值再改一次配置
        clear_switches(&dir);
        assert_eq!(recorded_switches(&dir), json!({}));
        assert_eq!(
            agent_choice(&dir).as_deref(),
            Some("zcode"),
            "清开关记录不能连带清了用户的选择"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Qoder 没有总开关，一次成功的安装不该在状态文件里多出任何东西
    #[test]
    fn record_switches_writes_nothing_when_no_switch_was_flipped() {
        let dir = tmp_dir("no-switch");
        let report = FileReport {
            path: r"C:\cfg\settings.json".to_string(),
            managed: 12,
            error: None,
            switch_before: None,
        };
        record_switches(&dir, std::slice::from_ref(&report));
        assert!(
            !state_path(&dir).exists(),
            "没拨过开关就不该为记账新建一个状态文件"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 切换 Agent 的顺序判据（抽成纯函数就是为了让它能被跑红）：
    /// 确认问必须在**动任何文件之前**，卸旧失败必须压住「装新的」。
    #[test]
    fn switching_asks_consent_before_touching_any_file() {
        assert!(
            consent_gate(Some(3), false),
            "总开关关着且用户自己配过 3 条 → 先问"
        );
        assert!(!consent_gate(Some(3), true), "第二次点击（带确认）才放行");
        assert!(
            !consent_gate(None, false),
            "没有确认问题就不该拦（Qoder 恒如此）"
        );
    }

    /// 确认框那句话的契约：**ASCII 前缀（给机器判）+ 条数（给人看）**两条都得在。
    /// 设置页剥掉前缀再显示；少了前缀它只能去猜中文字串（猜错就把一次真失败显示成确认框），
    /// 少了条数它说不清「打开会连带启用几条」—— 那正是这句确认存在的理由。
    #[test]
    fn the_confirm_prompt_carries_the_machine_token_and_the_count() {
        let e = confirm_prompt(&zcode::ZCODE, 3);
        assert_eq!(e.code, INVALID_STATE);
        assert!(e.message.starts_with(NEED_CONFIRM), "{}", e.message);
        assert!(
            e.message.contains("3 条"),
            "条数是确认的依据：{}",
            e.message
        );
    }

    /// 四家都接线之后，确认框这句话**只能由适配器给**：WorkBuddy 的 `disableAllHooks` 我们不动，
    /// 照 ZCode 那句「打开以后……」讲就是在骗用户。这条判据钉的是「话说得跟做的事一致」。
    #[test]
    fn each_adapter_wording_its_own_consent_prompt() {
        use crate::services::agent::adapters::{codex, workbuddy};
        // 有总开关且由我们去打开的那家（ZCode）保留原句
        assert!(
            zcode::ZCODE
                .consent_prompt(2)
                .contains("打开以后你之前配的 2 条"),
            "{}",
            zcode::ZCODE.consent_prompt(2)
        );
        // WorkBuddy 反过来：说清我们不改那个键
        let wb = workbuddy::WORKBUDDY.consent_prompt(1);
        assert!(wb.contains("disableAllHooks"), "要点名是哪个开关：{wb}");
        assert!(
            !wb.contains("打开以后你之前配的"),
            "不能谎称由我们去打开：{wb}"
        );
        // Codex 没有总开关：走适配器默认，不该由 linkage 再拼一份文案
        assert_eq!(
            codex::CODEX.consent_prompt(0),
            "Codex 需要你先确认才会改动配置文件。确认请再点一次。"
        );
    }

    #[test]
    fn switching_never_installs_on_top_of_a_failed_removal() {
        assert_eq!(
            plan_install(true, true),
            SwitchPlan::StopAfterRemoveFailure,
            "卸旧失败时哪怕目标目录就在也不装 —— 那样会两份条目并存，「同一时间只挂一个 Agent」当场就破了"
        );
        assert_eq!(
            plan_install(true, false),
            SwitchPlan::StopAfterRemoveFailure,
            "「失败」要报在「没地方装」之前，那是真原因"
        );
        assert_eq!(plan_install(false, false), SwitchPlan::NothingToInstall);
        assert_eq!(plan_install(false, true), SwitchPlan::Install);
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

        let reports = uninstall(&claude_style::QODER, std::slice::from_ref(&cfg), &json!({}));
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
        let reports = uninstall(&claude_style::QODER, std::slice::from_ref(&cfg), &json!({}));
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
            .find("install_files(adapter, &files, &exe_path()?)")
            .expect("找不到安装调用点");
        let noted = install
            .find("linkage::note_installed(&app, adapter.id(), &reports)")
            .expect("安装成功后没记录用户的选择");
        assert!(written < noted, "记录必须晚于真的装完");

        let uninstall = function_body(agent_cmd, "pub fn agent_hooks_uninstall(");
        let removed = uninstall
            .find("uninstall_everywhere(")
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
                stripped += uninstall(&claude_style::QODER, files, &json!({}))
                    .iter()
                    .map(|r| r.managed)
                    .sum::<usize>();
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
