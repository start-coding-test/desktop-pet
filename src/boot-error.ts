// 启动兜底错误条。必须是独立模块而非内联脚本 —— 收紧后的 CSP 不允许内联 script。
//
// 这里以前是「任何 window error / unhandledrejection 都盖一条整窗红条」，结果某个插件
// 的一次设置保存失败、或 Chromium 的 "ResizeObserver loop completed with undelivered
// notifications" 噪声，都能把整个宠物窗糊死（G4：普通插件错误不该被当成致命错误）。
// 现在只对**启动阶段**的错误与真正的宿主级错误亮条，其余按严重度落到 console：
// 插件异常的正式通道是 `host:plugin-error`（设置窗顶部横幅），不是这块遮羞布。
import { classifyError, hostErrorMessage } from "./runtime/host-error";

/** 启动完成了没有；没完成之前的未捕获错误视为致命（页面根本没装配起来） */
let bootReady = false;

/**
 * 由入口（宠物窗 / 设置窗）在 init 成功返回后调用。
 * 不调用也安全：那意味着这个窗口一直按「启动阶段」对待，宁可多亮条也不吞错。
 */
export function markBootReady(): void {
  bootReady = true;
}

/** 入口自己知道「这次真的起不来」时直接亮条（不必绕 unhandledrejection） */
export function showFatalError(rejection: unknown): void {
  show(hostErrorMessage(rejection));
}

/**
 * 浏览器噪声：观察者回调里同步改 DOM 会触发这条，Chromium 把它当 window error 派发，
 * 但它不代表任何功能失败（widget-host 里已经把写操作挪出交付回调，这里是第二道过滤）。
 */
const IGNORED = /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;

const el = typeof document === "undefined" ? null : document.getElementById("err-overlay");

function show(msg: string): void {
  if (!el) {
    // 没有兜底条的页面（悬浮窗/设置窗没有这个元素）：至少别把消息丢掉
    console.error(`[boot] ${msg}`);
    return;
  }
  el.textContent = `⚠ ${msg}`;
  el.style.display = "block";
}

function report(rejection: unknown, source: string): void {
  const message = hostErrorMessage(rejection);
  if (IGNORED.test(message)) {
    console.warn(`[boot] 忽略浏览器噪声（${source}）：${message}`);
    return;
  }
  const severity = classifyError(rejection, { bootPhase: !bootReady });
  if (severity === "fatal") {
    show(message);
    return;
  }
  if (severity === "error") {
    // 宿主级、又归因不到任何插件的未捕获错误：应用还活着，但用户眼前确实坏了 -> 照样亮条。
    // 它和 fatal 的差别只是「启动期就死了 vs 跑起来以后坏了」，对用户都是「这个窗口不能用了」，
    // 吞掉只会把故障变成一条沉默的 console（2026-11-01 E2E 合成的 window error 就是这一类）。
    show(message);
    return;
  }
  // 只有 warning（插件域：某个插件坏了，本体还能用）留日志。插件异常的正式通道是
  // `host:plugin-error`（设置窗顶部横幅），这里再亮整窗红条只会把「某个插件坏了」说成
  // 「整个应用坏了」（G4）。
  console.error(`[boot] ${source}（${severity}）`, rejection);
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => report(e.error ?? e.message, "error"));
  window.addEventListener("unhandledrejection", (e) => report(e.reason, "unhandledrejection"));
}
