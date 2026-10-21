// com.pet.goat-gauge 纯函数单测（方案 §12.1）。
// 只 import 不碰 ctx / 网络的模块；出网与视图在 C2 的 e2e 里验。
import { readFileSync } from "node:fs";
import { check, deep, eq, group } from "./harness.mjs";

const { planInfo } = await import(new URL("../../plugins/com.pet.goat-gauge/plans.js", import.meta.url));
const {
  boolOf,
  buildSnapshot,
  epochMs,
  maskKey,
  normalizeChartBucket,
  normalizeCredits,
  normalizeUsage,
  normalizeUsageRecord,
  normalizeWindow,
} = await import(new URL("../../plugins/com.pet.goat-gauge/normalize.js", import.meta.url));
const { fmtCountdown, fmtCredits, fmtMoney, fmtPct, fmtTokens } = await import(
  new URL("../../plugins/com.pet.goat-gauge/format.js", import.meta.url)
);
const { AGENT_RUNNING_REFRESH_SEC, nextDelay, scheduleBaseSec } = await import(
  new URL("../../plugins/com.pet.goat-gauge/schedule.js", import.meta.url)
);
const { TOPIC_AGENT_STATE } = await import(
  new URL("../../plugins/com.pet.goat-gauge/topics.js", import.meta.url)
);
const { appendHistory, bucketToLocalDay, localDayKey, samplePoint } = await import(
  new URL("../../plugins/com.pet.goat-gauge/history.js", import.meta.url)
);
const { authEvent, evaluate } = await import(
  new URL("../../plugins/com.pet.goat-gauge/alerts.js", import.meta.url)
);
const {
  BADGE_MODES,
  DEFAULT_CONFIG,
  migrate,
  sanitizeAlertsFired,
  sanitizeConfig,
  sanitizeCred,
  sanitizeHistory,
  sanitizeSnapshot,
  SCHEMA_VERSION,
} = await import(new URL("../../plugins/com.pet.goat-gauge/store-schema.js", import.meta.url));
const {
  setAttrIfChanged,
  setClassIfChanged,
  setDatasetIfChanged,
  setTextIfChanged,
} = await import(new URL("../../plugins/com.pet.goat-gauge/views/write.js", import.meta.url));
const { DEMO_SCENARIOS, demoSnapshot } = await import(
  new URL("../../plugins/com.pet.goat-gauge/demo.js", import.meta.url)
);
const {
  KEY_MODE_SECRETS,
  INTERNAL_ORIGIN,
  INTERNAL_REFERER,
  migrateSecrets,
  clearCookieAfterAuthFailure,
  assertInternalPath,
  internalHeaders,
  keyHeaders,
  classifyInternalStatus,
  isKeyModeSecret,
} = await import(new URL("../../plugins/com.pet.goat-gauge/secrets.js", import.meta.url));
const { buildInternalRequest, mergeChartBuckets, mergeUsagePages, nextPageCursor } = await import(
  new URL("../../plugins/com.pet.goat-gauge/internal.js", import.meta.url)
);

/* ============================ planInfo ============================ */
group("planInfo");

deep("individual-goat → GOAT/70", planInfo("individual-goat"), {
  name: "GOAT",
  monthlyCredits: 70,
});
deep("individual-pro-v1 最长前缀优先 → Pro/80", planInfo("individual-pro-v1"), {
  name: "Pro",
  monthlyCredits: 80,
});
deep("individual-pro → Pro/30", planInfo("individual-pro"), { name: "Pro", monthlyCredits: 30 });
deep("individual-go → Go/10", planInfo("individual-go"), { name: "Go", monthlyCredits: 10 });
deep("下划线按连字符归一", planInfo("individual_goat"), { name: "GOAT", monthlyCredits: 70 });
eq("未知套餐不猜", planInfo("individual-mystery"), null);
eq("空值不猜", planInfo(""), null);

/* ============================ normalizeWindow ============================ */
group("normalizeWindow");

{
  const w = normalizeWindow(
    { used: 26, cap: 100, resetAt: 1760420000, exceeded: false },
    { kind: "five_hour", label: "5 小时", limited: true },
  );
  eq("used", 26, w.used);
  eq("cap", 100, w.cap);
  eq("remaining", 74, w.remaining);
  eq("remaining_pct", 74, w.remaining_pct);
  eq("reset_at 秒转毫秒", 1760420000000, w.reset_at);
  eq("available", true, w.available);
  eq("有数据时 note 为空", "", w.note);
}

{
  const w = normalizeWindow(undefined, {
    kind: "weekly",
    label: "本周",
    limited: false,
  });
  eq("无窗口数据且 limited=false", false, w.available);
  eq("note 说明套餐不受限", "当前套餐不受此窗口限制", w.note);
  eq("remaining 为空", null, w.remaining);
}

{
  const w = normalizeWindow(
    { used: 100, cap: 100 },
    { kind: "five_hour", label: "5 小时", limited: true },
  );
  eq("used>=cap 兜底 exceeded", true, w.exceeded);
  eq("remaining 归零", 0, w.remaining);
  eq("remaining_pct 归零", 0, w.remaining_pct);
}

{
  const w = normalizeWindow(
    { used: 5 },
    { kind: "weekly", label: "本周", limited: true },
  );
  eq("缺 cap 不可用", false, w.available);
  eq("缺 cap 的 note", "服务端暂未返回完整额度", w.note);
}

/* ============================ normalizeUsage ============================ */
group("normalizeUsage");

{
  const u = normalizeUsage({
    successRate: 0.95,
    totalCount: 3,
    totalCost: 1.5,
    averageCost: 0.5,
    totalTokensIn: 100,
    totalTokensOut: 50,
    periodBasis: "billing-period",
  });
  eq("successRate <= 1 乘 100", 95, u.success_rate);
  eq("total_count", 3, u.total_count);
  eq("total_cost", 1.5, u.total_cost);
  eq("tokens_in", 100, u.tokens_in);
  eq("tokens_out", 50, u.tokens_out);
  eq("period_basis", "billing-period", u.period_basis);
}

{
  const u = normalizeUsage({
    data: { successRate: 1, totalCount: 2, totalTokensIn: 1, totalTokensOut: 2 },
  });
  eq("data 包裹兼容", 2, u.total_count);
  eq("successRate=1 乘 100", 100, u.success_rate);
  eq("data 包裹 tokens", 1, u.tokens_in);
}

{
  const u = normalizeUsage(null);
  eq("空数据 total_count 归零", 0, u.total_count);
  eq("空数据 average_cost 为空", null, u.average_cost);
  eq("空数据 total_cost 归零", 0, u.total_cost);
}

/* ============================ epochMs / maskKey ============================ */
group("epochMs / maskKey");

eq("秒转毫秒", 1760420000000, epochMs(1760420000));
eq("毫秒原样", 1760420000000, epochMs(1760420000000));
eq("数字字符串按秒", 1760420000000, epochMs("1760420000"));
eq("ISO Z", Date.UTC(2026, 9, 17, 8, 0, 0), epochMs("2026-10-17T08:00:00Z"));
eq("ISO 带偏移", Date.UTC(2026, 9, 17, 0, 0, 0), epochMs("2026-10-17T08:00:00+08:00"));
eq("ISO 无时区按 UTC", Date.UTC(2026, 9, 17, 8, 0, 0), epochMs("2026-10-17T08:00:00"));
eq("空值归零", 0, epochMs(""));
eq("坏值归零", 0, epochMs("not-a-date"));

eq("空 Key", "未配置", maskKey(""));
eq("短 Key 全打码", "*****", maskKey("abcdefgh"));
eq("更长短 Key 也全打码", "*****", maskKey("short"));
eq("前缀族 + 后 4 位", "sk-*****7890", maskKey("sk-1234567890"));
eq("cc- 前缀", "cc-*****ghij", maskKey("cc-abcdefghij"));

/* ============================ buildSnapshot ============================ */
group("buildSnapshot");

const WHOAMI = { success: true, org: null, user: { id: "u1", userName: "alice" } };
const SUMMARY = {
  totalCount: 3,
  totalCost: 1.5,
  averageCost: 0.5,
  successRate: 98.4,
  completedCount: 2,
  failedCount: 1,
  totalTokensIn: 100,
  totalTokensOut: 50,
  totalCredits: 3,
  periodBasis: "billing-period",
};
const CREDITS = {
  credits: {
    monthlyCredits: 42.5,
    purchasedCredits: 5,
    freeCredits: 2,
    belowThreshold: false,
    creditThreshold: 10,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 26, cap: 100, exceeded: false, resetAt: 1760420000 },
    weekly: { used: 41, cap: 100, exceeded: false, resetAt: 1760500000 },
  },
};
const SUBS = {
  success: true,
  data: {
    planId: "individual-goat",
    status: "active",
    currentPeriodStart: "2026-10-01T00:00:00Z",
    currentPeriodEnd: "2026-11-01T00:00:00Z",
    cancelAtPeriodEnd: false,
    pendingPhase: null,
  },
};

{
  const snapshot = buildSnapshot({
    whoami: WHOAMI,
    creditsRoot: CREDITS,
    subscriptionRoot: SUBS,
    summaryRoot: SUMMARY,
    apiKey: "user_1234567890",
    fetchedAt: 1000,
  });
  eq("plan id", "individual-goat", snapshot.plan.plan_id);
  eq("套餐名", "GOAT", snapshot.plan.name);
  eq("月额度上限来自本地表", 70, snapshot.plan.monthly_credits);
  eq("月已用 = cap - remaining", 27.5, snapshot.windows.monthly.used);
  eq("月剩余", 42.5, snapshot.windows.monthly.remaining);
  check(
    "月 remaining_pct 约 60.714",
    Math.abs(snapshot.windows.monthly.remaining_pct - (42.5 / 70) * 100) < 1e-9,
    String(snapshot.windows.monthly.remaining_pct),
  );
  eq("月窗口可用", true, snapshot.windows.monthly.available);
  eq("5h remaining", 74, snapshot.windows.five_hour.remaining);
  eq("5h remaining_pct", 74, snapshot.windows.five_hour.remaining_pct);
  eq("周 remaining", 59, snapshot.windows.weekly.remaining);
  eq("account name 取 userName", "alice", snapshot.account.name);
  eq("org_id 空", "", snapshot.account.org_id);
  eq("masked_key 不露完整 Key", "*****7890", snapshot.account.masked_key);
  eq("studio URL 用 userName", "https://commandcode.ai/alice/settings/usage", snapshot.studio_url);
  eq("usage total_count", 3, snapshot.usage.total_count);
  eq("usage success_rate", 98.4, snapshot.usage.success_rate);
  eq("credits monthly_remaining", 42.5, snapshot.credits.monthly_remaining);
  deep("没有告警", [], snapshot.alerts);
}

{
  const snapshot = buildSnapshot({
    whoami: WHOAMI,
    creditsRoot: CREDITS,
    subscriptionRoot: {
      data: { ...SUBS.data, planId: "individual-mystery" },
    },
    summaryRoot: SUMMARY,
    fetchedAt: 1000,
  });
  eq("未知套餐不推算月上限", null, snapshot.plan.monthly_credits);
  eq("未知套餐月窗口不可用", false, snapshot.windows.monthly.available);
  check(
    "未知套餐 note 说明不推算",
    snapshot.windows.monthly.note.includes("未知套餐不推算上限"),
    snapshot.windows.monthly.note,
  );
  eq("未知套餐仍显示剩余", 42.5, snapshot.windows.monthly.remaining);
}

{
  const snapshot = buildSnapshot({
    whoami: WHOAMI,
    creditsRoot: {
      ...CREDITS,
      windowLimits: { ...CREDITS.windowLimits, limited: false },
    },
    subscriptionRoot: SUBS,
    summaryRoot: SUMMARY,
    fetchedAt: 1000,
  });
  eq("limited=false 时 5h 不可用", false, snapshot.windows.five_hour.available);
  eq("limited=false 时周不可用", false, snapshot.windows.weekly.available);
  eq(
    "limited=false 的 note",
    "当前套餐不受此窗口限制",
    snapshot.windows.five_hour.note,
  );
  eq("月窗口仍按套餐表计算", true, snapshot.windows.monthly.available);
}

{
  const previousUsage = normalizeUsage({ totalCount: 9, totalCost: 2 });
  const snapshot = buildSnapshot({
    whoami: WHOAMI,
    creditsRoot: CREDITS,
    subscriptionRoot: SUBS,
    summaryRoot: null,
    previousUsage,
    fetchedAt: 1000,
  });
  eq("summary 失败时保留上次 usage", 9, snapshot.usage.total_count);
  eq("summary 失败时保留上次 cost", 2, snapshot.usage.total_cost);

  const noPrev = buildSnapshot({ whoami: WHOAMI, creditsRoot: CREDITS, subscriptionRoot: SUBS });
  eq("summary 失败且无历史时 usage 归零", 0, noPrev.usage.total_count);
}

{
  const snapshot = buildSnapshot({
    whoami: WHOAMI,
    creditsRoot: {
      credits: {
        monthlyCredits: 0,
        purchasedCredits: 0,
        freeCredits: 0,
        belowThreshold: true,
        creditThreshold: 10,
      },
      windowLimits: {
        limited: true,
        exceeded: "fiveHour",
        fiveHour: { used: 100, cap: 100, exceeded: true, resetAt: 1760420000 },
        weekly: { used: 100, cap: 100, exceeded: true, resetAt: 1760500000 },
      },
    },
    subscriptionRoot: {
      data: { ...SUBS.data, cancelAtPeriodEnd: true, pendingPhase: { planId: "x" } },
    },
    summaryRoot: SUMMARY,
    fetchedAt: 1000,
  });
  deep(
    "告警顺序与文案",
    snapshot.alerts.map((alert) => alert.message),
    [
      "当前受限窗口：fiveHour",
      "5 小时额度已用尽，请等待窗口重置。",
      "本周额度已用尽，请等待周额度重置。",
      "本月额度已用尽。",
      "账户余额已低于预警阈值。",
      "订阅将在当前账期结束后取消。",
      "账户存在待生效的套餐变更。",
    ],
  );
}

/* ============================ 明细 / 图表（P1 纯函数） ============================ */
group("normalizeUsageRecord / ChartBucket");

{
  const record = normalizeUsageRecord({
    id: "r1",
    createdAt: "2026-10-17T00:00:00Z",
    tokensIn: 10,
    tokensOut: 5,
    durationTotal: 1200,
    status: "ok",
    type: "chat",
    mode: "standard",
    meta: {
      model: "m",
      totalCost: 0.1,
      inputCost: 0.04,
      outputCost: 0.06,
      cacheCost: 0.01,
      traceId: "t1",
    },
  });
  eq("记录 id", "r1", record.id);
  eq("记录模型", "m", record.model);
  eq("记录 tokens_in", 10, record.tokens_in);
  eq("记录 cost_total", 0.1, record.cost_total);
  eq("记录 trace", "t1", record.trace_id);
  eq("缺 id 丢弃", null, normalizeUsageRecord({ createdAt: "x", meta: {} }));
  eq("缺 createdAt 丢弃", null, normalizeUsageRecord({ id: "x", meta: {} }));
}

{
  const bucket = normalizeChartBucket({
    model: "m",
    timeBucket: "2026-10-17T00:00:00Z",
    requests: 2,
    tokensIn: 10,
    tokensOut: 5,
    tokensTotal: 15,
    cacheReadInputTokens: 7,
    cacheCreationInputTokens: 3,
    totalCost: 0.2,
    cacheCost: 0.01,
    cacheSavings: 0.04,
  });
  eq("图表桶模型", "m", bucket.model);
  eq("图表桶时间", "2026-10-17T00:00:00Z", bucket.time_bucket);
  eq("图表桶 cache read", 7, bucket.cache_read_tokens);
  eq("图表桶 cache write", 3, bucket.cache_write_tokens);
  eq("缺模型丢弃", null, normalizeChartBucket({ timeBucket: "x" }));
  eq("缺时间桶丢弃", null, normalizeChartBucket({ model: "m" }));
}

/* ============================ schedule ============================ */
group("schedule.nextDelay");

{
  const now = 1_000_000;
  eq("rand=0.5 不抖", 60_000, nextDelay({}, now, { refreshSec: 60 }, () => 0.5));
  eq("rand=0 下抖 10%", 54_000, nextDelay({}, now, { refreshSec: 60 }, () => 0));
  eq("rand=1 上抖 10%", 66_000, nextDelay({}, now, { refreshSec: 60 }, () => 1));
  eq("refreshSec 下限 30", 30_000, nextDelay({}, now, { refreshSec: 1 }, () => 0.5));
  eq("refreshSec 上限 600", 600_000, nextDelay({}, now, { refreshSec: 10_000 }, () => 0.5));
}

{
  const now = 1_000_000;
  eq("无变化 3 次开始 ×1.5", 90_000, nextDelay({ noChangeCount: 3 }, now, { refreshSec: 60 }, () => 0.5));
  eq("无变化退避上限 10 分钟", 600_000, nextDelay({ noChangeCount: 10 }, now, { refreshSec: 60 }, () => 0.5));
  eq("无变化 2 次仍用基础间隔", 60_000, nextDelay({ noChangeCount: 2 }, now, { refreshSec: 60 }, () => 0.5));
}

{
  const now = 1_000_000;
  eq(
    "冷却优先于退避",
    120_000,
    nextDelay({ cooldownUntil: now + 120_000, noChangeCount: 10 }, now, { refreshSec: 60 }, () => 0),
  );
  eq("authError 停止轮询", null, nextDelay({ authError: true }, now, { refreshSec: 60 }));
}

{
  const now = 1_000_000;
  const windows = { five_hour: { reset_at: now + 30_000 } };
  eq(
    "reset_at 抢先刷新",
    35_000,
    nextDelay({}, now, { refreshSec: 60 }, () => 0.5, windows),
  );
  eq(
    "已过 reset 且本窗未刷新时 5 秒补一次",
    5_000,
    nextDelay({ lastRefreshAt: now - 60_000 }, now, { refreshSec: 60 }, () => 0.5, {
      five_hour: { reset_at: now - 1_000 },
    }),
  );
  eq(
    "本窗已刷新过则不补",
    60_000,
    nextDelay({ lastRefreshAt: now }, now, { refreshSec: 60 }, () => 0.5, {
      five_hour: { reset_at: now - 1_000 },
    }),
  );
}

group("schedule.agentState");
{
  const now = 1_000_000;
  eq("running 基础 30s", 30_000, nextDelay({ agentRunning: true }, now, { refreshSec: 300 }, () => 0.5));
  eq(
    "running 不受无变化退避",
    30_000,
    nextDelay({ agentRunning: true, noChangeCount: 5 }, now, { refreshSec: 300 }, () => 0.5),
  );
  eq("idle 恢复默认间隔", 300_000, nextDelay({ agentRunning: false }, now, { refreshSec: 300 }, () => 0.5));
  eq("缺省 agentRunning 保持默认", 300_000, nextDelay({}, now, { refreshSec: 300 }, () => 0.5));
  eq("AGENT_RUNNING_REFRESH_SEC", 30, AGENT_RUNNING_REFRESH_SEC);
  eq("scheduleBaseSec running", 30, scheduleBaseSec(true, 300));
  eq("scheduleBaseSec idle", 300, scheduleBaseSec(false, 300));
  eq("TOPIC_AGENT_STATE 精确", "agent:state", TOPIC_AGENT_STATE);

  const mainSrc = readFileSync(new URL("../../plugins/com.pet.goat-gauge/main.js", import.meta.url), "utf8");
  eq("main 精确订阅 TOPIC_AGENT_STATE", true, mainSrc.includes("ctx.bus.subscribe(TOPIC_AGENT_STATE"));
  eq("main 读取 agent:state 的 running", true, mainSrc.includes('payload?.state === "running"'));
  const subAt = mainSrc.indexOf("ctx.bus.subscribe(TOPIC_AGENT_STATE");
  const handler = mainSrc.slice(subAt, subAt + 600);
  eq("main 更新 agentRunning", true, handler.includes("agentRunning = running;"));
  eq("main 状态变化重排", true, /agentRunning = running;[\s\S]*scheduleNext\(\)/.test(handler));
}

/* ============================ alerts ============================ */
group("alerts.evaluate");

function windowOf(kind, { pct = 100, exceeded = false, resetAt = 5000 } = {}) {
  return {
    kind,
    label: kind,
    used: 100 - pct,
    cap: 100,
    remaining: pct,
    remaining_pct: pct,
    exceeded,
    reset_at: resetAt,
    available: true,
    note: "",
  };
}

function snap({
  fivePct = 100,
  fiveExceeded = false,
  weeklyPct = 100,
  weeklyExceeded = false,
  monthlyPct = 100,
  monthlyExceeded = false,
  below = false,
  fiveReset = 5000,
  weeklyReset = 9000,
  monthlyReset = 13_000,
} = {}) {
  return {
    fetched_at: 100,
    windows: {
      five_hour: windowOf("five_hour", { pct: fivePct, exceeded: fiveExceeded, resetAt: fiveReset }),
      weekly: windowOf("weekly", { pct: weeklyPct, exceeded: weeklyExceeded, resetAt: weeklyReset }),
      monthly: windowOf("monthly", {
        pct: monthlyPct,
        exceeded: monthlyExceeded,
        resetAt: monthlyReset,
      }),
    },
    credits: { below_threshold: below },
    plan: { current_period_end: 13_000 },
    usage: { total_count: 1, total_cost: 1, tokens_in: 1, tokens_out: 1 },
  };
}

const ALERT_CFG = { thresholds: { fiveHourPct: [20, 5], weeklyPct: [20], monthlyPct: [10] } };

{
  const now = 1000;
  const reset = now + 72 * 60_000;
  const prev = snap({ fivePct: 25, fiveReset: reset });
  const next = snap({ fivePct: 18, fiveReset: reset });
  const result = evaluate(prev, next, ALERT_CFG, {}, { now });
  eq("阈值穿越只发一条", 1, result.toFire.length);
  eq("阈值类型", "threshold", result.toFire[0].kind);
  eq("5 小时 warning", "warning", result.toFire[0].level);
  eq("宠物 waiting", "waiting", result.toFire[0].pet);
  check("文案带百分比", result.toFire[0].message.includes("18%"), result.toFire[0].message);
  check("文案带倒计时", result.toFire[0].message.includes("1:12"), result.toFire[0].message);
  check("fired 记下 key", Boolean(result.firedNext[result.toFire[0].key]), "missing key");

  const again = evaluate(next, snap({ fivePct: 16, fiveReset: reset }), ALERT_CFG, result.firedNext, {
    now,
  });
  eq("同一窗口不重复", 0, again.toFire.filter((e) => e.kind === "threshold").length);

  // 只靠 fired 表去重：prev 丢失（重启/换快照）但 fired 还在时，同 key 不能再发。
  const firedOnly = evaluate(
    null,
    snap({ fivePct: 18, fiveReset: reset }),
    ALERT_CFG,
    { [`five_hour:20:${reset}`]: now },
    { now },
  );
  eq("fired 表拦住同 key 重复", 0, firedOnly.toFire.length);

  const newWindow = evaluate(next, snap({ fivePct: 15, fiveReset: reset + 60_000 }), ALERT_CFG, again.firedNext, {
    now,
  });
  check(
    "reset_at 变化后重新开放",
    newWindow.toFire.some((e) => e.kind === "threshold"),
    JSON.stringify(newWindow.toFire),
  );
}

{
  const result = evaluate(snap({ fivePct: 1, fiveExceeded: false }), snap({ fivePct: 0, fiveExceeded: true }), ALERT_CFG, {}, { now: 1000 });
  const exceeded = result.toFire.find((e) => e.kind === "exceeded");
  eq("用尽事件 danger", "danger", exceeded?.level);
  eq("用尽宠物 failed", "failed", exceeded?.pet);
  check("用尽文案", exceeded?.message.includes("已用尽"), exceeded?.message);
  eq("用尽时不重复发阈值", 1, result.toFire.length);
}

{
  const result = evaluate(null, snap({ fivePct: 18 }), ALERT_CFG, {}, { suppress: true, now: 1000 });
  eq("首次激活不补发", 0, result.toFire.length);
  check("首次激活写入 fired", Object.keys(result.firedNext).length > 0, "empty fired");
}

{
  const result = evaluate(
    snap({ below: false }),
    snap({ below: true }),
    ALERT_CFG,
    {},
    { now: 1000 },
  );
  const low = result.toFire.find((e) => e.kind === "credit_low");
  eq("余额低 warning", "warning", low?.level);
  eq("余额低宠物 review", "review", low?.pet);
}

{
  const result = evaluate(
    snap({ fiveReset: 5000 }),
    snap({ fiveReset: 6000 }),
    ALERT_CFG,
    {},
    { now: 1000 },
  );
  const reset = result.toFire.find((e) => e.kind === "reset");
  eq("窗口重置 info", "info", reset?.level);
  eq("窗口重置宠物 jumping", "jumping", reset?.pet);
  eq("窗口重置不通知", false, reset?.notify);
}

{
  const event = authEvent(1234, 999);
  eq("凭据失效 key 按保存时间", "auth:1234", event.key);
  eq("凭据失效 danger", "danger", event.level);
  eq("凭据失效宠物 failed", "failed", event.pet);
}

/* ============================ history ============================ */
group("history");

{
  const snapshot = {
    fetched_at: 10_000,
    windows: {
      five_hour: { remaining_pct: 63 },
      weekly: { remaining_pct: 59 },
      monthly: { remaining: 42.5 },
    },
    usage: { total_cost: 1.23, tokens_in: 120, tokens_out: 45 },
  };
  deep("紧凑点字段顺序", samplePoint(snapshot, 10_000), [10_000, 63, 59, 42.5, 1.23, 120, 45]);
  const first = appendHistory([], snapshot, 10_000);
  eq("首点", 1, first.length);
  const tooSoon = appendHistory(first, snapshot, 10_000 + 1_000);
  eq("5 分钟内不重复采样", first, tooSoon);
  const later = appendHistory(first, { ...snapshot, fetched_at: 10_000 + 300_000 }, 10_000 + 300_000);
  eq("5 分钟后追加", 2, later.length);
}

{
  const now = 48 * 60 * 60 * 1000 + 10_000;
  const old = [now - 49 * 60 * 60 * 1000, 1, 1, 1, 1, 1, 1];
  const snapshot = {
    fetched_at: now,
    windows: { five_hour: {}, weekly: {}, monthly: {} },
    usage: {},
  };
  const next = appendHistory([old], snapshot, now, { sampleMs: 0, windowMs: 48 * 60 * 60 * 1000 });
  eq("48 小时外裁剪", 1, next.length);
  eq("保留的是新点", now, next[0][0]);
}

{
  const history = Array.from({ length: 3 }, (_, i) => [i + 1, 1, 1, 1, 1, 1, 1]);
  const snapshot = {
    fetched_at: 4,
    windows: { five_hour: {}, weekly: {}, monthly: {} },
    usage: {},
  };
  const next = appendHistory(history, snapshot, 4, { sampleMs: 0, maxPoints: 3, windowMs: 1000 });
  eq("环形上限", 3, next.length);
  eq("上限保留最后一点", 4, next.at(-1)[0]);
}

{
  eq(
    "UTC 晚 8 点在上海是次日",
    "2026-10-18",
    localDayKey(Date.UTC(2026, 9, 17, 20, 0, 0), "Asia/Shanghai"),
  );
  eq(
    "同一时刻在 UTC 是当天",
    "2026-10-17",
    localDayKey(Date.UTC(2026, 9, 17, 20, 0, 0), "UTC"),
  );
  eq(
    "UTC 桶转本地日",
    "2026-10-18",
    bucketToLocalDay("2026-10-17T20:00:00Z", "Asia/Shanghai"),
  );
  eq("坏时间桶丢弃", "", bucketToLocalDay("not-a-date"));
}

/* ============================ format ============================ */
group("format");

eq("credits 不换算", "42.5", fmtCredits(42.5));
eq("credits 整数", "10", fmtCredits(10));
eq("credits 坏值", "—", fmtCredits(NaN));
eq("USD 金额", "$1.23", fmtMoney(1.23));
eq("CNY 只换 cost", "¥8.86", fmtMoney(1.23, { currency: "CNY", usdToCny: 7.2 }));
eq("tokens k", "1.2k", fmtTokens(1_200));
eq("tokens M", "1.2M", fmtTokens(1_200_000));
eq("tokens 小数", "999", fmtTokens(999));
eq("倒计时 h:mm", "1:12", fmtCountdown(72 * 60_000, 0));
eq("倒计时归零", "0:00", fmtCountdown(0, 1_000));
eq("百分比取整", "63%", fmtPct(62.6));
eq("百分比坏值", "—", fmtPct(null));

/* ============================ write dedupe ============================ */
group("write dedupe");

{
  function fakeNode() {
    const counts = { text: 0, class: 0, attr: 0, dataset: 0 };
    let textValue = "";
    let classValue = "";
    const attrs = new Map();
    const data = {};
    return {
      counts,
      get textContent() {
        return textValue;
      },
      set textContent(value) {
        textValue = String(value);
        counts.text += 1;
      },
      get className() {
        return classValue;
      },
      set className(value) {
        classValue = String(value);
        counts.class += 1;
      },
      setAttribute(name, value) {
        attrs.set(name, value);
        counts.attr += 1;
      },
      dataset: new Proxy(data, {
        set(target, key, value) {
          target[key] = value;
          counts.dataset += 1;
          return true;
        },
        get(target, key) {
          return target[key];
        },
      }),
    };
  }

  const node = fakeNode();
  const cache = {};
  setTextIfChanged(node, "same", cache, "t");
  eq("首次文本写入 > 0", 1, node.counts.text);
  setTextIfChanged(node, "same", cache, "t");
  eq("相同文本不写", 1, node.counts.text);
  setTextIfChanged(node, "changed", cache, "t");
  eq("文本变化写入", 2, node.counts.text);

  setClassIfChanged(node, "a", cache);
  eq("首次 class 写入", 1, node.counts.class);
  setClassIfChanged(node, "a", cache);
  eq("相同 class 不写", 1, node.counts.class);
  setClassIfChanged(node, "b", cache);
  eq("class 变化写入", 2, node.counts.class);

  const both = fakeNode();
  const bothCache = {};
  setTextIfChanged(both, "x", bothCache, "t");
  setClassIfChanged(both, "y", bothCache);
  eq("文本和 class 都改：文本写入", 1, both.counts.text);
  eq("文本和 class 都改：class 写入", 1, both.counts.class);

  const attr = fakeNode();
  const attrCache = {};
  setAttrIfChanged(attr, "d", "M0 0", attrCache);
  setAttrIfChanged(attr, "d", "M0 0", attrCache);
  eq("相同 SVG 属性不写", 1, attr.counts.attr);
  setAttrIfChanged(attr, "d", "M1 1", attrCache);
  eq("SVG 属性变化写入", 2, attr.counts.attr);

  const dataNode = fakeNode();
  const dataCache = {};
  setDatasetIfChanged(dataNode, "state", "ok", dataCache);
  setDatasetIfChanged(dataNode, "state", "ok", dataCache);
  eq("相同 dataset 不写", 1, dataNode.counts.dataset);
  setDatasetIfChanged(dataNode, "state", "bad", dataCache);
  eq("dataset 变化写入", 2, dataNode.counts.dataset);
}

/* ============================ store-schema ============================ */
group("store-schema");

{
  const config = sanitizeConfig({
    refreshSec: 10,
    currency: "EUR",
    usdToCny: 100,
    thresholds: { fiveHourPct: [30, "x", 5], weeklyPct: [], monthlyPct: null },
    showOverlay: "no",
    badgeMode: "bad",
    demo: "yes",
    petReact: false,
    overlayX: Number.NaN,
  });
  eq("refreshSec 下限", 30, config.refreshSec);
  eq("缺 refreshSec 回落默认", DEFAULT_CONFIG.refreshSec, sanitizeConfig({}).refreshSec);
  eq(
    "坏 refreshSec 回落默认",
    DEFAULT_CONFIG.refreshSec,
    sanitizeConfig({ refreshSec: "x" }).refreshSec,
  );
  eq("非法币种回落 USD", "USD", config.currency);
  eq("汇率上限", 20, config.usdToCny);
  deep("阈值过滤并降序", [30, 5], config.thresholds.fiveHourPct);
  deep("空阈值回落默认", DEFAULT_CONFIG.thresholds.weeklyPct, config.thresholds.weeklyPct);
  eq("非布尔 showOverlay 回落默认", true, config.showOverlay);
  eq("非法 badgeMode 回落", "five_hour", config.badgeMode);
  eq("demo 只认真布尔", false, config.demo);
  eq("petReact=false 保留", false, config.petReact);
  eq("非法坐标回落", 360, config.overlayX);
  eq(
    "旧 cost_today 迁移为 cost_period",
    "cost_period",
    sanitizeConfig({ badgeMode: "cost_today" }).badgeMode,
  );
  eq(
    "cost_period 合法",
    "cost_period",
    sanitizeConfig({ badgeMode: "cost_period" }).badgeMode,
  );
  check("BADGE_MODES 不再含 cost_today", true, !BADGE_MODES.includes("cost_today"));
}

{
  const cred = sanitizeCred({ apiKey: "  abc  ", savedAt: "x" });
  eq("cred 去空白", "abc", cred.apiKey);
  eq("savedAt 坏值归零", 0, cred.savedAt);
  eq("超长 Key 丢弃", "", sanitizeCred({ apiKey: "x".repeat(300) }).apiKey);
  eq("非字符串 Key 丢弃", "", sanitizeCred({ apiKey: 123 }).apiKey);
}

eq(
  "快照缺 windows 丢弃",
  null,
  sanitizeSnapshot({ fetched_at: 1 }),
);
check(
  "合法快照保留",
  sanitizeSnapshot({ fetched_at: 1, windows: {} }) !== null,
  "null",
);

{
  const history = sanitizeHistory([
    [1, 1, 1, 1, 1, 1, 1],
    [2, 1, 1],
    ["x", 1, 1, 1, 1, 1, 1],
    [3, null, 1, 1, 1, 1, 1],
  ]);
  eq("history 只保留合法行", 2, history.length);
  eq("history 保留 null 占位", null, history[1][1]);
}

{
  const fired = sanitizeAlertsFired({ a: 1, b: "x", c: 2 });
  eq("alertsFired 保留 a", 1, fired.a);
  eq("alertsFired 丢弃坏值 b", undefined, fired.b);
  eq("alertsFired 保留 c", 2, fired.c);
}

{
  const store = migrate({
    schema: 1,
    refreshSec: 45,
    demo: true,
    apiKey: "user_abc",
    snapshot: { fetched_at: 1, windows: {} },
    history: [[1, 1, 1, 1, 1, 1, 1]],
    alertsFired: { "five_hour:20:1": 1 },
  });
  eq("迁移后 schema=2", SCHEMA_VERSION, store.schema);
  eq("迁移旧顶层 refreshSec", 45, store.config.refreshSec);
  eq("迁移旧顶层 demo", true, store.config.demo);
  eq("迁移旧顶层 apiKey", "user_abc", store.cred.apiKey);
  eq("迁移快照", 1, store.snapshot.fetched_at);
  eq("迁移 history", 1, store.history.length);
  eq("迁移 alertsFired", 1, store.alertsFired["five_hour:20:1"]);
}

/* ============================ demo ============================ */
group("demo");

{
  deep("演示场景枚举", DEMO_SCENARIOS, ["normal", "low", "exhausted"]);
  const normal = demoSnapshot(1_000_000, "normal");
  eq("演示默认 5h 63%", 63, normal.windows.five_hour.remaining_pct);
  eq("演示周 59%", 59, normal.windows.weekly.remaining_pct);
  eq("演示套餐 GOAT", "GOAT", normal.plan.name);
  eq("演示账户", "演示账户", normal.account.name);
  eq("演示无告警", 0, normal.alerts.length);

  const low = demoSnapshot(1_000_000, "low");
  eq("low 5h 15%", 15, low.windows.five_hour.remaining_pct);
  const exhausted = demoSnapshot(1_000_000, "exhausted");
  eq("exhausted 5h 0%", 0, exhausted.windows.five_hour.remaining_pct);
  eq("exhausted 窗口用尽", true, exhausted.windows.five_hour.exceeded);
  eq("exhausted 带告警", 1, exhausted.alerts.length);
  eq("非法场景回落 normal", 63, demoSnapshot(1_000_000, "bogus").windows.five_hour.remaining_pct);
}

/* ============================ 辅助导出 ============================ */
group("辅助导出");

eq("boolOf 字符串 true", true, boolOf("TRUE"));
eq("boolOf 数字 1 不认", false, boolOf(1));
eq("normalizeCredits 兼容 window_limits", true, (() => {
  const { limits } = normalizeCredits({ data: { window_limits: { limited: true } } });
  return limits.limited === true;
})());

/* ============================ C06 secrets 迁移与认证隔离 ============================ */
group("C06 secrets 迁移与认证隔离");

function fakeSecrets(initial = {}) {
  const store = { ...initial };
  const calls = [];
  return {
    store,
    calls,
    async get(key) {
      calls.push(`get:${key}`);
      return store[key] ?? null;
    },
    async set(key, value) {
      calls.push(`set:${key}`);
      store[key] = value;
    },
    async delete(key) {
      calls.push(`delete:${key}`);
      delete store[key];
    },
  };
}

function fakeStorage() {
  const store = {};
  const calls = [];
  return {
    store,
    calls,
    async set(key, value) {
      calls.push(`set:${key}`);
      store[key] = value;
    },
  };
}

await (async () => {
  const secrets = fakeSecrets();
  const storage = fakeStorage();
  const result = await migrateSecrets({
    legacy: { apiKey: "fake-key", cookie: "fake-cookie", savedAt: 123 },
    secrets,
    storage,
  });
  deep("迁移成功两项", result.migrated, ["apiKey", "cookie"]);
  eq("迁移后 secret apiKey", "fake-key", secrets.store.apiKey);
  eq("迁移后 secret cookie", "fake-cookie", secrets.store.cookie);
  deep("迁移成功标记只含非敏感字段", storage.store.cred, { savedAt: 123, secured: true });
  check(
    "迁移顺序：copy→verify→clear",
    secrets.calls.join("|") === "get:apiKey|set:apiKey|get:apiKey|get:cookie|set:cookie|get:cookie" &&
      storage.calls.join("|") === "set:cred",
    secrets.calls.join("|") + " / " + storage.calls.join("|"),
  );
  check(
    "迁移标记不含凭据值",
    !JSON.stringify(storage.store).includes("fake-key") &&
      !JSON.stringify(storage.store).includes("fake-cookie"),
    JSON.stringify(storage.store),
  );
})();

await (async () => {
  const secrets = fakeSecrets();
  const storage = fakeStorage();
  // set 成功但读回不一致：不得写标记/清明文
  secrets.get = async (key) => (secrets.store[key] ? "wrong" : null);
  const result = await migrateSecrets({
    legacy: { apiKey: "fake-key" },
    secrets,
    storage,
  });
  check("verify 失败：不清明文", storage.calls.length === 0, storage.calls.join("|"));
  check("verify 失败：如实返回 failed", result.failed.includes("apiKey"), result.failed.join(","));
})();

await (async () => {
  const secrets = fakeSecrets({ apiKey: "other-value" });
  const storage = fakeStorage();
  const result = await migrateSecrets({
    legacy: { apiKey: "fake-key", savedAt: 5 },
    secrets,
    storage,
  });
  eq("冲突：不覆盖 secret", "other-value", secrets.store.apiKey);
  check("冲突：不调用 set", !secrets.calls.includes("set:apiKey"), secrets.calls.join("|"));
  deep("冲突：仍清明文并留标记", storage.store.cred, { savedAt: 5, secured: true, conflict: true });
  deep("冲突：如实返回", result.conflicts, ["apiKey"]);
})();

await (async () => {
  let setAttempts = 0;
  const secrets = {
    store: {},
    calls: [],
    async get(key) {
      this.calls.push(`get:${key}`);
      return this.store[key] ?? null;
    },
    async set(key, value) {
      setAttempts += 1;
      this.calls.push(`set:${key}`);
      if (setAttempts === 1) throw new Error("transient");
      this.store[key] = value;
    },
    async delete(key) {
      this.calls.push(`delete:${key}`);
      delete this.store[key];
    },
  };
  const storage = fakeStorage();
  const result = await migrateSecrets({
    legacy: { apiKey: "fake-key" },
    secrets,
    storage,
    attempts: 2,
    delayMs: 0,
  });
  check("瞬时失败重试后成功", result.migrated.includes("apiKey") && secrets.store.apiKey === "fake-key");
  eq("重试后写标记", "set:cred", storage.calls[0]);
})();

await (async () => {
  const secrets = fakeSecrets({ apiKey: "keep-key", cookie: "fake-cookie" });
  const storage = fakeStorage();
  const result = await clearCookieAfterAuthFailure({ secrets, storage });
  deep("internal 401 只删 Cookie", secrets.calls, ["delete:cookie"]);
  eq("internal 401 后 Key 保留", "keep-key", secrets.store.apiKey);
  eq("internal 401 后 Cookie 清空", undefined, secrets.store.cookie);
  eq("internal 401 状态", "expired", result.cookieState);
  eq("internal 401 标记", "expired", storage.store.cookieState);
})();

deep(
  "internal 请求头含 Cookie/Origin/Referer",
  internalHeaders("fake-cookie"),
  [
    ["accept", "application/json"],
    ["user-agent", "DesktopPet-GOATGauge/0.1"],
    ["cookie", "fake-cookie"],
    ["origin", INTERNAL_ORIGIN],
    ["referer", INTERNAL_REFERER],
  ],
);
check(
  "Key 请求头不含 Cookie",
  !JSON.stringify(keyHeaders("fake-key")).toLowerCase().includes("cookie"),
  JSON.stringify(keyHeaders("fake-key")),
);
eq("internal 401 分类", "expired", classifyInternalStatus(401));
eq("internal 403 分类", "expired", classifyInternalStatus(403));
eq("internal 429 分类", "throttle", classifyInternalStatus(429));
eq("internal 200 分类", "ok", classifyInternalStatus(200));
eq("internal 500 分类", "upstream", classifyInternalStatus(500));

check(
  "internal 非白名单路径拒绝",
  (() => {
    try {
      assertInternalPath("/internal/other");
      return false;
    } catch {
      return true;
    }
  })(),
  "/internal/other 未被拒",
);
deep("Key 模式只读 apiKey", KEY_MODE_SECRETS, ["apiKey"]);
check("Key 模式不读 cookie", isKeyModeSecret("apiKey") && !isKeyModeSecret("cookie"));

group("C06 internal 翻页与请求");

{
  const pages = [
    {
      records: [
        { id: "a", createdAt: "2026-01-01T00:00:00Z", meta: { model: "m" } },
        { id: "b", createdAt: "2026-01-02T00:00:00Z" },
      ],
    },
    {
      data: [
        { id: "a", createdAt: "2026-01-03T00:00:00Z" },
        { id: "c", createdAt: "2026-01-01T12:00:00Z" },
      ],
    },
  ];
  const merged = mergeUsagePages(pages);
  deep("records 跨页去重 + 按时间降序", merged.map((record) => record.id), ["a", "b", "c"]);
  eq("records 上限生效", 2, mergeUsagePages(pages, { limit: 2 }).length);
  check("records 缺 id 丢弃", merged.every((record) => typeof record.id === "string" && record.id.length > 0));
}

{
  const page = { records: [{ id: "a" }], nextCursor: "next" };
  eq("有新 id 时继续翻页", "next", nextPageCursor(page, new Set()));
  eq("无新 id 时停止翻页", null, nextPageCursor(page, new Set(["a"])));
  eq("空页停止翻页", null, nextPageCursor({ records: [], nextCursor: "x" }, new Set()));
}

{
  const request = buildInternalRequest("/internal/usage", "fake-cookie", {
    cursor: "abc",
    orgId: "o1",
  });
  eq("internal URL", "https://api.commandcode.ai/internal/usage?cursor=abc&orgId=o1", request.url);
  check(
    "internal Cookie 只在请求头",
    request.headers.some(([key, value]) => key === "cookie" && value === "fake-cookie") &&
      !request.url.includes("fake-cookie"),
  );
  check(
    "internal 拒绝非白名单路径",
    (() => {
      try {
        buildInternalRequest("/internal/other", "fake-cookie");
        return false;
      } catch {
        return true;
      }
    })(),
  );
}

{
  const charts = mergeChartBuckets([
    { data: [{ model: "m", timeBucket: "2026-01-01", requests: 1 }] },
    {
      data: [
        { model: "m", timeBucket: "2026-01-01", requests: 2 },
        { model: "m", timeBucket: "2026-01-02", requests: 1 },
      ],
    },
  ]);
  eq("charts 按 model+time_bucket 去重", 2, charts.length);
  eq("charts 后到页为准", 2, charts.find((bucket) => bucket.time_bucket === "2026-01-01").requests);
}
