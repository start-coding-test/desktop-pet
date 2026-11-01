// 悬浮窗：每扇只挂**它自己的那个插件**的 overlay widget。
// 窗口是按插件建的（标签 overlay-<插件 id>），所以这里不再遍历全部启用插件 ——
// 那样会把别人的卡片叠进同一扇窗。
import { hostCall } from "../runtime/host-error";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { bus } from "../runtime/event-bus";
import { applyHotReload, reloadIdsFrom } from "../runtime/hot-reload";
import { loadEnabled, type PluginManifest } from "../runtime/plugin-runtime";
import { widgetHost } from "../runtime/widget-host";
import { closeReason, decideOverlayAction, OWNER_RETRY_MS } from "./lifecycle";
import "./style.css";

/** 归属由宿主按窗口标签回查（标签是净化过的，点号不能原样保留）；null = 还没查到 */
let pluginId: string | null = null;
let mounted = false;
/** 从什么时候开始查不到归属（附录2 N4：给宿主一点登记时间，超时就关自己） */
let ownerMissingSince: number | null = null;
let retryTimer: number | null = null;
let closing = false;

function now(): number {
  return Date.now();
}

function ownerMissingMs(): number {
  return ownerMissingSince === null ? 0 : now() - ownerMissingSince;
}

function scheduleRetry(): void {
  if (retryTimer !== null || closing) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void sync().catch((error) => console.error("[overlay] retry sync", error));
  }, OWNER_RETRY_MS);
}

/**
 * 收掉这扇窗。
 * 空窗（认不出主人 / 插件没了）如果不关，就是一扇**点不到也关不掉**的置顶窗，
 * 用户只能去任务管理器杀进程（附录2 N4）。close 本身也可能因为窗口已销毁而失败，
 * 那正好说明目标达成，一并吞掉。
 */
async function closeSelf(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  console.warn(`[overlay] 关闭悬浮窗 ${getCurrentWindow().label}：${reason}`);
  if (pluginId) {
    await widgetHost.unmount(pluginId).catch(() => undefined);
  }
  mounted = false;
  await getCurrentWindow().close().catch(() => undefined);
}

async function sync(): Promise<void> {
  if (closing) return;

  if (!pluginId) {
    let owner: string | null = null;
    try {
      owner = await hostCall<string | null>("overlay_owner");
    } catch (error) {
      // 宿主还没登记完（新窗刚建）或 IPC 失败：都按「暂时不知道」处理，不给用户留空窗
      console.error("[overlay] overlay_owner 失败", error);
    }
    if (!owner) {
      ownerMissingSince ??= now();
      const probe = {
        ownerId: null,
        installed: false,
        enabled: false,
        hasWidget: false,
        mounted,
        ownerMissingMs: ownerMissingMs(),
      };
      if (decideOverlayAction(probe) === "close") {
        await closeSelf(closeReason(probe));
      } else {
        scheduleRetry();
      }
      return;
    }
    pluginId = owner;
    ownerMissingSince = null;
  }

  const id = pluginId;
  // 多扇悬浮窗在 CDP / 任务管理器里要分得清是谁的：document.title 就是 CDP 看到的标题
  document.title = `DesktopPet Overlay · ${id}`;

  let manifests: PluginManifest[];
  let enabledIds: string[];
  try {
    manifests = await hostCall<PluginManifest[]>("plugins_list");
    // 启停清单向宿主取（C1）：本窗是新开的，缓存还没落地
    enabledIds = await loadEnabled();
  } catch (error) {
    console.error(`[overlay] 拉取插件清单失败：${id}`, error);
    scheduleRetry();
    return;
  }

  const mine = manifests.find((m) => m.id === id);
  const probe = {
    ownerId: id,
    installed: Boolean(mine),
    enabled: enabledIds.includes(id),
    hasWidget: Boolean(mine?.widget),
    mounted: mounted || widgetHost.has(id, "overlay"),
  };
  const action = decideOverlayAction(probe);
  if (action === "close") {
    await closeSelf(closeReason(probe));
    return;
  }
  if (action === "wait" || !mine) return;

  mounted = true;
  await widgetHost.mount(mine, "overlay").catch((error) => {
    mounted = false;
    console.error(`[overlay] mount widget: ${mine.id}`, error);
  });
}

async function main(): Promise<void> {
  try {
    await bus.init();
    await sync();

    // 启停与目录增删都收敛到一次同步（清单的事实来源在宿主，sync 每次都去取）。
    // 这扇窗只承载 overlay_owner 认领的那一个插件：它的文件被覆盖 → dev 下整页重载
    await listen("host:enabled-changed", () => void sync().catch(console.error));
    await listen("host:plugin-toggled", () => void sync().catch(console.error));
    await listen<{ ids?: string[]; reloadIds?: string[] }>("host:plugins-changed", (event) => {
      applyHotReload(reloadIdsFrom(event.payload), (changed) => changed === pluginId);
      void sync().catch(console.error);
    });
  } catch (error) {
    // 启动失败（event-bus / IPC）也不能把一扇半透明置顶窗留在屏幕上
    console.error("[overlay] 启动失败", error);
    await closeSelf("启动失败");
  }
}

void main();
