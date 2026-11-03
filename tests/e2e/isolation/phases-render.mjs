// 渲染、http、示例插件与点击穿透（原 1801-2444）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { attach, hostInvoke, waitUntil } from "../harness/cdp.mjs";
import { NET_ID, PROBE_ID, writeFixtures } from "../harness/fixtures.mjs";
import { waitWidgetRealm } from "../harness/widget-realm.mjs";
import { driveConsent } from "./consent.mjs";
import { PLUGINS_DIR, PORT, sleep } from "./env.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseRender(state) {
  const r = state.r;
  const INSTALL = state.INSTALL;
  const invoke_ = state.invoke_;
  const bare = state.bare;
  const { assertProbeRuntimeWritesAllowed, enableForConsent, grantProbeCap, revoke } = state;
  r.group("http 代理与按域名授权（#21）");
  // 热安装那组测试结束时删掉了 fixture，这里要自己造回来：
  // 否则宿主报的是「读不到 manifest」，会被误判成鉴权规则失效
  assertProbeRuntimeWritesAllowed("probe fixture 写入");
  writeFixtures(PLUGINS_DIR);
  await sleep(1200);
  const LOCAL_URL = "http://localhost:1420/src/index.html";
  const HOST_CAP = "http:localhost:1420";
  const badAsk = await invoke_("permission_request", {
    pluginId: PROBE_ID,
    capabilities: [HOST_CAP],
  });
  r.check("未声明 http 的插件不能申请按域名放行", true, !badAsk.ok && /未在 manifest 声明/.test(String(badAsk.e)));

  const restoreNet = await enableForConsent(NET_ID);
  try {
  const grant = state.c
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
  const grantPending = state.c.ev(
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
  } finally {
    await revoke(NET_ID);
    await restoreNet();
  }

  r.group("示例插件真实挂载（含相对 import 的 topics.js）");
  await state.c.ev(INSTALL); // 热安装那组末尾重载过页面，宿主句柄要重装（INSTALL 幂等）
  const hr = (await invoke_("plugins_list")).v?.find((m) => m.id === "com.pet.hr-ble");
  r.check("宿主返回了心率插件", true, !!hr?.widget);
  await state.c.ev(`window.__wh.mount(${JSON.stringify(hr)}, 'badge')`);
  r.check(
    "widget 挂载成功（说明 ./topics.js 在 petplugin 下能解析）",
    true,
    await waitUntil(state.c, `!!document.querySelector('#widget-badge > div[data-plugin-id="com.pet.hr-ble"]')`),
  );
  r.check(
    "hr-ble 的 badge 插槽 realm 戳是 worker（默认路线）",
    "worker",
    (await waitWidgetRealm(state.c, "com.pet.hr-ble", "badge", "worker", 20_000)).actual,
  );
  await state.c.ev(`window.__wh.unmount('com.pet.hr-ble')`);

  r.group("渲染几何与帧切片（单份图集 + 每帧源矩形）");
  const geo = await state.c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    const loaded = await s.loadSpriteSet(''); // 没有皮肤时的兜底路径
    const set = loaded.sprites;
    const style = getComputedStyle(document.documentElement);
    const num = (v) => parseInt(style.getPropertyValue(v) || '0', 10);
    const f = set.idle?.[0];
    return {
      timing: loaded.timing,
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
  r.check("兜底不带 v3 timing（状态机按 PET_STATES 现算）", undefined, geo.timing);
  r.check("立绘尺寸由 JS 写入 CSS 变量", true, geo.petSize > 0);
  r.check("徽标位置跟随立绘几何而非各自硬编", true, geo.badgeBottom > 0 && geo.badgeBottom < geo.innerH);
  r.check("气泡位置同理", true, geo.bubbleBottom > 0 && geo.bubbleBottom <= geo.innerH);

  // 气泡的水平归属：它属于角色的头顶，不是窗口的右上角。
  // 之前钉在 right:16px，长台词会往角色右侧探出去 30 多像素，整只宠物看起来占了一大块横向空间。
  const bubbleGeo = await state.c.ev(`(async () => {
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
  const longestFit = await state.c.ev(`(async () => {
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
  const atlasCap = await state.c.ev(`(async () => {
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
  const slice = await state.c.ev(`(async () => {
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

  r.group("v3 清单：16 列跨行切片与 timing（D01）");
  const v3 = await state.c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    const m = await import('/src/pet/skin-manifest.ts');
    const { detectSpriteAtlas } = await import('/src/pet/petdex-states.ts');
    const { PetStateMachine } = await import('/src/pet/state-machine.ts');
    const mk = (w, h) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; };
    // §5.1 示例：3072×2704 = 16 列 × 13 行，单元格 192×208；每格一种唯一颜色
    const atlas = mk(3072, 2704);
    const g = atlas.getContext('2d');
    for (let row = 0; row < 13; row++) for (let col = 0; col < 16; col++) {
      g.fillStyle = 'rgb(' + row + ',' + (col * 16) + ',0)';
      g.fillRect(col * 192, row * 208, 192, 208);
    }
    const image = { width: 3072, height: 2704 };
    const raw = { desktopPet: { version: 3, grid: { columns: 16, rows: 13 }, states: {
      idle: { row: 0, frames: 48, durationMs: 2000 },
      'running-right': { row: 3, frames: 16, durationMs: 800 },
      'running-left': { row: 4, frames: 16, durationMs: 800 },
      waving: { row: 5, frames: 12, durationMs: 600 },
      jumping: { row: 6, frames: 14, durationMs: 700 },
      failed: { row: 7, frames: 20, durationMs: 1200 },
      waiting: { row: 9, frames: 32, durationMs: 2400 },
      running: { row: 11, frames: 12, durationMs: 600 },
      review: { row: 12, frames: 16, durationMs: 1100 },
    } } };
    const parsed = m.parseDesktopPetManifest(raw, image);
    if (parsed.kind !== 'v3') return { kind: parsed.kind, reason: parsed.reason };
    const sliced = s.sliceAtlasV3(atlas, parsed.manifest);
    const set = sliced.sprites;
    const at = (f) => ({ col: Math.round(f.sx / 192), row: Math.round(f.sy / 208) });
    const sample = (f) => {
      const c = mk(1, 1);
      const g2 = c.getContext('2d');
      g2.imageSmoothingEnabled = false;
      g2.drawImage(atlas, f.sx, f.sy, f.sw, f.sh, 0, 0, 1, 1);
      const d = g2.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    };
    const sm = new PetStateMachine(set, sliced.timing);
    sm.request('waving');
    sm.update(0.55);
    const beforeDwell = sm.action;
    sm.update(0.06);
    const afterDwell = sm.action;
    const smFrame = new PetStateMachine(set, sliced.timing);
    smFrame.request('waving');
    const f0 = smFrame.frame.sx;
    smFrame.update(0.04);
    const f04 = smFrame.frame.sx;
    smFrame.update(0.02);
    const f06 = smFrame.frame.sx;
    return {
      kind: parsed.kind,
      warnings: parsed.warnings,
      keys: Object.keys(set),
      counts: Object.fromEntries(Object.entries(set).map(([k, frames]) => [k, frames.length])),
      idle47: at(set.idle[47]),
      waiting16: at(set.waiting[16]),
      failed19: at(set.failed[19]),
      pixelIdle47: sample(set.idle[47]),
      pixelWaiting16: sample(set.waiting[16]),
      pixelFailed19: sample(set.failed[19]),
      shared: Object.values(set).flat().every((f) => f.source === atlas),
      fits: Object.values(set).flat().every((f) =>
        f.nx >= 0 && f.ny >= 0 && f.nw > 0 && f.nh > 0 && f.nx + f.nw <= 1.0001 && f.ny + f.nh <= 1.0001),
      timingWaving: sliced.timing.waving,
      beforeDwell, afterDwell,
      f0, f04, f06,
      detect18: detectSpriteAtlas(3072, 3744),
      noManifest18: m.parseDesktopPetJson(null, { width: 3072, height: 3744 }).kind,
    };
  })()`);
  r.check("合法 v3 清单被识别", "v3", v3.kind);
  r.check("九个状态都按清单切出帧", 9, v3.keys.length);
  r.check("每个状态切出的帧数与清单一致", JSON.stringify({
    idle: 48, "running-right": 16, "running-left": 16, waving: 12, jumping: 14,
    failed: 20, waiting: 32, running: 12, review: 16,
  }), JSON.stringify(v3.counts));
  r.check("idle[47] 取自第 2 行第 15 列", JSON.stringify({ col: 15, row: 2 }), JSON.stringify(v3.idle47));
  r.check("waiting[16] 取自第 10 行第 0 列", JSON.stringify({ col: 0, row: 10 }), JSON.stringify(v3.waiting16));
  r.check("failed[19] 取自第 8 行第 3 列", JSON.stringify({ col: 3, row: 8 }), JSON.stringify(v3.failed19));
  r.check("像素反查：idle[47] 的颜色属于 row2/col15", JSON.stringify({ r: 2, g: 240, b: 0 }), JSON.stringify(v3.pixelIdle47));
  r.check("像素反查：waiting[16] 的颜色属于 row10/col0", JSON.stringify({ r: 10, g: 0, b: 0 }), JSON.stringify(v3.pixelWaiting16));
  r.check("像素反查：failed[19] 的颜色属于 row8/col3", JSON.stringify({ r: 8, g: 48, b: 0 }), JSON.stringify(v3.pixelFailed19));
  r.check("所有帧共用同一份源图", true, v3.shared);
  r.check("目标矩形都落在立绘单位方块内", true, v3.fits);
  r.check("waving 的 timing 来自清单", JSON.stringify({ frameSec: 0.05, cycleSec: 0.6 }), JSON.stringify(v3.timingWaving));
  r.check("手势 dwell 用清单的 cycleSec（550ms 仍在）", "waving", v3.beforeDwell);
  r.check("手势 dwell 用清单的 cycleSec（610ms 回落）", "idle", v3.afterDwell);
  r.check("帧间隔用清单的 frameSec（40ms 不换帧）", 0, v3.f04);
  r.check("帧间隔用清单的 frameSec（60ms 换到下一帧）", 192, v3.f06);
  r.check("帧序从第 1 帧开始", 0, v3.f0);
  r.check("16×18 尺寸（宽高比同 v1）无清单时仍被识别为 v1", JSON.stringify({ version: 1, rows: 9 }), JSON.stringify({ version: v3.detect18?.version, rows: v3.detect18?.rows }));
  r.check("16×18 尺寸无清单时解析结果是没有清单", "none", v3.noManifest18);

  const fallback = await state.c.ev(`(async () => {
    const s = await import('/src/pet/sprites.ts');
    let iconPath = '/assets/app-icon.png';
    try {
      const iconMod = await import('/assets/app-icon.png?url');
      if (typeof iconMod.default === 'string') iconPath = iconMod.default;
    } catch {
      // dev 资产插件不可用时直接走根路径静态服务
    }
    const iconUrl = new URL(iconPath, location.origin).href;
    const originalFetch = window.fetch;
    const realFetch = originalFetch.bind(window);
    const realWarn = console.warn;
    const warns = [];
    console.warn = (...args) => { warns.push(args.map((a) => String(a)).join(' ')); };
    const out = [];
    try {
      const bad = [
        { name: 'columns', body: { desktopPet: { version: 3, grid: { columns: 8, rows: 8 }, states: { idle: { row: 0, frames: 1, durationMs: 32 } } } }, expect: 'columns' },
        { name: 'frames', body: { desktopPet: { version: 3, grid: { columns: 16, rows: 8 }, states: { idle: { row: 0, frames: 65, durationMs: 2000 } } } }, expect: 'frames' },
        { name: 'overlap', body: { desktopPet: { version: 3, grid: { columns: 16, rows: 8 }, states: { idle: { row: 0, frames: 1, durationMs: 32 }, waving: { row: 0, frames: 1, durationMs: 32 } } } }, expect: '相交' },
      ];
      for (const c of bad) {
        warns.length = 0;
        window.fetch = async (url, init) => String(url).endsWith('/pet.json')
          ? new Response(JSON.stringify(c.body), { status: 200 })
          : realFetch(url, init);
        const loaded = await s.loadSpriteSet(iconUrl);
        out.push({
          name: c.name,
          keys: Object.keys(loaded.sprites).sort(),
          timing: loaded.timing === undefined,
          warn: warns.join(' | '),
          expect: c.expect,
          cachedAfter: s.decodedAtlases().includes(iconUrl),
        });
      }
      const none = [
        { name: '404', response: () => new Response('', { status: 404 }) },
        { name: 'version2', response: () => new Response(JSON.stringify({ desktopPet: { version: 2 } }), { status: 200 }) },
        { name: 'badjson', response: () => new Response('not json', { status: 200 }) },
      ];
      for (const c of none) {
        warns.length = 0;
        window.fetch = async (url, init) => String(url).endsWith('/pet.json') ? c.response() : realFetch(url, init);
        const loaded = await s.loadSpriteSet(iconUrl);
        out.push({ name: c.name, keys: Object.keys(loaded.sprites).sort(), timing: loaded.timing === undefined, warn: warns.join(' | ') });
      }
      return { cases: out };
    } finally {
      window.fetch = originalFetch;
      console.warn = realWarn;
    }
  })()`);
  for (const item of fallback.cases.slice(0, 3)) {
    r.check(`无效 v3 清单（${item.name}）回退占位帧`, JSON.stringify(["idle"]), JSON.stringify(item.keys));
    r.check(`无效 v3 清单（${item.name}）不带 timing`, true, item.timing);
    r.check(`无效 v3 清单（${item.name}）warn 带具体原因`, true,
      String(item.warn).includes("v3 清单无效") && String(item.warn).includes(item.expect));
    r.check(`无效 v3 清单（${item.name}）的图集已从 atlasCache 删掉`, false, item.cachedAfter);
  }
  for (const item of fallback.cases.slice(3)) {
    r.check(`无清单（${item.name}）不走 v3 无效分支`, false, String(item.warn).includes("v3 清单无效"));
    r.check(`无清单（${item.name}）不带 v3 timing`, true, item.timing);
    r.check(`无清单（${item.name}）走原 v1/v2 路径（图不是图集时报原错误）`, true,
      String(item.warn).includes("不是受支持的 petdex 图集"));
  }

  r.group("状态机优先级与排队上限（#19，词表 = petdex 九状态）");
  const sm = await state.c.ev(`(async () => {
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
  const peek = await state.c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
    const PID = ${JSON.stringify(PROBE_ID)};
    await bus.publish(\`\${PID}:widget\`, { mode: 'overlay', v: 1 }, PID);
    await new Promise((r) => setTimeout(r, 400));
    let got = null;
    const off = bus.subscribe(\`\${PID}:widget\`, (d) => { got = d; }, PID);
    await new Promise((r) => setTimeout(r, 700));
    off();
    let cmdGot = 'no-call';
    const off2 = bus.subscribe(\`\${PID}:cmd\`, (d) => { cmdGot = d; });
    await new Promise((r) => setTimeout(r, 400));
    off2();
    const peekedCmd = await inv('bus_peek', { topic: \`\${PID}:cmd\` });
    // S4：同一份已存在的数据，报成别人的 id 就读不到；报自己 ✓；不报（缺归属）也读不到
    const peekOwn = await inv('bus_peek', { topic: \`\${PID}:widget\`, pluginId: PID });
    const peekForged = await inv('bus_peek', { topic: \`\${PID}:widget\`, pluginId: 'com.pet.todo' });
    const peekNoOwner = await inv('bus_peek', { topic: \`\${PID}:widget\` });
    return { got, cmdGot, peekedCmd, peekOwn, peekForged, peekNoOwner };
  })()`);
  r.check("新订阅立刻拿到最近一份 widget 数据", "overlay", peek.got?.mode ?? null);
  r.check("非 widget topic 不会被回灌", "no-call", peek.cmdGot);
  r.check("bus_peek 拒绝非 widget topic", null, peek.peekedCmd);
  r.check("宿主 realm 直接 peek 别人的 :widget 拿到 null（S4）", null, peek.peekForged);
  r.check("报自己的 id 仍读得到自己的展示数据（不是把路堵死）", "overlay", peek.peekOwn?.mode ?? null);
  r.check("缺 plugin_id 一律 null（fail-closed，缺归属不放行）", null, peek.peekNoOwner);

  r.group("点击穿透判定（#16，注入假光标，不依赖真实鼠标）");
  const ct = await state.c.ev(`(async () => {
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
  const heal = await state.c.ev(`(async () => {
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
  const throughNoiseBefore = state.c.noise.length;
  await state.c.ev(`(async () => {
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
  r.check("真实调用链下翻转不产生任何 console 报错", 0, state.c.noise.length - throughNoiseBefore);

  r.group("dev 下的 CSP 现状（仅作基线记录，断言在 verify-release.mjs）");
  r.info("探针内 eval", bare.csp);
  r.check("widget 注入 <style> 生效", true, bare.styleApplied);

  r.group("启动错误条的样式来自外链 CSS");
  // 内联样式搬进 src/boot-error.css 后，#err-overlay 的样式只能来自那条 link。
  // dev 不注入 CSP，这里判「样式真的到位」；打包版的 CSP 放行归 verify-release.mjs。
  const overlay0 = await state.c.ev(`(() => {
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
  const noiseBefore = state.c.noise.length;
  const shown = await state.c.ev(`(() => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'm2a-probe' }));
    const el = document.getElementById('err-overlay');
    if (!el) return null;
    return { display: getComputedStyle(el).display, text: el.textContent ?? '' };
  })()`);
  await sleep(500);
  r.check("触发 error 后错误条可见且文本含探针串", true, shown?.display !== "none" && String(shown?.text).includes("m2a-probe"));
  r.check("触发期间没有新增 console 错误", noiseBefore, state.c.noise.length);
  // 复原：移除内联 style，隐藏重新只由样式表负责，不留痕迹给后续断言
  await state.c.ev(`(() => {
    const el = document.getElementById('err-overlay');
    if (!el) return false;
    el.removeAttribute('style');
    el.textContent = '';
    return true;
  })()`);

  r.group("设置窗：分区导航、搜索、快捷键与自启");
  // 用 hostInvoke 而不是裸 evaluate：被拒时页面外的 exceptionDetails 只剩
  // "Uncaught (in promise)"，拿不到宿主给的中文原因，断言就没法校验「为什么被拒」
  const call = hostInvoke(state.c);
  state.call = call;
  const sCall = (cmd, args) => hostInvoke(sc)(cmd, args);
  state.sCall = sCall;
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
  state.sc = sc;
}
