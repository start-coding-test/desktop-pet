// 会话状态与有状态 helper（原 207-221 / 225-236 / 263-269 / 303-332 / 865-937）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSettingsInvoker, readEnabledIds, waitUntil, writeEnabledIds } from "../harness/cdp.mjs";
import { PROBE_ID } from "../harness/fixtures.mjs";
import { driveConsent } from "./consent.mjs";
import { PLUGINS_DIR, PORT, RESET_CHANGE_SPY, RUNTIME_REPORT_SITE, invoke, runtimeNoiseMatches, sawChangedId, sleep } from "./env.mjs";

/**
 * 把有状态的 helper 绑到一个 state 上：原文里这些函数读写的模块级 let
 * （c / settings / probeRuntimeWritesAllowed / consoleLedgerMark）现在都读写 state 字段，
 * 因此赋值时机与拆分前一致（settings 仍是「用到才唤出设置窗」的惰性创建）。
 */
export function bindSession(state) {
  const r = state.r;
  function consoleWindow(start, ids) {
    return (state.c?.noise ?? []).slice(start).filter((n) => runtimeNoiseMatches(n, ids));
  }

  /** D07 C6：等窗口里出现预期的 console 条目；用 CDP 事件做信号，不靠固定 sleep。 */
  async function waitConsoleWindow(start, ids, predicate, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entries = consoleWindow(start, ids);
      if (predicate(entries)) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await state.c.once("Runtime.consoleAPICalled", Math.min(left, 5_000)).catch(() => undefined);
    }
  }
  function logConsoleLedger(label) {
    const noise = state.c?.noise ?? [];
    const since = noise.slice(state.consoleLedgerMark);
    const matched = (arr, id) =>
      arr.filter((n) => n.includes(id) && (RUNTIME_REPORT_SITE.test(n) || n.includes("bus relay failed")));
    const ids = ["zz.probe", "zz.consent", "zz.status"];
    const totals = Object.fromEntries(ids.map((id) => [id, matched(noise, id).length]));
    const deltas = Object.fromEntries(ids.map((id) => [id, matched(since, id).length]));
    const deltaLines = Object.fromEntries(ids.map((id) => [id, matched(since, id)]));
    r.info(`D07 console ledger ${label}`, JSON.stringify({ totals, deltas, deltaLines }));
    state.consoleLedgerMark = noise.length;
  }
  const armPageReload = async (timeoutMs = 8_000) => {
    await state.c.send("Page.enable");
    return state.c.once("Page.loadEventFired", timeoutMs).then(
      () => true,
      () => false,
    );
  };
  function assertProbeRuntimeWritesAllowed(where) {
    if (!state.probeRuntimeWritesAllowed) throw new Error(`D07 ${where}: 窗口 A 前禁止运行时改写 zz.probe manifest`);
  }
  async function revoke(pluginId) {
    if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c);
    return state.settings.invoke("permission_revoke", { pluginId });
  }
  async function setEnabled(ids) {
    if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c);
    return writeEnabledIds(state.settings.invoke, ids);
  }
  async function enableForConsent(pluginId) {
    const before = await readEnabledIds(invoke(state.c));
    const without = before.filter((id) => id !== pluginId);
    await setEnabled(without);
    await setEnabled([...without, pluginId]);
    return async () => setEnabled(before);
  }
  async function grantProbeCap(capability, pluginId = PROBE_ID) {
    const manifestPath = join(PLUGINS_DIR, pluginId, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.permissions?.includes(capability)) {
      if (!state.probeRuntimeWritesAllowed) {
        throw new Error(`D07 预置 ${pluginId} 缺能力 ${capability}，窗口 A 前禁止运行时改写 manifest`);
      }
      // D07-D10：写 manifest 前先确保插件 disabled；写后等 plugins-changed 信号，
      // 再显式 await reconcile 并读回 isActive=false，之后才 enable。
      const enabledNow = await readEnabledIds(invoke(state.c));
      if (enabledNow.includes(pluginId)) {
        await setEnabled(enabledNow.filter((id) => id !== pluginId));
        await state.c.ev(`(async () => {
          const rt = await import('/src/runtime/plugin-runtime.ts');
          await rt.reconcile(await window.__TAURI_INTERNALS__.invoke('plugins_list'));
          return true;
        })()`);
        await waitUntil(
          state.c,
          `(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); return rt.isActive(${JSON.stringify(pluginId)}) === false; })()`,
          10_000,
        );
      }
      await state.c.ev(RESET_CHANGE_SPY);
      writeFileSync(
        manifestPath,
        JSON.stringify({ ...manifest, permissions: [...(manifest.permissions ?? []), capability] }, null, 2),
      );
      const sawChange = await waitUntil(state.c, sawChangedId(pluginId), 10_000);
      await state.c.ev(`(async () => {
        const rt = await import('/src/runtime/plugin-runtime.ts');
        await rt.reconcile(await window.__TAURI_INTERNALS__.invoke('plugins_list'));
        return true;
      })()`);
      const inactive = await waitUntil(
        state.c,
        `(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); return rt.isActive(${JSON.stringify(pluginId)}) === false; })()`,
        10_000,
      );
      if (!sawChange || !inactive) {
        throw new Error(`D07 ${pluginId} manifest 写入后 reconcile 未静默（sawChange=${sawChange}, inactive=${inactive}）`);
      }
    }
    // 旧接缝是「未启用也能直接要授权」；D02 起宿主先看启停清单，这里临时启用探针，
    // 只写清单不 reconcile，避免激活期批量授权污染这一条能力的窗口。
    const restore = await enableForConsent(pluginId);
    try {
      const checked = await invoke(state.c)("permission_check", { pluginId, capability });
      if (checked.ok && checked.v === true) return true; // 已授权时 permission_request 不弹框，别空等
      // 不等 permission_request 的返回：它会阻塞到用户作答，而 CDP 的 Runtime.evaluate 有 20 秒硬超时
      // （见 cdp.mjs::send），弹框慢一点就会把整条断言链打断。改成应答之后轮询授权表。
      invoke(state.c)("permission_request", {
        pluginId,
        capabilities: [capability],
      }).catch(() => undefined);
      try {
        const consent = await driveConsent("allow", pluginId);
        r.check(`同意框列出了 ${capability}`, true, consent.caps.includes(capability));
      } catch (err) {
        console.log(`     没能操作 ${capability} 的同意框: ` + String(err?.message ?? err).split("\n")[0]);
        return false;
      }
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        const now = await invoke(state.c)("permission_check", { pluginId, capability });
        if (now.ok && now.v === true) return true;
        await sleep(400);
      }
      return false;
    } finally {
      await restore();
    }
  }

  state.consoleWindow = consoleWindow;
  state.waitConsoleWindow = waitConsoleWindow;
  state.logConsoleLedger = logConsoleLedger;
  state.armPageReload = armPageReload;
  state.assertProbeRuntimeWritesAllowed = assertProbeRuntimeWritesAllowed;
  state.revoke = revoke;
  state.setEnabled = setEnabled;
  state.enableForConsent = enableForConsent;
  state.grantProbeCap = grantProbeCap;
}

export function createSession({ report }) {
  const state = {
    r: report,
    c: null,
    settings: null,
    aborted: false,
    probeRuntimeWritesAllowed: false,
    consoleLedgerMark: 0,
    invoke_: null,
    INSTALL: null,
    bare: null,
    prevEnabled: null,
    call: null,
    sCall: null,
    sc: null,
    b3WindowStart: null,
  };
  bindSession(state);
  return state;
}
