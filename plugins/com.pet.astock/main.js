// A股盯盘主逻辑，运行在宠物窗上下文。
//
// 分工：market.js 只管取数与解析，rules.js 只管判定，这个文件负责
// 「什么时候问一次、问完拿结果干什么、怎么落盘」。
//
// 三条刻意的设计，改之前先看注释：
//   1) 提醒不看「是不是交易日」而看「行情时间戳有没有前进」—— 法定节假日接口给的是
//      上一交易日的旧数据，判时间戳比维护一份节假日日历可靠。
//   2) 一轮 tick 只允许有一个在飞请求（busy 标志），否则网络卡顿时定时器会排队堆请求。
//   3) 界面数据每轮都 ctx.widget.update 一次，设置页重新挂载时靠宿主回灌，
//      否则面板会拿自己的默认值去覆盖用户已经存好的配置。
// 2026-10-13 按职责拆分（M4）：轮询与状态在 core.js、盘面面板在 panel.js、提醒链在 alerts.js；
// 本文件保留生命周期（activate/deactivate）、指令处理与共享状态；入口壳见 index.js。
import { TOPIC_CMD, TOPIC_SUGGEST } from "./topics.js";
import { fetchSuggest, KIND_NAMES, KLT_VALUES, normalizeCode, secidOf, sourceLabelOf } from "./market.js";
import { fireAlerts } from "./alerts.js";
import { loadPanel, panel, publishPanel, resetPanel, resetPanelOnStop } from "./panel.js";
import {
  afterChange,
  clampNum,
  clearQuotes,
  persist,
  pushState,
  quotes,
  restartTimer,
  restore,
  status,
  stopTimer,
  tick,
} from "./core.js";
import { out } from "./index.js";

export const DEFAULT_CONFIG = {
  intervalSec: 20, // 盘中轮询间隔
  idleIntervalSec: 300, // 非盘中/休市时的间隔：没必要按秒打接口
  alertsOn: true,
  petOn: true,
  showIndex: true,
  indexSecid: "1.000001",
  mode: "badge", // badge | overlay | off
  // 后备数据源开关（G5-08）：关掉后只请求东财主源与各自主入口，
  // 腾讯/新浪（以及腾讯的 web.ifzq / ifzq 后备入口）一次都不碰 —— 免得中途弹出陌生域名的授权框。
  allowFallback: true,
  // 盯盘卡位置（逻辑像素，插件自己存；ADR-0010 决策 4）。缺省故意非对称：
  // 对称坐标抓不到 x/y 对调的接线错（宿主那轮变异抽查全套件全绿就是这么漏的）
  cardX: 420,
  cardY: 180,
};

/** 轮询间隔下限：再小就是在压公共接口，个人盯盘也没这个必要 */
export const MIN_INTERVAL = 10;
export const MAX_WATCH = 20;

export let ctx = null;
export let config = { ...DEFAULT_CONFIG };
export let watch = []; // [{secid, code, name, upper, lower, pct, limit}]
export let alerted = {}; // "日期:代码:规则" → true
let stopped = false;

/* 选中个股的盘口 / 分时 / K 线：只有设置页在用，走单独 topic，不进每轮的 *:widget */
export let selected = "";
export let klt = 101;

/**
 * 「上一次成功的源」：K线、分时、行情快照、五档各记一个 id，落在插件自己的隔离存储里（key: sources），
 * 重启后第一轮就先用它 —— 坏源不必每轮都再撞一次。插件页那行「K线数据源 腾讯」也是它。
 */
export let sourcePrefs = { kline: "", trend: "", quote: "", depth: "" };

/** 悬浮窗显隐的串行链，见 syncOverlay() */
let overlayChain = Promise.resolve();

/**
 * 记下「这一段上一次成功的源」并落盘（只在变化时写）。第一次成功也写：
 * 之后重启插件，第一轮就先用它 —— 上一次被重置的那个源不必每轮再撞一遍。
 */
export function noteSource(kind, id, host) {
  if (!id || sourcePrefs[kind] === id) return;
  sourcePrefs = { ...sourcePrefs, [kind]: id };
  ctx?.log?.(`${KIND_NAMES[kind]}数据源切到 ${sourceLabelOf(id)}（${host}）`);
  void persist(["sources"]);
}

function clearPanel() {
  selected = "";
  resetPanel();
  publishPanel();
}

async function syncOverlayOnce() {
  const want = config.mode === "overlay";
  try {
    if (want) {
      // 盯盘卡位置由插件自己给（cardX/cardY，设置页可改）：宿主只做屏内夹紧（ADR-0010 决策 3/4）
      await ctx.overlay.show({ x: config.cardX, y: config.cardY, height: 96 + 26 * Math.min(watch.length + 1, 8) });
    } else {
      await ctx.overlay.hide();
    }
  } catch (err) {
    ctx?.log?.("盯盘卡切换失败", err);
  }
}

/**
 * 显隐切换排成一条链。
 * 不排会输在收尾上：刚发出「删掉最后一只自选」的 show 还没落地就停用插件，
 * destroy 先到、show 后到，卡就留在屏幕上了（回归里就是这么炸的）。
 */
export function syncOverlay() {
  overlayChain = overlayChain.then(async () => {
    if (stopped || !ctx) return; // 已经停用/还没就绪，这一跳直接作废
    await syncOverlayOnce();
  });
  return overlayChain;
}

/** 加自选：优先用界面给定的 secid（来自 suggest），否则按代码规则推 */
export function resolveTarget(cmd) {
  if (typeof cmd.secid === "string" && /^\d\.\d{6}$/.test(cmd.secid)) {
    const code = cmd.secid.slice(2);
    return { secid: cmd.secid, code, name: typeof cmd.name === "string" ? cmd.name.slice(0, 40) : code };
  }
  const code = normalizeCode(cmd.input ?? cmd.code);
  if (!code) return null;
  const id = secidOf(code);
  return id ? { secid: id, code, name: typeof cmd.name === "string" ? cmd.name.slice(0, 40) : code } : null;
}

/** 坐标归一：真数字才算（非空数字串也收），其余给 null —— 存储里的怪值不许把位置变成 NaN 或字符串 */
function coordOf(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * config 的恢复 = 既有 restore("config") 的逐字段归整 + cardX/cardY 的严格收口。
 * 这两个坐标不在 restore 的字段表里：逐字段收 —— 不是有限数字就回落缺省，与命令入口同一条口径。
 */
function restoreConfig(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  return {
    ...restore("config", saved, config),
    cardX: coordOf(s.cardX) ?? DEFAULT_CONFIG.cardX,
    cardY: coordOf(s.cardY) ?? DEFAULT_CONFIG.cardY,
    // 后备源开关：存储里只有显式 false 才算关（老版本没有这个字段 → 保持开，行为不变）
    allowFallback: s.allowFallback !== false,
  };
}

async function handleCmd(cmd) {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.action) {
    case "sync":
      pushState();
      publishPanel();
      return;
    case "refresh":
      await tick("manual");
      status(`已刷新：${Object.keys(quotes).length} 条`, "ok");
      return;
    case "add": {
      const target = resolveTarget(cmd);
      if (!target) {
        status("给我 6 位代码，或者从搜索结果里点「添加」", "error");
        return;
      }
      if (watch.some((w) => w.secid === target.secid)) {
        status(`${target.name} 已经在自选里了`, "error");
        return;
      }
      if (watch.length >= MAX_WATCH) {
        status(`自选股最多 ${MAX_WATCH} 只`, "error");
        return;
      }
      watch.push({ ...target, upper: null, lower: null, pct: null, limit: true });
      await afterChange(`已加入 ${target.name}`);
      await tick("added");
      return;
    }
    case "remove": {
      const before = watch.length;
      watch = watch.filter((w) => w.secid !== cmd.secid);
      if (watch.length !== before) {
        // 正开着的那只被删掉，面板不能继续画它的曲线
        if (cmd.secid === selected) clearPanel();
        await afterChange("已删除一只自选股");
      }
      return;
    }
    case "update": {
      const item = watch.find((w) => w.secid === cmd.secid);
      if (!item) return;
      // 只认这三个规则字段：界面上没给的（undefined）保持原值，别抹成 null
      if (cmd.upper !== undefined) item.upper = clampNum(cmd.upper);
      if (cmd.lower !== undefined) item.lower = clampNum(cmd.lower);
      if (cmd.pct !== undefined) item.pct = clampNum(cmd.pct);
      if (cmd.limit !== undefined) item.limit = cmd.limit === true;
      await afterChange(`已更新 ${item.name} 的提醒规则`);
      return;
    }
    case "clear": {
      watch = [];
      clearPanel();
      await afterChange("已清空自选股");
      return;
    }
    case "config": {
      const c = cmd.value ?? {};
      if (c.intervalSec !== undefined) {
        const n = clampNum(c.intervalSec);
        config.intervalSec = Math.max(MIN_INTERVAL, Math.round(n ?? DEFAULT_CONFIG.intervalSec));
      }
      if (c.idleIntervalSec !== undefined) {
        const n = clampNum(c.idleIntervalSec);
        config.idleIntervalSec = Math.max(60, Math.round(n ?? DEFAULT_CONFIG.idleIntervalSec));
      }
      if (c.alertsOn !== undefined) config.alertsOn = c.alertsOn === true;
      if (c.petOn !== undefined) config.petOn = c.petOn === true;
      if (c.showIndex !== undefined) config.showIndex = c.showIndex === true;
      if (typeof c.indexSecid === "string" && /^\d\.\d{6}$/.test(c.indexSecid)) {
        config.indexSecid = c.indexSecid;
      }
      if (c.mode === "badge" || c.mode === "overlay" || c.mode === "off") config.mode = c.mode;
      if (c.allowFallback !== undefined) config.allowFallback = c.allowFallback === true;
      if (c.cardX !== undefined) {
        const n = coordOf(c.cardX);
        if (n !== null) config.cardX = n;
      }
      if (c.cardY !== undefined) {
        const n = coordOf(c.cardY);
        if (n !== null) config.cardY = n;
      }
      await afterChange(`刷新间隔 ${config.intervalSec}s、提醒 ${config.alertsOn ? "开" : "关"}`);
      return;
    }
    case "search": {
      const kw = String(cmd.keyword ?? "").trim();
      if (!kw) return;
      try {
        const rows = await fetchSuggest(out, kw);
        ctx?.bus.publish(TOPIC_SUGGEST, { keyword: kw, rows });
        if (!rows.length) status(`没找到与「${kw}」匹配的股票`, "error");
      } catch (err) {
        status(`搜索失败：${String(err?.message ?? err)}`, "error");
      }
      return;
    }
    case "select": {
      const secid = typeof cmd.secid === "string" ? cmd.secid : "";
      if (!/^\d\.\d{6}$/.test(secid) || !watch.some((w) => w.secid === secid)) {
        status("要点开一只自选股才能看盘口和曲线", "error");
        return;
      }
      selected = secid;
      await loadPanel();
      return;
    }
    case "klt": {
      const value = Number(cmd.value);
      if (!KLT_VALUES.includes(value)) {
        status(`不支持的K线周期: ${String(cmd.value)}`, "error");
        return;
      }
      klt = value;
      // 切周期只需要重拉 K 线，盘口和分时上一轮刚取过
      await loadPanel({ withDepth: false, withTrend: false });
      return;
    }
    case "panel":
      if (!selected) {
        status("还没选中自选股", "error");
        return;
      }
      await loadPanel();
      status(panel?.error ? `刷新失败：${panel.error}` : "盘面数据已刷新", panel?.error ? "error" : "ok");
      return;
    case "testAlert": {
      // 界面上的「试一下」：绕开按日去重，验证通知与宠物反应这条链路通不通
      const hit = {
        key: `test:${Date.now()}`,
        kind: "upper",
        secid: "test",
        code: "TEST",
        name: "测试",
        message: "这是一条盯盘测试提醒",
        level: "up",
        at: Date.now(),
      };
      await fireAlerts([hit]);
      pushState();
      status("测试提醒已发出", "ok");
      return;
    }
    default:
      status(`未知指令: ${String(cmd.action)}`, "error");
  }
}

export async function activate(context) {
  stopped = false;
  ctx = context;

  for (const key of ["watch", "config", "alerted", "sources"]) {
    try {
      const saved = await ctx.storage.get(key);
      if (key === "watch") watch = restore("watch", saved, []);
      else if (key === "config") config = restoreConfig(saved);
      else if (key === "sources") sourcePrefs = restore("sources", saved, sourcePrefs);
      else alerted = restore("alerted", saved, {});
    } catch (err) {
      ctx.log?.(`读取 ${key} 失败`, err);
    }
  }

  ctx.bus.subscribe(TOPIC_CMD, (p) => void handleCmd(p));

  pushState();
  await syncOverlay();
  restartTimer();
  if (watch.length) void tick("startup");
  status(
    watch.length
      ? `盯 ${watch.length} 只，间隔 ${config.intervalSec}s`
      : "已就绪：到「A股盯盘」页面添加自选股",
  );
}

export async function deactivate() {
  stopped = true;
  stopTimer();
  // 等在飞的显隐切换落完再收窗，否则后到的 show 会把卡重新点亮
  try {
    await overlayChain;
  } catch {
    /* 链上的错误都在 syncOverlayOnce 里吞掉了 */
  }
  overlayChain = Promise.resolve();
  try {
    await ctx?.overlay.destroy();
  } catch {
    /* 没开过卡就没有卡 */
  }
  ctx = null;
  clearQuotes();
  // 面板状态跟着插件一起下线，重新启用时由设置页重新 select，免得留着上一轮的在飞请求归属
  selected = "";
  resetPanelOnStop();
  // sourcePrefs 不清：它就是「重启后还认」的那份记忆（storage 里的 sources），下次 activate 读回来
}
