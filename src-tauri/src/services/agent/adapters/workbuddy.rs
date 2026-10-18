//! WorkBuddy 适配器：`~/.workbuddy/settings.json` 的 `hooks` 字段，Claude 风格同构。
//!
//! ⚠ 桌面版**没有官方 hook 文档**（方案 §3B）。这里的形状来自同源的 CodeBuddy CLI 官方文档 +
//! 第三方实测（workbuddy-buddy，2026-07），所以设置页要标「实验性」，事件表也**只挂实测会触发的 7 条**
//! —— CodeBuddy 文档里还列了 `PostToolUseFailure`、`SessionEnd` 等，桌面版是否触发没实测过，
//! 先不挂，等真机确认再加。多挂一条的后果不是报错，而是桌宠安静地少收一条，很难查。
//!
//! 两处与 Qoder/Codex 真实不同，都落在实例参数上：
//! * 工具类事件（`PreToolUse` / `PostToolUse`）的**外层分组**要带 `"matcher": ".*"`（实测可用的写法），
//!   其余事件不写 matcher。
//! * 总开关是 **`disableAllHooks`**，语义与 ZCode 的 `hooks.enabled` **相反**（`true` = 全关），
//!   而且**我们不替用户改它**。所以它不进 `switch_before` / 恢复那条路径（`has_switch()` 仍是 false），
//!   只进 `switch_needs_consent`：它是 true 时先问用户，确认后也只写自家条目。
//!   措辞由 `ClaudeStyleJson::consent_prompt` 按这个键分支 —— 照默认那句讲就是在骗人。
//!
//! 另一个坑写在这里而不是代码里：hook 配置在启动时缓存，**关窗口不算退出**，要从托盘彻底退出再重开。
//! 这条由 `post_install_hint` 常驻显示。

use crate::services::agent::adapters::claude_style::ClaudeStyleJson;

/// **(WorkBuddy 事件, phase)** 安装表，7 条（方案 §3B 的「实测会触发的」）。
pub static WORKBUDDY_EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "user-prompt"),
    ("PreToolUse", "pre"),
    ("PostToolUse", "post"),
    ("PermissionRequest", "approval-request"),
    ("Notification", "notification"),
    ("Stop", "stop"),
];

/// 需要在外层分组上写 `"matcher": ".*"` 的事件：只有工具类那两个。
const MATCHER_EVENTS: &[&str] = &["PreToolUse", "PostToolUse"];

/// WorkBuddy：一个目录一个文件，7 条事件，`timeout` 按秒，总开关是反向的 `disableAllHooks`。
pub static WORKBUDDY: ClaudeStyleJson = ClaudeStyleJson {
    id: "workbuddy",
    display_name: "WorkBuddy",
    dirs: &[".workbuddy"],
    file: "settings.json",
    events: WORKBUDDY_EVENTS,
    timeout_key: "timeout",
    paths_env: "PET_AGENT_WORKBUDDY_FILES",
    hint: Some(
        "实验性：WorkBuddy 的 hook 配置在启动时缓存 —— 要彻底退出（关窗口不算，从托盘退出）再重开才会生效",
    ),
    matcher_events: MATCHER_EVENTS,
    disable_switch_key: Some("disableAllHooks"),
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::adapters::AgentAdapter;
    use crate::services::agent::phases::PHASES;
    use crate::services::agent_hooks::HOOK_MARKER;
    use serde_json::Value;

    fn cmd(phase: &str) -> String {
        format!("C:\\app\\desktop-pet.exe {HOOK_MARKER} {phase} --agent workbuddy")
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).expect("应当是合法 JSON")
    }

    #[test]
    fn workbuddy_installs_the_seven_measured_events_with_whitelisted_phases() {
        assert_eq!(WORKBUDDY.events().len(), 7, "只挂实测会触发的那 7 条");
        for (event, phase) in WORKBUDDY.events() {
            assert!(
                PHASES.contains(phase),
                "{event} → {phase} 不在 phase 白名单里"
            );
        }
        assert!(
            !WORKBUDDY.events().iter().any(|(e, _)| *e == "SessionEnd"),
            "桌面版是否触发 SessionEnd 还没实测，不挂"
        );
    }

    #[test]
    fn tool_events_carry_the_matcher_and_others_do_not() {
        let text = WORKBUDDY.install_in_text("{}", &cmd).expect("能装");
        let config = parse(&text);
        for event in ["PreToolUse", "PostToolUse"] {
            let group = &config["hooks"][event][0];
            assert_eq!(
                group["matcher"], ".*",
                "{event} 是工具类事件，实测要写 matcher"
            );
        }
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "Notification",
            "PermissionRequest",
        ] {
            let group = &config["hooks"][event][0];
            assert_eq!(group["matcher"], Value::Null, "{event} 不该带 matcher");
            assert!(group["hooks"].is_array(), "{event} 的条目要在 hooks 数组里");
        }
    }

    #[test]
    fn keeps_other_settings_in_the_same_file() {
        // settings.json 里装的不止 hook：模型、权限、主题都在同一份文件里，写坏一次就是把用户的
        // WorkBuddy 配坏。这一条是「同文件其他键原样保留」的正面判据。
        let before = r#"{
  "theme": "dark",
  "model": "workbuddy-sonnet",
  "permissions": { "allow": ["read"] }
}"#;
        let text = WORKBUDDY.install_in_text(before, &cmd).expect("能装");
        let config = parse(&text);
        assert_eq!(config["theme"], "dark");
        assert_eq!(config["model"], "workbuddy-sonnet");
        assert_eq!(config["permissions"]["allow"][0], "read");
        assert_eq!(WORKBUDDY.managed_count(&text), 7);

        let after = WORKBUDDY
            .uninstall_in_text(&text)
            .expect("能卸")
            .expect("有东西可卸")
            .0;
        let cleaned = parse(&after);
        assert_eq!(cleaned["theme"], "dark", "摘完还要保住这些键");
        assert_eq!(cleaned["model"], "workbuddy-sonnet");
        assert_eq!(
            cleaned["hooks"].as_object().map(|m| m.len()),
            Some(0),
            "事件键摘空要一并删掉"
        );
    }

    #[test]
    fn disabled_hooks_switch_asks_for_consent_without_counting_zero_as_ok() {
        // 条数为 0 也要问：那时用户至少知道「装完为什么不动」。
        let off = r#"{ "disableAllHooks": true }"#;
        assert_eq!(
            WORKBUDDY.switch_needs_consent(off),
            Some(0),
            "整体关着就要问，与用户自己配了几条无关"
        );
        let off_with_user = r#"{
  "disableAllHooks": true,
  "hooks": { "PreToolUse": [ { "matcher": ".*", "hooks": [ { "type": "command", "command": "mine.sh", "timeout": 5 } ] } ] }
}"#;
        assert_eq!(
            WORKBUDDY.switch_needs_consent(off_with_user),
            Some(1),
            "确认的依据是「会连带启用几条用户自己的 hook」"
        );
        // 没这个键 / 显式 false 都不算关着
        assert_eq!(WORKBUDDY.switch_needs_consent("{}"), None);
        assert_eq!(
            WORKBUDDY.switch_needs_consent(r#"{ "disableAllHooks": false }"#),
            None
        );
        // 坏文件不猜
        assert_eq!(WORKBUDDY.switch_needs_consent("{ \"hooks\": "), None);
    }

    #[test]
    fn consent_sentence_does_not_claim_we_will_flip_the_switch() {
        // 默认措辞讲的是 ZCode 那种「由我们去打开」的开关。WorkBuddy 的键语义相反且我们不动它，
        // 照抄就等于对用户撒谎 —— 这条判据钉的是「话说对了」。
        let prompt = WORKBUDDY.consent_prompt(3);
        assert!(
            prompt.contains("不会替你改"),
            "要说清我们不动那个开关：{prompt}"
        );
        assert!(
            prompt.contains("disableAllHooks"),
            "要点名是哪个键：{prompt}"
        );
        assert!(prompt.contains("3 条"), "条数是确认的依据：{prompt}");
        assert!(
            !prompt.contains("打开以后你之前配的"),
            "不能声称由我们去打开：{prompt}"
        );
    }

    #[test]
    fn installing_never_writes_the_disable_switch() {
        // 「不替用户改」的硬证据：装之前是 true，装完还得是 true；装之前没这个键，装完也不能多出这个键。
        let off = r#"{ "disableAllHooks": true }"#;
        let text = WORKBUDDY.install_in_text(off, &cmd).expect("能装");
        assert_eq!(
            parse(&text)["disableAllHooks"],
            Value::Bool(true),
            "不许替用户打开"
        );
        let fresh = WORKBUDDY
            .install_in_text(r#"{ "theme": "dark" }"#, &cmd)
            .expect("能装");
        assert_eq!(
            parse(&fresh)["disableAllHooks"],
            Value::Null,
            "没有这个键就别凭空加：{fresh}"
        );
    }

    #[test]
    fn our_entries_survive_a_user_hook_in_the_same_event() {
        // 同一事件里用户已经有一组：我们追加自己的一组，谁也别顶掉谁
        let before = r#"{
  "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "guard.sh", "timeout": 5 } ] } ] }
}"#;
        let text = WORKBUDDY.install_in_text(before, &cmd).expect("能装");
        let config = parse(&text);
        let groups = config["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(groups.len(), 2, "用户那一组 + 我们那一组");
        assert_eq!(
            WORKBUDDY.managed_count(&text),
            7,
            "自家条目只算带 --pet-hook 的那些（七条事件各一条）"
        );

        let after = WORKBUDDY
            .uninstall_in_text(&text)
            .expect("能卸")
            .expect("有东西可卸")
            .0;
        let cleaned = parse(&after);
        let kept = cleaned["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(kept.len(), 1, "只摘我们自己那组");
        assert_eq!(kept[0]["matcher"], "Bash");
    }

    #[test]
    fn refuses_a_malformed_file_instead_of_overwriting_it() {
        let err = WORKBUDDY
            .install_in_text("not json", &cmd)
            .expect_err("坏文件不许被覆盖");
        assert!(err.contains("不是合法 JSON"), "{err}");
    }

    #[test]
    fn hint_says_full_quit_and_experimental() {
        // 关窗口不算退出：这句必须常驻，否则用户会以为装完了没生效是我们的 bug
        let hint = WORKBUDDY
            .post_install_hint()
            .expect("WorkBuddy 装完要用户做事");
        assert!(hint.contains("退出"), "要说清彻底退出：{hint}");
        assert!(
            hint.contains("实验性"),
            "没有官方文档，界面要标出来：{hint}"
        );
    }
}
