# ADR-0008：widget 进 Worker —— 虚拟节点 + 批量渲染指令 + 反向事件通道

- **状态**：已接受并已全量落地（决策 5 由 T18 实测证实；四个示例插件 2026-10-15 全部改完，
  同日按决策 9 收口 —— widget 默认进 Worker）
- **日期**：2026-10-15
- **相关**：[ADR-0006](0006-plugin-host-in-web-worker.md)（插件进 Worker，阶段一已落地）、
  [ADR-0004](0004-style-src-unsafe-inline-kept.md)、`docs/architecture/ARCHITECTURE.md` 的 widget 宿主一节、
  取证输入 [docs/process/T16-WIDGET-REALM-GAPS.md](../process/T16-WIDGET-REALM-GAPS.md)（本 ADR 的每一条都对得上它的编号；
  原件 `.dispatch/arch-p2/reference/T16-gaps.md` 在派单工作区、不入库，收进库是为了让引用打得开）

## 背景

阶段一把四个插件的**入口**搬进了 Web Worker，实测入口闭包对宿主 realm 零依赖（434 行读数里 B=0、C=0），
所以入口不需要新契约。剩下的 338 行 DOM 依赖全在 **widget 图**（16 个 widget-only 文件）里。
widget 今天是宿主 realm 直接 `mount(shadowRoot, ctx)` 拿到真的 ShadowRoot 自己建节点
（`src/runtime/widget-host.ts:86-95`），这与「插件不得直接操作 DOM」这条边界本来就有张力，
阶段二要把它收成真实隔离。

取证给出的 14 个桶里，四个不是「把 DOM 调用换个名字发出去」能承接的：`el-on`（17 行，反向事件）、
`host-event` + `host-dpr` + `dom-measure`（7 行，尺寸与重绘时机）、`canvas-2d`（2 行）、`el-html`（1 行）。

> **落地时的词汇表订正**（2026-10-15，写实现前对 widget 图 15 个文件重扫一遍的结果）：T16 那张固定
> token 表**漏了整类真实用法**——`setAttribute` 13 处、`.value=` 13 / `.checked=` 11 / `.type=` 10 /
> `.placeholder` 4（这些是 **property 不是 attribute**，写进 attribute 不生效）、`replaceChildren` 8 处、
> `createElement("style")` 8 处（四个插件都从 JS 往自己的 closed shadow root 注入 CSS）、`preventDefault` 1 处。
> 所以契约里的 op 词表是 **12 个按实测定的 kind**，不是照那 14 个桶一一翻译。
> 教训与 T16 那条同源：**基线数字不能当覆盖面的证据**，固定词表的扫描只会漏掉词表里没有的东西。
>
> **同一句教训又中了一次**（2026-10-15 晚些，写迁移卡前把 `innerHTML` 模板字符串本身摊开看）：
> `plugins/com.pet.hr-ble/widget.js:293` 那段模板里有 `name="hr-mode"` —— radio 靠它分组。
> 固定 token 表按 `createElement` 的调用面数，**模板字符串里的属性名一律看不见**，所以 `name` 当初就没进表。
> 已补进 `WIDGET_ATTRS`（不加载资源、不给导航、不带脚本面，风险面与 `id`/`class` 同级），并有一条单测
> 钉住它的来源，防止下一次有人按那张旧表把它撤掉。

## 决策

### 1. 载体：Worker 侧虚拟节点 + 批量 ops，不做逐调用代理

逐条 `render-cmd:*` 把每个 DOM 调用变成一条 postMessage 被**否决**。三个理由：

- 338 个调用点会产生同样数量的跨 realm 往返，`el-append` 单桶就 96 条，消息数完全不可接受；
- 逐调用代理要求 Worker 侧**同步**拿到宿主的结果，而 postMessage 只有异步 —— `querySelector` 这类
  「取回一个节点再用」的写法在异步形状下没法原样表达，等于强迫所有 widget 改写；
- 插件源码的形状会变得更差：现在写 `const el = document.createElement("div")` 之后随便用，
  代理化之后每个返回值都是 Promise。

采用**虚拟节点**：Worker 里有一个极小的节点对象图，方法名沿用插件现在用的那一套
（`createElement` / `append` / `textContent` / `className` 与 `classList` / `style` / `dataset` / `on`），
但它只改 Worker 侧状态并把改动**攒成一条 ops 批次**发给宿主；宿主按批次 apply 到那棵真实树上。
这样六个桶（`el-create` / `el-append` / `el-text` / `el-class` / `el-style` / `el-dataset`，合计 248 行）
由**同一个机制**承接，widget 文件的改动点只有「从 `document` 建节点」改成「从 `ctx.dom` 建节点」。

**批次口径**（写死，不许执行者自己定）：一次微任务flush 合并一批；单条消息 ops 上限 512，超出切成连续多条；
每条消息带单调 `seq`，apply 必须按 `seq` 顺序（同一 Worker 通道的 postMessage 本身有序，`seq` 是用来**断言**这个顺序没被实现破坏，不是用来重排）。

### 2. 节点身份：宿主分配的 nodeId，Worker 只能引用自己见过的 id

`dom-query` 那 57 行不是「把 querySelector 搬进 Worker」，而是**取消查询语义**：Worker 侧的虚拟节点持有对象身份，
宿主侧维护 `nodeId → 真实节点` 的映射；之后的每条 op 都带那个 id。
**id 由 Worker 侧单调分配**（落地时才想清楚的一条：批次里 `create` 之后的 op 要立刻引用它，
等宿主回发就等于把每次建节点变成一次往返），宿主的安全不变量因此是
「**只承认自己按 op 创建过的 id**」——未知 id、跨 session 的 id、非本 Worker 建过的 id 一律拒绝并报错。
每个 (pluginId, region) 有独立映射，所以一个 widget 既拿不到别人的节点，也没法靠猜 id 去碰宿主节点。

`querySelector` 的既有调用点在迁移时改成「持住你创建时拿到的那个节点引用」——这是**收窄**：查询能力从插件面上消失。

### 3. 反向事件：白名单事件名 + 净化后的标量载荷

`el-on` 是当时那张 22 方法表里完全没有对应物的那条通道。形状定死：

- Worker 侧 `node.on(event, handler)` → 发一条 `sub` op；宿主在该节点上 `addEventListener`；
- 事件回流：`{t:"widget-event", nodeId, event, value}`；`value` 只允许**标量或纯对象快照**
  （`value` / `checked` / `text` / `index` / 按键名白名单挑出的字段），**永远不传事件对象本身，也不传回调**
  （跨 realm 传函数与 DOM 事件对象就是 T16 分类里的 C 类，本 ADR 不接受它出现）；
- 事件名白名单：`click` / `change` / `input` / `submit` / `keydown`，不在表里的宿主直接拒；
- 取消：`node.off(event)` 发 `unsub`，与 `bus.subscribe` 的退订形状一致；widget unmount 时宿主回收全部监听。

`el-dataset` 与 `el-on` 这对「点了要认出是谁」的写法**不需要特殊通道**：dataset 就是节点上的普通 map，
事件回流带 `nodeId`，handler 在自己那个虚拟节点上直接读它的 dataset。

### 4. 尺寸、dpr 与测量：宿主观测后推，Worker 侧没有 `window`

`host-event` / `host-dpr` / `dom-measure`（合计 7 行）合并成一条通道：宿主对 widget 容器建 `ResizeObserver`，
尺寸变化或 `devicePixelRatio` 变化时推 `{t:"widget-layout", width, height, dpr, measured}`；
`measured` 是宿主量好的关键节点尺寸（对应 `canvas.clientWidth` 那 1 处）。
Worker 侧不再出现 `window`、`devicePixelRatio`、`clientWidth`，重绘时机由这条推送驱动
（取证确认 widget 图里没有 `requestAnimationFrame` 依赖，所以不需要再开一条帧通道）。

### 5. 画布：首选交出画布所有权，退路是通用 paint-ops（推翻 T16 gaps 的 (a)）

两个真实站点：`plugins/com.pet.astock/charts.js:39`、`plugins/com.pet.hr-ble/widget.js:167`。

- **首选（已由 T18 证实）**：宿主建 canvas 后 `transferControlToOffscreen()`，把 OffscreenCanvas 作为 transferable 交给
  该 widget 的 Worker，Worker 用 `OffscreenCanvasRenderingContext2D` 自己画。绘图代码留在插件侧，宿主不知道画的是什么。
  实测（2026-10-15，Edg/155.0.4283.45）：未入文档与已入文档两种 64×64 canvas 都交接成功，Worker 内填满
  `rgba(255,0,0,1)` 后 `getImageData` 读回中心像素 `[255,0,0,255]` 逐数相等；判据是像素比对而不是「没抛异常」
  （PM 复跑时把填充色改成绿色，判定立即翻成 paint-ops，证明这条不是恒真）。
  落到契约上是 **一条 inbound（`handoff`）而不是新的 op kind**：那 12 个名字描述的是「怎么改树」，
  而这条是「把一件宿主资源交出去」；交接只能走 `postMessage` 的 transfer 列表，且**交接后主线程不得再对该 canvas 取上下文**。
- **退路（如果 T18 实测不成立）**：开一条**通用 2d 指令通道**——Worker 发 `beginPath/moveTo/lineTo/stroke/fillText/...`
  这种成串的绘制 op，宿主取自己的 2d context 执行。**这里要明确否掉 T16 gaps 写的 (a)**：
  「宿主按数据指令自己画折线」意味着把 astock 的图表语义写进宿主，那会让框架本体认识某个插件的画面，
  与「本体只提供窗口/渲染/运行时」的既定架构冲突；通用 paint-ops 不带任何插件语义，才是可接受的退路。
- 尺寸与 dpr 一律走决策 4 那条推送，画布大小由宿主设，Worker 只负责画。

### 6. 不开 HTML 字符串通道

`el-html` 只有 1 处（`plugins/com.pet.hr-ble/widget.js:293`），改成结构化 ops 的成本最低，
而一旦开出 `html` 指令，就等于把「插件可以注入任意标记」这条既有边界重新打开（AGENTS.md 的安全边界共识）。
**协议里没有 `html` op，并且用一条单测把这个事实钉住**（有人加回来就红），不是只在文档里说一句「不要加」。

### 7. 区域边界随通道一起搬过来

今天 `ctx.host`（`agentHooks.*`）只在 `region === "settings"` 时注入（`widget-host.ts:95`）。
阶段二后 widget 的代码跑在 Worker 里，这条边界必须**由宿主在建 Worker 时告知 region 决定注入面**：
boot 消息带 `region`，非 settings 区的 Worker 里根本没有 `host` 这一组方法，不是「有但调用被拒」。
这条必须有运行时断言（badge / overlay 区里 `ctx.host` 不存在），否则搬迁过程很容易把它写成软门禁。

### 8. 生命周期：一个 (pluginId, region) 一个 Worker

- 入口 Worker 由插件运行时的宿主持有（阶段一形状，不变）；
- 每个 widget 由**它所在窗口的文档**建自己的模块 Worker（同源 `?worker` 资产，ADR-0006 已验过 CSP 成立）；
  所以同一个插件可能同时有 2~3 个 Worker（入口 + badge + settings），这是预期而不是泄漏；
- `unmount` / 窗口关闭 → `terminate()`；热重载沿用 ADR-0006 的失效机制：**终止 Worker 就是失效手段**，
  不是重载文档。

### 9. 迁移台账记在代码里；四片齐之后翻默认、删台账，例外名单改名换义

**迁移期（A10–A13 落地时）**：接缝认两条并取并集 —— 代码名单 `WIDGET_WORKER_MIGRATED`（PM 验收每张
卡时追加）与 localStorage 的 `host:widget-worker-plugin-host` 点名。理由是「迁完但生产还走宿主」这个
中间态压根不存在：改完的 widget 是照 `ctx.dom` 写的，在宿主 realm 里必然白屏，而 localStorage
换一台机器就没了。执行者不许自己改名单，否则四张卡都动同一处就成了串行点。

**收口（四片全放行之后）**：默认改为**一律进 Worker**，`WIDGET_WORKER_MIGRATED` 删除，只留一把
localStorage 例外名单。这把键**连名带义一起换**：新的 `host:widget-realm-plugin-host` 是「留在宿主 realm」
的点名，与阶段一的 `host:realm-plugin-host` 同向同命名法。不复用旧键名是因为翻默认之后
`host:widget-worker-plugin-host` 的语义正好反了 —— 一把键两种意思，迟早有人按旧义去点，
排查成本远高于改一次名字。

例外名单的定位是**逃生门**：给还没照契约写的第三方 widget 留一条回到宿主 realm 的路，
不是插件作者的配置项（在例外名单里时 `ctx.dom` 是 undefined，照契约写的代码会白屏）。
两条路线的取证都还在：`verify:worker` 第⑧组把「默认 Worker / 点名宿主 / 清掉回 Worker」三段都钉住，
四个插件各自的运行时套件钉一条插槽壳上的 realm 戳，`verify:release` 再证**打包版 CSP 下**同一条路线
（Worker realm 挂载、没有 document/window、`ctx.dom` 在、逢 call 必回、realm 戳、以及一条
「没有 widget 装载失败」的兜底 —— 翻默认那轮就是靠它逮到夹具没装 `widget.js` 的 404）。

## 后果

- **widget 的调用面比入口的 23 表窄**：只有 `bus.publish` / `bus.subscribe`，加上 settings 区的 `agentHooks.{status,install,uninstall,set}`（`set` 由 A02 为设置页四选一追加）。`storage` / `http` / `pet.*` / `notify.*` 一概不开 —— widget 今天在宿主 realm 里也拿不到它们，借搬迁扩权不接受；要开得先改本 ADR。
- **宿主对每一次 `call` 都必须回一个 `result`**（含它不认的方法名，回 `ok:false`）。`boot` 会 await 插件的 `mount()`，插件在 mount 里发出的调用没人回包，这个 widget 就永远起不来 —— 这条由 `tests/unit/unit-widget-worker.mjs` 钉住，不靠实现者记得。

- 契约实现落在 `src/runtime/` 目录下新增的三个文件与一处接缝：widget-protocol.ts（消息形状 + op 词表，
  和 plugin-worker-protocol.ts 一样**不许 import host-error 与 @tauri-apps**）、widget-node.ts（Worker 侧虚拟节点）、
  widget-renderer.ts（宿主侧 apply），接缝是 widget-host.ts 的 doMount()。那张能力方法表（写本 ADR 时 22 条）**不动**——它管能力调用，widget 渲染走的是新通道。（后来 A02 为设置页四选一给它加了第 23 条 `agentHooks.set`，与本 ADR 的渲染通道无关，见 ADR-0006。）
- 四个插件的 widget 图已迁移完毕（A10–A13，2026-10-15）：待办 1 文件 / agent 桥 1 / 心率 1 /
  盯盘 **19 个文件**（按 `widget.js` 的 import 闭包算，含 `market.js` 与 `sources/*` ——
  数据模块也会一起被 Worker 加载）。四张卡白名单不重叠，真并行。
- 决策 5 的首选形状已由 **T18 实测证实**（2026-10-15，WebView2 `Edg/155.0.4283.45`：未入文档与已入文档的
  canvas 都能把控制权交给模块 Worker，Worker 里画完 `getImageData` 逐数对得上），迁移按「Worker 直画」做，
  不开 paint-ops 指令通道。退路（交接被拒时留主线程可画的 canvas）已在渲染器里实现并有一条断言。
- 本 ADR 不改变 CSP：不新增 `worker-src`、不开 `blob:`，与 ADR-0006 第 5 条一致。
