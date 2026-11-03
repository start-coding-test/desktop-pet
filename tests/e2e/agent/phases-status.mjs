// 上线授权、状态机四态、陈旧 counter、failed 与隐私（原 542-806）
// 由 tests/e2e/verify-agent-bridge.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { openSettingsInvoker, waitUntil } from "../harness/cdp.mjs";
import { AGENT_ID, PORT, sleep } from "./env.mjs";
import { emitPhase } from "./session.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseStatus(state) {
  const r = state.r;
  const invoke = state.invoke;
  const lastView = state.lastView;
  const seededBytes = state.seededBytes;
  const acts = state.acts;
  const said = state.said;
  const statusLog = state.statusLog;
  const ourLastLine = state.ourLastLine;
  const ourStatusCalls = state.ourStatusCalls;
  const bubbleVsOurs = state.bubbleVsOurs;
  const waitStatusSlot = state.waitStatusSlot;
  const restartPlugin = state.restartPlugin;
  const awaitGranted = state.awaitGranted;
  r.group("插件上线与授权");
  // 撤销授权、读授权表都是「只认设置窗」的命令，先有设置窗的命令通道（上面启用时已经开过）
  if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c);
  const fromPet = await invoke("permission_list");
  r.check("宠物窗读授权表被门禁拒绝", true, !fromPet.ok && /设置窗/.test(String(fromPet.e)));
  r.check("总线授权已就位（activate 时的首次发布）", true, await awaitGranted("bus:publish"));

  r.group("插件不再需要任何网络能力");
  const manifests = await invoke("plugins_list");
  const manifest = manifests.ok ? manifests.v.find((m) => m.id === AGENT_ID) : null;
  r.check("manifest 存在", true, !!manifest);
  r.check("permissions 里没有 http", false, (manifest?.permissions ?? []).includes("http"));
  // A06：这一条钉的是 **manifest 声明侧**（宿主 `plugins_list` 解析出来的那一份），与上面
  // 「授权表里没有 overlay」那条运行时证据分属两层 —— 声明收回了才谈得上不授权。A04 的 M3b 打的就是这里。
  r.check("permissions 里没有 overlay（A9b 已从 manifest 收回）", false, (manifest?.permissions ?? []).includes("overlay"));

  r.group("running：工具调用 → petdex 的 running");
  emitPhase("pre", { tool_name: "Bash" });
  r.check("首次插播状态触发授权", true, await awaitGranted("pet:react", 30_000));
  r.check("宠物收到 running", true, await waitUntil(state.c, `window.__pet.acts.includes('running')`, 8_000));
  r.check("running 时不作声", [], await said());
  r.check(
    "宿主广播了 agent:state=running",
    true,
    await waitUntil(state.c, `(window.__topics.slice().some(([k,p]) => k === 'host-state' && p.state === 'running'))`, 5_000),
  );

  r.group("细粒度：只读工具走 review，工具间隙不闪回 idle");
  const beforeBurst = (await acts()).length;
  for (const [phase, payload] of [["post", { tool_name: "Bash" }], ["pre", { tool_name: "Read" }], ["post", { tool_name: "Read" }]]) {
    emitPhase(phase, payload);
    await sleep(300);
  }
  await sleep(1500);
  const burst = (await acts()).slice(beforeBurst);
  r.check("Read 这类只读工具切到 review", true, burst.includes("review"));
  r.check("会话还在跑时 post 不把姿势打回 idle", false, burst.includes("idle"));

  r.group("needs_input：等确认 → waiting + 说话");
  emitPhase("approval-request", { tool_name: "Bash" });
  r.check("宠物收到 waiting", true, await waitUntil(state.c, `window.__pet.acts.includes('waiting')`, 15_000));
  r.check(
    "台词提示需要确认",
    true,
    await waitUntil(state.c, `window.__pet.said.some(t => t.includes('确认'))`, 15_000),
  );

  r.group("completed：一轮结束 → waving");
  emitPhase("stop", {});
  r.check("宠物收到 waving", true, await waitUntil(state.c, `window.__pet.acts.includes('waving')`, 15_000));

  /** 本插件最后一次被交给本体控制器的值（`null` = 清除；一次都没有 = 那个说明串） */
  const ourTail = async () => {
    const log = await statusLog();
    for (let i = log.length - 1; i >= 0; i--) if (log[i][0] === AGENT_ID) return log[i][1];
    return "(本插件一次都没设过)";
  };
  state.ourTail = ourTail;
  const waitOurClear = (timeoutMs = 9_000) =>
    waitUntil(state.c, `(() => { const s = window.__pet.status; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) return s[i][1] === null; return false; })()`, timeoutMs).catch(() => false);
  state.waitOurClear = waitOurClear;

  r.group("一轮结束：常驻行留一会儿就清掉，陈旧 counter 不再把它点亮");
  emitPhase("post", { tool_name: "Bash" }); // 比 stop 晚到，属于常态
  await sleep(2000);
  r.check(
    "总状态仍是这轮完成",
    "completed",
    await state.c.ev(`(window.__topics.slice().reverse().find(([k]) => k === 'host-state')?.[1].state ?? '')`),
  );
  // 原「卡片 3 秒后自动收起」的实质：这一轮的可见反馈不会永远挂着。卡片没了，
  // 同一实质落在常驻行上 —— 被清成 null（取代者：B3 的清除语义 + 插件的收尾定时器）
  r.check("轮结束后常驻行被清成 null（收起的实质搬到这里）", true, await waitOurClear());
  const nonNullBefore = (await statusLog()).filter(([p, t]) => p === AGENT_ID && t !== null).length;
  // 「迟到的信息不许把已结束的会话重新点亮」这句实质，原来我是靠再发一条 post 来测 —— 错了：
  // 宿主的 `STOP_GRACE` 只有 2 秒（`src-tauri/src/services/agent/state.rs:50`，:165 用它实现
  // 「post 比 stop 晚到属常态，不打回 running」，`grace_tests.rs` 的
  // `straggler_post_does_not_reopen_a_stopped_session` 钉的就是这 2 秒），而本组等「行被清成 null」
  // 已经过了插件收尾的 3 秒 —— 那时再发 post，宿主按设计把它当**新一轮活动**（state_for_event("post")
  // = running，:68-71），插件如实点亮。上面那条 grace 之内的迟到 post 已经把成立的那半句判掉了。
  // 剩下真正属于插件自己的是 `seenCounter` 这道门，而宿主的 counter 单调递增、真实链路造不出回退，
  // 所以用运行时**既有**的注入入口造一条陈旧广播：`src/runtime/event-bus.ts` 的 `inject`
  // （`plugin-runtime.ts:363` 收 Rust 原生事件走的就是它，verify-isolation.mjs 也早已在用）。
  const lastSeenCounter = await state.c.ev(
    `(window.__topics.slice().reverse().find(([k, p]) => k === 'host-state' && typeof p.counter === 'number')?.[1].counter ?? 0)`,
  );
  const injectState = (payload) =>
    state.c.ev(`(async () => { const { bus } = await import('/src/runtime/event-bus.ts'); bus.inject('agent:state', ${JSON.stringify(payload)}); return true; })()`);
  await injectState({ state: "running", counter: lastSeenCounter, steps: 42, agent: "qoder" });
  // 正向对照兼作**屏障**：Worker 的消息是 FIFO，等这条真点亮了，上一条「本该被门吞掉的」也就走完了
  // 整条回路 —— 于是「没点亮」这个结论不靠 sleep 猜时间。（对照会把 seenCounter 抬到
  // lastSeenCounter+1，宿主下一个真实广播正好是这个值 ⇒ 会被吞一次，所以判完立刻清场。）
  await injectState({ state: "needs_input", counter: lastSeenCounter + 1, steps: 77, agent: "qoder" });
  const litUp = await waitUntil(
    state.c,
    `(() => { const s = window.__pet.status; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) return String(s[i][1] ?? '').includes('等你确认'); return false; })()`,
    12_000,
  );
  r.check("对照：同一条通道送来更新的 counter 时确实点亮（证明下一条不是空判，兼作回路屏障）", true, litUp);
  const staleLeaked = (await statusLog()).some(([p, t]) => p === AGENT_ID && String(t ?? "").includes("42步"));
  const grewTo = (await statusLog()).filter(([p, t]) => p === AGENT_ID && t !== null).length;
  r.check(
    "陈旧 counter 的广播被插件自己的门吞掉：记录里没出现过那次注入的 42 步，宿主也只被戳了对照那一次",
    `false|${nonNullBefore + 1}`,
    `${staleLeaked}|${grewTo}`,
  );
  r.info("清场用的 停用→激活 结果", await restartPlugin());

  // A07/M6：上面那组杀不掉「删掉 `seenCounter` 单调门」这个变异（A04 批 1 实测 survived）。
  // 原因有两条，这一组把它们逐一堵死：
  // ① 陈旧那条与插件当时那行文案可能**逐字相同**，于是被限频器自己的相等早退吞掉（`status-line.js` 的
  //    `if (text === lastSent) return;`）⇒ 这里给陈旧那条一个**真实链路造不出来的专属步数 88**，
  //    并先打一条 primer 把 `lastSent` 钉成别的；
  // ② 判据读的是「宿主收到什么」，一旦两条注入都落进同一个 1 秒合并窗口，后写的待发值会盖掉前一条 ⇒
  //    这里靠**开场重启**让 pacer 是新对象（`activate()` 里重建，`lastSentAt = -Infinity`、待发位空），
  //    于是每条被门放行的注入都走 `syncStatus({ immediate: true })` 当场发出（`index.js` 的 onState 末尾），
  //    合并窗口遮不住它 —— 全程不 sleep。
  r.group("陈旧 counter 的广播：即时通路下也被插件自己的门吞掉（A07/M6 补强）");
  const m6Restart = await restartPlugin();
  const m6TailAfterRestart = await state.c.ev(
    `(() => { const s = window.__pet.status; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) return s[i][1] === null; return false; })()`,
  );
  const m6Seen = await state.c.ev(
    `(window.__topics.slice().reverse().find(([k, p]) => k === 'host-state' && typeof p.counter === 'number')?.[1].counter ?? 0)`,
  );
  // primer：把「插件已见过的最大 counter」抬到 m6Seen+1，并把 `lastSent` 钉成一条已知文案，
  // 于是后面那条陈旧注入（同样 counter=m6Seen+1）既会被门判成陈旧、又不会与 lastSent 逐字相等。
  // 它也顺手证明「这个通道此刻能把一条广播送到常驻行上」，所以下面那条对照的红才是判据的红。
  await injectState({ state: "running", counter: m6Seen + 1, steps: 1, agent: "qoder" });
  const m6Primer = await waitUntil(
    state.c,
    `(() => { const s = window.__pet.status; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) return String(s[i][1] ?? '').includes('1步'); return false; })()`,
    12_000,
  );
  r.check(
    "前提：开场重启落定、读到数字 counter、primer 已点亮（即时通路与待发位为空由「刚重建的 pacer」保证）",
    "ok|true|true",
    [String(m6Restart), String(typeof m6Seen === "number"), String(m6Primer === true)].join("|"),
  );
  // 「重启后最后一条是不是清除」不当判据、只当观测：设置页那条 `sync` 会在重新挂载时戳一次
  // `syncStatus({immediate:true})`，那一行落在哪儿是可查的，但不该把下面的计数判据绑死在它上面。
  r.info("M6 开场重启后的尾部状态（观测，不判）", m6TailAfterRestart);
  const m6Mark = await ourStatusCalls();
  // 陈旧：counter 不前进（等于 primer 刚设的上界），但状态翻到 needs_input ⇒ 若门被删，它必然当场发出
  await injectState({ state: "needs_input", counter: m6Seen + 1, steps: 88, agent: "qoder" });
  // 对照：counter 前进一格 ⇒ 必须点亮，兼作 Worker FIFO 的回路屏障（不靠 sleep 证明「上一条已经走完」）
  await injectState({ state: "running", counter: m6Seen + 2, steps: 89, agent: "qoder" });
  const m6LitUp = await waitUntil(
    state.c,
    `(() => { const s = window.__pet.status; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) return String(s[i][1] ?? '').includes('89步'); return false; })()`,
    12_000,
  );
  r.check("对照：同一条通道送来更新的 counter 且状态不同时确实点亮（证明下一条不是空判）", true, m6LitUp);
  const m6Slice = (await statusLog()).slice(m6Mark);
  r.check(
    "陈旧 counter 且状态不同的广播被门吞掉：即时通路下新增恰为对照那一条，切片里从没出现过 88步 与等你确认",
    `false|false|1`,
    [
      String(m6Slice.some(([, t]) => String(t ?? "").includes("88步"))),
      String(m6Slice.some(([, t]) => String(t ?? "").includes("等你确认"))),
      String(m6Slice.filter(([, t]) => t !== null).length),
    ].join("|"),
  );
  r.info("M6 组尾清场用的 停用→激活 结果", await restartPlugin());

  r.group("failed：工具失败 → petdex 的 failed 并带上工具名");
  emitPhase("tool-failure", { tool_name: "cargo test" });
  r.check("宠物收到 failed", true, await waitUntil(state.c, `window.__pet.acts.includes('failed')`, 15_000));
  r.check(
    "台词里带上失败的工具",
    true,
    await waitUntil(state.c, `window.__pet.said.some(t => t.includes('cargo test'))`, 15_000),
  );

  r.group("隐私：会话标题与命令摘要根本不进插件（旧开关预置成「开着」也不生效）");
  const SECRET_TITLE = "把内部口令 abc123 写进配置";
  const SECRET_CMD = "echo abc123-inner-secret";
  // 旧 config 在启用插件之前就预置好了（见上面的 seedLegacyConfig），而且已经让 activate 重读过一次
  emitPhase("user-prompt", { prompt: SECRET_TITLE });
  emitPhase("pre", { tool_name: "Bash", tool_input: { command: SECRET_CMD } });
  r.check(
    "宿主 agent:event 带上命令摘要",
    true,
    await waitUntil(state.c, `(window.__topics.slice().some(([k,p]) => k === 'host-event' && (p.detail ?? '').includes('abc123-inner')))`, 12_000),
  );
  r.check(
    "宿主 agent:event 带上步数",
    true,
    await waitUntil(state.c, `(window.__topics.slice().some(([k,p]) => k === 'host-event' && p.steps >= 1))`, 12_000),
  );
  r.check(
    "会话进行中常驻行挂上了（本插件那条非空）",
    true,
    await waitUntil(state.c, `(() => { const s = window.__pet.status; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) return typeof s[i][1] === 'string' && s[i][1].length > 0; return false; })()`, 12_000),
  );
  await waitStatusSlot(); // 台词（上一轮的「这边需要你确认一下」）会占槽 3.6s，不等就读到的是它
  const on = await bubbleVsOurs();
  r.check(
    "气泡显示的正是本插件最近交给宿主的那一行（同一次求值里读，不赌时序）",
    true,
    on.show === true && on.status === true && typeof on.last === "string" && on.last.length > 0 && on.text === on.last,
  );
  r.check("常驻行不含会话标题那串口令", false, String(on.last ?? "").includes("abc123"));
  r.check("常驻行不含命令摘要那串口令", false, String(on.last ?? "").includes("abc123-inner"));
  const viewOn = await lastView();
  r.check("下发给 badge/设置页的数据里没有 title/detail 字段", [], Object.keys(viewOn ?? {}).filter((k) => k === "title" || k === "detail"));
  r.check("老开关开着也没让那两串进到插件这一层", false, JSON.stringify(viewOn ?? "").includes("abc123"));
  // A07/M1：上面那两条「不含口令」杀不掉「把标题接进状态行」这个变异 —— 隐私组这两条事件
  // （user-prompt / pre）都映射到 running，而 `publish()` 只在**汇总状态变化**时才广播
  // （`src-tauri/src/services/agent/state.rs:232-241`），标题压根没进过插件（A04 的 M1 正是这样活下来的）。
  // 所以这里追加一次**真实状态翻转**再判一遍：`approval-request` 映射 needs_input（同文件 :68-79），
  // 与翻转前的 running 必然不同 ⇒ 一定广播，而广播里带着 `active_summary()` 的 title（:205/:247）。
  const beforeFlip = await ourLastLine();
  const stateBeforeFlip = await state.c.ev(
    `(window.__topics.slice().reverse().find(([k, p]) => k === 'host-state' && typeof p.state === 'string')?.[1].state ?? null)`,
  );
  emitPhase("approval-request", { tool_name: "Bash" });
  const titleBroadcast = await waitUntil(
    state.c,
    `(() => window.__topics.some(([k, p]) => k === 'host-state' && typeof p.title === 'string' && p.title.includes('abc123')))()`,
    12_000,
  );
  r.check(
    "前提：追加一次真实状态翻转后 agent:state 的广播里确实带了那句会话标题（读不到就是空判）",
    // 三件事一起钉：翻转目标状态与翻转前确实不同、广播里读到了带口令的标题、翻转前手上确实挂着一条非空常驻行
    "true|true|true",
    [
      String(stateBeforeFlip !== "needs_input"),
      String(titleBroadcast === true),
      String(typeof beforeFlip === "string" && beforeFlip.length > 0),
    ].join("|"),
  );
  await waitStatusSlot(); // 台词会占槽 3.6s（needs_input 那句「这边需要你确认一下」），不等就读到的是台词
  const onAfterFlip = await bubbleVsOurs();
  r.check(
    "真实状态翻转之后，常驻行仍不含会话标题那串口令",
    false,
    String(onAfterFlip.last ?? "").includes("abc123"),
  );
  r.check(
    "真实状态翻转之后，常驻行仍不含命令摘要那串口令",
    false,
    String(onAfterFlip.last ?? "").includes("abc123-inner"),
  );
  const viewAfterFlip = await lastView();
  r.check(
    "真实状态翻转之后，下发给 badge/设置页的数据里仍不存在 title/detail 键",
    [],
    Object.keys(viewAfterFlip ?? {}).filter((k) => k === "title" || k === "detail"),
  );
  // 组尾把状态轨迹还原成 running（后面几组按 running 走），并清掉 M1 变异可能留下的标题残留。
  // 只做恢复、不新增判据：恢复没落定会被后面那组自己的前置判红，不在这里充数。
  emitPhase("post", { tool_name: "Bash" });
  r.info(
    "M1 组尾恢复到 running 的结果",
    await waitUntil(
      state.c,
      `(() => { const s = window.__pet.status; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) return String(s[i][1] ?? '').includes('正在执行'); return false; })()`,
      12_000,
    ),
  );
  r.check(
    "升级不动用户配置：事件跑完之后存储文件字节一致",
    true,
    state.legacySeed.read() === seededBytes,
  );

}
