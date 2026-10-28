# 远端分支清理记录（2026-10-28）

一次性维护记录，不是流程文档：说明远端 52 条分支各自在做什么、清理时它们的 tip 指向哪里、内容有没有真的落到 main，以及日后怎么恢复。

## 一、为什么 `git branch --no-merged` 会骗人

main 的 55 个提交**全部是 GitHub squash 合并**（subject 尾部带 `(#7)`…`(#65)`）。squash 会把分支上的 N 个提交压成一个新提交，patch-id 随之改变，于是 `git branch --no-merged origin/main` 永远认为源分支没合并——**它比的是提交，不是内容**。

判断一条分支是否已落地，看两处才可靠：

1. **内容**：取 `merge-base..branch` 的新增行，看它们是否出现在 main 当前文件里（本轮审计：44 条命中 96%–100%，只有 B04 两条是 3% / 6%）；
2. **卡号/PR**：main 每条 squash 提交都带卡号或 PR 号，逐条对得上。

## 二、清理清单（52 条 → 只留 main）

删除时的 tip（前 10 位）、对应卡/PR、以及内容是否在 main 里。`卡/PR` 一列的编号来自 main 的 squash 提交；标「main 祖先」的 6 条是早期普通合并（那时还没启用 squash），本来就是 main 的祖先。

| 分支 | 删除时 tip | 卡 / PR | 作用 | 内容在 main |
| --- | --- | --- | --- | --- |
| `chore/a18-bump-0.2.1` | 85313a6d6b | A18 #43 | 0.2.0 → 0.2.1 版本号 | 是（版本行已被后续 bump 覆盖） |
| `chore/release-0.2.2` | 04c2fa93f2 | #63（tag v0.2.2） | 0.2.2 版本号 | 是 |
| `ci/e2e-failure-detail` | 34174aa196 | #23 | 套件汇总注解带失败项期望/实得原文 | 是 |
| `ci/e2e-summary-notice` | 594b10f874 | #18 | 套件汇总行同时发成工作流注解 | 是 |
| `docs/adr-0012-consent-coalescing` | e07f318a99 | D01 #28 | ADR-0013 同意请求合流与未启用不弹窗 | 是 |
| `feat/a30-hotkey-registered` | 590bba15d3 | A30 #57 | 设置页快捷键显示真实注册状态 | 是 |
| `feat/agent-adapters-codex-workbuddy` | f5e3f05e63 | A03 #17 | Codex + WorkBuddy 适配器接线 | 是 |
| `feat/agent-adapters-zcode` | 22180596a5 | A02 #16 | 适配器抽象 + ZCode 适配器 + 四选一切换 | 是 |
| `feat/agent-linkage-h1` | 0a49cda904 | H1 #9 | 插件启停联动 hook 装卸（Agent 桥起点） | 是 |
| `feat/b04-b3-random-line-det` | 29f947441d | B04（无 PR） | 随机台词让路确定性，叠在下一支之上再 +140 行 | **否（搁置，见第三节）** |
| `feat/b04-random-line-det` | 3996ce7a7e | B04（无 PR） | 同一条线的 7 个提交：fixture 自挂常驻行 / 700ms 启动问候 / clear 插入点 | **否（搁置，见第三节）** |
| `feat/b06-overlay-fixture` | 7fe3cde615 | B06 #20 | overlay 夹具从 agent 桥换成 com.pet.astock | 是 |
| `feat/c05-goat-agent-link` | eba5add2a6 | C05 #26 | GOAT 与 agent:state 联动（running 30s 刷新） | 是 |
| `feat/c08-goat-gauge-secrets-copy` | 6c3912da94 | C08 #49 | 凭据文案改为 DPAPI 加密的 secrets.json | 是 |
| `feat/c09-goat-gauge-cache-kpi` | ab4c56faef | C09 #51 | 概览 KPI 换成缓存命中率 | 是 |
| `feat/c10-goat-gauge-visual` | 5ffe92d166 | C10 #54 | 插件页与悬浮卡视觉美化 | 是 |
| `feat/d01-sprite-manifest-v3` | b6cbcacbbe | E01 #61 | 精灵图 v3 清单化（≤64 帧；卡号由 D01 改名 E01，分支名未改） | 是 |
| `feat/d02-consent-coalescing` | 1d89a8235e | D02（#34 栈） | 钉住停用取消 pending 的接线顺序 | 是 |
| `feat/d03-consent-e2e` | 47d48fb5c0 | D03（#34 栈） | 核销有意 console、显式 cleanup 环境 | 是 |
| `feat/d04-console-e2e` | 0a7332a1c2 | D04（#34 栈） | 窗口化 console 核销与 goat 停用基线取证 | 是 |
| `feat/d07-fixture-preseed` | b427d1a106 | D07（#34 栈） | 启动前清旧授权与 agent 临时状态（`PET_E2E_PRESEED` 的由来） | 是 |
| `feat/d09-isolation-audit-fix` | 8f896e6419 | D09 #36 | 读不到的页判「未确认」，不再带走整轮 | 是 |
| `feat/e02-hotkey-default-override` | 53e3f336cb | E02 #62 | debug 默认热键覆盖 `PET_HOTKEY_DEFAULT` | 是 |
| `feat/goat-gauge-core` | df3da7ac34 | C1 #10 | GOAT 数据层、出网调度与告警（M0–M4） | 是 |
| `feat/goat-gauge-view` | 7f58e13769 | C2 #11 | GOAT 视图与 e2e（M5–M8） | 是 |
| `feat/l2-widget-worker-render-contract` | f751e18581 | L2（ADR-0006/0008） | Worker 渲染契约与同 realm 措辞同步 | 是（main 祖先） |
| `feat/widget-apiversion-2` | 2163de4c98 | L2 | widget `apiVersion` 2 迁移提示 | 是（main 祖先） |
| `fix/a20-release-target-env-isolation` | f2eabce07f | A20 #46 | verify:release 尊重目录变量并自带 agent 隔离 | 是 |
| `fix/a21-bundle-resources-plugins` | a607fd2a14 | A21 #44 | resources 用目录映射，插件落到 plugins/<id>/ | 是 |
| `fix/a22-consent-denied-latch` | 0deb9c50b2 | A22 #45 | 停用读不到启停清单时按拒绝锁集合清锁 | 是 |
| `fix/a23-cleanup-pet-backups` | 62b3d3a39f | A23 #48 | 清理路径收掉适配器生成的备份文件 | 是 |
| `fix/a24-nsis-cleanup-target-dir` | 482d9d6165 | A24 #47 | NSIS 验收脚本的安装包目录尊重 `CARGO_TARGET_DIR` | 是 |
| `fix/a25-hotkey-diagnostics` | 521487df51 | A25 #55 | 「改回默认值」被拒时带出 e / code / `hotkey_status` 读回 | 是 |
| `fix/a26-attach-handshake-timeout` | 81c71d701c | A26 #56 | 握手超时折进「读不到页」 | 是 |
| `fix/a27-choice-camelcase` | 52395260c7 | A27 #52 | `Choice` 改 camelCase，修设置页四个 undefined | 是 |
| `fix/a28-astock-add-input` | 0964307fdb | A28 #50 | A股插件添加自选输入框补 input 监听 | 是 |
| `fix/a29-watch-list-input-listener` | 9b59937b09 | A29 #58 | 自选三框各钉一条字段断言 | 是 |
| `fix/a31-settings-dir` | f31762a3d0 | A31 #59 | E2E 热键设置走 `PET_SETTINGS_DIR`（仅 debug） | 是 |
| `fix/a32-currency-sel-change-listener` | 8cf3a5b715 | A32 #60 | GOAT 币种下拉补 change 订阅 | 是 |
| `fix/agent-inbox-isolation` | d4f627fdc2 | 早期 | `PET_AGENT_INBOX` 覆盖收件目录，挡住开发机全局 hook | 是（main 祖先） |
| `fix/b08-b3-baseline-determinism` | da97dfc3cb | B08 #25 | 常驻行基线判据确定性（driveConsent 边界匹配） | 是 |
| `fix/badge-resizeobserver-red-bar` | a01a316dbb | 早期 | 徽标仲裁反应 ResizeObserver 回调，消掉宠物窗红条 | 是（main 祖先） |
| `fix/c11-demo-cache-kpi` | 3d04f1696d | C11 #53 | 演示模式注入可复算的缓存 KPI | 是 |
| `fix/e04-v3-csp-cache` | acc362b120 | E04 #64 | v3 CSP 回归、atlas 缓存失效与 pet.json no-store | 是 |
| `fix/e05-goat-empty-badge` | 3195349523 | E05 #65 | goat 空态 badge 改判自身高度与内容 | 是 |
| `fix/e2e-clean-stale-fixtures` | 09ed3564ea | #15 | 构建前后清残留探针插件，防一次崩溃连累下个分支 | 是 |
| `fix/goat-gauge-e2e-bus` | f0084ed7a6 | #13 | goat 重新启用后重建事件总线 | 是 |
| `fix/goat-gauge-followup` | d091d541b1 | C03 #12 | C03 评审 follow-up（Key 清理、写入去重） | 是 |
| `fix/p1p2-security-reliability` | 4b002b25de | 早期 | P1/P2 加固：同意框身份、订阅侧 ACL、点击穿透门禁 | 是（main 祖先） |
| `fix/s3-settings-worker` | 5cedeea47a | S3/B01 #7 | settings 区 widget 一律进 Worker | 是 |
| `fix/verify-worker-session-count` | 704e4ffed7 | 早期 | 回收断言改比停用前后差值 | 是（main 祖先） |
| `tmp/d03-baseline` | 7693c6d5d6 | —（#34 吸收） | D03 的临时基线草稿（提交信息自注「仅 tmp 分支」） | 是（内容已在 #34） |

## 三、B04 两条为什么是弃稿

`feat/b04-random-line-det`（7 提交）与 `feat/b04-b3-random-line-det`（2 提交，叠在前一支上）都在做同一件事：让「随机台词让路」这条断言变成确定性的。两支走的是重量级路线——用 `addScriptToEvaluateOnNewDocument` 截住启动问候、用 fixture 激活自挂常驻行、靠 localStorage 标志位、再补 700ms 启动问候与 clear 插入点。

main 最终用的是**另一种更轻的实现**：把 `Math.random` 钉死，等一次 45 秒闲置拍子（`tests/e2e/verify-isolation.mjs` 里「随机台词让路：把 Math.random 钉死…」那一组），判据是「整段窗口内气泡只出现过常驻行」。两条弃稿新增行只有 3% / 6% 命中 main，属被替代的实验。

当时的口径也一致：云端 PM 交接文档 §3 把 B04 列在「Ready 但不派（搁置）」，派单工作区里也有同样的搁置记录。

## 四、怎么把某条分支找回来

删除的只是 ref，提交还在 GitHub 上（短时间内可按 SHA 访问）。要恢复：

```
git push origin 29f947441d:refs/heads/feat/b04-b3-random-line-det
```

上面表格的 tip 列就是 SHA 前缀，配合 `git fetch origin 29f947441d` 可先取回本地核对。

## 五、防复发

- 合并后就让分支消失：GitHub 仓库设置里的 `delete_branch_on_merge`（或每次合并后执行 `git push origin --delete <branch>`）。本机没有 `gh`、也没有可用的仓库 token，这一项需仓库管理员在网页侧打开。
- 如果坚持保留源分支，至少保证「分支名里带卡号」——squash 之后卡号还在 main 的提交信息里，靠它就能对上，不依赖 ref 是否存在。

## 六、同日补的 tag

清理当天给已经出过包、但没打 tag 的两个版本补了注释 tag（沿用 v0.2.2 的注释 tag 风格）：

- `v0.2.3` → `02e5102`（DSH Agent 桥，第五家）
- `v0.2.4` → `b6d98cd`（DSH 桥收件目录修复与五处验收缺口，B5 修复轮）
