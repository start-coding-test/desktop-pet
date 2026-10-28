//! DSH（DeepSeek Harness）适配器：**没有可安装的 hook 配置文件**。
//!
//! 其余四家客户端的扩展面都是「往某个配置文件里塞一条命令」，DSH 不是：它的插件是进程内的
//! cordis 插件，配置由中国开发者工作台自己的 profile 组合（`cordis.patch.yml` + 各 bundle 的
//! patch）。往那儿写行不是「装 hook」，是替 DSH 做包管理 —— DSH 文档明确要求这些改动由它自己的
//! `plugin_manager install_bundle` 完成，手写会被它下一次迁移覆盖。
//!
//! 所以这里的桥长在 DSH 里面：`integrations/dsh-bridge/` 是一个 cordis 插件，它把会话事件折成
//! 桌宠收件行（格式与四家 hook 完全相同）。宠物侧只做两件事：
//!
//! * `installs_files()` 返回 **false**：`switch_agent` / `agent_hooks_install` 走「不写文件」分支；
//! * 桥装没装由 `services::agent::dsh_bridge::detect` 读 profile 的 bundles 清单判断。
//!
//! `install_in_text` 仍然实现，因为 trait 要求；它的唯一职责是把话说清楚，而不是返回一个
//! 「装好了」的假象 —— 假成功会让设置页显示「已安装」，而桌宠永远收不到事件。

use crate::services::agent::adapters::{AgentAdapter, LogWatch};
use std::path::{Path, PathBuf};

/// DSH 的桥插件包名（`integrations/dsh-bridge/package.json` 的 `name`）。
pub const BRIDGE_PACKAGE: &str = "dsh-pet-agent-bridge";

/// 安装指引：桥不归宠物装，但用户得知道去哪儿装、装哪个目录。
pub const BRIDGE_HINT: &str = "DSH 的桥是插件，不是 hook 文件：在 DSH 里用 plugin_manager 的 install_bundle 装一次 integrations/dsh-bridge，装完桌宠才会动";

pub struct Dsh;

impl AgentAdapter for Dsh {
    fn id(&self) -> &'static str {
        "dsh"
    }

    fn display_name(&self) -> &'static str {
        "DSH"
    }

    fn dir_hint(&self) -> &'static [&'static str] {
        // 只用于「找不到配置目录」那条文案；DSH 这条分支不会走到，但目录名是真的。
        &[".dsh"]
    }

    fn targets(&self, _home: &Path) -> Vec<PathBuf> {
        Vec::new()
    }

    fn installs_files(&self) -> bool {
        false
    }

    fn install_in_text(&self, _raw: &str, _cmd: &dyn Fn(&str) -> String) -> Result<String, String> {
        Err(format!("DSH 没有可安装的 hook 配置文件；{BRIDGE_HINT}"))
    }

    fn uninstall_in_text(&self, _raw: &str) -> Result<Option<(String, usize)>, String> {
        // 没有文件可写 = 没有条目可摘。桥的摘下由用户在 DSH 里卸载 bundle 完成。
        Ok(None)
    }

    fn managed_count(&self, _raw: &str) -> usize {
        0
    }

    fn events(&self) -> &'static [(&'static str, &'static str)] {
        // 事件表是「安装进某个文本的条目」，DSH 一个都没有。真正的映射在桥里
        // （integrations/dsh-bridge/mapping.js），由 tests/unit/unit-dsh-bridge.mjs 钉住。
        &[]
    }

    fn post_install_hint(&self) -> Option<&'static str> {
        Some(BRIDGE_HINT)
    }

    fn log_watch(&self, _home: &Path) -> Option<LogWatch> {
        // 四家里的 log_watch 是「hook 没生效时从客户端日志里捞证据」。
        // DSH 的桥不经日志确认：装没装直接看 profile 的 bundles 清单。
        None
    }
}

pub static DSH: Dsh = Dsh;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::adapters::AgentAdapter;

    fn cmd(phase: &str) -> String {
        format!("C:\\app\\desktop-pet.exe --pet-hook {phase} --agent dsh")
    }

    #[test]
    fn has_no_config_file_to_install() {
        // 这条判据是整条 DSH 分支的地基：一旦有人让它「也去装点文件」，switch_agent 的
        // bridge 分支就不再被走到，界面又会开始显示假成功。
        assert!(!DSH.installs_files());
        assert!(DSH.targets(Path::new("C:\\Users\\x")).is_empty());
        assert!(DSH.events().is_empty(), "DSH 不该有安装表");
        assert_eq!(DSH.managed_count("{}"), 0);
        assert!(!DSH.has_switch());
    }

    #[test]
    fn install_says_why_it_cannot_instead_of_pretending_success() {
        let err = DSH
            .install_in_text("{}", &cmd)
            .expect_err("DSH 没有可写的配置文件");
        assert!(err.contains("没有可安装的 hook 配置文件"), "{err}");
        assert!(
            err.contains("install_bundle"),
            "要给出真正的安装路径：{err}"
        );
    }

    #[test]
    fn uninstall_is_a_no_op_not_an_error() {
        // 切走 DSH 时 switch_agent 会先卸旧的：这里必须干净返回 None，
        // 否则「从 DSH 切到 Codex」会被一条本不该存在的卸载错误拦住。
        assert_eq!(DSH.uninstall_in_text("{}").expect("能卸"), None);
    }

    #[test]
    fn hint_points_at_the_bundle_directory() {
        let hint = DSH.post_install_hint().expect("DSH 要说明怎么装桥");
        assert!(hint.contains("install_bundle"), "{hint}");
        assert!(hint.contains("integrations/dsh-bridge"), "{hint}");
    }

    #[test]
    fn dsh_has_no_log_watch() {
        assert!(DSH.log_watch(Path::new("C:\\Users\\x")).is_none());
        assert!(DSH.scan_log_tail("anything", "--agent dsh").is_none());
    }
}
