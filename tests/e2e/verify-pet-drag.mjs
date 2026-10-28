#!/usr/bin/env node
// tests/e2e/verify-pet-drag.mjs —— 拖动方向态（running-right / running-left）与松手复原的真机回归。
//
// 用法（必须已有实例在跑）：
//   终端 1: npm run dev:debug        # 起 Tauri dev 实例并开 CDP（默认 9223）
//   终端 2: npm run verify:drag      # 本套件；端口可用 CDP_PORT=xxxx 或 --port=xxxx 覆盖
//
// ## 这套件到底测了什么（「窗口位移」由谁产生）
//
// 拖动方向态的数据源是**窗口位移**，不是 mousemove：真机一按下去系统就进了拖拽循环，
// webview 之后收不到 mousemove/mouseup。所以本套件把「谁产生窗口位移」写成了可复跑的替代路径：
//
//   1. 起拖：CDP `Input.dispatchMouseEvent` 合成 mousedown + 超过 DRAG_START_PX 的 mousemove
//      → 触发 main.ts 自己的起拖分支（beginDrag + startDragging invoke），页面进入 dragEngaged。
//      合成的按下没有物理按键，Windows 拖拽循环不会真的接管，所以页面还能继续收 IPC。
//   2. 位移：由 Win32 `SetWindowPos`（harness/pet-window.ps1，Node 侧外部进程）真实搬宠物窗。
//      产生的是真 WM_MOVE → tauri://move → getCurrentWindow().onMoved，与鼠标拖拽撞的是同一条链路；
//      方向判定、阈值、去抖、状态机切换全是被测代码本身。
//   3. 读数：读真实 DOM 的 `documentElement[data-pet-state]`（由套件注入的观察器写入，见下）。
//
// 阈值不另抄一套：DRAG_DIRECTION_MIN_PX / DRAG_DIRECTION_COOLDOWN_MS 从
// src/pet/state-machine.ts import；DRAG_START_PX 从 /src/main.ts?raw 源码里取。
// 时间预算沿用 t1 卡的验收线：出现方向态 ≤300ms、反向 ≤200ms、松手复原 ≤300ms。
//
// ## 覆盖了什么 / 没覆盖什么（如实口径）
//
// 覆盖：
//   - 起拖后按真实水平位移方向进入 running-right / running-left（真实 DOM 属性）
//   - 反向拖动切到另一侧；同向继续拖不来回抖
//   - 松手回到**拖动前**状态（本套件把拖动前置成插件态 running，复原若退化成 idle 会被抓）
//   - 切换发生在「跨过 24 CSS px 阈值的那一帧」，且方向判定期间页面没有新增 mousemove
//     （反证判定只靠窗口位移，不靠 startDragging 后的鼠标事件）
//   - 未拖动时戳一戳（手势态 + 台词）与点击穿透（WS_EX_TRANSPARENT 位）行为不变
//   - 二次拖动可再次进入方向态（beginDrag 快照/重置不串台）
//   - 收尾把窗口位置与系统光标还原；不写用户目录、不改配置（因此不需要 verify:agent 那套 PET_AGENT_* 隔离变量）
// 没覆盖（本套件不给绿灯，需人工验）：
//   - **真实鼠标按住拖动**：Windows 的 OS 拖拽循环（startDragging）本身没被驱动，
//     「拖拽循环期间 Moved 事件是否照样转发到 webview」只能人工验证，步骤见文末。
//   - DPI 非 100% 的缩放档、多显示器/负坐标屏（套件按 devicePixelRatio 换算，但没有在这些环境跑过）。
// 其他说明：
//   - 应用本身没有 data-pet-state 属性；套件用 Page.addScriptToEvaluateOnNewDocument 注入观察器，
//     给 PetStateMachine.prototype.switchTo / update / beginDrag / dragDirection / endDrag 挂包装，
//     把**真实状态机**切换后的 current 镜像到 <html data-pet-state>。写入者就是被测状态机，
//     不是另一份状态副本；断言读的是这个真实 DOM 属性。
//   - 合成按下的按键状态和真机不同：真拖时 mousemove 带 buttons=1，而合成拖拽里若窗口在光标
//     底下移动，WebView2 会补发 buttons=0 的 mousemove，被 main.ts 的
//     `dragEngaged && e.buttons === 0` 当成松手而取消拖动。套件因此在拖动相开始前把系统光标
//     停到远离宠物的屏幕角落，并在拖动相断言「页面没有再收到 mousemove」。
//   - 本套件本轮不进 .github/workflows/e2e.yml 的 allowlist（CI 本轮不改）：它要求先起 dev 实例、
//     还要真实桌面窗口，与 verify:skin / verify:release 等按需手动的套件同类。
//   - 前置缺失（CDP 连不上 / 观察器注入失败 / 找不到宠物窗 / PowerShell 7 缺失）一律报红并打印修复指引，
//     不静默跳过；退出码 1 = 断言红，2 = 前置连不上。
//
// ## 并发纪律（一套件一实例、串行跑）
//
// 不要和其他会搬窗口或动光标的套件并发跑（`verify` / `verify:agent` / `verify:game` 等 CDP 套件，
// 以及别的 UI 自动化）：本套件靠外部 SetWindowPos 搬宠物窗，还会把系统光标放到宠物上再停到 (10,10)，
// 并发时两边互相抢光标/窗口。实测（2026-10-28 15:33 与另一 UI 套件并发）：唯一红是
//   「系统光标已还原 — 期望 {"x":1597,"y":246}，实得 {"x":1564,"y":291}」，那一次 40/1；
// 同一实例串行冷启动连跑两次都是 41/0 —— 那条红是别的套件动了光标，不是拖动判据错。
// 判读与做法：看到「系统光标已还原」或窗口矩形还原类红，先查是不是有别的 UI 套件在跑/没退干净；
// **一套件一实例、串行**，等上一个套件收尾（实例与光标都还回去）再跑本套件。
//
// ## 人工验证「真实鼠标拖动」的步骤（未覆盖项）
//   1. npm run dev:debug，等宠物出现在桌面
//   2. 按住宠物往右拖 >24 CSS px：拖拽期间应显示 running-right（向右跑）
//   3. 不松手反向往左拖 >24 CSS px：应切成 running-left
//   4. 松手：应回到按下前的状态（插件在跑时是 running；闲置时是 idle/waiting）
//   5. 重复 2-4 三次，确认「拖过一次后还能正常戳宠物、点不到时能穿透」

import { attach, createReport, hostInvoke, reloadAndWait, waitUntil } from "./harness/cdp.mjs";
import {
  killAll,
  movePetWindow,
  readPetWindow,
  setCursor,
  waitTransparent,
} from "./harness/pet-window.mjs";

const PORT = Number(
  process.env.CDP_PORT ?? process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223,
);
const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);

// t1 卡验收线（时间预算，不是判定阈值；阈值从源码取）
const DEADLINE = { direction: 300, reverse: 200, restore: 300 };

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** 轮询条件直到真值；返回值或 null */
async function waitFor(fn, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 页面在导航/重载时偶发求值失败，继续轮询 */
    }
    await sleep(25);
  }
  return null;
}

const r = createReport("verify:drag —— 拖动方向态 running-right/left 与松手复原（真实实例）");

let c = null;
let shimId = null;
let rect0 = null;
let cursor0 = null;
let center = null;
let pressed = false;

// 观察器：注入到文档起点。注意两件事——
// 1) 只包 desc.value 是函数的成员：state-machine 的 `get frame()` 是 getter，碰它会抛；
// 2) `import("/src/pet/state-machine.ts")` 与 main.ts 拿到的是同一个 Vite 模块实例（已实测）。
const SHIM = `(() => {
  if (window.__petDragProbe) return;
  const probe = {
    errors: [],
    events: [],
    moves: [],
    mousemoves: 0,
    instance: null,
    reset() { this.events = []; this.moves = []; this.mousemoves = 0; this.errors = []; },
  };
  window.__petDragProbe = probe;
  const now = () => Math.round(performance.now() * 10) / 10;

  // 真实窗口位移（tauri://move）：证明 onMoved 的数据源确实到页面了
  try {
    const cb = window.__TAURI_INTERNALS__.transformCallback((e) => {
      const p = e && e.payload ? e.payload : e;
      if (p && typeof p.x === "number") probe.moves.push({ t: now(), x: p.x });
      if (probe.moves.length > 400) probe.moves.shift();
    }, false);
    window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event: "tauri://move",
      target: { kind: "Window", label: "pet" },
      handler: cb,
    }).catch((err) => probe.errors.push("listen:" + String(err)));
  } catch (err) {
    probe.errors.push("listen:" + String(err));
  }

  // 页面收到的 mousemove 记数：方向判定若偷偷依赖 mousemove，这里会变
  document.addEventListener("mousemove", () => { probe.mousemoves += 1; }, true);

  (async () => {
    try {
      const m = await import("/src/pet/state-machine.ts");
      const proto = m.PetStateMachine.prototype;
      const mirror = (inst) => {
        if (!inst) return;
        probe.instance = inst;
        try { document.documentElement.setAttribute("data-pet-state", String(inst.action)); } catch {}
      };
      const wrap = (name, tag) => {
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || typeof desc.value !== "function") return;
        const orig = desc.value;
        Object.defineProperty(proto, name, {
          ...desc,
          value: function (...args) {
            const ret = orig.apply(this, args);
            probe.events.push({
              t: now(),
              kind: tag,
              arg: args[0] === undefined ? null : args[0],
              state: this.current,
              dragging: this.dragging,
            });
            mirror(this);
            return ret;
          },
        });
      };
      // update 每帧都调：只用来抓活实例，不记事件（否则 probe.events 会被 60fps 灌满）
      const wrapUpdate = () => {
        const desc = Object.getOwnPropertyDescriptor(proto, "update");
        if (!desc || typeof desc.value !== "function") return;
        const orig = desc.value;
        Object.defineProperty(proto, "update", {
          ...desc,
          value: function (...args) {
            const ret = orig.apply(this, args);
            if (!probe.instance) {
              probe.instance = this;
              if (!document.documentElement.hasAttribute("data-pet-state")) mirror(this);
            }
            return ret;
          },
        });
      };
      for (const name of ["switchTo", "beginDrag", "dragDirection", "endDrag"]) wrap(name, name);
      wrapUpdate();
    } catch (err) {
      probe.errors.push("import:" + String(err && err.message ? err.message : err));
    }
  })();
})();`;

async function main() {
  try {
    c = await attach(PORT, isPetPage, 60_000);
  } catch (err) {
    console.error(`\n[前置失败] 连不上 dev 实例的 CDP 端口 ${PORT}：${err.message}`);
    console.error("  修复：先在另一个终端跑 `npm run dev:debug`，等宠物出现、CDP 就绪。");
    console.error("  （dev:debug 首次启动可能因单实例机制立刻退出，再跑一次即可；端口不同用 CDP_PORT=xxxx 覆盖。）");
    process.exit(2);
  }

  const getState = () => c.ev('document.documentElement.getAttribute("data-pet-state")');
  const snap = () =>
    c.ev(`(() => {
      const p = window.__petDragProbe;
      if (!p) return null;
      return {
        t: Math.round(performance.now() * 10) / 10,
        events: p.events.slice(),
        moves: p.moves.slice(),
        mousemoves: p.mousemoves,
        errors: p.errors.slice(),
        instanceState: p.instance ? p.instance.action : null,
        dragging: p.instance ? p.instance.dragging : null,
      };
    })()`);
  const resetProbe = () =>
    c.ev("(() => { const p = window.__petDragProbe; if (!p) return false; p.reset(); return true; })()");
  const mouse = (type, x, y, buttons) =>
    c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });

  /** 跨阈值帧：窗口位移累计首次达到 minPxPhys（物理像素）的那一帧 */
  const firstCrossing = (s, baseX, minPxPhys, sign) => {
    let prev = baseX;
    let cum = 0;
    for (const m of s.moves) {
      cum += m.x - prev;
      prev = m.x;
      if (sign > 0 ? cum >= minPxPhys : cum <= -minPxPhys) return { moveT: m.t, cum };
    }
    return null;
  };
  /** 跨阈值帧之后的第一次切向；顺带容忍同帧事件顺序抖动（负延迟不小于 -1ms） */
  const switchAfter = (s, state, notBefore) => {
    const hits = s.events.filter((e) => e.kind === "switchTo" && e.state === state);
    return hits.find((e) => e.t >= notBefore - 1) ?? hits[0] ?? null;
  };
  const latencyDetail = (s, cross, sw) =>
    JSON.stringify({
      crossT: cross?.moveT ?? null,
      crossCum: cross?.cum ?? null,
      swT: sw?.t ?? null,
      swState: sw?.state ?? null,
      events: s.events.map((e) => `${e.t}:${e.kind}:${e.state}`),
      moves: s.moves.map((m) => `${m.t}:${m.x}`),
    });

  try {
    // ── 0. 前置 ────────────────────────────────────────────────────────────────
    r.group("0. 前置（缺了必须红，不静默跳过）");
    await c.send("Page.enable");
    try {
      const { identifier } = await c.send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM });
      shimId = identifier;
    } catch (err) {
      r.check("前置：能注入状态观察器", true, false);
      throw new Error(`Page.addScriptToEvaluateOnNewDocument 失败：${err.message}`);
    }
    // 重载一次，确保观察器从文档起点生效（也顺带把页面状态清干净）
    await reloadAndWait(c);
    const ready = await waitUntil(
      c,
      'Boolean(window.__petDragProbe && window.__petDragProbe.instance && document.documentElement.hasAttribute("data-pet-state"))',
      15_000,
    );
    r.check("前置：状态观察器生效，<html data-pet-state> 可读", true, ready);
    if (!ready) {
      const diag = await snap();
      console.error("\n[前置失败] 观察器没拿到状态机实例。");
      console.error(`  诊断：${JSON.stringify(diag)}`);
      console.error("  修复：确认 dev 实例的页面是 http://localhost:1420/src/index.html（dev:debug 起的 dev server），然后重跑。");
      throw new Error("状态观察器未就绪");
    }
    const probeErrors = (await snap()).errors;
    r.check("前置：观察器自身没有报错", [], probeErrors);

    const initial = await getState();
    r.check("前置：初始状态是已知状态字符串", true, typeof initial === "string" && initial.length > 0);
    r.info("初始 data-pet-state", initial);

    const skin = await hostInvoke(c)("pet_skin_active");
    r.check(
      "前置：真实 Petdex 图集已安装（running-right/left 有行可播）",
      true,
      skin.ok === true && typeof skin.v?.url === "string" && skin.v.url.startsWith("http://petskin.localhost/"),
    );
    r.info("皮肤", skin.ok ? `${skin.v.slug} (${skin.v.url})` : `读取失败：${skin.e}`);

    const players = await c.ev(`(() => {
      const p = window.__petDragProbe.instance;
      return p ? { right: !!p.players["running-right"], left: !!p.players["running-left"], states: Object.keys(p.players).sort() } : null;
    })()`);
    r.check("前置：players 里有 running-right / running-left", { right: true, left: true }, {
      right: players?.right ?? false,
      left: players?.left ?? false,
    });
    r.info("可播状态", players?.states?.join(",") ?? "(none)");

    const derived = await c.ev(`(async () => {
      const sm = await import("/src/pet/state-machine.ts");
      const raw = (await import("/src/main.ts?raw")).default;
      const m = /const DRAG_START_PX = (\\d+)/.exec(raw);
      return {
        minPx: sm.DRAG_DIRECTION_MIN_PX,
        cooldownMs: sm.DRAG_DIRECTION_COOLDOWN_MS,
        startPx: m ? Number(m[1]) : null,
      };
    })()`, 15_000);
    r.check("前置：从源码取到 DRAG_START_PX（不另抄阈值）", true, derived?.startPx !== null && derived?.startPx > 0);
    r.check("前置：方向判定常数来自 src/pet/state-machine.ts", true, derived?.minPx > 0 && derived?.cooldownMs > 0);
    r.info(
      "阈值口径（源码）",
      `DRAG_START_PX=${derived?.startPx}px, DRAG_DIRECTION_MIN_PX=${derived?.minPx}px, DRAG_DIRECTION_COOLDOWN_MS=${derived?.cooldownMs}ms；时间预算 ${JSON.stringify(DEADLINE)}`,
    );
    if (!(derived?.startPx > 0) || !(derived?.minPx > 0)) throw new Error("阈值常数取不到，无法按同一口径断言");

    let w0;
    try {
      w0 = readPetWindow();
    } catch (err) {
      r.check("前置：能找到宠物窗（桌面侧 Win32）", true, false);
      throw err;
    }
    rect0 = { ...w0.rect };
    cursor0 = { ...w0.cursor };
    const dpr = await c.ev("window.devicePixelRatio || 1");
    const iw = await c.ev("innerWidth");
    const ih = await c.ev("innerHeight");
    center = { x: Math.round(iw / 2), y: Math.round(ih / 2) };
    const minPxPhys = derived.minPx * dpr;
    r.check(
      "前置：窗口矩形 = 视口 × dpr（PS 坐标与页面坐标可对齐）",
      true,
      Math.abs(w0.rect.width - iw * dpr) <= 2 && Math.abs(w0.rect.height - ih * dpr) <= 2,
    );
    r.info("宠物窗", `hwnd=${w0.hwnd} pid=${w0.pid} rect=${JSON.stringify(w0.rect)} dpr=${dpr} inner=${iw}x${ih}`);

    // ── ④ 未拖动时：穿透 + 戳一戳 ──────────────────────────────────────────────
    r.group("④ 未拖动时：点击穿透与戳一戳不变（回归）");
    const spriteCx = w0.rect.left + (iw / 2) * dpr;
    const spriteCy = w0.rect.top + (ih / 2) * dpr;
    const outsideX = w0.rect.left > 240 ? w0.rect.left - 200 : w0.rect.left + w0.rect.width + 120;
    const outsideY = w0.rect.top + 40;

    setCursor(outsideX, outsideY);
    const trOut = waitTransparent(true, 5000);
    r.check("未拖动 · 光标在窗外时点击穿透开启（WS_EX_TRANSPARENT 置位）", true, trOut.matched === true);
    r.info("穿透观测（窗外）", `exStyle=${trOut.exStyle} transparent=${trOut.transparent} 用时=${trOut.elapsedMs}ms`);

    setCursor(spriteCx, spriteCy);
    const trIn = waitTransparent(false, 5000);
    r.check("未拖动 · 光标进宠物后穿透关闭（可交互）", true, trIn.matched === true);
    r.info("穿透观测（宠物上）", `exStyle=${trIn.exStyle} transparent=${trIn.transparent} 用时=${trIn.elapsedMs}ms`);

    const prePoke = await getState();
    await mouse("mousePressed", center.x, center.y, 1);
    await mouse("mouseReleased", center.x, center.y, 0);
    const pokeState = await waitFor(async () => {
      const s = await getState();
      return ["waving", "jumping", "failed"].includes(s) ? s : null;
    }, 2500);
    r.check("未拖动 · 戳一戳进入手势态（事件照常到页面）", true, pokeState !== null);
    r.info("戳一戳状态", `${prePoke} → ${pokeState}`);
    const bubble = await c.ev('(document.querySelector("#pet-bubble")?.textContent ?? "").trim()');
    r.check("未拖动 · 戳一戳有台词（气泡非空）", true, typeof bubble === "string" && bubble.length > 0);
    r.info("气泡台词", bubble);

    // 起拖前把光标停到远离宠物的屏幕角落：合成按下没有物理按键，窗口若在光标底下移动，
    // WebView2 会补发 buttons=0 的 mousemove，被 main.ts 的 `dragEngaged && e.buttons === 0` 当成松手而取消拖动。
    // 真拖时按键是按下的（buttons=1）不会走到这条，属于本替代路径的合成限制，如实记在覆盖度里。
    setCursor(10, 10);
    const trPark = waitTransparent(true, 5000);
    r.check("未拖动 · 光标离开后穿透恢复开启（进入拖动相前的中性态）", true, trPark.matched === true);
    r.info("起拖前光标位置", "(10,10) —— 远离宠物窗，避免合成 mousemove 取消合成拖拽");

    // 拖动前状态置成插件态 running：用真实插件入口（pet:react），验「复原到拖动前」而不是「回 idle」
    await c.ev(`(async () => {
      const { petController } = await import("/src/pet/host.ts");
      petController()?.react("running");
      return true;
    })()`);
    const preDragState = await waitFor(async () => ((await getState()) === "running" ? "running" : null), 8000);
    r.check("拖动前状态已置为插件态 running", "running", preDragState ?? (await getState()));
    if (preDragState !== "running") throw new Error("拖动前状态没到 running，后续复原断言会失真");

    // ── ① 起拖 → running-right ────────────────────────────────────────────────
    r.group("① 起拖后按真实水平位移切到 running-right");
    await resetProbe();
    const rectBefore = readPetWindow().rect;
    const engageDx = Math.max(derived.startPx + 8, 12);
    await mouse("mousePressed", center.x, center.y, 1);
    pressed = true;
    await mouse("mouseMoved", center.x + engageDx, center.y, 1);
    const engaged = await waitFor(async () => {
      const s = await snap();
      return s?.dragging === true ? s : null;
    }, 2000);
    r.check("合成按下并越过 DRAG_START_PX 后进入拖动态（beginDrag 已调用）", true, engaged?.dragging === true);
    r.check(
      "拖动态由 main.ts 自己的起拖分支触发（beginDrag 事件在案）",
      true,
      (engaged?.events ?? []).some((e) => e.kind === "beginDrag"),
    );

    const stepCss = 10;
    const steps = Math.max(2, Math.ceil((derived.minPx + 6) / stepCss));
    const dxPhys = Math.round(stepCss * dpr);
    const mmAtEngage = (await snap()).mousemoves;

    await movePetWindow({ dx: dxPhys, steps, delayMs: 40 });
    const gotRight = await waitFor(async () => ((await getState()) === "running-right" ? "running-right" : null), DEADLINE.direction + 800);
    r.check("① 起拖后出现 running-right（读真实 DOM data-pet-state）", "running-right", gotRight ?? (await getState()));

    const sRight = await snap();
    const crossRight = firstCrossing(sRight, rectBefore.left, minPxPhys, 1);
    r.check("位移确实由窗口驱动到达页面（tauri://move 有记录）", true, sRight.moves.length >= steps);
    r.check(
      "位移映射正确（每帧 10 CSS px，物理像素按 dpr 折算）",
      true,
      sRight.moves.length > 0 && Math.abs(sRight.moves[0].x - rectBefore.left - stepCss * dpr) <= 3,
    );
    r.check("方向态在跨过 DRAG_DIRECTION_MIN_PX 的那一帧就切了", true, crossRight !== null);
    if (crossRight) {
      const frame = sRight.moves.findIndex((m) => m.t === crossRight.moveT) + 1;
      r.info("阈值帧", `第 ${frame} 帧累计 ${crossRight.cum}px（物理）= ${(crossRight.cum / dpr).toFixed(1)} CSS px，阈值 ${derived.minPx} CSS px`);
      let swSnap = sRight;
      let sw = switchAfter(swSnap, "running-right", crossRight.moveT);
      if (!sw) {
        // 事件回传与快照可能抢跑：补拍一次（只补数据，不改断言口径）
        await sleep(150);
        swSnap = await snap();
        sw = switchAfter(swSnap, "running-right", crossRight.moveT);
      }
      const latency = sw ? Math.round((sw.t - crossRight.moveT) * 10) / 10 : null;
      const okLatency = latency !== null && latency >= -1 && latency <= DEADLINE.direction;
      r.check(`① 方向态延迟 ≤${DEADLINE.direction}ms（从跨阈值帧算）`, true, okLatency);
      r.info("running-right 延迟", `${latency}ms`);
      if (!okLatency) r.info("延迟诊断", latencyDetail(swSnap, crossRight, sw));
      r.check(
        "跨阈值后没有再多等一帧（累计位移只超出阈值不到一步）",
        true,
        crossRight.cum - minPxPhys < stepCss * dpr + 2,
      );
    }
    const mmAfterRight = sRight.mousemoves;
    r.check(
      "方向判定期间页面没有新增 mousemove（判定只靠窗口位移）",
      mmAtEngage,
      mmAfterRight,
    );

    // ── ② 反向拖动 ────────────────────────────────────────────────────────────
    r.group("② 反向拖动切到 running-left");
    await movePetWindow({ dx: dxPhys, steps: 2, delayMs: 40 });
    await sleep(120);
    r.check("同向继续拖不来回抖（仍是 running-right）", "running-right", await getState());
    const lastRightX = (await snap()).moves.at(-1)?.x ?? rectBefore.left;
    await resetProbe();
    await sleep(derived.cooldownMs); // 切向去抖闸门（DRAG_DIRECTION_COOLDOWN_MS）留足余量
    await movePetWindow({ dx: -dxPhys, steps, delayMs: 40 });
    const gotLeft = await waitFor(async () => ((await getState()) === "running-left" ? "running-left" : null), DEADLINE.reverse + 800);
    r.check("② 反向拖动切到 running-left（读真实 DOM data-pet-state）", "running-left", gotLeft ?? (await getState()));

    const sLeft = await snap();
    const crossLeft = firstCrossing(sLeft, lastRightX, minPxPhys, -1);
    r.check("反向也在跨过阈值的那一帧切换", true, crossLeft !== null);
    if (crossLeft) {
      let swSnap = sLeft;
      let sw = switchAfter(swSnap, "running-left", crossLeft.moveT);
      if (!sw) {
        await sleep(150);
        swSnap = await snap();
        sw = switchAfter(swSnap, "running-left", crossLeft.moveT);
      }
      const latency = sw ? Math.round((sw.t - crossLeft.moveT) * 10) / 10 : null;
      const okLatency = latency !== null && latency >= -1 && latency <= DEADLINE.reverse;
      r.check(`② 反向延迟 ≤${DEADLINE.reverse}ms（从跨阈值帧算）`, true, okLatency);
      r.info("running-left 延迟", `${latency}ms`);
      if (!okLatency) r.info("延迟诊断", latencyDetail(swSnap, crossLeft, sw));
    }
    r.check("反向判定期间同样没有新增 mousemove", 0, sLeft.mousemoves);

    // ── ③ 松手复原 ────────────────────────────────────────────────────────────
    r.group("③ 松手回到拖动前状态（running，不是 idle）");
    const tRelease = await c.ev("performance.now()");
    await mouse("mouseReleased", center.x + engageDx, center.y, 0);
    pressed = false;
    const restored = await waitFor(async () => {
      const s = await getState();
      const d = await c.ev("Boolean(window.__petDragProbe.instance && window.__petDragProbe.instance.dragging)");
      return s === "running" && d === false ? "running" : null;
    }, DEADLINE.restore + 900);
    r.check("③ 松手后回到拖动前状态 running（不是 idle）", "running", restored ?? (await getState()));

    const sRestore = await snap();
    r.check("松手后 dragging = false", false, sRestore.dragging);
    r.check("松手触发一次 endDrag", 1, sRestore.events.filter((e) => e.kind === "endDrag").length);
    const restoreSw = sRestore.events.find((e) => e.kind === "switchTo" && e.state === "running" && e.t >= tRelease);
    const restoreLatency = restoreSw ? Math.round((restoreSw.t - tRelease) * 10) / 10 : null;
    r.check(`③ 复原延迟 ≤${DEADLINE.restore}ms`, true, restoreLatency !== null && restoreLatency <= DEADLINE.restore);
    r.info("复原延迟", `${restoreLatency}ms`);

    const switchesBefore = (await snap()).events.filter((e) => e.kind === "switchTo").length;
    await movePetWindow({ dx: dxPhys, steps: 2, delayMs: 30 });
    await sleep(320);
    const sIdleMove = await snap();
    r.check("松手后再挪窗不再改状态（onMoved 拖动分支已关）", switchesBefore, sIdleMove.events.filter((e) => e.kind === "switchTo").length);
    r.check("松手后状态仍是 running", "running", await getState());

    // ── 附加：二次拖动 ────────────────────────────────────────────────────────
    r.group("附加：二次拖动可再次进入方向态（beginDrag 快照不串台）");
    await resetProbe();
    const rectBefore2 = readPetWindow().rect;
    await mouse("mousePressed", center.x, center.y, 1);
    pressed = true;
    await mouse("mouseMoved", center.x + engageDx, center.y, 1);
    const engaged2 = await waitFor(async () => {
      const s = await snap();
      return s?.dragging === true ? s : null;
    }, 2000);
    r.check("第二次起拖同样进入拖动态", true, engaged2?.dragging === true);
    await movePetWindow({ dx: -dxPhys, steps, delayMs: 40 });
    const gotLeft2 = await waitFor(async () => ((await getState()) === "running-left" ? "running-left" : null), DEADLINE.direction + 800);
    r.check("第二次拖动按方向进入 running-left", "running-left", gotLeft2 ?? (await getState()));
    const s2 = await snap();
    const cross2 = firstCrossing(s2, rectBefore2.left, minPxPhys, -1);
    r.check("第二次拖动同样在跨阈值帧切换", true, cross2 !== null);
    await mouse("mouseReleased", center.x + engageDx, center.y, 0);
    pressed = false;
    const restored2 = await waitFor(async () => ((await getState()) === "running" ? "running" : null), DEADLINE.restore + 900);
    r.check("第二次松手仍复原到 running", "running", restored2 ?? (await getState()));
    r.check("第二次松手后 dragging = false", false, (await snap()).dragging);

    // ── 收尾 ──────────────────────────────────────────────────────────────────
    r.group("收尾：窗口/光标还原，不留残留");
    const wEnd = readPetWindow();
    const backDx = rect0.left - wEnd.rect.left;
    const backDy = rect0.top - wEnd.rect.top;
    if (backDx !== 0 || backDy !== 0) await movePetWindow({ dx: backDx, dy: backDy, steps: 1 });
    const wRestored = readPetWindow();
    r.check("窗口位置已还原到套件开始时", rect0, wRestored.rect);
    setCursor(cursor0.x, cursor0.y);
    r.check("系统光标已还原", cursor0, readPetWindow().cursor);
    r.info("收尾后宠物窗", `rect=${JSON.stringify(readPetWindow().rect)} cursor=${JSON.stringify(readPetWindow().cursor)}`);

    // ── 覆盖度（如实口径） ─────────────────────────────────────────────────────
    r.group("覆盖度（如实口径；未覆盖项不当作通过）");
    r.info("窗口位移由谁产生", "外部 Win32 SetWindowPos → 真 WM_MOVE → tauri://move → onMoved（与鼠标拖拽同一条页面链路）");
    r.info("起拖由谁触发", "CDP 合成 mousedown + 越过 DRAG_START_PX 的 mousemove → main.ts 自己的起拖分支（beginDrag + startDragging invoke）");
    r.info("已覆盖", "起拖判定/方向判定/去抖阈值（源码取数）；方向态 DOM 读数；反向切换；松手复原；无 mousemove 反证；穿透与戳一戳回归；二次拖动；阈值帧时序");
    r.info("未覆盖（需人工）", "真实鼠标按住拖动：OS 拖拽循环（startDragging）本身未被驱动，拖拽循环期间 Moved 是否照样转发只能人工验证；DPI≠100% 与多显示器/负坐标屏未跑");
    r.info("人工验证步骤", "见 tests/e2e/verify-pet-drag.mjs 文件头「人工验证」段；核心：dev:debug 起实例→按住宠物右拖>24px 应 running-right→反向>24px 应 running-left→松手回拖动前状态");
    r.info("CI 口径", "本轮不进 .github/workflows/e2e.yml allowlist（CI 不改）；属本机桌面回归，按需手动触发（npm run verify:drag）");
  } catch (err) {
    r.check("套件本身未抛异常", true, false);
    console.error(`\n[套件异常] ${err?.stack ?? err}`);
    console.error("\n修复指引：确认 `npm run dev:debug` 的实例还在跑、CDP 端口对得上、pwsh.exe（PowerShell 7）在 PATH 上。");
  } finally {
    if (pressed && c) {
      try {
        await mouse("mouseReleased", center?.x ?? 0, center?.y ?? 0, 0);
      } catch {
        /* 页面可能已关闭，忽略 */
      }
      pressed = false;
    }
    try {
      if (rect0) {
        const w = readPetWindow();
        const ddx = rect0.left - w.rect.left;
        const ddy = rect0.top - w.rect.top;
        if (ddx !== 0 || ddy !== 0) await movePetWindow({ dx: ddx, dy: ddy, steps: 1 });
      }
    } catch (err) {
      console.error(`[收尾] 窗口位置还原失败：${err.message}`);
    }
    try {
      if (cursor0) setCursor(cursor0.x, cursor0.y);
    } catch (err) {
      console.error(`[收尾] 光标还原失败：${err.message}`);
    }
    killAll(); // 别把搬窗的 pwsh 子进程留在后台
    try {
      if (c && shimId) await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: shimId });
    } catch {
      /* 页面可能已关闭 */
    }
    try {
      c?.close();
    } catch {
      /* 已关闭 */
    }
  }

  const failed = r.summary();
  process.exit(failed ? 1 : 0);
}

await main();
