//! ZCode 适配器。
//!
//! 与 Qoder 那家的三处形状差异（方案 §3）：
//!   * 事件挂在 `hooks.events.<Event>` 里，比 Qoder 多一层 `events`；
//!   * `hooks` 下还有一个总开关 `hooks.enabled`，关着的时候整段都不生效；
//!   * 超时字段叫 `timeoutMs`，单位是毫秒。
//!
//! 另外它的用户级配置有两个文件名：官方文档写 `config.json`，运行时（3.14.4）首启会把它
//! 迁成 `setting.json` 并只读后者 —— 与文档不一致，所以**两个都写、两个都摘**，
//! 谁存在写谁；`~/.zcode` 不存在就当作没装，不凭空造配置。
//!
//! 只用官方文档里 `command` 类型明确列出的三个字段（`type`/`command`/`timeoutMs`）：
//! 不写 `matcher`（缺省匹配全部），不写 `args`（feedback#32 报告过某个版本的校验器不认
//! `args`，而**一条非法条目会让整个 `hooks` 段失效**，连带用户自己配的 hook 一起废）。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::AgentAdapter;
use crate::services::agent::phases::AGENT_FLAG;
use crate::services::agent_hooks::HOOK_MARKER;

/// 事件词表只有 7 条（ZCode 没有 SessionEnd / Notification / Subagent / Interrupt）；
/// 回合结束靠 `state.rs` 现有的 90 秒 TTL 回落 idle，不动状态机。
const EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "user-prompt"),
    ("PreToolUse", "pre"),
    ("PermissionRequest", "approval-request"),
    ("PostToolUse", "post"),
    ("PostToolUseFailure", "tool-failure"),
    ("Stop", "stop"),
];

/// 超时：ZCode 的字段叫 `timeoutMs`，单位毫秒。与 Qoder 的 2 秒同口径
const TIMEOUT_MS: i64 = 2000;

pub struct ZCodeAdapter;

impl ZCodeAdapter {
    fn root(home: &Path) -> PathBuf {
        home.join(".zcode").join("cli")
    }

    /// `hooks` 段拿不到对象 = 这家客户端的配置不是我们认得的那个形状。
    /// 与 Qoder 的「坏文件不覆盖」同一态度：拒绝改写，别去猜。
    fn hooks_of(config: &mut Value) -> Option<&mut Value> {
        config.get_mut("hooks")
    }

    /// 事件表所在的对象：`hooks.events`。没有就建一个；类型不对（不是对象）返回 None。
    fn events_of(hooks: &mut Value) -> Option<&mut serde_json::Map<String, Value>> {
        if hooks.get("events").is_none() {
            hooks["events"] = json!({});
        }
        hooks.get_mut("events").and_then(Value::as_object_mut)
    }

    /// 自家条目：命令串里同时有 `--pet-hook` 和 `--agent zcode`。
    /// 比 Qoder 多判一次来源 —— ZCode 与 Codex/WorkBuddy 同族，事件词表重合度高，
    /// 万一别的适配器的条目落进同一个文件，按标记删会删掉别人的。
    fn is_ours(hook: &Value) -> bool {
        hook.get("command")
            .and_then(Value::as_str)
            .is_some_and(|cmd| {
                cmd.contains(HOOK_MARKER) && cmd.contains(&format!("{AGENT_FLAG} zcode"))
            })
    }

    /// 摘掉自家条目。返回摘掉的条数；某个事件的数组被摘空就删掉那个事件键。
    fn strip(&self, hooks: &mut Value) -> usize {
        let Some(events) = hooks.get_mut("events").and_then(Value::as_object_mut) else {
            return 0;
        };
        let mut removed = 0;
        let mut emptied: Vec<String> = Vec::new();
        for (event, groups) in events.iter_mut() {
            let Some(groups) = groups.as_array_mut() else {
                continue;
            };
            let before = groups.len();
            // 我们的条目永远独占一个分组（不和用户已有的组合并），所以整组摘掉
            groups.retain(|group| {
                !group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .is_some_and(|inner| inner.iter().any(Self::is_ours))
            });
            removed += before - groups.len();
            if groups.is_empty() {
                emptied.push(event.clone());
            }
        }
        for event in emptied {
            events.remove(&event);
        }
        // 全空了就连 `events` 这个键一起删：空对象与没有这个键在 ZCode 里语义相同，
        // 留着等于给用户添一个他从来没写过的键，也让「装卸往返逐字等价」这条没法钉。
        let all_emptied = events.is_empty();
        if all_emptied {
            if let Some(hooks) = hooks.as_object_mut() {
                hooks.remove("events");
            }
        }
        removed
    }

    /// 卸载时恢复总开关：只在我们当初动过它的时候调用。
    /// `Some(true/false)` 写回原值；`None`（记的是 null）表示原来根本没这个键 —— 删掉。
    pub fn restore_switch(&self, config: &mut Value, before: &Value) {
        let Some(hooks) = config.get_mut("hooks").and_then(Value::as_object_mut) else {
            return;
        };
        if before.is_null() {
            hooks.remove("enabled");
        } else {
            hooks.insert("enabled".into(), before.clone());
        }
    }
}

impl AgentAdapter for ZCodeAdapter {
    fn id(&self) -> &'static str {
        "zcode"
    }

    fn display_name(&self) -> &'static str {
        "ZCode"
    }

    fn dir_hint(&self) -> &'static [&'static str] {
        &[".zcode/cli"]
    }

    /// `~/.zcode` 不存在 = 没装这个客户端，一个候选都不给（连文件都不造）。
    /// 存在时列出 `cli/config.json` 与 `cli/setting.json` 里**实际存在的那些**；
    /// 两个都不存在也照样不造 —— 开发机上到底哪一种对应「装过但还没生成配置」，
    /// 是方案 §3.1 点名要在真机确认的一条，写进人工验证清单。
    fn targets(&self, home: &Path) -> Vec<PathBuf> {
        let root = match std::env::var("PET_AGENT_HOME") {
            Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
            _ => home.to_path_buf(),
        };
        if !root.join(".zcode").exists() {
            return Vec::new();
        }
        ["config.json", "setting.json"]
            .iter()
            .map(|leaf| Self::root(&root).join(leaf))
            .filter(|p| p.exists())
            .collect()
    }

    fn install_in_text(&self, raw: &str, cmd: &dyn Fn(&str) -> String) -> Result<String, String> {
        if raw.trim().is_empty() {
            return Err("ZCode 配置文件是空的，拒绝凭空造一份".into());
        }
        let mut config: Value =
            serde_json::from_str(raw).map_err(|e| format!("配置不是合法 JSON: {e}"))?;
        if !config.is_object() {
            return Err("配置顶层不是对象，拒绝改写".into());
        }
        // `hooks` 段已存在但不是对象（有人写成数组或字符串）→ 整段不动、直接拒
        if let Some(hooks) = config.get("hooks") {
            if !hooks.is_object() {
                return Err("hooks 段不是对象，拒绝改写".into());
            }
        }
        if config.get("hooks").is_none() {
            config["hooks"] = json!({});
        }
        let hooks = Self::hooks_of(&mut config).expect("上面刚建好 hooks 对象");
        // 装之前先把旧条目摘干净（幂等），返回值这里用不上：报告里的条数由流水线按
        // 「这份新文本实际有几条」重算
        let _ = self.strip(&mut *hooks);
        // 总开关：原来是 true 就不动；否则打开（原来有没有键、有没有别人的条目，
        // 由安装流水线抄进状态文件，弹确认框与恢复都看那份记录）
        hooks["enabled"] = json!(true);
        let events = Self::events_of(&mut *hooks).expect("上面刚建好 events 对象");
        for (event, phase) in EVENTS {
            let entry = events
                .entry((*event).to_string())
                .or_insert_with(|| json!([]));
            let Some(list) = entry.as_array_mut() else {
                return Err(format!("ZCode 事件 {event} 不是数组，拒绝改写"));
            };
            list.push(json!({
                "hooks": [{
                    "type": "command",
                    "command": cmd(phase),
                    "timeoutMs": TIMEOUT_MS,
                }]
            }));
        }
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())
    }

    fn uninstall_in_text(&self, raw: &str) -> Result<Option<(String, usize)>, String> {
        self.uninstall_restoring_switch(raw, None)
    }

    /// 摘自家条目，然后把总开关恢复成装之前的样子（`before` 没记 = 当初没动过，不恢复）。
    fn uninstall_restoring_switch(
        &self,
        raw: &str,
        before: Option<&Value>,
    ) -> Result<Option<(String, usize)>, String> {
        let mut config: Value =
            serde_json::from_str(raw).map_err(|e| format!("配置不是合法 JSON: {e}"))?;
        if !config.is_object() {
            return Err("配置顶层不是对象，拒绝改写".into());
        }
        let removed = match config.get_mut("hooks") {
            Some(hooks) if hooks.is_object() => self.strip(hooks),
            Some(_) => return Err("hooks 段不是对象，拒绝改写".into()),
            None => 0,
        };
        if removed == 0 {
            return Ok(None);
        }
        if let Some(value) = before {
            self.restore_switch(&mut config, value);
        }
        let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        Ok(Some((text, removed)))
    }

    fn has_switch(&self) -> bool {
        true
    }

    /// 装之前总开关的样子：`None` = 原文没有 `hooks.enabled` 这个键（ZCode 按关处理）。
    /// 安装流水线把它抄进状态文件，卸载时照单恢复 —— 记 `null` 与记 `false` 的恢复动作不同。
    fn switch_before(&self, raw: &str) -> Option<Value> {
        let config = serde_json::from_str::<Value>(raw).ok()?;
        config
            .get("hooks")
            .and_then(|h| h.get("enabled"))
            .cloned()
            .or(Some(Value::Null))
    }

    fn managed_count(&self, raw: &str) -> usize {
        let Ok(config) = serde_json::from_str::<Value>(raw) else {
            return 0;
        };
        let Some(events) = config
            .get("hooks")
            .and_then(|h| h.get("events"))
            .and_then(Value::as_object)
        else {
            return 0;
        };
        events
            .values()
            .filter_map(Value::as_array)
            .flatten()
            .filter_map(|group| group.get("hooks").and_then(Value::as_array))
            .flatten()
            .filter(|hook| Self::is_ours(hook))
            .count()
    }

    fn events(&self) -> &'static [(&'static str, &'static str)] {
        EVENTS
    }

    fn post_install_hint(&self) -> Option<&'static str> {
        // 方案 §3.6：hook 配置在会话启动时生成快照，所以装完/卸完都要新开会话
        Some("在 ZCode 里新开一个会话才会读到新装的 hook")
    }

    /// 总开关显式关着、而用户自己配过条目 → 打开它等于把他的 hook 也一起启用，
    /// 这句确认要由宿主问、不是我们替他决定
    fn switch_needs_consent(&self, raw: &str) -> Option<usize> {
        if self.switch_before(raw) != Some(json!(false)) {
            return None;
        }
        let mine = user_hook_count(raw);
        (mine > 0).then_some(mine)
    }
}

/// 用户自己的条目数（不含我们的）——「你之前配的 N 条 hook 也会一起生效」里的那个 N。
fn user_hook_count(raw: &str) -> usize {
    let Ok(config) = serde_json::from_str::<Value>(raw) else {
        return 0;
    };
    let Some(events) = config
        .get("hooks")
        .and_then(|h| h.get("events"))
        .and_then(Value::as_object)
    else {
        return 0;
    };
    events
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|group| group.get("hooks").and_then(Value::as_array))
        .flatten()
        .filter(|hook| !ZCodeAdapter::is_ours(hook))
        .count()
}

/// ZCode 接线表里的单例
pub static ZCODE: ZCodeAdapter = ZCodeAdapter;

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(phase: &str) -> String {
        format!("\"C:\\app\\desktop-pet.exe\" {HOOK_MARKER} {phase} {AGENT_FLAG} zcode")
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).expect("产出必须是合法 JSON")
    }

    /// 一条都不少地装 7 个事件，并且别家的键原样留着
    #[test]
    fn installs_seven_events_and_keeps_other_keys() {
        let raw = r#"{"mcpServers":{"fake":{"command":"npx"}},"permissions":{"allow":["Bash"]}}"#;
        let text = ZCodeAdapter.install_in_text(raw, &cmd).unwrap();
        let config = parse(&text);
        assert_eq!(config["mcpServers"]["fake"]["command"], "npx");
        assert_eq!(config["permissions"]["allow"][0], "Bash");
        assert_eq!(config["hooks"]["enabled"], true, "整段要打开才生效");
        assert_eq!(ZCodeAdapter.managed_count(&text), 7);
        assert_eq!(
            config["hooks"]["events"]["PreToolUse"][0]["hooks"][0]["command"],
            "\"C:\\app\\desktop-pet.exe\" --pet-hook pre --agent zcode"
        );
    }

    /// 只用文档里明确列出的三个字段：多写一个 `matcher` 或 `args` 都可能让整段失效
    #[test]
    fn entries_carry_only_type_command_and_timeout_ms() {
        let text = ZCodeAdapter.install_in_text("{}", &cmd).unwrap();
        let entry = &parse(&text)["hooks"]["events"]["Stop"][0]["hooks"][0];
        let keys = entry
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            ["type", "command", "timeoutMs"],
            "字段集合必须恰好是这三个"
        );
        assert_eq!(entry["timeoutMs"], 2000, "ZCode 的超时字段是毫秒");
        // 我们的条目独占一个分组，绝不并进用户已有的那组
        assert_eq!(
            parse(&text)["hooks"]["events"]["Stop"][0]["hooks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    /// 事件表与 phase 白名单必须两头对上：装了 Qoder 才有的事件（如 SessionEnd），
    /// ZCode 根本不会触发，白名单里有它也没用；反过来装了白名单里没有的 phase，
    /// 我们的 hook 分支会把它判成 Rejected 吃掉 —— 症状都是「装了但桌宠不动」。
    #[test]
    fn zcode_event_table_maps_only_whitelisted_phases() {
        let phases = crate::services::agent::phases::PHASES;
        for (event, phase) in ZCodeAdapter.events() {
            assert!(
                phases.contains(phase),
                "{event} 映射到白名单外的 phase {phase}"
            );
        }
        assert_eq!(ZCodeAdapter.events().len(), 7);
    }

    #[test]
    fn reinstall_is_idempotent_and_keeps_user_group() {
        let raw = json!({ "hooks": { "enabled": false, "events": {
            "Stop": [ { "hooks": [ { "type": "command", "command": "keep.sh", "timeoutMs": 3000 } ] } ]
        } } })
        .to_string();
        let once = ZCodeAdapter.install_in_text(&raw, &cmd).unwrap();
        let twice = ZCodeAdapter.install_in_text(&once, &cmd).unwrap();
        let config = parse(&twice);
        assert_eq!(ZCodeAdapter.managed_count(&twice), 7, "重装不越装越多");
        // 用户那一组原样还在，而且没被我们的条目污染
        assert_eq!(
            config["hooks"]["events"]["Stop"][0]["hooks"][0]["command"],
            "keep.sh"
        );
        assert_eq!(
            config["hooks"]["events"]["Stop"].as_array().unwrap().len(),
            2
        );
    }

    /// 卸载：摘自家、留别人，并把被摘空的事件键删掉
    #[test]
    fn uninstall_strips_ours_and_drops_emptied_events() {
        let text = ZCodeAdapter.install_in_text("{}", &cmd).unwrap();
        let (after, removed) = ZCodeAdapter.uninstall_in_text(&text).unwrap().unwrap();
        let config = parse(&after);
        assert_eq!(removed, 7);
        assert_eq!(ZCodeAdapter.managed_count(&after), 0);
        assert!(
            config["hooks"].get("events").is_none(),
            "全摘空之后连 events 这个键都不该留着（空对象与没键同义，留着就是给用户添东西）"
        );
    }

    #[test]
    fn uninstall_keeps_user_events_and_reports_no_change_when_clean() {
        let raw = json!({ "hooks": { "enabled": true, "events": {
            "Stop": [ { "hooks": [ { "type": "command", "command": "keep.sh" } ] } ]
        } } })
        .to_string();
        assert!(
            ZCodeAdapter.uninstall_in_text(&raw).unwrap().is_none(),
            "没有自家条目就不该改这个文件"
        );
        let mixed = ZCodeAdapter.install_in_text(&raw, &cmd).unwrap();
        let (after, removed) = ZCodeAdapter.uninstall_in_text(&mixed).unwrap().unwrap();
        assert_eq!(removed, 7);
        let config = parse(&after);
        assert_eq!(
            config["hooks"]["events"]["Stop"][0]["hooks"][0]["command"],
            "keep.sh"
        );
        assert_eq!(
            config["hooks"]["enabled"], true,
            "卸载不顺手关总开关（那是恢复逻辑的事）"
        );
    }

    /// 别人的 Agent 的条目（同族文件里混进一条 qoder）绝不能被我们摘掉
    #[test]
    fn another_agents_entry_in_the_same_file_survives() {
        let raw = json!({ "hooks": { "events": { "Stop": [ { "hooks": [
            { "type": "command", "command": "\"C:\\app\\desktop-pet.exe\" --pet-hook stop --agent qoder" }
        ] } ] } } })
        .to_string();
        // 只有 `--agent zcode` 的条目才是我们的：这条一个都不该摘，文件原样不动
        assert!(
            ZCodeAdapter.uninstall_in_text(&raw).unwrap().is_none(),
            "别的 Agent 的条目不是我们的"
        );
        // 装的时候也不并进用户那一组；装完再卸，那条 qoder 必须还原样在
        let mixed = ZCodeAdapter.install_in_text(&raw, &cmd).unwrap();
        let (after, removed) = ZCodeAdapter.uninstall_in_text(&mixed).unwrap().unwrap();
        assert_eq!(removed, 7);
        assert!(after.contains("--agent qoder"));
    }

    /// 空文件与坏 JSON 与 `hooks` 段形状不对：三种都得拒，且一字不改
    #[test]
    fn refuses_empty_malformed_and_wrongly_shaped_configs() {
        assert!(
            ZCodeAdapter.install_in_text("", &cmd).is_err(),
            "空文件不凭空造一份"
        );
        assert!(ZCodeAdapter.install_in_text("{ 半截", &cmd).is_err());
        assert!(ZCodeAdapter.install_in_text("[1,2]", &cmd).is_err());
        assert!(ZCodeAdapter
            .install_in_text(r#"{"hooks":[]}"#, &cmd)
            .is_err());
        assert!(ZCodeAdapter.uninstall_in_text(r#"{"hooks":"on"}"#).is_err());
    }

    /// 总开关的三种原值都要能被如实抄下来。注意「没这个键」记的是 `Some(Null)`
    /// （= 原来根本没键，恢复时删掉），与 `Some(false)`（原来显式关着）不同：
    /// 只有解析不出对象才返回 `None`（= 抄不出旧值，那也绝不能去改这个文件）。
    #[test]
    fn switch_before_tells_absent_apart_from_off() {
        assert_eq!(
            ZCODE.switch_before(r#"{"hooks":{"events":{}}}"#),
            Some(Value::Null)
        );
        assert_eq!(
            ZCODE.switch_before(r#"{"theme":"dark"}"#),
            Some(Value::Null)
        );
        assert_eq!(ZCODE.switch_before(r#"{"hooks":{}}"#), Some(Value::Null));
        assert_eq!(
            ZCODE.switch_before(r#"{"hooks":{"enabled":false}}"#),
            Some(json!(false))
        );
        assert_eq!(
            ZCODE.switch_before(r#"{"hooks":{"enabled":true}}"#),
            Some(json!(true))
        );
        assert_eq!(ZCODE.switch_before("{ 半截"), None, "读不出来就抄不出旧值");
    }

    /// `Some(Null)` 也算「不是 true」→ 安装会把它打开 → 状态文件必须记下这份旧值，
    /// 否则卸载时没人知道该删键还是该写 false
    #[test]
    fn install_flips_the_switch_in_all_not_true_cases() {
        for raw in [r#"{"hooks":{}}"#, r#"{"hooks":{"enabled":false}}"#] {
            let before = ZCODE.switch_before(raw);
            assert_ne!(before, Some(json!(true)), "{raw} 装之前不是开着");
            let text = ZCODE.install_in_text(raw, &cmd).unwrap();
            assert_eq!(parse(&text)["hooks"]["enabled"], true, "{raw} 装完必须开着");
            // 恢复用记下来的那份走一遍，回到原样
            let (after, removed) = ZCODE
                .uninstall_restoring_switch(&text, before.as_ref())
                .unwrap()
                .unwrap();
            assert_eq!(removed, 7);
            assert_eq!(parse(&after), parse(raw), "恢复之后与装之前逐字等价");
        }
    }

    /// 恢复：原来有键就写回原值，原来没这个键就删掉（不能给人留一个他从来没写过的键）
    #[test]
    fn restore_switch_writes_back_exactly_what_was_there() {
        let mut config = parse(r#"{"hooks":{"enabled":true,"events":{}}}"#);
        ZCodeAdapter.restore_switch(&mut config, &json!(false));
        assert_eq!(config["hooks"]["enabled"], false);

        let mut config = parse(r#"{"hooks":{"enabled":true,"events":{}}}"#);
        ZCodeAdapter.restore_switch(&mut config, &Value::Null);
        assert!(
            config["hooks"].get("enabled").is_none(),
            "原来根本没这个键，恢复就是把它删掉"
        );
        assert_eq!(config["hooks"]["events"], json!({}), "别的键不动");
    }

    /// `~/.zcode` 不存在 = 没装这个客户端：一个候选都不给
    #[test]
    fn no_candidates_without_the_directory() {
        let _env = super::super::lock_test_env();
        let home = Path::new(r"C:\definitely\not\here\pet-a02-zcode");
        // 这条只在没有 PET_AGENT_HOME 覆盖时成立；有覆盖时读的是覆盖目录
        if std::env::var_os("PET_AGENT_HOME").is_none() {
            assert!(ZCodeAdapter.targets(home).is_empty());
        }
    }

    /// 目录存在时只列**实际存在的那个文件**：config / setting / 两个都在，三种都要对。
    /// 不调环境变量 —— 同时只有一个测试能安全地碰 `PET_AGENT_HOME`（它在 agent_hooks 的
    /// 流水线测试里被覆盖），这条走的是「没有覆盖变量、按 home 推」的默认分支。
    #[test]
    fn lists_whichever_files_exist() {
        let _env = super::super::lock_test_env();
        if std::env::var_os("PET_AGENT_HOME").is_some() {
            // 开发机上手动 export 过这个变量时，home 推出来的路径不算数，直接放弃这条
            return;
        }
        let home = std::env::temp_dir().join(format!("pet-zcode-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let cli = home.join(".zcode").join("cli");
        std::fs::create_dir_all(&cli).unwrap();

        let none = ZCODE.targets(&home);
        assert!(none.is_empty(), "目录都新建了但两个文件都不在 → 不造配置");

        let cfg = cli.join("config.json");
        std::fs::write(&cfg, "{}").unwrap();
        assert_eq!(ZCODE.targets(&home), vec![cfg.clone()]);

        let setting = cli.join("setting.json");
        std::fs::write(&setting, "{}").unwrap();
        let both = ZCODE.targets(&home);
        assert_eq!(both.len(), 2, "运行时迁移过的那份也要一起写");
        assert!(both.contains(&cfg) && both.contains(&setting));

        let _ = std::fs::remove_dir_all(&home);
    }
}
