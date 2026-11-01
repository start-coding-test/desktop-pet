// 验收报告（desktop-pet-验收-a18ec21-2026-10-29）G5 的 GOAT 部分：
//   G5-02 / N1  汇率格「失焦即放锁」→ 点「应用」时锁已经放了，旧帧把非法汇率冲回去
//   G5-05 / N6  refreshSnapshot 的重入窗口（busy 要等 /internal 跑完才置位）
//   G5-06 / N7  /internal 改了明细；:widget 载荷瘦身后明细只走 :panel
//   G5-09      离线 / 未配置不许把界面画成「全零成功」
// 全部离线：不碰网络、不用真实凭据（假 cookie 串只用来走守卫分支）。
import { group, check, eq, deep } from "./harness.mjs";
import { WidgetRenderSession, createDomFacade } from "../../src/runtime/widget-node.ts";
import { TOPIC_WIDGET } from "../../plugins/com.pet.goat-gauge/topics.js";
import { internalFetchGate, snapshotGate } from "../../plugins/com.pet.goat-gauge/guards.js";
import { buildPanelPayload } from "../../plugins/com.pet.goat-gauge/panel.js";
import { splitView } from "../../plugins/com.pet.goat-gauge/view-split.js";
import { fmtPct } from "../../plugins/com.pet.goat-gauge/format.js";
import { mountPrefs } from "../../plugins/com.pet.goat-gauge/views/settings/prefs.js";
import { mountBadge } from "../../plugins/com.pet.goat-gauge/views/badge.js";

/* ---------- 最小 rig：真 session + 真 DOM facade + 收集发布/订阅 ---------- */
function rig() {
  const sent = [];
  const session = new WidgetRenderSession((msg) => sent.push(msg));
  const dom = createDomFacade(session);
  const published = [];
  const subscriptions = new Map();
  const bus = {
    publish: (topic, payload) => published.push([topic, payload]),
    subscribe: (topic, fn) => {
      if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
      subscriptions.get(topic).add(fn);
      return () => subscriptions.get(topic)?.delete(fn);
    },
  };
  const emit = (topic, payload) => {
    for (const fn of subscriptions.get(topic) ?? []) fn(payload);
  };
  const ops = () => {
    session.flush();
    const out = sent.flatMap((m) => m.ops ?? []);
    sent.length = 0;
    return out;
  };
  return { session, dom, bus, emit, published, ops };
}

const propsOf = (ops, id, name) => ops.filter((o) => o.k === "prop" && o.id === id && o.name === name);
const valuesOf = (ops, id) => propsOf(ops, id, "value").map((o) => o.value);
const texts = (ops) => ops.filter((o) => o.k === "text").map((o) => String(o.value));

/* ================================ 守卫（G5-05 / N6） ================================ */
group("goat 摘要刷新的重入守卫（G5-05 / N6）：busy 之前不许有第二路");
{
  eq("一切正常：放行", snapshotGate({ reentrant: false, busy: false, alive: true }), null);
  eq("默认参数即放行（不是靠 undefined 蒙混）", snapshotGate(), null);
  eq("已有一路在跑：挡下", snapshotGate({ reentrant: true, busy: false, alive: true }), "busy");
  eq("手动刷新在飞：挡下", snapshotGate({ reentrant: false, busy: true, alive: true }), "busy");
  eq("插件已停用：挡下且理由不同", snapshotGate({ reentrant: false, busy: false, alive: false }), "stopped");
  eq("停用优先于 busy（不会把停用写成正在刷新）", snapshotGate({ reentrant: true, busy: true, alive: false }), "stopped");
  check(
    "只有布尔 true 才算挡（数字/字符串不冒充「在跑」）",
    snapshotGate({ reentrant: 1, busy: "yes", alive: true }) === null,
    String(snapshotGate({ reentrant: 1, busy: "yes", alive: true })),
  );
}

group("goat /internal 拉取守卫（G5-05）：离线/演示不出网");
{
  const ctx = { secrets: {} };
  eq("没有上下文：挡", internalFetchGate({ ctx: null, cookie: "c" }), "no-ctx");
  eq("没有 secrets 能力：挡", internalFetchGate({ ctx: {}, cookie: "c" }), "no-secret");
  eq("没有 Cookie：挡", internalFetchGate({ ctx, cookie: "" }), "no-cookie");
  eq("演示模式即便有 Cookie 也不许出网", internalFetchGate({ ctx, cookie: "c", demo: true }), "demo");
  eq("摘要刷新在飞：挡", internalFetchGate({ ctx, cookie: "c", busy: true }), "busy");
  eq("/internal 自己还没跑完：挡", internalFetchGate({ ctx, cookie: "c", internalBusy: true }), "busy");
  eq("离线但拿不到 Cookie 时也不许假装有数据", internalFetchGate({ ctx, cookie: undefined }), "no-cookie");
  eq("条件齐了才放行", internalFetchGate({ ctx, cookie: "c", demo: false, busy: false, internalBusy: false }), null);
}

/* ============================ 载荷口径（G5-06 / N7 / G5-09） ============================ */
group("goat 视图载荷：明细不随 :widget 广播，离线不被画成成功");
{
  const panel = buildPanelPayload({
    history: [[1, 2]],
    fetchedAt: 123,
    daily: [{ day: "2026-10-28", by_model: { a: 1 } }],
    records: [{ id: "r1" }],
    charts: { "2026-10-28": [{ h: 1 }] },
    cookieState: "ready",
  });
  check(":panel 带明细", panel.records.length === 1, JSON.stringify(panel.records));
  eq(":panel 的 cookieState 原样", panel.cookieState, "ready");

  const widget = splitView(panel);
  check(":widget 不带明细（300 条不再广播）", !("records" in widget), JSON.stringify(Object.keys(widget)));
  check(":widget 其余字段原样保留", widget.daily.length === 1 && widget.charts["2026-10-28"].length === 1, JSON.stringify(Object.keys(widget)));
  check("splitView 不改原对象", panel.records.length === 1, JSON.stringify(panel.records));

  eq("非法 cookieState 归一成 none（不能凭一个脏值就说在线）", buildPanelPayload({ cookieState: "whatever" }).cookieState, "none");
  eq("缺百分比画破折号，不画 0%", fmtPct(undefined), "—");
  eq("缺百分比（null）同样", fmtPct(null), "—");
  eq("真的 0 才画 0%", fmtPct(0), "0%");
}

/* ================================ badge 离线态（G5-09） ================================ */
group("goat badge：未配置 / 离线不挂 0% 的假成功（G5-09）");
{
  const { session, dom, bus, emit, ops } = rig();
  const cleanups = [];
  mountBadge(session.root, { dom, bus }, cleanups);
  ops();

  // 还没连上、也没有账号：整块不挂（ADR-0010 决策 1）
  emit(TOPIC_WIDGET, { state: "onboarding" });
  let mounted = ops();
  check("未配置时不往根上挂 badge", mounted.filter((o) => o.k === "append").length === 0, JSON.stringify(mounted.filter((o) => o.k === "append")));
  check("也不会画 0%", !texts(mounted).some((t) => t.includes("%")), JSON.stringify(texts(mounted)));

  // 演示/离线但字段缺失：画破折号而不是 0%
  emit(TOPIC_WIDGET, { state: "ready", account: { maskedKey: "sk-…" }, windows: { five_hour: {} }, config: {} });
  mounted = ops();
  check("缺 remaining_pct 时画破折号", texts(mounted).includes("5h —"), JSON.stringify(texts(mounted)));
  check("不把缺失画成 0%", !texts(mounted).some((t) => t.includes("0%")), JSON.stringify(texts(mounted)));

  // 鉴权失败：明确画「Key 失效」，不装成有数据
  emit(TOPIC_WIDGET, { state: "auth_error", account: null });
  mounted = ops();
  check("鉴权失败画「Key 失效」", texts(mounted).includes("Key 失效"), JSON.stringify(texts(mounted)));
  check("鉴权失败整块是 bad 态", mounted.some((o) => o.k === "attr" && o.name === "class" && String(o.value).includes("bad")), JSON.stringify(mounted.filter((o) => o.k === "attr")));

  for (const fn of cleanups) fn();
}

/* ======================= 设置面板：汇率锁与「追上即放」（G5-02 / N1） ======================= */
group("goat 设置面板：汇率失焦不放锁，旧帧冲不掉草稿（G5-02 / N1）");
{
  const { session, dom, bus, published, ops } = rig();
  const statuses = [];
  const state = { status: { set: (text, level) => statuses.push([text, level]) } };
  const prefs = mountPrefs({ dom, bus }, state);
  prefs.render({ config: { usdToCny: 7.2, currency: "USD" } });
  const build = ops();
  // dataset op 的形状是 {k:"dataset", id, key:"field", value:字段名}，按 value 反查
  const rateId = build.find((o) => o.k === "dataset" && o.value === "usdToCny")?.id;
  check("汇率格建出来了", typeof rateId === "number", JSON.stringify(build.filter((o) => o.k === "dataset")));
  check("首帧回显配置里的汇率", valuesOf(build, rateId).includes("7.2"), JSON.stringify(valuesOf(build, rateId)));

  // 真点击顺序：input → blur(change) → click「应用」
  session.handleEvent(rateId, "input", { value: "8.5" });
  session.handleEvent(rateId, "change", { value: "8.5" });
  ops();
  prefs.render({ config: { usdToCny: 7.2, currency: "USD" } });
  const stale = ops();
  check("失焦后旧帧不许把 8.5 冲回 7.2（change 不放锁）", !valuesOf(stale, rateId).includes("7.2"), JSON.stringify(valuesOf(stale, rateId)));

  // 非法汇率：拒绝、不发、锁还在（用户能接着改）
  session.handleEvent(rateId, "input", { value: "25" });
  const applyBtn = build.filter((o) => o.k === "create" && o.tag === "button").map((o) => o.id);
  const applyTexts = build.filter((o) => o.k === "text" && applyBtn.includes(o.id) && o.value === "应用").map((o) => o.id);
  eq("面板有四个「应用」按钮（刷新/汇率/阈值/坐标）", applyBtn.length, 4);
  eq("「应用」按钮都带文案", applyTexts.length, 4);
  published.length = 0;
  session.handleEvent(applyTexts[1], "click", {});
  ops();
  eq("非法汇率不发补丁", published.length, 0);
  deep("非法汇率给错误提示", statuses.at(-1), ["汇率要在 1–20 之间", "error"]);
  prefs.render({ config: { usdToCny: 7.2, currency: "USD" } });
  const afterInvalid = ops();
  check("非法汇率被拒后旧帧也冲不掉它", !valuesOf(afterInvalid, rateId).includes("7.2"), JSON.stringify(valuesOf(afterInvalid, rateId)));

  // 合法：发 patch（含当前币种），并在推送追上之前不回显旧值
  session.handleEvent(rateId, "input", { value: "8.5" });
  published.length = 0;
  session.handleEvent(applyTexts[1], "click", {});
  ops();
  deep("合法汇率发出的是 saveConfig 补丁", published.map(([, p]) => p), [
    { action: "saveConfig", config: { currency: "USD", usdToCny: 8.5 } },
  ]);
  prefs.render({ config: { usdToCny: 7.2, currency: "USD" } });
  const pending = ops();
  check("推送还没追上：合法值不许先闪回一帧旧值", !valuesOf(pending, rateId).includes("7.2"), JSON.stringify(valuesOf(pending, rateId)));
  prefs.render({ config: { usdToCny: 8.5, currency: "USD" } });
  ops();
  prefs.render({ config: { usdToCny: 9.1, currency: "USD" } });
  const external = ops();
  check("追上之后外部改的汇率能进来", valuesOf(external, rateId).includes("9.1"), JSON.stringify(valuesOf(external, rateId)));
}

/* ========================= 设置面板：币种/开关的「追上即放」（Bug4） ========================= */
group("goat 设置面板：币种与开关推送不许把用户刚选的冲掉（Bug4）");
{
  const { session, dom, bus, published, ops } = rig();
  const state = { status: { set: () => {} } };
  const prefs = mountPrefs({ dom, bus }, state);
  prefs.render({ config: { currency: "USD", badgeMode: "five_hour", showOverlay: true, petReact: true, demo: false } });
  const build = ops();
  const byDataset = {};
  for (const op of build) if (op.k === "dataset") byDataset[op.value] = op.id;
  check(
    "币种/徽标/三个开关都建出来了",
    ["currency", "badgeMode", "showOverlay", "petReact", "demo"].every((key) => typeof byDataset[key] === "number"),
    JSON.stringify(byDataset),
  );
  const currencyId = byDataset.currency;
  const badgeId = byDataset.badgeMode;

  // 币种：选了 CNY，旧推送（USD）不许写回；推送追上才放行
  session.handleEvent(currencyId, "change", { value: "CNY" });
  published.length = 0;
  ops();
  prefs.render({ config: { currency: "USD" } });
  const staleCurrency = ops();
  check("旧推送不许把币种冲回 USD", !valuesOf(staleCurrency, currencyId).includes("USD"), JSON.stringify(valuesOf(staleCurrency, currencyId)));
  prefs.render({ config: { currency: "CNY" } });
  ops();
  prefs.render({ config: { currency: "USD" } });
  const externalCurrency = ops();
  check("追上之后外部改的币种能进来", valuesOf(externalCurrency, currencyId).includes("USD"), JSON.stringify(valuesOf(externalCurrency, currencyId)));

  // 徽标：选了「本周」，旧推送（5 小时）不许写回
  session.handleEvent(badgeId, "change", { value: "weekly" });
  published.length = 0;
  ops();
  prefs.render({ config: { currency: "USD", badgeMode: "five_hour" } });
  const staleBadge = ops();
  check("旧推送不许把徽标冲回 5 小时", !valuesOf(staleBadge, badgeId).includes("five_hour"), JSON.stringify(valuesOf(staleBadge, badgeId)));

  // 开关：勾掉「桌面悬浮卡」，旧推送（true）不许写回
  const overlayId = byDataset.showOverlay;
  session.handleEvent(overlayId, "change", { checked: false });
  ops();
  prefs.render({ config: { showOverlay: true } });
  const staleCheck = ops();
  check("旧推送不许把「桌面悬浮卡」勾回来", propsOf(staleCheck, overlayId, "checked").every((o) => o.value !== true), JSON.stringify(propsOf(staleCheck, overlayId, "checked")));
}
