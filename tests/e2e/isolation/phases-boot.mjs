// 窗口 A：启动、通信与热安装（原 948-1348）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { env } from "node:process";
import { attach, openSettingsInvoker, readEnabledIds, reloadAndWait, waitUntil } from "../harness/cdp.mjs";
import { NET_ID, PRESEED_PLUGIN_IDS, PROBE_ID, SPOOF_DIR, removeFixtures, writeFixtures, writeProbeFixtures } from "../harness/fixtures.mjs";
import { waitWidgetRealm } from "../harness/widget-realm.mjs";
import { E2E_DIR, MOUNT_BARE, MOUNT_CAPPED, PLUGINS_DIR, PORT, RESET_CHANGE_SPY, invoke, isPetPage, sawChangedId, sleep } from "./env.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseBoot(state) {
  const r = state.r;
  const { armPageReload, assertProbeRuntimeWritesAllowed, consoleWindow, grantProbeCap, logConsoleLedger, setEnabled } = state;
  state.c = await attach(PORT, isPetPage);
  r.info("已连接", state.c.url);
  const windowAConsoleStart = (state.c.noise ?? []).length;
  const preseeded = new Set(((await invoke(state.c)("plugins_list")).v ?? []).map((m) => m.id));
  const missingPreseed = PRESEED_PLUGIN_IDS.filter((id) => !preseeded.has(id));
  if (missingPreseed.length) {
    throw new Error(`D07 预置 fixture 缺失: ${missingPreseed.join(", ")}；请用 PET_E2E_PRESEED=1 npm run dev:debug 或 GITHUB_ACTIONS 启动`);
  }
  const enabledAtBoot = await readEnabledIds(invoke(state.c));
  const zzEnabledAtBoot = enabledAtBoot.filter((id) => String(id).startsWith("zz."));
  if (zzEnabledAtBoot.length) {
    throw new Error(`D07 启动前清单仍含 zz.*: ${zzEnabledAtBoot.join(", ")}`);
  }
  r.check("D07 启动前预置 fixture 齐全", true, missingPreseed.length === 0);
  r.check("D07 启动前清单不含 zz.*", [], zzEnabledAtBoot);
  let guardRejected = false;
  try {
    assertProbeRuntimeWritesAllowed("窗口 A 前");
  } catch {
    guardRejected = true;
  }
  r.check("D07 窗口 A 前拒绝 zz.probe 运行时写入（M7 杀手）", true, guardRejected);

  // D07-D16：套件启动前 agent 临时状态必须只剩两份 live 样例、且都在 temp/ 下。
  // dev-debug 已在 spawn 前删掉 *.pre-pet-backup；这里从宿主状态页读回，防止清理静默失效。
  if (env.PET_AGENT_CONFIG_FILES) {
    if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c);
    const hookStatus = await state.settings.invoke("agent_hooks_status");
    const hookFiles = Array.isArray(hookStatus.v?.files) ? hookStatus.v.files : [];
    const hookTempRoot = resolve(E2E_DIR, "../../temp");
    const hookFilesUnderTemp =
      hookFiles.length === 2 && hookFiles.every((f) => resolve(String(f.path)).startsWith(hookTempRoot + sep));
    r.check("D07 启动前 agent 状态可读", true, hookStatus.ok === true);
    r.check("D07 启动前 agent 临时配置只剩 2 个文件", 2, hookFiles.length);
    r.check("D07 启动前 agent 配置都在 temp/ 下", true, hookFilesUnderTemp);
    r.check(
      "D07 启动前 agent 状态页为默认 qoder/12/0",
      ["qoder", 12, 0],
      [hookStatus.v?.agent, hookStatus.v?.expectedPerFile, hookStatus.v?.managed],
    );
  } else {
    r.skip("agent 临时状态检查", "未设 PET_AGENT_CONFIG_FILES（非 E2E 启动）");
  }

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
  state.INSTALL = INSTALL;
  let ready = false;
  for (let i = 0; i < 8 && !ready; i++) {
    ready = await state.c.ev(INSTALL).catch(() => false);
    if (!ready) await sleep(2000);
  }
  r.check("widgetHost 与真实总线可达", true, ready);
  if (!ready) throw new Error("拿不到宿主的 widgetHost/总线单例（页面持续重载？）");

  // 插件入口现在默认跑在 Worker 里（ADR-0006 / L2 阶段一），但这份脚手架探针的 index.js
  // 是把事实写进 `window.__probeActivated` 这类页面全局的，断言就在页面 realm 读它们 ——
  // 入口一进 Worker 那些全局就没有对象了。把探针显式留在宿主 realm，真实插件不受这条影响。
  // 收尾会 removeItem（见 finally），别让它留在用户的 WebView 配置里。
  await state.c.ev(`localStorage.setItem('host:realm-plugin-host', ${JSON.stringify(`${PROBE_ID},${NET_ID}`)})`);
  // widget 从阶段二收口起也默认进 Worker，同理：这份探针的 widget 要测的是**页面自身代码**在
  // CSP 下的行为（eval、<style> 注入、`getComputedStyle`），并且结果同样写 `window.__probes`。
  // 放进 Worker 那些就不成立了 —— 这条同时也是「例外名单真管用」的现场证据。
  await state.c.ev(`localStorage.setItem('host:widget-realm-plugin-host', ${JSON.stringify(PROBE_ID)})`);

  // 起点必须自己清干净：Vite 已不 watch plugins/，页面不会因 fixture 写入而重载，
  // 上一轮（尤其是崩溃的那轮）遗留的挂载会抑制本轮 mount，看起来像「探针没执行」
  await state.c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);
  await state.c.ev(`window.__probes = []; window.__canary = []`);

  // 上一轮崩溃可能把探针留在启用清单里：目录 watcher 会据此自动激活它，
  // 于是测试自己看到的 badge 里多出别人（宿主）挂的容器。起点钉死清单。
  // C1 起这份清单归宿主，写只认设置窗 —— 别再碰 localStorage 那个旧键。
  {
    const prev = await readEnabledIds(invoke(state.c));
    const clean = prev.filter((id) => id !== PROBE_ID && id !== NET_ID);
    if (clean.join(",") !== prev.join(",")) await setEnabled(clean);
  }

  // 页面若在测试中途重载（编辑触发的 HMR、崩溃），window 上的句柄与计数会凭空消失，
  // 表现为看不懂的 TypeError。这里埋一个世代标记，越界时给出可执行的提示。
  const TOKEN = `verify-${Date.now()}`;
  await state.c.ev(`window.__verifyToken = ${JSON.stringify(TOKEN)}`);
  const guard = async () => {
    if (!(await state.c.ev(`window.__verifyToken === ${JSON.stringify(TOKEN)}`))) {
      throw new Error("页面在测试期间发生了重载（多为 HMR 触发），本次结果不可信 —— 重跑 npm run verify");
    }
  };

  const invoke_ = invoke(state.c);
  state.invoke_ = invoke_;
  const listed = await invoke_("plugins_list");
  r.check("宿主能列出探针插件", true, (listed.v ?? []).some((m) => m.id === PROBE_ID));

  await guard();
  r.group("零权限插件（manifest.permissions = []）的越权尝试");
  await state.c.ev(MOUNT_BARE);
  const bare = await state.c.ev(`window.__probes[0]`);
  state.bare = bare;
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
  await state.c.ev(MOUNT_CAPPED);
  const capped = await state.c.ev(`window.__probes[1]`);
  r.check("声明后发布自己 topic 放行", "THROUGH", capped?.attempts?.publish_own);
  r.check("声明后订阅宿主 topic 放行", "THROUGH", capped?.attempts?.subscribe_host);
  r.check("声明后仍不得发布他人 topic", "BLOCKED", capped?.attempts?.publish_foreign);

  r.group("被拦的发布不得漏给真实订阅者");
  r.check("金丝雀没收到伪造的 ble:heart-rate", 0, await state.c.ev(`window.__canary.length`));

  await guard();
  r.group("widget 挂载生命周期");
  // 用增量而不是绝对计数：宿主自己也可能挂过同名容器，绝对数在共享 DOM 上不可靠
  const sel = `#widget-badge > div[data-plugin-id="${PROBE_ID}"]`;
  const badgeCount = () => state.c.ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  await state.c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);
  const base = await badgeCount();
  await state.c.ev(MOUNT_BARE);
  r.check("mount 后容器 +1", base + 1, await badgeCount());
  await state.c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);
  r.check("卸载后回到基线", base, await badgeCount());
  r.check("卸载后 has() 为假", false, await state.c.ev(`window.__wh.has(${JSON.stringify(PROBE_ID)})`));

  r.group("并发重复挂载竞态");
  const base2 = await badgeCount();
  await Promise.all([state.c.ev(MOUNT_BARE), state.c.ev(MOUNT_BARE)]);
  r.check("同时两次 mount 只 +1", base2 + 1, await badgeCount());
  await state.c.ev(`window.__wh.unmount(${JSON.stringify(PROBE_ID)})`);

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

  // 窗口 A：触发=attach 后到宿主自身激活前的主动 mount / 授权 / 宿主规则；
  // 发射点=doActivate 277-282（缺权限被拒）与 doDeactivate 322/339；
  // 期望=0；理由=本窗口的拒绝/关窗都是直接 permission_request（不经过 doActivate），
  // 且 zz.probe 尚未被宿主激活。
  const windowANoise = consoleWindow(windowAConsoleStart, [PROBE_ID]);
  r.check("窗口 A：zz.probe console=0（attach 后切片）", 0, windowANoise.length);

  // 上面都是测试主动 mount；这一组让宿主在页面加载时自己去 import 入口与 widget，
  // 覆盖 activatePlugin 那条 import（petplugin 协议的真实使用方）
  // D07-D8：窗口 A 结束，把 zz.probe 写回 D04 的零声明 manifest；随后下线并清拒绝锁，
  // 再进入“宿主自身激活路径”（该组要求首次激活不弹授权）。
  state.probeRuntimeWritesAllowed = true;
  assertProbeRuntimeWritesAllowed("窗口 A 结束后写回零声明");
  writeFixtures(PLUGINS_DIR);
  const enabledBeforeZeroProbe = await readEnabledIds(invoke_);
  await setEnabled(enabledBeforeZeroProbe.filter((id) => id !== PROBE_ID));
  await state.c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    await rt.reconcile(await window.__TAURI_INTERNALS__.invoke('plugins_list'));
    return true;
  })()`);
  r.check(
    "D07 窗口 A 结束：zz.probe 已写回零声明并 isActive=false",
    true,
    await waitUntil(
      state.c,
      `(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); return rt.isActive(${JSON.stringify(PROBE_ID)}) === false; })()`,
      10_000,
    ),
  );
  r.group("宿主自身激活路径");
  const prevEnabled = await readEnabledIds(invoke_);
  state.prevEnabled = prevEnabled;
  await setEnabled([PROBE_ID]);
  await reloadAndWait(state.c);
  const badgeSelector = `#widget-badge > div[data-plugin-id=${JSON.stringify(PROBE_ID)}]`;
  const mountedByHost = await waitUntil(state.c, `!!document.querySelector(${JSON.stringify(badgeSelector)})`);
  if (!mountedByHost) {
    // 失败时把现场打出来，否则只能看到一句 false
    console.log(
      "     现场: activated=" +
        (await state.c.ev(`window.__probeActivated ?? 'none'`)) +
        " 选择器再查一次=" +
        (await state.c.ev(`!!document.querySelector(${JSON.stringify(badgeSelector)})`)) +
        " 命中数=" +
        (await state.c.ev(`document.querySelectorAll('div[data-plugin-id]').length`)) +
        " 全部 id=" +
        JSON.stringify(await state.c.ev(`[...document.querySelectorAll('div[data-plugin-id]')].map(d=>d.dataset.pluginId+':'+d.dataset.region)`)) +
        " enabled=" +
        JSON.stringify(await readEnabledIds(invoke_)),
    );
  }
  r.check("探针 widget 由宿主挂载成功", true, mountedByHost);
  r.check(
    "探针插槽的 realm 戳是 host（widget 那份例外名单在真实装载路径上管用）",
    "host",
    (await waitWidgetRealm(state.c, PROBE_ID, "badge", "host", 20_000)).actual,
  );
  r.check("入口 index.js 的 activate() 被调用", true, await state.c.ev(`(window.__probeActivated ?? 0) >= 1`));

  r.group("启停清单归宿主：清掉 WebView 存储也不丢（C1）");
  const beforeClear = await readEnabledIds(invoke_);
  // 只删那个旧键：localStorage.clear() 会连游戏模式开关等别的 WebView 状态一起抹掉，
  // 那不是本条要证的，也不该在回归里顺手改用户设置
  await state.c.ev(`localStorage.removeItem('host:enabled-plugins'); true`);
  await reloadAndWait(state.c);
  r.check(
    "旧键删掉并重启后，清单原样还在",
    JSON.stringify(beforeClear),
    JSON.stringify(await readEnabledIds(invoke_)),
  );
  r.check("探针仍在这份清单里（宿主那份才是来源）", true, (await readEnabledIds(invoke_)).includes(PROBE_ID));
  // 反向对照：把旧键写成干扰值，运行时读的仍该是宿主那份
  await state.c.ev(`localStorage.setItem('host:enabled-plugins', JSON.stringify(["zz.nobody"])); true`);
  await reloadAndWait(state.c);
  const afterPoison = await readEnabledIds(invoke_);
  r.check("旧键被写成干扰值后仍以宿主那份为准", true, afterPoison.includes(PROBE_ID) && !afterPoison.includes("zz.nobody"));
  r.check(
    "宠物窗运行时的启停判定跟着宿主走",
    true,
    await state.c.ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); return (await rt.loadEnabled()).includes(${JSON.stringify(PROBE_ID)}); })()`),
  );
  await state.c.ev(`localStorage.removeItem('host:enabled-plugins'); true`);

  // 迁移命令只认宠物窗，且只在清单文件还没写过时落盘 —— 拒绝与回读各钉一条
  r.group("启停清单迁移命令（plugin_enabled_migrate）：只认宠物窗、只在未初始化时写");
  const staleMigrate = await state.settings.invoke("plugin_enabled_migrate", { ids: [] });
  r.check("设置窗调迁移被窗口门禁拒", "denied", staleMigrate.code);
  // 用原始 plugin_enabled_list 判「文件写过没有」：readEnabledIds 会把 null 归一成 []，分不出来
  const migList = (await invoke_("plugin_enabled_list")).v;
  if (migList === null) {
    // 结构化跳过（不是通过）：CI 门只认 SKIP 前缀，且每条都得在 e2e-gate.json 的 allowedSkips 登记。
    r.skip("迁移原样回读断言", "宿主清单还没写过（fresh 环境）——迁移这一步只在首启时才落盘");
  } else {
    const forgedMigrate = await invoke_("plugin_enabled_migrate", { ids: ["zz.forged"] });
    const migAfter = (await invoke_("plugin_enabled_list")).v;
    r.check(
      "已有清单时迁移是原样回读：带伪造 ids 调完，返回与清单逐字相等",
      JSON.stringify([migList, migList]),
      JSON.stringify([forgedMigrate.v, migAfter]),
    );
  }

  logConsoleLedger("before hot install");
  r.group("热安装 / 热移除（不重启宿主，仅靠 plugins 目录 watcher）");
  // 先造出「有启用记录但目录不存在」的状态：此时不该有任何激活。
  // 探针此刻还在跑，目录被移走会让宠物窗整页热重载（本卡的新行为）：先武装
  // load 事件再删目录，等这次重载真的落地 —— 不等的话它会掀掉下面刚要埋的哨兵。
  const removalArmed = armPageReload();
  assertProbeRuntimeWritesAllowed("probe fixture 写入");
  removeFixtures(PLUGINS_DIR);
  if (await removalArmed) await sleep(600); // 与 reloadAndWait 同口径：等新文档的 reconcile 跑完
  await setEnabled([PROBE_ID]);
  await reloadAndWait(state.c);
  // 载荷探针：本卡把广播载荷从 () 换成了 { ids }，用它判「带得出变更的插件 id」。
  // 装在这里是因为刚 reloadAndWait 过，这段流程直到写完 fixtures 不会再换文档。
  await state.c.ev(RESET_CHANGE_SPY);
  // 哨兵：整段测试期间页面一旦被重载，下面的结论就都不成立
  await state.c.ev(`window.__hotSentinel = "armed"`);
  r.check("仅有启用记录、目录缺失时不激活", false, await state.c.ev(`(window.__probeActivated ?? 0) >= 1`));
  assertProbeRuntimeWritesAllowed("probe fixture 写入");
  // 只写（此刻不承载的）zz.probe：zz.net 在更早分组里仍 active，重写它的模块会触发
  // 产品设计内的 dev 热重载，把本组的哨兵与广播探针一起掀掉（套件干扰，不是产品红）。
  writeProbeFixtures(PLUGINS_DIR);
  r.check("放入目录后免重启即激活", true, await waitUntil(state.c, `(window.__probeActivated ?? 0) >= 1`, 20_000));
  r.check("目录变动的广播带得出变更的插件 id", true, await waitUntil(state.c, sawChangedId(PROBE_ID), 10_000));
  r.check("widget 容器随之出现", true, await state.c.ev(`!!document.querySelector('div[data-plugin-id=${JSON.stringify(PROBE_ID)}]')`));
  r.check("期间页面未重载（激活确实来自 watcher）", "armed", await state.c.ev(`window.__hotSentinel ?? '页面被重载了'`));

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
  await state.c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    await rt.deactivatePlugin(${JSON.stringify(PROBE_ID)});
    return true;
  })()`);
  // 探针先重置：下面要等的必须是「这次写入」触发的那轮广播，不能拿上一轮的陈旧载荷蒙混
  await state.c.ev(RESET_CHANGE_SPY);
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "top.js"), `export const top = "T1";\n`);
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "nested", "leaf.js"), `export const leaf = "L1";\n`);
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "index.js"), pentry("E1"));
  await waitUntil(state.c, sawChangedId(PROBE_ID), 4_000);
  // 万一有迟到的广播把这次显式 activate 打断，新文档的 initRuntime 也会把它装回来 ——
  // 下面的等待断言只认最终状态，过程性中断不该把整条断言链打断
  await state.c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    const ms = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    await rt.activatePlugin(ms.find((m) => m.id === ${JSON.stringify(PROBE_ID)}));
    return true;
  })()`).catch(() => undefined);
  r.check(
    "子模块形状的第一版已载入（E1/T1/L1）",
    true,
    await waitUntil(state.c, `window.__probeFlavor === 'E1' && window.__probeTop === 'T1' && window.__probeLeaf === 'L1'`, 15_000),
  );

  // 三种覆盖形状，各只动一个文件、入口其余行一字不动。已激活插件的文件被覆盖时
  // dev 下承载它的窗口会整页热重载（模块映射表只有换文档才会丢，?v= 管不到子模块），
  // 断言只等「新值自己出现」，不替产品做任何重载 —— 因此未改动代码上必然红：
  // 子模块覆盖连事件都不发，入口覆盖也只会命中同一 realm 的旧模块实例。
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "top.js"), `export const top = "T2";\n`);
  r.check("覆盖顶层子模块后免手动重载即生效", true, await waitUntil(state.c, `window.__probeTop === 'T2'`, 20_000));
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "nested", "leaf.js"), `export const leaf = "L2";\n`);
  r.check("覆盖嵌套子模块后免手动重载即生效", true, await waitUntil(state.c, `window.__probeLeaf === 'L2'`, 20_000));
  writeFileSync(join(PLUGINS_DIR, PROBE_ID, "index.js"), pentry("B"));
  r.check("覆盖入口文件后免手动重载即生效", true, await waitUntil(state.c, `window.__probeFlavor === 'B'`, 20_000));

  // 上面每条覆盖都可能把文档换了一茬：这条既有断言现在跑在已经落地的新文档上，
  // 判的仍是「deactivate → activate 之后读到的就是磁盘上的当前代码」。
  const swapped = await state.c.ev(`(async () => {
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
  await state.c.ev(`window.__probeFlavor = null; window.__probeDeactivated = 0; true`);

  // 目录被移走时探针仍活跃：固定版的宠物窗整页热重载（新文档里它不再被装起来）；
  // HEAD 形状走 watcher → reconcile → deactivate 那条路（deactivate 计数器可观察）。
  // 两条形状的共同结论必须都成立：插件停了。先武装 load 事件再删目录。
  const goneArmed = armPageReload();
  assertProbeRuntimeWritesAllowed("probe fixture 写入");
  removeFixtures(PLUGINS_DIR);
  const goneByReload = await goneArmed;
  if (goneByReload) await sleep(600); // 等新文档的 reconcile 跑完
  const stopped = goneByReload
    ? await waitUntil(
        state.c,
        `(window.__probeActivated ?? 0) === 0 && document.querySelectorAll('div[data-plugin-id=${JSON.stringify(PROBE_ID)}]').length === 0`,
        10_000,
      )
    : await waitUntil(state.c, `(window.__probeDeactivated ?? 0) >= 1`, 20_000);
  r.check("移走目录后自动 deactivate", true, stopped);
  // 容器消失是 deactivate 之后异步拆的，等它真的没了再断言（原来只 sleep 赌一把）
  const removedSelector = `div[data-plugin-id=${JSON.stringify(PROBE_ID)}]`;
  await waitUntil(state.c, `document.querySelectorAll(${JSON.stringify(removedSelector)}).length === 0`, 10_000);
  r.check("widget 容器随之移除", 0, await state.c.ev(`document.querySelectorAll(${JSON.stringify(removedSelector)}).length`));

}
