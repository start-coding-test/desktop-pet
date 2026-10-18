// Pet 插件 SDK 类型面（K1）。
//
// 两份契约面 —— 别合并，它们不是同一个 realm 里的东西：
// - PluginContext：宠物窗里 index.js 的 `activate(ctx)` 收到的对象，宿主实现是
//   src/runtime/bridge.ts 的 buildContext()（:110）。失败形态**一律 Promise reject**
//   （gated 的 throw 在 async 体内，bridge.ts:82-93）。
// - WidgetContext：widget.js 的 `mount(root, ctx)` 收到的对象，宿主注入实现是
//   src/runtime/widget-host.ts 的 doMount()（:149-164）。widget 侧总线方法是**同步函数**，
//   违规**同步 throw**（src/runtime/topic-acl.ts:43-55）；且 `ctx.host` 只在 settings 区存在
//   （widget-host.ts:155-163）。阶段二的渲染契约三个键（dom / onLayout / onCanvas）只在
//   Worker 路线注入，见 ADR-0008。把两面合并等于给插件一把宠物窗里拿不到的钥匙。
//
// 行号为 2026-10-15 现场；行为口径另见 docs/PLUGIN_SDK.md 与 T01 取证报告
// （.dispatch/arch-p2/work/T01/sdk-surface.md）。

import type { StandardTopic } from "./topics.js";

/** petdex 九状态名。词表来源 src/pet/petdex-states.ts:9-18（PetStateId），
 * src/pet/sprites.ts:22 把它别名为 ActionName；运行期白名单 src/pet/host.ts:9（PET_ACTIONS）。 */
export type PetAction =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

/** ctx.http.request 的响应。序列化形状来自 Rust `HttpResponse`
 * （src-tauri/src/services/http.rs:24-30，无 rename_all，字段按原名 snake_case 输出）。 */
export interface HttpResponse {
  status: number;
  /** 响应头 Content-Type 原值；宿主按它的 charset 解 gbk / gb2312 / gb18030，其余按 UTF-8 lossy（http.rs::decode_body） */
  content_type: string | null;
  body: string;
  /** body 超过上限被截断时为 true（http.rs:19、221-224，上限 1 MiB） */
  truncated: boolean;
}

/** ctx.http.request 的 options（bridge.ts:203） */
export interface HttpRequestOptions {
  method?: string;
  headers?: [string, string][];
  body?: string;
}

/** ctx.overlay.show 的 options（bridge.ts:247-255）。
 * x / y 是**逻辑像素**的落点（缺省 24,24）；宿主只保留「屏内夹紧」一件事：按请求点所在
 * 显示器的工作区整块夹回，找不到显示器就退回主屏（src-tauri/src/window/overlay.rs:103-128）。
 * height 实际被钳到 48~900、缺省 200（overlay.rs:66-71）。
 * placement 已废弃、接受但忽略（ADR-0010 决策 3）：位置改由插件直传坐标并自己存。 */
export interface OverlayShowOptions {
  /** 逻辑像素；缺省 24（插件第一次显示时不知道屏幕多大，宿主兜底） */
  x?: number;
  /** 逻辑像素；缺省 24 */
  y?: number;
  height?: number;
  /** @deprecated 位置改由 x / y 决定（ADR-0010 决策 3）：接受但忽略，传值时宿主只记一条 warn */
  placement?: string;
}

/** settings 区 widget 专属：ctx.host.agentHooks（定义在 bridge.ts 的 createAgentHooksApi，
 *  只经 widget-host 注入，边界见 ADR-0001）。名字面由 ADR-0006 那张表管，增删先改 ADR。 */
export interface AgentHooksApi {
  /** Rust `agent_hooks_status` 的返回：{ exe, files, managed, installed, expectedPerFile,
   *  agent, displayName, hint, options }（A02 起按「当前那一家」查，options 是四选一清单）；失败 reject */
  status(): Promise<unknown>;
  /** Rust `agent_hooks_install` 的返回：{ files: reports, hint }；没找到当前 Agent 的配置目录时 reject */
  install(): Promise<unknown>;
  /** Rust `agent_hooks_uninstall` 的返回：{ files: reports }（摘净每个已接线适配器的条目）；失败 reject */
  uninstall(): Promise<unknown>;
  /** Rust `agent_linkage_set`：切换联动的 Agent —— 先卸旧、成功后再装新，卸旧失败就停在原状态。
   *  `confirm` 只为一件事：ZCode 的 hook 总开关显式关着且用户自己配过条目时，宿主第一趟 reject 并说明
   *  「打开会连带启用 N 条」，界面问过用户之后带 `true` 重试。**不带 confirm 时一个文件都不会被改。** */
  set(agent: string, confirm?: boolean): Promise<unknown>;
}

/** 总线 topic 的**注释性**宽联合（K2）：标准 topic（`StandardTopic`，定义处 packages/sdk/topics.js）
 * **或任意字符串**。刻意保留任意字符串：私有 topic（`<自己 id>:xxx`、`<自己 id>:widget`）必须继续合法 ——
 * topic-acl 只按前缀归属判，不查标准名单。
 * 注：`StandardTopic | string` 在 TS 里会塌缩成 string，这是有意的，别把它收紧成只允许标准 topic。 */
export type BusTopic = StandardTopic | string;

/** 宠物窗桥侧总线（bridge.ts:122、128）。与 WidgetContext.bus 不同：这里全是 async，失败 reject。 */
export interface PluginBus {
  /** 只能发 `<自己 id>:` 前缀，且不能是通配（src/runtime/topic-acl.ts:9-14）。跨窗中继失败不 reject，只 console.error（src/runtime/event-bus.ts:36-38）。需要能力 `bus:publish` */
  publish(topic: BusTopic, payload: unknown): Promise<void>;
  /** 需要能力 `bus:subscribe`（不声明会在激活时被拒）。resolve 出退订函数；不手动退订则停用时由宿主回收（src/runtime/subscriptions.ts:12、plugin-runtime.ts:201） */
  subscribe(topic: BusTopic, handler: (payload: unknown) => void): Promise<() => void>;
}

/** 宠物窗桥侧存储（bridge.ts:135-139；Rust services/store.rs，按插件 id 隔离落盘）。 */
export interface PluginStorage {
  /** 值是任意 JSON；**没写过的键 resolve 出 null**（store.rs:111，Result<Option<Value>>） */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 宠物窗桥侧 BLE（bridge.ts:141-172）。扫描与连接会话按插件持有者计数（src/runtime/resources.ts:12-25）：
 * 不是最后一个持有者时 stopScan / disconnect 静默成功、不发 IPC（bridge.ts:155、167）。 */
export interface PluginBle {
  /** 需要能力 `ble:scan`；失败会把持有者登记回滚（bridge.ts:148-151） */
  startScan(): Promise<void>;
  /** 需要能力 `ble:scan` */
  stopScan(): Promise<void>;
  /** 需要能力 `ble:connect`；失败回滚持有者（bridge.ts:161-164） */
  connect(deviceId: string): Promise<void>;
  /** 需要能力 `ble:connect` */
  disconnect(): Promise<void>;
  /** 需要能力 `ble:connect`；未连接时 resolve 出 null（Rust ble.rs:393-400，Option<String>） */
  connectedDevice(): Promise<string | null>;
}

/** 宠物窗里 `activate(ctx)` 收到的能力上下文（宿主实现 bridge.ts:110 buildContext）。
 * 权限按 manifest 逐项校验，拒绝默认（bridge.ts:82-93）；未授权的调用是 Promise reject。 */
export interface PluginContext {
  /** = manifest.id（bridge.ts:118） */
  readonly pluginId: string;
  /** 写 webview console，前缀 `[插件id]`；同步、不需要能力、永不 reject（bridge.ts:119） */
  log(...args: unknown[]): void;
  /** bridge.ts:121-133 */
  bus: PluginBus;
  /** bridge.ts:135-139 */
  storage: PluginStorage;
  /** bridge.ts:141-172；本机无蓝牙硬件，未经真实设备验证 */
  ble: PluginBle;
  /** 向自己的 widget 推数据，走 `<id>:widget` topic；需要能力 `widget`（bridge.ts:175-179） */
  widget: { update(data: unknown): Promise<void> };
  /** 影响宠物本体；本体只暴露这两个受控入口，不给 canvas/DOM（bridge.ts:181-197）。宠物本体未初始化时 reject */
  pet: {
    /** 参数只能是 petdex 九状态之一，其余名字会被桥拒绝（bridge.ts:184-186，白名单 src/pet/host.ts:9）。需要能力 `pet:react` */
    react(action: PetAction): Promise<void>;
    /** 弹一句台词：换行折叠成空格、trim、截 200 字；清洗后为空则 reject（bridge.ts:190-194）。需要能力 `pet:say` */
    say(text: string): Promise<void>;
  };
  /** 出站请求（bridge.ts:199-222）。桥里唯一不走 gated 的成员：权限判断是自己的
   * ensurePermissions(["http", "http:<host>"])（bridge.ts:211），一次弹框申请两个键。
   * 域名键不带默认端口（`https://x.com` 的键是 `x.com`）；重定向由宿主逐跳跟进并重新校验域名。 */
  http: { request(url: string, options?: HttpRequestOptions): Promise<HttpResponse> };
  /** 系统通知（bridge.ts:224-228）。静默改写：折叠空白、title 截 80 字、body 截 240 字；
   * 两者清洗后皆空时 reject（src-tauri/src/services/notify.rs:15-19、29-37）。需要能力 `notify` */
  notify: { show(title: string, body: string): Promise<void> };
  /** 本插件专属悬浮窗（bridge.ts:243-263），窗标签 overlay-<id>（id 里的点编码成下划线）。
   * 拒绝面：调用窗归属不对（src-tauri/src/window/overlay.rs:362-364）、或插件确实没装着（overlay.rs:401-413）。需要能力 `overlay` */
  overlay: {
    show(options?: OverlayShowOptions): Promise<void>;
    hide(): Promise<void>;
    /** 整扇销毁（overlay.rs:451-467）；插件停用时宿主也会收（plugin-runtime.ts:212 走 overlay_reclaim，不查 overlay 能力） */
    destroy(): Promise<void>;
  };
}

/** widget 的三个挂载区（docs/PLUGIN_SDK.md:121-122；宿主调用点 plugin-runtime.ts:185、src/settings/main.ts:245、src/overlay/main.ts:39）。 */
export type WidgetRegion = "badge" | "overlay" | "settings";

/** widget 侧受限总线视图（src/runtime/topic-acl.ts:37-55 的 createScopedBus）。
 * 与宠物窗的 PluginBus **不是同一种返回形态**：这里是同步方法，违规**同步 throw**（不是 reject）；
 * 能力按 manifest 声明数组直接判断，不走授权表。 */
export interface WidgetBus {
  /** 违规（前缀不合法 / manifest 未声明 bus:publish）当场 throw（topic-acl.ts:43-50） */
  publish(topic: string, payload: unknown): void;
  /** 违规（通配越过自己前缀 / 订他人但未声明 bus:subscribe）当场 throw（topic-acl.ts:51-54、16-24） */
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
}

/** widget 能听的事件（闭集，src/runtime/widget-protocol.ts 的 WIDGET_EVENTS）。
 * 要按别的键触发就换这四个之一 —— 契约不为你临时开第五种。 */
export type WidgetEventName = "click" | "change" | "input" | "keydown";

/** 回给 handler 的**快照**，永远不是真事件对象（跨 realm 传不了，也不该传）。
 * `value` / `checked` 由宿主回推后写进 `target`，所以读它们走 `e.target.value`；
 * `preventDefault` 不在这里 —— 它在 `on()` 的第三个参数里事先声明（ADR-0008 决策 3）。 */
export interface WidgetEvent {
  target: WidgetNode;
  /** 只有 keydown 带 */
  key?: string;
}

/**
 * 渲染契约的节点句柄（ADR-0008 决策 1）。Worker 侧是虚拟节点、宿主侧是真元素，
 * 两边都**只保证这一面**：没有 `querySelector` / `innerHTML` / `children` /
 * `getBoundingClientRect` —— 关闭集是契约的一部分，不是没做完。
 */
export interface WidgetNode {
  /** 宿主只承认它按 create/adopt 见过的 id；不是你随意编的坐标 */
  readonly nodeId: number;
  readonly tag: string;
  textContent: string;
  /** 类名的唯一真相；`setAttribute("class", …)` 也走它 */
  className: string;
  readonly classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, force?: boolean): boolean;
    contains(name: string): boolean;
  };
  /** 只收字符串值（dataset 的 attr 语义），写 undefined 等于删 */
  readonly dataset: Record<string, string | undefined>;
  /** 逐属性赋值，一条属性一个值；没有 `cssText` */
  readonly style: Record<string, string | number>;
  /** 表单那几个 property 是真 property，不是 attribute */
  value: string;
  checked: boolean;
  disabled: boolean;
  readOnly: boolean;
  placeholder: string;
  type: string;
  id: string;
  setAttribute(name: string, value: string | null): void;
  append(...nodes: WidgetNode[]): void;
  appendChild(node: WidgetNode): WidgetNode;
  replaceChildren(...nodes: WidgetNode[]): void;
  remove(): void;
  /** `opts.preventDefault` 必须在这里声明，handler 里改不了 */
  on(event: WidgetEventName, handler: (e: WidgetEvent) => void, opts?: { preventDefault?: boolean }): void;
  off(event: WidgetEventName): void;
}

/** 建节点用的那一面：迁移时把 `document.createElement` 换成 `ctx.dom.createElement`，其余不动。 */
export interface WidgetDom {
  /** 标签名要在白名单里（widget-protocol.ts 的 WIDGET_HTML_TAGS / WIDGET_SVG_TAGS），表外当场拒 */
  createElement(tag: string): WidgetNode;
  createElementNS(ns: string, tag: string): WidgetNode;
}

/** 宿主替插件量到的画布 CSS 像素尺寸（旧代码里的 `canvas.clientWidth` / `clientHeight`）。
 *  两个都要：K 线图的高不是常量，插件没写死 CSS 高度，只发宽就等于让它一直走兜底值。 */
export interface WidgetMeasured {
  w: number;
  h: number;
}

/** 尺寸与 dpr 由宿主观测后推（Worker 里没有 window，也不许量自己）。
 * `measured` 按 nodeId 存画布尺寸。 */
export interface WidgetLayout {
  width: number;
  height: number;
  dpr: number;
  measured: Record<string, WidgetMeasured>;
}

/** 画布那一面：Worker 路线拿到的是 OffscreenCanvas，`getContext("2d")` 之后只能在这个 Worker 里画。 */
export interface WidgetCanvasLike {
  width: number;
  height: number;
  getContext(kind: "2d"): unknown;
}

/** widget.js `mount(root, ctx)` 收到的上下文（宿主注入 widget-host.ts:149-162）。
 * 同一份 widget 文件会在 badge / overlay / settings 三个区分别挂载，按 `ctx.region` 区分行为。 */
export interface WidgetContext {
  /** = manifest.id（widget-host.ts:150） */
  readonly pluginId: string;
  /** 当前挂载区（widget-host.ts:151） */
  readonly region: WidgetRegion;
  /** topic-acl.ts:37-55 的受限视图（widget-host.ts:152 注入） */
  bus: WidgetBus;
  /** **仅 settings 区存在**（widget-host.ts:155-163）：badge / overlay 区是 undefined，
   * 宠物窗的 PluginContext 里根本没有这个键。 */
  host?: { agentHooks: AgentHooksApi };
  /**
   * 阶段二渲染契约的三个键：widget **默认就跑在 Worker 路线**，所以正常情况下三个都有。
   * 唯一拿不到的情况是宿主把该插件点名进了「留在宿主 realm」的例外名单
   * （`localStorage` 的 `host:widget-realm-plugin-host`，给还没照契约写的第三方 widget 留的逃生门）。
   * 在那条路上它们是 undefined，照契约写的 widget 会白屏 —— 所以点名是排障手段，不是配置项。
   */
  dom?: WidgetDom;
  /** 对应旧代码的 `window.addEventListener("resize", …)`；返回退订函数 */
  onLayout?: (handler: (layout: WidgetLayout) => void) => () => void;
  /** 对应旧代码的 `canvas.getContext("2d")`：画布控制权由宿主交接过来，回调给你那块画布 */
  onCanvas?: (handler: (id: number, canvas: WidgetCanvasLike) => void) => () => void;
}
