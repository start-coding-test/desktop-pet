// L1 原型：插件 Worker 本体（同源资产，由宿主经 Vite 的 `?worker` 构造，见 worker-plugin-host.ts）。
//
// 这个 realm 里没有 window / document / __TAURI_INTERNALS__（ADR-0006 实测 B/H），
// 插件能说的话只有协议里那 24 个方法，全部经宿主转发；身份 `pluginId` 由宿主在 boot 消息里给。
// 本文件与它的依赖里不得出现 `@tauri-apps/*` —— 那等于把裸 IPC 搬进 Worker。
import type { AgentHooksApi, HttpResponse, PluginContext } from "../../packages/sdk";
import {
  fromWorkerError,
  type HostToWorker,
  isHostToWorker,
  type WorkerMethod,
  type WorkerToHost,
  WORKER_LEGACY_CODE,
} from "./plugin-worker-protocol";

type WorkerPluginContext = PluginContext & { agentHooks: AgentHooksApi };

const scope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

function emit(message: WorkerToHost): void {
  scope.postMessage(message);
}

let callSeq = 0;
let subSeq = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const handlers = new Map<number, (payload: unknown) => void>();
let instance: PluginModule | null = null;

interface PluginModule {
  activate?: (ctx: unknown) => Promise<void> | void;
  deactivate?: () => Promise<void> | void;
}

function ask<R>(method: WorkerMethod, args: unknown[], sub?: number): Promise<R> {
  callSeq += 1;
  const seq = callSeq;
  return new Promise<R>((resolve, reject) => {
    pending.set(seq, { resolve: resolve as (value: unknown) => void, reject });
    emit(sub === undefined ? { t: "call", seq, method, args } : { t: "call", seq, method, args, sub });
  });
}

function settle(message: Extract<HostToWorker, { t: "result" }>): void {
  const slot = pending.get(message.seq);
  if (!slot) return;
  pending.delete(message.seq);
  if (message.ok) slot.resolve(message.value);
  else slot.reject(fromWorkerError(message.error));
}

function buildContext(pluginId: string): WorkerPluginContext {
  return {
    pluginId,
    log: (...args: unknown[]) => {
      emit({ t: "log", args });
    },
    bus: {
      publish: (topic, payload) => ask<void>("bus.publish", [topic, payload]),
      subscribe: (topic, handler) => {
        subSeq += 1;
        const sub = subSeq;
        handlers.set(sub, handler);
        return ask<void>("bus.subscribe", [topic], sub).then(
          () => () => {
            if (handlers.delete(sub)) emit({ t: "unsub", sub });
          },
        );
      },
    },
    storage: {
      get: (key) => ask<unknown>("storage.get", [key]),
      set: (key, value) => ask<void>("storage.set", [key, value]),
      delete: (key) => ask<void>("storage.delete", [key]),
    },
    ble: {
      startScan: () => ask<void>("ble.startScan", []),
      stopScan: () => ask<void>("ble.stopScan", []),
      connect: (deviceId) => ask<void>("ble.connect", [deviceId]),
      disconnect: () => ask<void>("ble.disconnect", []),
      connectedDevice: () => ask<string | null>("ble.connectedDevice", []),
    },
    widget: { update: (data) => ask<void>("widget.update", [data]) },
    pet: {
      react: (action) => ask<void>("pet.react", [action]),
      say: (text) => ask<void>("pet.say", [text]),
      setStatus: (text) => ask<string | null>("pet.setStatus", [text]),
    },
    http: { request: (url, options) => ask<HttpResponse>("http.request", [url, options ?? {}]) },
    notify: { show: (title, body) => ask<void>("notify.show", [title, body]) },
    overlay: {
      show: (options) => ask<void>("overlay.show", [options ?? {}]),
      hide: () => ask<void>("overlay.hide", []),
      destroy: () => ask<void>("overlay.destroy", []),
    },
    agentHooks: {
      status: () => ask<unknown>("agentHooks.status", []),
      install: () => ask<unknown>("agentHooks.install", []),
      uninstall: () => ask<unknown>("agentHooks.uninstall", []),
      set: (agent, confirm) => ask<unknown>("agentHooks.set", [agent, confirm ?? false]),
    },
  };
}

async function boot(msg: Extract<HostToWorker, { t: "boot" }>): Promise<void> {
  try {
    // 绝对 petplugin URL：入口内的相对子模块按 ESM 规则相对**入口自身**解析，
    // 这一步是否成立由 tests/e2e/verify-worker.mjs 在真机上证（todo 有 ./todo-txt.js、./topics.js）
    const mod = (await import(/* @vite-ignore */ msg.entryUrl)) as PluginModule;
    instance = mod;
    await mod.activate?.(buildContext(msg.pluginId));
    emit({ t: "booted" });
  } catch (error) {
    emit({
      t: "boot-failed",
      error: { code: WORKER_LEGACY_CODE, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

scope.onmessage = (event: MessageEvent) => {
  const msg = event.data as HostToWorker;
  if (!isHostToWorker(msg)) return;
  if (msg.t === "boot") {
    void boot(msg);
    return;
  }
  if (msg.t === "result") {
    settle(msg);
    return;
  }
  if (msg.t === "event") {
    handlers.get(msg.sub)?.(msg.payload);
    return;
  }
  // 停用：插件自己的 deactivate 在它自己的 realm 里跑完再回执，宿主随后 terminate 这个 Worker
  const run = instance?.deactivate?.();
  Promise.resolve(run)
    .catch((error: unknown) => {
      emit({
        t: "boot-failed",
        error: { code: WORKER_LEGACY_CODE, message: error instanceof Error ? error.message : String(error) },
      });
    })
    .finally(() => {
      handlers.clear();
      emit({ t: "deactivated" });
    });
};
