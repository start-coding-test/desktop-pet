// 同意框探测、采样判定与等待（原 104-163 / 343-435 / 436-481 / 482-567 / 568-635）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { attach, listPages } from "../harness/cdp.mjs";
import { DENY_LOCK_SETTLE_MS, OBSERVE_MS, PORT, sleep } from "./env.mjs";

function consentBoxBelongsTo(name, wantId) {
  if (!wantId) return true;
  const escaped = wantId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?![A-Za-z0-9._-])`).test(String(name ?? ""));
}

async function driveConsent(how, wantId = "", waitCaps = null) {
  const deadline = Date.now() + 20_000;
  let others = 0;
  /** D09-D9 A：读不到的页数。跳过它继续轮询到 20 秒，绝不把「读不到」当成「没有框」。 */
  let unreadable = 0;
  let lastAttachError = "";
  /** 扫到过的框标题（去重）：失败时原文带出去，用来区分「框根本没开」和「开的是别人的框」 */
  const seenTitles = [];
  while (Date.now() < deadline) {
    const pages = (await listPages(PORT).catch(() => [])).filter((t) => /consent/.test(t.url));
    for (const target of pages) {
      const { cs, unreadable: miss, error } = await attachListedPage(target);
      if (!cs) {
        unreadable += miss;
        lastAttachError = String(error ?? "").split("\n")[0];
        continue;
      }
      try {
        const name = await cs.ev(`document.getElementById('plugin-name')?.textContent ?? ''`);
        if (!seenTitles.includes(name)) seenTitles.push(name);
        if (!consentBoxBelongsTo(name, wantId)) {
          others += 1;
          continue;
        }
        const seen = {
          caps: await cs.ev(`[...document.querySelectorAll('#cap-list li')].map(li => li.textContent)`),
          name,
          label: await cs.ev(`window.__TAURI_INTERNALS__.metadata.currentWindow.label`),
          seenTitles: [...seenTitles],
        };
        // 追加能力走 400ms 轮询；等页面把并集重绘完再作答。
        if (waitCaps && !waitCaps.every((cap) => seen.caps.includes(cap))) {
          continue;
        }
        if (how === "allow") {
          await cs.ev(`document.getElementById('btn-allow').click()`);
        } else if (how === "deny") {
          await cs.ev(`document.getElementById('btn-deny').click()`);
        } else {
          await cs.ev(
            `(() => { window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: ${JSON.stringify(seen.label)} }); return true; })()`,
          );
        }
        return seen;
      } finally {
        cs.close();
      }
    }
    await sleep(400);
  }
  throw new Error(
    `20 秒内没等到 ${wantId ? `「${wantId}」的` : ""}同意框（场上扫到的框标题：[${seenTitles.join(" | ") || "一个都没有"}]，按名字跳过没点 ${others} 个，attach 读不到 ${unreadable} 页${lastAttachError ? `，最后一次原文：${lastAttachError}` : ""}）`,
  );
}
const ATTACH_FAILURES = [
  /CDP websocket 连接失败/,
  /等不到匹配的 target/,
  /CDP (?:Runtime|Log)\.enable 超时 \d+ms/,
];
function isAttachFailure(err) {
  const msg = String(err?.message ?? err ?? "");
  return ATTACH_FAILURES.some((re) => re.test(msg));
}

/** 按「已列出来的那一页」attach；attach 类失败折成 `{ cs: null, unreadable: 1 }`，其他异常外抛。 */
async function attachListedPage(target, timeoutMs = 8_000) {
  try {
    return {
      cs: await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, timeoutMs),
      unreadable: 0,
      error: null,
    };
  } catch (err) {
    if (!isAttachFailure(err)) throw err;
    return { cs: null, unreadable: 1, error: String(err?.message ?? err) };
  }
}

/**
 * D09-D9 B：把「每个样本可能带读不到的页」的采样序列折成判定。
 * `unreadable > 0` 的样本是**未确认**：既不算「一扇窗也没有」也不算「数到了几扇」，不进 `every`。
 * 有效样本必须**不少于总样本的一半**（`valid * 2 >= total`，整数等价为向上取整，比一半更严不差），
 * 不够就 `state = SKIPPED-<n>` —— 调用方据此具名红，绝不拿「剩下那条碰巧对」当成立。
 * `want === 0`（断言「不该有窗」）时不要求「至少一次非 0」，那条只服务数窗判据。
 * 纯函数；被 `noConsentThroughout` 与 `sampleConsentCounts` 真实调用，并由套件尾部自测证伪。
 */
function tallySamples(samples, want) {
  const total = samples.length;
  const unreadable = samples.reduce((n, s) => n + (s.unreadable > 0 ? 1 : 0), 0);
  const valid = samples.filter((s) => s.unreadable === 0).map((s) => s.count);
  const enough = total > 0 && valid.length * 2 >= total;
  const matched = valid.length > 0 && valid.every((n) => n === want) && (want === 0 || valid.some((n) => n > 0));
  const state = !enough ? `SKIPPED-${unreadable}` : matched ? "成立" : "不成立";
  return { total, unreadable, valid, enough, matched, ok: enough && matched, state };
}

/** 只列出同意框页（归属仍要逐页读标题才算，这里只是粗筛，少几倍 CDP 往返）。 */
async function consentTargets() {
  return (await listPages(PORT).catch(() => [])).filter((t) => /consent/.test(t.url));
}

/**
 * 判据实际值的统一形状：成立时仍是 `true`（各站期望值一字不动），不成立时把判定串当实际值带出去 ——
 * `r.check` 失败行会原文打印它，所以「不成立 / SKIPPED-n / 窗没出现」和不可读页数直接进失败清单。
 */
const consentVerdict = (res) => (res.ok ? true : `${res.state}（不可读页 ${res.unreadable}）`);

const attachToTarget = (t) => attach(PORT, (x) => x.webSocketDebuggerUrl === t.webSocketDebuggerUrl, 8_000);

/**
 * 逐页读同意框的底座：属于 `pluginId` 的收进 `windows`，attach 不起来的计 `unreadable` 并跳过该页。
 * `connect` 只为自测注入「必然读不到的一页」而存在（实跑一律 `attachToTarget`）——
 * 自测用手写真 `attach()` 失败，而不是手写一条错误文案冒充失败，否则测的是我自己的字符串。
 * `deep` 才读能力表与窗口 label（数窗、并集判定用）。
 */
async function readConsentPages(pluginId, deep, targets, connect) {
  const windows = [];
  let unreadable = 0;
  let lastError = "";
  for (const target of targets) {
    let cs = null;
    try {
      cs = await connect(target);
    } catch (err) {
      if (!isAttachFailure(err)) throw err;
      unreadable += 1;
      lastError = String(err?.message ?? err).split("\n")[0];
      continue;
    }
    try {
      const name = await cs.ev(`document.getElementById('plugin-name')?.textContent ?? ''`);
      if (!consentBoxBelongsTo(name, pluginId)) continue;
      windows.push(
        deep
          ? {
              name,
              caps: await cs.ev(`[...document.querySelectorAll('#cap-list li')].map(li => li.textContent)`),
              label: await cs.ev(`window.__TAURI_INTERNALS__.metadata.currentWindow.label`),
            }
          : { name },
      );
    } finally {
      cs.close();
    }
  }
  return { windows, unreadable, lastError };
}

/**
 * D09 W-1：「这一轮扫描有没有看到该插件的同意框」的样本序列 → 「整个观察期内都没出现」吗。
 * 空数组按「没观察 = 没证据」判不成立。纯函数，被 `waitNoConsent` 真实调用，
 * 并由套件尾部的两条自测判据证伪（D09-D1 第 4 条：不许只测一个没人用的函数）。
 */
function absentThrough(samples) {
  return samples.length > 0 && samples.every((found) => !found);
}

/** 一轮扫描：该插件的窗数 + 这一轮有多少页读不到（`unreadable > 0` ⇒ 这一轮证明不了任何事）。 */
async function scanConsent(pluginId) {
  const { windows, unreadable } = await readConsentPages(pluginId, false, await consentTargets(), attachToTarget);
  return { count: windows.length, found: windows.length > 0, unreadable };
}

/** 属于该插件的同意框清单（label + 窗口里列出的能力），用于数窗与并集判定；附本轮不可读页数。 */
async function consentWindowsFor(pluginId) {
  return readConsentPages(pluginId, true, await consentTargets(), attachToTarget);
}

/**
 * 「等窗消失」的有界等待（前置、判据5前置、判据6、resetConsent 都走这条）。
 * 语义**保持**「最新一次扫描没有窗即成立」—— 窗本来就是先开后关的，改成累计观察会把这几处判反
 * （D09-D1 第 5 条）。判定仍然过一遍 `absentThrough`（第 4 条）。
 * D09-D9 C：本轮有页读不到时按**仍存在**处理（读不到不等于消失了），继续轮询到原超时。
 */
async function waitNoConsent(pluginId, timeoutMs = 2_000) {
  return (await waitNoConsentProbe(pluginId, timeoutMs)).gone;
}

/** `waitNoConsent` 的取证版本：把「等了几轮、有几轮读不到页」带出来，红时写进 detail。 */
async function waitNoConsentProbe(pluginId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  const scans = [];
  for (;;) {
    const { found, unreadable } = await scanConsent(pluginId);
    scans.push({ found, unreadable });
    const gone = absentThrough([found]) && unreadable === 0;
    if (gone) return { gone, unreadable, scans };
    if (Date.now() >= deadline) {
      return { gone: false, unreadable: scans.reduce((n, s) => n + s.unreadable, 0), scans };
    }
    await sleep(200);
  }
}

/**
 * 「不该出现窗」的用法（D09 W-1 新增）：连续采样满 `OBSERVE_MS`，任何一次看到窗就判 false。
 * 原来 `waitNoConsent` 是扫到第一次没有就返回 true 的瞬时快照 —— 去掉拒绝锁时开窗是几百毫秒后的事，
 * 那种写法抓不到，判据不可证伪。这里才是「观察期内始终没有」的判定。
 * D09-D9 B：带不可读页的样本是**未确认**（`tallySamples`），有效样本不到一半 ⇒ `SKIPPED-n`，
 * 两种都让 `ok=false` —— 调用方的期望值仍是 `true`，红时 detail 里带着是哪种。
 */
async function noConsentThroughout(pluginId, observeMs = OBSERVE_MS) {
  const samples = [];
  const until = Date.now() + observeMs;
  for (;;) {
    samples.push(await scanConsent(pluginId));
    if (samples.some((s) => s.found)) break;
    if (Date.now() >= until) break;
    await sleep(200);
  }
  const verdict = tallySamples(samples, 0);
  return {
    ok: verdict.ok,
    state: verdict.state,
    unreadable: verdict.unreadable,
    counts: samples.map((s) => s.count),
    samples,
  };
}

/**
 * D09 W-2：连续采样「这个插件到底几扇窗」，判定要求**每个有效样本都恰为 want 且至少一次非 0**。
 * 单次快照会让「第二扇窗晚开」的变异（合流键退回 req_id）因时序而存活 —— 和 W-1 是同一个毛病。
 * 先有界地等第一扇出现（这是等窗出现，不是观察期），再连续采满 `observeMs`。
 * 返回值带 `counts` 原文，红的时候能把采样序列贴出来；`unreadable` 是本轮所有采样里读不到的页数合计。
 */
async function sampleConsentCounts(pluginId, want, observeMs = OBSERVE_MS, firstWaitMs = 10_000) {
  const waited = [];
  const samples = [];
  let unreadableTotal = 0;
  let last = [];
  let lastUnreadable = 0;
  const untilFirst = Date.now() + firstWaitMs;
  for (;;) {
    const scan = await consentWindowsFor(pluginId);
    waited.push({ count: scan.windows.length, unreadable: scan.unreadable });
    unreadableTotal += scan.unreadable;
    last = scan.windows;
    lastUnreadable = scan.unreadable;
    if (last.length > 0) break;
    if (Date.now() >= untilFirst) {
      // 第一扇窗始终没出现：判定不能拿这个当「数到了 0 扇 ⇒ 合流正确」，调用方必须先具名红一次
      return {
        appeared: false,
        ok: false,
        state: "窗没出现",
        waited,
        samples,
        counts: [],
        unreadable: unreadableTotal,
        last,
      };
    }
    await sleep(200);
  }
  const until = Date.now() + observeMs;
  for (;;) {
    samples.push({ count: last.length, unreadable: lastUnreadable });
    if (Date.now() >= until) break;
    await sleep(200);
    const scan = await consentWindowsFor(pluginId);
    unreadableTotal += scan.unreadable;
    last = scan.windows;
    lastUnreadable = scan.unreadable;
  }
  // D09-D4 类 2：判定只吃**观察期**样本。等第一扇出现那几轮必然是 0（窗是异步建的），
  // 把它们算进 every() 会让这条结构必红 —— 第一轮就是这么红的（counts 原文 [0,0,1,1,…]）。
  const verdict = tallySamples(samples, want);
  return {
    appeared: true,
    ok: verdict.ok,
    state: verdict.state,
    waited,
    samples,
    counts: samples.map((s) => s.count),
    unreadable: unreadableTotal,
    last,
  };
}

/**
 * D09 W-1：让「该立刻返回 false」的请求在 `ms` 内落地，超时给哨兵而不是静默等满 CDP 的 20 秒。
 * 超时也必须 `clearTimeout`，否则挂着的定时器会在后续轮里迟到 resolve，污染下一个用例。
 */
const CONSENT_NOT_SETTLED = "__consent_not_settled__";
function settledWithin(promise, ms = DENY_LOCK_SETTLE_MS) {
  let timer = null;
  const sentinel = new Promise((resolve) => {
    timer = setTimeout(() => resolve(CONSENT_NOT_SETTLED), ms);
  });
  const raced = Promise.race([Promise.resolve(promise), sentinel]);
  return raced.then(
    (value) => {
      clearTimeout(timer);
      return value;
    },
    (err) => {
      clearTimeout(timer);
      throw err;
    },
  );
}

/**
 * 只读一扇同意框（不点按钮），用于停用关窗用例；调用方负责关闭返回的 client。
 * D09-D9 C：读不到的页**跳过并继续轮询** —— 不可读页不能用来判「窗出现了」，
 * 也不能让它把整组带走；到点仍没等到就照原样抛，但把「有几页读不到、最后一次是哪句原文」带上。
 * `listTargets` / `attachPage` 只为 A26 自测注入「永远读不到」的假页；实跑一律用默认值。
 */
async function waitConsentWindow(
  pluginId,
  timeoutMs = 20_000,
  { listTargets = consentTargets, attachPage = attachListedPage } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let unreadable = 0;
  let lastError = "";
  while (Date.now() < deadline) {
    for (const target of await listTargets()) {
      const { cs, unreadable: miss, error } = await attachPage(target);
      if (!cs) {
        unreadable += miss;
        lastError = String(error ?? "").split("\n")[0];
        continue;
      }
      let keep = false;
      try {
        const name = await cs.ev(`document.getElementById('plugin-name')?.textContent ?? ''`);
        if (!consentBoxBelongsTo(name, pluginId)) continue;
        const out = {
          caps: await cs.ev(`[...document.querySelectorAll('#cap-list li')].map(li => li.textContent)`),
          name,
          label: await cs.ev(`window.__TAURI_INTERNALS__.metadata.currentWindow.label`),
          cs,
        };
        keep = true;
        return out;
      } finally {
        if (!keep) cs.close();
      }
    }
    await sleep(200);
  }
  throw new Error(
    `${timeoutMs / 1000} 秒内没等到「${pluginId}」的同意框（只读；attach 读不到 ${unreadable} 页${lastError ? `，最后一次原文：${lastError}` : ""}）`,
  );
}

export { consentBoxBelongsTo, driveConsent, ATTACH_FAILURES, isAttachFailure, attachListedPage, tallySamples, consentTargets, consentVerdict, attachToTarget, readConsentPages, absentThrough, scanConsent, consentWindowsFor, waitNoConsent, waitNoConsentProbe, noConsentThroughout, sampleConsentCounts, CONSENT_NOT_SETTLED, settledWithin, waitConsentWindow };
