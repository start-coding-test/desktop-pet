// 宿主 http 能力的 charset 解码端到端断言。
//   终端 1: npm run dev:debug      终端 2: npm run verify:http
// 覆盖腾讯（text/html; charset=GBK）与新浪（application/javascript; charset=GB18030）两个真实
// GBK 后端：走 JS 能力桥 → 宿主代理 → 按响应头 charset 解码 → 中文名不带 U+FFFD，
// 且 `~` 分段不因 GBK 尾字节 0x7E 而错位（错位会把「今开」读成「现价」，是静默错价）。
// 顺带钉住按域名的授权键不带默认端口（:443）—— 键算错会让所有 https 请求都判未授权。
// 会真出网、会各弹一次域名同意框（脚本自己点「允许」并记录它展示了什么），
// 跑完撤销授权并删掉临时探针插件。
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv, env } from "node:process";
import { attach, createReport, hostInvoke, listPages, openSettingsInvoker, readEnabledIds, reloadAndWait, waitForPage, writeEnabledIds } from "./harness/cdp.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
// 探针插件：只为拿到一个有 http 能力的「已安装插件」身份（permission_request 按磁盘 manifest 判定
// 声明与否，未安装的 id 连同意框都弹不出来）。D02 起未启用插件不能申请授权：本套件在请求期间
// 经设置窗临时把它放进启停清单，收尾恢复，不 activate。
const PROBE_ID = "zz.httpcharset";
const PLUGINS_DIR = resolve(import.meta.dirname, "../../plugins");
const PROBE_DIR = join(PLUGINS_DIR, PROBE_ID);
const TENCENT = "https://qt.gtimg.cn/q=sh600000";
const SINA = "https://hq.sinajs.cn/list=sh600000";
// 新浪不带 referer 会 403；这条头也顺带证明插件的自定义请求头真的透传到了宿主
const SINA_HEADERS = [["referer", "https://finance.sina.com.cn"]];
const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const r = createReport("宿主 http 能力的 charset 解码（dev）");

let stopped = false;
const consents = [];

/**
 * 持续盯同意框：记录它展示了哪些能力（这就是授权键本身），然后点「允许」。
 * 与 verify-isolation.mjs 的 driveConsent 同一套路，但要在后台长跑 ——
 * 请求在宠物窗里 await，同意框不点就永远等不到响应。
 */
async function pumpConsents(deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (!stopped && Date.now() < until) {
    const target = (await listPages(PORT).catch(() => [])).find((t) => /consent/.test(t.url));
    if (!target) {
      await sleep(250);
      continue;
    }
    try {
      const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000);
      try {
        const seen = {
          caps: await cs.ev(`[...document.querySelectorAll('#cap-list li')].map(li => li.textContent)`),
          who: await cs.ev(`document.getElementById('plugin-name')?.textContent ?? ''`),
        };
        // 别的插件（比如自选列表里那个）也可能弹自己的框，只记我们这个探针的
        if (seen.who.includes(PROBE_ID)) consents.push(seen);
        await cs.ev(`document.getElementById('btn-allow').click()`);
      } finally {
        cs.close();
      }
    } catch (e) {
      console.log(`  · 同意框应答失败，重试：${String(e).slice(0, 70)}`);
    }
    await sleep(300);
  }
}

/** 从宠物窗走桥发一次请求。桥是插件唯一的入口，插件侧零改动就是靠它不变 */
function request(url, headers) {
  return `(async () => {
    const { buildContext } = await import('/src/runtime/bridge.ts');
    const ctx = buildContext({ id: ${JSON.stringify(PROBE_ID)}, name: 'HTTP 字符集探针', permissions: ['http'] });
    try {
      const res = await ctx.http.request(${JSON.stringify(url)}, ${JSON.stringify(headers ? { headers } : {})});
      return { ok: true, res };
    } catch (e) {
      return { ok: false, e: String(e?.message ?? e) };
    }
  })()`;
}

const FFFD = "\uFFFD";
/** 腾讯的载荷：v_sh600000="1~浦发银行~600000~9.54~…（1=名字 2=代码 3=现价 4=昨收） */
const tencentFields = (body) => (body.match(/="([^"]*)"/)?.[1] ?? "").split("~");

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
  // 先摆好探针插件再连页面：宿主 watcher 发现新目录后才会把它算成「装着的插件」
  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(
    join(PROBE_DIR, "manifest.json"),
    JSON.stringify(
      {
        id: PROBE_ID,
        name: "HTTP 字符集探针",
        version: "0.0.0",
        entry: "index.js",
        permissions: ["http"],
        description: "验证用探针：从宠物窗走桥请求腾讯/新浪的 GBK 行情接口。",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(PROBE_DIR, "index.js"), "export function activate() {}\nexport function deactivate() {}\n");
  await sleep(1500); // 让 plugins 目录 watcher 扫到它

  c = await attach(PORT, isPetPage);
  settings = await openSettingsInvoker(PORT, c);
  origEnabled = await readEnabledIds(hostInvoke(c));
  await writeEnabledIds(settings.invoke, [...new Set([...origEnabled, PROBE_ID])]);
  // 上一轮中途挂掉可能留下授权或一扇没点掉的同意框。它们会让这一轮少弹一扇框
  // （残留授权直接放行），也会让 pump 把别人的框记到我们头上 —— 起手必须先排空，
  // 并且把「排空了」当成断言钉住，否则继承来的状态只会表现为偶发红。
  const probeKeys = async () => {
    const table = (await settings.invoke("permission_list")).v ?? {};
    return Object.entries(table)
      .filter(([id]) => id === PROBE_ID)
      .flatMap(([, caps]) => caps);
  };
  let residual = await probeKeys();
  for (let i = 0; i < 40 && residual.length; i++) {
    await settings.invoke("permission_revoke", { pluginId: PROBE_ID }).catch(() => undefined);
    await sleep(250);
    residual = await probeKeys();
  }
  r.check("起手时表里没有本探针的残留授权", [], residual);
  let openConsents = 1;
  for (let i = 0; i < 40; i++) {
    openConsents = (await listPages(PORT).catch(() => [])).filter((t) => /consent/.test(t.url)).length;
    if (!openConsents) break;
    await sleep(250);
  }
  r.check("起手时没有还开着的同意框", 0, openConsents);
  void pumpConsents(240_000);

  r.group("腾讯实时行情（text/html; charset=GBK）");
  const qt = await c.ev(request(TENCENT));
  r.check("请求成功（域名授权已放行）", true, qt?.ok === true);
  r.check("HTTP 200", 200, qt?.res?.status);
  // 字段名按宿主实际序列化出来的（snake_case）；PLUGIN_SDK 第 93 行写的是 contentType，
  // 与实际不符（既存问题，遗留待规划方定夺），这里只钉住「结构没被本次改动动过」
  r.info("返回结构字段", Object.keys(qt?.res ?? {}).join(","));
  r.check("宿主原样回传 Content-Type（返回结构没变）", true, /charset=GBK/.test(String(qt?.res?.content_type ?? "")));
  r.check("没有截断", false, qt?.res?.truncated);
  const qtBody = String(qt?.res?.body ?? "");
  r.info("响应前 48 字", JSON.stringify(qtBody.slice(0, 48)));
  r.check("中文名解出来了（GBK 按 charset 解码）", true, qtBody.includes("浦发银行"));
  // 这条是本任务的目的：按 UTF-8 lossy 解时名称四个字会变成 U+FFFD
  r.check("整段不含替换字符 U+FFFD", false, qtBody.includes(FFFD));
  const qtf = tencentFields(qtBody);
  r.check("名称仍在第 2 段（没被挪位）", "浦发银行", qtf[1]);
  r.check("代码仍在第 3 段", "600000", qtf[2]);
  r.check("第 4 段是能当数字用的现价（错位时这里会变成代码）", true, Number.isFinite(Number(qtf[3])));
  r.info("现价字段", qtf[3]);

  r.group("新浪实时行情（application/javascript; charset=GB18030）");
  const sn = await c.ev(request(SINA, SINA_HEADERS));
  r.check("请求成功（带 referer，否则新浪 403）", true, sn?.ok === true);
  r.check("HTTP 200", 200, sn?.res?.status);
  r.check("宿主原样回传 Content-Type", true, /charset=GB18030/.test(String(sn?.res?.content_type ?? "")));
  const snBody = String(sn?.res?.body ?? "");
  r.info("响应前 48 字", JSON.stringify(snBody.slice(0, 48)));
  r.check("中文名解出来了（GB18030 按 charset 解码）", true, /hq_str_sh600000="浦发银行,/.test(snBody));
  r.check("整段不含替换字符 U+FFFD", false, snBody.includes(FFFD));

  r.group("按域名授权：键不带默认端口");
  const keys = consents.map((x) => x.caps);
  r.info("同意框依次展示了", JSON.stringify(keys));
  r.check("两个域名各弹了一次同意框", 2, consents.length);
  r.check("第一扇同意框是我们这个探针的", true, consents.every((x) => x.who.includes(PROBE_ID)));
  r.check("首个域名申请的键是 qt.gtimg.cn", true, (keys[0] ?? []).includes("http:qt.gtimg.cn"));
  r.check("第二个域名申请的键是 hq.sinajs.cn", true, (keys[1] ?? []).includes("http:hq.sinajs.cn"));
  r.check("同意框里没有任何带默认端口的键", false, keys.flat().some((k) => k.includes(":443")));
  const allGrants = Object.values((await settings.invoke("permission_list")).v ?? {}).flat();
  r.check("授权表落下的就是这两个键", true, ["http:qt.gtimg.cn", "http:hq.sinajs.cn"].every((k) => allGrants.includes(k)));
  r.check("授权表里没有 http:*:443（键算错会让所有 https 请求都判未授权）", false, allGrants.some((k) => k.includes(":443")));

  r.group("对照：同一条字节流按 UTF-8 lossy 解会坏成什么样");
  // 只为把「现在的断言不是空断言」写进日志：直接抓一份原始字节自己解，不进断言链
  try {
    const raw = Buffer.from(await (await fetch(TENCENT)).arrayBuffer());
    const lossy = new TextDecoder("utf-8").decode(raw);
    r.info("原始字节对照 lossy 解出", JSON.stringify(lossy.slice(0, 40)));
    r.info("两者名称段", `${JSON.stringify(tencentFields(lossy)[1])} vs 宿主的 ${JSON.stringify(qtf[1])}`);
  } catch (e) {
    r.info("原始字节对照", `跳过（Node 直连失败：${String(e).slice(0, 60)}）`);
  }
} catch (err) {
  r.check("脚本未抛异常", true, false);
  console.error(err);
} finally {
  stopped = true;
  if (c) {
    // 撤销授权（连带清掉探针存储）+ 删掉探针目录，最后换新文档把桥里的授权缓存丢掉
    if (!settings) settings = await openSettingsInvoker(PORT, c).catch(() => null);
    if (settings) await writeEnabledIds(settings.invoke, origEnabled).catch(() => undefined);
    if (settings) await settings.invoke("permission_revoke", { pluginId: PROBE_ID }).catch(() => undefined);
    settings?.close();
    settings = null;
    rmSync(PROBE_DIR, { recursive: true, force: true });
    await sleep(1500);
    await reloadAndWait(c).catch(() => undefined);
    await sleep(1200);
  } else {
    settings?.close();
    rmSync(PROBE_DIR, { recursive: true, force: true });
  }
  const failed = r.summary();
  c?.close();
  await sleep(400);
  process.exit(failed ? 1 : 0);
}
