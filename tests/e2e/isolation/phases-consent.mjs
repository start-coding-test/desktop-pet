// 同意框收口、ADR-0013 与窗口 D/E（原 3553-4007）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { attach, openSettingsInvoker, readEnabledIds, waitUntil } from "../harness/cdp.mjs";
import { PRESEED_CONSENT_ID, PRESEED_HOOK_UNDECLARED_ID } from "../harness/fixtures.mjs";
import { CONSENT_NOT_SETTLED, absentThrough, attachToTarget, consentTargets, consentVerdict, driveConsent, isAttachFailure, noConsentThroughout, readConsentPages, sampleConsentCounts, settledWithin, tallySamples, waitConsentWindow, waitNoConsent, waitNoConsentProbe } from "./consent.mjs";
import { DENY_TEXT, PORT, STOP_TEXT, invoke, runtimeNoiseMatches } from "./env.mjs";
import { runAttachHandshakeSelfTest } from "./fake-cdp.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseConsent(state) {
  const r = state.r;
  const { consoleWindow, enableForConsent, logConsoleLedger, setEnabled, waitConsoleWindow } = state;
  r.group("ADR-0013：同意合流 / 拒绝锁 / 未启用门禁");
  const adrWindowStart = (state.c.noise ?? []).length;
  const CONSENT_ID = PRESEED_CONSENT_ID;
  const askConsent = (caps) => invoke(state.c)("permission_request", { pluginId: CONSENT_ID, capabilities: caps });
  const checkConsent = async (cap) => {
    const res = await invoke(state.c)("permission_check", { pluginId: CONSENT_ID, capability: cap });
    return res.ok && res.v === true;
  };
  const resetConsent = async () => {
    if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c);
    await state.settings.invoke("permission_revoke", { pluginId: CONSENT_ID }).catch(() => undefined);
    const restore = await enableForConsent(CONSENT_ID);
    // 清锁/取消旧 pending 后，旧窗销毁是异步尾巴；先等场上没有本插件的窗再开始下一段。
    await waitNoConsent(CONSENT_ID, 10_000);
    return restore;
  };

  // D09 W-1：先自证这两个 helper 判得出「有没有窗」—— 否则后面所有「无窗」判据都可能只是在测一个瞎的函数。
  // 纯函数直接喂构造样本：中间出现过窗必须判 false；一个样本都没有按「没证据」判 false。
  r.check("自测：absentThrough 要能抓到序列里出现过的窗", false, absentThrough([false, true, false]));
  // D09-D4 第 6 条：console 切片此前只认 `plugin-runtime.ts:166`，对未捕获的 worker RPC 形状是盲的
  // （D09 第一轮「F-1：…console 增量」就是盲绿）。这里用**本轮日志里的那两行原文**喂纯函数自证。
  r.check(
    "自测：console 切片认 reportError 的 :166 形状",
    "true|false|false",
    [
      runtimeNoiseMatches(
        "console.error: [runtime] zz.status: 本次已拒绝，关闭插件再开启后可再次申请 @ http://localhost:1420/src/runtime/plugin-runtime.ts:166",
        ["zz.status"],
      ),
      runtimeNoiseMatches(
        "console.error: [runtime] zz.status: 本次已拒绝 @ http://localhost:1420/src/runtime/plugin-runtime.ts:166",
        ["zz.consent"],
      ),
      runtimeNoiseMatches("console.error: [bus] relay failed: zz.status:cmd", ["zz.status"]),
    ].join("|"),
  );
  r.check(
    "自测：console 切片认未捕获的 worker RPC 形状（本轮实测的那行原文）",
    "true|false|false",
    [
      runtimeNoiseMatches(
        "Uncaught (in promise) HostError: [zz.status] 权限被拒绝: bus:publish @ http://localhost:1420/src/runtime/plugin-worker-protocol.ts",
        ["zz.status"],
      ),
      runtimeNoiseMatches(
        "Uncaught (in promise) TypeError: x @ http://localhost:1420/src/runtime/plugin-worker-protocol.ts",
        ["zz.other"],
      ),
      runtimeNoiseMatches(
        "Uncaught (in promise) HostError: [zz.status] 权限被拒绝: bus:publish",
        ["zz.status"],
      ),
    ].join("|"),
  );
  r.check(
    "自测：absentThrough 对全 false 判成立、对空序列判不成立",
    "true|false",
    `${absentThrough([false, false])}|${absentThrough([])}`,
  );

  // ---- D09-D9 E：attach 容错自己的三条自测（E1/E3 在这儿，E2 放在「场上确有一扇窗」的那一组里）----
  // 造的假页走**真 `attach()`**：predicate 永不命中，超时由 cdp.mjs:19 自己抛
  // 「等不到匹配的 target」。不自造 Error —— 手写文案的话，测的就是我自己的字符串而不是容错。
  const BLIND_WS = "ws://selftest/attach-must-fail";
  const BLIND_PAGE = { url: "http://localhost:1420/src/consent.html", webSocketDebuggerUrl: BLIND_WS };
  const blindConnect = () => attach(PORT, () => false, 1_500);
  const mixedConnect = (t) => (t.webSocketDebuggerUrl === BLIND_WS ? blindConnect() : attachToTarget(t));

  // E1：读不到的页被折成 unreadable（不抛错），且「无窗」判据据此判**未确认**、具名红并带上页数。
  const blindScan = await readConsentPages(CONSENT_ID, false, [BLIND_PAGE], mixedConnect);
  r.check("自测：attach 读不到的那一页折成 unreadable=1，不抛错也不当噪音", 1, blindScan.unreadable);
  const blindVerdict = tallySamples([{ count: blindScan.windows.length, unreadable: blindScan.unreadable }], 0);
  r.check(
    "自测：全是 unreadable 样本时「无窗」判未确认（SKIPPED-n），ok 为 false",
    "SKIPPED-1|false|true",
    `${blindVerdict.state}|${blindVerdict.ok}|${consentVerdict(blindVerdict) !== true}`,
  );

  // E3：未确认样本既不算「0 扇」也不算「1 扇」，不进 every；有效样本恰好一半时按「不低于一半」成立。
  r.check(
    "自测：unreadable 样本判未确认、不进 every，覆盖率按不低于一半",
    "SKIPPED-1|SKIPPED-1|成立|SKIPPED-2",
    [
      tallySamples([{ count: 1, unreadable: 1 }], 1).state,
      tallySamples([{ count: 0, unreadable: 2 }], 1).state,
      tallySamples([{ count: 1, unreadable: 0 }, { count: 1, unreadable: 1 }], 1).state,
      tallySamples([{ count: 1, unreadable: 0 }, { count: 1, unreadable: 1 }, { count: 1, unreadable: 1 }], 1).state,
    ].join("|"),
  );

  // 反向对照：容错只认那两条 attach 文案，宿主错误/求值错误不许被吞（catch-all 正是要防的东西）。
  r.check(
    "自测：attach 容错只认两条文案，其他异常不许误吞",
    "true|true|false|false",
    [
      isAttachFailure(new Error("CDP websocket 连接失败: http://localhost:1420/src/consent.html")),
      isAttachFailure(new Error("等不到匹配的 target（port=9223）")),
      isAttachFailure(new Error("[zz.status] 权限被拒绝: bus:publish")),
      isAttachFailure(new Error("写启停清单失败: permission_denied")),
    ].join("|"),
  );

  // A26：握手命令超时的容错（快变体；20s 的 attach 级复现只在 --attach-selftest 跑）。
  // 上面那条既有断言的 want/got 一字未动，第三条握手模式由这里新增的断言单独钉住。
  await runAttachHandshakeSelfTest(r);

  // 7：未启用直接申请 → false 且无窗
  {
    const before = await readEnabledIds(invoke(state.c));
    await setEnabled(before.filter((id) => id !== CONSENT_ID));
    const res = await askConsent(["storage"]);
    r.check("未启用插件直接申请返回 false", true, res.ok === true && res.v === false);
    r.check("未启用插件不弹同意框（连续观察 1.2s 无窗）", true, consentVerdict(await noConsentThroughout(CONSENT_ID)));
    await setEnabled(before);
  }

  // 1/2/10：首次启用只一扇窗；并发同插件也只一扇；allow 后并集全授予
  {
    const restore = await resetConsent();
    try {
      const first = askConsent(["storage"]);
      // D09 W-2：数窗要连续采样满 OBSERVE_MS，每个**有效**样本都恰为 1 且至少一次非 0。
      // 单次快照等于没判 ——「第二扇窗晚开」的变异（合流键退回 req_id）就是靠时序活下来的。
      const s1 = await sampleConsentCounts(CONSENT_ID, 1);
      r.info("判据1 数窗采样原文", JSON.stringify({ 等第一扇: s1.waited, 观察期: s1.samples, 不可读页合计: s1.unreadable }));
      r.check(
        "判据1 前置：第一扇同意框在 10s 内出现（否则是采样瞎了，不是合流对了）",
        true,
        s1.appeared ? true : `窗没出现（attach 读不到 ${s1.unreadable} 页）`,
      );
      r.check("判据1：首次启用时该插件的窗数全程恰为 1", true, consentVerdict(s1));
      // 正对照：窗明明开着的时候，两个「无窗」helper 都必须返回 false —— 证明扫描抓得到窗。
      const control1 = await waitNoConsentProbe(CONSENT_ID, 600);
      r.check(
        "对照：窗开着时 waitNoConsent 必须返回 false（证明扫描不瞎）",
        false,
        control1.gone ? `扫描判成已消失（不可读页 ${control1.unreadable}）` : false,
      );
      const control2 = await noConsentThroughout(CONSENT_ID, 600);
      r.check(
        "对照：窗开着时 noConsentThroughout 也必须返回 false",
        false,
        control2.ok ? `扫描判成无窗：${control2.state}` : false,
      );
      // D09-D9 E2：场上此刻**确实**有一扇本插件的窗。把一页必 attach 失败的假页混在它前面，
      // 扫描必须跳过假页、照样在可读页上发现这扇窗 —— 证明「读不到」没被当成「场上没窗」。
      const mixedScan = await readConsentPages(
        CONSENT_ID,
        false,
        [BLIND_PAGE, ...(await consentTargets())],
        mixedConnect,
      );
      r.check(
        "自测：混进一页读不到的假页后，真着的那扇窗仍被发现（unreadable 不吞可读页）",
        true,
        mixedScan.windows.length > 0 && mixedScan.unreadable === 1
          ? true
          : `发现 ${mixedScan.windows.length} 扇 / 读不到 ${mixedScan.unreadable} 页`,
      );
      const consent = await driveConsent("allow", CONSENT_ID, ["storage"]);
      const firstRes = await first;
      r.check("判据1：首次启用只一扇同意框", true, consent.label.startsWith("consent-"));
      r.check("判据10：allow 后 storage 授权", true, firstRes.ok === true && firstRes.v === true && (await checkConsent("storage")));

      const restore2 = await resetConsent();
      try {
        const a = askConsent(["storage"]);
        const b = askConsent(["notify"]);
        const s2 = await sampleConsentCounts(CONSENT_ID, 1);
        r.info("判据2 数窗采样原文", JSON.stringify({ 等第一扇: s2.waited, 观察期: s2.samples, 不可读页合计: s2.unreadable }));
        r.check(
          "判据2 前置：并发时第一扇同意框在 10s 内出现",
          true,
          s2.appeared ? true : `窗没出现（attach 读不到 ${s2.unreadable} 页）`,
        );
        r.check("判据2：两个并发请求期间该插件的窗数全程恰为 1", true, consentVerdict(s2));
        r.check(
          "判据2：那一扇窗列的是两项并集（各出现一次）",
          "1|1",
          [
            (s2.last[0]?.caps ?? []).filter((x) => x.includes("storage")).length,
            (s2.last[0]?.caps ?? []).filter((x) => x.includes("notify")).length,
          ].join("|"),
        );
        const merged = await driveConsent("allow", CONSENT_ID, ["storage", "notify"]);
        const [ra, rb] = await Promise.all([a, b]);
        r.check("判据2：同插件并发只一扇窗且能力并集", true, merged.caps.includes("storage") && merged.caps.includes("notify"));
        r.check("判据2：两个并发调用共享同一次允许", true, ra.ok === true && ra.v === true && rb.ok === true && rb.v === true);
        r.check("判据10：allow 后 notify 也授权", true, await checkConsent("notify"));
      } finally {
        await restore2();
      }
    } finally {
      await restore();
    }
  }

  // 3：窗口开着时追加能力，不换窗；窗口 label 与 req_id 不变
  {
    const restore = await resetConsent();
    try {
      const first = askConsent(["storage"]);
      const opened = await waitConsentWindow(CONSENT_ID);
      try {
        const second = askConsent(["notify"]);
        const merged = await driveConsent("allow", CONSENT_ID, ["storage", "notify"]);
        const [r1, r2] = await Promise.all([first, second]);
        r.check("判据3：追加能力不换窗（label 不变）", opened.label, merged.label);
        r.check("判据3：追加能力不换 req（原窗协议仍有效）", true, merged.label.startsWith("consent-"));
        r.check("判据3：追加能力并集去重", true, merged.caps.filter((x) => x === "storage").length === 1 && merged.caps.filter((x) => x === "notify").length === 1);
        r.check("判据3：两个请求都放行", true, r1.ok && r1.v === true && r2.ok && r2.v === true);
      } finally {
        opened.cs.close();
      }
    } finally {
      await restore();
    }
  }

  // 4/9/11：拒绝锁、重复能力去重、停用再启用清锁
  {
    const restore = await resetConsent();
    try {
      const dup = askConsent(["storage", "storage", "notify"]);
      const dupConsent = await driveConsent("deny", CONSENT_ID, ["storage", "notify"]);
      const dupRes = await dup;
      r.check("判据9：重复能力在窗口里去重", true, dupConsent.caps.filter((x) => x === "storage").length === 1);
      r.check("判据10：deny 后新增能力不授权", true, dupRes.ok === true && dupRes.v === false && !(await checkConsent("storage")) && !(await checkConsent("notify")));

      // D09 W-1：先让请求带 5s 超时落地（挂到超时＝拒绝锁没生效，当场具名红），再连续观察不该有窗。
      const second = askConsent(["notify"]);
      const racedSecond = await settledWithin(second);
      if (racedSecond === CONSENT_NOT_SETTLED) await driveConsent("deny", CONSENT_ID).catch(() => null);
      const secondRes = await second;
      r.check(
        "判据4：拒绝后同轮调用 5s 内直接 false（不是挂到超时）",
        "true|true", // 类 1 修正：两个布尔都成立时拼出来就是 "true|true"
        racedSecond === CONSENT_NOT_SETTLED
          ? "TIMEOUT"
          : [secondRes.ok === true, secondRes.v === false].join("|"),
      );
      r.check("判据4：拒绝后同轮不再弹窗（连续观察 1.2s 无窗）", true, consentVerdict(await noConsentThroughout(CONSENT_ID)));

      // 设置页撤销授权不清拒绝锁（I4）
      await state.settings.invoke("permission_revoke", { pluginId: CONSENT_ID });
      const afterRevoke = askConsent(["notify"]);
      const racedRevoke = await settledWithin(afterRevoke);
      if (racedRevoke === CONSENT_NOT_SETTLED) await driveConsent("deny", CONSENT_ID).catch(() => null);
      const afterRevokeRes = await afterRevoke;
      r.check(
        "I4：撤销授权后同轮调用 5s 内直接 false（不是挂到超时）",
        "true|true", // 类 1 修正
        racedRevoke === CONSENT_NOT_SETTLED
          ? "TIMEOUT"
          : [afterRevokeRes.ok === true, afterRevokeRes.v === false].join("|"),
      );
      r.check("I4：撤销授权不清拒绝锁、仍不弹窗（连续观察 1.2s 无窗）", true, consentVerdict(await noConsentThroughout(CONSENT_ID)));
      r.check("I4：撤销授权后同轮仍直接 false", true, afterRevokeRes.ok === true && afterRevokeRes.v === false);

      // 停用再启用清锁（判据11）
      const restore11 = await enableForConsent(CONSENT_ID);
      try {
        const retry = askConsent(["notify"]);
        const retryConsent = await driveConsent("allow", CONSENT_ID, ["notify"]);
        const retryRes = await retry;
        r.check("判据11：停用再启用后拒绝锁已清，可再次弹窗", true, retryConsent.caps.includes("notify"));
        // F-5（D03 审计 W-5）：这条的谓词是判据11 那次答复的后半，本来就没断「不弹窗」—— 改名对齐名实。
        // I3（已授权不再弹）的实质由紧下面这两条承担，它们一个字没动。
        r.check("判据11：清锁后再次申请的答复为 true", true, retryRes.ok === true && retryRes.v === true);
        // 上一个窗口的销毁是异步尾巴；先等它消失，再断言“已授权不再开窗”。
        const settled5 = await waitNoConsentProbe(CONSENT_ID, 10_000);
        r.check(
          "判据5前置：答完后旧窗已关闭",
          true,
          settled5.gone ? true : `没确认关掉（等满 10s，attach 读不到 ${settled5.unreadable} 页）`,
        );
        const already = await askConsent(["notify"]);
        const alreadyNoWindow = await noConsentThroughout(CONSENT_ID);
        r.check(
          "判据5：已授权请求直接 true 且无窗",
          true,
          already.ok === true && already.v === true && alreadyNoWindow.ok
            ? true
            : `答复 ok=${already.ok} v=${already.v}｜${consentVerdict(alreadyNoWindow)}`,
        );
      } finally {
        console.log("  · 判据11 收尾：restore11() 前一行（判据5 组已结束）");
        await restore11();
      }
    } finally {
      console.log("  · 同意区收尾：restore() 前");
      await restore();
      console.log("  · 同意区收尾：restore() 已返回");
    }
  }

  // 6：窗口开着时停用插件 → 窗口关闭、等待方 false
  {
    const restore = await resetConsent();
    try {
      const pending = askConsent(["storage"]);
      const opened = await waitConsentWindow(CONSENT_ID);
      const before = await readEnabledIds(invoke(state.c));
      await setEnabled(before.filter((id) => id !== CONSENT_ID));
      // F-5（D03 审计 W-4）：预算按 ADR-0013 §5 判据6 原文的 **5s**，上一版偷偷放宽到 10s。
      // 起算点就是上面那次停用调用返回之后（不含任何观察期）；红时把实际耗时带进 detail，
      // 一眼分清「窗根本没关」与「关得慢」——要放宽得由日志原文去改 ADR，不许在代码里悄悄放。
      const closedStartedAt = Date.now();
      const closedProbe = await waitNoConsentProbe(CONSENT_ID, 5_000);
      const closedElapsed = Date.now() - closedStartedAt;
      r.info("判据6 关窗读数", `预算 5000ms，实测 ${closedElapsed}ms，attach 读不到 ${closedProbe.unreadable} 页`);
      // 实际值带耗时：红的时候失败清单里就直接写着「没关，已等 Xms」，不用再回去翻日志
      r.check(
        "判据6：停用插件后同意框关闭",
        "5s 内关掉",
        closedProbe.gone
          ? "5s 内关掉"
          : `5s 内没关掉（已等 ${closedElapsed}ms，attach 读不到 ${closedProbe.unreadable} 页）`,
      );
      const res = await pending;
      r.check("判据6：停用后等待方返回 false", true, res.ok === true && res.v === false);
      opened.cs.close();
      await setEnabled(before);
    } finally {
      await restore();
    }
  }

  // 清理探针：停用、移除目录，避免污染后续套件
  const consentBefore = await readEnabledIds(invoke(state.c));
  await setEnabled(consentBefore.filter((id) => id !== CONSENT_ID));
  // 有意拒绝/停用的都是直接 permission_request，不应经过 doActivate；按插件 id 精确核销为 0 条。
  // 窗口 B：触发=ADR-0013 组的直接 permission_request / 拒绝锁 / 停用取消；
  // 发射点=doActivate 277-282（本组不应经过）与 doDeactivate 322/339；
  // 期望=0；理由=直接 permission_request 不经过 doActivate，停用取消也不进 catch。
  const consentNoise = consoleWindow(adrWindowStart, [CONSENT_ID]);
  r.check("ADR-0013 新组/清理窗口 console 精确核销：zz.consent=0", 0, consentNoise.length);
  r.check("窗口 B：zz.consent console=0（ADR-0013 组切片）", 0, consentNoise.length);

  logConsoleLedger("after ADR-0013");
  r.group("宿主页面自身未产生 CSP 违规或未捕获异常");
  // 上面的递归测试会刻意打一条 console.error，它是被测行为的证据，不该混进这里的零容忍
  r.info("导航过渡期告警（reload 切断在飞 IPC 的产物，单独归类）", String(state.c.transitionNoise.length));
  // 本组故意打崩 Worker 的两条记录属被测行为的证据，按探针名过滤（同 verify-worker 口径）
  const unexpected = state.c.noise.filter((n) => !n.includes("派发递归") && !n.includes("B3 崩溃探针"));
  // 有意拒绝组的 console 不能一律算“意外”：按插件 id + 文案原文 + 次数精确核销。
  // 这是新增的核销断言，不是白名单；数量/文案变化都会红。
  // 前缀止于行号之前：卡「文案 + 发射文件」，不卡行号（行号会随 src/runtime 编辑漂移）。
  const denyText = `${DENY_TEXT} @ http://localhost:1420/src/runtime/plugin-runtime.ts:`;
  const countDeny = (id) => unexpected.filter((n) => n.includes(id) && n.includes(denyText)).length;
  r.info(
    "有意拒绝 console 触发窗口",
    "zz.probe: agent hooks 拒绝/重启用链；zz.consent: ADR-0013 新组清理；zz.status: 本轮未出现",
  );
  r.check(
    "有意拒绝 console 核销：zz.probe=0 / zz.consent=0 / zz.status=0",
    "0|0|0",
    `${countDeny("zz.probe")}|${countDeny("zz.consent")}|${countDeny("zz.status")}`,
  );
  const remaining = unexpected.filter(
    (n) =>
      !((n.includes("zz.probe") || n.includes("zz.consent") || n.includes("zz.status")) && n.includes(denyText)),
  );
  r.check("无其他 console 错误", 0, remaining.length);
  for (const n of remaining) console.log("   " + n);

  // ---------- D07 窗口 D/E：deny / stop 正向对照 ----------
  // 正向对照证明 console 采集真的能看见 reportError；否则上面 A/B/C 的 0 只是空判据。
  r.group("D07 窗口 D/E：deny / stop 正向对照");
  const UNDECLARED_ID = PRESEED_HOOK_UNDECLARED_ID;
  const enabledBeforeDE = await readEnabledIds(invoke(state.c));
  const deBaseIds = enabledBeforeDE.filter((id) => id !== UNDECLARED_ID);
  const resetUndeclared = async () => {
    if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c);
    // 先移除：宿主会取消 pending 并清掉旧拒绝锁；再撤销旧授权，最后加回。
    await setEnabled(deBaseIds);
    await state.settings.invoke("permission_revoke", { pluginId: UNDECLARED_ID }).catch(() => undefined);
    await setEnabled([...deBaseIds, UNDECLARED_ID]);
    await waitNoConsent(UNDECLARED_ID, 10_000);
  };
  const fireUndeclaredActivation = () =>
    state.c.ev(`(async () => {
      const rt = await import('/src/runtime/plugin-runtime.ts');
      const ms = await window.__TAURI_INTERNALS__.invoke('plugins_list');
      const manifest = ms.find((m) => m.id === ${JSON.stringify(UNDECLARED_ID)});
      if (!manifest) throw new Error('D07 未找到预置 fixture ${UNDECLARED_ID}');
      window.__d07Activation = null;
      rt.activatePlugin(manifest).then(
        () => { window.__d07Activation = 'done'; },
        (e) => { window.__d07Activation = 'error:' + String(e?.message ?? e); },
      );
      return true;
    })()`);
  const waitUndeclaredActivation = () =>
    waitUntil(state.c, `window.__d07Activation !== null && window.__d07Activation !== undefined`, 20_000);
  const undeclaredActive = () =>
    state.c.ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); return rt.isActive(${JSON.stringify(UNDECLARED_ID)}); })()`);
  try {
    // 窗口 D：触发=显式 rt.activatePlugin(zz.hookundeclared)，doActivate 发现 storage 未授权；
    // 发射点=277-282 的 permission_request 被用户拒绝 → 282 reportError(DENY_TEXT)；
    // 期望=该窗口切片长度===1 且 DENY_TEXT===1；理由=本窗口只有 282 一个发射点。
    await resetUndeclared();
    const dStart = (state.c.noise ?? []).length;
    const dConsole = waitConsoleWindow(
      dStart,
      [UNDECLARED_ID],
      (entries) => entries.some((n) => n.includes(DENY_TEXT)),
    );
    await fireUndeclaredActivation();
    const denySeen = await driveConsent("deny", UNDECLARED_ID);
    r.check("窗口 D：同意框属于 zz.hookundeclared", true, denySeen.name.includes(UNDECLARED_ID));
    await waitUndeclaredActivation();
    await dConsole;
    const dWindow = consoleWindow(dStart, [UNDECLARED_ID]);
    r.check(
      "窗口 D：DENY_TEXT 恰好 1（activatePlugin + deny）",
      1,
      dWindow.filter((n) => n.includes(DENY_TEXT)).length,
    );
    r.check("窗口 D：窗口切片总长恰好 1", 1, dWindow.length);
    r.check("窗口 D：拒绝后插件没有进入 active", false, await undeclaredActive());

    // 窗口 E：触发=清拒绝锁后重新 activatePlugin，permission_request 处于 pending 时停用；
    // 发射点=doActivate 277-282 的 permission_request 返回 false，且 loadEnabled=false → 282 STOP_TEXT；
    // 期望=切片长度===1 且 STOP_TEXT===1；322/339 期望 0，依据是 doDeactivate 开头的
    // `if (!instance) return`：pending 时插件还没 active，停用不会进 doDeactivate 的 catch。
    await resetUndeclared();
    const eStart = (state.c.noise ?? []).length;
    const eConsole = waitConsoleWindow(
      eStart,
      [UNDECLARED_ID],
      (entries) => entries.some((n) => n.includes(STOP_TEXT)),
    );
    await fireUndeclaredActivation();
    const pendingUndeclared = await waitConsentWindow(UNDECLARED_ID);
    r.check("窗口 E：同意框已打开（pending）", true, pendingUndeclared.caps.includes("storage"));
    pendingUndeclared.cs.close();
    const beforeEStop = await readEnabledIds(invoke(state.c));
    await setEnabled(beforeEStop.filter((id) => id !== UNDECLARED_ID));
    await waitUndeclaredActivation();
    await eConsole;
    await waitNoConsent(UNDECLARED_ID, 10_000);
    const eWindow = consoleWindow(eStart, [UNDECLARED_ID]);
    r.check(
      "窗口 E：STOP_TEXT 恰好 1（pending 时停用）",
      1,
      eWindow.filter((n) => n.includes(STOP_TEXT)).length,
    );
    r.check("窗口 E：窗口切片总长恰好 1（322/339 未发射）", 1, eWindow.length);
  } finally {
    await setEnabled(enabledBeforeDE);
    if (state.settings) await state.settings.invoke("permission_revoke", { pluginId: UNDECLARED_ID }).catch(() => undefined);
    await waitNoConsent(UNDECLARED_ID, 10_000);
  }
}
