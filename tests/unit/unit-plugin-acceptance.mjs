// 跨插件验收总表（desktop-pet-验收-a18ec21-2026-10-29 的范围 G5~G8）：
//   1) 报告点名但本仓库里根本没有的东西 —— 用源码扫描留证（不能复现项必须给证据，而不是「没做」）；
//   2) 数据源/凭据说明这类「口径」不许自相矛盾：界面文案 ↔ 注册表 ↔ manifest 必须一致；
//   3) 设置动作不能伪装可用（G5-10 阈值自检、G5-14 加密说明随能力变）；
//   4) 已修行为仍然「接着线」：并发门 / 明细推送 / 指令兜底 / 设备名清洗 —— 删任何一处这条就红。
// 全离线、无真实凭据、无真实行情：只读源码 + 假宿主 + 纯函数。
import { readdir, readFile } from "node:fs/promises";
import { group, check, eq, deep } from "./harness.mjs";
import { WidgetRenderSession, createDomFacade } from "../../src/runtime/widget-node.ts";

const ROOT = new URL("../../", import.meta.url);
const PLUGINS = ["com.pet.astock", "com.pet.goat-gauge", "com.pet.todo", "com.pet.hr-ble"];

/** 递归读出插件目录里的文本文件（.js/.mjs/.json/.md），相对路径 → 内容 */
async function sourcesOf(name) {
  const out = new Map();
  async function walk(url, rel) {
    for (const ent of await readdir(url, { withFileTypes: true })) {
      const child = new URL(`${ent.name}${ent.isDirectory() ? "/" : ""}`, url);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(child, relPath);
      else if (/\.(m?js|json|md)$/.test(ent.name)) out.set(relPath, await readFile(child, "utf8"));
    }
  }
  await walk(new URL(`plugins/${name}/`, ROOT), "");
  return out;
}

const ALL = new Map();
for (const name of PLUGINS) ALL.set(name, await sourcesOf(name));
/** 一个插件的全部源码拼一起（只看 .js，文档与 manifest 单独断言） */
const jsOf = (name) =>
  [...ALL.get(name)]
    .filter(([file]) => file.endsWith(".js"))
    .map(([file, text]) => `\n// FILE ${file}\n${text}`)
    .join("");
const fileText = (name, file) => ALL.get(name).get(file) ?? "";
const listOf = (name) => [...ALL.get(name).keys()];

/* ================= 1. 不能复现的项：源码里根本没有这些实现 ================= */
group("报告点名但本仓库没有的实现：给证据（不能复现≠没做）");
{
  const astock = jsOf("com.pet.astock");
  check(
    "astock 里没有「走势」源（走势源移除后不存在需要屏蔽的死按钮）",
    !astock.includes("走势"),
    JSON.stringify({ files: listOf("com.pet.astock").length, hits: [...astock.matchAll(/走势/g)].length }),
  );
  check(
    "astock 里没有 mini / 缩略 K 线组件（详情页只走 board.js 的整块图）",
    !astock.includes("mini") && !astock.includes("缩略"),
    JSON.stringify({ files: listOf("com.pet.astock").length }),
  );
  check(
    "astock 里没有遮罩（mask）实现，所以「mini 默认 mask」无从谈起",
    !astock.includes("mask"),
    JSON.stringify({ files: listOf("com.pet.astock").length }),
  );
  const hr = jsOf("com.pet.hr-ble");
  check(
    "hr 里没有信号格图标（避免「0 格」误导的前提是不存在这个图标）",
    !hr.includes("signal") && !hr.includes("格"),
    JSON.stringify({ files: listOf("com.pet.hr-ble") }),
  );
  const goat = jsOf("com.pet.goat-gauge");
  check(
    "goat 的刷新门不是「120 秒门」：只有 internalFetchGate / snapshotGate 两道",
    goat.includes("internalFetchGate") && goat.includes("snapshotGate") && !/120\s*秒/.test(goat),
    JSON.stringify({ files: listOf("com.pet.goat-gauge").length }),
  );
  const todo = jsOf("com.pet.todo");
  check(
    "todo 里没有确认弹窗（所以「未确认就重开 overlay」不是本仓库的路径）",
    !todo.includes("confirm(") && !todo.includes("dialog"),
    JSON.stringify({ files: listOf("com.pet.todo") }),
  );
  check(
    "todo 的 overlay.show 只有一处（syncCard 按数据决定，开关与空态都不会另开新窗）",
    (todo.match(/overlay\.show/g) ?? []).length === 1,
    JSON.stringify({ hits: (todo.match(/overlay\.show/g) ?? []).length }),
  );
  // 空态链接：todo 面板没有 <a>/href 这种「点了没反应」的东西
  const todoWidget = fileText("com.pet.todo", "widget.js");
  check(
    "todo 空态是一句提示，不是 href=\"#\" 的假链接",
    todoWidget.includes("全部清空了") && !todoWidget.includes("href"),
    JSON.stringify({ href: todoWidget.includes("href") }),
  );
}

/* ================= 2. 数据源口径：界面文案 ↔ 注册表 ↔ manifest ================= */
group("astock 数据源口径一致：文案里的源名与域名都能真的取数（G5-04/G5-08）");
{
  const { MARKET_HOSTS, MARKET_SOURCES } = await import("../../plugins/com.pet.astock/sources/registry.js");
  const prefsText = fileText("com.pet.astock", "views/settings/prefs.js");
  const labels = MARKET_SOURCES.map((s) => s.label);
  check(
    "设置页「数据源：」那行是照注册表拼的，不是手写常量",
    prefsText.includes("MARKET_SOURCES.map((s) => s.label)") &&
      labels.length === 3 &&
      new Set(labels).size === 3 &&
      labels.every((label) => typeof label === "string" && label.length > 0),
    JSON.stringify({ labels, file: "views/settings/prefs.js" }),
  );
  check(
    "设置页写出的域名个数与注册表一致（少写会漏授权、多写就是空头承诺）",
    /可能访问 \$\{MARKET_HOSTS\.length\} 个域名/.test(prefsText) && MARKET_HOSTS.length === 8,
    JSON.stringify({ hosts: MARKET_HOSTS.length }),
  );
  const manifest = JSON.parse(fileText("com.pet.astock", "manifest.json"));
  const describedHosts = [...new Set(manifest.description.match(/[a-z0-9.-]+\.(?:com|cn)/g) ?? [])].sort();
  deep("manifest 描述里点名的域名与注册表完全相同", describedHosts, [...MARKET_HOSTS].sort());
  check(
    "设置页说明的开关语义与取数层一致（关掉后备只走主源）",
    prefsText.includes("关掉「允许后备数据源」后只访问东方财富的主机"),
    "允许后备数据源开关",
  );
  // 新浪没有 depth（报告说「详情页对每个源都可点」属于伪装可用）
  const sina = MARKET_SOURCES.find((s) => s.id === "sina");
  eq("新浪确实不提供 depth，取数链会跳过而不是假装有", sina?.depth ?? null, null);
}

/* ================= 3. 设置动作不伪装可用：阈值自检 + 凭据说明 ================= */
function watchRig() {
  const sent = [];
  const session = new WidgetRenderSession((msg) => sent.push(msg));
  const dom = createDomFacade(session);
  const published = [];
  const status = [];
  const ctx = { dom, bus: { publish: (topic, payload) => published.push([topic, payload]) } };
  const state = {
    lastPanel: null,
    autoPicked: false,
    section: (title, ...nodes) => ({ title, nodes }),
    status: { set: (text, level) => status.push([text, level]) },
  };
  const ops = () => {
    session.flush();
    const out = sent.flatMap((m) => m.ops ?? []);
    sent.length = 0;
    return out;
  };
  return { session, ctx, state, published, status, ops };
}

group("astock 阈值自检：不能成立的输入不再静默清空（G5-10）");
{
  const { thresholdProblem } = await import("../../plugins/com.pet.astock/views/settings/watch-list.js");
  eq("两个都空：不拦", thresholdProblem({ upper: "", lower: "" }), null);
  eq("只填涨到：不拦", thresholdProblem({ upper: "12", lower: "" }), null);
  eq("只填跌到：不拦", thresholdProblem({ lower: "12", upper: "" }), null);
  eq("跌到高于涨到：拦", thresholdProblem({ upper: "10", lower: "20" }), "「跌到」不能高于「涨到」");
  eq("相等是合法边界", thresholdProblem({ upper: "10", lower: "10" }), null);
  eq("不是数字：拦", thresholdProblem({ upper: "abc", lower: "" }), "阈值要填数字");
  eq("0 或负数：拦", thresholdProblem({ upper: "-1", lower: "" }), "阈值要大于 0");

  // UI 级：填了自相矛盾的两格再点「存」，不发指令、给提示、草稿留在框里
  const { mountWatchList } = await import("../../plugins/com.pet.astock/views/settings/watch-list.js");
  const rig = watchRig();
  const view = mountWatchList(rig.ctx, rig.state);
  view.render({
    watch: [{ secid: "1.600519", code: "600519", name: "贵州茅台", upper: null, lower: null, pct: null, limit: true }],
    quotes: {},
  });
  const build = rig.ops();
  const upperId = build.find((o) => o.k === "prop" && o.name === "placeholder" && o.value === "涨到")?.id;
  const lowerId = build.find((o) => o.k === "prop" && o.name === "placeholder" && o.value === "跌到")?.id;
  const saveId = build.find((o) => o.k === "text" && o.value === "存")?.id;
  check("建表帧里找得到两个阈值框与「存」", [upperId, lowerId, saveId].every((v) => typeof v === "number"), JSON.stringify({ upperId, lowerId, saveId }));

  rig.session.handleEvent(upperId, "input", { value: "10" });
  rig.session.handleEvent(lowerId, "input", { value: "20" });
  rig.ops();
  rig.published.length = 0;
  rig.session.handleEvent(saveId, "click", {});
  const blocked = rig.ops();
  eq("矛盾阈值点「存」不发 update", rig.published.length, 0);
  deep("给了人话提示", rig.status.at(-1), ["「跌到」不能高于「涨到」", "error"]);
  check(
    "草稿没被清掉（框里仍是用户填的 10 / 20）",
    [upperId, lowerId].every((id) => !blocked.some((o) => o.k === "prop" && o.id === id && o.name === "value")),
    JSON.stringify(blocked.filter((o) => o.k === "prop" && o.name === "value")),
  );

  // 改对之后能存进去
  rig.session.handleEvent(lowerId, "input", { value: "8" });
  rig.ops();
  rig.session.handleEvent(saveId, "click", {});
  rig.ops();
  const payload = rig.published.at(-1)?.[1];
  deep("改成立刻能存", [payload?.action, payload?.upper, payload?.lower, payload?.pct], ["update", "10", "8", ""]);
}

group("goat 凭据说明随加密能力变，不再一律写 DPAPI（G5-14）");
{
  const { mountOnboarding } = await import("../../plugins/com.pet.goat-gauge/views/settings/onboarding.js");
  const sent = [];
  const session = new WidgetRenderSession((msg) => sent.push(msg));
  const dom = createDomFacade(session);
  const ctx = { dom, bus: { publish: () => {} } };
  const state = { status: { set: () => {} } };
  const onboarding = mountOnboarding(ctx, state);
  session.flush();
  const build = sent.flatMap((m) => m.ops ?? []);
  const noteId = build.find((o) => o.k === "text" && String(o.value).includes("DPAPI"))?.id;
  check("说明行建出来了", typeof noteId === "number", String(noteId));

  const opsOf = () => {
    session.flush();
    const out = sent.flatMap((m) => m.ops ?? []);
    sent.length = 0;
    return out;
  };
  opsOf();
  onboarding.render({ state: "onboarding", secrets: { available: true } });
  const secured = opsOf();
  check(
    "宿主有加密存储时才说 DPAPI",
    secured.some((o) => o.k === "text" && o.id === noteId && String(o.value).includes("DPAPI")),
    JSON.stringify(secured.filter((o) => o.k === "text" && o.id === noteId)),
  );
  onboarding.render({ state: "onboarding", secrets: { available: false } });
  const plain = opsOf();
  const plainText = plain.find((o) => o.k === "text" && o.id === noteId)?.value ?? "";
  check("没有加密能力时如实说明是明文", String(plainText).includes("明文"), String(plainText));
  check("没有加密能力时不再出现「加密」字样去误导", !String(plainText).includes("加密"), String(plainText));
}

/* ================= 4. 已修行为仍然接线（删任一处都会红） ================= */
group("接线断言：并发门 / 明细推送 / 指令兜底 / 设备名清洗（G5-05/G5-06/G5-11/G5-12）");
{
  const goatMain = fileText("com.pet.goat-gauge", "main.js");
  check("并发门接在 refreshSnapshot 外层", goatMain.includes("snapshotGate({ reentrant: snapshotBusy"), "main.js");
  check("门闩真的落闸", goatMain.includes("snapshotBusy = true;"), "main.js");
  check("手动刷新也走两道门", goatMain.includes("if (busy || snapshotBusy)"), "main.js");
  check("Cookie-only 路径上明细变了也会推 :panel", goatMain.includes("if (internalChanged) publishPanel();"), "main.js");
  check("Key 失效不再落成 onboarding（先判 auth_error）", fileText("com.pet.goat-gauge", "views/badge.js").includes('d.state === "auth_error"'), "views/badge.js");

  const hrWidget = fileText("com.pet.hr-ble", "widget.js");
  check("连接指令发的是清洗过的设备名", hrWidget.includes("deviceNames.get(selectedDeviceId)"), "widget.js");
  check("模式单选有编辑锁，旧推送冲不回", hrWidget.includes("modeLock"), "widget.js");
  check("badge 断开时清读数", hrWidget.includes('num.textContent = "--"'), "widget.js");
  const hrIndex = fileText("com.pet.hr-ble", "index.js");
  check("落盘前也清洗设备名", hrIndex.includes("stripSignalSuffix(cmd.deviceName)"), "index.js");

  check(
    "astock 指令处理接住了 reject",
    fileText("com.pet.astock", "main.js").includes("handleCmd(p).catch"),
    "main.js",
  );
  check(
    "todo 一次 toggle 只落一遍盘（strict 存 + afterChange 不再存）",
    fileText("com.pet.todo", "index.js").includes("save: persistStrict") &&
      fileText("com.pet.todo", "index.js").includes("{ save: false }"),
    "index.js",
  );

  // 「关闭」语义：三个插件的悬浮卡显隐都由「用户开关 + 真实状态」共同决定。
  // 关掉开关 / 没配置 / 没连接都必须收窗，不能画上去了事。
  check(
    "goat 悬浮卡：开关关掉或没数据就不弹",
    /config\.showOverlay === true && !!snapshot && viewState !== "onboarding"/.test(goatMain),
    "main.js",
  );
  check(
    "astock 盯盘卡：模式不是 overlay 就收起",
    /const want = config\.mode === "overlay"/.test(fileText("com.pet.astock", "main.js")),
    "main.js",
  );
  check(
    "hr 悬浮窗：只有「波形图模式 + 已连接」才显示",
    /config\.mode === "overlay" && connected/.test(hrIndex),
    "index.js",
  );
}

/* ================= 5. 编辑锁在三个视图各有一份同式实现（G9-09） ================= */
group("编辑锁实现一致：三处都是「追上即放」（G9-09）");
{
  const lock = fileText("com.pet.astock", "views/settings/lock.js");
  check("astock 抽出 lock.js", lock.length > 0, "views/settings/lock.js");
  for (const fn of ["syncSelect", "syncCheck", "syncRadioGroup"]) {
    check(`lock.js 导出 ${fn}`, new RegExp(`export function ${fn}`).test(lock), fn);
  }
  check("放锁条件是「值追上了」", lock.includes("locks.delete(node)"), "lock.js");
  const goatLock = fileText("com.pet.goat-gauge", "views/settings/lock.js");
  check("goat 也抽出 lock.js", goatLock.length > 0, "views/settings/lock.js");
  for (const fn of ["syncSelect", "syncCheck"]) {
    check(`goat lock.js 导出 ${fn}`, new RegExp(`export function ${fn}`).test(goatLock), fn);
  }
  check("goat 放锁条件同样是「值追上了」", goatLock.includes("locks.delete(node)"), "views/settings/lock.js");
  check(
    "goat 设置页用的是 lock.js",
    fileText("com.pet.goat-gauge", "views/settings/prefs.js").includes('from "./lock.js"'),
    "views/settings/prefs.js",
  );
  for (const file of ["views/settings/prefs.js", "views/settings/board.js"]) {
    check(`astock ${file} 用的是共享 lock.js`, fileText("com.pet.astock", file).includes('from "./lock.js"'), file);
  }
}
