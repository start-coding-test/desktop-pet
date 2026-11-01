// 悬浮窗的生死判定（附录2 N4）。
//
// 每扇悬浮窗由宿主按插件创建，内容只有「它自己那个插件的 overlay widget」。窗口一旦
// 找不到归属（宠物窗为空 / 窗口登记已拆 / 插件在开窗途中被删），它就是一扇
// **点不到、关不掉、还置顶**的空窗 —— 用户只能去任务管理器结束进程。
// 所以这里的缺省动作是「关掉自己」，但给宿主一点时间：
// 新开的窗口在 IPC 登记完成前可能短暂查不到归属，立刻关会误杀刚开的卡片。
//
// 纯函数 + 注入时间，离线单测直接算（tests/unit/unit-runtime-acceptance.mjs）。

/** 查不到归属时的宽限（ms）：超过它仍认不出窗口主人就关掉自己 */
export const OWNER_GRACE_MS = 3_000;
/** 宽限期内重试间隔（ms）：新窗口的登记 IPC 可能比页面脚本晚到 */
export const OWNER_RETRY_MS = 250;

export type OverlayAction = "mount" | "wait" | "close";

export interface OverlayProbe {
  /** `overlay_owner` 查到的插件 id；null = 宿主答不上来 */
  ownerId: string | null;
  /** 清单里还有这个插件吗（被删/移走 → false） */
  installed: boolean;
  /** 用户还启用它吗 */
  enabled: boolean;
  /** manifest 里声明了 widget 吗 */
  hasWidget: boolean;
  /** 本窗是否已经挂上（含 widgetHost 里已有插槽） */
  mounted: boolean;
  /** 已经查不到归属多久（ms）；只在 ownerId === null 时有意义 */
  ownerMissingMs?: number;
}

/**
 * 该做什么：
 * - 认不出归属：宽限期内等（"wait"），超时关窗（"close"）；
 * - 认出来了但插件已删/已停用/没有 overlay widget（"close"）—— 没有内容可挂；
 * - 已经挂着：什么都不用做（"wait"）；
 * - 其余：挂上去（"mount"）。
 */
export function decideOverlayAction(probe: OverlayProbe): OverlayAction {
  if (probe.ownerId === null || probe.ownerId === "") {
    return (probe.ownerMissingMs ?? 0) >= OWNER_GRACE_MS ? "close" : "wait";
  }
  if (!probe.installed || !probe.enabled || !probe.hasWidget) return "close";
  if (probe.mounted) return "wait";
  return "mount";
}

/** 关窗原因（日志里要能一眼看出是哪条路收的窗） */
export function closeReason(probe: OverlayProbe): string {
  if (probe.ownerId === null || probe.ownerId === "") {
    return `宿主查不到窗口归属（等满 ${OWNER_GRACE_MS}ms）`;
  }
  if (!probe.installed) return `插件 ${probe.ownerId} 已不在清单里`;
  if (!probe.enabled) return `插件 ${probe.ownerId} 已停用`;
  if (!probe.hasWidget) return `插件 ${probe.ownerId} 没有 overlay widget`;
  return "无需关闭";
}
