//! Codex 适配器：`~/.codex/hooks.json`，与 Qoder **完全同构**的 Claude 风格 JSON。
//!
//! 形状是方案 §3A 的实测口径：`hooks.<Event>[].hooks[] = { type: "command", command, timeout }`，
//! `timeout` 的单位是秒。所以这里只需要给一张事件表和一个实例，读写逻辑全部复用
//! [`claude_style::ClaudeStyleJson`] —— 三家共用一份摘除/追加代码，才不会各写一遍各错一遍。
//!
//! 两件与 Qoder 不同的事实，都落在实例参数上而不是新代码里：
//! * **目录在就建文件**：Codex 装完后不一定有 `hooks.json`，方案 §3A 要求「`~/.codex` 在就新建」。
//!   `targets()` 判的是**目录**存在，文件不存在时读侧按空对象处理，所以这条不需要额外分支。
//! * **信任**：非托管 hook 要在 Codex 里运行 `/hooks` 审核并信任一次，信任记录绑在 hook 定义的哈希上。
//!   这句话只能由宿主显示（`post_install_hint`），界面里不许再写一份。
//!
//! `config.toml` 我们**不读也不写**（云端 PM 在 A03 立项时定的边界）：方案 §3A 原本想读它来提示
//! 「内联 `[hooks]` 会与 `hooks.json` 并存告警」和「`[features] hooks = false`」，改成把这两条写进
//! ADR-0002 的残余风险 —— 代价是本该由宿主说出的两句提示，现在只在文档里。

use crate::services::agent::adapters::claude_style::ClaudeStyleJson;

/// **(Codex 事件, phase)** 安装表，10 条。
///
/// 与 Qoder 的差集是两处：Codex **没有** `PostToolUseFailure`（Bash 非零退出走 `PostToolUse`），
/// 也没有 `SubagentStart` 之外……不，它有 Subagent；它多出来的是 `Interrupt`（→ `idle`）。
/// `PreCompact` / `PostCompact` 不挂：压缩与桌宠状态无关（方案 §3A）。
/// phase 全部落在 `phases::PHASES` 白名单里，`interrupt` 是 A02 第一段加的那条。
pub static CODEX_EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "user-prompt"),
    ("PreToolUse", "pre"),
    ("PermissionRequest", "approval-request"),
    ("PostToolUse", "post"),
    ("SubagentStart", "subagent-start"),
    ("SubagentStop", "subagent-stop"),
    ("Stop", "stop"),
    ("SessionEnd", "session-end"),
    ("Interrupt", "interrupt"),
];

/// Codex：一个目录一个文件，10 条事件，`timeout` 按秒，没有总开关。
pub static CODEX: ClaudeStyleJson = ClaudeStyleJson {
    id: "codex",
    display_name: "Codex",
    dirs: &[".codex"],
    file: "hooks.json",
    events: CODEX_EVENTS,
    timeout_key: "timeout",
    // 与 Qoder 分开的覆盖变量：共用一个变量的话，测试里给 Qoder 设的那份清单会变成 Codex 的目标文件
    paths_env: "PET_AGENT_CODEX_FILES",
    hint: Some("到 Codex 里运行 /hooks，审核并信任 desktop-pet 的条目；没信任之前桌宠不会动"),
    matcher_events: &[],
    disable_switch_key: None,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::adapters::AgentAdapter;
    use crate::services::agent::phases::PHASES;
    use crate::services::agent_hooks::HOOK_MARKER;
    use serde_json::Value;

    fn cmd(phase: &str) -> String {
        format!("C:\\app\\desktop-pet.exe {HOOK_MARKER} {phase} --agent codex")
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).expect("应当是合法 JSON")
    }

    #[test]
    fn codex_installs_the_plan_event_table_and_every_phase_is_whitelisted() {
        assert_eq!(
            CODEX.events().len(),
            10,
            "Codex 的事件表是方案 §3A 那张，10 条"
        );
        for (event, phase) in CODEX.events() {
            assert!(
                PHASES.contains(phase),
                "{event} 映射到 {phase}，但 phase 不在白名单里 → 收了也进不了收件目录"
            );
            assert_ne!(
                event, &"PostToolUseFailure",
                "Codex 没有这个事件：Bash 非零退出走 PostToolUse"
            );
        }
        assert!(
            CODEX.events().iter().any(|(e, _)| *e == "Interrupt"),
            "Interrupt 是 Codex 比 Qoder 多出来的那条"
        );
    }

    #[test]
    fn timeout_is_the_second_unit_key_not_timeout_ms() {
        let text = CODEX.install_in_text("{} ", &cmd).expect("空对象应当能装");
        let config = parse(&text);
        let hook = &config["hooks"]["PreToolUse"][0]["hooks"][0];
        assert!(
            hook.get("timeout").is_some(),
            "Codex 用 `timeout`（秒），不是 ZCode 的 `timeoutMs`：{}",
            hook
        );
        assert!(
            hook.get("timeoutMs").is_none(),
            "写错键名的话 Codex 只会用默认超时"
        );
        assert_eq!(hook["type"], "command");
        assert_eq!(hook["matcher"], Value::Null, "与 Qoder 同构：不写 matcher");
    }

    #[test]
    fn command_carries_the_codex_source_flag() {
        let text = CODEX.install_in_text("{}", &cmd).expect("能装");
        assert!(
            text.contains("--agent codex"),
            "命令串要带来源，否则事件进不了 Codex 的过滤分支"
        );
    }

    #[test]
    fn installs_into_a_missing_file_inside_an_existing_directory() {
        // 这是 Codex 与 Qoder 的真实差异：装了 Codex 但从来没配过 hook → 目录在、文件不在。
        // 读侧把「没有文件」当空对象，所以这里必须能装出 10 条，而不是拒绝。
        let text = CODEX
            .install_in_text("", &cmd)
            .expect("文件不存在 = 空配置，应当能建出来");
        let config = parse(&text);
        assert_eq!(CODEX.managed_count(&text), 10, "十条事件都该挂上");
        assert_eq!(config["hooks"].as_object().unwrap().len(), 10);
    }

    #[test]
    fn keeps_user_hooks_and_other_top_level_keys() {
        let before = r#"{
  "model": "gpt-5",
  "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "notify.sh", "timeout": 5 } ] } ] }
}"#;
        let text = CODEX.install_in_text(before, &cmd).expect("能装");
        let config = parse(&text);
        assert_eq!(config["model"], "gpt-5", "别的键原样留着");
        let groups = config["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(groups.len(), 2, "用户那一组不能被我们摘掉");
        assert!(
            groups.iter().any(|g| g["matcher"] == "Bash"),
            "用户的 matcher 分组必须还在：{groups:?}"
        );
        assert_eq!(CODEX.managed_count(&text), 10);

        let after = CODEX
            .uninstall_in_text(&text)
            .expect("能卸")
            .expect("有东西可卸");
        assert_eq!(after.1, 10, "只摘我们那些");
        let cleaned = parse(&after.0);
        assert_eq!(cleaned["model"], "gpt-5");
        let kept = cleaned["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(kept.len(), 1, "摘完只剩用户那一组");
        assert_eq!(kept[0]["matcher"], "Bash");
    }

    #[test]
    fn refuses_a_malformed_file_instead_of_overwriting_it() {
        let broken = "{ \"hooks\": ";
        let err = CODEX
            .install_in_text(broken, &cmd)
            .expect_err("坏文件不许被覆盖");
        assert!(err.contains("不是合法 JSON"), "要说清为什么拒：{err}");
    }

    #[test]
    fn reinstall_is_idempotent() {
        let once = CODEX.install_in_text("{}", &cmd).unwrap();
        let twice = CODEX.install_in_text(&once, &cmd).unwrap();
        assert_eq!(CODEX.managed_count(&twice), 10, "重装不能越装越多");
        assert_eq!(once, twice);
    }

    #[test]
    fn hint_points_at_the_trust_step() {
        let hint = CODEX
            .post_install_hint()
            .expect("Codex 装完必须让用户做一件事");
        assert!(hint.contains("/hooks"), "信任入口是 /hooks：{hint}");
    }
}
