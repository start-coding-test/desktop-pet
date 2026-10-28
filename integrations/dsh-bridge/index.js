// 桌宠 Agent 桥（DSH 侧）：把 DSH 会话里发生的事，折成桌宠收件目录里的一行行 JSONL。
//
// 为什么不走 hook：DSH 没有「往设置文件里加一条命令」的扩展面。它的扩展面只有 cordis
// 插件，所以桥只能长在插件里。桌宠认识的另外四家（Qoder / ZCode / Codex / WorkBuddy）
// 都是「改客户端配置文件」，DSH 是唯一一个「客户端主动推」的。
//
// 三条硬规则（与 dsh-ops 的 capture 同一口径）：
//   1. 桥永远不能弄坏会话：每个入口都包 try/catch，handler 一律不向外抛。
//   2. 写盘串行且吞错：同一个文件一条 Promise 链，失败按错误种类只报一次。
//   3. 只写桌宠的收件目录：不读会话内容以外的任何东西，不发网络请求。
//
// 收件目录解析顺序：config.inboxDir（绝对路径）→ $PET_AGENT_INBOX（绝对路径）→
// %APPDATA%\com.desktoppet.pet\agent\inbox。与宿主
// `src-tauri/src/services/agent/inbox.rs::inbox_dir` 的前两级完全一致，第三级是宿主的
// `app_data_dir_standalone()`（identifier 见 `src-tauri/tauri.conf.json`）。
import { appendFile, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { eventLine, isSubagent, sessionEndLine, sessionStartLine } from "./mapping.js";

/** 桌宠宿主的复演开关；桥与宿主读同一个变量，测试里两边指同一个临时目录。 */
export const INBOX_ENV = "PET_AGENT_INBOX";

/** 宿主 `tauri.conf.json` 里的 identifier：改那里就必须改这里，单测钉着。 */
export const APP_IDENTIFIER = "com.desktoppet.pet";

const APP_DATA_INBOX = ["AppData", "Roaming", APP_IDENTIFIER, "agent", "inbox"];

export function apply(ctx, config) {
  // 连订阅面都没有的宿主里什么都别做：桥不能因为「对面少了一个方法」把插件加载搞崩。
  if (typeof ctx?.on !== "function") {
    warn(ctx, "宿主没有 ctx.on：DSH 桥没有事件面可订阅，保持静默");
    return;
  }

  const inbox = resolveInbox(config);
  if (inbox.dir === null) {
    warn(
      ctx,
      `没有可用的收件目录（最后试的是 ${inbox.source}${inbox.value ? `=${inbox.value}` : ""}，` +
        "需要绝对路径）；agent 桥保持静默，桌宠不会收到 DSH 的状态",
    );
    return;
  }

  const sink = createSink(inbox.dir, (message) => warn(ctx, message));
  // 子代理会话的事件不进桌宠：它们和父会话共用一轮，逐条转发会把步数算双。
  const children = new Set();
  let closed = false;

  const emit = (line) => {
    if (closed || line === null) return;
    void sink.write(line);
  };

  const on = (name, handler) => {
    ctx.on(name, (...args) => {
      if (closed) return;
      try {
        handler(...args);
      } catch (err) {
        sink.reportOnce("handler", err);
      }
    });
  };

  on("session/created", (session) => {
    const id = typeof session?.id === "string" ? session.id : "";
    if (isSubagent(session)) {
      if (id !== "") children.add(id);
      return;
    }
    emit(sessionStartLine(session));
  });

  on("session/event", (session, event) => {
    const id = typeof session?.id === "string" ? session.id : "";
    if (id === "" || children.has(id)) return;
    emit(eventLine(id, event));
  });

  on("session/disposed", (session) => {
    const id = typeof session?.id === "string" ? session.id : "";
    // 子代理从头到尾都不进桌宠，收尾也不进：它没有开头的 session-start，
    // 单独发一条 session-end 只会在宿主的会话表里凭空造出一个「刚结束」的会话。
    if (children.delete(id)) return;
    emit(sessionEndLine(session));
  });

  // 插件被停用/热更新时收尾：干净的停用要把已经排队的行写完再走。
  if (typeof ctx.effect === "function") {
    ctx.effect(
      () => () => {
        closed = true;
        return sink.idle();
      },
      "dsh-pet-agent-bridge: flush queued inbox lines",
    );
  }
}

/**
 * 解出收件目录。返回 `{dir}` 或 `{dir: null, source, value}`：后者只用于把
 * 「哪一级配错了」原样写进日志，桥本身不因此抛错。
 */
export function resolveInbox(config, env = process.env) {
  const candidates = [];
  const configured = typeof config?.inboxDir === "string" ? config.inboxDir.trim() : "";
  if (configured !== "") candidates.push(["config.inboxDir", configured]);
  const fromEnv = (env[INBOX_ENV] ?? "").trim();
  if (fromEnv !== "") candidates.push([INBOX_ENV, fromEnv]);
  const appData = (env.APPDATA ?? "").trim();
  if (appData !== "") candidates.push(["APPDATA", join(appData, ...APP_DATA_INBOX)]);

  for (const [source, value] of candidates) {
    if (isAbsolute(value)) return { dir: value, source, value };
  }
  const last = candidates.at(-1);
  return { dir: null, source: last?.[0] ?? "（三级都没配）", value: last?.[1] ?? "" };
}

/**
 * 收件行的落盘队列：每个文件一条 Promise 链，错误吞掉并按种类只报一次
 * （「写不进去」不是一个可以反复刷日志的问题）。
 */
export function createSink(inbox, report) {
  const chains = new Map();
  const reported = new Set();
  let ready = false;

  const ensureDir = async () => {
    if (ready) return;
    await mkdir(inbox, { recursive: true });
    ready = true;
  };

  const once = (kind, err) => {
    if (reported.has(kind)) return;
    reported.add(kind);
    report(`写不进桌宠收件目录（${inbox}）：${describe(err)}`);
  };

  const write = (line) => {
    const path = join(inbox, `${line.phase}.jsonl`);
    const text = `${JSON.stringify(line)}\n`;
    const prev = chains.get(path) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await ensureDir();
        await appendFile(path, text, "utf8");
      })
      .catch((err) => once(err?.code ?? "unknown", err));
    chains.set(path, next);
    return next;
  };

  return {
    write,
    reportOnce: (kind, err) => once(kind, err),
    idle: () => Promise.all([...chains.values()]).then(() => undefined),
  };
}

function describe(err) {
  const code = typeof err?.code === "string" && err.code !== "" ? `${err.code}: ` : "";
  const message = typeof err?.message === "string" && err.message !== "" ? err.message : String(err);
  return `${code}${message}`;
}

function warn(ctx, message) {
  try {
    const logger = ctx?.logger;
    if (typeof logger?.warn === "function") logger.warn(message);
    else console.warn(`[dsh-pet-agent-bridge] ${message}`);
  } catch {
    /* 连日志都写不出来时保持静默：桥不能反过来影响会话 */
  }
}
