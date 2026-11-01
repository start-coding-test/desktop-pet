import { listen } from "@tauri-apps/api/event";
import { bus } from "../runtime/event-bus";
import { hostCall, hostErrorMessage } from "../runtime/host-error";
import { applyHotReload, reloadIdsFrom } from "../runtime/hot-reload";
import {
  loadEnabled,
  validateManifest,
  watchEnabled,
  type PluginManifest,
} from "../runtime/plugin-runtime";
import { widgetHost } from "../runtime/widget-host";
import { $, el } from "./dom";
import { applyFilter, renderNav } from "./nav";
import { detachWidget, renderPluginPage } from "./plugin-page";
import { toggleListener } from "./plugin-toggle";
import { showNotice } from "./notice";
import { renderAutostart, wireStartup } from "./sections/autostart";
import { renderGameMode, wireGameMode } from "./sections/game-mode";
import { renderHotkey, wireHotkey } from "./sections/hotkey";
import { renderSkins, wireSkins } from "./sections/skins";
import {
  PET_VIEW,
  manifests,
  mountedFor,
  selected,
  setManifests,
  setMountedFor,
  setNavigate,
  setSelected,
} from "./state";
import "./style.css";

let banner: HTMLElement | null = null;

/* ---------- 视图切换 ---------- */

function titles(): { title: string; hint: string } {
  if (selected === PET_VIEW) {
    return {
      title: "宠物设置",
      hint: "宠物本体与宿主页面的配置；插件的功能与页面在左边插件区",
    };
  }
  const m = manifests.find((x) => x.id === selected);
  return {
    title: m && !validateManifest(m) ? m.name : "插件",
    hint: "启停即时生效；未授权能力首次调用时会弹出确认框",
  };
}

async function select(view: string): Promise<void> {
  setSelected(view);
  for (const item of document.querySelectorAll(".nav-item")) {
    item.classList.toggle("active", (item as HTMLElement).dataset.view === view);
  }
  for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== (view === PET_VIEW ? "pet" : "plugin");
  }
  const t = titles();
  const title = $<HTMLHeadingElement>("view-title");
  const hint = $<HTMLParagraphElement>("view-hint");
  if (title) title.textContent = t.title;
  if (hint) hint.textContent = t.hint;

  if (view === PET_VIEW) {
    await detachWidget();
    return;
  }
  await renderPluginPage();
}

async function render(): Promise<void> {
  const list = await hostCall<PluginManifest[]>("plugins_list");
  // 目录可能已经变了：先按新的清单重建侧栏，再决定当前页怎么渲染
  setManifests([...list].sort((a, b) => a.id.localeCompare(b.id)));
  const alive = new Set(manifests.map((m) => m.id));
  if (selected !== PET_VIEW && !alive.has(selected)) {
    // 正在看的插件被移走了，回到宠物设置，别留一张空壳
    setMountedFor(null);
    await widgetHost.unmount(selected).catch(() => undefined);
    setSelected(PET_VIEW);
  }
  renderNav();
  await select(selected);
}

function wireNav(): void {
  const pet = document.querySelector<HTMLElement>('.nav-item[data-view="pet"]');
  pet?.addEventListener("click", () => void select(PET_VIEW));
  $<HTMLInputElement>("search")?.addEventListener("input", applyFilter);
}

/* ---------- 启动 ---------- */

async function main(): Promise<void> {
  // 启停清单的事实来源在宿主：先挂上变更监听，再取本窗那份缓存 ——
  // 侧栏那个点与「插件页挂不挂 widget」都读它，别窗写过也要跟得上
  await watchEnabled();
  await loadEnabled();
  await bus.init();
  wireNav();
  toggleListener();
  await render();
  wireGameMode();
  void renderGameMode();
  wireSkins();
  void renderSkins();
  wireHotkey();
  void renderHotkey();
  wireStartup();
  void renderAutostart();

  // 宠物窗运行时上报的插件异常 → 顶部红条
  banner = el("div", "", "error-banner");
  banner.style.display = "none";
  $<HTMLElement>("content")?.prepend(banner);
  await listen<{ plugin: string; error: string }>("host:plugin-error", (e) => {
    if (!banner) return;
    banner.textContent = `插件异常已隔离 — ${e.payload.plugin}: ${e.payload.error}`;
    banner.style.display = "";
  });

  // 插件目录变动 → 侧栏立刻跟着增删；正在看的插件页被覆盖 → dev 下整页重载
  // （承载判定 = 该 id 正是当前挂载着的插件页，换别的插件页就与它无关）
  await listen<{ ids?: string[]; reloadIds?: string[] }>("host:plugins-changed", (e) => {
    applyHotReload(reloadIdsFrom(e.payload), (id) => id === mountedFor);
    void render().catch((e) => console.error("[settings] render", e));
  });

  // 首启自动装默认形象、或宠物窗那边换了形象 → 刷新形象列表
  await listen("pet:skin-changed", () => void renderSkins());

  // 其他窗口触发的启停：同步侧栏那个点与当前插件页
  await listen<{ id: string; enabled: boolean }>("host:plugin-toggled", (e) => {
    renderNav();
    applyFilter();
    if (e.payload.id === selected) void renderPluginPage();
    if (!e.payload.enabled && mountedFor === e.payload.id) void detachWidget();
  });
}

// 侧栏点击 → select 的回调经 state 注入（本文件是入口装配层，不对外导出任何名字）
setNavigate(select);
// 末尾不吞初始化失败：以前这里是 `void main()`，任何一次 IPC 失败都变成一条
// unhandledrejection —— 没有提示、窗口停在半装配状态，用户只看到空白侧栏（G4）
void main().catch((error) => {
  console.error("[settings] 初始化失败", error);
  showNotice(`设置窗初始化失败：${hostErrorMessage(error)}`);
});
