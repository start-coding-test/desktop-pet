# 插件宿主进 Web Worker：身份由宿主分配，IPC 只剩一条受控通道（清单 L1 的方向）

清单第 42 项 L1 要「Web Worker 插件宿主：ADR + 原型（插件身份由宿主分配，不可伪造）」。
**决定：把插件代码从承载窗的 realm 搬进 module Worker；插件身份由宿主在创建 Worker 时分配并绑定到那条
`MessagePort`，Worker 侧不再有 `invoke` 可调；面向插件的 24 个方法改走宿主代理；
widget 的容器与 Shadow DOM 仍留在宿主 realm，Worker 只发渲染指令。**

**为什么算决策**：这是一次真实的换轨，不是"再优化一下"。它会推翻本仓一条写了很久的自我承认 ——
AGENTS.md 的「仍然拦不住的：同 realm 的插件自己 `import { invoke }` 绕过 JS 桥」。
代价是插件生态的加载路径与渲染契约都要重写一遍，所以先把它写死，别让 L2 拆到一半时重新论证。

## 收口的到底是什么（T10 逐条取证的现状，不是推测）

身份链的每一跳都在同一 realm 里传一个**字符串**：磁盘目录名 → `plugins_dir()`（`commands/plugins.rs:77`）→
`collect_manifests`（:99）→ `plugins_list` → 前端 `reconcile`（`plugin-runtime.ts:333`）→
**`buildContext` 里 `const pid = manifest.id`（`src/runtime/bridge.ts:121`）** → 每条 `invoke` 带上这个字符串 →
Rust 侧 `gate::plugin_capability`（`gate.rs:24-37`）只核 `is_safe_id` + `is_granted(id, cap)`。
链条上没有一环能回答「这条 invoke 是哪个插件模块发的」——`pid` 来自 manifest 自述，而 manifest 就在同 realm 可达的地方。

T10 数出的可伪造点里，前 6 条都源于同一个事实：**Worker 里没有 `window`**。
`@tauri-apps/api/core.js:328` 是 `return window.__TAURI_INTERNALS__.invoke(cmd, args, options);`
（同文件 `:72`、`:160` 同样直接取 `window`），所以插件模块在自己 realm 里拿到的是**同一条 IPC**；
而四份 capabilities 文件（`src-tauri/capabilities/`）只列 `core:*` 权限、没列应用命令，
应用命令唯一的闸就是那个认字符串的 `gate.rs`。具体能干什么（逐条依据是派单工作区里 T10 的 `identity.md`；那份产物不入库，所以结论已在下面逐条内联）：

1. 冒名任意**已授权**的 id 调带 `pluginId` 的命令（借能力，不是提权：非法 id 与未声明能力照样被拒）。
2. 冒名发 bus 消息（`bus_publish` 在 pet/settings 那两路采信自报 id）。
3. 直接伪造 `core:event` 事件投递到别的窗口，**绕开 `bus_publish` 的全部 Rust 校验**（`core:default` 含 `core:event:default`）。
4. 窃听全部跨窗中继消息（Rust 把 bus 事件 emit 给所有窗口，无收件人筛选）。
5. `bus_peek` 只查窗型与 `:widget` 后缀，不查 topic 归属 → 读别人最近一份 widget 数据。
6. 设置窗里跑的 widget 代码天然过 `gate::settings` → 能调 `permission_revoke`（撤销任意插件授权并清其存储）、
   `plugin_enabled_set`、`autostart_set`、`hotkey_set`、`pet_skin_*` 这些**纯凭窗口 label 放行**的命令。
7. 同意框里的插件显示名是自报的（能伪造的只有 UI 名字，能力本身仍要 manifest 声明过）。

**本决定的覆盖面**：1–7 全部收口。Worker 里没有 `window` ⇒ 拿不到 `__TAURI_INTERNALS__` ⇒ 没有裸 IPC，
出入只能走宿主给的那条 `MessagePort`；而那条 port 在创建时就绑死了宿主分配的 id，
`gate::settings` 那类 label 门禁也不再被插件代码天然继承（改由宿主侧按 id 代理）。
**不在本决定范围内**：`plugins_list` / `plugin_file_version` 这类宿主运行时自用命令仍无能力门禁——
它们不该暴露给插件，属于 L1 原型里"接口面收窄"的具体一项，不是安全模型漏洞。

## 契约（L1 原型必须遵守的形状）

- **接口面 = 24 个方法**：`buildContext`（`bridge.ts:120-258`）暴露的 20 个（bus 2 / storage 3 / ble 5 / widget 1 / pet 3 /
  http 1 / notify 1 / overlay 3 / log 1）加 `createAgentHooksApi` 的 3 个。（那份表不入库：每个方法背后的命令名我逐条核过都在 `lib.rs:96` 的 48 条注册表里，缺失 0。）Worker 版桥必须覆盖这张表，不许多也不许多年。
- **渲染层留在宿主 realm**：widget 的容器与 Shadow DOM 由宿主持有（`widget-host.ts`），Worker 只发渲染指令。
  四个插件对主文档 realm 的依赖共 84 处，分级是 **W 可做 6 / 需宿主代理 78 / 做不到 0**——
  也就是说没有哪条必须在 Worker 里做不到的事，但绝大多数要么变成消息、要么留在宿主侧。
- **引导形状已由实测定死**（见下面两节）：宿主自己出一个**同源**的 worker 脚本（进 `dist` 的构建产物，
  Vite 的 `?worker` + `worker.format:"es"`），由它 `import()` 插件入口的绝对 petplugin URL；
  入口自己的相对子模块由 Worker 按 ESM 规则解析，宿主不做 URL 重写。
  「让 Worker 直接吃 petplugin URL」「blob:/data: 自举」「宿主 fetch 源码再转 blob」这三条在打包版全部走不通，
  不要再当备选提出。

## 实测结论（2026-10-14 凌晨，PM 起实例量的，不是推理）

方法：临时插件 `zz.worker-probe`（零权限，只跑实验并把读数写进 `globalThis.__probe`）经 petplugin:// 进宠物窗 realm，
外部只用 CDP 读那份副作用 —— 这是本仓判 CSP 的唯一合法姿势（CDP 求值不受 CSP 约束）。
dev 用 `npm run dev:debug`（无 CSP），打包版用 `tauri build --no-bundle` 的 release exe（CSP 以响应头下发，
所以读到的 `meta[http-equiv]` 是 null，照实记）。探针与临时资产测完已全部删除。

| # | 实验 | dev | 打包版（CSP 生效） |
|---|---|---|---|
| A | 直接用 petplugin URL 起 worker | **SecurityError**：脚本与 origin `http://localhost:1420` 不同源 | **同样 SecurityError**（origin 换成 tauri.localhost，规则不变） |
| B | 同源 blob: 起 module worker | 通过；worker 内 `window`/`document`/`localStorage` 全 undefined，`OffscreenCanvas` 是 function | **被 CSP 拦**：Refused to create worker from 'blob:'，违反 `script-src 'self' http://petplugin.localhost 'sha256-…'` |
| C | 经典 blob: worker + importScripts 取 petplugin 脚本 | NetworkError（跨源脚本加载失败） | 先被 CSP 拦（同 B 那条 directive） |
| D | 同源 URL 起 worker | 只有 404 类错误，**没有任何 CSP 报错** | 同样没有 CSP 报错（`'self'` 放行） |
| E | data: URL 起 worker | 构造成功 | **被 CSP 拦** |
| F | 页面 realm `fetch` 插件文件 | 200 | **被 CSP 拦**：违反 `connect-src 'self' ipc: http://ipc.localhost` |
| G | 页面 realm 动态 import 绝对 petplugin URL | 通过（今天的插件就是这么加载的） | 通过 |
| H | **同源 worker 内部** import 绝对 petplugin URL | —— | **通过，插件文件真的被 Worker 取到并执行了** |

由此定下 L1 的形状，一条都不靠猜：

1. **Worker 引导脚本必须是同源资产**（进 `dist` 的构建产物）。A/B/C/E 四条在打包版都走不通：
   petplugin URL 撞跨源规则，blob:/data: 撞 CSP；D 说明 `'self'` 放行，H 说明同源 worker 里 import petplugin 可用。
2. **相对说明符由 Worker 自己解析，宿主不做绝对化**（本条 2026-10-14 晚由原型实测**推翻**了原先的判断，
   原文见下一节的「更正」）：插件入口里的 `./leaf.js` 在 Worker 里按 **入口自身 URL** 解析成
   `http://petplugin.localhost/<id>/leaf.js` 并取到内容 —— todo 的 `./todo-txt.js`、`./topics.js` 同理。
   原先那条「H 里 `import('./leaf.js')` 解析成 `http://tauri.localhost/leaf.js`」量的是**引导脚本自己**写的
   相对引用（referrer 是 Worker 脚本），不是插件模块的相对引用，两者不能混。
3. **宿主也别想用 fetch 代取插件源码**（F 被 connect-src 拦）。要么把 petplugin 加进 connect-src（那要再过一次 ADR），
   要么引导脚本用 import 而不是 fetch —— H 已证明 import 这条路通，所以**本波不必改 CSP**。
4. **Worker 里没有 window/document/localStorage**（B/H 实测 undefined）：真隔离成立，
   `bridge.ts:121` 那个自报 id 的伪造面随之消失；「迁移前的旧副本」那条退路也彻底没了。
5. **OffscreenCanvas 在 Worker 里可用**（function），主文档侧 canvas 元素确有 `transferControlToOffscreen`；
   T10 判为 W 的 6 条画布类依赖可以搬，但画布所有权的交接只能在主文档发起。

## 更正与补测（2026-10-14 晚，L1 原型第一天，`npm run verify:worker` 25 条 + `npm run unit` 118 条实测）

上一节留的两条已量完，另有一条被推翻。方法：`src/runtime/plugin-worker.ts` 作为同源资产进 `dist`，
`src/runtime/worker-plugin-host.ts` 在宠物窗一侧造 Worker、转方法，取证插件 `zz.l1-probe`
（`tests/fixtures/l1-probe/`，跑完即删）把 realm 事实写进自己的隔离存储，外部只读这份副作用。

1. **引导形态定样 = Vite 的 `?worker` + `worker.format: "es" as const`**。Vite 8.2.2 实测四种形态的产物：
   - `import W from './x.ts?worker'` → `new Worker('/assets/x-<hash>.js',{type:'module',name:…})`，
     文件带 hash ✓、是真正的 ESM（顶层 `const`，无 IIFE 包裹）✓、路径同源 ✓ → **采用**。
     默认 `worker.format` 是 `iife`，产物虽同源带 hash 但**没有** `type:'module'`（脚本体被包成
     `(function(){…})()`），module worker 起不来，所以配置项必须显式写；
     而 `format: "es"` 不加 `as const` 会让 `npm run build` 的 `tsc` 报 TS2769（`string` 不匹配
     `"es"|"iife"`）—— 本仓 `vite.config.ts` 用的是函数式 `defineConfig(() => ({…}))`，没有上下文类型。
   - `new URL('./x.ts', import.meta.url)` 配 `new Worker(…,{type:'module'})` → 同样落成那个带 hash 的同源文件
     （与 `?worker` 共用同一份产物）。能用，但多一条 `import.meta.url` 解析路径，本波不选。
   - `?worker&inline` → `Blob` + `createObjectURL`，并留一条 `data:text/javascript` 回退 ——
     两条都在打包版被 CSP 拦（就是上表 B/E），**禁用**。
   - 裸 `new URL('./x.ts', import.meta.url).href`（不配 new Worker）→ 被当静态资产**原样 base64 内联成
     `data:video/mp2t;base64,…`**，TypeScript 根本不转译 —— **禁用**，别拿它当「绝对化」的手段。
2. **`?v=` 与 `no-store` 在 Worker 路径上都成立，但 ESM 模块映射表的老规矩不变**：
   - 入口 URL 实测带着 `?v=1791972970068` 进 Worker（协议侧 `request.uri().path()` 天然剥查询串，
     `src-tauri/src/commands/plugins.rs:230`），取回的是新内容。
   - **覆盖子模块**（URL 恒定、无查询串）之后：同一个还活着的 Worker 拿回的是**旧实例**；
     停用 → 换一个 Worker 重新 boot → 拿回**新内容**。后者就是 `Cache-Control: no-store`
     （`plugins.rs:309-312`）在 Worker 的取回路径上确实生效的证据。
   - 推论：Worker 宿主的失效手段是「**terminate 换新的**」，而不是重载文档。所以
     `plugin-runtime.ts` 的热重载判定改成 `active.has(id) && !workerHosted.has(id)` ——
     给 Worker 插件整页换茬既换不掉它的模块表，又白白抹掉窗口状态。
3. **更正**：上一节第 2 条原写「相对说明符要由宿主绝对化」，实测不成立（见上）。
   插件的相对子模块在 Worker 里正常解析，L2 迁移**不需要**写 URL 重写器 —— 少一整块最易出错的面。
4. **原型收口了什么**：探针在 Worker 里 `window`/`document`/`localStorage` 全 undefined、
   `__TAURI_INTERNALS__` 不可达、裸说明符 `@tauri-apps/api/core` 当场 `Failed to resolve module specifier`、
   `fetch('http://ipc.localhost/…')` 回 500（拿不到可用通道）；协议层伪造（表外方法名、冒名调
   `permission_revoke`、借表内方法发别人的 topic）全部被宿主拒，跨插件读别人的存储读到 `null`。
5. **原型没收口的部分（L2 的活，别当成已完成）**：widget 的 `mount()` 仍跑在宿主 realm
   （`widget-host.ts` 没动），所以 ADR 第 6 条「设置窗里 widget 天然过 `gate::settings`」那条口子
   还在；`?v=` 只钉入口、子模块靠换 Worker。
   ~~打包版 CSP 下这条路径尚未复跑~~ —— **已补上**（2026-10-14 晚）：`npm run verify:release` 里新增
   「L1 Worker 宿主在打包版 CSP 下成立」一组 14 条断言（release 套件现共 24 条），
   在全新 `tauri build -- --no-bundle` 产物上复跑通过，dev 与打包两边从此都有可重跑的证据。

**判据口径**（本仓踩过的坑，写死）：以上每条都取**页面自身代码的副作用**为准；
拿 CDP 求值判 CSP 会得出「CSP 没生效」的假结论。


## 被否掉的三条路

- **只加一层 `postMessage` shim、插件仍在宿主 realm**：那是伪隔离。上面第 1–3 条一条都收不掉，
  因为 `__TAURI_INTERNALS__` 还是可达——而这正是本项要解决的问题本身。
- **把 DOM/Shadow DOM 一起搬进 Worker**：做不到（Worker 无 DOM），而且会砸掉「每插件一个 Shadow DOM 插槽」
  这条既有安全边界（AGENTS.md「插件不得直接操作 DOM/画布」）。
- **先做 L2 四插件迁移、再回来补 ADR**：L2 是 48h 的量，接口契约里的任何一条（id 绑定方式、渲染指令形状）
  改一次就要重迁四个插件。顺序必须是原型钉死契约 → 再迁移。

## 分期与退出条件

- **L1 原型**（2026-10-14 落地）：`com.pet.todo` 已在 Worker 里跑通 —— badge 挂载、经通道写存储并落盘、
  相对子模块 `./todo-txt.js` 解析成立（`npm run verify:worker` 前三条）。退出条件里「第 1–6 条可伪造点逐条复现不出」
  **达成 4 条**（1 冒名调用、2 冒名发 bus、3 裸 IPC/伪造事件投递、5 跨插件读存储），
  外加协议层表外方法名被拒；**没达成的是第 6 条**（设置窗里 widget 仍跑宿主 realm）与第 4 条
  （bus 中继的窃听面 —— 那本来就是宿主侧 emit 的收件人筛选问题，不因为 Worker 而消失）。
  代码：`src/runtime/plugin-worker.ts`、`plugin-worker-protocol.ts`、`worker-plugin-host.ts`，
  开关是宠物窗 localStorage 的 `host:worker-plugin-host`（逗号分隔 id 名单，缺省空 = 老路径）。
- **L2 全面落地**：四个插件迁移 + widget 的渲染指令化（把第 6 条一起收掉）+ 全部 `verify:*` 通过。
  `verify-isolation` 里那批「越权尝试被拒」的断言要**新增而不是替换**——同 realm 越权用例全部被拒是 L2 的验收，本波先把判据立起来。
  拆两步的依据是 T16 取证（`reference/T16-summary.md`）：**阶段一不用改任何插件代码** ——
  四个入口闭包共 20 个文件对宿主 realm 零依赖（B=0、C=0），把 Worker 变成默认即可收口第 1/2/3/5 条；
  **阶段二才是硬骨头** —— 338 行 DOM 全在 widget 图，缺的是渲染指令词汇表与一条反向事件通道（`el-on` 17 行在 24 表里没有对应物）。
- L1/L2 都不改能力名单与授权模型（K3/K4 交付的那套），改的只是「谁在替插件说话」。

## 增项记录（2026-10-17，B3 常驻状态行）

- **方法表从 23 加到 24**（A02 先合拿了 23，B3 的 `pet.setStatus` 按 PM 口径成为第 24）：新增 `pet.setStatus`（命名空间 `pet`）。宿主侧实现落在
  `src/runtime/bridge.ts` 的 `pet` 段（**能力仍是 `pet:say`，不新增能力**），派发表加在
  `src/runtime/worker-plugin-host.ts`，Worker 侧代理加在 `src/runtime/plugin-worker.ts`，
  表本体在 `src/runtime/plugin-worker-protocol.ts`。
- **为什么**：B3（气泡常驻状态行）要让插件把一行状态长期挂在宠物旁。插件**入口默认就在 Worker 里跑**，
  名字不进表等于 Worker 里的入口一个都调不到这个方法（A9b 的 agent 桥正是这么用）。
- **这是明确的边界扩张，不是放宽校验**：表的闭集口径不变（「表即插件能说的全部话」），
  `tests/unit/unit-worker-host.mjs` 照旧**逐字钉死「恰好等于这 24 个名字」**（不改成「包含」「至少」），
  计数与文件头文案同步改成 24。
- **本文两处计数已同步为 24**（第 5 行、第 43 行；A02 先合拿 23、B3 拿 24 的 PM 口径，2026-10-18）。原记：
  22→23 的旧口径，rebase 到 dd715d6 后作废。
- 其余口径不变：`pet.setStatus` 仍只能由**插件入口**调用（`WIDGET_CALL_METHODS` 不加名字，
  widget 的渲染契约不动，见 ADR-0008）。
