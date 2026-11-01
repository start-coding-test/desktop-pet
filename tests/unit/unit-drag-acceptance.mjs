// 验收补测（t3 / 附录2 N1·N2、G4-08/G6-05）：拖动窗口的起点与结束状态**只认真实窗口坐标**。
//
// 为什么单独补这一份：既有 unit-runtime.mjs 只钉了「窗口位移喂方向判定」的接线事实，
// 没有数学口径（非 100% DPI 下起点/结束该按哪个坐标系算），也没覆盖「停手 ≠ 松手」。
// 两份都跑在离线环境：这里不碰真窗口、不碰 DPI 设置，只算数与驱动假时钟。
//
// 运行：npm run unit（node --test + tests/unit/ts-loader.mjs，把 src 下的 .ts 转译进 node）
import { readFileSync } from "node:fs";
import { check, eq, group } from "./harness.mjs";

const geo = await import("../../src/pet/drag-geometry.ts");
const dragMod = await import("../../src/pet/drag-controller.ts");
const smod = await import("../../src/pet/state-machine.ts");

const { DragController, DRAG_START_PX, DRAG_SILENCE_MS, DRAG_PAUSE_END_MS } = dragMod;
const { DragDirectionTracker, DRAG_DIRECTION_MIN_PX } = smod;

/** 假时钟：拖动行为全按注入的 now() 裁决，离线就能复现「停手两秒」「跨 DPI」这类时序 */
function clock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
  };
}

/* ---------- 起点：窗口物理位置 + 窗口内偏移（保留当前偏移，起拖不跳） ---------- */

group("拖动起点（附录2 N1）：按真实窗口坐标抓取，保留当前偏移");

{
  // 同一份窗口位置/指针位置，在三档缩放下抓锚点：偏移换成物理像素，抓取点必须原样保留
  const cases = [
    { dpr: 1, offsetX: 30, offsetY: 40 },
    { dpr: 1.5, offsetX: 45, offsetY: 60 },
    { dpr: 2, offsetX: 60, offsetY: 80 },
  ];
  for (const { dpr, offsetX, offsetY } of cases) {
    const anchor = geo.pressAnchor({
      windowX: 400,
      windowY: 300,
      clientX: 30,
      clientY: 40,
      dpr,
    });
    eq(`dpr=${dpr}：窗口内偏移按 dpr 换成物理像素（x）`, anchor.offsetX, offsetX);
    eq(`dpr=${dpr}：窗口内偏移按 dpr 换成物理像素（y）`, anchor.offsetY, offsetY);
    eq(`dpr=${dpr}：起拖点是窗口左上角 + 偏移（窗口坐标口径）`, anchor.screenX, 400 + offsetX);
    eq(`dpr=${dpr}：起拖点纵坐标`, anchor.screenY, 300 + offsetY);
    // 反算：指针停在起拖点 → 窗口必须还在 (400,300)，即「起拖瞬间窗口不跳」
    const back = geo.windowFromCursor(anchor, anchor.screenX, anchor.screenY);
    eq(`dpr=${dpr}：反算窗口位置 = 原位置（保留偏移，起拖不跳）`, `${back.x},${back.y}`, "400,300");
  }
}

{
  // 窗口被拖走之后，指针在屏幕上的位置仍由「窗口 + 抓取偏移」给出 —— 这是拖动期的唯一模型
  const anchor = geo.pressAnchor({ windowX: 100, windowY: 100, clientX: 20, clientY: 10, dpr: 2 });
  const cursor = geo.cursorFromWindow(anchor, 300, 220);
  eq("窗口移到 (300,220) 时指针 x = 窗口 + 偏移", cursor.x, 300 + 40);
  eq("窗口移到 (300,220) 时指针 y = 窗口 + 偏移", cursor.y, 220 + 20);
}

{
  // 按下点/移动点统一成 CSS 屏幕坐标：窗口物理位置 ÷ dpr + 窗口内 CSS 偏移
  const dpr2 = geo.cssScreenPoint({ windowX: 100, windowY: 100, clientX: 20, clientY: 30, dpr: 2 });
  eq("dpr=2：CSS 屏幕坐标 x = 窗口/2 + clientX", dpr2.x, 70);
  eq("dpr=2：CSS 屏幕坐标 y = 窗口/2 + clientY", dpr2.y, 80);
  const dpr1 = geo.cssScreenPoint({ windowX: 100, windowY: 100, clientX: 20, clientY: 30, dpr: 1 });
  eq("dpr=1：CSS 屏幕坐标与 screenX 口径一致（x）", dpr1.x, 120);
  eq("dpr=1：CSS 屏幕坐标与 screenX 口径一致（y）", dpr1.y, 130);
  // 窗口没动时它必须和浏览器给的 screenX 完全一致，否则阈值手感会跟以前不一样
  check("窗口未移动时 cssScreenPoint == screenX/screenY 口径", dpr2.x === 100 / 2 + 20 && dpr2.y === 100 / 2 + 30);
}

{
  eq("dpr=0 归一化到 1（个别机器会给 0，除法会炸）", geo.normalizeDpr(0), 1);
  eq("dpr=NaN 归一化到 1", geo.normalizeDpr(Number.NaN), 1);
  eq("负数 dpr 归一化到 1", geo.normalizeDpr(-2), 1);
  eq("非整倍率（1.25/1.75）原样保留", geo.normalizeDpr(1.25), 1.25);
}

/* ---------- 结束状态：真机松手时只信窗口停在哪（不拿 screenX/Y 当窗口坐标） ---------- */

group("拖动结束状态（附录2 N2）：按真实落点算，不用 screenX/screenY");

{
  const anchor = geo.pressAnchor({ windowX: 200, windowY: 100, clientX: 30, clientY: 40, dpr: 1.5 });
  // 拖动期间窗口从 (200,100) 挪到 (260,70)（物理像素，onMoved/outerPosition 口径）
  const end = geo.dragEndState(anchor, 260, 70);
  eq("结束状态：真实落点 x", end.windowX, 260);
  eq("结束状态：真实落点 y", end.windowY, 70);
  eq("结束状态：物理位移 x", end.dxPhysical, 60);
  eq("结束状态：物理位移 y", end.dyPhysical, -30);
  eq("结束状态：CSS 位移按按下时的倍率换算 x（60/1.5）", end.dxCss, 40);
  eq("结束状态：CSS 位移 y（-30/1.5）", end.dyCss, -20);
  eq("结束状态：折算回按下倍率仍等于物理位移", end.dxCss * end.dpr, 60);
  check("结束状态：这趟拖动被记成「动过窗口」（用于清悬停态）", end.distanceCss > 0);
}

{
  // 数学模型：24 CSS px 的方向阈值在不同倍率下对应的物理像素数
  const anchor2 = geo.pressAnchor({ windowX: 0, windowY: 0, clientX: 0, clientY: 0, dpr: 2 });
  const end2 = geo.dragEndState(anchor2, DRAG_DIRECTION_MIN_PX * 2, 0);
  eq("dpr=2：窗口走 48 物理像素 = 24 CSS 像素（正好到方向阈值）", end2.dxCss, DRAG_DIRECTION_MIN_PX);
  const anchor1 = geo.pressAnchor({ windowX: 0, windowY: 0, clientX: 0, clientY: 0, dpr: 1 });
  eq("dpr=1：同样的物理位移换成 CSS 后翻倍", geo.dragEndState(anchor1, 48, 0).dxCss, 48);
  // 结束状态没有「鼠标坐标」可依赖：把最后落点喂进方向判定，靠的就是这条换算
  const tracker = new DragDirectionTracker();
  tracker.begin();
  eq("dpr=2 时 48 物理像素才认方向", tracker.sample(end2.dxCss, 0), "running-right");
}

/* ---------- 位移采样：跨 DPI 只重建基线，不产生假位移 ---------- */

group("窗口位移采样（G6-05）：跨 DPI 重建基线，不把旧倍率位移混进来");

{
  const move = new geo.WindowMoveTracker(1);
  const first = move.sample(100);
  check("首个采样只铺基线（不出位移）", first.dxCss === 0 && first.rescaled === true);
  const next = move.sample(140);
  eq("常规采样：dx = 40 CSS px", next.dxCss, 40);
  eq("常规采样不算重建", next.rescaled, false);

  const switched = move.sample(200, 2);
  check("缩放倍率变化时重建基线：这一拍不出位移", switched.dxCss === 0 && switched.rescaled === true);
  eq("采样器记住新倍率", move.currentDpr, 2);
  eq("重建基线后按新倍率换算（+40 物理 = 20 CSS）", move.sample(240).dxCss, 20);

  move.reset(null, 2);
  check("reset(null) 后下一拍仍是「只建基线」", move.sample(999).rescaled === true);
  move.reset(500, 1.5);
  eq("reset(位置, 倍率) 后直接能算位移", move.sample(530).dxCss, 20);
}

{
  // 同一段物理位移在 1× / 2× 下是否认方向：证明「必须除 dpr」不是形式主义
  const t1 = new DragDirectionTracker();
  t1.begin();
  eq("1×：40 物理像素 = 40 CSS → 认右侧", t1.sample(40, 0), "running-right");
  const t2 = new DragDirectionTracker();
  t2.begin();
  eq("2×：40 物理像素 = 20 CSS → 不到 24，不认方向", t2.sample(20, 0), null);
  eq("2×：再走 8 物理像素（累计 28 CSS）才认右侧", t2.sample(8, 100), "running-right");
}

/* ---------- 控制器：停手不是松手，但真松手必须收尾 ---------- */

group("拖动控制器（附录2 N1）：停手先暂停，真松手仍会收尾");

{
  const c = clock();
  const log = [];
  const ctl = new DragController({
    now: c.now,
    pauseInsteadOfSilent: true,
    onBegin: () => log.push("begin"),
    onPause: () => log.push("pause"),
    onEnd: (reason) => log.push(`end:${reason}`),
  });

  ctl.pressDown(0, 0);
  ctl.pointerMove(DRAG_START_PX + 4, 0, 1);
  eq("越过起拖阈值就进拖动期", ctl.isEngaged, true);

  c.advance(DRAG_SILENCE_MS - 1);
  ctl.tick();
  check("静默未到 250ms：不暂停也不收尾", ctl.isEngaged && !ctl.isPaused && !log.includes("pause"));

  c.advance(1);
  ctl.tick();
  check(
    "静默到 250ms：只暂停（方向态回落），拖动会话还活着",
    ctl.isEngaged && ctl.isPaused && log.at(-1) === "pause",
  );

  c.advance(400);
  ctl.tick();
  check("停手期内（< 900ms）仍然只暂停，不会当松手收尾", ctl.isEngaged && !log.includes("end:silent"));

  // 手又动了（窗口继续位移）：恢复拖动，方向可以重新判
  ctl.windowMoved();
  check("窗口再动一下就从暂停恢复", ctl.isEngaged && !ctl.isPaused);
  eq("恢复后不会额外触发 onBegin（会话没重启）", log.filter((x) => x === "begin").length, 1);

  // 再次停手 → 再暂停 → 这次停够 DRAG_PAUSE_END_MS 才收尾
  c.advance(DRAG_SILENCE_MS);
  ctl.tick();
  check("第二次停手同样先暂停", ctl.isPaused && ctl.isEngaged);
  eq("onPause 每次进入暂停都通知（第二次）", log.filter((x) => x === "pause").length, 2);
  c.advance(DRAG_PAUSE_END_MS);
  ctl.tick();
  check("停手超过 900ms 才按静默收尾（真松手后 running/穿透不会永远挂着）", !ctl.isEngaged && log.at(-1) === "end:silent");
  eq("收尾后不再处于暂停态", ctl.isPaused, false);
}

{
  // 暂停态下收到真松手/重按，必须立刻收尾，不能等 900ms
  const c = clock();
  const log = [];
  const ctl = new DragController({
    now: c.now,
    pauseInsteadOfSilent: true,
    onEnd: (reason) => log.push(reason),
  });
  ctl.pressDown(0, 0);
  ctl.pointerMove(DRAG_START_PX + 4, 0, 1);
  c.advance(DRAG_SILENCE_MS);
  ctl.tick();
  check("先进入暂停", ctl.isPaused);
  ctl.pointerUp();
  check("暂停态下抬起立刻收尾（mouseup 路径）", !ctl.isEngaged && log.at(-1) === "mouseup");
  eq("暂停标记随之清掉", ctl.isPaused, false);

  // 「松键了但没收到 mouseup」的补救同样穿透暂停态
  const c2 = clock();
  const log2 = [];
  const ctl2 = new DragController({
    now: c2.now,
    pauseInsteadOfSilent: true,
    onEnd: (reason) => log2.push(reason),
  });
  ctl2.pressDown(0, 0);
  ctl2.pointerMove(DRAG_START_PX + 4, 0, 1);
  c2.advance(DRAG_SILENCE_MS);
  ctl2.tick();
  ctl2.pointerMove(20, 0, 0);
  check("暂停态下 buttons=0 也立刻收尾", !ctl2.isEngaged && log2.at(-1) === "buttons-released");
}

{
  // 默认模式（不打开 pauseInsteadOfSilent）必须与旧版逐字等价 —— 既有 227 条断言靠它
  const c = clock();
  const log = [];
  const ctl = new DragController({ now: c.now, onEnd: (reason) => log.push(reason) });
  ctl.pressDown(0, 0);
  ctl.pointerMove(DRAG_START_PX + 4, 0, 1);
  c.advance(DRAG_SILENCE_MS);
  ctl.tick();
  check("默认模式：静默到点直接收尾（不经过暂停）", !ctl.isEngaged && log.at(-1) === "silent");
  eq("默认模式永远不处于暂停态", ctl.isPaused, false);
}

group("拖动控制器：缩放变化时重设按下点");

{
  const c = clock();
  const ctl = new DragController({ now: c.now });
  ctl.pressDown(0, 0);
  // 还没起拖就改了缩放：接线层用新倍率重算按下点（否则阈值凭空多/少一截）
  ctl.reanchor(100, 0);
  ctl.pointerMove(100 + DRAG_START_PX - 1, 0, 1);
  eq("重锚后旧按下点失效：靠近旧点的位移不再起拖", ctl.isEngaged, false);
  ctl.pointerMove(100 + DRAG_START_PX + 1, 0, 1);
  eq("新按下点 + 超过阈值才起拖", ctl.isEngaged, true);
  // 没有按下候选时 reanchor 是空操作，不会错误地造出按下态
  const idle = new DragController({ now: c.now });
  idle.reanchor(50, 50);
  eq("没有按下候选时 reanchor 不制造按下态", idle.hasPress, false);
}

/* ---------- 接线层：main.ts 真的用的是窗口坐标 ---------- */

group("拖动接线（main.ts 形状）：起点/结束/缩放重绘都接上了");

{
  const mainSrc = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");

  check(
    "按下时抓「窗口位置 + 窗口内偏移」当起点（pressAnchor）",
    mainSrc.includes("dragAnchor = lastWindowPos") && mainSrc.includes("pressAnchor({"),
    "main.ts 没接 pressAnchor",
  );
  check(
    "按下点/移动点统一走 cssScreenPoint 口径（真实窗口位置）",
    /function pointerPoint[\s\S]{0,400}cssScreenPoint\(/.test(mainSrc),
    "pointerPoint 没有按窗口坐标换算",
  );
  check(
    "不再把 MouseEvent.screenX/screenY 当窗口坐标",
    !mainSrc.includes(".screenX") && !mainSrc.includes(".screenY"),
    "main.ts 里还有 .screenX/.screenY",
  );
  check(
    "方向判定用窗口位移采样器（跨 DPI 重建基线）",
    mainSrc.includes("moveTracker.sample(") && mainSrc.includes("sample.rescaled"),
    "onWindowMoved 没接 moveTracker",
  );
  check(
    "收尾用真实落点算结束状态（dragEndState）",
    /function finishDrag[\s\S]{0,600}dragEndState\(/.test(mainSrc),
    "finishDrag 没用 dragEndState",
  );
  check("拖动期打开「停手先暂停」开关", mainSrc.includes("pauseInsteadOfSilent: true"), "没打开 pause 模式");
  check(
    "暂停时方向态回落常态",
    /onPause:\s*\(\)\s*=>\s*\{[\s\S]{0,200}pet\?\.dragDirection\(null\)/.test(mainSrc),
    "onPause 没回落方向态",
  );
  check(
    "缩放变化后重锚按下点（G6-05）",
    /if \(lastPointer\)[\s\S]{0,200}drag\.reanchor\(/.test(mainSrc),
    "watchDpr 没重锚",
  );
  check(
    "渲染帧失败不带走循环（G4-10：finally 里续帧）",
    /function tick[\s\S]{0,400}finally\s*\{\s*rafId = requestAnimationFrame\(tick\)/.test(mainSrc),
    "tick 没有 try/finally 续帧",
  );
  check(
    "resize 后立刻重绘一次（G4-08）",
    /addEventListener\("resize"[\s\S]{0,200}paintNow\(\)/.test(mainSrc),
    "resize 只改画布不重绘",
  );
  check(
    "改缩放后也立刻重绘一次",
    /mq\.addEventListener\([\s\S]{0,700}paintNow\(\)/.test(mainSrc),
    "watchDpr 没重绘",
  );
}
