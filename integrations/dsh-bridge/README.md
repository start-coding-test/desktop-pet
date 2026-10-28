# 桌宠 Agent 桥（DSH）

给 DeepSeek Harness（下称 DSH）装一个 cordis 插件，让桌宠能显示「DSH 正在跑 / 在等确认 /
这一轮结束了」。桌宠侧不需要任何新端口、新进程：桥把事件写成一行行 JSONL，落进桌宠的收件
目录——和 Qoder / ZCode / Codex 的 hook 走的是同一条管道。

## 为什么不是 hook

其余四家客户端（Qoder、ZCode、Codex、WorkBuddy）都有「在配置文件里加一条命令」的扩展面，
桌宠的适配器就是改那份文本。DSH 没有这个面：它的插件是进程内的 cordis 插件，官方只支持用
`plugin_manager` 的 `install_bundle` 安装。所以桥只能是一个 DSH 插件，而不是一行 shell。

**桌宠不会替用户装它**：`install_bundle` 会改写 DSH profile 的 `package.json` 与
`cordis.patch.yml`，DSH 文档明确要求这些改动由它自己的安装路径完成（手写会被它下一次迁移
覆盖）。桌宠只负责把本目录随安装包发出去、检测桥有没有装上、记住用户的选择。

## 装一次

DSH 里对桌宠的 AI 说一句「用 plugin_manager 装 <路径> 这个 bundle」，等价于调用：

```text
plugin_manager({ action: "install_bundle", target: "<桌宠安装目录>/integrations/dsh-bridge" })
```

- **发布版**：`<桌宠安装目录>/integrations/dsh-bridge`（`bundle.resources` 已把本目录复制进去）。
- **开发版**：仓库里的 `integrations/dsh-bridge`。

装完新 bundle 由 HMR 直接激活，不需要重启 DSH。之后在桌宠设置窗的「Agent 接入」里选 DSH
→ 接入，桌宠就开始收状态。

## 写什么

收件目录：`%APPDATA%\com.desktoppet.pet\agent\inbox\<phase>.jsonl`（可用 `PET_AGENT_INBOX`
改；桌宠与桥读同一个变量）。每行一条：

```json
{"phase":"pre","at":1792401646292,"agent":"dsh","payload":{"session_id":"session-…","tool_name":"pwsh","command":"npm run build"}}
```

| DSH 事件 | phase | 桌宠表现 |
|---|---|---|
| `session/created` | `session-start` | 开始跑 |
| `user/message` | `user-prompt` | 开始跑，标题取这条消息 |
| `tool/call` | `pre` | 跑，步数 +1 |
| `tool/result`（失败） | `tool-failure` | 失败 |
| `tool/result` | `post` | 跑 |
| `approval/asked` | `approval-request` | 等确认（`needs_input`） |
| `approval/decided` | `post` | 回到跑 |
| `turn/end` `completed` | `stop` | 这一轮结束 |
| `turn/end` `aborted` 等 | `interrupt` | 空闲 |
| `turn/end` `error` / `max-tokens` | `stop-failure` | 失败 |
| `subagent/descriptor` | `subagent-start` | 跑 |
| `session/disposed` | `session-end` | 空闲 |

其余事件（`step/*`、`assistant/message`、`job/*`、`command/*`、`session/title`……）一律忽略：
桌宠只画状态，不搬内容。子代理会话（`delegationDepth > 0`）整体忽略，避免把父会话的步数
算成两份。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `inboxDir` | 见上 | 桌宠收件目录；必须是绝对路径，否则桥保持静默并写一条日志 |

## 边界

- 桥只写本地文件，不发网络请求，不读会话内容以外的东西。
- 桥的每个入口都包了 `try/catch`，写盘失败按错误种类只报一次：它不能反过来弄坏会话。
- 内容以 DSH 的公开事件为准（`session/event` 的 `type`/`time`/`data`）；未知类型按「不关心」
  跳过，所以 DSH 升级后最多是少几个状态，不会崩。
