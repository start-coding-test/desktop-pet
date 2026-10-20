// 迁移冒烟（离线）：把插件的 widget.js 真的在 Worker 侧运行时里跑一遍。
//
// 为什么要它：四张迁移卡如果都靠 CDP 运行时套件取证，就得抢同一个调试端口与单实例锁，
// 等于串行。这个冒烟不开浏览器、不占端口、秒级，能抓住迁移中最常见的一类破 ——
// 残留 `document.*`（Worker 里必然 ReferenceError）、用了表外的标签/属性名（宿主那条门禁就是
// `isWidgetOp`，这里照它逐条过一遍）。**它抓不到视觉与交互**，那仍以各插件的运行时套件为准。
//
// 名单来源与生产同一处：接缝默认进 Worker（`widget-host.ts` 的 `doMount`），所以这里跑的就是
// 生产实际会走的那条路。要临时加一个插件：`PET_WIDGET_SMOKE=com.pet.xxx`（逗号分隔）。
//
// 反向那半也留着，但换成不依赖产品插件的形式：一个故意用 `document.createElement` 的合成 widget
// **必须**当场失败。哪天这套冒烟对谁都绿、连这种代码都放过去，它就是空转了。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { isWidgetOp } from "../../src/runtime/widget-protocol.ts";
import { createWidgetRuntime } from "../../src/runtime/widget-worker.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGIONS = ["badge", "overlay", "settings"];
/** 仓库自带的四个示例插件：默认全部走 Worker，所以三个区都得跑起来且不越界 */
const REAL = ["com.pet.todo", "com.pet.agent-bridge", "com.pet.hr-ble", "com.pet.astock"];
/**
 * 「这个插件在这个区压根不画东西」的登记表（A9b：agent 桥头顶那张会话卡删了，
 * widget 只分派 badge 与 settings 两个区）。
 * 表里的组合不是「免测」，而是换成一条**反向**判据：挂上去必须零 op、零订阅、也不许报错 ——
 * 「没有那个区」从此是可证的，而不是靠把格子删掉来承认。
 */
const NO_RENDER = { "com.pet.agent-bridge": ["overlay"] };
/**
 * 只豁免「至少一条总线订阅」的区：agent 桥的设置页数据来自宿主的 `agentHooks.status()`
 * （能力调用），不来自 `*:widget` 总线，所以它没有订阅是设计事实；**渲染与事件回调照旧硬要求**。
 */
const NO_SUBSCRIBE = { "com.pet.agent-bridge": ["settings"] };
/** 常驻基线：夹具那份是双 realm 写法，今天就该过 —— 它证明这套冒烟本身不是空转 */
const FIXTURE_DIR = join("tests", "fixtures", "l1-probe");

const extraIds = () =>
  (process.env.PET_WIDGET_SMOKE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const targets = () => [...new Set([...REAL, ...extraIds()])];

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(REPO, dir, "manifest.json"), "utf8"));
}

/** 替身宿主的回包：形状给最空的。真实套件里才有真数据，所以形状敏感的逻辑不靠本文件判。 */
const replyFor = (method) => (String(method).startsWith("agentHooks.") ? {} : null);

/** 事件快照：与宿主 renderer 那份同形（keydown 给按键名，change/input 给 value+checked） */
const eventValueFor = (event) =>
  event === "keydown" ? { key: "Enter" } : { value: "1", checked: true };

/**
 * 数据驱动的那段渲染，不喂 payload 根本跑不到 —— 列表类分支只在收到总线消息时才执行。
 * 这条口径是被一次**存活的变异**逼出来的：把勾选取的 `on("change")` 改成表外事件名 `submit`，
 * 冒烟照绿，因为那条 `taskRow` 从没被执行过。
 *
 * 每个插件登记一份「有内容」的假 payload（空数组不算喂到），由 PM 在验收每张迁移卡时对着
 * 该插件自己发的那条总线补。喂进去之后新增的 op 一样逐条过门禁。
 * 一个插件往往订了好几个 topic，每个 handler 认的形状不同，所以按 topic 后缀给；
 * 没命中后缀就退到 `*`。一条都匹配不上 ⇒ 断言直接红，逼着每张迁移卡把自己的数据形状补进来。
 */
const BUS_POKE = {
  "com.pet.todo": {
    "*": {
      openCount: 1,
      doneCount: 0,
      tasks: [{ id: "a", text: "写周报", done: false, line: "(A) 写周报", projects: ["工作"] }],
    },
  },
  // 一份 payload 喂三个区：badge / overlay 读 state-label-steps-title-detail，settings 读两个开关
  "com.pet.agent-bridge": {
    "*": {
      state: "running",
      label: "编辑文件",
      steps: 3,
      title: "补迁移冒烟",
      detail: "tests/unit/unit-widget-migrations.mjs",
      toolName: "Edit",
      showTitle: true,
      showDetail: true,
    },
  },
  "com.pet.hr-ble": {
    bpm: { bpm: 96 },
    devices: { id: "AA:BB:CC:DD:EE:FF", name: "Polar H10", rssi: -61 },
    status: { text: "已连接 Polar H10", level: "ok" },
    widget: { mode: "overlay", connected: true, deviceName: "Polar H10" },
  },
  "com.pet.astock": {
    // 一份 `*:widget` 视图喂三个区：badge 读 watch + quotes[secid] + config.showIndex，
    // overlay 与设置页读同一份再加 rows / depth / net。形状按 core.js 的 pushState 抄。
    widget: {
      config: { showIndex: true, indexSecid: "1.000001", card: true, notify: true, intervalSec: 20 },
      watch: [{ secid: "1.600000", code: "sh600000", name: "浦发银行", rule: "≥10" }],
      quotes: {
        "1.600000": { name: "浦发银行", price: 9.85, pct: 1.23 },
        "1.000001": { name: "上证指数", price: 3210.5, pct: 0.44 },
      },
      recent: [],
      error: null,
      updatedAt: 1,
      quoteAt: 1,
      net: { strikes: 0, cooldownLeftSec: 0, noProgress: 0, intervalSec: 20, sources: {} },
    },
    panel: {
      code: "sh600000",
      kline: { bars: [{ t: "2026-10-15", o: 9.7, h: 9.9, l: 9.6, c: 9.85, v: 120000 }] },
      trend: [{ t: "09:30", p: 9.72 }, { t: "10:00", p: 9.85 }],
    },
    suggest: { rows: [{ code: "sz000001", name: "平安银行" }] },
    status: { text: "行情已更新", level: "ok" },
  },
};

/** 画布替身：`getContext("2d")` 回来的一切调用都是空操作，属性写全部吞掉。
 *  它证明的是**那段绘图代码在 Worker 里跑得完**，不是图画得对 —— 后者归 verify:astock（真数像素）。 */
function stubCanvas() {
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "measureText") return () => ({ width: 8 });
        if (key === "createLinearGradient" || key === "createRadialGradient")
          return () => ({ addColorStop: () => undefined });
        return () => undefined;
      },
      set: () => true,
    },
  );
  return { width: 0, height: 0, getContext: () => ctx };
}

/** 在 Worker 侧运行时里跑一遍：返回 ops、越界 op、调用面外的方法名、以及失败原因 */
async function smoke(dir, region, module = null) {
  const entry = module ? "about:blank#inline" : pathToFileURL(join(REPO, dir, "widget.js")).href;
  const manifest = module ? { id: "zz.smoke", permissions: [] } : manifestOf(dir);
  const ops = [];
  const badOps = [];
  const calls = [];
  const listeners = [];
  const canvasIds = [];
  const subs = [];
  let bootError = null;
  let booted = false;

  const runtime = createWidgetRuntime({
    post: (msg) => {
      if (msg.t === "ops") {
        for (const op of msg.ops) {
          ops.push(op);
          if (!isWidgetOp(op)) badOps.push(op);
          if (op?.k === "listen") listeners.push(op);
          if (op?.k === "create" && op?.tag === "canvas") canvasIds.push(op.id);
        }
        return;
      }
      if (msg.t === "call") {
        calls.push(msg.method);
        if (msg.method === "bus.subscribe" && typeof msg.sub === "number")
          subs.push({ sub: msg.sub, topic: String(msg.args?.[0] ?? "") });
        // 逢 call 必回：真宿主怎么回，这里就怎么回，否则 mount 里的调用会把冒烟吊死
        queueMicrotask(() =>
          runtime.hostMessage({ t: "result", seq: msg.seq, ok: true, value: replyFor(msg.method) }),
        );
        return;
      }
      if (msg.t === "booted") booted = true;
      if (msg.t === "boot-failed") bootError = msg.error?.message ?? "未知失败";
    },
    loadEntry: async () => module ?? import(entry),
  });

  await runtime.boot({
    t: "boot",
    pluginId: manifest.id,
    entryUrl: entry,
    region,
    permissions: manifest.permissions ?? [],
  });

  /** 让批次落地后再收一遍新增的 op */
  const settle = async () => {
    await new Promise((res) => setTimeout(res, 20));
  };
  const fired = new Set();
  // 真运行时里回调抛出的异常会被 Worker 全局接住，宿主用 `worker.onerror` 把它结算成挂载失败。
  // 离线这侧得自己接：一条 throw 直接把测试进程打崩，读数就成了「没跑完」而不是某条红 ——
  // A12 的 MW-B（把绘图目标从交接画布换成虚拟节点）正是这种情况，接住之后才有归因。
  const errors = [];
  const send = (msg) => {
    try {
      runtime.hostMessage(msg);
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
  };
  const dispatchListeners = async () => {
    for (const l of [...listeners]) {
      const key = `${l.id}:${l.event}`;
      if (fired.has(key)) continue;
      fired.add(key);
      send({ t: "event", id: l.id, event: l.event, value: eventValueFor(l.event) });
    }
    await settle();
  };

  const opsAfterMount = ops.length;

  // 1) 先把数据喂进去。列表类节点是数据驱动的：不喂的时候它们压根不存在，
  //    里面的监听也无从触发 —— 顺序反了会得到「触发了 1 个监听却没有新增 op」这种假红。
  //    见 BUS_POKE 上方那段（这条口径是被一次存活的变异逼出来的）。
  const table = BUS_POKE[manifest.id] ?? null;
  const pokes = subs
    .map((s) => ({
      sub: s.sub,
      payload: table ? (table[String(s.topic).split(":").pop()] ?? table["*"] ?? null) : null,
    }))
    .filter((p) => p.payload !== null);
  const opsBeforePoke = ops.length;
  for (const p of pokes) {
    send({ t: "bus", sub: p.sub, payload: p.payload });
  }
  await settle();
  const opsAfterPoke = ops.length;

  // 2) 事件回调里发生的渲染：每个 listen op 触发一次，新增的 op 照样过门禁
  const listenerCountBeforeEvents = listeners.length;
  const callsBeforeEvents = calls.length;
  const opsBeforeEvents = ops.length;
  await dispatchListeners();
  const opsAfterEvents = ops.length;
  const callsAfterEvents = calls.length;

  // 3) layout 与 handoff：图表类的绘制入口在这两个回调里
  send({
    t: "layout",
    width: 320,
    height: 120,
    dpr: 1,
    measured: Object.fromEntries(canvasIds.map((id) => [String(id), { w: 100, h: 60 }])),
  });
  await settle();
  for (const id of canvasIds) {
    send({ t: "handoff", id, off: stubCanvas() });
  }
  await settle();
  // 上面两步可能又登记了新监听，补一轮
  await dispatchListeners();

  // 收尾让插件自己清定时器：留着的测试进程不退出，看起来像挂死而不是断言失败
  send({ t: "deactivate" });
  await settle();
  return {
    ops,
    badOps,
    calls,
    bootError,
    booted,
    listenCount: listeners.length,
    errors,
    listenerCountBeforeEvents,
    canvasCount: canvasIds.length,
    subCount: subs.length,
    pokeCount: pokes.length,
    opsAfterMount,
    opsBeforePoke,
    opsAfterPoke,
    opsBeforeEvents,
    opsAfterEvents,
    callsBeforeEvents,
    callsAfterEvents,
  };
}

/** 三条套件共用的断言：跑得起来、有渲染、事件/layout/画布回调都过门禁 */
function assertClean(r, label) {
  assert.equal(r.bootError, null, `${label} 挂载失败：${r.bootError}`);
  assert.equal(r.booted, true, `${label} 没有 booted 回执`);
  assert.ok(r.ops.length > 0, `${label} 一条 op 都没发，等于没渲染`);
  assert.deepEqual(r.badOps, [], `${label} 有 ${r.badOps.length} 条 op 过不了宿主门禁`);
  assert.deepEqual(r.errors, [], `${label} 的回调抛出过：${r.errors.join(" / ")}`);
}

/**
 * 监听触发过之后要有动静。动静**可以是新 op，也可以是一次总线/宿主调用** ——
 * 勾选框那种处理函数就是纯动作（publish 一条指令、不重画自己），只盯 op 会把正确实现判成红。
 * 没登记任何监听时不硬要求（badge 区就没有）。
 */
function assertEventsRendered(r, label) {
  if (r.listenerCountBeforeEvents > 0) {
    const moved = r.opsAfterEvents > r.opsBeforeEvents || r.callsAfterEvents > r.callsBeforeEvents;
    assert.ok(
      moved,
      `${label} 触发了 ${r.listenerCountBeforeEvents} 个监听，既没新增 op 也没有任何调用（实得 ops ${
        r.opsAfterEvents - r.opsBeforeEvents
      }、calls ${r.callsAfterEvents - r.callsBeforeEvents}）`,
    );
  }
}

/** 台账内 / 点名里的插件必须登记 BUS_POKE：没登记就意味着列表类分支从没被执行过，
 *  「冒烟绿」只覆盖了 mount 那一半 —— A10 那次存活的变异就是这么漏过去的。
 *  `expectSub=false` 只豁免「有订阅」这半句（NO_SUBSCRIBE 表里的区），其余照旧硬要求。 */
function assertPokeRendered(r, label, expectSub = true) {
  if (expectSub) assert.ok(r.subCount > 0, `${label} 一条订阅都没有，喂不进数据`);
  if (!expectSub && r.subCount === 0) return;
  assert.equal(
    r.pokeCount,
    r.subCount,
    `${label} 有 ${r.subCount - r.pokeCount} 个订阅没在 BUS_POKE 里匹配到 payload（按 topic 后缀补）`,
  );
  assert.ok(r.opsAfterPoke > r.opsBeforePoke, `${label} 喂了 payload 却没多发一条 op`);
}

/** 反向那半：登记为「这个区不画东西」的组合，必须真的零 op、零订阅、且挂载不报错 */
function assertNoRender(r, label) {
  assert.equal(r.bootError, null, `${label} 说不画东西，却连挂载都失败了：${r.bootError}`);
  assert.equal(r.booted, true, `${label} 没有 booted 回执`);
  assert.deepEqual(r.ops, [], `${label} 说好没有这个区，实得 ${r.ops.length} 条 op`);
  assert.equal(r.subCount, 0, `${label} 说好没有这个区，却注册了 ${r.subCount} 条订阅`);
  assert.equal(r.pokeCount, 0, `${label} 没有订阅却匹配到了喂数据`);
  assert.deepEqual(r.badOps, [], `${label} 有 ${r.badOps.length} 条 op 过不了宿主门禁`);
  assert.deepEqual(r.errors, [], `${label} 的回调抛出过：${r.errors.join(" / ")}`);
}

describe("常驻基线：夹具那份双 realm 写法必须跑得起来", () => {
  for (const region of REGIONS) {
    it(`夹具 widget 在 ${region} 区零越界`, async () => {
      const r = await smoke(FIXTURE_DIR, region);
      assertClean(r, `夹具 ${region}`);
      assertEventsRendered(r, `夹具 ${region}`);
    });
  }
});

describe("四个示例插件默认就跑在 Worker 里：三个区都得跑起来且不越界", () => {
  for (const id of targets()) {
    for (const region of REGIONS) {
      const noRender = (NO_RENDER[id] ?? []).includes(region);
      const noSub = (NO_SUBSCRIBE[id] ?? []).includes(region);
      it(`${id} 在 ${region} 区${noRender ? "确实不画任何东西（反向判据）" : "跑得起来且不越界"}`, async () => {
        const r = await smoke(join("plugins", id), region);
        if (noRender) {
          assertNoRender(r, `${id} ${region}`);
          return;
        }
        assertClean(r, `${id} ${region}`);
        assertEventsRendered(r, `${id} ${region}`);
        assertPokeRendered(r, `${id} ${region}`, !noSub);
      });
    }
  }
});

it("豁免名单钉死：只许 agent-bridge 的 overlay（不画）与 settings（无总线订阅）这两项", () => {
  const flat = (table) =>
    Object.entries(table)
      .flatMap(([id, regions]) => regions.map((region) => `${id}/${region}`))
      .sort();
  assert.deepEqual(flat(NO_RENDER), ["com.pet.agent-bridge/overlay"]);
  assert.deepEqual(flat(NO_SUBSCRIBE), ["com.pet.agent-bridge/settings"]);
});

/**
 * 反向对照：一个还没照契约写的 widget（就用 `document.createElement`）**必须**当场失败。
 * 原来这半靠"台账外的真实插件"提供，翻默认之后四个都已迁移，所以换成合成模块 ——
 * 它不依赖任何产品代码，也就不会因为哪天又加了一个示例插件而悄悄失效。
 */
describe("冒烟不是空转：残留宿主 realm 依赖必须被抓到", () => {
  const legacy = {
    mount(root, _ctx) {
      const box = document.createElement("div");
      box.textContent = "还没迁的写法";
      root.append(box);
    },
  };

  it("只用 document.createElement 的 widget 挂不起来", async () => {
    const r = await smoke(null, "badge", legacy);
    assert.notEqual(r.bootError, null, "宿主 realm 依赖居然在 Worker 路线里跑通了");
    assert.match(String(r.bootError), /document|not defined/);
    assert.equal(r.booted, false, "挂载失败还回了 booted");
  });
});

/** 事件分发那半是这轮新加的，四个真实插件全都跑不到那里（它们 mount 就挂了），
 *  所以用两个合成 widget 自己证明自己会红。 */
describe("冒烟自己：只在事件回调里渲染的那段代码也在覆盖内", () => {
  const goodClick = {
    mount(root, ctx) {
      const box = ctx.dom.createElement("div");
      box.on("click", () => {
        const span = ctx.dom.createElement("span");
        span.textContent = "点出来的";
        box.append(span);
      });
      root.append(box);
    },
  };
  const badClick = {
    mount(root, ctx) {
      const box = ctx.dom.createElement("div");
      // href 不在 attr 表里（资源加载能力），而它只在回调里才发得出来
      box.on("click", () => box.setAttribute("href", "https://example.com"));
      root.append(box);
    },
  };

  it("合法回调：触发监听后确实新增 op，且一条不越界", async () => {
    const r = await smoke(null, "settings", goodClick);
    assert.equal(r.listenCount, 1);
    assert.equal(r.opsAfterEvents > r.opsAfterMount, true, "事件回调里没渲染出任何东西");
    assert.deepEqual(r.badOps, []);
  });

  it("越界回调：冒烟抓得到（否则整张卡都在自欺）", async () => {
    const r = await smoke(null, "settings", badClick);
    assert.equal(r.badOps.length, 1, `本该挑出 1 条越界 op，实际 ${r.badOps.length} 条`);
  });
});
