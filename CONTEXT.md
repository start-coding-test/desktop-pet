# 术语表（CONTEXT）

项目内所有文档、卡片与代码注释按这些词说话。改术语要先改这里。

## Agent 联动

- **联动（linkage）** —— 某个编码 Agent 的事件正在驱动桌宠的这一状态。**由宿主持有**
  （`src-tauri/src/services/agent/linkage.rs`），判据是「已启用的插件里有没有任一 manifest
  声明 `agent:hooks`」，不写死插件 id；插件自己不再维持这个状态（它的 `deactivate()` 在崩溃、
  被强杀或卸载时不一定跑得到）。同一时刻**只有一个 Agent 处于联动中**（硬约束，不是偏好）。
- **Agent 适配器（adapter）** —— 宿主侧一个 Agent 的接入定义：配置目录与文件名、事件名集合、
  写入的 hook 条目形状、状态词表映射。已接线五家：`qoder` / `zcode` / `codex` / `workbuddy` 写
  hook 文件；`dsh` 没有 hook 文件可装（`installs_files()` 返回 false），走**桥**形态。
- **hook 条目（hook entry）** —— 写进 Agent 自己配置文件里、指向本程序 `--pet-hook <phase>` 的那一段。
  只按 `--pet-hook` 标记识别，**只删我们自己写的行**，绝不整段覆盖别人的配置。
- **桥（bridge）** —— 没有 hook 文件的 Agent 的另一种投递形态：由跑在对方进程里的插件（DSH 的
  `integrations/dsh-bridge/` cordis 插件）把事件写成同样的收件行，宿主只负责检测桥装没装、记录选择、
  摘旧 hook，**不代装**（对方只认自己的 `plugin_manager install_bundle`，见 [ADR-0016](docs/adr/0016-dsh-agent-bridge-is-a-plugin-not-hook-files.md)）。
- **收件目录（inbox）** —— `<app_data>/agent/inbox/<phase>.jsonl`。投递方（hook 进程或桥）落一行就退出，
  宿主 watcher 增量消费并归一化成会话状态。每行带 `agent`，watcher 只上报与当前联动来源一致的行
  （`dsh` 必须同时出现在 `AGENT_IDS` 里，否则整条链路静默丢弃）。

## 生命周期（四个不同的动作，别混用）

- **启用 / 停用（enable / disable）** —— 设置窗插件列表的开关，决定插件 JS 是否加载。停用会连带**卸掉 hook**。
- **联动开关** —— 插件设置页里的「当前联动哪个 Agent」，关掉同样**卸掉 hook**。
- **显式选择（recorded choice）** —— `<app_data>/agent-linkage.json` 里的 `agent` 字段：用户最后一次
  在设置页装 hook（记 `qoder`）或卸载 / 被撤销授权连带卸载（记 `null`）留下的记录。
  **只有这两条路径写它**；启停差异、删除插件、启动清理与 `--pet-hook-cleanup` 都只读。
- **安装 / 卸载（install / uninstall）** —— 对 hook 条目的增删。增删本身由联动派生，
  「要不要装」的意图由上面那份显式选择决定：**停用或删插件会摘掉 hook，重新启用则按记录自动装回来**
  （前提是该能力已在同意框里同意过）；应用启动只摘残余、**绝不重装**（用户可能就是在 Agent 那边
  故意删掉的，每次开机把他刚做的事恢复回去是跟用户较劲）。
- **接入 / 断开（attach / detach）** —— 桥形态对应的两个动作（设置页按钮文案也用这两个词）：
  接入 = 检测桥已装 + 记下显式选择；断开 = 摘掉旧 hook + 把选择清成 `null`。**不改对方的 profile**，
  装桥永远是对方应用里的一次性手动动作。
- **撤销授权（revoke）** —— 撤掉插件的全部能力，并弹一次确认：默认连带卸载 hook，用户可选只撤能力。

## 显示

- **常驻状态行（status line）** —— 钉在宠物头顶气泡里的会话状态（状态 + 工具名 + 步数），
  状态变化就刷新，不是定时消失的台词。
- **节点台词（line）** —— `needs_input` / `completed` / `failed` 等关键节点上的一句话，3.6 秒后自动收起，
  不覆盖常驻状态行。
- **自语（dialogue）** —— 宿主自己的随机台词（`src/pet/dialogue.ts`）。**常驻状态行存在时自语让路**，
  联动关掉后自动恢复。
- **会话卡片** —— 旧的 agent 桥 overlay 悬浮窗（`overlay-com_pet_agent-bridge`）。本次要移除的东西，
  移除后 agent 桥不再持有 overlay 窗。

## 配置归属

- **宿主壳（host shell）** —— 插件页里由宿主渲染的部分：启停、id、权限列表、撤销授权。
- **插件页（plugin page）** —— 插件自己在 `settings` 区渲染的部分。Agent 钩子配置**归这里**，
  「宠物设置」里不再留第二份入口。
