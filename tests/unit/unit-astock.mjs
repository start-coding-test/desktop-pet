// astock（A 股盯盘）验收回归：G5-01 / G5-04 / N3 / N5 的可观测行为。
//
// 为什么用真的 Worker 侧虚拟节点（WidgetRenderSession + createDomFacade）：
// 「回显没有覆盖用户输入」在 Worker 路线下的可观测形式就是「这一帧没有为那个节点发 prop value」
// —— 假 DOM 会把快照回推这条契约抹平，产出一堆恒真断言（同 unit-settings-echo.mjs 的理由）。
//
// 本文件只跑离线单测：不发网络请求、不用真实行情/接口，行情数据全部是手写常量。
//
// 运行：npm run unit（等价于 node --import ./tests/unit/ts-loader.mjs --test 本文件）
import { check, deep, eq, group } from "./harness.mjs";
import { WidgetRenderSession, createDomFacade } from "../../src/runtime/widget-node.ts";
import { echoStep, mountWatchList, savedLedger } from "../../plugins/com.pet.astock/views/settings/watch-list.js";
import { mountPrefs } from "../../plugins/com.pet.astock/views/settings/prefs.js";
import { syncCheck, syncRadioGroup, syncSelect } from "../../plugins/com.pet.astock/views/settings/lock.js";
import { TOPIC_CMD } from "../../plugins/com.pet.astock/topics.js";

/** 一个 session + 它的 op 出口与总线收件。`ops()` 跑一次 flush 并只返回「自上次取走之后」的 op。 */
function rig() {
  const sent = [];
  const session = new WidgetRenderSession((msg) => sent.push(msg));
  const dom = createDomFacade(session);
  const published = [];
  const ops = () => {
    session.flush();
    const out = sent.flatMap((m) => m.ops);
    sent.length = 0;
    return out;
  };
  const ctx = { dom, bus: { publish: (topic, payload) => published.push([topic, payload]) } };
  return { session, dom, published, ops, ctx };
}

const byPlaceholder = (ops, ph) =>
  ops.find((o) => o.k === "prop" && o.name === "placeholder" && o.value === ph)?.id;
const valueOps = (ops, id) => ops.filter((o) => o.k === "prop" && o.name === "value" && o.id === id);
const checkedOps = (ops, id) => ops.filter((o) => o.k === "prop" && o.name === "checked" && o.id === id);

/* ============================ echoStep / savedLedger ============================ */
group("astock 回显一步的纯决策（G5-01 / N3）");
{
  // 「存」之后又动了手：编辑锁优先，这一帧不许写（否则刚敲的字被在途旧帧冲掉，锁还卡死）
  deep("force 遇到编辑锁：不写、不放锁，台账也不动（等追上或下次「存」再记账）", echoStep({
    editing: true,
    value: "13.5",
    want: "12",
    ledger: "12",
    force: true,
  }), { release: false, write: false, ledger: "12" });

  // 没有编辑锁时 force 仍然是「强制按宿主的值重画一次」：非法值被钳成空时靠它清掉草稿
  deep("force 没有编辑锁：强制写宿主值并记台账", echoStep({
    editing: false,
    value: "abc",
    want: "",
    ledger: "abc",
    force: true,
  }), { release: false, write: true, ledger: "" });

  deep("编辑中且宿主追上了：放锁、不写", echoStep({
    editing: true,
    value: "13.5",
    want: "13.5",
    ledger: "12",
  }), { release: true, write: false, ledger: "13.5" });

  deep("编辑中但还没追上：不写、草稿留着", echoStep({
    editing: true,
    value: "13.5",
    want: "12",
    ledger: "12",
  }), { release: false, write: false, ledger: "12" });

  deep("没在编辑且台账与目标不同：写", echoStep({
    editing: false,
    value: "12",
    want: "13.5",
    ledger: "12",
  }), { release: false, write: true, ledger: "13.5" });

  deep("没在编辑且台账已是目标：一个 op 都不发（幂等）", echoStep({
    editing: false,
    value: "13.5",
    want: "13.5",
    ledger: "13.5",
  }), { release: false, write: false, ledger: "13.5" });

  // 点「存」要记进台账的是框里的实际串，不是配置里的旧值（G5-01 的主修）
  deep("savedLedger 取框里的实际串（含空格裁掉）", savedLedger({ upper: " 13.5 ", lower: "", pct: "3" }), {
    upper: "13.5",
    lower: "",
    pctNum: "3",
  });
}

/* ============================ 编辑锁 helper ============================ */
group("astock 设置回显的编辑锁（G5-04 / N5 / G9-09）");
{
  const fake = (props) => ({ ...props });

  const sel = fake({ value: "1.000001" });
  const locks = new Set();
  eq("未上锁且值不同：写下去", syncSelect(sel, "1.000300", locks), true);
  eq("写的是推送里的值", sel.value, "1.000300");
  eq("未上锁且值相同：不重发 op", syncSelect(sel, "1.000300", locks), false);

  locks.add(sel);
  eq("上锁且没追上：不写", syncSelect(sel, "1.000001", locks), false);
  eq("锁还在（等推送追上才放）", locks.has(sel), true);
  sel.value = "1.000001";
  eq("上锁且追上了：放锁", syncSelect(sel, "1.000001", locks), false);
  eq("放锁后外部改动又能进来", syncSelect(sel, "0.399001", locks), true);

  const box = fake({ checked: true });
  const locks2 = new Set();
  eq("未上锁且相同：不写", syncCheck(box, true, locks2), false);
  eq("未上锁且不同：写", syncCheck(box, false, locks2), true);
  eq("写的是 false", box.checked, false);
  locks2.add(box);
  eq("上锁且没追上：不写（用户刚勾掉的不会被旧配置写回）", syncCheck(box, true, locks2), false);
  eq("锁还在", locks2.has(box), true);
  eq("上锁且追上：放锁且不写", syncCheck(box, false, locks2), false);
  eq("放锁", locks2.has(box), false);

  // radio 组：组里有一个在锁上就整组别碰 —— 否则写别人的 checked 等于把用户刚选的取消掉
  const r1 = fake({ checked: false });
  const r2 = fake({ checked: true });
  const r3 = fake({ checked: false });
  const locks3 = new Set();
  const entries = [["badge", r1], ["overlay", r2], ["off", r3]];
  eq("未上锁时按目标值写", syncRadioGroup(entries, "off", locks3), true);
  deep("整组只有一个 true", [r1.checked, r2.checked, r3.checked], [false, false, true]);
  locks3.add(r3);
  eq("上锁且没追上：整组不碰", syncRadioGroup(entries, "badge", locks3), false);
  deep("用户刚选的 off 还在", [r1.checked, r2.checked, r3.checked], [false, false, true]);
  eq("上锁且追上：放锁", syncRadioGroup(entries, "off", locks3), false);
  eq("放锁后外部改动又能进来", syncRadioGroup(entries, "badge", locks3), true);
}

/* ============================ 自选表：存 + 立刻改 ============================ */
group("astock 自选表：点「存」后立刻接着输入，不许被在途旧帧冲掉（G5-01 回归 / N3）");
{
  const { session, published, ops, ctx } = rig();
  const state = { lastPanel: null, autoPicked: false, section: () => ctx.dom.createElement("section") };
  const list = mountWatchList(ctx, state);
  const item = (upper) => ({
    secid: "1.600519",
    code: "600519",
    name: "贵州茅台",
    upper,
    lower: null,
    pct: null,
    limit: true,
  });
  const view = (price, pct, upper = 12) => ({ watch: [item(upper)], quotes: { "1.600519": { price, pct } } });

  list.render(view(1300, 1.2));
  const build = ops();
  const upperId = byPlaceholder(build, "涨到");
  const saveId = build.find((o) => o.k === "text" && o.value === "存")?.id;
  check("建表帧里找得到「涨到」与「存」", typeof upperId === "number" && typeof saveId === "number", `${upperId}/${saveId}`);
  check("首帧把配置里的 12 写进「涨到」", valueOps(build, upperId).some((o) => o.value === "12"));

  published.length = 0;
  session.handleEvent(saveId, "click", {});
  ops();
  const pub = published.filter(([topic]) => topic === TOPIC_CMD).map(([, payload]) => payload);
  check(
    "点「存」发的是 update + 完整三格（不是只发改的那一格）",
    pub.length === 1 && pub[0].action === "update" && pub[0].secid === "1.600519" && pub[0].upper === "12",
    JSON.stringify(pub),
  );

  // 存完立刻接着改：真实用户就是这么操作的
  session.handleEvent(upperId, "input", { value: "13.5" });
  ops();

  // 在途的旧帧（宿主还没收到 update，配置里仍是 12）
  list.render(view(1300, 1.2));
  const stale = ops();
  check(
    "存之后立刻输入的草稿没有被在途旧帧冲掉（force 让位给编辑锁）",
    valueOps(stale, upperId).every((o) => o.value !== "12"),
    JSON.stringify(valueOps(stale, upperId)),
  );

  // 锁没有卡死：宿主追上 13.5 之后，外部改动照样进得来
  list.render(view(1301, 1.3, 13.5));
  ops();
  list.render(view(1301, 1.3, 99));
  const external = ops();
  check(
    "放锁后外部改的 99 能进输入框（锁不会永远卡住）",
    valueOps(external, upperId).some((o) => o.value === "99"),
    JSON.stringify(valueOps(external, upperId)),
  );
}

/* ============================ 设置面板：开关/下拉的编辑锁 ============================ */
group("astock 设置面板：勾掉后备源后，旧配置的推送不许写回（G5-04 / N5）");
{
  const { session, published, ops, ctx } = rig();
  const state = {
    status: { at: Date.now(), line: ctx.dom.createElement("div"), set: () => {} },
    section: () => ctx.dom.createElement("section"),
  };
  const prefs = mountPrefs(ctx, state);
  prefs.render({ config: {}, watch: [], net: {} });
  const build = ops();
  // 复选框没有稳定的建序/文案可依：对每个 checked 节点发一次 change，看它发的是哪个 config key 来反查
  const candidateIds = build.filter((o) => o.k === "prop" && o.name === "checked").map((o) => o.id);
  const idByKey = {};
  for (const id of candidateIds) {
    published.length = 0;
    session.handleEvent(id, "change", { checked: true });
    const pub = published.filter(([topic]) => topic === TOPIC_CMD).map(([, payload]) => payload);
    const key = pub.length === 1 && pub[0].action === "config" ? Object.keys(pub[0].value)[0] : null;
    if (key) idByKey[key] = id;
    ops();
  }
  check(
    "四个开关都能按发布的 config key 反查到（alertsOn/petOn/showIndex/allowFallback）",
    ["alertsOn", "petOn", "showIndex", "allowFallback"].every((key) => typeof idByKey[key] === "number"),
    JSON.stringify(idByKey),
  );
  const fallbackId = idByKey.allowFallback;
  check(
    "首帧四个开关都是勾上的默认值",
    ["alertsOn", "petOn", "showIndex", "allowFallback"].every((key) =>
      checkedOps(build, idByKey[key]).some((o) => o.value === true),
    ),
    JSON.stringify(candidateIds),
  );

  published.length = 0;
  session.handleEvent(fallbackId, "change", { checked: false });
  ops();
  const pub = published.filter(([topic]) => topic === TOPIC_CMD).map(([, payload]) => payload);
  check(
    "勾掉后备源立刻发配置（不是等别的操作顺带）",
    pub.length === 1 && pub[0].action === "config" && pub[0].value.allowFallback === false,
    JSON.stringify(pub),
  );

  // 推送还没追上（配置里仍是 true）：不许把刚勾掉的写回来
  prefs.render({ config: { allowFallback: true }, watch: [], net: {} });
  const stale = ops();
  check(
    "旧配置的推送没有把「允许后备数据源」写回勾上",
    checkedOps(stale, fallbackId).length === 0,
    JSON.stringify(checkedOps(stale, fallbackId)),
  );

  // 追上之后放锁：外部再改就得写
  prefs.render({ config: { allowFallback: false }, watch: [], net: {} });
  ops();
  prefs.render({ config: { allowFallback: true }, watch: [], net: {} });
  const external = ops();
  check(
    "放锁后外部把 allowFallback 改回 true 能回显",
    checkedOps(external, fallbackId).some((o) => o.value === true),
    JSON.stringify(checkedOps(external, fallbackId)),
  );
}

group("astock 设置面板：显示方式单选框的编辑锁（G5-04）");
{
  const { session, published, ops, ctx } = rig();
  const state = {
    status: { at: Date.now(), line: ctx.dom.createElement("div"), set: () => {} },
    section: () => ctx.dom.createElement("section"),
  };
  const prefs = mountPrefs(ctx, state);
  prefs.render({ config: { mode: "badge" }, watch: [], net: {} });
  const build = ops();
  // radio 的 value 是建节点时写的 prop value，与 checked 一一对应；按 value 反查 id
  const radioIds = {};
  for (const value of ["badge", "overlay", "off"]) {
    const hit = build.find((o) => o.k === "prop" && o.name === "value" && o.value === value && o.id !== undefined);
    radioIds[value] = hit?.id;
  }
  check(
    "三个模式单选框都建出来了",
    Object.values(radioIds).every((id) => typeof id === "number"),
    JSON.stringify(radioIds),
  );
  const badgeId = radioIds.badge;
  const initialChecked = checkedOps(build, badgeId);
  check("默认 badge 被勾上", initialChecked.some((o) => o.value === true), JSON.stringify(initialChecked));

  published.length = 0;
  session.handleEvent(radioIds.overlay, "change", { checked: true });
  ops();
  const pub = published.filter(([topic]) => topic === TOPIC_CMD).map(([, payload]) => payload);
  check(
    "选 overlay 立刻发配置",
    pub.length === 1 && pub[0].value.mode === "overlay",
    JSON.stringify(pub),
  );

  // 推送还没追上（仍是 badge）：整组都不许动，否则刚选的 overlay 会被取消掉
  prefs.render({ config: { mode: "badge" }, watch: [], net: {} });
  const stale = ops();
  const staleChecked = stale.filter((o) => o.k === "prop" && o.name === "checked");
  check(
    "旧配置的推送没有把整组单选框写回去",
    staleChecked.length === 0,
    JSON.stringify(staleChecked),
  );
}
