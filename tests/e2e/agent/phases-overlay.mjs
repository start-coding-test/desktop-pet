// 悬浮窗、隐身、数据形状、限频与 hook 调用面（原 807-1220）
// 由 tests/e2e/verify-agent-bridge.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openSettingsInvoker, readEnabledIds, reconcilePetWindow, waitUntil, writeEnabledIds } from "../harness/cdp.mjs";
import { AGENT_ID, E2E_DIR, PET_WINDOW_LABEL, PLUGINS_DIR, PORT, PROBE_ID, sleep } from "./env.mjs";
import { emitPhase } from "./session.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseOverlay(state) {
  const r = state.r;
  const invoke = state.invoke;
  const overlayLabelFor = state.overlayLabelFor;
  const OVERLAY_LABEL = state.OVERLAY_LABEL;
  const withOverlayPageFor = state.withOverlayPageFor;
  const overlayPagePresent = state.overlayPagePresent;
  const agentInOverlayTable = state.agentInOverlayTable;
  const lastView = state.lastView;
  const ourLastLine = state.ourLastLine;
  const ourStatusCalls = state.ourStatusCalls;
  const bubbleNow = state.bubbleNow;
  const bubbleVsOurs = state.bubbleVsOurs;
  const waitStatusSlot = state.waitStatusSlot;
  const waitOurClear = state.waitOurClear;
  r.group("悬浮窗按插件分开：心率那扇照旧，本插件一扇都不开");
  const HR_ID = "com.pet.hr-ble";
  const HR_LABEL = overlayLabelFor(HR_ID);
  // 页面侧取证要求心率真在跑：overlay 页的 sync 会自我关闭「不在启停清单里」的插件的窗
  // （上一轮 3&4 两条红就是取到 null —— 窗在、坐标对，页面不在）。isolation 那组在开窗前也有
  // 同样一段 owner 前置。这里临时把它加进清单，组尾摘掉，finally 再按 origEnabled 兜一次。
  state.hrTempEnabled = true;
  await writeEnabledIds(state.settings.invoke, [...new Set([...state.origEnabled, AGENT_ID, PROBE_ID, HR_ID])]);
  // 从设置窗写的清单不会自己通知宠物窗（harness 的 reconcilePetWindow 就是补这一步的既有入口，
  // 它内部按 enabled 逐个 activate/deactivate）；不 reconcile，心率插件在本窗根本没跑起来。
  await reconcilePetWindow(state.c);
  r.check("前置：心率插件已临时进启停清单（它的 overlay 页才不会自我关闭）", true, (await readEnabledIds(invoke)).includes(HR_ID));
  // 直接打宿主命令：验的是「窗口按插件分开」这条宿主规则本身，不依赖蓝牙硬件。
  // S3 之后 overlay_* 在 Rust 侧查 overlay 授权，先走真实同意框把能力要到。
  // permission_request 会阻塞到有人应答，而 CDP 的 evaluate 有 20 秒硬超时 ——
  // 所以不等它的返回，弹框交给整轮在跑的 consentPump，这里只轮询授权表。
  invoke("permission_request", {
    pluginId: HR_ID,
    capabilities: ["overlay"],
  }).catch(() => undefined);
  let overlayGranted = false;
  for (let i = 0; i < 40 && !overlayGranted; i++) {
    const list = await state.settings.invoke("permission_list");
    overlayGranted = (list.v?.[HR_ID] ?? []).includes("overlay");
    if (!overlayGranted) await sleep(500);
  }
  r.check("心率插件经同意框拿到 overlay 授权", true, overlayGranted);
  // ADR-0010 决策 3：「宠物头顶」那一档已删 —— 宿主接受 placement 并忽略，落点回到缺省 (24,24)。
  // 原来这条的夹具是本插件的状态卡（插件自己传 above-pet），A9b 之后卡片没了：
  // 实质（宿主对废弃入参的处理）一个字没变，夹具换成心率的窗，由测试直接打宿主命令。
  const dpr = Number(await state.c.ev("window.devicePixelRatio")) || 1;
  await invoke("overlay_show", { pluginId: HR_ID, placement: "above-pet", height: 200 });
  const hrDefault = await invoke("plugin:window|outer_position", { label: HR_LABEL });
  r.check(
    "传 above-pet 不报错且落回宿主缺省坐标（头顶档已废弃）",
    true,
    Math.abs((hrDefault.v?.x ?? 1e9) - 24 * dpr) <= 6 && Math.abs((hrDefault.v?.y ?? 1e9) - 24 * dpr) <= 6,
  );
  // 同一扇**已存在**的窗再 show 一次并带新坐标：钉 U01 补的「已存在窗也要按新坐标重定位」，
  // 否则「插件改了位置再显示」只在第一次建窗生效
  await invoke("overlay_show", { pluginId: HR_ID, x: 520, y: 260, height: 104 });
  const hrMoved = await invoke("plugin:window|outer_position", { label: HR_LABEL });
  r.check(
    "已存在的窗按新请求坐标重定位（outer_position 是物理像素，按 dpr 换算）",
    true,
    Math.abs((hrMoved.v?.x ?? 1e9) - 520 * dpr) <= 6 && Math.abs((hrMoved.v?.y ?? 1e9) - 260 * dpr) <= 6,
  );
  // 原「两扇窗的位置不是同一个点」的实质是「两次请求落到两个点，宿主不把它们并成一个」。
  // 夹具从「agent 卡 + 心率」换成「同一扇心率窗的两次请求」：可比的两点还在，判据不降级。
  r.check(
    "两次请求的两个落点不是同一个点",
    true,
    !!hrDefault.v && !!hrMoved.v && JSON.stringify(hrDefault.v) !== JSON.stringify(hrMoved.v),
  );
  // 页面侧再对一次坐标：window.screenX/screenY 是 CSS（逻辑）像素，与上面那条物理像素的
  // outer_position 互为独立证据（同一 DPI 前提下不需要额外 capability）。
  // 页面可能刚被 reconcile 起来，用有界轮询等它可连（沿用本套件既有 overlayMounted 的轮询写法）；
  // 取不到就直接红在下一条前置上，不许让下面两条判据拿 null 空判（上一轮就是这么红得莫名其妙）。
  let hrGeo = null;
  for (let i = 0; i < 20 && !hrGeo; i++) {
    hrGeo = await withOverlayPageFor(HR_ID, (oc) =>
      oc.ev(`[window.screenX, window.screenY, window.outerWidth, window.outerHeight]`),
    );
    if (!hrGeo) await sleep(500);
  }
  r.check("前置：心率那扇 overlay 页可连（取不到页面就直接红，不让下面两条空判）", true, !!hrGeo);
  r.check(
    "窗按请求坐标落座（逻辑像素不经换算就是 screenX/screenY）",
    true,
    !!hrGeo && Math.abs(hrGeo[0] - 520) <= 6 && Math.abs(hrGeo[1] - 260) <= 6,
  );
  // 原「卡片宽度明显小于左上角整屏」的实质是「不给桌面蒙一块大板」。窗还在（心率那扇），
  // 这条宿主侧事实照判；本插件那一侧的同一实质搬到字数上限（下面两条 + 纯函数那组）
  r.check("心率那扇宽度明显小于整屏（不占满桌面的实质仍在窗口这一侧）", true, !!hrGeo && hrGeo[2] <= 360);

  // A9b 的反向判据：本插件不再开任何悬浮窗。三条互相独立的证据 —— 授权表、宿主的 overlay
  // 登记表、CDP 的页面列表。只判「看不见」会被「建了但收起」糊过去，所以三条都判存在性。
  const agentGrants = (await state.settings.invoke("permission_list")).v?.[AGENT_ID] ?? [];
  r.check("本插件的授权表里没有 overlay（能力已从 manifest 收回）", false, agentGrants.includes("overlay"));
  r.check("宿主的 overlay 登记表里根本没有本插件这一条", false, await agentInOverlayTable());
  r.check("CDP 页面列表里没有本插件的 overlay 页", false, await overlayPagePresent());
  // 第四路：按标签直接问窗口。曾经的卡那扇应当「查无此窗」，而不是「有窗但收起」——
  // 后者正是「代码不再调用但窗还留着」这种实现能蒙过去的地方
  const ghostWindow = await invoke("plugin:window|is_visible", { label: OVERLAY_LABEL });
  r.check("按标签查本插件那扇窗：查无此窗", false, ghostWindow.ok === true && ghostWindow.v === true);
  const pluginSrcFiles = ["index.js", "widget.js", "status-line.js"];
  // 口径（A04-D9 第 3 条）：**先剥注释**再对三份源码测 `/overlay/i` —— 代码里任何 overlay 字样仍然会红，
  // 而写在注释里那些「overlay 状态卡已删」的说明文字不算。上一轮这条红就是被自己的注释咬到的。
  // 剥法只处理成行注释与块注释（本插件的注释都是整行的）；不做词法分析，所以宁可少剥不可多剥：
  // 少剥只会把代码里的字样判成红（严），多剥才会放过残留（松）。
  const stripComments = (s) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
  state.stripComments = stripComments;
  const codeOnly = pluginSrcFiles
    .map((f) => stripComments(readFileSync(join(PLUGINS_DIR, AGENT_ID, f), "utf8")))
    .join("\n");
  r.check("插件代码（剥掉注释后）里不再出现 overlay 字样", false, /overlay/i.test(codeOnly));
  // 补充判据（不替换上面那条）：调用面一个都不许留 —— API、三个宿主命令、以及 "overlay" 这个区名。
  // A07 追加后三项（表内追加，判据名与期望值不变）：A04 批 1 的 M3a 写的是可选链
  // `await ctx?.overlay?.show?.({…})`，老的六项 needle 全都不含可选链写法 ⇒ 那条判据当年是绿的
  // （A04-D14 因此只能按「1/2 条静态判据红」裁定）。补上三种可选链写法后，同一变异两条静态判据都红。
  r.check(
    "插件代码里没有任何 overlay 调用面（API / 三个宿主命令 / overlay 区名）",
    [],
    [
      "ctx.overlay",
      "overlay_show",
      "overlay_destroy",
      "overlay_list",
      'region === "overlay"',
      "'overlay'",
      "ctx?.overlay",
      "overlay?.show",
      "?.show?.?",
    ].filter((needle) => codeOnly.includes(needle)),
  );

  r.group("销毁别人那扇窗，不影响本插件的常驻行");
  const beforeDestroy = await bubbleVsOurs();
  // 前置带**长度**判断（A04-D7 第 1 条）：只判 `!== null` 的话，万一记录点收进了被 reject 的
  // 空串，两边都是空串就恒等 —— 那条比较就成了空判。桥目前清洗后为空会先抛（见结果文件里的
  // 说明），这条是把「不依赖那个实现细节」写死在判据里。
  r.check(
    "前置：销毁之前本插件确实挂着一条非空的常驻行（且就显示在气泡上）",
    true,
    typeof beforeDestroy.last === "string" && beforeDestroy.last.length > 0 && beforeDestroy.text === beforeDestroy.last,
  );
  await invoke("overlay_destroy", { pluginId: HR_ID });
  r.check("心率的窗确实被收掉了", true, await waitUntil(state.c, `(async () => { const l = await window.__TAURI_INTERNALS__.invoke('overlay_list'); return !l.some(([id, visible]) => id === ${JSON.stringify(HR_ID)} && visible); })()`, 12_000));
  await waitStatusSlot();
  const afterDestroy = await bubbleVsOurs();
  r.check("销毁只收掉那一扇，本插件的常驻行不受影响", true, afterDestroy.show === true && afterDestroy.status === true && afterDestroy.text === beforeDestroy.last);

  /** 宠物窗的可见性：轮询到想要的那一侧（本套件的既有做法，不拿固定 sleep 当判据） */
  const petVisible = async (want, timeoutMs = 8_000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const v = await invoke("plugin:window|is_visible", { label: PET_WINDOW_LABEL });
      if (v.ok && v.v === want) return true;
      await sleep(300);
    }
    return false;
  };

  /** 本插件被 activate 过几次：`activate()` 尾巴上那句状态文案是唯一痕迹
   *  （`index.js` 的 `status("已接管宿主 Agent 事件")` 走 `${PID}:status`，被 __topics 记着）。
   *  隐身那条计数判据的前提是「这段时间里插件没被停用/重启过」—— 光看 setStatus 只盖住了停用
   *  （deactivate 会送一次 null），重启不留痕迹，所以得单独数 activate。 */
  const activateCount = () =>
    state.c.ev(`window.__topics.filter(([k, p]) => k === 'status' && String(p?.text ?? '').includes('已接管')).length`);
  const isActiveNow = () =>
    state.c.ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); return rt.isActive(${JSON.stringify(AGENT_ID)}); })()`);

  r.group("游戏模式隐身：常驻行跟着宠物窗看不见，恢复后按当前状态回来");
  // 隐身的实质（原「卡片一起收掉」）在新接口下 = 「这一行此刻看不见」。
  // 信号只有一处是真的：隐身走整扇窗 hide（src-tauri/src/window/pet.rs 的 set_pet_hidden），
  // 气泡 DOM 的 CSS 可见性在隐身期间**不变化** —— 判 DOM 可见性会结构性地红。
  // document.visibilityState 只取证不判定（没在 runner 上验过的信号不下注）。
  // 先补一条事件：前面几组花掉的时间可能已经让宿主的会话表把这条会话过期掉（过期 = idle = 行被清），
  // 那时候下面判的就不是「隐身不打扰」，而是「压根没东西可藏」。
  emitPhase("pre", { tool_name: "Bash" });
  r.check(
    "前置：本插件手上有一条非空的常驻行",
    true,
    await waitUntil(
      state.c,
      `(() => { const s = window.__pet.status; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) return typeof s[i][1] === 'string' && s[i][1].length > 0; return false; })()`,
      10_000,
    ),
  );
  r.check("前置：隐身之前宠物窗自己是可见的（否则下面两条是空判）", true, await petVisible(true));
  await waitStatusSlot();
  const preHide = await bubbleVsOurs();
  r.check("前置：隐身之前气泡上就是本插件那一行", true, preHide.last !== null && preHide.text === preHide.last);
  const lineForStealth = preHide.last;
  const callsBeforeHide = await ourStatusCalls();
  const activatesBeforeHide = await activateCount();
  state.petHidden = true;
  await invoke("set_pet_hidden", { hidden: true });
  r.check("隐身时宠物窗不可见（常驻行挂在它身上，因此一并看不见）", true, await petVisible(false));
  r.info("隐身期间的 document.visibilityState（只取证）", String(await state.c.ev("document.visibilityState ?? ''")));
  // 先钉前提再下结论（PM 的 A04-D4 第 2 条 + A04-D5 的补两条）：下面那条计数判据要成立，
  // 隐身窗口里本插件必须既没被停用也没被重启，而且数 activate 的那个计数器本身得是活的。
  // isActive 在窗口**起点和终点各采一次**：只采终点的话，「中途被停用又启回来」这条路径看不见。
  r.check("前提：隐身窗口起点本插件仍在运行（isActive 为 true）", true, await isActiveNow());
  r.check("前提：activate 计数器是活的（截至隐身起点已激活 ≥1 次，否则「次数没涨」是空判）", true, activatesBeforeHide >= 1);
  r.check(
    "隐身期间插件没有自己实现隐身逻辑：setStatus 调用数一条不多",
    callsBeforeHide,
    await ourStatusCalls(),
  );
  r.check("前提：隐身期间本插件没有被重新 activate 过（activate 次数没涨）", activatesBeforeHide, await activateCount());
  r.check("前提：隐身窗口终点本插件仍在运行（isActive 为 true）", true, await isActiveNow());
  // 恢复：无论上面判成什么样都必须放回来，中途抛错也别让宠物一直隐身（外层 finally 兜底）
  await invoke("set_pet_hidden", { hidden: false });
  state.petHidden = false;
  r.check("恢复后宠物窗可见", true, await petVisible(true));
  await waitStatusSlot();
  const back = await bubbleNow();
  r.check("恢复后气泡显示的就是本插件那一行（按当前状态回来）", lineForStealth, back.text);
  r.check("恢复后这一行仍是单行化显示（.status 在）", true, back.show === true && back.status === true);

  r.group("常驻行与 badge 的数据形状：状态、中文标签、步数在里面，工具名进文案吗");
  const viewOff = await lastView();
  r.check("数据含执行中状态", "running", viewOff?.state);
  r.check("数据含中文标签", "正在执行", viewOff?.label);
  r.check("数据含步数且至少 1", true, (viewOff?.steps ?? 0) >= 1);
  r.check("badge 仍然拿得到工具名（只有常驻行的文案不放它）", "Bash", viewOff?.toolName);
  r.check(
    "常驻行文本里没有工具名（20 码点预算换掉的，见映射表）",
    false,
    String((await ourLastLine()) ?? "").includes("Bash"),
  );
  // 原「默认不下发会话标题/命令内容」的实质搬到「这两个字段压根不存在」+ 上面那组不含 abc123
  r.check("数据里不存在 title 键", false, Object.keys(viewOff ?? {}).includes("title"));
  r.check("数据里不存在 detail 键", false, Object.keys(viewOff ?? {}).includes("detail"));
  r.check(
    "常驻行不超预算（≤20 码点，按码点算）",
    true,
    [...String((await ourLastLine()) ?? "")].length <= 20,
  );

  r.group("限频：同状态下多次工具调用只戳宿主一次量级");
  const callsBeforeBurst = await ourStatusCalls();
  for (const [phase, tool] of [["pre", "Edit"], ["post", "Edit"], ["pre", "Grep"], ["post", "Grep"], ["pre", "Bash"]]) {
    emitPhase(phase, { tool_name: tool });
    await sleep(120);
  }
  await sleep(1_600); // 越过 1 秒窗口，让合并的那次也发出来
  const burstCalls = (await ourStatusCalls()) - callsBeforeBurst;
  // 上限给到 3 而不是 2：这 5 条事件里宿主随时可能翻一次总状态，那是一次**该发**的即时调用，
  // 不该被判成刷屏。去掉限频（M4b）会直接冲到 5～6 次，照样红 —— 容忍一格不削弱它对变异的杀伤。
  r.check(
    "5 次同类事件的新增调用 ≤3（合并生效；去掉合并就是 5～6 次）",
    true,
    burstCalls > 0 && burstCalls <= 3,
  );
  r.check("合并之后下发给 widget 的仍是最新步数", true, (await lastView())?.steps >= 1);

  // 下面两组是 Node 侧的纯函数判据：不开窗口、不占 CDP、不赌机器快慢。
  // 为什么放在这个套件里而不是 tests/unit/：`tests/unit/` 不在 A04 的允许写入路径内，
  // 而这两组判据是**插件自己的**文案与节流口径，跟着插件走同样能反复跑。
  r.group("常驻行文案：码点预算逐档（纯函数）");
  const SL = await import(pathToFileURL(join(PLUGINS_DIR, AGENT_ID, "status-line.js")).href);
  const cps = (s) => [...String(s ?? "")].length;
  // 宿主输入侧也有一把 20 的尺（bridge.ts 的 STATUS_MAX_CHARS）。两把尺不同值 = 插件算好的行
  // 到了宿主那里又被裁一刀，裁出来的就是看不懂的半截 —— 这条钉住两个常数同源。
  const hostCap = (() => {
    const src = readFileSync(resolve(E2E_DIR, "../../src/runtime/bridge.ts"), "utf8");
    const m = /STATUS_MAX_CHARS\s*=\s*(\d+)/.exec(src);
    return m ? Number(m[1]) : null;
  })();
  r.check("插件侧预算与宿主的截断常量同值", hostCap, SL.MAX_CODEPOINTS);
  r.check("短名带步数：整行放得下", "Qoder · 正在执行 · 12步", SL.statusLine({ agent: "Qoder", label: "正在执行", steps: 12 }));
  r.check("长名带步数：整段丢掉步数，绝不裁半个词", "WorkBuddy · 等你确认", SL.statusLine({ agent: "WorkBuddy", label: "等你确认", steps: 128 }));
  r.check("恰好 20 码点这一档保留步数", "ABCDEFGH · 正在执行 · 5步", SL.statusLine({ agent: "ABCDEFGH", label: "正在执行", steps: 5 }));
  r.check("边界那一档确实是 20（不是 19 也不是 21）", 20, cps(SL.statusLine({ agent: "ABCDEFGH", label: "正在执行", steps: 5 })));
  r.check("再多一个码点就装不下：丢的是步数段", "ABCDEFGHI · 正在执行", SL.statusLine({ agent: "ABCDEFGHI", label: "正在执行", steps: 5 }));
  r.check("名字加标签本身就超限时退化成只显示标签", "正在执行 · 5步", SL.statusLine({ agent: "N".repeat(20), label: "正在执行", steps: 5 }));
  r.check("没有标签就没有这一行（调用方据此清掉自己那条）", null, SL.statusLine({ agent: "Qoder", label: "", steps: 3 }));
  r.check("步数为 0 / 负 / 非数时不带步数段", "Qoder · 待命", SL.statusLine({ agent: "Qoder", label: "待命", steps: 0 }));
  r.check("步数非数也不带", "Qoder · 待命", SL.statusLine({ agent: "Qoder", label: "待命", steps: "12" }));
  r.check("按码点计数，不是 UTF-16 长度", 2, SL.codepoints("🐱🐱"));
  r.check("宽字符那一档整行仍不超预算", true, cps(SL.statusLine({ agent: "🐱".repeat(12), label: "正在执行", steps: 9 })) <= 20);
  r.check("含代理对时按码点算才会留得下（length 会多算）", true, "🐱🐱".length === 4 && SL.codepoints("🐱🐱") === 2);

  r.group("限频器：手动时钟逐档（不 sleep）");
  const mkPacer = () => {
    const sent = [];
    const jobs = [];
    let t = 0;
    const p = SL.createStatusPacer({
      now: () => t,
      send: (x) => sent.push([t, x]),
      schedule: (fn, ms) => {
        const j = { fn, at: t + ms, done: false, dead: false };
        jobs.push(j);
        return () => {
          j.dead = true;
        };
      },
    });
    return {
      p,
      sent,
      tick: (ms) => {
        t += ms;
      },
      fire: () => {
        const j = jobs.find((x) => !x.done && !x.dead);
        if (!j) return null;
        j.done = true;
        t = j.at;
        j.fn();
        return j.at;
      },
    };
  };
  {
    const h = mkPacer();
    h.p.set("A");
    r.check("第一次变化立刻发出去", "0|A", `${h.sent[0]?.[0]}|${h.sent[0]?.[1]}`);
    h.p.set("A");
    h.p.set("A");
    r.check("内容没变就不戳宿主（当场不多发）", 1, h.sent.length);
    // 只判当场数量是不够的：早退被删掉时，重复的 set 只是把值塞进待发，到点才多发一条。
    // 到点这一枪必须开 —— 没有作业被排上，`fire()` 就该回 null。
    r.check("内容没变就不戳宿主（去变化判断的杀手：到点也不得多发一条）", null, h.fire());
    h.tick(200);
    h.p.set("B");
    h.tick(200);
    h.p.set("C");
    r.check("1 秒窗口内的两次变化当场都不发（去限频的杀手）", 1, h.sent.length);
    const at = h.fire();
    r.check("窗口到点只发最后一次", "1000|C", `${at}|${h.sent[1]?.[1]}`);
    r.check("延迟按「上次发出 + gap」算，不给每次变化重起一圈", 800, at - 200);
    r.check("整段一共只发两次：一次即时 + 一次合并（精确次数，不是判 ≤）", 2, h.sent.length);
    r.check("到点之后没有第二条待发的", null, h.fire());
  }
  {
    const h = mkPacer();
    h.p.set("A");
    h.tick(300);
    h.p.set("B"); // 落在窗口里，待发
    h.tick(100);
    h.p.set("C", { immediate: true }); // 状态翻转：立刻发，不等窗口
    r.check("状态翻转无条件立刻发（PM 口径：立刻且带最新步数）", "C", h.sent[1]?.[1]);
    r.check("翻转把待发的尾巴作废了，到点不多发一条", null, h.fire());
  }
  {
    const h = mkPacer();
    h.p.set("A");
    h.tick(200);
    h.p.set(null); // 清除落在窗口内
    const at = h.fire();
    r.check("清除（null）落在窗口里也要到点发出去", null, h.sent[1]?.[1]);
    r.check("那条清除发在窗口终点而不是拖到下一次", 1000, at);
  }
  {
    const h = mkPacer();
    h.p.set("A");
    h.tick(200);
    h.p.set("B");
    h.tick(300);
    h.p.set("A"); // 与上一次**实际发出**的内容相同 → 早退，不许借此把窗口拉长
    const at = h.fire();
    r.check("同内容的迟到 set 不改写窗口里待发的那一条", "B", h.sent[1]?.[1]);
    r.check("窗口也没有被它重新拉长（仍在 1000 那一刻发）", 1000, at);
  }
  {
    const h = mkPacer();
    h.p.set("A");
    h.tick(200);
    h.p.set("B");
    h.p.stop(); // 插件停用：尾巴丢掉
    r.check("停用之后没发出去的尾巴不再戳宿主", null, h.fire());
    r.check("停用时只发过那一条", 1, h.sent.length);
  }

  r.group("会话结束后回落 idle");
  const lineAtEnd = await ourLastLine();
  emitPhase("session-end", { session_id: "verify-sess" });
  r.check(
    "宿主广播了 idle",
    true,
    await waitUntil(state.c, `(window.__topics.slice().reverse().some(([k,p]) => k === 'host-state' && p.state === 'idle'))`, 25_000),
  );
  r.check("会话结束后常驻行清成 null（只清自己那条）", true, await waitOurClear(15_000));
  await waitStatusSlot();
  const endBubble = await bubbleNow();
  r.check("清除之后气泡上不再挂着本插件那一行", false, endBubble.show === true && endBubble.text === lineAtEnd);

  r.group("hook 命令的调用面：宠物窗被拒，宿主路径（设置窗）放行");
  const status = await invoke("agent_hooks_status");
  r.check("宠物窗（主 realm）调用被拒", false, status.ok);
  r.info("拒绝原因", String(status.e ?? "").slice(0, 60));
  // B2 迁移：声明 agent:hooks 的插件设置页（settings 区）经能力校验后才放行 ——
  // 那条链路（同意框、badge/overlay 区取不到 host、撤销两分支）在 verify-isolation 里断言；
  // 这里钉住反向：从宠物窗绕过桥直接 invoke，带不带 pluginId 都被窗口门禁挡住。
  const petInstall = await invoke("agent_hooks_install", { pluginId: AGENT_ID });
  r.check("宠物窗带 pluginId 直接 invoke install 也被拒（label 决定，不是能力决定）", false, petInstall.ok);
  if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c);
  const hostStatus = await state.settings.invoke("agent_hooks_status");
  r.check("宿主路径（设置窗、不带 pluginId）照旧可用", true, hostStatus.ok === true);
  r.check("宿主 status 回显含配置文件列表", true, Array.isArray(hostStatus.v?.files));

  // closed Shadow DOM 里的元素从外面查不到：按 verify-astock 的既有做法，从 widgetHost.mounted
  // 取挂载记录、用它捕获的 shadow 引用操作（都在页面内求值，走真实点击路径）。
  // 定义在外层：④ 那组（安装/卸载/启停）和 ⑨ 的「四选一」都要用，抄两份就会各漂各的。
  const recExpr = `((await import('/src/runtime/widget-host.ts')).widgetHost.mounted.get(${JSON.stringify(AGENT_ID)}) ?? []).find((r) => r.host.dataset.region === "settings")`;
  state.recExpr = recExpr;
  const stateExpr = (want) =>
    `(async () => { const rec = ${recExpr}; return !!rec && rec.shadow.querySelector('.hk-status')?.dataset.state === ${JSON.stringify(want)}; })()`;
  state.stateExpr = stateExpr;
  const clickShadow = async (selector, label) => {
    const ok = await waitUntil(
      state.settings.client,
      `(async () => { const rec = ${recExpr}; return !!rec?.shadow?.querySelector(${JSON.stringify(selector)}); })()`,
      15_000,
    );
    r.check(label, true, ok);
    if (ok) {
      await state.settings.client.ev(`(async () => {
        const rec = ${recExpr};
        rec.shadow.querySelector(${JSON.stringify(selector)}).click();
        return true;
      })()`);
    }
    return ok;
  };
  state.clickShadow = clickShadow;
  const statusText = () =>
    state.settings.client.ev(`(async () => { const rec = ${recExpr}; return rec ? rec.shadow.querySelector('.hk-status')?.textContent ?? '' : ''; })()`);
  state.statusText = statusText;

}
