// 端点 URL 拼装 + 调用 out() + HTTP 状态分类。解析在 normalize.js。
// Key 只出现在 Authorization 头里；错误消息与日志都不带 Key。
import { isAuthStatus, isThrottleStatus } from "./throttle.js";
import { buildInternalRequest } from "./internal.js";
import { noteFailure, out, resetThrottle } from "./index.js";

const BASE = "https://api.commandcode.ai";

export class ApiError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

export const isAuthError = (err) =>
  err?.kind === "auth" || err?.status === 401 || err?.status === 403;
export const isThrottleError = (err) =>
  err?.kind === "throttle" || err?.kind === "cooldown" || err?.status === 429;
export const isApiError = (err) => err instanceof ApiError;

/** @param {string} path @param {string} orgId */
function withOrg(path, orgId) {
  if (!orgId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}orgId=${encodeURIComponent(orgId)}`;
}

/**
 * @param {string} path
 * @param {string} key
 * @param {{ orgId?: string }} options
 * @returns {Promise<Record<string, any>>}
 */
async function requestJson(path, key, { orgId = "" } = {}) {
  const url = `${BASE}${withOrg(path, orgId)}`;
  const res = await out(url, {
    method: "GET",
    headers: [
      ["accept", "application/json"],
      ["user-agent", "DesktopPet-GOATGauge/0.1"],
      ["authorization", `Bearer ${key}`],
    ],
  });

  if (isAuthStatus(res.status)) {
    throw new ApiError("auth", "API Key 无效或已过期。", res.status);
  }
  if (isThrottleStatus(res.status)) {
    throw new ApiError("throttle", "Command Code 暂时限制了查询，请稍后重试。", res.status);
  }
  if (res.status < 200 || res.status >= 300) {
    noteFailure();
    throw new ApiError("upstream", `请求失败（HTTP ${res.status}）。`, res.status);
  }
  if (res.truncated) {
    noteFailure();
    throw new ApiError("parse", "Command Code 返回的数据被截断。", res.status);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    noteFailure();
    throw new ApiError("parse", "Command Code 返回了无法识别的数据。", res.status);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    noteFailure();
    throw new ApiError("parse", "Command Code 返回结构异常。", res.status);
  }
  // 只有「HTTP 2xx 且 JSON 解析成功」才算一次真正成功；解析失败要继续累计失败次数。
  resetThrottle();
  return parsed;
}

export function fetchWhoami(key) {
  return requestJson("/alpha/whoami", key);
}

export function fetchCredits(key, orgId = "") {
  return requestJson("/alpha/billing/credits", key, { orgId });
}

export function fetchSubscriptions(key, orgId = "") {
  return requestJson("/alpha/billing/subscriptions", key, { orgId });
}

export function fetchUsageSummary(key, orgId = "") {
  return requestJson("/alpha/usage/summary", key, { orgId });
}

/** internal 只允许 usage / charts 的只读 GET；Cookie 只进请求头，错误文案不带 Cookie。 */
async function requestInternal(path, cookie, options = {}) {
  const { url, headers } = buildInternalRequest(path, cookie, options);
  const res = await out(url, { method: "GET", headers });
  if (isAuthStatus(res.status)) {
    throw new ApiError("auth", "会话已过期，明细暂停。", res.status);
  }
  if (isThrottleStatus(res.status)) {
    throw new ApiError("throttle", "Command Code 暂时限制了查询，请稍后重试。", res.status);
  }
  if (res.status < 200 || res.status >= 300) {
    noteFailure();
    throw new ApiError("upstream", `明细请求失败（HTTP ${res.status}）。`, res.status);
  }
  if (res.truncated) {
    noteFailure();
    throw new ApiError("parse", "Command Code 返回的明细被截断。", res.status);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    noteFailure();
    throw new ApiError("parse", "Command Code 返回了无法识别的明细。", res.status);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    noteFailure();
    throw new ApiError("parse", "Command Code 返回明细结构异常。", res.status);
  }
  resetThrottle();
  return parsed;
}

export function fetchInternalUsage(cookie, options = {}) {
  return requestInternal("/internal/usage", cookie, options);
}

export function fetchInternalCharts(cookie, options = {}) {
  return requestInternal("/internal/usage/charts", cookie, options);
}
