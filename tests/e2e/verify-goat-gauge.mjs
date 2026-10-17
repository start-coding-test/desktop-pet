// com.pet.goat-gauge 端到端断言（dev）。
//   终端 1: npm run dev:debug      终端 2: npm run verify:goat-gauge
// 默认演示组：不出网、不读 GOAT_GAUGE_KEY；在线组只在 GOAT_GAUGE_KEY 且
// GOAT_GAUGE_ONLINE=1 时跑（runner 上不设后者）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { argv, env } from "node:process";
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
import { waitWidgetRealm } from "./harness/widget-realm.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const PID = "com.pet.goat-gauge";
const OVERLAY_LABEL = `overlay-${PID.replace(/[.]/g, "_")}`;
const TEST_KEY = "sk-goat-e2e-DO-NOT-LEAK-9f4c2a";
const ONLINE = Boolean(env.GOAT_GAUGE_KEY) && env.GOAT_GAUGE_ONLINE === "1";

const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const near = (a, b, tol = 6) => Math.abs(a - b) <= tol;

/** Node 侧的异步谓词轮询；用于 store_get / 窗口可见性这类 host 调用。 */
async function pollUntil(fn, timeoutMs = 10_000, intervalMs = 250) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}
const r = createReport("GOAT 用量插件（dev）");

let c = null;
let oc = null;
let settings = null;
let pump = null;
let origEnabled = [];
const consents = [];

/* ---------- 同意框：持续应答并记录能力表 ---------- */
function makePump() {
  let stopped = false;
  const run = async (deadlineMs) => {
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
          let rendered = false;
          for (let i = 0; i < 40 && !rendered; i++) {
            rendered = (await cs.ev(
              `(() => { const n = document.getElementById('plugin-name');` +
                ` return !!n && (n.textContent ?? '').trim() !== '' && !!document.querySelector('#cap-list li'); })()`,
            )) === true;
            if (!rendered) await sleep(100);
          }
          const who = String(await cs.ev(`document.getElementById('plugin-name')?.textContent ?? ''`));
          const caps = await cs.ev(`[...document.querySelectorAll('#cap-list li')].map(li => li.textContent)`);
          consents.push({ who, caps, rendered });
          await cs.ev(`document.getElementById('btn-allow').click()`);
        } finally {
          cs.close();
        }
      } catch (err) {
        console.log(`  · 同意框应答失败，重试：${String(err).slice(0, 80)}`);
      }
      await sleep(250);
    }
  };
  return { run, stop: () => (stopped = true) };
}

/* ---------- closed shadow 取证（CDP DOM pierce） ---------- */
async function domResult(client, method, params = {}) {
  const msg = await client.send(method, params, 15_000);
  if (msg?.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg?.result;
}

async function shadowRootOf(client, hostSelector) {
  const doc = await domResult(client, "DOM.getDocument", { depth: -1, pierce: true });
  const host = await domResult(client, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: hostSelector,
  });
  if (!host?.nodeId) return 0;
  const desc = await domResult(client, "DOM.describeNode", {
    nodeId: host.nodeId,
    depth: 0,
    pierce: true,
  });
  return desc?.node?.shadowRoots?.[0]?.nodeId ?? 0;
}

async function shadowQuery(client, hostSelector, innerSelector) {
  const shadow = await shadowRootOf(client, hostSelector);
  if (!shadow) return 0;
  const node = await domResult(client, "DOM.querySelector", {
    nodeId: shadow,
    selector: innerSelector,
  });
  return node?.nodeId ?? 0;
}

async function shadowText(client, hostSelector, innerSelector) {
  const nodeId = await shadowQuery(client, hostSelector, innerSelector);
  if (!nodeId) return "";
  const html = await domResult(client, "DOM.getOuterHTML", { nodeId });
  return String(html?.outerHTML ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function shadowCount(client, hostSelector, innerSelector) {
  const shadow = await shadowRootOf(client, hostSelector);
  if (!shadow) return 0;
  const nodes = await domResult(client, "DOM.querySelectorAll", {
    nodeId: shadow,
    selector: innerSelector,
  });
  return (nodes?.nodeIds ?? []).length;
}

async function shadowValue(client, hostSelector, innerSelector) {
  const nodeId = await shadowQuery(client, hostSelector, innerSelector);
  if (!nodeId) return null;
  const resolved = await domResult(client, "DOM.resolveNode", { nodeId });
  const objectId = resolved?.object?.objectId;
  if (!objectId) return null;
  const out = await domResult(client, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function(){ return this.value; }",
    returnByValue: true,
  });
  return out?.result?.value ?? null;
}

async function waitShadowText(client, hostSelector, innerSelector, needle, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await shadowText(client, hostSelector, innerSelector).catch(() => "");
    if (value.includes(needle)) return value;
    await sleep(500);
  }
  return "";
}

const badgeHost = `#widget-badge div[data-plugin-id=${JSON.stringify(PID)}][data-region="badge"]`;
const overlayHost = `#widget-overlay div[data-plugin-id=${JSON.stringify(PID)}][data-region="overlay"]`;
const settingsHost = `#plugin-settings div[data-plugin-id=${JSON.stringify(PID)}][data-region="settings"]`;

/* ---------- 插件指令与视图 ---------- */
async function send(cmd) {
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify(cmd)})`);
}

async function readView() {
  return c.ev("window.__seen.widget.at(-1) ?? null");
}

async function storeGet(key) {
  const res = await hostInvoke(c)("store_get", { pluginId: PID, key });
  return res.ok ? res.v : null;
}

/** 先 clearKey，再等存储里的 apiKey 真的为空；收尾/在线组都走这里。 */
async function clearCred(timeoutMs = 8000) {
  await send({ action: "clearKey" });
  return pollUntil(async () => {
    const cred = await storeGet("cred");
    return cred && cred.apiKey === "" ? cred : null;
  }, timeoutMs);
}

async function peekWidget() {
  const res = await hostInvoke(c)("bus_peek", { topic: `${PID}:widget` });
  return res.ok ? res.v : null;
}

async function overlayVisible() {
  const res = await hostInvoke(c)("plugin:window|is_visible", { label: OVERLAY_LABEL });
  return res.ok && res.v === true;
}

async function waitConsentForPlugin(before = 0, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = consents
      .slice(before)
      .find((entry) => String(entry.who ?? "").includes(PID) && Array.isArray(entry.caps));
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

async function openPluginPage() {
  await settings.client.ev(
    `document.querySelector('#nav-plugins .nav-item[data-view=${JSON.stringify(PID)}]')?.click()`,
  );
  const hostOk = await waitUntil(
    settings.client,
    `!!document.querySelector('#plugin-settings div[data-plugin-id=${JSON.stringify(PID)}]')`,
    20_000,
  );
  const realm = hostOk
    ? await waitWidgetRealm(settings.client, PID, "settings", "worker", 20_000)
    : { actual: "missing" };
  return { hostOk, realm: realm.actual };
}

try {
  c = await attach(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

try {
  const invoke = hostInvoke(c);
  origEnabled = await readEnabledIds(invoke);
  pump = makePump();
  void pump.run(1_200_000);
  const manifest = (await invoke("plugins_list")).v?.find((m) => m.id === PID);

  r.group("发现与能力声明");
  r.check("manifest 被发现", true, !!manifest);
  r.check(
    "声明了 widget / overlay / http / bus:subscribe",
    true,
    ["widget", "overlay", "http", "bus:subscribe"].every((cap) =>
      (manifest?.permissions ?? []).includes(cap),
    ),
  );

  // 干净起点：撤销授权会连带清掉插件存储目录。
  settings = await openSettingsInvoker(PORT, c);
  await settings.invoke("permission_revoke", { pluginId: PID });
  await pollUntil(async () => {
    const res = await hostInvoke(c)("store_get", { pluginId: PID, key: "cred" });
    return !res.ok || res.v === null;
  }, 8000);

  r.group("启用与授权");
  await writeEnabledIds(settings.invoke, [...origEnabled, PID]);
  await reloadAndWait(c);
  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    window.__bus = { publish: (topic, payload) => bus.publish(topic, payload, ${JSON.stringify(PID)}) };
    window.__seen = { widget: [], status: [], panel: [] };
    bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (p) => window.__seen.widget.push(p));
    bus.subscribe(${JSON.stringify(`${PID}:status`)}, (p) => window.__seen.status.push(p));
    bus.subscribe(${JSON.stringify(`${PID}:panel`)}, (p) => window.__seen.panel.push(p));
    return true;
  })()`);

  const badgeSlot = await waitUntil(
    c,
    `!!document.querySelector(${JSON.stringify(badgeHost)})`,
    30_000,
  );
  r.check("badge 插槽已创建", true, badgeSlot);
  const badgeRealm = await waitWidgetRealm(c, PID, "badge", "worker", 20_000);
  r.check("badge 在 Worker realm", "worker", badgeRealm.actual);

  const consent = await waitConsentForPlugin();
  r.check("同意框渲染出插件能力", true, !!consent?.rendered);
  const caps = new Set(
    consents.filter((entry) => String(entry.who ?? "").includes(PID)).flatMap((entry) => entry.caps ?? []),
  );
  const wanted = manifest?.permissions ?? [];
  r.check(
    "同意框列出的能力等于 manifest",
    true,
    wanted.length > 0 && wanted.every((cap) => caps.has(cap)) && caps.size === wanted.length,
  );

  const empty = await waitUntil(
    c,
    `(() => { const n = document.querySelector(${JSON.stringify(badgeHost)}); if (!n) return false; const b = n.getBoundingClientRect(); return b.width === 0 && b.height === 0; })()`,
    10_000,
  );
  r.check("未配置且非演示时 badge 没有尺寸", true, empty);

  // 观察 petController；notify 用插件在 ctx.notify.show resolve 后发的 :status 记录。
  const petReady = await waitUntil(c, `(async () => {
    const host = await import('/src/pet/host.ts');
    const ctrl = host.petController();
    if (!ctrl) return false;
    window.__pet = { acts: [], said: [] };
    const react0 = ctrl.react.bind(ctrl);
    const say0 = ctrl.say.bind(ctrl);
    ctrl.react = (a) => { window.__pet.acts.push(a); return react0(a); };
    ctrl.say = (t) => { window.__pet.said.push(t); return say0(t); };
    return true;
  })()`, 10_000);
  r.check("宠物控制器可拦截", true, petReady);

  r.group("演示：badge / overlay");
  await send({ action: "saveConfig", config: { demo: true } });
  const badgeText = await waitShadowText(c, badgeHost, ".g-badge", "5h 63%", 20_000);
  r.check("badge 显示演示 5h 63%", true, badgeText.includes("5h 63%"));

  const visible = await pollUntil(() => overlayVisible(), 15_000, 500);
  r.check("overlay 窗口可见", true, !!visible);

  const overlayTarget = (await listPages(PORT)).find(
    (t) => /overlay\.html/.test(t.url) && t.title === `DesktopPet Overlay · ${PID}`,
  );
  r.check("overlay 页按标题可识别", true, !!overlayTarget);
  if (overlayTarget) {
    oc = await attach(PORT, (t) => t.webSocketDebuggerUrl === overlayTarget.webSocketDebuggerUrl, 10_000);
  }
  const overlaySlot = oc
    ? await waitUntil(oc, `!!document.querySelector(${JSON.stringify(overlayHost)})`, 20_000)
    : false;
  r.check("overlay widget 挂进插槽", true, overlaySlot);
  if (oc && overlaySlot) {
    const realm = await waitWidgetRealm(oc, PID, "overlay", "worker", 15_000);
    r.check("overlay 在 Worker realm", "worker", realm.actual);
    const ringCount = await shadowCount(oc, overlayHost, ".g-ring").catch(() => -1);
    r.check("overlay 三个环节点齐全", 3, ringCount);
    const cardText = await shadowText(oc, overlayHost, ".g-card").catch(() => "");
    r.check(
      "overlay 卡包含三窗口文案",
      true,
      ["5 小时", "本周", "本月"].every((label) => cardText.includes(label)),
    );
  }

  const dpr = Number(await c.ev("window.devicePixelRatio")) || 1;
  const settleAt = async (logicalX, logicalY, timeoutMs = 10_000) => {
    const until = Date.now() + timeoutMs;
    let last = {};
    for (;;) {
      const pos = await invoke("plugin:window|outer_position", { label: OVERLAY_LABEL });
      last = pos.ok ? (pos.v ?? last) : last;
      const ok = near(last?.x ?? 1e9, logicalX * dpr) && near(last?.y ?? 1e9, logicalY * dpr);
      if (ok || Date.now() > until) return { ok, last };
      await sleep(500);
    }
  };
  const initialPos = await settleAt(360, 220);
  r.check("overlay 首开落在插件坐标 (360,220)", true, initialPos.ok);
  if (oc) {
    const screen = await oc.ev("[window.screenX, window.screenY]").catch(() => null);
    r.check(
      "overlay 页面侧 screenX/Y 也是 (360,220)",
      true,
      !!screen && near(screen[0], 360) && near(screen[1], 220),
    );
  }
  await send({ action: "saveConfig", config: { overlayX: 300, overlayY: 420 } });
  const moved = await settleAt(300, 420);
  r.check("已存在的 overlay 按新坐标移动 (300,420)", true, moved.ok);
  if (oc) {
    const screen = await oc.ev("[window.screenX, window.screenY]").catch(() => null);
    r.check(
      "改坐标后页面侧 screenX/Y 也是 (300,420)",
      true,
      !!screen && near(screen[0], 300) && near(screen[1], 420),
    );
  }

  r.group("设置：回显与补丁合并");
  const page = await openPluginPage();
  r.check("插件页已挂载", true, page.hostOk);
  r.check("插件页在 Worker realm", "worker", page.realm);
  await send({ action: "saveConfig", config: { refreshSec: 120 } });
  const firstCfg = await pollUntil(async () => {
    const current = await storeGet("config");
    return current?.refreshSec === 120 ? current : null;
  }, 8000);
  r.check("刷新间隔先落库", true, !!firstCfg);
  await send({ action: "saveConfig", config: { currency: "CNY" } });
  const cfg = await pollUntil(async () => {
    const current = await storeGet("config");
    return current &&
      current.refreshSec === 120 &&
      current.currency === "CNY" &&
      current.overlayX === 300 &&
      current.overlayY === 420
      ? current
      : null;
  }, 8000);
  r.check("只改币种不抹刷新间隔", [120, "CNY", 300, 420], [
    cfg?.refreshSec,
    cfg?.currency,
    cfg?.overlayX,
    cfg?.overlayY,
  ]);
  const peekedCfg =
    (await pollUntil(async () => {
      const config = (await peekWidget())?.config;
      return config && config.refreshSec === 120 && config.currency === "CNY"
        ? config
        : null;
    }, 8000)) ?? {};
  r.check("widget 视图里的配置同步", [120, "CNY"], [peekedCfg.refreshSec, peekedCfg.currency]);
  const uiRefresh = await pollUntil(async () => {
    const value = await shadowValue(
      settings.client,
      settingsHost,
      'input[data-field="refreshSec"]',
    ).catch(() => null);
    return value === "120" ? value : null;
  }, 8000);
  const uiCurrency = await pollUntil(async () => {
    const value = await shadowValue(
      settings.client,
      settingsHost,
      'select[data-field="currency"]',
    ).catch(() => null);
    return value === "CNY" ? value : null;
  }, 8000);
  r.check("设置页控件回显刷新间隔", "120", String(uiRefresh));
  r.check("设置页控件回显币种", "CNY", String(uiCurrency));

  await settings.close();
  settings = null;
  settings = await openSettingsInvoker(PORT, c);
  const reopened = await openPluginPage();
  r.check("重开设置窗插件页仍挂载", true, reopened.hostOk);
  const uiRefresh2 = await pollUntil(async () => {
    const value = await shadowValue(
      settings.client,
      settingsHost,
      'input[data-field="refreshSec"]',
    ).catch(() => null);
    return value === "120" ? value : null;
  }, 8000);
  const uiCurrency2 = await pollUntil(async () => {
    const value = await shadowValue(
      settings.client,
      settingsHost,
      'select[data-field="currency"]',
    ).catch(() => null);
    return value === "CNY" ? value : null;
  }, 8000);
  r.check("重开后刷新间隔回显 120", "120", String(uiRefresh2));
  r.check("重开后币种回显 CNY", "CNY", String(uiCurrency2));

  r.group("演示：告警与去重");
  await send({ action: "demoScenario", scenario: "exhausted" });
  const notified = await waitUntil(
    c,
    "window.__seen.status.some((s) => String(s.text ?? '').includes('已发送通知'))",
    15_000,
  );
  const failed = await waitUntil(c, "window.__pet.acts.includes('failed')", 15_000);
  r.check("5 小时用尽触发 notify 并收到成功记录", true, notified);
  r.check("5 小时用尽触发宠物 failed", true, failed);
  const notifyStatus = await c.ev(
    "window.__seen.status.find((s) => String(s.text ?? '').includes('已发送通知')) ?? null",
  );
  r.check("通知记录带 GOAT 用量标题", true, String(notifyStatus?.text ?? "").includes("GOAT 用量"));
  r.check(
    "通知记录带 5 小时用尽文案",
    true,
    String(notifyStatus?.text ?? "").includes("5 小时额度已用尽"),
  );
  const countNotify = () =>
    c.ev(
      "window.__seen.status.filter((s) => String(s.text ?? '').includes('已发送通知')).length",
    );
  const beforeNotify = Number(await countNotify()) || 0;
  const beforeFailed = Number(await c.ev("window.__pet.acts.filter((a) => a === 'failed').length")) || 0;
  const beforeFetched = Number((await readView())?.fetchedAt) || 0;
  await send({ action: "demoScenario", scenario: "exhausted" });
  const refreshed = await pollUntil(async () => {
    const view = await readView();
    return view && Number(view.fetchedAt) > beforeFetched ? view : null;
  }, 10_000);
  r.check("第二次演示刷新完成", true, !!refreshed);
  const afterNotify = Number(await countNotify()) || 0;
  const afterFailed = Number(await c.ev("window.__pet.acts.filter((a) => a === 'failed').length")) || 0;
  r.check("同一窗口不重复通知", beforeNotify, afterNotify);
  r.check("同一窗口不重复触发 failed", beforeFailed, afterFailed);

  r.group("凭据：Key 不出现在视图/日志");
  await send({ action: "saveKey", key: TEST_KEY });
  const storedCred = await pollUntil(async () => {
    const cred = await storeGet("cred");
    return cred?.apiKey === TEST_KEY ? cred : null;
  }, 8000);
  r.check("测试 Key 已写入插件存储", TEST_KEY, storedCred?.apiKey);
  const peeked = await peekWidget();
  r.check("widget payload 不含测试 Key", false, JSON.stringify(peeked ?? null).includes(TEST_KEY));
  const logPath = join(env.LOCALAPPDATA ?? "", "com.desktoppet.pet", "logs", "host.log");
  const logHit = existsSync(logPath) && readFileSync(logPath, "utf8").includes(TEST_KEY);
  r.check("host.log 不含测试 Key", false, logHit);

  const beforeClearFetched = Number((await readView())?.fetchedAt) || 0;
  const clearedDemo = await clearCred();
  r.check("演示测试 Key 已从插件存储清空", true, !!clearedDemo);
  const afterClearView = await pollUntil(async () => {
    const view = await readView();
    return view && Number(view.fetchedAt) > beforeClearFetched ? view : null;
  }, 8000);
  r.check("清 Key 后 demo 继续刷新", true, !!afterClearView);

  r.group("停用：停止推送与收掉 overlay");
  const widgetCountBefore = (await readView()) ? Number(await c.ev("window.__seen.widget.length")) : 0;
  await writeEnabledIds(settings.invoke, origEnabled);
  await sleep(10_000);
  const widgetCountAfter = Number(await c.ev("window.__seen.widget.length")) || 0;
  r.check("停用后 10 秒没有新的 :widget 推送", widgetCountBefore, widgetCountAfter);
  const hidden = await pollUntil(
    async () => !(await overlayVisible().catch(() => true)),
    12_000,
    500,
  );
  r.check("停用后 overlay 已收起", true, !!hidden);

  r.group("撤销授权与重新启用");
  const beforeConsents = consents.length;
  await settings.invoke("permission_revoke", { pluginId: PID });
  const denied = await pollUntil(async () => {
    const res = await hostInvoke(c)("store_get", { pluginId: PID, key: "cred" });
    return !res.ok || res.v === null ? res : null;
  }, 8000);
  r.check("撤销后存储读不到", true, !!denied && (!denied.ok || denied.v === null));
  await writeEnabledIds(settings.invoke, [...origEnabled, PID]);
  await reloadAndWait(c);
  const reconsent = await waitConsentForPlugin(beforeConsents, 30_000);
  r.check("重新启用会重新弹同意框", true, !!reconsent?.rendered);
  const reconsentCaps = new Set(reconsent?.caps ?? []);
  r.check(
    "重新弹框仍列出 manifest 能力",
    true,
    wanted.length > 0 && wanted.every((cap) => reconsentCaps.has(cap)),
  );

  if (ONLINE) {
    r.group("在线组（GOAT_GAUGE_KEY + GOAT_GAUGE_ONLINE=1）");
    const beforeOnlineConsents = consents.length;
    await send({ action: "saveKey", key: env.GOAT_GAUGE_KEY });
    const onlineConsent = await waitConsentForPlugin(beforeOnlineConsents, 30_000);
    const onlineCaps = onlineConsent?.caps ?? [];
    r.check(
      "http:api.commandcode.ai 同意框出现",
      true,
      onlineCaps.includes("http:api.commandcode.ai"),
    );
    const onlineOk = await waitUntil(
      c,
      `(() => { const v = window.__seen.widget.at(-1); return v?.state === "ok" && typeof v?.windows?.five_hour?.used === "number"; })()`,
      25_000,
    );
    r.check("在线快照字段类型正确", true, onlineOk);
    const onlineLogHit = existsSync(logPath) && readFileSync(logPath, "utf8").includes(env.GOAT_GAUGE_KEY);
    r.check("host.log 不含真实 Key", false, onlineLogHit);
    const clearedOnline = await clearCred();
    r.check("在线真实 Key 已从插件存储清空", true, !!clearedOnline);
  } else {
    r.info("在线组已跳过", "需要同时设置 GOAT_GAUGE_KEY 与 GOAT_GAUGE_ONLINE=1");
  }

  r.group("零噪音");
  r.check("无 console 错误与未捕获异常", [], c.noise);
  if (settings?.client) r.check("设置页无 console 错误与未捕获异常", [], settings.client.noise);
  if (oc) r.check("overlay 页无 console 错误与未捕获异常", [], oc.noise);
} catch (err) {
  r.check("脚本未抛异常", true, false);
  console.error(err);
} finally {
  pump?.stop();
  oc?.close();
  try {
    const canSend = await c.ev("typeof window.__bus?.publish === 'function'").catch(() => false);
    if (canSend) await clearCred(3000).catch(() => undefined);
    if (!settings) settings = await openSettingsInvoker(PORT, c).catch(() => null);
    if (settings) {
      await writeEnabledIds(settings.invoke, origEnabled).catch(() => undefined);
      await settings.invoke("permission_revoke", { pluginId: PID }).catch(() => undefined);
      await pollUntil(async () => {
        const res = await hostInvoke(c)("store_get", { pluginId: PID, key: "cred" });
        return !res.ok || res.v === null;
      }, 8000).catch(() => undefined);
      settings.close();
    }
    await reloadAndWait(c).catch(() => undefined);
  } catch (err) {
    console.error("收尾失败", err);
  }
  const failed = r.summary();
  c?.close();
  process.exit(failed ? 1 : 0);
}

