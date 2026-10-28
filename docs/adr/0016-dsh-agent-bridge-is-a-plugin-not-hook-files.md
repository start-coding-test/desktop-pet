# DSH 的 Agent 桥是 cordis 插件、不是 hook 文件；宿主只检测不代装（2026-10-28）

新增第五家 Agent：DSH（DeepSeek Harness）。前四家（Qoder / ZCode / Codex / WorkBuddy）的共同前提
在它身上不成立 —— **它没有 `hooks` 配置文件**。DSH 的扩展面是 cordis 插件（`ctx.on("session/event", …)`
这类事件订阅），bundle 的安装由它自己的 `plugin_manager` 承担。

## 决定

1. **桥跑在 DSH 里，不以「改 DSH 配置」的方式接入**：新包 `integrations/dsh-bridge/`（`package.json` +
   `cordis.patch.yml` + `index.js` + `mapping.js` + `locale/` + `icon.svg`），随桌宠安装包投到
   `<安装目录>/integrations/dsh-bridge`。它订阅 `session/created` / `session/event` / `session/disposed`，
   把事件映射成桌宠已有的收件行（`{"phase","at","agent":"dsh","payload"}`），写进同一个
   `%APPDATA%\com.desktoppet.pet\agent\inbox\<phase>.jsonl`。下游（watcher → 归一化 → `agent:state`/
   `agent:event` → `com.pet.agent-bridge` 插件）**一行都不用分叉**。
2. **宿主不代装**：`plugin_manager` 的 `action:"install_bundle"` 是 DSH 侧唯一受支持的安装入口，且
   DSH 文档明令不许手写 profile 的 `package.json` / `cordis.patch.yml`、不许在 profile 目录跑 pnpm。
   桌宠若替它做这几件事，就是在绕过人家的加载器与版本管理，升级即碎。所以桌宠只做三件：
   把 bundle 投到安装目录、**检测**它有没有被装上、**记住**用户的选择。用户需要在 DSH 里装一次
   （`install_bundle`，`target` 指向上面那个绝对目录），桥对重复安装幂等。
3. **适配器接口加一项显式事实**：`AgentAdapter::installs_files() -> bool`（默认 `true`，DSH 返回
   `false`）。`linkage::switch_agent` 与 `agent_hooks_install` 据此走「摘净旧 hook + 检测 + 记录」分支，
   而不是在调用方按 `id == "dsh"` 分派 —— 那种分派在加第六家时会静默漏掉。
4. **检测口径**：读 `~/.dsh/profiles/*/package.json` 的 `dsh.profile.bundles`，含
   `dsh-pet-agent-bridge`（或带 `@version` 后缀）即算已装；`PET_DSH_HOME` 可换根（E2E/复演用）。
   profile 清单是 DSH 自己的事实来源，比在 `node_modules` 里猜路径稳。检测结果只用于「接上/未接上」
   与一条可照抄的安装路径，不参与 hook 的条数统计。
5. **事件映射放在纯函数里**（`integrations/dsh-bridge/mapping.js`，不 import `node:`）：
   `user/message → user-prompt`、`tool/call → pre`、`tool/result → post`（`isError`/传输错误 →
   `tool-failure`）、`approval/asked → approval-request`、`approval/decided → post`、
   `turn/end` 按 `reason.kind` 分 `stop`/`interrupt`/`stop-failure`、`subagent/descriptor → subagent-start`、
   `session/created|disposed → session-start|session-end`；`step/*`、`assistant/message`、`job/*` 等忽略，
   未知类型安全跳过（DSH 自己的观察者插件也是这个口径）。子代理会话（`header.delegationDepth > 0`）
   整体不转发，否则步数会算双。
6. **桥不许反过来弄坏会话**：每个入口都包 `try/catch`、写盘按文件串成一条 Promise 链、
   同一类错误只报一次、`ctx.effect` 的 cleanup 里冲刷未落盘的队列。这条抄自 DSH 侧观察者插件的
   硬规则「Capture can never break a session」。

## 为什么不是「只读会话日志」

会话落盘是 v4 契约（`~/.dsh/sessions/…/session.v4.jsonl.zstd`，每批一个 zstd 帧、有迁移链）。
桌宠要读它就得在 Rust 里带 zstd 解帧 + 跟格式版本，且拆帧/半帧恢复都是自己维护的风险面；
桥插件读的是公开事件 API，格式变由 DSH 自己迁移。代价是「用户要装一次」，但换掉了整条格式依赖。

## 为什么不是「宠物硬写 profile」

`dsh plugin --profile …` 只是把参数转发给 profile 目录里的 pnpm，不是完整注册；手写
`package.json` 的 `dsh.profile.bundles` 与 `cordis.patch.yml` 会绕开 DSH 的加载器与 HMR 校对，
且替换已装包需要重启、写坏就是「DSH 起不来」。**跨应用写别人的配置**这条线，本仓只在有四家
hook 文件的明确契约时走过（还要备份、原子替换、同意框）；DSH 没有等价契约，就不走。

## 影响

- 设置页列出五家；DSH 那一格是「接入/断开 + 桥状态」，不是「安装/卸载 hook 条目」。
- `agent:hooks` 能力仍是唯一入口（`agent_hooks_status|install|uninstall` 与 `agent_linkage_set`），
  bridge 形态复用同一组命令，payload 多一个 `mode` 与 `bridge` 段。
- 桥的收件行 `agent` 字段固定 `dsh`，`phases::AGENT_IDS` 因此必须有它 —— 否则来源过滤会把
  桥的行全丢掉（单测钉住 `--agent dsh` 被接受、未知值仍被拒）。
- 打包资源多一个根：`bundle.resources` 里 `"../integrations": "integrations/"`；单测从
  「每个目标都以 `plugins/` 开头」改成「目标 = 源目录名 + `/`，且根只许 `plugins/` 与 `integrations/`」。
- 隔离判定表加 `dsh`（`realHomeFiles: []`）：它没有可改写的 home 文件，跨 home 风险判定跳过它。
