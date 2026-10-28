// 盘面面板：拉选中那只的盘口/分时/K线，发布到 *:panel topic。
// 拉数据的出网统一走 index.js 的 out()。

import { TOPIC_PANEL } from "./topics.js";
import { briefReason, fetchDepth, fetchKline, fetchTrend, KIND_NAMES } from "./market.js";
import { out } from "./index.js";
import { ctx, config, klt, noteSource, selected, sourcePrefs } from "./main.js";
import { quotes, status } from "./core.js";

/** K 线比盘口/分时候份稳定得多，60 秒才重拉一次 */
export const KLINE_STALE_MS = 60_000;
/** 设置页开着的时候会每分钟续一次期；人走了（关窗/切到别的插件页）就没人续，90 秒后自动停 */
export const PANEL_TTL_MS = 90_000;

export let panel = null; // { secid, klt, depth, trend, kline, error, failed, at }
export let panelWanted = false;
export let panelAt = 0;
let panelBusy = false;

/** 面板数据单独一条 topic：badge/overlay 收的是每轮的 *:widget，用不着几十 KB 的序列 */
export function publishPanel() {
  ctx?.bus.publish(TOPIC_PANEL, panel ?? { secid: "", cleared: true, at: Date.now() });
}

/**
 * 宿主代理的原始错误里带着整条 URL 和 rustls 的文档链接，对用户没用还会把面板那行撑成三行；
 * 完整信息进 ctx.log（多源失败时每个入口一条，见 market.js 抛出的 err.detail），界面上只留人话。
 */
export function briefError(err) {
  return briefReason(err).slice(0, 90);
}

/**
 * 拉选中个股的盘口 / 分时 / K 线。三段可以分开要：切 K 线周期时没必要把盘口和分时再打一遍。
 * 失败不牵动主轮询，但**失败的那一段不保留上一轮的数据**（序列摘成 null，界面留错误行 + 空提示）：
 * 尤其是切周期，把上一周期的 K 线挂在新周期标签下，就是一张错价的图。
 * K线与分时走多源（见 market.js）：先试上一次成功的源，失败依次下移，全失败才落成一行错误。
 */
export async function loadPanel({ withDepth = true, withTrend = true, withKline = true } = {}) {
  if (!ctx || !selected || panelBusy) return;
  panelBusy = true;
  panelWanted = true;
  panelAt = Date.now();
  const request = out;
  // 换标的时不继承上一只的曲线，否则名字是 A、图上画的是 B
  const next = { ...(panel?.secid === selected ? panel : {}), secid: selected, klt, error: "", failed: {} };
  // 切周期先把上一周期的 K 线摘掉：它比失败处理更早生效，
  // 否则「请求还没回来」的那几秒里，新周期标签下挂的仍是旧周期的图
  if (next.klineKlt !== klt) {
    next.kline = null;
    next.klineKlt = null;
    next.klineAt = 0;
  }
  const failed = {};

  // 每一类数据「这一轮试过的源」：只做记录（host + 成败），不改取数顺序、out() 与节流 ——
  // 「整条链失败」有 failed 兜底，但「先撞预期源失败、再换源成功」的中途失败不上任何回显字段，
  // 回归的判定层靠这份记录把「有理由的跨源」和「无理由跨源」分开（见 tests/e2e/harness/astock-source-branch.mjs）。
  const attempted = {};
  const traced = (kind) => {
    const rec = [];
    attempted[kind] = rec;
    return async (url, opts) => {
      const entry = { host: new URL(url).hostname, ok: null };
      rec.push(entry);
      try {
        const resp = await request(url, opts);
        entry.ok = true;
        return resp;
      } catch (err) {
        entry.ok = false;
        throw err;
      }
    };
  };

  /** 一段取数：成功写进 next，失败只记自己那一段（一段坏不连坐另外两段） */
  const grab = async (kind, run) => {
    try {
      await run();
    } catch (err) {
      failed[kind] = briefError(err);
      ctx?.log?.(`${KIND_NAMES[kind]}取数失败`, err?.detail ?? err);
    }
  };
  const grabDepth = () =>
    grab("depth", async () => {
      const { data, source, host } = await fetchDepth(traced("depth"), selected, {
        preferred: sourcePrefs.depth,
        allowFallback: config.allowFallback !== false,
      });
      next.depth = data;
      next.depthAt = Date.now();
      next.depthSource = source;
      noteSource("depth", source, host);
    });
  const grabTrend = () =>
    grab("trend", async () => {
      const { data, source, host } = await fetchTrend(traced("trend"), selected, {
        preferred: sourcePrefs.trend,
        allowFallback: config.allowFallback !== false,
      });
      // 昨收优先取**主轮询那一份快照**（缓存复用）：同一个数不重复问，
      // 而且分时基线跟着列表里的昨收走，不会出现「列表一个昨收、图上一个昨收」。
      // 快照这一轮没成功（或这只不在自选里）时才退回分时响应自带的那个。
      const cached = quotes[selected]?.prevClose;
      next.trend = Number.isFinite(cached) ? { ...data, preClose: cached } : data;
      next.trendAt = Date.now();
      next.trendSource = source;
      noteSource("trend", source, host);
    });
  const grabKline = () =>
    grab("kline", async () => {
      const { data, source, host } = await fetchKline(traced("kline"), selected, klt, {
        preferred: sourcePrefs.kline,
        allowFallback: config.allowFallback !== false,
      });
      next.kline = data;
      next.klineAt = Date.now();
      next.klineKlt = klt;
      next.klineSource = source;
      noteSource("kline", source, host);
    });

  try {
    // 三段**按顺序**取，不要 Promise.all：出网闸门的「连续失败」是全插件一份计数，
    // 三条链并发时，盘口 + 分时 + K线各自要先撞一次坏源（东财整组被重置），
    // 三次失败会在分时/ K线 还没轮到备用源时就把插件推进冷却（实测：面板一轮里
    // depth 失败、trend/kline 直接拿到「限流冷却中，约 300 秒后自动恢复」，备用源根本没跑到）。
    // 串起来之后每段都是「先撞坏源、再换源成功」，成功会把计数清零，冷却不会被误触发。
    if (withDepth) await grabDepth();
    if (withTrend) await grabTrend();
    if (withKline && (next.klineKlt !== klt || isKlineStale(next) || !next.kline)) await grabKline();

    // 失败的那一段：不把上一轮的序列当本轮结果发布（宁可图上写「还没有数据」）
    if (failed.depth) {
      next.depth = null;
      next.depthAt = 0;
    }
    if (failed.trend) {
      next.trend = null;
      next.trendAt = 0;
    }
    if (failed.kline) {
      next.kline = null;
      next.klineKlt = null;
      next.klineAt = 0;
    }
    next.failed = failed;
    /** 只增不改的归因字段：每类数据本轮试过的源（host + 成败），取数/判定逻辑不受它影响 */
    next.attempted = attempted;
    next.error = Object.entries(failed)
      .map(([kind, why]) => `${KIND_NAMES[kind]}：${why}`)
      .join("；");
    panel = { ...next, at: Date.now() };
    if (next.error) status(`盘面数据拉取失败：${next.error}`, "error");
  } finally {
    panelBusy = false;
    publishPanel();
  }
}

export function isKlineStale(state) {
  return !Number.isFinite(state?.klineAt) || Date.now() - state.klineAt > KLINE_STALE_MS;
}

/** clearPanel 用：作废当前面板数据（topic 由调用方负责发） */
export function resetPanel() {
  panel = null;
  panelWanted = false;
}

/** deactivate 用：下线清场，在飞标志也一起清 */
export function resetPanelOnStop() {
  panel = null;
  panelWanted = false;
  panelBusy = false;
}
