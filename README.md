# DesktopPet — 插件驱动的 Windows 桌面宠物

Tauri 2 + TypeScript/Vite 实现的桌面宠物框架：宠物本体只提供窗口、渲染与插件运行时，所有功能（BLE 心率、token 用量、待办等）由插件提供。完整设计见 [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)，插件开发规范见 [docs/plugin-dev/PLUGIN_SDK.md](docs/plugin-dev/PLUGIN_SDK.md)；要写插件请从 [docs/plugin-dev/PLUGIN-HANDBOOK.md](docs/plugin-dev/PLUGIN-HANDBOOK.md) 开始（交付标准与坑清单），验收口径见 [docs/plugin-dev/PLUGIN-REVIEW.md](docs/plugin-dev/PLUGIN-REVIEW.md)，可接的任务见 [docs/plugin-dev/PLUGIN-BACKLOG.md](docs/plugin-dev/PLUGIN-BACKLOG.md)（插件域）与 [docs/process/HOST-BACKLOG.md](docs/process/HOST-BACKLOG.md)（本体与工程域，含验收证据矩阵）。

## 功能清单

**宠物本体**

- 透明置顶宠物窗（Canvas2D 图集序列帧）、按 hit-zone 启用点击穿透、可拖拽、托盘、单实例
- **九个状态的状态机，词表照搬 Petdex**：`idle` / `running-right` / `running-left` / `waving` / `jumping` / `failed` / `waiting` / `running` / `review`，带优先级队列（去重、排队上限 3、可持续状态只续期不排队）；按住拖动时按窗口真实水平位移切 `running-right` / `running-left`（`onMoved`，不依赖被系统拖拽吞掉的 mousemove），松手复原拖动前的状态
- **桌宠形象来自 Petdex 公开画廊**：设置窗输入名字（如 `deepseek`）即下载并切换，默认形象 `deepseek`；本项目不内置、不再分发任何美术文件，仅供学习与自娱自乐
- 呼吸/轻摆渲染层叠加在真序列帧之上，插件经 `ctx.pet.*` 受控驱动本体
- 精灵帧按设备像素比烘焙并响应 DPI 变化；渲染循环节流（脏矩形、可见性门控、定时器清理）

**游戏模式**

- 检测到别的应用铺满整块显示器（游戏、演示、全屏视频）时宠物自动隐身并安静下来：动画、点击穿透的光标轮询、自言自语全部停掉，插件功能照常运行
- 进出全屏按最近 3 次采样的多数票决定，避免后台聊天软件间歇抢前台造成抖动；开关在设置窗，关掉就不再轮询前台

**插件运行时**

- manifest 扫描与校验（`id` 必须等于目录名）、动态 `import`、activate / deactivate 生命周期、单插件错误隔离
- 插件文件统一走自定义协议 `petplugin://<id>/<路径>`，磁盘位置只有 `plugins_dir()` 一个解析点，打包版仍是「放进目录即生效」
- 目录 watcher 热安装 + 设置窗启停；被移走的插件真正下线，授权与存储连带清理
- Widget 宿主：每插件一个 closed Shadow DOM 插槽，挂载并发保护、失败不留孤儿节点
- 事件总线：`<插件id>:` 前缀归属，发布/订阅分别鉴权，禁通配越界，派发深度上限
- 能力桥默认拒绝，一次弹框合并申请多个能力

**Rust 能力服务**

- `ble`：btleplug 扫描 / 连接 / 通知，按持有者计数，停用不误伤其他插件
- `store`：按插件隔离的 JSON 存储，原子写入，数据损坏报错而非静默清空
- `http`：宿主代发 + 按域名逐个授权，host 由 Rust 自行解析，响应体与方法均有上限
- `notify`：系统通知
- `permission`：授权表 + 同意框窗口，同意框被关闭即结束挂起的权限请求

**窗口**：宠物窗、设置窗、权限同意框、透明 overlay 悬浮窗（单窗共享、按持有者释放）

**设置窗**（右键托盘 → 设置，或按 `Ctrl+Alt+P` 唤出）

- 左侧分区导航：插件 / 桌宠形象 / 快捷键 / 启动 / Agent 接入 / 游戏模式
- 插件卡片带图标位、启停开关、权限标签（能出网、能落盘的权限标黄）、撤销授权，顶部可按名称、id 或权限搜索
- 开机自启写当前 exe 在 HKCU 的 Run 项（开发构建会如实提示注册的是 `target\debug` 路径）
- 全局快捷键可改，带修饰键/主键校验与占用测试；换键时先注册新键、成功才注销旧键

**示例插件**

- `com.pet.hr-ble`：扫描并连接心率设备，徽标小字或波形悬浮窗
- `com.pet.agent-bridge`：把编码 Agent 的会话状态转成宠物动作与台词。事件由 Qoder hook 采集（宿主自己收，不依赖第三方）；hook 的配置入口走插件自己的设置页（能力 `agent:hooks`，见 [ADR-0001](docs/adr/0001-agent-hooks-capability-in-plugin-page.md)）。第五家 DSH 没有 hook 文件，走 `integrations/dsh-bridge/` 这个 cordis 桥插件往同一个收件目录投递（见 [ADR-0016](docs/adr/0016-dsh-agent-bridge-is-a-plugin-not-hook-files.md)）
- `com.pet.todo`：待办清单。字段照 todo.txt 约定（`(A)` 优先级、`due:` 到期、`@项目`、`+上下文`），徽标显示剩余条数、桌面卡片可勾选、到点弹系统通知并让宠物有反应，变化时广播标准 topic `com.pet.todo:changed`。数据只存插件自己的隔离存储 —— **整个插件零本体改动**

**Agent 事件接入**：安装/卸载 Qoder hook 是插件可申请的能力 `agent:hooks`，入口在 agent 桥插件自己的设置页（宿主设置窗那张「Agent 事件接入」卡片已删除，见 [ADR-0001](docs/adr/0001-agent-hooks-capability-in-plugin-page.md)）。宿主 exe 自身兼任 hook 接收器（`--pet-hook <phase>` 分支，只落一个文件就退出），收件目录由 watcher 读增量并归一化成会话状态；安装只增删自己标记的条目，不动其他 hook，首次改动会留 `.pre-pet-backup` 备份。同一能力下还有「桥」这种形态：DSH 侧只认插件，宿主就只负责投递收件行、检测桥装没装、记录用户选择，`integrations/dsh-bridge/` 随安装包发出但不代装（见 [ADR-0016](docs/adr/0016-dsh-agent-bridge-is-a-plugin-not-hook-files.md)）。

**尚未完成**：`llm-token-usage` 示例插件（暂缓）。插件入口与 widget 现已默认运行在 Web Worker 里（[ADR-0006](docs/adr/0006-plugin-host-in-web-worker.md)、[ADR-0008](docs/adr/0008-widget-host-in-web-worker-render-commands.md)），同 realm 只剩显式 opt-out 的逃生门（`host:realm-plugin-host` / `host:widget-realm-plugin-host`）—— 走逃生门的插件仍可直接 `import { invoke }` 绕过 JS 桥，这一条不是隔离边界。

## 开发环境

- Node.js ≥ 20 与 npm
- Rust stable（`x86_64-pc-windows-msvc`）+ Visual Studio Build Tools（C++ 工作负载）
- Windows 10 1809+（WebView2 Runtime）

## 常用命令

```bash
npm install            # 首次安装前端依赖
npm run tauri dev      # 开发运行：宠物窗 + 前端热更新
npm run tauri build    # 打包发布

npm run dev:debug      # 带 WebView2 远程调试端口启动，供断言脚本连接
npm run verify         # 隔离与安全回归断言（需另一个终端先跑 dev:debug）
npm run verify:agent   # Agent 事件链路断言（脚本自己写收件目录）
npm run verify:game    # 游戏模式断言（会起一扇铺满显示器的深灰窗口约 10~16 秒：非置顶、任务栏可见，会自动关）
                   # 注意：该脚本会反复抢前台，其他置顶程序可能短暂闪动
npm run verify:skin    # 桌宠资源安装链路（会真的连 petdex.dev 下载图集，临时装一个第二形象后删掉）
npm run verify:release # 验打包产物的 CSP，每波次收尾手工跑一次
```

## 目录速览

- `src/pet/` 宠物本体：Petdex 图集切片与九状态规格 + 序列帧播放器 + 状态机 + 皮肤解析 + 点击穿透/台词/游戏模式
- `src/runtime/` 插件运行时：manifest 发现与启停、能力桥（校验在此）、事件总线与 topic 归属、widget 宿主
- `src/settings/` 设置窗：侧栏导航（宠物设置 + 每插件一条）、插件页壳、形象/快捷键/自启/游戏模式分节
- `src/overlay/` 与 `src/consent/` 悬浮窗页（按插件各开一扇）与权限同意框页
- `src-tauri/` Rust 宿主：窗口（宠物/悬浮/托盘）、单实例、自启，加原生能力服务（BLE/存储/HTTP 代理/通知/权限/启停/快捷键/全屏/hook/形象）
- `packages/sdk/` 插件 SDK：类型声明、manifest schema、能力与 topic 名单（单一事实源）
- `plugins/` 示例插件：`com.pet.hr-ble`（心率蓝牙）、`com.pet.agent-bridge`（Agent 桥）、`com.pet.todo`（待办）、`com.pet.astock`（A股盯盘）
- `tests/unit/` 与 `tests/e2e/` 单测与 `verify-*.mjs` 端到端断言
- `tools/` 开发辅助：`dev-debug.mjs`（供断言脚本连 CDP）、图标生成脚本
- `docs/` 文档：`docs/architecture/`（本架构）、`docs/plugin-dev/`（SDK 与插件流程）、`docs/process/`（评审与派单）、`docs/adr/`（决策记录）
- `release-package/` 便携包产物（不进版本库；插件是磁盘加载，改 `plugins/` 不需要重编本体）

## 更换桌宠形象

宠物形象不再内置在仓库里，而是从 [Petdex](https://petdex.dev/) 公开画廊按需下载：

1. 打开设置窗 → 「桌宠形象」→ 输入画廊里的名字（例如 `deepseek`）→ 安装。
2. 安装成功后宠物窗立即换装，之后可在同一区块切换或删除。
3. 首次启动且本地没有任何皮肤时，宿主会自动安装默认形象 `deepseek`；离线则退回程序生成的占位帧。

技术口径：图集是 `8 列 × 9 行`（v1）或 `8 列 × 11 行`（v2）的无损 webp，单元格 192×208，每行对应一个状态、行内帧数与整行时长见 `src/pet/petdex-states.ts`。下载的文件落在 `%APPDATA%/com.desktoppet.pet/skins/<slug>/`，经宿主自定义协议 `petskin://<slug>/sprite.webp` 读给 webview，与插件文件的 `petplugin://` 同一条路，dev 与打包版都不内嵌第二份副本。

## 致谢

- 状态词表、图集规格与 Agent 阶段→状态的映射照搬 [petdex](https://github.com/crafter-station/petdex)（`src/lib/pet-states.ts`、`src/lib/sprite-atlas.ts`、`packages/petdex-cli/src/hooks/bubble-runner.ts`）；本项目只做下载与渲染，不再分发任何美术文件，仅供学习与自娱自乐。
- 原「鲸鱼娘」单帧立绘（来自 [dsh-whale-musume](https://github.com/Sutera-Diffusus/dsh-whale-musume)）已随九状态图集重构一并移除，需要时在 git 历史里可以找回。

