// C06：internal usage/charts 的纯函数（翻页、去重、裁剪、请求形状）。
// 这里不碰 ctx/网络；api.js 负责出网，main.js 负责调度。
import { normalizeChartBucket, normalizeUsageRecord } from "./normalize.js";
import { assertInternalPath, internalHeaders } from "./secrets.js";

export const RECORDS_LIMIT = 300;
export const INTERNAL_BASE = "https://api.commandcode.ai";

function pageRecords(page) {
  if (Array.isArray(page)) return page;
  if (Array.isArray(page?.records)) return page.records;
  if (Array.isArray(page?.data)) return page.data;
  return [];
}

function asRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const normalized = normalizeUsageRecord(raw);
  if (normalized) return normalized;
  if (typeof raw.id !== "string" || typeof raw.created_at !== "string") return null;
  return raw;
}

function atMs(record) {
  if (Number.isFinite(record?.at_ms)) return record.at_ms;
  const parsed = Date.parse(String(record?.created_at ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 跨页按 id 去重、按时间降序、裁到 limit；缺 id/坏时间的记录丢弃。 */
export function mergeUsagePages(pages, { limit = RECORDS_LIMIT } = {}) {
  const byId = new Map();
  for (const page of pages ?? []) {
    for (const raw of pageRecords(page)) {
      const record = asRecord(raw);
      if (!record) continue;
      const time = atMs(record);
      if (time <= 0) continue;
      byId.set(record.id, { ...record, at_ms: time });
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.at_ms - a.at_ms || String(b.id).localeCompare(String(a.id)))
    .slice(0, limit);
}

/** 只在还有新 id 且上游给了 cursor 时继续翻页；否则停止，避免死循环。 */
export function nextPageCursor(page, seenIds = new Set()) {
  const cursor = page?.nextCursor ?? page?.next_cursor ?? page?.cursor ?? "";
  if (typeof cursor !== "string" || cursor.length === 0) return null;
  const records = pageRecords(page);
  if (records.length === 0) return null;
  return records.some((record) => record && !seenIds.has(record.id)) ? cursor : null;
}

/** charts 按 model + timeBucket 去重；同键以后到的页为准。 */
export function mergeChartBuckets(pages) {
  const byKey = new Map();
  for (const page of pages ?? []) {
    for (const raw of pageRecords(page)) {
      const bucket = normalizeChartBucket(raw);
      if (!bucket) continue;
      byKey.set(`${bucket.model}\u0000${bucket.time_bucket}`, bucket);
    }
  }
  return [...byKey.values()];
}

/** 只允许 usage / charts 的只读 GET；cursor/orgId 进 query，Cookie 只进请求头。 */
export function buildInternalRequest(path, cookie, { cursor = "", orgId = "" } = {}) {
  assertInternalPath(path, "GET");
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (orgId) params.set("orgId", orgId);
  const query = params.toString();
  return {
    url: `${INTERNAL_BASE}${path}${query ? `?${query}` : ""}`,
    headers: internalHeaders(cookie),
  };
}
