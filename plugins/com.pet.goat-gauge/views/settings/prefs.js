// 设置：只发「改动的字段」补丁，main 负责与当前 config 合并。
// 这样只改币种不会把刷新间隔或其他字段抹回默认。
import { TOPIC_CMD } from "../../topics.js";
import { button, card, hint, input, row, tag, text } from "../dom.js";

const BADGE_MODES = [
  ["five_hour", "5 小时"],
  ["weekly", "本周"],
  ["monthly", "本月"],
  ["cost_period", "本期成本"],
];

function listOf(textValue, fallback) {
  const list = String(textValue ?? "")
    .split(/[,，\s]+/)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
  return list.length ? list : fallback;
}

export function mountPrefs(ctx, state) {
  const dom = ctx.dom;
  const box = tag(dom, "div", "g-prefs");
  const editing = new Set();
  const send = (patch) => ctx.bus.publish(TOPIC_CMD, { action: "saveConfig", config: patch });

  const field = (type, cls = "g-input g-num") => {
    const node = input(dom, type, cls);
    node.on("input", () => editing.add(node));
    node.on("change", () => editing.delete(node));
    return node;
  };

  /* 刷新 */
  const refreshCard = card(dom, "刷新");
  const refreshInput = field("number");
  refreshInput.dataset.field = "refreshSec";
  refreshInput.placeholder = "60";
  const refreshBtn = button(dom, "应用", "g-btn");
  refreshBtn.on("click", () => {
    editing.delete(refreshInput);
    const n = Number(refreshInput.value);
    if (!Number.isFinite(n) || n < 30 || n > 600) {
      state.status.set("刷新间隔要在 30–600 秒之间", "error");
      return;
    }
    send({ refreshSec: Math.round(n) });
  });
  refreshCard.append(row(dom, text(dom, "间隔（秒）"), refreshInput, refreshBtn, hint(dom, "30–600")));

  /* 币种与汇率 */
  const currencyCard = card(dom, "币种与汇率");
  const currencySel = tag(dom, "select");
  currencySel.dataset.field = "currency";
  // 「应用」的 click 快照不带 value（widget-renderer.ts:88-96），宿主也只转发已订阅的事件（:236-249）——
  // 不订阅 change，下面 :75 读到的永远是 render 写回的回显值，选的币种会被 stale 值覆盖回去。
  currencySel.on("change", () => {
    // 无副作用：只需要这条订阅让宿主把选中的 value 写回虚拟节点；发送时机仍由「应用」决定（别在这里 send，
    // 否则会绕过下面 rateInput 的校验）。
  });
  for (const [value, label] of [
    ["USD", "USD ($)"],
    ["CNY", "CNY (¥)"],
  ]) {
    const option = tag(dom, "option");
    option.value = value;
    option.textContent = label;
    currencySel.append(option);
  }
  const rateInput = field("number");
  rateInput.dataset.field = "usdToCny";
  rateInput.placeholder = "7.2";
  const currencyBtn = button(dom, "应用", "g-btn");
  currencyBtn.on("click", () => {
    editing.delete(rateInput);
    const rate = Number(rateInput.value);
    if (!Number.isFinite(rate) || rate < 1 || rate > 20) {
      state.status.set("汇率要在 1–20 之间", "error");
      return;
    }
    send({ currency: currencySel.value, usdToCny: Math.round(rate * 100) / 100 });
  });
  currencyCard.append(
    row(dom, text(dom, "显示币种"), currencySel),
    row(dom, text(dom, "USD→CNY"), rateInput, currencyBtn, hint(dom, "只换算 cost 字段，credits 不换算")),
  );

  /* 告警阈值 */
  const thresholdCard = card(dom, "告警阈值（剩余 %，逗号分隔）");
  const fiveInput = field("text", "g-input");
  const weeklyInput = field("text", "g-input");
  const monthlyInput = field("text", "g-input");
  fiveInput.dataset.field = "fiveHourPct";
  weeklyInput.dataset.field = "weeklyPct";
  monthlyInput.dataset.field = "monthlyPct";
  const thresholdBtn = button(dom, "应用", "g-btn");
  thresholdBtn.on("click", () => {
    for (const node of [fiveInput, weeklyInput, monthlyInput]) editing.delete(node);
    send({
      thresholds: {
        fiveHourPct: listOf(fiveInput.value, [20, 5]),
        weeklyPct: listOf(weeklyInput.value, [20]),
        monthlyPct: listOf(monthlyInput.value, [10]),
      },
    });
  });
  thresholdCard.append(
    row(dom, text(dom, "5 小时"), fiveInput, text(dom, "本周"), weeklyInput, text(dom, "本月"), monthlyInput, thresholdBtn),
  );

  /* 显示方式 */
  const displayCard = card(dom, "显示");
  const showOverlay = input(dom, "checkbox");
  showOverlay.dataset.field = "showOverlay";
  showOverlay.on("change", () => send({ showOverlay: showOverlay.checked }));
  const overlayLabel = tag(dom, "label");
  overlayLabel.append(showOverlay, text(dom, " 桌面悬浮卡"));
  const badgeSel = tag(dom, "select");
  badgeSel.dataset.field = "badgeMode";
  for (const [value, label] of BADGE_MODES) {
    const option = tag(dom, "option");
    option.value = value;
    option.textContent = label;
    badgeSel.append(option);
  }
  badgeSel.on("change", () => send({ badgeMode: badgeSel.value }));
  const petBox = input(dom, "checkbox");
  petBox.dataset.field = "petReact";
  petBox.on("change", () => send({ petReact: petBox.checked }));
  const petLabel = tag(dom, "label");
  petLabel.append(petBox, text(dom, " 告警时宠物反应"));
  displayCard.append(
    row(dom, overlayLabel, text(dom, "徽标"), badgeSel, petLabel),
  );

  /* 悬浮卡位置 */
  const posCard = card(dom, "悬浮卡位置（逻辑像素）");
  const xInput = field("number");
  const yInput = field("number");
  xInput.dataset.field = "overlayX";
  yInput.dataset.field = "overlayY";
  xInput.placeholder = "360";
  yInput.placeholder = "220";
  const posBtn = button(dom, "应用", "g-btn");
  posBtn.on("click", () => {
    editing.delete(xInput);
    editing.delete(yInput);
    const x = Number(xInput.value);
    const y = Number(yInput.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      state.status.set("坐标要填数字", "error");
      return;
    }
    send({ overlayX: Math.round(x), overlayY: Math.round(y) });
  });
  posCard.append(row(dom, text(dom, "X"), xInput, text(dom, "Y"), yInput, posBtn));

  /* 演示 */
  const demoCard = card(dom, "演示数据");
  const demoBox = input(dom, "checkbox");
  demoBox.dataset.field = "demo";
  demoBox.on("change", () => send({ demo: demoBox.checked }));
  const demoLabel = tag(dom, "label");
  demoLabel.append(demoBox, text(dom, " 使用固定种子的演示快照（不出网）"));
  demoCard.append(demoLabel, hint(dom, "演示模式也会走同一套告警/界面链路，供 e2e 使用。"));

  box.append(refreshCard, currencyCard, thresholdCard, displayCard, posCard, demoCard);

  function render(view) {
    const d = view ?? {};
    const c = d.config ?? {};
    if (!editing.has(refreshInput)) refreshInput.value = String(c.refreshSec ?? 60);
    if (!editing.has(rateInput)) rateInput.value = String(c.usdToCny ?? 7.2);
    const thresholds = c.thresholds ?? {};
    if (!editing.has(fiveInput)) fiveInput.value = (thresholds.fiveHourPct ?? [20, 5]).join(",");
    if (!editing.has(weeklyInput)) weeklyInput.value = (thresholds.weeklyPct ?? [20]).join(",");
    if (!editing.has(monthlyInput)) monthlyInput.value = (thresholds.monthlyPct ?? [10]).join(",");
    if (!editing.has(xInput)) xInput.value = String(c.overlayX ?? 360);
    if (!editing.has(yInput)) yInput.value = String(c.overlayY ?? 220);
    currencySel.value = c.currency === "CNY" ? "CNY" : "USD";
    badgeSel.value = c.badgeMode ?? "five_hour";
    showOverlay.checked = c.showOverlay !== false;
    petBox.checked = c.petReact !== false;
    demoBox.checked = c.demo === true;
  }

  return { box, render };
}
