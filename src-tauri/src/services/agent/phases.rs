use crate::services::agent_hooks::HOOK_MARKER;

/// 单次 hook 事件的 stdin 上限，防止某个工具把整篇 transcript 灌进来
pub(super) const MAX_HOOK_BYTES: u64 = 1 << 20;

/// `--agent` 的参数名（hook 命令串里的来源字段）
pub const AGENT_FLAG: &str = "--agent";

/// **(Qoder 的)** `(Agent 事件名, 我们的 phase)` 安装表，12 条。
///
/// 它**不是** phase 白名单（白名单是 `PHASES`）：各 Agent 的事件集由自己的适配器给出，
/// 而这张表只决定「给 Qoder 装哪些 hook」。往这里加一行等于给 Qoder 多装一条
/// （条目数 12→13），会破「Qoder 迁移到适配器后行为不变」这条硬门槛 —— 依赖该计数的
/// 判据有 `snapshot()` 的 `expectedPerFile` 与 `commands/agent.rs`、`agent_hooks.rs` 的若干断言。
pub const HOOK_PHASES: &[(&str, &str)] = &[
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "user-prompt"),
    ("PreToolUse", "pre"),
    ("PostToolUse", "post"),
    ("PostToolUseFailure", "tool-failure"),
    ("PermissionRequest", "approval-request"),
    ("Notification", "notification"),
    ("SubagentStart", "subagent-start"),
    ("SubagentStop", "subagent-stop"),
    ("StopFailure", "stop-failure"),
    ("Stop", "stop"),
    ("SessionEnd", "session-end"),
];

/// `--pet-hook <phase>` 允许的取值：它同时决定收件目录里的文件名，所以不接受任意字符串。
///
/// 比 `HOOK_PHASES` 多一条 `interrupt` —— Codex 有 Interrupt 事件、Qoder 没有对应事件名，
/// 所以它只进白名单（能收），不进 Qoder 的安装表（不装）。
pub const PHASES: &[&str] = &[
    "session-start",
    "user-prompt",
    "pre",
    "post",
    "tool-failure",
    "approval-request",
    "notification",
    "subagent-start",
    "subagent-stop",
    "stop-failure",
    "stop",
    "session-end",
    "interrupt",
];

/// `--agent` 允许的取值 = 已注册的适配器 id。缺省按 `qoder`：
/// PR-1 及更早装好的 hook 条目不带这个参数，重装之前它们都来自 Qoder。
///
/// `dsh` 是第五个：它没有 hook 条目（桥是 DSH 侧插件），这个取值来自桥写的收件行
/// （`integrations/dsh-bridge/mapping.js` 的 `agent: "dsh"`），来源过滤靠它区分两边。
pub const AGENT_IDS: &[&str] = &["qoder", "zcode", "codex", "workbuddy", "dsh"];

pub const DEFAULT_AGENT: &str = "qoder";

/// 一次 hook 调用解析出的结果，两个字段都已过各自的白名单。
#[derive(Debug, PartialEq, Eq)]
pub struct HookCommand {
    pub phase: &'static str,
    pub agent: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HookArgs {
    /// 一条合法的 hook 调用
    Event(HookCommand),
    /// 命令行里有 `--pet-hook`，但 phase 或 agent 不合法。**这次调用必须被吃掉**：
    /// 既不能采集，也不能掉回完整启动流程 —— 后者会让一次坏 hook 把 GUI 拉起来。
    Rejected(&'static str),
    /// 不是给我们的（没有 `--pet-hook`），照原计划继续启动
    NotForUs,
}

/// 从命令行里取出 `--pet-hook <phase> [--agent <id>]`。
///
/// 名字沿用旧的 `hook_phase_from_args`：返回值现在多了来源 agent，但 `services/agent/mod.rs`
/// 那行 `pub use` 不在本次获批范围内（云端 PM 2026-10-18 的 fix 就是这条），改名会同时招来
/// unused import 与 dead_code 两条 clippy 错误。调用方一律走 `crate::services::agent::` 那条重导出。
pub fn hook_phase_from_args<I: Iterator<Item = String>>(args: &mut I) -> HookArgs {
    loop {
        let Some(arg) = args.next() else {
            return HookArgs::NotForUs;
        };
        if arg != HOOK_MARKER {
            continue;
        }
        let Some(raw_phase) = args.next() else {
            return HookArgs::Rejected("缺少 phase");
        };
        let Some(phase) = PHASES.iter().find(|p| **p == raw_phase.as_str()).copied() else {
            return HookArgs::Rejected("未知 phase");
        };
        let mut agent = DEFAULT_AGENT;
        if args.next().as_deref() == Some(AGENT_FLAG) {
            let Some(raw_agent) = args.next() else {
                return HookArgs::Rejected("--agent 缺值");
            };
            let Some(known) = AGENT_IDS
                .iter()
                .find(|a| **a == raw_agent.as_str())
                .copied()
            else {
                return HookArgs::Rejected("未知 agent");
            };
            agent = known;
        }
        return HookArgs::Event(HookCommand { phase, agent });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    fn parse(items: &[&str]) -> HookArgs {
        hook_phase_from_args(&mut argv(items).into_iter())
    }

    #[test]
    fn interrupt_is_a_phase_but_not_a_qoder_hook() {
        // 白名单收了它，Qoder 的安装表没收 —— 这条不成立就等于给 Qoder 多装了一条 hook
        assert!(PHASES.contains(&"interrupt"), "interrupt 必须能收");
        assert_eq!(
            HOOK_PHASES.len(),
            12,
            "Qoder 事件表必须还是 12 条（条目数一变，snapshot 的 expectedPerFile 与多条既有断言就漂了）"
        );
        assert!(
            !HOOK_PHASES.iter().any(|(_, phase)| *phase == "interrupt"),
            "interrupt 不许混进 Qoder 的安装表"
        );
        assert_eq!(
            parse(&[
                "desktop-pet.exe",
                "--pet-hook",
                "interrupt",
                "--agent",
                "codex"
            ]),
            HookArgs::Event(HookCommand {
                phase: "interrupt",
                agent: "codex"
            })
        );
    }

    #[test]
    fn every_writable_phase_parses_and_the_whitelist_covers_the_qoder_table() {
        for &(event, phase) in HOOK_PHASES {
            assert!(
                PHASES.contains(&phase),
                "Qoder 事件 {event} 的 phase {phase} 不在白名单里，装上去也收不了"
            );
            assert_eq!(
                parse(&["x", "--pet-hook", phase, "--agent", "qoder"]),
                HookArgs::Event(HookCommand {
                    phase,
                    agent: "qoder"
                })
            );
        }
    }

    #[test]
    fn missing_agent_defaults_to_qoder_so_pr1_entries_keep_working() {
        assert_eq!(
            parse(&["desktop-pet.exe", "--pet-hook", "pre"]),
            HookArgs::Event(HookCommand {
                phase: "pre",
                agent: "qoder"
            }),
            "PR-1 装好的条目不带 --agent，必须照旧能用"
        );
    }

    #[test]
    fn unknown_agent_is_rejected_not_silently_qoder() {
        assert_eq!(
            parse(&["x", "--pet-hook", "pre", "--agent", "cursor"]),
            HookArgs::Rejected("未知 agent"),
            "不认识的值只能算未知：悄悄按 qoder 处理会让来源过滤失效"
        );
        // dsh 现在是已知值（桥写的收件行带 `agent: "dsh"`），不能再拿它当反例
        assert_eq!(
            parse(&["x", "--pet-hook", "pre", "--agent", "dsh"]),
            HookArgs::Event(HookCommand {
                phase: "pre",
                agent: "dsh"
            })
        );
        assert_eq!(
            parse(&["x", "--pet-hook", "pre", "--agent"]),
            HookArgs::Rejected("--agent 缺值")
        );
    }

    #[test]
    fn bad_phase_is_rejected_and_the_missing_one_too() {
        assert_eq!(
            parse(&["x", "--pet-hook", "../../escape"]),
            HookArgs::Rejected("未知 phase"),
            "phase 会被拼成文件名，白名单外一律不进采集分支"
        );
        assert_eq!(
            parse(&["x", "--pet-hook"]),
            HookArgs::Rejected("缺少 phase")
        );
    }

    #[test]
    fn nothing_at_all_is_not_for_us_so_startup_continues() {
        assert_eq!(
            parse(&["desktop-pet.exe", "--", "something"]),
            HookArgs::NotForUs,
            "不带 --pet-hook 的正常启动不能被吃掉"
        );
        // 但「带 --pet-hook 又不合法」绝不能是 NotForUs —— 那是 GUI 被拉起来的入口
        for bad in [
            vec!["x", "--pet-hook"],
            vec!["x", "--pet-hook", "nope"],
            vec!["x", "--pet-hook", "pre", "--agent", "nope"],
        ] {
            assert!(
                matches!(parse(&bad), HookArgs::Rejected(_)),
                "{bad:?} 必须是 Rejected，不能掉回启动分支"
            );
        }
    }

    #[test]
    fn the_reexported_name_is_what_lib_rs_actually_calls() {
        // 走 mod.rs 的重导出，而不是 phases:: 全路径 —— 这正是 lib.rs 的调用形状。
        // 「没有 --pet-hook」必须是 NotForUs（启动流程要继续），非法来源必须是 Rejected（不能采集）。
        use crate::services::agent::hook_phase_from_args as via_mod;
        assert_eq!(
            via_mod(&mut argv(&["x", "--pet-hook", "post", "--agent", "zcode"]).into_iter()),
            HookArgs::Event(HookCommand {
                phase: "post",
                agent: "zcode"
            })
        );
        assert_eq!(
            via_mod(&mut argv(&["x", "--pet-hook", "post", "--agent", "bogus"]).into_iter()),
            HookArgs::Rejected("未知 agent")
        );
        assert_eq!(
            via_mod(&mut argv(&["x"]).into_iter()),
            HookArgs::NotForUs,
            "普通启动的参数不能被当成 hook 调用"
        );
    }
}
