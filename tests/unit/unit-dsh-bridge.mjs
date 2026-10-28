// DSH 桥（integrations/dsh-bridge/）的离线一致性单测。
//
// 桥是唯一一个「事件由对方进程主动推」的接入面：宠物这边没有配置文件可数，
// 所以它的正确性只能靠两份契约对齐 ——
//   1. 映射出的 phase 必须落在宿主白名单里，payload 的键必须是宿主真正会读的那些；
//   2. 包清单必须让 DSH 的 install_bundle 认得出来（patch 里的 name、exports、locale、icon）。
// 两条都**对着 Rust 源码读**，不是抄一份常量在 JS 里：抄一份就会两边各自漂。
//
// 收件行契约见 src-tauri/src/services/agent/inbox.rs::line_for；
// phase 白名单见 src-tauri/src/services/agent/phases.rs::PHASES；
// 详情键见 src-tauri/src/services/agent/state.rs::event_detail 的 KEYS。
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, deep, eq, group } from "./harness.mjs";

const ROOT = new URL("../../", import.meta.url);
const BUNDLE = new URL("../../integrations/dsh-bridge/", import.meta.url);
const mapping = await import(new URL("mapping.js", BUNDLE));
const bridge = await import(new URL("index.js", BUNDLE));

const rust = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
const json = async (rel) => JSON.parse(await readFile(new URL(rel, BUNDLE), "utf8"));

/** 从 Rust 源码里读 `pub const X: &[&str] = &[...]` / `const X: [&str; n] = [...]` 的字符串项。 */
function rustList(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`找不到 ${marker}`);
  // 跳过类型标注里的 `[`（`&[&str]` / `[&str; 6]`），只取 `=` 之后那个数组
  const open = src.indexOf("[", src.indexOf("=", at));
  const close = src.indexOf("]", open);
  return [...src.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 取 Rust 顶层 `fn name` 的函数体原文（到下一个行首 `}` 为止）。 */
function rustFn(src, name) {
  const at = src.indexOf(`fn ${name}`);
  if (at < 0) throw new Error(`找不到 fn ${name}`);
  const end = src.indexOf("\n}", at);
  if (end < 0) throw new Error(`找不到 fn ${name} 的结尾`);
  return src.slice(at, end);
}

const phases = rustList(rust("src-tauri/src/services/agent/phases.rs"), "pub const PHASES");
const agentIds = rustList(rust("src-tauri/src/services/agent/phases.rs"), "pub const AGENT_IDS");
const detailKeys = rustList(rust("src-tauri/src/services/agent/state.rs"), "const KEYS");

/* ==================== 契约对读：白名单 / 详情键 / 身份 ==================== */
group("与宿主 Rust 源码对读");

check("读到了宿主 PHASES（防解析失效造成的假绿）", phases.length === 13, `phases=${phases.length}`);
eq("桥的 agent 标识在 --agent 白名单里", agentIds.includes(mapping.AGENT_ID), true);
eq("桥的 agent 标识就是宿主认识的 dsh", mapping.AGENT_ID, "dsh");
deep("详情键与宿主 event_detail 的 KEYS 逐字一致（顺序即优先级）", [...mapping.DETAIL_KEYS], detailKeys);

// 映射能产出的每一种 phase 都必须在宿主白名单里：多一个就是「写进去被静默丢弃」
const produced = new Set([
  ...Object.values(mapping.EVENT_PHASES),
  "session-start",
  "session-end",
  "tool-failure",
  ...["completed", "error", "max-tokens", "aborted", "interrupted", "cancelled", "canceled", "other"].map(
    (kind) => mapping.phaseForTurnEnd({ kind }),
  ),
]);
for (const phase of [...produced].sort()) {
  check(`映射出的 phase 在宿主白名单里: ${phase}`, phases.includes(phase));
}
eq(
  "EVENT_PHASES 只登记文档里能对上 phase 的那几种（不代表全部映射）",
  Object.keys(mapping.EVENT_PHASES).length >= 6,
  true,
);

const manifest = await json("package.json");
const tauriConf = JSON.parse(rust("src-tauri/tauri.conf.json"));
eq("收件目录用的 identifier 与 tauri.conf.json 一致", bridge.APP_IDENTIFIER, tauriConf.identifier);

/* ============================ 映射：逐事件类型 ============================ */
group("session/事件 → 收件行");

const at = 1792401646292;
const line = (sessionId, event) => mapping.eventLine(sessionId, event);

{
  const got = line("s1", {
    type: "user/message",
    time: at,
    data: { content: [{ type: "text", text: "  帮我看看\n这个 bug " }] },
  });
  eq("用户发言 → user-prompt", got.phase, "user-prompt");
  deep("行级字段齐全（phase/at/agent/payload）", [got.at, got.agent, typeof got.payload], [at, "dsh", "object"]);
  eq("空白折叠后的 prompt", got.payload.prompt, "帮我看看 这个 bug");
  eq("session_id 带过去", got.payload.session_id, "s1");
}

eq(
  "没有文本段的用户消息不产生收件行（宁缺不猜）",
  line("s1", { type: "user/message", time: at, data: { content: [{ type: "image" }] } }),
  null,
);

{
  const got = line("s1", {
    type: "tool/call",
    time: at,
    data: { name: "pwsh", arguments: '{"command":"ls -la","timeout":5}' },
  });
  eq("工具调用 → pre", got.phase, "pre");
  eq("工具名进 tool_name", got.payload.tool_name, "pwsh");
  deep("参数摘要在 tool_input 下（宿主 event_detail 读的就是这一层）", got.payload.tool_input, {
    command: "ls -la",
  });
  eq("顶层不重复一份 command（宿主不读，写了就是假契约）", got.payload.command, undefined);
}

{
  const got = line("s1", { type: "tool/call", time: at, data: { name: "read", arguments: '{"path":"a/b.js"}' } });
  deep("取第一个可读参数（path 排在 command/file_path 之后）", got.payload.tool_input, { path: "a/b.js" });
}

{
  const got = line("s1", { type: "tool/call", time: at, data: { name: "read", arguments: "not json" } });
  eq("参数不是合法 JSON 时仍发 pre（工具确实跑了）", got.phase, "pre");
  eq("解析不出来就不带 tool_input", got.payload.tool_input, undefined);
}

{
  const got = line("s1", { type: "tool/call", time: at, data: { name: "x", arguments: '{"other":1}' } });
  eq("参数里没有可读键时不硬凑详情", got.payload.tool_input, undefined);
}

eq(
  "工具成功 → post",
  line("s1", { type: "tool/result", time: at, data: { message: { isError: false } } }).phase,
  "post",
);
eq(
  "工具自身报错 → tool-failure",
  line("s1", { type: "tool/result", time: at, data: { message: { isError: true } } }).phase,
  "tool-failure",
);
eq(
  "通道失败（data.error 存在）也算失败",
  line("s1", { type: "tool/result", time: at, data: { error: { code: "transport" } } }).phase,
  "tool-failure",
);

{
  const got = line("s1", { type: "approval/asked", time: at, data: { id: "a1", toolName: "pwsh" } });
  eq("等用户确认 → approval-request（宿主映射成 needs_input）", got.phase, "approval-request");
  eq("确认框上的工具名带过去", got.payload.tool_name, "pwsh");
}

eq(
  "批准后 → post 把状态拉回 running（工具不会补发 tool/call）",
  line("s1", { type: "approval/decided", time: at, data: { id: "a1", outcome: "allowed-once" } }).phase,
  "post",
);

group("turn/end 的 reason → phase");
for (const [kind, want] of [
  ["completed", "stop"],
  ["error", "stop-failure"],
  ["max-tokens", "stop-failure"],
  ["aborted", "interrupt"],
  ["interrupted", "interrupt"],
  ["cancelled", "interrupt"],
  ["canceled", "interrupt"],
  ["something-new", "stop"],
]) {
  eq(`reason=${kind} → ${want}`, mapping.phaseForTurnEnd({ kind }), want);
}
eq("reason 缺失时按正常收尾处理（不是 interrupt）", mapping.phaseForTurnEnd(undefined), "stop");

eq(
  "子代理启动 → subagent-start",
  line("s1", { type: "subagent/descriptor", time: at, data: { label: "review" } }).phase,
  "subagent-start",
);

group("不关心的事件一律 null");
for (const type of [
  "assistant/message",
  "step/start",
  "step/end",
  "job/registered",
  "job/settled",
  "session/title",
  "turn/start",
  "types-we-never-saw",
]) {
  eq(`${type} 不产生收件行`, line("s1", { type, time: at, data: {} }), null);
}
eq("没有 data 的事件跳过", line("s1", { type: "tool/call", time: at }), null);
eq("没有 type 的事件跳过", line("s1", { time: at, data: {} }), null);
eq("没有 session id 的事件跳过", line("", { type: "tool/call", time: at, data: { name: "x" } }), null);

eq(
  "event.time 不是数字时用当下时间（不产生 NaN）",
  Number.isFinite(line("s1", { type: "tool/call", data: { name: "x" } }).at),
  true,
);

group("会话起止与子代理判定");
eq("session/created → session-start", mapping.sessionStartLine({ id: "s1" }).phase, "session-start");
eq("session/disposed → session-end", mapping.sessionEndLine({ id: "s1" }).phase, "session-end");
eq("没有 id 的会话不发 session-start", mapping.sessionStartLine({}), null);
eq(
  "session_id 截到宿主的上限 96（bounded_str 的同一口径）",
  mapping.sessionStartLine({ id: "x".repeat(200) }).payload.session_id.length,
  96,
);
eq("父会话（depth 0）不是子代理", mapping.isSubagent({ header: { delegationDepth: 0 } }), false);
eq("子代理（depth 1）是", mapping.isSubagent({ header: { delegationDepth: 1 } }), true);
eq("没有 header 时按父会话处理", mapping.isSubagent({}), false);
eq("delegationDepth 在顶层也认（两种实测形状都兜住）", mapping.isSubagent({ delegationDepth: 2 }), true);

group("clip 的边界");
eq("空串 → undefined", mapping.clip("   "), undefined);
eq("非字符串 → undefined", mapping.clip(42), undefined);
eq("折叠换行与制表", mapping.clip("a\n\t b"), "a b");
eq("超长截断到 200", mapping.clip("x".repeat(300)).length, 200);
eq("自定义上限", mapping.clip("x".repeat(10), 4), "xxxx");

/* ============================ 收件目录解析 ============================ */
group("resolveInbox 的三级顺序");

{
  const abs = "C:\\pet-inbox";
  eq(
    "config.inboxDir 优先于环境变量",
    bridge.resolveInbox({ inboxDir: abs }, { PET_AGENT_INBOX: "C:\\env" }).dir,
    abs,
  );
  eq(
    "config 里是相对路径就跳过（只接受绝对路径）",
    bridge.resolveInbox({ inboxDir: "relative/dir" }, { PET_AGENT_INBOX: "C:\\env" }).dir,
    "C:\\env",
  );
  eq(
    "环境变量也必须是绝对路径",
    bridge.resolveInbox({}, { PET_AGENT_INBOX: "rel", APPDATA: "C:\\Users\\x\\AppData\\Roaming" }).dir,
    // APPDATA 本身已是 …\AppData\Roaming，第三级只接 identifier\agent\inbox
    join("C:\\Users\\x\\AppData\\Roaming", bridge.APP_IDENTIFIER, "agent", "inbox"),
  );
}

{
  const miss = bridge.resolveInbox({}, {});
  eq("三级都没配时不给目录", miss.dir, null);
  check("miss 结果里带最后一试的来源（日志要能说清哪一级配错了）", typeof miss.source === "string" && miss.source !== "");
  const rel = bridge.resolveInbox({}, { PET_AGENT_INBOX: "rel", APPDATA: "" });
  eq("有值但不是绝对路径时同样判 null", rel.dir, null);
  eq("来源指向最后一个候选", rel.source, "PET_AGENT_INBOX");
}

/* ================== 收件目录回退值 ↔ 宿主拼法对读（防回归） ================== */
// 桥的第三级回退不该是「抄一份常量」：宿主的拼法只有一处 ——
//   inbox.rs::app_data_dir_standalone() = %APPDATA% + identifier()
//   inbox.rs::inbox_dir(app_data)      = app_data + "agent" + "inbox"
// 这里按源码把这两段 join 读出来（identifier 再经 state.rs 的 include_str! 对回那张
// tauri.conf.json），与桥解析出的目录逐字比。以后再往哪边多拼一层 AppData\Roaming，
// 断言就会红 —— 这一层错曾经一直是绿的，因为期望值是照着 bug 抄的。
group("收件目录回退值 = 宿主 %APPDATA%\\<identifier>\\agent\\inbox");

const inboxSrc = rust("src-tauri/src/services/agent/inbox.rs");
const stateSrc = rust("src-tauri/src/services/agent/state.rs");
const appDataFn = rustFn(inboxSrc, "app_data_dir_standalone");
const inboxFn = rustFn(inboxSrc, "inbox_dir");
/** 函数体里 `.join("字面量")` 的段（按出现顺序）；`join(标识符)` 不算，另由断言钉。 */
const literalJoins = (body) => [...body.matchAll(/\.join\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);

deep("宿主 app_data_dir_standalone 不自己加 AppData\\Roaming（只按 identifier 拼一层）", literalJoins(appDataFn), []);
check(
  "宿主 app_data_dir_standalone 用的是 identifier()",
  /\.join\(\s*identifier\(\)\s*\)/.test(appDataFn),
  appDataFn,
);
deep("宿主 inbox_dir 挂在 APPDATA 之后的段就是 agent/inbox", literalJoins(inboxFn), ["agent", "inbox"]);

// identifier() 的实参是 include_str! 的那份配置：解析回真实文件再读一次，
// 免得「宿主的拼法」和「桥比对的 identifier」根本不是同一份 tauri.conf.json。
const confFromState = /include_str!\(\s*"([^"]+)"\s*\)/.exec(rustFn(stateSrc, "identifier"))?.[1];
eq(
  "identifier() 嵌的就是 src-tauri/tauri.conf.json（不是另抄一份常量）",
  typeof confFromState === "string" && confFromState.endsWith("tauri.conf.json"),
  true,
);
const embedded = confFromState
  ? JSON.parse(readFileSync(new URL(confFromState, new URL("src-tauri/src/services/agent/", ROOT)), "utf8"))
  : {};
eq("identifier() 读到的那份配置与上面比对的一致", embedded.identifier, tauriConf.identifier);

{
  // 真实 Windows 上 %APPDATA% 的取值形状；宿主与桥都必须只往后接 identifier\agent\inbox。
  const appData = "C:\\Users\\x\\AppData\\Roaming";
  const hostSubpath = [tauriConf.identifier, ...literalJoins(inboxFn)];
  const resolved = bridge.resolveInbox({}, { APPDATA: appData });
  eq("回退命中的来源就是 APPDATA（不是别的级）", resolved.source, "APPDATA");
  eq("收件目录回退值与宿主拼法逐字一致", resolved.dir, join(appData, ...hostSubpath));
}

/* ============================ 真写盘：createSink / apply ============================ */
group("createSink：一行一条、每个 phase 一个文件");

const dir = await mkdtemp(join(tmpdir(), "pet-dsh-bridge-sink-"));
try {
  const sink = bridge.createSink(dir, () => {});
  sink.write(line("s1", { type: "tool/call", time: 1, data: { name: "read", arguments: '{"path":"a"}' } }));
  sink.write(line("s1", { type: "turn/end", time: 2, data: { reason: { kind: "completed" } } }));
  await sink.idle();

  deep("按 phase 分文件", (await readdir(dir)).sort(), ["pre.jsonl", "stop.jsonl"]);
  const written = JSON.parse((await readFile(join(dir, "pre.jsonl"), "utf8")).trim());
  eq("落盘的是收件行的原样 JSON", written.phase, "pre");
  eq("agent 字段不丢", written.agent, "dsh");
  eq("tool_input 原样落盘", written.payload.tool_input.path, "a");

  sink.write(line("s1", { type: "tool/call", time: 3, data: { name: "grep" } }));
  await sink.idle();
  eq(
    "同一文件是追加不是覆盖",
    (await readFile(join(dir, "pre.jsonl"), "utf8")).trim().split("\n").length,
    2,
  );

  // 写不进去：只报一次，且报告里点明收件目录（写不进去要能定位，不能安静吞掉）
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "not a directory");
  const reported = [];
  const bad = bridge.createSink(join(blocker, "inbox"), (message) => reported.push(message));
  bad.write(mapping.sessionStartLine({ id: "s" }, 1));
  bad.write(mapping.sessionStartLine({ id: "s" }, 2));
  await bad.idle();
  eq("连续两次写失败只报一次", reported.length, 1);
  check("报告里带上了收件目录路径", reported[0].includes(join(blocker, "inbox")));
} finally {
  await rm(dir, { recursive: true, force: true });
}

group("apply：订阅三件事，子代理不转发，停用时先冲刷");

const applyDir = await mkdtemp(join(tmpdir(), "pet-dsh-bridge-apply-"));
try {
  const handlers = new Map();
  const effects = [];
  const logs = [];
  const ctx = {
    logger: { warn: (m) => logs.push(m) },
    on: (name, handler) => handlers.set(name, handler),
    effect: (fn) => effects.push(fn),
  };
  bridge.apply(ctx, { inboxDir: applyDir });
  deep("订阅了会话的创建/事件/销毁", [...handlers.keys()].sort(), [
    "session/created",
    "session/disposed",
    "session/event",
  ]);

  handlers.get("session/created")({ id: "parent", header: { delegationDepth: 0 } });
  handlers.get("session/event")({ id: "parent" }, {
    type: "user/message",
    time: 10,
    data: { content: [{ type: "text", text: "hi" }] },
  });
  // 子代理：先登记，再发事件 —— 它的每一步都不该进桌宠（否则步数算双）
  handlers.get("session/created")({ id: "child", header: { delegationDepth: 1 } });
  handlers.get("session/event")({ id: "child" }, { type: "tool/call", time: 11, data: { name: "read" } });
  // 子代理收尾同样不转发：它没有开头的 session-start，单独一条 session-end 会在
  // 宿主的会话表里凭空造出一个「刚结束」的会话（父会话的状态会被它带偏）。
  handlers.get("session/disposed")({ id: "child", header: { delegationDepth: 1 } });

  eq("注册了停用时的冲刷钩子", effects.length, 1);
  // cordis 的 effect 收的是「返回 cleanup 的工厂」：先取到 cleanup 再调它。
  // 直接 await 工厂只会拿到一个函数（不 thenable），排队的写入就没人等了。
  const cleanup = effects[0]();
  eq("工厂返回 cleanup 函数", typeof cleanup, "function");
  await cleanup();

  deep("子代理的事件没有落盘", (await readdir(applyDir)).sort(), ["session-start.jsonl", "user-prompt.jsonl"]);
  eq("没有 warn（正常路径不刷日志）", logs.length, 0);

  // 任何一条事件处理器拿到垃圾都不许抛：桥不能反过来弄坏会话
  let threw = null;
  try {
    handlers.get("session/event")({}, {});
    handlers.get("session/created")();
    handlers.get("session/disposed")();
  } catch (err) {
    threw = err;
  }
  eq("处理器对畸形输入不抛", threw, null);
  // 没有 ctx.on 的宿主（或别家 cordis 版本）：apply 直接静默退出，绝不把插件加载搞崩
  let brokeOnHost = null;
  try {
    bridge.apply({ logger: { warn: () => {} } }, { inboxDir: applyDir });
    bridge.apply(undefined, {});
  } catch (err) {
    brokeOnHost = err;
  }
  eq("没有 ctx.on 的宿主也不会把加载搞崩", brokeOnHost, null);
  // 停用之后再来的事件一律忽略（插件卸载后不该继续写盘）
  handlers.get("session/created")({ id: "late" });
  await new Promise((r) => setTimeout(r, 20));
  deep(
    "停用后不再写入",
    (await readdir(applyDir)).sort(),
    ["session-start.jsonl", "user-prompt.jsonl"],
  );
} finally {
  await rm(applyDir, { recursive: true, force: true });
}

/* ============================ 包清单（install_bundle 要认得） ============================ */
group("bundle 清单与展示元数据");

eq("包名", manifest.name, "dsh-pet-agent-bridge");
eq("私有包（不发布）", manifest.private, true);
eq("ES Module", manifest.type, "module");
eq("主入口导出", manifest.exports["."], "./index.js");
eq("声明了 bundle 的 patch", manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
deep("locale 与 icon 有导出", [manifest.exports["./icon"], manifest.exports["./locale/*.json"]], [
  "./icon.svg",
  "./locale/*.json",
]);

const patch = await readFile(new URL("cordis.patch.yml", BUNDLE), "utf8");
check("patch 用 insert 行挂插件", /^- insert:$/m.test(patch));
check(
  "patch 里的 name 就是包名（写错的话 DSH 加载器导入不到）",
  // 换行写 `\r?\n`：CI 的 windows runner 上工作区可能被检出成 CRLF（Git for Windows 默认
  // core.autocrlf=true），此前硬编码 `\n` 会让这条在 CRLF 工作区误红。行尾是检出细节，
  // 不属于 patch 的契约内容 —— 判据仍然只认「name 必须紧跟 id 行」，只是不再挑行尾。
  new RegExp(`^\\s+- id: pet-agent-bridge$\\r?\\n\\s+name: ${manifest.name}$`, "m").test(patch),
  patch,
);

for (const locale of ["en.json", "zh-CN.json"]) {
  const meta = (await json(join("locale", locale))).meta ?? {};
  check(`${locale} 有 meta.title`, typeof meta.title === "string" && meta.title !== "");
  check(`${locale} 有 meta.description`, typeof meta.description === "string" && meta.description !== "");
}

const icon = statSync(new URL("icon.svg", BUNDLE));
check("icon 在 DSH 的 256KiB 上限内", icon.size <= 256 * 1024, `${icon.size} B`);
check("icon 是 svg", (await readFile(new URL("icon.svg", BUNDLE), "utf8")).includes("<svg"));

const mappingSrc = await readFile(new URL("mapping.js", BUNDLE), "utf8");
check(
  "mapping.js 保持纯函数（不 import 任何 node: 模块，才好在离线单测里直接用）",
  !/from\s+["']node:/.test(mappingSrc),
);
const indexSrc = await readFile(new URL("index.js", BUNDLE), "utf8");
check("index.js 导出 apply（cordis 插件入口）", /export function apply\(/.test(indexSrc));
check("index.js 的写入口也导出，便于单测覆盖", /export function createSink\(/.test(indexSrc));
