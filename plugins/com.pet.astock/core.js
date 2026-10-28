// 盯盘的主循环与出网节制：轮询节拍、请求闸门的冷却记账、推给界面的状态与落盘恢复。
// 出网仍然只有 index.js 的 out() 一个口子，本文件只记账、不直接发请求。

import { TOPIC_CHANGED, TOPIC_QUOTE, TOPIC_STATUS } from "./topics.js";
import { fetchQuotes, marketSession, progressOf, SOURCE_IDS } from "./market.js";
import { evalAlerts, markAlerted } from "./rules.js";
import { cooldownMs, jittered, nextIntervalSec } from "./throttle.js";
import { fireAlerts, recent, today } from "./alerts.js";
import { loadPanel, PANEL_TTL_MS, panelAt, panelWanted } from "./panel.js";
import { gate, out } from "./index.js";
import {
  alerted,
  config,
  ctx,
  DEFAULT_CONFIG,
  MAX_WATCH,
  MIN_INTERVAL,
  noteSource,
  sourcePrefs,
  syncOverlay,
  watch,
} from "./main.js";

export let quotes = {}; // secid → quote

let timer = 0;
let busy = false;
let lastQuoteAt = 0;
let lastError = "";

/** 上一轮行情是哪家给的：切源那一轮不判「有没有进展」（两个源对同一时刻的措辞可能差几十分钟） */
let lastQuoteSource = "";

let strikes = 0; // 被判定为限流的次数，决定冷却阶梯
export let cooldownUntil = 0; // 冷却到什么时候（毫秒时间戳）
let noProgress = 0; // 连续多少轮行情时间戳没前进（休市/停牌/节假日）
let targetSec = 0; // 当前生效的未抖动间隔，用于判断要不要重建定时器

function clockText(ms) {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

export function enterCooldown(reason) {
  strikes += 1;
  cooldownUntil = Date.now() + cooldownMs(strikes);
  lastError = `接口在限流（${reason}），暂停到 ${clockText(cooldownUntil)}`;
  status(lastError, "error");
}

export function status(text, level = "info") {
  ctx?.bus.publish(TOPIC_STATUS, { text, level, at: Date.now() });
}

function watchSecids() {
  const ids = watch.map((w) => w.secid);
  if (config.showIndex && config.indexSecid) ids.push(config.indexSecid);
  return [...new Set(ids.filter(Boolean))];
}

export async function persist(keys) {
  const all = keys ?? ["watch", "config", "alerted"];
  try {
    for (const key of all) {
      const value = key === "watch" ? watch : key === "config" ? config : key === "sources" ? sourcePrefs : alerted;
      await ctx.storage.set(key, value);
    }
  } catch (err) {
    ctx?.log?.("保存盯盘配置失败", err);
  }
}

/** 推给 badge / overlay / 插件页的同一份视图：界面只读它，不自己算 */
export function pushState() {
  const session = marketSession();
  const now = Date.now();
  ctx?.widget.update({
    config,
    watch: watch.map((w) => ({ ...w, rule: ruleText(w) })),
    quotes,
    session,
    recent,
    error: lastError,
    updatedAt: now,
    quoteAt: lastQuoteAt,
    /** 出网节制对用户可见：为什么没更新、还要等多久，别让人以为插件挂了 */
    net: {
      ...gate.stats(),
      strikes,
      cooldownLeftSec: cooldownUntil > now ? Math.ceil((cooldownUntil - now) / 1000) : 0,
      noProgress,
      intervalSec: targetSec || currentIntervalSec(),
      /** 当前吃的是哪家的数据（K线/分时各自记）：插件页那行「K线数据源 腾讯」就来自这里 */
      sources: { ...sourcePrefs },
    },
  });
}

export function ruleText(item) {
  const parts = [];
  if (Number.isFinite(item.upper)) parts.push(`≥${item.upper}`);
  if (Number.isFinite(item.lower)) parts.push(`≤${item.lower}`);
  if (Number.isFinite(item.pct)) parts.push(`|±|≥${item.pct}%`);
  if (item.limit !== false) parts.push("涨跌停");
  return parts.join(" ") || "未设提醒";
}

export async function tick(reason = "timer") {
  if (!ctx || busy || watch.length === 0) {
    if (watch.length === 0) pushState();
    return;
  }
  if (reason === "timer" && Date.now() < cooldownUntil) {
    pushState(); // 界面上要看得见「为什么这几分钟没更新」
    return;
  }
  busy = true;
  try {
    // 后备源开关（G5-08）随每轮带到取数层：关掉时只碰东财主源
    const { data: rows, source, host } = await fetchQuotes(out, watchSecids(), {
      preferred: sourcePrefs.quote,
      allowFallback: config.allowFallback !== false,
    });
    const next = {};
    for (const q of rows) next[q.secid] = q;
    quotes = next;
    lastError = "";
    if (source) noteSource("quote", source, host);

    const session = marketSession();
    const newest = Math.max(0, ...rows.map((r) => r.quoteAt ?? 0));
    // 行情没前进 = 停牌/休市/节假日，这一轮不该产生任何提醒。
    // 时间戳已在解析层归一成毫秒，但**切源那一轮不判**（各家措辞差几十分钟，见 progressOf），
    // 否则换一次源就会被当成「涨了」白刷一轮、或者被当成「卡住了」把间隔退避到 30 分钟。
    const step = progressOf({ prevAt: lastQuoteAt, prevSource: lastQuoteSource, at: newest, source });
    const fresh = step.fresh;
    lastQuoteAt = newest || lastQuoteAt;
    if (source) lastQuoteSource = source;
    // 连续没进展就把间隔按 2 的幂拉长到 30 分钟封顶：休市还 7×24 每几分钟打一次，
    // 是这套接口最像爬虫的地方；一有进展立刻回到正常节奏
    if (step.counted) noProgress = fresh ? 0 : noProgress + 1;
    if (currentIntervalSec() !== targetSec) restartTimer();

    if (config.alertsOn && fresh && session.trading) {
      const hits = evalAlerts({ quotes, watch, alerted, today: today() });
      if (hits.length) {
        markAlerted(alerted, hits, today());
        await fireAlerts(hits);
        await persist(["alerted"]);
      }
    }
    // 面板只在「设置页还要它」且没在冷却的时候跟着行情刷新
    if (panelWanted && session.trading && fresh && Date.now() - panelAt < PANEL_TTL_MS && Date.now() >= cooldownUntil) {
      void loadPanel();
    }
    ctx?.bus.publish(TOPIC_QUOTE, { count: rows.length, reason, session });
  } catch (err) {
    // 一个源都没成时**把行情清空**：留着上一轮的价格再配一个「刚刚更新」的时间，
    // 就是把旧数据当新数据广播（与面板失败时摘掉序列是同一条规矩），界面显示「—」+ 错误行
    quotes = {};
    if (!err?.cooldown) {
      lastError = String(err?.message ?? err);
      status(`行情拉取失败：${lastError}`, "error");
    }
  } finally {
    busy = false;
    pushState();
  }
}

/** 当前该用多长的间隔（未抖动）。冷却期由 tick 自己跳过，不参与间隔计算 */
function currentIntervalSec() {
  const trading = marketSession().trading;
  return nextIntervalSec({
    tradingSec: Math.max(MIN_INTERVAL, config.intervalSec),
    idleSec: Math.max(MIN_INTERVAL, config.idleIntervalSec),
    noProgress: trading ? 0 : noProgress,
  });
}

export function restartTimer() {
  if (timer) clearInterval(timer);
  targetSec = currentIntervalSec();
  const fire = jittered(targetSec);
  timer = setInterval(() => {
    // 跨午休/收盘边界、或退避档位变了，就重建定时器，不必等下一次改配置
    if (currentIntervalSec() !== targetSec) {
      restartTimer();
      return;
    }
    void tick();
  }, fire * 1000);
}

export async function afterChange(note) {
  restartTimer();
  await persist(["watch", "config"]);
  pushState();
  ctx?.bus.publish(TOPIC_CHANGED, { count: watch.length, mode: config.mode });
  await syncOverlay();
  if (note) status(note, "ok");
}

export function clampNum(v) {
  const n = typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10000) / 10000 : null;
}

export function restore(key, saved, fallback) {
  if (key === "watch") {
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((w) => w && typeof w.secid === "string" && /^\d\.\d{6}$/.test(w.secid))
      .slice(0, MAX_WATCH)
      .map((w) => ({
        secid: w.secid,
        code: typeof w.code === "string" ? w.code : w.secid.slice(2),
        name: typeof w.name === "string" ? w.name.slice(0, 40) : w.code,
        upper: clampNum(w.upper),
        lower: clampNum(w.lower),
        pct: clampNum(w.pct),
        limit: w.limit !== false,
      }));
  }
  if (key === "config") {
    if (!saved || typeof saved !== "object") return { ...DEFAULT_CONFIG };
    return {
      intervalSec: Math.max(MIN_INTERVAL, clampNum(saved.intervalSec) ?? DEFAULT_CONFIG.intervalSec),
      idleIntervalSec: Math.max(60, clampNum(saved.idleIntervalSec) ?? DEFAULT_CONFIG.idleIntervalSec),
      alertsOn: saved.alertsOn !== false,
      petOn: saved.petOn !== false,
      showIndex: saved.showIndex !== false,
      indexSecid: typeof saved.indexSecid === "string" ? saved.indexSecid : DEFAULT_CONFIG.indexSecid,
      mode: saved.mode === "overlay" || saved.mode === "off" ? saved.mode : "badge",
    };
  }
  // sources：只认已知的源 id（旧版本写的、手改的都当没记过，下一轮重新探一遍）
  if (key === "sources") {
    const s = saved && typeof saved === "object" ? saved : {};
    const pick = (v) => (typeof v === "string" && SOURCE_IDS.includes(v) ? v : "");
    return { kline: pick(s.kline), trend: pick(s.trend), quote: pick(s.quote), depth: pick(s.depth) };
  }
  // alerted：只收字符串键、布尔值，且必须是今天的日期前缀（旧日期的直接丢）
  if (saved && typeof saved === "object") {
    const keep = {};
    for (const [k, v] of Object.entries(saved)) {
      if (typeof v === "boolean" && typeof k === "string" && k.startsWith(`${today()}:`)) keep[k] = v;
    }
    return keep;
  }
  return fallback;
}

/** deactivate 用：把定时器停掉（在飞的那一拍自然结束，不会再有新的） */
export function stopTimer() {
  if (timer) clearInterval(timer);
  timer = 0;
}

/** deactivate 用：行情快照随插件下线清掉，别留着上一轮的价格配新时间戳 */
export function clearQuotes() {
  quotes = {};
}
