// 隔离与安全回归断言。连到「已在运行」的 dev 实例，跑完给非零退出码即失败。
//   终端 1: npm run dev:debug     终端 2: npm run verify
// 只覆盖 dev 能验证的部分；CSP 与打包路径见 verify-release.mjs（每波次收尾手工跑一次）。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { argv, env } from "node:process";
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
import { NET_ID, PROBE_ID, SPOOF_DIR, removeFixtures, writeFixtures } from "./harness/fixtures.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const PLUGINS_DIR = resolve(import.meta.dirname, "../../plugins");
// 没有 APPDATA 时 join('', ...) 会把存储路径指到 cwd 下的相对路径，
// 「文件不在」会被读成「隔离没生效」—— 这类失败必须当场拒绝开跑
if (!env.APPDATA) {
  console.error("缺 APPDATA 环境变量：定位不到插件存储目录，拒绝开跑。");
  process.exit(2);
}
// store.rs 落在 app_data_dir()/plugins/<id>/；Windows 上 app_data_dir = %APPDATA%/<identifier>
const STORE_DIR = join(env.APPDATA, "com.desktoppet.pet", "plugins", PROBE_ID);
const probeManifest = (permissions) =>
  `{ id: ${JSON.stringify(PROBE_ID)}, widget: 'widget.js', permissions: ${JSON.stringify(permissions)} }`;
const MOUNT_BARE = `window.__wh.mount(${probeManifest([])}, 'badge')`;
const MOUNT_CAPPED = `window.__wh.mount(${probeManifest(["bus:publish", "bus:subscribe"])}, 'settings', document.body)`;
const r = createReport("隔离与安全回归（dev）");
const invoke = (c) => hostInvoke(c);

/**
 * 等同意框弹出、读它展示了什么，然后按 how 作答。
 * close 必须走真实关窗路径（plugin:window|close 才会触发 Rust 的 CloseRequested；
 * CDP 的 Page.close 绕过它），且不能 await 其响应 —— 关闭会先拆掉发起调用的 webview。
 */
/**
 * 应答同意框，且**只点我们正要问的那个插件的框**。
 *
 * 为什么必须按名字挑：同意框是跨套件残留的state —— 上一轮套件（例如 verify:worker 收尾）
 * 撤销了某个「仍在启用清单里」的插件的授权，下一个实例一 boot 它就弹框并一直挂着。
 * 旧写法 `waitForPage(/consent/)` 抓到谁点谁，于是本套件的「同意框列出了 storage」读到别人的能力表，
 * 整组假红（实测一次 13 条）。别人的框留给宿主自己的 60 秒超时处理，不去替它作答。
 */
async function driveConsent(how, wantId = "") {
  const deadline = Date.now() + 20_000;
  let others = 0;
  while (Date.now() < deadline) {
    const pages = (await listPages(PORT).catch(() => [])).filter((t) => /consent/.test(t.url));
    for (const target of pages) {
      let cs = null;
      try {
        cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000);
        const name = await cs.ev(`document.getElementById('plugin-name')?.textContent ?? ''`);
        if (wantId && !name.includes(wantId)) {
          others += 1;
          cs.close();
          cs = null;
          continue;
        }
        const seen = {
          caps: await cs.ev(`[...document.querySelectorAll('#cap-list li')].map(li => li.textContent)`),
          name,
          label: await cs.ev(`window.__TAURI_INTERNALS__.metadata.currentWindow.label`),
        };
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
        cs?.close();
      }
    }
    await sleep(400);
  }
  throw new Error(
    `20 秒内没等到 ${wantId ? `「${wantId}」的` : ""}同意框（场上别人的框累计扫到 ${others} 个，按名字跳过没点）`,
  );
}

const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * 「本体压住 overlay」的真窗判据：交回 `tools/win-zorder.ps1` 的退出码 + 它打的 ASCII 机器行。
 * 拼成一条字符串是为了失败时一眼分清 `overlay-covers-pet`（承诺真的破了）与
 * `no-overlapping-sample`（前置没满足，根本没采到同框样本）—— 探针只在有交互桌面的机器上跑得动
 * （托管 runner 连 WebView2 都起不来），所以这条不进 ci.yml。
 */
function probeZOrder(seconds) {
  const script = resolve(import.meta.dirname, "../../tools/win-zorder.ps1");
  const run = spawnSync("pwsh.exe", ["-NoProfile", "-File", script, "-Seconds", String(seconds)], {
    encoding: "utf8",
    timeout: (seconds + 60) * 1000,
    windowsHide: true,
  });
  if (run.error) return `spawn失败 ${run.error.message}`;
  const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const machine = out.split(/\r?\n/).find((l) => l.startsWith("ZORDER "))?.trim() ?? "没有 ZORDER 行";
  return `${run.status} ${machine}`;
}

/**
 * 武装一次「本窗自己发起的整页重载」：location.reload() 不换 CDP target，
 * 只能靠 Page.loadEventFired 认它。先武装、再触发；返回 false = 这段时间窗口没重载。
 * 本卡起「覆盖已启用插件的文件 → 承载它的窗口换一茬文档」是产品行为，
 * 等它必须等真实信号，不能拿固定 sleep 赌异步。
 */
const armPageReload = async (timeoutMs = 8_000) => {
  await c.send("Page.enable");
  return c.once("Page.loadEventFired", timeoutMs).then(
    () => true,
    () => false,
  );
};

/** 装/清一个 host:plugins-changed 载荷探针；换过文档后要重新装（新文档没有这个数组） */
const RESET_CHANGE_SPY = `(async () => {
  if (!window.__changeSpy) {
    // 注入代码不经 Vite 转换，裸说明符解析不了；本套件只连 dev 实例（1420），走 dev 服务器可解析的路径
    const { listen } = await import('/node_modules/@tauri-apps/api/event.js');
    window.__changeSpy = [];
    await listen('host:plugins-changed', (e) => window.__changeSpy.push(e.payload ?? null));
  }
  window.__changeSpy.length = 0;
  return true;
})()`;

/** 探针里是否收到过一条「载荷带得出该插件 id」的广播 */
const sawChangedId = (id) =>
  `Array.isArray(window.__changeSpy) && window.__changeSpy.some((p) => Array.isArray(p?.ids) && p.ids.includes(${JSON.stringify(id)}))`;

try {
  await waitForPage(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

// 往 plugins/ 写 fixture 会让 Vite 触发一次整页重载，所以先写完再连；
// 装上的宿主句柄仍可能被随后的重载冲掉，故下面的安装带退避重试。
let c;
let aborted = false;
// 撤销授权与查看授权表只认设置窗（见 gate.rs：插件 JS 就跑在宠物窗里，
// 不设门禁的话一行 invoke 就能抹掉任意插件的授权并连带清掉其存储）。
// 脚本要撤销时就把设置窗唤出来走这条真实通道，顺带证明宠物窗问同样的命令会被拒。
let settings = null;
async function revoke(pluginId) {
  if (!settings) settings = await openSettingsInvoker(PORT, c);
  return settings.invoke("permission_revoke", { pluginId });
}

/** 启停清单归宿主（C1）：写只认设置窗，脚本要改就先唤出设置窗再走真实通道 */
async function setEnabled(ids) {
  if (!settings) settings = await openSettingsInvoker(PORT, c);
  return writeEnabledIds(settings.invoke, ids);
}

/**
 * 用真实同意框给探针拿到某项能力。
 * S1 之后 store_* 在 Rust 侧查授权，S2/S3 之后总线与悬浮层也一样 ——
 * 而 fixture 探针默认零权限，脚本要走的能力必须自己一项项要回来，
 * 顺带证明「manifest 声明 + 用户同意」这条链在宿主侧确实生效。
 */
async function grantProbeCap(capability) {
  const manifestPath = join(PLUGINS_DIR, PROBE_ID, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.permissions?.includes(capability)) {
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, permissions: [...(manifest.permissions ?? []), capability] }, null, 2),
    );
    await sleep(600);
  }
  const checked = await invoke(c)("permission_check", { pluginId: PROBE_ID, capability });
  if (checked.ok && checked.v === true) return true; // 已授权时 permission_request 不弹框，别空等
  // 不等 permission_request 的返回：它会阻塞到用户作答，而 CDP 的 Runtime.evaluate 有 20 秒硬超时
  // （见 cdp.mjs::send），弹框慢一点就会把整条断言链打断。改成应答之后轮询授权表。
  invoke(c)("permission_request", {
    pluginId: PROBE_ID,
    capabilities: [capability],
  }).catch(() => undefined);
  try {
    const consent = await driveConsent("allow", PROBE_ID);
    r.check(`同意框列出了 ${capability}`, true, consent.caps.includes(capability));
  } catch (err) {
    console.log(`     没能操作 ${capability} 的同意框: ` + String(err?.message ?? err).split("\n")[0]);
    return false;
  }
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const now = await invoke(c)("permission_check", { pluginId: PROBE_ID, capability });
    if (now.ok && now.v === true) return true;
    await sleep(400);
  }
  return false;
}
try {
  writeFixtures(PLUGINS_DIR);
  await sleep(2500);
  c = await attach(PORT, isPetPage);
  r.info("已连接", c.url);
  const INSTALL = `(async () => {
    if (!window.__wh || !Array.isArray(window.__canary)) {
      const { bus } = await import('/src/runtime/event-bus.ts');
      window.__canary = [];
      bus.subscribe('ble:heart-rate', (p) => window.__canary.push(p));
      window.__wh = (await import('/src/runtime/widget-host.ts')).widgetHost;
      window.__probes = [];
    }
    return typeof window.__wh?.mount === 'function' && Array.isArray(window.__canary);
  })()`;
  let ready = false;
  for (let i = 0; i < 8 && !ready; i++) {
    ready = await c.ev(INSTALL).catch(() => false);
    if (!ready) await sleep(2000);
  }
  r.check("widgetHost 与真实总线可达", true, ready);
  if (!ready) throw new Error("拿不到宿主的 widgetHost/总线单例（页面持续重载？）");

  // 插件入口现在默认跑在 Worker 里（ADR-0006 / L2 阶段一），但这份脚手架探针的 index.js
  // 是把事实写进 `window.__probeActivated` 这类页面全局的，断言就在页面 realm 读它们 ——
  // 入口一进 Worker 那些全局就没有对象了。把探针显式留在宿主 realm，真实插件不受这条影响。
  // 收尾会 removeItem（见 finally），别让它留在用户的 WebView 配置里。
  await c.ev(`localStorage.setItem('host:realm-plugin-host', ${JSON.stringify(`${PROBE_ID},${NET_ID}`)})`);
  // widget 从阶段二收口起也默认进 Worker，同理：这份探针的 widget 要测的是**页面自身代码**在
  // CSP 下的行为（eval、<style> 注入、`getComputedStyle`），并且结果同样写 `window.__probes`。
  // 放进 Worker 那些就不成立了 —— 这条同时也是「例外名单真管用」的现场证据。
  await c.ev(`localStorage.setItem('host:widget-realm-plugin-host', ${JSON.stringify(PROBE_ID)})`);

  // 起点必须自己清干净：Vite 已不 watch plugins/，页面不会因 fixture 写入而重载，
  // 上一轮（尤其是崩溃的那轮）遗留的挂载会抑制本轮 mount，看起来像「探针没执行」
  await c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);
  await c.ev(`window.__probes = []; window.__canary = []`);

  // 上一轮崩溃可能把探针留在启用清单里：目录 watcher 会据此自动激活它，
  // 于是测试自己看到的 badge 里多出别人（宿主）挂的容器。起点钉死清单。
  // C1 起这份清单归宿主，写只认设置窗 —— 别再碰 localStorage 那个旧键。
  {
    const prev = await readEnabledIds(invoke(c));
    const clean = prev.filter((id) => id !== PROBE_ID && id !== NET_ID);
    if (clean.join(",") !== prev.join(",")) await setEnabled(clean);
  }

  // 页面若在测试中途重载（编辑触发的 HMR、崩溃），window 上的句柄与计数会凭空消失，
  // 表现为看不懂的 TypeError。这里埋一个世代标记，越界时给出可执行的提示。
  const TOKEN = `verify-${Date.now()}`;
  await c.ev(`window.__verifyToken = ${JSON.stringify(TOKEN)}`);
  const guard = async () => {
    if (!(await c.ev(`window.__verifyToken === ${JSON.stringify(TOKEN)}`))) {
      throw new Error("页面在测试期间发生了重载（多为 HMR 触发），本次结果不可信 —— 重跑 npm run verify");
    }
  };

  const invoke_ = invoke(c);
  const listed = await invoke_("plugins_list");
  r.check("宿主能列出探针插件", true, (listed.v ?? []).some((m) => m.id === PROBE_ID));

  await guard();
  r.group("零权限插件（manifest.permissions = []）的越权尝试");
  await c.ev(MOUNT_BARE);
  const bare = await c.ev(`window.__probes[0]`);
  if (!bare) throw new Error("探针 widget 未执行 mount()");
  r.check("发布自己 topic 需声明 bus:publish", "BLOCKED", bare.attempts.publish_own);
  r.check("发布他人 topic", "BLOCKED", bare.attempts.publish_foreign);
  r.check("发布宿主 topic", "BLOCKED", bare.attempts.publish_host);
  r.check("通配发布", "BLOCKED", bare.attempts.publish_wildcard);
  r.check("订阅自己命名空间放行", "THROUGH", bare.attempts.subscribe_own);
  r.check("订阅自己命名空间通配放行", "THROUGH", bare.attempts.subscribe_own_wildcard);
  r.check("未声明 bus:subscribe 时订阅宿主 topic", "BLOCKED", bare.attempts.subscribe_host);
  r.check("全通配订阅 *", "BLOCKED", bare.attempts.subscribe_all_wildcard);
  r.check("通配订阅他人命名空间", "BLOCKED", bare.attempts.subscribe_foreign_wildcard);
  r.check("bus 视图只暴露 publish/subscribe", ["publish", "subscribe"], bare.busKeys);
  r.check("拿不到 inject", false, bare.hasInject);
  r.check("拿不到 handlers", false, bare.hasHandlers);

  r.group("正向对照：声明了能力就该放行（证明上面的拦不是无条件抛错）");
  // S2 之后中继那侧还要看授权表，所以这条「放行」得真把 bus:publish 要到手才算端到端
  r.check("探针经同意框拿到 bus:publish", true, await grantProbeCap("bus:publish"));
  await c.ev(MOUNT_CAPPED);
  const capped = await c.ev(`window.__probes[1]`);
  r.check("声明后发布自己 topic 放行", "THROUGH", capped?.attempts?.publish_own);
  r.check("声明后订阅宿主 topic 放行", "THROUGH", capped?.attempts?.subscribe_host);
  r.check("声明后仍不得发布他人 topic", "BLOCKED", capped?.attempts?.publish_foreign);

  r.group("被拦的发布不得漏给真实订阅者");
  r.check("金丝雀没收到伪造的 ble:heart-rate", 0, await c.ev(`window.__canary.length`));

  await guard();
  r.group("widget 挂载生命周期");
  // 用增量而不是绝对计数：宿主自己也可能挂过同名容器，绝对数在共享 DOM 上不可靠
  const sel = `#widget-badge > div[data-plugin-id="${PROBE_ID}"]`;
  const badgeCount = () => c.ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  await c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);
  const base = await badgeCount();
  await c.ev(MOUNT_BARE);
  r.check("mount 后容器 +1", base + 1, await badgeCount());
  await c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);
  r.check("卸载后回到基线", base, await badgeCount());
  r.check("卸载后 has() 为假", false, await c.ev(`window.__wh.has(${JSON.stringify(PROBE_ID)})`));

  r.group("并发重复挂载竞态");
  const base2 = await badgeCount();
  await Promise.all([c.ev(MOUNT_BARE), c.ev(MOUNT_BARE)]);
  r.check("同时两次 mount 只 +1", base2 + 1, await badgeCount());
  await c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);

  r.group("宿主侧规则（直打 invoke，绕过 JS 能力桥）");
  const undeclared = await invoke_("permission_request", {
    pluginId: "com.pet.hr-ble",
    capabilities: ["camera:record"],
  });
  r.check("未声明能力被拒", true, !undeclared.ok && /未在 manifest 声明/.test(String(undeclared.e)));
  const spoofAnswer = await invoke_("consent_answer", { reqId: "rNOPE", granted: true });
  r.check("非同意框窗口不能应答授权", true, !spoofAnswer.ok && /does not own/.test(String(spoofAnswer.e)));
  const spoofDetails = await invoke_("consent_details", { reqId: "rNOPE" });
  r.check("非同意框窗口不能读授权详情", true, !spoofDetails.ok && /does not own/.test(String(spoofDetails.e)));

  const ids = (await invoke_("plugins_list")).v?.map((m) => m.id) ?? [];
  r.check("冒名目录的 id 未被列入", false, ids.includes(SPOOF_DIR));
  r.check("id 无重复（冒名者未顶替合法插件）", ids.length, new Set(ids).size);

  // 上面都是测试主动 mount；这一组让宿主在页面加载时自己去 import 入口与 widget，
  // 覆盖 activatePlugin 那条 import（petplugin 协议的真实使用方）
  r.group("宿主自身激活路径");
  const prevEnabled = await readEnabledIds(invoke_);
  await setEnabled([PROBE_ID]);
  await reloadAndWait(c);
  const badgeSelector = `#widget-badge > div[data-plugin-id=${JSON.stringify(PROBE_ID)}]`;
  const mountedByHost = await waitUntil(c, `!!document.querySelector(${JSON.stringify(badgeSelector)})`);
  if (!mountedByHost) {
    // 失败时把现场打出来，否则只能看到一句 false
    console.log(
      "     现场: activated=" +
        (await c.ev(`window.__probeActivated ?? 'none'`)) +
        " 选择器再查一次=" +
        (await c.ev(`!!document.querySelector(${JSON.stringify(badgeSelector)})`)) +
        " 命中数=" +
        (await c.ev(`document.querySelectorAll('div[data-plugin-id]').length`)) +
        " 全部 id=" +
        JSON.stringify(await c.ev(`[...document.querySelectorAll('div[data-plugin-id]')].map(d=>d.dataset.pluginId+':'+d.dataset.region)`)) +
        " enabled=" +
        JSON.stringify(await readEnabledIds(invoke_)),
    );
  }
  r.check("探针 widget 由宿主挂载成功", true, mountedByHost);
  r.check(
    "探针插槽的 realm 戳是 host（widget 那份例外名单在真实装载路径上管用）",
    "host",
    (await waitWidgetRealm(c, PROBE_ID, "badge", "host", 20_000)).actual,
  );
  r.check("入口 index.js 的 activate() 被调用", true, await c.ev(`(window.__probeActivated ?? 0) >= 1`));

  r.group("启停清单归宿主：清掉 WebView 存储也不丢（C1）");
  const beforeClear = await readEnabledIds(invoke_);
  // 只删那个旧键：localStorage.clear() 会连游戏模式开关等别的 WebView 状态一起抹掉，
  // 那不是本条要证的，也不该在回归里顺手改用户设置
  await c.ev(`localStorage.removeItem('host:enabled-plugins'); true`);
  await reloadAndWait(c);
  r.check(
    "旧键删掉并重启后，清单原样还在",
    JSON.stringify(beforeClear),
    JSON.stringify(await readEnabledIds(invoke_)),
  );
  r.check("探针仍在这份清单里（宿主那份才是来源）", true, (await readEnabledIds(invoke_)).includes(PROBE_ID));
  // 反向对照：把旧键写成干扰值，运行时读的仍该是宿主那份
  await c.ev(`localStorage.setItem('host:enabled-plugins', JSON.stringify(["zz.nobody"])); true`);
  await reloadAndWait(c);
  const afterPoison = await readEnabledIds(invoke_);
  r.check("旧键被写成干扰值后仍以宿主那份为准", true, afterPoison.includes(PROBE_ID) && !afterPoison.includes("zz.nobody"));
  r.check(
    "宠物窗运行时的启停判定跟着宿主走",
    true,
    await c.ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); return (await rt.loadEnabled()).includes(${JSON.stringify(PROBE_ID)}); })()`),
  );
  await c.ev(`localStorage.removeItem('host:enabled-plugins'); true`);

  // 迁移命令只认宠物窗，且只在清单文件还没写过时落盘 —— 拒绝与回读各钉一条
  r.group("启停清单迁移命令（plugin_enabled_migrate）：只认宠物窗、只在未初始化时写");
  const staleMigrate = await settings.invoke("plugin_enabled_migrate", { ids: [] });
  r.check("设置窗调迁移被窗口门禁拒", "denied", staleMigrate.code);
  // 用原始 plugin_enabled_list 判「文件写过没有」：readEnabledIds 会把 null 归一成 []，分不出来
  const migList = (await invoke_("plugin_enabled_list")).v;
  if (migList === null) {
    r.info("跳过迁移原样回读断言", "宿主清单还没写过（fresh 环境）——迁移这一步只在首启时才落盘");
  } else {
    const forgedMigrate = await invoke_("plugin_enabled_migrate", { ids: ["zz.forged"] });
    const migAfter = (await invoke_("plugin_enabled_list")).v;
    r.check(
      "已有清单时迁移是原样回读：带伪造 ids 调完，返回与清单逐字相等",
      JSON.stringify([migList, migList]),
      JSON.stringify([forgedMigrate.v, migAfter]),
    );
  }

  r.group("热安装 / 热移除（不重启宿主，仅靠 plugins 目录 watcher）");
  // 先造出「有启用记录但目录不存在」的状态：此时不该有任何激活。
  // 探针此刻还在跑，目录被移走会让宠物窗整页热重载（本卡的新行为）：先武装
  // load 事件再删目录，等这次重载真的落地 —— 不等的话它会掀掉下面刚要埋的哨兵。
  const removalArmed = armPageReload();
  removeFixtures(PLUGINS_DIR);
  if (await removalArmed) await sleep(600); // 与 reloadAndWait 同口径：等新文档的 reconcile 跑完
  await setEnabled([PROBE_ID]);
  await reloadAndWait(c);
  // 载荷探针：本卡把广播载荷从 () 换成了 { ids }，用它判「带得出变更的插件 id」。
  // 装在这里是因为刚 reloadAndWait 过，这段流程直到写完 fixtures 不会再换文档。
  await c.ev(RESET_CHANGE_SPY);
  // 哨兵：整段测试期间页面一旦被重载，下面的结论就都不成立
  await c.ev(`window.__hotSentinel = "armed"`);
  r.check("仅有启用记录、目录缺失时不激活", false, await c.ev(`(window.__probeActivated ?? 0) >= 1`));
  writeFixtures(PLUGINS_DIR);
  r.check("放入目录后免重启即激活", true, await waitUntil(c, `(window.__probeActivated ?? 0) >= 1`, 20_000));
  r.check("目录变动的广播带得出变更的插件 id", true, await waitUntil(c, sawChangedId(PROBE_ID), 10_000));
  r.check("widget 容器随之出现", true, await c.ev(`!!document.querySelector('div[data-plugin-id=${JSON.stringify(PROBE_ID)}]')`));
  r.check("期间页面未重载（激活确实来自 watcher）", "armed", await c.ev(`window.__hotSentinel ?? '页面被重载了'`));

  r.group("覆盖插件代码后不必重载即生效（import 带 cache-busting）");
  // 版本号一字不改、只改代码 —— 这正是 ESM 模块缓存会坑人的形状：URL 恒定的话
  // 关掉再打开拿到的还是内存里那份旧模块，「放进目录即生效」对代码变更就不成立了
  const ver = await invoke_("plugin_file_version", { pluginId: PROBE_ID, rel: "index.js" });
  r.check("宿主能给出文件修改时间", true, Number.isInteger(ver.v) && ver.v > 0);
  const badRel = await invoke_("plugin_file_version", { pluginId: PROBE_ID, rel: "../manifest.json" });
  r.check("越出插件目录的路径拿不到", true, !badRel.ok);

  // 探针换成「入口 + 顶层子模块 + 嵌套子模块」形状，先载入第一版（E1/T1/L1）。
  // 准备阶段必须不换文档：先把探针停掉再写文件（不承载它的窗口不会重载），写完等
  // 去抖窗口里的那次广播真的出来（HEAD 上等不到，超时后照常往下走），再手动开回来 ——
  // 开回来加载到的就是磁盘上的第一版。
  const pentry = (flavor) => `import { top } from "./top.js";
import { leaf } from "./nested/leaf.js";
export function activate() {
  window.__probeFlavor = ${JSON.stringify(flavor)};
  window.__probeTop = top;
  window.__probeLeaf = leaf;
  window.__probeActivated = (window.__probeActivated || 0) + 1;
}
export function deactivate() { window.__probeDeactivated = (window.__probeDeactivated || 0) + 1; }
`;
  mkdirSync(join(PLUGINS_DIR, PROBE_ID, "nested"), { recursive: true });
  await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    await rt.deactivatePlugin(${JSON.stringify(PROBE_ID)});
    return true;
  })()`);
  // 探针先重置：下面要等的必须是「这次写入」触发的那轮广播，不能拿上一轮的陈旧载荷蒙混
  await c.ev(RESET_CHANGE_SPY);
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "top.js"), `export const top = "T1";\n`);
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "nested", "leaf.js"), `export const leaf = "L1";\n`);
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "index.js"), pentry("E1"));
  await waitUntil(c, sawChangedId(PROBE_ID), 4_000);
  // 万一有迟到的广播把这次显式 activate 打断，新文档的 initRuntime 也会把它装回来 ——
  // 下面的等待断言只认最终状态，过程性中断不该把整条断言链打断
  await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    const ms = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    await rt.activatePlugin(ms.find((m) => m.id === ${JSON.stringify(PROBE_ID)}));
    return true;
  })()`).catch(() => undefined);
  r.check(
    "子模块形状的第一版已载入（E1/T1/L1）",
    true,
    await waitUntil(c, `window.__probeFlavor === 'E1' && window.__probeTop === 'T1' && window.__probeLeaf === 'L1'`, 15_000),
  );

  // 三种覆盖形状，各只动一个文件、入口其余行一字不动。已激活插件的文件被覆盖时
  // dev 下承载它的窗口会整页热重载（模块映射表只有换文档才会丢，?v= 管不到子模块），
  // 断言只等「新值自己出现」，不替产品做任何重载 —— 因此未改动代码上必然红：
  // 子模块覆盖连事件都不发，入口覆盖也只会命中同一 realm 的旧模块实例。
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "top.js"), `export const top = "T2";\n`);
  r.check("覆盖顶层子模块后免手动重载即生效", true, await waitUntil(c, `window.__probeTop === 'T2'`, 20_000));
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "nested", "leaf.js"), `export const leaf = "L2";\n`);
  r.check("覆盖嵌套子模块后免手动重载即生效", true, await waitUntil(c, `window.__probeLeaf === 'L2'`, 20_000));
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "index.js"), pentry("B"));
  r.check("覆盖入口文件后免手动重载即生效", true, await waitUntil(c, `window.__probeFlavor === 'B'`, 20_000));

  // 上面每条覆盖都可能把文档换了一茬：这条既有断言现在跑在已经落地的新文档上，
  // 判的仍是「deactivate → activate 之后读到的就是磁盘上的当前代码」。
  const swapped = await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    await rt.deactivatePlugin(${JSON.stringify(PROBE_ID)});
    const wasActive = rt.isActive(${JSON.stringify(PROBE_ID)});
    const ms = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    const manifest = ms.find((m) => m.id === ${JSON.stringify(PROBE_ID)});
    const enabledAtCall = rt.getEnabled();
    await rt.activatePlugin(manifest);
    return {
      flavor: window.__probeFlavor ?? null,
      wasActive,
      activeAfter: rt.isActive(${JSON.stringify(PROBE_ID)}),
      enabledAtCall,
      declared: manifest?.permissions ?? null,
    };
  })()`);
  if (swapped.flavor !== "B") {
    // 三条早退路径都长得一样「没跑新代码」：清单里没它、权限没过、模块 URL 没变（命中旧缓存）
    r.info("flavor 没换成 B 时的现场", JSON.stringify(swapped));
  }
  r.check("关掉再打开就跑的是新代码", "B", swapped.flavor);
  const sameVersion = (await invoke_("plugins_list")).v?.find((m) => m.id === PROBE_ID)?.version;
  r.check("前后是同一个版本号（改的只有代码）", "0.0.0", sameVersion);
  // 上面那次「关掉再打开」本身会跑一次 deactivate：计数器归零再往下断言，
  // 否则下面等的就是上一次的结果，热移除那条路径根本没被等到
  await c.ev(`window.__probeFlavor = null; window.__probeDeactivated = 0; true`);

  // 目录被移走时探针仍活跃：固定版的宠物窗整页热重载（新文档里它不再被装起来）；
  // HEAD 形状走 watcher → reconcile → deactivate 那条路（deactivate 计数器可观察）。
  // 两条形状的共同结论必须都成立：插件停了。先武装 load 事件再删目录。
  const goneArmed = armPageReload();
  removeFixtures(PLUGINS_DIR);
  const goneByReload = await goneArmed;
  if (goneByReload) await sleep(600); // 等新文档的 reconcile 跑完
  const stopped = goneByReload
    ? await waitUntil(
        c,
        `(window.__probeActivated ?? 0) === 0 && document.querySelectorAll('div[data-plugin-id=${JSON.stringify(PROBE_ID)}]').length === 0`,
        10_000,
      )
    : await waitUntil(c, `(window.__probeDeactivated ?? 0) >= 1`, 20_000);
  r.check("移走目录后自动 deactivate", true, stopped);
  // 容器消失是 deactivate 之后异步拆的，等它真的没了再断言（原来只 sleep 赌一把）
  const removedSelector = `div[data-plugin-id=${JSON.stringify(PROBE_ID)}]`;
  await waitUntil(c, `document.querySelectorAll(${JSON.stringify(removedSelector)}).length === 0`, 10_000);
  r.check("widget 容器随之移除", 0, await c.ev(`document.querySelectorAll(${JSON.stringify(removedSelector)}).length`));

  r.group("存储门禁：能力授权收在 Rust 侧（绕过 JS 桥的直接 invoke）");
  writeFixtures(PLUGINS_DIR);
  await sleep(1200);
  await revoke(PROBE_ID); // 起点确定：探针手里没有 storage
  const denySet = await invoke_("store_set", { pluginId: PROBE_ID, key: "prefs", value: { mode: "badge" } });
  r.check("未授权 storage 的写入被宿主拒绝", true, !denySet.ok && /未授权 storage/.test(String(denySet.e)));
  const denyGet = await invoke_("store_get", { pluginId: PROBE_ID, key: "prefs" });
  r.check("未授权 storage 的读取被宿主拒绝", true, !denyGet.ok && /未授权 storage/.test(String(denyGet.e)));
  const denyDel = await invoke_("store_delete", { pluginId: PROBE_ID, key: "prefs" });
  r.check("未授权 storage 的删除被宿主拒绝", true, !denyDel.ok && /未授权 storage/.test(String(denyDel.e)));
  // A2/ADR-0007：store_* 已迁到 `{code, message}`。文本判据一条没减，这里只是**多**要求宿主发了码
  r.check("三条存储命令的拒绝都带 code=denied", "denied|denied|denied", [denySet.code, denyGet.code, denyDel.code].join("|"));
  r.check("错误负载的形状就是 code 与 message 两个键", true, denyDel.ok === false && typeof denyDel.e === "string" && denyDel.e.length > 0);
  // 旧的手写检查只挡 `..` `/` `\` 与空串，带冒号的盘符 id 放得过；现在与 is_safe_id 同一口径
  for (const [label, badId] of [["盘符式 id", "C:"], ["分隔符", "a/b"], ["过短", "ab"], ["大写", "Todo"]]) {
    const denied = await invoke_("store_get", { pluginId: badId, key: "prefs" });
    r.check(`${label}（${badId}）按非法 id 被拒`, true, !denied.ok && /invalid plugin id/.test(String(denied.e)));
    r.check(`${label} 的码是 invalid-arg（同一文案跨命令同码）`, "invalid-arg", denied.code);
  }

  r.group("撤销授权连带清理插件存储");
  r.check("声明 storage 并同意后才拿得到读写能力", true, await grantProbeCap("storage"));
  const written = await invoke_("store_set", { pluginId: PROBE_ID, key: "prefs", value: { mode: "badge" } });
  r.check("授权后写入成功", true, written.ok === true);
  const readBack = () =>
    c.ev(
      `(async()=>{ try { const v = await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(PROBE_ID)}, key: 'prefs' }); return v?.mode ?? null; } catch { return "REJECTED"; } })()`,
    );
  r.check("写入可读回", "badge", await readBack());
  r.check("宿主的落盘目录已建", true, existsSync(STORE_DIR));
  const petRevoke = await invoke_("permission_revoke", { pluginId: PROBE_ID });
  r.check("宠物窗撤销授权被门禁拒绝", true, !petRevoke.ok && /设置窗/.test(String(petRevoke.e)));
  const petList = await invoke_("permission_list");
  r.check("宠物窗读授权表同样被拒", true, !petList.ok && /设置窗/.test(String(petList.e)));
  await revoke(PROBE_ID);
  const afterRevoke = await invoke_("store_get", { pluginId: PROBE_ID, key: "prefs" });
  r.check("撤销后同一调用重新被宿主拒绝", true, !afterRevoke.ok && /未授权 storage/.test(String(afterRevoke.e)));
  r.check("落盘目录随之删除", false, existsSync(STORE_DIR));

  r.group("BLE 命令也查授权表（不再是有桥无门的后门）");
  // JS 能力桥一直按 manifest 校验，但 Rust 侧命令原先不认调用者：
  // 绕过桥直接 invoke 的插件扫描/连接任何设备都不需要授权，与自述的能力模型不符
  const scanDenied = await invoke_("ble_start_scan", { pluginId: PROBE_ID });
  r.check("未授权 ble:scan 就扫不动", true, !scanDenied.ok && /未授权/.test(String(scanDenied.e)));
  const connectDenied = await invoke_("ble_connect", { pluginId: PROBE_ID, deviceId: "aa:bb" });
  r.check("未授权 ble:connect 就连不上", true, !connectDenied.ok && /未授权/.test(String(connectDenied.e)));
  const readDenied = await invoke_("ble_connected_device", { pluginId: PROBE_ID });
  r.check("读连接状态同样要授权", true, !readDenied.ok && /未授权/.test(String(readDenied.e)));
  const badId = await invoke_("ble_start_scan", { pluginId: "a/b" });
  r.check("非法插件 id 直接拒", true, !badId.ok && /invalid plugin id/.test(String(badId.e)));
  // 断开与停扫走同一把能力门禁：这里只验「没授权时一个也过不去」
  const discDenied = await invoke_("ble_disconnect", { pluginId: PROBE_ID });
  r.check("未授权 ble:connect 就断开被拒", "denied", discDenied.code);
  const stopScanDenied = await invoke_("ble_stop_scan", { pluginId: PROBE_ID });
  r.check("未授权 ble:scan 就停不了扫描", "denied", stopScanDenied.code);

  // 放行路径要真授权才进得来：两条前置各自走一次真实同意框（grantProbeCap 内部应答）
  r.group("扫描启停与断开的放行路径（真实适配器，无心率设备）");
  await grantProbeCap("ble:connect");
  const idleConn = await invoke_("ble_connected_device", { pluginId: PROBE_ID });
  if (idleConn.ok === true && idleConn.v === null) {
    const idleDisc = await invoke_("ble_disconnect", { pluginId: PROBE_ID });
    r.check("没连设备时断开是幂等空操作", true, idleDisc.ok);
  } else {
    // 护栏：用户真连着心率设备时不替他把连接掐掉
    r.info("跳过 ble_disconnect 空操作断言", `连接状态=${JSON.stringify(idleConn.v ?? idleConn.e ?? null)}（有设备在场就不动它）`);
  }
  await grantProbeCap("ble:scan");
  const scanStart = await invoke_("ble_start_scan", { pluginId: PROBE_ID });
  await sleep(1200); // 真扫约 1 秒：让适配器真的转起来再停，不是只测参数解析
  const scanStop1 = await invoke_("ble_stop_scan", { pluginId: PROBE_ID });
  const scanStop2 = await invoke_("ble_stop_scan", { pluginId: PROBE_ID });
  r.check("授权后扫描启停放行：起扫→停扫→再停都 ok", "true|true|true", [scanStart.ok, scanStop1.ok, scanStop2.ok].join("|"));

  r.group("总线自递归必须被深度上限截断");
  // 嵌套调用走 inject 而不是 publish：两者共用同一个 dispatch（被测的就是它），
  // 但 publish 每次都要过一趟 IPC，突发十几次会触发 Tauri 的 postMessage 回退，噪音盖过信号
  const rec = await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    let n = 0;
    const off = bus.subscribe('zz.probe:rec:*', () => { n++; bus.inject('zz.probe:rec:x', {}); });
    let threw = null;
    try { bus.inject('zz.probe:rec:x', {}); } catch (e) { threw = String(e); }
    off();
    let after = 0;
    const off2 = bus.subscribe('zz.probe:after', () => after++);
    bus.inject('zz.probe:after', {});
    off2();
    return { n, threw, after };
  })()`);
  r.check("递归被截断在有限层", true, rec.n > 1 && rec.n <= 12);
  r.check("截断后总线仍可正常派发", 1, rec.after);
  await sleep(600); // console 事件是异步送达的
  r.check("深度上限有明确告警", true, c.noise.some((x) => x.includes("派发递归")));

  r.group("同意框被直接关掉 → 立刻按拒绝结束，不空等 60s");
  const HR = "com.pet.hr-ble";
  const hrManifest = (await invoke_("plugins_list")).v?.find((m) => m.id === HR);
  const savedConfig = await invoke_("store_get", { pluginId: HR, key: "config" });
  await revoke(HR);
  const pending = c.ev(
    `window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(HR)}, capabilities: ['ble:scan'] })`,
  );
  let consentClosed = false;
  try {
    const consent = await driveConsent("close", HR);
    r.check("同意框列出了待授权能力", true, consent.caps.length >= 1);
    r.check("关的是同意框自己的窗口", true, consent.label.startsWith("consent-"));
    consentClosed = true;
  } catch (err) {
    console.log("     没能操作同意框窗口: " + String(err?.message ?? err).split("\n")[0]);
  }
  const raced = await Promise.race([
    pending.then((v) => ({ done: true, v })).catch((e) => ({ done: true, v: "ERR " + e })),
    new Promise((res) => setTimeout(() => res({ done: false }), 15_000)),
  ]);
  r.check("关窗后调用立即返回（未卡满超时）", true, consentClosed && raced.done);
  // 期望值就是「false」这个返回值本身：写成断言 raced.v === false 的话，
  // 抛错（v 是 "ERR …"）和超时（v 是 undefined）也会算通过
  r.check("按拒绝处理", false, raced.v);

  // 还原用户授权：重新走一次同意框并点「允许」
  if (hrManifest?.permissions?.length) {
    const regrant = c.ev(
      `window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(HR)}, capabilities: ${JSON.stringify(hrManifest.permissions)} })`,
    );
    try {
      const again = await driveConsent("allow", HR);
      r.check("重新弹出的同意框带插件名", true, again.name.includes("心率"));
    } catch (err) {
      console.log("     还原授权失败: " + String(err?.message ?? err).split("\n")[0]);
    }
    r.check("点允许后宿主放行", true, await regrant);
    if (savedConfig?.v !== undefined && savedConfig?.v !== null) {
      await invoke_("store_set", { pluginId: HR, key: "config", value: savedConfig.v });
    }
  }

  await setEnabled(prevEnabled);
  await reloadAndWait(c);

  r.group("共享资源持有者计数（停用不得误伤他插件）");
  const res = await c.ev(`(async () => {
    const m = await import('/src/runtime/resources.ts');
    m.claim('ble', 'zz.a');
    m.claim('ble', 'zz.b');
    const firstRelease = m.release('ble', 'zz.a');
    const secondRelease = m.release('ble', 'zz.b');
    m.claim('ble-scan', 'zz.c');
    const scanIndependent = m.release('ble', 'zz.c');
    return {
      nonHolderRelease: m.release('ble', 'zz.not-a-holder'),
      firstRelease,
      secondRelease,
      scanIndependent,
    };
  })()`);
  r.check("非持有者 release 不触发释放", false, res.nonHolderRelease);
  r.check("仍有人持有时不释放", false, res.firstRelease);
  r.check("最后一个持有者退出才释放", true, res.secondRelease);
  r.check("ble 与 ble-scan 各自独立计数", false, res.scanIndependent);

  r.group("存储损坏必须报错，不能被当成空表后覆盖");
  // 上面那组以撤销收尾，这里要读写就重新走一次同意框（S1 之后宿主按能力放行）
  r.check("重新拿到 storage 授权", true, await grantProbeCap("storage"));
  const STORE_FILE = join(STORE_DIR, "store.json");
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_FILE, "{ 这不是合法 json");
  const brokenRead = await invoke_("store_get", { pluginId: PROBE_ID, key: "prefs" });
  r.check("读取损坏文件返回错误", true, !brokenRead.ok && /损坏/.test(String(brokenRead.e)));
  const brokenWrite = await invoke_("store_set", { pluginId: PROBE_ID, key: "prefs", value: 1 });
  r.check("损坏状态下拒绝写入", true, !brokenWrite.ok);
  r.check("原文件未被静默改写", true, readFileSync(STORE_FILE, "utf8").includes("这不是合法"));
  rmSync(STORE_DIR, { recursive: true, force: true });

  r.group("总线发布门禁（S2）：topic 归属与 bus:publish 授权收在 Rust 侧");
  // 中继那侧原先不设限：绕过 JS 桥的插件可以往 ble:heart-rate、agent:state 这类
  // 宿主 topic 或他人前缀灌数据，全桌面的窗口都会收到。
  await revoke(PROBE_ID); // 起点确定：上面「正向对照」刚把 bus:publish 授出去
  const pubNoId = await invoke_("bus_publish", { topic: `${PROBE_ID}:self`, payload: { n: 1 } });
  r.check("不带 pluginId 的发布被拒", true, !pubNoId.ok && /需要 pluginId/.test(String(pubNoId.e)));
  const pubOwn = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: `${PROBE_ID}:self`, payload: { n: 1 } });
  r.check("未授权 bus:publish 连自己前缀也发不出", true, !pubOwn.ok && /未授权 bus:publish/.test(String(pubOwn.e)));
  r.check("声明并同意后拿到 bus:publish", true, await grantProbeCap("bus:publish"));
  const pubHost = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: "ble:heart-rate", payload: { bpm: 666 } });
  r.check("有了 bus:publish 也伪造不了宿主 topic", true, !pubHost.ok && /前缀/.test(String(pubHost.e)));
  const pubAgent = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: "agent:state", payload: { state: "idle" } });
  r.check("agent:state 同样灌不进去", true, !pubAgent.ok && /前缀/.test(String(pubAgent.e)));
  const pubForeign = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: "com.pet.hr-ble:bpm", payload: { bpm: 666 } });
  r.check("他人前缀同样被拒", true, !pubForeign.ok && /前缀/.test(String(pubForeign.e)));
  const pubOwnOk = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: `${PROBE_ID}:self`, payload: { n: 2 } });
  r.check("自己前缀照常放行", true, pubOwnOk.ok === true);
  const pubEmptyTopic = await invoke_("bus_publish", { pluginId: PROBE_ID, topic: `${PROBE_ID}:`, payload: {} });
  r.check("光秃秃的前缀不算自己的 topic", true, !pubEmptyTopic.ok && /前缀/.test(String(pubEmptyTopic.e)));
  const pubGone = await invoke_("bus_publish", { pluginId: "zz.gone", topic: "zz.gone:self", payload: {} });
  r.check("没装着的插件借不了名义", true, !pubGone.ok && /没有安装/.test(String(pubGone.e)));
  const pubBadId = await invoke_("bus_publish", { pluginId: "C:", topic: "C:x", payload: {} });
  r.check("非法 id 直接拒", true, !pubBadId.ok && /invalid plugin id/.test(String(pubBadId.e)));

  r.group("悬浮层门禁（S3）：未授权 overlay 开不出置顶窗");
  const ovBadId = await invoke_("overlay_show", { pluginId: "a/b", x: 64, y: 64, height: 120 });
  r.check("非法 id 被拒", true, !ovBadId.ok && /非法的插件 id/.test(String(ovBadId.e)));
  const ovNoGrant = await invoke_("overlay_show", { pluginId: PROBE_ID, x: 64, y: 64, height: 120 });
  r.check("未授权 overlay 的开窗被拒", true, !ovNoGrant.ok && /未授权 overlay/.test(String(ovNoGrant.e)));
  const hideNoGrant = await invoke_("overlay_hide", { pluginId: PROBE_ID });
  r.check("未授权 overlay 的收起同样被拒", true, !hideNoGrant.ok && /未授权 overlay/.test(String(hideNoGrant.e)));
  const destroyNoGrant = await invoke_("overlay_destroy", { pluginId: PROBE_ID });
  r.check("未授权 overlay 的销毁同样被拒", true, !destroyNoGrant.ok && /未授权 overlay/.test(String(destroyNoGrant.e)));
  // 宿主的回收通道不该插件面能用：它只认宠物窗里的运行时
  const reclaimFromSettings = await settings.invoke("overlay_reclaim", { pluginId: PROBE_ID });
  r.check("设置窗调宿主回收通道被窗口门禁拒绝", true, !reclaimFromSettings.ok && /宠物窗/.test(String(reclaimFromSettings.e)));
  r.check("声明并同意后拿到 overlay", true, await grantProbeCap("overlay"));
  const opened = await invoke_("overlay_show", { pluginId: PROBE_ID, x: 64, y: 64, height: 120 });
  r.check("授权后开窗命令被放行", true, opened.ok === true);
  // 过渡期兼容（ADR-0010 决策 3）：第三方老插件还在传 placement —— 接受并忽略，不报错、照常开窗
  const legacyPlacement = await invoke_("overlay_show", { pluginId: PROBE_ID, placement: "above-pet", height: 120 });
  r.check("带旧 placement 的调用仍能开窗（过渡期兼容）", true, legacyPlacement.ok === true);
  r.check(
    "注册表里有了这一扇",
    true,
    await waitUntil(c, `(async () => (await window.__TAURI_INTERNALS__.invoke('overlay_list')).some(([id]) => id === ${JSON.stringify(PROBE_ID)}))()`, 10_000),
  );
  // 「本体永远压住所有 overlay」这条真窗判据不挂在这里：探针那扇"窗"其实是空注册表条目
  // （实测 `plugin:window|is_visible` 回 `window not found`，而 overlay_list 里有条目）——
  // 拿它当前提会把"前置没满足"误报成回归。判据挪到 overlay_owner 组之后，
  // 那里两扇插件窗可证活着（它们的页面刚被 attach 过并答出归属）。
  await invoke_("overlay_hide", { pluginId: PROBE_ID });
  r.check(
    "授权后收得掉",
    true,
    await waitUntil(
      c,
      `(async () => !(await window.__TAURI_INTERNALS__.invoke('overlay_list')).some(([id, visible]) => id === ${JSON.stringify(PROBE_ID)} && visible))()`,
      10_000,
    ),
  );
  // 撤销授权后能力没了，插件面的销毁命令会过不去 —— 宿主必须已经把窗收掉，不能留孤儿窗
  await invoke_("overlay_show", { pluginId: PROBE_ID, x: 64, y: 64, height: 120 });
  await revoke(PROBE_ID);
  r.check(
    "撤销授权连带收掉该插件的悬浮层",
    true,
    await waitUntil(
      c,
      `(async () => !(await window.__TAURI_INTERNALS__.invoke('overlay_list')).some(([id]) => id === ${JSON.stringify(PROBE_ID)}))()`,
      10_000,
    ),
  );
  const reclaimed = await invoke_("overlay_reclaim", { pluginId: PROBE_ID });
  r.check("宿主回收通道在宠物窗里可用（幂等）", true, reclaimed.ok === true);
  // 上面为验证「撤销连带收窗」把探针的能力全撤了；后面的挂载/回显分组还要以它的
  // 名义发消息，这里按同一条真实链路把 bus:publish 要回来（否则中继被拒会往 console 里灌噪音，
  // 打断最后那条「宿主页面自身无告警」的断言）
  r.check("恢复 bus:publish 授权", true, await grantProbeCap("bus:publish"));

  // overlay_owner 没有门禁（悬浮窗开机就要问归属），断言全是归属正确性：
  // 归属只由窗口标签决定 —— 两扇插件窗各答出自己、宿主窗答 null。
  // 悬浮窗是插件起的：没开的用宿主命令补一扇，收尾把补的收掉、把新授的授权收回。
  r.group("overlay_owner：悬浮窗归属由窗口标签决定（两扇插件窗都在）");
  const OWNER_AGENT = "com.pet.agent-bridge";
  const OWNER_HR = "com.pet.hr-ble";
  const OWNER_LABEL = { [OWNER_AGENT]: "overlay-com_pet_agent-bridge", [OWNER_HR]: "overlay-com_pet_hr-ble" };

  // 前置一：起窗要求插件在启停清单里（overlay 页 sync 会自我关闭未启用插件的窗）
  const ownerEnabledAtStart = await readEnabledIds(invoke_);
  const ownerMissingEnabled = [OWNER_AGENT, OWNER_HR].filter((id) => !ownerEnabledAtStart.includes(id));
  if (ownerMissingEnabled.length) await setEnabled([...ownerEnabledAtStart, ...ownerMissingEnabled]);

  // 前置二：开窗命令要 overlay 已授权；没授的当场走真实同意框，记下来收尾撤销
  const ownerGrantedNow = new Set();
  const ownerBackup = {};
  for (const id of [OWNER_AGENT, OWNER_HR]) {
    const prior = (await settings.invoke("permission_list")).v?.[id] ?? [];
    ownerBackup[id] = { prior, config: undefined };
    const pre = await invoke_("permission_check", { pluginId: id, capability: "overlay" });
    if (pre.ok && pre.v === true) {
      r.info(`${id} 的 overlay 已在授权表里`, "本组不新授，也不收尾撤销");
      continue;
    }
    const pending = c
      .ev(`window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(id)}, capabilities: ['overlay'] })`)
      .catch(() => undefined);
    try {
      await driveConsent("allow", id);
    } catch (err) {
      console.log(`     没能操作 ${id} 的 overlay 同意框: ` + String(err?.message ?? err).split("\n")[0]);
    }
    await pending;
    let got = false;
    const grantUntil = Date.now() + 15_000;
    while (Date.now() < grantUntil && !got) {
      const now = await invoke_("permission_check", { pluginId: id, capability: "overlay" });
      got = now.ok && now.v === true;
      if (!got) await sleep(400);
    }
    if (got) {
      ownerGrantedNow.add(id);
      // 撤销会连带清掉存储：先把 config 记下，收尾重授后写回
      const cfgBackup = await invoke_("store_get", { pluginId: id, key: "config" });
      ownerBackup[id].config = cfgBackup.ok && cfgBackup.v !== undefined ? cfgBackup.v : undefined;
    }
    r.info(`${id} 的 overlay 授权`, got ? "经真实同意框拿到（收尾会撤销）" : "没拿到 —— 下面的开窗会被拒");
  }

  // 起窗：注册表里的条目**不等于**活窗（窗自关或被停用后条目可能还挂着、页面已经没了），
  // 所以无条件 show 一次 —— 已有活窗时它是幂等的，死条目/无窗时它把窗建回来。
  // 坐标由插件自定（ADR-0010 决策 4），这里只是给两扇窗一点可区分的落点
  const ownerPrior = {};
  for (const [id, visible] of (await invoke_("overlay_list")).v ?? []) {
    ownerPrior[id] = { entry: true, visible: visible === true };
  }
  for (const [id, x, y, height] of [
    [OWNER_AGENT, 44, 44, 104],
    [OWNER_HR, 24, 24, 200],
  ]) {
    const shown = await invoke_("overlay_show", { pluginId: id, x, y, height });
    if (!shown.ok) r.info(`给 ${id} 开悬浮窗失败`, String(shown.e));
  }

  // 按窗口标签枚举（不按 title 找窗，避开循环论证）：读页面的当前标签 + 它的 overlay_owner 应答。
  // attach 出来的客户端跨轮复用（反复 attach/detach 会把 CDP 调试端点拖垮，本仓踩过）。
  const ownerClients = new Map();
  const ownerMap = {};
  const ownerRound = async () => {
    for (const t of await listPages(PORT).catch(() => [])) {
      if (!/overlay\.html/.test(t.url)) continue;
      let oc = ownerClients.get(t.webSocketDebuggerUrl);
      if (!oc) {
        oc = await attach(PORT, (x) => x.webSocketDebuggerUrl === t.webSocketDebuggerUrl, 8_000).catch(() => null);
        if (!oc) continue;
        ownerClients.set(t.webSocketDebuggerUrl, oc);
      }
      const read = await oc
        .ev(`(async () => ({ label: window.__TAURI_INTERNALS__.metadata.currentWindow.label, owner: await window.__TAURI_INTERNALS__.invoke('overlay_owner') }))()`)
        .catch(() => null);
      if (read?.label) {
        ownerMap[read.label] = read.owner ?? null;
      } else {
        // 页面可能刚被换掉（导航会让旧客户端失效）：丢掉它，下一轮重建
        oc.close();
        ownerClients.delete(t.webSocketDebuggerUrl);
      }
    }
  };
  const ownerUntil = Date.now() + 30_000;
  while (Date.now() < ownerUntil) {
    await ownerRound();
    if (ownerMap[OWNER_LABEL[OWNER_AGENT]] === OWNER_AGENT && ownerMap[OWNER_LABEL[OWNER_HR]] === OWNER_HR) break;
    await sleep(800);
  }
  for (const oc of ownerClients.values()) oc.close();
  r.check("Agent 桥那扇答出自己属于 com.pet.agent-bridge", OWNER_AGENT, ownerMap[OWNER_LABEL[OWNER_AGENT]] ?? null);
  r.check("左上角波形那扇答出自己属于 com.pet.hr-ble", OWNER_HR, ownerMap[OWNER_LABEL[OWNER_HR]] ?? null);
  const petOwner = await invoke_("overlay_owner");
  r.check("宠物窗（非悬浮窗）问归属得到 null", true, petOwner.ok === true && petOwner.v === null);

  // 「本体永远压住所有 overlay」是对外承诺，判据只认真窗次序（ADR-0010 决策 5，不接受
  // "读代码看谁设了 alwaysOnTop"式的论证）。挂在这里是因为这两扇插件窗**可证活着** ——
  // 它们的页面刚被 attach 过并各自答出了归属；可见性也由每扇窗自己问自己（标签取自页面
  // metadata，不靠拼规则），免掉上一版把探针的空注册表条目当活窗、把前置没满足误报成回归的坑。
  // 恢复路径上的重放点只有一处（`set_suppressed` → `apply_visibility` 逐扇重放；原先
  // `set_pet_hidden` 尾部还有一次整体重放，三态实测证明是重复保险，已删）。本条钉承诺本身，
  // 不钉哪一处起作用 —— 三态实验（两处都在／只掐前者／只掐后者）的真窗结果记在 ADR-0010。
  r.group("隐身再恢复：本体仍压住在场的每一扇 overlay（真窗次序）");
  const aliveLabels = Object.keys(ownerMap);
  r.check("这条判据的前提：至少一扇 overlay 页答过归属", true, aliveLabels.length > 0);
  r.check("隐身命令由宠物窗发出并被放行", true, (await invoke_("set_pet_hidden", { hidden: true })).ok === true);
  await sleep(900);
  r.check("恢复命令被放行", true, (await invoke_("set_pet_hidden", { hidden: false })).ok === true);
  const selfVisible = async () => {
    const out = [];
    for (const t of (await listPages(PORT).catch(() => [])).filter((p) => /overlay\.html/.test(p.url))) {
      const oc = await attach(PORT, (x) => x.webSocketDebuggerUrl === t.webSocketDebuggerUrl, 8_000).catch(() => null);
      if (!oc) {
        out.push("attach失败");
        continue;
      }
      const v = await oc
        .ev(
          `(async () => { const I = window.__TAURI_INTERNALS__;
             try { return String(await I.invoke('plugin:window|is_visible', { label: I.metadata.currentWindow.label })); }
             catch (e) { return 'err:' + String((e && e.message) ?? e); } })()`,
        )
        .catch(() => "ev失败");
      oc.close();
      out.push(String(v));
    }
    return out.join(",");
  };
  let visObserved = "";
  for (let i = 0; i < 24 && !/^true(,true)*$/.test(visObserved); i++) {
    visObserved = await selfVisible();
    if (!/^true(,true)*$/.test(visObserved)) await sleep(500);
  }
  r.check(
    "恢复后在场的每一扇 overlay 都自报可见（探针的前置）",
    "yes",
    visObserved.split(",").length > 0 && visObserved.split(",").every((v) => v === "true")
      ? "yes"
      : `no: ${visObserved || "(没采到 overlay 页)"}`,
  );
  r.check("隐藏再恢复宠物后，本体仍压住 overlay", "0 ZORDER samples=3 verdict=pet-top", probeZOrder(45));

  // 收尾：本来就显示着的窗原地不动；其余（我们补开的、或本来就带病/隐藏的）收掉 ——
  // 插件下次需要它时会自己 show 回来。新授的 overlay 撤销前先让插件真的下线 ——
  // 否则它下一次轮询发现能力没了会再弹同意框；撤销连带清掉存储，所以按原样重授 + 写回 config。
  for (const id of [OWNER_AGENT, OWNER_HR]) {
    if (ownerPrior[id]?.entry && ownerPrior[id]?.visible) continue;
    await invoke_("overlay_destroy", { pluginId: id });
  }
  for (const id of ownerGrantedNow) {
    const wasStopped = await c
      .ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); if (!rt.isActive(${JSON.stringify(id)})) return false; await rt.deactivatePlugin(${JSON.stringify(id)}); return true; })()`)
      .catch(() => false);
    const revoked = await settings.invoke("permission_revoke", { pluginId: id });
    if (revoked.ok && ownerBackup[id].prior.length) {
      const regrant = c
        .ev(`window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(id)}, capabilities: ${JSON.stringify(ownerBackup[id].prior)} })`)
        .catch(() => undefined);
      try {
        await driveConsent("allow", id);
      } catch (err) {
        console.log(`     还原 ${id} 授权时没能操作同意框: ` + String(err?.message ?? err).split("\n")[0]);
      }
      const back = await regrant;
      if (ownerBackup[id].config !== undefined) {
        await invoke_("store_set", { pluginId: id, key: "config", value: ownerBackup[id].config }).catch(() => undefined);
      }
      r.info(`已按原样重授 ${id} 的授权`, `${JSON.stringify(ownerBackup[id].prior)} → ${JSON.stringify(back)}${wasStopped ? "（撤销前已先下线）" : ""}`);
    } else if (revoked.ok) {
      r.info(`已收回本组给 ${id} 的 overlay 授权`, JSON.stringify(revoked.v));
    } else {
      r.info(`撤销 ${id} 的 overlay 授权失败`, JSON.stringify(revoked.e));
    }
  }
  if (ownerMissingEnabled.length) await setEnabled(ownerEnabledAtStart);
  // 收尾前换新文档：本组的同意框/开窗会留下在飞 IPC，别让它们污染后面的分组
  await reloadAndWait(c);

  r.group("http 代理与按域名授权（#21）");
  // 热安装那组测试结束时删掉了 fixture，这里要自己造回来：
  // 否则宿主报的是「读不到 manifest」，会被误判成鉴权规则失效
  writeFixtures(PLUGINS_DIR);
  await sleep(1200);
  const LOCAL_URL = "http://localhost:1420/src/index.html";
  const HOST_CAP = "http:localhost:1420";
  const badAsk = await invoke_("permission_request", {
    pluginId: PROBE_ID,
    capabilities: [HOST_CAP],
  });
  r.check("未声明 http 的插件不能申请按域名放行", true, !badAsk.ok && /未在 manifest 声明/.test(String(badAsk.e)));

  const grant = c
    .ev(
      `window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(NET_ID)}, capabilities: ["http", ${JSON.stringify(HOST_CAP)}] })`,
    )
    .catch((e) => "ERR " + e);
  let granted = false;
  try {
    const consent = await driveConsent("allow", NET_ID);
    r.check("http:<host> 视为被 http 覆盖（弹框而非报未声明）", true, consent.caps.some((x) => x.includes("localhost")));
    granted = await grant;
  } catch (err) {
    console.log("     没能走完 http 授权: " + String(err?.message ?? err).split("\n")[0]);
  }
  r.check("域名授权通过后宿主放行", true, granted);

  const fetched = await invoke_("http_request", { pluginId: NET_ID, url: LOCAL_URL });
  r.check("已授权域名能取回内容", true, fetched.v?.status === 200 && String(fetched.v?.body).includes("doctype"));
  const otherHost = await invoke_("http_request", { pluginId: NET_ID, url: "http://127.0.0.1:9/x" });
  r.check("换个域名（localhost ≠ 127.0.0.1）仍被宿主拒绝", true, !otherHost.ok && /未授权/.test(String(otherHost.e)));
  const badScheme = await invoke_("http_request", { pluginId: NET_ID, url: "file:///C:/Windows/win.ini" });
  r.check("非 http/https 协议被拒", true, !badScheme.ok && /只允许 http/.test(String(badScheme.e)));

  // 授权键的口径：桥按 new URL(url).host 申请（默认端口会被省掉），宿主算出来的键必须一致。
  // 早先用 port_or_known_default() 会给 https 凭空补出 `:443`，两边永远对不上，
  // 任何 https 请求都判「未授权」—— 而本地测试地址带显式端口，恰好看不出来。
  const httpsDenied = await invoke_("http_request", { pluginId: NET_ID, url: "https://example.com/" });
  r.check(
    "https 的授权键不带 :443",
    true,
    !httpsDenied.ok && /未授权访问 example\.com：/.test(String(httpsDenied.e)) && !/:443/.test(String(httpsDenied.e)),
  );
  // 给 example.com 走一次真实同意框授权（http 已给过，缺的是这一跳的域名）
  const grantPending = c.ev(
    `window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(NET_ID)}, capabilities: ['http', 'http:example.com'] })`,
  );
  try {
    await driveConsent("allow", NET_ID);
  } catch (err) {
    console.log("     没能操作 example.com 的同意框: " + String(err?.message ?? err).split("\n")[0]);
  }
  await grantPending.catch(() => null);
  const httpsOk = await invoke_("http_request", { pluginId: NET_ID, url: "https://example.com/" });
  r.check(
    "经宿主代理走 https 能取回内容",
    true,
    httpsOk.v?.status === 200 && /Example Domain/.test(String(httpsOk.v?.body ?? "")),
  );
  const notifyDenied = await invoke_("notify_show", { pluginId: NET_ID, title: "t", body: "b" });
  r.check("未声明 notify 的插件发不出系统通知", true, !notifyDenied.ok && /未授权/.test(String(notifyDenied.e)));
  await revoke(NET_ID);

  r.group("示例插件真实挂载（含相对 import 的 topics.js）");
  await c.ev(INSTALL); // 热安装那组末尾重载过页面，宿主句柄要重装（INSTALL 幂等）
  const hr = (await invoke_("plugins_list")).v?.find((m) => m.id === "com.pet.hr-ble");
  r.check("宿主返回了心率插件", true, !!hr?.widget);
  await c.ev(`window.__wh.mount(${JSON.stringify(hr)}, 'badge')`);
  r.check(
    "widget 挂载成功（说明 ./topics.js 在 petplugin 下能解析）",
    true,
    await waitUntil(c, `!!document.querySelector('#widget-badge > div[data-plugin-id="com.pet.hr-ble"]')`),
  );
  r.check(
    "hr-ble 的 badge 插槽 realm 戳是 worker（默认路线）",
    "worker",
    (await waitWidgetRealm(c, "com.pet.hr-ble", "badge", "worker", 20_000)).actual,
  );
  await c.ev(`window.__wh.unmount('com.pet.hr-ble')`);

  r.group("渲染几何与帧切片（单份图集 + 每帧源矩形）");
  const geo = await c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    const set = await s.loadSpriteSet(''); // 没有皮肤时的兜底路径
    const style = getComputedStyle(document.documentElement);
    const num = (v) => parseInt(style.getPropertyValue(v) || '0', 10);
    const f = set.idle?.[0];
    return {
      dpr: window.devicePixelRatio || 1,
      // 帧必须是「源矩形 + 单位化目标矩形」，不是一张烘焙画布：
      // 57 帧 × (360×dpr)² 的画布在 dpr=2 时约 118 MB，而图集本身才 12 MB
      isCanvas: !!f && typeof HTMLCanvasElement !== 'undefined' && f instanceof HTMLCanvasElement,
      hasRect: !!f && ['sx','sy','sw','sh','nx','ny','nw','nh'].every((k) => typeof f[k] === 'number'),
      unitRect: f ? [f.nx, f.ny, f.nw, f.nh].every((v) => v >= 0 && v <= 1) : false,
      frameKeys: Object.keys(set),
      petSize: num('--pet-size'),
      badgeBottom: num('--pet-badge-bottom'),
      bubbleBottom: num('--pet-bubble-bottom'),
      fallbackKeys: Object.keys(set).sort(),
      innerH: window.innerHeight,
    };
  })()`);
  r.check("帧不再是烘焙出来的画布", false, geo.isCanvas);
  r.check("每帧带源矩形与单位化目标矩形", true, geo.hasRect);
  r.check("目标矩形落在立绘单位方块内", true, geo.unitRect);
  r.check("兜底只提供 idle，不再伪造其余状态", ["idle"], geo.fallbackKeys);
  r.check("立绘尺寸由 JS 写入 CSS 变量", true, geo.petSize > 0);
  r.check("徽标位置跟随立绘几何而非各自硬编", true, geo.badgeBottom > 0 && geo.badgeBottom < geo.innerH);
  r.check("气泡位置同理", true, geo.bubbleBottom > 0 && geo.bubbleBottom <= geo.innerH);

  // 气泡的水平归属：它属于角色的头顶，不是窗口的右上角。
  // 之前钉在 right:16px，长台词会往角色右侧探出去 30 多像素，整只宠物看起来占了一大块横向空间。
  const bubbleGeo = await c.ev(`(async () => {
    const b = document.getElementById('pet-bubble');
    const { petController, } = await import('/src/pet/host.ts');
    petController().say('一二三四五六七八九〇一二三四五六七八九〇一二三四五六七八九〇一二三四五六七八九〇');
    await new Promise((res) => setTimeout(res, 320));
    const cs = getComputedStyle(document.documentElement);
    const size = parseFloat(cs.getPropertyValue('--pet-size'));
    const left = parseFloat(cs.getPropertyValue('--pet-left'));
    const r = b.getBoundingClientRect();
    return {
      width: Math.round(r.width), size,
      center: +((r.left + r.width / 2) - (left + size / 2)).toFixed(1),
      inside: r.left >= left - 0.5 && r.right <= left + size + 0.5,
      boxSizing: getComputedStyle(b).boxSizing,
    };
  })()`);
  r.check("超长台词也被压在角色宽度内", true, bubbleGeo.inside && bubbleGeo.width <= bubbleGeo.size + 1);
  r.check("气泡水平居中在头顶", true, Math.abs(bubbleGeo.center) <= 3);
  r.check("max-width 含内边距（border-box，否则 padding 让它再宽 24px）", "border-box", bubbleGeo.boxSizing);

  // 真实台词不能顶出窗口上沿：头顶上方的余量只有 47px，两行刚好、三行会被裁
  const longestFit = await c.ev(`(async () => {
    const { pickLine } = await import('/src/pet/dialogue.ts');
    const states = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review', 'wake'];
    let longest = '';
    for (const s of states) for (let i = 0; i < 60; i++) {
      const l = pickLine(s);
      if ([...l].length > [...longest].length) longest = l;
    }
    const { petController } = await import('/src/pet/host.ts');
    petController().say(longest);
    await new Promise((res) => setTimeout(res, 320));
    const r = document.getElementById('pet-bubble').getBoundingClientRect();
    return { chars: [...longest].length, top: Math.round(r.top), lines: Math.max(1, Math.round((r.height - 16) / 19.2)) };
  })()`);
  r.info("最长内置台词", `${longestFit.chars} 字 / ${longestFit.lines} 行`);
  r.check("最长台词也没被窗口上沿裁掉", true, longestFit.top >= 0);

  r.group("已解码图集缓存有上限（换装不再一份份攒下去）");
  const atlasCap = await c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    const mk = (r, g, b) => {
      // 8×8 的真图，走的是和 petdex 图集同一条 loadAtlas 路径
      const cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
      const g2 = cv.getContext('2d'); g2.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')'; g2.fillRect(0, 0, 8, 8);
      return cv.toDataURL('image/png');
    };
    const urls = [mk(1, 1, 1), mk(2, 2, 2), mk(3, 3, 3), mk(4, 4, 4)];
    for (const u of urls) { try { await s.loadAtlas(u); } catch (e) { return { err: String(e) }; } }
    const after = s.decodedAtlases();
    // 再取一次最近用过的：命中不该新增条目
    await s.loadAtlas(urls[3]);
    return { count: after.length, hasRecent: after.includes(urls[3]), dropped: !after.includes(urls[0]) };
  })()`);
  r.check("加载本身没有报错", undefined, atlasCap.err);
  r.check("四张图装完只留下上限内的份数", true, atlasCap.count > 0 && atlasCap.count <= 2);
  r.check("最近使用的图集留在缓存里", true, atlasCap.hasRecent);
  r.check("最早那张被挤掉了", true, atlasCap.dropped);

  r.group("petdex 图集几何与九状态切片");
  const slice = await c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    const { PET_STATES, detectSpriteAtlas } = await import('/src/pet/petdex-states.ts');
    const mk = (w, h) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; };
    // 每格填一种唯一颜色：r 通道=行号，g 通道=列号×30，取中心像素即可反查它来自哪一格
    const paint = (w, h, rows) => {
      const atlas = mk(w, h);
      const g = atlas.getContext('2d');
      for (let r = 0; r < rows; r++) for (let col = 0; col < 8; col++) {
        g.fillStyle = 'rgb(' + r + ',' + (col * 30) + ',0)';
        g.fillRect(col * (w / 8), r * (h / rows), w / 8, h / rows);
      }
      return atlas;
    };
    const v1 = paint(1536, 1872, 9);
    const v2 = paint(1536, 2288, 11);
    const set = s.sliceAtlas(v1);
    const counts = {};
    for (const st of PET_STATES) counts[st.id] = set[st.id]?.length ?? 0;
    // 帧是「图集上的源矩形」，所以断言直接查它落在第几行第几列：
    // 列 = round(sx / (1536/8))，行 = round(sy / (h/rows))
    const at = (f, w, h, rows) => ({ col: Math.round(f.sx / (w / 8)), row: Math.round(f.sy / (h / rows)) });
    const probe = {
      idle2: at(set.idle[2], 1536, 1872, 9),
      review0: at(set.review[0], 1536, 1872, 9),
      failed7: at(set.failed[7], 1536, 1872, 9),
      // 全部帧共用同一份源图：这才是「不再逐帧烘焙」的关键
      sharesSource: Object.values(set).flat().every((f) => f.source === v1),
      // contain 进正方形：192×208 的单元格按长边缩放，窄边居中留边
      fits: set.idle.map((f) => f.nw <= 1 && f.nh <= 1 && Math.abs(Math.max(f.nw, f.nh) - 1) < 1e-6),
    };
    const set2 = s.sliceAtlas(v2);
    return {
      counts,
      probe,
      v1: detectSpriteAtlas(1536, 1872),
      v2: detectSpriteAtlas(1536, 2288),
      preview: detectSpriteAtlas(1152, 208),
      odd: detectSpriteAtlas(1500, 1872),
      v2States: PET_STATES.every((st) => (set2[st.id]?.length ?? 0) === st.frames),
      v2Idle8Row: at(set2.idle[0], 1536, 2288, 11).row,
    };
  })()`);
  r.check(
    "九个状态各取到自己那一行的帧数",
    JSON.stringify({ idle: 6, "running-right": 8, "running-left": 8, waving: 4, jumping: 5, failed: 8, waiting: 6, running: 6, review: 6 }),
    JSON.stringify(slice.counts),
  );
  r.check("idle 第 3 帧取自第 0 行第 2 列", JSON.stringify({ col: 2, row: 0 }), JSON.stringify(slice.probe.idle2));
  r.check("review 取自第 8 行", JSON.stringify({ col: 0, row: 8 }), JSON.stringify(slice.probe.review0));
  r.check("failed 第 8 帧取自第 5 行第 7 列", JSON.stringify({ col: 7, row: 5 }), JSON.stringify(slice.probe.failed7));
  r.check("所有帧共用同一份源图（没有逐帧画布）", true, slice.probe.sharesSource);
  r.check("contain 缩放：长边占满单位方块、没有超出", true, slice.probe.fits.every(Boolean) && slice.probe.fits.length === 6);
  r.check("v1 图集识别为 8×9", JSON.stringify({ version: 1, rows: 9, width: 1536, height: 1872, scale: 1 }), JSON.stringify(slice.v1));
  r.check("v2 图集识别为 8×11 且只切前九个状态行", true, slice.v2.version === 2 && slice.v2.rows === 11 && slice.v2States);
  r.check("v2 的行高按 11 行算（idle 仍在第 0 行）", 0, slice.v2Idle8Row);
  r.check("画廊里的 preview.webp（单行 1152×208）不算图集", null, slice.preview);
  r.check("列边界不是整数的图不认", null, slice.odd);

  r.group("状态机优先级与排队上限（#19，词表 = petdex 九状态）");
  const sm = await c.ev(`(async () => {
    const { PetStateMachine } = await import('/src/pet/state-machine.ts');
    const { PET_ACTIONS } = await import('/src/pet/host.ts');
    const mk = () => { const cv = document.createElement('canvas'); cv.width = 1; cv.height = 1; return cv; };
    const frame = () => ({ source: mk(), sx: 0, sy: 0, sw: 1, sh: 1, nx: 0, ny: 0, nw: 1, nh: 1 });
    const sprites = {};
    for (const a of PET_ACTIONS) sprites[a] = [frame(), frame()];
    const a = new PetStateMachine(sprites);
    a.request('jumping');
    const b = new PetStateMachine(sprites);
    b.request('jumping');
    for (const act of ['review','review','review']) b.request(act);
    const c2 = new PetStateMachine(sprites);
    c2.request('jumping');
    for (const act of ['review','running','waving','failed']) c2.request(act);
    const capped = c2.queuedCount; // 必须在排空之前取，否则读到的是排空后的 0
    const seq = [];
    for (let i = 0; i < 40; i++) { c2.update(0.1); if (seq[seq.length - 1] !== c2.action) seq.push(c2.action); }
    // waiting 承担原来的「长时间无交互」位：进入后只被交互打断，不被计时打断
    const w = new PetStateMachine(sprites);
    w.request('waiting');
    let stuck = true;
    for (let i = 0; i < 200; i++) { w.update(0.1); if (w.action !== 'waiting') stuck = false; }
    const woke = w.poke('head');
    // 可持续状态（running）重复请求只续期，不该排队
    const d = new PetStateMachine(sprites);
    d.request('running'); d.request('running'); d.request('running');
    // 兜底皮肤只有 idle 帧（没有 waiting 那一行）：挂机检测整条不该成立，
    // 否则 switchTo 每帧回落 idle、onSleep 每帧重放，台词被 60fps 反复触发
    const only = { idle: [frame(), frame()] };
    const e = new PetStateMachine(only);
    let slept = 0;
    e.onSleep = () => { slept += 1; };
    for (let i = 0; i < 120; i++) e.update(1); // 120 秒无交互
    return {
      actions: PET_ACTIONS.slice().sort(),
      interrupted: a.action,
      dedup: b.queuedCount,
      capped,
      seq,
      stuck,
      woke,
      renewQueued: d.queuedCount,
      renewAction: d.action,
      fallbackSleeps: slept,
      fallbackAction: e.action,
    };
  })()`);
  r.check(
    "插件可用状态就是 petdex 的九个状态",
    '["failed","idle","jumping","review","running","running-left","running-right","waiting","waving"]',
    JSON.stringify(sm.actions),
  );
  r.check("高优先级请求立即打断当前动作", "jumping", sm.interrupted);
  r.check("同一状态重复请求不叠加排队", 1, sm.dedup);
  r.check("队列有上限，不会无限缓冲", true, sm.capped > 0 && sm.capped <= 3);
  r.check("排队状态会被逐个排空", true, sm.seq.includes("running"));
  r.check("waiting 不被计时打断", true, sm.stuck);
  r.check("交互把 waiting 唤醒成 waving", "waving", sm.woke);
  r.check("可持续状态重复请求只续期不排队", 0, sm.renewQueued);
  r.check("缺 waiting 帧时不反复触发挂机回调", 0, sm.fallbackSleeps);
  r.check("缺 waiting 帧时角色仍停在 idle", "idle", sm.fallbackAction);

  r.group("设置面板回显：宿主为 `*:widget` 保留最近一份并回灌新订阅");
  // 中继现在认发布名义与能力（S2）：`:widget` 那条走 widget 能力
  r.check("拿到 widget 能力后才测得了回灌", true, await grantProbeCap("widget"));
  const peek = await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    const PID = ${JSON.stringify(PROBE_ID)};
    await bus.publish(\`\${PID}:widget\`, { mode: 'overlay', v: 1 }, PID);
    await new Promise((r) => setTimeout(r, 400));
    let got = null;
    const off = bus.subscribe(\`\${PID}:widget\`, (d) => { got = d; });
    await new Promise((r) => setTimeout(r, 700));
    off();
    let cmdGot = 'no-call';
    const off2 = bus.subscribe(\`\${PID}:cmd\`, (d) => { cmdGot = d; });
    await new Promise((r) => setTimeout(r, 400));
    off2();
    const peekedCmd = await inv('bus_peek', { topic: \`\${PID}:cmd\` });
    return { got, cmdGot, peekedCmd };
  })()`);
  r.check("新订阅立刻拿到最近一份 widget 数据", "overlay", peek.got?.mode ?? null);
  r.check("非 widget topic 不会被回灌", "no-call", peek.cmdGot);
  r.check("bus_peek 拒绝非 widget topic", null, peek.peekedCmd);

  r.group("点击穿透判定（#16，注入假光标，不依赖真实鼠标）");
  const ct = await c.ev(`(async () => {
    const { installClickThrough } = await import('/src/pet/click-through.ts');
    const calls = [];
    let fake = { x: 99999, y: 99999 };
    const stop = installClickThrough({
      spriteRect: () => ({ left: 47, top: 47, size: 266 }),
      isDragging: () => false,
      pollMs: 40,
      readCursor: async () => ({ x: fake.x, y: fake.y }),
      windowOrigin: async () => ({ x: 0, y: 0, scale: 1 }),
      setThrough: async (enabled) => { calls.push(enabled); },
    });
    await new Promise((r) => setTimeout(r, 200));
    const outside = calls.slice();
    fake = { x: 180, y: 180 };
    await new Promise((r) => setTimeout(r, 200));
    const afterInside = calls.slice();
    fake = { x: 44, y: 44 }; // 边缘余量内：不该再翻一次
    await new Promise((r) => setTimeout(r, 200));
    const afterEdge = calls.slice();
    stop();
    return { outside, afterInside, afterEdge };
  })()`);
  r.check("指针在实体外时才开启穿透", "[true]", JSON.stringify(ct.outside));
  r.check("指针回到实体内即关闭穿透", "[true,false]", JSON.stringify(ct.afterInside));
  r.check("状态未变时不重复下发（无抖动）", "[true,false]", JSON.stringify(ct.afterEdge));

  r.group("窗口被拖走之后穿透不会卡死（原点必须跟着更新）");
  // 这条是「拖一次之后宠物再也点不到」的回归：光标停在宠物身上不动，
  // 而窗口原点过期 → 判定「在实体外」→ 穿透打开；穿透开着就收不到 DOM 事件，
  // 只靠「翻转时重读原点」永远回不来。所以拖动后必须自愈。
  const heal = await c.ev(`(async () => {
    const { installClickThrough } = await import('/src/pet/click-through.ts');
    const calls = [];
    let reads = 0;
    let origin = { x: 0, y: 0, scale: 1 };
    const cursor = { x: 5000, y: 5000 }; // 先在远处：穿透应当打开
    const stop = installClickThrough({
      spriteRect: () => ({ left: 47, top: 47, size: 266 }),
      isDragging: () => false,
      pollMs: 40,
      readCursor: async () => ({ x: cursor.x, y: cursor.y }),
      windowOrigin: async () => { reads++; return { x: origin.x, y: origin.y, scale: origin.scale }; },
      setThrough: async (enabled) => { calls.push(enabled); },
    });
    await new Promise((r) => setTimeout(r, 150));
    const armed = calls.slice();
    // 宠物被拖到指针底下：光标一步没动，旧原点会说「还在实体外」
    origin = { x: cursor.x - 180, y: cursor.y - 180, scale: 1 };
    const t0 = Date.now();
    let reopened = false;
    while (Date.now() - t0 < 2500) {
      if (calls.length > armed.length && calls[calls.length - 1] === false) { reopened = true; break; }
      await new Promise((r) => setTimeout(r, 40));
    }
    const after = calls.slice();
    stop();
    return { armed, after, reopened, reads };
  })()`);
  r.check("起手指针在实体外，穿透打开", "[true]", JSON.stringify(heal.armed));
  r.check("宠物挪到指针底下后穿透自己关掉", true, heal.reopened);
  r.check("关掉只发生一次（不来回抖）", 1, heal.after.filter((v) => v === false).length);

  // 上面的穿透组全部注入 setThrough 接缝，「命令被删/参数名漂」也照样全绿。
  // 这一组不传接缝、走生产默认的 invoke('set_click_through')：断言两向翻转期间零 console 新增。
  r.group("穿透翻转走真实 set_click_through（不注入 setThrough 接缝）");
  const throughNoiseBefore = c.noise.length;
  await c.ev(`(async () => {
    const { installClickThrough } = await import('/src/pet/click-through.ts');
    let fake = { x: 99999, y: 99999 };
    const stop = installClickThrough({
      spriteRect: () => ({ left: 47, top: 47, size: 266 }),
      isDragging: () => false,
      pollMs: 40,
      readCursor: async () => ({ x: fake.x, y: fake.y }),
      windowOrigin: async () => ({ x: 0, y: 0, scale: 1 }),
    });
    await new Promise((r) => setTimeout(r, 300));
    fake = { x: 180, y: 180 }; // 转回实体内：两个方向的翻转都真发过命令再收
    await new Promise((r) => setTimeout(r, 300));
    stop();
    return true;
  })()`);
  await sleep(800); // console 事件异步送达
  r.check("真实调用链下翻转不产生任何 console 报错", 0, c.noise.length - throughNoiseBefore);

  r.group("dev 下的 CSP 现状（仅作基线记录，断言在 verify-release.mjs）");
  r.info("探针内 eval", bare.csp);
  r.check("widget 注入 <style> 生效", true, bare.styleApplied);

  r.group("启动错误条的样式来自外链 CSS");
  // 内联样式搬进 src/boot-error.css 后，#err-overlay 的样式只能来自那条 link。
  // dev 不注入 CSP，这里判「样式真的到位」；打包版的 CSP 放行归 verify-release.mjs。
  const overlay0 = await c.ev(`(() => {
    const el = document.getElementById('err-overlay');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { position: cs.position, zIndex: cs.zIndex, display: cs.display };
  })()`);
  r.check("错误条存在，position 来自外链样式（fixed）", true, overlay0?.position === "fixed");
  r.check("z-index 保持契约值 99", "99", overlay0?.zIndex);
  r.check("静止态由外链样式隐藏（display:none）", "none", overlay0?.display);
  // boot-error.ts 的 CSSOM 赋值不受 style-src 约束：触发一次合成 error，
  // 它写内联 display:block 覆盖外链的 display:none —— 错误条应带着探针文本可见
  const noiseBefore = c.noise.length;
  const shown = await c.ev(`(() => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'm2a-probe' }));
    const el = document.getElementById('err-overlay');
    if (!el) return null;
    return { display: getComputedStyle(el).display, text: el.textContent ?? '' };
  })()`);
  await sleep(500);
  r.check("触发 error 后错误条可见且文本含探针串", true, shown?.display !== "none" && String(shown?.text).includes("m2a-probe"));
  r.check("触发期间没有新增 console 错误", noiseBefore, c.noise.length);
  // 复原：移除内联 style，隐藏重新只由样式表负责，不留痕迹给后续断言
  await c.ev(`(() => {
    const el = document.getElementById('err-overlay');
    if (!el) return false;
    el.removeAttribute('style');
    el.textContent = '';
    return true;
  })()`);

  r.group("设置窗：分区导航、搜索、快捷键与自启");
  // 用 hostInvoke 而不是裸 evaluate：被拒时页面外的 exceptionDetails 只剩
  // "Uncaught (in promise)"，拿不到宿主给的中文原因，断言就没法校验「为什么被拒」
  const call = hostInvoke(c);
  const sCall = (cmd, args) => hostInvoke(sc)(cmd, args);
  await call("settings_show");
  const findSettings = async () => {
    for (let i = 0; i < 40; i++) {
      const hit = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((res) => res.json()).catch(() => []))
        .find((t) => /localhost:1420\/src\/settings\.html/.test(t.url));
      if (hit) return hit;
      await new Promise((res) => setTimeout(res, 400));
    }
    return null;
  };
  const settingsTarget = await findSettings();
  r.check("设置窗可被宿主唤出（快捷键与回归共用这个入口）", true, !!settingsTarget);
  const sc = settingsTarget
    ? await attach(PORT, (t) => t.webSocketDebuggerUrl === settingsTarget.webSocketDebuggerUrl, 15_000)
    : null;
  if (sc) {
    await new Promise((res) => setTimeout(res, 3000));
    const installed = (await sCall("plugins_list")).v ?? [];
    // 清单在宿主那边，从设置窗读同一个源即可（别再读 localStorage 那个旧键）
    const enabledIds = await readEnabledIds(sCall);
    const navViews = () =>
      sc.ev(`[...document.querySelectorAll('#nav-list .nav-item')].map(b => b.dataset.view).join(',')`);

    r.group("侧栏结构：宠物设置 + 插件列表");
    r.check(
      "第一项是宠物设置，其余每个已装插件一项",
      "pet," + installed.map((m) => m.id).sort().join(","),
      await navViews(),
    );
    r.check(
      "宠物设置这一页含形象/快捷键/自启/游戏模式四张卡片（Agent 卡片已移交插件页）",
      '["桌宠形象","唤出本页的全局快捷键","开机自动运行","游戏模式"]',
      JSON.stringify(await sc.ev(`[...document.querySelectorAll('[data-panel=pet] .card h2')].map(h => h.textContent)`)),
    );
    r.check(
      "宠物设置里含形象/快捷键/自启/游戏模式的控件",
      '[true,true,true,true,true,true]',
      JSON.stringify(await sc.ev(
        `['skin-list','hotkey-input','autostart-switch','game-mode-switch','skin-name','hotkey-test']` +
          `.map(id => !!document.getElementById(id))`,
      )),
    );
    r.check(
      "Agent 卡片的 DOM 与控件已删干净（不留死代码）",
      '[false,false,false,false,false]',
      JSON.stringify(await sc.ev(
        `['agent-status','agent-detail','agent-install','agent-uninstall','agent-refresh'].map(id => !!document.getElementById(id))`,
      )),
    );
    r.check("初始只有 pet 面板可见", "pet", await sc.ev(`[...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join(',')`));

    r.group("点插件 → 插件页（内容交给插件的 widget）");
    // 用零权限探针：开它的开关不会在宠物窗那边弹同意框，断言不会被授权对话框卡住
    r.check("探针此刻是停用态（下面要验开关流程）", false, enabledIds.includes(PROBE_ID));
    await sc.ev(`document.querySelector('.nav-item[data-view=${JSON.stringify(PROBE_ID)}]').click(); true`);
    await new Promise((res) => setTimeout(res, 500));
    r.check("切过去只留插件面板", "plugin", await sc.ev(`[...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join(',')`));
    r.check("标题换成插件名", "隔离探针", await sc.ev(`document.getElementById('view-title').textContent`));
    // 这一组原先硬编码「权限条数 = 0」，那是**读到过期 manifest** 的假象：上面为了走同意框
    // 已经往探针的 manifest 里逐项写过 permissions，设置窗重新取列表后条数就不再是 0。
    // 改成跟磁盘现场逐字对账 —— 既更严（名字与顺序都要一致），也不会再随写文件的顺序随机红。
    const permsOnDisk = (JSON.parse(readFileSync(join(PLUGINS_DIR, PROBE_ID, "manifest.json"), "utf8")).permissions ?? []).join(",");
    r.check("壳上给了插件 id", PROBE_ID, await sc.ev(`document.getElementById('plugin-id')?.textContent ?? '(没有该元素)'`));
    r.check(
      "权限条与磁盘上的 manifest.permissions 逐字一致（含顺序）",
      permsOnDisk,
      await sc.ev(`[...document.querySelectorAll('#plugin-perms .perm-chip')].map((n) => n.textContent).join(',')`),
    );
    r.check(
      "停用状态下不挂插件页面，并说明原因",
      true,
      await sc.ev(
        `!document.querySelector('#plugin-settings div[data-plugin-id=${JSON.stringify(PROBE_ID)}]')` +
          ` && !document.getElementById('plugin-note').hidden && /启用后/.test(document.getElementById('plugin-note').textContent)`,
      ),
    );
    // 在插件页里开开关：widget 应挂进 #plugin-settings，内容是插件自己的
    await sc.ev(`(() => { const t = document.getElementById('plugin-toggle'); t.checked = true; t.dispatchEvent(new Event('change')); })()`);
    const mountedInPage = await waitUntil(
      sc,
      `!!document.querySelector('#plugin-settings div[data-plugin-id=${JSON.stringify(PROBE_ID)}][data-region="settings"]')`,
      12_000,
    );
    r.check("启用后插件自己的设置页挂进来了", true, mountedInPage);
    r.check("侧栏那个点跟着变亮", true, await sc.ev(`!!document.querySelector('.nav-item[data-view=${JSON.stringify(PROBE_ID)}] .nav-dot.on')`));
    await sc.ev(`(() => { const t = document.getElementById('plugin-toggle'); t.checked = false; t.dispatchEvent(new Event('change')); })()`);
    await sleep(1200);
    r.check(
      "停用后 widget 摘干净（不留孤儿节点）",
      0,
      await sc.ev(`document.querySelectorAll('#plugin-settings div[data-plugin-id=${JSON.stringify(PROBE_ID)}]').length`),
    );

    r.group("搜索过滤的是插件列表");
    await sc.ev(`(() => { const i = document.getElementById('search'); i.value = 'ble:scan'; i.dispatchEvent(new Event('input')); })()`);
    r.check(
      "按权限搜索只剩声明它的插件",
      1,
      await sc.ev(`[...document.querySelectorAll('#nav-plugins .nav-item')].filter(b => b.style.display !== 'none').length`),
    );
    await sc.ev(`(() => { const i = document.getElementById('search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    r.check("清空搜索后侧栏恢复完整", installed.length, await sc.ev(`[...document.querySelectorAll('#nav-plugins .nav-item')].filter(b => b.style.display !== 'none').length`));

    // 上面只是把探针开了又关，清单该回到起点
    const afterToggle = await readEnabledIds(sCall);
    r.check("插件启停回到起点", JSON.stringify([...enabledIds].sort()), JSON.stringify([...afterToggle].sort()));
    await sc.ev(`document.querySelector('.nav-item[data-view=pet]').click(); true`);
    await new Promise((res) => setTimeout(res, 400));
    r.check("回到宠物设置", "pet", await sc.ev(`[...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join(',')`));
    r.check("离开插件页后插件页被卸载", 0, await sc.ev(`document.querySelectorAll('#plugin-settings div[data-plugin-id]').length`));

    // ---------- B2：agent:hooks 受控能力（settings 区专属，ADR-0001） ----------
    // 探针复用 zz.probe 目录（.gitignore 已忽略、收尾统一删除）。把它的 widget 换成
    // 「钩子能力探针」：mount 本身不发起任何调用，只把 ctx 形状与手动调用函数挂到 window，
    // 免得早先的挂载/开关用例被同意框打断。
    r.group("agent:hooks 受控能力（settings 区专属）");
    const TEMP_ROOT = resolve(import.meta.dirname, "../../temp");
    const hookDir = join(PLUGINS_DIR, PROBE_ID);
    const hookManifest = (permits) =>
      JSON.stringify({
        id: PROBE_ID,
        name: "钩子能力探针",
        version: "0.0.0",
        entry: "index.js",
        widget: "widget.js",
        permissions: permits,
        description: "验证 agent:hooks 的受控注入面与同意流程。",
      });
    const HOOK_WIDGET = `export function mount(root, ctx) {
  const api = ctx.host && ctx.host.agentHooks;
  const entry = {
    region: ctx.region,
    hostIsUndefined: typeof ctx.host === "undefined",
    hasAgentHooks: !!api,
    keys: ctx.host ? Object.keys(ctx.host).sort() : [],
  };
  entry.call = async (name) => {
    if (!api) return { ok: false, e: "no host.agentHooks on ctx" };
    try { return { ok: true, v: await api[name]() }; }
    catch (e) { return { ok: false, e: String(e && e.message ? e.message : e) }; }
  };
  (window.__hookProbes = window.__hookProbes || {})[ctx.region] = entry;
}
export function unmount() {}
`;
    const MOUNT_HOOK_PROBES = `(async () => {
      const { widgetHost } = await import('/src/runtime/widget-host.ts');
      window.__hookHost = widgetHost;
      document.getElementById('hook-probe-slot')?.remove();
      const slot = document.createElement('div');
      slot.id = 'hook-probe-slot';
      document.body.append(slot);
      const manifest = ${hookManifest([])};
      await widgetHost.mount(manifest, 'settings', slot);
      await widgetHost.mount(manifest, 'badge', slot);
      await widgetHost.mount(manifest, 'overlay', slot);
      return Object.keys(window.__hookProbes || {}).sort().join(',');
    })()`;

    writeFileSync(join(hookDir, "widget.js"), HOOK_WIDGET);
    writeFileSync(join(hookDir, "manifest.json"), hookManifest([]));
    mkdirSync(join(TEMP_ROOT, "b2"), { recursive: true });
    await sleep(900);

    r.check("探针在 settings/badge/overlay 三区都能挂上", "badge,overlay,settings", await sc.ev(MOUNT_HOOK_PROBES));
    const shape = await sc.ev(`({
      hasAgentHooks: window.__hookProbes.settings.hasAgentHooks,
      keys: window.__hookProbes.settings.keys.join(','),
      badgeHost: window.__hookProbes.badge.hostIsUndefined,
      badgeApi: window.__hookProbes.badge.hasAgentHooks,
      overlayHost: window.__hookProbes.overlay.hostIsUndefined,
      overlayApi: window.__hookProbes.overlay.hasAgentHooks,
    })`);
    r.check("settings 区注入 ctx.host.agentHooks（且只有这一个键）", true, shape.hasAgentHooks === true && shape.keys === "agentHooks");
    r.check("badge 区取到的 ctx.host 是 undefined（断言 undefined，不是调用报错）", true, shape.badgeHost === true && shape.badgeApi === false);
    r.check("overlay 区取到的 ctx.host 是 undefined", true, shape.overlayHost === true && shape.overlayApi === false);

    // 起点确定：清掉上一次（可能崩溃留下）的旧授权，否则 permission_check 会短路掉声明校验
    await sCall("permission_revoke", { pluginId: PROBE_ID });
    // 此刻探针确定没有 agent:hooks，且下面这次调用不会弹同意框（窗口门禁过了走的是能力校验）
    const hookSnapBefore = JSON.stringify((await sCall("agent_hooks_status")).v);
    const unauthUninstall = await sCall("agent_hooks_uninstall", { pluginId: PROBE_ID });
    const hookSnapAfter = JSON.stringify((await sCall("agent_hooks_status")).v);
    r.check(
      "设置窗带 pluginId 但未授权 agent:hooks：能力门禁拒且配置快照未动",
      "denied|true",
      `${unauthUninstall.code}|${hookSnapBefore === hookSnapAfter}`,
    );
    const undeclared = await sc.ev(`window.__hookProbes.settings.call("status")`);
    r.check(
      "未声明 agent:hooks：settings 区调用被拒（未声明的能力不弹框，直接拒）",
      true,
      undeclared.ok === false && /未在 manifest 声明/.test(undeclared.e),
    );

    // 声明后：首次调用应弹同意框。先拒绝一次，再同意。
    writeFileSync(join(hookDir, "manifest.json"), hookManifest(["agent:hooks"]));
    await sleep(500);
    const pendingDeny = sc.ev(`window.__hookProbes.settings.call("status")`);
    const consentDeny = await driveConsent("deny", PROBE_ID);
    r.check("同意框列出了 agent:hooks", true, consentDeny.caps.some((x) => x.includes("agent:hooks")));
    // 同意框标题是既有文案 `${plugin_name}（${plugin_id}）`（consent/main.ts:34），断言整串
    r.check("同意框显示的是探针插件名（既有文案含 id）", "钩子能力探针（zz.probe）", consentDeny.name);
    const denied = await pendingDeny;
    r.check("拒绝后调用被拒（默认拒绝语义）", true, denied.ok === false && /权限被拒绝/.test(denied.e));

    const pendingAllow = sc.ev(`window.__hookProbes.settings.call("status")`);
    const consentAllow = await driveConsent("allow", PROBE_ID);
    r.check("拒绝没留下授权（第二次调用仍弹框）", true, consentAllow.caps.some((x) => x.includes("agent:hooks")));
    const allowed = await pendingAllow;
    r.check("同意后 settings 区调用放行", true, allowed.ok === true);
    const hostStatus = await sCall("agent_hooks_status");
    r.check("status 回显与宿主路径一致", JSON.stringify(allowed.v), JSON.stringify(hostStatus.v));

    // 宠物窗主 realm：绕过 JS 桥直接 invoke 必须被窗口门禁拒（label=pet）
    const petStatus = await call("agent_hooks_status");
    r.check("宠物窗直接 invoke status 被拒（label=pet）", true, petStatus.ok === false && /设置窗/.test(String(petStatus.e)));
    const petInstall = await call("agent_hooks_install", { pluginId: PROBE_ID });
    r.check("宠物窗带 pluginId 的 install 同样被窗口门禁拒", true, petInstall.ok === false && /设置窗/.test(String(petInstall.e)));
    const petUninstall = await call("agent_hooks_uninstall", { pluginId: PROBE_ID });
    r.check("宠物窗直接 invoke agent_hooks_uninstall（带 pluginId）被窗口门禁拒", "denied", petUninstall.code);

    // 写盘类断言只在宿主被指到 temp/ 时跑（PET_AGENT_CONFIG_FILES 启动方式）；
    // 否则一律不改写真实用户配置，只做只读断言。
    const statusFiles = Array.isArray(allowed.v?.files) ? allowed.v.files : [];
    const underTemp = statusFiles.length > 0 && statusFiles.every((f) => resolve(String(f.path)).startsWith(TEMP_ROOT + sep));
    r.info("hook 配置落点", statusFiles.map((f) => f.path).join(" ； ") || "(空)");

    let sampleForeign = "";
    // 「他人条目未变」的比较口径：宿主用 serde_json 整文件重写（BTreeMap 按键排序），
    // 键序会被归一 —— 两侧都按键排序后比较（与 Rust 单测同口径），键序差异不算改动。
    const canon = (value) => {
      if (Array.isArray(value)) return value.map(canon);
      if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value).sort()) out[k] = canon(value[k]);
        return out;
      }
      return value;
    };
    const foreignOf = (text) => {
      const v = JSON.parse(text);
      return JSON.stringify([canon(v.hooks.PreToolUse[0].hooks[0]), canon(v.hooks.Stop[0].hooks[0])]);
    };
    if (underTemp) {
      const sample = JSON.stringify(
        {
          theme: "dark",
          hooks: {
            PreToolUse: [{ hooks: [
              { type: "command", command: "other-tool --notify", timeout: 5 },
              { type: "command", command: `"D:\\old\\desktop-pet.exe" --pet-hook pre`, timeout: 2 },
            ] }],
            Stop: [{ hooks: [{ type: "command", command: "keep.sh", timeout: 3 }] }],
          },
        },
        null,
        2,
      );
      for (const f of statusFiles) writeFileSync(f.path, sample);
      sampleForeign = foreignOf(sample);

      const installRes = await sc.ev(`window.__hookProbes.settings.call("install")`);
      r.check(
        "声明并同意后 install 成功（每个文件回显条数）",
        true,
        installRes.ok === true && Array.isArray(installRes.v?.files) && installRes.v.files.every((f) => f.managed > 0 && !f.error),
      );
      const afterInstall = (await sCall("agent_hooks_status")).v;
      r.check("install 后 status 回显条数与文件数一致", afterInstall.managed, statusFiles.length * afterInstall.expectedPerFile);
      for (const f of statusFiles) {
        const text = readFileSync(f.path, "utf8");
        r.check("install 后样例只有自家条目在增", afterInstall.expectedPerFile, text.split("--pet-hook").length - 1);
        r.check("install 后他人 hook 条目逐字段未变（键序由宿主归一）", sampleForeign, foreignOf(text));
      }
    } else {
      r.info(
        "跳过写盘断言",
        "hook 配置未指向 temp/：install 与「连带卸载」断言不做（会改写真实用户配置）；" +
          '用 PET_AGENT_CONFIG_FILES="<temp>\\a.json;<temp>\\b.json" npm run dev:debug 启动可跑全量',
      );
    }

    // 设置窗直调卸载（不带 pluginId，宿主路径）：翻候选文件摘自家条目，他人条目必须原样；
    // 铁律是随后经探针装回 —— 不装回会把后面「连带卸载」两条分支的起点掏空成假绿
    if (underTemp) {
      const foreignBeforeDirect = statusFiles.map((f) => foreignOf(readFileSync(f.path, "utf8")));
      const directUninstall = await sCall("agent_hooks_uninstall");
      const afterDirect = (await sCall("agent_hooks_status")).v;
      const marksAfterDirect = statusFiles.map((f) => readFileSync(f.path, "utf8").split("--pet-hook").length - 1);
      const foreignAfterDirect = statusFiles.map((f) => foreignOf(readFileSync(f.path, "utf8")));
      const reinstall = await sc.ev(`window.__hookProbes.settings.call("install")`);
      const afterReinstall = reinstall.ok === true ? (await sCall("agent_hooks_status")).v : { managed: -1 };
      const foreignAfterReinstall = statusFiles.map((f) => foreignOf(readFileSync(f.path, "utf8")));
      r.check(
        "宿主路径直调卸载（设置窗、不带 pluginId）：managed 归零、他人条目未变，随后经探针装回",
        `true|0|${statusFiles.map(() => 0).join(",")}|true|${statusFiles.length * afterDirect.expectedPerFile}`,
        [
          directUninstall.ok === true,
          afterDirect.managed,
          marksAfterDirect.join(","),
          JSON.stringify(foreignBeforeDirect) === JSON.stringify(foreignAfterDirect) &&
            JSON.stringify(foreignAfterReinstall) === JSON.stringify(foreignBeforeDirect),
          reinstall.ok === true && afterReinstall.managed,
        ].join("|"),
      );
    } else {
      r.info(
        "跳过「直调卸载再装回」断言",
        "hook 配置未指向 temp/：直调卸载会改写真实用户配置，与本组 install 断言同一开关（PET_AGENT_CONFIG_FILES）",
      );
    }

    // ---------- 撤销授权两条分支（CONTEXT.md 生命周期） ----------
    // 先重载设置窗：manifest 改写后要拿到刷新过的权限列表（nav 的 data-search 带权限名）。
    await reloadAndWait(sc);
    r.check(
      "设置页在 manifest 改写后刷新出 agent:hooks 权限",
      true,
      await waitUntil(sc, `document.querySelector('.nav-item[data-view=${JSON.stringify(PROBE_ID)}]')?.dataset.search?.includes('agent:hooks') === true`, 10_000),
    );
    // 重载把 window 上的探针句柄与桥缓存都清了：重新挂一次、再走一次 status 把缓存填上
    await sc.ev(MOUNT_HOOK_PROBES);
    const regrant = await sc.ev(`window.__hookProbes.settings.call("status")`);
    r.check("重载后凭已授权记录直接放行（不再弹框）", true, regrant.ok === true);

    // 所有点击都先等元素出现、缺了产出可读 FAIL —— 固定 sleep 赌渲染会在缺元素时抛
    // TypeError 把整个套件打断（上一轮就是这么丢掉尾部汇总的）。
    // 注意：撤销按钮是 **class** `btn-revoke`（settings/main.ts:158 用 el() 的第三参赋 className），
    // 不是 id —— 上一轮用 getElementById 查它永远为 null，是脚本选择器写错，不是产品缺口。
    const clickReady = async (selector) => {
      const ready = await waitUntil(sc, `!!document.querySelector(${JSON.stringify(selector)})`, 8_000).catch(() => false);
      if (ready) await sc.ev(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
      return ready;
    };

    const navOpened = await clickReady(`.nav-item[data-view=${JSON.stringify(PROBE_ID)}]`);
    const hasRevokeBtn = navOpened && (await waitUntil(sc, `!!document.querySelector('.btn-revoke')`, 8_000).catch(() => false));
    r.check("插件壳上出现「撤销授权」（class=btn-revoke，声明列表已刷新）", true, hasRevokeBtn);

    // 分支一「只撤能力」：不写 hook 配置文件，任何模式都可跑
    const beforeSnap = JSON.stringify((await sCall("agent_hooks_status")).v);
    const beforeBytes = underTemp ? statusFiles.map((f) => readFileSync(f.path, "utf8")) : [];
    r.check(
      "撤销前桥缓存里有 agent:hooks（下面「失效」才是真的变化）",
      true,
      (await sc.ev(`(async () => (await import('/src/runtime/bridge.ts')).grantedCapabilities(${JSON.stringify(PROBE_ID)}).includes('agent:hooks'))()`)) === true,
    );
    if (hasRevokeBtn) await clickReady(".btn-revoke");
    const stripUp = hasRevokeBtn === true && (await waitUntil(sc, `document.getElementById('revoke-uninstall')?.checked === true`, 5_000).catch(() => false));
    r.check("确认条默认勾选「同时卸载 hook」", true, stripUp);
    if (stripUp) {
      await sc.ev(`(() => { document.getElementById('revoke-uninstall').checked = false; return true; })()`);
      await clickReady("#revoke-go");
    }
    r.check(
      "「只撤能力」的回显",
      true,
      stripUp && (await waitUntil(sc, `document.querySelector('.btn-revoke')?.textContent.includes("仅能力") === true`, 8_000).catch(() => false)),
    );
    r.check(
      "确认条执行后收起",
      0,
      stripUp ? await sc.ev(`document.querySelectorAll('#revoke-confirm').length`) : "撤销流程未执行（前一步失败）",
    );
    r.check("「只撤能力」不动 hook 配置（宿主回显不变）", beforeSnap, JSON.stringify((await sCall("agent_hooks_status")).v));
    if (underTemp) {
      r.check("「只撤能力」后样例文件字节不变", true, statusFiles.every((f, i) => readFileSync(f.path, "utf8") === beforeBytes[i]));
    }
    // 撤销后缓存失效是异步广播（host:permission-revoked）：轮询断言，别一次性查询竞态
    r.check(
      "「只撤能力」后桥的能力缓存失效",
      true,
      await waitUntil(sc, `(async () => !(await import('/src/runtime/bridge.ts')).grantedCapabilities(${JSON.stringify(PROBE_ID)}).includes('agent:hooks'))()`, 5_000),
    );

    // 分支二「连带卸载」：写盘，仅 temp 模式
    if (underTemp) {
      await clickReady(`.nav-item[data-view=pet]`);
      await clickReady(`.nav-item[data-view=${JSON.stringify(PROBE_ID)}]`);
      const hasBtn2 = await waitUntil(sc, `!!document.querySelector('.btn-revoke')`, 8_000).catch(() => false);
      r.check("重新进入插件页后撤销按钮再次可用", true, hasBtn2);
      if (hasBtn2) await clickReady(".btn-revoke");
      const stripUp2 = hasBtn2 === true && (await waitUntil(sc, `document.getElementById('revoke-uninstall')?.checked === true`, 5_000).catch(() => false));
      r.check("第二次确认条默认勾选（不取消，走连带卸载）", true, stripUp2);
      if (stripUp2) await clickReady("#revoke-go");
      r.check(
        "「连带卸载」的回显",
        true,
        stripUp2 && (await waitUntil(sc, `document.querySelector('.btn-revoke')?.textContent.includes("含卸载 hook") === true`, 8_000).catch(() => false)),
      );
      const clean = (await sCall("agent_hooks_status")).v;
      r.check("「连带卸载」后配置文件干净", 0, clean.managed ?? -1);
      for (const f of statusFiles) {
        const text = readFileSync(f.path, "utf8");
        r.check("卸载后 --pet-hook 条目归零", 0, text.split("--pet-hook").length - 1);
        r.check("卸载后他人 hook 条目逐字段未变（键序由宿主归一）", sampleForeign, foreignOf(text));
      }
    }

    await sc.ev(`(async () => { await window.__hookHost.unmount(${JSON.stringify(PROBE_ID)}); document.getElementById('hook-probe-slot')?.remove(); return true; })()`);
    await clickReady(`.nav-item[data-view=pet]`);

    const noMod = await sCall("hotkey_set", { accelerator: "P" });
    r.check("不带修饰键的组合被拒", true, !noMod.ok && /修饰键/.test(String(noMod.e)));
    const twoKeys = await sCall("hotkey_set", { accelerator: "Ctrl+A+B" });
    r.check("两个主键的组合被拒", true, !twoKeys.ok && /主键/.test(String(twoKeys.e)));
    const asDefault = await sCall("hotkey_set", { accelerator: "CommandOrControl+Alt+P" });
    r.check("Tauri 跨平台 token 被接受（默认值本身必须能设）", true, asDefault.ok);
    const moved = await sCall("hotkey_set", { accelerator: "ctrl+alt+f9" });
    r.check("改键成功并归一化", "Ctrl+Alt+F9", moved.v);
    r.check("状态读回的是改后的键", "Ctrl+Alt+F9", (await sCall("hotkey_status")).v?.accelerator);
    r.check("改回默认值", "CommandOrControl+Alt+P", (await sCall("hotkey_set", { accelerator: "CommandOrControl+Alt+P" })).v);

    r.group("hotkey_test：试注册命令的门禁、语法码与不改现状");
    const petHotkeyTest = await call("hotkey_test", { accelerator: "Ctrl+Alt+F8" });
    r.check("宠物窗直接 invoke hotkey_test 被窗口门禁拒", "denied", petHotkeyTest.code);
    const badSyntaxTest = await sCall("hotkey_test", { accelerator: "P" });
    r.check("语法错的组合拒绝时带 code=invalid-arg", "invalid-arg", badSyntaxTest.code);
    // 试的就是「当前生效」的那个键：注册必然报已占用，那不是冲突 —— 命令必须识别并直接放行
    const liveAccel = (await sCall("hotkey_status")).v?.accelerator;
    const liveTest = await sCall("hotkey_test", { accelerator: liveAccel });
    r.check("当前生效的键试注册必得 true（不把已占用误报成冲突）", true, liveTest.v);
    // 试注册不得有副作用：命令只做瞬时的注册/注销。当前生效键恰好就是它时对「当前键」直接放行 true，
    // 两次仍走 true 分支，所以不需要为这种情形另设前置分支
    const hkBefore = JSON.stringify((await sCall("hotkey_status")).v);
    const t1 = await sCall("hotkey_test", { accelerator: "Ctrl+Alt+F9" });
    const t2 = await sCall("hotkey_test", { accelerator: "Ctrl+Alt+F9" });
    const hkAfter = JSON.stringify((await sCall("hotkey_status")).v);
    r.check(
      "试注册不改变现状：同一空闲键连试两次都 true、hotkey_status 前后不变",
      "true|true|true",
      [t1.v, t2.v, hkBefore === hkAfter].join("|"),
    );

    const auto = await sCall("autostart_status");
    r.check("自启状态带真实路径与 dev 标记", true, typeof auto.v?.devBuild === "boolean" && /\.exe$/.test(auto.v?.exe ?? ""));
    const gated = await call("autostart_set", { enabled: true });
    r.check("自启只能由设置窗改", true, !gated.ok && /设置窗/.test(String(gated.e)));
    const gatedKey = await call("hotkey_set", { accelerator: "Ctrl+Alt+F8" });
    r.check("快捷键只能由设置窗改", true, !gatedKey.ok && /设置窗/.test(String(gatedKey.e)));
    r.check("设置窗自身无报错", [], sc.noise);
    await sCall("plugin:window|close").catch(() => undefined);
    sc.close();
  }

  // ---------- B3：气泡常驻状态行（宿主侧） ----------
  // 两个 fixture（id 不同）验「每个插件各占一条 + 回落」；同一份入口脚本靠 ctx.pluginId 区分 topic。
  r.group("B3 常驻状态行：显示 / 单行几何 / 仲裁回落 / 台词优先 / 回收");
  const STATUS_A = "zz.status";
  const STATUS_B = "zz.status2";
  const STATUS_INDEX = `let live = true;
export async function activate(ctx) {
  const pid = ctx.pluginId;
  // 下线之后不再回包：否则在途/迟到的那条 :res 会在下一套件里变成
  // 'bus relay failed: … 插件没有安装'（verify:worker 的零噪音门会红）
  const reply = (id, body) => { if (live) ctx.bus.publish(pid + ":res", Object.assign({ id: id }, body)); };
  ctx.bus.subscribe(pid + ":cmd", async (msg) => {
    try {
      if (msg.action === "set") reply(msg.id, { ok: true, v: await ctx.pet.setStatus(msg.text) });
      else if (msg.action === "clear") reply(msg.id, { ok: true, v: await ctx.pet.setStatus(null) });
      else if (msg.action === "say") { await ctx.pet.say(String(msg.text)); reply(msg.id, { ok: true }); }
      else reply(msg.id, { ok: false, e: "未知 action" });
    } catch (e) {
      reply(msg.id, { ok: false, e: String(e && e.message ? e.message : e) });
    }
  });
}
export function deactivate() { live = false; }
`;
  const statusManifest = (id) =>
    JSON.stringify({
      id,
      name: `常驻行探针 ${id}`,
      version: "0.0.0",
      entry: "index.js",
      permissions: ["pet:say", "bus:publish", "bus:subscribe"],
      description: "验证气泡常驻行的显示、仲裁与回收（B3）。",
    });
  for (const id of [STATUS_A, STATUS_B]) {
    const dir = join(PLUGINS_DIR, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.js"), STATUS_INDEX);
    writeFileSync(join(dir, "manifest.json"), statusManifest(id));
  }
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
    await c.ev(`(async () => {
      const { bus } = await import('/src/runtime/event-bus.ts');
      bus.inject(${JSON.stringify(pid)} + ':cmd', { id: ${id}, action: ${JSON.stringify(action)}, text: ${JSON.stringify(text ?? null)} });
      return true;
    })()`);
    const hit = `((window.__statusRes || []).find((r) => r.id === ${id})) ?? null`;
    const got = await waitUntil(c, `!!(${hit})`, 15_000).catch(() => false);
    if (!got) return { ok: false, e: `插件没回传 ${pid} ${action} 的结果（15s）` };
    return c.ev(hit);
  };
  const bubbleNow = () =>
    c.ev(`(() => { const b = document.getElementById('pet-bubble'); return { show: b.classList.contains('show'), status: b.classList.contains('status'), text: b.textContent }; })()`);
  /** 气泡盒子的渲染态读数（单行盒高不在这里推 —— 由「1 个字」那次实测校准，见下） */
  const bubbleBox = () =>
    c.ev(`(() => {
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

  const enabledBeforeB3 = await readEnabledIds(invoke(c));
  r.check("基线：没挂常驻行时气泡是收起的", false, (await bubbleNow()).show);
  // 上面那一段结尾把设置窗关了，句柄也随窗作废：本组要写启停清单与撤授权，重开一扇
  settings = await openSettingsInvoker(PORT, c);
  await setEnabled([...new Set([...enabledBeforeB3, STATUS_A, STATUS_B])]);
  await reloadAndWait(c);
  // 激活会为两个 fixture 各弹一次同意框（声明的三项能力）
  for (const id of [STATUS_A, STATUS_B]) {
    const consent = await driveConsent("allow", id).catch(() => null);
    r.check(`同意框列出了 ${id} 声明的能力（含 pet:say）`, true, !!consent && consent.caps.some((x) => x.includes("pet:say")));
  }
  await c.ev(installedCollectors);
  /**
   * 等槽里没有台词在显示（气泡要么收起、要么带 `.status`）。
   * 重载之后那句启动问候会亮 3.6s，而它在显示期间**按设计占着槽**（B3：不打断正在显示的台词），
   * 这时候读气泡读到的是它、`.status` 也没挂 —— 上一轮就是这么假红的。
   */
  const waitStatusSlot = () =>
    waitUntil(
      c,
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
  await c.ev(`(() => {
    window.__savedRandom = Math.random;
    Math.random = () => 0;
    window.__bubbleSeen = [];
    window.__bubbleTimer = setInterval(() => {
      const b = document.getElementById('pet-bubble');
      window.__bubbleSeen.push(b.classList.contains('show') ? b.textContent : '');
    }, 120);
    return true;
  })()`);
  await waitUntil(c, `window.__bubbleSeen.length >= 400`, 52_000).catch(() => false);
  const b3Texts = await c.ev(`[...new Set(window.__bubbleSeen)]`);
  await c.ev(`(() => { clearInterval(window.__bubbleTimer); Math.random = window.__savedRandom; return true; })()`);
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
  const b3Dom = await c.ev(`(() => { const b = document.getElementById('pet-bubble'); return { text: b.textContent, scroll: b.scrollWidth, client: b.clientWidth }; })()`);
  r.check("超长输入照样只占一行（盒高 = 单行盒高）", true, Math.abs(b3Box2.height - b3Box1.height) <= 1);
  r.check("超长输入仍不越出窗口上沿", true, b3Box2.top >= 0);
  r.check("超长输入仍不超出立绘宽", true, b3Box2.width <= b3Box2.maxWidth + 1);
  r.check("输入侧按码点截到 20（返回值自证）", 20, [...String(b3Long.v ?? "")].length);
  r.check("界面上的文本就是那 20 个字（末尾被截掉，不是原样 80 字）", true,
    b3Dom.text === String(b3Long.v ?? "") && [...b3Dom.text].length === 20);
  r.info("超长行的可视溢出（scrollWidth/clientWidth）", `${b3Dom.scroll}/${b3Dom.client}`);

  const b3Escaped = await statusCall(STATUS_A, "set", "<b>x</b>");
  const b3Html = await c.ev(`document.getElementById('pet-bubble').innerHTML`);
  const b3AsText = await bubbleNow();
  r.check("尖括号走 textContent（界面显示字面文本）", "<b>x</b>", b3AsText.text);
  r.check("设置返回的就是这串字面文本（没被当成标记处理）", "<b>x</b>", b3Escaped.v);
  r.check("没有真的建出 <b> 元素（标签被转义）", true, /&lt;b&gt;/.test(b3Html) && (await c.ev(`document.getElementById('pet-bubble').querySelector('b') === null`)));

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
    c,
    `(() => { const b = document.getElementById('pet-bubble'); return b.classList.contains('show') && b.textContent === 'B行3'; })()`,
    5_000,
  ).catch(() => false);
  r.info("撤权 A 后回到 B行3 的耗时", b3RevokeBack ? "5s 内" : "5s 未回落");
  r.check("撤销 A 的授权后 A 的行被摘掉、回落到 B 的行", "B行3", (await bubbleNow()).text);
  // 「不误删别人的行 / 撤无关权限不误清」的反面证据：B 的行既没被摘也没被改
  r.check("撤 A 的权不动 B 的行", "B行3", (await bubbleNow()).text);
  // 无权之后不能再设置：会重新弹同意框，拒掉就不该出现这一行（不绕过授权）
  const b3NoGrant = statusCall(STATUS_A, "set", "偷挂行").catch((err) => ({ ok: false, e: String(err?.message ?? err) }));
  const b3ConsentAgain = await driveConsent("deny", STATUS_A).catch(() => null);
  const b3NoGrantRes = await b3NoGrant;
  r.info("撤权后再设置的同意框", b3ConsentAgain ? "弹了（已拒）" : "没弹");
  r.check(
    "撤权后无权再设置常驻行：拒掉同意框就拿不到这一行",
    "true|false",
    [b3NoGrantRes.ok === false, (await bubbleNow()).text === "偷挂行"].join("|"),
  );

  // 回收：停用要走**真的下线路径**。裸写启停清单不会让宠物窗 reconcile（watchEnabled 只缓存，
  // reconcile 只在启动与 host:plugin-toggled 时跑）—— 上一轮就是这么「停用」了个寂寞。
  // 这里直接调运行时导出的 deactivatePlugin：它和用户点开关最终进的是同一个 doDeactivate（disposeAll 在那里）。
  const b3Deactivate = (id) =>
    c.ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); await rt.deactivatePlugin(${JSON.stringify(id)}); return true; })()`);
  await statusCall(STATUS_B, "set", "B行");
  await b3Deactivate(STATUS_A);
  await waitUntil(
    c,
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
  // B 自己停用：轮询到收起，并记下实际耗时
  await statusCall(STATUS_B, "set", "B行2");
  const b3T0 = Date.now();
  await b3Deactivate(STATUS_B);
  const b3Gone = await waitUntil(
    c,
    `!document.getElementById('pet-bubble').classList.contains('show')`,
    5_000,
  ).catch(() => false);
  const b3Elapsed = Date.now() - b3T0;
  r.info("停用 B 到气泡收起（轮询）", `${b3Elapsed}ms · ${b3Gone ? "5s 内收起" : "5s 未收起"}`);
  const b3AfterAllOff = await bubbleNow();
  r.info("停用 B 后的气泡", b3AfterAllOff.show ? `show|${b3AfterAllOff.text}` : "hidden");
  r.check(
    "停用 B → 完全收起（轮询判据，没靠加大 sleep）",
    false,
    b3AfterAllOff.show,
  );

  // 收尾：改回原清单、撤销授权。fixture 目录**留到 finally 再删** —— 组尾就删会让
  // 超时调用的迟到回包变成 `bus relay failed: … 没有安装`（verify:worker 的零噪音门会红）。
  await setEnabled(enabledBeforeB3);
  for (const id of [STATUS_A, STATUS_B]) {
    await revoke(id);
  }

  r.group("宿主页面自身未产生 CSP 违规或未捕获异常");
  // 上面的递归测试会刻意打一条 console.error，它是被测行为的证据，不该混进这里的零容忍
  r.info("导航过渡期告警（reload 切断在飞 IPC 的产物，单独归类）", String(c.transitionNoise.length));
  const unexpected = c.noise.filter((n) => !n.includes("派发递归"));
  r.check("无", 0, unexpected.length);
  for (const n of unexpected) console.log("   " + n);
} catch (err) {
  // 断言中途抛错时别只丢一个栈：给出可读原因
  aborted = true;
  console.error("\n验证中断: " + String(err?.message ?? err).split("\n").slice(0, 3).join(" | "));
} finally {
  removeFixtures(PLUGINS_DIR);
  // B3 那两个探针目录不在 removeFixtures 的名单里，.gitignore 也没覆盖 zz.status* ——
  // 中途崩了也得清掉，别把临时插件留成待提交文件
  for (const id of ["zz.status", "zz.status2"]) rmSync(join(PLUGINS_DIR, id), { recursive: true, force: true });
  // 探针留在宿主 realm 那条例外只服务于本套件的页面全局断言，不该活到下一轮真实使用里
  await c?.ev(`localStorage.removeItem('host:realm-plugin-host')`).catch(() => undefined);
  await c?.ev(`localStorage.removeItem('host:widget-realm-plugin-host')`).catch(() => undefined);
  settings?.close();
  c?.close();
  // 等 websocket 真正关掉再退出，否则 Windows 上 Node 会在 stderr 抛一句 libuv 断言
  await new Promise((res) => setTimeout(res, 300));
}

process.exit(aborted || r.summary() ? 1 : 0);
