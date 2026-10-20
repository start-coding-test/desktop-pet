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
