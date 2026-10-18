// PetAPI 能力桥：按 manifest 权限逐项校验，未授权时触发同意框，拒绝默认。
// 进程内插件不是硬安全边界，这里是策略层（见 docs/architecture/ARCHITECTURE.md 信任模型）。
import { listen } from "@tauri-apps/api/event";
import { bus } from "./event-bus";
import { PET_ACTIONS, petController, type ActionName } from "../pet/host";
import { claim, release } from "./resources";
import { register } from "./subscriptions";
import { assertPublishable, assertSubscribable } from "./topic-acl";
import { deniedError, hostCall } from "./host-error";
import {
  AGENT_HOOKS,
  BLE_CONNECT,
  BLE_SCAN,
  BUS_PUBLISH,
  BUS_SUBSCRIBE,
  HTTP,
  HTTP_HOST_PREFIX,
  NOTIFY,
  OVERLAY,
  PET_REACT,
  PET_SAY,
  STORAGE,
  WIDGET,
} from "./plugin-capabilities";
import type { HttpResponse, PluginContext } from "../../packages/sdk";

function requireController() {
  const controller = petController();
  if (!controller) throw new Error("宠物本体尚未初始化完成");
  return controller;
}

interface ManifestLike {
  id: string;
  name: string;
  permissions?: string[];
}

/**
 * 会话内已授权能力缓存（插件 id → 能力名）。
 * 心率这类插件每秒要过好几项能力，逐次问宿主就是一串没有必要的 IPC；
 * 撤销授权时由 runtime 监听 `host:permission-revoked` 清掉对应条目。
 */
const granted = new Map<string, Set<string>>();

// 撤销授权后必须丢掉**本窗口**的桥缓存。运行时（宠物窗）的监听在 plugin-runtime 里，
// 但设置窗里的插件设置页用的是本窗口的模块实例，而撤销入口就在设置窗 —— 漏了这条，
// 缓存会一直说「已授权」，设置区插件的下一次调用要等整窗重载才会重新走能力校验。
void listen<string>("host:permission-revoked", (e) => invalidatePermissions(e.payload)).catch(() => undefined);

export function invalidatePermissions(pluginId?: string): void {
  if (pluginId) granted.delete(pluginId);
  else granted.clear();
}

export function grantedCapabilities(pluginId: string): string[] {
  return [...(granted.get(pluginId) ?? [])];
}

/** 一次弹框申请多个能力（http 需要 http + http:<host> 两级，不该弹两次） */
async function ensurePermissions(manifest: ManifestLike, capabilities: string[]): Promise<boolean> {
  const pid = manifest.id;
  const known = granted.get(pid) ?? new Set<string>();
  const uncached = capabilities.filter((capability) => !known.has(capability));

  // 缓存说「没授权」时仍要问宿主一次：授权表是宿主的事实，可能已被别处改动
  const missing: string[] = [];
  for (const capability of uncached) {
    const ok = await hostCall<boolean>("permission_check", { pluginId: pid, capability });
    if (ok) known.add(capability);
    else missing.push(capability);
  }
  if (missing.length === 0) {
    granted.set(pid, known);
    return true;
  }
  const accepted = await hostCall<boolean>("permission_request", {
    pluginId: pid,
    capabilities: missing,
  });
  if (accepted) {
    for (const capability of missing) known.add(capability);
    granted.set(pid, known);
  }
  return accepted;
}

async function ensurePermission(manifest: ManifestLike, capability: string): Promise<boolean> {
  return ensurePermissions(manifest, [capability]);
}

/** 包装一个能力方法：调用前校验权限 */
function gated<A extends unknown[], R>(
  manifest: ManifestLike,
  capability: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    if (!(await ensurePermission(manifest, capability))) {
      throw deniedError(`[${manifest.id}] 权限被拒绝: ${capability}`);
    }
    return fn(...args);
  };
}

/**
 * settings 区 widget 的受控宿主通道（能力名 `agent:hooks` 走共享名单，见 plugin-capabilities.ts）。
 * 只在 `widget-host.ts` 里当 `ctx.host.agentHooks` 注入 —— 这是本卡唯一的新攻击面，
 * 别在这里扩大面。
 */
export function createAgentHooksApi(manifest: ManifestLike) {
  return {
    status: gated(manifest, AGENT_HOOKS, () => hostCall<unknown>("agent_hooks_status", { pluginId: manifest.id })),
    install: gated(manifest, AGENT_HOOKS, () => hostCall<unknown>("agent_hooks_install", { pluginId: manifest.id })),
    uninstall: gated(manifest, AGENT_HOOKS, () => hostCall<unknown>("agent_hooks_uninstall", { pluginId: manifest.id })),
    // 切换联动的 Agent（设置页四选一）。单独一条命令的理由见 ADR-0002 与 A02 卡片 §5：
    // 「卸旧失败、停在原状态」必须同步回给设置页，复用 install 或「写配置再让宿主响应」都做不到
    set: gated(manifest, AGENT_HOOKS, (agent: string, confirm?: boolean) =>
      hostCall<unknown>("agent_linkage_set", { pluginId: manifest.id, agent, confirm: confirm ?? false }),
    ),
  };
}

export function buildContext(manifest: ManifestLike): PluginContext {
  const pid = manifest.id;
  const storage = {
    // store_* 已迁到 `{code, message}`（ADR-0007）。这一层规整让两种形状对调用方同形：
    // message 逐字不变，多出来的 code 才是新信息，所以未迁移的命令一行都不用动。
    get: (key: string) => hostCall("store_get", { pluginId: pid, key }),
    set: (key: string, value: unknown) =>
      hostCall("store_set", { pluginId: pid, key, value }),
    delete: (key: string) => hostCall("store_delete", { pluginId: pid, key }),
  };
  return {
    pluginId: pid,
    log: (...args: unknown[]) => console.log(`[${pid}]`, ...args),

    bus: {
      publish: gated(manifest, BUS_PUBLISH, (topic: string, payload: unknown) => {
        assertPublishable(pid, topic);
        // 带上 pid：宿主要按它校验 topic 前缀与 bus:publish 授权（见 commands/bus.rs）
        return Promise.resolve(bus.publish(topic, payload, pid));
      }),
      /** 返回退订函数（先 await 才拿到）。停用插件时宿主统一回收，见 runtime/subscriptions.ts */
      subscribe: gated(manifest, BUS_SUBSCRIBE, (topic: string, handler: (payload: unknown) => void) => {
        assertSubscribable(pid, topic, manifest.permissions ?? []);
        const off = bus.subscribe(topic, handler);
        return Promise.resolve(register(pid, off));
      }),
    },

    storage: {
      get: gated(manifest, STORAGE, (key: string) => storage.get(key) as Promise<unknown>),
      set: gated(manifest, STORAGE, (key: string, value: unknown) => storage.set(key, value) as Promise<void>),
      delete: gated(manifest, STORAGE, (key: string) => storage.delete(key) as Promise<void>),
    },

    ble: {
      startScan: gated(manifest, BLE_SCAN, async () => {
        // 先 claim 是对的（并发时不该有两个「开始扫描」），但失败必须对称回滚：
        // 留着幽灵持有者的话，真正在扫的那个 release 时永远返回 false，扫描就停不下来
        claim("ble-scan", pid);
        try {
          await hostCall("ble_start_scan", { pluginId: pid });
        } catch (err) {
          release("ble-scan", pid);
          throw err;
        }
      }),
      stopScan: gated(manifest, BLE_SCAN, async () => {
        // 仍有别的插件在扫就不该真的停
        if (release("ble-scan", pid)) await hostCall("ble_stop_scan", { pluginId: pid });
      }),
      connect: gated(manifest, BLE_CONNECT, async (deviceId: string) => {
        claim("ble", pid);
        try {
          await hostCall("ble_connect", { pluginId: pid, deviceId });
        } catch (err) {
          release("ble", pid);
          throw err;
        }
      }),
      disconnect: gated(manifest, BLE_CONNECT, async () => {
        if (release("ble", pid)) await hostCall("ble_disconnect", { pluginId: pid });
      }),
      connectedDevice: gated(manifest, BLE_CONNECT, () =>
        hostCall("ble_connected_device", { pluginId: pid }) as Promise<string | null>,
      ),
    },

    // widget 数据下发：以 `${pluginId}:widget` topic 广播，widget.js 自行订阅
    widget: {
      update: gated(manifest, WIDGET, (data: unknown) =>
        Promise.resolve(bus.publish(`${pid}:widget`, data, pid)),
      ),
    },

    // 影响宠物本体：插播动作 / 弹台词气泡（本体只暴露这两个受控入口，不给 canvas/DOM）
    pet: {
      react: gated(manifest, PET_REACT, async (action: unknown) => {
        if (!PET_ACTIONS.includes(action as ActionName)) {
          throw new Error(`[${pid}] 未知宠物动作: ${String(action)}`);
        }
        requireController().react(action as ActionName);
      }),
      say: gated(manifest, PET_SAY, async (text: unknown) => {
        const clean = String(text ?? "")
          .replace(/\s*\n\s*/g, " ")
          .trim()
          .slice(0, 200);
        if (!clean) throw new Error(`[${pid}] say 需要非空文本内容`);
        requireController().say(clean);
      }),
    },

    // 出站请求：域名逐个授权（http + http:<host>），实际请求由宿主代发并二次校验 host
    http: {
      request: async (
        url: string,
        options: { method?: string; headers?: [string, string][]; body?: string } = {},
      ) => {
        let host: string;
        try {
          host = new URL(url).host;
        } catch {
          throw new Error(`[${pid}] URL 非法: ${url}`);
        }
        if (!(await ensurePermissions(manifest, [HTTP, `${HTTP_HOST_PREFIX}${host}`]))) {
          throw deniedError(`[${pid}] 域名授权被拒绝: ${host}`);
        }
        return hostCall<HttpResponse>("http_request", {
          pluginId: pid,
          url,
          method: options.method ?? null,
          headers: options.headers ?? null,
          body: options.body ?? null,
        });
      },
    },

    notify: {
      show: gated(manifest, NOTIFY, (title: string, body: string) =>
        hostCall("notify_show", { pluginId: pid, title, body }) as Promise<void>,
      ),
    },

    overlay: {
      // 每个插件一扇自己的悬浮窗（标签 overlay-<id>）：位置、高度、显隐互不影响，
      // 不再是谁先 show 谁定这扇窗。位置（逻辑像素 x/y）由插件直传、自己存，
      // 宿主只按所在显示器工作区做屏内夹紧；placement 是过渡期参数：宿主接受但忽略（打 warn）
      show: gated(manifest, OVERLAY, async (options: { x?: number; y?: number; height?: number; placement?: string } = {}) => {
        await hostCall("overlay_show", {
          pluginId: pid,
          placement: options.placement ?? null,
          height: options.height ?? null,
          x: options.x ?? null,
          y: options.y ?? null,
        });
      }),
      hide: gated(manifest, OVERLAY, async () => {
        await hostCall("overlay_hide", { pluginId: pid });
      }),
      destroy: gated(manifest, OVERLAY, async () => {
        await hostCall("overlay_destroy", { pluginId: pid });
      }),
    },
  };
}
