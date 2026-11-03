# 验收复核 — a18ec21（2026-10-29）

针对 `desktop-pet-验收-a18ec21-2026-10-29.docx`（附录 5 的 N1–N8 与 G1/G7/G8/G9 条目）逐项复核，
按「先复现、再修、修不了给证据」的口径整理。本轮只改工作区，**未 push、未创建 GitHub Release、未改 main 分支保护、
未改写历史提交**。

## 结论摘要

- 报告点名的离线门问题（skip 判据误伤、e2e 配置漂移、NSIS 已知缺口、文档表格与数字、跨平台单测）**已修并可离线验证**。
- **P1 的 Rust fmt 红没有修**：25 处差异全部落在 `src-tauri/**`，不在本卡 inScope 内；已开 HOST-BACKLOG R1，
  本文件的离线门表把它记为失败，不豁免。
- **CI 没有在本轮重跑**：没有推送就不可能有新 run。本文件只引用报告给出、且能用本地 git 复核的 run 号与
  tag 祖先事实；「CI 绿」没有被写成已完成。
- **E2E 已在 2026-11-01 夜间于本机实跑并四套全绿**（`verify` 485/0、`verify:agent` 318/0、`verify:drag` 41/0、
  `verify:dsh` 43/0）；首跑抓出的 3 处回归已修复并复跑确认（见 §8）。CI 侧的 E2E 门（`workflow_dispatch`）仍未被触发。

## 判定矩阵

### P1 / N1 — main CI 红在 Rust fmt

| 项 | 报告判定 | 本轮复核 | 证据与去向 |
|---|---|---|---|
| N1 | 未修（阻断发布） | **复现；不修（范围外）** | `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` 退出 1，`grep -c '^Diff in'` = 25，全部在 `src-tauri/src/**`（`src-tauri/src/commands/agent.rs`、`gate.rs`、`agent/inbox.rs`、`agent/linkage.rs`、`agent_hooks.rs`、`http.rs`、`http_proxy.rs`）。本地看到的 25 比报告记录的 23 多，因为同一工作区里其他成员已经动过这些文件。CI run 40725727745 / 40725728961 在第 12 步失败、13–15 skipped（报告附录 5）。**修复卡 R1**，本卡不豁免。 |

### G1 — 格式/发布/门禁类

| 项 | 报告判定 | 本轮复核 | 证据 |
|---|---|---|---|
| G1-03 | 修出新问题 | **已修** | `993e1f2` 不是 `b6d98cd` 的祖先（`git merge-base --is-ancestor` 退出 1），是 `a18ec21` 的祖先；0.2.4 notes 与 checklist 已把 B6 标成「tag 之后、未随 0.2.4 出包」，并写明 verify:dsh 是 a18ec21 才加的套件。见 [RELEASE-NOTES-0.2.x.md](./RELEASE-NOTES-0.2.x.md)、[RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md)。 |
| G1-04 | 部分 | **已修** | [CONVENTIONS.md](./CONVENTIONS.md) 里 `required_approving_review_count=1` / `restrictions=` 那组旧命令整段删除，改为只认 [BRANCHES.md](./BRANCHES.md) 第七节的 `--input` JSON（审批数 0、`restrictions: null`），并注明本轮未执行、保护仍关闭。 |
| G1-05 / N2 | 修出新问题 | **已修** | [cdp.mjs](../../tests/e2e/harness/cdp.mjs) 的 `createReport` 增加 `skip(label, reason)`，每个套件末尾输出唯一机器行 `E2E-SUMMARY suite=… passed=… failed=… skipped=…`；[e2e.yml](../../.github/workflows/e2e.yml) 只解析该行与 `SKIP <label>` 行，不再搜中文「跳过」；`verify-pet-drag.mjs` 的分组标题不再参与判据；goat-gauge 在线组用 `r.skip("在线组", …)` 且登记在 `e2e-gate.json` 的 `allowedSkips`（带理由与到期日）。 |
| G1-06 / N5 | 部分 | **已修（按不豁免的口径）** | `e2e-gate.json` 的 `knownEnvFailures` 清空，D07「缺夹具」不再冒充环境问题；热键用例的前置改由 e2e.yml 的 `PET_HOTKEY_DEFAULT` 提供；登记项命中仍是 ENV-RED、整体仍红 —— 没有新增「登记即豁免」。 |
| G1-07 | 部分 | **部分；剩余项 R4** | [RELEASE-CHECKLIST.md](./RELEASE-CHECKLIST.md) 已一版一节并补 CI/E2E 事实；0.2.4 的 SHA256 仍「待补录」（包不在本轮工作区），转 R4 真机/产物项。 |
| G1-08 | 未修 | **已修** | [check-nsis-cleanup.ps1](../../tools/check-nsis-cleanup.ps1) 增加 `-AcceptKnownGapC`：Case C 被摘 hook 时默认 `Fail`，显式给开关才记 `KNOWN GAP ACCEPTED`；[unit-nsis-hook.mjs](../../tests/unit/unit-nsis-hook.mjs) 增加接线检查。 |
| G1-09 | 部分 | **已修** | 新增 [e2e-extended.yml](../../.github/workflows/e2e-extended.yml)（手动 + 每周），以 `uses: ./.github/workflows/e2e.yml` 复用同一套步骤，`mode: extended`；判据仍只在 [e2e-gate.json](../../.github/workflows/e2e-gate.json)。`npm run check:e2e-gate` 校验每个 `verify*` 脚本都有 mode 入口。 |
| G1-10 | 部分 | **已修（major 强制）** | 新增 `.npmrc` 的 `engine-strict=true`：Node 22 在 `npm ci` 直接失败，不再出现 `Unable to deserialize cloned data` 假红；[harness.mjs](../../tests/unit/harness.mjs) 拒绝非布尔 `check()` 条件；`unit` 脚本改 glob。`.nvmrc` 24.9.0 与 CI `node-version: 24`（实际 24.22.1）同 major，不再当门禁差异。 |
| G1-11 | 未修 | **范围外（本卡范围未列）** | 无 PR 标题 lint；需要仓库治理动作，未做。 |
| G1-12 | 未修 | **部分** | [HOST-BACKLOG.md](./HOST-BACKLOG.md) 增加 R1–R5 并可追溯到 a18ec21 这轮（R2 即本轮）；历史 t22/t37/t38/t39… 未逐张回填（不做，卡号真实优先）。B6 行补 `src/pet/drag-controller.ts`。 |

### G7 — 测试与工具

| 项 | 报告判定 | 本轮复核 | 证据 |
|---|---|---|---|
| G7-04 | 部分 | **已修** | harness 对非布尔条件先报 `[harness] check() 的 cond 必须是布尔值`；`skip()` 单独计数并在退出时打 `SKIPPED <n>`；`npm run unit` 2241/0，说明没有既有调用被防呆误伤。 |
| G7-06 | 未修 | **已修** | `verify-goat-gauge.mjs` 增加 `constantFor`/`quietFor` 轮询，替换 `sleep(800)` 后单次读与 `sleep(10_000)`。 |
| G7-07 | 未修 | **已修** | 空态只看高度（不再读 closed shadow 的宿主 `textContent`）；启用集合显式断言；在线组缺 Key 改为结构化 skip。 |
| G7-08 | 未修 | **已修** | `verify-release.mjs` 的 pet.json 探测拆两层：可达（`ok===true` 或 404）与「仅在 200 时要求合法 JSON」。 |
| G7-11 | 未修 | **范围外** | `include_str!` 计数在 `src-tauri/**`，本卡不改；留给 R1/t3 的 Rust 侧。 |
| G7-13 | 未修 | **范围外** | enqueue 单测在 `src/runtime/plugin-runtime.ts`，本卡不改。 |
| G7-14 | 未修 | **已修** | `unit` 脚本不再手列 21 个文件，改为 `tests/unit/unit-*.mjs`（保留 `--import ./tests/unit/ts-loader.mjs --test --test-concurrency=1`；实测 node 自行展开，结果与手列一致）。 |
| G7-15 | 未修 | **部分** | goat-gauge 的固定 sleep 已换轮询；其余套件仍有 `localhost:1420` 直写与 `sleep(10_000)` 残留，归 R3 的低风险搬运项，不在本轮扩大改动面。 |

### G8 — 文档与状态板

| 项 | 报告判定 | 本轮复核 | 证据 |
|---|---|---|---|
| G8-01 / N8 | 部分 | **已修** | 状态板删掉截断表格的空行、B5 行转义 `` `created\|event\|disposed` ``、S4 改为「b6d98cd CI 绿（run 40643854516）、E2E 门未触发」、新增 R1–R5、B10 引用块标明与状态板 B10 不是同一张卡。R-J 现在 `rows=35 dups=0 blanks=0 misaligned=0`。 |
| G8-02 | 修出新问题 | **已修（长行留 R3）** | CONVENTIONS 的硬编码基线表整段换成「基线的唯一来源」（只认 e2e-gate.json + `check:e2e-gate` + 最近绿 run）；`48 条注册命令`、`1249 个用例` 等陈旧数字改为「以命令输出为准」；fmt 退出码 0 的旧说法改成「a18ec21 上红、修复卡 R1」。8452 字单行与 38 行 >400 字未动 → R3。 |
| G8-03 | 未修 | **已修** | `tools/check-docs.mjs` 的 `PLUGIN_IDS` 增至 5 个（含 `com.pet.goat-gauge`），README 速览行同步；check:docs R-C 现在 `ids=5/5`。 |
| G8-04 | 部分 | **已修** | AGENTS 状态段改为「b6d98cd CI 绿（run 40643854516）、a18ec21 红在 fmt、E2E 门未触发、本地读数不是 tag 字节、分支保护未开」；直推清单补 `f2e9fd0`/`a18ec21`；文件 5986 字节（R-F limit 6000）。 |
| G8-05 | 未修 | **已收口（2026-11-03 / R5）** | PLUGIN-HANDBOOK 硬性规则 4 与 PLUGIN-REVIEW 检查表补「回显防冲写守卫」口径；共享方式定为源码级（跨插件 import 被 `is_safe_rel` 挡住），契约写在 PLUGIN_SDK「6.1 设置页回显与防冲写」，goat-gauge 的内联守卫已抽成 `views/settings/lock.js`。 |
| G8-06 | 未修 | **部分** | `unit-settings-echo.mjs` 的过时注释已改（F03′ 差量更新后旧虚拟节点 id 仍有效）；插件侧 `watch-list.js` 注释在 `plugins/**`，本卡不改 → 留给插件卡。 |
| G8-07 | 未修 | **部分** | `.gitattributes` 清单补 `tests/e2e/harness/pet-window.ps1`；`src/main.ts` 的「单飞防 HMR」注释在 `src/**`，本卡不改。 |

### G9 — 体积

| 项 | 报告判定 | 本轮复核 | 证据 |
|---|---|---|---|
| G9-03 | 未修 | **未修（范围外的一半）** | `biome.jsonc` 的 formatter 开关在 `src/**`/根配置里，本卡不改；`check-command-shape.mjs` 的体积门会改变现有多命令卡的失败面，不在本轮冒险加。记入 R3。 |
| G9-08 | 未修 | **未修** | `verify-isolation.mjs` 4064 行、`verify-agent-bridge.mjs` 2372 行；只搬不改判据的拆分归 R3。 |

### 附录 5 的 N1–N8

N1 = P1（fmt 红，R1）；N2 = G1-05；N3 = G1-03；N4 = 基线只留 `e2e-gate.json`（`verify:agent` 统一按 303/4，旧的 307/0 作废）；
N5 = G1-06；N6 = 提交信息统计（说「74 文件 +5446/−724」，实际 `git show --stat` 为 85 文件、+6450/−724）**不改历史，
只在本文件记账**；N7 = 跨平台单测（`unit-nsis-hook.mjs` 用平台化 home 夹具，缺 pwsh 时 4 条 `skip()` 单独计数，不再硬红）；
N8 = G8-01（R-J 加「状态板内不许空行、每行列数 == 表头」）。

### G2 的 N6 / N7 / N10

| 项 | 报告判定 | 本轮复核 | 证据 |
|---|---|---|---|
| G2-N6 | 未修 | **已修** | [fixtures.mjs](../../tests/e2e/harness/fixtures.mjs) 新增 `isRealAgentPath`：只有「等于 realHome」或「realHome 下已知 agent 目录（`.qoder/.qoder-cn/.zcode/.codex/.workbuddy/.codebuddy/.dsh`）」才算真实目录；Windows 默认 TEMP 在 `%USERPROFILE%` 下不再误判。`unit-nsis-hook.mjs` 加三条反例（TEMP 下放行、`.codex` 下判红、home 本身判红）。 |
| G2-N7 | 未修 | **已修** | [e2e.yml](../../.github/workflows/e2e.yml) job env 设 `PET_DSH_HOME`，verify:dsh 前置不再是 exit 2；缺前置时仍是红（不静默跳过）。 |
| G2-N10 | 未修 | **已修** | 同 N7：`unit-nsis-hook.mjs` 的 Windows 路径夹具改 `path` 语义并用平台分支，POSIX 上不再被 `resolve` 拉成 cwd 相对路径。 |

## 离线门实跑（2026-10-29，本机）

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run unit` | 通过 | 2241 passed / 0 failed / 0 skipped（基线 2238 + 本轮 3 条 G1-08 接线检查） |
| `npm run check:docs` | 通过 | `RESULT rules=10 failing=0`（R-A 在生成本文件后归零；R-C ids=5/5；R-J rows=35 无空行/错列） |
| `npm run check:shape` | 通过 | `RESULT commands=52 s1=0 s2=0 string_err=0 failing=0` |
| `npm run check:e2e-gate` | 通过 | `RESULT suites=12 floors=8 pending=4 skips=3 failing=0` |
| `npm run lint` | 通过 | biome 201 文件无错（修掉 `check-e2e-gate.mjs` 的未用变量后复跑） |
| `npm run build` | 通过 | `typecheck:plugins && tsc && vite build` 退出 0 |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | **失败** | 25 处差异全在 `src-tauri/**`（本卡范围外）；对应 R1，不豁免、不改写成通过 |

## 交付文件（本轮）

- 门禁/工作流：`.github/workflows/e2e.yml`、`.github/workflows/e2e-gate.json`、`.github/workflows/e2e-extended.yml`、
  `tools/check-e2e-gate.mjs`、`tools/check-docs.mjs`、`tools/check-nsis-cleanup.ps1`、`package.json`、`.npmrc`、`.gitattributes`
- E2E/harness：`tests/e2e/harness/cdp.mjs`、`tests/e2e/harness/fixtures.mjs`、`tests/e2e/verify-isolation.mjs`、
  `tests/e2e/verify-agent-bridge.mjs`、`tests/e2e/verify-goat-gauge.mjs`、`tests/e2e/verify-release.mjs`
- 单测：`tests/unit/harness.mjs`、`tests/unit/unit-nsis-hook.mjs`、`tests/unit/unit-settings-echo.mjs`
- 文档：`README.md`、`AGENTS.md`、`docs/process/CONVENTIONS.md`、`docs/process/HOST-BACKLOG.md`、
  `docs/process/RELEASE-NOTES-0.2.x.md`、`docs/process/RELEASE-CHECKLIST.md`、`docs/plugin-dev/PLUGIN-HANDBOOK.md`、
  `docs/plugin-dev/PLUGIN-REVIEW.md`、本文件

> 说明：`CONTEXT.md` 本轮未改（报告未点名）；用户未跟踪的 `docs/process/HANDOFF-2026-10-27.md` 保持原样。

## 剩余项（全部有卡，不在本文件冒充已修）

- R1：main CI Rust fmt 红（`src-tauri/**` 25 处差异）；只动格式，等 CI 全绿。
- R3：巨型 E2E 文件拆分与 CONVENTIONS 超长行，只搬不改判据；`localhost:1420` 与固定 sleep 的收口同批。
- R4：NSIS Case C 在真机重跑（`-AcceptKnownGapC` 只降低误报，不等价于通过）；0.2.4 包 SHA256 补录。
- R5：**已收口（2026-11-03）**：`PLUGIN_SDK.md` 新增「6.1 设置页回显与防冲写」，HANDBOOK 规则 4 / REVIEW 检查表改为指向该节；goat-gauge 内联守卫抽成 `views/settings/lock.js`；跨插件 import 被 `is_safe_rel` 挡住，共享固定为源码级（复制带来源注释）。
- 范围外：G1-11（PR 标题 lint）、G7-11（include_str!）、G7-13（enqueue 单测）、G8-06 的插件侧注释、
  G8-07 的 `src/main.ts` 注释、G9-03 的 formatter 开关。

## 没有做的事（不得读成通过）

- 没有触发/重跑 main CI 或 E2E 门；没有推送、没有建 Release、没有改分支保护。
- 没有跑 E2E 套件（需要自托管 Windows runner 与桌面会话）；本文件只有离线门读数。
- 没有做人工验收：NSIS Case C、0.2.4 安装包、DSH 桥真机联动、B6 真实拖拽/DPI 仍待真机。

---

# 本轮修复轮（t1–t9）与最终字节集成验证 · 2026-11-01

> 本节由集成卡 t8 **追加**，不改上面 2026-10-29 的判定与读数（那时的「P1 fmt 红」「离线门 2241/0」是开工前口径）。
> 基线提交仍是 `8b2bc0e`（分支 `wip/acceptance-a18ec21-2026-11-01`），本轮全部改动**留在工作区、未提交、未推送**。

## 1. 卡面结果矩阵

| 卡 | 类型 | 状态 / verdict | 改动文件数 | 该卡自报 verify 读数 | 未代认项（不得读成通过） |
|---|---|---|---|---|---|
| t1 | implementation | completed；独立审查 t6 **verdict=pass** | 10（3 Rust + `bridge.ts` + `widget.js` + `dsh-bridge/index.js` + 2 ADR + 2 单测） | `unit-dsh-bridge` 149/0、新增 `unit-agent-acceptance` 43/0、`cargo test` 428/0 | Qoder 真机写盘未验证（全部用临时 home 夹具；卡面本身禁止写真实 Agent 配置） |
| t2 | implementation | completed；独立审查 t5 **verdict=pass** | 6（`http.rs`、`http_proxy.rs`、`gate.rs`、`permission.tests.rs`、ADR-0011、新增 `unit-native-acceptance.mjs`） | 四条 verify 全绿（同本文件第 2 节的最终复跑） | 同 realm 插件可绕过 JS 桥未解决（ADR-0011 明写）；TUN 真机抓包未做 |
| t3 | implementation | completed；独立审查 t7 **verdict=pass** | 21（7 新建 / 14 修改） | `unit` 2636/0、`build`/`lint` 0、`cargo test` 428/0 | 真实 OS 拖动与 DPI≠100% 属人工项（未改系统 DPI，只有数学模型 + 单测） |
| t4 | implementation | completed（PM 验收，未配 review 卡） | 19（12 修改 + 2 新增插件侧模块 + 5 个新增单测） | 5 个新测试文件 41/46/18/49/51 断言全绿；`unit` 2636/0 | 无真实行情、无真机蓝牙；G5-03（整表 replace→差分更新）因断言文件不在其 inScope 未做 |
| t9 | work | completed | 1（`tests/e2e/verify-agent-bridge.mjs`，+35/−2，单 hunk） | 静态校验 `node --check` + `biome lint` 通过；**E2E 已于 2026-11-01 实跑**（§8） | 新期望当场抓出「confirm 被零参工厂吞掉」，修复后 318/0 |
| t8 | integration | 本卡 | 见「未提交清单」 | 见第 2 节与 §8 | 见第 6 节的分类剩余项 |

三项独立审查（t5 / t6 / t7）均为 `verdict=pass`，`needs_revision`/`reject` 零；t6 的补充说明已用 `evidence_note` 追加在
原任务上（乱码句更正 + 范围说明），原 verdict 不变。

## 2. 最终字节离线门（2026-11-01 本机，t8 复跑）

| 命令 | 结果 | 读数 |
|---|---|---|
| `npm run unit` | 通过 | **2638 passed / 0 failed / 0 skipped**（48 套件，20.0s；相对本轮开工前 2241 的增量来自新增验收测试文件，§8 的修复轮再 +2） |
| `npm run check:docs` | 通过 | `RESULT rules=10 failing=0`（R-F bytes=5986/6000；R-G tree=107 checked=106 reverse=61 broken=0；R-H checked=23 broken=0；R-J rows=37 dups=0 blanks=0 misaligned=0 —— 37 是本节新增两行状态板后的读数） |
| `npm run check:shape` | 通过 | `RESULT commands=52 s1=0 s2=0 string_err=0 failing=0` |
| `npm run check:e2e-gate` | 通过 | `RESULT suites=12 floors=8 pending=4 skips=3 failing=0`（与 2026-10-29 持平：t9 只改套件内期望，没有新增/下线套件，也没有下调下限） |
| `npm run lint` | 通过 | biome **217 文件**无错、0 fix |
| `npm run build` | 通过 | `typecheck:plugins && tsc && vite build` 退出 0（built in 118ms） |
| `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | 通过 | **退出 0、0 处 `Diff in`**（上一轮的 R1 红已收口，见第 3 节） |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 | 退出 0，无 warning |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 通过 | **428 passed / 0 failed**（lib 428 + main 0 + doc-tests 0） |

## 3. fmt 收口（本卡新增职责）

1. 先确认并发：派单时除 t8 外全员 idle，且没有成员在改 `src-tauri/**`，才执行写模式。
2. 取写模式前的自证指纹：`git diff -- src-tauri/src | sha256sum` = `7c62eab7ff04398d9d13fa3a38b396ba9b504d50b1b5574715b1bf044ee1dfed`。
3. 跑 `cargo fmt --all --manifest-path src-tauri/Cargo.toml`（退出 0）后重算同一指纹：**完全一致**；`git status --porcelain` 的指纹
   `a06ffc1cc6578b1828c89c61e80c205487e98bf1548332ea6233e35a0cf2aab0` 前后也一致。
   → 本卡的写模式 fmt 对最终字节**零改动**，所以「只格式化、逻辑零改动」在这里是最强形态的成立。
4. 为什么已经干净：t1/t2 各自对自己改的 `.rs` 跑过 `rustfmt --edition 2021`；t2 按其卡面执行过一次写模式收口，
   顺带把 `src-tauri/src/commands/agent.rs`、`src-tauri/src/services/agent_hooks.rs` 两个本轮**没有逻辑改动**的文件格式化了。
5. 这两个文件的「纯格式化」不只靠肉眼看 diff：把 `8b2bc0e` 版与工作区版都做「去全部空白 + 去行尾逗号」的字符归一化后
   **逐字节相同**（`identical=True`），即唯一的差异是 rustfmt 的换行、缩进与尾逗号。
6. `src-tauri/src/**` 其余差异归属：t1（`agent/linkage.rs`、`agent/inbox.rs`、`enabled.rs`、ADR 口径）、t2（`http.rs`、
   `http_proxy.rs`、`gate.rs`、`permission.tests.rs`）。`enabled.rs` 是唯一被两张卡共同改到的文件（t1 的 `reconcile` 调用点 +
   t2 的 `review_ids` 严格档），两处改动在工作区里**共存且都能单测**（见 t2 的 `set_path_rejects_malformed_ids_instead_of_dropping_them`
   与 t1 的 `no_automatic_path_clears_the_install_confirm_gate`），不是覆盖。

## 4. 与本文件旧读数 / 报告口径的差异说明

- **unit 条数**：2241 → 2638（+397）。增量来自本轮新增的验收测试文件（agent 43、astock 41、goat 46、todo 18、
  hr-ble 49、plugin-acceptance 51、drag/runtime/widget-host/native 等），§8 的修复轮又在 `unit-widget-worker.mjs` 里
  +2（2636 → 2638）；既有套件没有被删断言。t1 还做了变异验证（把 `widget.js` / `bridge.ts` /
  `integrations/dsh-bridge/index.js` 换回 `8b2bc0e` 版，新增断言分别红 16 / 16 / 4 条），说明新测试不是空转。
- **fmt**：本文件 2026-10-29 节按当时范围记为「失败 25 处、转 R1」。本轮最终字节为 **0 处**，R1 的本地部分已收口；
  CI 复验（新 run）仍需推送后才可能，本轮**不推送**，所以 R1 在状态板标「本地已收口 / CI 待复验」，不写成 CI 绿。
- **`verify:agent` 基线**：唯一口径是 `.github/workflows/e2e-gate.json` 的 `floorBasis`。§8 实跑后该字段已由
  「303/4（2026-10-28）」更新为 **318/0（2026-11-01 本机 E2E 四套全绿）**，floor 250 保持不变（只升读数、不降门槛）。
  状态板 S4/B5/B6 行里的 307/0 是 2026-10-28 的历史读数，已加「作废、以 floorBasis 为准」注记，不改历史行正文。
- **E2E**：2026-11-01 夜间按用户授权在本机用 `node tools/e2e-run.mjs` 串行实跑四套，**全部通过**
  （485/0、318/0、41/0、43/0，总耗时约 341s），详见 §8。门禁配置同步：`suites=12 floors=8 pending=4 skips=3`、
  `minAssertions` 8 套件、`floorPending` 4 套件、`allowedSkips` 3 条（reason + `expires: 2027-06-30`）、
  `knownEnvFailures` 为空；`floorBasis` 的 verify:agent 已按本次读数更新。仍要说明的是：这是开发机上的本地读数，
  CI 侧 `e2e.yml` 的 `workflow_dispatch` 没有被触发。
- **工作区 diff 审计**：`git diff` 无冲突标记、无新增 `.skip(` / `.only(`、无临时探针脚本入库；调试脚本全在 `temp/`
  （`.gitignore` 覆盖，不入库）；上一轮提到的 `tests/unit/_dbg2.mjs` 已不在工作区。

## 5. 未提交清单（`git status` 的 `??`，用户未授权提交 → 一律没有 `git add`）

新增源码/模块：`src/pet/drag-geometry.ts`、`src/overlay/lifecycle.ts`、`src/runtime/lifecycle.ts`、`src/settings/notice.ts`、
`plugins/com.pet.astock/views/settings/lock.js`、`plugins/com.pet.hr-ble/label.js`。

新增单测：`tests/unit/unit-agent-acceptance.mjs`、`unit-astock.mjs`、`unit-drag-acceptance.mjs`、`unit-goat-acceptance.mjs`、
`unit-hr-ble.mjs`、`unit-native-acceptance.mjs`、`unit-plugin-acceptance.mjs`、`unit-runtime-acceptance.mjs`、`unit-todo.mjs`、
`unit-widget-host.mjs`。

改动：49 个已跟踪文件（`git diff --shortstat` = 49 files / +2448 / −437），其中 43 个是 t1/t2/t3/t4/t9 的改动、
3 个是本卡（t8）改的 `docs/process` 文件，另有 §8 修复轮的 `src/boot-error.ts`、`src/runtime/widget-worker.ts`、
`src/runtime/worker-widget-host.ts`、`tests/unit/unit-widget-worker.mjs`、`tests/e2e/verify-{isolation,agent-bridge}.mjs`、
`.github/workflows/e2e-gate.json`。合计 66 个文件条目（49 改动 + 17 未跟踪，后者含用户的 HANDOFF），
即实现与修复两侧合计交付 65 个文件，**全部未提交**。
用户自己的 `docs/process/HANDOFF-2026-10-27.md` 保持未跟踪、未被本卡读写
（sha256 `8731b83927a78fcf672c504290111cd5aefe328afeed65af0876340f5af5aaa5`、mtime `2026-10-27 23:24:47`、19557 字节，收尾核对未变）。

## 6. 剩余项（按类分，全部不是本卡能单独关闭的）

**真机 / 桌面会话**
- NSIS Case C 覆盖安装的被动摘 hook 复核（`-AcceptKnownGapC` 只降低误报，不等于通过）；0.2.4 安装包 SHA256 补录。
- B6 真实 OS 拖动（`startDragging()` 之后 webview 收不到事件，合成按下没有物理按键）与 DPI≠100% / 多屏负坐标。
- DSH 桥真机「`install_bundle` 一次后桌宠联动」；Qoder/ZCode/Codex/WorkBuddy 四家真实配置目录的写盘行为。
- hr-ble 真机蓝牙、astock/goat 在线行情（本轮 0 在线读数）。

**外部权限 / 需要推送或 token**
- 推送后重跑 main CI（R1 的 CI 复验 + clippy/test 一步）、触发 `.github/workflows/e2e.yml` 的 E2E 门。
- `main` 分支保护开启（`gh` / token 都没有）；GitHub Release **已于 2026-11-02 建**（release id `430739968`，
  安装包资产 2,760,222 B）；分支保护在网页侧提交时被 GitHub 的 sudo 二次认证拦下，仍需管理员在已 sudo 的会话里按
  [BRANCHES.md](BRANCHES.md)「七」重做。

**架构债务**
- 同 realm 插件可 `import { invoke }` 绕过 JS 桥、插件身份由调用方自报（ADR-0011 / CODE-REVIEW R2 已记为未解决，本轮未假装解决）。
- R3：巨型 E2E 文件拆分与 `CONVENTIONS.md` 超长行（只搬不改判据）。
- R5：防冲写/编辑锁共享 helper **已收口（源码级共享）**；G5-03 整表 replace→差分更新仍未做。
- 范围外小项：G1-11（PR 标题 lint）、G7-11（`include_str!` 计数）、G7-13（enqueue 单测）、G9-03（formatter 开关）。

## 7. 本轮没有做的事（不得读成通过）

- 没有 `git add` / `commit` / `push`，没有建 GitHub Release，没有改分支保护，没有改写历史提交。
  （**2026-11-01～02 补记**：经用户授权已推 main `33c78d8` / `eec3abe` 并复验 CI 绿；GitHub Release `v0.2.4` 已建；
  分支保护仍未开，见上节。）
- **E2E 已补跑**（2026-11-01，用户授权，§8）：`tools/e2e-run.mjs` 由 `dev:debug` 现构建 debug exe 并串行拉起实例，
  四套全绿；首跑出的 7+3 条红全部归因并修复，不是靠放宽断言转绿（`verify:agent` 反而因 t9 新断言从 307 增到 318）。
  CI 侧的 `e2e.yml`（`workflow_dispatch` + 自托管 runner）仍未触发，不能写成 CI 通过。
- 没有做人工验收：上面「真机」一节的所有项都保持未验收。
- 没有修改用户未跟踪的 `docs/process/HANDOFF-2026-10-27.md`。


## 8. 本机 E2E 实跑与三处回归修复（2026-11-01 夜）

> 用户授权（2026-11-01）：E2E 可在本机跑（自托管 runner 的 `D:\runner\actions-runner\run.cmd` 那台机），
> 「能力局限要如实说，不发散」。以下读数都来自本机真实实例，不是静态推断。

### 8.1 怎么跑

- 入口：`node tools/e2e-run.mjs`（`npm run e2e`），四套 `verify` / `verify:agent` / `verify:drag` / `verify:dsh` **串行**；
  `--only verify:agent` 可单跑。实例由 `npm run dev:debug`（`tauri dev`）现构建 debug exe 并冷启动，CDP 9223。
- 隔离：`PET_E2E_PRESEED=1`、`PET_AGENT_HOME=temp/agent-home-e2e`、`PET_DSH_HOME=temp/dsh-home-e2e`、
  `PET_SETTINGS_DIR=temp/settings-e2e`、`PET_AGENT_CONFIG_FILES=temp/a9a/cfg-a.json;cfg-b.json`、`PET_AGENT_INBOX=temp/inbox-e2e`。
- **跑期间不许改 `src-tauri/**`**（watcher rebuild 会把套件打成 INTERRUPTED 假红）；日志落 `temp/e2e-run/<suite>.instance.log`
  （宿主 stdout）与 `<suite>.log`（CDP 断言），`temp/` 被 `.gitignore` 覆盖，不入库。

### 8.2 首跑：基线掉了 7 + 3 条

| 套件 | 首跑读数 | 基线 | 结论 |
|---|---|---|---|
| `verify` | 478 passed / **7 failed**（305s） | 485/0 | 两类回归 |
| `verify:agent` | 315 passed / **3 failed**（82s） | 307/0 或 303/4 | 确认链断 |
| `verify:drag` | 41/0（13s） | 41/0 | 绿 |
| `verify:dsh` | 43/0（3s） | 43/0 | 绿 |

证据文件：`temp/e2e-2026-11-01.log`（首跑）、`temp/e2e-recheck-agent.log`（加诊断后的单套件复跑）、
`temp/e2e-recheck-agent2.log`（修后单套件）、`temp/e2e-recheck-full.log`（修后四套全跑）。

### 8.3 三类红的根因与修法

1. **`boot-error` 语义（`verify` 3 条红）**：t3 重写的 `src/boot-error.ts` 只对 `fatal` 亮条；E2E 合成的
   `new ErrorEvent("error", { message: "m2a-probe" })` 经 `classifyError(new Error(...), { bootPhase: false })` 判成 `error`
   （legacy 非插件域），走 `console.error` 分支 → 条不亮、还多一条 console 错误。修法：fatal 之后补
   `if (severity === "error") { show(message); return; }` —— 归因不到任何插件的宿主级未捕获错误同样亮条，只有 `warning`
   （插件域）仍只写 console。`tests/unit/unit-runtime-acceptance.mjs:96` 钉的源码形状（`classifyError(rejection, { bootPhase: !bootReady })`、
   `if (severity === "fatal")`、监听器走 `report(`）全部保留。
2. **E2E 形状判据钉了行号（`verify` 4 条红）**：`tests/e2e/verify-isolation.mjs` 的 `runtimeNoiseMatches` 用
   `line.includes("plugin-runtime.ts:166")` 切片；t3 改过 `src/runtime/plugin-runtime.ts` 后 reportError 的 console 发射点移到
   `plugin-runtime.ts:212`，窗口 D/E 的切片整段为空（期望 1 实得 0）。修法：新增
   `const RUNTIME_REPORT_SITE = /src\/runtime\/plugin-runtime\.ts:\d+/`，`runtimeNoiseMatches`、`logConsoleLedger` 的 matched、
   `denyText` 三处改为「钉文件不钉行号」；`:3565-3576` 的自测样本字符串保留原样。
3. **确认位被零参工厂吞掉（`verify:agent` 3 条红，真实产品缺陷）**：`src/runtime/widget-worker.ts` 的 settings 区把 agent 方法
   统一包成 `const agent = (method) => () => call(method, [])`，套在 `install` 上就把 `api.install(confirm)` 的 `true` 丢了 →
   宿主永远收 `confirm=false`，第二趟点击仍停在确认门（面板原文「确认请再点一次。」）。`git diff` 证明此文件本轮没有被任何卡改过，
   是 Worker 化（ADR-0008）以来的既存缺陷，只是此前没有真机 E2E 覆盖到确认链。修法：`AgentHooksApi.install(confirm?: boolean)`
   改带参，实现 `install: (confirm) => call("agentHooks.install", [confirm ?? false])`；`src/runtime/worker-widget-host.ts` 注释同步；
   `tests/unit/unit-widget-worker.mjs` 把「旧三方法仍按零参数下发」改成只测 status/uninstall，并新增 `install(true)` →
   `call.args === [true]`、`install()` → `[false]` 两条断言。

### 8.4 复跑结果（最终字节）

| 套件 | 复跑读数 | 耗时 | 备注 |
|---|---|---|---|
| `verify` | **485 passed / 0 failed** | 263s | 回到 485 基线 |
| `verify:agent` | **318 passed / 0 failed** | 62s | 比 307/0 多 11 条（t9 新增确认链断言）；面板原文「已安装（ZCode）：每个文件 7 个事件，共 7 条。」 |
| `verify:drag` | **41 passed / 0 failed** | 13s | 与基线一致 |
| `verify:dsh` | **43 passed / 0 failed** | 3s | 与基线一致 |

修复后离线门同步复跑：`npm run unit` **2638/0**（+2）、`build` 0、`lint` 217 文件 0、`check:docs` rules=10 failing=0、
`check:shape` commands=52 failing=0、`check:e2e-gate` suites=12 failing=0、`cargo test` 428/0、`cargo fmt --check` 干净、
`cargo clippy -D warnings` 0。

### 8.5 仍然没有覆盖到的（不改判定）

- 真实 OS 拖动与 DPI≠100% / 多屏负坐标：`startDragging()` 之后 webview 收不到事件，E2E 只能到几何模型（`verify:drag` 41 条）。
- Qoder/ZCode 真机配置目录的写盘：全程用临时 home 夹具，没写真实 `~/.qoder` / ZCode 配置。
- CI 侧 `e2e.yml` 的 `workflow_dispatch`（自托管 runner + 交互式会话）仍未触发；上面的 341s 读数是开发机本地读数。
