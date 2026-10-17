// 存储键、版本与读出校验。宿主 store 每次整表读写，坏数据必须回落到默认值，
// 不能让插件在激活时崩掉。schema 1 → 2 的迁移只为兼容早期试用数据。
import { HISTORY_FIELDS, MAX_HISTORY_POINTS } from "./history.js";

export const SCHEMA_VERSION = 2;
export const BADGE_MODES = ["five_hour", "weekly", "monthly", "cost_period"];

export const DEFAULT_CONFIG = {
  refreshSec: 60,
  currency: "USD",
  usdToCny: 7.2,
  thresholds: {
    fiveHourPct: [20, 5],
    weeklyPct: [20],
    monthlyPct: [10],
  },
  showOverlay: true,
  badgeMode: "five_hour",
  demo: false,
  petReact: true,
  overlayX: 360,
  overlayY: 220,
};

/** @param {unknown} raw @returns {Record<string, any>} */
function asObject(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function finiteInRange(value, min, max, fallback) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** @param {unknown} value @param {number[]} fallback @returns {number[]} */
function pctList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const list = value
    .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 100)
    .sort((a, b) => b - a)
    .slice(0, 4);
  return list.length ? list : [...fallback];
}

/** @param {unknown} raw @returns {typeof DEFAULT_CONFIG} */
export function sanitizeConfig(raw) {
  const source = asObject(raw);
  const thresholds = asObject(source.thresholds);
  const rawBadgeMode =
    source.badgeMode === "cost_today" ? "cost_period" : source.badgeMode;
  return {
    refreshSec: Math.round(finiteInRange(source.refreshSec, 30, 600, DEFAULT_CONFIG.refreshSec)),
    currency: source.currency === "CNY" ? "CNY" : "USD",
    usdToCny: finiteInRange(source.usdToCny, 1, 20, DEFAULT_CONFIG.usdToCny),
    thresholds: {
      fiveHourPct: pctList(thresholds.fiveHourPct, DEFAULT_CONFIG.thresholds.fiveHourPct),
      weeklyPct: pctList(thresholds.weeklyPct, DEFAULT_CONFIG.thresholds.weeklyPct),
      monthlyPct: pctList(thresholds.monthlyPct, DEFAULT_CONFIG.thresholds.monthlyPct),
    },
    showOverlay:
      typeof source.showOverlay === "boolean" ? source.showOverlay : DEFAULT_CONFIG.showOverlay,
    badgeMode: BADGE_MODES.includes(rawBadgeMode) ? rawBadgeMode : DEFAULT_CONFIG.badgeMode,
    demo: source.demo === true,
    petReact: source.petReact !== false,
    overlayX: finiteInRange(source.overlayX, -10_000, 10_000, DEFAULT_CONFIG.overlayX),
    overlayY: finiteInRange(source.overlayY, -10_000, 10_000, DEFAULT_CONFIG.overlayY),
  };
}

/** @param {unknown} raw @returns {{apiKey: string, savedAt: number}} */
export function sanitizeCred(raw) {
  const source = asObject(raw);
  const key = typeof source.apiKey === "string" ? source.apiKey.trim() : "";
  return {
    apiKey: key.length > 0 && key.length <= 256 ? key : "",
    savedAt: finiteInRange(source.savedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

/** @param {unknown} raw @returns {Record<string, any> | null} */
export function sanitizeSnapshot(raw) {
  const source = asObject(raw);
  if (
    typeof source.fetched_at !== "number" ||
    !Number.isFinite(source.fetched_at) ||
    !source.windows ||
    typeof source.windows !== "object" ||
    Array.isArray(source.windows)
  ) {
    return null;
  }
  return source;
}

/** @param {unknown} raw @returns {Array<Array<number | null>>} */
export function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = raw.filter(
    (row) =>
      Array.isArray(row) &&
      row.length === HISTORY_FIELDS &&
      typeof row[0] === "number" &&
      Number.isFinite(row[0]) &&
      row.slice(1).every((value) => value === null || (typeof value === "number" && Number.isFinite(value))),
  );
  return rows.slice(-MAX_HISTORY_POINTS);
}

/** @param {unknown} raw @returns {Record<string, number>} */
export function sanitizeAlertsFired(raw) {
  const source = asObject(raw);
  const entries = Object.entries(source)
    .filter(([key, at]) => key.length <= 200 && typeof at === "number" && Number.isFinite(at))
    .sort(([, a], [, b]) => b - a)
    .slice(0, 200);
  return Object.fromEntries(entries);
}

/**
 * schema 1（早期试用）→ 2。旧数据可能把 config/cred 摊在顶层。
 * @param {unknown} raw
 * @returns {{
 *   schema: number,
 *   config: typeof DEFAULT_CONFIG,
 *   cred: {apiKey: string, savedAt: number},
 *   snapshot: Record<string, any> | null,
 *   history: Array<Array<number | null>>,
 *   alertsFired: Record<string, number>,
 * }}
 */
export function migrate(raw) {
  const source = asObject(raw);
  const legacyConfig = asObject(source.config).refreshSec === undefined ? source : source.config;
  const legacyCred =
    asObject(source.cred).apiKey === undefined ? { apiKey: source.apiKey, savedAt: source.savedAt } : source.cred;
  return {
    schema: SCHEMA_VERSION,
    config: sanitizeConfig(legacyConfig),
    cred: sanitizeCred(legacyCred),
    snapshot: sanitizeSnapshot(source.snapshot),
    history: sanitizeHistory(source.history),
    alertsFired: sanitizeAlertsFired(source.alertsFired),
  };
}
