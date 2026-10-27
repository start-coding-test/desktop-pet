// 精灵来源只有一个：Petdex 画廊下载的图集（8 列 × 9/11 行、单元格 192×208）。
// 本模块负责把一张图集切成九个状态的多帧序列。
//
// 切出来的每一帧是「图集上的一个源矩形 + 一个单位化目标矩形」，绘制时由渲染层
// 一次性 drawImage 完成，**不再逐帧烘焙成画布**：57 帧 × (360×dpr)² 的 backing store
// 在 dpr=2 时约 118 MB，而源图集只有 12 MB 左右一份，切片本来就是 drawImage 的能力。
// 顺带一提，这么改之后 DPI 变化也不需要重烘焙（目标矩形是相对立绘边长的比例）。
//
// 图集缺失或尺寸不被识别时退回程序生成的 idle 帧，保证窗口不会是空白的。

import {
  PET_STATES,
  SPRITE_COLUMNS,
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH,
  detectSpriteAtlas,
} from "./petdex-states";
import type { PetStateId, SpriteTiming } from "./petdex-states";
import {
  V3_COLUMNS,
  frameCell,
  manifestTiming,
  parseDesktopPetJson,
  type DesktopPetManifest,
} from "./skin-manifest";

export type { PetStateId };
/** 状态词表完全等同 petdex：原来的 12 个自造状态（walk/greet/sleep/react/…）已取消 */
export type ActionName = PetStateId;

/**
 * 一帧 = 源图上的一块矩形，画到立绘方块里的某个位置。
 * n* 是相对立绘边长的单位化值（0~1），因此与 dpr、与窗口尺寸都无关。
 */
export interface SpriteFrame {
  source: CanvasImageSource;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
}

export type SpriteSet = Partial<Record<ActionName, SpriteFrame[]>>;

/** 立绘在 CSS 坐标系里的基准边长（px）；petdex 单元格按 contain 放进这个正方形 */
export const FRAME_SIZE = 360;

/** 归一化 dpr：仅用于日志与兜底路径，切片本身不需要它 */
export function deviceScale(): number {
  return Math.max(1, window.devicePixelRatio || 1);
}

/**
 * 已解码的图集源图。换一次皮肤就驻留一份（约 12 MB），所以按 LRU 限容：
 * 之前没有上限，来回切几次形象就是几十 MB 无人回收。
 * 留 2 份是为了「切回来不用重新下载解码」，而不是缓存整个装过的形象集。
 */
const MAX_ATLASES = 2;
const atlasCache = new Map<string, HTMLImageElement>();

/** pet.json 与图集同目录；超时按“没有清单”处理，不能让旧皮肤的 v1/v2 被读清单拖住。 */
export const PET_JSON_TIMEOUT_MS = 2000;

export interface LoadedSpriteSet {
  sprites: SpriteSet;
  /** v3 清单给出的逐状态节奏；v1/v2/兜底不传，状态机按 PET_STATES 现算 */
  timing?: SpriteTiming;
}

/**
 * 从图集 URL 装载九个状态的帧序列。
 * URL 由宿主 petskin 协议给出（`http://petskin.localhost/<slug>/sprite.webp`）。
 * url 为空（还没有任何皮肤）或图集不被识别时，退回程序生成的 idle 帧。
 *
 * v3 只由同目录 pet.json 的 desktopPet.version === 3 触发：
 * - 无清单 / JSON 非法 / version ≠ 3：走原来的 v1/v2 尺寸识别，行为不变
 * - version 3 但校验失败：占位帧 + console.warn 具体原因（不再猜 v1/v2）
 */
export async function loadSpriteSet(url: string): Promise<LoadedSpriteSet> {
  if (!url) return { sprites: buildProceduralSpriteSet() };
  let img: HTMLImageElement;
  let manifestText: string | null;
  try {
    [img, manifestText] = await Promise.all([loadAtlas(url), readDesktopPetJson(url)]);
  } catch (err) {
    console.warn("[pet] 图集加载失败，退回程序生成占位帧", err);
    return { sprites: buildProceduralSpriteSet() };
  }

  const parsed = parseDesktopPetJson(manifestText, {
    width: img.naturalWidth,
    height: img.naturalHeight,
  });
  if (parsed.kind === "invalid") {
    // 这张图刚刚已经解码并进了 LRU；清单无效后不会再用它，留着会白占两个缓存位之一
    atlasCache.delete(url);
    console.warn(`[pet] v3 清单无效，退回程序生成占位帧: ${parsed.reason}`);
    return { sprites: buildProceduralSpriteSet() };
  }
  if (parsed.kind === "v3") {
    warnManifestWarnings(parsed.warnings);
    return sliceAtlasV3(img, parsed.manifest);
  }

  try {
    const set = sliceAtlas(img);
    if (!set) throw new Error(`不是受支持的 petdex 图集: ${img.naturalWidth}x${img.naturalHeight}`);
    return { sprites: set };
  } catch (err) {
    console.warn("[pet] 图集加载失败，退回程序生成占位帧", err);
    return { sprites: buildProceduralSpriteSet() };
  }
}

/** 未知状态 id 只提醒一次（换回同一皮肤时不重复刷屏） */
const warnedManifestStates = new Set<string>();

function warnManifestWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    if (warnedManifestStates.has(warning)) continue;
    warnedManifestStates.add(warning);
    console.warn(`[pet] v3 清单: ${warning}`);
  }
}

/** 同目录 pet.json：默认 2 秒超时、任何失败都按“没有清单”返回 null */
export async function readDesktopPetJson(
  atlasUrl: string,
  timeoutMs = PET_JSON_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const petUrl = new URL("pet.json", new URL(atlasUrl, document.baseURI)).href;
    // 同一 slug 原地覆盖 pet.json 时不能命中 HTTP 缓存；图集本身的 LRU 仍是旧图，覆盖后需重启
    const res = await fetch(petUrl, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 图集源：真机是解码后的 <img>，回归里可以直接喂一张合成用的 canvas */
export type AtlasSource = HTMLImageElement | HTMLCanvasElement;

function sourceSize(source: AtlasSource): { width: number; height: number } {
  return source instanceof HTMLCanvasElement
    ? { width: source.width, height: source.height }
    : { width: source.naturalWidth, height: source.naturalHeight };
}

/** 按 petdex 规格把图集切成九个状态的帧（只算矩形，不生成任何画布） */
export function sliceAtlas(img: AtlasSource): SpriteSet | null {
  const { width: sw, height: sh } = sourceSize(img);
  const layout = detectSpriteAtlas(sw, sh);
  if (!layout) return null;
  const cellW = sw / SPRITE_COLUMNS;
  const cellH = sh / layout.rows;
  // petdex 单元格是 192×208（比宽更高），立绘是正方形：按长边等比放入，短边居中留边，
  // 这样点击判定/气泡定位仍能沿用正方形几何，不必为每个状态另算一套矩形
  const scale = FRAME_SIZE / Math.max(cellW, cellH);
  const nw = (cellW * scale) / FRAME_SIZE;
  const nh = (cellH * scale) / FRAME_SIZE;
  const nx = (1 - nw) / 2;
  const ny = (1 - nh) / 2;

  const set: SpriteSet = {};
  for (const state of PET_STATES) {
    const frames: SpriteFrame[] = [];
    for (let col = 0; col < state.frames; col++) {
      frames.push({
        source: img,
        sx: col * cellW,
        sy: state.row * cellH,
        sw: cellW,
        sh: cellH,
        nx,
        ny,
        nw,
        nh,
      });
    }
    set[state.id] = frames;
  }
  return set;
}

/**
 * v3 图集：16 列、行数由清单给定，状态帧按 row + floor(k/16) 跨行排列。
 * 单元格几何沿用 v1/v2 的 contain 逻辑，目标矩形仍是单位化正方形。
 */
export function sliceAtlasV3(
  img: AtlasSource,
  manifest: DesktopPetManifest,
): LoadedSpriteSet {
  const { width: sw, height: sh } = sourceSize(img);
  const cellW = sw / V3_COLUMNS;
  const cellH = sh / manifest.grid.rows;
  const scale = FRAME_SIZE / Math.max(cellW, cellH);
  const nw = (cellW * scale) / FRAME_SIZE;
  const nh = (cellH * scale) / FRAME_SIZE;
  const nx = (1 - nw) / 2;
  const ny = (1 - nh) / 2;

  const sprites: SpriteSet = {};
  for (const state of PET_STATES) {
    const spec = manifest.states[state.id];
    if (!spec) continue;
    const frames: SpriteFrame[] = [];
    for (let k = 0; k < spec.frames; k++) {
      const cell = frameCell(manifest, state.id, k);
      if (!cell) break;
      frames.push({
        source: img,
        sx: cell.col * cellW,
        sy: cell.row * cellH,
        sw: cellW,
        sh: cellH,
        nx,
        ny,
        nw,
        nh,
      });
    }
    sprites[state.id] = frames;
  }
  return { sprites, timing: manifestTiming(manifest) };
}

export function loadAtlas(url: string): Promise<HTMLImageElement> {
  // 只有解码成功过的图才会进缓存，所以命中即完成
  const cached = atlasCache.get(url);
  if (cached) {
    // 命中就重新放到末尾（Map 保持插入序，末尾即最近使用）
    atlasCache.delete(url);
    atlasCache.set(url, cached);
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      atlasCache.set(url, img);
      while (atlasCache.size > MAX_ATLASES) {
        const oldest = atlasCache.keys().next().value;
        if (oldest === undefined) break;
        atlasCache.delete(oldest);
      }
      resolve(img);
    };
    img.onerror = () => reject(new Error(`图集加载失败: ${url}`));
    img.src = url;
  });
}

/** 已经解码过的图集 URL（只读诊断）：回归用它确认换装确实在宠物窗里发生了 */
export function decodedAtlases(): string[] {
  return [...atlasCache.keys()];
}

/* ================= 程序生成兜底（仅供 idle） ================= */

// 兜底宠物的原始绘制尺寸
const PROCEDURAL_SIZE = 256;

/** 只生成 idle 一个状态的呼吸帧：图集不可用时的最后防线，不提供其余八个状态 */
export function buildProceduralSpriteSet(): SpriteSet {
  // 原来 256 的内容摆在 360 画布里约占 71%，这里用同样的占比保持视觉大小一致
  const ratio = PROCEDURAL_SIZE / FRAME_SIZE;
  const offset = (1 - ratio) / 2;
  return {
    idle: Array.from({ length: 6 }, (_, i) => ({
      source: drawProceduralFrame(i),
      sx: 0,
      sy: 0,
      sw: PROCEDURAL_SIZE,
      sh: PROCEDURAL_SIZE,
      nx: offset,
      ny: offset,
      nw: ratio,
      nh: ratio,
    })),
  };
}

function drawProceduralFrame(i: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = PROCEDURAL_SIZE;
  canvas.height = PROCEDURAL_SIZE;
  const ctx = canvas.getContext("2d")!;

  const t = (i / 6) * Math.PI * 2;
  const bodyDy = Math.sin(t) * 2;
  const squash = 1 + Math.sin(t) * 0.02;

  ctx.translate(PROCEDURAL_SIZE / 2, PROCEDURAL_SIZE / 2);
  ctx.translate(0, bodyDy);

  const bodyY = 8;
  const rx = 78;
  const ry = rx * squash;

  const body = ctx.createRadialGradient(-24, bodyY - 28, 8, 0, bodyY, rx + 6);
  body.addColorStop(0, "#ffc078");
  body.addColorStop(1, "#f5923e");
  ctx.fillStyle = body;
  ellipse(ctx, 0, bodyY, rx, ry);

  const eyeY = bodyY - 18;
  if (i === 5) {
    ctx.strokeStyle = "#5b3a12";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    for (const ex of [-28, 28]) {
      ctx.beginPath();
      ctx.moveTo(ex - 10, eyeY);
      ctx.lineTo(ex + 10, eyeY);
      ctx.stroke();
    }
  } else {
    for (const ex of [-28, 28]) {
      ctx.fillStyle = "#fff";
      ellipse(ctx, ex, eyeY, 14, 15);
      ctx.fillStyle = "#40270a";
      ellipse(ctx, ex + 4, eyeY + 2, 7, 8);
      ctx.fillStyle = "#fff";
      ellipse(ctx, ex + 6, eyeY - 2, 2.5, 2.5);
    }
  }

  ctx.fillStyle = "rgba(255, 120, 90, 0.45)";
  ellipse(ctx, -46, bodyY + 6, 10, 6);
  ellipse(ctx, 46, bodyY + 6, 10, 6);

  ctx.strokeStyle = "#5b3a12";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, bodyY + 8, 18, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  return canvas;
}

function ellipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

export { SPRITE_FRAME_HEIGHT, SPRITE_FRAME_WIDTH };
