// 数据源注册表：MARKET_SOURCES、源标签、落盘记忆里的源 id 与候选源排序。
// 原 market.js 的「数据源注册表」一节按源拆出；各源的 URL/解析函数分别来自 eastmoney/tencent/sina。

import {
  buildDetailUrl,
  buildKlineUrl,
  buildQuoteUrl,
  buildTrendUrl,
  DETAIL_API,
  EASTMONEY_HEADERS,
  KLINE_API,
  KLT_VALUES,
  parseDepthResponse,
  parseKlineResponse,
  parseQuoteResponse,
  parseTrendResponse,
  QUOTE_API,
  SUGGEST_API,
  TREND_API,
} from "./eastmoney.js";
import {
  buildTencentQuoteUrl,
  parseTencentDepth,
  parseTencentKline,
  parseTencentQuotes,
  parseTencentTrend,
  TENCENT_FALLBACK_HOSTS,
  TENCENT_KLINE_API,
  TENCENT_MINUTE_API,
  TENCENT_QUOTE_API,
  TENCENT_TREND_API,
  tencentPeriod,
  UA_HEADERS,
} from "./tencent.js";
import { buildSinaQuoteUrl, parseSinaQuotes, SINA_HEADERS, SINA_QUOTE_API } from "./sina.js";

/* ================= 数据源注册表：K线 / 分时 ================= */

/**
 * K 线与分时为什么要有第二个源（2026-10-09 本机实测，别再自己复现一遍）：
 * 东财行情主机 push2 / push2delay / push2his / 79.push2his 是**整组**在 TLS 握手阶段被连接重置
 * （约 100ms 内 ECONNRESET；换目标 IP、换 SNI、改走明文 http 的结果一样），面板因此整块没数据。
 * 腾讯这两条接口同一天实测 200 且 Content-Type 是 UTF-8，可以直接接。
 * 换 user-agent / 补浏览器请求头对这种故障零作用 —— 连接死在 ClientHello，HTTP 请求还没发出去就被 RST，
 * 那是 L7 的层；客户端唯一有效的手段就是换源，所以这里做的是「换源」而不是「伪装」。
 */

/** 从常量 URL 里取主机名（后备入口只换 host，路径与查询串一模一样） */
function hostOf(url) {
  return new URL(url).hostname;
}

/**
 * 源对象。`id` 是落盘与界面都在用的标识（改了等于把「上一次成功的源」这份记忆清空，别改）；
 * `klts` 是这个源能供的 K 线周期（不支持的周期直接跳过，不浪费一次请求）；
 * 每个 kind 给纯函数 `url(params)`、`parse(payload, params)` 与**自己的 `hosts`**（主入口在前，
 * 失败才走后备入口）—— 入口必须按 kind 分开：快照在 qt.gtimg.cn、K线/分时在 proxy.finance.qq.com，
 * 共用一份就等着把快照请求发到 K 线主机上去（这个错真踩过）。
 * 缺哪个 kind 就是不供（新浪没有 depth），取数链会跳过并说明；列序表一律各源各写。
 * `text: true` 表示这个 kind 的响应体是文本（腾讯/新浪的快照），不走 JSON 解码。
 */
export const MARKET_SOURCES = [
  {
    id: "eastmoney",
    label: "东方财富",
    klts: KLT_VALUES,
    headers: EASTMONEY_HEADERS,
    quote: {
      hosts: [hostOf(QUOTE_API)],
      url: ({ secids }) => buildQuoteUrl(secids),
      parse: (json) => parseQuoteResponse(json),
    },
    depth: {
      hosts: [hostOf(DETAIL_API)],
      url: ({ secid }) => buildDetailUrl(secid),
      parse: (json, { secid }) => parseDepthResponse(json, secid),
    },
    kline: {
      hosts: [hostOf(KLINE_API)],
      url: ({ secid, klt, count }) => buildKlineUrl(secid, klt, count),
      parse: (json) => parseKlineResponse(json),
    },
    trend: {
      hosts: [hostOf(TREND_API)],
      url: ({ secid }) => buildTrendUrl(secid),
      parse: (json) => parseTrendResponse(json),
    },
  },
  {
    id: "tencent",
    label: "腾讯",
    klts: KLT_VALUES,
    headers: UA_HEADERS,
    /** secid 转不出腾讯代码的标的就别试了（快照要代码，K线/分时也要） */
    ok: ({ code, codes }) => (codes ? codes.length > 0 : !!code),
    quote: {
      text: true,
      hosts: [hostOf(TENCENT_QUOTE_API)],
      url: ({ codes }) => buildTencentQuoteUrl(codes),
      parse: (body) => parseTencentQuotes(body),
    },
    // 快照与五档是同一条接口（qt.gtimg.cn 一行里就带五档），只是取不同的段
    depth: {
      text: true,
      hosts: [hostOf(TENCENT_QUOTE_API)],
      url: ({ code }) => buildTencentQuoteUrl([code]),
      parse: (body, { code }) => parseTencentDepth(body, { code }),
    },
    kline: {
      hosts: [hostOf(TENCENT_KLINE_API), ...TENCENT_FALLBACK_HOSTS],
      url: ({ code, klt, count }) =>
        tencentPeriod(klt) === "day"
          ? `${TENCENT_KLINE_API}?param=${code},day,,,${count},qfq`
          : `${TENCENT_MINUTE_API}?param=${code},${tencentPeriod(klt)},,${count}`,
      parse: (json, { code, klt, count }) => parseTencentKline(json, { code, period: tencentPeriod(klt), count }),
    },
    trend: {
      hosts: [hostOf(TENCENT_KLINE_API), ...TENCENT_FALLBACK_HOSTS],
      url: ({ code }) => `${TENCENT_TREND_API}?code=${code}`,
      parse: (json, { code }) => parseTencentTrend(json, { code }),
    },
  },
  {
    id: "sina",
    label: "新浪",
    headers: SINA_HEADERS,
    ok: ({ codes }) => codes.length > 0,
    // 只供价格快照，不供五档（盘口随时段被清空，见上面的实测记录）
    quote: {
      text: true,
      hosts: [hostOf(SINA_QUOTE_API)],
      url: ({ codes }) => buildSinaQuoteUrl(codes),
      parse: (body) => parseSinaQuotes(body),
    },
  },
];

export function sourceLabelOf(id) {
  return MARKET_SOURCES.find((s) => s.id === id)?.label ?? "";
}

/** 落盘记忆里只认这几个 id（撤销授权会清存储，读到脏值就当没记过） */
export const SOURCE_IDS = MARKET_SOURCES.map((s) => s.id);

/** 主源：不开后备源时只用它（G5-08 的「后备源」开关按这个口径收窄） */
export const PRIMARY_SOURCE_ID = MARKET_SOURCES[0].id;

/**
 * 实际可能被请求到的主机（G5-08）：注册表的四个 kind 各自的 hosts 并集，
 * 再补上「搜索」这一路 —— 它不在注册表里（只有东财供），但确实会出网。
 * 界面说明、manifest 描述与单测都拿这一份对齐，别再手写主机名。
 */
export const MARKET_HOSTS = [
  ...new Set([
    ...MARKET_SOURCES.flatMap((s) =>
      ["quote", "depth", "kline", "trend"].flatMap((kind) => s[kind]?.hosts ?? []),
    ),
    hostOf(SUGGEST_API),
  ]),
];

/**
 * 候选源顺序：上一次成功的源排最前，其余保持注册表顺序（原 fetchFromSources 里的内联排序，行为不变）。
 * `allowFallback === false` 时只留主源：用户关掉后备源就是「别去碰别家域名」，
 * 记忆里上一次成功的源也不该把请求带到腾讯/新浪去。
 */
export function orderSourcesForPreferred(preferred, { allowFallback = true } = {}) {
  const pool = allowFallback ? MARKET_SOURCES : MARKET_SOURCES.filter((s) => s.id === PRIMARY_SOURCE_ID);
  return [...pool.filter((s) => s.id === preferred), ...pool.filter((s) => s.id !== preferred)];
}
