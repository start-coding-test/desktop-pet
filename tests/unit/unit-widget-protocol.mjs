// widget 渲染契约与 Worker 侧虚拟节点的离线单测（ADR-0008 / L2 阶段二）。
//
// 为什么值这些形状而不是值「渲染出来好看」：宿主侧 apply 只能在这一层给出的白名单上做判断，
// 词表一泄，隔离就变成一句注释。本文件里最要紧的是那三条「不许有」的断言：
// 没有 html op、没有 class op kind、两个模块都不许带进 IPC 入口。
//
// 零 GUI、零联网、不开 DOM —— 宿主侧 apply（要真 ShadowRoot）不在这里验，归运行时套件。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "./import-graph.mjs";
import {
  WIDGET_ATTRS,
  WIDGET_CONTRACT_API_VERSION,
  WIDGET_EVENTS,
  WIDGET_HTML_TAGS,
  WIDGET_HOST_REALM_FLAG,
  WIDGET_MAX_OPS_PER_MESSAGE,
  WIDGET_OP_KINDS,
  WIDGET_PROPS,
  WIDGET_SVG_TAGS,
  isWidgetAttr,
  isWidgetCallAllowed,
  isWidgetEvent,
  isWidgetOp,
  isWidgetProp,
  isWidgetStyleProp,
  isWidgetTag,
  isWidgetToHost,
  legacyWidgetReason,
  regionForcesWorker,
  widgetUsesWorker,
} from "../../src/runtime/widget-protocol.ts";
import { WidgetRenderSession, createDomFacade } from "../../src/runtime/widget-node.ts";

const PROTO_SRC = readFileSync(new URL("../../src/runtime/widget-protocol.ts", import.meta.url), "utf8");
const SDK_SRC = readFileSync(new URL("../../packages/sdk/index.d.ts", import.meta.url), "utf8");

/** 隔离判据走传递 import 闭包（P2-5），不再用手写正则认引号风格 */
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const PROTO_ENTRY = here("../../src/runtime/widget-protocol.ts");
const NODE_ENTRY = here("../../src/runtime/widget-node.ts");
const WIDGET_WORKER_ENTRY = here("../../src/runtime/widget-worker.ts");
const HOST_ENTRY = here("../../src/runtime/worker-plugin-host.ts");

/** 收集 session 发出的每一条 ops 消息 */
const collect = () => {
  const sent = [];
  const session = new WidgetRenderSession((msg) => sent.push(msg));
  return { session, sent };
};

/** 微任务里批次才会落地，测试用这个显式等一轮 */
const settle = () => new Promise((res) => queueMicrotask(res));

describe("词表是闭集：多一个名字等于扩大攻击面", () => {
  it("op kind 恰好是这 12 个，顺序无关", () => {
    assert.deepEqual([...WIDGET_OP_KINDS].sort(), [
      "adopt",
      "append",
      "attr",
      "create",
      "dataset",
      "listen",
      "prop",
      "remove",
      "replace",
      "style",
      "text",
      "unlisten",
    ]);
  });

  // ADR-0008 决策 6 的全部牙齿在这一条：协议里没有标记注入的入口，且不许有人加回来
  it("没有 html / innerHTML 这一类 op", () => {
    for (const forbidden of ["html", "innerHTML", "insertAdjacentHTML", "markup", "outerHTML"]) {
      assert.equal(WIDGET_OP_KINDS.includes(forbidden), false, `词表里出现了 ${forbidden}`);
    }
    assert.equal(/\bk:\s*"(html|innerHTML)"/.test(PROTO_SRC), false);
  });

  it("classList 不配新的 op kind：类名整串走 attr class", () => {
    assert.equal(WIDGET_OP_KINDS.includes("class"), false);
    assert.ok(WIDGET_ATTRS.includes("class"));
  });

  it("表族 6 个标签在表内：astock 的自选表与五档表靠它们，且是从 helper 调用面量的", () => {
    // 两轮按 `createElement("字面量")` 数词表都没看见它们 —— astock 把建元素收进自己的 tag(name) 小件
    for (const t of ["table", "thead", "tbody", "tr", "th", "td"]) {
      assert.equal(isWidgetTag(t), true, `${t} 不在标签表里`);
    }
    // 但补表族不等于开导航面：这三个同族里最像 div 的之外一律仍表外
    for (const t of ["col", "colgroup", "caption"]) {
      assert.equal(isWidgetTag(t), false, `${t} 没在实测里出现，不该顺手开`);
    }
  });

  it("标签白名单不开导航与资源加载能力", () => {
    for (const forbidden of ["script", "iframe", "object", "embed", "a", "form", "link", "meta", "base"]) {
      assert.equal(isWidgetTag(forbidden), false, `${forbidden} 被当成了合法标签`);
    }
    assert.ok(WIDGET_HTML_TAGS.includes("style"), "四个插件都从 JS 往自己的 shadow root 注入 CSS");
  });

  it("属性白名单不含 src / href / style 逐条属性", () => {
    for (const forbidden of ["src", "href", "style", "xlink:href", "srcset"]) {
      assert.equal(isWidgetAttr(forbidden), false, `${forbidden} 被当成了合法属性`);
    }
  });

  // 撤掉一个名字也要留证据，否则下次有人当它是漏写又加回来
  it("两张标签表不相交：否则 create 用 svg 标记选表这件事形同虚设", () => {
    const overlap = WIDGET_HTML_TAGS.filter((t) => WIDGET_SVG_TAGS.includes(t));
    assert.deepEqual(overlap, []);
    // 命名空间混用在形状层就拒：div 不许带 svg，path 不许不带 svg
    assert.equal(isWidgetOp({ k: "create", id: 1, tag: "div", svg: true }), false);
    assert.equal(isWidgetOp({ k: "create", id: 1, tag: "path" }), false);
    assert.ok(isWidgetOp({ k: "create", id: 1, tag: "stop", svg: true }));
  });

  it("title 已从两张表撤掉（全库实测 0 处使用）", () => {
    assert.equal(WIDGET_PROPS.includes("title"), false);
    assert.equal(isWidgetProp("title"), false);
    assert.equal(isWidgetAttr("title"), false);
  });

  it("name 在 attr 表里：radio 组靠它分组，而它是从 innerHTML 模板里量出来的", () => {
    // T16 那份词表按 createElement 的调用面数，模板字符串里的属性名一律看不见 ——
    // 这条钉住「模板里真在用」这个来源，别再按那张表把它撤掉
    assert.equal(isWidgetAttr("name"), true);
    assert.ok(WIDGET_ATTRS.includes("name"));
    // 但它不是万能 attribute 的入口：导航与资源加载那两个仍然表外
    assert.equal(isWidgetAttr("href"), false);
    assert.equal(isWidgetAttr("src"), false);
  });

  it("事件名按实测来：resize 不在这里（它走 layout 推送），submit 没被用到就不开", () => {
    assert.deepEqual([...WIDGET_EVENTS].sort(), ["change", "click", "input", "keydown"]);
    assert.equal(isWidgetEvent("resize"), false);
    assert.equal(isWidgetEvent("submit"), false);
    assert.equal(isWidgetEvent("wheel"), false);
  });

  it("prop 与 attr 是两张表：value/checked 写 attribute 不生效", () => {
    assert.ok(isWidgetProp("value") && isWidgetProp("checked"));
    assert.equal(isWidgetAttr("value"), false);
    assert.equal(isWidgetAttr("checked"), false);
  });

  it("样式属性只认驼峰闭集，kebab 与未知名字一律拒", () => {
    assert.ok(isWidgetStyleProp("flexDirection"));
    assert.equal(isWidgetStyleProp("flex-direction"), false);
    assert.equal(isWidgetStyleProp("--evil-var"), false);
  });
});

describe("op 形状：kind 在闭集里 + 字段齐 + 名字在白名单里", () => {
  it("合法形状通过", () => {
    assert.ok(isWidgetOp({ k: "create", id: 3, tag: "div" }));
    assert.ok(isWidgetOp({ k: "create", id: 4, tag: "path", svg: true }));
    assert.ok(isWidgetOp({ k: "append", parent: 1, child: 3 }));
    assert.ok(isWidgetOp({ k: "replace", parent: 1, children: [2, 3] }));
    assert.ok(isWidgetOp({ k: "text", id: 3, value: "72 bpm" }));
    assert.ok(isWidgetOp({ k: "prop", id: 3, name: "checked", value: true }));
    assert.ok(isWidgetOp({ k: "attr", id: 3, name: "stop-color", value: "#ff7a8c" }));
    assert.ok(isWidgetOp({ k: "style", id: 3, props: { width: "100%", opacity: 0.5 } }));
    assert.ok(isWidgetOp({ k: "dataset", id: 3, key: "sym", value: "sh600000" }));
    assert.ok(isWidgetOp({ k: "listen", id: 3, event: "change" }));
    assert.ok(isWidgetOp({ k: "listen", id: 3, event: "keydown", preventDefault: true }));
    assert.ok(isWidgetOp({ k: "unlisten", id: 3, event: "click" }));
    assert.ok(isWidgetOp({ k: "adopt", id: 0, root: true }));
    assert.ok(isWidgetOp({ k: "remove", id: 3 }));
  });

  it("非法形状逐个被拒（每种坏一个样本，不许靠「反正都不合法」蒙）", () => {
    assert.equal(isWidgetOp(null), false);
    assert.equal(isWidgetOp("create"), false);
    assert.equal(isWidgetOp({ k: "html", id: 1, value: "<script>" }), false);
    assert.equal(isWidgetOp({ k: "create", id: 1.5, tag: "div" }), false);
    assert.equal(isWidgetOp({ k: "create", id: 1 }), false);
    assert.equal(isWidgetOp({ k: "create", id: 1, tag: "script" }), false);
    // 命名空间混用：svg:true 只准 SVG 标签，没标只准 HTML 标签
    assert.equal(isWidgetOp({ k: "create", id: 1, tag: "div", svg: true }), false);
    assert.equal(isWidgetOp({ k: "create", id: 1, tag: "path" }), false);
    assert.equal(isWidgetOp({ k: "append", parent: 1 }), false);
    assert.equal(isWidgetOp({ k: "replace", parent: 1, children: [2, "x"] }), false);
    assert.equal(isWidgetOp({ k: "text", id: 1 }), false);
    assert.equal(isWidgetOp({ k: "prop", id: 1, name: "onclick", value: "alert(1)" }), false);
    assert.equal(isWidgetOp({ k: "attr", id: 1, name: "src", value: "http://x" }), false);
    assert.equal(isWidgetOp({ k: "style", id: 1, props: { color: "red", bad: 1 } }), false);
    assert.equal(isWidgetOp({ k: "style", id: 1, props: { width: Number.NaN } }), false);
    assert.equal(isWidgetOp({ k: "dataset", id: 1, key: 2, value: "x" }), false);
    assert.equal(isWidgetOp({ k: "listen", id: 1, event: "mousemove" }), false);
    assert.equal(isWidgetOp({ k: "listen", id: 1, event: "click", preventDefault: "yes" }), false);
    assert.equal(isWidgetOp({ k: "adopt", id: 0 }), false);
  });

  it("outbound 消息：call 的方法名必须在 22 能力表里，ops 逐条验形状", () => {
    assert.ok(isWidgetToHost({ t: "ops", seq: 0, ops: [{ k: "remove", id: 2 }] }));
    assert.equal(isWidgetToHost({ t: "ops", seq: 0, ops: [{ k: "html", id: 2 }] }), false);
    assert.equal(isWidgetToHost({ t: "ops", seq: "0", ops: [] }), false);
    assert.ok(isWidgetToHost({ t: "call", seq: 1, method: "bus.publish", args: ["com.pet.x:t", 1] }));
    // 形状层与策略层分工：不合法的名字在这里是**合法形状**（宿主才回得出 denied），
    // 由 isWidgetCallAllowed 拒。运行时断言踩过一次：把它在这层当协议外消息丢掉，
    // 那次调用就永远没人回包，而 boot 正 await 着插件的 mount()。
    assert.ok(isWidgetToHost({ t: "call", seq: 1, method: "storage.get", args: ["k"] }));
    assert.equal(isWidgetCallAllowed("storage.get", "settings"), false);
    assert.equal(isWidgetToHost({ t: "call", seq: 1, method: "pet.teleport", args: [] }) && isWidgetCallAllowed("pet.teleport", "badge"), false);
    assert.equal(isWidgetToHost({ t: "call", seq: 1, method: 42, args: [] }), false);
    assert.ok(isWidgetToHost({ t: "unsub", sub: 3 }));
    assert.equal(isWidgetToHost({ t: "unsub", sub: "3" }), false);
    assert.ok(isWidgetToHost({ t: "booted" }));
    assert.ok(isWidgetToHost({ t: "deactivated" }));
    assert.ok(isWidgetToHost({ t: "boot-failed", error: { code: "parse", message: "m" } }));
    assert.equal(isWidgetToHost({ t: "boot-failed", error: { code: "parse" } }), false);
    assert.equal(isWidgetToHost({ t: "eval", code: "1" }), false);
    assert.equal(isWidgetToHost(undefined), false);
  });

  it("单条消息的 op 上限是个真数字（批次实现依赖它）", () => {
    assert.equal(WIDGET_MAX_OPS_PER_MESSAGE, 512);
  });
});

describe("虚拟节点：每次调用只改本地状态并攒一条 op", () => {
  it("root 是 0，建出来的节点从 1 开始单调递增", () => {
    const { session } = collect();
    assert.equal(session.root.nodeId, 0);
    const a = session.create("div");
    const b = session.create("span");
    assert.deepEqual([a.nodeId, b.nodeId], [1, 2]);
  });

  it("三次写合并成一条消息，seq 从 0 递增", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.textContent = "你好";
    el.className = "a b";
    await settle();
    assert.equal(sent.length, 1, "微任务内该只发一条消息");
    assert.equal(sent[0].seq, 0);
    assert.deepEqual(sent[0].ops.map((o) => o.k), ["create", "text", "attr"]);
  });

  it("超过上限就切成连续多条，seq 递增且总条数不丢", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    for (let i = 0; i < WIDGET_MAX_OPS_PER_MESSAGE + 7; i++) el.textContent = String(i);
    await settle();
    const total = sent.reduce((n, m) => n + m.ops.length, 0);
    assert.equal(total, WIDGET_MAX_OPS_PER_MESSAGE + 8);
    assert.ok(sent.length >= 2, "应当切成多条消息");
    assert.deepEqual(sent.map((m) => m.seq), sent.map((_m, i) => i));
    assert.ok(sent.slice(0, -1).every((m) => m.ops.length === WIDGET_MAX_OPS_PER_MESSAGE));
  });

  it("classList.toggle 在 Worker 侧留状态，整串当 attr class 下发", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.classList.add("on");
    assert.equal(el.classList.toggle("on"), false, "已有则 toggle 应当返回 false");
    assert.equal(el.classList.contains("on"), false);
    await settle();
    const classes = sent.flatMap((m) => m.ops).filter((o) => o.k === "attr" && o.name === "class");
    assert.deepEqual(classes.map((o) => o.value), ["on", ""]);
    assert.equal(sent.flatMap((m) => m.ops).some((o) => o.k === "class"), false, "不许出现 class op kind");
  });

  it("样式逐属性赋值各发一条 style op，名字原样", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.style.width = "100%";
    el.style.opacity = 0.5;
    await settle();
    const styles = sent.flatMap((m) => m.ops).filter((o) => o.k === "style");
    assert.deepEqual(styles, [
      { k: "style", id: el.nodeId, props: { width: "100%" } },
      { k: "style", id: el.nodeId, props: { opacity: 0.5 } },
    ]);
  });

  it("dataset 写入发值、删除发 null（宿主按 removeAttribute 解释）", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.dataset.sym = "sh600000";
    delete el.dataset.sym;
    await settle();
    assert.deepEqual(
      sent.flatMap((m) => m.ops).filter((o) => o.k === "dataset"),
      [
        { k: "dataset", id: el.nodeId, key: "sym", value: "sh600000" },
        { k: "dataset", id: el.nodeId, key: "sym", value: null },
      ],
    );
  });

  it("value / checked 是 property 写：既发 prop op，也能读回来", async () => {
    const { session, sent } = collect();
    const el = session.create("input");
    el.value = "600519";
    el.checked = true;
    await settle();
    const props = sent.flatMap((m) => m.ops).filter((o) => o.k === "prop");
    assert.deepEqual(props, [
      { k: "prop", id: el.nodeId, name: "value", value: "600519" },
      { k: "prop", id: el.nodeId, name: "checked", value: true },
    ]);
    assert.equal(el.value, "600519");
    assert.equal(el.checked, true);
  });

  it("el.id = 写的是 DOM id，不许覆盖宿主句柄 nodeId", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    const before = el.nodeId;
    el.id = "hr-panel";
    await settle();
    assert.equal(el.nodeId, before, "句柄被插件赋值覆盖了");
    assert.equal(el.id, "hr-panel");
    const op = sent.flatMap((m) => m.ops).find((o) => o.k === "prop" && o.name === "id");
    assert.deepEqual(op, { k: "prop", id: before, name: "id", value: "hr-panel" });
  });

  it("setAttribute 写 class 走 className 那条唯一真相，不另发一套状态", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.classList.add("x");
    el.setAttribute("class", "y z");
    await settle();
    assert.equal(el.className, "y z");
    const attrs = sent.flatMap((m) => m.ops).filter((o) => o.k === "attr" && o.name === "class");
    assert.deepEqual(attrs.map((o) => o.value), ["x", "y z"]);
  });

  it("appendChild / append / replaceChildren / remove 的字段形状", async () => {
    const { session, sent } = collect();
    const parent = session.create("div");
    const a = session.create("span");
    const b = parent.appendChild(session.create("i"));
    parent.append(a, b);
    parent.replaceChildren(a);
    a.remove();
    await settle();
    const ops = sent.flatMap((m) => m.ops);
    assert.ok(ops.some((o) => o.k === "append" && o.parent === parent.nodeId && o.child === a.nodeId));
    assert.ok(ops.some((o) => o.k === "replace" && o.parent === parent.nodeId && o.children.length === 1));
    assert.ok(ops.some((o) => o.k === "remove" && o.id === a.nodeId));
    assert.equal(b.tag, "i");
  });

  it("on 发 listen、off 发 unlisten；preventDefault 只在明确要求时出现", async () => {
    const { session, sent } = collect();
    const el = session.create("input");
    el.on("keydown", () => undefined);
    el.on("keydown", () => undefined, { preventDefault: true });
    el.off("keydown");
    await settle();
    const listens = sent.flatMap((m) => m.ops).filter((o) => o.k === "listen");
    assert.deepEqual(listens, [
      { k: "listen", id: el.nodeId, event: "keydown" },
      { k: "listen", id: el.nodeId, event: "keydown", preventDefault: true },
    ]);
    assert.ok(sent.flatMap((m) => m.ops).some((o) => o.k === "unlisten" && o.event === "keydown"));
  });

  it("宿主回推事件：先把 value 写回节点，且不回声发 op", () => {
    const { session, sent } = collect();
    const el = session.create("select");
    let seen = null;
    el.on("change", (e) => {
      seen = e;
    });
    session.handleEvent(el.nodeId, "change", { value: "sh600519" });
    // 不显式 flush 的话，op 还积在 pending 里，下面那句「没有回声」就是恒真 —— 变异测试把这一条抓出来了
    session.flush();
    assert.equal(el.value, "sh600519", "下拉框回读拿到的应当是用户刚选的值");
    assert.equal(seen.target, el);
    const echoed = sent.flatMap((m) => m.ops).filter((o) => o.k === "prop" && o.name === "value");
    assert.equal(echoed.length, 0, "宿主已经知道这个值，回声会写成两个真相");
  });

  it("keydown 的按键名进 handler，其余字段不乱塞", () => {
    const { session } = collect();
    const el = session.create("input");
    const keys = [];
    el.on("keydown", (e) => keys.push(e.key));
    session.handleEvent(el.nodeId, "keydown", { key: "Enter" });
    session.handleEvent(el.nodeId, "keydown", {});
    assert.deepEqual(keys, ["Enter", undefined]);
  });

  it("没绑过 handler 的节点收到事件不炸（宿主可能推给已 unmount 的 id）", () => {
    const { session } = collect();
    const el = session.create("div");
    assert.doesNotThrow(() => session.handleEvent(el.nodeId, "click", {}));
    assert.doesNotThrow(() => session.handleEvent(9999, "click", { value: "x" }));
  });

  it("discard 之后既没有 handler 也没有待发 ops", async () => {
    const { session, sent } = collect();
    const el = session.create("div");
    el.on("click", () => assert.fail("停用后不该再回调"));
    el.textContent = "还没发出去";
    session.discard();
    await settle();
    assert.equal(sent.length, 0);
    assert.doesNotThrow(() => session.handleEvent(el.nodeId, "click", {}));
  });

  it("createSvg 只认 SVG 那一个命名空间串", () => {
    const { session } = collect();
    assert.equal(session.createSvg("http://www.w3.org/2000/svg", "path").tag, "path");
    assert.throws(() => session.createSvg("http://www.w3.org/1999/xhtml", "div"), /不支持的命名空间/);
  });

  it("dom 面是闭集：只给 createElement / createElementNS", () => {
    const { session } = collect();
    const dom = createDomFacade(session);
    assert.deepEqual(Object.keys(dom).sort(), ["createElement", "createElementNS"]);
    assert.equal(dom.querySelector, undefined);
    assert.equal(dom.createTextNode, undefined);
  });

  it("flush 可以被宿主显式调用，首屏不等下一个微任务", () => {
    const { session, sent } = collect();
    session.create("div");
    session.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].ops.length, 1);
  });
});

describe("隔离：这两个模块不许把 IPC 入口带进 Worker", () => {
  // 一旦被 Worker 侧拉到，插件 Worker 的 bundle 里就躺着真正的 IPC 入口，隔离当场作废。
  // 判据是**传递闭包**（P2-5）：手写正则只认双引号、只看直接 import，改引号风格即绕过。
  it("widget-protocol.ts 的闭包只有它自己（既不带 @tauri-apps 也不带 host-error，也引不到别的东西）", () => {
    const hit = inspect(PROTO_ENTRY);
    assert.deepEqual(hit.files, [PROTO_ENTRY]);
    assert.deepEqual(hit.tauri, []);
    assert.deepEqual(hit.hostErrorFiles, []);
  });

  it("widget-node.ts 的闭包只有它自己与协议模块", () => {
    const hit = inspect(NODE_ENTRY);
    assert.deepEqual(hit.files, [NODE_ENTRY, PROTO_ENTRY].sort());
    assert.deepEqual(hit.tauri, []);
    assert.deepEqual(hit.hostErrorFiles, []);
  });

  it("widget-worker.ts 的整个闭包不触及 IPC 入口", () => {
    const hit = inspect(WIDGET_WORKER_ENTRY);
    assert.deepEqual(hit.tauri, []);
    assert.deepEqual(hit.hostErrorFiles, []);
  });

  it("反向对照：宿主侧入口的闭包必须命中 host-error（防这套判据空转）", () => {
    assert.equal(inspect(HOST_ENTRY).hostErrorFiles.length, 1);
  });
});

/** 四张插件迁移卡是照 `packages/sdk/index.d.ts` 写代码的，那份类型面漂了就等于按假契约迁移。 */
describe("SDK 类型面与协议词表同源", () => {
  /** 从 .d.ts 里取出 `export type X = "a" | "b";` 的成员（只认真实声明形态） */
  const unionMembers = (name) => {
    const m = SDK_SRC.match(new RegExp(`export type ${name} =([^;]+);`));
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort() : null;
  };

  it("WidgetEventName 与协议的 WIDGET_EVENTS 是同一个集合", () => {
    assert.deepEqual(unionMembers("WidgetEventName"), [...WIDGET_EVENTS].sort());
  });

  it("渲染契约那三个键在 SDK 里都声明成可选（Worker 路线才有）", () => {
    for (const key of ["dom?: WidgetDom", "onLayout?:", "onCanvas?:"]) {
      assert.equal(SDK_SRC.includes(key), true, `SDK 缺 ${key}`);
    }
  });

  it("SDK 不承诺 innerHTML / querySelector（承诺了就有插件按它写）", () => {
    assert.equal(/innerHTML\??:/.test(SDK_SRC), false);
    assert.equal(/querySelector\(/.test(SDK_SRC), false);
  });

  it("SDK 的 WidgetNode 成员不超过协议允许的调用面", () => {
    const body = SDK_SRC.match(/export interface WidgetNode \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const members = [...body.matchAll(/^\s{2}(?:readonly )?([A-Za-z]+)[?(:.\s]/gm)].map((m) => m[1]);
    const allowed = new Set([
      "nodeId",
      "tag",
      "textContent",
      "className",
      "classList",
      "dataset",
      "style",
      "value",
      "checked",
      "disabled",
      "readOnly",
      "placeholder",
      "type",
      "id",
      "setAttribute",
      "append",
      "appendChild",
      "replaceChildren",
      "remove",
      "on",
      "off",
    ]);
    assert.deepEqual(members.filter((m) => !allowed.has(m)), []);
    assert.equal(members.length, allowed.size);
  });
});

/**
 * S3：门禁粒度从「哪扇窗」收到「谁」。设置窗的 realm 就是宿主壳的 realm，
 * 被点名留在宿主 realm 的设置页因此拿得到宿主级命令，所以这一区不再认例外名单。
 */
describe("S3：settings 区一律进 Worker，例外名单只对 badge / overlay 生效", () => {
  const HOST_SRC = readFileSync(new URL("../../src/runtime/widget-host.ts", import.meta.url), "utf8");
  /** 注释里提到 `ctx.host` 是合法的（S3 的说明就在注释里），判据只看代码：先剥掉注释 */
  const HOST_CODE = HOST_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("被点名的插件在 settings 区照样进 Worker，只在 badge / overlay 区留宿主 realm", () => {
    const raw = "com.pet.other, com.pet.x ";
    assert.equal(widgetUsesWorker("com.pet.x", raw, "settings"), true, "settings 区认了例外名单");
    assert.equal(widgetUsesWorker("com.pet.x", raw, "badge"), false);
    assert.equal(widgetUsesWorker("com.pet.x", raw, "overlay"), false);
  });

  it("没点名时三区都进 Worker（改的是例外名单，不是默认值）", () => {
    for (const region of ["settings", "badge", "overlay"]) {
      assert.equal(widgetUsesWorker("com.pet.x", null, region), true);
    }
  });

  it("旧接口 widget 在 settings 区被拦下，原因里不把人引到例外名单上", () => {
    const v1 = { id: "com.pet.old", widget: "widget.js" };
    const pinned = "com.pet.old";
    // 逃生门本身还在：badge 区点名照旧放行
    assert.equal(legacyWidgetReason(v1, pinned, "badge"), null);
    const reason = legacyWidgetReason(v1, pinned, "settings");
    assert.ok(reason, "settings 区点名后旧接口 widget 没被拦下");
    assert.ok(reason.includes("com.pet.old") && reason.includes(`apiVersion 1`), `原因不可读：${reason}`);
    assert.ok(reason.includes(WIDGET_HOST_REALM_FLAG), `原因没点名那份名单：${reason}`);
    assert.ok(/不生效/.test(reason), `原因没说清例外名单对这一区不生效：${reason}`);
    assert.equal(reason.includes("点名这个插件 id"), false, "settings 区的原因仍在教用户去点名");
  });

  it("regionForcesWorker 只认 settings 这一个区", () => {
    assert.equal(regionForcesWorker("settings"), true);
    for (const other of ["badge", "overlay", "", "pet"]) {
      assert.equal(regionForcesWorker(other), false, `${other} 也被当成了 settings`);
    }
  });

  it("宿主两处判定都把区带了过去，且宿主 realm 不再给 settings 注入 ctx.host", () => {
    assert.equal(HOST_CODE.includes("widgetUsesWorker(manifest.id, pinnedRaw, region)"), true, "分流没带区");
    assert.equal(HOST_CODE.includes("legacyWidgetReason(manifest, pinnedRaw, region)"), true, "拦下判定没带区");
    // settings 区在上面就分流进 Worker 了，宿主 realm 那条路永远到不了 settings：
    // 留着注入代码等于留一条看起来还活着的提权路
    assert.equal(HOST_CODE.includes("ctx.host"), false, "宿主 realm 仍在给 settings 注入 ctx.host");
  });

  it("契约版本没被顺手改动（这条卡改的是分流，不是渲染契约）", () => {
    assert.equal(WIDGET_CONTRACT_API_VERSION, 2);
  });
});

describe("A28 添加自选：真实 input→click 快照", () => {
  async function mountAddHarness() {
    const sent = [];
    const session = new WidgetRenderSession((msg) => sent.push(msg));
    const real = createDomFacade(session);
    const inputs = [];
    const buttons = [];
    const dom = {
      createElement(tag) {
        const node = real.createElement(tag);
        if (tag === "input") inputs.push(node);
        if (tag === "button") buttons.push(node);
        return node;
      },
      createElementNS(ns, tag) {
        return real.createElementNS(ns, tag);
      },
    };
    const published = [];
    const statuses = [];
    const ctx = { dom, bus: { publish: (topic, payload) => published.push({ topic, payload }) } };
    const state = {
      status: { set: (text, level) => statuses.push({ text, level }) },
      section: (title, ...nodes) => ({ title, nodes }),
    };
    const { mountAdd } = await import("../../plugins/com.pet.astock/views/settings/add.js");
    mountAdd(ctx, state);
    session.flush();
    return { session, sent, inputs, buttons, published, statuses };
  }

  it("input 快照回推后 search / 直接添加 / 回车都能读到关键字", async () => {
    const h = await mountAddHarness();
    const inputNode = h.inputs[0];
    const search = h.buttons.find((b) => b.textContent === "搜索");
    const add = h.buttons.find((b) => b.textContent === "直接添加");
    assert.ok(inputNode, "输入框节点");
    assert.ok(search, "搜索按钮");
    assert.ok(add, "直接添加按钮");

    const inputListens = h.sent
      .flatMap((m) => m.ops)
      .filter((o) => o.k === "listen" && o.id === inputNode.nodeId && o.event === "input");
    assert.equal(inputListens.length, 1, "输入框必须订阅 input 快照，否则宿主不会回推 value");

    // 负对照：不注入 input，直接点搜索仍应报「先输入代码或名称关键字」
    h.session.handleEvent(search.nodeId, "click", {});
    assert.equal(h.published.length, 0, "空输入不应发布 search");
    assert.equal(h.statuses.at(-1)?.text, "先输入代码或名称关键字");

    // 负对照：只有 keydown 快照（不带 value）时，回车也不应发布 add
    h.session.handleEvent(inputNode.nodeId, "keydown", { key: "Enter" });
    assert.equal(h.published.length, 0, "只有 keydown 不应发布 add");
    assert.equal(h.statuses.at(-1)?.text, "先输入 6 位代码");

    // 真实路径：input 快照先把 value 写回节点，再点搜索
    h.session.handleEvent(inputNode.nodeId, "input", { value: "立昂微" });
    h.session.handleEvent(search.nodeId, "click", {});
    assert.deepEqual(h.published.at(-1)?.payload, { action: "search", keyword: "立昂微" });
    assert.equal(h.statuses.at(-1)?.text, "正在搜索「立昂微」…");

    // 直接添加
    h.session.handleEvent(inputNode.nodeId, "input", { value: "600519" });
    h.session.handleEvent(add.nodeId, "click", {});
    assert.deepEqual(h.published.at(-1)?.payload, { action: "add", input: "600519" });

    // 回车
    h.session.handleEvent(inputNode.nodeId, "input", { value: "600519" });
    h.session.handleEvent(inputNode.nodeId, "keydown", { key: "Enter" });
    assert.deepEqual(h.published.at(-1)?.payload, { action: "add", input: "600519" });
  });
});

describe("A29 阈值输入框：契约回放下的 input→click 快照", () => {
  /**
   * 与上面 A28 那组的区别：这里**不直接**调 `handleEvent`，而是先看节点订阅过什么事件。
   * 出处 `src/runtime/widget-renderer.ts:236-249`：宿主只对「插件订阅过的事件」挂真监听并回推，
   * 而 `:88-96` 的 `snapshotOf` 只有 `change`/`input` 的快照带 `value`。
   * 所以「少订阅一条 input」这种缺陷，只有按订阅关系回放才杀得掉 —— 直接调 handleEvent 的话
   * `widget-node.ts:84` 会无条件把 value 写进节点，测试就变成恒绿装饰。
   */
  async function mountWatchHarness() {
    const sent = [];
    const session = new WidgetRenderSession((msg) => sent.push(msg));
    const real = createDomFacade(session);
    const inputs = [];
    const buttons = [];
    const dom = {
      createElement(tagName) {
        const node = real.createElement(tagName);
        if (tagName === "input") inputs.push(node);
        if (tagName === "button") buttons.push(node);
        return node;
      },
      createElementNS(ns, tagName) {
        return real.createElementNS(ns, tagName);
      },
    };
    const published = [];
    const ctx = { dom, bus: { publish: (topic, payload) => published.push({ topic, payload }) } };
    const state = { lastPanel: null, autoPicked: false, section: (title, ...nodes) => ({ title, nodes }) };
    const ops = () => sent.flatMap((m) => m.ops);
    const listens = (node, event) =>
      ops().filter((o) => o.k === "listen" && o.id === node.nodeId && o.event === event).length;
    const type = (node, value) => {
      if (listens(node, "input") > 0) session.handleEvent(node.nodeId, "input", { value });
    };
    const click = (node) => {
      if (listens(node, "click") > 0) session.handleEvent(node.nodeId, "click", {});
    };
    const { mountWatchList } = await import("../../plugins/com.pet.astock/views/settings/watch-list.js");
    const watch = [{ secid: "1.600519", code: "600519", name: "贵州茅台", upper: 58.8, lower: null, pct: null, limit: true }];
    const view = mountWatchList(ctx, state);
    view.render({ watch, quotes: {} });
    session.flush();
    const nums = inputs.filter((n) => n.type === "text" && n.classList.contains("num"));
    const save = buttons.find((b) => b.textContent === "存");
    return { session, sent, ops, listens, type, click, inputs, buttons, published, nums, save };
  }

  it("三只阈值框各订阅一条 input；「停」那列的 checkbox 维持 change 不动", async () => {
    const h = await mountWatchHarness();
    assert.equal(h.nums.length, 3, "upper / lower / pct 三只文本框");
    assert.equal(
      h.inputs.filter((n) => n.type === "checkbox").length,
      1,
      "每行只有一只「停」checkbox",
    );
    assert.ok(h.save, "「存」按钮在");
    for (const box of h.nums) {
      assert.equal(h.listens(box, "input"), 1, `节点 ${box.nodeId} 必须订阅 input，否则宿主不回推 value`);
    }
    const limit = h.inputs.find((n) => n.type === "checkbox");
    assert.equal(h.listens(limit, "change"), 1, "checkbox 的 change 订阅保持原样（本卡不该动它）");
    assert.equal(h.listens(limit, "input"), 0, "顺手给 checkbox 加 input 不在本卡范围内");
  });

  it("负对照：不注入 input 快照时，点「存」发的就是回显值（这就是缺陷的可观测面）", async () => {
    const h = await mountWatchHarness();
    assert.equal(h.nums[0].value, "58.8", "已设阈值回显成字符串");
    assert.equal(h.nums[1].value, "", "未设（null）回显成空串，不是 \"null\"");
    assert.equal(h.nums[2].value, "");
    h.click(h.save);
    assert.deepEqual(h.published.at(-1)?.payload, {
      action: "update",
      secid: "1.600519",
      upper: "58.8",
      lower: "",
      pct: "",
    });
  });

  it("三框各自注入快照后点「存」发的都是注入值；空串在 clampNum 收口里落 null（清除）", async () => {
    const h = await mountWatchHarness();
    const C = await import("../../plugins/com.pet.astock/core.js");
    h.type(h.nums[0], "66.6");
    h.type(h.nums[1], "50");
    h.type(h.nums[2], "5");
    h.click(h.save);
    // 三框各钉一条：少任何一只的订阅，对应的字段就回落到回显值（M1a 实测红的就是 pct 那条）
    assert.equal(h.published.at(-1)?.payload.upper, "66.6", "upper 发的必须是注入值");
    assert.equal(h.published.at(-1)?.payload.lower, "50", "lower 发的必须是注入值");
    assert.equal(h.published.at(-1)?.payload.pct, "5", "pct 发的必须是注入值");
    assert.deepEqual(h.published.at(-1)?.payload, {
      action: "update",
      secid: "1.600519",
      upper: "66.6",
      lower: "50",
      pct: "5",
    });
    // 清除路径：把「涨到」清空再点存 —— 发的是空串，收口 clampNum 把它落成 null
    h.type(h.nums[0], "");
    h.click(h.save);
    assert.equal(h.published.at(-1)?.payload.upper, "");
    assert.equal(C.clampNum(""), null, "空串=清除阈值");
    assert.equal(C.clampNum("66.6"), 66.6, "正向对照：clampNum 没坏，上面那个 null 不是假的");
  });
});

describe("A32 币种下拉：契约回放下的 change→click 快照", () => {
  // 契约回放与 A29 那组同一理由：宿主只把「插件订阅过的事件」转回 Worker（widget-renderer.ts:236-249、:245），
  // 且只有 change/input 的快照带 value（:88-96）。直接调 handleEvent 会绕过转发条件，少订阅杀不动。
  async function mountPrefsHarness() {
    const sent = [];
    const session = new WidgetRenderSession((msg) => sent.push(msg));
    const real = createDomFacade(session);
    const selects = [];
    const inputs = [];
    const buttons = [];
    const dom = {
      createElement(tagName) {
        const node = real.createElement(tagName);
        if (tagName === "select") selects.push(node);
        if (tagName === "input") inputs.push(node);
        if (tagName === "button") buttons.push(node);
        return node;
      },
      createElementNS(ns, tagName) {
        return real.createElementNS(ns, tagName);
      },
    };
    const published = [];
    const statuses = [];
    const ctx = { dom, bus: { publish: (topic, payload) => published.push({ topic, payload }) } };
    const state = { status: { set: (text, level) => statuses.push({ text, level }) } };
    const ops = () => sent.flatMap((m) => m.ops);
    const listens = (node, event) =>
      ops().filter((o) => o.k === "listen" && o.id === node.nodeId && o.event === event).length;
    const fire = (node, event, snapshot = {}) => {
      if (listens(node, event) > 0) session.handleEvent(node.nodeId, event, snapshot);
    };
    const { mountPrefs } = await import("../../plugins/com.pet.goat-gauge/views/settings/prefs.js");
    const prefs = mountPrefs(ctx, state);
    prefs.render({ config: { currency: "USD", usdToCny: 7.2 } });
    session.flush();
    const byField = (name) => selects.find((n) => n.dataset.field === name);
    // 「应用」按钮有四只（刷新/币种/阈值/位置），按创建顺序取第二只；它发的补丁里带 usdToCny，取错就会断言红
    return { session, sent, ops, listens, fire, selects, inputs, buttons, published, statuses, prefs, byField };
  }

  it("两只 select：币种补上 change 订阅，徽标那条正确写法没被改动", async () => {
    const h = await mountPrefsHarness();
    assert.equal(h.selects.length, 2, "goat-gauge 设置页只有 currency 与 badgeMode 两只 select");
    const currency = h.byField("currency");
    const badge = h.byField("badgeMode");
    assert.ok(currency && badge, "两只都要能按 dataset.field 认出来");
    assert.equal(h.listens(currency, "change"), 1, "币种必须订阅 change，否则「应用」读到的还是回显值");
    assert.equal(h.listens(currency, "input"), 0, "只补 change，不顺手多订一种");
    assert.equal(h.listens(badge, "change"), 1, "徽标下拉原有的 change 订阅不许被动（同文件的正确写法）");
  });

  it("负对照：不注入 change 快照时，点「应用」发的就是回显的 USD", async () => {
    const h = await mountPrefsHarness();
    const currency = h.byField("currency");
    const rate = h.inputs.find((n) => n.dataset.field === "usdToCny");
    assert.equal(currency.value, "USD", "render 的回显（prefs.js:174）");
    h.fire(rate, "input", { value: "8.1" });
    h.fire(h.buttons[1], "click");
    assert.deepEqual(h.published.at(-1)?.payload, {
      action: "saveConfig",
      config: { currency: "USD", usdToCny: 8.1 },
    });
  });

  it("注入 change 快照后点「应用」发的就是所选币种；sanitizeConfig 与汇率校验都钉住", async () => {
    const h = await mountPrefsHarness();
    const S = await import("../../plugins/com.pet.goat-gauge/store-schema.js");
    const currency = h.byField("currency");
    const rate = h.inputs.find((n) => n.dataset.field === "usdToCny");
    h.fire(currency, "change", { value: "CNY" });
    h.fire(rate, "input", { value: "8.1" });
    h.fire(h.buttons[1], "click");
    assert.equal(h.published.at(-1)?.payload.config.currency, "CNY", "币种发的必须是选中值");
    assert.equal(h.published.at(-1)?.payload.config.usdToCny, 8.1, "汇率同批带上");
    assert.deepEqual(h.published.at(-1)?.payload, {
      action: "saveConfig",
      config: { currency: "CNY", usdToCny: 8.1 },
    });
    // 收口语义：这里没有「空串=清除」，脏值一律静默回落 USD（所以 stale 值会主动覆盖回 USD）
    assert.equal(S.sanitizeConfig({ currency: "CNY" }).currency, "CNY", "正向对照");
    assert.equal(S.sanitizeConfig({ currency: "" }).currency, "USD", "空值静默回落 USD");
    // 校验顺序没被新订阅绕过：汇率非法仍然拦下、一条都不发
    const before = h.published.length;
    h.fire(rate, "input", { value: "0" });
    h.fire(h.buttons[1], "click");
    assert.equal(h.published.length, before, "汇率不合法时不该发出任何补丁");
    assert.equal(h.statuses.at(-1)?.text, "汇率要在 1–20 之间");
  });
});
