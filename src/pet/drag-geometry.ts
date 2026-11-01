// 拖动几何（G6-05 / 附录2 N1、N2）：非 100% DPI 下的拖动起点与结束状态一律按**真实窗口坐标**算。
//
// 为什么不能直接用 `MouseEvent.screenX/screenY`：
// - 它们是 WebView 按自己的视口换算出来的 CSS 坐标，跨 DPI 时与窗口物理坐标差一个缩放倍率，
//   拿它当「窗口在哪」会把 1.5× 屏上的 10px 当成 15px（方向态翻错、起拖阈值提前触发）；
// - 系统级拖拽（`startDragging()`）一旦接管，鼠标事件就断了，松手也收不到 mouseup，
//   拖动期间**唯一**还在动的观测是窗口自己的 `outerPosition()` / `onMoved`。
//
// 所以拖动模型只有一条：按下瞬间记「窗口物理位置 + 指针在窗口内的物理偏移」（= 抓取偏移），
// 之后窗口到哪，指针就在 `窗口 + 偏移`；反过来要问「窗口该到哪」，答案也是 `指针 - 偏移`。
// 这条式子在任何缩放倍率下都成立，且**保留当前偏移**（起拖瞬间不跳）。
//
// 纯函数 + 注入时钟/倍率，离线单测直接算（tests/unit/unit-drag-acceptance.mjs）。

/** 缩放倍率归一化：0 / NaN / 负数一律按 1 处理（个别机器会给出 0，除法会炸） */
export function normalizeDpr(dpr: number): number {
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/** 按下瞬间的锚点：窗口物理位置 + 指针在窗口内的物理偏移 + 当时的缩放倍率 */
export interface DragAnchor {
  /** 窗口左上角的物理像素（`outerPosition()` 的口径） */
  windowX: number;
  windowY: number;
  /** 指针相对窗口左上角的物理像素偏移（= clientX * dpr）—— 拖动全程保持不变 */
  offsetX: number;
  offsetY: number;
  /** 按下时的缩放倍率 */
  dpr: number;
  /** 按下瞬间指针的屏幕物理坐标（= window + offset），只用于诊断与单测 */
  screenX: number;
  screenY: number;
}

export interface AnchorInput {
  windowX: number;
  windowY: number;
  /** 指针在窗口内的 CSS 偏移（MouseEvent.clientX/clientY） */
  clientX: number;
  clientY: number;
  dpr: number;
}

/** 按下：把「窗口位置 + 窗口内偏移」钉成锚点（这一步就是「抓窗口位置作为拖动起点」） */
export function pressAnchor(input: AnchorInput): DragAnchor {
  const dpr = normalizeDpr(input.dpr);
  const offsetX = input.clientX * dpr;
  const offsetY = input.clientY * dpr;
  return {
    windowX: input.windowX,
    windowY: input.windowY,
    offsetX,
    offsetY,
    dpr,
    screenX: input.windowX + offsetX,
    screenY: input.windowY + offsetY,
  };
}

/** 锚点对应的「指针屏幕物理坐标」：窗口换了位置时，指针就在新窗口 + 抓取偏移处 */
export function cursorFromWindow(
  anchor: DragAnchor,
  windowX: number,
  windowY: number,
): { x: number; y: number } {
  return { x: windowX + anchor.offsetX, y: windowY + anchor.offsetY };
}

/** 反向：让指针停在 (cursorX, cursorY) 时窗口该在哪 —— 保留抓取偏移，起拖不跳 */
export function windowFromCursor(
  anchor: DragAnchor,
  cursorX: number,
  cursorY: number,
): { x: number; y: number } {
  return { x: cursorX - anchor.offsetX, y: cursorY - anchor.offsetY };
}

/**
 * 按下点 / 移动点统一成 **CSS 屏幕坐标**，喂给 `DragController` 的阈值判定。
 *
 * 口径：`窗口物理位置 / dpr + 窗口内 CSS 偏移`。窗口没动时它等于 `screenX`，
 * 但窗口动过之后仍然正确（`screenX` 在拖动态拿不到任何新值），且阈值仍是 CSS px，
 * 与 `DRAG_START_PX` 的含义一致 —— 1×、1.5×、2× 屏上手感相同。
 */
export function cssScreenPoint(input: AnchorInput): { x: number; y: number } {
  const dpr = normalizeDpr(input.dpr);
  return { x: input.windowX / dpr + input.clientX, y: input.windowY / dpr + input.clientY };
}

/** 真实窗口位移（CSS px）—— 拖动方向态的输入 */
export interface WindowTravel {
  /** 窗口相对锚点走了多少（CSS px） */
  dxCss: number;
  dyCss: number;
  distanceCss: number;
}

/** 结束状态快照：窗口最终停在哪、这趟拖动一共走了多远（全部来自真实窗口坐标） */
export interface DragEndState extends WindowTravel {
  windowX: number;
  windowY: number;
  dpr: number;
  /** 从按下点算起的物理位移（诊断用；除以 dpr 才是 CSS） */
  dxPhysical: number;
  dyPhysical: number;
}

/** 由真实窗口位置算「相对按下点走了多远」 */
export function travelFromWindow(
  anchor: DragAnchor,
  windowX: number,
  windowY: number,
): WindowTravel {
  const dpr = normalizeDpr(anchor.dpr);
  const dxPhysical = windowX - anchor.windowX;
  const dyPhysical = windowY - anchor.windowY;
  const dxCss = dxPhysical / dpr;
  const dyCss = dyPhysical / dpr;
  return { dxCss, dyCss, distanceCss: Math.hypot(dxCss, dyCss) };
}

/**
 * 收尾：用**最后观测到的真实窗口位置**给出结束状态（N2「OS 拖动结束转常态」）。
 *
 * 真机松手时没有可信的 mouseup（被系统拖拽吞掉），screenX/screenY 也不会再更新，
 * 结束状态只能由窗口自己停在哪来定：`windowX/Y` 是真实落点，`dxCss` 是这趟走了多远，
 * 状态机据此复原拖动前的姿态（`endDrag()`），再也不拿鼠标事件里的坐标冒充窗口坐标。
 */
export function dragEndState(
  anchor: DragAnchor,
  windowX: number,
  windowY: number,
): DragEndState {
  const travel = travelFromWindow(anchor, windowX, windowY);
  return {
    ...travel,
    windowX,
    windowY,
    dpr: normalizeDpr(anchor.dpr),
    dxPhysical: windowX - anchor.windowX,
    dyPhysical: windowY - anchor.windowY,
  };
}

/** `WindowMoveTracker.sample` 的结果：CSS 位移 + 这次采样是否刚重建基线 */
export interface WindowSample {
  /** 本次窗口位移（CSS px）；重建基线的采样为 0 */
  dxCss: number;
  /** true = 缩放倍率变了或首个采样，调用方应丢弃这一拍的方向输入（跨 DPI 会跳变） */
  rescaled: boolean;
}

/**
 * 窗口位移采样器：把「物理像素位移」换成「CSS 位移」，并在缩放倍率变化时**重建基线**。
 *
 * 跨 DPI 拖动（拖到另一块屏）时，同一个物理位移在不同倍率下的 CSS 值不等价；
 * 直接拿上一拍的物理差除以新倍率会造出一个假跳变（宠物瞬间反向甩头）。
 * 这里宁可丢一拍（返回 `rescaled: true`）也不产生假方向。
 */
export class WindowMoveTracker {
  private dpr: number;
  private lastX: number | null;

  constructor(dpr: number, windowX: number | null = null) {
    this.dpr = normalizeDpr(dpr);
    this.lastX = typeof windowX === "number" && Number.isFinite(windowX) ? windowX : null;
  }

  get currentDpr(): number {
    return this.dpr;
  }

  get lastWindowX(): number | null {
    return this.lastX;
  }

  /** 观测一次真实窗口位置；首帧或 dpr 变化返回重建标记（位移 0，调用方别当方向输入） */
  sample(windowX: number, dpr = this.dpr): WindowSample {
    const next = normalizeDpr(dpr);
    if (next !== this.dpr) {
      this.dpr = next;
      this.lastX = windowX;
      return { dxCss: 0, rescaled: true };
    }
    if (this.lastX === null) {
      this.lastX = windowX;
      return { dxCss: 0, rescaled: true };
    }
    const dxCss = (windowX - this.lastX) / this.dpr;
    this.lastX = windowX;
    return { dxCss, rescaled: false };
  }

  /** 重置基线：新一趟拖动 / 停手后重新计数（windowX 传 null = 下一拍只建基线不出位移） */
  reset(windowX: number | null = null, dpr = this.dpr): void {
    this.dpr = normalizeDpr(dpr);
    this.lastX = typeof windowX === "number" && Number.isFinite(windowX) ? windowX : null;
  }
}
