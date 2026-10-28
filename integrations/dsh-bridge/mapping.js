// DSH 会话事件 → 桌宠收件行。这里是纯函数：不碰磁盘、不读时钟、不抛异常，
// 由 index.js 负责写文件与兜错。
//
// 收件行契约（宿主侧唯一实现 `src-tauri/src/services/agent/inbox.rs::line_for`）：
//   {"phase": "<白名单 phase>", "at": <epoch ms>, "agent": "dsh", "payload": {...}}
// payload 的键必须对齐 `src-tauri/src/services/agent/watcher.rs` 的读取口径：
//   session_id（会话）、tool_name（工具名）、prompt（标题）、
//   command|file_path|path|url|pattern|query（其中第一个非空者作为详情摘要）。
// 这里多写的键宿主不读，不会成为新契约；少写只会少显示一点东西。
//
// phase 白名单见 `src-tauri/src/services/agent/phases.rs::PHASES`（13 条），
// 本文件映射出的每一种都必须在那 13 条里，单测 `tests/unit/unit-dsh-bridge.mjs` 钉住。

export const AGENT_ID = "dsh";

/** 详情摘要可用的键：顺序即优先级，与宿主 `event_detail` 的键表一致。 */
export const DETAIL_KEYS = ["command", "file_path", "path", "url", "pattern", "query"];

/** 事件名 → phase，仅用于文档与单测自查；真实映射在 `eventLine` 的分支里。 */
export const EVENT_PHASES = {
  "user/message": "user-prompt",
  "tool/call": "pre",
  "tool/result": "post",
  "approval/asked": "approval-request",
  "approval/decided": "post",
  "turn/end": "stop",
  "subagent/descriptor": "subagent-start",
};

const PROMPT_LIMIT = 200;
const TOOL_LIMIT = 64;

/** 把文本压成一行并截断；空串、非字符串一律返回 undefined。 */
export function clip(text, limit = PROMPT_LIMIT) {
  if (typeof text !== "string") return undefined;
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat === "") return undefined;
  return flat.length > limit ? flat.slice(0, limit) : flat;
}

/** 取 user/message 里的文本段（DSH 存的是 `[{type:"text", text}]`）。 */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = [];
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** `tool/call` 的 arguments 是 JSON 字符串；取第一个可读参数作为详情摘要。
 *
 * 详情必须挂在 `tool_input` 下面：宿主 `state.rs::event_detail` 先取 `payload.tool_input`
 * 再按 `command|file_path|…` 找键（这是各家 hook 的原始 payload 形状）。放在顶层看着更
 * 自然，但宿主一个字段都读不到 —— 桌宠上会退化成「只显示工具名」。
 */
export function toolDetail(data) {
  let args = data?.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return {};
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  for (const key of DETAIL_KEYS) {
    const value = args[key];
    const text = clip(value);
    if (text !== undefined) return { tool_input: { [key]: text } };
  }
  return {};
}

/** 会话是否属于子代理（子代理的事件不进桌宠，否则每一步都会被算两遍）。 */
export function isSubagent(session) {
  const depth = session?.header?.delegationDepth ?? session?.delegationDepth ?? 0;
  return typeof depth === "number" && depth > 0;
}

/** `session/created` → session-start。 */
export function sessionStartLine(session, at = Date.now()) {
  const sessionId = clip(session?.id, 96);
  if (sessionId === undefined) return null;
  return line("session-start", at, { session_id: sessionId });
}

/** `session/disposed` → session-end。 */
export function sessionEndLine(session, at = Date.now()) {
  const sessionId = clip(session?.id, 96);
  if (sessionId === undefined) return null;
  return line("session-end", at, { session_id: sessionId });
}

/**
 * 一条 `session/event` → 一行收件（或 null 表示这类事件桌宠不关心）。
 * 解析不出来的字段宁可缺，也不猜：宿主缺键时按空值处理，不会因此判错。
 */
export function eventLine(sessionId, event) {
  const id = clip(sessionId, 96);
  if (id === undefined) return null;
  const type = typeof event?.type === "string" ? event.type : "";
  const data = event?.data;
  if (!data || typeof data !== "object") return null;
  const at = Number.isFinite(event?.time) ? event.time : Date.now();

  switch (type) {
    case "user/message": {
      const prompt = clip(textOf(data.content));
      if (prompt === undefined) return null;
      return line("user-prompt", at, { session_id: id, prompt });
    }
    case "tool/call": {
      const tool = clip(data.name, TOOL_LIMIT);
      const payload = { session_id: id, ...toolDetail(data) };
      if (tool !== undefined) payload.tool_name = tool;
      return line("pre", at, payload);
    }
    case "tool/result":
      // `message.isError` 是工具自己的失败；`error` 是通道失败（见 dsh-ops 的 transportFailed）。
      return data?.message?.isError === true || data?.error !== undefined
        ? line("tool-failure", at, { session_id: id })
        : line("post", at, { session_id: id });
    case "approval/asked": {
      const tool = clip(data.toolName, TOOL_LIMIT);
      const payload = { session_id: id };
      if (tool !== undefined) payload.tool_name = tool;
      return line("approval-request", at, payload);
    }
    case "approval/decided":
      // 批准之后工具继续跑，但不会再补一条 tool/call：用 post 把状态拉回 running。
      return line("post", at, { session_id: id });
    case "turn/end":
      return line(phaseForTurnEnd(data.reason), at, { session_id: id });
    case "subagent/descriptor":
      return line("subagent-start", at, { session_id: id });
    default:
      return null;
  }
}

/** 回合结束原因 → phase：正常收尾是 stop，被打断是 interrupt，出错是 stop-failure。 */
export function phaseForTurnEnd(reason) {
  const kind = typeof reason?.kind === "string" ? reason.kind : "";
  if (kind === "completed") return "stop";
  if (kind === "error" || kind === "max-tokens") return "stop-failure";
  if (kind === "aborted" || kind === "interrupted" || kind === "cancelled" || kind === "canceled")
    return "interrupt";
  return "stop";
}

function line(phase, at, payload) {
  return { phase, at, agent: AGENT_ID, payload };
}
