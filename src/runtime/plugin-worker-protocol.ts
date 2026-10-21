// L1 原型：宿主 realm 与插件 Worker realm 之间唯一的消息契约（ADR-0006）。
//
// 插件代码搬进 module Worker 之后，`window.__TAURI_INTERNALS__` 不再可达，出入只剩这一条通道；
// 因此这张方法表就是插件能说的全部话 —— 多一个名字等于扩大攻击面，少一个名字等于砸掉生态。
//
// 这个文件两侧共用，所以它**不许** import `host-error.ts` 或任何 `@tauri-apps/*`：
// 一旦被 Worker 侧拉到，插件 Worker 的 bundle 里就会躺着真正的 IPC 入口，隔离当场作废。
// 错误的规整（asHostError）留在宿主侧做，Worker 只消费 `{code, message}` 这个纯负载。
import catalog from "../../packages/sdk/error-codes.json" with { type: "json" };

/** 面向插件的 27 个方法（点号命名空间）。`log` 不占能力，但同样只能走这条通道。
 *  27 = 22 的底座 + A02 的 `agentHooks.set`（第 23）+ B3 的 `pet.setStatus`（第 24）+ B07 的 `secrets.*`（第 25–27），见 ADR-0006 增项记录。 */
export const PLUGIN_WORKER_METHODS = [
  "bus.publish",
  "bus.subscribe",
  "storage.get",
  "storage.set",
  "storage.delete",
  "secrets.get",
  "secrets.set",
  "secrets.delete",
  "ble.startScan",
  "ble.stopScan",
  "ble.connect",
  "ble.disconnect",
  "ble.connectedDevice",
  "widget.update",
  "pet.react",
  "pet.say",
  "pet.setStatus",
  "http.request",
  "notify.show",
  "overlay.show",
  "overlay.hide",
  "overlay.destroy",
  "log",
  "agentHooks.status",
  "agentHooks.install",
  "agentHooks.uninstall",
  // A02 设置页四选一：切换联动的 Agent（先卸旧再装新，同步拿回结果）
  "agentHooks.set",
] as const;

export type WorkerMethod = (typeof PLUGIN_WORKER_METHODS)[number];

/**
 * 宿主派发表要覆盖的方法：27 个里除去 `bus.subscribe`（参数带函数）与 `log`（不回包），
 * 剩下 25 个都是「纯参数进、纯值出」，可以做成一张表 —— 表的完备性由 Record 类型钉住。
 */
export type ProxiedMethod = Exclude<WorkerMethod, "bus.subscribe" | "log">;

const METHOD_SET: ReadonlySet<string> = new Set<string>(PLUGIN_WORKER_METHODS);

/** 宿主侧唯一的入站方法名判据：不在表里的方法当场拒，不做「未知就当透传」的兜底 */
export function isWorkerMethod(name: unknown): name is WorkerMethod {
  return typeof name === "string" && METHOD_SET.has(name);
}

/** 码表里那条兜底码的名字（与 `host-error.ts` 的 LEGACY_CODE 同值，单测对撞两处防漂） */
export const WORKER_LEGACY_CODE = "legacy";

const CODES: readonly string[] = (catalog.codes as { code: string }[]).map((c) => c.code);

/** 过通道的码必须是码表里的码；不是就退成兜底码，别让插件收到来路不明的字符串码 */
export function normalizeWorkerCode(code: unknown): string {
  return typeof code === "string" && CODES.includes(code) ? code : WORKER_LEGACY_CODE;
}

export interface WorkerErrorPayload {
  code: string;
  message: string;
}

/** Worker 侧还原成 `Error & {code}`：插件里 `catch (err) { err.code }` 与同 realm 时同形 */
export function fromWorkerError(payload: WorkerErrorPayload): Error {
  const err = new Error(payload.message) as Error & { code: string };
  err.name = "HostError";
  err.code = normalizeWorkerCode(payload.code);
  return err;
}

/** 宿主 → Worker：装载插件、请求停用、把总线事件推回指定订阅、回包 */
export type HostToWorker =
  | { t: "boot"; pluginId: string; entryUrl: string }
  | { t: "deactivate" }
  | { t: "event"; sub: number; payload: unknown }
  | { t: "result"; seq: number; ok: true; value: unknown }
  | { t: "result"; seq: number; ok: false; error: WorkerErrorPayload };

/** Worker → 宿主：能力调用、日志、退订、启停回执 */
export type WorkerToHost =
  | { t: "call"; seq: number; method: string; args: unknown[]; sub?: number }
  | { t: "log"; args: unknown[] }
  | { t: "unsub"; sub: number }
  | { t: "booted" }
  | { t: "boot-failed"; error: WorkerErrorPayload }
  | { t: "deactivated" };

/** 入站消息的类型判据：Worker 侧只认这几种 `t`，其余（含宿主 realm 随手 post 的东西）忽略 */
export function isHostToWorker(value: unknown): value is HostToWorker {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { t?: unknown }).t;
  return t === "boot" || t === "deactivate" || t === "event" || t === "result";
}

/**
 * 插件默认跑在 Worker 里（L2 阶段一）。要留在宿主 realm 的插件走这一份**例外名单**：
 * 宠物窗 localStorage 的逗号分隔 id。为什么还留着这条口子而不是硬翻 ——
 * 回归脚手架（`tests/e2e/harness/fixtures.mjs` 与 `verify-isolation.mjs` 里那些探针）
 * 的入口代码把事实写进 `window.__probe*`，入口一进 Worker 这些断言就没有对象了；
 * 探针是测试脚手架、不是真实插件，让它们留在老路径，真实插件才是要验的那四个。
 */
export const REALM_HOST_FLAG = "host:realm-plugin-host";

export function shouldUseWorkerHost(pluginId: string, optOut: string | null | undefined): boolean {
  if (!optOut) return true;
  return !optOut
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .includes(pluginId);
}
