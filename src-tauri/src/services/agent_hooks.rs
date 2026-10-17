//! Qoder hook 的安装与卸载。
//!
//! 目标配置文件：`~/.qoder-cn/settings.json` 与 `~/.qoder/settings.json`，
//! 结构为 `{ "hooks": { "<Event>": [ { "hooks": [ { "type": "command", "command": …, "timeout": 2 } ] } ] } }`。
//! Qoder 不需要额外的 `hooksConfig.enabled` 开关。
//!
//! 三条硬规则：
//! 1. 只认自己的条目 —— 靠命令串里的 `--pet-hook` 标记识别，绝不删别人的 hook；
//! 2. 重装即幂等 —— 先摘掉全部自家条目再追加，不会越装越多；
//! 3. 坏文件不覆盖 —— 解析不出对象就直接拒绝，让用户自己修，别把配置写坏。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

/// 自家条目的识别标记。它同时是 hook 分支的 CLI 参数，两边共用这一个常量
pub const HOOK_MARKER: &str = "--pet-hook";

/// 装卸串行锁。设置页点按钮、启停联动、启动清理和 `--pet-hook-cleanup` 都在做
/// 「读原文 → 改 → 原子替换」这三步，并发跑就会互相覆盖：一方按旧内容算出新文本时
/// 另一方已经写进去了，后写的那份把先写的条目抹掉（或装出双份）。
/// 锁放在这一层（而不是调用方）是因为调用方有四个，少一个就漏。
static HOOK_IO: Mutex<()> = Mutex::new(());

/// 取锁。中毒（持锁线程 panic）时继续用：配置读写本身是可重入的纯 IO，
/// 让后续装卸因一次无关 panic 永久失效，比带着锁继续跑更糟。
fn lock_hook_io() -> std::sync::MutexGuard<'static, ()> {
    HOOK_IO.lock().unwrap_or_else(|p| p.into_inner())
}

/// hook 超时（秒）。事件采集不该拖住 Agent，取小值
const HOOK_TIMEOUT: i64 = 2;

fn is_managed(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|cmd| cmd.contains(HOOK_MARKER))
}

/// 摘掉全部自家 hook，返回摘掉的条数；内层 `hooks` 被摘空的外层分组一并删除，
/// 分组数组空了则连事件键一起删。
pub fn strip_managed(config: &mut Value) -> usize {
    let Some(hooks) = config.get_mut("hooks").and_then(Value::as_object_mut) else {
        return 0;
    };
    let mut removed = 0;
    let mut emptied: Vec<String> = Vec::new();

    for (event, entries) in hooks.iter_mut() {
        let Some(entries) = entries.as_array_mut() else {
            continue;
        };
        let mut kept_groups: Vec<Value> = Vec::with_capacity(entries.len());
        for entry in entries.drain(..) {
            let mut entry = entry;
            if let Some(group) = entry.get_mut("hooks").and_then(Value::as_array_mut) {
                let before = group.len();
                group.retain(|hook| !is_managed(hook));
                removed += before - group.len();
            }
            let still_has_hooks = entry
                .get("hooks")
                .and_then(Value::as_array)
                .is_some_and(|group| !group.is_empty());
            if still_has_hooks {
                kept_groups.push(entry);
            }
        }
        *entries = kept_groups;
        if entries.is_empty() {
            emptied.push(event.clone());
        }
    }
    for event in emptied {
        hooks.remove(&event);
    }
    removed
}

/// 追加自家条目。调用方应先 strip_managed 以保证幂等。
pub fn append_managed(config: &mut Value, command_for: impl Fn(&str) -> String) -> usize {
    if config.get("hooks").is_none() {
        config["hooks"] = json!({});
    }
    let Some(hooks) = config.get_mut("hooks").and_then(Value::as_object_mut) else {
        return 0;
    };
    let mut added = 0;
    for (event, phase) in super::agent::HOOK_PHASES {
        let entry = hooks
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        let Some(list) = entry.as_array_mut() else {
            continue;
        };
        list.push(json!({
            "hooks": [{
                "type": "command",
                "command": command_for(phase),
                "timeout": HOOK_TIMEOUT,
            }]
        }));
        added += 1;
    }
    added
}

/// 配置里自家 hook 的条数（不含别人的）
pub fn managed_count(config: &Value) -> usize {
    let Some(hooks) = config.get("hooks").and_then(Value::as_object) else {
        return 0;
    };
    hooks
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|entry| entry.get("hooks").and_then(Value::as_array))
        .flatten()
        .filter(|hook| is_managed(hook))
        .count()
}

fn parse_object(raw: &str) -> Result<Value, String> {
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    let config: Value = serde_json::from_str(raw).map_err(|e| format!("配置不是合法 JSON: {e}"))?;
    if !config.is_object() {
        return Err("配置顶层不是对象，拒绝改写".into());
    }
    Ok(config)
}

/// 纯函数版安装：解析 → 拒绝坏结构 → 摘旧 → 追加
pub fn install_in_text(
    raw: &str,
    command_for: impl Fn(&str) -> String,
) -> Result<(String, usize), String> {
    let mut config = parse_object(raw)?;
    strip_managed(&mut config);
    let added = append_managed(&mut config, command_for);
    Ok((
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
        added,
    ))
}

/// 纯函数版卸载：没有自家条目时返回 None，表示「不必改动这个文件」
pub fn uninstall_in_text(raw: &str) -> Result<Option<(String, usize)>, String> {
    let mut config = parse_object(raw)?;
    let removed = strip_managed(&mut config);
    if removed == 0 {
        return Ok(None);
    }
    Ok(Some((
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
        removed,
    )))
}

pub fn command_for(exe: &Path, phase: &str) -> String {
    // 路径可能带空格，整体加引号；phase 取自白名单常量，无注入面
    format!("\"{}\" {HOOK_MARKER} {phase}", exe.display())
}

#[derive(serde::Serialize)]
pub struct FileReport {
    pub path: String,
    pub managed: usize,
    pub error: Option<String>,
}

impl FileReport {
    fn failed(path: &Path, error: impl Into<String>) -> Self {
        Self {
            path: path.display().to_string(),
            managed: 0,
            error: Some(error.into()),
        }
    }
}

/// 候选配置文件：只有所在目录存在才算数（没装那个客户端就不该凭空造配置）。
/// `PET_AGENT_CONFIG_FILES`（`;` 分隔）是开发与测试的覆盖入口，避免动到真实用户配置。
pub fn candidate_files(home: &Path) -> Vec<PathBuf> {
    if let Ok(list) = std::env::var("PET_AGENT_CONFIG_FILES") {
        return list
            .split(';')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.parent().is_some_and(|dir| dir.exists()))
            .collect();
    }
    [".qoder", ".qoder-cn"]
        .iter()
        .map(|leaf| home.join(leaf).join("settings.json"))
        .filter(|p| p.parent().is_some_and(|dir| dir.exists()))
        .collect()
}

fn backup_once(path: &Path) -> std::io::Result<()> {
    let mut name = path.as_os_str().to_os_string();
    name.push(".pre-pet-backup");
    let bak = PathBuf::from(name);
    if bak.exists() {
        return Ok(());
    }
    fs::copy(path, &bak).map(|_| ())
}

/// 原子写：先落同目录临时文件再 rename，避免写一半被打断留下坏配置。
/// 临时名必须带 pid —— 固定名会让两个来源同时安装时互相覆盖：
/// 一方还在写 `settings.json.tmp`，另一方已经把同名文件 rename 走了。
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let base = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("settings.json");
    let tmp = path.with_file_name(format!("{base}.{}.tmp", std::process::id()));
    if let Err(e) = fs::write(&tmp, text) {
        return Err(format!("写入临时文件失败: {e}"));
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(format!("替换配置文件失败: {e}"))
        }
    }
}

/// 读原文；文件不存在返回 Ok(None)
fn read_existing(path: &Path) -> Result<Option<String>, std::io::Error> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// 这批报告里有没有至少一个文件真的装上了。设置页据此决定「要不要把用户的选择记进
/// 联动状态文件」—— 全部失败时不记，否则下一次启用插件会去装一个从没成功过的 hook。
pub fn any_installed(reports: &[FileReport]) -> bool {
    reports.iter().any(|r| r.error.is_none() && r.managed > 0)
}

pub fn status_reports(files: &[PathBuf]) -> Vec<FileReport> {
    files
        .iter()
        .map(|path| match read_existing(path) {
            Ok(None) => FileReport {
                path: path.display().to_string(),
                managed: 0,
                error: None,
            },
            Ok(Some(raw)) => match serde_json::from_str::<Value>(&raw) {
                Ok(config) => FileReport {
                    path: path.display().to_string(),
                    managed: managed_count(&config),
                    error: None,
                },
                Err(e) => FileReport::failed(path, format!("配置解析失败: {e}")),
            },
            Err(e) => FileReport::failed(path, e.to_string()),
        })
        .collect()
}

/// 写回前先备份。备份失败就不改 —— 宁可装不上，也不能把用户配置弄成不可恢复
fn apply_text(path: &Path, text: &str) -> Result<(), String> {
    if path.exists() {
        backup_once(path).map_err(|_| "备份失败，未改动配置".to_string())?;
    }
    write_atomic(path, text)
}

pub fn install_files(files: &[PathBuf], exe: &Path) -> Vec<FileReport> {
    let _io = lock_hook_io();
    files
        .iter()
        .map(|path| {
            let raw = match read_existing(path) {
                Ok(raw) => raw.unwrap_or_default(),
                Err(e) => return FileReport::failed(path, e.to_string()),
            };
            let owned = path.clone();
            let exe = exe.to_path_buf();
            match install_in_text(&raw, move |phase| command_for(&exe, phase)) {
                Ok((text, added)) => match apply_text(&owned, &text) {
                    Ok(()) => FileReport {
                        path: owned.display().to_string(),
                        managed: added,
                        error: None,
                    },
                    Err(e) => FileReport::failed(&owned, e),
                },
                Err(e) => FileReport::failed(&owned, e),
            }
        })
        .collect()
}

pub fn uninstall_files(files: &[PathBuf]) -> Vec<FileReport> {
    let _io = lock_hook_io();
    files
        .iter()
        .map(|path| {
            let Ok(raw) = read_existing(path) else {
                return FileReport::failed(path, "读取配置失败");
            };
            let Some(raw) = raw else {
                return FileReport {
                    path: path.display().to_string(),
                    managed: 0,
                    error: None,
                };
            };
            match uninstall_in_text(&raw) {
                Ok(None) => FileReport {
                    path: path.display().to_string(),
                    managed: 0,
                    error: None,
                },
                Ok(Some((text, removed))) => match apply_text(path, &text) {
                    Ok(()) => FileReport {
                        path: path.display().to_string(),
                        managed: removed,
                        error: None,
                    },
                    Err(e) => FileReport::failed(path, e),
                },
                Err(e) => FileReport::failed(path, e),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::HOOK_PHASES;

    fn cmd(phase: &str) -> String {
        format!("C:\\app\\desktop-pet.exe {HOOK_MARKER} {phase}")
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).expect("产出必须是合法 JSON")
    }

    #[test]
    fn installs_every_event_and_keeps_other_keys() {
        let (text, added) = install_in_text(r#"{"theme":"dark"}"#, cmd).unwrap();
        let config = parse(&text);
        assert_eq!(added, HOOK_PHASES.len());
        assert_eq!(config["theme"], "dark");
        assert_eq!(managed_count(&config), HOOK_PHASES.len());
        assert_eq!(
            config["hooks"]["PreToolUse"][0]["hooks"][0]["type"],
            "command"
        );
    }

    #[test]
    fn treats_missing_file_content_as_empty_object() {
        let (text, added) = install_in_text("", cmd).unwrap();
        assert_eq!(added, HOOK_PHASES.len());
        assert!(text.starts_with('{'));
    }

    #[test]
    fn reinstall_is_idempotent() {
        let (once, _) = install_in_text("{}", cmd).unwrap();
        let (twice, added) = install_in_text(&once, cmd).unwrap();
        let config = parse(&twice);
        assert_eq!(added, HOOK_PHASES.len());
        assert_eq!(managed_count(&config), HOOK_PHASES.len());
        assert_eq!(config["hooks"]["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn keeps_foreign_hooks_in_the_same_event() {
        let raw = json!({
            "hooks": { "PreToolUse": [ { "hooks": [
                { "type": "command", "command": "other-tool --notify" },
                { "type": "command", "command": "stale.exe --pet-hook pre" }
            ] } ] }
        });
        let (text, _) = install_in_text(&raw.to_string(), cmd).unwrap();
        let config = parse(&text);
        let groups = config["hooks"]["PreToolUse"].as_array().unwrap();
        // 陈旧自家条目被摘掉，别人的原样留在原分组；我们的作为新分组追加
        assert_eq!(
            groups
                .iter()
                .flat_map(|g| g["hooks"].as_array().unwrap().iter())
                .filter(|h| h["command"] == "other-tool --notify")
                .count(),
            1
        );
        // 整个事件里只剩一份自家条目，且每个事件都只有一份
        assert_eq!(managed_count(&config), HOOK_PHASES.len());
        assert_eq!(
            groups
                .iter()
                .flat_map(|g| g["hooks"].as_array().unwrap().iter())
                .filter(|h| is_managed(h))
                .count(),
            1
        );
    }

    #[test]
    fn uninstall_removes_only_ours_and_drops_empty_keys() {
        let (text, _) = install_in_text("{}", cmd).unwrap();
        let (after, removed) = uninstall_in_text(&text).unwrap().unwrap();
        let config = parse(&after);
        assert_eq!(removed, HOOK_PHASES.len());
        assert_eq!(managed_count(&config), 0);
        assert_eq!(config["hooks"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn uninstall_keeps_user_owned_hooks() {
        let raw = json!({
            "hooks": { "Stop": [ { "hooks": [
                { "type": "command", "command": "mine.exe --pet-hook stop" },
                { "type": "command", "command": "keep.sh" }
            ] } ] }
        });
        let (after, removed) = uninstall_in_text(&raw.to_string()).unwrap().unwrap();
        let config = parse(&after);
        assert_eq!(removed, 1);
        assert_eq!(
            config["hooks"]["Stop"][0]["hooks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(config["hooks"]["Stop"][0]["hooks"][0]["command"], "keep.sh");
    }

    #[test]
    fn uninstall_reports_no_change_when_nothing_ours() {
        assert!(uninstall_in_text(r#"{"theme":"dark"}"#).unwrap().is_none());
    }

    #[test]
    fn refuses_to_rewrite_malformed_or_non_object_config() {
        assert!(install_in_text("{ not json", cmd).is_err());
        assert!(install_in_text("[1,2,3]", cmd).is_err());
        assert!(uninstall_in_text("[1,2,3]").is_err());
    }

    #[test]
    fn quotes_exe_path_for_spaces() {
        let built = command_for(Path::new(r"C:\Program Files\pet\desktop-pet.exe"), "pre");
        assert!(built.starts_with('"'));
        assert!(built.contains("Program Files"));
        assert!(built.ends_with("--pet-hook pre"));
    }

    /// preserve_order 的卖点落在「属于用户的那些键」上：装卸往返后，顶层键的顺序与值都不碰。
    /// 口径说的是「除 hooks 子树外逐字节一致」，这里能真证的是「键序 + 值不变」——
    /// 序列化走 to_string_pretty，缩进风格由宿主定，字节级一致本来就不成立，别假装证了。
    /// 关掉 Cargo.toml 的 preserve_order，这条就该红。
    #[test]
    fn user_key_order_survives_an_install_uninstall_round_trip() {
        let raw = r#"{"zeta":1,"alpha":{"nested":[3,1,2]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep.sh"}]}]}}"#;
        let keys = |text: &str| -> Vec<String> {
            serde_json::from_str::<Value>(text)
                .expect("产出必须是合法 JSON")
                .as_object()
                .expect("顶层必须是对象")
                .keys()
                .cloned()
                .collect()
        };
        let (text, _) = install_in_text(raw, cmd).unwrap();
        assert_eq!(
            keys(&text),
            ["zeta", "alpha", "hooks"],
            "顶层键序必须按用户原来那样，不是字母序"
        );
        let (after, removed) = uninstall_in_text(&text).unwrap().unwrap();
        assert_eq!(removed, HOOK_PHASES.len());
        assert_eq!(keys(&after), keys(&text), "卸载也不得重排");
        let config = parse(&after);
        assert_eq!(
            config["alpha"]["nested"].to_string(),
            "[3,1,2]",
            "数组顺序更不是我们的事"
        );
        assert_eq!(config["hooks"]["Stop"][0]["hooks"][0]["command"], "keep.sh");
        assert_eq!(managed_count(&config), 0);
    }

    /// 「装成功才算用户的选择」的判据：设置页据此决定要不要往 agent-linkage.json 写 qoder。
    /// 全失败还去记，等于让下一次启用插件装一个从没成功过的 hook。
    #[test]
    fn any_installed_needs_a_file_without_error_and_with_entries() {
        let ok = |managed: usize, error: Option<&str>| FileReport {
            path: "x".into(),
            managed,
            error: error.map(str::to_string),
        };
        assert!(any_installed(&[ok(12, None)]));
        assert!(
            any_installed(&[ok(0, Some("备份失败")), ok(12, None)]),
            "一个文件失败不算全失败"
        );
        assert!(!any_installed(&[]), "一个候选都没有 = 没装那个 Agent");
        assert!(
            !any_installed(&[ok(0, Some("配置解析失败"))]),
            "全部失败不能算装上"
        );
        assert!(
            !any_installed(&[ok(0, None)]),
            "managed=0 且无错 = 没写进任何条目，也不算装上"
        );
    }
}
