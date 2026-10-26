// 演示快照：确定性种子，供设置页「演示数据」和 e2e 使用。不出网。
// five_hour 默认 63% 是 e2e 断言值；exhausted/low 用来触发告警路径。
import { localDayKey } from "./history.js";
import { buildSnapshot } from "./normalize.js";

/** @type {string[]} */
export const DEMO_SCENARIOS = ["normal", "low", "exhausted"];

/**
 * @param {number} now
 * @param {string} scenario
 * @returns {Record<string, any>}
 */
export function demoSnapshot(now = Date.now(), scenario = "normal") {
  const mode = DEMO_SCENARIOS.includes(scenario) ? scenario : "normal";
  const fiveUsed = mode === "exhausted" ? 100 : mode === "low" ? 85 : 37;
  const fiveExceeded = fiveUsed >= 100;

  return buildSnapshot({
    whoami: {
      success: true,
      org: null,
      user: {
        id: "demo-user",
        name: "演示账户",
        userName: "演示账户",
        email: "demo@example.com",
      },
    },
    creditsRoot: {
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
        fiveHour: {
          used: fiveUsed,
          cap: 100,
          exceeded: fiveExceeded,
          resetAt: now + 72 * 60_000,
        },
        weekly: {
          used: 41,
          cap: 100,
          exceeded: false,
          resetAt: now + 3 * 86_400_000,
        },
      },
    },
    subscriptionRoot: {
      success: true,
      data: {
        planId: "individual-goat",
        status: "active",
        currentPeriodStart: new Date(now - 12 * 86_400_000).toISOString(),
        currentPeriodEnd: new Date(now + 18 * 86_400_000).toISOString(),
        cancelAtPeriodEnd: false,
        pendingPhase: null,
      },
    },
    summaryRoot: {
      totalCount: 128,
      totalCost: 1.23,
      averageCost: 0.0096,
      successRate: 98.4,
      completedCount: 126,
      failedCount: 2,
      totalTokensIn: 120_000,
      totalTokensOut: 45_000,
      totalCredits: 12.3,
      periodBasis: "billing-period",
    },
    apiKey: "demo",
    fetchedAt: now,
  });
}

const DEMO_DAY_MS = 86_400_000;

/**
 * 演示用的 daily/charts：固定分子分母，供概览缓存 KPI 复算。
 * 分子 cache_read_tokens = 1500，分母 tokens_in = 3000，命中率 1/3（33.33%）。
 * 日期按计费周期起点取，保证周期首日/次日 now 也落在窗口内；不读写真实数据。
 * @param {number} now
 * @param {string} scenario
 * @param {string|undefined} timeZone
 * @param {number} periodStart
 * @returns {{daily: Array<Record<string, any>>, charts_by_day: Record<string, Array<Record<string, any>>>}}
 */
export function demoViewData(now = Date.now(), scenario = "normal", timeZone = undefined, periodStart = now - 12 * DEMO_DAY_MS) {
  const start = Number.isFinite(periodStart) ? periodStart : now - 12 * DEMO_DAY_MS;
  const first = now - DEMO_DAY_MS >= start ? now - DEMO_DAY_MS : start;
  const second = now - 2 * DEMO_DAY_MS >= start ? now - 2 * DEMO_DAY_MS : first;
  const day1 = localDayKey(first, timeZone);
  const day2 = localDayKey(second, timeZone);

  const daily = [
    {
      day: day1,
      at_ms: first,
      requests: 4,
      tokens_in: 1200,
      tokens_out: 300,
      cost_total: 0.12,
      by_model: { deepseek: { requests: 4, tokens_in: 1200, tokens_out: 300, cost_total: 0.12 } },
    },
    {
      day: day2,
      at_ms: second,
      requests: 6,
      tokens_in: 1800,
      tokens_out: 450,
      cost_total: 0.18,
      by_model: { deepseek: { requests: 6, tokens_in: 1800, tokens_out: 450, cost_total: 0.18 } },
    },
  ];

  /** @type {Record<string, Array<Record<string, any>>>} */
  const charts_by_day = {};
  const addChart = (day, at, requests, tokensIn, tokensOut, cacheRead, cost) => {
    const list = charts_by_day[day] ?? [];
    list.push({
      model: "deepseek",
      provider: "deepseek",
      time_bucket: new Date(at).toISOString(),
      requests,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cache_read_tokens: cacheRead,
      cost_total: cost,
    });
    charts_by_day[day] = list;
  };
  addChart(day1, first, 4, 1200, 300, 600, 0.12);
  addChart(day2, second, 6, 1800, 450, 900, 0.18);

  // scenario 只影响 snapshot，不改变演示用量；保留参数与排序以对齐现有 API。
  void scenario;
  return { daily, charts_by_day };
}

/** 演示/真实数据源选择；demo 缺数据时返回空结构，绝不回退真实数据。 */
export function pickUsageView({ demo = false, demoData = null, daily = [], chartsByDay = {} } = {}) {
  if (!demo) return { daily, charts_by_day: chartsByDay };
  return demoData ? { daily: demoData.daily, charts_by_day: demoData.charts_by_day } : { daily: [], charts_by_day: {} };
}
