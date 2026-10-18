# 本体与工程任务池（派单 / 验收）

维护：项目经理（负责拆需求、派单、验收）。开发由外部敏捷模型接卡，本文件是接口。

插件域的卡片在 [PLUGIN-BACKLOG.md](../plugin-dev/PLUGIN-BACKLOG.md)（`A` 候选插件、`B` 需要宿主新能力的提案），
评审口径在 [PLUGIN-REVIEW.md](../plugin-dev/PLUGIN-REVIEW.md)，接活者的交付标准在 [PLUGIN-HANDBOOK.md](../plugin-dev/PLUGIN-HANDBOOK.md)。
**本文件只收非插件域**：本体（`src/`、`src-tauri/`）、构建与发布、文档与工程约定。

编号规则：本体功能/缺陷卡续用 `B`（下一张 `B2`）；工程与发布卡用 `S`。

## 0. 卡片模板（复制给接活的模型）

```
任务：<Bn|Sn> —— <一句话目标>
类型：本体缺陷 / 本体功能 / 工程发布 / 文档        ← 决定下面哪条边界生效
必读：AGENTS.md（技术决策表 + 约定，选型不许重议）、docs/architecture/ARCHITECTURE.md、
      docs/plugin-dev/PLUGIN-HANDBOOK.md（若动到插件协议）、被点到的模块源码
边界：只准动这些文件 —— <逐个列出，白名单制>
      不得改 tauri.conf.json 的 CSP、不得加/删 Cargo 依赖（除非卡片明列）、
      不得动 plugins/ 下其他插件目录、不得 git push。
      需要越界就停下来提问，不要顺手改。
已定口径：<本卡依赖的既有决定与坑，摘自 AGENTS.md，标明「不要重新选型」>
方案约束：<已定的实现方向，防止接活者另起炉灶>
MVP 范围：<这一轮只做什么>
明确不做：<列出来，防止范围扩大>
验收：<逐条可观察标准 + 指名要跑哪个 verify 套件 + 该套件断言数不得低于 N 条>
交付：git 提交（不 push）、temp 清空、无遗留进程、验收套件的完整输出粘贴（含末尾汇总行与退出码）
```

## 1. 状态板

| 卡 | 标题 | 类型 | 状态 | 依赖 | 提交 | 评审 |
|---|---|---|---|---|---|---|
| S1 | 发布 0.2.0 便携包 | 工程发布 | **已完成**（2026-10-16 用户直接要求出包；B3/B4/A9b 未落地，包按当期 main 切，证据见卡面） | — | `93a6eef` + 本次提交 | — |
| S2 | P1/P2 加固：同意框身份、订阅侧 ACL、点击穿透门禁、widget boot 超时、store 锁表回收、裸 IPC 判据换真执行 | 安全边界 + 工程 | **已落地待验收**（本次提交；离线门禁全绿，e2e 未跑 —— 理由与影响面见卡面与 [adr/0011](../adr/0011-consent-identity-and-subscribe-acl.md)） | — | 本次提交 | — |
| S3 | settings 区强制进 Worker（门禁粒度从"窗口"收到"身份"） | 安全边界 | **待排**（改法一行，但要重写 `verify-isolation` 的 settings 区探针组并冷启动复跑 CDP 套件，本轮无桌面会话，故意不改） | — | — | — |
| B2 | `agent:hooks` 受控能力：钩子配置从设置窗移交到插件页 | 本体功能 + 安全边界 | **已放行**（第二轮返工后 PM 全量重跑：cargo 72、`verify` **189/0**、`verify:agent` 53、`verify:release` 12、build 0；三条打回问题都修在脚本侧，根因见卡 §10 与提交说明） | — | `7b9b558` | — |
| A9a | agent 桥：把 hook 装/卸入口接到自己的插件页（**补 B2 留下的空窗**） | 插件 | **已放行**（`.dispatch/A股盯盘质量加固/cards/A9a-插件页承接hook入口.md`，派单工作区、不入库，R4 口径；PM 重跑 `verify:agent` 53→**71**、`verify` 189 不变、cargo 72、build 0；HEAD 的 54 条断言标题逐条核对仍全在） | B2（已满足） | `f3be069` | — |
| B3 | 本体气泡常驻状态行 + 节点台词分层（**范围已重划**：agent 桥那张头顶 overlay 会话卡的移除并入本卡，ADR-0010 决策 6） | 本体功能 | **进行中**（2026-10-17，分支 `feat/b3-status-line`：宿主侧 `ctx.pet.setStatus` 已落地 —— 每插件各占一条、显示最近设置的那条、`null` 只删自己那条并回落、控制字符折叠与 20 码点截断都在桥的 gated 内、CSS 单行化、随机台词让路、停用/卸载/撤销/重载/Worker 崩溃五条收尾都摘条目；Worker 方法表 23→24，ADR-0006 已补增项记录。**插件侧（agent 桥删会话卡、改推常驻行）是 A9b，不在本卡**；接口口径见 PLUGIN_SDK §4.1） | — | `b987f21`（ADR）+ `b0b2639`（宿主实现） | 离线：`unit` 1253/0、`lint` / `build` rc 0、`check:docs` rules=8 failing=0、`check:shape` commands=48 failing=0；e2e 新组读数见 PR 描述的 runner run。过渡态提醒（2026-10-16）：agent 桥此刻仍传 `placement:"above-pet"`，宿主接受但忽略，那张卡漂在桌面 `(24,24)` —— 不等于 B3 已完成；B3 落地时要连插件侧的 `overlay` 权限声明一起收回。跟随与游戏模式压制那套机制已由 U01（`134dfce`）从宿主整体删除，本卡不再需要处理 |
| B4 | Agent 适配器注册表 + 单联动事务（卸旧装新） | 本体功能 | 待排（**批次 5**）；T03 的两条缺陷已并入方案约束第 8 条 | B2（已满足） | — | — |
| A10 | A股封板判定改用交易所涨跌停价 | 插件缺陷 | **已放行**（`.dispatch/A股盯盘质量加固/cards/A10-封板判定与权重注释.md`，派单工作区、不入库，R4 口径；批次 2；单测 397 条、6 处变异抽查全杀掉、`verify:astock` 的 10 条红与它无关） | — | `1cd4b5b` | — |
| A11 | `verify:astock` 源归属断言改回源无关（回归套件的测试缺陷） | 工程/回归 | **已放行**（第二轮：PM 现场复现 **154 passed / 0 failed**，且是在**与执行者不同的网络形态**下——PM 这轮 preflight 七台主机全"可达"、新浪 5100ms 通了，而执行者那轮新浪不可达；判定层靠 `attempted` 的尝试记录把"东财 API 失败→下移腾讯"判成绿，预算档位自动放宽到 [3,12]。变异抽查 4/4 全杀掉） | B2（已满足） | 本次提交 | — |
| A9b | agent 桥：去掉会话状态卡 + 多 Agent 单选（依赖本体新能力） | 插件 | 待排（**批次 6**），**等 B3/B4 放行** | B3 B4 | — | — |
| U02 | 本体窗永远压住 overlay：`SetWindowPos` 层内相对序 + 两处重放点（[adr/0010](../adr/0010-badge-visibility-overlay-position-and-window-layering.md) 决策 5） | 本体窗口 | **已放行**（`.dispatch/ui-surfaces/cards/U02-window-layering-above-overlay.md`，派单工作区、不入库，R4 口径；PM 冷重启实测 cargo 185/0、clippy `-D warnings` 与 fmt `--check` 退出码 0、`check:shape` 48 条全 0；真机 `tools/win-zorder.ps1` 三次采样都是 pet 在 1 位／overlay 在 2 位 → pet-top、退出码 0，同轮 `verify:todo` 31/0；变异：把 `raise_above_pet` 掐成首行 return → 同一探针三次全翻回 overlay-covers-pet、退出码 1。**两条欠账**：这段逻辑没有可离线钉住的纯逻辑，L3 要求的 ≥6 个变异点只做得到 1 个（同一天补做的 M-B1 仍是同一刀，只是现在由套件内的新断言接住而不是外部探针；纯 `SetWindowPos` 调用没有可注入的分支，≥6 点这条在这段逻辑上做不到）；`pet.rs` 的第二重放点在现有调用链上是幂等重复保险，独立贡献要「隐藏宠物→恢复→仍 pet-top」的真机断言才能证明，本轮未做 —— **这条已在 2026-10-16 补做并了结**：`verify-isolation` 新增「隐身再恢复：本体仍压住在场的每一扇 overlay（真窗次序）」一组（5 条），三态冷启动实测 V0（两处都在）／V1（只掐 `apply_visibility` 的逐扇重放）／V2（只掐 `pet.rs` 的整体重放）**各 278 passed / 0 failed**，`tools/win-zorder.ps1` 每态三次采样一致 `verdict=pet-top`；V2 同时暴露 `raise_above_pet_all` 只有这一个调用点，故把整体重放连同该函数删掉，恢复路径只剩一处重放，结论与理由记在 [adr/0010](../adr/0010-badge-visibility-overlay-position-and-window-layering.md) 文末「修订」） | — | `c4dcc8c` | — |
| U03 | 徽标只显一个：尺寸判据 + 5 秒轮播（启用清单序）+ 四插件空态不渲染（[adr/0010](../adr/0010-badge-visibility-overlay-position-and-window-layering.md) 决策 1） | 本体运行时 + 四插件 | **已放行**（`.dispatch/ui-surfaces/cards/U03-badge-visibility-arbiter.md`，派单工作区、不入库，R4 口径；新单测 24 条，`unit` 1212→**1236**、`unit:widget` 110→134、`unit:migrate` 18/0，tsc／typecheck:plugins／biome 143 files／`check:shape`／`check:docs` 退出码全 0；`verify:worker` 59→**66/0**（⑨ 组 8 条全新增）、`verify` 270/0；`audit-assertions` 59→67 条标题且 0 条消失；PM 独立变异 7 点 → 6 杀 1 存活，存活那点是 `candidates()` 里经公开 API 不可达的防御性冗余子句（一次性探针证实），已补一条断言把入口那层钉住并实测能杀；两条 grep 判据：宿主侧无 `display` 藏法、仲裁模块无计时器） | — | `d378565` | — |
| U01 | overlay 位置改插件直传逻辑像素坐标，删头顶档与跟随定时器（[adr/0010](../adr/0010-badge-visibility-overlay-position-and-window-layering.md) 决策 2/3/4） | 本体命令 + 插件 | **已放行**（`.dispatch/ui-surfaces/cards/U01-overlay-position-api.md`，派单工作区、不入库，R4 口径；PM 冷重启实测 cargo 185→**189/0**、clippy `-D warnings` 与 fmt 退出码 0、`unit` 1236/0、`unit:migrate` 18/0、`check:shape` 48 全 0、`check:docs` rules=8 failing=0、tsc／typecheck:plugins／biome 143／`node --check` 全 0；真机带全 `PET_AGENT_CONFIG_FILES` + `PET_AGENT_INBOX` 冷启动：`verify` **271/0**、`verify:worker` 66/0、`verify:todo` 31/0、`win-zorder.ps1` 仍 **exit 0**（U02 的承诺没回退）。PM 独立变异 11 点：**10 杀**（缺省落点／宽度参与夹紧／高度 clamp／退回主屏取列表第一／retain 的窗口存在性／release_wanted 收意愿／list_row 常量／mark_wanted 起始不可见／签名 pin 的纯文本敏感版），1 点（参数改名）编译先拦；**M11 抓出真盲区**——调用点 `resolve_rect(y, x, …)` 对调能编译、表驱动照样绿、全套件无一红，PM 补 `overlay_show_passes_x_before_y_into_resolve_rect` 后同点杀掉，故 cargo 是 189 而非执行者自报的 188。audit-assertions 对 `verify-isolation.mjs`：249→250 唯一标题，**消失的 1 条已逐条对上**（改名，判定体与期望值一字未动）） | ~~U02~~ 已满足 | `134dfce` + `bfd9951`（PM 统合片：agent 套件的位置断言换到直传坐标口径） | — |
| U04 | 待办桌面卡片改插件自定坐标（原「三插件迁自定坐标」拆出来的 todo 片） | 插件 + 回归 | **已放行**（`.dispatch/ui-surfaces/cards/U04-todo-card-position.md`，派单工作区、不入库，R4 口径；PM 冷启动实测 `verify:todo` 31→**36/0**，同轮 z 序探针仍 **exit 0（pet-top）**、`verify:worker` 66/0、离线门全 0；变异两处都被点名的断言红掉 —— 运行时把 `overlay.show` 的 x/y 对调 → **3 failed**（三条落点/负例），离线给新输入项加白名单外属性 → `unit:migrate` 红。执行者纠正了卡片一处事实错误：`type` 在 `WIDGET_PROPS` 而非 `WIDGET_ATTRS`，按卡面写会被宿主判非法 op） | ~~U01, U03~~ 已满足 | `ba10739` | — |
| U05 | SDK / HANDBOOK 契约面 + B3 卡片范围重划 | 文档 | **已放行**（PM 自留，本波最后一张。改了七份文档 + 三处代码文案：SDK 的 `overlay` 能力行与 §6 摆放段按现行契约重写（逻辑像素直传、宿主只夹紧、`placement` 接受但忽略、已存在窗再 show 会同时挪位置和高度、本体永远压住 overlay 且判据用真窗次序）、新增 §5.2 徽标可见性仲裁（同刻只显一个、5 秒按启用清单序轮、**空态什么都不挂**、藏法禁 `display:none`、一个插件内多条内容由插件自己轮）、§5 的必读清单加第 5 条、词表段钉死「`type` 只能走 property、`name` 只能走 attribute」（两位执行者各撞一次，第二次留下 `unit:migrate` 18/0→17/1 的原文）、`apiVersion` 那行写明"这把旋钮只管 widget 渲染契约，overlay 与徽标都不动它"；HANDBOOK 硬性规则 +2、坑表 +4、自检清单重写（含"别拿 verify 条数当门"与"落点要用非对称坐标"）；ADR-0003 加一节**依 ADR-0010 的修订**，把三处依赖 `above-pet` 的表述按现状重读，并明写"卡现在漂在 (24,24) 不等于 B3 已完成"；B3 / A9 两行按决策 6 重划范围；CONVENTIONS 那条 2026-09-30 的实测记录加时间限定 + 现状指针；ARCHITECTURE §4 两行注释补齐新职责。代码文案三处：`prefs.js` 的模式名、`views/overlay.js` 的段注释、`verify-astock.mjs` 的「左上角盯盘卡可见」→「盯盘卡可见（位置由插件自定）」（改名映射：判定体 `is_visible` 轮询一字未动）；同轮 `verify:astock` **158 passed / 0 failed**、`check:docs rules=8 failing=0`、`unit` 1236/0、`unit:migrate` 18/0、tsc / typecheck:plugins / biome 143 / `check:shape` 48 全 0）；**当时另记的两处文案统合**：`prefs.js:19` 的模式文案「桌面左上角盯盘卡」与 `verify-astock.mjs` 的标题「左上角盯盘卡可见」在位置可自定后已不准确（U07 执行者点名、本波未改，改文案要连标签带标题一起动再复跑一轮出网套件）；docs 侧 `above-pet` / `corner` 的残留引用清点已在 U07 回传里给出，**这两处已由 U07（`e02a68e`）落地** | ~~U01, U03, U04, U07~~ 已满足 | 本次提交 | — |
| U06 | 补 T14 施工图**真剩下**的 2 条运行时断言（原口径「7 条命令补 12–14 条」已由 `91fd80b`/T15 做完 15 条） | 回归 | **已放行**（`.dispatch/ui-surfaces/cards/U06-leftover-t14-assertions.md`，派单工作区、不入库，R4 口径；派卡前逐条对账 21 候选：14 条已在套件里、真剩 2 条、4 条砍掉并写明理由，其中「设置页『测试』按钮」那条**物理前提不成立**（`src/settings/sections/hotkey.ts` 只有 input/save/reset/status 四个元素）；PM 实测 `verify` 271→**273/0** 且两条新标题以 OK 出现（不是 `r.info` 跳过），变异按执行者预先写出的红条件下靶 —— 掐掉 `hotkeys.rs` 成功分支的 `unregister` 后 **272/1，红的恰好只有那一条**） | ~~U01~~ 已满足 | `74077bf` | — |
| U07 | 盯盘悬浮卡改插件自定坐标（与 U04 同构的 astock 片） | 插件 + 回归 | **已放行**（`.dispatch/ui-surfaces/cards/U07-astock-card-position.md`，派单工作区、不入库，R4 口径；PM 冷启动实测 `verify:astock` **159/0** 且四条新落点标题全在场 —— 该套件出网、条数随盘面形态漂，判覆盖比标题集合；变异：x/y 对调 → **6 failed**（三条点名 + 三条同套件连带，记下来：这套件断言彼此不独立），离线加白名单外属性 → `unit:migrate` 红；执行者留下了真实的红→绿原文（按卡面 attr 写法时 18/0→17/1）） | ~~U01, U03~~ 已满足 | `e02a68e` | — |
| U08 | 收尾两笔欠账：本体压 overlay 的第二重放点了结 + 同意框应答泵的偶发红（**PM 自留，无执行卡**） | 本体窗口 + 回归脚本 | **已完成**（#69 三态实验：V0 两处都在／V1 只掐 `apply_visibility` 逐扇重放／V2 只掐 `pet.rs` 整体重放，各 **278 passed / 0 failed**、`win-zorder.ps1` 每态三次采样一致 pet-top → 第二重放点无法被证明独立必要，连同唯一调用它的 `raise_above_pet_all` 一起删掉，结论记在 [adr/0010](../adr/0010-badge-visibility-overlay-position-and-window-layering.md)「修订」；新增真窗断言一组 5 条（`r.check` 唯一标题 252→257、消失 0 条），并把 `win-zorder.ps1` 的结论补成纯 ASCII 机器行 `ZORDER samples=… verdict=…`。#70 根因：pump 把「窗口出现在 CDP 列表」当成「已渲出内容」，抢在 `consent_details` 回来之前读+点，于是「探针首次调用弹出的同意框列出了 agent:hooks」三轮红一次；改为轮询到 `#cap-list li` 出现再读点（最多 4 秒，超时仍应答）+ 新增硬失败「pump 应答过的每一扇同意框都渲出过内容」（75→76、消失 0 条），两轮冷启动各 **80/0**。变异 `mutate-check` 2 点 **killed=2 survived=0**（M-A1 让 pump 不等渲出 → 新那条与探针那条一起红；M-B1 让 `raise_above_pet` 首行早退 → **全套件唯一红的就是新加的那条**，实得 `verdict=overlay-covers-pet`）。复跑门禁：cargo 189/0、clippy `-D warnings` 与 fmt 退出码 0、`unit` 1236/0、`check:shape` 48 全 0、`check:docs` rules=8 failing=0、tsc／biome 全 0） | — | `bfa3112`（窗口层）+ `40cc843`（应答泵）+ `aca1563`（文档） | — |

**两处调度纠正（2026-10-10 规划方复核）**：

1. **B4 不能与 B2 并行**。两卡都要改 `src-tauri/src/commands/agent.rs`、`src-tauri/src/lib.rs`、`tests/e2e/verify-agent-bridge.mjs`，同一工作树里并行改同一批文件必然互相覆盖；且 B4 的验收本身以「B2 迁移后的断言基线」为准。已把 B4 的 Blocked by 改成 B2。
2. **B3 的 60 字上限与气泡几何矛盾，必须先由 T04 定行数**。实测：气泡 `max-width` 就是立绘宽 266px，扣掉左右各 12px 内边距后内容宽 242px，12px 字号下约 **20 个汉字一行**；常驻行若给 60 字就是 **3 行 = 73.6px**，而头顶到窗口上沿只有 **47px**（`--pet-bubble-bottom` 让气泡底边落在 y=55）—— 顶边会到 -18.8px，**必然被裁**，而 B3 自己的验收第 153 行就要求"没有溢出宠物窗上沿"。若常驻行与台词还要同时可见，余量更不够。所以 B3 的字数上限与"两行是否共存"要等 T04 的取证结论一并定，不先写执行卡。
   **已解（2026-10-12）**：T04 回传后定为「常驻行 1 行 + 与台词共享一个槽」，60 字作废、改为 20 字输入上限 + 渲染态几何判据，
   同屏两层被几何否掉（要它就得加高窗口，那是另一个决定）。数字、被否掉的三条路与理由记在
   [adr/0003](../adr/0003-session-visibility-on-pet-bubble.md) 的「修订」一节，B3 的卡片照修订后的口径写。
3. 另外：所有需要跑 `npm run verify*` 的卡实际上**互斥**（CDP 端口 9223 固定 + 单实例锁 + 会起 GUI），排批时按串行处理，不与只读取证卡混在同一批。
4. **A9 已拆成 A9a / A9b（2026-10-12，B2 放行当天发现的真空窗）**：B2 按 ADR-0001 删掉了宿主设置窗那张
   「Agent 事件接入」卡片，但 agent 桥还没有自己的 hook 装/卸入口 —— 于是**从 B2 落地到 A9 落地之间，界面上没有任何地方能安装或卸载 hook**
   （已装好的条目照常工作，因为配置文件是持久的）。原 A9 还同时压着 B3（常驻行）与 B4（多 Agent 单选）两个依赖，排在最后，
   等于把这个空窗留在整波的尾巴上。拆开：**A9a 只依赖 B2，提到批次 3 优先补上入口**；A9b（去会话卡片 + 多 Agent 单选）留到最后。
   这也是"删入口"类改动的通用规矩：**卡片删除必须和替代入口同批或更晚**，下一波别再分开派。

状态词表沿用 PLUGIN-BACKLOG：`待排` / `已派` / `进行中` / `待评审` / `已放行` / `搁置`。
术语与决策见 [../../CONTEXT.md](../../CONTEXT.md) 与 [adr/0001](../adr/0001-agent-hooks-capability-in-plugin-page.md)、
[adr/0002](../adr/0002-single-agent-linkage-uninstall-then-install.md)、[adr/0003](../adr/0003-session-visibility-on-pet-bubble.md)。

## 2. 卡片

### S1 发布 0.2.0 便携包 · 状态：**已完成**（2026-10-16 规划方执行；用户当次直接要求出包，B3/B4/A9b 未落地，按当期 main 切）

- **2026-10-16 出包完成**：
  - 版本号五处 0.2.0 一致（`93a6eef`）：`package.json` / `package-lock.json`（两处）/ `tauri.conf.json` /
    `Cargo.toml` / `Cargo.lock`；exe 元数据 `FileVersion=0.2.0`。
  - 构建 `npm run tauri build -- --no-bundle` 0 退出；exe 7,376,384 B，
    mtime 20:26:47 晚于 `src/` + `src-tauri/` 最后提交（`93a6eef`，20:24:08）。
  - 发布门槛 `npm run verify:release` **30 passed / 0 failed**（响应头 CSP、探针 eval 被拒、打包版图集解码、
    Worker realm 激活与挂载、跨插件存储隔离、无 CSP 违规）—— 本包已在本机复跑，`更新说明.txt` 按实测口径写。
  - 产物：`release-package/DesktopPet-0.2.0/`（`desktop-pet.exe` + `plugins/` 四插件 40 文件 + `更新说明.txt`）
    + `DesktopPet-0.2.0.zip`（43 条目，中文文件名带 UTF-8 标志 bit11=1，解压实测按 `更新说明.txt` 命中且大小一致）。
  - 未验项照旧：装机运行（NSIS 安装器）—— 用户 10-16 选择不做；本包为便携包，不涉安装器。
- **为什么在本池里**：发布不是开发任务，验收手段（跑构建、核对产物、验打包版 CSP）只有规划方有上下文。
- **产物口径（已定，别改）**：`release-package/DesktopPet-<版本>/` = `desktop-pet.exe` + 旁边的 `plugins/` + `更新说明.txt`，
  外加同名 zip。**不是 `dist/`** —— `dist/` 是 Vite 输出目录，任何 `npm run build` / `tauri build` 都会清空它，本项目已因此丢过两次成品包。
- **构建**：`npm run tauri build -- --no-bundle`（前端 tsc+vite 已过）。插件是磁盘加载，改 `plugins/` 不需要重编本体。
- **出包前必查**：`src-tauri/target/release/desktop-pet.exe` 的 mtime 必须**晚于** `src/` 与 `src-tauri/` 的最后一次提交，
  否则是过期二进制。S1 就撞上了：exe 是 2026-09-06 的 0.1.0，落后 4 天的代码。
- **发布门槛**：`npm run verify:release` 全绿（打包版 CSP 只在打包产物里强制，dev 不注入 CSP、测不出来；
  验 CSP 不能用 CDP/DevTools 发起的求值，那不受 CSP 约束，要看页面自身代码的副作用）。
  用户当次明确免跑时，`更新说明.txt` 里**不得声称本包已验**，改写成「回归在开发机完成 + 本包未复跑」。
- **本轮已知障碍（2026-10-10 实测）**：360 安全卫士会在 build script 刚写盘的一瞬间锁住
  `src-tauri/target/release/build/*/build-script-build.exe`，cargo 报 `拒绝访问。(os error 5) (never executed)`。
  文件没有被隔离 —— 手动执行同一个脚本立刻 0 退出。**结论：这是瞬时拦截，重试即可；不要删 `target/`，不要怀疑代码，不要动安全软件。**
  本机 Defender 实时防护是关闭的，360 是唯一拦截者。
- **NSIS 带打包：2026-10-16 实测跑通（此前记在提交信息里的「这台机器跑不通」已否证）**
  `npm run tauri build`（不带 `--no-bundle`）连跑两次都 0 退出：第一次下载工具链并解压，
  第二次 **2m22s**、日志里没有一行 `Downloading` —— 说明 `%LOCALAPPDATA%\tauri\NSIS` 落成之后就会被复用。
  产物 `src-tauri/target/release/bundle/nsis/DesktopPet_0.1.0_x64-setup.exe`（2.50 MiB，
  sha256 `b7f43a53d0c5eed484967059334539089a1f7189bf78790e1002f2728b5f227a`），已按上面的产物口径
  存进 `release-package/`（**不往 `dist/` 放**，那里每次构建都被清空）。
  **当时为什么会红**：缓存里留下的是半个 `nsis-3.11` 目录，而 bundler 要的是名为 `NSIS` 的那个 —— 目录名不对它就去重下，
  而那时 GitHub release 资产拉不通就成了 `timeout: global`。是不是同一条 360 瞬时拦截（被锁的换成刚解压出来的
  `makensis.exe`／改名那一步）**没有现场证据，别写成结论**。今天探了一次：
  `curl -o /dev/null -w` 打 `nsis-3.11.zip` 得 `http=200 / 9.3s` —— **release 资产通路和 A股 push2 一样是状态量**，
  下次这条门红，先探 URL 再定性，别急着改配置。
  **仍然没证明的**：装机运行（静默 `/S /D=` 装到 temp、跑一轮真装机布局的断言、再卸载）。用户 2026-10-16 明确选择不做，
  所以别把「能构建」写成「打包版安装后已验证」。`verify:release` 走的是 `target/release/desktop-pet.exe`
  （`resource_dir()/plugins` 的解析路径与装机布局同形），覆盖的是 CSP 与插件加载，不是安装器。
- **收尾**：`git status` 复核提交里有无凭据；版本号四处一致（`package.json` / `package-lock.json` /
  `tauri.conf.json` / `Cargo.toml` + `Cargo.lock` 的 `desktop-pet` 条目）。

### B2 `agent:hooks` 受控能力 —— 钩子配置从设置窗移交到插件页 · 状态：**待排**

- **任务**：让插件自己的设置页能查询/安装/卸载 Agent hook；「宠物设置」里那张「Agent 事件接入」卡片整体删除。
- **任务类型**：本体功能 **+ 安全边界变更**（本项目第一次把能改别人应用配置的能力开给插件，先读
  [adr/0001](../adr/0001-agent-hooks-capability-in-plugin-page.md)，验收按它核对，不要自己重新论证）。
- **必读**：[../../CONTEXT.md](../../CONTEXT.md)（「生命周期」四个动作的定义）、AGENTS.md「跨会话生效的系统级开关一律只认设置窗」那条约定、
  `src-tauri/src/gate.rs`（含头注释里的信任模型说明）、`src-tauri/src/commands/agent.rs`、
  `src-tauri/src/services/agent_hooks.rs:1-130`、`src/runtime/bridge.ts:42-95`（`ensurePermissions`/`gated`）、
  `src/runtime/widget-host.ts:86-90`（widget ctx 现在只有 `ScopedBus`）、`src/runtime/topic-acl.ts`。
- **实况纠偏（写死在这里，免得接活者重新猜一遍）**：插件 `settings` 区的 widget 是 `src/settings/main.ts` 里
  `widgetHost.mount(manifest, "settings", box)` 挂的，**跑在设置窗 realm**，所以 `gate.rs` 的 `label=="settings"`
  对它本来就成立；缺口只有一个 —— widget ctx 没有 invoke 通道。**不要为了"放行"去改门禁判定**，
  那既没必要，也会把注释里的信任模型一起改错。
- **边界（只准动这些，其余一律不碰）**：
  - `src-tauri/src/gate.rs`、`src-tauri/src/commands/agent.rs`、`src-tauri/src/lib.rs`（仅命令注册处）
  - `src/runtime/bridge.ts`、`src/runtime/widget-host.ts`、`src/runtime/topic-acl.ts`
  - `src/settings/main.ts`、`src/settings.html`
  - `docs/plugin-dev/PLUGIN_SDK.md`（§3 能力表加一行）、`AGENTS.md`（改那条约定的含义）
  - `tests/e2e/verify-isolation.mjs`、`tests/e2e/verify-agent-bridge.mjs`（只做断言迁移，不做功能改动）
  - **不得**动 `plugins/com.pet.agent-bridge/`（归 A9）、`src/main.ts` 与 `src/pet/`（归 B3）、`services/agent.rs` 的收件与归一化、
    `tauri.conf.json`、CSP。
- **方案约束（已定，别再选）**：
  1. 能力名 `agent:hooks`，必须 manifest 声明；首次调用走 `permission_request` 同意框（复用 `gated()`，不要另写一套授权模型）。
  2. 注入面**只在 `region === "settings"`**：给 widget ctx 加 `host.agentHooks.{status,install,uninstall}`；
     `badge` / `overlay` 区与宠物窗主 realm 的插件上下文**不注入**。这是本卡唯一的新攻击面，越窄越好。
  3. Rust 三个命令增加可选 `pluginId`：**不带** = 宿主自己的调用（撤销授权的确认框要用），照旧只过 `gate::settings`；
     **带** = 插件调用，额外逐项校验 `agent:hooks`。别把宿主路径也绑上 pluginId —— 那会让撤销流程依赖插件还活着。
  4. `commands/agent.rs:3-6` 的注释现在写着「权限比任何插件能力都高……插件即便绕过 JS 桥直接 invoke 也拿不到这个入口」，
     **必须改写**成 ADR-0001 的口径：挡的是别的窗口，不挡同 realm 的主动越权（那条缺口要等 Web Worker 宿主才收口）。
     留着旧注释就是给下一批人一个假安全感。
  5. `src/settings/main.ts:360-435` 的 `renderAgent/runAgentAction/wireAgentBox`、`:574-575` 的启动调用、
     `src/settings.html:83-96` 那张卡片，**一起删干净**，不留"以后可能还要"的死代码。
  6. 撤销授权的连带卸载确认框由**宿主**弹（撤销入口在宿主壳里，插件拦不到这一步）：默认勾选「同时卸载 hook」，
     用户可以只撤能力。选「连带卸载」时复用 uninstall 那条路径，不要另写一份删除逻辑。
- **MVP 范围**：上面 6 条 + 断言，做完就停。
- **明确不做**：多 Agent 注册表与切换事务（B4）、气泡显示（B3）、agent 桥插件侧任何改动（A9）、
  hook 写入格式与幂等策略的调整（`strip_managed`/`append_managed`/`backup_once`/原子写全部照旧）、
  自动安装 hook、动 `PET_AGENT_CONFIG_FILES` 这个开发覆盖入口的语义。
- **验收**（下限，**断言只许变严**）：
  - `cargo test --lib` ≥ **70**；新增：带 `pluginId` 且未声明 `agent:hooks` → install/uninstall 被拒；
    不带 `pluginId` 的宿主路径仍通；`overlay-*` 窗发来的调用被 `gate` 拒。
  - `npm run verify` ≥ **147**；新增：未声明能力的插件在 settings 区调用 → 被拒且弹同意框；声明并同意后 → 装得上、
    `status` 回显对得上；`badge`/`overlay` 区 ctx 上取不到 `host.agentHooks`（断言 `undefined`，**不是**断言"调用报错"）；
    宠物窗主 realm 里直接 `invoke("agent_hooks_install")` 被拒（label=pet）。
  - **`verify-agent-bridge.mjs:459-462` 那三条「插件调用被拒」断言不许整组删** —— 新模型下 settings 区调用是合法路径，
    要改写成「badge/overlay 区仍被拒 + settings 区经能力校验后才放行」这两条更强的断言；迁移后该文件总数不得少于 **50**。
  - **只删自家条目**（P0）：构造一份含他人 hook 条目的样例 `settings.json`，走完 install→uninstall 后断言
    `--pet-hook` 条目归零且**别人的条目逐字节未变**。
  - 撤销授权确认后两条分支都要有断言：「连带卸载」→ 配置文件干净；「只撤能力」→ 文件保持装好状态且能力缓存失效。
  - 动了 `src/settings.html` → 必须跑 `npm run verify:release` 且 ≥ **12** 全绿。
  - `git diff` 复核：出现 `src/main.ts`、`src/pet/`、`plugins/` 的改动就是越界，直接打回。
- **落地后回改（规划方做，接活者在提交说明里提醒即可）**：AGENTS.md 那条约定补上"指 realm、不指宿主独占"，
  `agent:hooks` 进能力名清单与 PLUGIN_SDK 表格，README 功能清单同步。
- **交付**：git 提交（不 push）、temp 清空、无遗留进程、`cargo test` + `verify` + `verify:release` 尾部汇总与退出码粘贴、
  改后的 `commands/agent.rs` 头注释原文。

### B3 本体气泡 —— 常驻状态行与节点台词分层 · 状态：**待排**

- **任务**：气泡除了 3.6 秒自动收起的一次性台词，还要能挂一行**常驻**状态文字（随事件刷新、不定时消失）；
  常驻行存在期间宿主的随机自言自语让路。
- **任务类型**：本体功能。先看 [adr/0003](../adr/0003-session-visibility-on-pet-bubble.md)，那里记了为什么不选"只播报节点"和"两行容器"。
- **必读**：`src/main.ts:15`、`:50-57`（`syncLayout` 写 CSS 变量）、`:61-67`（`say()`：`textContent` + 3600ms 收起）、
  `src/styles.css:43-84`（`max-width:var(--pet-size)` ≈ 立绘 266px、`::after` 尾巴、`pointer-events:none`）、
  `src/runtime/bridge.ts:160-174`（能力校验、压换行、截 200 字）、`src/pet/host.ts`、`src/pet/dialogue.ts:6-24`、
  `src/pet/click-through.ts:107-117`、`src-tauri/src/window/pet.rs:39-51`（`set_pet_hidden`）、`src/pet/game-mode.ts:33-44`。
- **边界**：`src/main.ts`、`src/pet/host.ts`、`src/pet/dialogue.ts`、`src/styles.css`、`src/runtime/bridge.ts`、
  `docs/plugin-dev/PLUGIN_SDK.md`、`tests/e2e/verify-isolation.mjs`、`tests/e2e/verify-agent-bridge.mjs`（只配合迁移断言，不改插件）。
  **不得**动 `plugins/`、`src-tauri/`（本卡预期零 Rust 改动）、`tauri.conf.json`、CSP、overlay 机制、状态机优先级队列。
- **方案约束（已定）**：
  1. 新增显式能力 **`pet:status`**，不复用 `say()` 的第二参数 —— "自动收起"是 `say` 的语义核心，
     塞 sticky 会让已有插件的行为漂移；权限也要能单独撤销。
  2. `setStatus(text)`：非空字符串 = 常驻并立即刷新；`null`/空串 = 清除。**按持有者唯一**：
     第二个插件来申请时拒绝并 `ctx.log` 写清谁在持有（口径对齐 BLE 会话的持有者计数），不许静默覆盖。
  3. 宿主必须在 **widget unmount / 插件 deactivate / 撤销授权** 三条路径上强制清除自己发出去的常驻行 ——
     不能指望插件自觉，否则会出现"插件已经没了、宠物头顶还挂着别人的会话状态"。
  4. 长度：**常驻行按「至多 1 行」实现**（输入侧上限 20 个全角字，超出截断加 `…`；渲染侧由 CSS 保证单行）。
     原写的 60 字作废 —— T04 实测 60 字 = 3 行 = 73.6px，而气泡底边只有 55px，顶边 −18.6px 必被裁。
     仍沿用「压掉换行 + `textContent`」，**不许**拼 HTML。**判据是几何不是字数**：字数是按全角宽推算的，
     真字体折行差 1 字就会退回被裁，验收必须读 `getBoundingClientRect()`。
  5. 常驻行存在期间 `dialogue.ts` 的随机台词与 `wake` 自语**跳过本次**（不是排队到后面补播），常驻行清除后自然恢复。
  6. 节点台词与常驻行**共享一个气泡槽**（台词优先占用，收起后常驻行回位）—— 不是同屏两行，理由与数字见
     [adr/0003](../adr/0003-session-visibility-on-pet-bubble.md) 的「修订」一节。
     "分层"指的是**状态分层不是位置分层**：台词收起不能顺带清掉常驻行。
     实现上要么单元素 + 常驻文本状态机，要么拆两个元素由 CSS 保证不叠加 —— 验收只认断言，不认写法。
  7. 游戏模式：常驻行随宠物窗整体隐藏，恢复显示时若仍持有就**要重新出现**，不许"回来后发现没状态"。
- **明确不做**：不改气泡字号/配色/动画、不做两行容器、不做打字机效果、不给插件控制样式、
  不动 `react()` 的状态机优先级、不改 overlay 的 above-pet 跟随机制。
- **验收**（下限）：
  - `npm run verify` ≥ **151**，且 `4a7a05d` 新加的那 4 条气泡几何断言（居中、宽度不超立绘）继续全绿。
  - 常驻性：`setStatus` 后等 **>5 秒**（跨过 3600ms）文字仍在；`setStatus(null)` 后立即消失。
  - 分层：常驻期间调 `say()`，等台词自己收起后断言常驻行**未受影响**（这条是分层的唯一证据，不能省）。
  - 生命周期三条路径各一条：unmount / deactivate / 撤销授权之后气泡区域干净（断言 `textContent` 为空，不是"没报错"）。
  - 持有者唯一：第二个探针插件 `setStatus` 被拒，且第一个插件的常驻行**没被覆盖**。
  - 截断：喂 200 字 → 断言渲染出的文字 ≤20 字，**且读 `getBoundingClientRect` 证明它只有 1 行**
    （`top ≥ 0` 且高度 ≤ 单行行盒 ≈35.2px），别只看长度。
  - 自语让路：触发一次 dialogue，断言常驻行存在期间台词没有写进气泡。
  - 穿透：常驻行显示期间，鼠标停在气泡区域仍判定 not-inside（沿用 `click-through.ts` 的断言形式）。
  - `npm run verify:game` ≥ **15** 全绿（动了显隐）；动了 `src/styles.css` → 跑 `npm run verify:release` ≥ **12**。
- **交付**：git 提交（不 push）、temp 清空、无遗留进程、`verify` + `verify:game` 尾部汇总与退出码粘贴。

### B4 Agent 适配器注册表 + 单联动事务 · 状态：**待排**

- **任务**：把 `candidate_files` 里硬编的 `.qoder`/`.qoder-cn` 变成「一个 Agent 一个适配器」的注册表，
  提供一条事务式的"当前联动只有一个 Agent"切换命令；`qoder` 行为一字不变，`zcode`/`codex`/`dsh` 只留槽位。
- **任务类型**：本体功能。**范围是用户 2026-10-11 拍的**：本轮不许接线任何新 Agent，理由见
  [adr/0002](../adr/0002-single-agent-linkage-uninstall-then-install.md) 和下面的实测现状 —— 猜出来的事件名映射比不做更糟。
- **H1 已先行落地（PR-1，2026-10-17）**：插件启停与 hook 装卸的联动已住在
  `src-tauri/src/services/agent/linkage.rs`（判据、`agent` 显式选择、启动清理、
  `--pet-hook-cleanup`）。本卡接适配器时**必须继续走这一层**：`linkage::decide` 是「该装还是
  该卸」的唯一判据，`agent` 字段从「等于 qoder」放宽成「非空」是它唯一该改的地方；
  别在适配器里另起一套启停反应，那会把「停用摘掉、再启用恢复」这条已断言过的路绕开。
- **规划方已实测的现状（接活者不要重复取证）**：

  | Agent | 本机现状 | 结论 |
  |---|---|---|
  | `qoder` | `~/.qoder/settings.json`、`~/.qoder-cn/settings.json` 存在；结构 `{hooks:{<Event>:[{hooks:[{type:"command",command,timeout:2}]}]}}`；12 个事件名 | **唯一已验证**，本轮行为必须一字不变 |
  | `zcode` | `~/.zcode` 存在；`cli/plugins/cache/**/hooks/hooks.json` 有 `hooks` 字段，但官方插件样本是空的 `{}` | 事件名与用户级入口**未知**，只留槽位 |
  | `codex` | `~/.codex/config.toml` 只有 `[tui]`、`[model_providers.*]`，**无任何 hook 键**；`executor.config.toml` 同 | 是否支持 hook **未证实**，只留槽位 |
  | `dsh` | `~/.dsh` 不存在，从仓库与代码里都推不出它指什么 | 用户口径：只留 id 槽位，不接线 |

- **必读**：`src-tauri/src/services/agent_hooks.rs`（`candidate_files:162-177`、`strip_managed:31`、`append_managed:68`、
  `install_in_text:118`、`uninstall_in_text:126`、`backup_once:179`、原子写 `:192-208`）、
  `src-tauri/src/services/agent.rs:34-47`（`HOOK_PHASES` 的 `(事件名, phase)` 形状）、
  `commands/agent.rs:27-40`（`snapshot`）、`../../CONTEXT.md` 的「Agent 联动」与「生命周期」。
- **边界**：`src-tauri/src/services/agent_hooks.rs`、`services/agent.rs`（**只**许动事件名/适配器表，不许动 watcher 与归一化）、
  `commands/agent.rs`、`src-tauri/src/lib.rs`（命令注册）、`tests/e2e/verify-agent-bridge.mjs`、
  `docs/plugin-dev/PLUGIN_SDK.md`（若把选择器暴露给插件）、`AGENTS.md` 的 Agent 接入约定（改文案不改语义）。
  **不得**动 `src/`（B3 地盘）、`plugins/`（A9 地盘）、`services/http.rs`、CSP。
- **方案约束（已定）**：
  1. 适配器形状至少含 `{ id, 显示名, 候选配置文件解析, 事件名→phase 映射, 命令串模板 }`；`qoder` 用现有常量填进去，
     **写入格式与幂等策略一字不改**（`--pet-hook` 标记、先 `strip` 后 `append`、`backup_once`、`.tmp`+rename 全部沿用）。
  2. 未验证的槽位**不得进入默认解析**：注册表里有 id，但没有已证实的解析规则时 install 必须直接返回
     「该 Agent 的接入方式尚未验证」，**不许去猜路径写文件** —— 写坏别人的配置按 P0 处理。
  3. 新增命令 **`agent_hooks_switch({ pluginId?, agentId })`**：事务 = 卸旧 → 校验卸净 → 装新 → 校验；
     任一步失败**回滚原状**并回传失败文件与原因。顺序不许反（先装新会让两个来源同时往同一个 inbox 写，
     而 `agent/inbox/<phase>.jsonl` 的事件**没有来源字段**，归一化层分不开）。
  4. **「当前联动哪个 Agent」由宿主持久化**（授权表旁边一份状态），不能只存插件隔离存储：
     插件崩溃与宿主退出这两条路径插件自己碰不到，必须靠宿主状态把 hook 收掉（ADR-0001 后果一节）。
  5. 停用插件 / 关闭联动 → 按宿主持有的联动状态自动卸载 hook；**装**仍然要用户显式点按钮（本轮决定，不要自动装）。
  6. `snapshot()` 里 `installed = files.len() * expected == managed`（`commands/agent.rs:31/37`，`expected` 现在恒等于
     `HOOK_PHASES.len()`）改成按**所选适配器的期望条数**算；
     保留「装了但条数不对 → 报『需要修复』而不是『已安装』」这一档。
  7. `PET_AGENT_CONFIG_FILES` 覆盖入口保留，并让它能带适配器 id（测试要在不碰真实用户配置的前提下造出第二个适配器）。
  8. **条目路径与当前 exe 不一致要单独成档**（T03 实测的两条缺陷，见
     `.dispatch/A股盯盘质量加固/work/T03/hook-path-audit.md` 的 F13–F17/F19–F20，派单工作区、不入库，R4 口径）：
     `is_managed` 只认 `--pet-hook` 子串、不看路径，所以换 exe（dev 产物 ↔ 便携包）后条数仍是 12，
     `installed` 仍为 `true`，而 `snapshot()` 回给前端的 `exe` 是**当前** exe —— 界面会指着一条并不存在的安装说"已安装"。
     `snapshot()` 要新增逐文件判定（条目里的 exe 路径是否存在、是否等于 `current_exe()`），把这档叫作「路径过期」，
     并且**启动时只报告不自动改写**（自动改别人配置要用户显式点，口径同第 5 条）。
     **注意 B2 已经删掉宿主设置页那张卡片**，所以这档文案不能往 `src/settings/main.ts` 加 —— 只加到命令返回值，
     由 A9 的插件页显示。
- **明确不做**：不接 zcode/codex/dsh 的真实配置、不给事件加 `agentId` 字段（单联动语义下不需要，且是破坏性变更）、
  不做多 Agent 并行观测、不改 hook 超时（2 秒）、不做"扫描本机装了哪些 Agent"、不动收件目录布局。
- **验收**（下限）：
  - `cargo test --lib` ≥ **70**；新增：qoder 适配器 install/uninstall 的输出与本卡改动前**逐字节相同**
    （用现有单测样例做基线，不许改期望值来"过"）；未验证槽位调 install → 返回错误且**没有任何文件被创建或改写**
    （`temp_dir` 断言目录不变）；switch 事务：模拟"装新失败" → 断言旧条目**已回滚复原**且失败原因可读；
    期望条数按适配器算：12 条齐 → `installed=true`，缺 1 条 → "需要修复"。
  - 幂等与只删自家：连续 install 三次 → `managed` 恒为 12；同一文件里别人的 hook 条目一字未动。
  - `npm run verify-agent-bridge` 在 B2 迁移后的基线上**只增不减**（≥ **50**），新增：联动状态回显、停用自动卸载、
    撤销确认两条分支、切换失败回滚后宠物不再收到旧 Agent 的事件。
  - **两条方向相反的退出断言都要有**：宠物进程结束后 hook 条目**仍在**（退出时不该偷改别人的配置）；
    插件被停用**时**条目必须被收掉。只测其中一条就是漏。
  - 改了 Rust 与命令注册 → `npm run verify:release` ≥ **12**，且 `cargo tree -p tauri` 仍必须是 **2.12.0**。
- **交付**：git 提交（不 push）、temp 清空、无遗留进程、`cargo test` + `verify-agent-bridge` 尾部汇总与退出码粘贴、
  贴出 qoder 适配器 install 前后同一份样例配置的 diff（应为空或仅顺序稳定）。

### S2 P1/P2 加固 · 状态：**已落地待验收**（2026-10-17，本会话直接实施）

- 分支：`fix/p1p2-security-reliability`（本次提交）。方案全文 `docs/process/OPTIMIZATION-PLAN-2026-10-17.md`，
  决定与理由 [adr/0011](../adr/0011-consent-identity-and-subscribe-acl.md)。
- 改了什么（逐项）：
  1. `permission_request` 去掉 `plugin_name` 形参，名字只从磁盘 manifest 读
     （`commands/plugins.rs::manifest_display_name`）；前端 `bridge.ts` / `plugin-runtime.ts` 与三个 e2e
     的调用点同步去掉该字段；`permission.tests.rs` 的签名钉**加**了一条负向断言（谁把入参加回来就红）。
  2. `topic-acl.ts` 订阅侧收紧到 `PUBLIC_TOPICS`（在 `packages/sdk/topics.js` 新增，单一事实源）；
     `unit-sdk-topics.mjs` 反向钉住名单，`unit-capabilities.mjs` / `unit-widget-worker.mjs` 补正反用例。
  3. `pet.rs::set_click_through` 加 `gate::pet`，并改返回 `HostError`（不再 `let _ =` 吞错）。
  4. `worker-widget-host.ts` 的 `await booted` 加 15s 超时（超时 destroy + 抛错）。
  5. `store.rs` 的 per-plugin 锁表改 `Weak` + 顺手回收，新增两条单测（死条目被清、在用的锁不被换）。
  6. 裸 IPC 判据换成**传递 import 闭包**（新增 `tests/unit/import-graph.mjs`），三个套件里的手写正则删掉，
     并加了「单引号 + 隔一层的 host-error」负向对照防判据空转。
- **离线门禁（本机实测全绿）**：`npm run unit` **1249/0**（本轮基线 1236）、`check:docs rules=8 failing=0`、
  `check:shape failing=0`、`lint` / `build` 退出码 0；cargo 三件套见提交说明。
- **未验项（如实标注，不许当已验）**：
  - `npm run verify*` 一族**本轮未跑**（需真实桌面会话 + CDP 9223 + 冷启动实例，见 §4 那条「改过 `src/` 必须先冷重启」）。
    受影响的断言已逐条按现有口径核对「应当仍成立」：同意框名那几条断的是 fixture 的 manifest 名（与新口径同值）、
    现场 topic 全在公开名单内、`verify-isolation` 的 settings 区探针组依赖 `host:widget-realm-plugin-host`
    而本轮**没动**例外名单分流（那是 S3），前提未变。**「核对过」不等于「跑过」，验收方必须冷启动复跑。**
  - `verify:release` 另需打包产物，未跑。
  - **欠一条 e2e**：widget 起不来时 `mount()` 要在超时内失败（第 4 项只落了实现与常量，
    这段没有可离线钉住的接缝 —— 真行为在 Worker 里）。派给下一次有桌面会话的批次。

### S3 settings 区强制进 Worker · 状态：**待排**

- 目标：`settings` 区的插件 widget 不认例外名单，一律进 Worker。因为设置窗的 realm 就是宿主壳的 realm，
  而设置窗的命令门禁只认 `window.label()` —— 插件代码落在那里即拿到宿主级命令
  （`permission_revoke` / `plugin_enabled_set` / `autostart_set` / `hotkey_set` / `pet_skin_*` / hook 安装）。
- 为什么本轮没做（**别当成"改一行就完"**）：`verify-isolation.mjs` 的「agent:hooks 受控能力（settings 区专属）」整组，
  靠 `localStorage` 把 `zz.probe` 点名留在宿主 realm，探针要把事实写进 `window.__hookProbes`；
  且它的 manifest **没写 `apiVersion`**（= 旧接口）。settings 区一律进 Worker 之后，该探针会被判 legacy →
  `mountNotice` 拦下 → 该组 12+ 条断言当场变红。探针按设计必须在宿主 realm 才能自证，
  所以要么把它改成 Worker 契约（`ctx.dom` 建节点 + 自己 `bus.publish` 回传事实），要么换区域再另想办法验 settings 区。
- 边界（白名单）：只准动 `src/runtime/widget-host.ts`、`src/runtime/widget-protocol.ts`、
  `tests/e2e/verify-isolation.mjs`、`tests/e2e/verify-release.mjs`、`tests/unit/unit-widget-protocol.mjs` 与相关文档。
- 已定口径：旧接口 widget 在 settings 区的正确表现是**被拦下并给出可读原因**，不是「留在宿主 realm 跑起来」。
- 验收：`npm run unit` 新增「settings 区忽略例外名单」的纯逻辑钉并全绿；桌面会话冷启动复跑
  `verify-isolation` / `verify-release` 全绿，且探针按新契约重写后仍覆盖
  「settings 区拿得到 `ctx.host.agentHooks`、badge/overlay 区拿不到」这条不变量。

## 3. 验收证据矩阵（本体改动必须跑哪个套件）

| 改动落点 | 必须跑 | 上一轮实测断言数（**下限，不许倒退**） |
|---|---|---|
| `src/pet/`（状态机、图集切片、点击穿透、气泡） | `npm run verify` + `npm run verify:skin`（动了形象/协议）+ `verify:game`（动了显隐） | verify **189** / skin 26 / game 15 |
| `src/runtime/`（插件运行时、bridge、widget 宿主、订阅回收） | `npm run verify` | **189** |
| L1 Worker 插件宿主（`src/runtime/plugin-worker.ts`、`plugin-worker-protocol.ts`、`worker-plugin-host.ts`，开关是宠物窗 localStorage 的 `host:worker-plugin-host`） | `npm run verify:worker` + `npm run unit:worker-host` + `npm run verify:release` | worker **25**（2026-10-14 原型首日：装载 1 + realm 事实 7 + 相对子模块 2 + 协议层伪造 5 + `?v=`/`no-store` 4 + todo 跑通 3 + 回收 2 + 零噪音 1）/ unit:worker-host **118**（22 方法表、派发表完备、Worker 侧禁带裸 IPC）/ **release 24**（其中「L1 Worker 宿主在打包版 CSP 下成立」一组 14 条，在全新构建上复跑过 —— ADR-0006 打包版那条前提已闭合）。L2 的输入是 `reference/T16-*`：入口闭包零 DOM，338 行 DOM 全在 widget 图 |
| `src-tauri/`（Rust 能力服务、gate、fsutil、hotkeys） | `cargo test --lib` + `npm run verify` + 对应 `verify:<域>` | cargo **144** / verify **234**（S/Q/C1 之后。verify 的条数随同意框是否真弹在 215~234 间浮动，**下限按 215**；2026-10-13 实测 219 即落在该区间内，A1 那波起实例实测 230/0。cargo 由 121 → 131（H2）→ **144**（A1 的 13 条新规则单测）） |
| `http` 能力 / charset 解码 / 重定向 | `npm run verify:http` | 21 |
| Agent hook 链路 | `npm run verify:agent` | **72**（A9a 加了插件页端到端组；当批实测 `cargo` 72 / `verify` 189。本波只改了 overlay/bus 门禁那条采样路径，verify:agent 72/72 复跑过） |
| 待办链路 | `npm run verify:todo` | 30（C1 后复跑 30/30） |
| A股插件 | `npm run verify:astock` | **154**（盘中形态实测：盘口两侧都有档 + 分时有数据 + 北交所有源供历史 + `session.trading` 为真 + 无异常留证分支；同形态两轮 154/0）。**这个数随数据形态浮动，不能当恒定下限** —— 五处分支各自产不同条数：① `verify-astock.mjs:473` 的 `session.trading` 守卫（盘中 1 条 / 非盘中 0 条，只出一行 info，**这是 153 与 154 最常见的差**：2026-10-13 12:44 午休跑出的就是 153）；② 分时那一段失败时 1 条（有数据时 2 条）；③ 北交所判「不供历史」3 条（成功出图 1 条）；④ 三源全不通的现场支与离线注入支条数不同；⑤ `!gotSug` / `!hasQuote` / `cardTarget` / `!cardGone` 四个异常留证支各多 1 条，`catch` 里那条「脚本未抛异常」只在崩溃时出现。验收时用 `audit-assertions.cjs` 把报告里的标题集合与源码里的 check 点做差，**比标题不比数字** |
| `plugins/com.pet.astock` 的纯函数（三源解析 / 节流 / 提醒判定 / 五档数据 / 源判定层） | `npm run unit:astock`（常驻单测，零 GUI、零联网、秒级） | market **247** / aux **186**（含 A11 的 `sourceBranch` 组 36 条；Q2 起跑在 `node --test`，读 `ℹ tests 433 / fail 0` 与 `ASSERTIONS` 分组计数） |
| `src/` 运行时纯逻辑（状态机、topic ACL、总线、插件 URL、manifest 校验、资源回收） | `npm run unit:runtime`（离线，靠 `tests/unit/ts-loader.mjs` 转译 .ts） | runtime **107**（Q3 + C1 的启停清单迁移；`npm run unit` 合计 **811**） |
| 插件纯函数（`plugins/com.pet.todo/todo-txt.js`；hr-ble 的 BPM 解析在 Rust，归 cargo test） | `npm run unit:plugins` | plugins **53**（Q4；`npm run unit` 合计 **811**） |
| 任何新增脚本 / 协议源 / CSP / 打包相关 | `npm run verify:release` | 12 |
| Cargo 依赖变动 | `cargo tree -p tauri` 必须仍是 **2.12.0**，且 `npm run verify:release` | — |
| 文档与磁盘一致性（改 `ARCHITECTURE.md` §4 目录树、README 目录速览、搬文件/建删模块、改 ADR 链接、动 `AGENTS.md`、往文档里写路径坐标） | `npm run check:docs`（CI 里 `npm run unit` 之后一步，见 `.github/workflows/ci.yml`） | **rules=8 failing=0**、退出码 0。八条：R-A md 相对链接可达 / R-B §4 树对 `src-tauri/src/services/` 双向（`disk=12 doc=12`）/ R-C 速览点名的插件 id 齐 / R-D 反引号路径 token 存在 / R-E 链接文字与目标名一致 / R-F `AGENTS.md` ≤6000 字节 / R-G **§4 全树双向**（正向逐条 existsSync、反向按顶层目录；`tree=99`）/ R-H **坐标对读者可达**（清单 R4）：反引号里的盘符绝对路径直接判红，指向派单工作区 `.dispatch/…` 的引用必须同行写「不入库」，现场读数 `checked=19 exempted=2 broken=0`（豁免常量只有一条＝仓库外那份历史重写备份目录，`exempted=2` 是它在两处出现；豁免带出处、进 `EXEMPT_TOKENS`）。R7（`e2e63c7`）交付前六条、R8 补出 R-G、R4 补出 R-H：清单 32 项那句「删一个模块而文档未改时 CI 变红」从那一刻起才对**整棵树**成立，此前只对 services 成立。**加规则不许削既有读数**，且新增例外一律进 `EXEMPT_*` 常量表带出处理由 |
| 命令层形状（新增或改动任何 `#[tauri::command]`） | `npm run check:shape`（CI 里跟在 `check:docs` 之后） | **commands=48 s1=0 s2=0 string_err=0 failing=0**。三条机械判据：S1 命令体禁 IO 原语、S2 命令体非空行 ≤20（A1 / [ADR-0005](../adr/0005-command-layering-thin-command-bodies.md)）、S3 命令 Err 侧必须是 `HostError` 的 `{code, message}`（A2 收口后升成拦截项，2026-10-14）。首跑 8 处违例已全部修掉，读数中位数 9 行、最大 20 行；「业务规则要住在可单测的函数里」这一维靠 `cargo test --lib` 的点名新测试与评审，不靠这条 CI（机械判据不判断径） |
| IPC 错误形状（A2 / [ADR-0007](../adr/0007-unified-command-error-codes.md)：命令 Err 侧、`packages/sdk/error-codes.json`、`src/runtime/host-error.ts`） | `npm run check:shape`（S3 拦截项）+ `npm run unit:errors` + `cargo test --lib`（`host_error.rs` 单测） | 码表 12 个，两侧对撞 cargo 4 条 + unit:errors 13 条；**2026-10-14（A07）收口**：`string_err=0`、`From<HostError> for String` 混迁桥已删且 `cargo check --all-targets` 全绿（无残余转换的机器证明） |

**验收纪律**（沿用 PLUGIN-REVIEW §0，此处不复制全文）：跑起来看而不是只读代码；每条问题给 文件:行号 + 触发步骤 +
期望/实际；**「已核不成立」一节必须写**，附证据，别让下一批助手重复提同一件。
额外两条本体域专用：

1. **断言只许变严不许变松**。评审时 diff `tests/e2e/verify-*.mjs`，被删的断言行要逐条在新代码里找到对应的新标签，
   找不到就是放宽回归 —— 直接打回。
2. **`cargo test` / verify 输出取尾部汇总和退出码**，不要凭片段宣布全绿。

## 4. 工程约定（派单时随卡片贴给接活者）

- **`cargo fmt` 可能「装了但跑不起来」**（2026-10-12 实测）：钉住的 1.98.1 工具链里 `rustup component add rustfmt`
  回 `info: component rustfmt is up to date`，但 `toolchains/1.98.1-*/bin/` 里根本没有 `rustfmt.exe`，
  于是 `cargo fmt --check` 报的是「component is not applicable to the toolchain」而**不是**格式差异 ——
  用 `cargo fmt --all -- --check; echo $?` 判绿会把这种「没跑」读成「没问题」。
  修法：`rustup component remove rustfmt --toolchain <那个>` 再 `add`（E3 就是这么把 139 处真实差异跑出来的）。
- **做变异抽查之前先提交**。抽查要故意改坏产品代码再看测试是否变红，而还原手法是 `git checkout -- <文件>` ——
  如果那个文件里还有本次**尚未提交**的接缝（新抽的纯函数、新加的 mod 声明），checkout 会把它们一起吞掉
  （2026-10-12 Q1 就这么丢过一次：`cargo test` 从 111 掉回 86，得把接缝重新落一遍）。
  顺序应当是：改完 → 全绿 → **先提交** → 再做变异抽查 → `git checkout --` 还原 → 复跑确认回到基线。
- **`git add` 只要带一个不存在的路径名就整批什么都不做**（E1 踩过）：`git mv` 之后旧目录已空，
  再 `git add -A 旧目录 新目录` 会静默失败，提交进去的是重命名前的内容 —— 新检出的树直接断链。
  提交前用 `git status --short` 对齐工作区，提交后用 `git grep --cached` 核对索引内容。

- `npm run verify:game` 会真起一个铺满显示器的窗口，**会抢前台**；脚本被中断时自己收窗不留孤儿，
  但**不要在外面套 `timeout`**（2026-09-30 曾把用户会话压垮过一次）。用户在游戏/演示时不要派需要抢前台的验收。
- 不碰安全软件设置，不加开机自启、不改注册表（`tauri-plugin-autostart` 除外，且那是本体能力）。
- 原子写只用 `src-tauri/src/fsutil.rs::write_atomic` 一份实现，别再复制第四份。
- **`npm run dev:debug` 被中断后 vite 子进程会活着留在 1420**（2026-10-12 实测两次）：下一次启动直接
  `Error: Port 1420 is already in use`，看起来像"端口冲突"其实是自己留的孤儿。收尾查
  `netstat -ano | grep :1420`，按 PID + `CommandLine` 里的 `<仓库根>\node_modules` 确认归属后再停；
  宠物进程同理（TaskStop 只收 npm/tauri 那一层）。
- **hook 配置写回会整文件重排键序**：`agent_hooks.rs:122/133` 用 `serde_json::to_string_pretty` 重写整个
  `settings.json`，serde_json 默认按 BTreeMap 排键（`HEAD` 起就是这样，不是某张卡引入的回归）。
  所以"别人条目逐字节未变"不是可承诺的口径 —— 断言只能按**键排序后的规范串**比内容，
  要保住原键序得引入 `preserve_order`，属新增依赖，本轮禁止。
- **同意框在「激活插件」时一次性弹，不是首次调用时弹**（2026-10-12 核实）：`src/runtime/plugin-runtime.ts:107-115`
  在激活流程里逐个 `permission_check` 收集未授权的能力，然后**一次** `permission_request` 全要；
  `src/runtime/bridge.ts:78` 的 `gated()` 只在"调用时仍缺"才补弹（例如激活后才改过 manifest，或上次被拒）。
  写这类断言时**断言"弹过同意框"并核对授权记录**，不要钉死触发时机 —— A9a 的执行者就是按这条把断言写对的，
  而 PM 的卡在 §6 里写"首次调用会弹框"是错的。**派卡前先把 PLUGIN_SDK §2 对一遍**。
- std Mutex 一律 `unwrap_or_else(|p| p.into_inner())`。
- 宿主日志：`%LOCALAPPDATA%\com.desktoppet.pet\logs\host.log`，验收时先看它再猜。

## 5. 宿主缺口（goat-gauge 评审提出，2026-10-17）

| # | 现象 | 插件侧怎么绕过 | 建议 |
|---|---|---|---|
| G1 | `ctx.dom` 的 SVG 白名单缺 `stroke-width` / `stroke-linecap` / `fill-opacity` 等呈现属性，表外名字静默拒收。 | 圆环用 `path` 的 `d` 画弧，线宽/线帽/透明度写进 `<style>` 元素的 CSS；刻度用 HTML `span`，不用 SVG `text`。 | 评估把常用 SVG 呈现属性加入 `WIDGET_ATTRS` / `WIDGET_STYLE_PROPS`，或提供 SVG 专用样式通道；改词表时同步 `unit:migrate` 与 SDK §5.1。 |
| G2 | `ctx.http.request` 只返回 `status` / `content_type` / `body` / `truncated`，没有响应头。 | 429 无法读 `Retry-After`，只用本地冷却阶梯 60s→2m→5m→15m→30m。 | 在 `HttpResponse` 增加 `headers`（至少 `retry-after`）或 `retryAfterMs` 字段；桥与 Rust 同改。 |
| G3 | Widget 在 Worker 里没有 `matchMedia` / 主题能力，无法跟随系统深浅色。 | badge / overlay 固定深色、设置页固定浅色；不接 `navigator.clipboard`，外链只显示文本。 | 评估 `ctx.theme` 或 `layout` 推送带 `colorScheme`；剪贴板另开能力卡。 |
