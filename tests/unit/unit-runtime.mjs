// Q3 前端运行时离线单测：状态机、topic ACL、总线、插件 URL、manifest 校验、资源回收。
//
// 运行：npm run unit:runtime（node --test + tests/unit/ts-loader.mjs，把 src 下的 .ts
// 直接转译进 node；@tauri-apps/api/* 换成 tests/unit/tauri-stub.mjs）
//
// 与浏览器里那批 verify 断言的分工：这里只测**纯逻辑**（不需要窗口、不需要真协议），
// 好处是零 GUI、秒级、能在 CI 的门禁里跑；像素、CSP、真实 IPC 仍归 verify:*。
// 求值时机与迁移前的常驻单测一致：交互在本文件顶层按源码顺序跑完，eq 只在事后比快照。
import { readFileSync } from "node:fs";
import { check, deep, eq, group, throws } from "./harness.mjs";
import { calls as tauriCalls, resetStub, setReply } from "./tauri-stub.mjs";

const smod = await import("../../src/pet/state-machine.ts");
const dragMod = await import("../../src/pet/drag-controller.ts");
const { DragController, DRAG_START_PX, BLUR_GRACE_MS, DRAG_SILENCE_MS } = dragMod;
const acl = await import("../../src/runtime/topic-acl.ts");
const { bus } = await import("../../src/runtime/event-bus.ts");
const { pluginFileUrl, pluginFileVersion } = await import("../../src/runtime/plugin-url.ts");
const rt = await import("../../src/runtime/plugin-runtime.ts");
const { validateManifest } = rt;
const resources = await import("../../src/runtime/resources.ts");
const subs = await import("../../src/runtime/subscriptions.ts");
const hotReload = await import("../../src/runtime/hot-reload.ts");

const { PetStateMachine } = smod;

// 状态机在 idle 到点时按 REVIEW_CHANCE 随机切「思考」小动作 —— 离线单测要的是确定性，
// 所以把这个掷骰子钉死成「不随机切」（verify 那批浏览器断言里同样避开了这条随机路径）。
Math.random = () => 0.99;

/** 造一批假帧：状态机只用长度与索引，不碰画布 */
const frames = (n) =>
  Array.from({ length: n }, (_, i) => ({
    source: {},
    sx: i * 192,
    sy: 0,
    sw: 192,
    sh: 208,
    nx: 0,
    ny: 0,
    nw: 1,
    nh: 1,
  }));

const fullSet = () => ({
  idle: frames(4),
  "running-right": frames(4),
  "running-left": frames(4),
  waving: frames(4),
  jumping: frames(4),
  failed: frames(4),
  running: frames(4),
  review: frames(4),
  waiting: frames(4),
});

/** 跑掉 label 之外全部状态的帧表（用于验证缺 waiting 帧的兜底） */
const setWithout = (...missing) => {
  const set = fullSet();
  for (const key of missing) delete set[key];
  return set;
};

const noThrow = (label, fn) => {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  check(label, err === null, err ? `意外抛错: ${err.message}` : "");
  return err;
};

/* ============================ 状态机：优先级与排队 ============================ */
group("状态机优先级");

{
  const sm = new PetStateMachine(fullSet());
  eq("新建时停在 idle", sm.action, "idle");
  sm.request("jumping");
  eq("手势类优先级更高，立即打断 idle", sm.action, "jumping");
  eq("打断时不留排队", sm.queuedCount, 0);
  sm.request("review");
  eq("低优先级请求只排队，不换姿势", sm.action, "jumping");
  eq("低优先级进了队列", sm.queuedCount, 1);
  sm.request("review");
  eq("同一状态不重复排队", sm.queuedCount, 1);
}

{
  const sm = new PetStateMachine(fullSet());
  sm.request("running");
  eq("running 是当前状态", sm.action, "running");
  sm.request("running");
  eq("重复请求可持续状态不排队", sm.queuedCount, 0);
  sm.update(44);
  eq("45 秒续期上限内仍停在 running", sm.action, "running");
  sm.update(2);
  eq("安静超过 RENEW_HOLD 回落 idle", sm.action, "idle");
}

{
  // 队列上限：从 running(3) 依次排入 review(2)、左右跑(1)、idle(0) 共 4 条 → 丢最旧的
  const sm = new PetStateMachine(fullSet());
  sm.request("running");
  for (const a of ["review", "running-left", "running-right", "idle"]) sm.request(a);
  eq("队列封顶 3 条", sm.queuedCount, 3);
  eq("丢的是最旧那条（review）", sm.action, "running");
  // 排空：每次 dwell 到点出一个
  const seen = [];
  for (let i = 0; i < 80 && seen.length < 3; i++) {
    const before = sm.action;
    sm.update(80);
    if (sm.action !== before) seen.push(sm.action);
  }
  deep("排队状态按先进先出被逐个排空", seen.slice(0, 2), ["running-left", "running-right"]);
}

{
  const sm = new PetStateMachine(fullSet());
  let sleeps = 0;
  sm.onSleep = () => sleeps++;
  sm.request("waiting");
  eq("waiting 可以被打断进入", sm.action, "waiting");
  sm.update(200);
  eq("waiting 的 dwell 是 1e9，不被计时打断", sm.action, "waiting");
  eq("waiting 期间不重复触发挂机回调", sleeps, 0);
  eq("摸头把 waiting 唤醒成 waving", sm.poke("head"), "waving");
  eq("唤醒后当前姿势是 waving", sm.action, "waving");
}

{
  const sm = new PetStateMachine(fullSet());
  eq("戳肚子是 jumping", sm.poke("belly"), "jumping");
  const before = sm.shakeUntil;
  eq("摸头是 waving", sm.poke("head"), "waving");
  sm.poke("tail");
  eq("拉尾巴切 failed", sm.action, "failed");
  check("拉尾巴设了抖动截止", sm.shakeUntil !== before, `shakeUntil=${sm.shakeUntil}`);
}

{
  const sm = new PetStateMachine(fullSet());
  let sleeps = 0;
  sm.onSleep = () => sleeps++;
  for (let i = 0; i < 20; i++) sm.update(10);
  eq("三分钟无交互进 waiting", sm.action, "waiting");
  eq("进 waiting 时只回调一次", sleeps, 1);
  sm.update(300);
  eq("停在 waiting 后不再重复回调", sleeps, 1);
}

{
  // 兜底皮肤只有 idle 帧：挂机检测整条不成立，否则会每帧回落 idle + 每帧重放台词
  const sm = new PetStateMachine(setWithout("waiting"));
  let sleeps = 0;
  sm.onSleep = () => sleeps++;
  for (let i = 0; i < 20; i++) sm.update(10);
  eq("缺 waiting 帧时角色仍停在 idle", sm.action, "idle");
  eq("缺 waiting 帧时不反复触发挂机回调", sleeps, 0);
}

{
  const sm = new PetStateMachine(fullSet());
  sm.request("no-such-action");
  eq("未注册的状态请求被忽略", sm.action, "idle");
  sm.request("review");
  eq("先切到 review", sm.action, "review");
  const frameBefore = sm.frame;
  sm.setSprites(setWithout());
  eq("换一批帧后保持当前状态", sm.action, "review");
  check("setSprites 之后仍能取到帧", !!sm.frame, "frame 为空");
  check("换帧后帧对象是新的", sm.frame !== frameBefore, "还是旧帧");
}

/* ============================ 拖动驱动方向态（running-left/right） ============================ */
// 口径与 src/pet/state-machine.ts 的常量一致：起拖 6px（main.ts），认方向要 24 CSS px 净位移，
// 两次切换至少隔 80ms。e2e 的拖动断言必须复用同一口径，否则两边会在同一段位移上判出不同结果。
group("拖动方向判定纯逻辑");

{
  const t = new smod.DragDirectionTracker();
  t.begin();
  eq("阈值口径是 24 CSS px", smod.DRAG_DIRECTION_MIN_PX, 24);
  eq("去抖口径是 80ms", smod.DRAG_DIRECTION_COOLDOWN_MS, 80);
  eq("零位移不认方向", t.sample(0, 0), null);
  eq("阈值内的位移（23px）不认方向", t.sample(23, 0), null);
  eq("越过阈值立刻认右（事件本身就当帧，不另等计时）", t.sample(1, 8), "running-right");
  eq("同方向的一帧把反向进度清零", t.sample(5, 16), "running-right");
  eq("反向 20px 还不够", t.sample(-20, 24), "running-right");
  eq("中途回拖一帧（哪怕 1px）就把反向进度清零", t.sample(1, 32), "running-right");
  eq("再反向 20px 仍不够", t.sample(-20, 40), "running-right");
  eq("凑满 -24px 但离上次切换不足 80ms → 仍右（位移不丢）", t.sample(-4, 48), "running-right");
  eq("闸门到点后同一笔位移立刻切左", t.sample(0, 500), "running-left");
}

{
  // 反向只需要一个阈值：不会有「一路向右攒下的余量」替反向买单（否则最坏要 2 个阈值）
  const t = new smod.DragDirectionTracker();
  t.begin();
  eq("先向右 24px", t.sample(24, 100), "running-right");
  eq("同方向继续走 24px：仍是右，不重置切换时间戳", t.sample(24, 200), "running-right");
  eq("此时反向 23px 还不够（一个阈值 = 24px）", t.sample(-23, 300), "running-right");
  eq("反向满 24px 立刻切（没有旧余量挡路）", t.sample(-1, 340), "running-left");
  eq("零位移保持已认定的方向", t.sample(0, 500), "running-left");
}

{
  // 抖动：往复幅度小于阈值时净位移互抵，一次都不该切
  const t = new smod.DragDirectionTracker();
  t.begin();
  const seen = [t.sample(20, 0), t.sample(-40, 40), t.sample(40, 80), t.sample(-40, 120)];
  deep("±20px 的往复抖动不切换（净位移攒不够一个阈值）", seen, [null, null, null, null]);
}

{
  // 时间闸门：位移够了但离上次切换不足 80ms → 先不切，且不丢位移（闸门一开立刻切）
  const t = new smod.DragDirectionTracker();
  t.begin();
  eq("先向右", t.sample(24, 1000), "running-right");
  eq("40ms 内反向 24px 被闸门压住", t.sample(-24, 1040), "running-right");
  eq("到 80ms 后同一笔净位移立刻生效（不丢量）", t.sample(0, 1080), "running-left");
}

{
  const t = new smod.DragDirectionTracker();
  t.begin();
  t.sample(24, 0);
  t.begin();
  eq("重新起拖清掉上一次的净位移（不会被旧余量提前判方向）", t.sample(-10, 10), null);
}

group("拖动时序预算（按 onMoved 帧率喂事件流）");

{
  // 8ms/帧 = Windows 拖窗口时 Move 事件的常见密度（125Hz 上限，实测几十到一百多 Hz）。
  // 这里不模拟物理鼠标，只把「窗口每帧移动多少」喂给真实的判定器，验收线因此可测：
  //   ① 越过 24px 的那一帧就出方向，稳态拖速下 ≪300ms；
  //   ② 反向从「开始往左拖」到切左 ≤200ms（攒位移 + 80ms 闸门）；
  //   ③ 幅度小于阈值的往复抖动一次都不切。
  const TICK = 8;
  const STEP = 1.6; // 每帧 1.6 CSS px ≈ 200 px/s 的慢速拖
  const feed = (tracker, frames, dxAt, now0 = 0) => {
    let now = now0;
    const marks = [];
    for (let i = 0; i < frames; i += 1) {
      now += TICK;
      marks.push({ now, dir: tracker.sample(dxAt(i, now), now) });
    }
    return marks;
  };

  const t = new smod.DragDirectionTracker();
  t.begin();
  const right = feed(t, 200, () => STEP);
  const firstRight = right.find((m) => m.dir !== null);
  check(
    "200px/s 匀速右拖：越过 24px 的那一帧就认右（≈128ms ≪ 300ms 验收线）",
    firstRight?.dir === "running-right" && firstRight.now <= 300,
    `first=${firstRight?.now}ms dir=${firstRight?.dir}`,
  );

  const t2 = new smod.DragDirectionTracker();
  t2.begin();
  const warm = feed(t2, 100, () => STEP);
  const commitAt = warm.find((m) => m.dir !== null).now;
  const back = feed(t2, 100, () => -STEP, commitAt);
  const flipped = back.find((m) => m.dir === "running-left");
  check(
    "同速反向：从开始往左拖到切 left ≤200ms（含 80ms 闸门，实测≈128ms）",
    flipped !== undefined && flipped.now - commitAt <= 200,
    `flip=${flipped?.now}ms after ${commitAt}ms`,
  );

  const t3 = new smod.DragDirectionTracker();
  t3.begin();
  const jitter = feed(t3, 200, (i) => (i % 2 === 0 ? 2 : -2));
  check(
    "±2px/帧 的往复抖动（幅度远小于 24px）一次都不切",
    jitter.every((m) => m.dir === null),
    `dirs=${[...new Set(jitter.map((m) => m.dir))].join(",")}`,
  );

  const t4 = new smod.DragDirectionTracker();
  t4.begin();
  feed(t4, 40, () => STEP); // 先稳定认右
  const after = feed(t4, 200, (i) => (i % 2 === 0 ? -2 : 2), 40 * TICK);
  check(
    "已认右后再抖：抖动吃不掉方向（净位移始终远小于阈值）",
    after.every((m) => m.dir === "running-right"),
    `dirs=${[...new Set(after.map((m) => m.dir))].join(",")}`,
  );
}

group("拖动进入与复原");

{
  const sm = new PetStateMachine(fullSet());
  eq("没有拖动时 dragging 为 false", sm.dragging, false);
  sm.dragDirection("running-right");
  eq("没起拖时方向请求被忽略（方向态只由拖动驱动）", sm.action, "idle");
  sm.beginDrag();
  eq("起拖后进入拖动期", sm.dragging, true);
  eq("起拖本身不改姿势（先停在拖动前的 idle）", sm.action, "idle");
  sm.dragDirection("running-right");
  eq("向右拖切 running-right", sm.action, "running-right");
  const switchedAt = sm.lastSwitchAt;
  sm.dragDirection("running-right");
  eq("重复 set 同一方向不重入（不刷 lastSwitchAt）", sm.lastSwitchAt, switchedAt);
  sm.dragDirection("running-left");
  eq("拖动中反向立即切 running-left", sm.action, "running-left");
  sm.update(200);
  eq("长拖也停得住：dwell 不会把方向态打回 idle", sm.action, "running-left");
  sm.endDrag();
  eq("松手回到拖动前的 idle", sm.action, "idle");
  eq("松手后退出拖动期", sm.dragging, false);
  const endedAt = sm.lastSwitchAt;
  sm.endDrag();
  eq("重复 endDrag 是空操作", sm.lastSwitchAt, endedAt);
}

{
  const sm = new PetStateMachine(fullSet());
  sm.request("waiting");
  eq("拖动前先在 waiting", sm.action, "waiting");
  sm.beginDrag();
  sm.dragDirection("running-right");
  eq("waiting 也能被拖动切走", sm.action, "running-right");
  sm.endDrag();
  eq("拖动前是 waiting 就回 waiting，不是 idle", sm.action, "waiting");
}

{
  const sm = new PetStateMachine(fullSet());
  sm.request("waiting");
  sm.beginDrag();
  sm.dragDirection("running-right");
  sm.beginDrag(); // 拖动中的重复调用：mousemove 与 mouseup 两条路径都可能走到
  sm.endDrag();
  eq("重复 beginDrag 不改写复原目标", sm.action, "waiting");
}

{
  const sm = new PetStateMachine(fullSet());
  sm.request("waving");
  eq("拖动前是手势 waving", sm.action, "waving");
  sm.beginDrag();
  sm.dragDirection("running-right");
  sm.dragDirection(null);
  eq("还没越过阈值落在 null 上时回到拖动前的姿势", sm.action, "waving");
  eq("null 不结束拖动期", sm.dragging, true);
  sm.endDrag();
  eq("随后松手仍复原到拖动前那条", sm.action, "waving");
}

{
  // 拖动前被插件插播占用：复原回插件那条，且插件自己的 dwell 照原样播完
  const sm = new PetStateMachine(fullSet());
  sm.request("jumping");
  eq("插件 pet:react 先占住姿势", sm.action, "jumping");
  sm.beginDrag();
  sm.dragDirection("running-left");
  eq("拖动可以临时接管插件插播的姿势", sm.action, "running-left");
  sm.endDrag();
  eq("松手复原到插件那条（不是 idle）", sm.action, "jumping");
  sm.update(2);
  eq("复原后插件手势按自己的 dwell 播完", sm.action, "idle");
}

{
  // 拖动期不排空队列：插件的排队请求既不被丢掉，也不会被方向态吃掉
  const sm = new PetStateMachine(fullSet());
  sm.request("running");
  sm.request("review");
  eq("低优先级插件请求排队", sm.queuedCount, 1);
  sm.beginDrag();
  sm.dragDirection("running-right");
  sm.update(120);
  eq("拖动期不排空插件的排队请求", sm.queuedCount, 1);
  sm.endDrag();
  eq("松手复原到拖动前的 running", sm.action, "running");
  sm.update(46);
  eq("复原后排队的请求照常出队", sm.action, "review");
  eq("队列已排空", sm.queuedCount, 0);
}

{
  // G6-03：拖动期 request 不再当场切（切了会被下一帧方向帧盖掉，waiting 提示永久丢），
  // 先入队，松手复原后按原优先级补播。
  const sm = new PetStateMachine(fullSet());
  sm.beginDrag();
  sm.dragDirection("running-right");
  sm.request("waiting");
  eq(
    "拖动中插件请求 waiting 不抢方向帧（旧实现切过去就被覆盖，等于丢掉）",
    sm.action,
    "running-right",
  );
  sm.request("jumping");
  eq("拖动中更高优先级的请求也只排队", sm.action, "running-right");
  sm.endDrag();
  eq("松手后补播优先级最高的那条（jumping）", sm.action, "jumping");
  sm.update(2);
  eq("补播的手势按自己的 dwell 播完", sm.action, "idle");
}

{
  // waiting 单独验：它是审批提示，丢了用户就看不到「需要点确认」。
  // 拖动前正好在播手势时，补播要按原优先级排队（不抢正在播的手势），但不能永久丢。
  const sm = new PetStateMachine(fullSet());
  sm.request("waving"); // 拖动前是手势，复原目标不是 idle
  sm.beginDrag();
  sm.dragDirection("running-left");
  sm.request("waiting");
  eq("拖动中 waiting 仍不抢方向帧", sm.action, "running-left");
  sm.endDrag();
  eq("松手后先复原拖动前的姿势（优先级更高的手势没被打断）", sm.action, "waving");
  sm.update(1); // waving 一遍 0.7s 播完，队列里的 waiting 补上
  eq("补播按原优先级排在后面，最终播到 waiting（不再永久丢）", sm.action, "waiting");
  eq("补播后拖动期已结束", sm.dragging, false);
}

// 缺方向帧的皮肤（G6-04）：Moved 循环不许每帧重切回退姿势，否则立绘卡在 idle 的首帧上闪。
group("拖动缺帧皮肤（G6-04）");

{
  const sm = new PetStateMachine(setWithout("running-left", "running-right"));
  sm.request("running"); // 拖动前是 running：缺方向帧时画面不该跳成 idle
  sm.beginDrag();
  sm.dragDirection("running-right");
  eq("缺方向帧时不切到不存在的状态（停在拖动前姿势）", sm.action, "running");
  const frameBefore = sm.frame;
  sm.update(0.2); // running 帧间隔 ≈0.14s，推进一帧
  const frameAfter = sm.frame;
  check("拖动中帧序列照常推进", frameAfter !== frameBefore, "帧没有推进，可能被重切重置了");
  sm.dragDirection("running-right");
  sm.dragDirection("running-left");
  sm.dragDirection(null);
  eq("连续 Moved 不重切（帧序列没有被重置）", sm.frame, frameAfter);
  eq("方向帧缺失期间姿势始终停在拖动前那条", sm.action, "running");
  sm.endDrag();
  eq("松手后仍在拖动前姿势", sm.action, "running");
}

{
  // 拖动前是 idle 时也一样：回退目标恒定，只回退一次，不来回切
  const sm = new PetStateMachine(setWithout("running-left", "running-right"));
  sm.beginDrag();
  sm.dragDirection("running-right");
  eq("idle 起拖 + 缺方向帧：停在 idle", sm.action, "idle");
  const first = sm.frame;
  sm.update(0.2); // idle 帧间隔 ≈0.18s
  const second = sm.frame;
  check("帧确实推进过（不是永远首帧）", second !== first);
  sm.dragDirection("running-left");
  sm.dragDirection("running-right");
  eq("重复 Moved 不重切 idle（帧序列保持推进）", sm.frame, second);
  sm.endDrag();
  eq("松手后仍是 idle", sm.action, "idle");
}

// 拖动交互本体（G6-01/G6-02/G6-08）：用假时钟直接驱动 DragController 的公开方法，
// 不再用正则去 main.ts 里「证明」这些行为存在 —— 正则抓不到「拖动中失焦」「松手没事件」。
group("拖动交互行为（DragController + 假时钟）");

{
  let clock = 0;
  const mk = () => {
    const log = [];
    const ctl = new DragController({
      now: () => clock,
      onBegin: () => log.push("begin"),
      onEnd: (reason) => log.push(`end:${reason}`),
    });
    return { ctl, log };
  };

  {
    const { ctl, log } = mk();
    ctl.pressDown(100, 100);
    check("按下只记 press，不立刻起拖", ctl.hasPress && !ctl.isEngaged && log.length === 0);
    ctl.pointerMove(100 + DRAG_START_PX, 100, 1);
    check("位移恰在阈值上不起拖", !ctl.isEngaged);
    ctl.pointerMove(100 + DRAG_START_PX + 1, 100, 1);
    check("超过阈值才交给系统拖拽（onBegin 一次）", ctl.isEngaged && log.join(",") === "begin");
    ctl.pointerUp();
    check("拖动中抬起按 mouseup 收尾", !ctl.isEngaged && log.at(-1) === "end:mouseup");
  }

  {
    // G6-01：拖动期 blur 不结束拖动；宽限内 focus 回来就作废
    clock = 0;
    const { ctl, log } = mk();
    ctl.pressDown(0, 0);
    ctl.pointerMove(10, 0, 1);
    ctl.blur();
    check(
      "拖动中 blur 只清 press、标记待裁决，不结束拖动",
      ctl.isEngaged && !ctl.hasPress && ctl.awaitingBlurVerdict && !log.includes("end:blur"),
    );
    clock += BLUR_GRACE_MS - 1;
    ctl.tick();
    check("宽限未到不作废拖动", ctl.isEngaged);
    ctl.focus();
    ctl.tick();
    check("宽限内 focus 回来：这次失焦作废、拖动继续", ctl.isEngaged && !ctl.awaitingBlurVerdict);

    clock = 0;
    const second = mk();
    second.ctl.pressDown(0, 0);
    second.ctl.pointerMove(10, 0, 1);
    second.ctl.blur();
    clock += BLUR_GRACE_MS;
    second.ctl.tick();
    check(
      "宽限期到点按真失焦收尾（onEnd reason=blur）",
      !second.ctl.isEngaged && second.log.join(",") === "begin,end:blur",
    );
  }

  {
    // G6-02：真机吞 mouseup —— 窗口静默 250ms 就按松键收尾，不能永远 running
    clock = 0;
    const { ctl, log } = mk();
    ctl.pressDown(0, 0);
    ctl.pointerMove(10, 0, 1);
    clock += DRAG_SILENCE_MS - 1;
    ctl.tick();
    check("静默不足 250ms 不收尾", ctl.isEngaged);
    ctl.windowMoved(); // 窗口还在动 = 拖拽还活着
    clock += 200;
    ctl.tick();
    check("窗口还在动就继续拖（静默计时被窗口位移刷新）", ctl.isEngaged);
    clock += DRAG_SILENCE_MS;
    ctl.tick();
    check(
      "窗口静默 250ms：按松键收尾（onEnd reason=silent）",
      !ctl.isEngaged && log.at(-1) === "end:silent",
    );
  }

  {
    // 拖动中按键已松开（buttons=0 的 mousemove）：mouseup 没收到时的常规补救路径
    clock = 0;
    const { ctl, log } = mk();
    ctl.pressDown(0, 0);
    ctl.pointerMove(10, 0, 1);
    ctl.pointerMove(999, 0, 0);
    check("拖动中按键已松开：按松手收尾", !ctl.isEngaged && log.at(-1) === "end:buttons-released");
  }

  {
    // 非拖动期的失焦/移出只撤销「按住」候选，不能影响别的拖拽
    clock = 0;
    const { ctl, log } = mk();
    ctl.pressDown(0, 0);
    ctl.blur();
    check("非拖动期失焦只撤销按下候选", !ctl.hasPress && !ctl.isEngaged && log.length === 0);
    ctl.pressDown(0, 0);
    ctl.mouseLeave();
    check("移出窗口只撤销按下候选", !ctl.hasPress && !ctl.isEngaged && log.length === 0);

    // 拖动中移出窗口：只清 press，拖动继续
    ctl.pressDown(0, 0);
    ctl.pointerMove(10, 0, 1);
    ctl.mouseLeave();
    check("拖动中移出窗口不结束拖动", ctl.isEngaged && !ctl.hasPress);

    // 上一趟 mouseup 没收到时重新按下：先按松手收尾，再记新按下点
    ctl.pressDown(5, 5);
    check(
      "上一趟 mouseup 丢失时，重新按下先收尾旧的拖动",
      log.includes("end:reset") && ctl.hasPress && !ctl.isEngaged,
    );
  }
}

// 接线层（main.ts 顶层就摸 document，node 里 import 不了）：只钉「事件源与生命周期」这类
// 跑不进 node 的接线事实；拖动行为本身在上面的假时钟单测里验。
group("拖动接线（main.ts 形状）");

{
  const mainSrc = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
  check(
    "方向来自窗口真实位移：挂的是 petWindow.onMoved",
    mainSrc.includes("petWindow.onMoved("),
    "main.ts 里没有 onMoved",
  );
  check(
    "onWindowMoved 把窗口位移喂给方向判定与静默兜底",
    /function onWindowMoved[\s\S]*?pet\.dragDirection\(dragTracker\.sample\(/.test(mainSrc) &&
      mainSrc.includes("drag.windowMoved()"),
    "onWindowMoved 没接方向判定/静默兜底",
  );
  check(
    "拖动收尾统一走 DragController（main.ts 不再自己管 press 标志）",
    mainSrc.includes("drag.pointerUp()") && mainSrc.includes("drag.isEngaged") && !mainSrc.includes("let press:"),
    "main.ts 没有接 DragController",
  );
  check(
    "重复 activate 不叠加监听（已挂即退）",
    mainSrc.includes("if (dragTrackingDisposed || dragTrackingPending || unlistenMoved) return;"),
    "installDragTracking 缺少单飞守卫",
  );
  check(
    "unlisten 只调一次：原生注销包在 onceOnly 里",
    mainSrc.includes("unlistenMoved = onceOnly(un);") &&
      /function onceOnly[\s\S]*?done = true;\s*unlisten\(\);/.test(mainSrc),
    "onceOnly 缺位或没有幂等",
  );
  check(
    "窗口销毁前摘监听（pagehide）",
    /addEventListener\("pagehide", disposeDragTracking/.test(mainSrc),
    "没有 pagehide 收尾",
  );
}

/* ============================ topic 归属 ACL ============================ */
group("topic-acl");

{
  noThrow("发布自己前缀放行", () => acl.assertPublishable("com.pet.todo", "com.pet.todo:changed"));
  throws("发布他人前缀被拒", () => acl.assertPublishable("com.pet.todo", "com.pet.astock:cmd"), "前缀");
  throws("发布宿主 topic 被拒", () => acl.assertPublishable("com.pet.todo", "ble:heart-rate"), "前缀");
  throws("通配发布被拒", () => acl.assertPublishable("com.pet.todo", "com.pet.todo:*"), "前缀");
  noThrow("订阅自己前缀不需要授权", () => acl.assertSubscribable("com.pet.todo", "com.pet.todo:widget", []));
  noThrow("订阅自己前缀的通配也可以", () => acl.assertSubscribable("com.pet.todo", "com.pet.todo:*", []));
  noThrow("声明 bus:subscribe 后能订宿主 topic", () =>
    acl.assertSubscribable("com.pet.todo", "agent:state", ["bus:subscribe"]),
  );
  throws(
    "未声明就订他人 topic 被拒",
    () => acl.assertSubscribable("com.pet.todo", "agent:state", []),
    "bus:subscribe",
  );
  throws("通配订阅不许越过自己命名空间", () => acl.assertSubscribable("com.pet.todo", "*", ["bus:subscribe"]), "通配");
  throws(
    "带前缀的通配同样越界",
    () => acl.assertSubscribable("com.pet.todo", "com.pet.*", ["bus:subscribe"]),
    "通配",
  );
}

{
  const sent = [];
  const fake = {
    publish: (topic, payload, pluginId) => sent.push({ topic, payload, pluginId }),
    subscribe: () => () => {},
  };
  const scoped = acl.createScopedBus("com.pet.todo", ["bus:publish", "bus:subscribe"], fake);
  deep("受限视图只暴露 publish/subscribe", Object.keys(scoped).sort(), ["publish", "subscribe"]);
  scoped.publish("com.pet.todo:cmd", { action: "sync" });
  deep("发布把插件身份带到中继那一层", sent[0], {
    topic: "com.pet.todo:cmd",
    payload: { action: "sync" },
    pluginId: "com.pet.todo",
  });
  throws("未声明 bus:publish 时本地就拦下", () => {
    const bare = acl.createScopedBus("com.pet.todo", [], fake);
    bare.publish("com.pet.todo:cmd", {});
  }, "bus:publish");
  throws("受限视图里没有 inject", () => scoped.inject("agent:state", {}), "inject");
}

/* ============================ 事件总线 ============================ */
group("event-bus");

resetStub();

{
  const got = [];
  const off = bus.subscribe("com.pet.todo:changed", (p) => got.push(p));
  bus.inject("com.pet.todo:changed", { n: 1 });
  eq("inject 本地即时派发", got.length, 1);
  off();
  bus.inject("com.pet.todo:changed", { n: 2 });
  eq("退订后不再收", got.length, 1);

  const wild = [];
  const offWild = bus.subscribe("com.pet.todo:*", (p) => wild.push(p));
  bus.inject("com.pet.todo:widget", { v: 1 });
  bus.inject("com.pet.astock:cmd", {});
  eq("前缀通配命中自己的 topic", wild.length, 1);
  offWild();
}

{
  // 通配订阅 :widget 会向宿主取最近一份（回灌），这条靠 stub 的 invoke 记录来证明
  resetStub();
  setReply("bus_peek", { mode: "badge" });
  const replayed = [];
  const off = bus.subscribe("zz.probe:widget", (p) => replayed.push(p));
  check(
    "订阅 widget topic 会问宿主取回灌",
    tauriCalls.some((c) => c.cmd === "bus_peek"),
    "stub 没记录到 bus_peek 调用",
  );
  off();
  // S4：回灌要报**订阅方自己**的身份（宿主侧不代表任何插件时是 null），宿主按它校验 topic 归属
  deep(
    "bus_peek 带 topic 与订阅方身份（宿主自己的订阅是 null）",
    tauriCalls.find((c) => c.cmd === "bus_peek")?.args,
    { topic: "zz.probe:widget", pluginId: null },
  );
}

{
  // S4 反例：传出去的是**订阅方的身份**，不是从 topic 前缀里解析出来的 ——
  // 否则订别人的 topic 会自动带上别人的 id，归属校验就形同虚设
  resetStub();
  setReply("bus_peek", { mode: "badge" });
  const off = bus.subscribe("com.pet.astock:widget", () => {}, "com.pet.todo");
  deep(
    "订阅方是 todo、topic 是 astock：传出去的仍是订阅方的 id，不是 topic 前缀",
    tauriCalls.find((c) => c.cmd === "bus_peek")?.args,
    { topic: "com.pet.astock:widget", pluginId: "com.pet.todo" },
  );
  off();
}

{
  // S4：悬浮窗那一支的归属只认宿主注册表（label 是宿主开窗时定的，页面伪造不了）。
  // 这条**只能钉源码形状**：注册表本体是 overlay.rs 里的私有 static，离线造不出它的状态；
  // 而「命令体把注册表值交给归属解析」正是漏了就让自报值生效的那一步（变异 M2 实测如此）。
  const busSrc = readFileSync(new URL("../../src-tauri/src/commands/bus.rs", import.meta.url), "utf8");
  const busCode = busSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // 只看 bus_peek 这一段：bus_publish 里有一模一样的一行，扫全文会让这条钉空转
  const peekAt = busCode.indexOf("pub fn bus_peek");
  const peekBody = busCode.slice(peekAt, busCode.indexOf("fn peek_allowed", peekAt));
  check(
    "bus_peek 的归属解析带上了宿主注册表（悬浮窗自报值作废的那一支）",
    peekAt > 0 && peekBody.includes("crate::window::overlay::owner_of_label(&label)"),
    `在 bus.rs 里没找到这一行（peekAt=${peekAt}）`,
  );
}

{
  resetStub();
  bus.publish("com.pet.todo:changed", { n: 3 }, "com.pet.todo");
  const relay = tauriCalls.find((c) => c.cmd === "bus_publish");
  check("publish 走一趟中继", !!relay, `calls=${JSON.stringify(tauriCalls)}`);
  deep("中继参数带上 topic/payload/pluginId", relay?.args, {
    topic: "com.pet.todo:changed",
    payload: { n: 3 },
    pluginId: "com.pet.todo",
  });
  bus.publish("com.pet.todo:status", { text: "x" });
  eq("宿主自己的发布不带插件身份（由宿主判为 null）", tauriCalls.at(-1)?.args.pluginId, null);
}

{
  // 自递归必须在深度上限处截断，否则通配订阅者会把栈打爆
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(String(a.join(" ")));
  let fired = 0;
  const off = bus.subscribe("zz.probe:rec:*", () => {
    fired++;
    bus.inject("zz.probe:rec:x", {});
  });
  bus.inject("zz.probe:rec:x", {});
  off();
  console.error = realError;
  check("递归被截断在有限层", fired > 1 && fired <= 12, `实际 ${fired} 层`);
  check("截断时有明确告警", errors.some((e) => e.includes("派发递归")), JSON.stringify(errors));

  let after = 0;
  const off2 = bus.subscribe("zz.probe:after", () => after++);
  bus.inject("zz.probe:after", {});
  off2();
  eq("截断后总线仍可正常派发", after, 1);
}

/* ============================ 插件文件 URL ============================ */
group("plugin-url");

{
  eq(
    "不带版本串",
    pluginFileUrl("com.pet.astock", "index.js"),
    "http://petplugin.localhost/com.pet.astock/index.js",
  );
  eq(
    "mtime 拼成查询串做 cache-busting",
    pluginFileUrl("todo", "widget.js", 1720000000000),
    "http://petplugin.localhost/todo/widget.js?v=1720000000000",
  );
  eq("版本串为空串时退回不带参数", pluginFileUrl("todo", "index.js", ""), "http://petplugin.localhost/todo/index.js");
  eq("undefined 版本同样不带参数", pluginFileUrl("todo", "index.js", undefined), "http://petplugin.localhost/todo/index.js");
  throws("缺入口路径直接抛", () => pluginFileUrl("todo", undefined), "缺少入口文件路径");
  eq("id 里的点号不被编码掉", pluginFileUrl("a.b", "x.js").includes("a.b"), true);
}

{
  resetStub();
  setReply("plugin_file_version", 12345);
  const ok = await pluginFileVersion("todo", "index.js");
  eq("mtime 以字符串给出", ok, "12345");
  const asked = tauriCalls.find((c) => c.cmd === "plugin_file_version");
  deep("参数名与 Rust 侧一致", asked?.args, { pluginId: "todo", rel: "index.js" });
  setReply("plugin_file_version", () => Promise.reject(new Error("文件正被替换")));
  const fallback = await pluginFileVersion("todo", "index.js");
  eq("取不到 mtime 时返回空串而不是拒绝加载", fallback, "");
}

/* ============================ manifest 校验 ============================ */
group("validateManifest");

{
  const good = { id: "com.pet.astock", name: "A股盯盘", version: "0.1.0", entry: "index.js" };
  eq("合法 manifest 通过", validateManifest(good), null);
  eq("带 widget 也合法", validateManifest({ ...good, widget: "widget.js" }), null);
  check("id 词表与 Rust 侧 ids.rs 一致（下划线被拒）", !!validateManifest({ ...good, id: "a_b" }), "没拦住 a_b");
  check("大写 id 被拒", !!validateManifest({ ...good, id: "Todo" }), "没拦住大写");
  check("过短 id 被拒", !!validateManifest({ ...good, id: "ab" }), "没拦住 ab");
  check("路径式 id 被拒", !!validateManifest({ ...good, id: "../etc" }), "没拦住 ../etc");
  eq("数字开头的 id 合法（与前端正则一致）", validateManifest({ ...good, id: "1.2-3" }), null);
  eq(
    "65 字符的 id 超长被拒",
    validateManifest({ ...good, id: `a${"b".repeat(64)}` }) !== null,
    true,
  );
  check("缺 name 被拒", validateManifest({ ...good, name: "" }).includes("name"), true);
  check("缺 version 被拒", validateManifest({ ...good, version: "" }).includes("version"), true);
  check("entry 带斜杠被拒", validateManifest({ ...good, entry: "a/index.js" }).includes("entry"), true);
  check("widget 不是 .js 被拒", validateManifest({ ...good, widget: "widget.mjs" }).includes("widget"), true);
  check("permissions 不是数组被拒", validateManifest({ ...good, permissions: "http" }).includes("permissions"), true);
  check("整个 manifest 不是对象被拒", String(validateManifest(null)).includes("不是对象"), true);
}

/* ============================ 共享资源与订阅回收 ============================ */
group("资源回收");

{
  resources.claim("ble", "a");
  resources.claim("ble", "b");
  eq("非持有者 release 不算数", resources.release("ble", "zz"), false);
  eq("仍有人持有时不释放", resources.release("ble", "a"), false);
  eq("最后一个持有者退出才释放", resources.release("ble", "b"), true);
  resources.claim("ble-scan", "c");
  eq("ble 与 ble-scan 各自独立计数", resources.release("ble", "c"), false);
  deep("releaseAll 回每类资源的释放情况", resources.releaseAll("c"), {
    ble: false,
    "ble-scan": true,
  });
}

{
  let ran = 0;
  const handle = subs.register("zz.probe", () => ran++);
  subs.register("zz.probe", () => ran++);
  eq("登记数可见", subs.pendingCount("zz.probe"), 2);
  handle();
  eq("插件提前自行退订会即时执行", ran, 1);
  eq("提前退订后登记数减一", subs.pendingCount("zz.probe"), 1);
  handle();
  eq("同一个句柄重复调用不再执行第二次", ran, 1);
  eq("宿主回收剩下的登记", subs.disposeAll("zz.probe"), 1);
  eq("回收后没有残留", subs.pendingCount("zz.probe"), 0);
  eq("重复回收是 0", subs.disposeAll("zz.probe"), 0);

  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(String(a.join(" ")));
  subs.register("zz.probe", () => {
    throw new Error("插件自己的清理炸了");
  });
  eq("清理函数抛错时不计入回收成功数", subs.disposeAll("zz.probe"), 0);
  console.error = realError;
  check("抛错的回收有告警留下", errors.some((e) => e.includes("回收 zz.probe")), JSON.stringify(errors));
}

/* ============================ 启停清单与一次性迁移（C1） ============================ */
group("启停清单");

{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  // 1) 宿主已有那份 → 直接用，也不碰旧键
  resetStub();
  setReply("plugin_enabled_list", ["todo"]);
  deep("宿主已有清单时直接采用", await rt.loadEnabled(), ["todo"]);
  deep("getEnabled 读到同一份", rt.getEnabled(), ["todo"]);
  eq("不再触发迁移", tauriCalls.some((c) => c.cmd === "plugin_enabled_migrate"), false);

  // 2) 宿主还没写过 → 拿旧键那份去迁移，并以宿主回读的那份为准
  resetStub();
  setReply("plugin_enabled_list", null);
  setReply("plugin_enabled_migrate", ["todo", "com.pet.astock"]);
  store.set("host:enabled-plugins", JSON.stringify(["todo", 7, "C:", "com.pet.astock"]));
  deep("迁移结果以宿主回读为准", await rt.loadEnabled(), ["todo", "com.pet.astock"]);
  deep(
    "旧键里非字符串的项在 JS 侧就先挡掉（宿主还有一层 id 词表）",
    tauriCalls.find((c) => c.cmd === "plugin_enabled_migrate")?.args?.ids,
    ["todo", "C:", "com.pet.astock"],
  );
  deep("本窗缓存跟着迁移结果走", rt.getEnabled(), ["todo", "com.pet.astock"]);

  // 3) 旧键是坏 JSON → 按空表迁移，不能抛
  resetStub();
  setReply("plugin_enabled_list", null);
  setReply("plugin_enabled_migrate", []);
  store.set("host:enabled-plugins", "{ 不是 json");
  deep("旧键读坏按空表处理", await rt.loadEnabled(), []);
  deep("交给宿主的也是空表", tauriCalls.find((c) => c.cmd === "plugin_enabled_migrate")?.args?.ids, []);

  // 4) 旧键整个不存在 → 空表，且仍把这次迁移落下去（宿主要有自己的一份，才谈得上清缓存不丢）
  resetStub();
  setReply("plugin_enabled_list", null);
  setReply("plugin_enabled_migrate", []);
  store.delete("host:enabled-plugins");
  deep("没有旧键时是空表", await rt.loadEnabled(), []);
  eq("仍然调了迁移命令", tauriCalls.some((c) => c.cmd === "plugin_enabled_migrate"), true);

  // 5) 老宿主没这条命令 → 退回旧键那份继续跑，别把用户挡在门外
  resetStub();
  setReply("plugin_enabled_list", null);
  setReply("plugin_enabled_migrate", () => Promise.reject(new Error("命令不存在")));
  store.set("host:enabled-plugins", JSON.stringify(["todo"]));
  deep("迁移失败时退回旧键那份", await rt.loadEnabled(), ["todo"]);

  // 6) 写清单：以宿主回读的那份为准（它滤过非法项与重复项）
  resetStub();
  setReply("plugin_enabled_set", ["com.pet.hr-ble"]);
  await rt.setEnabledIds(["com.pet.hr-ble", "C:"]);
  deep("写入后本窗缓存采用宿主的结果", rt.getEnabled(), ["com.pet.hr-ble"]);
  deep(
    "参数原样带给宿主",
    tauriCalls.find((c) => c.cmd === "plugin_enabled_set")?.args,
    { ids: ["com.pet.hr-ble", "C:"] },
  );
}

/* ============================ 插件热重载判定 ============================ */
group("插件热重载判定");

{
  const carryA = (id) => id === "zz.a";
  // dev 下承载了变更插件 → 重载；其余一律不动。判定是纯函数（dev 由调用方传入），
  // 所以两条分支都能离线跑；真机上的 dev 值来自 import.meta.env.DEV（装配层读取）。
  deep("dev 下变更命中本窗承载的插件 → 要重载", hotReload.decideHotReload(["zz.a"], carryA, true), {
    carried: ["zz.a"],
    shouldReload: true,
  });
  deep("非 dev 构建绝不重载（打包版不该掀用户窗口）", hotReload.decideHotReload(["zz.a"], carryA, false), {
    carried: ["zz.a"],
    shouldReload: false,
  });
  deep("变更与本窗无关 → 不动", hotReload.decideHotReload(["zz.b"], carryA, true), {
    carried: [],
    shouldReload: false,
  });
  deep(
    "同一 id 重复出现只算一次，且只回报确实承载的那些",
    hotReload.decideHotReload(["zz.a", "zz.a", "zz.b", "zz.a"], (id) => id !== "zz.b", true),
    { carried: ["zz.a"], shouldReload: true },
  );
  deep("空变更列表 → 不动", hotReload.decideHotReload([], () => true, true), {
    carried: [],
    shouldReload: false,
  });
  // 装配层：node 里没有 Vite 注入的 import.meta.env，必须安全落到「不重载」——
  // 这条同时钉住「离开 dev 就不碰 location」的接线（node 里没有 location，碰了就会抛）
  deep("装配层在非 Vite 环境不重载也不抛", hotReload.applyHotReload(["zz.a"], carryA), {
    carried: ["zz.a"],
    shouldReload: false,
  });
  deep("载荷里的变更 id 被取出", hotReload.changedIdsFrom({ ids: ["zz.a", "zz.b"] }), ["zz.a", "zz.b"]);
  deep("载荷里的非字符串项被滤掉", hotReload.changedIdsFrom({ ids: ["zz.a", 7, null, "zz.b"] }), ["zz.a", "zz.b"]);
  deep("旧载荷（()）按取不到处理", hotReload.changedIdsFrom(null), []);
  deep("不带 ids 的对象按取不到处理", hotReload.changedIdsFrom({}), []);
  // 重载判定只认 reloadIds（模块文件被覆盖的那部分插件）
  deep("reloadIds 被取出", hotReload.reloadIdsFrom({ ids: ["zz.a", "zz.b"], reloadIds: ["zz.b"] }), ["zz.b"]);
  deep("只有 manifest 被动过时 reloadIds 为空 → 不重载", hotReload.reloadIdsFrom({ ids: ["zz.a"], reloadIds: [] }), []);
  deep("reloadIds 里的非字符串项被滤掉", hotReload.reloadIdsFrom({ reloadIds: ["zz.a", 9, undefined] }), ["zz.a"]);
  deep("缺 reloadIds 的载荷按空处理（不误重载）", hotReload.reloadIdsFrom({ ids: ["zz.a"] }), []);
  deep("坏载荷按空处理", hotReload.reloadIdsFrom(null), []);
}

/* ============================ 同意框刷新与拒绝文案（ADR-0013） ============================ */
group("同意框刷新与拒绝文案");

{
  eq(
    "停用时提示取消，不误导用户去设置页重新授权",
    "插件已停用，授权请求已取消",
    rt.consentFailureMessage(false),
  );
  eq(
    "用户拒绝时提示关闭插件再开启",
    "本次已拒绝，关闭插件再开启后可再次申请",
    rt.consentFailureMessage(true),
  );

  const consentSrc = readFileSync(new URL("../../src/consent/main.ts", import.meta.url), "utf8");
  check(
    "同意框用 consent_details 轮询同一 req_id",
    consentSrc.includes('hostCall<ConsentDetails>("consent_details"') &&
      consentSrc.includes("timer = setInterval("),
    true,
  );
  check(
    "轮询间隔 400ms、上限约 65s",
    /POLL_MS\s*=\s*400/.test(consentSrc) && /POLL_MAX_MS\s*=\s*65_000/.test(consentSrc),
    true,
  );
  const notFoundBranch =
    consentSrc.split("if (e.code === NOT_FOUND)")[1]?.split("// 偶发")[0] ?? "";
  check(
    "NOT_FOUND 只关窗、不再 consent_answer",
    notFoundBranch.includes("closeExpired") &&
      !notFoundBranch.includes('hostCall("consent_answer"'),
    true,
  );
  check(
    "答复、pagehide、beforeunload 都停表",
    consentSrc.includes("stopPolling") &&
      consentSrc.includes('addEventListener("pagehide", stopPolling)') &&
      consentSrc.includes('addEventListener("beforeunload", stopPolling)'),
    true,
  );
  check("能力并集重绘时去重", consentSrc.includes("[...new Set(caps)]"), true);

  const consentCss = readFileSync(new URL("../../src/consent/style.css", import.meta.url), "utf8");
  check(
    "能力列表有高度上限并可滚动",
    /#cap-list\s*\{[\s\S]*max-height:\s*150px;[\s\S]*overflow-y:\s*auto;/.test(consentCss),
    true,
  );
}

group("A30 热键状态契约");

{
  const hotkeyTs = readFileSync(
    new URL("../../src/settings/sections/hotkey.ts", import.meta.url),
    "utf8",
  );
  const hotkeysRs = readFileSync(
    new URL("../../src-tauri/src/services/hotkeys.rs", import.meta.url),
    "utf8",
  );
  check(
    "A30 hotkey_status 读取真实注册状态",
    hotkeysRs.includes("is_registered(accelerator.as_str())") &&
      hotkeysRs.includes('"registered": registered'),
    true,
  );
  check(
    "A30 前端读取 camelCase registered",
    hotkeyTs.includes("registered: boolean") && hotkeyTs.includes("info.registered"),
    true,
  );
  check(
    "A30 未生效提示与 error 样式",
    hotkeyTs.includes("未生效（可能被其他程序占用），请换一个") &&
      hotkeyTs.includes('classList.add("error", "error-banner")'),
    true,
  );
}
