// 生命周期、共享状态、轮询调度与界面推送。
// 出网只在 api.js → index.js::out()；存储只在插件隔离 store；凭据不进 :widget。
import { authEvent, evaluate } from "./alerts.js";
import {
  fetchCredits,
  fetchInternalCharts,
  fetchInternalUsage,
  fetchSubscriptions,
  fetchUsageSummary,
  fetchWhoami,
  isAuthError,
  isThrottleError,
} from "./api.js";
import { mergeChartBuckets, mergeUsagePages, nextPageCursor } from "./internal.js";
import { buildPanelPayload } from "./panel.js";
import { mergeDaily, replaceChartDays } from "./daily.js";
import { clearCookieAfterAuthFailure, COOKIE_EXPIRED_TEXT, maskCookie, migrateSecrets } from "./secrets.js";
import { demoSnapshot, demoViewData, pickUsageView, DEMO_SCENARIOS } from "./demo.js";
import { appendHistory } from "./history.js";
import { buildSnapshot, maskKey } from "./normalize.js";
import { nextDelay } from "./schedule.js";
import { DEFAULT_CONFIG, migrate, sanitizeConfig, SCHEMA_VERSION } from "./store-schema.js";
import { TOPIC_AGENT_STATE, TOPIC_CMD, TOPIC_PANEL, TOPIC_STATUS, TOPIC_USAGE } from "./topics.js";
import { cooldownReason, cooldownUntil, gate, resetThrottle } from "./index.js";

export let ctx = null;

let config = sanitizeConfig(DEFAULT_CONFIG);
let cred = { apiKey: "", savedAt: 0 };
let cookie = "";
let cookieState = "none";
let secretsReady = false;
let records = [];
let daily = [];
let countedThroughMs = 0;
/** @type {Record<string, Array<Record<string, any>>>} */
let chartsByDay = {};
/** 演示模式的独立数据源；不写 daily/chartsByDay，不进 persist。 */
/** @type {{daily: Array<Record<string, any>>, charts_by_day: Record<string, Array<Record<string, any>>>} | null} */
let demoData = null;
/** @type {Record<string, any> | null} */
let snapshot = null;
/** @type {Array<Array<number | null>>} */
let history = [];
/** @type {Record<string, number>} */
let alertsFired = {};
let whoamiCache = null;
let subscriptionCache = null;
let timer = 0;
let overlayChain = Promise.resolve();
let stopped = false;
let busy = false;
/** 宿主 agent:state 的最近一次运行态；没有事件时保持默认间隔。 */
let agentRunning = false;
let noChangeCount = 0;
let lastRefreshAt = 0;
let viewState = "onboarding";
let lastError = "";
let demoScenario = "normal";
let nextAt = 0;
let needsSchemaWrite = false;

const alive = () => !stopped && !!ctx;

function cloneConfig() {
  return {
    ...config,
    thresholds: {
      fiveHourPct: [...config.thresholds.fiveHourPct],
      weeklyPct: [...config.thresholds.weeklyPct],
      monthlyPct: [...config.thresholds.monthlyPct],
    },
  };
}

function status(text, level = "info") {
  try {
    const published = ctx?.bus?.publish(TOPIC_STATUS, { text, level });
    if (published && typeof published.catch === "function") {
      void published.catch(() => undefined);
    }
  } catch (err) {
    ctx?.log?.("状态广播失败", err);
  }
}

async function persist(keys) {
  if (!ctx || !keys?.length) return;
  // secrets 可用时 cred 只落非敏感标记；不可用时保留旧 cred，绝不丢明文。
  const values = {
    schema: SCHEMA_VERSION,
    config,
    cred: secretsReady ? { savedAt: cred.savedAt, secured: true } : cred,
    snapshot,
    history,
    alertsFired,
    records,
    daily,
    counted_through_ms: countedThroughMs,
    charts_by_day: chartsByDay,
  };
  for (const key of keys) {
    try {
      await ctx.storage.set(key, values[key]);
    } catch (err) {
      ctx?.log?.(`保存 ${key} 失败`, err);
    }
  }
}

async function restore() {
  if (!ctx) return;
  const raw = {};
  for (const key of [
    "schema",
    "config",
    "cred",
    "snapshot",
    "history",
    "alertsFired",
    "records",
    "daily",
    "counted_through_ms",
    "charts_by_day",
  ]) {
    try {
      raw[key] = await ctx.storage.get(key);
    } catch (err) {
      ctx.log?.(`读取 ${key} 失败`, err);
    }
  }
  const store = migrate(raw);
  config = store.config;
  cred = store.cred;
  snapshot = store.snapshot;
  history = store.history;
  alertsFired = store.alertsFired;
  records = store.records;
  daily = store.daily;
  countedThroughMs = store.counted_through_ms;
  chartsByDay = store.charts_by_day;
  needsSchemaWrite = raw.schema !== SCHEMA_VERSION;
  lastRefreshAt = Number(snapshot?.fetched_at) || 0;
  await restoreSecrets(raw);
}

/** B 段：旧明文 copy→verify→clear；secret 不可用时保留明文，不回写明文。 */
async function restoreSecrets(raw) {
  secretsReady = false;
  if (!ctx?.secrets) {
    cookieState = "unavailable";
    return;
  }
  const legacyCookie =
    typeof raw?.cookie === "string"
      ? raw.cookie
      : typeof raw?.cred?.cookie === "string"
        ? raw.cred.cookie
        : "";
  const legacy = {
    apiKey: typeof cred.apiKey === "string" ? cred.apiKey : "",
    cookie: legacyCookie,
  };
  if (legacy.apiKey || legacy.cookie) {
    try {
      const result = await migrateSecrets({
        legacy,
        secrets: ctx.secrets,
        storage: { set: (key, value) => ctx.storage.set(key, value) },
      });
      if (result.marker?.cookieState) cookieState = result.marker.cookieState;
    } catch {
      cookieState = "unavailable";
    }
  }
  try {
    const storedKey = await ctx.secrets.get("apiKey");
    if (storedKey) cred.apiKey = storedKey;
    const storedCookie = await ctx.secrets.get("cookie");
    if (storedCookie) {
      cookie = storedCookie;
      cookieState = "ready";
    }
    secretsReady = true;
  } catch {
    secretsReady = false;
    cookieState = "unavailable";
  }
}

function publishView() {
  if (!ctx) return;
  const mode = config.demo ? "demo" : cred.apiKey ? "key" : "none";
  const account =
    mode === "demo"
      ? { name: "演示账户", maskedKey: "演示模式", mode: "demo" }
      : mode === "key"
        ? {
            name: snapshot?.account?.name ?? "Command Code",
            maskedKey: snapshot?.account?.masked_key ?? maskKey(cred.apiKey),
            mode: "key",
          }
        : null;
  const usage = pickUsageView({ demo: config.demo, demoData, daily, chartsByDay });
  const view = {
    state: viewState,
    fetchedAt: Number(snapshot?.fetched_at) || 0,
    nextAt,
    cooldownUntil,
    account,
    plan: snapshot?.plan ?? null,
    windows: snapshot?.windows ?? null,
    credits: snapshot?.credits ?? null,
    usage: snapshot?.usage ?? null,
    alerts: snapshot?.alerts ?? [],
    config: cloneConfig(),
    cookie: { configured: !!cookie, state: cookieState, masked: maskCookie(cookie) },
    records,
    daily: usage.daily,
    charts: usage.charts_by_day,
    net: {
      lastMinute: gate.stats().window,
      cooldownReason,
      lastError,
    },
  };
  try {
    void ctx.widget.update(view).catch((err) => ctx?.log?.("推送界面失败", err));
  } catch (err) {
    ctx?.log?.("推送界面失败", err);
  }
}

function publishUsage(prev, next) {
  if (!ctx) return;
  const windowOf = (window) =>
    window
      ? { remainingPct: window.remaining_pct, resetAt: window.reset_at, exceeded: window.exceeded }
      : null;
  const period = next.usage ?? {};
  const previous = prev?.usage ?? null;
  const delta = previous
    ? {
        tokensIn: Number(period.tokens_in ?? 0) - Number(previous.tokens_in ?? 0),
        tokensOut: Number(period.tokens_out ?? 0) - Number(previous.tokens_out ?? 0),
        cost: Number(period.total_cost ?? 0) - Number(previous.total_cost ?? 0),
      }
    : null;
  try {
    const published = ctx.bus.publish(TOPIC_USAGE, {
      provider: "commandcode",
      account: next.account?.user_name ?? "",
      at: next.fetched_at,
      windows: {
        five_hour: windowOf(next.windows?.five_hour),
        weekly: windowOf(next.windows?.weekly),
        monthly: windowOf(next.windows?.monthly),
      },
      period: {
        tokensIn: period.tokens_in ?? 0,
        tokensOut: period.tokens_out ?? 0,
        cost: period.total_cost ?? 0,
        currency: "USD",
        requests: period.total_count ?? 0,
      },
      delta,
    });
    if (published && typeof published.catch === "function") {
      void published.catch(() => undefined);
    }
  } catch (err) {
    ctx?.log?.("用量广播失败", err);
  }
}

function publishPanel() {
  if (!ctx) return;
  try {
    const published = ctx.bus.publish(
      TOPIC_PANEL,
      buildPanelPayload({
        history,
        fetchedAt: Number(snapshot?.fetched_at) || 0,
        daily,
        records,
        charts: chartsByDay,
        cookieState,
      }),
    );
    if (published && typeof published.catch === "function") {
      void published.catch(() => undefined);
    }
  } catch (err) {
    ctx?.log?.("历史广播失败", err);
  }
}

function syncOverlay() {
  overlayChain = overlayChain.then(async () => {
    if (!alive()) return;
    const want = config.showOverlay === true && !!snapshot && viewState !== "onboarding";
    try {
      if (want) {
        await ctx.overlay.show({
          x: config.overlayX,
          y: config.overlayY,
          height: 168,
        });
      } else {
        await ctx.overlay.hide();
      }
    } catch (err) {
      ctx?.log?.("悬浮卡切换失败", err);
    }
  });
  return overlayChain;
}

async function fireAlerts(events) {
  if (!events?.length || !ctx) return;
  for (const event of events) {
    if (!ctx) return;
    if (event.notify) {
      try {
        await ctx.notify.show("GOAT 用量", event.message);
        // notify.resolve 之后才发这条记录：e2e 用它证明宿主通知命令真的走通了。
        status(`已发送通知（GOAT 用量）：${event.message}`, "ok");
      } catch (err) {
        status(`通知发送失败：${err.message}`, "error");
        ctx?.log?.("通知失败", err);
      }
    }
    if (!ctx) return;
    if (config.petReact && event.pet) {
      try {
        await ctx.pet.react(event.pet);
        if (event.say) await ctx.pet.say(event.message);
      } catch (err) {
        ctx?.log?.("宠物联动失败", err);
      }
    }
  }
}

function comparableChanged(prev, next) {
  if (!prev) return true;
  const before = [
    prev.windows?.five_hour?.used,
    prev.windows?.weekly?.used,
    prev.windows?.monthly?.remaining,
    prev.usage?.total_count,
  ];
  const after = [
    next.windows?.five_hour?.used,
    next.windows?.weekly?.used,
    next.windows?.monthly?.remaining,
    next.usage?.total_count,
  ];
  return before.some((value, index) => !Object.is(value, after[index]));
}

function sameFired(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

function stopTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  nextAt = 0;
}

function scheduleNext(override) {
  stopTimer();
  if (!alive()) return;
  if (!config.demo && (!cred.apiKey || viewState === "auth_error")) return;
  const delay =
    override ??
    nextDelay(
      {
        cooldownUntil,
        noChangeCount,
        lastRefreshAt,
        authError: viewState === "auth_error",
        agentRunning,
      },
      Date.now(),
      config,
      Math.random,
      snapshot?.windows ?? {},
    );
  if (delay === null) return;
  nextAt = Date.now() + delay;
  timer = setTimeout(() => {
    timer = 0;
    void refreshSnapshot();
  }, delay);
}

async function handleRefreshError(err) {
  if (isAuthError(err)) {
    viewState = "auth_error";
    lastError = err.message;
    stopTimer();
    const event = authEvent(cred.savedAt);
    if (!alertsFired[event.key]) {
      alertsFired[event.key] = Date.now();
      await persist(["alertsFired"]);
      await fireAlerts([event]);
    }
    publishView();
    void syncOverlay();
    return;
  }
  if (isThrottleError(err) || err?.kind === "cooldown" || Date.now() < cooldownUntil) {
    viewState = "cooldown";
    lastError = err?.message ?? "限流冷却中";
    scheduleNext();
    publishView();
    void syncOverlay();
    return;
  }
  viewState = "stale";
  lastError = err?.message ?? String(err);
  scheduleNext();
  publishView();
  void syncOverlay();
}

/** B 段：Cookie 的 /internal usage/charts 拉取与翻页去重；401/403 只清 Cookie。 */
async function refreshInternal() {
  if (!ctx?.secrets || !cookie) {
    cookieState = cookie ? "ready" : cookieState;
    return;
  }
  try {
    const pages = [];
    const seen = new Set();
    let cursor = "";
    let complete = false;
    for (let i = 0; i < 5; i += 1) {
      const page = await fetchInternalUsage(cookie, { cursor });
      pages.push(page);
      const pageRecords = Array.isArray(page) ? page : (page?.records ?? page?.data ?? []);
      for (const record of pageRecords) {
        if (record?.id) seen.add(record.id);
      }
      const next = nextPageCursor(page, seen);
      if (!next) {
        complete = true;
        break;
      }
      cursor = next;
    }
    const merged = mergeUsagePages(pages);
    const chartsPage = await fetchInternalCharts(cookie);
    const buckets = mergeChartBuckets([
      { data: chartsPage?.charts ?? chartsPage?.data ?? chartsPage?.records ?? [] },
    ]);
    if (complete) {
      // 只有整批翻页完整成功才提交 daily/水位；部分页或 charts 失败不推进。
      const nextDaily = mergeDaily(merged, daily, countedThroughMs);
      records = merged;
      daily = nextDaily.daily;
      countedThroughMs = nextDaily.counted_through_ms;
      chartsByDay = replaceChartDays(chartsByDay, buckets);
      await persist(["records", "daily", "counted_through_ms", "charts_by_day"]);
    } else {
      records = merged;
    }
    cookieState = "ready";
  } catch (err) {
    if (isAuthError(err)) {
      await clearCookieAfterAuthFailure({
        secrets: ctx.secrets,
        storage: { set: (key, value) => ctx.storage.set(key, value) },
      });
      cookie = "";
      cookieState = "expired";
      lastError = COOKIE_EXPIRED_TEXT;
      status(lastError, "warn");
      return;
    }
    cookieState = "error";
    lastError = err?.message ?? String(err);
  }
}

async function refreshSnapshot() {
  if (busy || !alive()) return;
  if (cookie) await refreshInternal();
  if (!config.demo && !cred.apiKey) {
    viewState = "onboarding";
    publishView();
    void syncOverlay();
    return;
  }

  busy = true;
  const now = Date.now();
  let summaryFailed = false;

  try {
    let next;
    if (config.demo) {
      const demoNext = demoSnapshot(now, demoScenario);
      demoData = demoViewData(
        now,
        demoScenario,
        undefined,
        Number(demoNext.plan?.current_period_start) || undefined,
      );
      next = demoNext;
      viewState = "demo";
      lastError = "";
    } else {
      demoData = null;
      const key = cred.apiKey;
      let whoami = whoamiCache?.data;
      if (!whoamiCache || now - whoamiCache.at > 3_600_000) {
        whoami = await fetchWhoami(key);
        if (!alive()) return;
        whoamiCache = { at: now, data: whoami };
      }
      const orgId = String(whoami?.org?.id ?? "");
      const creditsRoot = await fetchCredits(key, orgId);
      if (!alive()) return;

      const periodEnd = Number(snapshot?.plan?.current_period_end) || 0;
      const resetPassed = periodEnd > 0 && now >= periodEnd;
      let subscriptionRoot;
      if (subscriptionCache && !resetPassed && now - subscriptionCache.at < 600_000) {
        subscriptionRoot = subscriptionCache.data;
      } else {
        subscriptionRoot = await fetchSubscriptions(key, orgId);
        if (!alive()) return;
        subscriptionCache = { at: now, data: subscriptionRoot };
      }

      let summaryRoot = null;
      try {
        summaryRoot = await fetchUsageSummary(key, orgId);
        if (!alive()) return;
      } catch (err) {
        if (isAuthError(err) || isThrottleError(err) || err?.kind === "cooldown") throw err;
        summaryFailed = true;
      }

      next = buildSnapshot({
        whoami,
        creditsRoot,
        subscriptionRoot,
        summaryRoot,
        apiKey: key,
        fetchedAt: now,
        previousUsage: snapshot?.usage ?? null,
      });
    }

    if (!alive()) return;
    const prev = snapshot;
    const changed = comparableChanged(prev, next);
    noChangeCount = prev && !changed ? noChangeCount + 1 : 0;
    snapshot = next;
    lastRefreshAt = Date.now();

    const historyNext = appendHistory(history, snapshot, lastRefreshAt);
    const historyChanged = historyNext !== history;
    history = historyNext;

    const result = evaluate(prev, snapshot, config, alertsFired, {
      suppress: !prev,
      now: lastRefreshAt,
    });
    const firedChanged = !sameFired(alertsFired, result.firedNext);
    alertsFired = result.firedNext;
    await fireAlerts(result.toFire);
    if (!alive()) return;

    const keys = [];
    if (!prev || changed) keys.push("snapshot");
    if (historyChanged) keys.push("history");
    if (firedChanged) keys.push("alertsFired");
    if (needsSchemaWrite) {
      keys.push("schema", "config", "cred");
      needsSchemaWrite = false;
    }
    await persist(keys);

    viewState = summaryFailed ? "stale" : config.demo ? "demo" : "ok";
    lastError = summaryFailed ? "用量汇总暂不可用，保留上次数据" : "";
    publishView();
    publishUsage(prev, snapshot);
    if (historyChanged) publishPanel();
    void syncOverlay();
    scheduleNext();
  } catch (err) {
    if (alive()) await handleRefreshError(err);
  } finally {
    busy = false;
  }
}

async function handleCmd(cmd) {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.action) {
    case "sync":
      publishView();
      publishPanel();
      return;
    case "refresh": {
      if (busy) {
        status("正在刷新，请稍候", "info");
        return;
      }
      if (Date.now() < cooldownUntil) {
        status(cooldownReason || "限流冷却中", "warn");
        return;
      }
      await refreshSnapshot();
      return;
    }
    case "testKey": {
      const key = typeof cmd.key === "string" ? cmd.key.trim() : "";
      if (!key) {
        status("请先填写 API Key", "error");
        return;
      }
      try {
        await fetchWhoami(key);
        status(`连接成功：${maskKey(key)}`, "ok");
      } catch (err) {
        status(`连接失败：${err.message}`, "error");
      }
      return;
    }
    case "saveKey": {
      const key = typeof cmd.key === "string" ? cmd.key.trim() : "";
      if (!key) {
        status("请先填写 API Key", "error");
        return;
      }
      if (!config.demo) {
        try {
          await fetchWhoami(key);
        } catch (err) {
          status(`连接失败：${err.message}`, "error");
          return;
        }
      }
      try {
        await ctx.secrets.set("apiKey", key);
        secretsReady = true;
      } catch {
        status("凭据存储不可用，Key 未保存", "error");
        return;
      }
      resetThrottle();
      cred = { apiKey: key, savedAt: Date.now() };
      whoamiCache = null;
      subscriptionCache = null;
      snapshot = null;
      history = [];
      alertsFired = {};
      noChangeCount = 0;
      lastRefreshAt = 0;
      viewState = config.demo ? "demo" : "ok";
      lastError = "";
      await persist(["cred", "snapshot", "history", "alertsFired"]);
      publishView();
      void syncOverlay();
      scheduleNext(0);
      status("API Key 已保存", "ok");
      return;
    }
    case "clearKey": {
      try {
        await ctx.secrets.delete("apiKey");
        secretsReady = true;
      } catch {
        status("凭据清除失败，请重试", "error");
        return;
      }
      resetThrottle();
      cred = { apiKey: "", savedAt: 0 };
      whoamiCache = null;
      subscriptionCache = null;
      snapshot = null;
      history = [];
      alertsFired = {};
      noChangeCount = 0;
      lastRefreshAt = 0;
      stopTimer();
      viewState = config.demo ? "demo" : "onboarding";
      lastError = "";
      await persist(["cred", "snapshot", "history", "alertsFired"]);
      publishView();
      void syncOverlay();
      if (config.demo) scheduleNext(0);
      status("已清除 API Key", "ok");
      return;
    }
    case "saveCookie": {
      const value = typeof cmd.cookie === "string" ? cmd.cookie.trim() : "";
      if (!value) {
        status("请先填写 Cookie", "error");
        return;
      }
      try {
        await ctx.secrets.set("cookie", value);
        secretsReady = true;
      } catch {
        cookieState = "unavailable";
        status("Cookie 保存失败（凭据存储不可用）", "error");
        return;
      }
      cookie = value;
      cookieState = "ready";
      try {
        await ctx.storage.set("cookieState", cookieState);
      } catch {
        /* 非敏感标记写失败不影响 Cookie 已进 secrets */
      }
      publishView();
      status("Cookie 已保存", "ok");
      return;
    }
    case "clearCookie": {
      try {
        await ctx.secrets.delete("cookie");
        secretsReady = true;
      } catch {
        status("Cookie 清除失败，请重试", "error");
        return;
      }
      cookie = "";
      cookieState = "none";
      records = [];
      daily = [];
      countedThroughMs = 0;
      chartsByDay = {};
      try {
        await ctx.storage.set("cookieState", cookieState);
      } catch {
        /* 非敏感标记写失败不影响清除 */
      }
      publishView();
      status("已清除 Cookie", "ok");
      return;
    }
    case "saveConfig": {
      // 面板只发改动字段；这里与当前 config 合并，避免「只改币种把刷新间隔抹回默认」。
      const patch = cmd.config && typeof cmd.config === "object" ? cmd.config : cmd;
      config = sanitizeConfig({
        ...config,
        ...patch,
        thresholds: { ...config.thresholds, ...(patch.thresholds ?? {}) },
      });
      await persist(["config"]);
      if (!config.demo) demoData = null;
      else if (!demoData) demoData = demoViewData(Date.now(), demoScenario);
      if (config.demo) scheduleNext(0);
      else if (cred.apiKey) scheduleNext(0);
      else {
        stopTimer();
        viewState = "onboarding";
      }
      publishView();
      void syncOverlay();
      status("设置已保存", "ok");
      return;
    }
    case "demoScenario": {
      if (!config.demo) {
        status("先打开演示模式", "error");
        return;
      }
      if (!DEMO_SCENARIOS.some((scenario) => scenario === cmd.scenario)) {
        status("未知的演示场景", "error");
        return;
      }
      demoScenario = String(cmd.scenario);
      demoData = demoViewData(Date.now(), demoScenario);
      await refreshSnapshot();
      return;
    }
    default:
      status(`未知指令: ${String(cmd.action)}`, "error");
  }
}

export async function activate(context) {
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  ctx = context;
  stopped = false;
  busy = false;
  agentRunning = false;
  overlayChain = Promise.resolve();
  await restore();
  try {
    await ctx.bus.subscribe(TOPIC_CMD, (payload) => {
      void handleCmd(payload).catch((err) => status(`指令失败：${err.message}`, "error"));
    });
    // 精确订阅宿主公开的 agent:state；没有事件（agent 桥未启用）就保持默认间隔。
    await ctx.bus.subscribe(TOPIC_AGENT_STATE, (payload) => {
      const running = payload?.state === "running";
      if (running === agentRunning) return;
      agentRunning = running;
      if (timer || config.demo || cred.apiKey) scheduleNext();
    });
  } catch (err) {
    ctx.log?.("订阅指令失败", err);
  }

  if (needsSchemaWrite) {
    await persist(["schema", "config", "cred"]);
    needsSchemaWrite = false;
  }
  demoData = config.demo ? demoViewData(Date.now(), demoScenario) : null;
  viewState = config.demo ? "demo" : cred.apiKey ? "stale" : "onboarding";
  publishView();
  void syncOverlay();
  if (config.demo) void refreshSnapshot();
  else if (cred.apiKey) scheduleNext(0);
  status("GOAT 用量已就绪", "info");
}

export async function deactivate() {
  stopped = true;
  demoData = null;
  stopTimer();
  await overlayChain.catch(() => undefined);
  try {
    await ctx?.overlay.destroy();
  } catch {
    /* 没开过就没有卡片 */
  }
  ctx = null;
}
