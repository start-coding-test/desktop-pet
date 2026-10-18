// L2 阶段二：宿主 realm 与 widget Worker realm 之间的渲染契约（ADR-0008）。
//
// widget 的代码搬进 Worker 之后拿不到真的 ShadowRoot，只剩这一条通道；所以这里的每一张表
// 都是「插件能说的全部话」。闭集是刻意的：多一个名字等于扩大攻击面，少一个名字等于砸掉生态。
//
// 与 plugin-worker-protocol.ts 同一条铁律：这个文件两侧共用，**不许** import `host-error.ts`
// 或任何 `@tauri-apps/*` —— 一旦被 Worker 侧拉到，widget Worker 的 bundle 里就会躺着真正的
// IPC 入口，隔离当场作废。
//
// 词表不是设计出来的，是数出来的：每个 op kind、每个标签、每个属性与事件名都对应 2026-10-15
// 对四个示例插件 widget 图（15 个文件）的一次实测扫描。T16 那张固定 token 表漏了
// `setAttribute`(13) / `.value=`(13) / `.checked=`(11) / `.type=`(10) / `replaceChildren`(8) /
// `createElement("style")`(8) 这些真实形状，所以本文件按实测重写，而不是照它的 14 个桶落地。
// 取证与校验都在本文件内完成，不 import 任何运行时模块 —— 它会被 Worker 侧拉到。

/* ============ 标签与名字：全部闭集 ============ */

/** HTML 标签白名单。逐个对应实测次数：div 19 / style 8 / span 4 / i 2 / option 1 / label 1 /
 *  input 1 / canvas 1 / button 1；ul/li/p/h3/small/img 是 `innerHTML` 那一处改写要落地的结构，
 *  随迁移卡逐条加，不加注释里的任何一个（`a` / `form` / `iframe` / `object` / `link` / `meta` /
 *  `base` / `script` 一律不开：前四个能造成导航或资源加载，后四个是文档级标记，本就不该出现在插件手里）。
 *  **表族 6 个是 A12 迁移时才补上的**：astock 把建元素全收进自己的 `tag(name, cls)` 小件，
 *  按 `createElement("字面量")` 数词表的那两轮都看不见它们（`views/settings/depth.js` 的
 *  `tag("table","depth")` / `tag("tbody")` / `tag("td")`，另有 `views/dom.js` 的 `cell()` helper）。
 *  语义上与 div/span 同族：不成导航、不载资源、无脚本面。 */
export const WIDGET_HTML_TAGS = [
  "div",
  "span",
  "i",
  "p",
  "small",
  "b",
  "label",
  "button",
  "input",
  "option",
  "select",
  "textarea",
  "ul",
  "li",
  "canvas",
  "style",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
] as const;

/** SVG 标签白名单：hr-ble 那颗心用到的 5 个（svg / path / defs / linearGradient / stop），
 *  g / circle / rect / line / polyline 是给后续图表留的同族，其余 SVG 元素要随用例再开。 */
export const WIDGET_SVG_TAGS = [
  "svg",
  "g",
  "path",
  "defs",
  "linearGradient",
  "stop",
  "circle",
  "rect",
  "line",
  "polyline",
] as const;

/** 反向事件通道的事件名白名单（实测：click 6 / change 6 / keydown 1）。
 *  `input` 是同族里唯一值得预开的（文本框边打字边收，迁移时不然要改两次）。
 *  `window` 级的 resize / dpr **不在这里** —— 那走 `layout` 推送（ADR-0008 决策 4）。 */
export const WIDGET_EVENTS = ["click", "change", "input", "keydown"] as const;

/** 可写的 DOM property 名（不是 attribute！`.value` / `.checked` 写进 attribute 不会生效，
 *  这是 widget 里最大的一类真实用法：value 13 / checked 11 / type 10 / placeholder 4）。 */
export const WIDGET_PROPS = [
  "value",
  "checked",
  "disabled",
  "placeholder",
  "type",
  "id",
  "readOnly",
] as const;

/** 可写的 attribute 名。HTML 侧只有这几个是实测用到的；其余全是 SVG 呈现属性
 *  （stop-color / offset / x1 / y1 / x2 / y2 / viewBox / fill / d / class / id）。
 *  不开放 `style` 属性（走 `style` op 批量下发，逐属性写会放大消息数），不开 `src` / `href`
 *  （那是资源加载与导航能力，不在渲染契约里）。`title` 两张表都不开：全库实测 0 处使用。 */
export const WIDGET_ATTRS = [
  "id",
  "class",
  "width",
  "height",
  "viewBox",
  "d",
  "fill",
  "stroke",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "offset",
  "stop-color",
  "stop-opacity",
  "opacity",
  "points",
  "preserveAspectRatio",
  "transform",
  // hr-ble 的 radio 组靠它分组（<input type=radio name=hr-mode>）。它不加载资源、不给导航、
  // 不带脚本面，风险面和 id/class 同级。T16 的词表是从 createElement 调用面量的，
  // 而这一处藏在 innerHTML 模板字符串里 —— 那张表本来就会漏掉模板里的名字。
  "name",
] as const;

/** 可写的 CSS 属性（实测 13 处逐属性赋值，全在这张表或它的同族里）。用驼峰名，宿主侧直接写
 *  `el.style[name]`，不做 kebab 转换 —— 转换要引正则、多一处能出错的地方。 */
export const WIDGET_STYLE_PROPS = [
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxHeight",
  "display",
  "flex",
  "flexDirection",
  "alignItems",
  "justifyContent",
  "gap",
  "padding",
  "margin",
  "color",
  "background",
  "backgroundColor",
  "border",
  "borderRadius",
  "opacity",
  "overflow",
  "overflowY",
  "fontSize",
  "fontWeight",
  "textAlign",
  "transform",
  "transformOrigin",
  "transition",
  "cursor",
  "whiteSpace",
  "visibility",
  "position",
  "top",
  "left",
  "zIndex",
  "aspectRatio",
  "animation",
] as const;

/** 明确**没有** `html` / `innerHTML` op：开它就等于把「插件可以注入任意标记」这条既有边界重新打开
 *  （AGENTS.md 的安全边界共识）。全库只有 1 处模板字符串（`plugins/com.pet.hr-ble/widget.js:293`），
 *  迁移时改成结构化 ops。这条事实由 `tests/unit/unit-widget-protocol.mjs` 钉住，不靠文档自觉。 */

/* ============ op 词表 ============ */

export const WIDGET_OP_KINDS = [
  "adopt", // 把一个已存在的宿主节点纳入本 session 的 id 表（root 用）
  "create", // { id, tag, svg? }
  "append", // { parent, child }
  "replace", // { parent, children[] } —— 实测 replaceChildren 8 处，列表重绘靠它
  "remove", // { id }
  "text", // { id, value }
  "prop", // { id, name, value }
  "attr", // { id, name, value }
  "style", // { id, props: { name: value } } —— 一条 op 批量下发，不逐属性发
  "dataset", // { id, key, value }
  "listen", // { id, event, preventDefault? }
  "unlisten", // { id, event }
] as const;

export type WidgetOpKind = (typeof WIDGET_OP_KINDS)[number];

export type WidgetOp =
  | { k: "adopt"; id: number; root: true }
  | { k: "create"; id: number; tag: string; svg?: true }
  | { k: "append"; parent: number; child: number }
  | { k: "replace"; parent: number; children: number[] }
  | { k: "remove"; id: number }
  | { k: "text"; id: number; value: string }
  | { k: "prop"; id: number; name: string; value: string | number | boolean | null }
  | { k: "attr"; id: number; name: string; value: string | null }
  | { k: "style"; id: number; props: Record<string, string | number> }
  | { k: "dataset"; id: number; key: string; value: string | null }
  | { k: "listen"; id: number; event: string; preventDefault?: true }
  | { k: "unlisten"; id: number; event: string };

/** 单条消息的 op 上限：超限由 Worker 侧切成连续多条（同一通道有序，宿主按 seq 校验没被打乱）。 */
export const WIDGET_MAX_OPS_PER_MESSAGE = 512;

/* ============ 消息形状 ============ */

/** 宿主替插件量到的画布 CSS 像素尺寸（按 nodeId 存）。两个都要：K 线图的高不是常量。 */
export interface WidgetMeasured {
  w: number;
  h: number;
}

/** 宿主 → widget Worker。 */
export type HostToWidget =
  | {
      t: "boot";
      pluginId: string;
      entryUrl: string;
      region: "badge" | "overlay" | "settings";
      permissions: string[];
    }
  /** 尺寸 / dpr / 宿主量到的画布尺寸。Worker 侧没有 window，重绘时机只能由这条驱动。 */
  | { t: "layout"; width: number; height: number; dpr: number; measured: Record<string, WidgetMeasured> }
  /**
   * 画布所有权交接（T18 实测成立，Edg/155.0.4283.45：未入文档与已入文档两种 canvas 都能交出控制权，
   * Worker 内取 2d 上下文填满纯色后 `getImageData` 读回中心像素逐数相等）。
   * `off` 是真 OffscreenCanvas，只能由宿主用 `worker.postMessage(msg, [off])` 的 transfer 列表发过来；
   * **交接之后主线程不能再对该 canvas 取上下文**，所以这条消息每块画布只发一次。
   * 它是 inbound 而不是新的 op kind：词表那 12 个名字描述的是「怎么改树」，这里是「把一件宿主资源交出去」。
   */
  | { t: "handoff"; id: number; off: OffscreenCanvas }
  /** 反向事件：`value` 只允许标量或纯对象快照，永远不是事件对象本身。 */
  | { t: "event"; id: number; event: string; value: unknown }
  /** 总线投递：`sub` 是 widget 侧 `bus.subscribe` 换回的句柄（与入口通道同一形状） */
  | { t: "bus"; sub: number; payload: unknown }
  /** 一次 `call` 的回包。宿主对未识别的方法名一律回 ok:false + `legacy`，不让它静默悬空 */
  | { t: "result"; seq: number; ok: true; value: unknown }
  | { t: "result"; seq: number; ok: false; error: { code: string; message: string } }
  | { t: "deactivate" };

/** widget Worker → 宿主。`call` 的方法名必须是 `WIDGET_CALL_METHODS` 里的一个。 */
export type WidgetToHost =
  | { t: "ops"; seq: number; ops: WidgetOp[] }
  | { t: "call"; seq: number; method: string; args: unknown[]; sub?: number }
  | { t: "unsub"; sub: number }
  | { t: "booted" }
  | { t: "boot-failed"; error: { code: string; message: string } }
  | { t: "deactivated" };

/**
 * widget 能被叫到的方法。**刻意比入口的 22 表窄**：widget 今天在宿主 realm 里就只有
 * `ctx.bus` 与（settings 区）`ctx.host.agentHooks`，把 `storage` / `http` / `pet.*` 一并开进来
 * 等于借搬迁之名扩权。要加得先改 ADR。
 */
export const WIDGET_CALL_METHODS = [
  "bus.publish",
  "bus.subscribe",
  "agentHooks.status",
  "agentHooks.install",
  "agentHooks.uninstall",
  // 与 plugin-worker-protocol 那张表同步追加（A02 设置页四选一）
  "agentHooks.set",
] as const;

export type WidgetCallMethod = (typeof WIDGET_CALL_METHODS)[number];

/** `agentHooks.*` 只在 settings 区放行（与 widget-host 现行为同一条边界）。 */
export const isWidgetCallAllowed = (method: unknown, region: string): boolean =>
  typeof method === "string" &&
  (WIDGET_CALL_METHODS as readonly string[]).includes(method) &&
  !(method.startsWith("agentHooks.") && region !== "settings");

/**
 * 阶段二收口后的开关：**默认进 Worker**，`localStorage` 里那份逗号分隔 id 是**留在宿主 realm 的例外名单**
 * （与阶段一的 `host:realm-plugin-host` 同向、同命名法）。
 *
 * 为什么不复用迁移期那个 widget 点名键：它的意思是「点名**进** Worker」，
 * 翻默认之后同一把键义正好相反 —— 一个键两种语义，迟早有人按旧义去点。换名字是便宜的，
 * 读错一次开关的排查成本不是。
 */
export const WIDGET_HOST_REALM_FLAG = "host:widget-realm-plugin-host";

/** 点名留在宿主 realm（迁移期的例外通道：某个第三方 widget 还没照契约写时的临时出路）。 */
export function isWidgetPinnedToHostRealm(pluginId: string, raw: string | null | undefined): boolean {
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(pluginId);
}

/**
 * 走不走 Worker：**默认走**，只有点名的例外留在宿主 realm。
 * 迁移期那份代码台账已经删掉 —— 四个示例插件都照契约改完、
 * 各自有运行时套件的 realm 戳断言钉住；例外名单现在只服务一种情况：
 * 第三方 widget 还没照契约写。它是逃生门，不是主路。
 */
export const widgetUsesWorker = (pluginId: string, raw: string | null | undefined): boolean =>
  !isWidgetPinnedToHostRealm(pluginId, raw);

/**
 * 渲染契约对应的 manifest `apiVersion`。声明到这个版本，才表示「我的 widget 是照 ADR-0008 写的」。
 *
 * 为什么要一个版本号而不是「进 Worker 试试，起不来再说」：照旧接口写的 widget 一进 Worker，
 * 第一句 `document.createElement` 就 ReferenceError，宿主只看到 boot-failed、插槽被收掉 ——
 * 用户眼里就是一块白。先按声明分流，才能在插件代码执行之前说清楚为什么不显示。
 */
export const WIDGET_CONTRACT_API_VERSION = 2;

/**
 * 旧接口 widget 的拦截判定：要进 Worker（没被点名留宿主 realm）且 `apiVersion` 低于契约版本 → 给出
 * 可读原因；否则 null。纯函数，入参只要 manifest 的三个字段与例外名单原文。
 */
export function legacyWidgetReason(
  manifest: { id: string; widget?: string; apiVersion?: number },
  pinnedRaw: string | null | undefined,
): string | null {
  if (!manifest.widget) return null;
  if (!widgetUsesWorker(manifest.id, pinnedRaw)) return null;
  const declared = manifest.apiVersion ?? 1;
  if (declared >= WIDGET_CONTRACT_API_VERSION) return null;
  return (
    `${manifest.id} 的 widget 按旧接口（apiVersion ${declared}）编写，宿主现在默认在 Worker 里运行 widget，` +
    `它在这里跑不起来。插件作者：按渲染契约迁移（ctx.dom 建节点，见 ADR-0008）后在 manifest 写 ` +
    `"apiVersion": ${WIDGET_CONTRACT_API_VERSION}。临时出路（仅开发用）：localStorage 的 ` +
    `${WIDGET_HOST_REALM_FLAG} 里点名这个插件 id。`
  );
}

/* ============ 校验器（宿主侧 apply 之前必须逐条过） ============ */

const inSet = <T extends string>(table: readonly T[], value: string): value is T =>
  (table as readonly string[]).includes(value);

export const isWidgetOpKind = (value: unknown): value is WidgetOpKind =>
  typeof value === "string" && inSet(WIDGET_OP_KINDS, value);

export const isWidgetTag = (value: unknown): boolean =>
  typeof value === "string" &&
  (inSet(WIDGET_HTML_TAGS, value) || inSet(WIDGET_SVG_TAGS, value));

export const isWidgetEvent = (value: unknown): value is (typeof WIDGET_EVENTS)[number] =>
  typeof value === "string" && inSet(WIDGET_EVENTS, value);

export const isWidgetProp = (value: unknown): value is (typeof WIDGET_PROPS)[number] =>
  typeof value === "string" && inSet(WIDGET_PROPS, value);

export const isWidgetAttr = (value: unknown): value is (typeof WIDGET_ATTRS)[number] =>
  typeof value === "string" && inSet(WIDGET_ATTRS, value);

export const isWidgetStyleProp = (value: unknown): value is (typeof WIDGET_STYLE_PROPS)[number] =>
  typeof value === "string" && inSet(WIDGET_STYLE_PROPS, value);

/** 一条消息是不是本契约认的合法 outbound。宿主侧收到非法消息应当直接丢弃并记日志，
 *  而不是抛 —— 抛在 onmessage 里会变成一条无法归因的未捕获异常。 */
export function isWidgetToHost(msg: unknown): msg is WidgetToHost {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  switch (m.t) {
    case "ops":
      return typeof m.seq === "number" && Array.isArray(m.ops) && m.ops.every(isWidgetOp);
    case "call":
      // 这里只管**形状**，不管方法名合不合法：名字白名单是策略（还分 region），
      // 归 `isWidgetCallAllowed` 判。在这一层把不合法的名字当"协议外消息"丢掉，
      // 就等于对一次调用不回包 —— 而 `boot` 会 await 插件的 mount()，插件那侧永远悬着。
      return typeof m.seq === "number" && typeof m.method === "string" && Array.isArray(m.args);
    case "unsub":
      return typeof m.sub === "number";
    case "booted":
    case "deactivated":
      return true;
    case "boot-failed": {
      const e = m.error as Record<string, unknown> | undefined;
      return !!e && typeof e.code === "string" && typeof e.message === "string";
    }
    default:
      return false;
  }
}

/** 单个 op 的形状 + 名字检查：kind 在闭集里、必填字段齐且类型对、**名字也必须落在对应白名单里**。
 *  这里是唯一的权威门禁 —— 宿主侧 apply 之前过一遍就够，别再在别处补第二套判断（两套判断迟早会漂移，
 *  `check:shape` 的 S3 升拦之前就是因为有两个判断点）。 */
export function isWidgetOp(op: unknown): op is WidgetOp {
  if (!op || typeof op !== "object") return false;
  const o = op as Record<string, unknown>;
  if (!isWidgetOpKind(o.k)) return false;
  const num = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  const str = (v: unknown) => typeof v === "string";
  switch (o.k) {
    case "adopt":
      return num(o.id) && o.root === true;
    case "create": {
      if (!num(o.id) || !str(o.tag)) return false;
      // svg 标记决定用哪张标签表：SVG 的 `path` 与 HTML 的标签名空间不同，混着允许等于开出第二个命名空间
      return o.svg === true ? inSet(WIDGET_SVG_TAGS, o.tag) : inSet(WIDGET_HTML_TAGS, o.tag);
    }
    case "append":
      return num(o.parent) && num(o.child);
    case "replace":
      return num(o.parent) && Array.isArray(o.children) && o.children.every(num);
    case "remove":
      return num(o.id);
    case "text":
      return num(o.id) && str(o.value);
    case "prop":
      return (
        num(o.id) &&
        isWidgetProp(o.name) &&
        (o.value === null || str(o.value) || typeof o.value === "number" || typeof o.value === "boolean")
      );
    case "attr":
      return num(o.id) && isWidgetAttr(o.name) && (o.value === null || str(o.value));
    case "dataset":
      return num(o.id) && str(o.key) && (o.value === null || str(o.value));
    case "style": {
      if (!num(o.id) || !o.props || typeof o.props !== "object") return false;
      return Object.entries(o.props as Record<string, unknown>).every(
        ([k, v]) =>
          isWidgetStyleProp(k) &&
          (str(v) || (typeof v === "number" && Number.isFinite(v)) || v === null),
      );
    }
    case "listen":
      return (
        num(o.id) &&
        isWidgetEvent(o.event) &&
        (o.preventDefault === undefined || o.preventDefault === true)
      );
    case "unlisten":
      return num(o.id) && isWidgetEvent(o.event);
  }
}
