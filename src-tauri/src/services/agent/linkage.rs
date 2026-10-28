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
use crate::services::agent::adapters::{self, claude_style, AgentAdapter};
use crate::services::agent::dsh_bridge;
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

/// 把这次安装真正拨开过的开关抄进状态文件。
///
/// 两个方向都要写（G2-08）：拨开了就记下原值；**这次安装没拨、但状态文件里还留着旧记录的，
/// 要按路径删掉**。只加不删的形状是：用户第一次装 ZCode（开关关着，记 `false`）→ 卸载恢复了
/// `false` 但记录没清 → 用户自己把开关打开 → 再装一次（这次不用拨）→ 状态文件里仍留着
/// `false`（过期）→ 下次卸载把用户自己打开的开关关回去。
/// 一条都没拨也没旧记录可清（Qoder 恒如此）就不写，免得给只装 Qoder 的用户多出一个空键。
pub fn record_switches(app_data: &Path, reports: &[FileReport]) {
    let mut additions = serde_json::Map::new();
    let mut cleared: Vec<&str> = Vec::new();
    for report in reports {
        if report.error.is_some() {
            continue;
        }
        match &report.switch_before {
            Some(value) => {
                additions.insert(report.path.clone(), value.clone());
            }
            // 这次装没碰开关：任何旧记录都不再描述这个文件的现状
            None => cleared.push(report.path.as_str()),
        }
    }
    if additions.is_empty() && cleared.is_empty() {
        return;
    }
    // 只清理时先看一眼现有记录：没有可清的路径就什么都不写。
    // 否则 update_state 会为一次空清理新建出 `{}` 或空状态文件 —— 用户只装了 Qoder
    // （永远不拨开关）却多出一个 hooksEnabled 记账键，正是这条判据要拦的形状。
    if additions.is_empty() {
        let recorded = recorded_switches(app_data);
        let table = recorded.as_object().cloned().unwrap_or_default();
        if !cleared.iter().any(|path| table.contains_key(*path)) {
            return;
        }
    }
    if let Err(e) = update_state(app_data, false, &|map| {
        // 只清理时：没有 `hooksEnabled` 表就没有可清的东西，别凭空造一个再删掉
        if additions.is_empty() {
            let Some(table) = map.get_mut("hooksEnabled").and_then(Value::as_object_mut) else {
                return;
            };
            for path in cleared.iter() {
                table.remove(*path);
            }
            if table.is_empty() {
                map.remove("hooksEnabled");
            }
            return;
        }
        let table = map.entry("hooksEnabled").or_insert_with(|| json!({}));
        let Some(table) = table.as_object_mut() else {
            return;
        };
        for (path, value) in additions.iter() {
            table.insert(path.clone(), value.clone());
        }
        for path in cleared.iter() {
            table.remove(*path);
        }
    }) {
        log::warn!("写入总开关记录失败: {e}");
    }
}

/// 卸载（或清理）把开关恢复回去之后，按路径删掉这份记录：它是**一次性**的，留着下次卸载
/// 会照着早已不相关的旧值再改一次用户的配置。
///
/// 只删「这次真的摘干净了」（`managed > 0` 且没报错）的路径：摘失败的文件还得留着旧值，
/// 下次卸载/清理才有东西可恢复。删空之后整个键一起去掉。
fn forget_restored_switches(app_data: &Path, reports: &[FileReport]) {
    let restored: Vec<&str> = reports
        .iter()
        .filter(|r| r.error.is_none() && r.switch_before.is_some())
        .map(|r| r.path.as_str())
        .collect();
    if restored.is_empty() {
        return;
    }
    if let Err(e) = update_state(app_data, false, &|map| {
        let Some(table) = map.get_mut("hooksEnabled").and_then(Value::as_object_mut) else {
            return;
        };
        for path in restored.iter() {
            table.remove(*path);
        }
        if table.is_empty() {
            map.remove("hooksEnabled");
        }
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

/// 「没有文件可装的 Agent」（DSH）接上时记下选择。
///
/// 与 `note_installed` 的区别只在判据：那边看的是 hook 报告里真装上了几条，这边没有报告
/// 可看 —— 桥装没装已由调用方先核过，所以这里直接落用户的显式选择。没有这一步，
/// 桥接上以后来源过滤（`linkage::current_agent()`）仍按上一个 Agent 算，桌宠不会动。
pub fn note_attached(app: &AppHandle, agent: &str) {
    note_choice(app, Some(agent));
}

/// G6-10 + G6-15：桥到底装没装（**只读**，一个文件都不写）。
///
/// `attach_bridge` 与 `switch_agent` 曾各写一份 `detect` + `not_detected` —— 措辞分家过一次，
/// 判据也会跟着分家。更要紧的是切换那一侧原来**先摘旧 hook、后检测桥**：没装桥时用户机器上
/// 别家的 hook 已经被摘没了，报错说的却是「没检测到桥」。所以这份检测被抽出来，
/// 由调用方**排在摘旧之前**；单测正是按「检测在前、摘旧在后」钉这条顺序。
pub fn bridge_presence(
    adapter: &dyn adapters::AgentAdapter,
    home: &Path,
    bundle_dir: PathBuf,
) -> Result<dsh_bridge::Bridge, HostError> {
    let bridge = dsh_bridge::detect(home, &bundle_dir);
    if bridge.detected {
        Ok(bridge)
    } else {
        Err(HostError::new(
            NOT_FOUND,
            dsh_bridge::not_detected(adapter.display_name(), Path::new(&bridge.bundle_dir)),
        ))
    }
}

/// G6-11：离开桥形态（DSH）时的一句实话 —— 桥住在对方进程里，宿主摘不到它。
///
/// `agent_hooks_uninstall` 只摘得掉四家的 hook 文本；桥是 DSH profile 里的一个 bundle，
/// 必须由用户在 DSH 里用 plugin_manager 卸。不写这句，用户会以为卸载把 DSH 也摘干净了，
/// 桥却还挂在对方进程里继续写收件箱。返回 `None` = 没检测到桥，没什么可提醒的。
pub fn bridge_residue_hint(app: &AppHandle, home: &Path) -> Option<String> {
    let bridge = dsh_bridge::detect(home, &dsh_bridge::bundle_dir(app).ok()?);
    bridge_residue_message(&bridge)
}

/// 提示文案的纯函数部分：命令体要过 AppHandle，单测只钉「检测到 → 有话、点明 profile 数」。
fn bridge_residue_message(bridge: &dsh_bridge::Bridge) -> Option<String> {
    bridge.detected.then(|| {
        format!(
            "桥插件仍挂在 DSH 的 {} 个 profile 里：宿主只摘掉四家 Agent 的 hook，桥要到 DSH 里用 plugin_manager 卸载（宿主不代卸）。",
            bridge.profiles
        )
    })
}

/// bridge 形态的「接入」：没有文件可写，只校验桥在不在 + 记下选择。
///
/// 抽到本模块而不是留在命令体里，有两个理由：命令体要过 `check:shape` 的 20 行上限；
/// 而「先核桥、再落选择」跟 `switch_agent` 的 bridge 分支是同一口径，写两遍必然漂。
pub fn attach_bridge(
    app: &AppHandle,
    adapter: &dyn adapters::AgentAdapter,
    home: &Path,
) -> Result<Value, HostError> {
    let bridge = bridge_presence(adapter, home, dsh_bridge::bundle_dir(app)?)?;
    note_attached(app, adapter.id());
    Ok(json!({
        "files": [],
        "hint": adapter.post_install_hint(),
        "bridge": bridge,
    }))
}

/// 设置页主动卸载（带逐文件报告）：选择记成 null，但只忘掉**真的恢复成功**的开关记录。
/// 有的文件摘失败时，它的旧值还得留着 —— 否则下次卸载会照着错的现状再改一次用户配置。
pub fn note_uninstalled_with(app: &AppHandle, reports: &[FileReport]) {
    note_choice(app, None);
    if let Some(data) = app_data(app) {
        forget_restored_switches(&data, reports);
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

// 「要先问用户」那条拒绝的机器可读前缀（`agent_hooks::NEED_CONFIRM`）。为什么塞在 message 里
// 而不是加字段：IPC 错误的形状被 ADR-0007 钉成 `{code, message}`，而 `invalid-state` 这个码
// 同时也被「卸旧失败」用 —— 让设置页去猜中文字串，猜错的表现是把一次真失败显示成确认框。
// 前缀是 ASCII 的固定串，界面显示前会剥掉，用户看不到它。
//
// 定义搬到了 `agent_hooks`：确认门下沉到 `install_files`（G2-09），装的那一层也要造这个前缀。

/// 确认框那句话。抽成函数是为了让「前缀在、条数在」这条契约能被离线钉住
/// （`switch_agent` 那层要 AppHandle 与真文件，跑不了）。
/// 正文交给适配器（`AgentAdapter::consent_prompt`）：ZCode 的开关是我们去打开的，
/// WorkBuddy 的 `disableAllHooks` 我们**不动**，两句话不能共用一个模板，否则界面会在骗用户。
pub fn confirm_prompt(adapter: &dyn AgentAdapter, user_hooks: usize) -> HostError {
    HostError::new(INVALID_STATE, agent_hooks::need_confirm(adapter, user_hooks))
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
    // G6-10：桥的检测是只读的，必须排在摘旧之前 —— 没装桥就到此为止，机器上别家的 hook
    // 一条都不该动。此前这里是先 strip 再 detect，等报「没检测到桥」时旧 hook 已经被摘掉了。
    let bridge = if adapter.installs_files() {
        None
    } else {
        Some(bridge_presence(adapter, home, dsh_bridge::bundle_dir(app)?)?)
    };
    // 回滚要用（G2-10）：切换前联动的那个适配器与它的候选文件。必须在摘旧之前取，
    // 之后状态文件里记的可能已经变了。
    let previous = adapter_for(agent_choice(&data).as_deref());
    let previous_files = previous.targets(home);
    let switches = recorded_switches(&data);
    // 摘全部家庭（G2-07），旧的那份开关记录已一次性用掉，顺手按路径删（G2-08）
    let removed = strip_everywhere(&data, home, &switches);
    let first_error = removed
        .iter()
        .filter_map(|r| r.error.as_ref())
        .next()
        .cloned()
        .unwrap_or_default();
    // G6-11：从 DSH 断开时桥仍留在对方 profile 里 —— 结果里要说清，别让用户以为全卸干净了。
    let bridge_hint = if !previous.installs_files() && adapter.id() != previous.id() {
        bridge_residue_hint(app, home)
    } else {
        None
    };
    // 没有文件可装的 Agent（DSH）：桥住在对方进程里，宠物这边只做两件事 ——
    // 校验桥确实装上了（`bridge` 已在摘旧之前核过），再记下用户的选择。这里**不能**走
    // install_files：「装 0 个文件成功」既骗用户也骗 note_installed（它在 any_installed
    // 为假时直接 return，选择记不下来，桌宠会一直盯着上一个 Agent）。
    if let Some(bundle) = bridge {
        if !first_error.is_empty() {
            return Err(HostError::new(
                INVALID_STATE,
                format!("卸下旧的 hook 失败，未接上新的: {first_error}"),
            ));
        }
        note_attached(app, adapter.id());
        return Ok(json!({
            "agent": adapter.id(),
            "displayName": adapter.display_name(),
            "removed": removed.iter().map(|r| r.managed).sum::<usize>(),
            "files": [],
            "hint": adapter.post_install_hint(),
            "bridge": bundle,
            "bridgeHint": bridge_hint,
            // null = 这家没有「装后读日志自检」这回事，不是「查过且干净」
            "selfCheck": null,
        }));
    }
    match plan_install(!first_error.is_empty(), !targets.is_empty()) {
        // 卸旧只成功了一部分：把旧的装回去（装回是幂等的：已摘的补上、还在的原样），
        // 不让用户停在「旧 hook 缺几条、新 hook 没装」的半装态（G2-10）
        SwitchPlan::StopAfterRemoveFailure => {
            let back = rollback_to(app, &data, previous, &previous_files);
            Err(HostError::new(
                INVALID_STATE,
                format!("卸下旧的 hook 失败（{first_error}），未安装新的；{back}"),
            ))
        }
        SwitchPlan::NothingToInstall => {
            // 没地方装也是切换失败：旧的已经摘了，同样要回滚，否则用户点完「切换」谁都不联动
            let back = rollback_to(app, &data, previous, &previous_files);
            Err(HostError::new(
                NOT_FOUND,
                format!("没找到 {} 的配置目录；{back}", adapter.display_name()),
            ))
        }
        SwitchPlan::Install => {
            let exe = std::env::current_exe()
                .map_err(|e| HostError::new(INTERNAL, format!("取不到自身路径: {e}")))?;
            // 装之前先记下日志写到哪了 —— 装后自检只看这之后的行（方案 §3.5）。
            // 「这家有没有可查的日志」由适配器自己答（`log_watch`），不在这里按 id 分派：
            // 接线第三家时那种 `if id == zcode` 会静默沿用 ZCode 的日志路径。
            let mark = agent_hooks::mark_log(adapter, home);
            // 确认门在 install_files 里也有一道（G2-09）。这里把用户刚才的确认原样传下去：
            // 确认过就不该被再问一次，没确认又不需要问的（Qoder）照常装。
            let reports = agent_hooks::install_files(adapter, &targets, &exe, Some(&data), confirm);
            if !agent_hooks::any_installed(&reports) {
                // 新的一个文件都没装上 = 切换失败。旧 hook 已被摘掉，必须装回旧 Agent，
                // 并把「现在是谁在联动」写进错误里 —— 只报失败不报后果，用户没法判断现状（G2-10）
                let why = reports
                    .iter()
                    .filter_map(|r| r.error.as_ref())
                    .next()
                    .cloned()
                    .unwrap_or_else(|| "没有任何文件装上".into());
                let back = rollback_to(app, &data, previous, &previous_files);
                return Err(HostError::new(
                    INVALID_STATE,
                    format!("切到 {} 失败：{why}；{back}", adapter.display_name()),
                ));
            }
            // 自检重新读盘：路径 + 条数 + 命令串 + 日志增量，不看上面那份报告（G2-11）
            let self_check = agent_hooks::self_check(
                adapter,
                &targets,
                &exe,
                mark.as_ref(),
                home,
                &format!("{} {}", AGENT_FLAG, adapter.id()),
            );
            // 只有真装上才算用户的选择（note_installed 里判），全失败时状态文件保持「没选过」
            note_installed(app, adapter.id(), &reports);
            Ok(json!({
                "agent": adapter.id(),
                "displayName": adapter.display_name(),
                "removed": removed.iter().map(|r| r.managed).sum::<usize>(),
                "files": reports,
                "hint": adapter.post_install_hint(),
                // G6-11：从 DSH 切走时，桥还在对方 profile 里 —— null 表示本来就没装桥
                "bridgeHint": bridge_hint,
                // 永远是一个对象：status 为 ok/pending/unverified/problem，没人能把「没查」说成绿
                "selfCheck": self_check,
            }))
        }
    }
}

/// 切换失败的回滚：把刚摘掉的旧 Agent 装回去，让「当前联动」仍然指向它。
///
/// 返回一句给人看的话（成功/失败都写清），调用方拼进错误里 —— 用户按完「切换」必须知道
/// 现在到底是谁在联动，而不是只看到一个泛泛的失败（G2-10）。回滚本身也失败时把选择清成
/// 「没选过」：状态页不能继续显示一个已经不在联动的 Agent，那比「没有 Agent」更难查。
fn rollback_to(
    app: &AppHandle,
    data: &Path,
    previous: &dyn AgentAdapter,
    previous_files: &[PathBuf],
) -> String {
    if previous_files.is_empty() {
        return format!(
            "旧 Agent（{}）没有候选文件，回滚不了；当前没有 Agent 在联动",
            previous.display_name()
        );
    }
    match rollback_install(previous, previous_files, data) {
        Ok(back) => {
            // 记账与 `switch_agent` 成功路径同口径：选择指回旧的、拨过的开关抄下来
            note_installed(app, previous.id(), &back);
            let count: usize = back.iter().map(|r| r.managed).sum();
            format!("已回滚到 {}（{count} 条）", previous.display_name())
        }
        Err(why) => {
            note_choice(app, None);
            format!(
                "回滚到 {} 也失败了（{why}），当前没有 Agent 在联动",
                previous.display_name()
            )
        }
    }
}

/// 回滚里「把旧的装回去」那一步。单独成函数是为了能在单测里真的注入失败跑一遍：
/// `switch_agent` 那层要 AppHandle，而「摘干净了没装回来」正是最该被跑红的形状（G2-10）。
fn rollback_install(
    previous: &dyn AgentAdapter,
    previous_files: &[PathBuf],
    data: &Path,
) -> Result<Vec<FileReport>, String> {
    let back = install(previous, previous_files, Some(data), true);
    if agent_hooks::any_installed(&back) {
        return Ok(back);
    }
    Err(back
        .iter()
        .filter_map(|r| r.error.as_ref())
        .next()
        .cloned()
        .unwrap_or_else(|| "原因未知".into()))
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

/// 联动安装的调用来源（G2-09 / t38-A）。区分它是因为「拨开用户的总开关」是需要同意的动作：
/// **用户重新勾选启用插件就是对这个动作的同意**，而启动补写、启停清单迁移、插件目录扫描
/// 都不是用户动作 —— 它们没有确认框可弹，也就没有资格替用户点头。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallMode {
    /// 用户在设置页主动勾选启用插件（`plugin_enabled_set`）：需要确认的客户端也照装。
    UserConfirmed,
    /// 启动补写 / 清单迁移 / 插件目录扫描：走严格确认门，需要确认的客户端保持原样。
    Strict,
}

impl InstallMode {
    /// 往下透传给 `install_files` 的确认门（G2-09）。`true` 只该来自用户动作。
    fn confirm(self) -> bool {
        matches!(self, Self::UserConfirmed)
    }
}

/// 装。`confirm` 往下透传给 `install_files` 的确认门（G2-09）：自动路径传 `false`，
/// 遇见要确认的客户端只会拿到 `[need-confirm]` 报告而不会动文件。
fn install(
    adapter: &dyn AgentAdapter,
    files: &[PathBuf],
    ledger_dir: Option<&Path>,
    confirm: bool,
) -> Vec<FileReport> {
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
    agent_hooks::install_files(adapter, files, &exe, ledger_dir, confirm)
}

fn uninstall(adapter: &dyn AgentAdapter, files: &[PathBuf], switches: &Value) -> Vec<FileReport> {
    agent_hooks::uninstall_files(adapter, files, switches)
}

/// 摘**全部家庭**的自家条目（G2-07），并只忘掉真的恢复成功的开关记录（G2-08）。
///
/// 停用/删除插件、启动清理、切换 Agent 三条路径共用这一条：分别写三份「扫哪几家 + 忘哪些记录」
/// 必然漂，而漂错的表现分别是「另外三家的 --pet-hook 永远留在磁盘上」与「过期旧值下次关掉
/// 用户自己打开的开关」。抽成函数也让「停用摘四家」能在没有 AppHandle 的单测里真的跑一遍。
fn strip_everywhere(app_data: &Path, home: &Path, switches: &Value) -> Vec<FileReport> {
    let reports = agent_hooks::uninstall_everywhere(home, switches);
    forget_restored_switches(app_data, &reports);
    reports
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
fn apply(app: &AppHandle, prev_on: Option<bool>, now_on: bool, ids: &[String], mode: InstallMode) {
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
    let switches = recorded_switches(&data);
    let reports = match action {
        Action::Install => {
            // 确认门住在 `install_files` 里（G2-09），这里只透传调用来源：用户在设置页
            // 主动启用（`InstallMode::UserConfirmed`）算对「恢复总开关」的同意；启动补写、
            // 清单迁移、目录扫描都不是用户动作，需要确认的客户端只会拿到 `[need-confirm]`
            // 报告，配置文件一个字都不动，也不记选择
            let reports = install(adapter, &files, Some(data.as_path()), mode.confirm());
            // 拨过的总开关要立刻记下来：这条路径是自动装的，没有设置页帮忙记，
            // 漏记就等于卸载时把用户的开关留在开着的状态
            record_switches(&data, &reports);
            reports
        }
        _ => {
            // G2-07：停用/删除插件要摘**全部家庭**，不能只摘「状态文件里当前那一家」——
            // 用户切换过 Agent、或状态文件缺失时，其余几家的 `--pet-hook` 会永远留在磁盘上
            let reports = match app.path().home_dir() {
                Ok(home) => strip_everywhere(&data, &home, &switches),
                Err(e) => {
                    log::warn!("拿不到用户主目录，本次只摘 {} 的文件: {e}", adapter.id());
                    uninstall(adapter, &files, &switches)
                }
            };
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
///
/// `mode` 只说「这次是不是用户动作」：设置页主动勾选启用传 [`InstallMode::UserConfirmed`]，
/// 迁移/启动/目录扫描传 [`InstallMode::Strict`]。确认门的语义仍在 `install_files` 里。
pub fn reconcile(
    app: &AppHandle,
    previous: Option<&[String]>,
    next: &[String],
    mode: InstallMode,
) {
    let now_on = linkage_on(app, next);
    apply(
        app,
        previous.map(|ids| linkage_on(app, ids)),
        now_on,
        next,
        mode,
    );
}

/// 插件目录被改动（含整目录删除）后的重算。运行期没有「卸载插件」命令，
/// 删除只体现在磁盘上，所以差异基线取宿主上次认定的状态。
pub fn resync(app: &AppHandle) {
    let Some(ids) = crate::services::enabled::list_ids(app) else {
        // 清单还不存在 = 现状说不出，保持原样（与 startup 的 Unknown 同一口径）
        return;
    };
    let now_on = linkage_on(app, &ids);
    // 插件目录扫描不是用户动作：严格确认门（t38-A）
    apply(app, Some(broadcast_allowed()), now_on, &ids, InstallMode::Strict);
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
    // G2-05：隔离变量在发布构建里照样生效，所以命中时必须显式说出来 —— 启动日志是
    // 用户与支持人员唯一能看到「这次读的不是默认路径」的地方，静默换根是最难查的失败。
    let overrides = adapters::active_overrides();
    if !overrides.is_empty() {
        log::warn!(
            "hook 路径被环境变量改写: override={}（发布构建里同样生效）",
            overrides.join(",")
        );
    }
    let ids = crate::services::enabled::list_ids(app);
    // 清单还不存在（尚未迁移）= 说不出现状：既不拨广播闸门，也不动手清理
    let on = ids.as_ref().is_some_and(|v| linkage_on(app, v));
    apply_startup_broadcast(ids.as_deref(), on);
    let switches = recorded_switches(&data);
    // 证据与残留都在用户目录里：连主目录都拿不到时，补写与清理都无从谈起，保持原样
    match app.path().home_dir() {
        Ok(home) => {
            let outcome = startup_sequence(&data, &home, ids.as_deref(), on, &switches);
            log::info!("启动补写联动状态: {:?}", outcome.migrated);
            if let Some(reports) = outcome.cleaned {
                for r in &reports {
                    if let Some(e) = &r.error {
                        log::warn!("启动清理失败: {e} (path: {})", r.path);
                    }
                }
                if reports.iter().any(|r| r.managed > 0) {
                    // 只忘掉真的恢复了的路径：启动清理失败的那份下次还得靠旧值恢复（G2-08）
                    forget_restored_switches(&data, &reports);
                }
                report(app, "startup-cleanup", &reports);
            }
        }
        Err(e) => log::warn!("拿不到用户主目录，启动不做联动补写与清理: {e}"),
    }
    // 补写可能刚刚新建了状态文件，缓存要在第一次读事件之前对齐
    sync_current_agent(&data);
}

/// 启动阶段的两步，以及各自动了哪些文件。
pub struct StartupOutcome {
    /// 补写结果：升级上来的老用户第一次启动时，把「装过 hook」从配置文件挪进状态文件
    pub migrated: Migrate,
    /// `None` = 现状还说不出来、或联动开着：配置文件一个字都没动。
    /// `Some(_)` = 真的清了一遍（候选文件都没有时是空表 —— 清过，只是没东西可清）。
    pub cleaned: Option<Vec<FileReport>>,
}

/// 启动阶段的两步及其顺序。
///
/// 顺序：先补写、后清理。反了就先擦掉证据，「停用摘掉、再启用装回来」对升级上来的用户
/// 从此永不成立。放在这里而不是 `startup` 里，是因为它不碰 AppHandle，单测能把顺序与
/// 「清了哪几家」都真的跑红。
///
/// 两个清单**不是同一份**，别合成一个：
/// * 补写只认 Qoder 形状的条目（见 `migrate_from_legacy`），所以按 Qoder 的候选文件数证据；
/// * 清残留按**每个已接线适配器各自的候选文件**（`uninstall_everywhere`）。残留可能留在任何
///   一家（用户切换过 agent；状态文件缺失时 `adapter_for` 还退回 Qoder），只清 Qoder 会让
///   其余三家的 `--pet-hook` 永远留在磁盘上 —— 这里从前是「Qoder 的文件 + 当前那家的
///   适配器」，两头都不对，而单测只喂一个 Qoder 形状的文件正好把它盖住。
///
/// 这个函数**没有装的能力**（只调 uninstall），「启动只清不装」是行为层面的事实。
/// `ids = None` 表示启停清单还不存在：说不出现状就不动手。
pub fn startup_sequence(
    app_data_dir: &Path,
    home: &Path,
    ids: Option<&[String]>,
    linkage_on: bool,
    switches: &Value,
) -> StartupOutcome {
    let migrated = migrate_from_legacy(app_data_dir, &claude_style::QODER.targets(home));
    let cleaned =
        (ids.is_some() && !linkage_on).then(|| agent_hooks::uninstall_everywhere(home, switches));
    StartupOutcome { migrated, cleaned }
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
    let app_data = app_data_standalone();
    let switches = app_data
        .as_ref()
        .map(|dir| recorded_switches(dir))
        .unwrap_or_else(|| json!({}));
    let reports = agent_hooks::uninstall_everywhere(&home, &switches);
    // 备份要在这里收：账本证明是我们写的才删，没账本（含 0.2.1 之前生成的旧备份）一律跳过。
    // 这一步只在**清理路径**（卸载前那一次）执行；停用/切换 agent 不走这里，备份要留着给
    // 下次启用当「用户原文件」用（`backup_once` 是首写为准，删掉就再也恢复不到原样了）。
    let backups =
        crate::services::agent::backups::remove_backups_everywhere(&home, app_data.as_deref());
    let stripped: usize = reports.iter().map(|r| r.managed).sum();
    let failed = reports.iter().filter(|r| r.error.is_some()).count();
    // G2-05：清理也要把「路径被环境变量改写」说出来。清理分支拿不到日志系统，
    // 唯一能被 NSIS / e2e 看见的出口就是这行 stdout。
    let overrides = adapters::active_overrides();
    let override_note = if overrides.is_empty() {
        "none".to_string()
    } else {
        overrides.join(",")
    };
    // 只剩备份也要继续往下走：上一版在 reports 为空时提前 return，会把「hook 已摘干净、
    // 只剩我们抄的备份」这种最常见的情形整段跳过。
    if reports.is_empty() && backups.removed == 0 && backups.failed == 0 && backups.skipped == 0 {
        println!(
            "desktop-pet: hook cleanup result=nothing-to-do files=0 stripped=0 backups=0 backups_failed=0 backups_skipped=0 override={override_note}"
        );
        return;
    }
    println!(
        "desktop-pet: hook cleanup result=done files={} stripped={stripped} failed={failed} backups={} backups_failed={} backups_skipped={} override={override_note}",
        reports.len(),
        backups.removed,
        backups.failed,
        backups.skipped
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

    /// 进程级 env 是共享的：手写 set_var/remove_var 一旦断言 panic，remove 就被跳过，
    /// 假 home 会漏给同进程的其它用例（cargo test 默认多线程）。RAII 收口后不管怎么退场
    /// 都清干净（G7-10）。只给测试用，生产代码不读它。
    struct EnvScope {
        names: Vec<&'static str>,
    }

    impl EnvScope {
        /// 设 `set`、清 `clear`；两类名字都进 Drop 清单。
        fn new(set: &[(&'static str, &Path)], clear: &[&'static str]) -> Self {
            let mut names: Vec<&'static str> = Vec::new();
            for (name, value) in set {
                std::env::set_var(name, value);
                names.push(name);
            }
            for name in clear {
                std::env::remove_var(name);
                names.push(name);
            }
            Self { names }
        }
    }

    impl Drop for EnvScope {
        fn drop(&mut self) {
            for name in &self.names {
                std::env::remove_var(name);
            }
        }
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

        // 恢复完就清掉：它是**一次性**的，留着下次卸载会照着早已不相关的旧值再改一次配置。
        // 走带报告的那条（`forget_restored_switches`），摘失败的文件才不会被一起忘掉。
        forget_restored_switches(&dir, &[report(r"C:\cfg\config.json", Some(json!(false)))]);
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
        let e = confirm_prompt(&adapters::zcode::ZCODE, 3);
        assert_eq!(e.code, INVALID_STATE);
        assert!(
            e.message
                .starts_with(crate::services::agent_hooks::NEED_CONFIRM),
            "{}",
            e.message
        );
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
            adapters::zcode::ZCODE
                .consent_prompt(2)
                .contains("打开以后你之前配的 2 条"),
            "{}",
            adapters::zcode::ZCODE.consent_prompt(2)
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
        assert!(
            install.contains("install_and_note("),
            "安装命令必须走带确认门的安装路径（G2-09），不能在命令体里自己装"
        );
        // 真正的写入点在 install_and_note 里（命令体只留一行，见 check:shape 的 S2）。
        // 不钉整串：rustfmt 会把多参数调用折行。钉「调用点在」+「账本目录确实传进去了」。
        let install = function_body(agent_cmd, "fn install_and_note(");
        let written = install.find("install_files(").expect("找不到安装调用点");
        assert!(
            install.contains("agent_hooks::ledger_dir(app).as_deref()"),
            "安装路径必须把账本目录传进去（A23：备份要可证明归属）"
        );
        let refused = install
            .find("NEED_CONFIRM")
            .expect("确认门拒绝必须翻成可读错误（G2-09）");
        let noted = install
            .find("linkage::note_installed(")
            .expect("安装成功后没记录用户的选择");
        assert!(written < noted, "记录必须晚于真的装完");
        assert!(refused < noted, "被确认门拒掉的那次不能记账");

        let uninstall = function_body(agent_cmd, "pub fn agent_hooks_uninstall(");
        let removed = uninstall
            .find("uninstall_everywhere(")
            .expect("找不到卸载调用点");
        let cleared = uninstall
            .find("linkage::note_uninstalled_with(&app, &reports)")
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
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("startup-seq");
        let home = dir.join("home");
        let cfg = home.join(".qoder").join("settings.json");
        fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        fs::write(
            &cfg,
            json!({ "hooks": { "Stop": [ { "hooks": [ managed_entry("stop"), foreign_entry() ] } ] } })
                .to_string(),
        )
        .unwrap();
        // 证据与残留都按 home 推：不换根就是去读开发机真 home，用例会在别人的文件上跑
        let _scope = EnvScope::new(&[("PET_AGENT_HOME", &home)], &["PET_AGENT_CONFIG_FILES"]);
        // 插件已停用（清单里不包括它）→ 该摘残余
        let outcome = startup_sequence(&dir, &home, Some(&[]), false, &json!({}));
        assert_eq!(outcome.migrated, Migrate::Wrote(Some(QODER.to_string())));
        let cleaned = outcome.cleaned.expect("联动关着就该清一遍");
        assert_eq!(
            cleaned.iter().map(|r| r.managed).sum::<usize>(),
            1,
            "联动关着就要把残余摘掉"
        );
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
    /// `startup_sequence` 只调 uninstall，所以重装这条路在行为上就不存在。
    #[test]
    fn startup_leaves_the_configs_alone_when_linkage_is_on_or_unknown() {
        let _env = adapters::lock_test_env();
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
            let home = dir.join("home");
            let cfg = home.join(".qoder").join("settings.json");
            fs::create_dir_all(cfg.parent().unwrap()).unwrap();
            fs::write(
                &cfg,
                json!({ "hooks": { "Stop": [ { "hooks": [ managed_entry("stop") ] } ] } })
                    .to_string(),
            )
            .unwrap();
            let _scope =
                EnvScope::new(&[("PET_AGENT_HOME", &home)], &["PET_AGENT_CONFIG_FILES"]);
            let outcome = startup_sequence(&dir, &home, ids.as_deref(), on, &json!({}));
            assert!(outcome.cleaned.is_none(), "{why}：还是去摘了条目");
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

    /// 启动清理的判据是「每个已接线适配器各自的候选文件」，不是「只清 Qoder」，
    /// 也不是「Qoder 的文件配当前选择那家的适配器」—— 后两种都会让切换过 agent
    /// 的用户在 .zcode/.codex/.workbuddy 里留着指向桌面宠物的 `--pet-hook`，
    /// 而单测只喂一个 Qoder 形状的文件正好把错配盖住。
    ///
    /// 只跑「有文件可装」的那几家：DSH 的桥是 DSH 侧插件，宠物这边根本没有残留可摘，
    /// 把它算进「每家各摘一条」会让本用例的基数失真（它由 `dsh_bridge` 的单测负责）。
    #[test]
    fn startup_cleanup_strips_residue_in_every_wired_adapter() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("startup-all-families");
        let home = dir.join("home");
        // 有文件可装的那几家都「装过」：夹具按各自 targets() 的目录约定摆好
        fs::create_dir_all(home.join(".qoder")).unwrap();
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(home.join(".workbuddy")).unwrap();
        fs::create_dir_all(home.join(".zcode").join("cli")).unwrap();
        fs::write(home.join(".qoder").join("settings.json"), "{}").unwrap();
        fs::write(home.join(".codex").join("hooks.json"), "{}").unwrap();
        fs::write(home.join(".workbuddy").join("settings.json"), "{}").unwrap();
        fs::write(
            home.join(".zcode").join("cli").join("config.json"),
            json!({ "hooks": { "events": {} } }).to_string(),
        )
        .unwrap();
        // 候选文件全从假 home 推：逐项覆盖变量会把它指到别处，一个都不留
        let _scope = EnvScope::new(
            &[("PET_AGENT_HOME", &home)],
            &[
                "PET_AGENT_CONFIG_FILES",
                "PET_AGENT_CODEX_FILES",
                "PET_AGENT_WORKBUDDY_FILES",
            ],
        );

        // 「不写文件」现在恰好只有一家（DSH）。哪天多出一家，本用例要一起改 ——
        // 静默把它过滤掉就没人记得清理逻辑要不要跟着变。
        let file_writers: Vec<&dyn AgentAdapter> = adapters::wired()
            .iter()
            .copied()
            .filter(|a| a.installs_files())
            .collect();
        assert_eq!(
            file_writers.len() + 1,
            adapters::wired().len(),
            "目前恰好一家不写文件（DSH）：新增第二家请同步本用例"
        );

        let exe = Path::new(r"C:\app\desktop-pet.exe");
        for adapter in &file_writers {
            let files = adapter.targets(&home);
            assert!(!files.is_empty(), "{} 的夹具没建对", adapter.id());
            let reports = agent_hooks::install_files(*adapter, &files, exe, Some(dir.as_path()), true);
            assert!(
                agent_hooks::any_installed(&reports),
                "{} 没装上，用例前提不成立",
                adapter.id()
            );
        }

        // 插件已停用、联动关着 → 启动清理该把各家的残留全摘掉
        let outcome = startup_sequence(&dir, &home, Some(&[]), false, &json!({}));
        assert_eq!(
            outcome.migrated,
            Migrate::Wrote(Some(QODER.to_string())),
            "Qoder 有自家条目 → 照样补写用户的选择"
        );
        let cleaned = outcome.cleaned.expect("联动关着就该清一遍");
        assert!(
            cleaned.iter().map(|r| r.managed).sum::<usize>() >= file_writers.len(),
            "有文件的那几家各摘掉至少一条：{:?}",
            cleaned
                .iter()
                .map(|r| (r.path.clone(), r.managed))
                .collect::<Vec<_>>()
        );
        for adapter in &file_writers {
            for file in adapter.targets(&home) {
                let text = fs::read_to_string(&file).unwrap();
                assert!(
                    !text.contains(agent_hooks::HOOK_MARKER),
                    "{} 的残留没摘掉: {}",
                    adapter.id(),
                    file.display()
                );
            }
        }

        let _ = fs::remove_dir_all(&dir);
    }


    /// G7-10：env 作用域退场（包括断言 panic 展开）必须把变量全清掉 —— 手写
    /// set_var/remove_var 时漏一句就可能把假 home 泄漏给同进程的其它用例。
    #[test]
    fn env_scope_clears_every_name_it_touched_on_drop() {
        let _env = adapters::lock_test_env();
        let fake = Path::new(r"C:\pet-test\home");
        {
            let _scope = EnvScope::new(
                &[("PET_AGENT_HOME", fake)],
                &["PET_AGENT_CONFIG_FILES", "PET_AGENT_CODEX_FILES"],
            );
            assert_eq!(std::env::var("PET_AGENT_HOME").unwrap(), r"C:\pet-test\home");
            assert!(std::env::var("PET_AGENT_CONFIG_FILES").is_err());
        }
        assert!(
            std::env::var("PET_AGENT_HOME").is_err(),
            "退场后不许留在环境里：假 home 漏出去就是别人的用例读错文件"
        );
        assert!(std::env::var("PET_AGENT_CODEX_FILES").is_err());
    }

    /// G2-07：停用/删除插件要摘**全部家庭**。旧实现只摘状态文件里当前那一家，用户切换过
    /// Agent 之后（或被删过状态文件），其余几家的 `--pet-hook` 会永远留在磁盘上。
    #[test]
    fn disabling_clears_every_wired_family_not_only_the_recorded_one() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("strip-all-families");
        let home = dir.join("home");
        for (sub, leaf) in [
            (".qoder", "settings.json"),
            (".codex", "hooks.json"),
            (".workbuddy", "settings.json"),
            (".zcode/cli", "config.json"),
        ] {
            let file = home.join(sub).join(leaf);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, "{}").unwrap();
        }
        let _scope = EnvScope::new(
            &[("PET_AGENT_HOME", &home)],
            &[
                "PET_AGENT_CONFIG_FILES",
                "PET_AGENT_CODEX_FILES",
                "PET_AGENT_WORKBUDDY_FILES",
            ],
        );
        let exe = Path::new(r"C:\app\desktop-pet.exe");
        let writers: Vec<&dyn AgentAdapter> = adapters::wired()
            .iter()
            .copied()
            .filter(|a| a.installs_files() && a.id() != "dsh")
            .collect();
        for adapter in &writers {
            let files = adapter.targets(&home);
            assert!(!files.is_empty(), "{} 的夹具没建对", adapter.id());
            let reports =
                agent_hooks::install_files(*adapter, &files, exe, Some(dir.as_path()), true);
            assert!(
                agent_hooks::any_installed(&reports),
                "{} 没装上，用例前提不成立",
                adapter.id()
            );
        }
        // 状态文件里只写着「用户当前选的是 Qoder」—— 旧逻辑就只清这一个文件
        record_choice(&dir, Some(QODER)).unwrap();
        let switches = recorded_switches(&dir);
        let reports = strip_everywhere(&dir, &home, &switches);
        assert!(
            reports.iter().any(|r| r.managed > 0),
            "四家都装过，停用至少要摘掉一条: {:?}",
            reports
                .iter()
                .map(|r| (r.path.clone(), r.managed))
                .collect::<Vec<_>>()
        );
        for adapter in &writers {
            for file in adapter.targets(&home) {
                let text = fs::read_to_string(&file).unwrap();
                assert!(
                    !text.contains(agent_hooks::HOOK_MARKER),
                    "{} 的条目没摘净: {}",
                    adapter.id(),
                    file.display()
                );
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// G2-08（装侧）：这次安装没拨开关 → 该文件在状态文件里的旧值必须删掉。
    /// 只加不删的形状会真的改错用户的配置：装（记 false）→ 卸载恢复 → 用户自己打开开关 →
    /// 再装（这次不拨）→ 记录还是 false → 下次卸载把用户打开的开关关回去。
    #[test]
    fn a_new_install_drops_a_switch_record_it_did_not_touch() {
        let dir = tmp_dir("switch-stale");
        let file = r"C:\z\config.json";
        record_switches(
            &dir,
            &[FileReport {
                path: file.to_string(),
                managed: 1,
                error: None,
                switch_before: Some(json!(false)),
            }],
        );
        assert!(recorded_switches(&dir).get(file).is_some());
        // 再装一次：开关已经是开的（用户自己打开过），适配器读不到 switch_before
        record_switches(
            &dir,
            &[FileReport {
                path: file.to_string(),
                managed: 7,
                error: None,
                switch_before: None,
            }],
        );
        assert!(
            recorded_switches(&dir).get(file).is_none(),
            "这次没拨开关，旧记录不再描述现状，必须删"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// G2-08（卸侧）：只忘掉**真的恢复成功**的路径；摘失败的那份旧值还得留着下次恢复。
    #[test]
    fn only_restored_switch_records_are_forgotten() {
        let dir = tmp_dir("switch-forget");
        let restored = r"C:\ok.json";
        let failed = r"C:\failed.json";
        record_switches(
            &dir,
            &[
                FileReport {
                    path: restored.to_string(),
                    managed: 1,
                    error: None,
                    switch_before: Some(json!(false)),
                },
                FileReport {
                    path: failed.to_string(),
                    managed: 1,
                    error: None,
                    switch_before: Some(json!(false)),
                },
            ],
        );
        forget_restored_switches(
            &dir,
            &[
                FileReport {
                    path: restored.to_string(),
                    managed: 1,
                    error: None,
                    switch_before: Some(json!(false)),
                },
                FileReport {
                    path: failed.to_string(),
                    managed: 0,
                    error: Some("permission denied".into()),
                    switch_before: Some(json!(false)),
                },
            ],
        );
        let left = recorded_switches(&dir);
        assert!(left.get(restored).is_none(), "恢复成功的记录是一次性的");
        assert!(
            left.get(failed).is_some(),
            "摘失败的旧值留着，下次才有东西可恢复"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// G2-10：切换失败必须回滚。这里注入**真实的安装失败**（目标落在一个普通文件下面，
    /// 写不进去）并真的跑回滚那一步：旧 Agent 的条目必须重新出现，而不是停在
    /// 「旧的摘了、新的没装」的半装态；回滚本身失败时也要给出可读原因。
    #[test]
    fn a_failed_switch_puts_the_old_agent_back() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("rollback");
        let home = dir.join("home");
        let cfg = home.join(".zcode").join("cli").join("config.json");
        fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        fs::write(
            &cfg,
            json!({ "hooks": { "enabled": true, "events": {} } }).to_string(),
        )
        .unwrap();
        let _scope = EnvScope::new(&[("PET_AGENT_HOME", &home)], &[]);
        let zcode = adapters::by_id("zcode").expect("zcode 已接线");
        let old_files = zcode.targets(&home);
        assert!(!old_files.is_empty(), "夹具没建对");
        let exe = Path::new(r"C:\app\desktop-pet.exe");
        let first = agent_hooks::install_files(zcode, &old_files, exe, Some(dir.as_path()), true);
        assert!(agent_hooks::any_installed(&first), "用例前提：旧的先装上");
        // 切走：旧 hook 先被摘掉（switch_agent 在装新的之前就是这么做的）
        agent_hooks::uninstall_files(zcode, &old_files, &json!({}));
        assert_eq!(
            fs::read_to_string(&cfg)
                .unwrap()
                .matches("--pet-hook")
                .count(),
            0,
            "切换的第一步确实把旧的摘了"
        );
        // 注入失败：新 Agent 的目标写不进去（父路径是普通文件）
        let blocker = dir.join("not-a-dir");
        fs::write(&blocker, "x").unwrap();
        let broken = vec![blocker.join("config.json")];
        let codex = adapters::by_id("codex").expect("codex 已接线");
        let failed = agent_hooks::install_files(codex, &broken, exe, Some(dir.as_path()), true);
        assert!(
            !agent_hooks::any_installed(&failed),
            "失败注入必须真的失败，否则这条用例什么都没证明"
        );
        // 回滚：真的把旧 Agent 装回去
        let back = rollback_install(zcode, &old_files, &dir).expect("回滚必须成功");
        assert!(agent_hooks::any_installed(&back), "回滚后旧的必须在盘上");
        let text = fs::read_to_string(&cfg).unwrap();
        assert_eq!(
            text.matches("--pet-hook").count(),
            zcode.events().len(),
            "回滚要把旧 Agent 的每一条都装回来"
        );
        assert!(
            text.contains("\"enabled\": true"),
            "回滚不许把总开关拨乱"
        );
        // 回滚也失败时：可读原因，不是 panic 也不是空串
        let why = match rollback_install(codex, &broken, &dir) {
            Ok(back) => panic!("写不进去必须报错，却报成功（{} 条）", back.len()),
            Err(why) => why,
        };
        assert!(!why.trim().is_empty(), "回滚失败必须给出可读原因");
        let _ = fs::remove_dir_all(&dir);
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

    /// A23 ②：清理路径收备份，**停用/切换 agent 不得收** —— 后者若删了，`backup_once` 是
    /// 「首写为准」，下次启用会把已经被我们改过的配置当成用户原文件抄成新备份，永久丢原配置。
    #[test]
    fn only_the_cleanup_path_removes_backups() {
        let src = include_str!("linkage.rs");
        let cleanup = function_body(src, "pub fn run_cleanup_cli(");
        assert!(
            cleanup.contains("remove_backups_everywhere(&home, app_data.as_deref())"),
            "清理路径必须收掉我们自己的备份"
        );
        let switch = function_body(src, "pub fn switch_agent(");
        assert!(
            !switch.contains("remove_backups_everywhere"),
            "停用/切换 agent 不得删备份"
        );
        let reconcile = function_body(src, "pub fn reconcile(");
        assert!(
            !reconcile.contains("remove_backups_everywhere"),
            "停用插件触发的 reconcile 也不得删备份"
        );
    }

    /// G6-10：切到 DSH 时「检测桥」必须排在「摘旧 hook」之前 —— 没装桥就到此为止，
    /// 机器上别家的 hook 一条都不许动（此前先 strip 再 detect，报「没检测到桥」时旧 hook 已经没了）。
    /// 这里用源码顺序钉住：AppHandle 构造不出来，行为分支跑不进单测，但顺序就是修复本身。
    #[test]
    fn bridge_is_detected_before_any_hook_is_stripped() {
        let src = include_str!("linkage.rs");
        let switch = function_body(src, "pub fn switch_agent(");
        let detect_at = switch
            .find("bridge_presence(")
            .expect("switch_agent 里必须检测桥（bridge_presence）");
        let strip_at = switch
            .find("strip_everywhere(")
            .expect("switch_agent 里必须摘旧 hook（strip_everywhere）");
        assert!(
            detect_at < strip_at,
            "桥的检测必须先于摘旧 hook：否则没装桥时别家 hook 已被摘掉（G6-10）"
        );
        assert!(
            !switch[detect_at..strip_at].contains("return Ok("),
            "检测失败必须直接返回错误"
        );
    }

    /// G6-11：卸载响应里的「桥还在」提示 —— 检测到才给话，且要能点出 profile 数；
    /// 没检测到就闭嘴（不能每次都吓唬「桥还挂着」）。
    #[test]
    fn bridge_residue_message_speaks_only_when_the_bridge_is_present() {
        let present = dsh_bridge::Bridge {
            package: crate::services::agent::adapters::dsh::BRIDGE_PACKAGE,
            detected: true,
            profiles: 2,
            bundle_dir: "C:\\app\\integrations\\dsh-bridge".to_string(),
            dsh_home: "C:\\Users\\me\\.dsh".to_string(),
        };
        let message = bridge_residue_message(&present).expect("检测到桥时必须给提示");
        assert!(message.contains("2 个 profile"), "{message}");
        assert!(message.contains("plugin_manager"), "{message}");
        let absent = dsh_bridge::Bridge {
            detected: false,
            profiles: 0,
            ..present
        };
        assert_eq!(bridge_residue_message(&absent), None);
    }

    /// R4-F1：没检测到桥必须**拒绝** —— 只钉顺序不够。M3 变异（把拒绝分支删成无条件
    /// `Ok(bridge)`）曾能全绿存活，说明当时没有行为断言兜底。这里用临时 `PET_DSH_HOME`
    /// 造出「profiles 里没有桥」的真实盘上状态：返回 Err、码 NOT_FOUND、文案点明桥与
    /// install_bundle；再补一条「列了桥就放行」的正例对照，证明拒绝不是把所有情况都拒了。
    #[test]
    fn bridge_presence_rejects_when_no_bridge_detected() {
        let _env = adapters::lock_test_env();
        let root = tmp_dir("bridge-presence");
        let dsh_home = root.join("dsh-home");
        // profile 目录存在但没有 package.json：跟真机上「装过 DSH、没装桥」同形
        fs::create_dir_all(dsh_home.join("profiles").join("e2e")).expect("建 profile 目录");
        // 清掉 PET_AGENT_HOME：回退链若命中真实家目录，这台机器上装过桥就会把反例带偏
        let _scope = EnvScope::new(&[(dsh_bridge::HOME_ENV, &dsh_home)], &["PET_AGENT_HOME"]);
        let bundle_dir = root.join("integrations").join("dsh-bridge");

        let err = bridge_presence(&adapters::dsh::DSH, &root, bundle_dir.clone())
            .expect_err("profiles 里没有桥时 bridge_presence 必须拒绝");
        assert_eq!(
            err.code,
            crate::host_error::NOT_FOUND,
            "没检测到桥是 not-found 码，实际: {err}"
        );
        let text = err.message.to_lowercase();
        assert!(text.contains("bridge"), "文案要点明桥（bridge）：{err}");
        assert!(
            text.contains("install_bundle"),
            "文案要给出 install_bundle 的装法：{err}"
        );

        // 正例对照：同一个临时 dsh home，写一个列了桥的 profile，就必须放行
        fs::write(
            dsh_home.join("profiles").join("e2e").join("package.json"),
            json!({
                "dsh": {
                    "profile": {
                        "bundles": [crate::services::agent::adapters::dsh::BRIDGE_PACKAGE]
                    }
                }
            })
            .to_string(),
        )
        .expect("写 profile 的 package.json");
        let bridge = bridge_presence(&adapters::dsh::DSH, &root, bundle_dir)
            .expect("profile 的 bundles 里列了桥就必须放行");
        assert!(bridge.detected);
        assert_eq!(bridge.profiles, 1);
    }

    /// G2-09 / t38-A：确认门只允许「用户在设置页主动启用」这一条路径代用户同意。
    /// 启动补写、启停清单迁移、插件目录扫描都不是用户动作，需要确认的客户端必须保持原样。
    #[test]
    fn only_the_user_action_clears_the_install_confirm_gate() {
        assert!(
            InstallMode::UserConfirmed.confirm(),
            "主动启用就是对恢复总开关的同意"
        );
        assert!(
            !InstallMode::Strict.confirm(),
            "自动路径不许代用户同意拨开总开关"
        );

        let enabled = include_str!("../enabled.rs");
        let set = function_body(enabled, "pub fn plugin_enabled_set(");
        assert!(
            set.contains("InstallMode::UserConfirmed"),
            "设置页主动启用必须按已确认装（否则停用时还原的总开关装不回来）"
        );
        let migrate = function_body(enabled, "pub fn plugin_enabled_migrate(");
        assert!(
            migrate.contains("InstallMode::Strict"),
            "清单迁移不是用户动作，必须走严格确认门"
        );

        let myself = include_str!("linkage.rs");
        let resync = function_body(myself, "pub fn resync(");
        assert!(
            resync.contains("InstallMode::Strict"),
            "插件目录扫描不是用户动作，必须走严格确认门"
        );
        // 启动路径压根没有安装能力（只清不装）：这条钉住「启动不越过确认门」的事实。
        // 用「没有安装调用点」判，避免把 `uninstall_*` 里的 install 子串当成安装。
        let startup = function_body(myself, "pub fn startup_sequence(");
        assert!(
            !startup.contains("install_files") && !startup.contains("InstallMode"),
            "启动只会清残留，不许装 hook"
        );
    }

    /// G2-09 / t38-A：同一份用户配置，`Strict` 拿不到同意就一个字节都不写；
    /// `UserConfirmed`（用户重新勾选启用插件）要真的装回去，并把停用时还原成 false 的
    /// 总开关一并拨开。ZCode 的夹具正是 `switch_needs_consent` 的形状：总开关关着，
    /// 但用户自己配过 hook。
    #[test]
    fn a_user_confirmed_install_restores_the_switch_a_strict_one_does_not() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("user-confirmed");
        let home = dir.join("home");
        let cfg = home.join(".zcode").join("cli").join("config.json");
        fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        let raw = json!({
            "hooks": {
                "enabled": false,
                "events": {
                    "Stop": [{ "hooks": [
                        { "type": "command", "command": "user-hook.sh", "timeoutMs": 2000 }
                    ] }]
                }
            }
        })
        .to_string();
        fs::write(&cfg, &raw).unwrap();
        let _scope = EnvScope::new(&[("PET_AGENT_HOME", &home)], &["PET_AGENT_CONFIG_FILES"]);
        let zcode = adapters::by_id("zcode").expect("zcode 已接线");
        let files = zcode.targets(&home);
        assert!(!files.is_empty(), "夹具没建对");
        let ledger = dir.join("ledger");
        fs::create_dir_all(&ledger).unwrap();

        // 自动路径（迁移/启动/目录扫描）：确认门先问，配置一个字都不许动
        let strict = install(
            zcode,
            &files,
            Some(ledger.as_path()),
            InstallMode::Strict.confirm(),
        );
        assert!(
            !agent_hooks::any_installed(&strict),
            "严格路径不许动用户配置"
        );
        assert!(
            strict.iter().all(|r| r
                .error
                .as_deref()
                .is_some_and(|e| e.starts_with(agent_hooks::NEED_CONFIRM))),
            "每个没写的文件都要带 [need-confirm] 标记"
        );
        assert_eq!(
            fs::read_to_string(&cfg).unwrap(),
            raw,
            "没确认就一个字节都不写"
        );

        // 用户主动再启用：同意随这次点击给出，装回去并恢复总开关
        let confirmed = install(
            zcode,
            &files,
            Some(ledger.as_path()),
            InstallMode::UserConfirmed.confirm(),
        );
        assert!(
            agent_hooks::any_installed(&confirmed),
            "主动再启用必须真的装上"
        );
        let text = fs::read_to_string(&cfg).unwrap();
        assert_eq!(
            text.matches("--pet-hook").count(),
            zcode.events().len(),
            "再启用要把 7 条事件装回来"
        );
        assert!(
            text.contains("\"enabled\": true"),
            "停用时还原的总开关要一并恢复：{text}"
        );
        assert!(
            text.contains("user-hook.sh"),
            "用户自己那条一个字都不许动：{text}"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
