import { PET_STATES, frameSeconds } from "./petdex-states";
import type { PetStateId, SpriteTiming } from "./petdex-states";
import type { SpriteFrame, SpriteSet, ActionName } from "./sprites";
import { FramePlayer } from "./player";

interface StateDef {
  /** 停留时长（秒）：到时按 next 切换。1e9 = 只被交互或新的请求打断 */
  dwell: number;
  /** 到时去哪个状态；null = 回 idle */
  next: ActionName | null;
  /** 数值越大越适合打断当前状态 */
  priority: number;
  /** 可被重复请求续期的状态（插件按事件节奏续命，安静下来后自然回落 idle） */
  renewable: boolean;
}

/** 无交互多久进入等待（参考原项目 AFK_MS = 180s） */
const AFK_SECONDS = 180;
/** idle 结束时随机切「思考」小动作的概率 */
const REVIEW_CHANCE = 0.35;
/** 可持续状态的默认停留上限：插件不再续期就回落 */
const RENEW_HOLD_SECONDS = 45;

/**
 * 拖动方向判定口径（e2e 复用同一口径）：
 * 窗口水平净位移达到多少才认方向。与 main.ts 的 6px 起拖阈值分开 ——
 * 起拖只需证明「按着在动」，认方向要证明「确实往那边拖」。
 * 取 24px = 起拖阈值的 4 倍：按住时的鼠标微颤（±几 px）和抓取点偏移都到不了这里；
 * 而正常拖速（≥200 px/s）只要 ≤120ms 就能越过，所以方向态在过阈值后的下一帧就出现，
 * 远快于「起拖后 300ms 内出现方向态」这条验收线。这里是 CSS px，
 * main.ts 拿到的是物理像素，判断前先除以 devicePixelRatio，200% 缩放下手感才一致。
 */
export const DRAG_DIRECTION_MIN_PX = 24;
/**
 * 两次方向切换之间的最短间隔（去抖）：拖动时 Windows 的窗口 Move 事件很密（几十到一百多 Hz），
 * 没有这道时间闸门时「左右抖一抖」（幅度刚过 24px）会把立绘翻成筛子。
 * 80ms ≈ 25fps 的两帧：反向切换最多被压后 80ms + 一帧事件（<20ms），仍在「反向 200ms 内切换」的验收线内。
 * 反向的时间预算 = 攒一个阈值（24px，200px/s 的拖速下 ≈120ms）+ 闸门残留（≤80ms）= ≤200ms；
 * 正常中途反向时闸门早已过期，实测只有 ~120ms（单测「拖动时序预算」钉住这两个数）。
 * 注意闸门只压时间、不丢位移：净位移一直攒着，闸门一开立刻判。
 */
export const DRAG_DIRECTION_COOLDOWN_MS = 80;

export type PokeZone = "head" | "belly" | "tail";

/** 拖动驱动的两个方向态（petdex 九状态的行 1 / 行 2，见 petdex-states.ts；不新造状态） */
export type DragDirection = "running-right" | "running-left";

/**
 * 拖动 → 方向态的判定器：纯逻辑，不碰 DOM、不自己取时钟（`now` 由调用方传入）。
 *
 * 为什么放在状态机这一侧而不是 main.ts：main.ts 顶层就摸 document，node 里的离线单测
 * import 不了它；而「窗口往哪边拖」本来就是方向态的前置判定，放一起才能被
 * `tests/unit/unit-runtime.mjs` 覆盖到。窗口位置事件（`getCurrentWindow().onMoved`）仍由
 * main.ts 接 —— 系统级拖拽一开始 webview 就收不到 mousemove/mouseup，能用的只剩窗口自己的位移。
 */
export class DragDirectionTracker {
  /** 自上次认方向以来的水平净位移（CSS px，正 = 向右） */
  private accum = 0;
  /** 已认定的方向；null = 还没越过阈值，宠物停在拖动前的姿势 */
  private committed: DragDirection | null = null;
  private lastSwitchAt = Number.NEGATIVE_INFINITY;

  /** 起拖：清掉上一次拖动残留的累计量（否则上次往右拖剩的余量会把这次起手判成右） */
  begin(): void {
    this.accum = 0;
    this.committed = null;
    this.lastSwitchAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * 喂一次窗口水平位移（dx 为正 = 窗口向右），返回此刻应显示的方向；null = 还没到阈值。
   *
   * 未认定方向时判「净位移」（往右 30px 再往左 20px 净剩 10px 不成方向）；
   * 认定方向之后，反向进度只由**连续**的反向位移累积：窗口只要往已认定方向挪过一帧
   *（哪怕 1px），反向进度就清零。这条换来两个性质：
   *   - 抖动不切：±2px 的往复里反向永远攒不满一个阈值；
   *   - 反向不等等：不会有「一路向右攒下的余量」替反向买单，最坏情况也只要一个阈值
   *     （24px，200px/s 的拖速下 ≈120ms，见上方 COOLDOWN 的 200ms 预算）。
   * 代价是反向途中回拖一下要重新攒，这是刻意的取舍：宁可慢半帧，不可抖。
   */
  sample(dx: number, now: number): DragDirection | null {
    const committedSign =
      this.committed === "running-right" ? 1 : this.committed === "running-left" ? -1 : 0;
    if (committedSign !== 0 && Math.sign(dx) === committedSign) this.accum = 0;
    else this.accum += dx;
    if (Math.abs(this.accum) < DRAG_DIRECTION_MIN_PX) return this.committed;
    const dir: DragDirection = this.accum > 0 ? "running-right" : "running-left";
    if (dir === this.committed) return dir;
    if (now - this.lastSwitchAt < DRAG_DIRECTION_COOLDOWN_MS) return this.committed;
    this.committed = dir;
    this.accum = 0;
    this.lastSwitchAt = now;
    return dir;
  }
}

// 状态词表完全照搬 petdex 的九个状态（见 petdex-states.ts），不再有 sleep/react/greet 等自造动作。
// - 手势类（waving/jumping/failed）播完一遍整行时长就回 idle，与 petdex 桌面端 dwell 语义一致
// - 循环类（running/review/running-left/right）可被重复请求续期，安静 RENEW_HOLD_SECONDS 后回落
// - waiting 是 petdex 的「耐心待机」变体，本项目用它承担原来的睡觉位（长时间无交互）
// - request 为插件预留的插播队列入口（pet:react）
// - running-left/right 另外还由拖动驱动（beginDrag/dragDirection/endDrag）：拖动期不排空队列、
//   不走到点回落，松手复原到拖动前的姿势；拖动期的 request 另存一份 deferred（见下），
//   松手复原后按原优先级补播 —— 否则插件此刻要的 waiting 提示会被方向帧永久吃掉
export class PetStateMachine {
  private defs: Partial<Record<ActionName, StateDef>> = {};
  private players: Partial<Record<ActionName, FramePlayer>> = {};
  private current: ActionName = "idle";
  private played = 0;
  /** 同级/低级请求的排队，上限 3：超限时丢最旧的，避免插件刷屏把队列变成无限缓冲 */
  private queue: ActionName[] = [];
  private sinceInteraction = 0;
  /**
   * 拖动前的姿势快照；null = 此刻不在拖动。
   * 拖动期间立绘由窗口位移驱动（running-left/right），与插件请求互不越界：
   * 拖动期只暂停本状态机的计时（dwell / 队列出队 / 挂机，见 update），
   * `request()` 的优先级与排队规则一个字不改。
   */
  private dragReturn: ActionName | null = null;
  /**
   * 拖动期间收到的插件请求（G6-03）：拖动期画面由方向帧驱动，此刻立即切过去会被下一帧
   * Moved 覆盖 —— 插件要的 waiting（审批提示）就这样永久丢了。这里先存着，松手复原后
   * 再按原来的优先级规则补播（replayDeferred）。
   */
  private deferred: ActionName[] = [];
  /**
   * 拖动期间真正画到前台的姿势（G6-04）：皮肤缺 running-left/right 帧时会回退到 idle，
   * 此时拖动画出来的其实是 idle。松手只复原「画面还停在拖动画出来的那一帧」的情况，
   * 拖动被暂停（installGameMode）等没画出来的时候不要凭空切姿势。
   */
  private dragPainted: ActionName | null = null;

  private static readonly MAX_QUEUE = 3;

  /** 最近一次姿势切换的时间戳（渲染层做弹跳淡入） */
  lastSwitchAt = 0;
  /** 拉尾巴的抖动截止时间戳（渲染层做位移抖动） */
  shakeUntil = 0;
  /** 进入 waiting（长时间无交互）时回调（渲染层配台词） */
  onSleep?: () => void;

  constructor(sprites: SpriteSet, timing?: SpriteTiming) {
    this.applySprites(sprites, timing);
  }

  /** 重建 defs/players：帧间隔与手势 dwell 都以 timing 为准，缺省回落 petdex 状态表 */
  private applySprites(sprites: SpriteSet, timing?: SpriteTiming): void {
    this.defs = {};
    this.players = {};
    const def = (id: PetStateId, partial: StateDef): void => {
      const frames = sprites[id];
      if (!frames || frames.length === 0) return;
      this.defs[id] = partial;
      const state = PET_STATES.find((s) => s.id === id)!;
      this.players[id] = new FramePlayer(frames, timing?.[id]?.frameSec ?? frameSeconds(state));
    };

    // 手势类的一遍时长默认取表里的 durationMs；v3 清单给了 durationMs 就按清单，
    // 与 petdex 桌面端的 dwell 语义对齐
    const gesture = (id: PetStateId): StateDef => ({
      dwell:
        timing?.[id]?.cycleSec ?? PET_STATES.find((s) => s.id === id)!.durationMs / 1000,
      next: "idle",
      priority: 10,
      renewable: false,
    });

    def("idle", { dwell: 9, next: null, priority: 0, renewable: false });
    def("running-right", { dwell: RENEW_HOLD_SECONDS, next: "idle", priority: 1, renewable: true });
    def("running-left", { dwell: RENEW_HOLD_SECONDS, next: "idle", priority: 1, renewable: true });
    def("waving", gesture("waving"));
    def("jumping", gesture("jumping"));
    def("failed", gesture("failed"));
    def("waiting", { dwell: 1e9, next: null, priority: 5, renewable: false });
    def("running", { dwell: RENEW_HOLD_SECONDS, next: "idle", priority: 3, renewable: true });
    def("review", { dwell: RENEW_HOLD_SECONDS, next: "idle", priority: 2, renewable: true });
  }

  /** 请求插播状态：优先级更高则立即打断，同级或更低则排队；重复请求当前状态只续期 */
  request(action: ActionName): void {
    this.sinceInteraction = 0;
    const def = this.defs[action];
    if (!def) return;
    if (action === this.current) {
      if (def.renewable) this.played = 0;
      return;
    }
    if (this.queue.includes(action) || this.deferred.includes(action)) return; // 同一状态不重复排队
    // 拖动期只入队不切（G6-03）：切了也会被下一帧方向帧盖掉，请求等于白丢
    if (this.dragReturn !== null) {
      this.deferred.push(action);
      if (this.deferred.length > PetStateMachine.MAX_QUEUE) this.deferred.shift();
      return;
    }
    const cur = this.defs[this.current];
    if (!cur || def.priority > cur.priority || this.current === "waiting") {
      this.switchTo(action);
      return;
    }
    this.queue.push(action);
    if (this.queue.length > PetStateMachine.MAX_QUEUE) this.queue.shift();
  }

  /** 换一批帧（换皮肤用），保持当前状态；dwell 与帧间隔随新 timing 一起重建 */
  setSprites(sprites: SpriteSet, timing?: SpriteTiming): void {
    const keep: ActionName = this.players[this.current] ? this.current : "idle";
    const played = this.played;
    this.applySprites(sprites, timing);
    this.current = this.players[keep] ? keep : "idle";
    this.played = played;
    this.players[this.current]?.reset();
  }

  /**
   * 摸头/戳肚子/拉尾巴（部位判定沿用原 hit-zones）。
   * waiting 中任何 poke 都会先唤醒（切 waving，由渲染层配 wake 台词）。
   */
  poke(zone: PokeZone): ActionName {
    this.sinceInteraction = 0;
    if (this.current === "waiting") {
      this.switchTo("waving");
      return "waving";
    }
    const action: ActionName =
      zone === "head" ? "waving" : zone === "belly" ? "jumping" : "failed";
    if (zone === "tail") this.shakeUntil = performance.now() + 320;
    this.switchTo(action);
    return action;
  }

  get frame(): SpriteFrame {
    return this.players[this.current]!.current;
  }

  get action(): ActionName {
    return this.current;
  }

  /** 是否正被拖动驱动（诊断与回归断言用） */
  get dragging(): boolean {
    return this.dragReturn !== null;
  }

  /**
   * 起拖：把此刻的姿势记成松手后的复原目标。
   * 幂等 —— 拖动中重复调用不许改写快照：第二次会把 running-right 记成「拖动前」，
   * 松手就停在跑步态了（main.ts 的 mousemove 与 mouseup 两条路径都可能走到这里）。
   */
  beginDrag(): void {
    this.sinceInteraction = 0;
    if (this.dragReturn !== null) return;
    this.dragReturn = this.current;
  }

  /**
   * 拖动中按方向切姿势；null = 还没越过判定阈值，落回拖动前那个姿势（但仍算在拖）。
   * 只由拖动驱动：不在拖动期时调用一律忽略，插件 `pet:react` 的 request() 语义不受影响。
   */
  dragDirection(dir: DragDirection | null): void {
    if (this.dragReturn === null) return;
    this.sinceInteraction = 0;
    const wanted = dir ?? this.dragReturn;
    // 皮肤可能没有 running-left/right 帧：回落目标是**拖动前的姿势**，不是 idle。
    // 不这么做的话每个 Moved 都会 switchTo(wanted) → 回退 idle → 重置播放进度，
    // 立绘永远停在 idle 的首帧（半透明入场帧）上抖（G6-04）。回落目标恒定，所以最多切一次。
    const target = this.players[wanted] ? wanted : this.dragReturn;
    // 重复 set 不重入：不重置播放进度，也不刷 lastSwitchAt（渲染层的弹跳淡入靠它）
    if (target === this.current) return;
    this.dragPainted = target;
    this.switchTo(target);
  }

  /**
   * 松手：回到拖动前的姿势（拖动前是 waiting 就回 waiting，不是 idle）。可重复调用，第二次起是空操作。
   * 拖动期间被插件插播（jumping/waving…）时不抢回来：方向态只由拖动驱动，复原也只复原
   * 「此刻还停在方向态」这一种情况，插件的手势/循环态照它原本的优先级、dwell 与队列自己播完。
   */
  endDrag(): void {
    if (this.dragReturn === null) return;
    const back = this.dragReturn;
    const painted = this.dragPainted;
    this.dragReturn = null;
    this.dragPainted = null;
    this.sinceInteraction = 0;
    // 只复原「画面还停在拖动画出来的那一帧」的情况：皮肤缺方向帧时画出来的可能是 idle
    // 回退（G6-04）；拖动期间被插件插播（jumping…）时画面已经不归拖动管，也不抢回来。
    if (painted !== null && this.current === painted && this.current !== back) this.switchTo(back);
    this.replayDeferred();
  }

  /** 松手后补播拖动期排队的请求（G6-03）：仍走 request，优先级与排队语义一个字不改 */
  private replayDeferred(): void {
    if (this.deferred.length === 0) return;
    const pending = this.deferred;
    this.deferred = [];
    for (const action of pending) this.request(action);
  }

  /** 当前排队等待插播的状态数（诊断与回归断言用） */
  get queuedCount(): number {
    return this.queue.length;
  }

  update(dt: number): void {
    // 拖动期只推进帧序列（在跑就得动），dwell / 队列出队 / 挂机全部暂停：
    // 否则一次长拖会被 running-* 的 45 秒续期上限打回 idle，插件的排队请求也会被方向态吃掉。
    if (this.dragReturn !== null) {
      this.sinceInteraction = 0;
      this.players[this.current]!.update(dt);
      return;
    }

    this.played += dt;
    this.sinceInteraction += dt;

    // 挂机检测：非等待状态下 3 分钟无交互 → waiting
    // 兜底皮肤只有 idle 帧（players.waiting 不存在）时这条整体不成立：
    // 否则 switchTo 每帧回落 idle、onSleep 每帧重放，台词被 60fps 反复触发
    if (
      this.current !== "waiting" &&
      this.players.waiting &&
      !isRenewable(this.defs[this.current]) &&
      this.sinceInteraction >= AFK_SECONDS
    ) {
      this.switchTo("waiting");
      this.onSleep?.();
    }

    this.players[this.current]!.update(dt);

    const def = this.defs[this.current]!;
    if (this.played >= def.dwell) {
      let next: ActionName;
      if (this.current === "idle") {
        // 先排空插件请求，再随机切「思考」小动作
        next =
          this.queue.shift() ??
          (Math.random() < REVIEW_CHANCE && this.players.review ? "review" : "idle");
      } else {
        next = this.queue.shift() ?? def.next ?? "idle";
      }
      this.switchTo(next);
    }
  }

  private switchTo(action: ActionName): void {
    const target = this.players[action] ? action : "idle";
    this.current = target;
    this.played = 0;
    this.players[target]!.reset();
    this.lastSwitchAt = performance.now();
  }
}

function isRenewable(def: StateDef | undefined): boolean {
  return def?.renewable === true;
}
