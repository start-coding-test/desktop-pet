// 分节：选中个股的盘面（分时 / K线 / 五档）—— 面板头、分时/K线切换、周期下拉、画布。
// 五档表本体在 depth.js（它自己挂 state.depth.render），本模块只把它放进右列并在回灌时调它。
// 跨节共享只走 state：lastPanel（选中标的，自选列表拿它做行高亮）、lastView（涨跌停那一路的回落）、depth。

import { drawKline, drawTrend } from "../../charts.js";
import { KLINE_PERIODS, sourceLabelOf } from "../../market.js";
import { TOPIC_CMD } from "../../topics.js";
import { button, fmtPct, fmtPrice, tag, text, toneOf } from "../dom.js";
import { syncSelect } from "./lock.js";
import { kltDisplay, kltOptionValue, pickLimit, rawPctOf } from "./util.js";

/**
 * 挂「盘面」分节。
 * @param {{bus: {publish: Function}, dom: object, onCanvas: Function}} ctx
 * @param {any} state 装配壳建的共享状态（用到 lastView / lastPanel / depth / section，见 work/M4b/closures.md）
 * @param {Array<Function>} cleanups 本挂载实例的清理表（onCanvas 的退订进这里）
 * @returns {{section: HTMLElement, renderPanel: Function, drawChart: Function}}
 */
export function mountBoard(ctx, state, cleanups) {
  const dom = ctx.dom;
  const panelName = text(dom, "点下面一行自选股看盘口与曲线", "nm");
  const panelSub = text(dom, "", "muted");
  const panelErr = text(dom, "", "muted");
  const chartTabs = tag(dom, "div", "tabs");
  const kltSel = tag(dom, "select", "klt");
  const panelRefresh = button(dom, "刷新");
  const canvas = tag(dom, "canvas", "cv");
  const chartBox = tag(dom, "div", "chart");
  chartBox.append(canvas);
  let chartKind = "trend";
  /** 用户刚改过、推送里的 klt 还没追上的时候先别回显（G5-04：以前每帧无条件写，选了又被写回） */
  const locks = new Set();
  /** 宿主交接来的可画对象（Worker 路线是 OffscreenCanvas）；没有它之前什么都画不了 */
  let canvasOff = null;
  /** 最近一次 layout 推送（尺寸 / dpr / 各画布量得的宽高） */
  let lastLayout = null;

  for (const p of KLINE_PERIODS) {
    const opt = tag(dom, "option");
    opt.value = kltOptionValue(p);
    opt.textContent = p.label;
    kltSel.append(opt);
  }
  kltSel.on("change", () => {
    locks.add(kltSel);
    ctx.bus.publish(TOPIC_CMD, { action: "klt", value: Number(kltSel.value) });
  });
  panelRefresh.on("click", () => ctx.bus.publish(TOPIC_CMD, { action: "panel" }));

  const tabButtons = [];
  for (const [kind, label] of [
    ["trend", "分时"],
    ["kline", "K线"],
  ]) {
    const b = button(dom, label, "tab");
    b.on("click", () => {
      chartKind = kind;
      syncTabs();
      drawChart();
    });
    chartTabs.append(b);
    tabButtons.push([kind, b]);
  }
  function syncTabs() {
    for (const [kind, b] of tabButtons) b.classList.toggle("on", kind === chartKind);
    kltSel.style.display = kltDisplay(chartKind);
  }
  syncTabs();

  // 画布控制权交接（宿主按 create op 就交，可能早于第一次 layout）：位图尺寸写在交接来的
  // 这块画布上、绘图也只在这里做；拿到手时若已有 layout，立刻补画一次
  cleanups.push(
    ctx.onCanvas((id, off) => {
      if (id !== canvas.nodeId) return;
      canvasOff = off;
      drawChart();
    }),
  );

  function drawChart(layout) {
    if (layout) lastLayout = layout;
    if (!canvasOff || !lastLayout) return; // 还没交接 / 还没量过：等另一条回调再画
    const p = state.lastPanel;
    // CSS 尺寸由宿主量好下发（旧代码的 canvas.clientWidth / clientHeight）；
    // 查不到这个 id 或还没排版（0）时才退回兜底常量 —— 与旧写法同口径
    const m = lastLayout.measured?.[String(canvas.nodeId)];
    const cssWidth = m?.w || 300;
    const cssHeight = m?.h || 132;
    const dpr = lastLayout.dpr || 1;
    if (chartKind === "kline") {
      drawKline(canvasOff, p?.kline?.bars, { width: cssWidth, height: cssHeight, dpr });
    } else {
      drawTrend(canvasOff, p?.trend, { width: cssWidth, height: cssHeight, dpr });
    }
  }

  function renderPanel(p) {
    state.lastPanel = p ?? null;
    const live = p && !p.cleared && p.secid ? p : null;
    const d = live?.depth;
    if (!live) {
      panelName.textContent = "点下面一行自选股看盘口与曲线";
      panelSub.textContent = "";
      panelErr.textContent = "";
      canvas.style.visibility = "hidden";
      state.depth.table.replaceChildren();
      return;
    }
    canvas.style.visibility = "";
    panelName.textContent = `${d?.name ?? live.secid}（${d?.code ?? live.secid.slice(2)}）`;
    const pct = rawPctOf(d?.price, d?.prevClose);
    // 涨停/跌停优先用五档那一路（腾讯段 47/48、东财 f51/f52 都是交易所给的价），
    // 它没给就退回快照那一路；两路都没有就明写「该源不供」—— 不拿按代码前缀猜的幅度冒充交易所的价
    const q = state.lastView?.quotes?.[live.secid] ?? null;
    const limitUp = pickLimit(d?.limitUp, q?.limitUp);
    const limitDown = pickLimit(d?.limitDown, q?.limitDown);
    const limitText =
      limitUp === null && limitDown === null
        ? `涨停/跌停 该源不供（${sourceLabelOf(live.depthSource || state.lastView?.net?.sources?.quote || "") || "未知来源"}）`
        : `涨停 ${fmtPrice(limitUp)} / 跌停 ${fmtPrice(limitDown)}`;
    panelSub.textContent =
      `现价 ${fmtPrice(d?.price)} ${fmtPct(pct)} · 昨收 ${fmtPrice(d?.prevClose)} · ` +
      `${limitText} · 分时 ${live.trend?.points?.length ?? 0} 点 · K线 ${live.kline?.bars?.length ?? 0} 根`;
    panelSub.className = `muted ${toneOf({ pct })}`;
    panelErr.textContent = live.error ? `盘面数据拉取失败：${live.error}` : "";
    if (Number.isFinite(Number(live.klt))) syncSelect(kltSel, String(live.klt), locks);
    drawChart();
    state.depth.render(live);
  }

  const hd = tag(dom, "div", "panel-hd");
  hd.append(panelName, panelSub);
  const tools = tag(dom, "div", "row");
  tools.append(chartTabs, kltSel, panelRefresh);
  const left = tag(dom, "div", "chart-col");
  left.append(tools, chartBox, panelErr);
  const right = tag(dom, "div", "depth-col");
  right.append(state.depth.table);
  const grid = tag(dom, "div", "panel-grid");
  grid.append(left, right);

  return { section: state.section("盘面（分时 / K线 / 五档）", hd, grid), renderPanel, drawChart };
}
