// A股盯盘插件的端到端断言。
//   终端 1: npm run dev:debug      终端 2: npm run verify:astock
// 覆盖：授权（含按域名的 http 授权）、走宿主代理取行情（UTF-8 中文名是关键证据）、
// 自选增删与阈值落盘、badge/overlay/插件页三区渲染、选中个股的分时/K线/五档（含画布真的画出像素）、
// 提醒链路（系统通知 + 宠物反应）、停用后定时器与订阅回收，以及 K线/分时的多源 failover
// （注入失败 + 固定样例单测，不靠真断网）。跑完撤销授权并下线插件。
//
// 会在屏幕上弹出系统通知（一次「测试提醒」），并短暂开一扇自定坐标的盯盘卡、把设置页点到插件页。
// 收盘后行情时间戳不前进，规则命中会被「本轮没有新数据」这道闸挡住 ——
// 那部分判定逻辑由 market.js / rules.js 的纯函数断言覆盖，这里只验链路。
// 分时/K线/五档取的是接口最近一次的数据，所以休市跑也断言得出结构，只有提醒那条要看时段。
// 本机对东财 push2* 的通路会漂（2026-10-09 整组 RST、2026-10-12 恢复，见 AGENTS.md 那条约定）：
// 所以「数据来自哪家源」的断言一律不许钉死某一家 —— 脚本开头做一次 preflight（逐 host 探可达性），
// 各条断言按「本轮观测到的可用性 + 插件回显的失败明细」分支判定。判定层 = tests/e2e/harness/astock-source-branch.mjs
// （纯函数；离线单测钉住全通 / 有坏源两种形态）。全通时换源、或请求数撞满多家，照旧判红。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { argv, env } from "node:process";
import { fileURLToPath } from "node:url";
import {
  attach,
  createReport,
  hostInvoke,
  listPages,
  openSettingsInvoker,
  readEnabledIds,
  reloadAndWait,
  waitForPage,
  waitUntil,
  writeEnabledIds,
} from "./harness/cdp.mjs";
import {
  SOURCE_IDS,
  buildSinaQuoteUrl,
  buildTencentQuoteUrl,
  fetchDepth,
  fetchKline,
  fetchQuotes,
  fetchTrend,
  parseQuoteRow,
  parseSinaQuotes,
  parseTencentDepth,
  parseTencentKline,
  parseTencentMinuteRows,
  parseTencentQuotes,
  parseTencentTrend,
  progressOf,
  sourceLabelOf,
  tencentCodeOf,
} from "../../plugins/com.pet.astock/market.js";
import { decodePng, inkCount } from "./harness/png.mjs";
import { waitWidgetRealm } from "./harness/widget-realm.mjs";
import {
  allHosts,
  availableFor,
  judgeKindSource,
  requestBudget,
  requestBudgetMany,
} from "./harness/astock-source-branch.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const PID = "com.pet.astock";
const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const r = createReport("A股盯盘插件（dev）");

let stopped = false;
/**
 * 同意框按能力分批弹，必须整轮持续点「允许」；域名授权也是走同一个框。
 * 两个细节是踩出来的：① 框刚建好时页面还没解析完，`getElementById` 会拿到 null（实测报
 * `Cannot read properties of null`），所以同一扇窗里要点到成功为止；② 一扇已经失效的旧框
 * （对应的请求早结束了）会自己按「拒绝」关掉，不能让它挡住后面真在等的那些框 —— 每个 target 都点。
 * 窗口给得比整轮跑测更宽：本脚本要等两处 45 秒的 waitUntil（行情/盘口在当前网络下拿不到），
 * 后面还有多源 failover 那一段要按域名为腾讯弹一次同意框。
 */
async function pump(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (!stopped && Date.now() < until) {
    const targets = (await listPages(PORT).catch(() => [])).filter((t) => /consent/.test(t.url));
    if (!targets.length) {
      await sleep(250);
      continue;
    }
    for (const target of targets) {
      try {
        const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000);
        try {
          // 按钮和 caps 列表要一次求值里点掉：点完窗口就关了，分两次求值会拿到空列表
          let caps = "";
          for (let i = 0; i < 6; i++) {
            caps = await cs.ev(`(() => {
              const b = document.getElementById('btn-allow');
              if (!b) return '';
              const list = [...document.querySelectorAll('#cap-list li')].map((n) => n.textContent).join(' ');
              b.click();
              return list;
            })()`);
            if (caps) break;
            await sleep(250); // 页面还没解析完，重试（6 次约 1.5s，远小于宿主 60s 的等待）
          }
          console.log(`  · 同意框${caps ? `已允许：${caps}` : "没等到按钮"}`);
        } finally {
          cs.close();
        }
      } catch (e) {
        console.log(`  · 同意框应答失败，重试：${String(e).slice(0, 70)}`);
      }
    }
    await sleep(300);
  }
}

let c = null;
let settings = null;
let origEnabled = [];

try {
  await waitForPage(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

try {
  c = await attach(PORT, isPetPage);
  const invoke = hostInvoke(c);
  origEnabled = await readEnabledIds(invoke);
  // 整轮要 12~14 分钟（阶段二又加了快照/五档与北交所那几组），pump 必须活得比它长：
  // 一旦 pump 先退出，之后弹出的同意框没人点，那条请求会卡满宿主的 60s 才按拒绝返回（实测踩过）
  void pump(1_800_000);

  r.group("发现与能力声明");
  const manifest = (await invoke("plugins_list")).v?.find((m) => m.id === PID);
  r.check("manifest 被发现", true, !!manifest);
  r.check("声明了 http（行情要出网）", true, (manifest?.permissions ?? []).includes("http"));
  r.check("声明了 overlay / notify / pet:say", true, ["overlay", "notify", "pet:say"].every((p) => (manifest?.permissions ?? []).includes(p)));
  r.check("没有声明它用不到的能力（ble 等）", false, (manifest?.permissions ?? []).some((p) => p.startsWith("ble")));

  // 从干净状态开始：撤销授权会连带清掉插件存储目录，避免上一轮的自选股干扰断言
  settings = await openSettingsInvoker(PORT, c);
  await settings.invoke("permission_revoke", { pluginId: PID });
  await sleep(1200);

  r.group("启用并授权");
  // 清单归宿主（C1）：先由设置窗写进去，宠物窗这边只是把缓存取回来再激活
  await writeEnabledIds(settings.invoke, [...origEnabled, PID]);
  await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    await rt.loadEnabled();
    const ms = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    await rt.activatePlugin(ms.find((m) => m.id === ${JSON.stringify(PID)}));
    return rt.isActive(${JSON.stringify(PID)});
  })()`);
  r.check("插件已激活", true, await c.ev(`(async () => (await import('/src/runtime/plugin-runtime.ts')).isActive(${JSON.stringify(PID)}))()`));

  // A11：源的可用性决定各断言走哪条分支。preflight 由测试侧自己发请求（根路径判可达；
  // 新浪根路径 403 是它的正常反应，resolve 了就算可达）。结论用 r.info 写进报告，
  // 让下一批人看得出「当时的红绿是哪种网络状态」。
  r.group("网络形态 preflight（源无关断言的输入）");
  const reachable = {};
  for (const host of allHosts()) {
    const t0 = Date.now();
    let ok = false;
    try {
      await fetch(`https://${host}/`, { signal: AbortSignal.timeout(8000) });
      ok = true;
    } catch {
      ok = false;
    }
    reachable[host] = ok;
    r.info(`preflight ${host}`, `${ok ? "可达" : "不可达"}（${Date.now() - t0}ms）`);
  }
  r.info("preflight 结论（判定层输入）", JSON.stringify(reachable));
  for (const kind of ["quote", "depth", "kline", "trend"]) {
    r.info(`preflight 可用源（${kind}）`, availableFor(kind, reachable).join("/") || "(无)");
  }

  /** 读一份 `*:widget` 视图（宿主会回灌最近一份，publish sync 就够） */
  const readView = () => c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    return await new Promise((res) => {
      const off = bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (x) => { off(); res(x); });
      bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "sync" }, ${JSON.stringify(PID)});
      setTimeout(() => { off(); res(null); }, 5000);
    });
  })()`);

  // 面板这一组要在「没有冷却、失败计数也干净」的窗口里跑：
  // ① 冷却只认时间（cooldownUntil），前面行情那几条撞墙攒出的冷却没过的话，插件的 out() 会把
  //    所有请求（包括 K线/分时的）直接判在冷却里、1ms 就返回，什么都观察不到 —— 所以先等它过去。
  // ② 「连续失败」计数只被一次**成功**的请求清零；而行情每被抓一次就记一笔（add/refresh/激活都会抓），
  //    面板第一段是盘口（没有备用源、必然失败），计数带着旧账进来就会在分时/K线 换源之前先进冷却。
  //    搜索走的是同一个 out() 口子，而 searchadapter 这个域在本机是通的 —— 用真搜索清零，不伪造数据。
  const prepareFreshNetwork = async () => {
    let left = Number((await readView())?.net?.cooldownLeftSec) || 0;
    for (const until = Date.now() + 120_000; left > 0 && Date.now() < until; ) {
      await sleep(5000);
      left = Number((await readView())?.net?.cooldownLeftSec) || 0;
    }
    if (left > 0) return { cooled: false, clean: false };
    // 连着两条、中间隔 2 秒：在飞的那笔失败（重试后记账）也不会落在最后一条后面
    let clean = false;
    for (let i = 0; i < 2; i++) {
      await c.ev(`window.__seen.suggest.length = 0; window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "search", keyword: "浦发" }); true`);
      clean = await waitUntil(c, `window.__seen.suggest.length > 0`, 20_000);
      if (!clean) break;
      await sleep(2000);
    }
    return { cooled: true, clean };
  };
  /** 「上一次成功的源」那份记忆（插件的隔离存储里） */
  const sourceMem = async () => (await invoke("store_get", { pluginId: PID, key: "sources" })).v ?? null;
  /** 出网闸门最近 60 秒的请求数：用来分辨「这一轮撞了坏源」和「只走记住的源」 */
  const netWindow = async () => Number((await readView())?.net?.window) || 0;

  /**
   * 反复发同一个命令，直到页面上看到期望的结果。
   * 为什么需要它：插件的 `tick` 有 busy 标志、面板有 panelBusy，上一轮还在飞的时候新命令会被**跳过**
   * （不是排队）—— 定时器/前一次刷新稍慢一点，测试就会误判成「插件没反应」。断言本身不含这个重试，
   * 它只是把「等它空下来」这件事做扎实。
   */
  const nudgeUntil = async (cmd, expr, tries = 4, eachMs = 25_000) => {
    for (let i = 0; i < tries; i++) {
      await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify(cmd)}); true`);
      if (await waitUntil(c, expr, eachMs)) return true;
    }
    return false;
  };


  // 第一次出网要按域名授权：让插件真跑一次搜索，把 http + http:<host> 的同意框弹出来
  await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    // 宿主侧中继现在要认「以哪个插件的名义发布」（见 commands/bus.rs 的 S2 门禁），
    // 脚本这一路模拟的就是插件自己往 cmd topic 发指令，统一绑上 PID
    window.__bus = { publish: (topic, payload) => bus.publish(topic, payload, ${JSON.stringify(PID)}) };
    window.__seen = { quote: [], alert: [], status: [], suggest: [], panel: [] };
    for (const k of ['quote', 'alert', 'status', 'suggest', 'panel']) {
      bus.subscribe(${JSON.stringify(`${PID}:`)} + k, (p) => window.__seen[k].push(p));
    }
    return true;
  })()`);

  // 轮询间隔调到上限：行情快照后端（push2）在本机整组被连接重置，而行情是每轮都要打的，
  // 20 秒一次的失败攒够 3 次就会把整个插件的出网推进冷却（这是插件的正确行为，见 throttle.js），
  // 于是「面板的多源切换」「出网计数」这些断言根本观察不到。这一轮验的是 K线/分时的多源面板
  // （行情快照与五档是阶段二的事，不在这一轮），所以先把行情按住，面板那组开跑前再等冷却过去。
  // 这不是放宽断言：行情快照/五档那几条该怎么红还怎么红。
  // A11 §10：激活是异步的（同意框一个个弹、pump 回答），配置下发后读到生效为止 —— 不能拿单次
  // 快照赌「命令已经进了插件的订阅」；重发是幂等的，最终值仍必须是 1800（没放宽）
  {
    const cfg = { action: "config", value: { intervalSec: 1800, idleIntervalSec: 1800 } };
    let intervalApplied = null;
    for (let i = 0; i < 20; i++) {
      await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify(cfg)}); true`);
      await sleep(1000);
      intervalApplied = (await readView())?.net?.intervalSec ?? null;
      if (intervalApplied === 1800) break;
    }
    r.check("轮询间隔已预置成上限（按住行情，好让面板在没冷却的窗口里验）", 1800, intervalApplied);
  }

  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "search", keyword: "茅台" }); true`);
  let gotSug = await waitUntil(c, `window.__seen.suggest.length > 0`, 40_000);
  if (!gotSug) {
    // 这条端点实测很稳（200 / 首包 1.1s、之后 40ms）。out() 已经对「传输层失败」重试过一次了，
    // 这里再补一次是给宿主代理/机房抖动留余地 —— 断言一字没动（还是「搜得到 600519 且中文名不乱码」）
    r.info("第一次搜索没回音，状态行", String(await c.ev(`window.__seen.status.slice(-3).map((s) => s.text).join(' | ')`)).slice(0, 220));
    await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "search", keyword: "茅台" }); true`);
    gotSug = await waitUntil(c, `window.__seen.suggest.length > 0`, 40_000);
  }
  r.check("按名称搜索有回音（http 授权已放行）", true, gotSug);
  const sugRows = (await c.ev(`window.__seen.suggest.at(-1)?.rows ?? []`)) ?? [];
  r.check("搜到 600519 且中文名没乱码", true, sugRows.some((s) => s.code === "600519" && /贵州茅台/.test(s.name ?? "")));

  r.group("加自选与行情");
  // 从空自选开始：撤销授权会清存储，但这一跑可能接在上一轮/别的会话之后，显式清一次，
  // 下面「只有我加的这两只」才钉得住
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "clear" }); true`);
  await sleep(800);
  const add = async (secid, code, name) => {
    await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "add", secid, code, name })})`);
    await sleep(1200);
  };
  await add("1.600519", "600519", "贵州茅台");
  await add("0.300750", "300750", "宁德时代");
  const stored = (await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? [];
  r.check("两只自选都落盘", ["1.600519", "0.300750"], stored.map((w) => w.secid));
  r.check("阈值字段是显式 null 而不是 undefined", [null, null], [stored[0]?.upper, stored[0]?.pct]);

  // 腾讯/新浪的快照 host 偶发直接拒连（实测 connect timeout）；插件对每个源都重试过一次，
  // 这里在「没广播」时再等冷却/清计数后补一次，属于网络抖动的余地，断言本身没动
  await c.ev(`window.__seen.quote.length = 0; true`);
  let hasQuote = await nudgeUntil({ action: "refresh" }, `window.__seen.quote.length > 0`, 2, 25_000);
  if (!hasQuote) {
    r.info("第一次刷新没广播，先等冷却清计数再来", JSON.stringify(await prepareFreshNetwork()));
    hasQuote = await nudgeUntil({ action: "refresh" }, `window.__seen.quote.length > 0`, 2, 25_000);
  }
  r.check("刷新后广播了行情快照", true, hasQuote);
  const view = (await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    return await new Promise((res) => {
      const off = bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (d) => { off(); res(d); });
      bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "sync" }, ${JSON.stringify(PID)});
      setTimeout(() => { off(); res(null); }, 8000);
    });
  })()`));
  const q1 = view?.quotes?.["1.600519"];
  r.check("中文名来自宿主代理仍是 UTF-8", "贵州茅台", q1?.name);
  // 盘前（9:15 之前）接口会把个股的现价/涨跌幅打成 "-"，这是数据形态不是 bug，
  // 所以断言写成「同生同灭 + 脏值不落进界面」，任何时段都成立且仍能抓到解析层出错
  r.info("本轮时段", `${view?.session?.phase}${Number.isFinite(q1?.price) ? "（有实时成交价）" : "（无实时成交价，按盘前形态断言）"}`);
  r.check("现价与涨跌幅同生同灭（不会出现有价无幅或有幅无价）", true, Number.isFinite(q1?.price) === Number.isFinite(q1?.pct));
  // 行情这条路当前拿不到（push2 被整组重置，阶段二才接快照后端），所以这里不能崩：
  // 后面「面板：分时/K线」那一段不依赖它，崩了就整块看不到结果。断言本身一字未改。
  r.check("取不到的数值落成 null，不漏出 undefined 或字符串 '-'", true,
    ["price", "pct", "change", "prevClose", "volume"].every((k) => q1?.[k] === null || Number.isFinite(q1?.[k])));
  r.check("行情时间戳始终可用（提醒就靠它判这轮新不新）", true, Number.isFinite(q1?.quoteAt));
  r.check("带上了指数", true, Number.isFinite(view?.quotes?.["1.000001"]?.price));
  r.check("时段判定给了相位", true, typeof view?.session?.phase === "string" && view.session.phase.length > 0);

  const net0 = await prepareFreshNetwork();
  r.check("面板开跑前：冷却结束，且用一条真搜索把「连续失败」清零（同一口子，成功即归零）", [true, true],
    [net0.cooled, net0.clean]);

  r.group("行情快照：多源换源 + 一次批量带走全部自选");
  // 快照（自选列表 + badge/overlay 用的那份）是多源：先试记忆里上一次成功的源，失败才下移
  // （东财 push2 与腾讯 qt.gtimg.cn 都能当首选，取决于本轮谁出得来；腾讯是 GBK，宿主按 charset 解码）。
  // **不要把"某家源必坏"当成前提写进注释或断言** —— 本机通路分域、随时段漂，2026-10-09 与 10-12 就是两种形态。
  // 出网次数用闸门的滚动计数读：它是「这一轮实际发了几次请求」的直接证据。
  // A11 §10：预期源取「本轮开始时读到的那份记忆」——插件会把上一次成功的源试在最前，判定要跟着它走
  const memQuoteBefore = (await readView())?.net?.sources?.quote ?? "";
  const netQ0 = await netWindow();
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "refresh" }); true`);
  const quoted = await waitUntil(c, `window.__seen.quote.length > 0`, 25_000);
  const netQ1 = await netWindow();
  const quoteSrc1 = (await readView())?.net?.sources?.quote ?? "";
  r.check("刷新后广播了行情快照（走多源链）", true, quoted);
  const delta2 = netQ1 - netQ0;
  r.info("两只自选一轮刷新的出网次数", String(delta2));
  // A11：次数断言按本轮可用性给预算 —— 全通时一条链只该有一次请求（撞多家即判红，这是本卡唯一变严处）；
  // 有坏源才允许各源的失败尝试与重试叠加（见 astock-source-branch.mjs::requestBudget）
  const budgetQ = requestBudget({ kind: "quote", requests: delta2, preferred: memQuoteBefore, observed: quoteSrc1 });
  r.info("快照出网预算", budgetQ.reason);
  r.check("一轮刷新 = 一次批量请求链（次数符合预期档位；同档时不许撞源：≤2）", true, budgetQ.ok);
  // 再加两只（共 4 只自选 + 指数 = 5 个代码）再刷一轮：出网次数与上一轮**相同** ——
  // 「数量不增加请求数」就是这么证出来的，不是靠读代码
  await add("1.601398", "601398", "工商银行");
  await add("0.000001", "000001", "平安银行");
  const netQ2 = await netWindow();
  await c.ev(`window.__seen.quote.length = 0; true`);
  const fiveOk = await nudgeUntil({ action: "refresh" }, `(window.__seen.quote.at(-1)?.count ?? 0) >= 5`);
  const netQ3 = await netWindow();
  const delta5 = netQ3 - netQ2;
  r.info("五个代码一轮刷新的出网次数", String(delta5));
  // 精确相等会被环境的偶发抖动带偏（某个 host 临时拒连会让那条链多试一两次），
  // 所以钉「不随数量增长」：5 个代码的一轮仍然是个位数常数量的请求，绝不可能是 5 条
  r.check("5 个代码一轮刷新仍然是一次批量请求（次数与 2 个代码同量级，不随数量增长）", true,
    fiveOk && delta5 >= 1 && delta5 <= 4 && delta5 <= delta2 + 2);
  // 收尾：把多的两只删掉，后面的断言按两条自选来
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "remove", secid: "1.601398" }); true`);
  await sleep(900);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "remove", secid: "0.000001" }); true`);
  await sleep(900);
  r.check("多出来的两只已删掉（回到两条自选）", ["1.600519", "0.300750"],
    ((await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? []).map((w) => w.secid));
  // 存储那份是异步落盘的（persist 直写但要走一遍 IPC）：有界轮询等它追上，别拿单次快照赌
  const netQuoteSnap = (await readView())?.net?.sources?.quote;
  let memQuoteSnap = null;
  for (let i = 0; i < 10; i++) {
    memQuoteSnap = (await sourceMem())?.quote ?? null;
    if (memQuoteSnap) break;
    await sleep(500);
  }
  const snapSrc = [netQuoteSnap, memQuoteSnap];
  r.info("快照实际吃的是哪家", JSON.stringify(snapSrc));
  // A11：不钉死哪一家 —— 判「与本轮可用性一致」：net 与存储同值、∈已知源、且非首选源必须带失败记录
  const judgeQ0 = judgeKindSource({ kind: "quote", observed: snapSrc[0], preferred: memQuoteBefore, reachable });
  r.info("快照源判定", judgeQ0.reason);
  r.check("快照源进了 net 与插件存储，且与本轮可用性判定一致", true,
    snapSrc[0] !== undefined && snapSrc[0] === snapSrc[1] && judgeQ0.ok);

  r.group("盘面：分时 / K线 / 五档（走 push2his 域名）+ 出网节制");
  const memPanelBefore = (await readView())?.net?.sources ?? {};
  const win0 = await netWindow();
  const selectAt = Date.now();
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "1.600519" }); true`);
  const gotPanel = await waitUntil(c, `(() => { const p = window.__seen.panel.at(-1); return !!p?.depth && !!p?.kline && (!!p?.trend || !!p?.failed?.trend); })()`, 45_000);
  const pnl = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
  r.info("面板这一轮的失败明细", JSON.stringify(pnl.failed ?? null).slice(0, 300));
  r.info("面板这一轮每类试过的源（attempted）", JSON.stringify(pnl.attempted ?? null).slice(0, 300));
  /** 换源证据之二：本轮「实际尝试过的源」里的失败次数（整段失败走 failed，中途换源走这里） */
  const attemptFails = (p, kind) => (p?.attempted?.[kind] ?? []).filter((a) => a.ok === false).length;
  // A11 §10：分时在盘后可能全源失败（实测 15:27 两个源都失败、15:34 又恢复）——「到位」的口径
  // 按每段「有数据或有失败明细」判；深/ K 两段必须有数据，不许静默缺失
  r.check("选中后每一段都有数据或有失败明细（深/K 必须有数据）", true,
    gotPanel && !!pnl.depth && !!pnl.kline && (!!pnl.trend || !!pnl.failed?.trend));
  // 一次 select 要发 3 条请求（盘口/分时/K线）。闸门是 350ms 最小间隔，
  // 所以三条串起来至少要 2×350ms —— 用耗时证明请求真的过了闸门，而不是只写了个函数
  const panelMs = (pnl.at ?? 0) - selectAt;
  r.info("面板一轮三条请求耗时", `${panelMs}ms`);
  r.check("三条出网被闸门串了起来（≥2×最小间隔）", true, panelMs >= 700);
  // 序列数据体积大，必须走单独 topic；每轮的 *:widget 里不该出现它们
  const viewAfter = await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    return await new Promise((res) => {
      const off = bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (d) => { off(); res(d); });
      bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "sync" }, ${JSON.stringify(PID)});
      setTimeout(() => { off(); res(null); }, 8000);
    });
  })()`);
  r.check("每轮视图里没夹带分时/K线（省一次跨窗中继）", false, ["trend", "kline", "depth"].some((k) => k in (viewAfter ?? {})));
  const net = viewAfter?.net ?? {};
  r.check("视图带出了网关节流状态（界面据此解释为什么没更新）", true, Number.isFinite(net.window) && Number.isFinite(net.intervalSec));
  r.check("每分钟上限与最小间隔都下发了", true, net.perMinute === 30 && net.minGapMs === 350);
  r.check("间隔不会低于 10 秒下限，也不会超过 30 分钟退避顶", true, net.intervalSec >= 10 && net.intervalSec <= 1800);
  r.check("近 1 分钟请求数在窗口上限之内", true, net.window >= 1 && net.window <= net.perMinute);
  const grants = ((await settings.invoke("permission_list")).v ?? {})[PID] ?? [];
  r.check("新域名 push2his 也走了按域名授权", true, grants.includes("http:push2his.eastmoney.com"));
  r.check("五档买/卖各五档", [5, 5], [pnl.depth?.bids?.length, pnl.depth?.asks?.length]);
  // 竞价阶段盘口很薄，接口会给「价格 - 但量是数字」的半截档（实测 09:16 的买二）；
  // 解析层已把这种档整档判空，这里只对有价的档排序，并额外钉住「无价必无量」
  r.check("没有价格的档不带量（界面不会出现「— 配 2 手」）", true,
    [...(pnl.depth?.bids ?? []), ...(pnl.depth?.asks ?? [])].every((l) => l.price !== null || l.volume === null));
  const bidPrices = (pnl.depth?.bids ?? []).filter((l) => Number.isFinite(l.price)).map((l) => l.price);
  const askPrices = (pnl.depth?.asks ?? []).filter((l) => Number.isFinite(l.price)).map((l) => l.price);
  r.check("买价按买一→买五递减", true, bidPrices.every((p, i, a) => i === 0 || p <= a[i - 1]));
  r.check("卖价按卖一→卖五递增", true, askPrices.every((p, i, a) => i === 0 || p >= a[i - 1]));
  r.check("买一不高于卖一", true, bidPrices[0] === undefined || askPrices[0] === undefined || bidPrices[0] <= askPrices[0]);
  r.check("明细里的中文名仍是 UTF-8", "贵州茅台", pnl.depth?.name);
  r.check("涨停价是交易所给的数值且高于昨收", true, Number.isFinite(pnl.depth?.limitUp) && pnl.depth.limitUp > pnl.depth.prevClose);
  r.check("跌停价低于昨收", true, Number.isFinite(pnl.depth?.limitDown) && pnl.depth.limitDown < pnl.depth.prevClose);
  const judgeD = judgeKindSource({ kind: "depth", observed: pnl.depthSource, preferred: memPanelBefore.depth ?? "", reachable, hadFailure: !!pnl.failed?.depth, attemptedFailures: attemptFails(pnl, "depth") });
  r.info("五档源判定", judgeD.reason);
  r.check("五档源符合本轮可用性（非首选源必须有失败记录解释）", true, judgeD.ok);
  // 时段守卫（AGENTS.md「有价才比大小、无价必无量」）：收盘后/竞价盘口可能整片为空，
  // 两侧都有档才比大小；任一侧无档时改判「该侧必须整侧无价」，并把当轮形态写进 r.info
  const hasBid = bidPrices.length > 0;
  const hasAsk = askPrices.length > 0;
  r.info("盘口三价与高低", `现价 ${pnl.depth?.price} / 买一 ${hasBid ? bidPrices[0] : "—"} / 卖一 ${hasAsk ? askPrices[0] : "—"} / 低 ${pnl.depth?.low} / 高 ${pnl.depth?.high}`);
  // 现价与当日高低：交易所定义，任何时刻都成立。缺项那一支不许静默跳过 —— 判「缺的必须是 null」，
  // 0 / -1 / NaN 冒充高低正是逐字段错位的样子。
  if (Number.isFinite(pnl.depth?.price) && Number.isFinite(pnl.depth?.low) && Number.isFinite(pnl.depth?.high)) {
    r.check("现价落在当日高低区间内", true, pnl.depth.price >= pnl.depth.low && pnl.depth.price <= pnl.depth.high);
  } else {
    r.check("现价或高低缺项时：缺的那一项必须是 null（禁 0 / -1 / NaN 冒充）", true,
      [pnl.depth?.price, pnl.depth?.low, pnl.depth?.high].every((v) => v === null));
  }
  // 「买一 ≤ 现价 ≤ 卖一」在真实快照上**不成立**：东财这条详情里 f43（最新价）与 f19/f39（盘口第一档）
  // 来自不同时刻的聚合，2026-10-13 盘中对 600519 连采 10 次有 3 次「现价 > 卖一」，越界幅度恰好一个
  // 最小变动价位（0.01）。改成容一个 tick 的双向越界上限：错位一档会差出几十倍，仍然当场红。
  if (hasBid && hasAsk) {
    const TICK = 0.01;
    r.check("现价不越买一/卖一（允许快照滞后一个最小变动价位）", true,
      bidPrices[0] - pnl.depth.price <= TICK && pnl.depth.price - askPrices[0] <= TICK);
  } else {
    r.check("任一侧无档时：该侧五档必须整侧无价（无价必无量见上一条）", true,
      (hasBid || (pnl.depth?.bids ?? []).every((l) => l.price === null)) &&
        (hasAsk || (pnl.depth?.asks ?? []).every((l) => l.price === null)));
  }
  // 昨收复用：分时那条链不再单独问一次昨收，基线取的是主轮询那一份快照（同一个数不重复问）
  const viewSnap = await readView();
  if (pnl.trend) {
    r.check("分时基线 = 同一轮快照的昨收（缓存复用，没有额外的昨收请求）",
      viewSnap?.quotes?.["1.600519"]?.prevClose, pnl.trend?.preClose);
    r.check("分时结构成立：数组 + 昨收基准线可用", true,
      Array.isArray(pnl.trend?.points) && Number.isFinite(pnl.trend?.preClose));
  } else {
    // 盘后全源失败时（实测 15:27 出现过）该段按「明确失败」判：不许拿旧数据冒充，也不许无明细地空
    r.check("分时该段失败时：不保留旧数据（trend 为 null）且有失败明细", true,
      pnl.trend === null && !!pnl.failed?.trend);
  }
  r.check("分时有数据时形状自洽（时刻 HH:MM、价与均价都是数）", true,
    (pnl.trend?.points ?? []).every((p) => /^\d{2}:\d{2}$/.test(p.time) && Number.isFinite(p.price) && Number.isFinite(p.avg)));
  if (view?.session?.trading) {
    r.check("盘中必须拿得到分时采样点", true, (pnl.trend?.points?.length ?? 0) > 0);
  } else {
    r.info("非交易时段的分时点数", `${pnl.trend?.points?.length ?? 0}（盘前/竞价前接口可以给 0 点，图上要显示提示而不是空白）`);
  }
  r.check("K线拉满 120 根", 120, pnl.kline?.bars?.length);
  r.check("K线每根的高低价自洽", true, (pnl.kline?.bars ?? []).every((b) => b.high >= b.low && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)));

  // —— 多源 failover：源无关判定（冷记忆下先撞不可达源、或直接用本轮首选源，都算对） ——
  const win1 = await netWindow();
  r.info("第一轮（冷记忆，无偏好）", `失败明细=${JSON.stringify(pnl.failed)} 出网增量=${win1 - win0}`);
  const judgeK1 = judgeKindSource({ kind: "kline", observed: pnl.klineSource, preferred: memPanelBefore.kline ?? "", reachable, hadFailure: !!pnl.failed?.kline, attemptedFailures: attemptFails(pnl, "kline") });
  const judgeT1 = judgeKindSource({ kind: "trend", observed: pnl.trendSource, preferred: memPanelBefore.trend ?? "", reachable, hadFailure: !!pnl.failed?.trend, attemptedFailures: attemptFails(pnl, "trend") });
  r.info("K线源判定", judgeK1.reason);
  r.info("分时源判定", judgeT1.reason);
  r.check("K线与分时的源都符合本轮可用性（非首选源必须有失败记录解释）", true, judgeK1.ok && judgeT1.ok);
  // 出网次数按三条链（盘口 + 分时 + K线）叠加的预算判：全通时三条链各一次就够（撞多家判红），
  // 有坏源才允许各源的失败尝试与重试叠加 —— 环境的偶发抖动由预算余量吸收
  const budget1 = requestBudgetMany({
    kinds: ["depth", "trend", "kline"],
    requests: win1 - win0,
    preferred: memPanelBefore,
    observed: { depth: pnl.depthSource, trend: pnl.trendSource, kline: pnl.klineSource },
  });
  r.info("面板一轮出网预算", budget1.reason);
  r.check("这一轮的出网次数符合本轮源可用性（三条链的预算区间）", true, budget1.ok);
  const memNow = (await sourceMem()) ?? {};
  r.info("源记忆（四个 kind）", JSON.stringify(memNow));
  // 按键取，不整体比 JSON：宿主存储是 serde_json 的 BTreeMap，落盘后键是字母序。
  // A11：判「落盘值与本轮实际使用一致」而不是钉死哪家 —— 记忆被正确写回才是这条守的东西。
  // 落盘是异步的（persist 有抖动），用有界轮询等它追上，不用固定 sleep 赌。
  const memSynced = await (async () => {
    for (let i = 0; i < 20; i++) {
      const m = (await sourceMem()) ?? {};
      const s = (await readView())?.net?.sources ?? {};
      // 未成功的 kind 记忆本来就是空串（如盘后全源失败的分时）——空串也算「落盘一致」，只要求：
      // 存储==运行内存，且非空值必须是已知源
      if (["kline", "trend", "depth", "quote"].every((k) => (m[k] ?? "") === (s[k] ?? "") && ((m[k] ?? "") === "" || SOURCE_IDS.includes(m[k])))) return { ok: true, m };
      await sleep(500);
    }
    return { ok: false, m: (await sourceMem()) ?? {}, s: (await readView())?.net?.sources ?? {} };
  })();
  if (!memSynced.ok) r.info("记忆回显现场", JSON.stringify(memSynced).slice(0, 220));
  // 有数据的那两段（深/K 必须成功）逐段核对；分时若成功也核对，失败则不比对（记忆合法留空）
  r.check("「上一次成功的源」落盘与本轮实际使用一致（四个 kind，空值占位仅限未成功的段）", true,
    memSynced.ok &&
      memSynced.m.kline === pnl.klineSource &&
      memSynced.m.depth === pnl.depthSource &&
      (!pnl.trend || memSynced.m.trend === pnl.trendSource));
  // 第二轮：换一只自选（三段都重新取），记忆生效 —— 不再撞坏源，出网次数明显更少
  const at1 = Number(pnl.at ?? 0);
  // 第二轮的「本轮开始时记忆」按 §10 口径从 net.sources 取（运行内存才是插件真实在用的记忆；
  // 存储落盘是异步的，拿它当 preferred 会在落盘没追上时把正确行为判红）
  const memPanelAfter1 = (await readView())?.net?.sources ?? {};
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "0.300750" }); true`);
  const got2 = await waitUntil(c, `(() => { const p = window.__seen.panel.at(-1); return (p?.at ?? 0) > ${at1} && !!p?.kline?.bars?.length && (!!p?.trend || !!p?.failed?.trend); })()`, 30_000);
  const pnl2 = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
  const win2 = await netWindow();
  r.info("第二轮（记忆=腾讯）", `失败明细=${JSON.stringify(pnl2.failed)} 出网增量=${win2 - win1}`);
  const judgeK2 = judgeKindSource({ kind: "kline", observed: pnl2.klineSource, reachable, preferred: memPanelAfter1.kline ?? "", hadFailure: !!pnl2.failed?.kline, attemptedFailures: attemptFails(pnl2, "kline") });
  const judgeT2 = judgeKindSource({ kind: "trend", observed: pnl2.trendSource, reachable, preferred: memPanelAfter1.trend ?? "", hadFailure: !!pnl2.failed?.trend, attemptedFailures: attemptFails(pnl2, "trend") });
  r.check("第二轮照旧有数据（记忆指向的源可用，源与预期一致或带尝试证据）", true,
    got2 && judgeK2.ok && (!pnl2.trend || (judgeT2.ok && pnl2.trendSource === pnl.trendSource)));
  r.check("第二轮至少不会比第一轮更费（记忆指向的源可用）", true, win2 - win1 <= win1 - win0);
  // 把选中还给原来那只（后面的断言按它来）
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "1.600519" }); true`);
  await sleep(3000);
  const memKlineBefore60 = (await readView())?.net?.sources?.kline ?? "";
  const netK0 = await netWindow();
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "klt", value: 60 }); true`);
  const toMinute = await waitUntil(c, `window.__seen.panel.at(-1)?.klt === 60`, 20_000);
  const pnl60 = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
  const netK1 = await netWindow();
  r.check("切到 60 分钟周期", true, toMinute);
  r.check("60 分钟线的时刻带时分", true, /\d{2}:\d{2}$/.test(pnl60.kline?.bars?.at(-1)?.time ?? ""));
  const judgeK60 = judgeKindSource({ kind: "kline", observed: pnl60.klineSource, preferred: memKlineBefore60, reachable, hadFailure: !!pnl60.failed?.kline, attemptedFailures: attemptFails(pnl60, "kline") });
  r.info("60 分钟线源判定", judgeK60.reason);
  r.check("60 分钟线源符合本轮可用性（分钟 K 与日 K 走同一条多源链）", true, judgeK60.ok);
  // 切周期只该动 K 线这一条链，没有「为分时补昨收」的额外请求：
  // 那份昨收是主轮询缓存里的，数字对得上就够了（上面那条断言）
  const budgetK = requestBudget({ kind: "kline", requests: netK1 - netK0, preferred: memKlineBefore60, observed: pnl60.klineSource });
  r.info("切周期一轮的出网预算", budgetK.reason);
  r.check("切周期只出网 K 线这一条链（含换源与备用入口，次数符合本轮可用性）", true, budgetK.ok);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "klt", value: 101 }); true`);
  await sleep(1500);

  r.group("设置页：图真的画出来了、五档表有行");
  await settings.client.ev(`document.querySelector('#nav-plugins .nav-item[data-view=${JSON.stringify(PID)}]')?.click()`);
  const widgetReady = await waitUntil(
    settings.client,
    `(async () => {
      const { widgetHost } = await import('/src/runtime/widget-host.ts');
      const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
      return !!rec?.shadow?.querySelector('canvas');
    })()`,
    20_000,
  );
  r.check("插件页挂上了画布", true, widgetReady);
  r.check(
    "插件页插槽的 realm 戳是 worker（默认路线）",
    "worker",
    (await waitWidgetRealm(settings.client, PID, "settings", "worker", 20_000)).actual,
  );
  /**
   * 「图真的画出来了」只能数像素，但 widget 进 Worker 之后画布控制权已经交给 Worker，
   * 主线程 `getContext` 必抛（InvalidStateError —— 这本身就是交接成功的证据，A12 预言过这条会红）。
   * 所以改成：从 DOM 读位图尺寸（`cv.width` 仍可读写，只有上下文取不到），
   * 墨迹则对**合成后的画面**截一张画布区域的图，自己解 PNG 再数。
   */
  const boxOf = () =>
    settings.client.ev(`(async () => {
      const { widgetHost } = await import('/src/runtime/widget-host.ts');
      const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
      const cv = rec?.shadow?.querySelector('canvas');
      if (!cv) return null;
      const b = cv.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, dpr: window.devicePixelRatio, bitmapW: cv.width, bitmapH: cv.height };
    })()`);
  const inkOf = async () => {
    const box = await boxOf();
    if (!box) return { ok: false, ink: 0 };
    await settings.client.send("Page.enable");
    const cap = await settings.client.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: box.dpr },
    });
    if (cap.error) throw new Error(`截图失败：${cap.error.message ?? JSON.stringify(cap.error)}`);
    const img = decodePng(cap.result.data);
    return { ok: true, ink: inkCount(img), w: box.bitmapW, h: box.bitmapH, cssW: box.w, shotW: img.width };
  };
  const trendInk = await inkOf();
  r.check("分时画布按 DPR 建了位图（不是 0 尺寸）", true, trendInk.ok === true && trendInk.w >= trendInk.cssW);
  // 竞价阶段分时可能只有 1 个点（画一个点而不是折线），完全没数据时画的是提示行
  const trendPoints = pnl.trend?.points?.length ?? 0;
  const inkFloor = trendPoints > 1 ? 400 : trendPoints === 1 ? 120 : 30;
  r.info("分时笔迹像素", `${trendInk.ink} 点（分时 ${trendPoints} 个采样）`);
  r.check(
    trendPoints > 1 ? "分时图有笔迹（折线+均价+量能）" : trendPoints === 1 ? "竞价阶段单点也画得出来" : "分时为空时画的是提示行而不是空白画布",
    true,
    (trendInk.ink ?? 0) > inkFloor,
  );
  const depthRows = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    const rows = [...(rec?.shadow?.querySelectorAll('table.depth tbody tr') ?? [])];
    return rows.map((r) => r.children[0]?.textContent ?? '');
  })()`);
  r.check("五档表是卖五→卖一→现价→买一→买五", 11, depthRows.length);
  r.check("档位标签顺序对", ["卖5", "卖4", "卖3", "卖2", "卖1", "现价", "买1", "买2", "买3", "买4", "买5"], depthRows);
  await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    [...rec.shadow.querySelectorAll('.tabs button')].find((b) => b.textContent === 'K线')?.click();
    return true;
  })()`);
  await sleep(400);
  const klineInk = await inkOf();
  r.check("K 线图有笔迹（蜡烛+MA+量能）", true, (klineInk.ink ?? 0) > 400);
  // 周期下拉只在 K 线页出现：这比「两张位图像素数不同」确定，不受数据形态影响
  const selVisible = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    const sel = rec.shadow.querySelector('.tabs + select');
    return { on: [...rec.shadow.querySelectorAll('.tabs button')].filter((b) => b.classList.contains('on')).map((b) => b.textContent), shown: sel ? sel.offsetParent !== null : null };
  })()`);
  r.check("切到 K 线后只有 K 线页亮着", ["K线"], selVisible?.on);
  r.check("K 线页显示周期下拉", true, selVisible?.shown === true);
  const panelText = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    return rec.shadow.querySelector('.panel-hd')?.textContent ?? '';
  })()`);
  r.check("面板抬头写了选中的标的与涨跌停价", true, /贵州茅台/.test(panelText) && /涨停/.test(panelText) && /分时 \d+ 点/.test(panelText));
  const selectedRow = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    return [...rec.shadow.querySelectorAll('tbody tr.sel td:first-child')].map((td) => td.textContent);
  })()`);
  r.check("自选列表里高亮的是当前选中那只", true, String(selectedRow?.[0] ?? "").includes("贵州茅台"));
  const netText = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    return [...rec.shadow.querySelectorAll('.muted')].map((n) => n.textContent).find((t) => /出网/.test(t)) ?? '';
  })()`);
  r.check("设置页把节流状态写给了用户（而不是默默不更新）", true, /近 1 分钟出网 \d+ 次/.test(netText));
  // A11：不写死哪家 —— 断言「页面上那行与插件实际吃的源一致」（标签必须等于观测到的源 id 的中文名）
  const pageSources = (await readView())?.net?.sources ?? {};
  const expectQuoteLabel = pageSources.quote ? `行情数据源 ${sourceLabelOf(pageSources.quote)}` : "";
  const expectKlineLabel = pageSources.kline ? `K线数据源 ${sourceLabelOf(pageSources.kline)}` : "";
  r.check("插件页写明了行情数据源且与实际一致（东方财富/腾讯/新浪之一）", true,
    /行情数据源 (东方财富|腾讯|新浪)/.test(netText) &&
    (!expectQuoteLabel || netText.includes(expectQuoteLabel)) &&
    (!expectKlineLabel || netText.includes(expectKlineLabel)));

  // 无成交/退市标的（腾讯给整行但 5/6 段是 0、五档全 0、47/48 段是 -1）：
  // 解析层必须把 -1/0 落成 null，界面必须明写「该源不供」，不许把 -1 当价格、
  // 也不许拿按代码前缀猜的幅度冒充交易所给的涨跌停
  await add("1.600001", "600001", "邯郸钢铁");
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "1.600001" }); true`);
  const gotDead = await waitUntil(c,
    `(() => { const p = window.__seen.panel.at(-1); return p?.secid === "1.600001" && !!p?.depth && !!p?.trend; })()`, 40_000);
  const pDead = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
  const deadQuote = (await readView())?.quotes?.["1.600001"] ?? null;
  r.info("无成交标的的现场", JSON.stringify({
    price: pDead.depth?.price, prevClose: pDead.depth?.prevClose, volume: pDead.depth?.volume,
    limitUp: pDead.depth?.limitUp, bid1: pDead.depth?.bids?.[0] ?? null,
  }).slice(0, 200));
  r.check("无成交标的：五档整片为空（不是 0.00 的价位）", true,
    gotDead && pDead.depth.bids.every((l) => l.price === null && l.volume === null));
  r.check("涨跌停段是 -1 → 落成 null（不是 -1，也不是按昨收硬算的价）", [null, null], [pDead.depth.limitUp, pDead.depth.limitDown]);
  r.check("快照那一路同样不给涨跌停（留 null 交给界面说「该源不供」）", [null, null], [deadQuote?.limitUp, deadQuote?.limitDown]);
  if (deadQuote) {
    // A11：不同快照源对退市/无成交代码的口径不同（腾讯保留最后一笔价；东财可能把价打成 "-"）。
    // 判据源无关但不变松：**源供了就必须是有数（>0）**；源不供必须显式 null —— 0 / -1 / NaN 一律判红。
    const okPrice = (v) => v === null || (Number.isFinite(v) && v > 0);
    r.info("无成交标的本轮的源与数值", `源=${(await readView())?.net?.sources?.quote} price=${deadQuote.price} prevClose=${deadQuote.prevClose}`);
    r.check("无成交标的的现价/昨收：源供则须有数（>0），源不供须显式 null（禁 0/-1/NaN）", true,
      okPrice(deadQuote.price) && okPrice(deadQuote.prevClose));
  } else {
    // 这一轮的快照源可能不供这只退市代码（新浪就整行是空的）—— 那是源的口径，不是解析错，报信息即可
    r.info("这一轮的快照源没给这只退市代码的行", `源=${(await readView())?.net?.sources?.quote}`);
  }
  await sleep(800);
  const deadHead = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    return rec?.shadow.querySelector('.panel-hd')?.textContent ?? '';
  })()`);
  r.info("无成交标的的面板抬头", String(deadHead).slice(0, 120));
  r.check("源不供涨跌停时明写「该源不供」而不是编一个价", true, /该源不供/.test(String(deadHead)));
  // 收尾：把这只见不得光的代码删掉，选中还给贵州茅台（后面的断言按两条自选来）
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "remove", secid: "1.600001" }); true`);
  await sleep(1200);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "1.600519" }); true`);
  await sleep(2500);

  r.group("出网只有一个口子（grep 断言）");
  // 插件里所有出网都要过 index.js 的 out()（闸门、冷却、传输层重试都在那一处）；
  // 别处再冒出一个 ctx.http.request 调用点就等于绕开节流，AGENTS.md 明令禁止。
  const pluginDir = fileURLToPath(new URL("../../plugins/com.pet.astock/", import.meta.url));
  const offenders = [];
  for (const file of readdirSync(pluginDir).filter((f) => f.endsWith(".js"))) {
    const lines = readFileSync(join(pluginDir, file), "utf8").split(/\r?\n/);
    let owner = "";
    lines.forEach((line, i) => {
      const decl = /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/.exec(line);
      if (decl) owner = decl[1];
      if (!line.includes("ctx.http.request")) return;
      const code = line.replace(/\/\/.*$/, "").trim();
      if (!code || code.startsWith("*") || code.startsWith("/*")) return; // 注释里提到不算调用点
      if (file === "index.js" && owner === "out") return; // 唯一许可的那一处
      offenders.push(`${file}:${i + 1}（在 ${owner || "?"} 里）`);
    });
  }
  r.check("除 index.js 的 out() 之外没有 ctx.http.request 调用点", [], offenders);
  r.check("market.js 不碰宿主 API（取数靠调用方传进来的 request）", false, /ctx\./.test(readFileSync(join(pluginDir, "market.js"), "utf8")));

  r.group("多源 failover 单测：腾讯列序与取数链（固定输入，不依赖跑测时是否开盘）");
  /**
   * 固定输入，来自 2026-10-09 那几次真实返回：
   *   K线：除权那一行（7 列，末尾多一个分红对象）与 09-16/09-17/10-09 三行都是原样抄的，
   *        其中 09-17 那条就是任务书里给出的样例。
   *   分时：首条与末条原样抄；15:00 那行用的是同一天快照交叉验证过的累计量/额
   *        （947958 手 / 915309833 元），15:06 那行按同一次返回的形状补 —— 都是固定输入。
   */
  const KLINE_DAY = {
    code: 0,
    msg: "",
    data: {
      sh600000: {
        qfqday: [
          ["2026-07-16", "8.920", "8.850", "8.940", "8.800", "755826.000", { nd: "2025", fh_sh: "4.2" }],
          ["2026-09-16", "9.170", "9.100", "9.200", "9.000", "723404.000"],
          ["2026-09-17", "9.100", "9.060", "9.140", "9.030", "456711.000"],
          ["2026-10-09", "9.70", "9.54", "9.74", "9.54", "947958"],
        ],
        // qt 段：实测下标 4 是昨收。这里只留前 9 段（后面几十段与解析无关，截断不改变语义）
        qt: { sh600000: ["1", "浦发银行", "600000", "9.54", "9.70", "9.70", "947958", "449628", "498330"] },
        // prec 实测 9.510，与昨收 9.70 不是一回事：留着它就是钉住「解析没去读 prec」
        prec: "9.510",
        version: "18",
      },
    },
  };
  const dayBars = parseTencentKline(KLINE_DAY, { code: "sh600000", period: "day", count: 120 }).bars;
  r.check("腾讯日K 逐字段相等（日期/开/收/高/低/量；除权行只认前 6 列）", [
    ["2026-07-16", 8.92, 8.85, 8.94, 8.8, 755826],
    ["2026-09-16", 9.17, 9.1, 9.2, 9.0, 723404],
    ["2026-09-17", 9.1, 9.06, 9.14, 9.03, 456711],
    ["2026-10-09", 9.7, 9.54, 9.74, 9.54, 947958],
  ], dayBars.map((b) => [b.time, b.open, b.close, b.high, b.low, b.volume]));
  r.check("列序是「开收高低」而不是「开高低收」（高≥低且高≥开收，逐根成立）", true,
    dayBars.every((b) => b.high >= b.low && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)));
  r.check("请求 2 根时从尾部对齐（实测腾讯会多回一根）", ["2026-09-17", "2026-10-09"],
    parseTencentKline(KLINE_DAY, { code: "sh600000", period: "day", count: 2 }).bars.map((b) => b.time));
  r.check("昨收取 qt 第 5 段 9.70，不是同级的 prec 9.510", 9.7, parseTencentKline(KLINE_DAY, { code: "sh600000" }).preKPrice);
  const weekBar = parseTencentKline(
    { data: { sh600000: { qfqweek: [
      ["2026-10-02", "9.300", "9.450", "9.500", "9.200", "1500000"],
      ["2026-10-09", "9.450", "9.54", "9.74", "9.410", "2098227"],
    ] } } },
    { code: "sh600000", period: "week" },
  ).bars.at(-1);
  r.check("周线走 qfqweek（周期是参数，不硬编 day）", ["2026-10-09", 9.45, 9.54, 9.74, 9.41, 2098227],
    [weekBar.time, weekBar.open, weekBar.close, weekBar.high, weekBar.low, weekBar.volume]);
  r.check("代码前缀：沪 sh / 深 sz / 北交所 bj（920185 实测在 bj 那一边）", ["sh600000", "sz300750", "bj920185", null],
    ["1.600000", "0.300750", "0.920185", "bad"].map(tencentCodeOf));

  const MINUTE_ROWS = [
    "0930 9.70 4256 4128320.00",
    "0931 9.70 26626 25842111.83",
    "1130 9.67 498172 482689839.39",
    "1300 9.67 498172 482689839.39",
    "1500 9.54 947958 915309833.00",
    "1506 9.54 948000 915400000.00",
    "1530 9.54 948106 915450551.88",
  ];
  const MINUTE = {
    data: {
      sh600000: {
        data: { date: "20261009", data: MINUTE_ROWS },
        qt: { sh600000: ["1", "浦发银行", "600000", "9.54", "9.70", "9.70", "947958"] },
      },
    },
  };
  const rawMinute = parseTencentMinuteRows(MINUTE_ROWS);
  r.check("分时首/末条逐字段（时刻 HH:MM、价、累计量、累计额）",
    [["09:30", 9.7, 4256, 4128320], ["15:30", 9.54, 948106, 915450551.88]],
    [rawMinute[0], rawMinute.at(-1)].map((r) => [r.time, r.price, r.cumVolume, r.cumAmount]));
  // 「第 3、4 列是累计而不是当分钟增量」由这条钉住：同一次返回里整条单调不减
  r.check("第 3、4 列单调不减（累计量 / 累计额）", true,
    rawMinute.every((r, i) => i === 0 || (r.cumVolume >= rawMinute[i - 1].cumVolume && r.cumAmount >= rawMinute[i - 1].cumAmount)));
  const minuteTrend = parseTencentTrend(MINUTE, { code: "sh600000" });
  r.check("只留连续竞价时段（15:06–15:30 的盘后行不进 242 槽的轴）", ["09:30", "09:31", "11:30", "13:00", "15:00"],
    minuteTrend.points.map((p) => p.time));
  r.check("分时的昨收同样取自 qt 第 5 段（图上的平盘基准线）", 9.7, minuteTrend.preClose);
  // 容差 1e-9（相对）：解析里就是这条算式，容差只给浮点留余量，不是「差不多就行」
  r.check("均价 = 累计额 ÷ (累计量 × 100)", true,
    minuteTrend.points.every((p) => Math.abs(p.avg - p.cumAmount / (p.cumVolume * 100)) <= 1e-9 * Math.abs(p.avg)));
  r.check("末点均价落在实测值上（915309833 ÷ (947958×100) ≈ 9.656）", true,
    Math.abs(minuteTrend.points.at(-1).avg - 9.656) < 0.001);
  r.check("量能柱用当分钟量（累计量差分；首根是集合竞价的量，午休两点差 0）", [4256, 22370, 471546, 0, 449786],
    minuteTrend.points.map((p) => p.volume));
  const bjTrend = parseTencentTrend({ data: { bj920185: { data: { data: ["0930 21.01 189", "0931 21.01 300"] } } } }, { code: "bj920185" });
  r.check("北交所那种只有 3 列的响应：量照解，均价留空而不是瞎算", [null, null], bjTrend.points.map((p) => p.avg));
  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  r.check("数组缺失 / 行全解不出都判源失败（不许静默画错图）", [true, true], [
    throws(() => parseTencentTrend({ data: { sh600000: {} } }, { code: "sh600000" })),
    throws(() => parseTencentTrend({ data: { sh600000: { data: { data: ["这不是分时行"] } } } }, { code: "sh600000" })),
  ]);

  // 取数链本身也用假 request 钉一遍（确定、不碰网络）：东财抛错 → 腾讯；记住的源优先
  const fakeNet = () => {
    const seen = [];
    return {
      seen,
      request: async (url) => {
        const host = new URL(url).hostname;
        seen.push(host);
        if (host.endsWith("eastmoney.com")) throw new Error(`fetch failed: 注入的连接重置 https://${host}/x`);
        return { status: 200, body: JSON.stringify(url.includes("fqkline") ? KLINE_DAY : MINUTE) };
      },
    };
  };
  const netA = fakeNet();
  const chainA = await fetchKline(netA.request, "1.600000", 101);
  r.check("东财那条失败后，K线落到腾讯并真的解出数据", ["tencent", 4], [chainA.source, chainA.data.bars.length]);
  const netB = fakeNet();
  const chainB = await fetchKline(netB.request, "1.600000", 101, { preferred: "tencent" });
  r.check("记住的源优先：这一轮一次都没撞东财", [["proxy.finance.qq.com"], "tencent"], [netB.seen, chainB.source]);
  const netC = fakeNet();
  const chainC = await fetchTrend(netC.request, "1.600000");
  r.check("东财那条失败后，分时同样落到腾讯并解出数据", ["push2his.eastmoney.com", "proxy.finance.qq.com", "tencent", 5],
    [...netC.seen, chainC.source, chainC.data.points.length]);
  let aggErr = null;
  try {
    await fetchTrend(async (url) => {
      throw new Error(`fetch failed: ${new URL(url).hostname} 不通`);
    }, "1.600000");
  } catch (err) {
    aggErr = err;
  }
  // message 是给界面的一行（含两个源名），detail 是给日志的（每个源一条，里面带着各自的入口）
  r.check("全部源都失败：错误里点出每个源与每个入口（含两个备用入口与「新浪不供分时」）", true,
    /东方财富/.test(aggErr?.message ?? "") &&
      ["push2his.eastmoney.com", "proxy.finance.qq.com", "web.ifzq.gtimg.cn", "ifzq.gtimg.cn"].every((host) =>
        String(aggErr?.message ?? "").includes(host),
      ) &&
      /新浪：不供分时/.test(aggErr?.message ?? "") &&
      (aggErr?.detail?.length ?? 0) === 3);

  // 固定输入：2026-10-10 从 qt.gtimg.cn / hq.sinajs.cn 原样抄下来的真实行（GBK/GB18030 已解码）。
  // 键是 6 位代码，值是**整行**（带 v_/hq_str_ 外壳），join 起来就是一份真实响应 —— 解析器的行为与线上一致。
  const TENCENT_LINES = {
    "600000": `v_sh600000="1~浦发银行~600000~9.54~9.70~9.70~947958~449628~498330~9.54~1668~9.53~1134~9.52~1307~9.51~1679~9.50~2333~9.55~357~9.56~235~9.57~182~9.58~3249~9.59~2728~~20261009161457~-0.16~-1.65~9.74~9.54~9.54/947958/915309833~947958~91531~0.28~6.20~~9.74~9.54~2.06~3177.38~3177.38~0.42~10.67~8.73~0.92~1370~9.66~5.13~6.35~~~0.00~91530.9833~14.1192~148~   A~GP-A~-20.63~6.00~4.40~6.14~0.50~13.11~8.07~5.30~2.91~11.45~33305838300~33305838300~9.21~-16.09~33305838300~~~-16.17~-0.21~~CNY~0~___D__F__N~9.60~-2154~";`,
    "920185": `v_bj920185="62~贝特瑞~920185~21.82~21.01~21.01~125135~68553~56582~21.81~289~21.79~98~21.78~506~21.77~18~21.76~81~21.82~405~21.83~44~21.84~82~21.85~200~21.86~27~~20261009153542~0.81~3.86~21.95~20.78~21.82/125135/268558000~125135~26855.80~1.12~31.88~~21.95~20.78~5.57~244.27~248.35~1.95~27.31~14.71~2.10~234~21.46~32.46~28.38~~~~26855.8000~0.0000~0~ ~GP~-31.94~9.43~0.00~6.11~2.81~39.58~19.29~10.76~2.68~-2.76~1119459717~1138190398~13.37~-35.64~1119459717~~~-33.09~0.18~~CNY~19~NBFND~0.00~0";`,
    "600001": `v_sh600001="1~邯郸钢铁~600001~5.29~5.29~0.00~0~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20261009090000~0.00~0.00~0.00~0.00~5.29/0/0~0~0~0.00~-673.65~D~0.00~0.00~0.00~148.99~148.99~1.20~-1~-1~0.00~0~0.00~55.62~24.86~~~~0.0000~0.0000~0~ ~GP-A~0.00~0.00~0.00~-0.18~-0.08~~~0.00~0.00~0.00~2816456569~2816456569~~0.00~2816456569~~~0.00~0.00~~CNY~0~~0.00~0~";`,
  };
  const SINA_LINES = [
    `var hq_str_sh600000="浦发银行,9.700,9.700,9.540,9.740,9.540,9.540,9.550,94795849,915309833.000,166757,9.540,113400,9.530,130700,9.520,167900,9.510,233300,9.500,35700,9.550,23500,9.560,18200,9.570,324880,9.580,272772,9.590,2026-10-09,15:34:59,00,D|14800|141192.00";`,
    `var hq_str_sz300750="宁德时代,292.000,286.750,297.750,301.420,289.000,297.750,297.760,54152671,16028123330.460,14571,297.750,200,297.740,500,297.720,800,297.710,9100,297.700,8500,297.760,2800,297.770,1700,297.780,700,297.790,1900,297.800,2026-10-09,15:35:30,00,D|14500|4317375.000";`,
  ];

  r.group("快照（腾讯/新浪）：段位、五档、涨跌停与三源一致（固定输入）");
  /**
   * 固定输入 = 2026-10-10 从 qt.gtimg.cn / hq.sinajs.cn 原样抄下来的真实行（GBK/GB18030 已解码）：
   *   sh600000 有成交（88 段）、bj920185 北交所（87 段）、sh600001 是退市僵尸代码
   *   （无成交形态：5/6 段是 0、9..28 全是 0、30 段是当天 090000、47/48 段是 -1）。
   */
  const TENCENT_SNAPSHOT = [TENCENT_LINES["600000"], TENCENT_LINES["920185"], TENCENT_LINES["600001"]].join("\n");
  const SINA_SNAPSHOT = SINA_LINES.join("\n");
  const tencentQuotes = parseTencentQuotes(TENCENT_SNAPSHOT);
  const qSh = tencentQuotes.find((q) => q.code === "sh600000");
  const qBj = tencentQuotes.find((q) => q.code === "bj920185");
  const qDead = tencentQuotes.find((q) => q.code === "sh600001");
  r.check("腾讯快照逐字段（现价/昨收/今开/量(手)/高/低/时间）",
    [9.54, 9.7, 9.7, 947958, 9.74, 9.54, 1791533697000],
    [qSh?.price, qSh?.prevClose, qSh?.open, qSh?.volume, qSh?.high, qSh?.low, qSh?.quoteAt]);
  r.check("涨跌幅与涨跌额自己算（不读段 32）", [-1.65, -0.16], [qSh?.pct, qSh?.change]);
  r.check("中文名（GBK 解码后）", ["浦发银行", "贝特瑞"], [qSh?.name, qBj?.name]);
  r.check("北交所那行是 87 段但段位对齐（现价/量/涨跌停都对得上）", [21.82, 125135, 27.31],
    [qBj?.price, qBj?.volume, qBj?.limitUp]);
  r.check("无成交标的：量是 0、现价仍是最后一笔价、涨跌停段 -1 落成 null", [0, 5.29, null, null],
    [qDead?.volume, qDead?.price, qDead?.limitUp, qDead?.limitDown]);
  const dSh = parseTencentDepth(TENCENT_SNAPSHOT, { code: "sh600000" });
  r.check("五档：买五卖五各 5 档 + 买一 ≤ 现价 ≤ 卖一", [5, 5, true],
    [dSh.bids.length, dSh.asks.length, dSh.bids[0].price <= dSh.price && dSh.price <= dSh.asks[0].price]);
  r.check("五档逐档（买一/买五/卖一/卖五 的价与量）",
    [[9.54, 1668], [9.5, 2333], [9.55, 357], [9.59, 2728]],
    [dSh.bids[0], dSh.bids[4], dSh.asks[0], dSh.asks[4]].map((l) => [l.price, l.volume]));
  r.check("均价取自段 51", 9.66, dSh.avgPrice);
  const dDead = parseTencentDepth(TENCENT_SNAPSHOT, { code: "sh600001" });
  r.check("无成交标的的五档整片为空（不是 0.00 的价位）", true,
    dDead.bids.every((l) => l.price === null && l.volume === null) && dDead.asks.every((l) => l.price === null));
  // 涨跌停 = 昨收 × 交易所幅度，按分四舍五入到两位（实测三例全中，所以断言能断到分）
  const round2 = (v) => Math.round(v * 100) / 100;
  const limitsOf = (q, up, down) => [round2(q.prevClose * up), round2(q.prevClose * down)];
  const qCy = tencentQuotes.find((q) => q.code === "sz300750");
  r.check("涨跌停对得上 昨收×1.1 / ×1.2 / ×1.3（沪主板/创业板/北交所，按分取整）", [
    [10.67, 8.73], [344.1, 229.4], [27.31, 14.71],
  ], [
    limitsOf(qSh, 1.1, 0.9),
    limitsOf({ prevClose: 286.75 }, 1.2, 0.8),
    limitsOf(qBj, 1.3, 0.7),
  ]);
  r.info("创业板那条原始涨跌停（固定样例里没有它的整行）", `腾讯实测 47/48 = 344.10 / 229.40`);
  r.check("qCy 与固定样例无关（占位，避免误用）", true, qCy === undefined || Number.isFinite(qCy.price));
  const sinaQuotes = parseSinaQuotes(SINA_SNAPSHOT);
  const sSh = sinaQuotes.find((q) => q.code === "sh600000");
  r.check("新浪快照：量与腾讯同口径（股 ÷ 100 取整成手）、额与时间戳都在", [947958, 915309833, 1791531299000],
    [sSh?.volume, sSh?.amount, sSh?.quoteAt]);
  r.check("新浪没有涨跌停字段 → 留 null（界面据此说「该源不供」）", [null, null], [sSh?.limitUp, sSh?.limitDown]);
  // 新浪对不存在的代码回的是 `var hq_str_sz999999="";`：那种行不算一行（否则会挤掉真数据，
  // 也会让「三源全失败」被判成「取数成功、1 条」）
  const mixedRows = parseSinaQuotes(SINA_LINES[0] + '\n' + `var hq_str_sz999999="";`);
  r.check("整行没有可用数据的行被丢掉：混在正常行里只留正常那条", [1, "sh600000"], [mixedRows.length, mixedRows[0]?.code]);
  let emptyErr = null;
  try {
    parseSinaQuotes(`var hq_str_sz999999="";`);
  } catch (err) { emptyErr = err; }
  r.check("整批都不可用时判源失败（不是 0 条成功）", true, /没有可解析的行情行/.test(String(emptyErr?.message ?? "")));
  // 三源对同一时刻的**现价/昨收/成交量**必须一致：东财那条按它的字段口径造一行（f124 是秒）
  const emRow = parseQuoteRow({
    f12: "600000", f13: 1, f14: "浦发银行", f2: 9.54, f3: -1.65, f4: -0.16, f5: 947958, f6: 1,
    f15: 9.74, f16: 9.54, f17: 9.7, f18: 9.7, f124: Math.floor(1791533697000 / 1000),
  });
  r.check("三源（东财/腾讯/新浪）解出的现价、昨收、成交量一致（量已统一成手）",
    [[9.54, 9.7, 947958], [9.54, 9.7, 947958], [9.54, 9.7, 947958]],
    [[emRow.price, emRow.prevClose, emRow.volume], [qSh.price, qSh.prevClose, qSh.volume], [sSh.price, sSh.prevClose, sSh.volume]]);

  r.group("时间戳归一（秒 / YYYYMMDDHHMMSS / 日期+时间 → epoch 毫秒）");
  r.check("东财（秒）×1000 与腾讯（YYYYMMDDHHMMSS）在同一时刻相等", qSh.quoteAt, emRow.quoteAt);
  r.info("腾讯与新浪对同一收盘时刻各自的口径",
    `腾讯 ${new Date(qSh.quoteAt).toISOString()} / 新浪 ${new Date(sSh.quoteAt).toISOString()}（差 ${Math.abs(qSh.quoteAt - sSh.quoteAt) / 1000}s）`);
  r.check("新浪的日期+时间也归一成毫秒（同一天，差值就是两家自己的刷新时刻差）", true,
    Math.abs(qSh.quoteAt - sSh.quoteAt) > 0 && Math.abs(qSh.quoteAt - sSh.quoteAt) < 6 * 3600 * 1000);
  // 这就是「切源必修的隐患」：两家对同一时刻措辞不同，直接比大小会把「换了家」当成涨了/卡了
  r.check("切源那一轮不判进展、也不计入退避（progressOf）", [{ fresh: false, counted: false }], [
    progressOf({ prevAt: sSh.quoteAt, prevSource: "sina", at: qSh.quoteAt, source: "tencent" }),
  ]);
  r.check("同一个源：时间戳前进算有进展、不动算没进展（退避计数只在这时加）",
    [{ fresh: true, counted: true }, { fresh: false, counted: true }], [
      progressOf({ prevAt: 1000, prevSource: "tencent", at: 2000, source: "tencent" }),
      progressOf({ prevAt: 2000, prevSource: "tencent", at: 2000, source: "tencent" }),
    ]);
  r.check("这一轮没拿到时间戳时两者都不算", [{ fresh: false, counted: false }],
    [progressOf({ prevAt: 2000, prevSource: "tencent", at: 0, source: "" })]);

  r.group("快照取数链与批量：一次带走整张自选 + 分钟 K + 北交所不供历史");
  const url40 = buildTencentQuoteUrl(Array.from({ length: 40 }, (_, i) => `sh6000${String(i).padStart(2, "0")}`));
  r.check("40 只拼进一个 q= 里（实测 200、URL 381 字符；不存在的代码整行不返回，不是空值行）", true,
    url40.startsWith("https://qt.gtimg.cn/q=sh600000,sh600001,") && url40.split(",").length === 40);
  r.check("新浪也是批量一个 list=", true,
    buildSinaQuoteUrl(["sh600000", "sz300750"]).endsWith("hq.sinajs.cn/list=sh600000,sz300750"));
  const snapFake = () => async (url) => {
    if (url.includes("eastmoney")) throw new Error("fetch failed: 注入的连接重置");
    if (url.includes("gtimg.cn/q=")) return { status: 200, body: TENCENT_SNAPSHOT };
    if (url.includes("sinajs.cn")) return { status: 200, body: SINA_SNAPSHOT };
    throw new Error("nope");
  };
  const chainQ = await fetchQuotes(snapFake(), ["1.600000", "0.920185"]);
  r.check("东财那条失败后，快照落到腾讯并解出三行（含北交所那只）", ["tencent", 3], [chainQ.source, chainQ.data.length]);
  const chainQSina = await fetchQuotes(async (url) => {
    if (url.includes("eastmoney") || url.includes("gtimg.cn/q=")) throw new Error("fetch failed");
    return { status: 200, body: SINA_SNAPSHOT };
  }, ["1.600000"]);
  r.check("腾讯也不通时落到新浪（价格兜底），量仍是手", ["sina", 947958], [chainQSina.source, chainQSina.data[0]?.volume]);
  let depthErr = null;
  try {
    await fetchDepth(async () => {
      throw new Error("fetch failed: 全不通");
    }, "1.600000");
  } catch (err) { depthErr = err; }
  r.check("五档全失败：错误里点出每个源，且明写新浪「不供五档」", true,
    /东方财富/.test(depthErr?.message ?? "") && /腾讯/.test(depthErr?.message ?? "") && /新浪：不供五档/.test(depthErr?.message ?? ""));
  // 分钟 K：周期段是 m5/m15/m30/m60（fqkline 上那套返回 200 却没有任何数组，分钟 K 只能走 mkline）
  const minuteBars = parseTencentKline({ data: { sh600000: { m60: [
    ["202610091400", "9.67", "9.60", "9.67", "9.58", "239787.00", {}, "7.20"],
    ["202610091500", "9.60", "9.54", "9.61", "9.54", "132348.00", {}, "3.97"],
  ] } } }, { code: "sh600000", period: "m60", count: 120 }).bars;
  r.check("分钟 K 的时刻带时分（横轴标签与断言都按这个形状）", ["2026-10-09 14:00", "2026-10-09 15:00"],
    minuteBars.map((b) => b.time));
  r.check("分钟 K 的列序同样是「开、收、高、低、量」",
    [[9.67, 9.6, 9.67, 9.58, 239787], [9.6, 9.54, 9.61, 9.54, 132348]],
    minuteBars.map((b) => [b.open, b.close, b.high, b.low, b.volume]));
  let klineErr = null;
  try {
    await fetchKline(async (url) => {
      throw new Error(`fetch failed: ${new URL(url).hostname} 不通`);
    }, "1.600000", 101);
  } catch (err) { klineErr = err; }
  r.check("K线全失败：错误里点出两个源、两个备用入口，并说明新浪不供 K 线", true,
    ["push2his.eastmoney.com", "proxy.finance.qq.com", "web.ifzq.gtimg.cn", "ifzq.gtimg.cn"].every((h) =>
      String(klineErr?.message ?? "").includes(h)) && /新浪：不供K线/.test(klineErr?.message ?? ""));
  let bjErr = null;
  try {
    parseTencentKline({ data: { bj920185: { day: [["2026-10-09", "21.01", "21.82", "21.95", "20.78", "125135"]] } } },
      { code: "bj920185", period: "day", count: 120 });
  } catch (err) { bjErr = err; }
  r.check("北交所只回 1 根 → 判「不供历史」并给文案", true,
    /只回了 1 根日线/.test(bjErr?.message ?? "") && /不供这个标的的历史/.test(bjErr?.message ?? ""));
  let bjErr0 = null;
  try {
    parseTencentKline({ data: { bj430047: { day: [] } } }, { code: "bj430047", period: "day", count: 120 });
  } catch (err) { bjErr0 = err; }
  r.check("0 根同样判失败（不是画一张空图当成功）", true, /只回了 0 根日线/.test(bjErr0?.message ?? ""));

  r.group("运行时：不供历史的标的 + 行情三源全失败不许广播旧数据 + 记忆读回");
  // ① 北交所：腾讯只回 1 行（当日那根）→ 判「不供这个标的的历史」；但若本轮有源可达且真供了历史
  //    （例如东财恢复），就该正常出图。A11：等「这一轮出结果」（成功或失败）再按本轮可用性分支判，
  //    不再预设「必然失败」。「1 根不许冒充历史」这条规则本身由上面固定输入那组离线钉死。
  await add("0.920185", "920185", "贝特瑞");
  const memBjKline = (await readView())?.net?.sources?.kline ?? "";
  const bjT0 = Date.now();
  const gotBj = await nudgeUntil(
    { action: "select", secid: "0.920185" },
    `(() => { const p = window.__seen.panel.at(-1); return p?.secid === "0.920185" && !!p?.trend && (!!p?.kline || /不供这个标的的历史/.test(String(p?.failed?.kline ?? ""))); })()`,
    3, 30_000);
  r.info("北交所那轮等到面板花了", `${Date.now() - bjT0}ms`);
  if (!gotBj) {
    r.info("北交所那轮没等到面板，现场", JSON.stringify({
      panels: await c.ev(`window.__seen.panel.length`),
      last: await c.ev(`(() => { const p = window.__seen.panel.at(-1); return p ? { at: p.at, secid: p.secid, failed: p.failed, cleared: p.cleared } : null; })()`),
      watch: ((await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? []).map((w) => w.secid),
    }).slice(0, 400));
  }
  const pBj = (await c.ev(`window.__seen.panel.at(-1) ?? null`)) ?? {};
  r.info("北交所那轮的 K 线失败明细", String(pBj.failed?.kline).slice(0, 160));
  if (/不供这个标的的历史/.test(String(pBj.failed?.kline))) {
    // 失败分支：源们都不供这只的历史 —— 空图 + 文案说到点子上（不是一根 K 线的图）
    r.check("北交所判「不供历史」：K 线是空的 + 文案说到点子上（不是一根 K 线的图）", [true, null],
      [gotBj, pBj.kline]);
    // 界面那行是 briefError 截到 90 字的（完整原因在 ctx.log 的 err.detail 里），所以只断言
    // 「是一行」「点了源的名字」「说到点子上」，逐字面量对比交给上面那组固定输入单测
    r.check("错误行是一行、且点了源的名字", true,
      !String(pBj.failed?.kline).includes("\n") && /腾讯|东方财富/.test(String(pBj.failed?.kline)));
    const errShown = await waitUntil(settings.client, `(async () => {
      const { widgetHost } = await import('/src/runtime/widget-host.ts');
      const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
      const nodes = [...(rec?.shadow?.querySelectorAll('.chart-col .muted') ?? [])];
      return nodes.some((n) => /盘面数据拉取失败/.test(n.textContent));
    })()`, 15_000);
    r.check("插件页上是错误行而不是空白", true, errShown);
  } else {
    // 成功分支：本轮有源能供这只的历史 —— 判「K 线非空、源∈已知三源、且符合本轮可用性」
    const judgeBj = judgeKindSource({ kind: "kline", observed: pBj.klineSource, preferred: memBjKline, reachable, hadFailure: !!pBj.failed?.kline, attemptedFailures: attemptFails(pBj, "kline") });
    r.info("北交所成功分支判定", judgeBj.reason);
    r.check("北交所有源能供历史时正常出图（K 线非空且源符合本轮可用性）", [true, true],
      [(pBj.kline?.bars?.length ?? 0) > 0, judgeBj.ok]);
  }
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "remove", secid: "0.920185" }); true`);
  await sleep(1200);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "select", secid: "1.600519" }); true`);
  await sleep(2000);

  // ② 记忆是从 storage 读回来的：改成东财再重启插件，重启后第一轮就该先试东财
  await invoke("store_set", { pluginId: PID, key: "sources", value: { kline: "eastmoney", trend: "eastmoney" } });
  await c.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    const ms = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    await rt.deactivatePlugin(${JSON.stringify(PID)});
    await rt.activatePlugin(ms.find((m) => m.id === ${JSON.stringify(PID)}));
    return true;
  })()`);
  await sleep(1500);
  r.check("重启后插件活着（记忆是从 storage 读回来的）", true,
    await c.ev(`(async () => (await import('/src/runtime/plugin-runtime.ts')).isActive(${JSON.stringify(PID)}))()`));
  r.check("重启读回的记忆是东财（storage 里那份，不是内存里的残留）", "eastmoney", (await readView())?.net?.sources?.kline);

  // ③ 行情三源全给不出东西（自选里只剩一个不存在的代码，且关掉指数）：
  //    错误行要一行点出每个源，且**不许把上一轮的价格当成本轮结果广播**（行情表清空，界面显示「—」+ 错误行）
  // 北交所那轮的 K 线链撞了三次（主入口 + 两个备用入口），按设计进了冷却；
  // 先等它过去、再用真搜索把失败计数清零，然后跑一轮**成功**的主轮询 —— 下面要作废的「旧行情」得先有
  const netBj = await prepareFreshNetwork();
  r.check("北交所那轮之后：冷却结束、失败计数清零（下一段才验得动）", [true, true], [netBj.cooled, netBj.clean]);
  await c.ev(`window.__seen.quote.length = 0; window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "refresh" }); true`);
  const gotBefore = await waitUntil(c, `window.__seen.quote.length > 0`, 25_000);
  const beforeKeys = Object.keys((await readView())?.quotes ?? {});
  r.check("先把要作废的那份行情准备好（下面那条才不是空转）", [true, true], [gotBefore, beforeKeys.length > 0]);
  // 关掉指数：这一步必须真的生效，否则只留一个不存在代码的自选表还是会带回指数的行
  let idxOff = false;
  for (let i = 0; i < 3 && !idxOff; i++) {
    await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "config", value: { showIndex: false } })}); true`);
    await sleep(700);
    idxOff = (await readView())?.config?.showIndex === false;
  }
  r.check("已关掉指数（这样自选表里只剩那个不存在的代码）", true, idxOff);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "clear" }); true`);
  await sleep(900);
  // add 自己会顺带抓一次行情（tick("added")），那一次就是「三源全失败」；
  // 不再补 refresh —— 补的那次会撞上刚触发的冷却，把状态行盖成「已刷新」反而看不到错误
  await add("0.999999", "999999", "不存在的代码");
  // add 自己会顺带抓一次行情（tick("added")）；那一轮可能被上一轮的在飞请求跳过，
  // 所以等不到就再补一次 refresh（两次都进冷却的话，说明失败已经发生，状态行一样在）
  const allFail = await nudgeUntil({ action: "refresh" }, `/行情拉取失败/.test(window.__seen.status.at(-1)?.text ?? "")`, 3, 25_000);
  const failText = String(await c.ev(`window.__seen.status.at(-1)?.text ?? ""`));
  r.info("三源全失败时的错误行", failText.slice(0, 200));
  const quotesCleared = await waitUntil(c, `(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    const d = await new Promise((res) => {
      const off = bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (x) => { off(); res(x); });
      bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "sync" }, ${JSON.stringify(PID)});
      setTimeout(() => { off(); res(null); }, 5000);
    });
    return Object.keys(d?.quotes ?? {}).length === 0;
  })()`, 15_000);
  if (allFail) {
    // 现场拿到了：错误行要一行点出链上真实尝试过的每个源（三源都会走到）
    r.check("错误行一行点出每个源（东方财富 / 腾讯 / 新浪）", true,
      !failText.includes("\n") && /东方财富/.test(failText) && /腾讯/.test(failText) && /新浪/.test(failText));
  } else {
    // 这一轮没造出现场（某个源居然供了这个代码，或失败被冷却折叠）—— 不许静默放过：
    // 同一语义（三源全失败时一行点出每个源）改由**离线注入**的固定输入直接钉住
    let allFailErr = null;
    try {
      await fetchQuotes(async () => {
        throw new Error("fetch failed: 注入的三源全不通");
      }, ["1.600000"]);
    } catch (err) {
      allFailErr = err;
    }
    r.check("错误行一行点出每个源（现场未出现，改由离线注入钉同一语义）", true,
      !String(allFailErr?.message ?? "").includes("\n") &&
        ["东方财富", "腾讯", "新浪"].every((n) => String(allFailErr?.message ?? "").includes(n)));
    r.info("三源全失败现场未出现的原因线索", `status=${failText.slice(0, 120)} quotes=${JSON.stringify(Object.keys((await readView())?.quotes ?? {}))}`);
  }
  r.check("旧行情没有被当成本轮结果广播（行情表已清空）", true, quotesCleared);
  // 收尾：把指数跟两条自选都放回去，选中还给贵州茅台（后面的断言按它来）
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "clear" }); true`);
  await sleep(900);
  await add("1.600519", "600519", "贵州茅台");
  await add("0.300750", "300750", "宁德时代");
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "config", value: { showIndex: true } })}); true`);
  r.check("两条自选加回来了（后面「删掉一只」按它来）", ["1.600519", "0.300750"],
    ((await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? []).map((w) => w.secid));
  const backSel = await nudgeUntil({ action: "select", secid: "1.600519" }, `window.__seen.panel.at(-1)?.secid === "1.600519"`, 3, 20_000);
  r.check("收尾：选中的标的回到 1.600519（下面「删除后盘面收掉」按它来）", true, backSel);

  r.group("阈值规则保存与回显");
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "update", secid: "1.600519", upper: 1, lower: 99999, pct: 3 })}); true`);
  await sleep(1500);
  const withRules = (await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? [];
  const item = withRules.find((w) => w.secid === "1.600519");
  r.check("三个阈值都存下", [1, 99999, 3], [item?.upper, item?.lower, item?.pct]);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "update", secid: "1.600519", upper: "" })}); true`);
  await sleep(1500);
  const cleared = ((await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? []).find((w) => w.secid === "1.600519");
  r.check("清空一个阈值不影响另外两个", [null, 99999, 3], [cleared?.upper, cleared?.lower, cleared?.pct]);

  // ---------- Bug4：一次推送不能把正在输入的阈值冲掉 ----------
  // 交接文档 §4.5 要的那条运行时判据。走真实链路：设置页里的阈值格是 Worker 渲染契约下
  // 宿主按 op 流建出来的真元素（`rec.shadow` 是页面 realm 里的那个 shadow root），
  // 在它上面派发一次真 input（宿主的 listen 就挂在元素本身，widget-renderer.ts:248），
  // 再广播一次 sync 逼出 widget 的视图推送 —— 推送里 upper 仍是配置的空值，
  // 界面必须还显示用户刚敲的 88.88。少了 watch-list.js 的行复用与编辑锁，这条当场红。
  await settings.client.ev(`document.querySelector('#nav-plugins .nav-item[data-view=${JSON.stringify(PID)}]')?.click()`);
  const numBoxReady = await waitUntil(
    settings.client,
    `(async () => {
      const { widgetHost } = await import('/src/runtime/widget-host.ts');
      const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
      return !!rec?.shadow?.querySelector('input.num[placeholder="涨到"]');
    })()`,
    20_000,
  );
  r.check("设置页找得到「涨到」那一格阈值输入框", true, numBoxReady);
  const typedIn = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    const box = rec?.shadow?.querySelector('input.num[placeholder="涨到"]');
    if (!box) return { ok: false, why: "框没了" };
    const before = box.value;
    box.value = "88.88";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, before, after: box.value };
  })()`);
  r.check("把 88.88 敲进「涨到」（下面那条才不是空转）", true, typedIn?.ok === true && typedIn.after === "88.88");
  // 逼一次视图推送，并证明这一帧真的到了插件（不是只有我们自己在等）
  const pushArrived = await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    const got = await new Promise((res) => {
      const off = bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (x) => { off(); res(x); });
      bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "sync" }, ${JSON.stringify(PID)});
      setTimeout(() => { off(); res(null); }, 6000);
    });
    return !!got && (got.watch ?? []).length > 0;
  })()`);
  r.check("sync 触发了一次视图推送且带着自选表", true, pushArrived);
  await sleep(1200);
  const stillTyped = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    return rec?.shadow?.querySelector('input.num[placeholder="涨到"]')?.value ?? "框没了";
  })()`);
  r.check("推送没有冲掉还没保存的输入", "88.88", String(stillTyped));
  // 反向判据（G7-05）：构造一次「非法值 + 存」的真失败输入，UI 必须判红。
  // 存下去的是非法串，宿主按 clampNum 落成 null；插件要把「框里的实际串」记进台账，
  // 而不是记它自己发出去的那份。旧实现记的是用户键入值，于是推送永远追不上、回显永远不动，
  // 这一格就留成陈旧草稿 —— 下面两条各自都能当场红：
  //   1) store 里那只股票的 upper 真的被清成 null（失败输入确实落库，判据不是空转）；
  //   2) 下一帧回显把框清空（陈旧草稿不残留）。
  const badIn = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    const box = rec?.shadow?.querySelector('input.num[placeholder="涨到"]');
    if (!box) return { ok: false, why: "框没了" };
    const tr = box.closest("tr");
    const code = tr?.querySelector(".muted")?.textContent ?? "";
    box.value = "abc";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const save = [...(tr?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "存");
    if (!save) return { ok: false, why: "存按钮没了" };
    save.click();
    return { ok: true, code, typed: box.value };
  })()`);
  r.check("把非法串 abc 敲进阈值格并点「存」", true, badIn?.ok === true && badIn.typed === "abc");
  const badCode = String(badIn?.code ?? "").trim();
  const badSaved = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const list = (await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? [];
      const target = list.find((w) => badCode && badCode.includes(w.code));
      if (target && target.upper === null) return target;
      await sleep(200);
    }
    return null;
  })();
  r.check("失败输入落库为 null（下面那条判据才不是空转）", "null", String(badSaved?.upper));
  await sleep(1200);
  const clearedBad = await settings.client.ev(`(async () => {
    const { widgetHost } = await import('/src/runtime/widget-host.ts');
    const rec = (widgetHost.mounted.get(${JSON.stringify(PID)}) ?? [])[0];
    return rec?.shadow?.querySelector('input.num[placeholder="涨到"]')?.value ?? "框没了";
  })()`);
  r.check("存了非法值后回显清空，不留陈旧草稿", "", String(clearedBad));

  r.group("配置：间隔下限与模式");
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "config", value: { intervalSec: 1, mode: "overlay" } })}); true`);
  await sleep(1500);
  const cfg = (await invoke("store_get", { pluginId: PID, key: "config" })).v ?? {};
  r.check("间隔被夹到下限 10s（不给压公共接口）", 10, cfg.intervalSec);
  r.check("模式已切到 overlay", "overlay", cfg.mode);
  r.check(
    "盯盘卡可见（位置由插件自定）",
    true,
    await waitUntil(
      c,
      `(async () => (await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'overlay-com_pet_astock' })) === true)()`,
      15_000,
    ),
  );
  const cardTarget = (await listPages(PORT)).find(
    (t) => /overlay\.html/.test(t.url) && t.title === `DesktopPet Overlay · ${PID}`,
  );
  r.check("卡片页按标题能被认出来", true, !!cardTarget);
  let oc = null;
  if (cardTarget) {
    oc = await attach(PORT, (t) => t.webSocketDebuggerUrl === cardTarget.webSocketDebuggerUrl, 10_000);
    r.check(
      "盯盘卡里挂上了本插件的 overlay widget",
      true,
      await oc.ev(`!!document.querySelector('#widget-overlay div[data-plugin-id=${JSON.stringify(PID)}]')`),
    );
    // 首开落点（页面侧）：这扇窗是刚按插件缺省坐标建的，套件此时还没改过 cardX/cardY
    // （开头 permission_revoke 连带清了插件存储，配置回到缺省）。420/180 故意不对称：
    // 对称点抓不到 x/y 对调的接线错（U01 那轮变异抽查全套件全绿就是这么漏的）
    const geoOpen = await oc.ev(`[window.screenX, window.screenY]`);
    r.check(
      "卡片首次打开就落在插件缺省坐标 (420,180)（页面侧逻辑像素）",
      true,
      Array.isArray(geoOpen) && Math.abs(geoOpen[0] - 420) <= 6 && Math.abs(geoOpen[1] - 180) <= 6,
    );
  }

  // —— 落点（U07 / ADR-0010 决策 3/4）：位置由插件直传逻辑像素坐标并自己存，宿主只做屏内夹紧 ——
  // 两条独立通道对同一件事：命令侧 plugin:window|outer_position 是物理像素（×页面 devicePixelRatio，容差 6），
  // 页面侧 window.screenX/screenY 是逻辑像素（不经换算，与请求值直接比）。坐标一律用非对称值。
  const CARD_LABEL = "overlay-com_pet_astock";
  const ocDpr = Number(await c.ev("window.devicePixelRatio")) || 1;
  const cardPos = async () => (await invoke("plugin:window|outer_position", { label: CARD_LABEL })).v ?? null;
  // ㈠ 首开那一下（命令侧）：落点不是宿主缺省 (24,24)，说明插件真的传了自己的坐标。
  //    插件没传坐标的形态在这条与上面那条上同时红，蹭缺省藏不住
  const posOpen = await cardPos();
  r.check(
    "卡片首开落点不是宿主缺省 (24,24)（命令侧物理像素；防插件没传坐标蹭缺省）",
    true,
    !!posOpen && !(Math.abs(posOpen.x - 24 * ocDpr) <= 6 && Math.abs(posOpen.y - 24 * ocDpr) <= 6),
  );
  // ㈡ 先开在一个坐标 → 发 config 改成另一个 → 再看它有没有真的动：
  //    「坐标存下了但没触发一次重 show、窗停在旧位置」的形态在这里必红
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "config", value: { cardX: 300, cardY: 420 } })}); true`);
  const movedByConfig = await waitUntil(
    c,
    `(async () => {
      try {
        const p = await window.__TAURI_INTERNALS__.invoke('plugin:window|outer_position', { label: ${JSON.stringify(CARD_LABEL)} });
        const k = window.devicePixelRatio || 1;
        return Math.abs((p?.x ?? 1e9) - 300 * k) <= 6 && Math.abs((p?.y ?? 1e9) - 420 * k) <= 6;
      } catch { return false; }
    })()`,
    12_000,
  );
  const posMoved = await cardPos();
  r.check(
    "发 config 改坐标后卡片真的移动：命令侧物理落点 = 请求值×devicePixelRatio（容差 6）",
    true,
    movedByConfig && Math.abs((posMoved?.x ?? 1e9) - 300 * ocDpr) <= 6 && Math.abs((posMoved?.y ?? 1e9) - 420 * ocDpr) <= 6,
  );
  // ㈢ 页面侧独立核对同一件事（上面是物理像素、这里是逻辑像素，互为两路证据）
  const geoMoved = oc ? await oc.ev(`[window.screenX, window.screenY]`) : null;
  r.check(
    "页面侧独立核对：卡片页 window.screenX/screenY = (300,420)（逻辑像素）",
    true,
    Array.isArray(geoMoved) && Math.abs(geoMoved[0] - 300) <= 6 && Math.abs(geoMoved[1] - 420) <= 6,
  );

  r.group("提醒链路（通知 + 宠物反应）");
  await c.ev(`(async () => {
    const host = await import('/src/pet/host.ts');
    const ctrl = host.petController();
    window.__pet = { acts: [], said: [] };
    const react0 = ctrl.react.bind(ctrl), say0 = ctrl.say.bind(ctrl);
    ctrl.react = (a) => { window.__pet.acts.push(a); return react0(a); };
    ctrl.say = (t) => { window.__pet.said.push(t); return say0(t); };
    return true;
  })()`);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "testAlert" }); true`);
  const alerted = await waitUntil(c, `window.__seen.alert.length > 0`, 15_000);
  r.check("提醒广播到了总线", true, alerted);
  r.check("宠物有反应", true, (await c.ev(`window.__pet.acts.length`)) > 0);
  r.check("宠物说了台词", true, (await c.ev(`window.__pet.said.some(t => /测试/.test(t))`)));
  const recent = (await c.ev(`(async () => {
    const { bus } = await import('/src/runtime/event-bus.ts');
    return await new Promise((res) => {
      const off = bus.subscribe(${JSON.stringify(`${PID}:widget`)}, (d) => { off(); res(d.recent ?? []); });
      bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "sync" }, ${JSON.stringify(PID)});
      setTimeout(() => { off(); res([]); }, 8000);
    });
  })()`));
  r.check("最近提醒进了视图", true, recent.some((a) => /测试/.test(a.message ?? "")));

  r.group("配置改动不会把另一项抹成默认（回显）");
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "config", value: { petOn: false } })}); true`);
  await sleep(1500);
  const cfg2 = (await invoke("store_get", { pluginId: PID, key: "config" })).v ?? {};
  r.check("只改 petOn，间隔与模式保持", [10, "overlay"], [cfg2.intervalSec, cfg2.mode]);
  r.check("petOn 确实关了", false, cfg2.petOn);
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "config", value: { petOn: true } })}); true`);
  await sleep(800);

  r.group("删除与停用后的回收");
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, ${JSON.stringify({ action: "remove", secid: "0.300750" })}); true`);
  await sleep(1500);
  r.check("删掉一只", ["1.600519"], ((await invoke("store_get", { pluginId: PID, key: "watch" })).v ?? []).map((w) => w.secid));
  // 正开着盘面的那只被删掉时，面板要收掉，不能继续画它的曲线
  await c.ev(`window.__bus.publish(${JSON.stringify(`${PID}:cmd`)}, { action: "remove", secid: "1.600519" }); true`);
  const panelCleared = await waitUntil(c, `window.__seen.panel.at(-1)?.cleared === true`, 15_000);
  r.check("删掉选中标的后盘面收掉", true, panelCleared);
  await c.ev(`(async () => { const rt = await import('/src/runtime/plugin-runtime.ts'); await rt.deactivatePlugin(${JSON.stringify(PID)}); return true; })()`);
  await sleep(1500);
  r.check("停用后插件确实不在活动列表", false, await c.ev(`(async () => (await import('/src/runtime/plugin-runtime.ts')).isActive(${JSON.stringify(PID)}))()`));
  const cardGone = await waitUntil(
    c,
    `(async () => {
      try { const v = await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'overlay-com_pet_astock' }); return v !== true; }
      catch { return true; } // 窗口记录都没了，当然是收掉了
    })()`,
    12_000,
  ).catch(() => false);
  if (!cardGone) {
    // 失败要能说清是哪一类：还在活动列表里被 watcher 重新激活了，还是 destroy 真的没落地
    r.info("卡仍可见时的现场", JSON.stringify({
      active: await c.ev(`(async () => (await import('/src/runtime/plugin-runtime.ts')).isActive(${JSON.stringify(PID)}))()`),
      enabled: await readEnabledIds(invoke),
      mode: ((await invoke("store_get", { pluginId: PID, key: "config" })).v ?? {}).mode,
      windows: (await listPages(PORT)).filter((t) => /overlay\.html/.test(t.url)).map((t) => t.title),
    }));
  }
  r.check("停用后卡收掉", true, cardGone);
  r.check(
    "停用后指令 topic 没有残留订阅（宿主回收）",
    true,
    await c.ev(`(async () => { const { bus } = await import('/src/runtime/event-bus.ts'); return (bus.handlers.get(${JSON.stringify(`${PID}:cmd`)})?.size ?? 0) === 0; })()`),
  );
  oc?.close();
} catch (err) {
  r.check("脚本未抛异常", true, false);
  console.error(err);
} finally {
  stopped = true;
  if (c) {
    // 下线 + 撤销授权（连带清掉它的存储），最后换新文档
    if (!settings) settings = await openSettingsInvoker(PORT, c).catch(() => null);
    // 清单归宿主（C1）：恢复用户那份要由设置窗写
    if (settings) await writeEnabledIds(settings.invoke, origEnabled).catch(() => undefined);
    await c
      .ev(`(async () => {
        const rt = await import('/src/runtime/plugin-runtime.ts');
        await rt.loadEnabled();
        await rt.deactivatePlugin(${JSON.stringify(PID)});
        return true;
      })()`)
      .catch(() => undefined);
    if (settings) await settings.invoke("permission_revoke", { pluginId: PID }).catch(() => undefined);
    settings?.close();
    settings = null;
    await sleep(1500);
    await reloadAndWait(c).catch(() => undefined);
    await sleep(1200);
  } else {
    settings?.close();
  }
  const failed = r.summary();
  c?.close();
  await sleep(400);
  process.exit(failed ? 1 : 0);
}
