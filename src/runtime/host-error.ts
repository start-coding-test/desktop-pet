// A2 / ADR-0007：IPC 错误 `{code, message}` 的 TS 侧唯一入口。
//
// 码表本体在 packages/sdk/error-codes.json —— Rust 侧 host_error.rs 用 include_str! 内嵌**同一份磁盘文件**
// （import 必须带 `with { type: "json" }`，不带会在 node 单测里当场 ERR_IMPORT_ATTRIBUTE_MISSING，K3 实测过这条）。
// 两侧 const 与这份表的一致性由 cargo 单测 + tests/unit/unit-error-codes.mjs 双向钉住。
import { invoke } from "@tauri-apps/api/core";
import catalog from "../../packages/sdk/error-codes.json" with { type: "json" };

/** 码表本体（冻结）。 */
export const ERROR_CODES: readonly string[] = Object.freeze(
  (catalog.codes as { code: string }[]).map((c) => c.code)
);

/**
 * 兜 Tauri 框架自己发出的裸字符串错误（命令名写错、参数序列化失败这类）。
 * A2 迁移期它标记「还没迁完的命令」；2026-10-14（A07）迁移面走完后语义改成上面那条 ——
 * 码保留、不改名（ADR-0007 规则 2），因为宿主命令之外仍会有非 `{code, message}` 的负载到达前端。
 */
export const LEGACY_CODE = "legacy";

/** 宿主错误的可见形状：`Error` 上加一个 `code`，`message` 与迁移前逐字相同。 */
export type CodedError = Error & { code: string };

function define(code: string): string {
  if (!ERROR_CODES.includes(code)) {
    throw new Error(`[host-error] "${code}" 不在码表里 —— 码表是唯一来源，先改 JSON`);
  }
  return code;
}

/** 门禁拒绝：bridge 自己抛的那条「权限被拒绝」与宿主 gate 的「未授权…」归同一码（ADR-0007）。 */
export const DENIED = define("denied");
export const NOT_FOUND = define("not-found");
export const INVALID_ARG = define("invalid-arg");
export const INVALID_STATE = define("invalid-state");
export const IO = define("io");
export const NETWORK = define("network");
export const PARSE = define("parse");
export const DEVICE_UNAVAILABLE = define("device-unavailable");
export const SCAN_START = define("scan-start");
export const CONSENT_TIMEOUT = define("consent-timeout");
export const UNSUPPORTED = define("unsupported");
export const INTERNAL = define("internal");

/** 宿主命令错误的负载形状。判据只看这两个键是不是字符串。 */
export function isHostErrorPayload(value: unknown): value is { code: string; message: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { code?: unknown; message?: unknown };
  return typeof v.code === "string" && typeof v.message === "string";
}

/**
 * 把 invoke 的拒绝值规整成 `Error & {code}` —— 宿主命令给的是 `{code, message}`，
 * Tauri 框架自己发出的裸字符串错误（命令名写错、参数序列化失败这类）给的是字符串，
 * 两种形状下调用方读到的 `message` 都与文案原文一致，所以 `tests/e2e` 那批按文本判的断言不受影响。
 */
export function asHostError(rejection: unknown): CodedError {
  if (isHostErrorPayload(rejection)) {
    const err = new Error(rejection.message) as CodedError;
    err.name = "HostError";
    err.code = rejection.code;
    return err;
  }
  if (rejection instanceof Error) {
    // bridge 自己抛的（如权限被拒绝）已有 message；没带码的按 legacy 记（框架侧兜底，见 LEGACY_CODE）。
    const err = rejection as CodedError;
    if (typeof err.code !== "string") err.code = LEGACY_CODE;
    return err;
  }
  // 框架侧的裸字符串错误（命令名写错、参数序列化失败）落到这里：message 就是原文案。
  const err = new Error(String(rejection)) as CodedError;
  err.name = "HostError";
  err.code = LEGACY_CODE;
  return err;
}

/**
 * 给人读的那一句：宿主命令（`{code,message}`）、框架侧的裸字符串、
 * 前端自己抛的 `Error` 三种形状都取回**同一句文案**。
 * 设置窗这类「把错误显示进状态行」的地方用它 —— 直接 `String(e)` 会在迁移过的命令上
 * 变成 `Error: …`，那是形状泄漏，不是信息。
 */
export function hostErrorMessage(rejection: unknown): string {
  if (isHostErrorPayload(rejection)) return rejection.message;
  if (rejection instanceof Error) return rejection.message;
  return String(rejection);
}

/** 给 `.catch()` 直接用：把拒绝值换成规整后的 Error 再抛出去。 */
export function rethrowAsHostError(rejection: unknown): never {
  throw asHostError(rejection);
}

/**
 * 前端调宿主的唯一入口（桥内外都用它）。宿主命令 reject `{code,message}`、
 * 框架侧的错误是裸字符串，这里一律收成 `Error & {code}`：`message` 逐字不变，
 * 所以调用点与 `tests/e2e` 的文本判据都不受影响（ADR-0007 的收口点）。
 */
export function hostCall<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args).catch(rethrowAsHostError);
}

/**
 * 桥自己判出来的拒绝（没走到宿主就挡下）也带码 —— ADR-0007 要求桥的「权限被拒绝」
 * 与宿主 gate 的「未授权…」归同一码 `denied`，否则前端要按两套措辞分支。
 * 文案一字不改，只是多挂一个 code。
 */
export function deniedError(message: string): CodedError {
  const err = new Error(message) as CodedError;
  err.name = "HostError";
  err.code = DENIED;
  return err;
}

/* ---------- 严重度分类（G4：普通插件错误不该被当成致命错误） ---------- */

/**
 * 见到一个错误之后，界面该怎么对待它：
 * - `fatal`：宿主自己起不来（启动阶段的未捕获错误）→ 整窗红条；
 * - `warning`：某个插件自己踩的坑（坏 activate、调用被拒、设置页回显失败）→ 只记日志/横幅，
 *   **不许**盖掉整个窗口；
 * - `error`：宿主服务的真失败（io / network / internal / 框架侧的 legacy）→ 记日志，留给上层决定。
 */
export type ErrorSeverity = "fatal" | "warning" | "error";

/**
 * 这些码是「插件域可预期拒绝」：权限没给、参数不对、状态不对、设备不在……
 * 它们只说明**某个插件这次没成**，不代表宿主坏了。分类表放在这里而不是调用点，
 * 是为了让所有上报口径一致（G4-06 只 console、G4-11 listen 回调无 catch 都收口到这张表）。
 */
export const PLUGIN_SCOPED_CODES: readonly string[] = Object.freeze([
  DENIED,
  NOT_FOUND,
  INVALID_ARG,
  INVALID_STATE,
  PARSE,
  CONSENT_TIMEOUT,
  UNSUPPORTED,
  DEVICE_UNAVAILABLE,
  SCAN_START,
]);

export interface SeverityContext {
  /** 还在启动阶段（首帧/清单加载完成之前）：这时的未捕获错误是真起不来 */
  bootPhase?: boolean;
  /** 已知属于哪个插件：一律按插件域处理 */
  pluginId?: string | null;
}

/** 取错误码；不是宿主错误形状的（DOM Error、字符串、null）给 `legacy`。 */
export function errorCodeOf(rejection: unknown): string {
  if (isHostErrorPayload(rejection)) return rejection.code;
  const code = (rejection as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : LEGACY_CODE;
}

export function isPluginScopedError(rejection: unknown): boolean {
  return PLUGIN_SCOPED_CODES.includes(errorCodeOf(rejection));
}

/**
 * 判严重度。顺序有意为之：启动阶段一律致命（页面渲染不出来，别藏）；
 * 带 pluginId 的一律插件域（调用点比码表更清楚这是谁的事）；
 * 其余按码表分类。
 */
export function classifyError(rejection: unknown, context: SeverityContext = {}): ErrorSeverity {
  if (context.bootPhase) return "fatal";
  if (context.pluginId) return "warning";
  if (isPluginScopedError(rejection)) return "warning";
  return "error";
}

