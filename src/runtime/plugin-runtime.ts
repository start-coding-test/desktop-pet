// 插件运行时：manifest 扫描校验 → 动态 import → activate/deactivate 生命周期。
// 单插件异常被隔离，不影响宿主；启停清单存在宿主磁盘上（见 services/enabled.rs）。
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import manifestSchema from "../../packages/sdk/manifest.schema.json" with { type: "json" };
// 宿主版本的事实来源：打包/开发都取 tauri.conf.json 的 version（与 Rust 侧
// env!("CARGO_PKG_VERSION") 同值，由 unit-manifest-schema.mjs 对撞防漂）
import hostConfig from "../../src-tauri/tauri.conf.json" with { type: "json" };
import { bus } from "./event-bus";
import { buildContext, invalidatePermissions } from "./bridge";
import { applyHotReload, reloadIdsFrom } from "./hot-reload";
import { CAPABILITIES } from "./plugin-capabilities";
import { hostCall } from "./host-error";
import { pluginFileUrl, pluginFileVersion } from "./plugin-url";
import { shouldUseWorkerHost, REALM_HOST_FLAG } from "./plugin-worker-protocol";
import { widgetHost } from "./widget-host";
import { releaseAll } from "./resources";
import { disposeAll } from "./subscriptions";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  widget?: string;
  permissions?: string[];
  description?: string;
  /** 插件用的 manifest 接口版本；缺省视为 1（schema 的 default） */
  apiVersion?: number;
  /** 最低宿主版本；缺省即不设限 */
  minHostVersion?: string;
}

/**
 * 启停清单：事实来源在宿主（`services/enabled.rs`，原子写的一份 JSON 文件）。
 *
 * 原先它存在 WebView 的 localStorage 里 —— 清一次 WebView 缓存，用户给的启停就全没了，
 * 而这份清单决定「哪些插件会被激活」，属于跨会话状态（C1）。
 * 每个窗口各自持一份只读缓存：`loadEnabled()` 在开窗时取一次，取值仍是同步的
 * （reconcile 与 activate 的判定点都在热路径上，不该为它多等一次 IPC）。
 */
const LEGACY_ENABLED_KEY = "host:enabled-plugins";
let enabledCache: string[] = [];

/** 宿主还没写过（新安装，或老用户尚未迁移）时读到的那一份旧清单 */
function readLegacyEnabled(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_ENABLED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function getEnabled(): string[] {
  return enabledCache;
}

/**
 * 取宿主那份清单；还没有就先做一次迁移再落定。
 * 迁移命令只在「文件不存在」时写入，其余情况原样回读，所以多个窗口同时开也不会互相覆盖。
 * 以宿主回读的那份为准（非法 id 与重复项在宿主侧被滤掉），不自己猜过滤结果。
 */
export async function loadEnabled(): Promise<string[]> {
  const stored = await hostCall<string[] | null>("plugin_enabled_list");
  if (stored) {
    enabledCache = stored;
    return enabledCache;
  }
  const legacy = readLegacyEnabled();
  try {
    enabledCache = await hostCall<string[]>("plugin_enabled_migrate", { ids: legacy });
  } catch {
    // 老宿主没这条命令、或本窗不是宠物窗：至少按旧键那份继续跑，别把用户挡在门外
    enabledCache = legacy;
  }
  return enabledCache;
}

/** 写启停清单（只认设置窗，宿主会拒），并同步本窗缓存 —— 调用方需要 await 它 */
export async function setEnabledIds(ids: string[]): Promise<void> {
  const stored = await hostCall<string[]>("plugin_enabled_set", { ids });
  enabledCache = stored;
}

/**
 * 每个窗口启动时挂一次：清单被任何窗口（包括直接打宿主命令的回归脚本）改过时，
 * 本窗那份缓存要跟着刷新。少了这一步，设置页会拿着旧名单判定「这个插件没启用」，
 * 于是插件页不挂 widget —— 表现成「明明开了开关，页面却是空的」。
 */
export async function watchEnabled(): Promise<void> {
  await listen<string[]>("host:enabled-changed", (e) => {
    if (Array.isArray(e.payload)) enabledCache = e.payload;
  });
}

/**
 * manifest 的字段约束全部取自 packages/sdk/manifest.schema.json（K4）：
 * schema 是唯一数据源，这里只做消费，Rust 侧 `plugins.rs::validate_manifest_fields`
 * 读的是同一份磁盘文件（include_str! 编译期内嵌）。
 * 两侧与 schema 的一致性由 `tests/unit/unit-manifest-schema.mjs` 逐条对撞（改任一边即红）。
 */
const ID_RULE = manifestSchema.properties.id;
const ID_RE = new RegExp(ID_RULE.pattern);
const NAME_RULE = manifestSchema.properties.name;
const VERSION_RULE = manifestSchema.properties.version;
const ENTRY_RE = new RegExp(manifestSchema.properties.entry.pattern);
const WIDGET_RE = new RegExp(manifestSchema.properties.widget.pattern);
const API_RULE = manifestSchema.properties.apiVersion;
const MIN_HOST_RE = new RegExp(manifestSchema.properties.minHostVersion.pattern);
/** 宿主版本（与 Rust 侧 env!("CARGO_PKG_VERSION") 同值，见 package 单测对撞） */
const HOST_VERSION: string = hostConfig.version;

/** 数值逐段比较（缺失段按 0 补齐） */
function compareVersions(a: string, b: string): number {
  const segments = a.split(".");
  const other = b.split(".");
  for (let i = 0; i < Math.max(segments.length, other.length); i += 1) {
    const diff = Number(segments[i] ?? 0) - Number(other[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function validateManifest(m: PluginManifest): string | null {
  if (!m || typeof m !== "object") return "manifest 不是对象";
  const raw = m as unknown as Record<string, unknown>;
  for (const key of manifestSchema.required) {
    if (raw[key] == null) return `缺少 ${key}`;
  }
  if (
    typeof m.id !== "string" ||
    m.id.length < ID_RULE.minLength ||
    m.id.length > ID_RULE.maxLength ||
    !ID_RE.test(m.id)
  ) {
    return `非法插件 id: ${m.id}`;
  }
  if (typeof m.name !== "string" || m.name.length < NAME_RULE.minLength) return "缺少 name";
  if (typeof m.version !== "string" || m.version.length < VERSION_RULE.minLength) {
    return "缺少 version";
  }
  if (typeof m.entry !== "string" || !ENTRY_RE.test(m.entry)) return `非法 entry: ${m.entry}`;
  if (m.widget != null && (typeof m.widget !== "string" || !WIDGET_RE.test(m.widget))) {
    return `非法 widget: ${m.widget}`;
  }
  if (m.permissions != null) {
    if (!Array.isArray(m.permissions)) return "permissions 必须是数组";
    for (const capability of m.permissions) {
      if (typeof capability !== "string") {
        return `permissions 元素必须是字符串: ${JSON.stringify(capability)}`;
      }
      if (!CAPABILITIES.includes(capability)) return `未知能力名: ${capability}`;
    }
  }
  const apiVersion = m.apiVersion ?? API_RULE.default;
  if (!Number.isInteger(apiVersion)) {
    return `非法 apiVersion: ${String(m.apiVersion)}（应为整数）`;
  }
  if (!API_RULE.supported.includes(apiVersion)) {
    return `不支持的 apiVersion: ${apiVersion}（本宿主支持 ${API_RULE.supported.join("、")}）`;
  }
  if (m.minHostVersion != null) {
    if (typeof m.minHostVersion !== "string" || !MIN_HOST_RE.test(m.minHostVersion)) {
      return `非法 minHostVersion: ${String(m.minHostVersion)}`;
    }
    if (compareVersions(m.minHostVersion, HOST_VERSION) > 0) {
      return `插件要求宿主版本 ≥ ${m.minHostVersion}，当前宿主 ${HOST_VERSION}`;
    }
  }
  return null;
}

interface ActiveInstance {
  manifest: PluginManifest;
  module: { activate?: (ctx: unknown) => Promise<void> | void; deactivate?: () => Promise<void> | void };
}

const active = new Map<string, ActiveInstance>();

/** 这一轮被搬进 Worker 的插件 id。停用时按它决定「收 Worker」还是「调同 realm 的 deactivate」，
 * 也用来跳过整页重载（Worker 的模块映射表不在文档里，换文档也换不掉它）。 */
const workerHosted = new Set<string>();

/**
 * 每个插件一条串行执行链。
 *
 * activate 里有两处会长时间等待：用户点同意框、动态 import。此前它们不设防，
 * 于是「等同意框期间把开关关掉」会走完 activate 却没人 deactivate 它（当时它还不算 active），
 * 两个事件源（开关 + 目录变动）并发也可能把 activate 跑两遍。排队到同一条链上，
 * 启停就是可预期的先后顺序，而不是交错的竞态。
 */
const chains = new Map<string, Promise<void>>();

function enqueue<T>(pluginId: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(pluginId) ?? Promise.resolve();
  const run = prev.then(task, task);
  // 链尾吞掉结果：上一次的失败不该让下一次的启停直接 reject
  chains.set(
    pluginId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function reportError(plugin: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[runtime] ${plugin}:`, error);
  void emit("host:plugin-error", { plugin, error: message });
}

/** 拒绝/停用的文案分开：停用不是用户拒绝，不能提示“去设置页重新授权”。 */
export function consentFailureMessage(stillEnabled: boolean): string {
  return stillEnabled
    ? "本次已拒绝，关闭插件再开启后可再次申请"
    : "插件已停用，授权请求已取消";
}

export function isActive(pluginId: string): boolean {
  return active.has(pluginId);
}

export function activatePlugin(manifest: PluginManifest): Promise<void> {
  return enqueue(manifest.id, () => doActivate(manifest));
}

export function deactivatePlugin(pluginId: string): Promise<void> {
  return enqueue(pluginId, () => doDeactivate(pluginId));
}

/**
 * Worker 宿主模块按需取，不写在顶层 import 里：它 import 的 `./plugin-worker.ts?worker`
 * 只有 Vite 认得，node 离线单测（要 import 本文件）会在解析时当场 SyntaxError。
 */
async function workerHost(): Promise<(typeof import("./worker-plugin-host"))["workerPluginHost"]> {
  return (await import("./worker-plugin-host")).workerPluginHost;
}

/**
 * 留在宿主 realm 的例外名单（缺省为空 = 全部走 Worker）：见 `REALM_HOST_FLAG` 那段理由。
 * 读失败（无痕模式、键被写成别的类型）一律按「没有例外」处理 —— 默认路径已经是 Worker，
 * 不该因为一次 storage 读取失败把插件退回同 realm。
 */
function realmHostOptOut(): string | null {
  try {
    return localStorage.getItem(REALM_HOST_FLAG);
  } catch {
    return null;
  }
}

async function doActivate(manifest: PluginManifest): Promise<void> {
  const invalid = validateManifest(manifest);
  if (invalid) {
    reportError(manifest.id ?? "?", invalid);
    return;
  }
  if (active.has(manifest.id)) return;
  try {
    // 首次激活：就 manifest 声明的权限一次性弹同意框（之后逐项校验静默放行）
    const missing: string[] = [];
    for (const capability of manifest.permissions ?? []) {
      const granted = await invoke<boolean>("permission_check", {
        pluginId: manifest.id,
        capability,
      });
      if (!granted) missing.push(capability);
    }
    if (missing.length > 0) {
      const ok = await hostCall<boolean>("permission_request", {
        pluginId: manifest.id,
        capabilities: missing,
      });
      if (!ok) {
        // 停用取消与用户拒绝都返回 false；向宿主重取启停清单区分文案，不改变激活顺序。
        const stillEnabled = await loadEnabled()
          .then((ids) => ids.includes(manifest.id))
          .catch(() => true);
        reportError(manifest.id, consentFailureMessage(stillEnabled));
        return;
      }
    }
    // 弹框期间开关可能已经被关掉：那就别把一个「已被停用」的插件装起来。
    // 这里必须向宿主重取，而不是读本窗那份缓存 —— 缓存只保证「最终会被广播追平」，
    // 而直接调用 activatePlugin 的路子（回归脚本、watcher 之外的任何一处）可能刚由
    // 别的窗口写过清单，读旧缓存会把一个确实启用的插件判成停用。
    if (!(await loadEnabled()).includes(manifest.id)) return;

    if (shouldUseWorkerHost(manifest.id, realmHostOptOut())) {
      // 默认路径：插件代码进 Worker，身份由宿主在 boot 消息里钉死（ADR-0006 / L2 阶段一）
      await (await workerHost()).activate(manifest);
      workerHosted.add(manifest.id);
      active.set(manifest.id, { manifest, module: {} });
    } else {
      const bust = await pluginFileVersion(manifest.id, manifest.entry);
      const url = pluginFileUrl(manifest.id, manifest.entry, bust);
      const mod = (await import(/* @vite-ignore */ url)) as ActiveInstance["module"];
      await mod.activate?.(buildContext(manifest));
      active.set(manifest.id, { manifest, module: mod });
    }
    // 宠物窗负责徽标区；settings/overlay 窗自行挂载各自区域
    await widgetHost.mount(manifest, "badge");
  } catch (err) {
    reportError(manifest.id, err);
  }
}

async function doDeactivate(pluginId: string): Promise<void> {
  const instance = active.get(pluginId);
  if (!instance) return;
  active.delete(pluginId);
  if (workerHosted.delete(pluginId)) {
    // Worker 会话的 deactivate 在插件自己那个 realm 里跑，跑完由宿主 terminate 整个 Worker
    await (await workerHost()).deactivate(pluginId);
  } else {
    try {
      await instance.module.deactivate?.();
    } catch (err) {
      reportError(pluginId, err);
    }
  }
  // 插件自己漏掉的订阅由宿主兜底回收：留着闭包收事件，它捕获的界面也 GC 不掉
  disposeAll(pluginId);
  await widgetHost.unmount(pluginId);
  // 只回收该插件确实持有、且已无其他持有者的共享资源。
  // 早先这里是无条件 ble_disconnect + stop_scan，会掐断别的插件正在用的会话。
  const freed = releaseAll(pluginId);
  try {
    if (freed.ble) await hostCall("ble_disconnect", { pluginId });
    if (freed["ble-scan"]) await hostCall("ble_stop_scan", { pluginId });
    // 悬浮窗是这个插件为自己开的，它停了就整扇收掉，不涉及别的插件。
    // 走宿主的回收通道而不是插件面的 overlay_destroy：撤销授权之后能力已经没了，
    // 那条命令会被门禁挡住，窗就永远留在桌面上。
    await hostCall("overlay_reclaim", { pluginId });
  } catch (err) {
    reportError(pluginId, err);
  }
}

/** 按持久化的启用清单同步实际运行状态 */
export async function reconcile(manifests: PluginManifest[]): Promise<void> {
  // 每次都向宿主取一遍：清单的事实来源在宿主，本窗那份缓存可能已经被别的窗口写过
  const enabled = new Set(await loadEnabled());
  // 目录被移走的插件必须真正下线：它已经不在 manifests 里，下面的循环管不到它
  const installed = new Set(manifests.map((m) => m.id));
  for (const id of [...active.keys()]) {
    if (!installed.has(id)) await deactivatePlugin(id);
  }
  for (const manifest of manifests) {
    if (enabled.has(manifest.id)) {
      await activatePlugin(manifest);
    } else {
      await deactivatePlugin(manifest.id);
    }
  }
}

/** 宠物窗（主上下文）启动入口 */
export async function initRuntime(): Promise<void> {
  // 先挂监听再取清单：反过来的话中间那次变更会被丢掉
  await watchEnabled();
  // 启停清单要先取到：reconcile 与 activate 都读那份同步缓存，取空了会把用户启用的插件全当停用
  await loadEnabled();
  await bus.init();
  // 宿主 Rust 原生事件注入总线，插件经标准 topic 订阅
  await listen("ble:device-found", (e) => bus.inject("ble:device-found", e.payload));
  await listen("ble:heart-rate", (e) => bus.inject("ble:heart-rate", e.payload));
  await listen("ble:disconnected", (e) => bus.inject("ble:disconnected", e.payload));
  await listen("ble:error", (e) => bus.inject("ble:error", e.payload));
  // Agent hook 事件（Rust 侧 watcher 归一化后广播）
  await listen("agent:state", (e) => bus.inject("agent:state", e.payload));
  await listen("agent:event", (e) => bus.inject("agent:event", e.payload));
  // 设置窗切换插件开关 → 本窗运行时执行启停
  await listen<{ id: string; enabled: boolean }>("host:plugin-toggled", async (e) => {
    const { id, enabled } = e.payload;
    // 清单的事实来源在宿主：本窗那份缓存要跟着刷新，否则下一次 reconcile
    // 会拿旧名单把刚被停用的插件又激活回来
    await loadEnabled();
    const manifests = await hostCall<PluginManifest[]>("plugins_list");
    const manifest = manifests.find((m) => m.id === id);
    if (!manifest) return;
    if (enabled) {
      await activatePlugin(manifest);
    } else {
      await deactivatePlugin(id);
    }
  });
  // 撤销授权后必须丢掉桥的能力缓存，否则已经加载的插件还能继续用它刚被收回的权限
  await listen<string>("host:permission-revoked", (e) => {
    invalidatePermissions(e.payload);
  });
  // 插件目录变动（放入/移除插件）即时生效，不必重启宿主。
  // 其中「覆盖了正在跑的插件的文件」光靠 reconcile 不成立：入口的 ?v= 管不到子模块，
  // 同一 realm 的模块映射表会把旧实例还回来 —— dev 下先按载荷判定本窗要不要整页重载，
  // reconcile 逻辑保留（新装/删除插件仍靠它，重载只是它之上的一层判断）。
  await listen<{ ids?: string[]; reloadIds?: string[] }>("host:plugins-changed", async (e) => {
    // Worker 宿主的那部分不必整页换茬：它的模块映射表在 Worker 里，重载文档也换不掉它，
    // 真正取新内容的动作是「停用 → 换一个 Worker 重新 boot」（见 worker-plugin-host.ts）
    applyHotReload(reloadIdsFrom(e.payload), (id) => active.has(id) && !workerHosted.has(id));
    await reconcile(await hostCall<PluginManifest[]>("plugins_list"));
  });
  await reconcile(await hostCall<PluginManifest[]>("plugins_list"));
}
