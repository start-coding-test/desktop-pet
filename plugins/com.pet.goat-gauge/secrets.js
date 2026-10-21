// C06：凭据迁移与认证隔离的纯函数。生产调用方在 main.js；这里不直接碰 ctx。
// 约束：Cookie/Key 只进 secrets；不写明文、不进日志/错误/标记；标记只含非敏感状态。

export const KEY_SECRET = "apiKey";
export const COOKIE_SECRET = "cookie";
/** Key 模式下允许读取的 secret 名单：绝不含 cookie（在线 Key 组不读 Cookie）。 */
export const KEY_MODE_SECRETS = [KEY_SECRET];
export const INTERNAL_ORIGIN = "https://commandcode.ai";
export const INTERNAL_REFERER = "https://commandcode.ai/";

const MARKER_KEYS = new Set(["savedAt", "secured", "cookieState", "conflict"]);
const COOKIE_UNAVAILABLE = "unavailable";
const COOKIE_EXPIRED = "expired";

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function withRetry(fn, attempts, delayMs) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i + 1 < attempts) await wait(delayMs);
    }
  }
  throw last;
}

function markerFor(legacy, state) {
  const marker = {
    savedAt: Number.isFinite(legacy?.savedAt) ? legacy.savedAt : 0,
    secured: state.secured === true,
  };
  if (state.cookieState) marker.cookieState = state.cookieState;
  if (state.conflict) marker.conflict = true;
  return marker;
}

function assertMarkerShape(marker) {
  for (const key of Object.keys(marker)) {
    if (!MARKER_KEYS.has(key)) throw new Error(`非法的迁移标记字段: ${key}`);
  }
  return marker;
}

/**
 * copy → verify → clear。只有所有存在的旧凭据都成功迁移/确认冲突时才写标记
 * （写 `cred` 标记即清掉旧明文）；任一失败都保留旧明文，等下次重试。
 * secrets 的 get/set 抛错时不回落明文，也不把错误值拼进返回值。
 * @param {{ legacy?: Record<string, any>, secrets?: any, storage?: any, attempts?: number, delayMs?: number }} [options]
 */
export async function migrateSecrets({
  legacy = {},
  secrets,
  storage,
  attempts = 3,
  delayMs = 0,
} = {}) {
  if (!secrets || typeof secrets.get !== "function" || typeof secrets.set !== "function") {
    throw new Error("migrateSecrets 需要注入 secrets.get/set");
  }
  if (!storage || typeof storage.set !== "function") {
    throw new Error("migrateSecrets 需要注入 storage.set");
  }

  const marker = markerFor(legacy, { secured: false });
  const result = { migrated: [], conflicts: [], failed: [], marker };
  const present = [KEY_SECRET, COOKIE_SECRET].filter(
    (name) => typeof legacy[name] === "string" && legacy[name].length > 0,
  );
  if (present.length === 0) return result;

  for (const name of present) {
    const plain = legacy[name];
    let existing;
    try {
      existing = await withRetry(() => secrets.get(name), attempts, delayMs);
    } catch {
      result.failed.push(name);
      if (name === COOKIE_SECRET) marker.cookieState = COOKIE_UNAVAILABLE;
      continue;
    }

    if (existing === plain) {
      result.migrated.push(name);
      continue;
    }
    if (existing != null) {
      // secrets 为准：不覆盖；旧明文仍清掉，标记只带非敏感冲突位。
      result.conflicts.push(name);
      marker.conflict = true;
      continue;
    }

    try {
      await withRetry(() => secrets.set(name, plain), attempts, delayMs);
      const readBack = await withRetry(() => secrets.get(name), attempts, delayMs);
      if (readBack !== plain) throw new Error("verify failed");
      result.migrated.push(name);
    } catch {
      result.failed.push(name);
      if (name === COOKIE_SECRET) marker.cookieState = COOKIE_UNAVAILABLE;
    }
  }

  // 部分失败：不写标记（写 cred 会清掉失败那一项的旧明文）；下次整轮重试。
  if (result.failed.length === 0) {
    const cleared = assertMarkerShape(
      markerFor(legacy, {
        secured: true,
        conflict: marker.conflict,
        cookieState: marker.cookieState,
      }),
    );
    try {
      await storage.set("cred", cleared);
      result.marker = cleared;
    } catch {
      result.failed.push("marker");
    }
  }
  return result;
}

/**
 * internal 401/403：只删 Cookie，不碰 apiKey；删除失败也如实返回。
 * @param {{ secrets?: any, storage?: any, attempts?: number, delayMs?: number }} [options]
 */
export async function clearCookieAfterAuthFailure({
  secrets,
  storage,
  attempts = 3,
  delayMs = 0,
} = {}) {
  if (!secrets || typeof secrets.delete !== "function") {
    throw new Error("clearCookieAfterAuthFailure 需要注入 secrets.delete");
  }
  let removed = true;
  try {
    await withRetry(() => secrets.delete(COOKIE_SECRET), attempts, delayMs);
  } catch {
    removed = false;
  }
  const marker = { savedAt: 0, secured: true, cookieState: COOKIE_EXPIRED };
  if (storage && typeof storage.set === "function") {
    try {
      await storage.set("cookieState", marker.cookieState);
    } catch {
      removed = false;
    }
  }
  return { removed, cookieState: COOKIE_EXPIRED };
}

/** internal 只允许 usage / charts 的只读 GET；非白名单在发请求前抛错。 */
export function assertInternalPath(path, method = "GET") {
  const allowed = path === "/internal/usage" || path === "/internal/usage/charts";
  if (method.toUpperCase() !== "GET" || !allowed) {
    throw new Error("internal 只允许 usage/charts 的只读 GET");
  }
  return path;
}

export function internalHeaders(cookie) {
  if (typeof cookie !== "string" || cookie.length === 0) {
    throw new Error("internal 请求缺少 Cookie");
  }
  return [
    ["accept", "application/json"],
    ["user-agent", "DesktopPet-GOATGauge/0.1"],
    ["cookie", cookie],
    ["origin", INTERNAL_ORIGIN],
    ["referer", INTERNAL_REFERER],
  ];
}

export function keyHeaders(key) {
  return [
    ["accept", "application/json"],
    ["user-agent", "DesktopPet-GOATGauge/0.1"],
    ["authorization", `Bearer ${key}`],
  ];
}

export function classifyInternalStatus(status) {
  if (status === 401 || status === 403) return "expired";
  if (status === 429) return "throttle";
  if (status >= 200 && status < 300) return "ok";
  return "upstream";
}

export function isKeyModeSecret(name) {
  return KEY_MODE_SECRETS.includes(name);
}
