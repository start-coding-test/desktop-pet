// D01：v3 图集清单（同目录 pet.json 的 desktopPet 字段）解析与校验。
// 纯函数，不读磁盘/网络；只有 version === 3 才进入校验，其余一律按“没有清单”返回。
import { isPetStateId } from "./petdex-states";
import type { PetStateId, SpriteTiming } from "./petdex-states";

export const DESKTOP_PET_VERSION = 3;
export const V3_COLUMNS = 16;
export const V3_MAX_FRAMES = 64;
export const V3_MIN_FRAME_MS = 16;
export const V3_MAX_DURATION_MS = 20_000;
export const V3_MAX_EDGE = 8192;
export const V3_MAX_DECODED_BYTES = 128 * 1024 * 1024;

export interface DesktopPetStateSpec {
  row: number;
  frames: number;
  durationMs: number;
}

export interface DesktopPetManifest {
  version: 3;
  grid: { columns: 16; rows: number };
  states: Partial<Record<PetStateId, DesktopPetStateSpec>>;
}

export type ManifestParseResult =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "v3"; manifest: DesktopPetManifest; warnings: string[] };

export interface AtlasDimensions {
  width: number;
  height: number;
}

const none = (): ManifestParseResult => ({ kind: "none" });
const invalid = (reason: string): ManifestParseResult => ({ kind: "invalid", reason });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * 解析 desktopPet 清单并校验 §5.3。返回 none 表示按无清单走 v1/v2；
 * invalid 只用于 version === 3 但清单不合法，调用方必须回退占位帧而不是再猜 v1/v2。
 */
export function parseDesktopPetManifest(
  raw: unknown,
  image: AtlasDimensions,
): ManifestParseResult {
  if (!isObject(raw)) return none();
  const desktopPet = raw.desktopPet;
  if (!isObject(desktopPet) || desktopPet.version !== DESKTOP_PET_VERSION) return none();

  const grid = desktopPet.grid;
  if (!isObject(grid)) return invalid("grid 缺失或不是对象");
  if (grid.columns !== V3_COLUMNS) {
    return invalid(`grid.columns 必须是 ${V3_COLUMNS}，实得 ${String(grid.columns)}`);
  }
  if (!isInt(grid.rows) || grid.rows <= 0) {
    return invalid(`grid.rows 必须是正整数，实得 ${String(grid.rows)}`);
  }
  if (!isInt(image.width) || !isInt(image.height) || image.width <= 0 || image.height <= 0) {
    return invalid("图集尺寸不是正整数");
  }
  if (image.width % V3_COLUMNS !== 0) {
    return invalid(`图宽 ${image.width} 不能被 ${V3_COLUMNS} 整除`);
  }
  if (image.height % grid.rows !== 0) {
    return invalid(`图高 ${image.height} 不能被 grid.rows=${grid.rows} 整除`);
  }
  if (image.width > V3_MAX_EDGE || image.height > V3_MAX_EDGE) {
    return invalid(`图集每边必须 ≤ ${V3_MAX_EDGE}，实得 ${image.width}×${image.height}`);
  }
  if (image.width * image.height * 4 > V3_MAX_DECODED_BYTES) {
    return invalid(
      `解码后 ${image.width * image.height * 4} 字节超过 ${V3_MAX_DECODED_BYTES} 字节`,
    );
  }

  const rawStates = desktopPet.states;
  if (!isObject(rawStates)) return invalid("states 缺失或不是对象");

  const states: Partial<Record<PetStateId, DesktopPetStateSpec>> = {};
  const warnings: string[] = [];
  for (const [id, value] of Object.entries(rawStates)) {
    if (!isPetStateId(id)) {
      warnings.push(`未知状态 id 已忽略: ${id}`);
      continue;
    }
    if (!isObject(value)) return invalid(`state ${id}: 不是对象`);
    const { row, frames, durationMs } = value;
    if (!isInt(row) || row < 0) return invalid(`state ${id}: row 必须是非负整数`);
    if (!isInt(frames) || frames < 1 || frames > V3_MAX_FRAMES) {
      return invalid(`state ${id}: frames 必须在 1..${V3_MAX_FRAMES}`);
    }
    if (!isInt(durationMs)) return invalid(`state ${id}: durationMs 必须是整数`);
    if (durationMs / frames < V3_MIN_FRAME_MS) {
      return invalid(`state ${id}: durationMs / frames 必须 ≥ ${V3_MIN_FRAME_MS}ms`);
    }
    if (durationMs > V3_MAX_DURATION_MS) {
      return invalid(`state ${id}: durationMs 必须 ≤ ${V3_MAX_DURATION_MS}`);
    }
    const rowEnd = row + Math.ceil(frames / V3_COLUMNS);
    if (rowEnd > grid.rows) {
      return invalid(`state ${id}: 行区间 ${row}..${rowEnd} 超出 rows=${grid.rows}`);
    }
    states[id] = { row, frames, durationMs };
  }

  if (!states.idle) return invalid("缺少 idle 状态");

  const spans = Object.entries(states)
    .map(([id, state]) => ({
      id,
      start: state.row,
      end: state.row + Math.ceil(state.frames / V3_COLUMNS),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].start < spans[i - 1].end) {
      return invalid(
        `状态行区间相交: ${spans[i - 1].id} [${spans[i - 1].start},${spans[i - 1].end}) 与 ${spans[i].id} [${spans[i].start},${spans[i].end})`,
      );
    }
  }

  return {
    kind: "v3",
    manifest: { version: 3, grid: { columns: V3_COLUMNS, rows: grid.rows }, states },
    warnings,
  };
}

/** JSON 文本入口：非法 JSON 与空文本都按“没有清单”处理。 */
export function parseDesktopPetJson(
  text: string | null | undefined,
  image: AtlasDimensions,
): ManifestParseResult {
  if (typeof text !== "string" || !text.trim()) return none();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return none();
  }
  return parseDesktopPetManifest(raw, image);
}

/** 第 k 帧所在的格：row + floor(k/16)，列 k % 16。 */
export function frameCell(
  manifest: DesktopPetManifest,
  id: PetStateId,
  k: number,
): { row: number; col: number } | null {
  const state = manifest.states[id];
  if (!state || !Number.isInteger(k) || k < 0 || k >= state.frames) return null;
  return { row: state.row + Math.floor(k / V3_COLUMNS), col: k % V3_COLUMNS };
}

/** v3 清单对应的逐状态节奏。 */
export function manifestTiming(manifest: DesktopPetManifest): SpriteTiming {
  const timing: SpriteTiming = {};
  for (const [id, state] of Object.entries(manifest.states)) {
    timing[id as PetStateId] = {
      frameSec: state.durationMs / 1000 / state.frames,
      cycleSec: state.durationMs / 1000,
    };
  }
  return timing;
}
