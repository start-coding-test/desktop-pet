import { hostCall, hostErrorMessage } from "../../runtime/host-error";
import { $ } from "../dom";

/* ---------- 快捷键 ---------- */

const hotkeyStatus = () => $<HTMLElement>("hotkey-status");

type HotkeyStatus = { accelerator: string; default: string; registered: boolean };

export async function renderHotkey(): Promise<void> {
  const el2 = hotkeyStatus();
  if (!el2) return;
  try {
    const info = await hostCall<HotkeyStatus>("hotkey_status");
    el2.classList.remove("error", "error-banner");
    if (info.registered === false) {
      el2.classList.add("error", "error-banner");
      el2.textContent = `当前快捷键 ${info.accelerator} 未生效（可能被其他程序占用），请换一个`;
    } else {
      el2.replaceChildren(
        document.createTextNode("当前："),
        Object.assign(document.createElement("kbd"), { textContent: info.accelerator }),
        document.createTextNode(info.accelerator === info.default ? "（默认）" : ""),
      );
    }
    const input = $<HTMLInputElement>("hotkey-input");
    if (input && !input.value) input.value = info.accelerator;
  } catch (e) {
    el2.textContent = `读取失败：${hostErrorMessage(e)}`;
  }
}

async function saveHotkey(accelerator: string): Promise<void> {
  const el2 = hotkeyStatus();
  try {
    const saved = await hostCall<string>("hotkey_set", { accelerator });
    const input = $<HTMLInputElement>("hotkey-input");
    if (input) input.value = saved;
    await renderHotkey();
    el2?.classList.remove("error", "error-banner");
  } catch (e) {
    if (el2) el2.textContent = `应用失败：${hostErrorMessage(e)}`;
  }
}

export function wireHotkey(): void {
  $<HTMLElement>("hotkey-save")?.addEventListener("click", () => {
    const value = ($<HTMLInputElement>("hotkey-input")?.value ?? "").trim();
    if (!value) {
      const el2 = hotkeyStatus();
      if (el2) el2.textContent = "先输入一个组合键，例如 Ctrl+Alt+P。";
      return;
    }
    void saveHotkey(value);
  });
  $<HTMLElement>("hotkey-reset")?.addEventListener("click", async () => {
    try {
      const info = await hostCall<HotkeyStatus>("hotkey_status");
      await saveHotkey(info.default);
    } catch (e) {
      const el2 = hotkeyStatus();
      if (el2) el2.textContent = `恢复默认失败：${hostErrorMessage(e)}`;
    }
  });
  $<HTMLElement>("hotkey-test")?.addEventListener("click", async () => {
    const el2 = hotkeyStatus();
    const value = ($<HTMLInputElement>("hotkey-input")?.value ?? "").trim();
    if (!value || !el2) return;
    try {
      const free = await hostCall<boolean>("hotkey_test", { accelerator: value });
      el2.textContent = free
        ? `「${value}」可以注册，没被别的应用占用。`
        : `「${value}」注册失败，多半已被其他程序占用，换一个吧。`;
    } catch (e) {
      el2.textContent = `测试失败：${hostErrorMessage(e)}`;
    }
  });
}
