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

use std::path::{Path, PathBuf};

/// 一种 Agent 的 hook 接入方式。实现者负责读写配置文件里的文本，
/// **不碰磁盘** —— 读原文、备份、原子替换都住在 `services/agent_hooks.rs`。
pub trait AgentAdapter: Sync {
    /// `--agent` 的取值，也是 `agent-linkage.json` 里 `agent` 字段的取值
    fn id(&self) -> &'static str;

    /// 给用户看的名字（设置页与错误文案用它，别再手写「Qoder」）
    fn display_name(&self) -> &'static str;

    /// 候选配置文件：所在目录不存在就不算装了这个客户端，绝不凭空造配置
    fn targets(&self, home: &Path) -> Vec<PathBuf>;

    /// 装：解析 → 拒绝坏结构 → 摘自家旧条目 → 追加自家条目。返回新文本。
    /// `cmd` 由调用方给（命令串里带哪个 `--agent` 是宿主的口径，不是客户端的形状）
    fn install_in_text(&self, raw: &str, cmd: &dyn Fn(&str) -> String) -> Result<String, String>;

    /// 卸：没有自家条目时返回 `None`，表示「这个文件不必改动」
    fn uninstall_in_text(&self, raw: &str) -> Result<Option<(String, usize)>, String>;

    /// 这份文本里自家条目有几条
    fn managed_count(&self, raw: &str) -> usize;

    /// **(事件名, phase)** 安装表。各家的事件词表不同，所以由适配器给出；
    /// phase 本身还得过 `phases::PHASES` 白名单，两处一致才收得到。
    fn events(&self) -> &'static [(&'static str, &'static str)];
    // 方案 §2 还列了 `post_install_hint()`（装完要用户做什么：新开会话 / 去 /hooks 信任 /
    // 彻底重启）。它的第一批读者是 A02-4 的设置页四选一，那一段一起加，
    // 不留一个只有实现、没人调的 trait 方法。
}

/// 已经接线的适配器。装卸、状态、卸载前清理都按这张表走 ——
/// 没在这里出现的 id 就算过了 `--agent` 的白名单（那是命令行校验用的），宿主也不动配置文件。
static WIRED: &[&dyn AgentAdapter] = &[&claude_style::QODER];

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
