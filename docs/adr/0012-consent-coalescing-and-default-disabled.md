# 同一插件同意请求按 plugin_id 合流、未启用不弹窗（D01 方案草案）

- 日期：2026-10-21
- 基线：`origin/main` `bcbc92a`（C05 已合入；B07 未合入，与本卡无关）
- 状态：**草案**。D01 只产出本文件，不改产品代码、不起应用、不跑 E2E。
- 适用：宿主 Rust 授权服务（D02）、同意框前端与 E2E（D03）。

**决定：**

1. **同一 `plugin_id` 同一时刻最多一扇同意框**。宿主内按 `plugin_id` 归并 pending；已有窗口时，新请求只把新能力追加到同一 pending，去重后不再开窗。
2. **新能力追加去重**。追加前先过滤宿主已授权能力和已在该 pending 里的能力；已授权能力永不出现在待授权列表里，也不单独弹窗。
3. **拒绝锁按插件、按宿主进程生命周期**。用户拒绝（含 60s 超时、直接关窗）后，本次宿主运行内该插件再次申请新的授权直接返回 `false`、不弹窗；已经持有的能力仍按 `permission_check` 放行（不会因为拒绝锁被反向撤销）。
4. **停用即取消 pending**。授权窗开着时把插件从启停清单移除，宿主把该插件的 pending 按 `false` 收口并关闭窗口；停用导致的取消**不写拒绝锁**，重新启用后仍可再次申请。
5. **未启用一律不弹**。`permission_request` 在需要弹窗的路径上先校验宿主启停清单；插件未启用（或清单不存在/读坏）时直接 `false`，不建窗。已全部授权的能力仍直接返回 `true`，不走弹窗。
6. **新装默认关闭是既有事实，不改安装语义**。插件目录出现只触发扫描/广播，不会自动写启停清单；用户在设置窗第一次点启用后，运行时激活才走首次授权。D02 只补上第 5 条的宿主强制。
7. **不新增宿主命令、不新增 `PLUGIN_WORKER_METHODS`、不改 ADR-0006**。合流状态全部留在宿主；同意框刷新复用既有 `consent_details`，D03 用有界轮询，不新增事件或命令。

---

## 1. 取证：现在为什么会给同一插件弹多个窗

### 1.1 现状调用链（静态，逐行）

- `permission_request` 先做 id/声明校验，再在 `permissions` 已全部授权时直接放行；否则调用 `ask_user`：
  `src-tauri/src/services/permission.rs:247-264`（全授权短路在 `:257`）。
- `ask_user` **每次调用都生成新的 `req_id`**：
  `src-tauri/src/services/permission.rs:297`；
  以 `req_id` 为键插入 `pending`：`:299-311`；
  窗口 label 固定为 `consent-<req_id>`：`:313`；
  每次都 `WebviewWindowBuilder::new(...).build()`：`:314-320`。
- `pending` 的类型是 `HashMap<String, PendingConsent>`，键只有 `req_id`：
  `src-tauri/src/services/permission.rs:20,23-28`；
  没有「按 plugin_id 找现有 pending」的分支，也没有 single-flight。
- 同意框只能按 `req_id` 应答/关闭：`consent_details` / `consent_answer` / `assert_consent_caller`
  在 `:377-441`；关窗事件只丢弃当前 `req_id` 的挂起项：`:335-345`，实现见 `:130-139`。
- 运行期桥的授权缓存是**每个 realm 一份**的模块级 `Map`：
  `src/runtime/bridge.ts:44`；
  `ensurePermissions` 先读缓存、逐项 `permission_check`，再把本次缺口一次性 `permission_request`：
  `src/runtime/bridge.ts:87-112`；
  缓存只在请求返回后才更新（`:107-110`），因此两个并发调用会同时看到“没授权”。
- 首次激活的批量请求在 `src/runtime/plugin-runtime.ts:256-269`；它本身是一批，但只覆盖本轮激活缺的 manifest 能力，
  与运行期桥、其他窗口的请求之间没有宿主侧合并。

### 1.2 会让同一插件出现多扇窗的路径

| # | 路径 | 代码事实 | 可复现步骤（静态推导，D03 落断言） |
|---|---|---|---|
| P1 | 同一 realm 并发首次调用不同能力 | `bridge.ts:87-112` 的缓存只在 `permission_request` 返回后更新；两次并发都越过缓存，各自调用 `permission_request`；宿主每次 `ask_user` 都新开窗（`permission.rs:297,313-320`） | 插件声明 `http` 但未授权，`activate` 里 `Promise.all([ctx.http.request(A), ctx.http.request(B)])`；两个请求各带 `http:<host>`，当前会弹两扇窗 |
| P2 | 同一插件的两个窗口/两个 bridge 实例 | `bridge.ts:44` 的 `granted` 是模块级 per-realm 缓存；宠物窗、设置窗、overlay 窗各有自己的上下文；插件激活在宠物窗，设置页 widget 在设置窗 | 启用一个带设置页 widget 的插件；在宠物窗首次激活同意框还开着时打开设置页，widget 调 `ctx.host.agentHooks.status()` 或 `ctx.storage.get()`；两个 realm 各发一次 `permission_request` |
| P3 | 激活批量请求 + 运行期请求并发 | `plugin-runtime.ts:256-269` 的批量请求与 `bridge.ts:103-111` 的运行期请求是两条独立调用；宿主没有「按 plugin 合并」 | 插件有三个能力，激活批量请求正在等用户；另一个窗口的设置 widget 请求其中一项或新的 `http:<host>` |
| P4 | 拒绝/关窗后重试 | `permission_request` 只检查授权表（`:257`），没有拒绝记忆；`ask_user` 每次都新开窗（`:297,313-320`） | 第一次拒绝后，插件下一次调用同一能力，会再弹一扇新窗；当前 E2E 明确把这条当预期（见 §5） |
| P5 | 并发多窗只关掉其中一扇 | `pending` 按 `req_id` 存，关窗只 `discard_pending(req_id)`（`:130-139,335-345`），其他 req 的窗口继续等 | P1 弹两扇后关掉一扇；另一扇仍在，直到用户作答或 60s 超时 |

**复现入口（当前基线）**：在已运行 dev 实例的宠物窗里，对一个已安装且声明了 `storage`/`notify` 的插件并发执行两次不 await 的调用：

```js
const inv = window.__TAURI_INTERNALS__.invoke;
void inv("permission_request", { pluginId: "zz.consent-probe", capabilities: ["storage"] });
void inv("permission_request", { pluginId: "zz.consent-probe", capabilities: ["notify"] });
```

`ask_user` 每次都会生成新的 `r*` 和 `consent-r*` 窗，`pending` 里是两条不同键；当前没有代码能把它们归并。D03 会把这条改成可断言用例（并发只允许一扇窗、能力并集）。

### 1.3 一个不能合错的边界：不同插件即使能力完全相同也不能合窗

B3 的两个夹具 `zz.status` / `zz.status2` 声明同一组 `pet:say`、`bus:publish`、`bus:subscribe`
（`tests/e2e/verify-isolation.mjs:1992-2027`），且 `driveConsent` 专门按 id 边界匹配，避免 `zz.status` 吃掉
`zz.status2` 的框（`:57-66`）。合流键必须是 `plugin_id`，不能是「能力集合」或窗口标题；B3 是这条的反例守卫。

---

## 2. 默认关闭与“安装不授权”的现状

### 2.1 现状证据

| 事实 | 证据 |
|---|---|
| 启停清单的唯一事实来源是宿主文件；文件不存在时返回 `None`，不是“全部启用” | `src-tauri/src/services/enabled.rs:46-67`（`read_ids`），`:80-83`（`plugin_enabled_list`） |
| 新装/未迁移时，运行时把旧 localStorage 迁移成宿主清单；全新的旧键是空数组，最终落成空清单 | `src/runtime/plugin-runtime.ts:46-53,64-77`（`loadEnabled`），`src-tauri/src/services/enabled.rs:145-162`（`plugin_enabled_migrate`） |
| 运行时只激活清单里的 id；不在清单里的插件只执行 `deactivate` | `src/runtime/plugin-runtime.ts:333-348`（`reconcile`） |
| 写启停清单只认设置窗；新增 id 只来自用户在设置页的开关 | `src-tauri/src/services/enabled.rs:104-117`（`plugin_enabled_set` 的 `gate::settings`），`src/settings/plugin-toggle.ts:15-27` |
| 设置页对新插件显示“已停用”，且不挂插件页面 | `src/settings/plugin-page.ts:100-123` |
| 插件“安装”= 往 `plugins/` 放目录；目录 watcher 只做回收/广播，不写启用清单 | `src-tauri/src/commands/plugins.rs:112-149`（扫描/列表），`:407-466`（watcher；`:449` 只回收孤儿授权，`:453-456` 广播） |

**结论**：正常路径下，新插件默认关闭、安装时不激活、不弹授权；只有用户在设置窗第一次点启用，运行时 `doActivate` 才批量申请缺失能力。
老用户从旧 localStorage 迁移过来的既有启用项会保留，这属于“旧状态”，不是“新装自动启用”。

### 2.2 现有缺口：未启用的插件仍可被直接请求授权

`permission_request` 没有检查启用清单（`src-tauri/src/services/permission.rs:247-264`）。
现有 E2E 正是利用这一点：`verify-http.mjs:15-17` 明确写探针“全程不被启用”，却通过桥直接
`permission_request` 拿到域名授权；`verify-isolation.mjs:197-228` 的 `grantProbeCap` 也是在探针被移出启用清单后
（`:268-275`）直接请求授权。也就是说，“默认关闭”目前只保证**不自动激活**，没有保证**未启用不弹授权**。

D02 必须把后者补上；这也意味着上面两条测试的授权前置要改成“先启用（或启用后立即停用）”，不能再用“未启用但直接要授权”当测试接缝。

---

## 3. 方案：宿主侧按 plugin_id 合流

### 3.1 状态形状

在 `PermissionState` 内增加一份**同一把锁保护**的合流状态（具体字段名由 D02 定，语义如下）：

```text
consent:
  pending: req_id -> PendingConsent {
      plugin_id, plugin_name,
      caps: Vec<String>,              // 当前窗口展示的并集，去重、保序
      waiters: Vec<oneshot::Sender<bool>>, // 这一轮所有等待同一答复的调用
      window_label: "consent-<req_id>",
      deadline: Instant               // 组级 60s，从第一请求起算
  }
  denied: HashSet<plugin_id>          // 本次宿主进程内已拒绝的插件
```

要点：

- `pending` 仍以 `req_id` 为键（窗口 label、`consent_details`、`consent_answer` 的既有契约不变），但查找/创建时**按 `plugin_id` 归并**。
- `pending` 与 `denied` 放在**同一把互斥锁**里，保证“检查拒绝锁 → 查/建 pending → 追加能力”与“答复拒绝 → 写拒绝锁 → 移除 pending”不会交错。
- 不持久化 `pending`/`denied`；宿主退出即清空，符合“同次运行”。

### 3.2 `permission_request` 的判定顺序

1. 校验 plugin id（`is_safe_id`）与磁盘 manifest 声明（保持 `permission.rs:254-256` 的现有错误码/文案）。
2. 若请求能力**全部已授权** → 直接 `true`，不弹窗（保持 `:257`）。
3. 若插件未启用（`enabled::list_ids` 中没有该 id，`None` 也按未启用）→ 直接 `false`，不弹窗。
4. 若 `denied` 含该 `plugin_id` → 直接 `false`，不弹窗。
5. 在锁内按 `plugin_id` 查找 pending：
   - **没有**：创建新 pending、新 `req_id`、新窗口，登记第一个 waiter，启动组级 60s 超时任务。
   - **已有**：把 `requested - granted - 已有 caps` 追加到同一 pending（去重、保序），登记新 waiter；
     不新建窗口，不更换 `req_id`；新能力通过既有 `consent_details` 的刷新路径出现在同一扇窗里。
6. 每个调用 await 自己 waiter 的结果；多个 waiter 收到同一个 `bool`。

`all-granted` 放在启用检查之前，是为了让“已授权能力不再弹”保持字面成立，也避免把一个已持有能力的调用因为插件暂时停用而反向判失败；
需要新授权时才要求“已启用”。这一点在 §7 作为待 PM 确认项之一。

### 3.3 答复、关窗、超时、停用

| 事件 | 宿主动作 | 等待方结果 | 拒绝锁 |
|---|---|---|---|
| 用户点“允许” | 锁内移除 pending → 对该插件 `grant(union caps)` → 逐个 waiter 发 `true` → 关窗 | 全部 `true` | 不写 |
| 用户点“拒绝” | 锁内移除 pending → 写 `denied` → waiter 全部 `false` → 关窗 | 全部 `false` | 写入 |
| 用户直接关窗（Alt+F4 / Destroyed） | 与拒绝同路径；关窗事件不再只按 `req_id` drop sender，而是收口整个组 | 全部 `false` | 写入（现行语义就是“关窗=拒绝”） |
| 组级 60s 超时 | 超时任务调用同一收口路径；若 pending 已被答复/停用则 no-op | 全部 `false` | 写入（现行超时=拒绝） |
| 停用插件 | `plugin_enabled_set` 落盘后，对 `previous - cleaned` 的 id 调用宿主内部取消：移除 pending、waiter `false`、关窗 | 全部 `false` | **不写**；重新启用可再申请 |
| 卸载/目录消失 | 目录 watcher 的 pending 回收入口对“已不在盘上”的 id 走同一取消路径 | 全部 `false` | 不写 |
| 开窗失败 | 移除 pending，首个调用返回 `internal`，同组 waiter `false` | `false`（首调用另有错误码） | 不写 |
| 答复时某个 waiter 已离开 | 忽略该 sender 的失败，继续给其余 waiter 发结果；不因为单个调用方消失让整条命令失败 | 其余正常 | 按答复类型 |
| 答复时 pending 已不存在 | `consent_answer`/`consent_details` 返回 `not-found`（既有码） | — | 不变 |

**停用取消的竞态**：`plugin_enabled_set` 先写盘再广播（`enabled.rs:113-115`）。`permission_request` 在插入 pending 后、
开窗前再读一次启用清单；如果已被停用则移除 pending、不建窗。窗口创建完成后还要复核 pending 是否仍在；
如果创建期间已被取消，立即关窗。这样“停用”与“首次请求”交错时不会留下一扇没有 pending 的窗。

### 3.4 同意框前端：复用 `consent_details`，不新增接口
现有页面只在启动时取一次详情（`src/consent/main.ts:13-40`），因此追加能力必须让它重新读：

- D03 在窗口存活期间按**有界轮询**（建议 400ms，窗口关闭即停止）调用既有 `consent_details`（`permission.rs:421-429`），
  发现 `caps` 变化就重绘 `#cap-list`；发现 `not-found` 就显示“本次授权请求已失效”并关窗（不再调用 `consent_answer`）。
- `consent_details` 的调用方校验仍按窗口 label `consent-<req_id>`（`assert_consent_caller`，`:377-386`），合流不改变窗口 label。
- 窗口固定 420×320；D03 给能力列表加 `max-height` + 滚动，保证“集中列出所有待授权能力”不溢出。
- **不新增 Tauri 命令、不新增事件、不新增 Worker 方法**：`consent_details`/`consent_answer`/`permission_request`
  的签名和注册表不变（`src-tauri/src/lib.rs:156-161`）；`PLUGIN_WORKER_METHODS` 不变，ADR-0006 无需改。
  如果 D03 评审认为轮询不可接受、要改事件推送，那是另一条接口决策，必须先补 ADR-0006/本 ADR，不在 D02 里悄悄加。

### 3.5 契约与不变量

| # | 不变量 | 判据 |
|---|---|---|
| I1 | 同一 `plugin_id` 同时最多一个 pending、一扇窗 | 并发两个 `permission_request` 后 `listPages(/consent/)` 中该插件只有 1 个；两次调用共享同一 `req_id` |
| I2 | 新能力追加去重 | 同一能力重复请求/已在 pending/已授权，列表不重复；追加只增不替换 |
| I3 | 已授权能力不弹 | 全已授权请求直接 `true`；混合请求的列表只含未授权项 |
| I4 | 拒绝锁按插件、按进程 | 拒绝后同插件新请求立即 `false` 且无新窗；已授权能力仍放行；宿主重启后锁清空 |
| I5 | 停用取消不写锁 | 停用后窗口关闭、等待方 `false`；重新启用+激活可再次弹窗 |
| I6 | 未启用零弹窗 | 未启用且需要新授权时返回 `false`，无 `consent-*` 窗；已全部授权仍直接 `true` |
| I7 | 不同插件不合并 | `zz.status` 与 `zz.status2` 即使能力完全相同，也各自一扇窗 |
| I8 | 授权是并集、拒绝是全无 | 允许后 union caps 全部 `permission_check=true`；拒绝后本轮新增的 caps 都未授权 |

**UX 文案要跟着改**：`src/runtime/plugin-runtime.ts:270-273` 现在写“用户拒绝了权限申请（可在设置中重新授权）”。
拒绝锁生效后，同一次运行内去设置页并不能绕过它；D03 应改成“本次运行已拒绝，重启应用后可再次申请”。
停用导致的取消可以在 false 分支先用现有 `loadEnabled()` 复核：插件已不在清单时提示“插件已停用，授权请求已取消”，
否则再按拒绝锁文案；仍不需要新增错误码或命令。

---

## 4. 受影响的既有测试

| 套件/用例 | 现状 | D02/D03 需要做什么 |
|---|---|---|
| `src-tauri/src/services/permission.tests.rs` | 直接构造 `PendingConsent { sender: oneshot::Sender }`（`:155-211,325-353,357-415`），并断言 dropped receiver 返回 `internal`（`:357-382`） | D02 改成组 `waiters`；新增合流/去重/拒绝锁/停用取消/超时收口的纯函数或状态机单测；保留源码签名钉（`:442-479`），签名不变则只随结构体调整 |
| `tests/e2e/verify-isolation.mjs` `driveConsent`（`:62-111`） | 按窗口标题找同意框、按 id 边界区分 `zz.status`/`zz.status2` | 保留；新增“同一插件并发只一窗”“追加能力同一窗”“停用关窗”用例；不得放宽边界匹配 |
| 同文件 `grantProbeCap`（`:197-228`） | 探针被移出启用清单（`:268-275`）后直接 `permission_request` | 新启用门禁下会直接 `false`。D03 改为先启用探针再申请（或启用后停用但保持测试前置自洽），不能靠“未启用也能要授权”的旧接缝 |
| 同文件 agent hooks 拒绝组（`:1734-1749`） | 明确断言“拒绝后第二次调用仍弹框” | 按新口径翻转为：第二次调用**不弹窗**、返回 `false`、无授权；这是拒绝锁的核心回归 |
| 同文件 B3（`:1989-2134,2277-2286`） | 两个独立插件 `zz.status`/`zz.status2` 各自弹框；撤权后再设置拒一次 | B3 的显式 `setEnabled`（`:2124`）保证默认关闭不影响它；补“两插件同能力不合并”断言；拒绝后的后续行为按新锁检查 |
| `tests/e2e/verify-http.mjs` | 探针“全程不被启用”（`:15-17`），靠直接请求弹两扇域名框（`:173-177`） | D03 启用探针（其 index.js 为空，不跑业务）；两域名是**顺序**请求，仍应各一窗，但授权前置改为已启用；该套件不在 runner 默认白名单，需手工跑或另行获批 |
| `tests/e2e/verify-worker.mjs` | 后台 `pump` 逐个应答同意框（`:41-62`）；测试里会 revoke/重装 | 合流后可能少了并发的多余框，pump 继续按“场上有就答”工作；重跑确认，不按框数做断言 |
| `tests/e2e/verify-agent-bridge.mjs` | 后台 `makeConsentPump`（`:60-111`），注释写“各能力的框分批弹”；探针启用见 `:370,759` | 重跑；若断言依赖“每次能力一扇框”，改为按插件/能力集合断言；不新增命令 |
| `tests/e2e/verify-goat-gauge.mjs` | 撤权后重新启用，断言重新弹框（`:535-553`）；在线组另弹 `http:api.commandcode.ai`（`:555-563`） | 启用门禁与合流下应保持：撤权→重启用→一扇窗；重跑确认 |
| `tests/e2e/verify-release.mjs` | 启用探针后测未声明能力错误（`:101,129-133`）；非同意框应答被拒（`:134-135`） | 判定顺序保持“先声明校验”，错误码/文案不变；重跑打包版 |
| `tests/unit/unit-capabilities.mjs` | mock `permission_check`/`permission_request`，验证桥的批量与缓存 | 桥不改；重跑确认没有隐式依赖（若 D03 改了 consent 前端不影响此套） |
| `tests/unit/unit-worker-host.mjs` | 钉住 Worker 方法名单 | 不新增方法；应原样通过 |

---

## 5. 拆分：D02（宿主 Rust）与 D03（前端 + E2E）

### D02：宿主 Rust（无 UI、无 E2E）

**文件（预计）**

- `src-tauri/src/services/permission.rs`：合流状态、按 plugin 查找/追加、拒绝锁、启用门禁、组级超时、答复/关窗/停用收口。
- `src-tauri/src/services/permission.tests.rs`：状态机单测；更新既有 `PendingConsent` 构造与 dropped receiver 语义。
- `src-tauri/src/services/enabled.rs`：`plugin_enabled_set` 落盘后对 `previous - cleaned` 调取消；不改命令签名/注册表。
- `src-tauri/src/commands/plugins.rs`：目录 watcher/`prune_orphan_grants` 对已不在盘的 pending 走取消（可选但建议，覆盖卸载）。
- 不改 `src-tauri/src/lib.rs` 命令注册表；不加新命令、不加 Worker 方法。
- **命令体保持薄层**（ADR-0005 / `check:shape` 的非空行 ≤20）：`permission_request` 只做 id/声明校验后委托给
  `request_consent_group(...)`；启用门禁、拒绝锁、合流、取消都抽成可离线单测的能力域函数。
  `plugin_enabled_set` 新增的取消调用也要放进 helper 或保证命令体不超限。

**离线验收**

- `cargo test`（`src-tauri`）全绿，既有 Rust 断言只增不删；新增：同插件合流同一 req、能力并集去重、已授权过滤、拒绝锁、停用取消不写锁、超时/关窗收口、开窗失败清理。
- `npm run check:shape`/`check:docs` 不因新命令/新文档漂移（D02 预计只改 Rust）。
- 不跑 GUI/E2E；D02 完成后再进 D03。

### D03：同意框前端 + E2E（至少 3 轮变异）

**文件（预计）**

- `src/consent/main.ts`、`src/consent/style.css`：`consent_details` 有界轮询、并集重绘、失效关闭、列表滚动。
- `src/runtime/plugin-runtime.ts`：仅在拒绝/停用的错误文案分支做区分（先 `loadEnabled()` 复核），不改激活顺序。
- `tests/e2e/verify-isolation.mjs`：新增合流/追加/拒绝锁/停用/未启用/跨插件不合并用例；改造 `grantProbeCap` 前置。
- `tests/e2e/verify-http.mjs`（手工或另行获批）：探针启用前置。
- 视实际断言调整 `verify-agent-bridge.mjs`/`verify-worker.mjs`/`verify-goat-gauge.mjs`；不改 workflow 白名单。
- 不改 `src/runtime/bridge.ts`（合流在宿主；桥的 per-realm 缓存保留）。

**E2E 新增判据（建议命名）**

1. `首次启用只弹一扇同意框`：新装/停用插件在设置页点启用后，场上只有 1 扇窗，列表是 manifest 缺失能力的并集（不是每个能力一扇）。
2. `同插件并发申请只开一扇同意框`：两个 `permission_request` 并发，场上 `consent-*` 数量为 1，能力并集正确。
3. `窗口开着时追加能力不换窗`：第一请求弹窗后第二请求追加新能力；窗口 label/req_id 不变，`#cap-list` 出现并集且无重复。
4. `拒绝后同轮不再弹`：拒绝一次后同插件再申请，2s 内无新 `consent-*`，调用返回 `false`。
5. `已授权能力不再弹`：已授权能力单独请求直接 `true`，无窗口。
6. `停用插件关闭授权窗`：窗口开着时切到停用，窗口在 5s 内消失，等待调用返回 `false`；重新启用+激活可再次弹框。
7. `未启用插件不弹`：新装/移出清单的插件直接请求，返回 `false` 且无窗口。
8. `不同插件同能力不合并`：`zz.status`/`zz.status2` 各一窗（B3 的既有边界）。
9. `重复能力去重`：请求 `["storage","storage"]`，列表只出现一次。
10. `允许=并集、拒绝=全无`：并集授权后逐项 `permission_check` 为真；拒绝后逐项为假。

**变异至少 3 轮**（每轮只改一个点，跑对应离线/指定 E2E；记录分支、run、退出码、失败断言原文）：

| 轮次 | 变异 | 预期被哪条判据杀死 |
|---|---|---|
| 1 | 合流键退回 `req_id`（同插件每次都新建 pending） | 1、2 |
| 2 | 追加能力不去重/不过滤已授权（或按能力集合而不是 plugin_id 合流） | 2、7、8 |
| 3 | 去掉拒绝锁（或关窗只 drop 当前 waiter） | 3 |
| 4（建议） | 停用不取消 pending | 5 |
| 5（建议） | 去掉启用门禁 | 6 |

D03 的 runner 需求：**1 轮干净基线 + ≥3 轮变异**；默认套件优先 `verify`（isolation）与 `verify:agent`，
`verify:http` 不在默认白名单、需单独获批或手工跑。D01 本身不占用 runner。

---

## 6. 风险、边界与待 PM 确认

### 已明确的边界

- **不是硬安全边界**：同 realm 插件仍可直接 `invoke` 自报 `plugin_id`（ADR-0006/0011 的老缺口）；本方案只收口
  “同意框次数/身份展示/拒绝语义”，不假装解决插件间冒名。
- **拒绝锁不持久化**：宿主重启即清空；“同次运行”按宿主进程算，WebView 重载不会清。
- **停用取消不写拒绝锁**：这是有意的，避免用户误关一次开关就永久不能再授权；若 PM 要求“停用也按拒绝记锁”，需要改本决策。
- **合流后的单一答复**：用户看到的是并集，允许/拒绝作用于整个 pending；不存在“只批准后追加的某一项”的 UI。
- **组级 60s**：从第一个请求起算；后加入的请求共享剩余时间，不单独续期。超时=拒绝=写拒绝锁（沿用现行 `consent_outcome`）。
- **窗口创建失败**：首个调用得到 `internal`，同组其他等待方得到 `false`；不会留下 pending。

### 待 PM 确认（D01 方案评审点）

1. **“仅第一次点启用时弹”与运行期 `http:<host>` 的冲突**：`http` 的域名能力在 manifest 里无法穷举，
   首次激活只能批量申请 `http` 本身；运行期第一次访问新域名仍需要一次授权。
   本草案保留这条运行期弹窗（否则 http 插件无法扩展域名），但受合流/拒绝锁约束。
   如果要求“启用后绝不弹”，需要改成设置页集中预授权，且无法覆盖未知域名 —— 不建议。
2. **拒绝后的恢复路径**：本草案按用户口径“同次运行内直接拒绝”，只能重启宿主恢复；
   设置页现有“撤销授权”是否应同时清除拒绝锁（作为显式重置）？D02 暂不实现，等 PM 决定。
3. **停用取消是否写拒绝锁**：本草案不写（重新启用可再问）；若要求写，用户体验会变成“关一次开关后本次运行不能再启用授权”。
4. **同意框刷新方式**：本草案用 `consent_details` 400ms 有界轮询，零新命令/零新事件；
   若 PM 要求事件推送，需先补接口决策（但不触达 Worker 方法/宿主命令）。
5. **新装默认关闭是否还要补“安装后不显示权限提示”**：本草案只保证不弹授权窗；设置页仍展示 manifest 声明的能力清单（只读），
   这是信息展示，不是授权。

---

## 7. 参考

- `src-tauri/src/services/permission.rs`
- `src/runtime/bridge.ts`
- `src/runtime/plugin-runtime.ts`
- `src-tauri/src/services/enabled.rs`
- `src-tauri/src/commands/plugins.rs`
- `src/consent/main.ts`
- `docs/adr/0005-command-layering-thin-command-bodies.md`
- `docs/adr/0006-plugin-host-in-web-worker.md`
- `docs/adr/0011-consent-identity-and-subscribe-acl.md`
- `tests/e2e/verify-isolation.mjs`（driveConsent / B3 / agent hooks 组）
- `tests/e2e/verify-http.mjs`（域名授权两扇框）
- `tests/e2e/verify-worker.mjs`、`tests/e2e/verify-agent-bridge.mjs`、`tests/e2e/verify-goat-gauge.mjs`、`tests/e2e/verify-release.mjs`
- `src-tauri/src/services/permission.tests.rs`
