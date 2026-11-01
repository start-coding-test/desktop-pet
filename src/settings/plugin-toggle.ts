import { emit } from "@tauri-apps/api/event";
import { hostErrorMessage } from "../runtime/host-error";
import { getEnabled, setEnabledIds } from "../runtime/plugin-runtime";
import { $ } from "./dom";
import { applyFilter, renderNav } from "./nav";
import { renderPluginPage } from "./plugin-page";
import { manifests, selected } from "./state";
import { showNotice } from "./notice";

// 模块顶层就挂上（本文件是入口的装配依赖，只 import 不调用也要生效）
toggleListener();

export function toggleListener(): void {
  const toggle = $<HTMLInputElement>("plugin-toggle");
  toggle?.addEventListener("change", async () => {
    const manifest = manifests.find((m) => m.id === selected);
    if (!manifest) return;
    const on = toggle.checked === true;
    const ids = new Set(getEnabled());
    if (on) ids.add(manifest.id);
    else ids.delete(manifest.id);
    // 先落盘再广播：宠物窗收到 host:plugin-toggled 后会向宿主重取清单，
    // 顺序反了它取到的还是旧的那份，表现成「开关点不动」
    try {
      await setEnabledIds([...ids]);
    } catch (error) {
      // 落盘失败（宿主拒绝/IO）：把开关拨回真实状态并把原因摆出来。
      // 以前这里没有 catch —— 开关停在用户点的那一侧、侧栏点也不动，看着像功能坏了。
      toggle.checked = !on;
      showNotice(`「${manifest.name || manifest.id}」启停留存失败：${hostErrorMessage(error)}`);
      return;
    }
    const label = $<HTMLSpanElement>("plugin-toggle-label");
    if (label) label.textContent = on ? "已启用" : "已停用";
    renderNav();
    applyFilter();
    try {
      await renderPluginPage();
    } catch (error) {
      // 页面渲染失败不该把整个设置窗带崩：壳已经更新，插件页留一条可读的说明
      console.error("[settings] renderPluginPage after toggle", error);
      showNotice(`插件页渲染失败：${hostErrorMessage(error)}`);
    }
    // 通知宠物窗运行时启停（overlay/settings 窗各自监听同一事件挂载 widget）
    try {
      await emit("host:plugin-toggled", { id: manifest.id, enabled: on });
    } catch (error) {
      // 已落盘但没通知出去：说清楚，别让用户以为切换完全没发生
      showNotice(`已保存，但通知宠物窗失败：${hostErrorMessage(error)}`);
    }
  });
}
