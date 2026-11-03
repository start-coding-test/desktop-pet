// B3 常驻状态行（原 3067-3552）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { openSettingsInvoker, readEnabledIds, reloadAndWait, waitUntil } from "../harness/cdp.mjs";
import { PRESEED_STATUS_A, PRESEED_STATUS_B } from "../harness/fixtures.mjs";
import { CONSENT_NOT_SETTLED, consentVerdict, driveConsent, noConsentThroughout, sampleConsentCounts, settledWithin } from "./consent.mjs";
import { PORT, invoke, sleep } from "./env.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseBadge(state) {
  const r = state.r;
  const invoke_ = state.invoke_;
  const call = state.call;
  const b3WindowStart = state.b3WindowStart;
  const { consoleWindow, logConsoleLedger, revoke, setEnabled } = state;
  r.group("B3 常驻状态行：显示 / 单行几何 / 仲裁回落 / 台词优先 / 回收");
  const STATUS_A = PRESEED_STATUS_A;
  const STATUS_B = PRESEED_STATUS_B;
  // 采样器必须等 reload 之后再装：window 上的东西（订阅与数组）会被那次重载整个冲掉 ——
  // 上一版就栽在这儿，结果每条 statusCall 都等满 15s 超时
  const installedCollectors = `(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    window.__statusRes = [];
    for (const pid of ['${STATUS_A}', '${STATUS_B}']) bus.subscribe(pid + ':res', (p) => window.__statusRes.push(p));
    return true;
  })()`;
  let statusSeq = 0;
  /** 指令经总线投给插件入口，结果同样经总线回来（回不传就返回可读失败，而不是 TypeError） */
  const statusCall = async (pid, action, text) => {
    const id = ++statusSeq;
    await state.c.ev(`(async () => {
      const { bus } = await import('/src/runtime/event-bus.ts');
      bus.inject(${JSON.stringify(pid)} + ':cmd', { id: ${id}, action: ${JSON.stringify(action)}, text: ${JSON.stringify(text ?? null)} });
      return true;
    })()`);
    const hit = `((window.__statusRes || []).find((r) => r.id === ${id})) ?? null`;
    const got = await waitUntil(state.c, `!!(${hit})`, 15_000).catch(() => false);
    if (!got) return { ok: false, e: `插件没回传 ${pid} ${action} 的结果（15s）` };
    return state.c.ev(hit);
  };
  const bubbleNow = () =>
    state.c.ev(`(() => { const b = document.getElementById('pet-bubble'); return { show: b.classList.contains('show'), status: b.classList.contains('status'), text: b.textContent }; })()`);
  /** 气泡盒子的渲染态读数（单行盒高不在这里推 —— 由「1 个字」那次实测校准，见下） */
  const bubbleBox = () =>
    state.c.ev(`(() => {
      const b = document.getElementById('pet-bubble');
      const cs = getComputedStyle(b);
      const rect = b.getBoundingClientRect();
      return {
        top: rect.top,
        height: rect.height,
        width: rect.width,
        maxWidth: parseFloat(cs.maxWidth),
      };
    })()`);

  const enabledBeforeB3 = await readEnabledIds(invoke(state.c));
  /**
   * 基线读数要确定性成立。本组第一条读数会撞上**宿主自己的临时台词**：45s 一拍的闲置自言自语、
   * AFK 满 3 分钟的等待台词、重载后的启动问候 —— 它们按设计只占槽 3.6s（`BUBBLE_HOLD_MS`），
   * 点对点采样因此偶发读到「气泡正显示着」（2026-10-20 main 的 340/1 就是这条）。
   * 两步把读数落到确定态：① 夹具隔离（把闲聊源在组内钉住，用完即还原）；② 有界轮询等已经在显示的那句台词回位。
   * 判据本身**没放宽**：真有插件常驻行占着槽时 `.status` 会跟着亮，下面两条都会红。
   */
  let b3Pin = null;
  let b3AfkReset = false;
  let b3Quiet = false;
  let b3Entry = null;
  let b3After = null;
  try {
    // ① 关掉「45s 一拍 × Math.random() < 0.4」的闲置自言自语闸：抽两次必须相等，才说明真的钉住了
    b3Pin = await state.c.ev(`(() => {
      window.__b3SavedRandom = Math.random;
      Math.random = () => 0.5;
      return { a: Math.random(), b: Math.random() };
    })()`);
    // AFK 计时复位（可达则做）：`request()` 里 `sinceInteraction = 0`，把「3 分钟无交互」的等待台词推到本组之外；
    // idle → idle 不改画面。宿主没暴露控制器时跳过，不影响后面的判据。
    b3AfkReset = await state.c
      .ev(`(async () => {
        try {
          const { petController } = await import('/src/pet/host.ts');
          const ctl = petController();
          if (!ctl) return false;
          ctl.react("idle");
          return true;
        } catch { return false; }
      })()`)
      .catch(() => false);
    b3Entry = await bubbleNow();
    // ② 台词到点自己回位：有界轮询等它安静下来（不赌时序、不加固定 sleep）
    b3Quiet = await waitUntil(state.c, `!document.getElementById('pet-bubble').classList.contains('show')`, 6_000).catch(() => false);
    b3After = await bubbleNow();
    r.info("B3 基线入口读数（show / .status / 文本 · AFK 计时已复位）", `${b3Entry.show} / ${b3Entry.status} / ${JSON.stringify(b3Entry.text)} · ${b3AfkReset}`);
    r.info("B3 基线轮询后读数（是否等到安静 / .status / 文本）", `${b3Quiet} / ${b3After.status} / ${JSON.stringify(b3After.text)}`);
    r.check("本组开始时已钉住随机台词闸（两次抽样相等且落在 0.4 之上，隔离生效）", true, b3Pin?.a === b3Pin?.b && b3Pin.a > 0.4 && b3Pin.a < 1);
    r.check("基线：此刻槽里没有插件的常驻行（显示中的只能是不带 .status 的台词）", true, !(b3Entry.show && b3Entry.status));
  } finally {
    // 随机闸用完立刻还原（后面的「随机台词让路」那组要自己掌控 randomness）
    await state.c
      .ev(`(() => {
        if (window.__b3SavedRandom) {
          Math.random = window.__b3SavedRandom;
          delete window.__b3SavedRandom;
        }
        return true;
      })()`)
      .catch(() => undefined);
  }
  const b3BaselineShow = b3After ? b3After.show : (await bubbleNow()).show;
  r.check("基线：没挂常驻行时气泡是收起的", false, b3BaselineShow);
  // 上面那一段结尾把设置窗关了，句柄也随窗作废：本组要写启停清单与撤授权，重开一扇
  state.settings = await openSettingsInvoker(PORT, state.c);
  // D07-D16：上一轮可能留下 zz.status/zz.status2 的授权（B3 收尾的 revoke 若静默失败，
  // 下一次 doActivate 的 permission_check 会直接放行，不再弹同意框）。启用前清掉所有
  // zz.* 旧授权并读回；只动测试插件的授权，不碰用户插件。
  const b3GrantsBefore = (await state.settings.invoke("permission_list")).v ?? {};
  for (const id of Object.keys(b3GrantsBefore)) {
    if (String(id).startsWith("zz.")) await revoke(id);
  }
  const b3GrantsAfter = (await state.settings.invoke("permission_list")).v ?? {};
  const b3ZzLeft = Object.entries(b3GrantsAfter)
    .filter(([id, caps]) => String(id).startsWith("zz.") && (caps ?? []).length > 0)
    .map(([id]) => id);
  r.check("B3 启用前授权表不含 zz.*（旧授权已清）", [], b3ZzLeft);
  await setEnabled([...new Set([...enabledBeforeB3, STATUS_A, STATUS_B])]);
  await reloadAndWait(state.c);
  // 激活会为两个 fixture 各弹一次同意框（声明的三项能力）
  // D09-D4 类 3：数窗必须**逐插件、且在应答该插件之前**采。原来我在这里先整体采 A 再采 B，
  // 前提错了 —— doActivate 是串行的：A 的批量授权不答完，B 根本不会激活。第一轮实测就是
  // A 采到 [1,1,1,1,1,1,1]、B 采到 48 个 0，而 B 的窗随后确实正常出现。
  // 所以「场上同时两扇 / 各自恰一扇」这条合并断言删掉，取代者 = 循环内这两条逐插件的
  // 「窗数全程恰为 1」+ 既有的「不同插件即使能力相同也各一扇窗（不合并）」（比 label 不同）。
  const b3Consents = [];
  for (const id of [STATUS_A, STATUS_B]) {
    // 采样放在**应答该插件之前**：串行激活下此刻属于这个插件的窗只该有一扇。
    // 若哪天改成按能力集合合流，第二个插件永远等不到自己的窗 ⇒ 下面两条各自具名红。
    const sampled = await sampleConsentCounts(id, 1);
    r.info(
      `B3 数窗采样原文 ${id}`,
      JSON.stringify({ 等第一扇: sampled.waited, 观察期: sampled.samples, 不可读页合计: sampled.unreadable }),
    );
    r.check(
      `B3 前置：${id} 的第一扇同意框在 10s 内出现（否则是采样瞎了，不是合流对了）`,
      true,
      sampled.appeared ? true : `窗没出现（attach 读不到 ${sampled.unreadable} 页）`,
    );
    r.check(`B3：${id} 的窗数全程恰为 1（逐插件连续数窗）`, true, consentVerdict(sampled));
    const consent = await driveConsent("allow", id).catch((err) => ({ error: String(err?.message ?? err) }));
    b3Consents.push(consent);
    const caps = consent?.caps ?? null;
    const capsOk = !!caps && caps.some((x) => x.includes("pet:say"));
    // 期望值不动（仍是 true）；失败时把 driveConsent 的原因原文带进 detail —— 否则只有一句
    // 「期望 true，实得 false」，分不清「框根本没开」还是「开的是别人的框」（B08 那一轮的现场就是这样丢掉的）
    r.check(`同意框列出了 ${id} 声明的能力（含 pet:say）`, true, capsOk ? true : (consent?.error ?? false));
  }
  // 两个插件声明同一组能力；它们必须各自有独立 req/窗口，不能被按能力集合合流。
  r.check(
    "不同插件即使能力相同也各一扇窗（不合并）",
    true,
    b3Consents.every((x) => typeof x?.label === "string" && x.label.startsWith("consent-")) &&
      b3Consents[0].label !== b3Consents[1].label,
  );
  await state.c.ev(installedCollectors);
  /**
   * 等槽里没有台词在显示（气泡要么收起、要么带 `.status`）。
   * 重载之后那句启动问候会亮 3.6s，而它在显示期间**按设计占着槽**（B3：不打断正在显示的台词），
   * 这时候读气泡读到的是它、`.status` 也没挂 —— 上一轮就是这么假红的。
   */
  const waitStatusSlot = () =>
    waitUntil(
      state.c,
      `(() => { const b = document.getElementById('pet-bubble'); return !b.classList.contains('show') || b.classList.contains('status'); })()`,
      8_000,
    ).catch(() => false);
  await waitStatusSlot();
  // 先挂一行。**不在激活里挂**：首次启用时 pet:say 还没授权，激活里调 setStatus 会当场 reject
  // （这正是同意框被弹出来的原因），所以别靠激活时序
  const b3Seed = await statusCall(STATUS_A, "set", "常驻行");
  r.check("设置返回生效后的文本", "常驻行", b3Seed.v);
  await waitStatusSlot();
  const b3SeedNow = await bubbleNow();
  r.check("挂上一行后界面显示它、且带 .status（单行化生效）", "常驻行|true", [b3SeedNow.text, b3SeedNow.status].join("|"));
  // 随机台词让路：把 Math.random 钉死，等一次闲置自言自语（45s 一拍 ⇒ 48s 窗口内必然 ≥1 拍），
  // 全程 120ms 采样气泡文本 —— 守卫被摘掉时那一拍会弹台词并亮 3.6s，必然被抓到。
  // 这样判不赌「激活 vs 启动台词」的时序，也只等一个固定窗口。
  await state.c.ev(`(() => {
    window.__savedRandom = Math.random;
    Math.random = () => 0;
    window.__bubbleSeen = [];
    window.__bubbleTimer = setInterval(() => {
      const b = document.getElementById('pet-bubble');
      window.__bubbleSeen.push(b.classList.contains('show') ? b.textContent : '');
    }, 120);
    return true;
  })()`);
  await waitUntil(state.c, `window.__bubbleSeen.length >= 400`, 52_000).catch(() => false);
  const b3Texts = await state.c.ev(`[...new Set(window.__bubbleSeen)]`);
  await state.c.ev(`(() => { clearInterval(window.__bubbleTimer); Math.random = window.__savedRandom; return true; })()`);
  r.check(
    "有常驻行时宿主随机台词让路（整段窗口内气泡只出现过常驻行）",
    "[]",
    JSON.stringify(b3Texts.filter((t) => t !== "" && t !== "常驻行")),
  );
  r.check("观察期确实采样到了常驻行（采样器活着，这条不是空转）", true, b3Texts.includes("常驻行"));

  await waitStatusSlot(); // 量之前先确认槽里是常驻行而不是某句台词
  r.check("常驻行有 .status 类（CSS 单行化生效）", true, (await bubbleNow()).status);
  // 单行盒**自校准**：先设 1 个字量出盒高，不推公式（Chromium 对 `line-height: 1.6` 可能回 "normal"，
  // parseFloat 得 NaN，比较就恒假 —— 上一轮就是这么假红的）
  await statusCall(STATUS_A, "set", "字");
  await waitStatusSlot();
  const b3Box1 = await bubbleBox();
  r.check("单行盒高 > 0（元素真渲染了，防 0 === 0 空转）", true, b3Box1.height > 0);
  r.check("单行盒不越出窗口上沿", true, b3Box1.top >= 0);
  r.check("宽度没超出立绘宽（既有断言不破）", true, b3Box1.width <= b3Box1.maxWidth + 1);

  const b3Long = await statusCall(STATUS_A, "set", "超长".repeat(40));
  await waitStatusSlot();
  const b3Box2 = await bubbleBox();
  const b3Dom = await state.c.ev(`(() => { const b = document.getElementById('pet-bubble'); return { text: b.textContent, scroll: b.scrollWidth, client: b.clientWidth }; })()`);
  r.check("超长输入照样只占一行（盒高 = 单行盒高）", true, Math.abs(b3Box2.height - b3Box1.height) <= 1);
  r.check("超长输入仍不越出窗口上沿", true, b3Box2.top >= 0);
  r.check("超长输入仍不超出立绘宽", true, b3Box2.width <= b3Box2.maxWidth + 1);
  r.check("输入侧按码点截到 20（返回值自证）", 20, [...String(b3Long.v ?? "")].length);
  r.check("界面上的文本就是那 20 个字（末尾被截掉，不是原样 80 字）", true,
    b3Dom.text === String(b3Long.v ?? "") && [...b3Dom.text].length === 20);
  r.info("超长行的可视溢出（scrollWidth/clientWidth）", `${b3Dom.scroll}/${b3Dom.client}`);

  // M4 的可观测性前提：必须有一个「20 码点以内、但宽度超过气泡」的输入 —— 否则单独去掉 nowrap 不可观测
  // （20 个全角汉字约 264px，正好卡在 266 上限内）。20 个 emoji 按全角宽排版会溢出：
  // 带 nowrap 时它只溢出（scroll > client），去掉 nowrap 就会折行（盒高变大）。这条基线就是那个证明。
  const b3Wide = await statusCall(STATUS_A, "set", "🐱".repeat(20));
  await waitStatusSlot();
  const b3BoxWide = await bubbleBox();
  const b3WideDom = await state.c.ev(`(() => { const b = document.getElementById('pet-bubble'); return { scroll: b.scrollWidth, client: b.clientWidth, len: [...b.textContent].length }; })()`);
  r.check("20 个宽字符输入：仍是单行（盒高 = 单行盒高）", true, Math.abs(b3BoxWide.height - b3Box1.height) <= 1);
  r.check(
    "20 个宽字符确实溢出气泡（M4「单独去掉 nowrap 会折行」的可观测性前提）",
    true,
    b3WideDom.scroll > b3WideDom.client,
  );
  r.check("宽字符输入也没被 20 码点上限截短", 20, b3WideDom.len);
  r.check("宽字符输入的返回值也是那 20 个字符（没被截短）", "🐱".repeat(20), b3Wide.v);

  const b3Escaped = await statusCall(STATUS_A, "set", "<b>x</b>");
  const b3Html = await state.c.ev(`document.getElementById('pet-bubble').innerHTML`);
  const b3AsText = await bubbleNow();
  r.check("尖括号走 textContent（界面显示字面文本）", "<b>x</b>", b3AsText.text);
  r.check("设置返回的就是这串字面文本（没被当成标记处理）", "<b>x</b>", b3Escaped.v);
  r.check("没有真的建出 <b> 元素（标签被转义）", true, /&lt;b&gt;/.test(b3Html) && (await state.c.ev(`document.getElementById('pet-bubble').querySelector('b') === null`)));

  const b3Bad = await statusCall(STATUS_A, "set", 123);
  r.check("非字符串/非 null 直接拒", true, b3Bad.ok === false && /只接受字符串或 null/.test(String(b3Bad.e)));
  const b3Empty = await statusCall(STATUS_A, "set", "  \n\t ");
  r.check("清洗后为空 → 拒（不悄悄清掉）", true, b3Empty.ok === false && /非空文本内容/.test(String(b3Empty.e)));
  const b3Folded = await statusCall(STATUS_A, "set", "a\u0007b\u0000c\td");
  r.check("控制字符（含 BEL/NUL/制表）一律折叠成空格", "a b c d", b3Folded.v);

  const b3A1 = await statusCall(STATUS_A, "set", "A行");
  const b3B1 = await statusCall(STATUS_B, "set", "B行");
  r.check("A 设了显示 A、B 设了显示 B（最近设置的生效）", "B行", (await bubbleNow()).text);
  r.check("两次设置都拿到了生效值", "A行|B行", [b3A1.v, b3B1.v].join("|"));
  const b3AgainA = await statusCall(STATUS_A, "set", "A行");
  r.check("重复设置相同文本不改回落顺序（B 仍在上，防刷）", "B行", (await bubbleNow()).text);
  r.check("重复设置照样返回生效值（幂等只作用在顺序上）", "A行", b3AgainA.v);
  const b3BClear = await statusCall(STATUS_B, "clear");
  r.check("B 清除后回落到 A 那条", "A行", (await bubbleNow()).text);
  r.check("清除的返回值是 null（只关于自己那条）", null, b3BClear.v);
  const b3AClear = await statusCall(STATUS_A, "clear");
  r.check("A 清除的返回值也是 null", null, b3AClear.v);
  r.check("A 也清掉后气泡收起", false, (await bubbleNow()).show);

  // 台词优先：say 占槽 → 3.6s 后回位到常驻行；台词期间 setStatus 不打断正在显示的台词
  await statusCall(STATUS_A, "set", "常驻1");
  await statusCall(STATUS_A, "say", "一句台词");
  r.check("台词插进来就占用槽（常驻行被临时替换）", "一句台词", (await bubbleNow()).text);
  await statusCall(STATUS_A, "set", "常驻2");
  r.check("台词显示期间状态行只是被替换，不打断这句台词", "一句台词", (await bubbleNow()).text);
  await sleep(3_700);
  r.check("3.6s 后台词收起、常驻行回位（回到最新那条内容）", "常驻2", (await bubbleNow()).text);

  // 隐藏后恢复：状态行按当前状态回来
  const b3Hidden = await call("set_pet_hidden", { hidden: true });
  r.check("宠物窗能隐身（既有命令）", true, b3Hidden.ok === true);
  await sleep(400);
  const b3Shown = await call("set_pet_hidden", { hidden: false });
  r.check("宠物窗能回来", true, b3Shown.ok === true);
  await sleep(600);
  r.check("隐藏再显示之后常驻行仍在（按当前状态回来）", "常驻2", (await bubbleNow()).text);

  // 撤权：失去 pet:say 之后那条行要摘掉并**正确回落到别人那条**；别人的行一概不动
  await statusCall(STATUS_B, "set", "B行3");
  await statusCall(STATUS_A, "set", "A行3");
  r.check("撤权前 A 的行在最上（A 最后设置）", "A行3", (await bubbleNow()).text);
  await revoke(STATUS_A);
  const b3RevokeBack = await waitUntil(
    state.c,
    `(() => { const b = document.getElementById('pet-bubble'); return b.classList.contains('show') && b.textContent === 'B行3'; })()`,
    5_000,
  ).catch(() => false);
  r.info("撤权 A 后回到 B行3 的耗时", b3RevokeBack ? "5s 内" : "5s 未回落");
  r.check("撤销 A 的授权后 A 的行被摘掉、回落到 B 的行", "B行3", (await bubbleNow()).text);
  // 「不误删别人的行 / 撤无关权限不误清」的反面证据：B 的行既没被摘也没被改
  r.check("撤 A 的权不动 B 的行", "B行3", (await bubbleNow()).text);
  // F-1（D03 审计）：无权之后**必须真的再试一次插件路径**。上一版为了躲 console 噪音，把这次尝试
  // 换成直接 `permission_request`，于是后面那句「这一行没出现」成了恒假的空比较 —— 没人去挂它。
  // 这里恢复 ctx.pet.setStatus → 桥 gated → permission_request 的真实链路，并在尝试前后切一段
  // console 窗口单独核 zz.status 的增量（切片形状见 runtimeNoiseMatches，D09-D4 第 6 条补全）。
  // 该增量期望 0 不再是推断：第一轮（run 39594136355）实测出过 1 条
  // `Uncaught (in promise) HostError: [zz.status] 权限被拒绝: bus:publish`，根因就是下面这段
  // 出路 C 描述的「回传通道也被撤了」；把 bus:publish 授回来后桥会当场拒 pet:say 并把
  // 「权限被拒绝」原文回传，链路里不再有待授权的 reply()。
  const regrantPublish = invoke_("permission_request", {
    pluginId: STATUS_A,
    capabilities: ["bus:publish"],
  });
  const publishConsent = await driveConsent("allow", STATUS_A, ["bus:publish"]).catch(() => null);
  const regrantPublishRes = await regrantPublish;
  r.check(
    "F-1 前置：重新授予 bus:publish 走的是真实同意框（不是绕过授权）",
    true,
    !!publishConsent && regrantPublishRes.ok === true && regrantPublishRes.v === true,
  );
  const pubCap = await invoke_("permission_check", { pluginId: STATUS_A, capability: "bus:publish" });
  const sayCap = await invoke_("permission_check", { pluginId: STATUS_A, capability: "pet:say" });
  r.check(
    "F-1 前置：回传通道已授权（permission_check bus:publish 为 true）",
    true,
    pubCap.ok === true && pubCap.v === true,
  );
  r.check(
    "F-1 前置：被测能力仍未授权（permission_check pet:say 为 false）",
    true,
    sayCap.ok === true && sayCap.v === false,
  );
  const b3BubbleBefore = await bubbleNow();
  r.check("F-1 前置：挂行尝试之前气泡按名确认是 B行3", "B行3", b3BubbleBefore.text);
  const b3AttemptConsoleStart = (state.c.noise ?? []).length;
  const b3NoGrant = statusCall(STATUS_A, "set", "偷挂行");
  const b3ConsentAgain = await driveConsent("deny", STATUS_A).catch(() => null);
  const b3NoGrantRes = await b3NoGrant;
  const b3AttemptConsole = consoleWindow(b3AttemptConsoleStart, [STATUS_A]);
  r.info("撤权后再设置的同意框", b3ConsentAgain ? "弹了（已拒）" : "没弹");
  // 标签与期望串一字不改；改的是它前面那次真调用回来了
  // （原实质=插件试过且被拒 → 新实质同；取代者=它自己，另加下面两条把它拆细）
  r.check(
    "撤权后无权再设置常驻行：拒掉同意框就拿不到这一行",
    "true|false",
    [b3NoGrantRes.ok === false, (await bubbleNow()).text === "偷挂行"].join("|"),
  );
  r.check(
    "F-1：经插件路径再设置时桥当场就把调用拒了（不是静默丢弃）",
    true,
    b3NoGrantRes.ok === false && /权限被拒绝/.test(String(b3NoGrantRes.e)),
  );
  r.check("F-1：挂行被拒这段窗口里 zz.status 的 console 增量", 0, b3AttemptConsole.length);
  r.check(
    "F-1：被拒的这次挂行没有把别人的行顶掉（拒绝不是清空气泡蒙过去的）",
    "B行3",
    (await bubbleNow()).text,
  );
  // ADR-0013 拒绝锁：同轮再申请不新开窗，调用直接失败；停用 A 时由宿主清锁。
  // D09 W-1：先让请求带 5s 超时落地（挂到超时就是实现坏了，当场具名红），再连续观察该窗不该出现。
  const b3Retry = invoke_("permission_request", {
    pluginId: STATUS_A,
    capabilities: ["pet:say"],
  });
  const b3Raced = await settledWithin(b3Retry);
  if (b3Raced === CONSENT_NOT_SETTLED) {
    // 拒绝锁失效时会留下一扇没人答的窗；收掉它，别让后面整组靠 20 秒抛错连坐丢尾部汇总
    await driveConsent("deny", STATUS_A).catch(() => null);
  }
  const b3RetryRes = await b3Retry;
  r.check(
    "B3：拒绝锁下同轮调用 5s 内直接返回 false（不是挂到超时）",
    // 类 1 修正：实际值是两个布尔拼成的串，正确实现下就是 "true|true"；
    // 上一版照抄了旧断言的 "true|false"，把自己判红了。
    "true|true",
    b3Raced === CONSENT_NOT_SETTLED
      ? "TIMEOUT"
      : [b3RetryRes.ok === true, b3RetryRes.v === false].join("|"),
  );
  const b3LockNoWindow = await noConsentThroughout(STATUS_A);
  r.check(
    "B3 撤权拒绝后同轮不再弹（拒绝锁生效）",
    true,
    b3LockNoWindow.ok && b3RetryRes.ok === true && b3RetryRes.v === false
      ? true
      : `${consentVerdict(b3LockNoWindow)}｜调用 ok=${b3RetryRes.ok} v=${b3RetryRes.v}`,
  );

  // 回收：停用要走**真的下线路径**。裸写启停清单不会让宠物窗 reconcile（watchEnabled 只缓存，
  // reconcile 只在启动与 host:plugin-toggled 时跑）—— 上一轮就是这么「停用」了个寂寞。
  // 这里直接调运行时导出的 deactivatePlugin：它和用户点开关最终进的是同一个 doDeactivate（disposeAll 在那里）。
  const b3Deactivate = (id) =>
    state.c.ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); await rt.deactivatePlugin(${JSON.stringify(id)}); return true; })()`);
  await statusCall(STATUS_B, "set", "B行");
  await b3Deactivate(STATUS_A);
  await waitUntil(
    state.c,
    `(() => { const b = document.getElementById('pet-bubble'); return b.classList.contains('status') && b.textContent === 'B行'; })()`,
    5_000,
  ).catch(() => false);
  r.check("停用 A 后 B 的行不受影响（仍是 B行）", "B行", (await bubbleNow()).text);
  // 真正的「A 被摘掉」证据：把 B 也清掉之后气泡必须收起 —— 若 A 的条目还在（只是被压在下面），
  // 这一刻会露出 "A行"/"常驻2"
  await statusCall(STATUS_B, "clear");
  const b3Reveal = await bubbleNow();
  r.info("清掉 B 后的气泡", b3Reveal.show ? `show|${b3Reveal.text}` : "hidden");
  r.check(
    "清掉 B 之后气泡收起（说明 A 停用时条目确实被摘掉，不是只被压在下面）",
    false,
    b3Reveal.show,
  );
  // 「只测停用回收」：这一路**全程无撤权、无 Worker 崩溃、无 setStatus(null)** —— 只有停用回收能清掉它。
  // 停用回收有两条冗余路径（桥里 register 的兜底回收 + worker-plugin-host 的 terminate 收尾），
  // 只破坏其中一条会被另一条掩盖（这点已由变异 M3 实测确认）；所以这条断言要能挡住「两条都断」。
  await statusCall(STATUS_B, "set", "B行2");
  const b3T0 = Date.now();
  await b3Deactivate(STATUS_B);
  const b3Gone = await waitUntil(
    state.c,
    `!document.getElementById('pet-bubble').classList.contains('show')`,
    5_000,
  ).catch(() => false);
  const b3Elapsed = Date.now() - b3T0;
  r.info("停用 B 到气泡收起（轮询）", `${b3Elapsed}ms · ${b3Gone ? "5s 内收起" : "5s 未收起"}`);
  r.check("停用回收在 5s 内生效（只测停用这条路径，轮询判据）", true, b3Gone);
  const b3AfterAllOff = await bubbleNow();
  r.info("停用 B 后的气泡", b3AfterAllOff.show ? `show|${b3AfterAllOff.text}` : "hidden");
  r.check(
    "停用 B → 完全收起（轮询判据，没靠加大 sleep）",
    false,
    b3AfterAllOff.show,
  );

  // 回收不止「停用」一条路：重载 / 移出启停清单 / Worker 崩溃 都得把行摘掉（各自实测，轮询判据，不加大 sleep）
  const b3LineGoneWithin5s = async (label) => {
    const t0 = Date.now();
    const gone = await waitUntil(
      state.c,
      `!document.getElementById('pet-bubble').classList.contains('show')`,
      5_000,
    ).catch(() => false);
    r.info(`${label} 到气泡收起（轮询）`, `${Date.now() - t0}ms · ${gone ? "5s 内收起" : "5s 未收起"}`);
    r.check(`${label}：常驻行在 5s 内被摘掉`, true, gone);
  };
  const b3Activate = (id) =>
    state.c.ev(`(async () => {
      const rt = await import('/src/runtime/plugin-runtime.ts');
      const ms = await window.__TAURI_INTERNALS__.invoke('plugins_list');
      await rt.activatePlugin(ms.find((m) => m.id === ${JSON.stringify(id)}));
      return true;
    })()`);

  // ① 重载（停用 + 装回同一份 manifest）：旧行必须摘掉；装回后仍能重新挂（授权不因重载丢失）
  await statusCall(STATUS_B, "set", "B行4");
  await b3Deactivate(STATUS_B);
  await b3Activate(STATUS_B);
  await b3LineGoneWithin5s("重载 B 后（旧行）");
  const b3ReloadedSet = await statusCall(STATUS_B, "set", "B行5");
  r.check(
    "重载 B 之后还能重新挂行（授权未因重载丢失）",
    "true|B行5",
    [b3ReloadedSet.ok === true, (await bubbleNow()).text].join("|"),
  );

  // 「卸载」在宠物窗这一侧没有独立代码路径：启停清单的写入口只对设置窗开放 —— 卸载的下线回收
  // 同样走 deactivate/terminate 那条（已在上面「停用」实测），故这里只把门禁本身钉住，不另造伪路径。
  const b3ListWrite = await state.c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    try { await rt.setEnabledIds(rt.getEnabled()); return "放行"; } catch (e) { return String(e && e.message ? e.message : e); }
  })()`);
  r.check("启停清单只能由设置窗改（宠物窗写被拒，故「卸载」不在此处另造路径）", true, /只有设置窗/.test(b3ListWrite));

  // ③ Worker 崩溃：探针主动抛未捕获错误 → 宿主 onerror 那条兜底得把行摘掉。
  // 真崩必然产生两条 console 记录（宿主 [worker-host] + Worker 侧 Uncaught），两条都点名本探针，
  // 故这里按探针名过滤（verify-worker.mjs 的零噪音门同口径，B03 获批）。
  await statusCall(STATUS_B, "set", "B行6");
  await statusCall(STATUS_B, "boom");
  await b3LineGoneWithin5s("Worker 崩溃后");

  // 收尾：先真的下线两个状态探针，再改回原清单、撤销授权。fixture 目录**留到 finally 再删** ——
  // 组尾就删会让超时调用的迟到回包变成 `bus relay failed: … 没有安装`（verify:worker 的零噪音门会红）。
  await b3Deactivate(STATUS_A);
  await b3Deactivate(STATUS_B);
  await setEnabled(enabledBeforeB3);
  for (const id of [STATUS_A, STATUS_B]) {
    await revoke(id);
  }

  logConsoleLedger("after B3");
  // 窗口 C：触发=B3 组全流程（含撤权、停用回收、Worker 崩溃探针）；
  // 发射点=doActivate 277-282（缺权限被拒）与 doDeactivate 322/339；
  // 期望=0；理由=B3 的撤权走直接 permission_request，停用回收不报错；
  // 故意的 `B3 崩溃探针` 不含 plugin-runtime.ts:166，不混入切片。
  const b3Noise = consoleWindow(b3WindowStart, [STATUS_A, STATUS_B]);
  r.check("窗口 C：zz.status/zz.status2 console=0（B3 组切片）", 0, b3Noise.length);

  // ---------- ADR-0013 判据 1–11：直接对宿主发 permission_request ----------
}
