//! Agent hook 的宿主命令：状态 / 安装 / 卸载。
//!
//! 两个调用面（见 ADR-0001）：
//!   * 不带 `pluginId` —— 宿主自己的调用（设置窗壳里「撤销授权」的连带卸载要用），
//!     照旧只过 `gate::settings`。别把宿主路径也绑上 pluginId，否则撤销流程会依赖插件还活着。
//!   * 带 `pluginId` —— 插件设置页经 JS 桥的调用，除窗口门禁外再逐项校验 `agent:hooks` 已授权。
//!
//! 门禁挡的是**别的窗口**（宠物窗 / overlay 窗里绕过 JS 桥直接 invoke 会被拒）；
//! 挡不住的是同 realm 里插件的主动越权 —— settings 区的 widget 本来就跑在设置窗里，
//! `label == "settings"` 对它天然成立，边界靠 manifest 声明 + 同意框，不是靠窗口身份。
//! 那条缺口要等 Web Worker 宿主才收口，别在这条注释里给自己假安全感。
//!
//! 这两个命令还是「用户显式选择」的唯一写入口（`agent-linkage.json` 的 `agent` 字段，
//! 见 services/agent/linkage.rs）：装成功记那次的适配器 id，卸载记 null。
//! 启停联动、删除插件、启动清理和 `--pet-hook-cleanup` 都只读它 ——
//! 停用插件导致的卸载不是退出，重新启用时全靠这个字段把安装恢复回来。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::host_error::{HostError, INTERNAL, INVALID_STATE, NOT_FOUND};
use crate::services::agent::adapters::{self, AgentAdapter};
use crate::services::agent::dsh_bridge;
use crate::services::agent::linkage;
use crate::services::agent_hooks;
use crate::services::permission::PermissionState;

/// 调用面判定：任何调用都要过设置窗门禁；带 pluginId 的插件路径再加一层能力校验
fn assert_caller(
    app: &AppHandle,
    window: &tauri::Window,
    plugin_id: Option<&str>,
    what: &str,
) -> Result<(), HostError> {
    // gate 已迁 HostError（ADR-0007），两道门禁的码原样透传，不再经 String 转换
    crate::gate::settings(window, what)?;
    if let Some(pid) = plugin_id {
        let perms = app.state::<PermissionState>();
        crate::gate::plugin_capability(window, &perms, pid, crate::plugin_caps::AGENT_HOOKS)?;
    }
    Ok(())
}

fn home_dir(app: &AppHandle) -> Result<PathBuf, HostError> {
    app.path()
        .home_dir()
        // 拿不到 home 目录 = 宿主起不来，不是调用方的错（与 enabled.rs 同口径）
        .map_err(home_dir_error)
}

/// 失败映射单列成函数：单测里构造不出 AppHandle，只有它能直连这条路径钉码
fn home_dir_error(e: tauri::Error) -> HostError {
    HostError::new(INTERNAL, e.to_string())
}

fn exe_path() -> Result<PathBuf, HostError> {
    std::env::current_exe().map_err(exe_path_error)
}

/// 同上：单测里构造不出 `current_exe` 的失败，用映射函数钉住码
fn exe_path_error(e: std::io::Error) -> HostError {
    HostError::new(INTERNAL, format!("取不到自身路径: {e}"))
}

/// 宿主**实际生效**的全部候选 hook 路径（G2-01）。e2e 的隔离守卫只信这一份：
/// 套件自己按 env 拼路径要复刻 `PET_AGENT_HOME` / `PET_AGENT_*_FILES` 的解析规则，
/// 漏一条就会让「以为在 temp、其实写进真实 home」的用例通过。这里是唯一解析点，
/// 报不出（字段缺失/空表）或报出任何不在 temp 下的路径，守卫都判红（fail-closed）。
///
/// T8-F3：`home` 报的是**生效** home（`adapters::effective_home`，含 `PET_AGENT_HOME`
/// 换根），与 `files` 同源；`defaultHome` 保留 `app.path().home_dir()` 原始值，两者不同
/// 就说明根被换过 —— 排查「为什么写到了别处」先看这一对。widget 目前不读 `defaultHome`
/// （新增字段只增不改；设置页的文档说明随 F04b 台账收口）。
fn everywhere(home: &Path) -> Value {
    let effective = adapters::effective_home(home);
    let adapters: Vec<Value> = adapters::wired()
        .iter()
        .map(|adapter| {
            json!({
                "agent": adapter.id(),
                "displayName": adapter.display_name(),
                "installsFiles": adapter.installs_files(),
                "files": adapter
                    .targets(&effective)
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "home": effective.display().to_string(),
        "defaultHome": home.display().to_string(),
        // 命中的隔离覆盖变量：非空就说明上面的路径不是默认位置（G2-05 的可见性要求）
        "overrides": adapters::active_overrides(),
        "adapters": adapters,
    })
}

fn snapshot(app: &AppHandle) -> Result<Value, HostError> {
    // 按「当前联动的那一家」查，不是写死 Qoder：设置页回显的必须就是用户选中的那个 Agent
    let adapter = linkage::current_adapter(app);
    let home = home_dir(app)?;
    // 没有文件可装的那家（DSH）：状态来自「桥装没装上」，不是配置里有几条 hook。
    // 两种「已安装」共用 `installed` 字段，但判据不同，所以连 `mode` 一起回给设置页。
    if !adapter.installs_files() {
        // 这里传原始 home：`dsh_bridge::dsh_home` 自己就有 `PET_DSH_HOME → PET_AGENT_HOME → home`
        // 的回退链（T8-F3 不在这条链上重复覆盖，否则回退顺序会被改掉）。
        let bridge = dsh_bridge::detect(&home, &dsh_bridge::bundle_dir(app)?);
        return Ok(json!({
            "exe": exe_path().map(|p| p.display().to_string()).unwrap_or_default(),
            "mode": "bridge",
            "bridge": bridge,
            "installed": bridge.detected,
            "managed": 0,
            "expectedPerFile": 0,
            "files": [],
            "agent": adapter.id(),
            "displayName": adapter.display_name(),
            "hint": adapter.post_install_hint(),
            "options": adapters::choices(),
            // 宿主实际生效的路径全表：隔离守卫与排查「为什么写到了别处」都读它
            "everywhere": everywhere(&home),
        }));
    }
    // 与 `everywhere()` 同源（T8-F3）：状态里的 `files` 和 `everywhere.home` 必须由同一个
    // 生效 home 派生，否则设置页一边显示 temp 路径、一边说根是真实家目录。
    let files = adapter.targets(&adapters::effective_home(&home));
    let reports = agent_hooks::status_reports(adapter, &files);
    let managed: usize = reports.iter().map(|r| r.managed).sum();
    let expected = adapter.events().len();
    Ok(json!({
        "exe": exe_path().map(|p| p.display().to_string()).unwrap_or_default(),
        "mode": "hook",
        "files": reports,
        "managed": managed,
        // 装了但条数不对（比如换过 exe 路径）时，UI 该提示「需要修复」而不是「已安装」
        "installed": managed > 0 && files.len() * expected == managed,
        // 每份文件该有几条，由适配器的事件表给，不再直接引 Qoder 那张常量表
        "expectedPerFile": expected,
        "agent": adapter.id(),
        "displayName": adapter.display_name(),
        "hint": adapter.post_install_hint(),
        // 五选一的清单（含还没接线的槽位，界面按 wired=false 禁选）
        "options": adapters::choices(),
        // 宿主实际生效的路径全表：隔离守卫与排查「为什么写到了别处」都读它
        "everywhere": everywhere(&home),
    }))
}

/// 安装的配置目录入口：一个候选都没有时按「资源名字不存在」拒（not-found）。
/// 独立成函数让这条失败在单测里可达（命令体要 AppHandle 与窗口，构造不出来）。
///
/// 文案整个由适配器拼：接第二个客户端时不该还写着 Qoder，而 Qoder 那句要与旧文案**逐字相同**
/// （判据是 `install_without_qoder_config_dirs_is_not_found`）。
fn required_hook_configs(
    adapter: &dyn AgentAdapter,
    home: &Path,
) -> Result<Vec<PathBuf>, HostError> {
    let files = adapter.targets(home);
    if files.is_empty() {
        return Err(HostError::new(
            NOT_FOUND,
            format!(
                "没找到 {} 的配置目录（{}）",
                adapter.display_name(),
                adapter
                    .dir_hint()
                    .iter()
                    .map(|d| format!("~/{d}"))
                    .collect::<Vec<_>>()
                    .join(" 或 ")
            ),
        ));
    }
    Ok(files)
}

#[tauri::command]
pub fn agent_hooks_status(
    app: AppHandle,
    window: tauri::Window,
    plugin_id: Option<String>,
) -> Result<Value, HostError> {
    assert_caller(&app, &window, plugin_id.as_deref(), "查询或改动 Agent hook")?;
    snapshot(&app)
}

/// 「安装」命令的正文：装、把确认拒绝翻成可读错误、只在真装上时记账。
/// 抽成函数不是为复用，是让命令体回到 `check:shape` 的命令体行数上限内（S2）。
fn install_and_note(
    app: &AppHandle,
    adapter: &dyn AgentAdapter,
    home: &Path,
    confirm: bool,
) -> Result<Value, HostError> {
    let files = required_hook_configs(adapter, home)?;
    let reports = agent_hooks::install_files(
        adapter,
        &files,
        &exe_path()?,
        agent_hooks::ledger_dir(app).as_deref(),
        confirm,
    );
    // 需要确认时 install_files 一个文件都没写，错误串以 NEED_CONFIRM 开头：
    // 原样抛给设置页，让它弹那句确认（而不是把半截报告当成功回显）
    if let Some(msg) = reports
        .iter()
        .filter_map(|r| r.error.as_ref())
        .find(|e| e.starts_with(agent_hooks::NEED_CONFIRM))
    {
        return Err(HostError::new(INVALID_STATE, msg.clone()));
    }
    // 只有真装上才算用户的选择；全失败不写，见 linkage::note_installed
    linkage::note_installed(app, adapter.id(), &reports);
    Ok(json!({ "files": reports, "hint": adapter.post_install_hint() }))
}

#[tauri::command]
pub fn agent_hooks_install(
    app: AppHandle,
    window: tauri::Window,
    plugin_id: Option<String>,
    // 第二次点击「安装」时的确认（ZCode 总开关那句）。第一道门在 install_files 里，
    // 与「停用→再启用」的自动重装走同一条判据（G2-09），这里只负责把拒绝翻成可读错误。
    confirm: Option<bool>,
) -> Result<Value, HostError> {
    assert_caller(&app, &window, plugin_id.as_deref(), "查询或改动 Agent hook")?;
    // 「安装」装的是当前选中的那一家（五选一由 agent_linkage_set 负责改这个选择）
    let adapter = linkage::current_adapter(&app);
    let home = home_dir(&app)?;
    // 没有文件可装的那家（DSH）：「接入」= 校验桥在不在 + 记下选择。
    // 这里不能走 install_files —— 装 0 个文件「成功」会让设置页显示已安装、实际毫无作用。
    if !adapter.installs_files() {
        return linkage::attach_bridge(&app, adapter, &home);
    }
    install_and_note(&app, adapter, &home, confirm.unwrap_or(false))
}

/// 切换联动的 Agent（设置页四选一）。单独一条命令的理由（PM Q1）：它要把
/// 「卸旧失败、停在原状态」这个结果**同步**回设置页，并按调用方做权限校验 ——
/// 复用现有方法或「写配置文件再让宿主响应」两条路都做不到。
/// `confirm` 是 ZCode 总开关那句确认的第二次点击（见 linkage::switch_agent）。
#[tauri::command]
pub fn agent_linkage_set(
    app: AppHandle,
    window: tauri::Window,
    plugin_id: Option<String>,
    agent: String,
    confirm: Option<bool>,
) -> Result<Value, HostError> {
    assert_caller(&app, &window, plugin_id.as_deref(), "切换联动的 Agent")?;
    linkage::switch_agent(&app, &agent, confirm.unwrap_or(false), &home_dir(&app)?)
}

#[tauri::command]
pub fn agent_hooks_uninstall(
    app: AppHandle,
    window: tauri::Window,
    plugin_id: Option<String>,
) -> Result<Value, HostError> {
    assert_caller(&app, &window, plugin_id.as_deref(), "查询或改动 Agent hook")?;
    // 卸载按「摘净每个已接线适配器」走，不是只摘 Qoder：设置页的卸载与「撤销授权」连带的
    // 宿主卸载都意味着用户退出联动，留着别家的条目和一个已经被我们拨开的总开关没有道理。
    // （`note_uninstalled` 会清掉总开关记录，所以只摘一家的话那笔账就丢了。）
    let home = home_dir(&app)?;
    let reports = agent_hooks::uninstall_everywhere(&home, &linkage::recorded_switches_of(&app));
    // 卸载（含「撤销授权」连带的宿主卸载）算明确退出：记 null，别再自动装回来。
    // 只忘掉**真的恢复成功**的那几笔开关记录：摘失败的文件还留着旧值，下次卸载才能照着改回去。
    linkage::note_uninstalled_with(&app, &reports);
    Ok(json!({
        "files": reports,
        // G6-11：桥住在 DSH 进程里，宿主摘不到它 —— 卸完必须说清「还差哪一步」
        "bridgeHint": linkage::bridge_residue_hint(&app, &home),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::adapters::claude_style::{self, QODER};
    use crate::services::agent::HOOK_PHASES;

    /// B2 验收 P0：含他人 hook 条目的样例配置走完 install → uninstall 后，
    /// 自家 `--pet-hook` 条目归零、别人的条目一字未动。
    /// 用临时目录里的真实文件走完整写入管线（备份 + 原子替换），全程不碰用户配置。
    #[test]
    fn install_then_uninstall_on_temp_file_keeps_foreign_hooks_untouched() {
        let dir = std::env::temp_dir().join(format!("pet-b2-p0-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let sample = r#"{
  "theme": "dark",
  "hooks": {
    "PreToolUse": [
      { "hooks": [
        { "type": "command", "command": "other-tool --notify", "timeout": 5 },
        { "type": "command", "command": "\"D:\\old\\desktop-pet.exe\" --pet-hook pre", "timeout": 2 }
      ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "keep.sh", "timeout": 3 } ] }
    ]
  }
}"#;
        std::fs::write(&path, sample).unwrap();

        let exe = std::path::Path::new(r"C:\app\desktop-pet.exe");
        // A23：账本目录走临时目录（与 UI 路径同一个签名，只是不写真实 %APPDATA%）
        let ledger = path.parent().expect("配置有父目录").join("ledger");
        let reports = agent_hooks::install_files(
            &QODER,
            std::slice::from_ref(&path),
            exe,
            Some(ledger.as_path()),
            true,
        );
        assert!(reports[0].error.is_none(), "{:?}", reports[0].error);
        assert_eq!(reports[0].managed, HOOK_PHASES.len());

        let installed = std::fs::read_to_string(&path).unwrap();
        // 自家 12 条；别人的两条原样还在；陈旧的自家条目已被摘掉
        assert_eq!(installed.matches("--pet-hook").count(), HOOK_PHASES.len());
        assert!(installed.contains("other-tool --notify"));
        assert!(installed.contains("keep.sh"));
        assert!(!installed.contains("D:\\\\old\\\\desktop-pet.exe"));

        let reports2 =
            agent_hooks::uninstall_files(&QODER, std::slice::from_ref(&path), &json!({}));
        assert_eq!(reports2[0].managed, HOOK_PHASES.len());
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(!after.contains("--pet-hook"));

        // 别人条目逐字节未变：同一段落的规范序列化在安装后 / 卸载后完全相同
        let foreign = |text: &str| -> Vec<String> {
            let val: Value = serde_json::from_str(text).unwrap();
            vec![
                val["hooks"]["PreToolUse"][0]["hooks"][0].to_string(),
                val["hooks"]["Stop"][0]["hooks"][0].to_string(),
            ]
        };
        assert_eq!(foreign(&installed), foreign(&after));
        // 键序也是「未变」的一部分，而且这条要的就是键序：样例里三个键是**故意**不按字母序
        // 写的（type → command → timeout）。serde_json 没开 preserve_order 时这里会得到
        // {"command":…,"timeout":…,"type":…}，等于我们替用户把他的配置重排了一遍。
        // 装卸两个端点都钉：只钉 install 那端，「卸载时又排一次序」就看不见。
        let untouched = vec![
            "{\"type\":\"command\",\"command\":\"other-tool --notify\",\"timeout\":5}".to_string(),
            "{\"type\":\"command\",\"command\":\"keep.sh\",\"timeout\":3}".to_string(),
        ];
        assert_eq!(foreign(&installed), untouched, "装完不能重排别人条目的键序");
        assert_eq!(foreign(&after), untouched, "卸载往返后仍然是原键序");

        // 其余内容也原样：theme 还在，顶层 hooks 只少了自家条目所在的数组项
        let val: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(val["theme"], "dark");
        assert_eq!(claude_style::managed_count(&val), 0);
        assert_eq!(
            val["hooks"]["PreToolUse"][0]["hooks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            val["hooks"]["Stop"][0]["hooks"].as_array().unwrap().len(),
            1
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A04：装 hook 时一个配置目录都没有 = 资源名字不存在 → not-found（文案逐字保持）
    #[test]
    fn install_without_qoder_config_dirs_is_not_found() {
        let dir = std::env::temp_dir().join(format!("pet-a04-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let err = required_hook_configs(&QODER, &dir).unwrap_err();
        assert_eq!(err.code, NOT_FOUND);
        assert_eq!(
            err.message,
            "没找到 Qoder 的配置目录（~/.qoder 或 ~/.qoder-cn）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A04：home 目录解析失败 = 宿主起不来 → internal（status / uninstall 链上都会经过）
    #[test]
    fn home_dir_failure_is_internal() {
        let err = home_dir_error(tauri::Error::UnknownPath);
        assert_eq!(err.code, INTERNAL);
    }

    /// A04：取不到自身 exe 路径 → internal（status / install 链上都会经过）
    #[test]
    fn exe_path_failure_is_internal() {
        let err = exe_path_error(std::io::Error::new(std::io::ErrorKind::NotFound, "probe"));
        assert_eq!(err.code, INTERNAL);
        assert_eq!(err.message, "取不到自身路径: probe");
    }

    /// T8-F3：`everywhere` 的 `home` 必须是**生效** home，且 `files` 与它同源。
    /// 这条钉的是 t8 verify:agent 的假红根因：`home` 报真实家目录、`files` 报 temp，
    /// e2e 的 fail-closed 守卫读到 `home` 就判红。三态都走一遍（设了 / 空值 / 未设）。
    #[test]
    fn everywhere_reports_the_effective_home_and_files_share_it() {
        let _env = adapters::lock_test_env();
        let dir = std::env::temp_dir().join(format!("pet-t26-everywhere-{}", std::process::id()));
        let default = dir.join("default-home");
        let isolated = dir.join("agent-home");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&default).unwrap();
        for leaf in [".qoder", ".qoder-cn", ".zcode", ".codex", ".workbuddy"] {
            std::fs::create_dir_all(isolated.join(leaf)).unwrap();
        }
        // 逐项覆盖变量会把 targets() 整条绕开，这里只验「home 根换根」这一条口径
        for name in ["PET_AGENT_CONFIG_FILES", "PET_AGENT_CODEX_FILES", "PET_AGENT_WORKBUDDY_FILES"] {
            std::env::remove_var(name);
        }

        std::env::set_var("PET_AGENT_HOME", &isolated);
        let value = everywhere(&default);
        assert_eq!(
            value["home"].as_str().expect("home 必须是字符串"),
            isolated.display().to_string(),
            "设了 PET_AGENT_HOME 就必须报生效 home"
        );
        assert_eq!(
            value["defaultHome"].as_str().expect("defaultHome 必须是字符串"),
            default.display().to_string(),
            "原始 home 留在 defaultHome 里，供排查时对照"
        );
        let entries = value["adapters"].as_array().expect("adapters 是数组");
        assert_eq!(entries.len(), adapters::wired().len(), "五家都要回报");
        let isolated_prefix = isolated.display().to_string().to_lowercase();
        let default_prefix = default.display().to_string().to_lowercase();
        let mut with_files = 0;
        for entry in entries {
            for file in entry["files"].as_array().expect("每家有 files 数组") {
                let path = file.as_str().expect("路径是字符串").to_lowercase();
                with_files += 1;
                assert!(
                    path.starts_with(&isolated_prefix),
                    "文件 {path} 必须由生效 home 派生"
                );
                assert!(
                    !path.starts_with(&default_prefix),
                    "文件 {path} 不能落到默认 home"
                );
            }
        }
        assert!(with_files > 0, "至少一家真的报出候选文件，否则这条断言是空转");

        std::env::set_var("PET_AGENT_HOME", "   ");
        let blank = everywhere(&default);
        assert_eq!(
            blank["home"].as_str().expect("home 必须是字符串"),
            default.display().to_string(),
            "空值/纯空白视为没设"
        );

        std::env::remove_var("PET_AGENT_HOME");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
