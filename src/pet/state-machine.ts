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

export type PokeZone = "head" | "belly" | "tail";

// 状态词表完全照搬 petdex 的九个状态（见 petdex-states.ts），不再有 sleep/react/greet 等自造动作。
// - 手势类（waving/jumping/failed）播完一遍整行时长就回 idle，与 petdex 桌面端 dwell 语义一致
// - 循环类（running/review/running-left/right）可被重复请求续期，安静 RENEW_HOLD_SECONDS 后回落
// - waiting 是 petdex 的「耐心待机」变体，本项目用它承担原来的睡觉位（长时间无交互）
// - request 为插件预留的插播队列入口（pet:react）
export class PetStateMachine {
  private defs: Partial<Record<ActionName, StateDef>> = {};
  private players: Partial<Record<ActionName, FramePlayer>> = {};
  private current: ActionName = "idle";
  private played = 0;
  /** 同级/低级请求的排队，上限 3：超限时丢最旧的，避免插件刷屏把队列变成无限缓冲 */
  private queue: ActionName[] = [];
  private sinceInteraction = 0;

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
    if (this.queue.includes(action)) return; // 同一状态不重复排队
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

  /** 当前排队等待插播的状态数（诊断与回归断言用） */
  get queuedCount(): number {
    return this.queue.length;
  }

  update(dt: number): void {
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
