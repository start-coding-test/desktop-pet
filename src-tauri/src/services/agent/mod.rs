//! Agent hook 收件与状态归一化。
//!
//! 数据通路：编码 Agent 的 hook → 本 exe 的 `--pet-hook <phase>` 分支（只读写一个文件就退出）
//! → `agent/inbox/<phase>.jsonl` → 本模块的 watcher 读增量 → 归一化成会话状态 → 宿主总线 topic。
//!
//! 为什么不走网络：本项目本身就是桌面宠物，再装一个宠物来采事件是多余的；而开本地端口
//! 要管 token、端口占用与防火墙。落盘一行 JSONL 就够了，双方都不需要长连接。
//! 为什么不写死 identifier：hook 分支在建窗之前就返回了，拿不到 AppHandle，
//! 于是从编译期内嵌的 tauri.conf.json 读，保持单一来源。

pub mod adapters;
pub mod backups;
pub mod dsh_bridge;
pub mod inbox;
pub mod linkage;
pub mod phases;
pub mod state;
pub mod watcher;

pub use self::inbox::hook_ingest;
// inbox_dir 与 AgentWatcher 原本可从 crate::services::agent::<名> 取到（模块内其他文件
// 直接走子模块路径），保留这两条路径兼容；单 lib 构建下无引用，故显式放宽该 lint。
#[allow(unused_imports)]
pub use self::inbox::inbox_dir;
pub use self::phases::{hook_phase_from_args, HOOK_PHASES};
pub use self::state::AgentState;
#[allow(unused_imports)]
pub use self::state::AgentWatcher;
pub use self::watcher::{spawn_agent_watcher, start_agent_ticker};

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
#[path = "grace_tests.rs"]
mod grace_tests;
