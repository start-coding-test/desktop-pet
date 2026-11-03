// A26 假 CDP 端点与 attach 握手自测（原 637-857）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { attach } from "../harness/cdp.mjs";
import { consentVerdict, isAttachFailure, readConsentPages, tallySamples, waitConsentWindow } from "./consent.mjs";

// ---- A26：握手超时（Runtime.enable / Log.enable）的假 CDP 端点与自测 ----
// 零依赖手搓（harness 不带 ws 库）：只服务自测，只监听 127.0.0.1 临时端口，不连应用。
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsAccept(key) {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/** 服务端 → 客户端文本帧（无需掩码；自测消息都短于 65536）。 */
function wsTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  return Buffer.concat([Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]), payload]);
}

/** 从缓冲里摘一帧（客户端帧必有掩码）；不够一帧返回 null，等下次 data。 */
function takeWsFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, text: payload.toString("utf8"), rest: buf.subarray(off + maskLen + len) };
}

/**
 * A26 自测用假 CDP 端点：`/json/list` 列一页 consent target；WS 握手后只应答 `answerIds`
 * 里的命令 id，其余一律静默 —— 超时由 `cdp.mjs::send` 自己按 20s（或调用方传入的短超时）抛出。
 * `[1]` 复现生产同形：attach 的 Runtime.enable 有应答（id=1）、Log.enable 静默（id=2）。
 * `[1, 2]` 让 attach 成功，之后的命令（id≥3）静默，用来产生真求值/重复握手超时。
 */
async function startFakeCdp(answerIds) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url !== "/json/list") {
      res.statusCode = 404;
      res.end();
      return;
    }
    const port = server.address().port;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify([
        {
          type: "page",
          url: `http://127.0.0.1:${port}/src/consent.html`,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/selftest`,
        },
      ]),
    );
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAccept(req.headers["sec-websocket-key"])}\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = takeWsFrame(buf);
        if (!frame) return;
        buf = frame.rest;
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode !== 0x1) continue;
        let msg;
        try {
          msg = JSON.parse(frame.text);
        } catch {
          continue;
        }
        if (answerIds.includes(msg.id)) socket.write(wsTextFrame(JSON.stringify({ id: msg.id, result: {} })));
      }
    });
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((res) => server.close(res));
    },
  };
}

/**
 * A26 自测：握手命令的 CDP 超时只折进「读不到页」，求值/导航/输入超时照旧外抛；
 * 到点仍读不到仍是红。`withAttach` 的 20s attach 级复现只在 `--attach-selftest` 开，
 * 主套件跑快变体（三条 800ms 真超时）。
 */
async function runAttachHandshakeSelfTest(rep, { withAttach = false } = {}) {
  const selftestId = "zz.a26-selftest";
  const fakeTarget = {
    url: "http://127.0.0.1/selftest/consent.html",
    webSocketDebuggerUrl: "ws://127.0.0.1/selftest",
  };
  const endpoints = [];
  try {
    // ① 快变体：attach 成功后的命令超时（真 send/ev；800ms 只缩短等待，不改任何被测逻辑）
    const both = await startFakeCdp([1, 2]);
    endpoints.push(both);
    const client = await attach(both.port, () => true, 5_000);
    let runtimeErr = null;
    let logErr = null;
    let evalErr = null;
    try {
      runtimeErr = await client.send("Runtime.enable", {}, 800).then(() => null, (e) => e);
      logErr = await client.send("Log.enable", {}, 800).then(() => null, (e) => e);
      evalErr = await client.ev("1", 800).then(() => null, (e) => e);
    } finally {
      client.close();
    }
    rep.check(
      "自测：握手超时文案是 cdp.mjs 原文（含括号提示）",
      "true|true",
      [
        String(runtimeErr?.message ?? "") === "CDP Runtime.enable 超时 800ms（调试端点可能已失去响应，重启 dev 实例再试）",
        String(logErr?.message ?? "") === "CDP Log.enable 超时 800ms（调试端点可能已失去响应，重启 dev 实例再试）",
      ].join("|"),
    );
    rep.check(
      "自测：两条握手超时被认作 attach 失败（不再外抛带走整组）",
      "true|true",
      `${isAttachFailure(runtimeErr)}|${isAttachFailure(logErr)}`,
    );

    // ② 生产同形（仅 --attach-selftest）：真 attach 等 Log.enable 满 20s
    if (withAttach) {
      const runtimeOnly = await startFakeCdp([1]);
      endpoints.push(runtimeOnly);
      const attachErr = await attach(runtimeOnly.port, () => true, 5_000).then(() => null, (e) => e);
      rep.check(
        "自测：attach 级握手超时是真 CDP Log.enable 超时（20s，含括号提示）",
        true,
        String(attachErr?.message ?? "") === "CDP Log.enable 超时 20000ms（调试端点可能已失去响应，重启 dev 实例再试）",
      );
      rep.check("自测：attach 级握手超时同样被认作 attach 失败", true, isAttachFailure(attachErr));
    }

    // ③ 握手超时折成 unreadable、不抛；全读不到仍是「未确认」而非「无窗」
    const scanRes = await readConsentPages(selftestId, false, [fakeTarget], () => Promise.reject(logErr)).then(
      (value) => ({ ok: true, value }),
      (err) => ({ ok: false, err }),
    );
    rep.check(
      "自测：握手超时折成 unreadable=1，readConsentPages 不抛错",
      "true|1",
      `${scanRes.ok}|${scanRes.ok ? scanRes.value.unreadable : "抛错"}`,
    );
    const verdict = tallySamples(
      [{ count: scanRes.ok ? scanRes.value.windows.length : 0, unreadable: scanRes.ok ? scanRes.value.unreadable : 0 }],
      0,
    );
    rep.check(
      "自测：全读不到时「无窗」判未确认（SKIPPED-1），ok=false —— 不得变绿",
      "SKIPPED-1|false|true",
      `${verdict.state}|${verdict.ok}|${consentVerdict(verdict) !== true}`,
    );

    // ④ 反向对照：真 Runtime.evaluate 超时不许被折，也不许被宽模式吞
    const rethrown = await readConsentPages(selftestId, false, [fakeTarget], () => {
      throw evalErr;
    }).then(
      () => null,
      (err) => err,
    );
    rep.check("自测：求值超时不被折叠，readConsentPages 原样外抛", true, rethrown === evalErr);
    rep.check(
      "自测：握手白名单不认求值/导航/输入类超时",
      "false|false|false",
      [
        isAttachFailure(evalErr),
        isAttachFailure(new Error("CDP Page.navigate 超时 20000ms（调试端点可能已失去响应，重启 dev 实例再试）")),
        isAttachFailure(new Error("CDP Input.dispatchMouseEvent 超时 20000ms（调试端点可能已失去响应，重启 dev 实例再试）")),
      ].join("|"),
    );

    // ⑤ 到点仍读不到：waitConsentWindow 注入探针照原样抛，带页数与最后一次原文
    const timedOut = await waitConsentWindow(selftestId, 300, {
      listTargets: async () => [fakeTarget],
      attachPage: async () => ({ cs: null, unreadable: 1, error: String(logErr?.message ?? "").split("\n")[0] }),
    }).then(
      () => null,
      (err) => err,
    );
    const timeoutText = String(timedOut?.message ?? "");
    rep.check(
      "自测：到点仍读不到 → waitConsentWindow 照原样红（带读不到页数与最后一次原文）",
      true,
      /秒内没等到/.test(timeoutText) &&
        /attach 读不到 [1-9]\d* 页/.test(timeoutText) &&
        timeoutText.includes("CDP Log.enable 超时 800ms"),
    );
  } finally {
    for (const endpoint of endpoints) await endpoint.close();
  }
}

export { WS_GUID, wsAccept, wsTextFrame, takeWsFrame, startFakeCdp, runAttachHandshakeSelfTest };
