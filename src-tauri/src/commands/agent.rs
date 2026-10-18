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

use crate::host_error::{HostError, INTERNAL, NOT_FOUND};
use crate::services::agent::adapters::{claude_style, AgentAdapter};
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
        crate::gate::plugin_capability(&perms, pid, crate::plugin_caps::AGENT_HOOKS)?;
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

fn snapshot(app: &AppHandle) -> Result<Value, HostError> {
    let adapter = &claude_style::QODER;
    let files = adapter.targets(&home_dir(app)?);
    let reports = agent_hooks::status_reports(adapter, &files);
    let managed: usize = reports.iter().map(|r| r.managed).sum();
    let expected = adapter.events().len();
    Ok(json!({
        "exe": exe_path().map(|p| p.display().to_string()).unwrap_or_default(),
        "files": reports,
        "managed": managed,
        // 装了但条数不对（比如换过 exe 路径）时，UI 该提示「需要修复」而不是「已安装」
        "installed": managed > 0 && files.len() * expected == managed,
        // 每份文件该有几条，由适配器的事件表给，不再直接引 Qoder 那张常量表
        "expectedPerFile": expected,
    }))
}

/// 安装的配置目录入口：一个候选都没有时按「资源名字不存在」拒（not-found）。
/// 独立成函数让这条失败在单测里可达（命令体要 AppHandle 与窗口，构造不出来）。
///
/// 文案由适配器给：接第二个客户端时这段不该还写着 Qoder。`dirs_hint` 是提示用的目录列表，
/// 它是适配器结构体的字段（trait 里没有这一项，方案 §2 的接口形状不动），所以由调用方传入。
fn required_hook_configs(
    adapter: &dyn AgentAdapter,
    dirs_hint: &[&str],
    home: &Path,
) -> Result<Vec<PathBuf>, HostError> {
    let files = adapter.targets(home);
    if files.is_empty() {
        return Err(HostError::new(
            NOT_FOUND,
            format!(
                "没找到 {} 的配置目录（{}）",
                adapter.display_name(),
                dirs_hint
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

#[tauri::command]
pub fn agent_hooks_install(
    app: AppHandle,
    window: tauri::Window,
    plugin_id: Option<String>,
) -> Result<Value, HostError> {
    assert_caller(&app, &window, plugin_id.as_deref(), "查询或改动 Agent hook")?;
    let adapter = &claude_style::QODER;
    let files = required_hook_configs(adapter, adapter.dirs, &home_dir(&app)?)?;
    let reports = agent_hooks::install_files(adapter, &files, &exe_path()?);
    // 只有真装上才算用户的选择；全失败不写，见 linkage::note_installed
    linkage::note_installed(&app, adapter.id(), &reports);
    Ok(json!({ "files": reports }))
}

#[tauri::command]
pub fn agent_hooks_uninstall(
    app: AppHandle,
    window: tauri::Window,
    plugin_id: Option<String>,
) -> Result<Value, HostError> {
    assert_caller(&app, &window, plugin_id.as_deref(), "查询或改动 Agent hook")?;
    let adapter = &claude_style::QODER;
    let files = adapter.targets(&home_dir(&app)?);
    let reports = agent_hooks::uninstall_files(adapter, &files);
    // 卸载（含「撤销授权」连带的宿主卸载）算明确退出：记 null，别再自动装回来
    linkage::note_uninstalled(&app);
    Ok(json!({ "files": reports }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::adapters::claude_style::QODER;
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
        let reports = agent_hooks::install_files(&QODER, std::slice::from_ref(&path), exe);
        assert!(reports[0].error.is_none(), "{:?}", reports[0].error);
        assert_eq!(reports[0].managed, HOOK_PHASES.len());

        let installed = std::fs::read_to_string(&path).unwrap();
        // 自家 12 条；别人的两条原样还在；陈旧的自家条目已被摘掉
        assert_eq!(installed.matches("--pet-hook").count(), HOOK_PHASES.len());
        assert!(installed.contains("other-tool --notify"));
        assert!(installed.contains("keep.sh"));
        assert!(!installed.contains("D:\\\\old\\\\desktop-pet.exe"));

        let reports2 = agent_hooks::uninstall_files(&QODER, std::slice::from_ref(&path));
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
        let err = required_hook_configs(&QODER, QODER.dirs, &dir).unwrap_err();
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
}
