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
import { appendFile, mkdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { eventLine, isSubagent, sessionEndLine, sessionStartLine } from "./mapping.js";

/** 桌宠宿主的复演开关；桥与宿主读同一个变量，测试里两边指同一个临时目录。 */
export const INBOX_ENV = "PET_AGENT_INBOX";

/** 宿主 `tauri.conf.json` 里的 identifier：改那里就必须改这里，单测钉着。 */
export const APP_IDENTIFIER = "com.desktoppet.pet";

/** G6-11 写侧上限：一行 32 KiB、每个 phase 文件 8 MiB、每文件最多 256 行在排队。 */
export const MAX_LINE_BYTES = 32 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PENDING = 256;

// %APPDATA% 本身就是 `C:\Users\<user>\AppData\Roaming`：这里只接 identifier 之后的段，
// 再写一次 `AppData\Roaming` 就会拼到 `...\Roaming\AppData\Roaming\...`，宿主永远读不到。
const APP_DATA_INBOX = [APP_IDENTIFIER, "agent", "inbox"];

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
    if (id === "") return;
    // G6-13：桥可能在一轮中途装上 —— 那时子代理的 session/created 已经错过，只靠上面
    // 那张表会把子代理的每一步当父会话再数一遍。所以每条事件都按它自己的 session 再判一次。
    if (isSubagent(session) || children.has(id)) {
      children.add(id);
      return;
    }
    emit(eventLine(id, event));
  });

  on("session/disposed", (session) => {
    const id = typeof session?.id === "string" ? session.id : "";
    // 子代理从头到尾都不进桌宠，收尾也不进：它没有开头的 session-start，
    // 单独发一条 session-end 只会在宿主的会话表里凭空造出一个「刚结束」的会话。
    // 没登记过的（桥中途装上）同样按 isSubagent 认出来，不能当成父会话收尾。
    if (children.delete(id) || isSubagent(session)) return;
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
 *
 * `pathApi` 可注入（G7-01）：CI 的 Linux runner 上 `node:path` 的 `isAbsolute` 不认
 * `C:\...`，单测直接传 Windows 口径的实现 —— 这样断言的是桥自己的顺序与回退，
 * 而不是宿主平台的路径规则（此前 Windows 夹具在 Linux 上静默全绿，等于没测）。
 */
export function resolveInbox(config, env = process.env, pathApi = { isAbsolute, join }) {
  const candidates = [];
  const configured = typeof config?.inboxDir === "string" ? config.inboxDir.trim() : "";
  if (configured !== "") candidates.push(["config.inboxDir", configured]);
  const fromEnv = (env[INBOX_ENV] ?? "").trim();
  if (fromEnv !== "") candidates.push([INBOX_ENV, fromEnv]);
  const appData = (env.APPDATA ?? "").trim();
  if (appData !== "") candidates.push(["APPDATA", pathApi.join(appData, ...APP_DATA_INBOX)]);

  for (const [source, value] of candidates) {
    if (pathApi.isAbsolute(value)) return { dir: value, source, value };
  }
  const last = candidates.at(-1);
  return { dir: null, source: last?.[0] ?? "（三级都没配）", value: last?.[1] ?? "" };
}

/**
 * 收件行的落盘队列：每个文件一条 Promise 链，错误吞掉并按种类只报一次
 * （「写不进去」不是一个可以反复刷日志的问题）。
 *
 * G6-11 的三道上限都在这一层：桌宠侧没有「拒绝接收」的回执，桥如果无脑追加，
 * 一次跑飞的事件流就能把磁盘写满；而卸载/断开之后桥仍可能活着（桥住在 DSH 里），
 * 上限是它最后一道自保。超限只报告一次并丢掉那一条，绝不反过来弄坏会话。
 */
export function createSink(inbox, report) {
  const chains = new Map();
  const pending = new Map();
  const sizes = new Map();
  const reported = new Set();
  let ready = false;

  const ensureDir = async () => {
    if (ready) return;
    await mkdir(inbox, { recursive: true });
    ready = true;
  };

  const sizeOf = async (path) => {
    if (sizes.has(path)) return sizes.get(path);
    return stat(path).then(
      (info) => info.size,
      () => 0,
    );
  };

  const once = (kind, err) => {
    if (reported.has(kind)) return;
    reported.add(kind);
    report(`写不进桌宠收件目录（${inbox}）：${describe(err)}`);
  };

  const write = (line) => {
    const path = join(inbox, `${line.phase}.jsonl`);
    const text = `${JSON.stringify(line)}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_LINE_BYTES) {
      once("line-limit", new RangeError(`单行 ${bytes} 字节，超过上限 ${MAX_LINE_BYTES}`));
      return Promise.resolve();
    }
    if ((pending.get(path) ?? 0) >= MAX_PENDING) {
      once("backlog", new Error(`${path} 积压超过 ${MAX_PENDING} 行`));
      return Promise.resolve();
    }
    const prev = chains.get(path) ?? Promise.resolve();
    pending.set(path, (pending.get(path) ?? 0) + 1);
    const next = prev
      .then(async () => {
        await ensureDir();
        const size = await sizeOf(path);
        if (size + bytes > MAX_FILE_BYTES) {
          once("file-limit", new Error(`${path} 已到 ${MAX_FILE_BYTES} 字节上限`));
          return;
        }
        sizes.set(path, size + bytes);
        await appendFile(path, text, "utf8");
      })
      .catch((err) => once(err?.code ?? "unknown", err))
      .finally(() => pending.set(path, Math.max(0, (pending.get(path) ?? 1) - 1)));
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
