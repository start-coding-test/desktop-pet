// L2 阶段二：widget Worker 侧的运行时（ADR-0008）。
//
// 一个 (pluginId, region) 挂载对应一个这种 Worker。它拿不到真 ShadowRoot，也拿不到
// `window` / `document` / `localStorage`；能拿到的只有 createWidgetRuntime 给的这套替身。
//
// 两条刻意的设计：
// 1. **topic ACL 复用宿主同一份 `createScopedBus`**，不在 Worker 里重写一套判断 ——
//    两处规则迟早漂移，而它的行为（同步 throw、订他人要声明 bus:subscribe）是既有断言钉着的。
//    topic-acl 只依赖 plugin-capabilities 那份纯常量表，进 Worker 安全。
// 2. **`ctx.host` 只在 settings 区构造**。badge / overlay 区的 Worker 里这个键压根不存在，
//    不是「存在但调用被拒」—— 那是 widget-host 现在就在守的边界，搬进 Worker 不能搬成软门禁。
//
// 与 plugin-worker.ts 同一条禁令：本文件不许 import `host-error.ts` 或任何 `@tauri-apps/*`。
import { createScopedBus } from "./topic-acl";
import { createDomFacade, WidgetRenderSession, type WidgetNode } from "./widget-node";
import type { HostToWidget, WidgetToHost } from "./widget-protocol";

/** widget 模块的形状：与 `WidgetExports` 同构，只是 root 换成了虚拟节点。 */
export interface WidgetModule {
  mount: (root: WidgetNode, ctx: WorkerWidgetContext) => void | Promise<void>;
  deactivate?: (root: WidgetNode) => void | Promise<void>;
  /** 宿主 realm 一直用的旧名字。四个示例插件都只导出这个，不认它等于迁移后插件的清理白写。 */
  unmount?: (root: WidgetNode) => void | Promise<void>;
}

export interface WidgetRuntimeDeps {
  post: (msg: WidgetToHost) => void;
  /** 真实 Worker 里就是 `import(url)`；单测注入一个假模块 */
  loadEntry: (url: string) => Promise<WidgetModule>;
}

export type WidgetLayout = Extract<HostToWidget, { t: "layout" }>;

export interface WorkerWidgetContext {
  readonly pluginId: string;
  readonly region: string;
  /** 与宿主 realm 那份同名同语义：违规当场同步 throw（topic-acl） */
  bus: {
    publish(topic: string, payload: unknown): void;
    subscribe(topic: string, handler: (payload: unknown) => void): () => void;
  };
  /** 建节点用的替身：迁移时把 `document.createElement` 换成 `ctx.dom.createElement` */
  dom: ReturnType<typeof createDomFacade>;
  /** 尺寸与 dpr 由宿主观测后推（Worker 里没有 window）。对应旧代码的 `window.addEventListener("resize", …)` */
  onLayout: (handler: (layout: WidgetLayout) => void) => () => void;
  /** 画布控制权交接：回调拿到那块节点的 id 与 OffscreenCanvas，之后只能在 Worker 里画它 */
  onCanvas: (handler: (id: number, off: OffscreenCanvas) => void) => () => void;
  /** 仅 settings 区存在（region 由宿主在 boot 里告知，不是插件自己能选的） */
  host?: { agentHooks: AgentHooksApi };
}

export interface AgentHooksApi {
  status(): Promise<unknown>;
  install(): Promise<unknown>;
  uninstall(): Promise<unknown>;
  /** 唯一一个带参数的：切换要同时交出「选哪家」和「用户已确认」 */
  set(agent: string, confirm?: boolean): Promise<unknown>;
}

export interface WidgetRuntime {
  boot(msg: Extract<HostToWidget, { t: "boot" }>): Promise<void>;
  hostMessage(msg: HostToWidget): void;
}

export function createWidgetRuntime(deps: WidgetRuntimeDeps): WidgetRuntime {
  let session: WidgetRenderSession | null = null;
  let instance: WidgetModule | null = null;
  let seq = 1;
  let nextSub = 1;
  const subs = new Map<number, (payload: unknown) => void>();
  const waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const layouts = new Set<(layout: WidgetLayout) => void>();
  const canvases = new Set<(id: number, off: OffscreenCanvas) => void>();

  const call = (method: string, args: unknown[], sub?: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = seq++;
      waiters.set(id, { resolve, reject });
      deps.post(sub === undefined ? { t: "call", seq: id, method, args } : { t: "call", seq: id, method, args, sub });
    });

  const busLike = {
    // publish 是同步的（fire-and-forget）：宿主侧的失败由它自己记日志，不在这里变成未处理的 rejection
    publish: (topic: string, payload: unknown): void => {
      void call("bus.publish", [topic, payload]).catch(() => undefined);
    },
    subscribe: (topic: string, handler: (payload: unknown) => void): (() => void) => {
      const sub = nextSub++;
      subs.set(sub, handler);
      void call("bus.subscribe", [topic], sub).catch(() => undefined);
      return () => {
        if (subs.delete(sub)) deps.post({ t: "unsub", sub });
      };
    },
  };

  const boot = async (msg: Extract<HostToWidget, { t: "boot" }>): Promise<void> => {
    session = new WidgetRenderSession((batch) => deps.post(batch));
    const ctx: WorkerWidgetContext = {
      pluginId: msg.pluginId,
      region: msg.region,
      bus: createScopedBus(msg.pluginId, msg.permissions, busLike),
      dom: createDomFacade(session),
      onLayout: (handler) => {
        layouts.add(handler);
        return () => layouts.delete(handler);
      },
      onCanvas: (handler) => {
        canvases.add(handler);
        return () => canvases.delete(handler);
      },
    };
    if (msg.region === "settings") {
      const agent = (method: string) => () => call(method, []);
      ctx.host = {
        agentHooks: {
          status: agent("agentHooks.status"),
          install: agent("agentHooks.install"),
          uninstall: agent("agentHooks.uninstall"),
          // 不能套上面那个零参工厂：set 少了 agent 与 confirm 就切不动，宿主只会收到一次 agent 为空的调用
          set: (agentId, confirm) => call("agentHooks.set", [agentId, confirm ?? false]),
        },
      };
    }
    try {
      const mod = await deps.loadEntry(msg.entryUrl);
      if (typeof mod?.mount !== "function") throw new Error(`widget.js 缺少 mount() 导出: ${msg.entryUrl}`);
      instance = mod;
      await mod.mount(session.root, ctx);
      // 首屏不能等下一个微任务：宿主在 booted 之后就要看到树已经建好
      session.flush();
      deps.post({ t: "booted" });
    } catch (error) {
      instance = null;
      deps.post({
        t: "boot-failed",
        error: { code: "legacy", message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const deactivate = async (): Promise<void> => {
    try {
      // 停用钩子在两个 realm 里同名才不用改插件：宿主 realm 一直调 `unmount`，
      // 所以 Worker 侧也认它（`deactivate` 是阶段二给的新名字）。
      // 只认一个：两个都导出时 `deactivate` 优先，绝不能两个都调 —— 调两次就是重复退订。
      const teardown = instance?.deactivate ?? instance?.unmount;
      await teardown?.(session?.root as WidgetNode);
    } catch {
      // 插件收尾自己炸了：不外泄成未处理拒绝，也不让宿主干等 —— 照样回执 deactivated
    } finally {
      instance = null;
      subs.clear();
      layouts.clear();
      canvases.clear();
      waiters.clear();
      session?.discard();
      session = null;
      deps.post({ t: "deactivated" });
    }
  };

  return {
    boot,
    hostMessage(msg: HostToWidget) {
      switch (msg.t) {
        case "boot":
          void boot(msg);
          return;
        case "result": {
          const pending = waiters.get(msg.seq);
          if (!pending) return;
          waiters.delete(msg.seq);
          if (msg.ok) pending.resolve(msg.value);
          else pending.reject(new Error(msg.error.message));
          return;
        }
        case "event":
          session?.handleEvent(msg.id, msg.event, (msg.value ?? {}) as Record<string, unknown>);
          return;
        case "bus":
          subs.get(msg.sub)?.(msg.payload);
          return;
        case "layout":
          for (const handler of [...layouts]) handler(msg);
          return;
        case "handoff":
          for (const handler of [...canvases]) handler(msg.id, msg.off);
          return;
        case "deactivate":
          void deactivate();
          return;
      }
    },
  };
}

/**
 * Worker 自举。守卫的理由很实际：这个模块也要能被 node 的离线单测 import，而 node 里没有 `self`。
 */
const scope =
  typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function"
    ? (self as unknown as {
        postMessage: (msg: WidgetToHost) => void;
        onmessage: ((e: { data: unknown }) => void) | null;
      })
    : null;

if (scope) {
  const runtime = createWidgetRuntime({
    post: (msg) => scope.postMessage(msg),
    loadEntry: (url) => import(/* @vite-ignore */ url) as Promise<WidgetModule>,
  });
  scope.onmessage = (e) => {
    const msg = e.data as HostToWidget;
    if (msg && typeof msg === "object" && "t" in msg) runtime.hostMessage(msg);
  };
}

