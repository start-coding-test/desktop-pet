// Widget 宿主：每个插件的 widget 运行在独立 Shadow DOM 中，样式与 DOM 互相隔离。
// 插件不得直接操作宿主 DOM/画布，只能拿到自己 Shadow Root 的挂载入口；
// widget 能力（事件总线）由宿主经 ctx 注入为受限视图。
// widget 与插件其余文件一样经 petplugin 协议按目录提供，因此可以用相对 import
// 拆分子模块（示例插件把 topic 常量抽进 topics.js 就是这个用法）。
import { listen } from "@tauri-apps/api/event";
import { bus } from "./event-bus";
import { pluginFileUrl, pluginFileVersion } from "./plugin-url";
import { createScopedBus } from "./topic-acl";
import { WIDGET_HOST_REALM_FLAG, legacyWidgetReason, widgetUsesWorker } from "./widget-protocol";
import { BADGE_ROTATE_INTERVAL_MS, type BadgeArbiter, createBadgeArbiter } from "./badge-arbiter";
// 与 plugin-runtime 是一对循环 import：两边都只在函数体里用对方（它是 widgetHost，这边是 getEnabled），
// 函数声明在模块求值前就已初始化，所以两个窗口的入口先引哪一个都不会炸
import { getEnabled } from "./plugin-runtime";
import type { WidgetContext, WidgetRegion } from "../../packages/sdk";

export interface WidgetManifest {
  id: string;
  name?: string;
  widget?: string;
  permissions?: string[];
  /** 声明到 WIDGET_CONTRACT_API_VERSION 才算照渲染契约写的 widget；缺省按 1 */
  apiVersion?: number;
}

export interface WidgetExports {
  mount: (
    root: ShadowRoot,
    ctx: WidgetContext,
  ) => void | Promise<void>;
  unmount?: (root: ShadowRoot) => void | Promise<void>;
}

interface MountRecord {
  host: HTMLDivElement;
  mod: WidgetExports;
  shadow: ShadowRoot;
}

class WidgetHost {
  private mounted = new Map<string, MountRecord[]>(); // pluginId → 该窗口内已挂载插槽
  private mounting = new Map<string, Promise<void>>(); // `${id}#${region}` → 在途挂载
  /** 每次 unmount 递增：在途的挂载完成后据此判断「我该不该真的留下来」 */
  private epoch = new Map<string, number>();
  /** 徽标可见性仲裁（ADR-0010）：懒建，只有真出现 badge 插槽的窗口才开计时器与订阅 */
  private badgeArbiter: BadgeArbiter | null = null;
  /** badge 插槽外壳的尺寸观测：外壳在 light DOM，closed shadow 不影响量它 */
  private badgeObservers = new Map<HTMLDivElement, ResizeObserver>();

  private epochOf(pluginId: string): number {
    return this.epoch.get(pluginId) ?? 0;
  }

  /* ---------- 徽标区可见性仲裁（ADR-0010 决策 1） ---------- */

  private ensureBadgeArbiter(): BadgeArbiter {
    if (this.badgeArbiter) return this.badgeArbiter;
    const arbiter = createBadgeArbiter({ enabled: () => getEnabled() });
    arbiter.onChange((visibleId) => this.applyBadgeVisibility(visibleId));
    // 全屏（游戏模式）期间暂停轮播：本卡加的第二位消费者，写法照 src/pet/game-mode.ts 的订阅
    listen<{ active: boolean }>("host:fullscreen", (e) => {
      arbiter.setSuppressed(e.payload?.active === true);
    }).catch((err) => {
      console.error("[widget] 订阅 host:fullscreen 失败", err);
    });
    // 宿主侧唯一的轮播计时器落点；间隔是 badge-arbiter 里的具名常量，纯模块自己不持计时器
    setInterval(() => arbiter.tick(), BADGE_ROTATE_INTERVAL_MS);
    this.badgeArbiter = arbiter;
    return arbiter;
  }

  /**
   * badge 插槽建出来的那一刻登记，并把「有没有内容」的观测钉在**外壳**上：
   * 插槽是 closed shadow root，外面读不到里面的字，但壳是 light DOM 的 div ——
   * 布局尺寸是宿主在外面唯一观测得到的信号（ADR 落地口径第 1 条）。
   */
  private watchBadgeSlot(pluginId: string, host: HTMLDivElement): void {
    const arbiter = this.ensureBadgeArbiter();
    arbiter.register(pluginId);
    const observer = new ResizeObserver(() => {
      const { width, height } = host.getBoundingClientRect();
      // 反应必须出交付回调：applyBadgeVisibility 翻转的正是**被观察的那个外壳**的 position，
      // 而翻转本身会改它的尺寸（absolute 被塌缩容器夹紧 ↔ 流内展开）。在交付回调里改「本次
      // 已交付的元素」，Chromium 记一条 "ResizeObserver loop completed with undelivered
      // notifications" 并把它当 window error 派发；boot-error 的兜底条不筛消息，于是宠物窗
      // 顶部就出一条红条（现场：徽标首次拿到内容那一拍）。
      // 量尺寸留在回调里 —— 观察者说「它变了」的那一刻只该读；写挪到下一帧前，交付循环里没人改 DOM。
      requestAnimationFrame(() => {
        if (this.badgeObservers.get(host) !== observer) return; // 槽已摘：别拿旧尺寸写账
        arbiter.setHasSize(pluginId, width > 0 && height > 0);
        // 有内容却没人可见就立刻抛一个出来，别干等下一个 5 秒拍子（空候选时 tick 是空操作）
        if (arbiter.visible() === null) arbiter.tick();
      });
    });
    observer.observe(host);
    this.badgeObservers.set(host, observer);
  }

  /** 摘下 badge 插槽：断开尺寸观测并注销登记，漏了会让仲裁器留着死名字继续轮 */
  private dropBadgeSlot(pluginId: string, host: HTMLDivElement): void {
    const observer = this.badgeObservers.get(host);
    if (!observer) return;
    observer.disconnect();
    this.badgeObservers.delete(host);
    this.badgeArbiter?.unregister(pluginId);
  }

  /**
   * 按仲裁结果落可见性：非当前可见者 `visibility:hidden` + `position:absolute` 脱流藏起，
   * 当前可见者解除；`visible()` 为 null 时整个 `#widget-badge` 容器隐藏。
   * **不许改用 display 藏法**：那样 ResizeObserver 恒量到 0，判据当场失效（ADR 写死）。
   */
  private applyBadgeVisibility(visibleId: string | null): void {
    const container = document.getElementById("widget-badge");
    if (!container) return;
    for (const slot of container.querySelectorAll<HTMLElement>("div[data-plugin-id]")) {
      const show = visibleId !== null && slot.dataset.pluginId === visibleId;
      slot.style.visibility = show ? "" : "hidden";
      slot.style.position = show ? "" : "absolute";
    }
    container.style.visibility = visibleId === null ? "hidden" : "";
  }

  /** 把插件 widget 挂载到指定区域；容器缺省按 id 约定 widget-<region> 查找 */
  async mount(
    manifest: WidgetManifest,
    region: WidgetRegion,
    container?: HTMLElement,
  ): Promise<void> {
    const key = `${manifest.id}#${region}`;
    if (!manifest.widget || this.has(manifest.id, region) || this.mounting.has(key)) return;
    const root = container ?? document.getElementById(`widget-${region}`);
    if (!root) return;

    const startedAt = this.epochOf(manifest.id);
    const run = this.doMount(manifest, manifest.widget, region, root, startedAt);
    this.mounting.set(key, run);
    try {
      await run;
    } finally {
      this.mounting.delete(key);
    }
  }

  /**
   * 建这一区那个 closed shadow 插槽。两条路共用，差一行都会让「谁挂在哪儿」不一致。
   * `widget-realm` 戳在壳上而不是 shadow 里面：closed root 外部读不到，套件就没别的办法
   * 区分这个插槽是宿主 realm 挂的还是 Worker 挂的 —— 迁移期每条卡都要靠它取证。
   */
  private createSlot(
    pluginId: string,
    region: WidgetRegion,
    root: HTMLElement,
    realm: "host" | "worker" | "blocked",
  ): { host: HTMLDivElement; shadow: ShadowRoot } {
    const host = document.createElement("div");
    host.dataset.pluginId = pluginId;
    host.dataset.region = region;
    host.dataset.widgetRealm = realm;
    const shadow = host.attachShadow({ mode: "closed" });
    root.appendChild(host);
    if (region === "badge") this.watchBadgeSlot(pluginId, host);
    return { host, shadow };
  }

  /**
   * 阶段二的接缝：默认进 Worker，点了名的例外才留宿主 realm。
   * 分流放在加载 widget **之前** —— 先 import 再分家，等于把插件代码又在宿主 realm 执行一遍，
   * 那正是这次搬迁要消掉的东西。名单判断用 widget-protocol 里那份（它不带 `?worker`），
   * 实现只在分流之后动态 import：顶层 import 会把 `?worker` 带进 node 离线单测的解析路径，
   * 阶段一就是这么翻的第一次。
   */
  private async doMountInWorker(
    manifest: WidgetManifest,
    url: string,
    region: WidgetRegion,
    root: HTMLElement,
    startedAt: number,
  ): Promise<void> {
    const { workerWidgetHost } = await import("./worker-widget-host");
    if (this.epochOf(manifest.id) !== startedAt) return;
    const { host, shadow } = this.createSlot(manifest.id, region, root, "worker");
    try {
      await workerWidgetHost.mount({ manifest, region, url, host, shadow });
    } catch (err) {
      this.dropBadgeSlot(manifest.id, host);
      host.remove(); // 半途失败的容器不能留下删不掉的孤儿节点
      throw err;
    }
    if (this.epochOf(manifest.id) !== startedAt) {
      await workerWidgetHost.deactivate(manifest.id, region);
      this.dropBadgeSlot(manifest.id, host);
      host.remove();
      return;
    }
    // 壳：让 epoch / unmount 那套逻辑对两条路同构，Worker 路线的收尾转发给 workerWidgetHost
    const mod: WidgetExports = {
      mount: () => undefined,
      unmount: () => workerWidgetHost.deactivate(manifest.id, region),
    };
    const list = this.mounted.get(manifest.id) ?? [];
    list.push({ host, mod, shadow });
    this.mounted.set(manifest.id, list);
  }

  /**
   * 宿主自己画的说明卡，替代一块白：插件代码一行都不执行。照常登记进 mounted，
   * 这样停用 / 热重载走的还是同一条 unmount 路，不会留下删不掉的节点。
   * 壳上戳 `data-widget-realm="blocked"`，运行时套件据此区分「被拦」与「挂上了」。
   */
  private mountNotice(
    pluginId: string,
    region: WidgetRegion,
    root: HTMLElement,
    reason: string,
    startedAt: number,
  ): void {
    if (this.epochOf(pluginId) !== startedAt) return;
    console.warn(`[widget] ${reason}`);
    const { host, shadow } = this.createSlot(pluginId, region, root, "blocked");
    const note = document.createElement("div");
    note.setAttribute("role", "note");
    note.title = reason;
    // badge 区只有宠物旁一行小字的地方，放全文会把窗口撑乱；全文在 title 与日志里
    note.textContent = region === "badge" ? "⚠ widget 需迁移" : reason;
    note.style.cssText =
      "font:12px/1.5 system-ui,sans-serif;color:#7a4b00;background:#fff7e0;" +
      "border:1px solid #f0c36d;border-radius:6px;padding:6px 8px;max-width:360px;white-space:normal;";
    shadow.appendChild(note);
    const mod: WidgetExports = { mount: () => undefined };
    const list = this.mounted.get(pluginId) ?? [];
    list.push({ host, mod, shadow });
    this.mounted.set(pluginId, list);
  }

  private async doMount(
    manifest: WidgetManifest,
    widgetPath: string,
    region: WidgetRegion,
    root: HTMLElement,
    startedAt: number,
  ): Promise<void> {
    const pinnedRaw = globalThis.localStorage?.getItem(WIDGET_HOST_REALM_FLAG);
    // 旧接口 widget 在加载之前就拦下：进了 Worker 只会 boot-failed、插槽被收掉，用户看到的是一块白
    const legacy = legacyWidgetReason(manifest, pinnedRaw, region);
    if (legacy) {
      this.mountNotice(manifest.id, region, root, legacy, startedAt);
      return;
    }
    const bust = await pluginFileVersion(manifest.id, widgetPath);
    const url = pluginFileUrl(manifest.id, widgetPath, bust);
    // settings 区一律 Worker（S3），例外名单只对 badge / overlay 生效
    if (widgetUsesWorker(manifest.id, pinnedRaw, region)) {
      return this.doMountInWorker(manifest, url, region, root, startedAt);
    }
    let host: HTMLDivElement | undefined;
    try {
      const mod = (await import(/* @vite-ignore */ url)) as WidgetExports;
      if (typeof mod.mount !== "function") {
        throw new Error(`widget.js 缺少 mount() 导出: ${url}`);
      }
      // 等 import 期间可能已经有人 unmount 过这个插件（设置窗重开、插件被停用）：
      // 那时 mounted 里还没有记录，unmount 管不到这次挂载，不复查就会留下挂在 DOM 上的孤儿
      if (this.epochOf(manifest.id) !== startedAt) return;

      const slot = this.createSlot(manifest.id, region, root, "host");
      host = slot.host;
      const { shadow } = slot;

      const ctx: Parameters<WidgetExports["mount"]>[1] = {
        pluginId: manifest.id,
        region,
        bus: createScopedBus(manifest.id, manifest.permissions ?? [], bus),
      };
      // 这里**没有** settings 分支：settings 区在上面就分流进 Worker 了（S3）。
      // 受控宿主通道（ctx.host.agentHooks）由 widget-worker.ts 在 Worker 侧按 region 构造。
      await mod.mount(shadow, ctx);

      if (this.epochOf(manifest.id) !== startedAt) {
        this.dropBadgeSlot(manifest.id, host);
        host.remove();
        return;
      }
      const list = this.mounted.get(manifest.id) ?? [];
      list.push({ host, mod, shadow });
      this.mounted.set(manifest.id, list);
      host = undefined; // 挂载成功，交由 mounted 管理
    } catch (err) {
      if (host) this.dropBadgeSlot(manifest.id, host);
      host?.remove(); // 半途失败的容器不能留下删不掉的孤儿节点
      throw err;
    }
  }

  has(pluginId: string, region?: WidgetRegion): boolean {
    const list = this.mounted.get(pluginId);
    if (!list) return false;
    if (!region) return list.length > 0;
    return list.some((m) => m.host.dataset.region === region);
  }

  async unmount(pluginId: string): Promise<void> {
    // 先作废这一轮的在途挂载，再等它们落地：顺序反了的话等的是一个「已经不算数」的 Promise
    this.epoch.set(pluginId, this.epochOf(pluginId) + 1);
    const inflight = [...this.mounting.entries()]
      .filter(([key]) => key.startsWith(`${pluginId}#`))
      .map(([, run]) => run.catch(() => undefined));
    if (inflight.length) await Promise.all(inflight);

    const list = this.mounted.get(pluginId);
    if (!list) return;
    this.mounted.delete(pluginId);
    for (const record of list) {
      try {
        await record.mod.unmount?.(record.shadow);
      } catch (err) {
        console.error(`[widget] unmount error: ${pluginId}`, err);
      }
      this.dropBadgeSlot(pluginId, record.host);
      record.host.remove();
    }
  }

  /** 在途挂载的插槽数（只读诊断，供回归断言竞态窗口） */
  get inflightCount(): number {
    return this.mounting.size;
  }
}

export const widgetHost = new WidgetHost();
