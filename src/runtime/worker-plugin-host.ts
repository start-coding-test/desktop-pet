// L1 原型：宿主侧的 Worker 插件宿主（ADR-0006）。
//
// 一个插件一个 Worker、一条通道。身份在这一步就钉死：`buildContext(manifest)` 里闭包住的
// pluginId 来自宿主读到的 manifest，Worker 传什么参数都改不了它 —— 这正是同 realm 时代
// 「谁都能冒用别人的 id 发 invoke」那条拦不住的洞的收口点。
// 能力校验、总线、存储、宠物动作全部复用 bridge.ts 那份实现，这里只做通道与派发。
import PluginWorker from "./plugin-worker.ts?worker";
import type { PluginContext } from "../../packages/sdk";
import { buildContext, createAgentHooksApi } from "./bridge";
import { asHostError } from "./host-error";
import type { PluginManifest } from "./plugin-runtime";
import { pluginFileUrl, pluginFileVersion } from "./plugin-url";
import {
  fromWorkerError,
  isWorkerMethod,
  type HostToWorker,
  type ProxiedMethod,
  type WorkerErrorPayload,
  type WorkerToHost,
  WORKER_LEGACY_CODE,
} from "./plugin-worker-protocol";

/** 等 Worker 回执的上限：boot 要过动态 import 与插件自己的 activate（可能正等同意框） */
const BOOT_TIMEOUT_MS = 60_000;
const DEACTIVATE_TIMEOUT_MS = 5_000;

interface Session {
  pluginId: string;
  worker: Worker;
  ctx: PluginContext;
  agentHooks: ReturnType<typeof createAgentHooksApi>;
  /** 订阅句柄 → 退订函数（Worker 侧只记得句柄，真正的监听在宿主 realm） */
  subs: Map<number, () => void>;
  acks: Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>;
}

function errorPayload(error: unknown): WorkerErrorPayload {
  const err = asHostError(error);
  return { code: typeof err.code === "string" ? err.code : WORKER_LEGACY_CODE, message: err.message };
}

class WorkerPluginHost {
  private sessions = new Map<string, Session>();

  has(pluginId: string): boolean {
    return this.sessions.has(pluginId);
  }

  /** 一个插件的会话数（只读诊断，回归断言「停用后 Worker 真的没了」用它） */
  get sessionCount(): number {
    return this.sessions.size;
  }

  async activate(manifest: PluginManifest): Promise<void> {
    if (this.sessions.has(manifest.id)) return;
    const bust = await pluginFileVersion(manifest.id, manifest.entry);
    const entryUrl = pluginFileUrl(manifest.id, manifest.entry, bust);

    const worker = new PluginWorker();
    const session: Session = {
      pluginId: manifest.id,
      worker,
      ctx: buildContext(manifest),
      agentHooks: createAgentHooksApi(manifest),
      subs: new Map(),
      acks: new Map(),
    };
    this.sessions.set(manifest.id, session);
    worker.onmessage = (event: MessageEvent) => {
      void this.onMessage(session, event.data as WorkerToHost);
    };
    // Worker 里的未捕获错误（含 terminate 之前的 reject）不该静默消失
    worker.onerror = (event: ErrorEvent) => {
      console.error(`[worker-host] ${manifest.id}:`, event.message);
    };

    try {
      this.post(session, { t: "boot", pluginId: manifest.id, entryUrl });
      await this.waitForAck(session, "booted", BOOT_TIMEOUT_MS);
    } catch (error) {
      await this.destroy(session);
      throw error;
    }
  }

  async deactivate(pluginId: string): Promise<void> {
    const session = this.sessions.get(pluginId);
    if (!session) return;
    try {
      this.post(session, { t: "deactivate" });
      await this.waitForAck(session, "deactivated", DEACTIVATE_TIMEOUT_MS);
    } catch (error) {
      // 插件的 deactivate 自己炸了也要把 Worker 收掉，别把会话永久留在表里
      console.error(`[worker-host] ${pluginId} 停用失败`, error);
    }
    await this.destroy(session);
  }

  private async destroy(session: Session): Promise<void> {
    if (this.sessions.get(session.pluginId) === session) this.sessions.delete(session.pluginId);
    for (const off of [...session.subs.values()]) {
      try {
        off();
      } catch {
        /* 退订失败不该拖住回收 */
      }
    }
    session.subs.clear();
    for (const ack of session.acks.values()) clearTimeout(ack.timer);
    session.acks.clear();
    session.worker.terminate();
  }

  private post(session: Session, message: HostToWorker): void {
    try {
      session.worker.postMessage(message);
    } catch (error) {
      console.error(`[worker-host] ${session.pluginId} 投递失败`, error);
    }
  }

  /** 等一条具名回执；同一时刻只可能有一个在途启停（启停链串行，见 plugin-runtime.ts） */
  private waitForAck(session: Session, name: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.acks.delete(name);
        reject(new Error(`[worker-host] ${session.pluginId} 等待 ${name} 超时`));
      }, timeoutMs);
      session.acks.set(name, { resolve, reject, timer });
    });
  }

  private settleAck(session: Session, name: string, error?: WorkerErrorPayload): void {
    const ack = session.acks.get(name);
    if (!ack) return;
    session.acks.delete(name);
    clearTimeout(ack.timer);
    if (error) ack.reject(fromWorkerError(error));
    else ack.resolve();
  }

  private async onMessage(session: Session, msg: WorkerToHost): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "log") {
      console.log(`[${session.pluginId}]`, ...msg.args);
      return;
    }
    if (msg.t === "booted") {
      this.settleAck(session, "booted");
      return;
    }
    if (msg.t === "boot-failed") {
      this.settleAck(session, "booted", msg.error);
      return;
    }
    if (msg.t === "deactivated") {
      this.settleAck(session, "deactivated");
      return;
    }
    if (msg.t === "unsub") {
      const off = session.subs.get(msg.sub);
      if (off) {
        session.subs.delete(msg.sub);
        try {
          off();
        } catch (error) {
          console.error(`[worker-host] ${session.pluginId} 退订失败`, error);
        }
      }
      return;
    }
    if (msg.t !== "call") return;
    try {
      const value = await this.dispatch(session, msg);
      this.post(session, { t: "result", seq: msg.seq, ok: true, value });
    } catch (error) {
      this.post(session, { t: "result", seq: msg.seq, ok: false, error: errorPayload(error) });
    }
  }

  /**
   * 派发表：20 个「纯参数进、纯值出」的方法逐条点名，返回类型写成 `Record<ProxiedMethod, …>`
   * —— 协议里加了方法名而这里没实现，当场编译不过。
   * bus.subscribe 与 log 不在表里：它们的参数或返回里有函数，只能特判。
   */
  private table(session: Session): Record<ProxiedMethod, (args: unknown[]) => unknown> {
    const ctx = session.ctx;
    return {
      "bus.publish": (args) => ctx.bus.publish(String(args[0]), args[1]),
      "storage.get": (args) => ctx.storage.get(String(args[0])),
      "storage.set": (args) => ctx.storage.set(String(args[0]), args[1]),
      "storage.delete": (args) => ctx.storage.delete(String(args[0])),
      "ble.startScan": () => ctx.ble.startScan(),
      "ble.stopScan": () => ctx.ble.stopScan(),
      "ble.connect": (args) => ctx.ble.connect(String(args[0])),
      "ble.disconnect": () => ctx.ble.disconnect(),
      "ble.connectedDevice": () => ctx.ble.connectedDevice(),
      "widget.update": (args) => ctx.widget.update(args[0]),
      "pet.react": (args) => ctx.pet.react(args[0] as Parameters<typeof ctx.pet.react>[0]),
      "pet.say": (args) => ctx.pet.say(String(args[0])),
      "http.request": (args) => ctx.http.request(String(args[0]), args[1] as never),
      "notify.show": (args) => ctx.notify.show(String(args[0]), String(args[1])),
      "overlay.show": (args) => ctx.overlay.show(args[0] as never),
      "overlay.hide": () => ctx.overlay.hide(),
      "overlay.destroy": () => ctx.overlay.destroy(),
      "agentHooks.status": () => session.agentHooks.status(),
      "agentHooks.install": () => session.agentHooks.install(),
      "agentHooks.uninstall": () => session.agentHooks.uninstall(),
      "agentHooks.set": (args) => session.agentHooks.set(String(args[0]), Boolean(args[1])),
    };
  }

  private async dispatch(session: Session, msg: Extract<WorkerToHost, { t: "call" }>): Promise<unknown> {
    if (!isWorkerMethod(msg.method)) {
      throw new Error(`[${session.pluginId}] Worker 通道不接受的方法: ${String(msg.method)}`);
    }
    if (msg.method === "bus.subscribe") {
      const sub = msg.sub;
      if (typeof sub !== "number") throw new Error(`[${session.pluginId}] bus.subscribe 缺少订阅句柄`);
      const off = await session.ctx.bus.subscribe(String((msg.args as unknown[])[0]), (payload: unknown) => {
        if (this.sessions.get(session.pluginId) === session) {
          this.post(session, { t: "event", sub, payload });
        }
      });
      session.subs.set(sub, off);
      return undefined;
    }
    if (msg.method === "log") {
      console.log(`[${session.pluginId}]`, ...msg.args);
      return undefined;
    }
    const call = this.table(session)[msg.method as ProxiedMethod];
    return await call(msg.args ?? []);
  }
}

export const workerPluginHost = new WorkerPluginHost();
