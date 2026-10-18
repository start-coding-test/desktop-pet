//! Claude 风格 JSON 配置的适配器：`{ "hooks": { "<Event>": [ { "hooks": [ … ] } ] } }`。
//!
//! Qoder 用的就是这个形状（Codex / WorkBuddy 同族，接线在 PR-3）。文件读写的三条硬规则
//! 原样从 `services/agent_hooks.rs` 搬过来，没有改：
//! 1. 只认自己的条目 —— 靠命令串里的 `--pet-hook` 标记识别，绝不删别人的 hook；
//! 2. 重装即幂等 —— 先摘掉全部自家条目再追加，不会越装越多；
//! 3. 坏文件不覆盖 —— 解析不出对象就直接拒绝，让用户自己修，别把配置写坏。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::AgentAdapter;
// 走 `services::agent` 的对外路径而不是 `phases::`：`agent/mod.rs` 那行 `pub use` 重导出的
// 就是这张 Qoder 事件表，本模块是它在生产代码里的使用方（那行重导出不属于本次获批范围，不动）。
use crate::services::agent::HOOK_PHASES;
use crate::services::agent_hooks::HOOK_MARKER;

/// hook 超时。Qoder 的 `timeout` 单位是秒：事件采集不该拖住 Agent，所以取小值。
/// 键名与单位都由适配器带着走（ZCode 那家叫 `timeoutMs`、单位是毫秒），调用方不许猜。
const HOOK_TIMEOUT: i64 = 2;

pub struct ClaudeStyleJson {
    pub id: &'static str,
    pub display_name: &'static str,
    /// home 下哪些目录存在就算装了这个客户端
    pub dirs: &'static [&'static str],
    /// 每个目录里那个配置文件叫什么
    pub file: &'static str,
    pub events: &'static [(&'static str, &'static str)],
    pub timeout_key: &'static str,
    /// 开发/测试的覆盖入口：设了这个环境变量（`;` 分隔完整文件路径）就不再从 home 推目录。
    /// 它是「不碰真实用户配置」这条硬规则的实现，不是可选装饰。
    pub paths_env: &'static str,
}

impl ClaudeStyleJson {
    /// 摘掉全部自家 hook，返回摘掉的条数；内层 `hooks` 被摘空的外层分组一并删除，
    /// 分组数组空了则连事件键一起删。
    fn strip_managed(&self, config: &mut Value) -> usize {
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

    /// 追加自家条目。调用方必须先 strip_managed 以保证幂等。
    fn append_managed(&self, config: &mut Value, command_for: &dyn Fn(&str) -> String) -> usize {
        if config.get("hooks").is_none() {
            config["hooks"] = json!({});
        }
        let Some(hooks) = config.get_mut("hooks").and_then(Value::as_object_mut) else {
            return 0;
        };
        let mut added = 0;
        for (event, phase) in self.events {
            let entry = hooks
                .entry((*event).to_string())
                .or_insert_with(|| json!([]));
            let Some(list) = entry.as_array_mut() else {
                continue;
            };
            let mut hook = json!({
                "type": "command",
                "command": command_for(phase),
            });
            // 键名由适配器决定（Qoder 是 timeout、ZCode 是 timeoutMs），json! 里不能拼变量，
            // 所以在这一步补上
            hook[self.timeout_key] = json!(HOOK_TIMEOUT);
            list.push(json!({ "hooks": [hook] }));
            added += 1;
        }
        added
    }
}

/// 自家条目的识别标记：命令串里带 `--pet-hook` 就是我们在装，别的都别碰
fn is_managed(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|cmd| cmd.contains(HOOK_MARKER))
}

/// 数自家条目（不含别人的）
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

impl AgentAdapter for ClaudeStyleJson {
    fn id(&self) -> &'static str {
        self.id
    }

    fn display_name(&self) -> &'static str {
        self.display_name
    }

    fn targets(&self, home: &Path) -> Vec<PathBuf> {
        if let Ok(list) = std::env::var(self.paths_env) {
            return list
                .split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .filter(|p| p.parent().is_some_and(|dir| dir.exists()))
                .collect();
        }
        self.dirs
            .iter()
            .map(|leaf| home.join(leaf).join(self.file))
            .filter(|p| p.parent().is_some_and(|dir| dir.exists()))
            .collect()
    }

    fn install_in_text(&self, raw: &str, cmd: &dyn Fn(&str) -> String) -> Result<String, String> {
        let mut config = parse_object(raw)?;
        self.strip_managed(&mut config);
        self.append_managed(&mut config, cmd);
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())
    }

    fn uninstall_in_text(&self, raw: &str) -> Result<Option<(String, usize)>, String> {
        let mut config = parse_object(raw)?;
        let removed = self.strip_managed(&mut config);
        if removed == 0 {
            return Ok(None);
        }
        let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        Ok(Some((text, removed)))
    }

    fn managed_count(&self, raw: &str) -> usize {
        match parse_object(raw) {
            Ok(config) => managed_count(&config),
            // 读不出对象 = 数不出来，也别去改它（status 那条路径会单独报解析失败）
            Err(_) => 0,
        }
    }

    fn events(&self) -> &'static [(&'static str, &'static str)] {
        self.events
    }
}

/// Qoder：两个可能的配置目录，12 条事件，`timeout` 按秒。
pub static QODER: ClaudeStyleJson = ClaudeStyleJson {
    id: "qoder",
    display_name: "Qoder",
    dirs: &[".qoder", ".qoder-cn"],
    file: "settings.json",
    events: HOOK_PHASES,
    timeout_key: "timeout",
    paths_env: "PET_AGENT_CONFIG_FILES",
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::adapters::AgentAdapter;
    use crate::services::agent::HOOK_PHASES;

    fn cmd(phase: &str) -> String {
        format!("C:\\app\\desktop-pet.exe {HOOK_MARKER} {phase}")
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).expect("产出必须是合法 JSON")
    }

    #[test]
    fn installs_every_event_and_keeps_other_keys() {
        let text = QODER.install_in_text(r#"{"theme":"dark"}"#, &cmd).unwrap();
        let config = parse(&text);
        assert_eq!(QODER.events().len(), HOOK_PHASES.len());
        assert_eq!(managed_count(&config), HOOK_PHASES.len());
        assert_eq!(
            config["hooks"]["PreToolUse"][0]["hooks"][0]["type"],
            "command"
        );
    }

    #[test]
    fn treats_missing_file_content_as_empty_object() {
        let text = QODER.install_in_text("", &cmd).unwrap();
        assert_eq!(managed_count(&parse(&text)), HOOK_PHASES.len());
        assert!(text.starts_with('{'));
    }

    #[test]
    fn reinstall_is_idempotent() {
        let once = QODER.install_in_text("{}", &cmd).unwrap();
        let twice = QODER.install_in_text(&once, &cmd).unwrap();
        let config = parse(&twice);
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
        let text = QODER.install_in_text(&raw.to_string(), &cmd).unwrap();
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
        let text = QODER.install_in_text("{}", &cmd).unwrap();
        let (after, removed) = QODER.uninstall_in_text(&text).unwrap().unwrap();
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
        let (after, removed) = QODER.uninstall_in_text(&raw.to_string()).unwrap().unwrap();
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
        assert!(QODER
            .uninstall_in_text(r#"{"theme":"dark"}"#)
            .unwrap()
            .is_none());
    }

    #[test]
    fn refuses_to_rewrite_malformed_or_non_object_config() {
        assert!(QODER.install_in_text("{ not json", &cmd).is_err());
        assert!(QODER.install_in_text("[1,2,3]", &cmd).is_err());
        assert!(QODER.uninstall_in_text("[1,2,3]").is_err());
    }

    /// preserve_order 的卖点落在「属于用户的那些键」上：装卸往返后，顶层键的顺序与值都不碰。
    /// 口径说的是「除 hooks 子树外逐字节一致」，这里能真证的是「键序 + 值不变」——
    /// 序列化走 to_string_pretty，缩进风格由宿主定，字节级一致本来就不成立，别假装证了。
    /// 关掉 Cargo.toml 的 preserve_order，这条就该红。
    #[test]
    fn user_key_order_survives_an_install_uninstall_round_trip() {
        let raw = r#"{"zeta":1,"alpha":{"nested":[3,1,2]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep.sh"}]}]}}"#;
        let keys = |text: &str| -> Vec<String> {
            parse(text)
                .as_object()
                .expect("顶层必须是对象")
                .keys()
                .cloned()
                .collect()
        };
        let text = QODER.install_in_text(raw, &cmd).unwrap();
        assert_eq!(
            keys(&text),
            ["zeta", "alpha", "hooks"],
            "顶层键序必须按用户原来那样，不是字母序"
        );
        let (after, removed) = QODER.uninstall_in_text(&text).unwrap().unwrap();
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

    /// 事件词表由适配器给，不是宿主写死：这条把「Qoder 恰好是那 12 条」钉成注册表事实
    #[test]
    fn qoder_installs_exactly_the_pr1_event_table() {
        assert_eq!(
            QODER.events(),
            crate::services::agent::phases::HOOK_PHASES,
            "Qoder 装的事件集必须与 PR-1 一字不差，否则「行为不变」这条没依据"
        );
    }

    /// 目录存在才算装了这个客户端 —— 用一个 `paths_env` 指向不存在变量的探针实例来测，
    /// 这样它读的是纯目录分支，不会被开发机或 CI 上的 `PET_AGENT_CONFIG_FILES` 干扰
    /// （那个覆盖分支由 `agent_hooks::tests` 里唯一改这个变量的那条测试负责）。
    #[test]
    fn targets_only_count_directories_that_exist() {
        let probe = ClaudeStyleJson {
            id: "probe",
            display_name: "探针",
            dirs: &[".probe-dir"],
            file: "probe.json",
            events: HOOK_PHASES,
            timeout_key: "timeout",
            paths_env: "PET_AGENT_PROBE_UNSET_ENV",
        };
        let home = std::env::temp_dir().join(format!("pet-probe-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();

        assert!(
            probe.targets(&home).is_empty(),
            "home 下没有 .probe-dir 时必须一个候选都不给，更不能凭空造配置"
        );

        std::fs::create_dir_all(home.join(".probe-dir")).unwrap();
        assert_eq!(
            probe.targets(&home),
            vec![home.join(".probe-dir").join("probe.json")],
            "目录存在才算装了这个客户端（文件本身还不存在也照样列出来）"
        );

        let _ = std::fs::remove_dir_all(&home);
    }
}
