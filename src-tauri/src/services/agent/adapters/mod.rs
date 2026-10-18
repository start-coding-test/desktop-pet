//! Agent 适配器：把「某个客户端的 hook 配置长什么样」收进一处，宿主其余部分只认这个接口。
//!
//! 需要它是因为四家客户端在三个维度上都不一样：
//!   * 配置文件在哪（目录、文件名、有没有环境覆盖入口）；
//!   * `hooks` 那一段的形状（嵌套层级、超时字段叫什么、有没有总开关）；
//!   * 装完之后还要用户做什么才生效（新开会话 / 去 /hooks 信任 / 彻底重启）。
//!
//! 启停联动、来源过滤、卸载前清理这些编排不该跟着这些差异一起分叉，所以它们只调本模块。
//!
//! 生命周期口径：**每次装卸都重新问 `targets()`，不缓存**。客户端可能是装上又卸掉的，
//! 缓存住一份 home 根目录的探测结果就会往已经不存在的目录里写配置。

pub mod claude_style;
pub mod codex;
pub mod workbuddy;
pub mod zcode;

use std::path::{Path, PathBuf};

use serde_json::Value;

/// 一种 Agent 的 hook 接入方式。实现者负责读写配置文件里的文本，
/// **不碰磁盘** —— 读原文、备份、原子替换都住在 `services/agent_hooks.rs`。
pub trait AgentAdapter: Sync {
    /// `--agent` 的取值，也是 `agent-linkage.json` 里 `agent` 字段的取值
    fn id(&self) -> &'static str;

    /// 给用户看的名字（设置页与错误文案用它，别再手写「Qoder」）
    fn display_name(&self) -> &'static str;

    /// 「没找到 X 的配置目录（…）」括号里那份路径提示，相对 home 的目录名。
    /// 只为文案存在：接口形状（方案 §2）里没有这一项，加的是**带默认实现**的方法，
    /// 所以两家适配器各答一句、调用方不必按 id 分派。
    fn dir_hint(&self) -> &'static [&'static str] {
        &[]
    }

    /// 候选配置文件：所在目录不存在就不算装了这个客户端，绝不凭空造配置
    fn targets(&self, home: &Path) -> Vec<PathBuf>;

    /// 装：解析 → 拒绝坏结构 → 摘自家旧条目 → 追加自家条目。返回新文本。
    /// `cmd` 由调用方给（命令串里带哪个 `--agent` 是宿主的口径，不是客户端的形状）
    fn install_in_text(&self, raw: &str, cmd: &dyn Fn(&str) -> String) -> Result<String, String>;

    /// 卸：没有自家条目时返回 `None`，表示「这个文件不必改动」
    fn uninstall_in_text(&self, raw: &str) -> Result<Option<(String, usize)>, String>;

    /// 卸载时顺带把「装之前抄下来的总开关旧值」恢复回去。`before = None` 表示这个文件的
    /// 开关当初没被我们动过（或这个客户端压根没有开关），默认实现就是原样卸载。
    /// ZCode 的 `hooks.enabled` 走这条 —— 方案 §3.4：「如果当初是我们把它打开的，就恢复原值」，
    /// 插件停用自动卸载与卸载应用清理都算「卸载」。
    fn uninstall_restoring_switch(
        &self,
        raw: &str,
        before: Option<&Value>,
    ) -> Result<Option<(String, usize)>, String> {
        let _ = before;
        self.uninstall_in_text(raw)
    }

    /// 这个客户端有没有「一个开关关掉整段 hooks」的总开关。默认没有（Qoder）。
    fn has_switch(&self) -> bool {
        false
    }

    /// 装之前总开关的原值（`None` = 原文没这个键）。配合 `has_switch` 用：
    /// 安装流水线在动手之前抄下它，才谈得上卸载时如实恢复。
    fn switch_before(&self, _raw: &str) -> Option<Value> {
        None
    }

    /// 这份文本里自家条目有几条
    fn managed_count(&self, raw: &str) -> usize;

    /// **(事件名, phase)** 安装表。各家的事件词表不同，所以由适配器给出；
    /// phase 本身还得过 `phases::PHASES` 白名单，两处一致才收得到。
    fn events(&self) -> &'static [(&'static str, &'static str)];

    /// 装完之后要用户做的事（新开会话 / 去 /hooks 信任 / 彻底重启）。`None` = 什么都不用做。
    /// 设置页原文显示这一句，别在界面里另写一份 —— 生效时机是客户端的事实，不是文案。
    fn post_install_hint(&self) -> Option<&'static str>;

    /// 「装这个客户端之前得先跟用户确认」的情况：返回 `Some(N)` 表示它的总开关现在是**显式关着**的，
    /// 而打开会连带把用户自己配的 `N` 条 hook 一起启用。`None` = 不需要确认。
    /// 判的是**单个文件的原文** —— 适配器不碰磁盘，读文件由 `agent_hooks::pending_consent` 负责。
    ///
    /// 「没有 `enabled` 这个键」不进这里：方案 §3.4 的确认框说的是「总开关现在是关的」，
    /// 键不存在时那句文案就不成立，而这种文件里用户的条目本来也没被关着（照 §3.4 直接打开即可）。
    fn switch_needs_consent(&self, _raw: &str) -> Option<usize> {
        None
    }

    /// 「要用户拍板」时说的那句话（**不带** `[need-confirm]` 前缀，前缀由 `linkage::confirm_prompt` 加，
    /// 那个前缀是界面判「这是确认还是失败」的机器可读契约）。
    ///
    /// 默认讲的是 ZCode 那种开关：显式关着，打开会连带把用户自己配的 N 条一起启用，而且**是我们将要去打开它**。
    /// 开关语义相反的家必须自己说一句：WorkBuddy 的 `disableAllHooks` 我们**不替用户改**，
    /// 照默认措辞显示就是在骗人 —— 用户以为点一下就会打开，实际那个键一动不动，装完还是不触发。
    fn consent_prompt(&self, user_hooks: usize) -> String {
        format!(
            "{} 的 hook 总开关现在是关的，打开以后你之前配的 {} 条 hook 也会一起生效。确认请再点一次。",
            self.display_name(),
            user_hooks
        )
    }

    /// 装完之后宿主能自己去读的日志（方案 §3.5 的「装后自检」）。`None` = 这一家没有可查的日志。
    ///
    /// 为什么它是接口的一部分而不是 `agent_hooks` 里的一句 `if id == zcode`：接线第三家时，
    /// 那句硬编码会**静默**沿用 ZCode 的日志路径 —— 症状是新那家的自检永远报「没找到日志」，
    /// 而读代码的人以为它压根没做自检。路径、文件名形状和「什么算坏行」都只有适配器知道。
    fn log_watch(&self, _home: &Path) -> Option<LogWatch> {
        None
    }

    /// 在「安装之后新写入的那些行」里找第一条能归责到我们头上的行；`Some(原文)` = 查出问题。
    /// 只有实现了 `log_watch` 的适配器会被调到（调用方先看 `log_watch` 是不是 `None`）。
    fn scan_log_tail(&self, _new_text: &str, _our_command: &str) -> Option<String> {
        None
    }
}

/// 装后自检要盯的那份日志：哪个目录、文件名什么形状。
/// 前缀后缀带着走是因为日期格式是我们不确定的事实（ZCode 是 `zcode-<日期>.jsonl`），
/// 所以调用方按 mtime 挑最新的一份，而不是自己拼一个可能拼错的文件名。
pub struct LogWatch {
    pub dir: PathBuf,
    pub prefix: &'static str,
    pub suffix: &'static str,
}

/// 已经接线的适配器。装卸、状态、卸载前清理都按这张表走 ——
/// 没在这里出现的 id 就算过了 `--agent` 的白名单（那是命令行校验用的），宿主也不动配置文件。
static WIRED: &[&dyn AgentAdapter] = &[
    &claude_style::QODER,
    &zcode::ZCODE,
    &codex::CODEX,
    &workbuddy::WORKBUDDY,
];

pub fn wired() -> &'static [&'static dyn AgentAdapter] {
    WIRED
}

/// 已接线的适配器里找这个 id；未知值与还没接线的槽位都返回 `None`。
pub fn by_id(id: &str) -> Option<&'static dyn AgentAdapter> {
    WIRED.iter().copied().find(|a| a.id() == id)
}

/// 这个 id 现在能不能真的装卸。`decide()` 用它把「用户选了谁」和「我们接了谁」分开。
pub fn is_wired(id: &str) -> bool {
    by_id(id).is_some()
}

/// 设置页的一个槽位
#[derive(serde::Serialize)]
pub struct Choice {
    pub id: &'static str,
    pub display_name: &'static str,
    /// `false` = 命令行认得但宿主还没接（PR-3 的 codex / workbuddy），界面按禁选渲染
    pub wired: bool,
    pub hint: Option<&'static str>,
}

/// 设置页四选一的清单：**`--agent` 白名单里的四个都列**，而不是只列已接线的。
/// 只列两个的话，用户配置里残留的 `--agent codex` 条目在界面上「没有对应的选项」，
/// 看起来就是宿主坏了；列出来并标成未接线，才是事实。
pub fn choices() -> Vec<Choice> {
    crate::services::agent::phases::AGENT_IDS
        .iter()
        .copied()
        .map(|id| match by_id(id) {
            Some(adapter) => Choice {
                id,
                display_name: adapter.display_name(),
                wired: true,
                hint: adapter.post_install_hint(),
            },
            None => Choice {
                id,
                display_name: label(id),
                wired: false,
                hint: None,
            },
        })
        .collect()
}

/// 还没接线那两家的显示名；接线之后会被适配器自己的 `display_name()` 顶掉。
fn label(id: &'static str) -> &'static str {
    match id {
        "codex" => "Codex",
        "workbuddy" => "WorkBuddy",
        other => other,
    }
}

#[cfg(test)]
pub static TEST_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 会读或写 `PET_AGENT_CONFIG_FILES` / `PET_AGENT_HOME` 的用例共用的串行锁（`TEST_ENV`）。
/// 环境变量是进程级的，`cargo test` 默认多线程：不锁就是「A 测试设的变量改了 B 测试里
/// `targets()` 的结果」这种随机红。锁中毒时照旧用 —— 持锁的测试 panic 了，下一个测试
/// 不该因此永远跑不起来。
#[cfg(test)]
pub(crate) fn lock_test_env() -> std::sync::MutexGuard<'static, ()> {
    TEST_ENV.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// id 唯一且与 `--agent` 白名单对得上：白名单里有、注册表里没有 = 接线在后续 PR，
    /// 那是**已知但未接线**，不是拼写错误。这个区别 `decide` 依赖，所以钉住。
    #[test]
    fn wired_ids_are_a_subset_of_the_cli_whitelist_and_unique() {
        let mut ids: Vec<&str> = wired().iter().map(|a| a.id()).collect();
        for id in &ids {
            assert!(
                crate::services::agent::phases::AGENT_IDS.contains(id),
                "{id} 不在 --agent 白名单里，装好的条目会被自己的解析器拒掉"
            );
        }
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(
            ids.len(),
            before,
            "两个适配器共用一个 id 会让 by_id 只认第一个"
        );
    }

    /// 还没接线的槽位与拼错的值都拿不到适配器：`decide` 靠这个区分「用户选了个我们没接的
    /// 客户端」和「这值本来就是脏的」，两者都不许装。
    #[test]
    fn unknown_ids_are_never_wired() {
        assert!(is_wired("qoder"), "Qoder 是唯一从 PR-1 就接线的");
        assert!(!is_wired(""));
        assert!(!is_wired("nope"));
        assert!(!is_wired("Qoder"), "id 是大小写敏感的，别拿显示名当 id");
    }

    /// 适配器装的事件必须能被自己的解析器收回来：安装表里的 phase 不在 `PHASES`
    /// 白名单里 = 我们给用户装了一条 hook，Qoder 真触发时却走 `Rejected` 分支被吃掉，
    /// 症状是「装了但桌宠完全没反应」，而且离线门禁一条都不会红。
    #[test]
    fn every_wired_adapter_installs_only_whitelisted_phases() {
        for adapter in wired() {
            for (event, phase) in adapter.events() {
                assert!(
                    crate::services::agent::phases::PHASES.contains(phase),
                    "{} 要装的事件 {event} 映射到 phase {phase}，但它不在 --pet-hook 白名单里",
                    adapter.id()
                );
            }
        }
    }
}
