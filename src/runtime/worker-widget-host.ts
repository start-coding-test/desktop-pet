// L2 阶段二：widget Worker 的宿主侧（ADR-0008 决策 8）。
//
// 一个 (pluginId, region) 一个 Worker。本文件做四件事：建 Worker、把 ops 接到渲染器 apply、
// 把 Worker 发来的 `call` 路由到既有能力实现、停用时先等插件自己收尾再 terminate。
//
// **逢 call 必回**：每一次 `call` 都必须有一个 `result`，包括方法名不认、region 不允许、实现抛错。
// 因为 Worker 侧的 `boot` 会 await 插件的 `mount()`，插件在 mount 里发出的调用没人回包，
// 这个 widget 就永远起不来，而宿主只看到「没报错也没 booted」。
//
// 与 worker-plugin-host.ts 同一条排序约束：**本文件不许被 widget-host 顶层 import**。
// 它带着 `?worker` 说明符，node 的离线单测一解析就炸（阶段一就是这么翻的第一次）。
import WidgetWorker from "./widget-worker.ts?worker";
import { buildContext, createAgentHooksApi } from "./bridge";
import { createWidgetRenderer } from "./widget-renderer";
import {
  isWidgetCallAllowed,
  isWidgetToHost,
  type HostToWidget,
  type WidgetToHost,
} from "./widget-protocol";
import type { WidgetRegion } from "../../packages/sdk";

/** 只用到这些字段，不 import widget-host 的类型以免两个模块互相引用。 */
interface ProbeManifest {
  id: string;
  name?: string;
  version?: string;
  entry?: string;
  widget?: string;
  permissions?: string[];
}

interface Session {
  worker: Worker;
  renderer: ReturnType<typeof createWidgetRenderer>;
  unsubscribers: Map<number, () => void>;
  region: WidgetRegion;
  /** 订阅与调用都按这份 manifest 判权限：换成空数组会把合法订阅判成违规 */
  manifest: ProbeManifest;
  pluginId: string;
  settleBoot: (error: Error | null) => void;
  booted: Promise<void>;
}

const sessions = new Map<string, Session>();
const keyOf = (pluginId: string, region: WidgetRegion) => `${pluginId}#${region}`;

/**
 * 等 Worker 回执 `booted` 的上限。
 *
 * 比 phase 1 的 worker-plugin-host（60s）短得多，因为那一条要等插件自己的 `activate()`
 * 走完、可能正卡在同意框上，而 widget 的 `mount()` 不该等任何跨窗口往返。
 * 这条超时不是"优化"而是**必需的兜底**：没有它时 Worker 崩在 import 阶段（或 boot 消息
 * 丢掉）会让 `await booted` 永久挂起 —— 宿主只看到「没报错也没 booted」，
 * widget-host 的 `mounting` / inflight 两张表跟着一起泄漏，unmount 也就卡死。
 */
const WIDGET_BOOT_TIMEOUT_MS = 15_000;

async function resolveSub(session: Session, topic: string, sub: number): Promise<void> {
  const ctx = buildContext(session.manifest as never);
  const off = (await ctx.bus.subscribe(topic, (payload: unknown) => {
    session.worker.postMessage({ t: "bus", sub, payload } satisfies HostToWidget);
  })) as () => void;
  session.unsubscribers.set(sub, off);
}

/** 一次 call 的执行与回包。任何分支都不许不回。 */
async function handleCall(session: Session, msg: Extract<WidgetToHost, { t: "call" }>): Promise<void> {
  const reply = (ok: true, value: unknown): void =>
    session.worker.postMessage({ t: "result", seq: msg.seq, ok, value } satisfies HostToWidget);
  const fail = (code: string, message: string): void =>
    session.worker.postMessage({
      t: "result",
      seq: msg.seq,
      ok: false,
      error: { code, message },
    } satisfies HostToWidget);

  if (!isWidgetCallAllowed(msg.method, session.region)) {
    fail("denied", `widget 不许调用 ${msg.method}（region=${session.region}）`);
    return;
  }
  const ctx = buildContext(session.manifest as never);
  const hooks = createAgentHooksApi(session.manifest as never) as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  try {
    if (msg.method === "bus.publish") {
      await ctx.bus.publish(msg.args[0] as string, msg.args[1]);
      reply(true, null);
      return;
    }
    if (msg.method === "bus.subscribe") {
      if (typeof msg.sub !== "number") {
        fail("invalid-arg", "bus.subscribe 缺少 sub 句柄");
        return;
      }
      await resolveSub(session, msg.args[0] as string, msg.sub);
      reply(true, null);
      return;
    }
    const fn = hooks[msg.method.split(".")[1] as "status" | "install" | "uninstall" | "set"];
    // 参数一律透传：门禁已经过了，这里不该再决定「哪个方法值得带参数」。
    // `set` 靠这两个参数才知道切给谁、用户确认了没有；另外三个不接受参数，多给不影响。
    reply(true, await fn.apply(hooks, msg.args));
  } catch (error) {
    const e = error as { code?: string; message?: string };
    fail(e.code ?? "legacy", e.message ?? String(error));
  }
}

export const workerWidgetHost = {
  /** doMount 已经把 host 容器与 closed Shadow Root 建好了，这里只接管里面的渲染 */
  async mount(args: {
    manifest: ProbeManifest;
    region: WidgetRegion;
    url: string;
    host: HTMLElement;
    shadow: ShadowRoot;
  }): Promise<void> {
    const { manifest, region, url, host, shadow } = args;
    const key = keyOf(manifest.id, region);
    await this.deactivate(manifest.id, region);

    const worker = new WidgetWorker();
    let settleBoot: (error: Error | null) => void = () => undefined;
    const booted = new Promise<void>((resolve, reject) => {
      settleBoot = (error) => (error ? reject(error) : resolve());
    });
    const session: Session = {
      worker,
      renderer: createWidgetRenderer({
        root: shadow,
        container: host,
        pluginId: manifest.id,
        postMessage: (msg, transfer) =>
          transfer?.length ? worker.postMessage(msg, transfer) : worker.postMessage(msg),
      }),
      unsubscribers: new Map(),
      region,
      manifest,
      pluginId: manifest.id,
      settleBoot,
      booted,
    };
    sessions.set(key, session);

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as WidgetToHost;
      if (!isWidgetToHost(msg)) {
        console.error(`[widget] ${manifest.id} 发来协议外的消息，已丢弃`, msg);
        return;
      }
      switch (msg.t) {
        case "ops":
          session.renderer.apply(msg.ops);
          return;
        case "call":
          void handleCall(session, msg);
          return;
        case "unsub": {
          session.unsubscribers.get(msg.sub)?.();
          session.unsubscribers.delete(msg.sub);
          return;
        }
        case "booted":
          session.settleBoot(null);
          return;
        case "boot-failed":
          session.settleBoot(new Error(`${manifest.id} 的 widget 起不来：${msg.error.message}`));
          return;
        default:
          return;
      }
    };
    worker.onerror = (e) => {
      const err = new Error(`${manifest.id} 的 widget Worker 崩了：${e.message}`);
      session.settleBoot(err);
      console.error(err.message);
    };

    worker.postMessage({
      t: "boot",
      pluginId: manifest.id,
      entryUrl: url,
      region,
      permissions: manifest.permissions ?? [],
    } satisfies HostToWidget);

    // settleBoot 是幂等的（resolve 之后再 reject／reject 之后再 resolve 都是 no-op），
    // 所以超时与迟到的 booted 谁先到都不会产生未处理的 rejection。
    const bootTimer = setTimeout(() => {
      session.settleBoot(
        new Error(`${manifest.id} 的 widget 在 ${WIDGET_BOOT_TIMEOUT_MS}ms 内没有 booted`),
      );
    }, WIDGET_BOOT_TIMEOUT_MS);
    try {
      await booted;
    } catch (error) {
      this.destroy(key, session);
      throw error;
    } finally {
      clearTimeout(bootTimer);
    }
  },

  /** 停用：先让插件自己收尾（最多等 5 秒），再 terminate + 拆渲染器 */
  async deactivate(pluginId: string, region: WidgetRegion): Promise<void> {
    const key = keyOf(pluginId, region);
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 5_000);
      const wait = (e: MessageEvent) => {
        if ((e.data as WidgetToHost)?.t === "deactivated") {
          clearTimeout(done);
          resolve();
        }
      };
      session.worker.addEventListener("message", wait);
      session.worker.postMessage({ t: "deactivate" } satisfies HostToWidget);
    });
    this.destroy(key, session);
  },

  has(pluginId: string, region?: WidgetRegion): boolean {
    for (const key of sessions.keys()) {
      const [id, reg] = key.split("#");
      if (id !== pluginId) continue;
      if (!region || reg === region) return true;
    }
    return false;
  },

  get size(): number {
    return sessions.size;
  },

  destroy(key: string, session: Session): void {
    if (key) sessions.delete(key);
    for (const off of session.unsubscribers.values()) off();
    session.unsubscribers.clear();
    session.renderer.destroy();
    session.worker.terminate();
  },
};
