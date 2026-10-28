// 拖动交互的按下 / 起拖 / 收尾状态机（G6-01、G6-02、G6-08）。
//
// 纯逻辑：时钟与副作用全部由外部注入 —— main.ts 负责 DOM 与窗口接线，离线单测用假时钟
// 直接驱动。这段逻辑原来直接摊在 main.ts 顶层（摸了 document/window），node 里 import 不了，
// 只能靠正则匹配源码「证明」它存在，抓不到「拖动中 blur」「真机吞 mouseup」这类行为问题。

/** 起拖阈值（CSS px）：按下后位移超过它才启动系统级拖拽，否则抬起按「戳一戳」处理 */
export const DRAG_START_PX = 6;

/**
 * 拖动期 blur 的宽限（ms）：Windows 上 startDragging 有已知的 blur 抖动，真机可能刚起拖就失焦。
 * 宽限内 focus 回来就作废（继续拖），超时才按真失焦收尾 —— 直接 endDrag 会把拖动误杀在半路。
 */
export const BLUR_GRACE_MS = 100;

/**
 * 静默兜底（ms）：真机拖拽会吞掉 mouseup，松手后不动鼠标就再没有任何事件。
 * 窗口连续这么久没再移动就按「松键了」收尾，避免 running 永远挂着、点击穿透再也开不回来。
 * 代价：拖动中途停手超过这个时长的真实拖动会被提前收尾 —— 「不永久挂住」优先的取舍。
 */
export const DRAG_SILENCE_MS = 250;

/** 拖动收尾原因（只用于诊断：e2e/真机排查时能看出是哪条路径收的尾） */
export type DragEndReason = "mouseup" | "blur" | "silent" | "buttons-released" | "reset";

export interface DragControllerOptions {
  /** 注入时钟（ms）：单测用假时钟驱动宽限期与静默兜底 */
  now: () => number;
  /** 起拖副作用：状态机 beginDrag + 方向追踪器复位 + 系统 startDragging */
  onBegin?: () => void;
  /** 收尾副作用：状态机 endDrag + 方向追踪器复位 */
  onEnd?: (reason: DragEndReason) => void;
}

export class DragController {
  /** 按下点（screen 坐标，CSS px）；null = 没在按 */
  private pressPoint: { x: number; y: number } | null = null;
  /** 系统级拖拽已接管（拖动期） */
  private engaged = false;
  /** 拖动期 blur 的时刻；null = 没有待裁决的失焦 */
  private pendingBlurAt: number | null = null;
  /** 最近一次窗口真实位移的时刻（静默兜底的计时起点） */
  private lastWindowMoveAt = 0;
  private readonly now: () => number;
  private readonly onBegin: () => void;
  private readonly onEnd: (reason: DragEndReason) => void;

  constructor(opts: DragControllerOptions) {
    this.now = opts.now;
    this.onBegin = opts.onBegin ?? (() => {});
    this.onEnd = opts.onEnd ?? (() => {});
  }

  /** 是否处于拖动期（点击穿透据此关/开） */
  get isEngaged(): boolean {
    return this.engaged;
  }

  /** 是否按着但还没起拖（mouseup 靠它区分「戳一戳」与「拖动后的松手」） */
  get hasPress(): boolean {
    return this.pressPoint !== null;
  }

  /** 是否有待裁决的拖动期失焦（诊断与单测用） */
  get awaitingBlurVerdict(): boolean {
    return this.pendingBlurAt !== null;
  }

  /** 按下：上一趟拖拽的 mouseup 可能没收到，先按「松手」收尾，再记这一次的按下点 */
  pressDown(x: number, y: number): void {
    if (this.engaged) this.finish("reset");
    this.pendingBlurAt = null;
    this.pressPoint = { x, y };
  }

  /** 移动：按键已松开（buttons === 0）就收尾；否则按起拖阈值判断是否交给系统拖拽 */
  pointerMove(x: number, y: number, buttons: number): void {
    // 系统级拖拽会吃掉抬起事件，mouseup 常常收不到：按键已经松开就说明这趟拖完了。
    // 不补这一下的话 engaged 永远挂着，穿透再也不会开启，宠物整块挡鼠标。
    if (this.engaged && buttons === 0) {
      this.finish("buttons-released");
      return;
    }
    if (!this.pressPoint || this.engaged) return;
    if (Math.hypot(x - this.pressPoint.x, y - this.pressPoint.y) > DRAG_START_PX) this.engage();
  }

  /** 抬起：拖动期收尾（复原姿势）；没起拖则只撤销按下候选（调用方据 hasPress/isEngaged 决定戳一戳） */
  pointerUp(): void {
    if (this.engaged) {
      this.finish("mouseup");
      return;
    }
    this.pressPoint = null;
    this.pendingBlurAt = null;
  }

  /** 失焦：非拖动期只撤销按下候选；拖动期只清 press、不结束，等宽限期裁决 */
  blur(): void {
    if (!this.engaged) {
      this.pressPoint = null;
      return;
    }
    this.pressPoint = null;
    this.pendingBlurAt = this.now();
  }

  /** 焦点回来：宽限期内回来就作废这次失焦，拖动继续 */
  focus(): void {
    this.pendingBlurAt = null;
  }

  /** 指针移出窗口：只清按下候选，永远不会结束拖动 */
  mouseLeave(): void {
    this.pressPoint = null;
  }

  /** 窗口真实位移（onMoved）：喂静默兜底的计时 */
  windowMoved(): void {
    if (this.engaged) this.lastWindowMoveAt = this.now();
  }

  /** 渲染帧驱动：宽限期到点按真失焦收尾；静默到点按「已松键」收尾 */
  tick(): void {
    if (!this.engaged) return;
    if (this.pendingBlurAt !== null && this.now() - this.pendingBlurAt >= BLUR_GRACE_MS) {
      this.finish("blur");
      return;
    }
    if (this.now() - this.lastWindowMoveAt >= DRAG_SILENCE_MS) this.finish("silent");
  }

  private engage(): void {
    this.engaged = true;
    this.pressPoint = null;
    this.pendingBlurAt = null;
    this.lastWindowMoveAt = this.now();
    this.onBegin();
  }

  private finish(reason: DragEndReason): void {
    const wasEngaged = this.engaged;
    this.engaged = false;
    this.pressPoint = null;
    this.pendingBlurAt = null;
    if (wasEngaged) this.onEnd(reason);
  }
}
