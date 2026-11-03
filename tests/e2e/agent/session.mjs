// emitPhase、同意框应答泵与会话状态（原 100-104 / 111-158）
// 由 tests/e2e/verify-agent-bridge.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { attach, listPages } from "../harness/cdp.mjs";
import { INBOX, PORT, sleep } from "./env.mjs";

function emitPhase(phase, payload = {}) {
  const line = JSON.stringify({ phase, at: Date.now(), payload: { session_id: "verify-sess", ...payload } });
  appendFileSync(join(INBOX, `${phase}.jsonl`), line + "\n");
  return line;
}
function makeConsentPump(seen) {
  let stopped = false;
  const run = async (deadlineMs) => {
    const until = Date.now() + deadlineMs;
    while (!stopped && Date.now() < until) {
      const target = (await listPages(PORT).catch(() => []))
        .find((t) => /consent/.test(t.url));
      if (!target) {
        await sleep(250);
        continue;
      }
      // 单个框没答上不致命，但绝不能让异常把整个应答循环带走：
      // 一旦没人答后续对话框，宿主 60 秒超时就会把它们全判成「用户拒绝」，
      // 表现为偶发的「零噪音」红，而且红在离根因很远的断言上。
      try {
        const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000);
        try {
          // **窗口出现在列表里 ≠ 已渲出内容**：同意框要等 `consent_details` 回来才填
          // `#plugin-name` 与 `#cap-list`（`src/consent/main.ts:17` 之后才是同步的渲染 + 挂监听）。
          // 抢在渲染前读会记下 `{who:'', caps:[]}` 这条假证据，而紧跟的 click 在监听器挂上之前是空操作；
          // 一旦渲染恰好落在"读完、点下去"之间，这扇框就被应答掉而账上没有任何内容 ——
          // 「探针首次调用弹出的同意框列出了 agent:hooks」的偶发红（三轮一次）就是这么来的。
          // 反过来，读到 `li` 存在就说明那段同步尾巴已经跑完（填内容与挂监听之间没有 await），
          // 所以「渲出了」是「点了会生效」的可靠前置条件。
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
          if (!rendered) console.log("  · 同意框 4 秒内没渲出内容，仍按原样应答（这条记账不算证据）");
          seen.push({ who, caps, rendered });
          await cs.ev(`document.getElementById('btn-allow').click()`);
        } finally {
          cs.close();
        }
      } catch (e) {
        console.log(`  · 同意框应答失败，重试：${String(e).slice(0, 80)}`);
      }
      await sleep(300);
    }
  };
  return { run, stop: () => (stopped = true) };
}

// 本跑的状态槽：原文散在模块级的有状态变量全部搬到这里，赋值时机不变
// （settings 仍是「用到才唤出设置窗」的惰性创建；pumpDone / legacySeed 仍是本跑内赋值）。
export function createSession({ report }) {
  const state = {
    r: report,
    c: null,
    settings: null,
    origEnabled: [],
    pumpDone: null,
    legacySeed: null,
    petHidden: false,
    hrTempEnabled: false,
    grantedCaps: [],
    consentPump: null,
    invoke: null,
    token: null,
    lastView: null,
    overlayLabelFor: null,
    OVERLAY_LABEL: null,
    withOverlayPageFor: null,
    agentInOverlayTable: null,
    overlayPagePresent: null,
    seededBytes: null,
    acts: null,
    said: null,
    statusLog: null,
    ourLastLine: null,
    ourStatusCalls: null,
    bubbleNow: null,
    bubbleVsOurs: null,
    waitStatusSlot: null,
    restartPlugin: null,
    awaitGranted: null,
    ourTail: null,
    waitOurClear: null,
    stripComments: null,
    recExpr: null,
    stateExpr: null,
    clickShadow: null,
    statusText: null,
    TEMP_ROOT: null,
    underTemp: null,
    ZHOME: null,
    zhomeOk: null,
  };
  state.consentPump = makeConsentPump(state.grantedCaps);
  return state;
}

export { emitPhase };
