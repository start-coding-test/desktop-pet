// 行情数据层：三家公开只读数据源（东方财富为主，腾讯/新浪作后备，见 sources/registry.js）。
// 实际可能访问 8 个主机：东财的 push2 / push2his / searchadapter，腾讯的 qt.gtimg.cn /
// proxy.finance.qq.com / web.ifzq.gtimg.cn / ifzq.gtimg.cn，新浪的 hq.sinajs.cn；
// 名单以 registry.js 的 MARKET_HOSTS 为准（manifest 描述与插件页说明都跟它对齐）。
// 不想让后备源接触别家域名时把 allowFallback 关掉（设置页的「后备数据源」，默认开）。
//
// 为什么是东财而不是腾讯/新浪：这两个源的实时接口回的是 GBK / GB18030，
// 而宿主的 http 代理按 UTF-8 取文本（from_utf8_lossy），中文股票名会直接变乱码；
// 新浪还要求带 Referer，缺了给 403。东财三个域都是 UTF-8 JSON、约 150ms、
// 且不跨主机重定向（宿主的 http 授权是逐跳复核域名的，跨主机 302 会被拒）。
// 腾讯的 K 线与分时两条接口是 UTF-8，所以能被 K 线/分时当成第二源；实时快照那条（qt.gtimg.cn）
// 是 GBK，要等宿主 http 按 charset 解码（本体改动）之后才能接，不在这一轮里。
//
// 这里刻意分成两层：纯函数（编码规则、解析、时段判定）+ 取数函数。
// 纯函数不碰网络也不碰 ctx，回归脚本可以直接 import 来断言。
//
// 2026-10-13 按源拆分（M3）：各源的 URL/解析/列序在 sources/{eastmoney,tencent,sina}.js，
// 注册表在 sources/registry.js；本文件保留共享纯函数与取数层，并再导出全部原有名字。

import { buildSuggestUrl, EASTMONEY_HEADERS, num, parseSuggestResponse } from "./sources/eastmoney.js";
import { orderSourcesForPreferred } from "./sources/registry.js";
import { tencentCodeOf } from "./sources/tencent.js";

export {
  buildDetailUrl,
  buildKlineUrl,
  buildQuoteUrl,
  buildSuggestUrl,
  buildTrendUrl,
  DETAIL_API,
  KLINE_API,
  KLINE_PERIODS,
  KLT_VALUES,
  parseDepthResponse,
  parseKlineResponse,
  parseQuoteResponse,
  parseQuoteRow,
  parseSuggestResponse,
  parseTrendResponse,
  QUOTE_API,
  SUGGEST_API,
  TREND_API,
} from "./sources/eastmoney.js";
export {
  buildTencentQuoteUrl,
  parseTencentDepth,
  parseTencentKline,
  parseTencentMinuteRows,
  parseTencentQuotes,
  parseTencentTrend,
  secidOfTencentCode,
  TENCENT_FALLBACK_HOSTS,
  TENCENT_KLINE_API,
  TENCENT_MINUTE_API,
  TENCENT_QUOTE_API,
  TENCENT_TREND_API,
  tencentCodeOf,
} from "./sources/tencent.js";
export { buildSinaQuoteUrl, parseSinaQuotes, SINA_QUOTE_API } from "./sources/sina.js";
export { MARKET_HOSTS, MARKET_SOURCES, orderSourcesForPreferred, PRIMARY_SOURCE_ID, sourceLabelOf, SOURCE_IDS } from "./sources/registry.js";

/// 一次批量快照最多带多少只：接口本身能吞更多，但列表太长时响应体与解析都会抖
export const MAX_SECIDS = 40;

/** 常用指数。代码与个股会撞车（000001 既是上证指数也是平安银行），所以指数只走这份预设表 */
export const INDICES = [
  { secid: "1.000001", name: "上证指数" },
  { secid: "0.399001", name: "深证成指" },
  { secid: "0.399006", name: "创业板指" },
  { secid: "1.000688", name: "科创50" },
  { secid: "1.000300", name: "沪深300" },
  { secid: "0.899050", name: "北证50" },
];

export function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 把用户输入归整成 6 位数字代码。
 * 接受 `600519` / `sh600519` / `600519.SH` / `SZ000001` / `1.600519`。
 */
export function normalizeCode(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  const dotted = raw.match(/^(\d{6})\.(sh|sz|bj)$/);
  if (dotted) return dotted[1];
  const prefixed = raw.match(/^(sh|sz|bj)(\d{6})$/);
  if (prefixed) return prefixed[2];
  const secid = raw.match(/^([01])\.(\d{6})$/);
  if (secid) return secid[2];
  return /^\d{6}$/.test(raw) ? raw : null;
}

/**
 * 6 位代码 → 东财 secid（`市场.代码`）。市场号：1=沪，0=深。
 * 规则按首位收敛：沪 6/9/5 开头，深 0/1/2/3 开头；北交所走 0.8xxxxx（与指数同样需要显式指定）。
 * 认不出来时返回 null，让调用方去查 suggest 接口而不是猜。
 */
export function secidOf(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  // 北交所新代码段 920xxx 也是 9 开头，必须排在「9 = 沪」之前判掉，
  // 否则 920185 会被拼成 1.920185（沪市）而查不到（实测贝特瑞、纬达光电都在市场 0）。
  if (c.startsWith("92")) return `0.${c}`;
  const head = c[0];
  if (head === "6" || head === "9" || head === "5") return `1.${c}`;
  if (head === "0" || head === "1" || head === "2" || head === "3") return `0.${c}`;
  if (head === "4" || head === "8") return `0.${c}`; // 北交所（4xxxxx / 8xxxxx）
  return null;
}

/** 涨跌停幅度**回落表**（只在源不供交易所涨跌停价时才用，见 rules.js；腾讯 47/48 段、
 *  东财 f51/f52 给的都是价，有价时判定不经过这里）：创业板 30 / 科创板 68 是 20%；
 *  北交所 92/4/8 开头（前缀口径与 secidOf 完全一致，别另起一份）是 30%；其余 10%。
 *  ST 的 5% 这里不区分 —— 判不出就是判不出，不假装解决（有交易所价时不受影响） */
export function limitPct(code) {
  const c = normalizeCode(code) ?? "";
  if (c.startsWith("30") || c.startsWith("68")) return 20;
  if (c.startsWith("92") || c.startsWith("4") || c.startsWith("8")) return 30;
  return 10;
}

/* ================= 行情时间戳：三个源口径不同，统一成 epoch 毫秒 ================= */

/**
 * 「这一轮有没有新数据」全靠行情时间戳比大小（提醒与退避都建立在它上面），
 * 而三个源给的不是一回事：
 *   东财 f124 = **秒级** epoch（实测口径，见上面字段表）
 *   腾讯 段 30 = "20261009161457"（本地时区的 YYYYMMDDHHMMSS）
 *   新浪 段 30/31 = "2026-10-09" + "15:34:59"
 * 不归一的话，切源那一轮就是秒 vs 毫秒差 1000 倍：要么被当成「有进展」白刷一轮，
 * 要么被当成「没进展」把间隔退避到 30 分钟 —— 静默坏掉退避逻辑。
 * 所以三个解析器都从这里取时间戳，比较只认这里输出的毫秒数。
 */
export function epochMsOfSeconds(v) {
  const n = num(v);
  if (n === null || n <= 0) return null;
  // 秒级 epoch 现在是 ~1.7e9，毫秒级 ~1.7e12：1e11 这条线两边都留了三个数量级余量
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

export function epochMsOfCompact(stamp) {
  const s = String(stamp ?? "").trim();
  if (!/^\d{14}$/.test(s)) return null;
  // 腾讯给的是本地时区的墙上时间（券商口径），按本地时间构造才是那一刻
  const t = new Date(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(s.slice(8, 10)),
    Number(s.slice(10, 12)),
    Number(s.slice(12, 14)),
  ).getTime();
  return Number.isFinite(t) ? t : null;
}

export function epochMsOfDateTime(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
  const c = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!d || !c) return null;
  const t = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(c[1]), Number(c[2]), Number(c[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 涨跌幅与涨跌额一律自己用现价/昨收算：休市、停牌时各家接口的自带口径不一致 */
export function pctOf(price, prevClose) {
  const p = num(price);
  const base = num(prevClose);
  if (p === null || base === null || base <= 0) return null;
  return Math.round((p / base - 1) * 10000) / 100;
}

export function changeOf(price, prevClose) {
  const p = num(price);
  const base = num(prevClose);
  if (p === null || base === null) return null;
  return Math.round((p - base) * 1000) / 1000;
}

/**
 * 「这一轮有没有新数据」+「要不要计入没进展的退避」。
 * 把时间戳归一成毫秒只是第一步：不同源对**同一时刻**的措辞差得远（实测 2026-10-09 收盘后
 * 腾讯段 30 是 16:14:57、新浪是 15:34:59，差 40 分钟），拿它们直接比大小会把「换了家源」
 * 当成「行情涨了」或「卡住了」。所以切源那一轮既不判进展、也不计入退避 —— 等下一轮同一个源再比。
 * 纯函数，回归脚本可以直接喂固定输入断言（见 verify-astock 的「时间戳归一」一组）。
 */
export function progressOf({ prevAt = 0, prevSource = "", at = 0, source = "" } = {}) {
  if (!(at > 0)) return { fresh: false, counted: false }; // 这轮没拿到时间戳（一个源都没成）
  if (prevSource && source && source !== prevSource) return { fresh: false, counted: false }; // 切源那一轮
  return { fresh: at !== prevAt, counted: true };
}

/**
 * A股时段（本地时间，只认星期与时钟；法定节假日不判 —— 那时行情时间戳不动，
 * 提醒逻辑靠「时间戳有没有前进」自然就不会误触发）。
 */
export function marketSession(now = new Date()) {
  const day = now.getDay();
  if (day === 0 || day === 6) return { phase: "weekend", trading: false };
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 9 * 60 + 15) return { phase: "pre", trading: false };
  if (mins < 9 * 60 + 30) return { phase: "auction", trading: true };
  if (mins <= 11 * 60 + 30) return { phase: "morning", trading: true };
  if (mins < 13 * 60) return { phase: "lunch", trading: false };
  if (mins <= 15 * 60) return { phase: "afternoon", trading: true };
  return { phase: "closed", trading: false };
}

/** K 线条数上限：5 分钟线一天 48 根，120 根够看半年日线，响应约 12 KB，远在宿主 1 MiB 闸门内 */
export const MAX_KLINE_BARS = 120;

/** 界面上用的名字（错误行与日志都要说清是哪一段数据出的问题） */
export const KIND_NAMES = { quote: "行情", depth: "五档", trend: "分时", kline: "K线" };

/* ================= 取数（要 http 能力，由调用方把 request 传进来） ================= */

/** 统一把接口响应解成 JSON；非 2xx / 非 JSON / 被截断都抛可读错误 */
function decode(resp, what) {
  if (!resp || resp.status < 200 || resp.status >= 300) {
    throw new Error(`${what} 返回 ${resp?.status ?? "?"}`);
  }
  if (resp.truncated) throw new Error(`${what} 响应过大被截断`);
  try {
    return JSON.parse(resp.body);
  } catch {
    throw new Error(`${what} 响应不是 JSON`);
  }
}

/** 文本响应（腾讯/新浪快照是 `v_xx="…"` 这种行文本，不是 JSON）：只校验状态与截断 */
function decodeText(resp, what) {
  if (!resp || resp.status < 200 || resp.status >= 300) {
    throw new Error(`${what} 返回 ${resp?.status ?? "?"}`);
  }
  if (resp.truncated) throw new Error(`${what} 响应过大被截断`);
  if (typeof resp.body !== "string" || !resp.body.trim()) throw new Error(`${what} 响应是空的`);
  return resp.body;
}

/** 掐掉宿主代理原始错误里的 URL 与 rustls 文档链接：聚合错误要能塞进界面一行 */
export function briefReason(err) {
  const raw = String(err?.message ?? err);
  const head = raw.split(/:?\s*https?:\/\//)[0].trim();
  return head || raw;
}

function urlOnHost(url, host) {
  return url.replace(/^https:\/\/[^/]+/, `https://${host}`);
}

/** 一个源的尝试：主入口 → 后备入口。全失败抛出的 message 里带着源名与每个入口的原因 */
async function trySource(request, source, kind, params, { allowFallback = true } = {}) {
  const spec = source[kind];
  const reasons = [];
  // 入口按 kind 走（见 MARKET_SOURCES 的注释）：快照在 qt.gtimg.cn，K线/分时在 proxy.finance.qq.com。
  // 关掉后备源（G5-08）时只试主入口：后备入口也是别家域名（web.ifzq / ifzq），
  // 开关的意义就是「别去请求没出现过的域名、别弹授权框」。
  const hosts = allowFallback ? spec.hosts : spec.hosts.slice(0, 1);
  for (const host of hosts) {
    const url = urlOnHost(spec.url(params), host);
    try {
      const resp = await request(url, { headers: source.headers });
      const payload = spec.text ? decodeText(resp, `${source.label}${KIND_NAMES[kind]}`) : decode(resp, `${source.label}${KIND_NAMES[kind]}`);
      const data = spec.parse(payload, params);
      return { data, source: source.id, host };
    } catch (err) {
      // 冷却/限流是全局的（出网只有一个闸门），换源与换入口都不会好，把话直接交回调用方
      if (err?.cooldown) throw err;
      reasons.push(`${host}: ${briefReason(err)}`);
    }
  }
  // detail 给调用方写日志（每个入口一条），把交出去的形状声明在 Error 类型上
  const err = /** @type {Error & { detail?: string[] }} */ (new Error(`${source.label}（${reasons.join("；")}）`));
  err.detail = reasons;
  throw err;
}

/**
 * 取数主循环：先试「上一次成功的源」，再依次下移；一个源内部先试主入口，失败才试后备入口。
 * 全部失败抛出的 message 可以直接给界面（一行，含每个源与入口），`detail` 给调用方写日志（每个源一条）。
 * `allowFallback === false`（G5-08 的设置开关）时只用主源、每源只试主入口，别家域名一次都不碰。
 */
async function fetchFromSources(kind, request, params, preferred, { allowFallback = true } = {}) {
  const ordered = orderSourcesForPreferred(preferred, { allowFallback });
  const detail = [];
  for (const source of ordered) {
    // 不供这个 kind 的源（新浪没有五档）直接跳过，并说清是「不供」而不是「失败」
    if (!source[kind]) {
      detail.push(`${source.label}：不供${KIND_NAMES[kind]}`);
      continue;
    }
    if (kind === "kline" && !source.klts.includes(params.klt)) {
      detail.push(`${source.label}：不支持该周期`);
      continue;
    }
    if (source.ok && !source.ok(params)) {
      detail.push(`${source.label}：这个代码转不过去`);
      continue;
    }
    try {
      return await trySource(request, source, kind, params, { allowFallback });
    } catch (err) {
      if (err?.cooldown) throw err;
      detail.push(err.message);
    }
  }
  const err = /** @type {Error & { detail?: string[] }} */ (new Error(`${KIND_NAMES[kind]}取数失败：${detail.join("；")}`));
  err.detail = detail;
  throw err;
}

/**
 * 自选列表快照：多源批量取数（腾讯/新浪一次带走全部自选，东财同样是一次 ulist）。
 * 返回 { data: [quote…], source, host }。
 */
export async function fetchQuotes(request, secids, { preferred = "", allowFallback = true } = {}) {
  const list = [...new Set((secids ?? []).filter(Boolean))].slice(0, MAX_SECIDS);
  if (list.length === 0) return { data: [], source: "", host: "" };
  const codes = list.map(tencentCodeOf).filter(Boolean);
  return fetchFromSources("quote", request, { secids: list, codes }, preferred, { allowFallback });
}

export async function fetchSuggest(request, keyword) {
  const resp = await request(buildSuggestUrl(keyword), { headers: EASTMONEY_HEADERS });
  return parseSuggestResponse(decode(resp, "搜索"));
}

/** 五档盘口：多源取数（腾讯的五档与快照是同一条接口的另一段；新浪不供五档） */
export async function fetchDepth(request, secid, { preferred = "", allowFallback = true } = {}) {
  const params = { secid, code: tencentCodeOf(secid) };
  return fetchFromSources("depth", request, params, preferred, { allowFallback });
}

/** K 线：多源取数，返回 { data, source, host }；`preferred` 是「上一次成功的源」 */
export async function fetchKline(request, secid, klt = 101, { preferred = "", allowFallback = true } = {}) {
  const params = { secid, code: tencentCodeOf(secid), klt, count: MAX_KLINE_BARS };
  return fetchFromSources("kline", request, params, preferred, { allowFallback });
}

/** 当日分时：多源取数，返回 { data, source, host } */
export async function fetchTrend(request, secid, { preferred = "", allowFallback = true } = {}) {
  const params = { secid, code: tencentCodeOf(secid) };
  return fetchFromSources("trend", request, params, preferred, { allowFallback });
}
