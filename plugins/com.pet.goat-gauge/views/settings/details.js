// C07 明细看板：今天/7/30/全部、模型成本环、缓存命中率、20/页分页。
// 只读 :panel 的 daily/records（C06 契约）；不写 records/daily，不调用 matchMedia。
import { fmtCredits, fmtDateTime, fmtPct, fmtTokens } from "../../format.js";
import { localDayKey } from "../../history.js";
import { button, card, hint, tag, text } from "../dom.js";

export const DETAIL_RANGES = [
  { key: "today", label: "今天", days: 1 },
  { key: "7", label: "7 天", days: 7 },
  { key: "30", label: "30 天", days: 30 },
  { key: "all", label: "全部", days: 0 },
];
export const PAGE_SIZE = 20;

function dayParts(dayKey) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  return { year, month, day };
}

function addDays(dayKey, delta) {
  const { year, month, day } = dayParts(dayKey);
  const date = new Date(Date.UTC(year, month - 1, day + delta));
  return date.toISOString().slice(0, 10);
}

function zoneOffsetMs(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"), pick("second"));
  return asUtc - ms;
}

function zonedDayStart(dayKey, timeZone) {
  const { year, month, day } = dayParts(dayKey);
  if (!timeZone) return new Date(year, month - 1, day).getTime();
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  for (let i = 0; i < 2; i += 1) guess = target - zoneOffsetMs(guess, timeZone);
  return guess;
}

/** 本地日历日范围；today = [今日 00:00, 明日 00:00)；7/30 含今天的最近 N 个日历日。 */
export function timeRange(rangeKey, now = Date.now(), timeZone = undefined) {
  const today = localDayKey(now, timeZone);
  if (!today) return { key: rangeKey, start_ms: 0, end_ms: Infinity, label: "全部" };
  const def = DETAIL_RANGES.find((item) => item.key === rangeKey) ?? DETAIL_RANGES[0];
  if (def.key === "all") {
    return { key: "all", start_ms: 0, end_ms: Infinity, label: "全部（最近 90 天 / 300 条）" };
  }
  const startDay = addDays(today, -(def.days - 1));
  const endDay = addDays(today, 1);
  return {
    key: def.key,
    start_ms: zonedDayStart(startDay, timeZone),
    end_ms: zonedDayStart(endDay, timeZone),
    label: def.label,
  };
}

export function inRange(atMs, range) {
  return Number.isFinite(atMs) && atMs >= range.start_ms && atMs < range.end_ms;
}

/** 模型成本环：by_model.cost_total 求和；环总额与 daily.cost_total 只做容差比较。 */
export function modelCostRing(daily = []) {
  const byModel = new Map();
  let dailyTotal = 0;
  for (const day of Array.isArray(daily) ? daily : []) {
    dailyTotal += Number(day?.cost_total) || 0;
    for (const [model, value] of Object.entries(day?.by_model ?? {})) {
      const cost = Number(value?.cost_total) || 0;
      byModel.set(model, (byModel.get(model) ?? 0) + cost);
    }
  }
  const total = [...byModel.values()].reduce((sum, cost) => sum + cost, 0);
  const models = [...byModel.entries()]
    .map(([model, cost]) => ({ model, cost, pct: total > 0 ? (cost / total) * 100 : 0 }))
    .sort((a, b) => b.cost - a.cost);
  return { models, total, daily_total: dailyTotal, consistent: Math.abs(total - dailyTotal) <= 1e-9 };
}

/** cache_read/(cache_read+input)；若上游 input 已含缓存，分母只用 input。分母 0 → null。 */
export function cacheHitRate({ cacheReadTokens = 0, tokensIn = 0, inputIncludesCache = false } = {}) {
  const read = Number(cacheReadTokens) || 0;
  const input = Number(tokensIn) || 0;
  const denominator = inputIncludesCache ? input : read + input;
  return denominator > 0 ? read / denominator : null;
}

/** 先过滤再分页；页码夹在 1..pageCount，最后一页不补空行。 */
export function paginate(items = [], page = 1, pageSize = PAGE_SIZE) {
  const list = Array.isArray(items) ? items : [];
  const count = Math.max(1, Math.ceil(list.length / pageSize));
  const current = Math.min(count, Math.max(1, Math.trunc(page) || 1));
  return {
    page: current,
    page_count: count,
    items: list.slice((current - 1) * pageSize, current * pageSize),
  };
}

/**
 * @param {Record<string, any>} [panel]
 * @param {{ rangeKey?: string, page?: number, now?: number, timeZone?: string }} [options]
 */
export function detailsModel(panel = {}, { rangeKey = "today", page = 1, now = Date.now(), timeZone } = {}) {
  const range = timeRange(rangeKey, now, timeZone);
  const records = (Array.isArray(panel.records) ? panel.records : []).filter((record) =>
    inRange(Number(record?.at_ms), range),
  );
  const daily = (Array.isArray(panel.daily) ? panel.daily : []).filter((day) => {
    if (range.key === "all") return true;
    return inRange(Number(day?.at_ms), range);
  });
  const ring = modelCostRing(daily);
  // C06 的 charts_by_day：{ "YYYY-MM-DD": [bucket] }，bucket 才有 cache_read_tokens。
  let cacheReadTokens = 0;
  for (const [day, buckets] of Object.entries(panel.charts ?? {})) {
    const dayStart = zonedDayStart(day, timeZone);
    if (range.key !== "all" && !(dayStart >= range.start_ms && dayStart < range.end_ms)) continue;
    for (const bucket of Array.isArray(buckets) ? buckets : []) {
      cacheReadTokens += Number(bucket?.cache_read_tokens) || 0;
    }
  }
  return {
    range,
    records,
    daily,
    ring,
    cache: cacheHitRate({
      cacheReadTokens,
      tokensIn: daily.reduce((sum, day) => sum + (Number(day.tokens_in) || 0), 0),
    }),
    page: paginate(records, page),
  };
}

export function mountDetails(ctx, state) {
  const dom = ctx.dom;
  const box = card(dom, "明细");
  const note = hint(dom, "口径：模型环来自 daily.by_model；明细表来自 records（最多 300 条）；全部受最近 90 天 / 300 条限制。");
  const tabs = tag(dom, "div", "g-row g-detail-tabs");
  const rangeButtons = {};
  for (const range of DETAIL_RANGES) {
    const node = button(dom, range.label, "g-btn");
    node.on("click", () => {
      currentRange = range.key;
      currentPage = 1;
      render(state.lastPanel, state.lastView);
    });
    tabs.append(node);
    rangeButtons[range.key] = node;
  }
  const empty = hint(dom, "还没有明细数据：需要 Cookie 的 /internal 同步，或先使用演示数据。");
  const error = text(dom, "", "g-error g-hidden");
  const ringLine = text(dom, "", "g-muted");
  const cacheLine = text(dom, "", "g-muted");
  const table = tag(dom, "div", "g-detail-table");
  const pager = tag(dom, "div", "g-row g-detail-pager");
  const prev = button(dom, "上一页", "g-btn");
  const next = button(dom, "下一页", "g-btn");
  const pageInfo = text(dom, "", "g-muted");
  prev.on("click", () => {
    currentPage -= 1;
    render(state.lastPanel, state.lastView);
  });
  next.on("click", () => {
    currentPage += 1;
    render(state.lastPanel, state.lastView);
  });
  pager.append(prev, next, pageInfo);
  box.append(note, tabs, error, empty, ringLine, cacheLine, table, pager);

  let currentRange = "today";
  let currentPage = 1;

  function render(panel, view) {
    const cookies = view?.cookie ?? {};
    if (cookies.state === "expired" || cookies.state === "unavailable") {
      error.textContent = cookies.state === "expired" ? "会话已过期，明细暂停" : "凭据存储不可用，明细暂停";
      error.className = "g-error";
    } else {
      error.textContent = "";
      error.className = "g-error g-hidden";
    }
    for (const [key, node] of Object.entries(rangeButtons)) {
      node.className = `g-btn${key === currentRange ? " primary" : ""}`;
    }
    const model = detailsModel(panel ?? {}, {
      rangeKey: currentRange,
      page: currentPage,
      now: Number(panel?.fetchedAt) || Date.now(),
    });
    currentPage = model.page.page;
    const has = model.records.length > 0 || model.daily.length > 0;
    empty.className = has ? "g-muted g-hidden" : "g-muted";
    ringLine.textContent = model.ring.models.length
      ? `模型成本：${model.ring.models.map((item) => `${item.model} ${fmtCredits(item.cost)} (${fmtPct(item.pct)})`).join(" · ")}`
      : "模型成本：—";
    cacheLine.textContent = `缓存命中率：${model.cache === null ? "—" : fmtPct(model.cache * 100)}`;
    table.textContent = "";
    for (const record of model.page.items) {
      const line = tag(dom, "div", "g-detail-row");
      line.append(
        text(dom, fmtDateTime(Number(record.at_ms)), "g-muted"),
        text(dom, String(record.model ?? "unknown")),
        text(dom, fmtTokens(Number(record.tokens_in) + Number(record.tokens_out))),
        text(dom, fmtCredits(Number(record.cost_total) || 0)),
      );
      table.append(line);
    }
    pageInfo.textContent = `${model.page.page} / ${model.page.page_count}（${model.records.length} 条）`;
    prev.disabled = model.page.page <= 1;
    next.disabled = model.page.page >= model.page.page_count;
    pager.className = `g-row g-detail-pager${has ? "" : " g-hidden"}`;
  }

  return { box, render };
}
