# 0.2.x 发版说明草稿（Release Notes）

本文件是 0.2.3 / 0.2.4 的 release notes 草稿；正式发布时把对应一节贴到 GitHub Release。
发版步骤与每版勾选项见 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)。

## 0.2.4 — 2026-10-28（修复轮；tag `v0.2.4` → `b6d98cd`）

### 主要变化

- **Agent 桥第五家：DSH**（`7448b3f`）：新增 `integrations/dsh-bridge/` cordis 桥插件与宿主 `mode=bridge`
  接入形态；DSH 侧 `session/created|event|disposed` 写入收件行（`agent:"dsh"`），设置页按形态显示「接入/断开」。
  设计见 [adr/0016](../adr/0016-dsh-agent-bridge-is-a-plugin-not-hook-files.md)。
- **收件目录回退修复**（`4df82f9`）：`--pet-hook-cleanup` 与启动清理按四家各自的候选文件摘残余；
  修掉 `.pre-pet-backup` 泄漏、CRLF 判据、四家卸载断言与 13 条恒真断言转真。
- **B6 拖动态**（`993e1f2`）：拖动桌宠时按窗口真实位移切 `running-right` / `running-left`，松手复原拖动前状态。
- 发版口径纠偏：0.2.3 安装器作废、提交直推 main 与 CI 门未跑的事实写进台账，不再按「已发布」叙述。

### 已知问题与未验项

- **0.2.3 安装器作废**：其内嵌的桥是收件目录修复前的版本，不要使用；0.2.4 取代它。
- **CI / E2E 门未跑**：E2E 只在本地跑过（`verify` 485/0、`verify:agent` 307/0（t38 修复后复验）、`verify:drag` 41/0、
  `verify:dsh` 43/0；四套件 336s、0 rebuild）；main 分支保护未开启 —— 见 [BRANCHES.md](BRANCHES.md)「七」，需仓库管理员执行。
- **真机安装/覆盖升级未验**：安装器只构建过，未做静默安装 + 真装机布局断言 + 卸载复跑。
- **DSH 真机联动未验**：需要在 DSH 侧用 `plugin_manager` 的 `install_bundle` 装一次桥插件，属产品既定步骤。
- **GitHub Release 未建**：本机无 `gh` / 仓库 token，安装包与 notes 由管理员在网页侧上传。

## 0.2.3 — 2026-10-28（**作废**）

- tag `v0.2.3` → `02e5102`（DSH Agent 桥，第五家）。
- **不要发放**：安装器内嵌的桥为收件目录修复前版本 —— 这正是 0.2.4 修复轮（`4df82f9`）要修的问题
  （收件目录回退、四家卸载与 CRLF 判据）。GitHub Release 未建，也没有正式的 0.2.3 notes。

## 0.2.2 — 2026-10-27（已发布，供格式参照）

- tag `v0.2.2` → `bf585fe`；GitHub Release 双资产；真机验收与读数见 [HOST-BACKLOG](HOST-BACKLOG.md) 的 S3 行。
