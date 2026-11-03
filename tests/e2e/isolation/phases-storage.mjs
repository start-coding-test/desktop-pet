// 存储隔离与宿主门禁（原 1349-1800）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attach, listPages, readEnabledIds, reloadAndWait, waitUntil } from "../harness/cdp.mjs";
import { PROBE_ID, writeFixtures } from "../harness/fixtures.mjs";
import { driveConsent } from "./consent.mjs";
import { PLUGINS_DIR, PORT, STORE_DIR, probeZOrder, sleep } from "./env.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseStorage(state) {
  const r = state.r;
  const invoke_ = state.invoke_;
  const prevEnabled = state.prevEnabled;
  const { assertProbeRuntimeWritesAllowed, enableForConsent, grantProbeCap, revoke, setEnabled } = state;
  r.group("存储门禁：能力授权收在 Rust 侧（绕过 JS 桥的直接 invoke）");
  assertProbeRuntimeWritesAllowed("probe fixture 写入");
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
    state.c.ev(
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
    r.skip("ble_disconnect 空操作断言", `连接状态=${JSON.stringify(idleConn.v ?? idleConn.e ?? null)}（有设备在场就不动它）`);
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
  const rec = await state.c.ev(`(async () => {
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
  r.check("深度上限有明确告警", true, state.c.noise.some((x) => x.includes("派发递归")));

  r.group("同意框被直接关掉 → 立刻按拒绝结束，不空等 60s");
  const HR = "com.pet.hr-ble";
  const hrManifest = (await invoke_("plugins_list")).v?.find((m) => m.id === HR);
  const savedConfig = await invoke_("store_get", { pluginId: HR, key: "config" });
  const restoreHr = await enableForConsent(HR);
  try {
    await revoke(HR);
  const pending = state.c.ev(
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

  // 还原用户授权：拒绝锁会让同轮第二次请求直接 false；先停用/再启用清锁，再走一次同意框。
  const restoreRegrant = await enableForConsent(HR);
  try {
    if (hrManifest?.permissions?.length) {
      const regrant = state.c.ev(
        `window.__TAURI_INTERNALS__.invoke('permission_request', { pluginId: ${JSON.stringify(HR)}, capabilities: ${JSON.stringify(hrManifest.permissions)} })`,
      );
      try {
        const again = await driveConsent("allow", HR);
        r.check("拒绝后停用/再启用，重新弹出的同意框带插件名", true, again.name.includes("心率"));
      } catch (err) {
        console.log("     还原授权失败: " + String(err?.message ?? err).split("\n")[0]);
      }
      r.check("点允许后宿主放行", true, await regrant);
      if (savedConfig?.v !== undefined && savedConfig?.v !== null) {
        await invoke_("store_set", { pluginId: HR, key: "config", value: savedConfig.v });
      }
    }
  } finally {
    await restoreRegrant();
  }
  } finally {
    await restoreHr();
  }

  await setEnabled(prevEnabled);
  await reloadAndWait(state.c);

  r.group("共享资源持有者计数（停用不得误伤他插件）");
  const res = await state.c.ev(`(async () => {
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
  const reclaimFromSettings = await state.settings.invoke("overlay_reclaim", { pluginId: PROBE_ID });
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
    await waitUntil(state.c, `(async () => (await window.__TAURI_INTERNALS__.invoke('overlay_list')).some(([id]) => id === ${JSON.stringify(PROBE_ID)}))()`, 10_000),
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
      state.c,
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
      state.c,
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
  const OWNER_ALT = "com.pet.astock";
  const OWNER_HR = "com.pet.hr-ble";
  const OWNER_LABEL = { [OWNER_ALT]: "overlay-com_pet_astock", [OWNER_HR]: "overlay-com_pet_hr-ble" };

  // 前置一：起窗要求插件在启停清单里（overlay 页 sync 会自我关闭未启用插件的窗）
  const ownerEnabledAtStart = await readEnabledIds(invoke_);
  const ownerFixtureManifest = JSON.parse(readFileSync(join(PLUGINS_DIR, OWNER_ALT, "manifest.json"), "utf8"));
  r.check("B06 前置：夹具 manifest 确实声明 overlay", true, (ownerFixtureManifest.permissions ?? []).includes("overlay"));
  const ownerMissingEnabled = [OWNER_ALT, OWNER_HR].filter((id) => !ownerEnabledAtStart.includes(id));
  if (ownerMissingEnabled.length) await setEnabled([...ownerEnabledAtStart, ...ownerMissingEnabled]);

  // 前置二：开窗命令要 overlay 已授权；没授的当场走真实同意框，记下来收尾撤销
  const ownerGrantedNow = new Set();
  const ownerBackup = {};
  for (const id of [OWNER_ALT, OWNER_HR]) {
    const prior = (await state.settings.invoke("permission_list")).v?.[id] ?? [];
    ownerBackup[id] = { prior, config: undefined };
    const pre = await invoke_("permission_check", { pluginId: id, capability: "overlay" });
    if (pre.ok && pre.v === true) {
      r.info(`${id} 的 overlay 已在授权表里`, "本组不新授，也不收尾撤销");
      continue;
    }
    const pending = state.c
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
    [OWNER_ALT, 44, 44, 104],
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
    if (ownerMap[OWNER_LABEL[OWNER_ALT]] === OWNER_ALT && ownerMap[OWNER_LABEL[OWNER_HR]] === OWNER_HR) break;
    await sleep(800);
  }
  for (const oc of ownerClients.values()) oc.close();
  r.check("astock 那扇答出自己属于 com.pet.astock", OWNER_ALT, ownerMap[OWNER_LABEL[OWNER_ALT]] ?? null);
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
  for (const id of [OWNER_ALT, OWNER_HR]) {
    if (ownerPrior[id]?.entry && ownerPrior[id]?.visible) continue;
    await invoke_("overlay_destroy", { pluginId: id });
  }
  for (const id of ownerGrantedNow) {
    const wasStopped = await state.c
      .ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); if (!rt.isActive(${JSON.stringify(id)})) return false; await rt.deactivatePlugin(${JSON.stringify(id)}); return true; })()`)
      .catch(() => false);
    const revoked = await state.settings.invoke("permission_revoke", { pluginId: id });
    if (revoked.ok && ownerBackup[id].prior.length) {
      const regrant = state.c
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
  await reloadAndWait(state.c);

}
