// petdex 桌宠状态与图集规格，照搬 petdex 的 src/lib/pet-states.ts 与 src/lib/sprite-atlas.ts。
// 本项目不再自造状态词表：九个状态 id、行号、每行帧数与整行时长都以下面这份表为准，
// 所有 Petdex 画廊下载的图集都按它切片。

export const SPRITE_COLUMNS = 8;
export const SPRITE_FRAME_WIDTH = 192;
export const SPRITE_FRAME_HEIGHT = 208;

export type PetStateId =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

/** v3 清单算出的逐状态节奏；v1/v2 不传，状态机按 PET_STATES 现算。 */
export type SpriteTiming = Partial<
  Record<PetStateId, { frameSec: number; cycleSec: number }>
>;

export interface PetStateDef {
  id: PetStateId;
  label: string;
  /** 图集里的行号 */
  row: number;
  /** 该行实际使用的帧数（列数为 8，尾部单元格是空的） */
  frames: number;
  /** 整行播完一遍的时长 */
  durationMs: number;
  purpose: string;
}

export const PET_STATES: readonly PetStateDef[] = [
  { id: "idle", label: "Idle", row: 0, frames: 6, durationMs: 1100, purpose: "Neutral breathing and blinking loop" },
  { id: "running-right", label: "Run Right", row: 1, frames: 8, durationMs: 1060, purpose: "Directional locomotion to the right" },
  { id: "running-left", label: "Run Left", row: 2, frames: 8, durationMs: 1060, purpose: "Directional locomotion to the left" },
  { id: "waving", label: "Waving", row: 3, frames: 4, durationMs: 700, purpose: "Greeting or attention gesture" },
  { id: "jumping", label: "Jumping", row: 4, frames: 5, durationMs: 840, purpose: "Anticipation, lift, peak, descent, settle" },
  { id: "failed", label: "Failed", row: 5, frames: 8, durationMs: 1220, purpose: "Readable error or sad reaction" },
  { id: "waiting", label: "Waiting", row: 6, frames: 6, durationMs: 1010, purpose: "Patient idle variant" },
  { id: "running", label: "Running", row: 7, frames: 6, durationMs: 820, purpose: "Generic in-place run loop" },
  { id: "review", label: "Review", row: 8, frames: 6, durationMs: 1030, purpose: "Focused inspecting or thinking loop" },
] as const;

const BY_ID = new Map<string, PetStateDef>(PET_STATES.map((s) => [s.id, s]));

export function petState(id: string): PetStateDef | undefined {
  return BY_ID.get(id);
}

export function isPetStateId(value: unknown): value is PetStateId {
  return typeof value === "string" && BY_ID.has(value);
}

/** 单帧推进间隔：整行时长 / 帧数 */
export function frameSeconds(def: PetStateDef): number {
  return def.durationMs / 1000 / def.frames;
}

export type SpriteAtlasVersion = 1 | 2;

export interface SpriteAtlasLayout {
  version: SpriteAtlasVersion;
  /** v1 = 9 行（正好九个状态），v2 = 8×11 网格但只有前 9 行有内容，第 10/11 行是预留空白 */
  rows: 9 | 11;
  width: number;
  height: number;
  /** 相对标准 1536 宽的整数倍缩放 */
  scale: number;
}

const LAYOUTS: Array<{ version: SpriteAtlasVersion; rows: 9 | 11 }> = [
  { version: 1, rows: 9 },
  { version: 2, rows: 11 },
];

/**
 * 只凭尺寸识别图集，不解码像素。缩放过的图集只有在每行每列仍落在整数单元格边界时才接受，
 * 否则切片会出现小数裁剪边界。返回 null 表示不是受支持的 petdex 图集。
 */
export function detectSpriteAtlas(width: unknown, height: unknown): SpriteAtlasLayout | null {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const canonicalWidth = SPRITE_COLUMNS * SPRITE_FRAME_WIDTH;
  for (const layout of LAYOUTS) {
    const canonicalHeight = layout.rows * SPRITE_FRAME_HEIGHT;
    if (
      width % SPRITE_COLUMNS !== 0 ||
      height % layout.rows !== 0 ||
      BigInt(width) * BigInt(canonicalHeight) !== BigInt(height) * BigInt(canonicalWidth)
    ) {
      continue;
    }
    return { ...layout, width, height, scale: width / canonicalWidth };
  }
  return null;
}
