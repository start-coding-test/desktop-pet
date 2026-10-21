// C06：records → 本地 daily 的水位聚合。纯函数，不碰 ctx/网络。
// 水位严格用 at_ms > counted_through_ms；at_ms == 水位不重复计入。
import { bucketToLocalDay, localDayKey } from "./history.js";

export const MAX_DAILY_DAYS = 90;

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dayEntry(day, atMs) {
  return {
    day,
    at_ms: atMs,
    requests: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_total: 0,
    by_model: {},
  };
}

function addRecord(entry, record) {
  entry.requests += 1;
  entry.tokens_in += number(record.tokens_in);
  entry.tokens_out += number(record.tokens_out);
  entry.cost_total += number(record.cost_total);
  const model = typeof record.model === "string" && record.model ? record.model : "unknown";
  const modelEntry = entry.by_model[model] ?? { requests: 0, tokens_in: 0, tokens_out: 0, cost_total: 0 };
  modelEntry.requests += 1;
  modelEntry.tokens_in += number(record.tokens_in);
  modelEntry.tokens_out += number(record.tokens_out);
  modelEntry.cost_total += number(record.cost_total);
  entry.by_model[model] = modelEntry;
  if (record.at_ms > entry.at_ms) entry.at_ms = record.at_ms;
}

function cloneEntry(entry) {
  return {
    ...entry,
    by_model: Object.fromEntries(
      Object.entries(entry.by_model ?? {}).map(([model, value]) => [model, { ...value }]),
    ),
  };
}

function trimDaily(daily) {
  return [...daily]
    .sort((a, b) => String(b.day).localeCompare(String(a.day)))
    .slice(0, MAX_DAILY_DAYS)
    .map(cloneEntry);
}

/**
 * 只把严格晚于水位的 records 计入 daily；返回新水位（本次最大 at_ms）。
 * 调用方必须在整批拉取完整成功后才提交返回值；部分失败不要调用/不要提交。
 * @param {Array<Record<string, any>>} records
 * @param {Array<Record<string, any>>} previous
 * @param {number} countedThroughMs
 * @param {{ timeZone?: string }} [options]
 */
export function mergeDaily(records, previous = [], countedThroughMs = 0, options = {}) {
  const { timeZone } = options;
  const baseline =
    typeof countedThroughMs === "number" && Number.isFinite(countedThroughMs)
      ? countedThroughMs
      : 0;
  const byDay = new Map();
  for (const entry of previous ?? []) {
    if (entry && typeof entry.day === "string") byDay.set(entry.day, cloneEntry(entry));
  }

  let watermark = baseline;
  let added = 0;
  for (const record of records ?? []) {
    if (!record || typeof record.at_ms !== "number" || !Number.isFinite(record.at_ms)) continue;
    if (record.at_ms <= baseline) continue; // 严格大于；== 和更旧都不计
    const day = localDayKey(record.at_ms, timeZone);
    if (!day) continue;
    const entry = byDay.get(day) ?? dayEntry(day, record.at_ms);
    addRecord(entry, record);
    byDay.set(day, entry);
    watermark = Math.max(watermark, record.at_ms);
    added += 1;
  }
  return { daily: trimDaily([...byDay.values()]), counted_through_ms: watermark, added };
}

/**
 * charts 按本地日整日替换（不累加），只保留最近 90 个本地日。
 * @param {Record<string, Array<Record<string, any>>>} [previous]
 * @param {Array<Record<string, any>>} [buckets]
 * @param {{ timeZone?: string }} [options]
 */
export function replaceChartDays(previous = {}, buckets = [], options = {}) {
  const { timeZone } = options;
  const next = {};
  for (const [day, list] of Object.entries(previous ?? {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(list)) next[day] = list.map((b) => ({ ...b }));
  }
  const grouped = new Map();
  for (const bucket of buckets ?? []) {
    const day = bucketToLocalDay(bucket?.time_bucket, timeZone);
    if (!day) continue;
    const list = grouped.get(day) ?? [];
    list.push({ ...bucket });
    grouped.set(day, list);
  }
  for (const [day, list] of grouped) next[day] = list;
  return Object.fromEntries(
    Object.entries(next)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, MAX_DAILY_DAYS),
  );
}
