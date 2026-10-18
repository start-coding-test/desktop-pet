// Agent 事件链路的端到端断言。
//   终端 1: npm run dev:debug      终端 2: npm run verify:agent
// 覆盖两层：
//   1) hook 分支 —— 真的用 exe 跑一次 `--pet-hook <phase>`，验证 stdin 落成一行 JSONL；
//   2) 采集→归一化→宠物 —— 往收件目录追加事件，断言宠物动作、台词、总线 topic 与去重。
// 不依赖 petdex，也不需要 Qoder 真跑起来：事件是按其 hook 形状直接造的。
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { argv, env } from "node:process";
import { spawnSync } from "node:child_process";
import {
  attach,
  createReport,
  hostInvoke,
  listPages,
  openSettingsInvoker,
  readEnabledIds,
  reloadAndWait,
  waitForPage,
  waitUntil,
  writeEnabledIds,
} from "./harness/cdp.mjs";
import { waitWidgetRealm } from "./harness/widget-realm.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const AGENT_ID = "com.pet.agent-bridge";
// 探针插件：只为钉住「声明 agent:hooks 的插件第一次调用必经同意框」这条宿主规则。
// 规则与用户此刻有没有授权过真实的 Agent 插件无关 —— 探针起手必然没授权，所以那一扇框
// 是必然要弹的；运行时自建自删，全程不碰 com.pet.agent-bridge 的授权状态。
const PROBE_ID = "zz.agentconsent";
const PLUGINS_DIR = resolve(import.meta.dirname, "../../plugins");
const PROBE_DIR = join(PLUGINS_DIR, PROBE_ID);
const EXE = join(import.meta.dirname, "../../src-tauri/target/debug/desktop-pet.exe");
// 没有 APPDATA 就拼不出收件目录，断言会打在 cwd 下一个同名相对路径上 ——
// 那种失败和「宿主真的没收到事件」长得一模一样，必须当场拒绝开跑
if (!env.APPDATA) {
  console.error("缺 APPDATA 环境变量：找不到宿主收件目录，拒绝开跑。");
  process.exit(2);
}
// 与 Rust 侧 inbox_dir 同一条规则：设了 PET_AGENT_INBOX 就用它（宿主实例也必须带同一个值），
// 否则落回 APPDATA 下的共享目录 —— 那时本机全局 Qoder hook 的真实会话会混进来
const INBOX = env.PET_AGENT_INBOX || join(env.APPDATA, "com.desktoppet.pet", "agent", "inbox");
const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const r = createReport("Agent 事件链路（dev）");

function emitPhase(phase, payload = {}) {
  const line = JSON.stringify({ phase, at: Date.now(), payload: { session_id: "verify-sess", ...payload } });
  appendFileSync(join(INBOX, `${phase}.jsonl`), line + "\n");
  return line;
}

/**
 * 授权只能走真实同意框，且各能力的框分批弹，所以后台持续应答整个测试期间。
 * 每扇框连主人一起记（{ who, caps }）：别的插件也可能同时弹自己的框，
 * 断言要按探针 id 过滤再判，别拿总数当证据。
 */
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

let c = null;
let settings = null;
let origEnabled = [];
let pumpDone = null;
const grantedCaps = [];
const consentPump = makeConsentPump(grantedCaps);

try {
  await waitForPage(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

try {
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
  c = await attach(PORT, isPetPage);
  const invoke = hostInvoke(c);
  origEnabled = await readEnabledIds(invoke);
  const token = `agent-${Date.now()}`;
  await c.ev(`window.__verifyToken = ${JSON.stringify(token)}; true`);
  pumpDone = consentPump.run(600_000); // 应答窗口必须比整轮长：宿主对同意框有 60 秒超时即视为拒绝 // 宿主对同意框有 60 秒超时即视为拒绝，应答窗口必须比整轮测试更长

  r.group("探针：agent:hooks 首次调用必经同意框（与真实插件的授权状态无关）");
  // 上一轮中途挂掉可能留下探针的残留授权或一扇没点掉的同意框 —— 残留授权会让首次调用
  // 不弹框，开着的老框会被 pump 记到探针头上。起手先排空，并把「排空了」钉成断言。
  if (!settings) settings = await openSettingsInvoker(PORT, c);
  const probeCapsInTable = async () => {
    const table = (await settings.invoke("permission_list")).v ?? {};
    return Object.entries(table)
      .filter(([id]) => id === PROBE_ID)
      .flatMap(([, caps]) => caps);
  };
  let probeResidual = await probeCapsInTable();
  for (let i = 0; i < 40 && probeResidual.length; i++) {
    await settings.invoke("permission_revoke", { pluginId: PROBE_ID }).catch(() => undefined);
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
  await reloadAndWait(settings.client);
  await waitUntil(settings.client, `!!window.__TAURI_INTERNALS__`, 15_000);

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
  const probeBoxes = () => grantedCaps.filter((x) => x.rendered === true && x.who.includes(PROBE_ID));
  await settings.client.ev(probeStatus);
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
    grantedCaps.filter((x) => x.rendered !== true).map((x) => `${x.who || "(空)"}|${x.caps.length}项`),
  );
  // 第二次调用同一条能力：授权已在表里（且桥有会话内缓存），不该再弹框。
  // 按探针自己的框数对比，别的插件 concurrent 弹框不进这条证据。
  const beforeSecond = probeBoxes().length;
  await settings.client.ev(probeStatus);
  await sleep(2000); // 若实现错成「每次都弹框」，给泵留出把它记下来的时间
  r.check("同一能力第二次调用不再弹框", beforeSecond, probeBoxes().length);

  /** 本插件那扇悬浮窗：标签 overlay-<id>，但 Tauri 不允许点号，id 里的点被编码成 `_`
   *  （与 Rust 的 overlay_label 同式：id 词表里没有下划线，所以这是一一对应）；
   *  标题带原 id，用来在 CDP 里认出是哪一扇 */
  const overlayLabelFor = (id) => `overlay-${id.replace(/\./g, "_").replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const OVERLAY_LABEL = overlayLabelFor(AGENT_ID);
  const OVERLAY_TITLE = `DesktopPet Overlay · ${AGENT_ID}`;
  const findOverlayTarget = async () =>
    (await listPages(PORT).catch(() => [])).find(
      (t) => /overlay\.html/.test(t.url) && t.title === OVERLAY_TITLE,
    );

  /**
   * overlay 窗里是否挂上了本插件的容器。
   * widget 渲染在 closed Shadow DOM 里，外部选择器穿不进去（那是隔离设计的一部分），
   * 所以这里只断言到「挂上了没有」；卡片内容的正确性由下发给 widget 的数据断言保证。
   */
  async function overlayMounted(timeoutMs = 15_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const target = await findOverlayTarget();
      if (target) {
        const oc = await attach(
          PORT,
          (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl,
          8_000,
        ).catch(() => null);
        if (oc) {
          try {
            const has = await oc.ev(
              `!!document.querySelector('#widget-overlay [data-plugin-id=${JSON.stringify(AGENT_ID)}][data-region="overlay"]')`,
            );
            if (has) return true;
          } finally {
            oc.close();
          }
        }
      }
      await sleep(600);
    }
    return false;
  }

  /** 在 overlay 窗里跑一段求值；窗不存在返回 null */
  async function withOverlayPage(fn) {
    const target = await findOverlayTarget();
    if (!target) return null;
    const oc = await attach(
      PORT,
      (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl,
      8_000,
    ).catch(() => null);
    if (!oc) return null;
    try {
      return await fn(oc);
    } finally {
      oc.close();
    }
  }

  async function overlayVisible(want, timeoutMs = 15_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const v = await invoke("plugin:window|is_visible", { label: OVERLAY_LABEL });
      if (v.ok && v.v === want) return true;
      await sleep(500);
    }
    return false;
  }

  /** 最近一次下发给卡片的数据（隐私开关的强度就体现在这里） */
  async function lastCard() {
    const all = await c.ev(`window.__topics.slice().filter(([k]) => k === 'card').map(([,p]) => p)`);
    return all.length ? all[all.length - 1] : null;
  }

  /** 模拟设置面板里的隐私开关：走插件自己的 cmd topic */
  async function setCardConfig(showTitle, showDetail) {
    await c.ev(`(async () => {
      const { bus } = await import('/src/runtime/event-bus.ts');
      bus.publish(${JSON.stringify(`${AGENT_ID}:cmd`)}, {
        action: 'config',
        showTitle: ${showTitle},
        showDetail: ${showDetail},
      }, ${JSON.stringify(AGENT_ID)});
      return true;
    })()`);
    await sleep(1200);
  }

  r.group("启用插件");
  // 经运行时启停，不靠重载：重载会切断页面在途的 IPC（点击穿透每 250ms 问一次光标位置），
  // 宿主随后把「孤儿回调」告警喷到页面上，被后面的零噪音断言算作本跑噪音。
  // 清单归宿主（C1）：先由设置窗写进去，宠物窗这边只是 loadEnabled + activate。
  settings = await openSettingsInvoker(PORT, c);
  await writeEnabledIds(settings.invoke, [...origEnabled, AGENT_ID]);
  r.check(
    "插件经运行时激活",
    true,
    await c.ev(`(async () => {
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
    await c.ev(`(async () => {
      const host = await import('/src/pet/host.ts');
      const ctrl = host.petController();
      if (!ctrl) return false;
      window.__pet = { acts: [], said: [] };
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
      bus.subscribe(${JSON.stringify(`${AGENT_ID}:widget`)}, (p) => window.__topics.push(['card', p]));
      return true;
    })()`),
  );
  const acts = () => c.ev(`window.__pet.acts.slice()`);
  const said = () => c.ev(`window.__pet.said.slice()`);

  /**
   * 等某个能力真的被授权。插件在 activate 时第一次 publish、第一次 react 各自会弹一个
   * 同意框，不先等它们落定就把首个事件发出去，断言测的其实是「应答对话框有多快」。
   * 授权表只认设置窗（见 gate.rs），所以这份查询走设置页；宠物窗问同样的命令必须被拒。
   */
  async function awaitGranted(cap, timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const list = await settings.invoke("permission_list");
      if (list.ok && (list.v[AGENT_ID] ?? []).includes(cap)) return true;
      await sleep(500);
    }
    return false;
  }

  r.group("插件上线与授权");
  // 撤销授权、读授权表都是「只认设置窗」的命令，先有设置窗的命令通道（上面启用时已经开过）
  if (!settings) settings = await openSettingsInvoker(PORT, c);
  const fromPet = await invoke("permission_list");
  r.check("宠物窗读授权表被门禁拒绝", true, !fromPet.ok && /设置窗/.test(String(fromPet.e)));
  r.check("总线授权已就位（activate 时的首次发布）", true, await awaitGranted("bus:publish"));

  r.group("插件不再需要任何网络能力");
  const manifests = await invoke("plugins_list");
  const manifest = manifests.ok ? manifests.v.find((m) => m.id === AGENT_ID) : null;
  r.check("manifest 存在", true, !!manifest);
  r.check("permissions 里没有 http", false, (manifest?.permissions ?? []).includes("http"));

  r.group("running：工具调用 → petdex 的 running");
  emitPhase("pre", { tool_name: "Bash" });
  r.check("首次插播状态触发授权", true, await awaitGranted("pet:react", 30_000));
  r.check("宠物收到 running", true, await waitUntil(c, `window.__pet.acts.includes('running')`, 8_000));
  r.check("running 时不作声", [], await said());
  r.check(
    "宿主广播了 agent:state=running",
    true,
    await waitUntil(c, `(window.__topics.slice().some(([k,p]) => k === 'host-state' && p.state === 'running'))`, 5_000),
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
  r.check("宠物收到 waiting", true, await waitUntil(c, `window.__pet.acts.includes('waiting')`, 15_000));
  r.check(
    "台词提示需要确认",
    true,
    await waitUntil(c, `window.__pet.said.some(t => t.includes('确认'))`, 15_000),
  );

  r.group("completed：一轮结束 → waving");
  emitPhase("stop", {});
  r.check("宠物收到 waving", true, await waitUntil(c, `window.__pet.acts.includes('waving')`, 15_000));

  r.group("一轮结束：迟到的 post 不再打开，卡片 3 秒自动收起");
  emitPhase("post", { tool_name: "Bash" }); // 比 stop 晚到，属于常态
  await sleep(2000);
  r.check(
    "总状态仍是这轮完成",
    "completed",
    await c.ev(`(window.__topics.slice().reverse().find(([k]) => k === 'host-state')?.[1].state ?? '')`),
  );
  r.check("卡片 3 秒后自动收起", true, await overlayVisible(false, 9_000));

  r.group("failed：工具失败 → petdex 的 failed 并带上工具名");
  emitPhase("tool-failure", { tool_name: "cargo test" });
  r.check("宠物收到 failed", true, await waitUntil(c, `window.__pet.acts.includes('failed')`, 15_000));
  r.check(
    "台词里带上失败的工具",
    true,
    await waitUntil(c, `window.__pet.said.some(t => t.includes('cargo test'))`, 15_000),
  );

  r.group("状态卡：开关关闭时不下发敏感内容");
  // 显式关掉开关再验：插件的开关状态是持久化的，上一轮被中途 kill 会留下「开着」的状态，
  // 依赖环境干净等于把断言变成随机
  await setCardConfig(false, false);
  const SECRET_TITLE = "把内部口令 abc123 写进配置";
  const SECRET_CMD = "echo abc123-inner-secret";
  emitPhase("user-prompt", { prompt: SECRET_TITLE });
  emitPhase("pre", { tool_name: "Bash", tool_input: { command: SECRET_CMD } });
  r.check(
    "宿主 agent:event 带上命令摘要",
    true,
    await waitUntil(c, `(window.__topics.slice().some(([k,p]) => k === 'host-event' && (p.detail ?? '').includes('abc123-inner')))`, 12_000),
  );
  r.check(
    "宿主 agent:event 带上步数",
    true,
    await waitUntil(c, `(window.__topics.slice().some(([k,p]) => k === 'host-event' && p.steps >= 1))`, 12_000),
  );
  r.check("会话进行中悬浮卡可见", true, await overlayVisible(true));
  r.check("卡片 widget 挂进 overlay 区", true, await overlayMounted());

  r.group("两扇悬浮窗互不抢占：按各自请求的坐标同时存在");
  const HR_ID = "com.pet.hr-ble";
  const HR_LABEL = overlayLabelFor(HR_ID);
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
    const list = await settings.invoke("permission_list");
    overlayGranted = (list.v?.[HR_ID] ?? []).includes("overlay");
    if (!overlayGranted) await sleep(500);
  }
  r.check("心率插件经同意框拿到 overlay 授权", true, overlayGranted);
  await invoke("overlay_show", { pluginId: HR_ID, x: 24, y: 24, height: 200 });
  r.check(
    "两张卡片同时可见",
    true,
    await waitUntil(
      c,
      `(async () => {
        const l = await window.__TAURI_INTERNALS__.invoke('overlay_list');
        const on = (id) => l.some(([p, v]) => p === id && v);
        return on(${JSON.stringify(AGENT_ID)}) && on(${JSON.stringify(HR_ID)});
      })()`,
      12_000,
    ),
  );
  // ADR-0010 决策 3：「宠物头顶」那一档已删。agent 桥的插件此刻仍在传 placement:"above-pet"，
  // 宿主接受并忽略 —— 落点回到缺省 (24,24)。这条钉的是「废弃但不报错、也不再把窗抬到头顶」。
  const dpr = Number(await c.ev("window.devicePixelRatio")) || 1;
  const posAgentLegacy = await invoke("plugin:window|outer_position", { label: OVERLAY_LABEL });
  r.check(
    "传 above-pet 只落回宿主缺省坐标（头顶档已废弃）",
    true,
    Math.abs((posAgentLegacy.v?.x ?? 1e9) - 24 * dpr) <= 6 &&
      Math.abs((posAgentLegacy.v?.y ?? 1e9) - 24 * dpr) <= 6,
  );
  // 同一扇**已存在**的窗再 show 一次并带新坐标：钉 U01 补的「已存在窗也要按新坐标重定位」，
  // 否则「插件改了位置再显示」只在第一次建窗生效
  await invoke("overlay_show", { pluginId: AGENT_ID, x: 520, y: 260, height: 104 });
  const posAgent = await invoke("plugin:window|outer_position", { label: OVERLAY_LABEL });
  const posHr = await invoke("plugin:window|outer_position", { label: HR_LABEL });
  r.check(
    "已存在的窗按新请求坐标重定位（outer_position 是物理像素，按 dpr 换算）",
    true,
    Math.abs((posAgent.v?.x ?? 1e9) - 520 * dpr) <= 6 && Math.abs((posAgent.v?.y ?? 1e9) - 260 * dpr) <= 6,
  );
  r.check("心率那扇留在桌面左上角", true, (posHr.v?.x ?? 1e9) < 150 && (posHr.v?.y ?? 1e9) < 150);
  r.check(
    "两扇窗的位置不是同一个点",
    true,
    JSON.stringify(posAgent.v) !== JSON.stringify(posHr.v),
  );
  await invoke("overlay_destroy", { pluginId: HR_ID });
  r.check("销毁只收掉那一扇，状态卡不受影响", true, await overlayVisible(true, 8_000));
  // 页面侧再对一次坐标：window.screenX/screenY 是 CSS（逻辑）像素，与上面那条物理像素的
  // outer_position 互为独立证据（同一 DPI 前提下不需要额外 capability）
  const cardGeo = await withOverlayPage((oc) => oc.ev(`[window.screenX, window.screenY, window.outerWidth, window.outerHeight]`));
  r.check(
    "卡片按请求坐标落座（头顶档删了，逻辑像素不经换算就是 screenX/screenY）",
    true,
    !!cardGeo && Math.abs(cardGeo[0] - 520) <= 6 && Math.abs(cardGeo[1] - 260) <= 6,
  );
  r.check("卡片宽度明显小于左上角整屏", true, !!cardGeo && cardGeo[2] <= 360);

  r.group("游戏模式隐身时卡片一起收，恢复后按会话状态回来");
  await invoke("set_pet_hidden", { hidden: true });
  r.check("隐身时卡片一起收掉", true, await overlayVisible(false, 8_000));
  await invoke("set_pet_hidden", { hidden: false });
  r.check("恢复后卡片按当前会话状态回来", true, await overlayVisible(true, 8_000));
  const cardOff = await lastCard();
  r.check("卡片数据含执行中状态", "running", cardOff?.state);
  r.check("卡片数据含中文标签", "正在执行", cardOff?.label);
  r.check("卡片数据含工具名", "Bash", cardOff?.toolName);
  r.check("卡片步数至少 1", true, (cardOff?.steps ?? 0) >= 1);
  r.check("默认不下发会话标题", "", cardOff?.title);
  r.check("默认不下发命令内容", "", cardOff?.detail);

  r.group("状态卡：开关打开后才下发敏感内容");
  await setCardConfig(true, true);
  const cardOn = await lastCard();
  r.check("打开后下发会话标题", true, (cardOn?.title ?? "").includes("把内部口令 abc123"));
  r.check("打开后下发命令摘要", true, (cardOn?.detail ?? "").includes("echo abc123-inner-secret"));
  // 面板重新挂载时靠这份回灌数据回显；没有它就会显示成默认值，表现成「配置没保存」
  const echoed = await invoke("bus_peek", { topic: `${AGENT_ID}:widget` });
  r.check(
    "宿主为面板回灌最近一份卡片数据（含已保存的开关）",
    true,
    echoed.v?.showTitle === true && echoed.v?.showDetail === true,
  );
  await setCardConfig(false, false);
  const cardOff2 = await lastCard();
  r.check("关掉后又变回空", true, (cardOff2?.title ?? "x") === "" && (cardOff2?.detail ?? "x") === "");

  r.group("会话结束后回落 idle");
  emitPhase("session-end", { session_id: "verify-sess" });
  r.check(
    "宿主广播了 idle",
    true,
    await waitUntil(c, `(window.__topics.slice().reverse().some(([k,p]) => k === 'host-state' && p.state === 'idle'))`, 25_000),
  );
  r.check("会话结束后悬浮卡收起", true, await overlayVisible(false, 15_000));

  r.group("hook 命令的调用面：宠物窗被拒，宿主路径（设置窗）放行");
  const status = await invoke("agent_hooks_status");
  r.check("宠物窗（主 realm）调用被拒", false, status.ok);
  r.info("拒绝原因", String(status.e ?? "").slice(0, 60));
  // B2 迁移：声明 agent:hooks 的插件设置页（settings 区）经能力校验后才放行 ——
  // 那条链路（同意框、badge/overlay 区取不到 host、撤销两分支）在 verify-isolation 里断言；
  // 这里钉住反向：从宠物窗绕过桥直接 invoke，带不带 pluginId 都被窗口门禁挡住。
  const petInstall = await invoke("agent_hooks_install", { pluginId: AGENT_ID });
  r.check("宠物窗带 pluginId 直接 invoke install 也被拒（label 决定，不是能力决定）", false, petInstall.ok);
  if (!settings) settings = await openSettingsInvoker(PORT, c);
  const hostStatus = await settings.invoke("agent_hooks_status");
  r.check("宿主路径（设置窗、不带 pluginId）照旧可用", true, hostStatus.ok === true);
  r.check("宿主 status 回显含配置文件列表", true, Array.isArray(hostStatus.v?.files));

  // closed Shadow DOM 里的元素从外面查不到：按 verify-astock 的既有做法，从 widgetHost.mounted
  // 取挂载记录、用它捕获的 shadow 引用操作（都在页面内求值，走真实点击路径）。
  // 定义在外层：④ 那组（安装/卸载/启停）和 ⑨ 的「四选一」都要用，抄两份就会各漂各的。
  const recExpr = `((await import('/src/runtime/widget-host.ts')).widgetHost.mounted.get(${JSON.stringify(AGENT_ID)}) ?? []).find((r) => r.host.dataset.region === "settings")`;
  const stateExpr = (want) =>
    `(async () => { const rec = ${recExpr}; return !!rec && rec.shadow.querySelector('.hk-status')?.dataset.state === ${JSON.stringify(want)}; })()`;
  const clickShadow = async (selector, label) => {
    const ok = await waitUntil(
      settings.client,
      `(async () => { const rec = ${recExpr}; return !!rec?.shadow?.querySelector(${JSON.stringify(selector)}); })()`,
      15_000,
    );
    r.check(label, true, ok);
    if (ok) {
      await settings.client.ev(`(async () => {
        const rec = ${recExpr};
        rec.shadow.querySelector(${JSON.stringify(selector)}).click();
        return true;
      })()`);
    }
    return ok;
  };
  const statusText = () =>
    settings.client.ev(`(async () => { const rec = ${recExpr}; return rec ? rec.shadow.querySelector('.hk-status')?.textContent ?? '' : ''; })()`);

  r.group("插件页：Qoder hook 接入（端到端，只碰 temp 样例）");
  // A9a：入口在 agent 桥自己的设置页（settings 区 widget）。写盘类断言一律只碰
  // PET_AGENT_CONFIG_FILES 指到的 temp/a9a 样例；不满足就整组跳过并说清原因。
  const TEMP_ROOT = resolve(import.meta.dirname, "../../temp");
  const A9A_DIR = join(TEMP_ROOT, "a9a");
  const cfgA = join(A9A_DIR, "cfg-a.json");
  const cfgB = join(A9A_DIR, "cfg-b.json");
  mkdirSync(A9A_DIR, { recursive: true });
  const foreignOnly = (tag) =>
    JSON.stringify(
      {
        theme: "dark",
        note: `keep-${tag}`,
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `other-tool-${tag} --notify`, timeout: 5 }] }] },
      },
      null,
      2,
    );
  writeFileSync(cfgA, foreignOnly("a"));
  writeFileSync(cfgB, foreignOnly("b"));

  if (!settings) settings = await openSettingsInvoker(PORT, c);
  const st0 = await settings.invoke("agent_hooks_status");
  const files0 = Array.isArray(st0.v?.files) ? st0.v.files : [];
  const underTemp = files0.length > 0 && files0.every((f) => resolve(String(f.path)).startsWith(TEMP_ROOT + sep));
  r.info("hook 配置落点", files0.map((f) => f.path).join(" ； ") || "(空)");
  r.check("目标文件都在 temp/ 下（写盘断言只碰样例，不碰真实用户配置）", true, underTemp);
  if (!underTemp) {
    r.info("跳过写盘断言", "hook 配置未指向 temp/a9a（启动时未设 PET_AGENT_CONFIG_FILES）；本组不写任何文件");
  } else {
    // 「他人条目未变」沿用「逐字段未变」的同一口径：按键排序的规范串比较。
    // 注意这个排序只是**比对手段**，不代表宿主的行为：A02 起宿主开了 serde_json 的
    // preserve_order，整文件重写不再把键归一成字母序，而是原样保留用户自己的键序
    // （改 ZCode 那种混着 MCP/权限开关的配置就必须这样）。键序真被改坏时，
    // 红的是 commands/agent.rs 那条「往返后键序不变」的单测，不是这里。
    const canon = (value) => {
      if (Array.isArray(value)) return value.map(canon);
      if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value).sort()) out[k] = canon(value[k]);
        return out;
      }
      return value;
    };
    const foreignOf = (path) => {
      const v = JSON.parse(readFileSync(path, "utf8"));
      const out = [];
      for (const [event, groups] of Object.entries(v.hooks ?? {})) {
        for (const g of groups ?? []) {
          for (const h of g.hooks ?? []) {
            if (!String(h.command ?? "").includes("--pet-hook")) out.push([event, canon(h)]);
          }
        }
      }
      return JSON.stringify(out);
    };

    // 打开 agent 桥的插件页（套件前面已把它加进启用清单；没加上就补一次开关，与用户点开关同一条路径）
    await settings.client.ev(`document.querySelector('#nav-plugins .nav-item[data-view=${JSON.stringify(AGENT_ID)}]')?.click(); true`);
    if (!(await settings.client.ev(`document.getElementById('plugin-toggle')?.checked === true`))) {
      await settings.client.ev(`(() => { const t = document.getElementById('plugin-toggle'); t.checked = true; t.dispatchEvent(new Event('change')); return true; })()`);
    }
    const panelReady = await waitUntil(
      settings.client,
      `(async () => { const rec = ${recExpr}; return !!rec?.shadow?.querySelector('.hk-status'); })()`,
      20_000,
    );
    r.check("插件页挂出「Qoder hook 接入」块", true, panelReady);
    r.check(
      "插件页插槽的 realm 戳是 worker（默认路线）",
      "worker",
      (await waitWidgetRealm(settings.client, AGENT_ID, "settings", "worker", 20_000)).actual,
    );

    // ① 未装：样例里只有别人的 hook，managed=0
    const absent = await waitUntil(settings.client, stateExpr("absent"), 20_000);
    r.check("未装状态文案：挂载即回显「未安装」", true, absent && String(await statusText()).includes("未安装"));

    // ② 需要修复：cfg-a 塞两条自家陈旧条目（managed=2 ≠ 2×12）
    const stale = JSON.stringify(
      {
        theme: "dark",
        hooks: {
          Stop: [{ hooks: [
            { type: "command", command: `"D:\\old\\desktop-pet.exe" --pet-hook stop`, timeout: 2 },
            { type: "command", command: `"D:\\old\\desktop-pet.exe" --pet-hook pre`, timeout: 2 },
            { type: "command", command: "keep.sh", timeout: 3 },
          ] }],
        },
      },
      null,
      2,
    );
    writeFileSync(cfgA, stale);
    const expectForeign = `${foreignOf(cfgA)}|${foreignOf(cfgB)}`;
    await clickShadow(".hk-refresh", "「刷新」按钮存在且可点");
    const repair = await waitUntil(settings.client, stateExpr("repair"), 15_000);
    const repairText = String(await statusText());
    r.check("需要修复状态：条数不对时不被显示成「已安装」", true, repair && repairText.includes("需要修复") && !repairText.includes("已安装"));

    // ③ 点安装 → 已装；每个样例文件恰好 expectedPerFile 条；回显与随后一次 status() 一致
    const clickedInstall = await clickShadow(".hk-install", "「安装」按钮存在且可点");
    const installed = clickedInstall && (await waitUntil(settings.client, stateExpr("installed"), 20_000));
    r.check("点安装后回显为已安装", true, installed);
    const stAfterInstall = (await settings.invoke("agent_hooks_status")).v;
    r.check(
      "安装后宿主 status：installed 为真且总数 = 文件数×expectedPerFile",
      true,
      stAfterInstall?.installed === true && stAfterInstall.managed === stAfterInstall.files.length * stAfterInstall.expectedPerFile,
    );
    for (const f of stAfterInstall?.files ?? []) {
      r.check("安装后样例文件恰好 expectedPerFile 条", stAfterInstall.expectedPerFile, readFileSync(f.path, "utf8").split("--pet-hook").length - 1);
    }
    // 装出来的条目必须带来源字段：不带的话，收件侧只能靠「缺省按 qoder」兜底 ——
    // 接线第二个 Agent 之后，那个兜底就是「桌宠对着别人的会话演」。
    // files.length 也钉住，否则空数组的 every() 恒真是条假绿。
    r.check(
      "装好的条目带 --agent qoder",
      true,
      (stAfterInstall?.files?.length ?? 0) > 0 &&
        (stAfterInstall?.files ?? []).every((f) =>
          readFileSync(f.path, "utf8").includes("--pet-hook pre --agent qoder"),
        ),
    );
    r.check("安装不改别人条目（复用按键排序规范串口径）", expectForeign, `${foreignOf(cfgA)}|${foreignOf(cfgB)}`);
    const shownInstall = String(await statusText());
    r.check("回显条数与随后一次 status() 一致", true, shownInstall.includes(`共 ${stAfterInstall.managed} 条`));

    // ④ 点卸载 → 归零；别人条目仍未变
    const clickedUninstall = await clickShadow(".hk-uninstall", "「卸载」按钮存在且可点");
    const absent2 = clickedUninstall && (await waitUntil(settings.client, stateExpr("absent"), 20_000));
    r.check("点卸载后回显为未安装", true, absent2);
    for (const p of [cfgA, cfgB]) {
      r.check("卸载后 --pet-hook 条目归零", 0, readFileSync(p, "utf8").split("--pet-hook").length - 1);
    }
    r.check("卸载不动别人条目（与 verify-isolation 同口径：按键排序规范串）", expectForeign, `${foreignOf(cfgA)}|${foreignOf(cfgB)}`);

    // ⑤ 旧断言「agent:hooks 的授权弹过同意框」已删除：它写的是「这一轮跑动期间真实 Agent
    // 插件的授权弹过框」，用户本就启用并授权 com.pet.agent-bridge 时收尾门控原样保留授权，
    // 这一轮不弹框，断言随继承状态红绿交替。同一宿主规则（声明 agent:hooks 的插件第一次
    // 调用必经同意框）改由上面探针组的首调断言钉住（起手必然没授权，那一扇框必然弹）。

    // ⑥ 启停联动（派单 §2 验收第一条）：停用插件要把自家条目摘净，再启用要装回来。
    // reconcile 就跑在同一次 plugin_enabled_set 调用里（装卸失败不拦启停，但顺序是先落盘
    // 再装卸），所以命令一返回磁盘上就已是结果 —— 不需要轮询等副作用追上来。
    r.group("启停联动：停用摘净、再启用恢复（只碰 temp 样例）");
    const ours = (p) => readFileSync(p, "utf8").split("--pet-hook").length - 1;
    // 状态文件在宿主自己的数据目录（不是 Agent 的配置），套件只读它取证
    const identifier = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../src-tauri/tauri.conf.json"), "utf8"),
    ).identifier;
    const LINKAGE_FILE = join(env.APPDATA, identifier, "agent-linkage.json");
    const agentField = () => {
      try {
        return JSON.parse(readFileSync(LINKAGE_FILE, "utf8")).agent ?? null;
      } catch {
        return "<读不到>";
      }
    };

    // 起点：先经设置页装一次 —— 那是「用户显式选择」的唯一记录点，也是下面能自动装回来的前提
    const clickedReinstall = await clickShadow(".hk-install", "「安装」按钮再次可点（联动恢复的起点）");
    r.check(
      "再点安装后回显为已安装",
      true,
      clickedReinstall && (await waitUntil(settings.client, stateExpr("installed"), 20_000)),
    );
    const perFile = (await settings.invoke("agent_hooks_status")).v?.expectedPerFile ?? 0;
    r.check("停用前基线：两个样例各装满", [perFile, perFile], [ours(cfgA), ours(cfgB)]);
    r.check("设置页装成功就记下了用户选的 Agent", "qoder", agentField());
    const foreignBeforeToggle = `${foreignOf(cfgA)}|${foreignOf(cfgB)}`;

    const disabledIds = origEnabled.filter((id) => id !== AGENT_ID);
    await writeEnabledIds(settings.invoke, disabledIds);
    r.check("停用插件后自家条目归零", [0, 0], [ours(cfgA), ours(cfgB)]);
    r.check("停用插件不动用户自己的 hook 条目", foreignBeforeToggle, `${foreignOf(cfgA)}|${foreignOf(cfgB)}`);
    r.check("停用不清空 agent 字段（再启用全靠它恢复）", "qoder", agentField());

    // 暂停广播：停用期间落一条事件，watcher 只该推进偏移量 —— 不发 agent:event、不进状态机。
    // 再启用后再写一条并真的跑一轮：只有新那条该被广播，停用期间那条永远不重放
    // （偏移量已经走过去）。两半合起来才是「只推进偏移量」，只看前一半等于没测后一半。
    const eventCount = async () =>
      (await c.ev(`window.__topics.filter(([k]) => k === 'host-event').length`));
    const eventsBeforePause = await eventCount();
    emitPhase("pre", { tool_name: "Bash", session_id: "verify-paused" });
    await sleep(1_500);
    r.check("停用期间不广播 agent 事件", eventsBeforePause, await eventCount());

    // 不先钉这条授权，下面的绿可能只是「没授权所以本来就不会装」
    r.check("再启用所需的 agent:hooks 授权仍在", true, await awaitGranted("agent:hooks"));
    await writeEnabledIds(settings.invoke, [...disabledIds, AGENT_ID]);
    r.check("再启用后条目装回来", [perFile, perFile], [ours(cfgA), ours(cfgB)]);
    r.check("再启用同样不动别人条目", foreignBeforeToggle, `${foreignOf(cfgA)}|${foreignOf(cfgB)}`);

    emitPhase("post", { tool_name: "Bash", session_id: "verify-resumed" });
    await sleep(1_500);
    r.check(
      "再启用只广播新事件、不重放停用期间那条",
      eventsBeforePause + 1,
      await eventCount(),
    );

    // ⑦ 来源过滤（A02）：与当前 Agent 不一致的事件只推进偏移量，不进状态机也不广播。
    // 用真 exe 注入而不是直接写收件文件：一次跑完「--agent 参数 → JSONL → watcher」整条链。
    r.group("来源过滤：别的 Agent 的事件不驱动桌宠");
    const foreignSess = `verify-foreign-${Date.now()}`;
    const eventsBeforeFilter = await eventCount();
    const foreign = spawnSync(EXE, ["--pet-hook", "pre", "--agent", "zcode"], {
      input: JSON.stringify({ session_id: foreignSess, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    r.check("带 --agent zcode 的 hook 分支退出码为 0", 0, foreign.status);
    await sleep(1_500);
    r.check("外来来源不产生 agent:event", eventsBeforeFilter, await eventCount());
    r.check(
      "外来事件确实落了盘（红在这条说明是采集坏了，而不是过滤生效）",
      true,
      readFileSync(join(INBOX, "pre.jsonl"), "utf8").includes(foreignSess),
    );
    // 对照：同一 phase 换成当前来源必须照常广播 —— 没有这条，上面的绿可能只是整条链断了
    const mine = spawnSync(EXE, ["--pet-hook", "pre", "--agent", "qoder"], {
      input: JSON.stringify({ session_id: `verify-mine-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    r.check("带 --agent qoder 的 hook 分支退出码为 0", 0, mine.status);
    r.check(
      "当前来源照常广播，且 payload 带上 agent 字段",
      true,
      await waitUntil(
        c,
        `(window.__topics.slice().reverse().find(([k]) => k === 'host-event')?.[1]?.agent === 'qoder')`,
        8_000,
      ),
    );
    r.check(
      "agent:state 也带上 agent 字段",
      true,
      await waitUntil(
        c,
        `(window.__topics.slice().reverse().find(([k]) => k === 'host-state')?.[1]?.agent === 'qoder')`,
        8_000,
      ),
    );

    // 缺省（不带 --agent）的旧形状必须仍然可用：A01 装好的条目就是这个形状
    const legacy = spawnSync(EXE, ["--pet-hook", "post"], {
      input: JSON.stringify({ session_id: `verify-legacy-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    r.check("不带 --agent 的旧 hook 条目退出码为 0", 0, legacy.status);
    r.check(
      "不带 --agent 时按 qoder 处理，事件照常被采集",
      true,
      await waitUntil(
        c,
        `(window.__topics.slice().reverse().find(([k]) => k === 'host-event')?.[1]?.phase === 'post')`,
        8_000,
      ),
    );

    // ⑧ --pet-hook-cleanup：NSIS 卸载前那条清理分支。跑在真的 dev 实例旁边，
    // 顺带证明分流发生在单实例锁与建窗之前 —— 排错了要么条目不被清，要么现成实例被干扰。
    r.group("卸载前清理分支（起一个 exe --pet-hook-cleanup）");
    const readInboxLen = () => {
      try {
        return readFileSync(join(INBOX, "pre.jsonl"), "utf8").length;
      } catch {
        return 0;
      }
    };
    const pagesBefore = (await listPages(PORT).catch(() => [])).length;
    const inboxBefore = readInboxLen();
    const cleanup = spawnSync(EXE, ["--pet-hook-cleanup"], { encoding: "utf8", timeout: 5_000 });
    r.check("清理分支 5 秒内退出且退出码为 0", 0, cleanup.status);
    r.check("清理分支没有被超时杀掉", undefined, cleanup.error);
    r.check("stdout 报告摘掉了条目", true, /result=done .*stripped=[1-9]\d* .*failed=0/.test(String(cleanup.stdout)));
    r.check("清理后自家条目归零", [0, 0], [ours(cfgA), ours(cfgB)]);
    r.check("清理不动别人条目与其他键", foreignBeforeToggle, `${foreignOf(cfgA)}|${foreignOf(cfgB)}`);
    r.check("清理分支不往收件目录写（没被当成一条 hook 事件）", inboxBefore, readInboxLen());
    // 只判「没多出页面」：本组前后可能有一张状态卡按自己的超时收起，那与清理分支无关
    const pagesAfter = (await listPages(PORT).catch(() => [])).length;
    r.check("清理分支没有开新窗口", true, pagesAfter <= pagesBefore);
    r.check("dev 实例仍然存活（没被单实例锁抢占或重载）", token, await c.ev(`window.__verifyToken ?? null`));

    // 第二遍专撞坏配置：清理失败绝不能拦住卸载，所以退码仍是 0 且文件一字不改
    const broken = "{ 半截 JSON";
    writeFileSync(cfgA, broken);
    const brokenB = readFileSync(cfgB, "utf8");
    const cleanup2 = spawnSync(EXE, ["--pet-hook-cleanup"], { encoding: "utf8", timeout: 5_000 });
    r.check("撞到坏配置仍然退出码 0", 0, cleanup2.status);
    r.check("坏配置文件一字不改", broken, readFileSync(cfgA, "utf8"));
    r.check("坏配置不牵连另一个文件", brokenB, readFileSync(cfgB, "utf8"));
    r.check("坏配置在 stdout 里留痕", true, /failed=1/.test(String(cleanup2.stdout)));

    // 复位成套件后面用例需要的样子：两份样例都只留用户自己的条目，不带我们的东西
    writeFileSync(cfgA, foreignOnly("a"));
    writeFileSync(cfgB, foreignOnly("b"));
    r.info("样例配置已复位", "两份都只剩用户自己的 hook 条目");
  }

  // ⑨ ZCode 切换（A02-4）：夹具目录由本套件自建自删，工作流不负责预置。
  // 只跑 ZCode —— codex / workbuddy 的适配器在 PR-3 接线，那时按同一形状各加一组。
  r.group("ZCode 切换：确认门、双文件、总开关恢复（只碰 PET_AGENT_HOME 下的夹具）");
  const ZHOME = String(env.PET_AGENT_HOME ?? "");
  // 两组前置都要满足：PET_AGENT_HOME 在 temp 下（写盘安全），且④那组真的把设置页开起来了
  // （本组的切换走界面 —— 设置区 widget 没挂载就没有按钮可点，那是前置不成立而不是行为坏了）
  const zhomeOk = ZHOME !== "" && resolve(ZHOME).startsWith(TEMP_ROOT + sep) && underTemp;
  r.check("前置齐备：PET_AGENT_HOME 在 temp 下 + 设置页已挂载", true, zhomeOk);
  if (!zhomeOk) {
    r.info("跳过 ZCode 组", "PET_AGENT_HOME 未设/不在 temp 下，或设置页没打开；本组一个文件都不写");
  } else {
    const zcli = join(ZHOME, ".zcode", "cli");
    rmSync(zcli, { recursive: true, force: true });
    mkdirSync(zcli, { recursive: true });
    const zcfg = join(zcli, "config.json");
    const zset = join(zcli, "setting.json");
    const userHook = { type: "command", command: "user-hook.sh", timeoutMs: 3000 };
    const sample = (enabled) =>
      JSON.stringify(
        {
          mcpServers: { fake: { command: "npx fake-mcp" } },
          ...(enabled === undefined ? {} : { hooks: { enabled, events: { Stop: [{ hooks: [userHook] }] } } }),
          permissions: { allow: ["Bash"] },
        },
        null,
        2,
      );

    writeFileSync(zcfg, sample(false));
    const zBefore = readFileSync(zcfg, "utf8");
    const denied = await settings.invoke("agent_linkage_set", { agent: "zcode" });
    r.check("总开关显式关着且用户配过条目 → 第一次切换被要求确认", false, denied.ok);
    r.check("确认文案带上用户自己的条数", true, /1 条/.test(String(denied.e)));
    r.check(
      "确认拒绝带 ASCII 机器可读前缀（界面靠它判，不靠猜中文）",
      "[need-confirm]",
      String(denied.e).slice(0, 14),
    );
    r.check("被拦下时一个文件都没动", zBefore, readFileSync(zcfg, "utf8"));
    r.check("未知来源的 agent 值直接被拒（不是任意非空字符串）", false, (await settings.invoke("agent_linkage_set", { agent: "nope" })).ok);

    // 真正走一遍界面：点四选一里的 ZCode → 桥 → Worker 通道 agentHooks.set → 宿主。
    // 这条链上任何一环没接上，表现都是「按了没反应」，所以判据必须是界面状态而不是 invoke 结果。
    const clickedZ = await clickShadow(".hk-agent-zcode", "四选一里有 ZCode 这个按钮");
    r.check(
      "第一趟停在确认门（界面 dataset.state=consent）",
      true,
      clickedZ && (await waitUntil(settings.client, stateExpr("consent"), 12_000)),
    );
    r.check("确认提示没改写宿主原话", true, /1 条/.test(String(await statusText())));
    const clickedConsent = await clickShadow(".hk-consent", "「仍要打开」按钮出现了");
    r.check(
      "点「仍要打开」之后装上（界面 state=installed）",
      true,
      clickedConsent && (await waitUntil(settings.client, stateExpr("installed"), 20_000)),
    );
    const zText = readFileSync(zcfg, "utf8");
    r.check("装了 7 个事件（ZCode 没有 SessionEnd/Notification/Subagent）", 7, zText.split("--pet-hook").length - 1);
    r.check("条目带 --agent zcode", true, zText.includes("--pet-hook pre --agent zcode"));
    r.check("只写文档列出的字段（不写 matcher / args）", false, /matcher|"args"/.test(zText));
    r.check("timeoutMs 用毫秒", true, zText.includes("\"timeoutMs\": 2000"));
    r.check("总开关被打开", true, JSON.parse(zText).hooks.enabled === true);
    const zc = JSON.parse(zText);
    const inner = zc.hooks.events.Stop.flatMap((g) => g.hooks ?? []);
    const mine = inner.find((h) => String(h.command).includes("--pet-hook"));
    const kept = inner.find((h) => !String(h.command).includes("--pet-hook"));
    r.check("我们的条目独占一个分组", true, zc.hooks.events.Stop.length >= 2 && kept?.command === "user-hook.sh" && !!mine);
    r.check("其他键一个不少，且顶层键序原样（preserve_order 的端到端证据）", ["mcpServers", "hooks", "permissions"], Object.keys(zc));
    r.check("没装过的那份 setting.json 不被凭空造出来", false, existsSync(zset));

    const stZ = (await settings.invoke("agent_hooks_status")).v;
    r.check("状态页按当前那一家报（agent=zcode，每文件 7 条）", ["zcode", 7, 7], [stZ?.agent, stZ?.expectedPerFile, stZ?.managed]);
    r.check("四选一清单列全四个槽位（含未接线的 codex/workbuddy）", ["codex", "qoder", "workbuddy", "zcode"], (stZ?.options ?? []).map((o) => o.id).sort());
    r.check("未接线的槽位标成 wired=false", false, (stZ?.options ?? []).find((o) => o.id === "codex")?.wired);
    r.check("装完提示由适配器给（新开会话才生效）", true, /新开/.test(String(stZ?.hint)));

    // 来源过滤在真实切换之后仍只对当前那一家放行：注入 qoder 事件不该动桌宠，zcode 事件该动
    const evCount = async () =>
      (await c.ev(`window.__topics.filter(([k]) => k === 'host-event').length`));
    const evBefore = await evCount();
    spawnSync(EXE, ["--pet-hook", "pre", "--agent", "qoder"], {
      input: JSON.stringify({ session_id: `verify-back-qoder-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    await sleep(1_500);
    r.check("当前是 ZCode 时，注入 qoder 事件不广播", evBefore, await evCount());
    spawnSync(EXE, ["--pet-hook", "pre", "--agent", "zcode"], {
      input: JSON.stringify({ session_id: `verify-zcode-live-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    r.check("切到 ZCode 后自己的事件照常广播", true, await waitUntil(c, `(window.__topics.slice().reverse().find(([k]) => k === 'host-event')?.[1]?.agent === 'zcode')`, 8_000));

    // 切回 Qoder：走界面（点四选一里的 Qoder），ZCode 的条目摘净，并且**总开关回到装之前的
    // false**（hooksEnabled 记录的端到端证据）
    const clickedBack = await clickShadow(".hk-agent-qoder", "四选一里 Qoder 是选中态、也能点");
    r.check(
      "切回 Qoder 后界面回到已安装",
      true,
      clickedBack && (await waitUntil(settings.client, stateExpr("installed"), 20_000)),
    );
    const zAfter = readFileSync(zcfg, "utf8");
    r.check("ZCode 的条目摘净", 0, zAfter.split("--pet-hook").length - 1);
    r.check("总开关恢复成装之前的 false", true, JSON.parse(zAfter).hooks.enabled === false);
    r.check("用户自己的条目仍然在", "user-hook.sh", JSON.parse(zAfter).hooks.events.Stop.flatMap((g) => g.hooks ?? [])[0]?.command);
    r.check("恢复后键序与内容回到原样", ["mcpServers", "hooks", "permissions"], Object.keys(JSON.parse(zAfter)));
    const stQ = (await settings.invoke("agent_hooks_status")).v;
    r.check("状态页跟着回到 Qoder", ["qoder", 12], [stQ?.agent, stQ?.expectedPerFile]);

    // 夹具目录自己删：工作流不负责预置，也不能把它留给下一轮
    rmSync(join(ZHOME, ".zcode"), { recursive: true, force: true });
    r.check("夹具目录已自删", false, existsSync(zcli));
  }

  r.group("收尾前的完整性");
  r.check("测试期间宠物窗未被重载", token, await c.ev(`window.__verifyToken ?? null`));
  await sleep(500); // console 事件异步送达
  r.info("导航过渡期告警（reload 切断在飞 IPC 的产物，单独归类）", String(c.transitionNoise.length));
  r.check("零噪音", [], c.noise);
} catch (err) {
  // 断言中途抛错绝不能以 0 收场：对回归工具来说，「崩了但退出码 0」比一条红断言危险得多
  r.check("脚本未抛异常", true, false);
  console.error("\n验证中断: " + String(err?.message ?? err).split("\n").slice(0, 3).join(" | "));
} finally {
  // 收尾顺序：停同意框应答 → 趁一切还在把插件下线（不要拿重载当下线手段）→ 撤销授权
  // → 最后重载换新文档，把本跑的 console 输出连同旧文档一起丢掉，别污染下一次 attach
  consentPump.stop();
  await pumpDone?.catch(() => undefined);
  if (c) {
    // 探针收尾：先撤销授权（撤销只认设置窗，目录一删宿主就把它当孤儿了），再删目录，
    // 最后断言授权已被 prune_orphan_grants 回收。顺序不能反。
    if (!settings) settings = await openSettingsInvoker(PORT, c).catch(() => null);
    const probeRevoked = settings
      ? await settings.invoke("permission_revoke", { pluginId: PROBE_ID }).catch(() => undefined)
      : { ok: false, e: "设置窗没开起来" };
    r.info("探针授权撤销", JSON.stringify(probeRevoked?.ok ?? false));
    rmSync(PROBE_DIR, { recursive: true, force: true });
    await sleep(1500); // 等 watcher 跑一轮，prune_orphan_grants 把孤儿授权回收掉
    // 这条断言不许因「设置窗没开起来」而静默消失——那样总条数会悄悄少一条，看起来像套件本来就少一条。
    const probeTable = settings
      ? ((await settings.invoke("permission_list").catch(() => ({ v: {} }))).v ?? {})
      : { [PROBE_ID]: ["设置窗没开起来，无法确认授权已回收"] };
    r.check("探针下线后授权被回收", [], Object.keys(probeTable).filter((id) => id === PROBE_ID));
    const wasEnabled = origEnabled.includes(AGENT_ID);
    {
      // 原样恢复用户那份清单。先前这里会把 agent-bridge 从清单里摘掉，
      // 用户本来开着它，跑完一轮回归它就悄悄下线了
      if (!settings) settings = await openSettingsInvoker(PORT, c).catch(() => null);
      if (settings) await writeEnabledIds(settings.invoke, origEnabled).catch(() => undefined);
      await c
        .ev(`(async () => {
          const rt = await import('/src/runtime/plugin-runtime.ts');
          await rt.loadEnabled();
          ${wasEnabled ? "" : `await rt.deactivatePlugin(${JSON.stringify(AGENT_ID)});`}
          return true;
        })()`)
        .catch(() => undefined);
      await sleep(1200);
    }
    if (!wasEnabled) {
      // 只撤销本跑自己申请到的授权；撤销只认设置窗，所以走那一页的命令通道
      if (!settings) settings = await openSettingsInvoker(PORT, c).catch(() => null);
      const revoked = settings
        ? await settings.invoke("permission_revoke", { pluginId: AGENT_ID })
        : { ok: false, e: "设置窗没开起来，授权留在原地" };
      r.info("已撤销授权", JSON.stringify(revoked.ok ? revoked.v : revoked.e));
    } else {
      r.info("用户本来就开着它", "授权与启用清单原样保留");
    }
    settings?.close();
    settings = null;
    await reloadAndWait(c).catch(() => undefined);
    // 等这一轮的收尾彻底落地再退出：下一套断言脚本紧跟着 attach 的话，
    // 会撞在这次重载的尾巴上，红在一堆与本跑无关的断言上
    await waitUntil(c, `!!window.__TAURI_INTERNALS__ && !!document.querySelector('#pet-canvas')`, 10_000);
    await sleep(1200);
  } else {
    settings?.close();
    // 页面没连上就中断的场合，探针目录也要删掉，别给后面所有套件留一个孤儿插件
    rmSync(PROBE_DIR, { recursive: true, force: true });
  }
  const failed = r.summary();
  c?.close();
  await sleep(500);
  process.exit(failed ? 1 : 0);
}
