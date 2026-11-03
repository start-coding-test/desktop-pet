// hook 接收分支、探针首次调用同意门与启用插件（原 181-541）
// 由 tests/e2e/verify-agent-bridge.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "node:process";
import { attach, hostInvoke, listPages, openSettingsInvoker, readEnabledIds, reloadAndWait, waitUntil, writeEnabledIds } from "../harness/cdp.mjs";
import { AGENT_ID, EXE, INBOX, PORT, PROBE_DIR, PROBE_ID, isPetPage, sleep } from "./env.mjs";
import { emitPhase } from "./session.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseHook(state) {
  const r = state.r;
  if (!existsSync(INBOX)) throw new Error(`收件目录不存在：${INBOX}（宿主没起来？）`);

  // ---------- 0) 探针插件：先落盘再连页面 ----------
  // 照 verify-http.mjs 的做法：先写 index.js、最后才写 manifest.json —— manifest 是宿主认账
  // 的信号，先写它会让 watcher 看到一个入口缺失的半装插件。写完等 watcher 扫到它。
  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(join(PROBE_DIR, "index.js"), "export function activate() {}\nexport function deactivate() {}\n");
  writeFileSync(
    join(PROBE_DIR, "manifest.json"),
    JSON.stringify(
      {
        id: PROBE_ID,
        name: "Agent 授权探针",
        version: "0.0.0",
        entry: "index.js",
        permissions: ["agent:hooks"],
        description: "验证用探针：从设置页走桥调 agentHooks.status()，钉住声明 agent:hooks 的插件首次调用必经同意框。",
      },
      null,
      2,
    ),
  );
  await sleep(1500); // 让 plugins 目录 watcher 扫到它

  // ---------- 1) hook 分支：exe 收 stdin 并落盘 ----------
  r.group("hook 接收分支（起一个真实的 exe --pet-hook）");
  const marker = `hook-probe-${Date.now()}`;
  const before = (() => {
    try {
      return readFileSync(join(INBOX, "pre.jsonl"), "utf8").length;
    } catch {
      return 0;
    }
  })();
  const spawned = spawnSync(EXE, ["--pet-hook", "pre"], {
    input: JSON.stringify({ session_id: marker, tool_name: "Edit" }),
    encoding: "utf8",
    timeout: 15_000,
  });
  r.check("hook 分支退出码为 0", 0, spawned.status);
  const after = (() => {
    try {
      return readFileSync(join(INBOX, "pre.jsonl"), "utf8");
    } catch {
      return "";
    }
  })();
  const appended = after.slice(before).trim().split("\n").filter(Boolean);
  r.check("落盘且只有一行", 1, appended.length);
  const landed = appended.length ? JSON.parse(appended[0]) : {};
  r.check("phase 与 session 正确", [ "pre", marker ], [ landed.phase, landed.payload?.session_id ]);
  const bogus = spawnSync(EXE, ["--pet-hook", "../escape"], { input: "{}", timeout: 15_000 });
  r.check("白名单外的 phase 被拒绝且没建文件", false, existsSync(join(INBOX, "escape.jsonl")) && bogus.status === 0);

  // 清场：上面那些会话会在宿主的活跃表里挂 90 秒，不把总状态压回 idle 的话，
  // 后面「第一个事件应该变 running」这类断言会因为起点就已经是 running 而假失败。
  // 清场：把收件目录里出现过的**所有**会话都结束掉。
  // 装了 hook 之后这台机器是活的 —— 跑这条断言的 agent 自己每次工具调用都在写
  // pre/post，宿主的总状态会一直停在 running，「第一个事件应当变 running」就永远不成立。
  // 脚本运行期间不再有新事件进来（下一次工具调用要等脚本跑完），所以清完就能拿到干净起点。
  for (const phase of ["user-prompt", "pre", "post", "stop", "approval-request"]) {
    let text = "";
    try {
      text = readFileSync(join(INBOX, `${phase}.jsonl`), "utf8");
    } catch {
      continue;
    }
    for (const id of new Set([...text.matchAll(/"session_id":"([^"]+)"/g)].map((m) => m[1]))) {
      appendFileSync(
        join(INBOX, "session-end.jsonl"),
        JSON.stringify({ phase: "session-end", at: Date.now(), payload: { session_id: id } }) + "\n",
      );
    }
  }
  await sleep(2500); // 等 watcher 把这些结束事件吃掉
  emitPhase("session-end", { session_id: "verify-sess" });
  await sleep(1800); // 等 watcher 把这两条吃掉，总状态落回 idle 再往下测

  // ---------- 2) 采集 → 归一化 → 宠物 ----------
  state.c = await attach(PORT, isPetPage);
  const invoke = hostInvoke(state.c);
  state.invoke = invoke;
  state.origEnabled = await readEnabledIds(invoke);
  const token = `agent-${Date.now()}`;
  state.token = token;
  await state.c.ev(`window.__verifyToken = ${JSON.stringify(token)}; true`);
  state.pumpDone = state.consentPump.run(600_000); // 应答窗口必须比整轮长：宿主对同意框有 60 秒超时即视为拒绝 // 宿主对同意框有 60 秒超时即视为拒绝，应答窗口必须比整轮测试更长

  r.group("探针：agent:hooks 首次调用必经同意框（与真实插件的授权状态无关）");
  // 上一轮中途挂掉可能留下探针的残留授权或一扇没点掉的同意框 —— 残留授权会让首次调用
  // 不弹框，开着的老框会被 pump 记到探针头上。起手先排空，并把「排空了」钉成断言。
  if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c);
  const probeCapsInTable = async () => {
    const table = (await state.settings.invoke("permission_list")).v ?? {};
    return Object.entries(table)
      .filter(([id]) => id === PROBE_ID)
      .flatMap(([, caps]) => caps);
  };
  let probeResidual = await probeCapsInTable();
  for (let i = 0; i < 40 && probeResidual.length; i++) {
    await state.settings.invoke("permission_revoke", { pluginId: PROBE_ID }).catch(() => undefined);
    await sleep(250);
    probeResidual = await probeCapsInTable();
  }
  r.check("起手时表里没有探针的残留授权", [], probeResidual);
  let probeConsents = 1;
  for (let i = 0; i < 40; i++) {
    probeConsents = (await listPages(PORT).catch(() => [])).filter((t) => /consent/.test(t.url)).length;
    if (!probeConsents) break;
    await sleep(250);
  }
  r.check("起手时没有还开着的同意框", 0, probeConsents);

  // 授权表是宿主的事实，但 **JS 桥还有一层 `granted` 缓存，按页面文档实例存在**（bridge.ts 的模块级
  // Map）。宿主侧 revoke 掉探针的授权后，同一份设置页文档里的缓存仍然认为它已授权 —— 首调会直接命中
  // 缓存、根本不发 permission_request，于是这条断言变成「设置页自上次授权后重建过没有」的函数。
  // 实测：连跑三次是 绿 / 红 / 绿（红的那一轮复用上一轮的设置页文档）。
  // 这里显式重建一次文档，让缓存回到冷状态，断言才真的只依赖宿主事实。
  await reloadAndWait(state.settings.client);
  await waitUntil(state.settings.client, `!!window.__TAURI_INTERNALS__`, 15_000);

  // 宿主启停门禁：探针先启用（并先移除一次以清旧拒绝锁），否则 permission_request 直接 false。
  {
    const current = await readEnabledIds(invoke);
    const without = current.filter((id) => id !== PROBE_ID);
    await writeEnabledIds(state.settings.invoke, without);
    await writeEnabledIds(state.settings.invoke, [...without, PROBE_ID]);
  }

  // 从设置页 realm 构造探针的 agentHooks 通道再调 status()：agent_hooks_* 带 pluginId 的调用
  // 除设置窗门禁外还要逐项校验 agent:hooks 已授权（commands/agent.rs 的 assert_caller），
  // 而桥在放行前会先 permission_request —— 探针起手必然没授权，所以这扇框必然要弹。
  // 宿主把 agentHooks 注入为 ctx.host 只发生在 widget-host 的 settings 区真实 widget 上；
  // 探针没有 widget，这里直接用 widget-host.ts:97 注入的同一个工厂 createAgentHooksApi。
  const probeStatus = `(async () => {
    const { createAgentHooksApi } = await import('/src/runtime/bridge.ts');
    const api = createAgentHooksApi({ id: ${JSON.stringify(PROBE_ID)}, name: 'Agent 授权探针', permissions: ['agent:hooks'] });
    try { await api.status(); return { ok: true }; } catch (e) { return { ok: false, e: String(e?.message ?? e) }; }
  })()`;
  const probeBoxes = () => state.grantedCaps.filter((x) => x.rendered === true && x.who.includes(PROBE_ID));
  await state.settings.client.ev(probeStatus);
  r.check(
    "探针首次调用弹出的同意框列出了 agent:hooks",
    true,
    probeBoxes().some((x) => x.caps.some((c) => String(c).includes("agent:hooks"))),
  );
  // 把"抢读未渲出的框"从**静默假阴**变成硬失败：pump 现在只在渲出内容后才记账并应答，
  // 4 秒内渲不出会带着 rendered:false 记账（照样应答，免得宿主 60 秒超时误判成拒绝）。
  // 没有这条，将来再出现同类竞态只会表现为"某条断言莫名红一次"，排查成本就是这次的三轮一次。
  r.check(
    "pump 应答过的每一扇同意框都渲出过内容",
    [],
    state.grantedCaps.filter((x) => x.rendered !== true).map((x) => `${x.who || "(空)"}|${x.caps.length}项`),
  );
  // 第二次调用同一条能力：授权已在表里（且桥有会话内缓存），不该再弹框。
  // 按探针自己的框数对比，别的插件 concurrent 弹框不进这条证据。
  const beforeSecond = probeBoxes().length;
  await state.settings.client.ev(probeStatus);
  await sleep(2000); // 若实现错成「每次都弹框」，给泵留出把它记下来的时间
  r.check("同一能力第二次调用不再弹框", beforeSecond, probeBoxes().length);

  /** 悬浮窗标签的编码规则（Tauri 不许点号，id 里的点被编码成 `_`，与 Rust 的 overlay_label 同式）。
   *  A9b 之后本插件**不再有**这一扇窗：这里留着标签式子，是为了把「查不到」判成一个可复核的字符串，
   *  而不是判一个含糊的「少了点什么」。心率那扇仍然要用它。 */
  const overlayLabelFor = (id) => `overlay-${id.replace(/\./g, "_").replace(/[^A-Za-z0-9_-]/g, "-")}`;
  state.overlayLabelFor = overlayLabelFor;
  const OVERLAY_LABEL = overlayLabelFor(AGENT_ID);
  state.OVERLAY_LABEL = OVERLAY_LABEL;
  const OVERLAY_TITLE = `DesktopPet Overlay · ${AGENT_ID}`;
  /** 按插件标题认出某一扇 overlay 页，在它里面跑一段求值；窗不存在返回 null。
   *  （宿主规则原来借本插件的卡当夹具，A9b 之后借心率那扇 —— 换夹具不换实质） */
  async function withOverlayPageFor(pluginId, fn) {
    const wantTitle = `DesktopPet Overlay · ${pluginId}`;
    const target = (await listPages(PORT).catch(() => [])).find(
      (t) => /overlay\.html/.test(t.url) && t.title === wantTitle,
    );
    if (!target) return null;
    const oc = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000).catch(() => null);
    if (!oc) return null;
    try {
      return await fn(oc);
    } finally {
      oc.close();
    }
  }
  state.withOverlayPageFor = withOverlayPageFor;
  const overlayPagePresent = async () =>
    !!(await listPages(PORT).catch(() => [])).find(
      (t) => /overlay\.html/.test(t.url) && t.title === OVERLAY_TITLE,
    );
  state.overlayPagePresent = overlayPagePresent;
  /** 宿主的 overlay 登记表里，本插件是否以「某个窗」的形式存在（不论可见与否） */
  const agentInOverlayTable = async () =>
    state.c.ev(
      `(async () => { try { const l = await window.__TAURI_INTERNALS__.invoke('overlay_list'); return l.some(([id]) => id === ${JSON.stringify(AGENT_ID)}); } catch { return "查询失败"; } })()`,
    );
  state.agentInOverlayTable = agentInOverlayTable;

  /** 最近一次下发给 badge/设置页的数据（A9b 之后这份数据里根本没有标题与命令摘要） */
  async function lastView() {
    const all = await state.c.ev(`window.__topics.slice().filter(([k]) => k === 'view').map(([,p]) => p)`);
    return all.length ? all[all.length - 1] : null;
  }
  state.lastView = lastView;

  /**
   * 预置「升级前把那两只隐私开关打开过」的老用户存储：直接写插件自己的 store.json，
   * 因为 A9b 之后**没有任何代码路径**会替插件写它 —— 通过插件去写等于自己把被测对象改了。
   * 返回 { read, restore }：restore 在 finally 里把文件恢复成本跑之前的样子（原来不存在就删掉）。
   */
  function seedLegacyConfig(showTitle, showDetail) {
    const file = join(env.APPDATA, "com.desktoppet.pet", "plugins", AGENT_ID, "store.json");
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    let map;
    if (before === null) {
      map = {};
    } else {
      try {
        map = JSON.parse(before);
      } catch {
        throw new Error(`插件存储不是合法 JSON，拒绝在脏环境上预置：${file}`);
      }
    }
    map.config = { showTitle, showDetail };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(map, null, 2));
    return {
      read: () => (existsSync(file) ? readFileSync(file, "utf8") : null),
      restore: () => {
        if (before === null) rmSync(file, { force: true });
        else writeFileSync(file, before);
      },
    };
  }

  // 预置「升级前把那两只隐私开关打开过」的老用户存储，**在插件激活之前**写进去：
  // A9b 之后插件根本不读它，但判据要打的正是「读到旧值就当真」那条回退路径 ——
  // 先写后激活，才保证下面每一次 activate() 都看得见这份盘上的旧值（PM 的条件 3）。
  state.legacySeed = seedLegacyConfig(true, true);
  const seededBytes = state.legacySeed.read();
  state.seededBytes = seededBytes;
  const seededCfg = JSON.parse(seededBytes ?? "{}").config ?? {};
  r.check(
    "预置的旧开关确实在盘上（不先钉这条，后面的「前后字节一致」就是空判）",
    "true|true",
    [String(seededCfg.showTitle), String(seededCfg.showDetail)].join("|"),
  );

  r.group("启用插件");
  // 经运行时启停，不靠重载：重载会切断页面在途的 IPC（点击穿透每 250ms 问一次光标位置），
  // 宿主随后把「孤儿回调」告警喷到页面上，被后面的零噪音断言算作本跑噪音。
  // 清单归宿主（C1）：先由设置窗写进去，宠物窗这边只是 loadEnabled + activate。
  state.settings = await openSettingsInvoker(PORT, state.c);
  await writeEnabledIds(state.settings.invoke, [...new Set([...state.origEnabled, AGENT_ID, PROBE_ID])]);
  r.check(
    "插件经运行时激活",
    true,
    await state.c.ev(`(async () => {
      const rt = await import('/src/runtime/plugin-runtime.ts');
      const manifests = await window.__TAURI_INTERNALS__.invoke('plugins_list');
      const manifest = manifests.find((m) => m.id === ${JSON.stringify(AGENT_ID)});
      if (!manifest) throw new Error('宿主没扫到插件');
      await rt.loadEnabled();
      await rt.activatePlugin(manifest);
      return rt.isActive(${JSON.stringify(AGENT_ID)});
    })()`),
  );

  // 截获本体入口：气泡 DOM 3.6 秒就收起来，记在入口处更稳
  r.check(
    "宠物控制器可截获",
    true,
    await state.c.ev(`(async () => {
      const host = await import('/src/pet/host.ts');
      const ctrl = host.petController();
      if (!ctrl) return false;
      window.__pet = { acts: [], said: [], status: [] };
      const react0 = ctrl.react.bind(ctrl);
      const say0 = ctrl.say.bind(ctrl);
      ctrl.react = (a) => { window.__pet.acts.push(a); return react0(a); };
      ctrl.say = (t) => { window.__pet.said.push(t); return say0(t); };
      const { bus } = await import('/src/runtime/event-bus.ts');
      window.__topics = [];
      bus.subscribe(${JSON.stringify(`${AGENT_ID}:state`)}, (p) => window.__topics.push(['state', p]));
      bus.subscribe(${JSON.stringify(`${AGENT_ID}:status`)}, (p) => window.__topics.push(['status', p]));
      bus.subscribe("agent:state", (p) => window.__topics.push(['host-state', p]));
      bus.subscribe('agent:event', (p) => window.__topics.push(['host-event', p]));
      bus.subscribe(${JSON.stringify(`${AGENT_ID}:widget`)}, (p) => window.__topics.push(['view', p]));
      // 常驻行的真实落点：桥把插件给的文本交给本体控制器（已截断到 20 码点之后）。
      // 记在这里而不是只看气泡 DOM —— 台词与常驻行共用一个槽，气泡那一刻显示的可能是一句台词，
      // 而「本插件到底往宿主登记了哪几行」是判限频、判清除、判隐身不自己藏的唯一硬证据。
      const setStatus0 = ctrl.setStatus.bind(ctrl);
      ctrl.setStatus = (pid, text) => {
        window.__pet.status.push([pid, text]);
        return setStatus0(pid, text);
      };
      return true;
    })()`),
  );
  const acts = () => state.c.ev(`window.__pet.acts.slice()`);
  state.acts = acts;
  const said = () => state.c.ev(`window.__pet.said.slice()`);
  state.said = said;
  /** 本体控制器收到过的常驻行设置记录：[[pluginId, text|null], …]（按发生顺序） */
  const statusLog = () => state.c.ev(`window.__pet.status.slice()`);
  state.statusLog = statusLog;
  /** 本插件最近一次**非清除**的常驻行文本（判「气泡里现在该是我们的哪一行」用） */
  const ourLastLine = async () => {
    const log = await statusLog();
    for (let i = log.length - 1; i >= 0; i--) if (log[i][0] === AGENT_ID && log[i][1] !== null) return log[i][1];
    return null;
  };
  state.ourLastLine = ourLastLine;
  const ourStatusCalls = async () => (await statusLog()).filter(([p]) => p === AGENT_ID).length;
  state.ourStatusCalls = ourStatusCalls;

  /** 气泡此刻的样子（B3 的口径：常驻行单行化靠 `.status` 类，台词占槽时没有它） */
  const bubbleNow = () =>
    state.c.ev(`(() => { const b = document.getElementById('pet-bubble');
      return { show: b.classList.contains('show'), status: b.classList.contains('status'), text: b.textContent }; })()`);
  state.bubbleNow = bubbleNow;
  /** 一次求值里同时读「气泡现在的样子」与「宿主手上我们最后一条是什么」。
   *  分两次读，中间正好落进一次合并发送就会比出假红 —— A03 那轮「期望值从实际里取」的同类教训。 */
  const bubbleVsOurs = () =>
    state.c.ev(`(() => { const b = document.getElementById('pet-bubble'); const s = window.__pet.status;
      let last = null;
      for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) { last = s[i][1]; break; }
      return { show: b.classList.contains('show'), status: b.classList.contains('status'), text: b.textContent, last }; })()`);
  state.bubbleVsOurs = bubbleVsOurs;
  /** 等槽里不是台词（台词亮 3.6s 且按设计占槽）；不等就直接读，读到的可能是那句台词 */
  const waitStatusSlot = () =>
    waitUntil(
      state.c,
      `(() => { const b = document.getElementById('pet-bubble'); return !b.classList.contains('show') || b.classList.contains('status'); })()`,
      8_000,
    ).catch(() => false);
  state.waitStatusSlot = waitStatusSlot;

  /** 真把插件的 JS 生命周期走一遍「停用 → 再激活」：
   *  「写启停清单」只驱动 Rust 侧 reconcile，宠物窗的 JS 不在这条路上（`watchEnabled` 只缓存，
   *  reconcile 仅在启动与 host:plugin-toggled 时跑 —— 这段教训就写在 verify-isolation 的 B3 组），
   *  所以判 `deactivate()` 有没有摘掉自己那行必须用这条通路。返回停用/激活是否按预期落定。 */
  const restartPlugin = () =>
    state.c.ev(`(async () => {
      const rt = await import('/src/runtime/plugin-runtime.ts');
      const manifests = await window.__TAURI_INTERNALS__.invoke('plugins_list');
      const manifest = manifests.find((m) => m.id === ${JSON.stringify(AGENT_ID)});
      if (!manifest) return "没扫到插件";
      await rt.deactivatePlugin(${JSON.stringify(AGENT_ID)});
      const off = rt.isActive(${JSON.stringify(AGENT_ID)}) === false;
      await rt.activatePlugin(manifest);
      return off && rt.isActive(${JSON.stringify(AGENT_ID)}) ? "ok" : \`停用/激活没落定 off=\${off}\`;
    })()`);
  state.restartPlugin = restartPlugin;
  // 旧配置得真的「被激活看见一次」：已在跑的插件再调一次 activatePlugin 是空转，所以这里显式走
  // 一轮 停用 → 再激活 —— 这一轮跑在预置之后的盘上，后面那条「预置开着也不下发」才不是判在
  // 一个没重读过配置的实例上。**必须排在截获之后**：`activate()` 末尾那句状态文案是
  // 「activate 计数器是活的」那条前提的观测对象，装在截获之前计数器就一直是 0，那条判据会空红。
  r.check(
    "预置之后重新走了一轮停用 → 激活（旧配置确实被 activate 看过一次）",
    "ok",
    await restartPlugin(),
  );

  /**
   * 等某个能力真的被授权。插件在 activate 时第一次 publish、第一次 react 各自会弹一个
   * 同意框，不先等它们落定就把首个事件发出去，断言测的其实是「应答对话框有多快」。
   * 授权表只认设置窗（见 gate.rs），所以这份查询走设置页；宠物窗问同样的命令必须被拒。
   */
  async function awaitGranted(cap, timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const list = await state.settings.invoke("permission_list");
      if (list.ok && (list.v[AGENT_ID] ?? []).includes(cap)) return true;
      await sleep(500);
    }
    return false;
  }
  state.awaitGranted = awaitGranted;

}
