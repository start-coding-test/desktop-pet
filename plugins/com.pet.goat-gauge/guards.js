// `/internal` 拉取的准入守卫（G5-05）。纯函数：main 的 refreshInternal 在**发请求前**调它，
// 离线单测直接钉这里。
//
// 原实现只有 `if (!ctx?.secrets || !cookie) return;` 一道门：
//   - busy 中（手动刷新在飞）再来一次定时刷新，/internal 会和摘要请求叠着打；
//   - 演示模式（config.demo）本该完全不出网，但 Cookie 在时照样打 /internal；
//   - 停用后 ctx 被清成 null，可选链让这段代码"能跑"，却在空上下文上继续写 cookieState。
// 三种都收成守卫的返回值，main 只负责照单执行（挡住就不动任何状态）。

/**
 * @param {{ctx?: any, cookie?: string, demo?: boolean, busy?: boolean, internalBusy?: boolean}} [input]
 * @returns {null | "no-ctx" | "no-secret" | "no-cookie" | "demo" | "busy"}
 *   null 表示可以发请求；其余为挡下原因（调用方只记日志，不改 cookieState）
 */
export function internalFetchGate(input = {}) {
  const { ctx, cookie, demo = false, busy = false, internalBusy = false } = input;
  if (!ctx) return "no-ctx";
  if (!ctx.secrets) return "no-secret";
  if (!cookie) return "no-cookie";
  if (demo === true) return "demo";
  if (busy === true || internalBusy === true) return "busy";
  return null;
}
