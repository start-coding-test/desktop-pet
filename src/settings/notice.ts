// 设置窗的可见回执（G4：动作失败不能只进 console）。
//
// 以前启停保存失败、插件页渲染失败都只有一个 `console.error` —— 用户点了一下开关，
// 界面没变、也没有任何说明，看起来就是「点了没反应」。这里给设置窗一条统一的、
// 可关闭的提示条：谁失败谁调用，条子摆在内容区顶部，不盖住配置本身。
import { el } from "./dom";

export type NoticeKind = "error" | "info";

let current: HTMLElement | null = null;

/** 摆一条提示；同类提示不叠条，新的直接替换旧的。返回 false 表示连内容区都没有。 */
export function showNotice(text: string, kind: NoticeKind = "error"): boolean {
  const content = document.getElementById("content");
  if (!content) {
    // 设置窗骨架都没装配起来：至少让它进宿主日志，别静默
    console.error(`[settings] ${kind}: ${text}`);
    return false;
  }
  current?.remove();
  const bar = el("div", undefined, `notice notice-${kind}`);
  bar.setAttribute("role", kind === "error" ? "alert" : "status");
  const msg = el("span", text, "notice-text");
  const close = el("button", "×", "notice-close");
  close.type = "button";
  close.setAttribute("aria-label", "关闭提示");
  close.addEventListener("click", () => {
    bar.remove();
    if (current === bar) current = null;
  });
  bar.append(msg, close);
  content.prepend(bar);
  current = bar;
  return true;
}

/** 当前是否挂着提示（测试与重复渲染要用） */
export function noticeText(): string | null {
  return current?.textContent ?? null;
}

export function clearNotice(): void {
  current?.remove();
  current = null;
}
