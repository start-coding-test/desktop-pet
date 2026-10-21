// 下一次轮询的纯函数：基础间隔 / 无变化退避 / 冷却优先 / 窗口重置抢先。
// 随机数与时间都注入，单测不依赖真实时钟。
export const MIN_REFRESH_SEC = 30;
export const MAX_REFRESH_SEC = 600;
/** Agent 正在运行时，下一次轮询的基础间隔（C05 候选 C）。 */
export const AGENT_RUNNING_REFRESH_SEC = 30;
export const NO_CHANGE_THRESHOLD = 3;
export const MAX_BACKOFF_MS = 600_000;
export const JITTER_RATIO = 0.1;
export const RESET_GRACE_MS = 5_000;
export const MIN_DELAY_MS = 1_000;

/** @param {unknown} sec @returns {number} 秒 */
export function clampRefreshSec(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return 60;
  return Math.min(MAX_REFRESH_SEC, Math.max(MIN_REFRESH_SEC, Math.round(n)));
}

/** Agent 运行态优先用 30s，否则沿用用户配置（并保持原有上下限）。 */
export function scheduleBaseSec(agentRunning, refreshSec) {
  return agentRunning === true ? AGENT_RUNNING_REFRESH_SEC : clampRefreshSec(refreshSec);
}

/** @param {number} baseMs @param {() => number} rand @param {number} ratio */
export function jitter(baseMs, rand = Math.random, ratio = JITTER_RATIO) {
  const factor = 1 + (rand() * 2 - 1) * ratio;
  return Math.max(1, Math.round(baseMs * factor));
}

/**
 * @param {{
 *   cooldownUntil?: number,
 *   noChangeCount?: number,
 *   lastRefreshAt?: number,
 *   authError?: boolean,
 *   agentRunning?: boolean,
 * }} state
 * @param {number} now
 * @param {{ refreshSec?: number }} cfg
 * @param {() => number} rand
 * @param {Record<string, any>} windows
 * @returns {number | null} null = 停止轮询
 */
export function nextDelay(state, now, cfg, rand = Math.random, windows = {}) {
  if (state.authError) return null;

  const cooldownUntil = Number(state.cooldownUntil) || 0;
  if (cooldownUntil > now) return cooldownUntil - now;

  const running = state.agentRunning === true;
  const baseMs = scheduleBaseSec(running, cfg.refreshSec) * 1000;
  const noChange = Math.max(0, Math.floor(Number(state.noChangeCount) || 0));
  // Agent 运行期间固定 30s 基础间隔，不受无变化退避影响；idle 恢复原有退避。
  const backoff =
    running || noChange < NO_CHANGE_THRESHOLD
      ? baseMs
      : Math.min(baseMs * 1.5 ** (noChange - NO_CHANGE_THRESHOLD + 1), MAX_BACKOFF_MS);
  let delay = jitter(Math.max(baseMs, backoff), rand);

  // 任一窗口到点后 5 秒强制刷新；已经过点且刷新发生在过点之前也补一次。
  const lastRefreshAt = Number(state.lastRefreshAt) || 0;
  for (const window of Object.values(windows ?? {})) {
    const resetAt = Number(window?.reset_at) || 0;
    if (resetAt <= 0) continue;
    if (resetAt > now) delay = Math.min(delay, resetAt - now + RESET_GRACE_MS);
    else if (resetAt > lastRefreshAt) delay = Math.min(delay, RESET_GRACE_MS);
  }

  return Math.max(MIN_DELAY_MS, Math.round(delay));
}
