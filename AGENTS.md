# Pet — Windows 桌面宠物插件化框架

一个插件驱动的 Windows 桌面宠物：宠物本体只提供窗口、渲染和插件运行时，所有功能（心率蓝牙广播、大模型 token 用量、待办事项等）由插件提供，面向第三方开放插件生态。

## 当前状态

- **阶段**：**0.2.2 已发布（2026-10-27）**；0.2.4 增量包已出（2026-10-28，Agent 桥第五家 DSH + 修复轮），发版口径按实况：提交**直接推了 main**（`7448b3f` / `02e5102` / `4df82f9`），安装包在 CI 之前打好；0.2.3 安装器作废（内嵌收件目录修复前的桥，0.2.4 已取代）；**E2E 只在本地跑过**（`verify:agent` 298/0、`verify` 482/0，离线门 `npm run unit` 2037/0、`cargo test` 384/0，见 B5 卡），E2E 门（`.github/workflows/e2e.yml`，`workflow_dispatch`）没触发、**CI 侧未见绿**，main 分支保护也未开启 —— 四步发版前置与开启命令见 [约定与验收明细](docs/process/CONVENTIONS.md)「发版前置」。历史评审修复见 [CODE-REVIEW.md](docs/process/CODE-REVIEW.md)。
- **已完成**：宠物窗（Petdex 九状态 + 状态机 + 渲染层 + 点击穿透）、Petdex 桌宠资源安装、插件运行时、Rust 能力服务（ble / store / http / notify / 权限同意框 / Agent hook 收件）、设置窗、按插件分开的 overlay 悬浮窗、五个示例插件（心率蓝牙 / Agent 桥 / 待办 / A股盯盘 / GOAT 用量）、v0.2.2 安装包与便携包、v0.2.3 增量安装包与便携包（0.2.3 安装器作废）、v0.2.4 修复轮安装包与便携包。
- **进行中**：DSH Agent 桥（第五家）：`integrations/dsh-bridge/` 桥插件 + 宿主 `mode=bridge` 接入形态，见 [ADR-0016](docs/adr/0016-dsh-agent-bridge-is-a-plugin-not-hook-files.md)；待真机验证「DSH 里 `install_bundle` 一次后桌宠联动」，0.2.4 也还没过 E2E 门（见「阶段」）。拖动态（按窗口真实位移切 `running-right`/`running-left`、松手复原）已落地待验收，真实 OS 拖拽待人工验证；llm-token-usage 按用户决定暂缓。
- 完整设计见 [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)；插件 API 见 [docs/plugin-dev/PLUGIN_SDK.md](docs/plugin-dev/PLUGIN_SDK.md)。

## 技术决策（已确认，勿重新选型）

| 项 | 决策 |
|---|---|
| 宿主框架 | Tauri 2（Rust），不用 Electron / .NET / Python |
| 前端 | TypeScript + Vite，不引入重框架，Canvas2D 渲染宠物 |
| 开机自启 / 全局快捷键 | `tauri-plugin-autostart` + `tauri-plugin-global-shortcut`（官方插件，不自写注册表与 RegisterHotKey）。加依赖后必须核对 `cargo tree -p tauri`：本项目踩过「cargo 把 tauri 抬到新 minor，npm 侧 `@tauri-apps/*` 没动 → `tauri build` 直接失败」，当前锁 tauri 2.12.0 且 Cargo.lock 入库，收尾必跑 `npm run verify:release`。另注意 autostart v2 的扩展方法仍叫 `app.autolaunch()`（改名 `autostart()` 排到 v3） |
| 宠物形象 | Petdex 图集（8 列 × 9 行 v1 / × 11 行 v2，单元格 192×208 无损 webp）+ 状态机；状态词表照搬 petdex 九个状态，本项目不内置美术，运行时从公开画廊下载，默认 `deepseek` |
| 插件形态 | WebView 内 ES Module（进程内加载），每个插件 = manifest.json + index.js |
| 插件生态 | 面向第三方开放：manifest 权限声明 + 能力受控桥 + 首次授权弹窗 |
| BLE | Rust `btleplug`（WinRT 后端）；若 Windows 广播数据受限，回退 `windows` crate 的 BluetoothLEAdvertisementWatcher |
| 插件文件来源 | 宿主自定义协议 `petplugin://<id>/<相对路径>`（Windows 上即 `http://petplugin.localhost/…`），磁盘位置只有 `plugins_dir()` 一个解析点。**不要**回到构建时把 `plugins/` 复制进 `dist/` 的做法——那会让"放进目录即生效"在打包版失效；asset 协议 + 配置 scope 也不可用，`$CARGO_MANIFEST_DIR` 在 dev 下不展开会 403 |

**安全边界与宿主门禁的明细（含 CSP 的生效范围与判法）见 [约定与验收明细](docs/process/CONVENTIONS.md) 的「宿主门禁与安全边界」节**。硬约束：同 realm 插件可绕过 JS 桥——未收口，勿假装已解决；具体说，同 realm 的插件自己 `import { invoke }` 绕过 JS 桥，多插件共用宠物窗时宿主无法按窗口身份区分是哪个插件，改动时不要假装它已解决。

## 架构速览

- **WebView 侧**：宠物渲染状态机（动画优先级队列）；Widget 宿主（每插件一个 Shadow DOM 插槽）；插件运行时（manifest 扫描 → 动态 import → activate/deactivate 生命周期，单插件错误隔离）；事件总线（topic 格式 `plugin-id:topic`）；PetAPI 能力桥（按 manifest 权限逐项校验，拒绝默认）。
- **Rust 宿主侧**：窗口管理（透明/置顶/点击穿透/拖拽）、托盘、单实例、自启；原生能力服务 ble / store（插件隔离 JSON 存储）/ http（白名单域名代理）/ notify / agent（Qoder hook 收件与状态归一化）；权限管理（授权记录 + 同意对话框）。

## 文档索引

- [约定与验收明细](docs/process/CONVENTIONS.md)：流程与交付、实施步骤、验收标准与套件索引、数据源口径、宿主门禁与安全边界、其余约定。
- [架构设计](docs/architecture/ARCHITECTURE.md)：完整架构。
- [插件 SDK](docs/plugin-dev/PLUGIN_SDK.md)：插件 API 与能力表。
- [插件手册](docs/plugin-dev/PLUGIN-HANDBOOK.md)：接活者的交付标准与坑清单。
- [插件评审口径](docs/plugin-dev/PLUGIN-REVIEW.md)。
- [插件任务卡](docs/plugin-dev/PLUGIN-BACKLOG.md)：派单模板与提案区。
- [本体任务卡](docs/process/HOST-BACKLOG.md)：本体/工程域派单与验收证据矩阵。
- 另有 [代码评审记录](docs/process/CODE-REVIEW.md)、[架构决策记录](docs/adr/)、[项目上下文](CONTEXT.md)。
