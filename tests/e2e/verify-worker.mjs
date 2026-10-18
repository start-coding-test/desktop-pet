// L1 原型（ADR-0006）运行时取证：插件搬进 Web Worker 之后，
//   ① realm 事实（没有 window/document/localStorage、__TAURI_INTERNALS__ 不可达、裸说明符解析不了）
//   ② 入口的相对子模块在 Worker 里能否解析（todo 的 ./todo-txt.js、探针的 ./leaf.js）
//   ③ petplugin 的 `?v=` 与 no-store 在 Worker 的取回路径上是否仍成立
//   ④ 协议层伪造（不在 24 个方法表里的调用、跨插件读存储）是否被宿主挡下
//   ⑤ 退出条件：com.pet.todo 在 Worker 里真的跑得动
// 取证方式是本仓唯一合法姿势：读页面/Worker 自己写下的副作用，不用 CDP 求值判 CSP。
//   终端 1: npm run dev:debug      终端 2: npm run verify:worker
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv, env } from "node:process";
import { fileURLToPath } from "node:url";
import {
  attach,
  createReport,
  hostInvoke,
  listPages,
  openSettingsInvoker,
  readEnabledIds,
  reloadAndWait,
  waitUntil,
  writeEnabledIds,
} from "./harness/cdp.mjs";
import {
  clearWidgetHostRealm,
  setWidgetHostRealm,
  waitWidgetRealm,
} from "./harness/widget-realm.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(REPO, "tests", "fixtures", "l1-probe");
const INSTALLED = join(REPO, "plugins", "zz.l1-probe");
const PROBE = "zz.l1-probe";
const TODO = "com.pet.todo";
const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const r = createReport("L1 Worker 宿主（dev）");

let stopped = false;
/** 同意框逐个能力分批弹，必须整轮持续应答（授权只能走真实同意框） */
async function pump(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (!stopped && Date.now() < until) {
    const target = (await listPages(PORT).catch(() => [])).find((t) => /consent/.test(t.url));
    if (!target) {
      await sleep(250);
      continue;
    }
    try {
      const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000);
      try {
        await cs.ev(`document.getElementById('btn-allow').click()`);
      } finally {
        cs.close();
      }
    } catch (e) {
      console.log(`  · 同意框应答失败，重试：${String(e).slice(0, 70)}`);
    }
    await sleep(300);
  }
}

function installFixture() {
  mkdirSync(INSTALLED, { recursive: true });
  for (const file of ["manifest.json", "index.js", "leaf.js", "widget.js"]) {
    copyFileSync(join(FIXTURE, file), join(INSTALLED, file));
  }
}

/** 把已装探针的 leaf.js 改成别的标记值：量「子模块内容变了而 URL 没变」时 Worker 拿到的是哪一份 */
function markLeaf(value) {
  writeFileSync(join(INSTALLED, "leaf.js"), `export const LEAF_MARKER = ${JSON.stringify(value)};\n`);
}

/** 例外名单：点名的插件留在宿主 realm，缺省为空 = 全部走 Worker（L2 阶段一起的默认） */
const FLAG = "host:realm-plugin-host";
const setOptOut = (client, ids) =>
  client.ev(`localStorage.setItem(${JSON.stringify(FLAG)}, ${JSON.stringify(ids.join(","))})`);

/** 两条接缝现在同向：**默认都进 Worker**，各自的 localStorage 名单是「留在宿主 realm」的例外
 *  （入口是 `host:realm-plugin-host`，widget 是 `host:widget-realm-plugin-host`）。
 *  widget 的点名与 realm 取证走 harness/widget-realm.mjs 那份 —— 四张迁移卡用的是同一把尺子。 */

let c = null;
let cdp = null;
let settings = null;
let origEnabled = [];
let invoked = false;
/** ⑨ 组临时占用过的宿主状态：传感开关与游戏模式键，finally 里照原样还回去 */
let origFullscreenWatch = null;
let origGameMode = null;
let gameModeTouched = false;

try {
  if (!existsSync(join(FIXTURE, "manifest.json"))) throw new Error(`探针夹具缺失: ${FIXTURE}`);
  installFixture();
  invoked = true;

  try {
    c = await attach(PORT, isPetPage, 60_000);
  } catch {
    console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
    process.exit(2);
  }
  cdp = c;
  const invoke = hostInvoke(c);
  settings = await openSettingsInvoker(PORT, c);
  origEnabled = await readEnabledIds(invoke);
  void pump(420_000);

  r.group("装载");
  await settings.invoke("permission_revoke", { pluginId: PROBE });
  await sleep(1200);
  const enabled = [...new Set([...origEnabled, PROBE])];
  await writeEnabledIds(settings.invoke, enabled);
  await reloadAndWait(c);
  r.check(
    "探针在 Worker 里 activate 成功",
    true,
    await waitUntil(
      c,
      `(async () => { try { return (await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(PROBE)}, key: 'booted' })) === true; } catch { return false; } })()`,
      30_000,
    ),
  );

  const storeGet = async (key) => (await invoke("store_get", { pluginId: PROBE, key })).v;
  const facts = await storeGet("facts");
  r.info("入口 URL", String(facts?.entryUrl));
  r.info("裸说明符解析失败的原因", String(facts?.bareImportText));
  r.info("Worker 里 fetch ipc.localhost 的结果", `${facts?.ipcFetch} ${String(facts?.ipcFetchText ?? "")}`);

  r.group("① realm 事实：真隔离成立");
  r.check("ctx.pluginId 是宿主分配的", PROBE, facts?.ctxId);
  r.check("Worker 里没有 window", false, facts?.hasWindow);
  r.check("Worker 里没有 document", false, facts?.hasDocument);
  r.check("Worker 里没有 localStorage", false, facts?.hasLocalStorage);
  r.check("__TAURI_INTERNALS__ 不可达", false, facts?.hasInternals);
  r.check("裸说明符 @tauri-apps/api/core 解析不了", "rejected", facts?.bareImport);
  r.check("取 ipc.localhost 拿不到可用通道", true, !String(facts?.ipcFetch).startsWith("status:2"));

  r.group("② 入口的相对子模块在 Worker 里解析");
  r.check("./leaf.js 被 Worker 取到并执行", "leaf-v1", facts?.leaf);
  r.check("入口 URL 带上了 ?v= 令牌", true, /\?v=\d+/.test(String(facts?.entryUrl)));

  r.group("④ 协议层伪造被宿主挡下");
  r.check("表外方法被拒", false, facts?.forged?.unknownMethod?.ok);
  r.check("拒绝带码", true, typeof facts?.forged?.unknownMethod?.code === "string");
  r.check("冒名调别的插件的撤销命令也进不来", false, facts?.forged?.revokeOther?.ok);
  r.check("借表内方法发别人的 topic 被前缀归属拦下", false, facts?.forged?.publishAsOther?.ok);
  r.check("跨插件读不到别人的存储", null, facts?.crossPluginRead);

  r.group("③ 覆盖子模块：同一个 Worker 陈旧、换一个 Worker 取新");
  markLeaf("leaf-v2");
  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    await bus.publish(${JSON.stringify(`${PROBE}:cmd`)}, { tag: "ping-1" }, ${JSON.stringify(PROBE)});
  })()`);
  await sleep(2500);
  const last = await storeGet("last");
  r.check("事件经通道推回了 Worker", "ping-1", last?.echo?.tag);
  r.check("同一个 Worker 里 URL 不变的子模块仍是旧实例", "leaf-v1", last?.facts?.leaf);

  await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    const list = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    await rt.deactivatePlugin(${JSON.stringify(PROBE)});
    await rt.activatePlugin(list.find((m) => m.id === ${JSON.stringify(PROBE)}));
  })()`);
  await sleep(4000);
  const facts2 = await storeGet("facts");
  r.check("换一个 Worker 后取到新内容（no-store 在 Worker 路径上成立）", "leaf-v2", facts2?.leaf);
  r.check("新 Worker 的入口令牌与旧的同源可取回", true, /\?v=\d+/.test(String(facts2?.entryUrl)));

  r.group("⑤ 退出条件：todo 插件在 Worker 里跑通");
  await settings.invoke("permission_revoke", { pluginId: TODO });
  await sleep(1200);
  await writeEnabledIds(settings.invoke, [...new Set([...enabled, TODO])]);
  await reloadAndWait(c);
  r.check(
    "todo 在 Worker 里 activate（badge 已挂载）",
    true,
    await waitUntil(
      c,
      `!!document.querySelector('#widget-badge div[data-plugin-id=${JSON.stringify(TODO)}]')`,
      60_000,
    ),
  );
  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    await bus.publish(${JSON.stringify(`${TODO}:cmd`)}, { action: "add", text: "worker 里加的一条" }, ${JSON.stringify(TODO)});
  })()`);
  await sleep(2500);
  const tasks = (await invoke("store_get", { pluginId: TODO, key: "tasks" })).v ?? [];
  r.check("经 Worker 的存储写入落盘", 1, tasks.length);
  r.check("子模块 todo-txt.js 的解析在 Worker 里也成立", "worker 里加的一条", tasks[0]?.text);
  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    await bus.publish(${JSON.stringify(`${TODO}:cmd`)}, { action: "remove", id: ${JSON.stringify(tasks[0]?.id ?? "")} }, ${JSON.stringify(TODO)});
  })()`);
  await sleep(1500);

  r.group("停用后回收");
  // sessionCount 是全表计数：套件保留了用户原本启用的插件（origEnabled），它们默认也在 Worker 里，
  // 所以不能断言「归零」—— runner 上多开一个插件（如 Agent 桥）就是假红。改比停用前后的差值。
  const sessionDelta = await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    const wh = await import('/src/runtime/worker-plugin-host.ts');
    const before = wh.workerPluginHost.sessionCount;
    await rt.deactivatePlugin(${JSON.stringify(TODO)});
    await rt.deactivatePlugin(${JSON.stringify(PROBE)});
    return before - wh.workerPluginHost.sessionCount;
  })()`);
  r.check("两个 Worker 会话都收掉了（停用前后差 2，不受用户其他已启用插件影响）", 2, sessionDelta);
  r.check("插件自己的 deactivate 在 Worker 里跑完", true, (await storeGet("deactivated")) === true);

  r.group("⑥ 例外名单是逃生口：点名的插件留在宿主 realm");
  // 判据不靠「有没有 Worker 会话」这种内部状态单独说话，而是让插件自己在两个 realm 里各写一份事实：
  // `window` 在页面 realm 存在、在 Worker 里是 undefined —— 同一个探针，两种真相
  await setOptOut(c, [PROBE]);
  await reloadAndWait(c);
  r.check(
    "名单里点名的插件在宿主 realm 里激活（facts.hasWindow 为真）",
    true,
    await waitUntil(
      c,
      `(async () => { try { const f = await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(PROBE)}, key: 'facts' }); return f?.hasWindow === true; } catch { return false; } })()`,
      40_000,
    ),
  );
  r.check(
    "它确实没有 Worker 会话",
    false,
    await c.ev(`(async () => { const wh = await import('/src/runtime/worker-plugin-host.ts'); return wh.workerPluginHost.has(${JSON.stringify(PROBE)}); })()`),
  );
  await setOptOut(c, []);
  await reloadAndWait(c);
  r.check(
    "清掉名单后同一个插件又回到 Worker（facts.hasWindow 为假，且有会话）",
    true,
    await waitUntil(
      c,
      `(async () => { try { const wh = await import('/src/runtime/worker-plugin-host.ts'); const f = await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(PROBE)}, key: 'facts' }); return wh.workerPluginHost.has(${JSON.stringify(PROBE)}) === true && f?.hasWindow === false; } catch { return false; } })()`,
      40_000,
    ),
  );

  r.group("⑦ 宿主侧 apply：真 shadow root 上的渲染、拒收、反向事件与画布交接");
  // 渲染器只在宿主 realm 跑，这里给它一棵真的 closed shadow root 走一整遍契约。
  // 全程不碰插件装载：验的是「收到这串 op 会改成什么、不该改的时候挡不挡得住」。
  const rendered = await c.ev(`(async () => {
    const { createWidgetRenderer } = await import('/src/runtime/widget-renderer.ts');
    const { WidgetRenderSession } = await import('/src/runtime/widget-node.ts');
    const host = document.createElement('div');
    host.style.cssText = 'width:140px;height:64px';
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const inbound = [];
    const renderer = createWidgetRenderer({
      root: shadow,
      container: host,
      pluginId: 'zz.renderprobe',
      postMessage: (m) => inbound.push({ t: m.t, id: m.id, event: m.event, value: m.value, dpr: m.dpr, width: m.width, height: m.height, measured: m.measured, hasOff: !!m.off && m.off.constructor && m.off.constructor.name }),
    });
    const session = new WidgetRenderSession((msg) => renderer.apply(msg.ops));
    session.enqueue({ k: 'adopt', id: 0, root: true });
    const card = session.create('div');
    card.className = 'rp-card';
    const title = session.create('span');
    title.textContent = '心率 72';
    card.append(title);
    const box = session.create('input');
    box.value = 'sh600000';
    box.checked = true;
    box.dataset.sym = 'sh600000';
    box.on('keydown', () => undefined, { preventDefault: true });
    box.on('change', () => undefined);
    session.root.append(card, box);
    const cv = session.create('canvas');
    session.root.append(cv);
    session.flush();
    const el = (sel) => shadow.querySelector(sel);
    const out = { tree: {}, reject: {}, event: {}, canvas: {}, layout: {}, after: {} };
    out.tree.span = el('.rp-card span')?.textContent ?? null;
    out.tree.spanCount = el('.rp-card')?.querySelectorAll('span').length ?? 0;
    out.tree.inputValue = el('input')?.value ?? null;
    out.tree.inputChecked = el('input')?.checked ?? null;
    out.tree.dataset = el('input')?.dataset.sym ?? null;
    // 未知 id 与非法 op：都应当只涨计数，不动 DOM
    const before = renderer.rejects();
    renderer.apply([{ k: 'text', id: 4242, value: 'x' }]);
    out.reject.unknownId = renderer.rejects() - before;
    out.reject.spanStillThere = el('.rp-card span')?.textContent ?? null;
    renderer.apply([{ k: 'html', id: 1, value: '<img src=x onerror=alert(1)>' }]);
    renderer.apply([{ k: 'attr', id: 1, name: 'src', value: 'http://evil.invalid/x.js' }]);
    renderer.apply([{ k: 'prop', id: 1, name: 'onclick', value: 'alert(1)' }]);
    renderer.apply([{ k: 'create', id: 777, tag: 'script' }]);
    out.reject.illegalTotal = renderer.rejects() - before;
    out.reject.noScript = shadow.querySelectorAll('script').length;
    out.reject.noAttrSrc = el('div')?.getAttribute('src') ?? null;
    // 反向事件：keydown 走 preventDefault，change 回推 value/checked 标量快照
    const input = el('input');
    const keyEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(keyEvent);
    input.value = 'sh600519';
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const evs = inbound.filter((m) => m.t === 'event');
    out.event.kinds = evs.map((m) => m.event).join(',');
    out.event.keyDefaultPrevented = keyEvent.defaultPrevented === true;
    const changeSnap = evs.find((m) => m.event === 'change')?.value;
    out.event.changeShape = changeSnap ? Object.keys(changeSnap).sort().join('+') : null;
    out.event.changeValue = changeSnap?.value ?? null;
    out.event.changeChecked = changeSnap?.checked ?? null;
    out.event.notAnEventObject = evs.every((m) => m.value === null || (typeof m.value === 'object' && !('target' in (m.value ?? {}))));
    // 画布交接：inbound 里有 handoff，且主线程再取上下文必须失败（证明是真交接不是复制）
    const hand = inbound.find((m) => m.t === 'handoff');
    out.canvas.handedOff = !!hand && hand.id === cv.nodeId;
    out.canvas.offscreenType = hand?.hasOff ?? null;
    try { (function () { const real = shadow.querySelector('canvas'); real.getContext('2d'); })(); out.canvas.mainThreadUsable = true; } catch { out.canvas.mainThreadUsable = false; }
    // layout：apply 之后至少下发一次，dpr 是真数值
    const lay = inbound.filter((m) => m.t === 'layout');
    out.layout.count = lay.length;
    out.layout.dprPositive = (lay[lay.length - 1]?.dpr ?? 0) > 0;
    out.layout.width = lay[lay.length - 1]?.width ?? 0;
    // measured 必须同时带 w 与 h：插件的画布高不是常量，只发宽就等于让它一直走兜底值
    {
      const m = lay[lay.length - 1]?.measured ?? {};
      const first = Object.values(m)[0];
      out.layout.measuredShape =
        first && typeof first.w === "number" && typeof first.h === "number" ? "w+h" : "missing";
    }
    // 越界关闭：刷一批非法 op，session 应当自锁，之后的合法 op 也不再生效
    const flood = [];
    for (let i = 0; i < 70; i++) flood.push({ k: 'text', id: 9999, value: 'x' });
    renderer.apply(flood);
    out.after.closed = renderer.closed() === true;
    renderer.apply([{ k: 'text', id: 1, value: '不该再改了' }]);
    out.after.spanUntouched = el('.rp-card span')?.textContent ?? null;
    renderer.destroy();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    out.after.noEventsAfterDestroy = inbound.filter((m) => m.t === 'event').length === evs.length;
    host.remove();
    return out;
  })()`);
  r.check("渲染出的节点树与虚拟节点一致（span 文本 + 只一个 span）", "心率 72|1", `${rendered.tree.span}|${rendered.tree.spanCount}`);
  r.check("prop 写到真元素上：value / checked / dataset", "sh600000|true|sh600000", `${rendered.tree.inputValue}|${rendered.tree.inputChecked}|${rendered.tree.dataset}`);
  r.check("未知 nodeId 被拒收且不动 DOM（计数 1、文本原样）", "1|心率 72", `${rendered.reject.unknownId}|${rendered.reject.spanStillThere}`);
  // illegalTotal 与 unknownId 共用同一个基线（都在那一次拒绝之后取样），所以表外那批要相减才是它自己的数
  r.check("html op / 表外属性 / 表外 property / script 标签全部被拒（4 次）", 4, rendered.reject.illegalTotal - rendered.reject.unknownId);
  r.check("shadow 里没有混进 script 节点，被拒的属性也没落上", "0|null", `${rendered.reject.noScript}|${rendered.reject.noAttrSrc}`);
  r.check("反向事件按顺序回推 keydown 与 change", "keydown,change", rendered.event.kinds);
  r.check("preventDefault 由 listen op 事先声明才生效", true, rendered.event.keyDefaultPrevented);
  r.check("change 的快照只带 value 与 checked 两个键", "checked+value", rendered.event.changeShape);
  r.check("快照里的 value 是用户改后的那个", "sh600519|false", `${rendered.event.changeValue}|${rendered.event.changeChecked}`);
  r.check("回推的不是事件对象（快照里没有 target）", true, rendered.event.notAnEventObject);
  r.check("画布控制权真的交给 Worker（inbound 有 handoff，主线程再取上下文会抛）", "true|OffscreenCanvas|false", `${rendered.canvas.handedOff}|${rendered.canvas.offscreenType}|${rendered.canvas.mainThreadUsable}`);
  r.check("apply 之后下发 layout，dpr 与容器宽度是真数值", true, rendered.layout.count > 0 && rendered.layout.dprPositive && rendered.layout.width === 140);
  r.check("layout 的 measured 带画布的 w 与 h（K 线图的高不是常量）", "w+h", rendered.layout.measuredShape);
  r.check("拒绝次数越界后 session 自锁，合法 op 也不再生效", "true|心率 72", `${rendered.after.closed}|${rendered.after.spanUntouched}`);
  r.check("destroy 之后事件不再回推", true, rendered.after.noEventsAfterDestroy);

  r.group("⑧ widget 接缝：默认进 Worker，点过名的例外留宿主 realm");
  const widgetFacts = async (want, ms = 30_000) => {
    const ok = await waitUntil(
      c,
      `(async () => { try { const f = await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(PROBE)}, key: 'widgetFacts' }); return !!f && f.realm === ${JSON.stringify(want)}; } catch { return false; } })()`,
      ms,
    );
    if (!ok) return null;
    return storeGet("widgetFacts");
  };
  // 先确认探针是启用状态（⑤/⑥ 两组停过又拉起），再读它 widget 的自报
  await writeEnabledIds(settings.invoke, [...new Set([...(await readEnabledIds(invoke)), PROBE])]);
  await reloadAndWait(c);
  /**
   * 收口后默认方向翻了：不点名就是 Worker。
   * 迁移期这一组是「默认宿主 → 点名进 Worker」，两条路线要证的性质一模一样，
   * 所以标题按性质重排而不是删掉一半（旧→新对应写在提交信息里）。
   */
  const workerSide = await widgetFacts("worker", 40_000);
  r.check("默认名单下 widget 在 Worker realm 里挂载（region 是 badge）", "worker|badge", `${workerSide?.realm}|${workerSide?.region}`);
  r.check(
    "Worker 路线里没有 document 也没有 window",
    "false|false",
    `${workerSide?.hasDocument}|${workerSide?.hasWindow}`,
  );
  r.check(
    "Worker 路线上 ctx.dom 与 onLayout 都在（渲染只能走指令通道）",
    "true|true",
    `${workerSide?.hasDom}|${workerSide?.hasOnLayout}`,
  );
  r.check("badge 区在 Worker 路线里同样没有 ctx.host", false, workerSide?.hasHostKey);
  r.check("layout 至少被宿主推过一次", true, (workerSide?.layout ?? 0) >= 1);
  // 逢 call 必回：不回包的话这里量到的是 timeout，而那个 timeout 就是插件永远起不来的样子
  r.check("宿主对 widget 调用面外的方法回的是拒绝，不是让它悬着", "answered:denied", workerSide?.forbidden);
  r.check(
    "默认路线上徽标插槽照样建出来了（渲染没被搬丢）",
    true,
    await c.ev(
      `(async () => { const n = document.querySelectorAll('#widget-badge div[data-plugin-id="${PROBE}"]').length; return n >= 1; })()`,
    ),
  );
  // realm 戳在插槽壳上，是 closed shadow 外面唯一的取证点；迁移卡全靠它，这里先把它钉住
  r.check(
    "插槽壳上的 realm 戳在默认路线里是 worker",
    "worker",
    (await waitWidgetRealm(c, PROBE, "badge", "worker")).actual,
  );

  await setWidgetHostRealm(c, [PROBE]);
  await reloadAndWait(c);
  const docSide = await widgetFacts("document", 40_000);
  r.check(
    "点名之后同一个 widget 回到宿主 realm（例外名单是名单，不是开关一次就定型）",
    "document",
    docSide?.realm,
  );
  r.check(
    "宿主 realm 路线看得见 document，且没有 ctx.dom（接缝没把替身塞给旧路径）",
    "true|false",
    `${docSide?.hasDocument}|${docSide?.hasDom}`,
  );
  r.check("badge 区没有 ctx.host 这个键（宿主 realm 路线）", false, docSide?.hasHostKey);
  r.check(
    "widget 发的 publish 被入口收到（跨 realm 中继可用）",
    true,
    await c.ev(
      `(async () => { const n = document.querySelectorAll('#widget-badge div[data-plugin-id="${PROBE}"]').length; return n >= 1; })()`,
    ),
  );
  r.check(
    "点名后 realm 戳跟着翻成 host",
    "host",
    (await waitWidgetRealm(c, PROBE, "badge", "host")).actual,
  );

  await clearWidgetHostRealm(c);
  await reloadAndWait(c);
  r.check(
    "清掉点名后同一个 widget 又回到 Worker realm",
    "worker",
    (await widgetFacts("worker", 40_000))?.realm,
  );
  r.check(
    "清掉点名后 realm 戳跟着翻回 worker",
    "worker",
    (await waitWidgetRealm(c, PROBE, "badge", "worker")).actual,
  );

  r.group("⑨ 徽标仲裁：同一时刻至多一个插槽可见、全屏期间轮播暂停（ADR-0010 决策 1）");
  // 判据是插槽外壳的布局尺寸非零（ADR 落地口径第 1 条），所以先把 todo 徽标喂出内容：
  // 探针的 L1W 恒有内容而 todo 平时是空态（空态不渲染是本卡的配套改动），两格有内容才轮得起来。
  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    await bus.publish(${JSON.stringify(`${TODO}:cmd`)}, { action: "add", text: "U03 轮播夹具" }, ${JSON.stringify(TODO)});
  })()`);
  const BADGE_SLOTS = `[...document.querySelectorAll('#widget-badge div[data-plugin-id]')]`;
  const SHOWN_IDS = `(() => ${BADGE_SLOTS}.filter((el) => getComputedStyle(el).visibility !== "hidden").map((el) => el.dataset.pluginId).join(","))()`;
  const badgeSample = await c.ev(
    `(async () => {
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const sized = () => ${BADGE_SLOTS}.filter((el) => el.offsetWidth > 0 && el.offsetHeight > 0).map((el) => el.dataset.pluginId);
      const until = Date.now() + 15_000;
      while (Date.now() < until && sized().length < 2) await sleep(200);
      const samples = [];
      for (let i = 0; i < 40; i += 1) {
        samples.push(${BADGE_SLOTS}.filter((el) => getComputedStyle(el).visibility !== "hidden").length);
        await sleep(150);
      }
      return { sized: sized(), samples };
    })()`,
    25_000,
  );
  r.info("有内容的徽标格", JSON.stringify(badgeSample.sized));
  r.check("至少两格有内容（轮播有得轮）", true, badgeSample.sized.length >= 2);
  r.check("同一时刻至多一个徽标插槽不带 visibility:hidden", true, badgeSample.samples.every((n) => n <= 1));
  r.check(
    "采样后半段一直恰有一格可见（轮播在走，不是整片藏起来）",
    0,
    badgeSample.samples.slice(5).filter((n) => n !== 1).length,
  );
  // 徽标建槽/内容到达不得把 window error 弹成红条。这条错误的唯一可观测点就是红条本身：
  // RO 交付回调里改被观察外壳的 position，Chromium 报
  // "ResizeObserver loop completed with undelivered notifications" 并当 window error 派发，
  // 而它**不进 CDP 的 console 通道**（c.noise 看不见），所以只能读 #err-overlay。
  // 红条只增不清，启动期触发过就一直是 block —— 整轮跑完再读即可。
  r.check(
    "徽标整轮下来没把 window error 弹成红条",
    "none|",
    await c.ev(`(() => { const el = document.getElementById('err-overlay'); return el ? getComputedStyle(el).display + '|' + el.textContent : 'no-el'; })()`),
  );
  // 全屏暂停：人工造 host:fullscreen。先把传感与游戏模式开关都按住，否则真检测器或
  // game-mode 的联动（隐藏宠物窗）会跟这一组抢事件；两样都在本组末尾与 finally 里还原。
  const watchStatus = await invoke("fullscreen_watch_status");
  if (watchStatus.ok) origFullscreenWatch = watchStatus.v === true;
  origGameMode = (await c.ev(`localStorage.getItem("host:game-mode")`)) ?? null;
  gameModeTouched = true;
  await c.ev(`localStorage.setItem("host:game-mode", "0"); true`);
  if (watchStatus.ok) await invoke("fullscreen_watch_set", { enabled: false });
  // watch_set(false) 会在一个采样周期内强制补发一次 active=false，等它落地再开始测量
  await sleep(1800);
  const emitFullscreen = (active) => c.ev(`(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'host:fullscreen', payload: { active: ${active} } });
      return { ok: true };
    } catch (e) { return { ok: false, e: typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)) }; }
  })()`);
  // 「事件送到了」与「轮播没停」在下面那条断言里长得一样，所以先用一个裸监听单独取证送达
  await c.ev(`(async () => {
    window.__fsSeen = [];
    const handler = window.__TAURI_INTERNALS__.transformCallback((e) => { window.__fsSeen.push(e.payload?.active === true); });
    window.__fsUnlisten = await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'host:fullscreen', target: { kind: 'Any' }, handler });
    return true;
  })()`);
  const beforeIds = await c.ev(SHOWN_IDS);
  const emitOn = await emitFullscreen(true);
  if (emitOn.ok !== true) r.info("emit 失败原因", String(emitOn.e));
  r.check("host:fullscreen 能从页面发出去（能力与回环都通）", true, emitOn.ok === true);
  await sleep(6500); // 6.5s > 一个 5 秒拍子：没被压住的轮播在这段时间里必换人
  const duringIds = await c.ev(SHOWN_IDS);
  const fsSeen = await c.ev(`window.__fsSeen.filter((v) => v === true).length`);
  r.check("同窗口 JS 监听收到了 active=true（是送到了，不是没发出去）", true, fsSeen >= 1);
  r.check("前提：期间确实有一格可见，且前后都非空", true, beforeIds.length > 0 && duringIds.length > 0);
  r.check("host:fullscreen active 期间轮播可见者不变", beforeIds, duringIds);
  await emitFullscreen(false);
  const resumedIds = await c.ev(
    `(async () => {
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const shown = () => ${SHOWN_IDS};
      const until = Date.now() + 12_000;
      while (Date.now() < until) {
        const now = shown();
        if (now !== ${JSON.stringify(duringIds)}) return now;
        await sleep(250);
      }
      return shown();
    })()`,
    15_000,
  );
  r.check("恢复之后轮播继续推进（可见者换人，证明刚才的暂停不是没有轮子）", true, resumedIds !== duringIds && resumedIds.length > 0);
  await c.ev(`(async () => {
    await window.__TAURI_INTERNALS__.invoke('plugin:event|unlisten', { event: 'host:fullscreen', eventId: window.__fsUnlisten });
    return true;
  })()`);
  if (watchStatus.ok) await invoke("fullscreen_watch_set", { enabled: origFullscreenWatch });
  await c.ev(
    origGameMode === null
      ? `localStorage.removeItem("host:game-mode"); true`
      : `localStorage.setItem("host:game-mode", ${JSON.stringify(origGameMode)}); true`,
  );
  gameModeTouched = false;
  // 收夹具：把本组加的那条待办删掉，别给后面的「零噪音」和下一跑留状态
  const u03Tasks = (await invoke("store_get", { pluginId: TODO, key: "tasks" })).v ?? [];
  const u03Task = u03Tasks.find((t) => t.text === "U03 轮播夹具");
  if (u03Task) {
    await c.ev(`(async () => {
      const { bus } = await import('/src/runtime/event-bus.ts');
      await bus.publish(${JSON.stringify(`${TODO}:cmd`)}, { action: "remove", id: ${JSON.stringify(u03Task.id)} }, ${JSON.stringify(TODO)});
    })()`);
  }

  r.group("零噪音");
  r.info("导航过渡期告警", String(c.transitionNoise.length));
  // B3 组那条「Worker 崩溃」断言是**故意**把探针打崩的，它的两条 console 记录（宿主 [worker-host] + Worker 侧 Uncaught）都点名探针，按名过滤（B03 获批）
  const noise = c.noise.filter((n) => !n.includes("B3 崩溃探针"));
  r.check("无 console 错误与未捕获异常", [], noise);
} catch (err) {
  r.check("脚本未抛异常", true, false);
  console.error(err);
} finally {
  stopped = true;
  if (settings) {
    await writeEnabledIds(settings.invoke, origEnabled).catch(() => undefined);
    await settings.invoke("permission_revoke", { pluginId: PROBE }).catch(() => undefined);
    await settings.invoke("permission_revoke", { pluginId: TODO }).catch(() => undefined);
    settings.close();
    settings = null;
  }
  if (cdp) {
    // ⑨ 组中途抛错时也要把宿主状态还回去：传感开关与游戏模式键
    if (origFullscreenWatch !== null) {
      await hostInvoke(cdp)("fullscreen_watch_set", { enabled: origFullscreenWatch }).catch(() => undefined);
    }
    if (gameModeTouched) {
      await cdp
        .ev(
          origGameMode === null
            ? `localStorage.removeItem("host:game-mode"); true`
            : `localStorage.setItem("host:game-mode", ${JSON.stringify(origGameMode)}); true`,
        )
        .catch(() => undefined);
    }
    await cdp.ev(`localStorage.removeItem(${JSON.stringify(FLAG)})`).catch(() => undefined);
    await clearWidgetHostRealm(cdp).catch(() => undefined);
    await sleep(1200);
    await reloadAndWait(cdp).catch(() => undefined);
    await sleep(1200);
    cdp.close();
  }
  if (invoked) rmSync(INSTALLED, { recursive: true, force: true });
  const failed = r.summary();
  await sleep(400);
  process.exit(failed ? 1 : 0);
}
