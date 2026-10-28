// 分节：显示方式 / 刷新与提醒 / 最近提醒（原文件第 3 个横幅，三块都在这一个分节里）。
//   render(d)       —— 状态行 + 出网窗口行 + 各控件回显（statusLine 与 lastStatusAt 走 state.status）
//   renderAlerts(d) —— 最近提醒列表
// 装配关系不在这里：三个 section 节点由 views/settings.js 按原次序 append。

import { MARKET_HOSTS, MARKET_SOURCES, sourceLabelOf } from "../../market.js";
import { TOPIC_CMD } from "../../topics.js";
import { button, clockOf, input, PHASE_TEXT, tag, text } from "../dom.js";
import { cardXOf, cardYOf, intervalOf, modeOf, netText, prefChecked, statusText } from "./util.js";

const INDEXES = [
  { secid: "1.000001", name: "上证指数" },
  { secid: "0.399001", name: "深证成指" },
  { secid: "0.399006", name: "创业板指" },
  { secid: "1.000688", name: "科创50" },
  { secid: "1.000300", name: "沪深300" },
];

const MODE_TEXT = { badge: "宠物旁小字", overlay: "桌面盯盘卡（位置自定）", off: "不显示" };

/**
 * 挂「显示方式 / 刷新与提醒 / 最近提醒」三个分节。
 * @param {{bus: {publish: Function}, dom: object}} ctx
 * @param {any} state 装配壳建的共享状态（用到 status / section，见 work/M4b/closures.md）
 * @returns {{sections: HTMLElement[], render: Function, renderAlerts: Function}}
 *   `sections` 按原 append 次序给出：显示方式 → 刷新与提醒 → 最近提醒。
 */
export function mountPrefs(ctx, state) {
  const dom = ctx.dom;
  /* ---------- 显示方式 ---------- */
  const modeInputs = {};
  const radios = tag(dom, "div", "radios");
  for (const value of ["badge", "overlay", "off"]) {
    const box = input(dom, "radio");
    box.setAttribute("name", "astock-mode"); // radio 分组靠 name attribute；契约里它走 attr 而不是 property
    box.value = value;
    box.on("change", () => {
      if (box.checked) ctx.bus.publish(TOPIC_CMD, { action: "config", value: { mode: value } });
    });
    const label = tag(dom, "label");
    label.append(box, text(dom, MODE_TEXT[value])); // 契约里没有文本节点，行内文字一律包一层 span
    radios.append(label);
    modeInputs[value] = box;
  }

  // 盯盘卡位置：位置由插件自己给、自己存（ADR-0010 决策 3/4），这两个字段就是它的设置入口。
  // 契约：type 走 property（attr 表里没有 type，见 widget-protocol 的 WIDGET_PROPS/WIDGET_ATTRS，
  // input() 助手就是这么写的），name 走 attribute（与上面 radio 同一条）；change 回来的 value 是
  // 净化后的字符串 —— 这里 Number 一道只做提示，落库的收口在 main.js 的 config 处理里
  const posField = (key, placeholder) => {
    const el = input(dom, "text", "num");
    el.setAttribute("name", `astock-${key}`);
    el.placeholder = placeholder;
    let editing = false; // Worker 里没有 document.activeElement，同间隔输入项：正在输入就别回显覆盖
    el.on("input", () => {
      editing = true;
    });
    el.on("change", () => {
      editing = false;
      const n = el.value.trim() === "" ? Number.NaN : Number(el.value);
      if (!Number.isFinite(n)) {
        state.status.set("卡片坐标要填数字", "error");
        return;
      }
      ctx.bus.publish(TOPIC_CMD, { action: "config", value: { [key]: Math.round(n) } });
    });
    return { el, editing: () => editing };
  };
  const cardXField = posField("cardX", "420");
  const cardYField = posField("cardY", "180");
  const cardRow = tag(dom, "div", "row");
  cardRow.append(text(dom, "卡片 X "), cardXField.el, text(dom, "卡片 Y "), cardYField.el);

  /* ---------- 刷新与提醒 ---------- */
  const intervalInput = input(dom, "text", "num");
  intervalInput.placeholder = "20";
  // Worker 里没有 document.activeElement：用插件自己的标记复现「用户正在输入就别覆盖」
  // （input 置位、change 在失焦/回车时复位）
  let editing = false;
  intervalInput.on("input", () => {
    editing = true;
  });
  intervalInput.on("change", () => {
    editing = false;
  });
  const intervalBtn = button(dom, "应用");
  intervalBtn.on("click", () => {
    const n = Number(intervalInput.value);
    if (!Number.isFinite(n) || n < 10) return state.status.set("间隔至少 10 秒", "error");
    ctx.bus.publish(TOPIC_CMD, { action: "config", value: { intervalSec: Math.round(n) } });
  });
  const refreshBtn = button(dom, "立刻刷新");
  refreshBtn.on("click", () => ctx.bus.publish(TOPIC_CMD, { action: "refresh" }));
  const testBtn = button(dom, "试一条提醒");
  testBtn.on("click", () => ctx.bus.publish(TOPIC_CMD, { action: "testAlert" }));

  const alertsBox = input(dom, "checkbox");
  alertsBox.on("change", () => ctx.bus.publish(TOPIC_CMD, { action: "config", value: { alertsOn: alertsBox.checked } }));
  const petBox = input(dom, "checkbox");
  petBox.on("change", () => ctx.bus.publish(TOPIC_CMD, { action: "config", value: { petOn: petBox.checked } }));
  const showIndexBox = input(dom, "checkbox");
  showIndexBox.on("change", () => ctx.bus.publish(TOPIC_CMD, { action: "config", value: { showIndex: showIndexBox.checked } }));
  // 后备数据源开关（G5-08）：关掉后只打东财主源与各自主入口，别家域名一次都不碰
  const fallbackBox = input(dom, "checkbox");
  fallbackBox.on("change", () => ctx.bus.publish(TOPIC_CMD, { action: "config", value: { allowFallback: fallbackBox.checked } }));
  const indexSel = tag(dom, "select");
  for (const idx of INDEXES) {
    const opt = tag(dom, "option");
    opt.value = idx.secid;
    opt.textContent = idx.name;
    indexSel.append(opt);
  }
  indexSel.on("change", () => ctx.bus.publish(TOPIC_CMD, { action: "config", value: { indexSecid: indexSel.value } }));

  const alertList = tag(dom, "div", "alerts");
  const netLine = tag(dom, "div", "muted");

  const row = tag(dom, "div", "row");
  row.append(text(dom, "盘中间隔 "), intervalInput, text(dom, "秒 "), intervalBtn, refreshBtn, testBtn);
  const checks = tag(dom, "div", "checks");
  const l1 = tag(dom, "label");
  l1.append(alertsBox, text(dom, "系统通知"));
  const l2 = tag(dom, "label");
  l2.append(petBox, text(dom, "宠物反应"));
  const l3 = tag(dom, "label");
  l3.append(showIndexBox, text(dom, "带指数"));
  const l4 = tag(dom, "label");
  l4.append(fallbackBox, text(dom, "允许后备数据源"));
  checks.append(l1, l2, l3, l4, indexSel);

  // 出网说明与实现对齐（G5-08）：主机名单直接取注册表的并集，别再手写一份会漂的名字
  const hostsLine = tag(dom, "div", "muted");
  hostsLine.textContent = `数据源：${MARKET_SOURCES.map((s) => s.label).join("、")}（后两家为后备）。可能访问 ${MARKET_HOSTS.length} 个域名：${MARKET_HOSTS.join("、")}。关掉「允许后备数据源」后只访问东方财富的主机。`;

  /* ---------- 回灌 ---------- */
  const render = (d) => {
    const cfg = d.config ?? {};
    const list = d.watch ?? [];
    const net = d.net ?? {};

    if (Date.now() - state.status.at > 6000) {
      const line = statusText({
        phaseLabel: PHASE_TEXT[d.session?.phase] ?? "",
        count: list.length,
        net,
        cfgIntervalSec: cfg.intervalSec,
        error: d.error,
      });
      state.status.line.textContent = line.text;
      state.status.line.className = `status${line.error ? " error" : ""}`;
      // 吃的是哪家的数据要看得见（换源是自动的，别让用户以为行情变了口径）。
      // 行情（自选列表快照）与五档各报一句，跟 K线/分时同一个格式
      netLine.textContent = netText(net, sourceLabelOf);
    }

    for (const [value, box] of Object.entries(modeInputs)) box.checked = modeOf(cfg) === value;
    if (!editing) intervalInput.value = String(intervalOf(cfg));
    if (!cardXField.editing()) cardXField.el.value = String(cardXOf(cfg));
    if (!cardYField.editing()) cardYField.el.value = String(cardYOf(cfg));
    alertsBox.checked = prefChecked(cfg.alertsOn);
    petBox.checked = prefChecked(cfg.petOn);
    showIndexBox.checked = prefChecked(cfg.showIndex);
    fallbackBox.checked = cfg.allowFallback !== false;
    if (cfg.indexSecid) indexSel.value = cfg.indexSecid;
  };

  const renderAlerts = (d) => {
    alertList.replaceChildren();
    const hits = (d.recent ?? []).filter((a) => a?.message);
    if (!hits.length) {
      const empty = tag(dom, "span", "muted");
      empty.textContent = "今天还没有触发过提醒。";
      alertList.append(empty);
    } else {
      for (const a of hits) {
        const rowNode = tag(dom, "div");
        rowNode.textContent = `${clockOf(a.at)} · ${a.message}`;
        alertList.append(rowNode);
      }
    }
  };

  return {
    // 次序与原 wrap.append 一致：显示方式 → 刷新与提醒 → 最近提醒
    sections: [
      state.section("显示方式", radios, cardRow),
      state.section("刷新与提醒", row, checks, netLine, hostsLine),
      state.section("最近提醒", alertList),
    ],
    render,
    renderAlerts,
  };
}
