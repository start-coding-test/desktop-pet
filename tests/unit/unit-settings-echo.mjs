// Bug4 的渲染契约单测：插件设置页的「推送回显」不许冲掉用户正在编辑的控件。
//
// 为什么用真的 Worker 侧虚拟节点（WidgetRenderSession + createDomFacade）而不是手搓假 DOM：
// 值只有经 handleEvent 的快照回推才会写回节点（widget-node.ts:82-90），假 DOM 会把这条契约
// 抹平，产出一堆恒真断言（unit-astock-views.mjs 开头就因此明确不测 mount*）。
// 这里判的是宿主真正收到的 op 流：某一帧没有为某节点发 `prop value`，宿主页面上那个输入框
// 就保持用户刚敲进去的值 —— 这正是「值还在」在 Worker 路线下的可观测形式。
//
// 运行：npm run unit:echo（等价于 node --import ./tests/unit/ts-loader.mjs --test 本文件）
import { check, eq, group } from "./harness.mjs";
import { WidgetRenderSession, createDomFacade } from "../../src/runtime/widget-node.ts";
import { mountPrefs } from "../../plugins/com.pet.goat-gauge/views/settings/prefs.js";
import { mountWatchList } from "../../plugins/com.pet.astock/views/settings/watch-list.js";
import { TOPIC_CMD as ASTOCK_CMD } from "../../plugins/com.pet.astock/topics.js";
import { TOPIC_CMD as GOAT_CMD } from "../../plugins/com.pet.goat-gauge/topics.js";

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
  return { session, dom, published, ops };
}

/** 按 placeholder 找输入框的节点 id（阈值三格各有一个唯一的占位词） */
const byPlaceholder = (ops, ph) =>
  ops.find((o) => o.k === "prop" && o.name === "placeholder" && o.value === ph)?.id;
/** 按 dataset.field 找控件 id（goat-gauge 每个控件都钉了字段名） */
const byField = (ops, field) => ops.find((o) => o.k === "dataset" && o.key === "field" && o.value === field)?.id;
const valueOps = (ops, id) => ops.filter((o) => o.k === "prop" && o.name === "value" && o.id === id);
const checkedOps = (ops, id) => ops.filter((o) => o.k === "prop" && o.name === "checked" && o.id === id);

/* ============================ astock 阈值三格 ============================ */
group("astock 自选表：行情推送不冲掉正在输入的阈值（Bug4）");
{
  const { session, dom, published, ops } = rig();
  const ctx = { dom, bus: { publish: (topic, payload) => published.push([topic, payload]) } };
  const state = { lastPanel: null, autoPicked: false, section: () => dom.createElement("section") };
  const list = mountWatchList(ctx, state);
  const item = (upper) => ({ secid: "1.600519", code: "600519", name: "贵州茅台", upper, lower: null, pct: null, limit: true });
  const view = (price, pct, upper = 12) => ({ watch: [item(upper)], quotes: { "1.600519": { price, pct } } });

  // 首帧：建结构 + 回显
  list.render(view(1300, 1.2));
  const build = ops();
  const upperId = byPlaceholder(build, "涨到");
  const lowerId = byPlaceholder(build, "跌到");
  const saveId = build.find((o) => o.k === "text" && o.value === "存")?.id;
  check(
    "建表帧里找得到阈值三格、「存」按钮与停板勾选框",
    [upperId, lowerId, saveId].every((v) => typeof v === "number") && build.some((o) => o.k === "prop" && o.name === "checked"),
    JSON.stringify({ upperId, lowerId, saveId, checked: build.filter((o) => o.k === "prop" && o.name === "checked") }),
  );
  check("首帧把配置里的 12 写进「涨到」", valueOps(build, upperId).some((o) => o.value === "12"), JSON.stringify(valueOps(build, upperId)));

  // 用户开始输入：宿主回推 input 快照，Worker 把 13.5 写回节点并标记为编辑中
  session.handleEvent(upperId, "input", { value: "13.5" });
  ops();

  // 一次真正的行情 tick：价格变了，配置里的 upper 仍然是 12
  list.render(view(1301, 1.3));
  const tick = ops();
  check(
    "tick 确实推了新数据（否则下面几条是空转）",
    tick.some((o) => o.k === "text" && String(o.value).includes("1301.00")),
    JSON.stringify(tick.filter((o) => o.k === "text")),
  );
  check("正在输入的「涨到」没有被这一帧回显改写", valueOps(tick, upperId).length === 0, JSON.stringify(valueOps(tick, upperId)));
  check("纯 tick 不整表重建（无 replace op）", tick.filter((o) => o.k === "replace").length === 0, JSON.stringify(tick.filter((o) => o.k === "replace")));
  check("一次纯 tick 不新建任何节点", tick.filter((o) => o.k === "create").length === 0, JSON.stringify(tick.filter((o) => o.k === "create")));

  // 编辑优先于外部改动：用户还在这格里，配置改成 99 也进不来
  list.render({ watch: [item(99)], quotes: {} });
  const whileEditing = ops();
  check("编辑中时外部改成 99 也不覆盖用户输入", valueOps(whileEditing, upperId).length === 0, JSON.stringify(valueOps(whileEditing, upperId)));

  // 点「存」= 提交：把用户填的值发出去，同时放开这把锁
  session.handleEvent(saveId, "click", {});
  const payload = published.filter(([topic]) => topic === ASTOCK_CMD).at(-1)?.[1];
  eq("点「存」发出去的是用户填的 13.5", String(payload?.upper), "13.5");
  eq("发的是 update 且带这一行的 secid", JSON.stringify([payload?.action, payload?.secid]), JSON.stringify(["update", "1.600519"]));

  // 解锁后，宿主钳过的回显要能写进去
  list.render({ watch: [item(13.5)], quotes: {} });
  const afterSave = ops();
  check("存过之后回显追上用户所填", valueOps(afterSave, upperId).some((o) => o.value === "13.5"), JSON.stringify(valueOps(afterSave, upperId)));

  // 反向判据：无人编辑时外部改动必须进得来（别把编辑锁写成永不复位）
  list.render({ watch: [item(88)], quotes: {} });
  const external = ops();
  check("无人编辑时外部把阈值改成 88，回显进得来", valueOps(external, upperId).some((o) => o.value === "88"), JSON.stringify(valueOps(external, upperId)));
  check("值没变的格子不会被每帧重写", valueOps(external, lowerId).length === 0, JSON.stringify(valueOps(external, lowerId)));

  // 增删行才动结构：加第二只自选
  list.render({
    watch: [item(12), { secid: "0.000001", code: "000001", name: "平安银行", upper: null }],
    quotes: {},
  });
  const grew = ops();
  check(
    "加一行才新建节点（第二行的三格输入框）",
    grew.filter((o) => o.k === "create" && o.tag === "input").length >= 3,
    JSON.stringify(grew.filter((o) => o.k === "create")),
  );
  eq("加一行时整表重建一次", grew.filter((o) => o.k === "replace").length, 1);

  // 空表：空态行进来，被删行的编辑标记一起丢
  list.render({ watch: [], quotes: {} });
  const emptied = ops();
  eq("清空后重排一次结构", emptied.filter((o) => o.k === "replace").length, 1);
  check(
    "空态那一行的文案写进来了",
    emptied.some((o) => o.k === "text" && String(o.value).includes("还没有自选股")),
    JSON.stringify(emptied.filter((o) => o.k === "text")),
  );
  check("行靠 replace 清场，不逐个 remove", emptied.filter((o) => o.k === "remove").length === 0, JSON.stringify(emptied.filter((o) => o.k === "remove")));

  // 编辑标记不悬空：删行后重建成新行，回显照常写
  list.render({ watch: [item(77)], quotes: {} });
  const rebuilt = ops();
  // 注意判据落在**哪只节点**上：`replaceChildren` 之后旧虚拟节点 id 作废（widget-node.ts 每次 create 都
  // nextId++，replace 只发结构 op；「值搬移只能在 Worker 侧自己记」见 HANDOFF §4.3），所以重加回来的行是
  // 新节点，回显必须写在新节点上。原先这条断言尾参里写的是首帧的 `upperId`（旧节点），拿死 id 读 op 流
  // 永远是空数组 —— 只因它当年被放在第三参（detail）里、断言的是常量真，才一直绿。
  const rebuiltUpperId = byPlaceholder(rebuilt, "涨到") ?? upperId;
  check("删空再建回来时新行照常回显 77", valueOps(rebuilt, rebuiltUpperId).some((o) => o.value === "77"), JSON.stringify(valueOps(rebuilt, rebuiltUpperId)));
}

/* ============================ goat-gauge 下拉与开关 ============================ */
group("goat-gauge 币种/徽标/开关：推送回显不冲掉刚选的项（Bug4）");
{
  const { session, dom, published, ops } = rig();
  const ctx = { dom, bus: { publish: (topic, payload) => published.push([topic, payload]) } };
  const prefs = mountPrefs(ctx, { status: { set: () => {} } });
  const view = (config) => ({ config });

  prefs.render(view({ currency: "USD", badgeMode: "weekly", showOverlay: true, petReact: true, demo: false }));
  const first = ops();
  const currencyId = byField(first, "currency");
  const badgeId = byField(first, "badgeMode");
  const overlayId = byField(first, "showOverlay");
  const refreshId = byField(first, "refreshSec");
  check(
    "找得到币种、徽标、悬浮卡开关与间隔框",
    [currencyId, badgeId, overlayId, refreshId].every((v) => typeof v === "number"),
    JSON.stringify({ currencyId, badgeId, overlayId, refreshId }),
  );
  check("首帧把 USD 回显进币种 select", valueOps(first, currencyId).some((o) => o.value === "USD"), JSON.stringify(valueOps(first, currencyId)));

  // 用户选了 CNY，而随后到达的是「保存还没落地」的旧配置推送
  session.handleEvent(currencyId, "change", { value: "CNY" });
  ops();
  prefs.render(view({ currency: "USD", badgeMode: "weekly" }));
  const stalePush = ops();
  check("旧配置的推送不会把刚选的 CNY 冲回 USD", valueOps(stalePush, currencyId).length === 0, JSON.stringify(valueOps(stalePush, currencyId)));

  // 配置追上用户所选 → 锁复位；之后的外部改动照样进得来
  prefs.render(view({ currency: "CNY", badgeMode: "weekly" }));
  ops();
  prefs.render(view({ currency: "USD", badgeMode: "weekly" }));
  const afterCatch = ops();
  check(
    "追上后锁即复位，外部改回 USD 能进得来",
    valueOps(afterCatch, currencyId).some((o) => o.value === "USD"),
    JSON.stringify(valueOps(afterCatch, currencyId)),
  );

  // 徽标是「选了立即发补丁」
  session.handleEvent(badgeId, "change", { value: "monthly" });
  const badgeSent = published.filter(([topic]) => topic === GOAT_CMD).at(-1)?.[1];
  eq("选徽标立刻发出去的是 monthly", badgeSent?.config?.badgeMode, "monthly");
  prefs.render(view({ currency: "USD", badgeMode: "weekly" }));
  const badgeStale = ops();
  check("回显还没追上时不冲掉刚选的 monthly", valueOps(badgeStale, badgeId).length === 0, JSON.stringify(valueOps(badgeStale, badgeId)));
  prefs.render(view({ currency: "USD", badgeMode: "monthly" }));
  ops();
  prefs.render(view({ currency: "USD", badgeMode: "cost_period" }));
  const badgeCatch = ops();
  check("追上之后外部改的徽标照样回显", valueOps(badgeCatch, badgeId).some((o) => o.value === "cost_period"), JSON.stringify(valueOps(badgeCatch, badgeId)));

  // 复选框同一口径
  session.handleEvent(overlayId, "change", { checked: false });
  prefs.render(view({ currency: "USD", badgeMode: "cost_period", showOverlay: true }));
  const boxStale = ops();
  check("刚关掉悬浮卡时，旧配置的推送不会把它勾回来", checkedOps(boxStale, overlayId).length === 0, JSON.stringify(checkedOps(boxStale, overlayId)));
  prefs.render(view({ currency: "USD", badgeMode: "cost_period", showOverlay: false }));
  ops();
  prefs.render(view({ currency: "USD", badgeMode: "cost_period", showOverlay: true }));
  const boxCatch = ops();
  check("开关追上后外部改动照样进来", checkedOps(boxCatch, overlayId).some((o) => o.value === true), JSON.stringify(checkedOps(boxCatch, overlayId)));

  // 文本框那条老守卫不能被这次改动写坏
  session.handleEvent(refreshId, "input", { value: "120" });
  ops();
  prefs.render(view({ currency: "USD", badgeMode: "cost_period", refreshSec: 60 }));
  const refreshStale = ops();
  check("编辑中的刷新间隔不被回显改写", valueOps(refreshStale, refreshId).length === 0, JSON.stringify(valueOps(refreshStale, refreshId)));
}
