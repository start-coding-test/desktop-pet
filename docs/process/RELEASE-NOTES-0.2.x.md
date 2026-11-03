# 0.2.x 发版说明草稿（Release Notes）

本文件是 0.2.3 / 0.2.4 / 0.2.5 的 release notes 草稿；正式发布时把对应一节贴到 GitHub Release。
发版步骤与每版勾选项见 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)。

## 0.2.5 — 2026-11-03（验收修复轮；tag `v0.2.5`）

> 已发布：GitHub Release `v0.2.5`（tag 指向 `d5a3ee5`，CI run `41581638182` 全绿；资产 `DesktopPet_0.2.5_x64-setup.exe` 2,809,161 B、asset id `704397272`）。

### 主要变化

- **验收报告 P1/P2 收口**（`33c78d8`）：Rust fmt 23 处差异清零 → main CI 第 12 步「Rust 格式检查」转绿；
  TUN/fake-ip 的 `198.18.0.0/15` 与 `fc00::/7` 不再被「非公网」判据误拒；代理跨源按起始源永久摘掉
  `Authorization` / `Cookie` / `Proxy-Authorization`；HTTP 代理并发拆成 idle 10s 与绝对 deadline 30s。
- **E2E 判定**：两个套件不再用「日志里出现跳过」判红，改结构化 `SKIP` + `E2E-SUMMARY`；
  `e2e-gate` 升 v2（floors 与 pending 分开），新增 `e2e-extended.yml`；NSIS Case C 默认判红、需显式接受。
- **Agent / DSH 桥**：修掉设置页「确认安装」的确认位被 worker 零参工厂吞掉的实现缺陷（Qoder/ZCode 真机链路的断点）；
  hook 回滚只回滚真正装过的文件，空选择不再回退 Qoder；事件写盘超过 8MiB 轮换成 `.1` 后继续写。
- **拖动与运行时**：拖动起点/结束改用「物理窗口坐标 + dpr × 窗口内偏移」的 anchor，跨 DPI 重锚丢弃假位移；
  overlay 找不到归属 3s 自关；插件单步错误隔离；设置页授权状态与撤销改为真调用；错误分级（boot 才亮整窗红条）。
- **业务插件**：A股盯盘阈值自检与编辑锁、GOAT 用量快照门与汇率锁、待办严格持久化、心率广播后缀剥离。
- **R3**（`564f2a8`）：`verify-isolation.mjs`（4074→59 行）与 `verify-agent-bridge.mjs`（2407→44 行）拆成
  `tests/e2e/isolation/` + `tests/e2e/agent/` 的分片；断言标题集合与拆分前**顺序敏感**逐条一致；`CONVENTIONS.md` 超长行折行。
- **R5**：`PLUGIN_SDK.md` 新增 6.1「设置页回显与防冲写（编辑锁）」，A股与 GOAT 各留一份同式 `lock.js`。

### 门禁读数（开发机；不是本包字节）

- `npm run unit` 2642/0；`lint` 238 文件 0 fix；`build` 退出 0；`check:docs` rules=10 failing=0；
  `check:shape` commands=52 failing=0；`check:e2e-gate` suites=12 failing=0。
- `cargo test` 428/0；`cargo fmt --all -- --check` 干净；`clippy -D warnings` 退出 0。
- E2E：`verify` 485/0、`verify:agent` 318/0、`verify:drag` 41/0、`verify:dsh` 43/0。
- 打包版：`npm run verify:release` **40/0**。安装包 `DesktopPet_0.2.5_x64-setup.exe`
  （2,809,161 B，sha256 `c8bd2bae3218a602d884aa35a1ff8718e5751bd35767ebd603f220cb9c3f76aa`，未签名）。

### 已知问题与未验项

- 0.2.3 安装器作废；**0.2.4 安装器不含 2026-11-01 之后的修复**（Rust fmt、E2E 回归、R3/R5），本包才含。
- E2E 门（`.github/workflows/e2e.yml`）仍是 `workflow_dispatch` + 自托管 runner；2026-11-03 runner 仍 Offline，未触发。
- **main 分支保护仍未开启**：网页创建被 GitHub 二次认证（sudo）拦下，需管理员按 [BRANCHES.md](BRANCHES.md)「七」重做。
- 真机未验：安装/覆盖升级、DSH 真机 `install_bundle` 联动、四家 Agent 写盘、DPI≠100% 拖动、蓝牙、在线行情。
- G5-03（A股阈值整表 replace → 差分）未做；报告中 8 个 UI 点在源码中不存在。


## 0.2.4 — 2026-10-28（修复轮；tag `v0.2.4` → `b6d98cd`）

### 主要变化

- **Agent 桥第五家：DSH**（`7448b3f`）：新增 `integrations/dsh-bridge/` cordis 桥插件与宿主 `mode=bridge`
  接入形态；DSH 侧 `session/created|event|disposed` 写入收件行（`agent:"dsh"`），设置页按形态显示「接入/断开」。
  设计见 [adr/0016](../adr/0016-dsh-agent-bridge-is-a-plugin-not-hook-files.md)。
- **收件目录回退修复**（`4df82f9`）：`--pet-hook-cleanup` 与启动清理按四家各自的候选文件摘残余；
  修掉 `.pre-pet-backup` 泄漏、CRLF 判据、四家卸载断言与 13 条恒真断言转真。
- **B6 拖动态**（`993e1f2`）：拖动桌宠时按窗口真实位移切 `running-right` / `running-left`，松手复原拖动前状态。
  该提交在 tag `v0.2.4` **之后**（`git merge-base --is-ancestor 993e1f2 b6d98cd` 不成立），**未随 0.2.4 出包**，随下一版发布。
- 发版口径纠偏：0.2.3 安装器作废、提交直推 main 与 CI 门未跑的事实写进台账，不再按「已发布」叙述。

### 已知问题与未验项

- **0.2.3 安装器作废**：其内嵌的桥是收件目录修复前的版本，不要使用；0.2.4 取代它。
- **CI / E2E 门**：`b6d98cd` 的 CI 绿（run `40643854516`，success）。E2E 门（`.github/workflows/e2e.yml`，
  `workflow_dispatch`）**从未触发**；0.2.4 的 E2E 本地读数跑在含 DSH 套件的工作区、不是 tag `b6d98cd` 的字节：
  `verify` 485/0、`verify:agent` 303/4（t38 修复前记录）、`verify:drag` 41/0、`verify:dsh` 43/0。
  基线的唯一来源是 [.github/workflows/e2e-gate.json](../../.github/workflows/e2e-gate.json)。main 分支保护未开启
  —— 见 [BRANCHES.md](BRANCHES.md)「七」，需仓库管理员执行。
- **tag 之后**：`a18ec21` 在 main 上 CI **红在 Rust fmt**（run `40725727745` / `40725728961`，23 处差异，
  后续 clippy / cargo test / 打包 skipped），不在 0.2.4 包内；修复卡见 [HOST-BACKLOG](HOST-BACKLOG.md) R1。
- **真机安装/覆盖升级未验**：安装器只构建过，未做静默安装 + 真装机布局断言 + 卸载复跑。
- **DSH 真机联动未验**：需要在 DSH 侧用 `plugin_manager` 的 `install_bundle` 装一次桥插件，属产品既定步骤。
- **GitHub Release 已建**（2026-11-02，release id `430739968`，资产 `DesktopPet_0.2.4_x64-setup.exe` 2,760,222 B）；
  便携包未上传（按上文口径属仓库外产物）。**分支保护仍未开**：网页侧创建被 GitHub 二次认证（sudo）拦下，
  需管理员在已通过 sudo 的会话里按 [BRANCHES.md](BRANCHES.md)「七」重做。

## 0.2.3 — 2026-10-28（**作废**）

- tag `v0.2.3` → `02e5102`（DSH Agent 桥，第五家）。
- **不要发放**：安装器内嵌的桥为收件目录修复前版本 —— 这正是 0.2.4 修复轮（`4df82f9`）要修的问题
  （收件目录回退、四家卸载与 CRLF 判据）。GitHub Release 未建，也没有正式的 0.2.3 notes。

## 0.2.2 — 2026-10-27（已发布，供格式参照）

- tag `v0.2.2` → `bf585fe`；GitHub Release 双资产；真机验收与读数见 [HOST-BACKLOG](HOST-BACKLOG.md) 的 S3 行。
