import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { loadSpriteSet, FRAME_SIZE, type SpriteSet } from "./pet/sprites";
import { activeSkin } from "./pet/skins";
import { PetStateMachine, type PokeZone } from "./pet/state-machine";
import { pickLine } from "./pet/dialogue";
import { registerPetController } from "./pet/host";
import { installClickThrough } from "./pet/click-through";
import { installGameMode } from "./pet/game-mode";
import { initRuntime } from "./runtime/plugin-runtime";
import "./styles.css";

const canvas = document.querySelector<HTMLCanvasElement>("#pet-canvas")!;
const ctx = canvas.getContext("2d")!;
const bubble = document.querySelector<HTMLDivElement>("#pet-bubble")!;
const petWindow = getCurrentWindow();

/** 立绘绘制缩放：窗口 360，角色视觉约 266 CSS px */
const SPRITE_SCALE = 0.74;
/** 立绘在 CSS 坐标系里的边长。帧按 FRAME_SIZE×dpr 烘焙，绘制时按此边长贴图 */
const SPRITE_CSS = Math.round(FRAME_SIZE * SPRITE_SCALE);
/** 呼吸/轻摆/抖动的最大位移，脏矩形按它留边 */
const MOTION_MARGIN = 12;

let pet: PetStateMachine;
let sprites: SpriteSet;
let skinUrl: string | null = null;

function fitCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 改 width 会连带重置绘图状态，所以每次都要重设：
  // 帧现在是从 192×208 的单元格直接放大，采样质量决定它糊不糊
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
}

/** 立绘矩形（CSS px）——点击判定、点击穿透、气泡/徽标定位共用同一份几何 */
function spriteRect(): { left: number; top: number; size: number } {
  return {
    left: Math.round(window.innerWidth / 2 - SPRITE_CSS / 2),
    top: Math.round(window.innerHeight / 2 - SPRITE_CSS / 2),
    size: SPRITE_CSS,
  };
}

/** 把几何写进 CSS 变量，避免徽标/气泡各自硬编像素而互相漂移 */
function syncLayout(): void {
  const { left, top, size } = spriteRect();
  const style = document.documentElement.style;
  style.setProperty("--pet-size", `${size}px`);
  style.setProperty("--pet-left", `${left}px`);
  style.setProperty("--pet-badge-bottom", `${Math.round(window.innerHeight - (top + size * 0.6))}px`);
  style.setProperty("--pet-bubble-bottom", `${Math.round(window.innerHeight - top - 8)}px`);
}

/* ---------- 气泡槽：常驻状态行 + 台词（B3） ---------- */
// 一个槽、两种内容。常驻行按 pluginId 各占一条（有序表，界面显示最近设置的那条）；台词插进来时
// 临时占用槽，3.6s 后回位到常驻行（ADR-0003 修订）—— 台词期间常驻行只是被替换，不是被清除。
const BUBBLE_HOLD_MS = 3600;
/** pluginId → 该插件的常驻行。Map 的插入序就是「最近设置」的顺序：重设要 delete + set 挪到队尾 */
const statusLines = new Map<string, string>();
/** 正在显示的台词；null = 此刻没台词占着槽 */
let ephemeral: string | null = null;
let bubbleTimer: number | undefined;

/** 此刻该显示的常驻行：最近设置的那条（一条都没有就是 null） */
function statusLine(): string | null {
  let last: string | null = null;
  for (const text of statusLines.values()) last = text;
  return last;
}

/**
 * 唯一的渲染口：槽里显示什么只有这里说了算。
 * 一律走 `textContent`（绝不碰 innerHTML）—— 插件交上来的是文本，不是标记（传 `<b>x</b>` 就显示这几个字符）。
 * 只有常驻行时挂 `.status`（CSS 单行化 + 省略号）：台词可以折行，常驻行不许。
 */
function renderBubble(): void {
  const text = ephemeral ?? statusLine();
  bubble.classList.toggle("status", ephemeral === null && text !== null);
  if (text === null) {
    bubble.textContent = "";
    bubble.classList.remove("show");
    return;
  }
  bubble.textContent = text;
  bubble.classList.add("show");
}

/** 弹一句台词：临时占用槽，到点回位到常驻行 */
function say(text: string): void {
  if (!text) return;
  ephemeral = text;
  renderBubble();
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => {
    ephemeral = null;
    renderBubble(); // 回位：常驻行还在就显示它，都清了就收起
  }, BUBBLE_HOLD_MS);
}

/** 宿主自己的随机台词让路：挂着常驻行时不弹（用户主动触发的台词照旧走 `say`） */
function sayRandom(text: string): void {
  if (statusLine() !== null) return;
  say(text);
}

/** 插件面 `ctx.pet.setStatus` 的落点：按 pluginId 增删自己那条，然后把槽重画一次 */
function setStatus(pluginId: string, text: string | null): string | null {
  if (text === null) {
    statusLines.delete(pluginId);
  } else if (statusLines.get(pluginId) !== text) {
    // delete + set：重设要把这条挪到队尾，「最近设置的那条」才认得出来。
    // **内容没变就不动顺序**（幂等）—— 否则插件高频重设同一个值就能一直占着队首，
    // 把别的插件的行永久压在下面，那是刷而不是状态更新。
    statusLines.delete(pluginId);
    statusLines.set(pluginId, text);
  }
  renderBubble(); // 正在显示的台词不受影响：ephemeral 非空时它照旧占着槽
  return text;
}

/* ---------- 交互：按住拖拽 vs 戳一戳 ---------- */
// 按下后移动超过阈值才启动系统级拖拽（拖拽会吞掉后续鼠标事件），
// 否则抬起视为「戳一戳」：按部位触发反应 + 台词气泡
let press: { x: number; y: number } | null = null;
let dragEngaged = false;

function insideSprite(clientX: number, clientY: number): boolean {
  const r = spriteRect();
  return clientX >= r.left && clientX <= r.left + r.size && clientY >= r.top && clientY <= r.top + r.size;
}

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY };
  dragEngaged = false;
});

document.addEventListener("mousemove", (e) => {
  document.documentElement.classList.toggle("over-pet", insideSprite(e.clientX, e.clientY));
  // 系统级拖拽会吃掉抬起事件，mouseup 常常收不到：按键已经松开就说明这趟拖完了。
  // 不补这一下的话 dragEngaged 永远挂着，穿透再也不会开启，宠物整块挡鼠标。
  if (dragEngaged && e.buttons === 0) {
    resetPress();
    return;
  }
  if (!press || dragEngaged) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 6) {
    dragEngaged = true;
    void petWindow.startDragging();
  }
});

// 按下后指针移出窗口、或在窗口外抬起、或失焦：都必须复位，否则 press 会一直挂着
window.addEventListener("blur", resetPress);
document.addEventListener("mouseleave", resetPress);
document.addEventListener("mouseup", (e) => {
  const wasPress = press !== null;
  const wasDrag = dragEngaged;
  const clientX = e.clientX;
  const clientY = e.clientY;
  const dozing = pet?.action === "waiting";
  resetPress();
  if (!wasPress || wasDrag || e.button !== 0 || !pet) return;
  // 只认落在立绘范围内的一击（原来纵向一条带子无限宽，点窗口角落也会戳到角色）
  if (!insideSprite(clientX, clientY)) return;
  const action = pet.poke(hitZone(clientY));
  // 从 waiting 唤醒时配醒来的台词，而不是普通反应
  say(pickLine(dozing && action === "waving" ? "wake" : action));
});

function resetPress(): void {
  press = null;
  dragEngaged = false;
}

function hitZone(clientY: number): PokeZone {
  const { top, size } = spriteRect();
  const ny = (clientY - top) / size;
  if (ny > 0.8) return "tail";
  if (ny < 0.5) return "head";
  return "belly";
}

/* ---------- 皮肤：从宿主取当前 Petdex 图集并按 dpr 烘焙 ---------- */

/** 宿主没有可用皮肤（尚未安装/正在下载）时返回 null，渲染层用程序生成兜底帧 */
async function fetchActiveSkin(): Promise<string | null> {
  try {
    const skin = await activeSkin();
    return skin?.url ?? null;
  } catch (err) {
    console.warn("[pet] 读取当前皮肤失败", err);
    return null;
  }
}

/** 换皮肤时重新切片，动作与时间轴保持不变。
 * 帧不再按 dpr 烘焙（源矩形直接 drawImage），所以改系统缩放只需要重设画布，见 watchDpr。
 * 换肤事件可能与别的触发交错：只有最后一次调用可以生效，
 * 否则先发起的那次带着旧图集回来会更晚落地，把新皮肤盖回旧帧。 */
let skinSeq = 0;
async function applySkin(url: string | null): Promise<void> {
  const seq = ++skinSeq;
  skinUrl = url;
  const next = await loadSpriteSet(url ?? "");
  if (seq !== skinSeq) return;
  sprites = next.sprites;
  pet?.setSprites(sprites, next.timing);
  fitCanvas();
}

/* ---------- 渲染循环 ---------- */
let last = performance.now();
let rafId = 0;

function tick(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  pet.update(dt);

  const { left, top, size } = spriteRect();
  const cx = left + size / 2;
  const cy = top + size / 2;
  // 呼吸浮动（wm-breathe 的 canvas 版）
  const bob = Math.sin((now / 1000) * ((Math.PI * 2) / 3.4)) * 3;
  // 轻摆（wm-sway：±1.2°）
  const sway = Math.sin((now / 1000) * ((Math.PI * 2) / 2.6)) * (1.2 * Math.PI) / 180;
  // 姿势切换弹跳淡入（wm-pose-in 风格）
  const k = Math.min(1, (now - pet.lastSwitchAt) / 180);
  const pop = 1 + 0.05 * (1 - k);
  // 尾巴反应抖动（wm-shake）
  const shake = now < pet.shakeUntil ? Math.sin(now / 26) * 2.5 : 0;

  // 脏矩形：立绘范围 + 位移余量。原来每帧清整窗（360²），其中大部分永远是透明空白
  const box = size / 2 + MOTION_MARGIN;
  ctx.clearRect(cx - box, cy - box, box * 2, box * 2);
  ctx.save();
  ctx.globalAlpha = 0.35 + 0.65 * k;
  ctx.translate(cx + shake, cy + bob);
  ctx.rotate(sway);
  if (k < 1) ctx.scale(pop, pop); // 弹跳结束后不再重采样
  // 帧是「图集上的一块源矩形 + 单位化目标矩形」：直接从源图切片，
  // 不再为每一帧留一张烘焙画布（dpr=2 时那是约 118 MB）
  const f = pet.frame;
  ctx.drawImage(
    f.source,
    f.sx,
    f.sy,
    f.sw,
    f.sh,
    -size / 2 + f.nx * size,
    -size / 2 + f.ny * size,
    f.nw * size,
    f.nh * size,
  );
  ctx.restore();

  rafId = requestAnimationFrame(tick);
}

let stopThrough: (() => void) | null = null;
let idleChat = 0;

/** 可见时才需要跑的辅助循环：hit-test 光标轮询 + 偶尔自言自语 */
function startAux(): void {
  if (!stopThrough) stopThrough = installClickThrough({ spriteRect, isDragging: () => dragEngaged });
  if (!idleChat) {
    idleChat = window.setInterval(() => {
      if (pet.action === "idle" && Math.random() < 0.4) sayRandom(pickLine("idle"));
    }, 45_000);
  }
}

function stopAux(): void {
  stopThrough?.();
  stopThrough = null;
  if (idleChat) {
    window.clearInterval(idleChat);
    idleChat = 0;
  }
}

/** 窗口最小化/隐藏时停掉动画，回到可见再续 */
function setRunning(running: boolean): void {
  if (running) {
    startAux();
    if (!rafId) {
      last = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  } else {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    // 隐藏时把光标轮询与闲聊定时器也掐掉：没人看见的东西不该还在花钱
    stopAux();
  }
}

/** matchMedia 的 once 监听只会响一次，响应后要按新的 dpr 重新挂一条 */
function watchDpr(): void {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener(
    "change",
    () => {
      // 帧是源矩形切片，与 dpr 无关：改缩放只需要按新的 devicePixelRatio 重设画布
      fitCanvas();
      watchDpr();
    },
    { once: true },
  );
}

async function init(): Promise<void> {
  fitCanvas();
  syncLayout();
  skinUrl = await fetchActiveSkin();
  const loaded = await loadSpriteSet(skinUrl ?? "");
  sprites = loaded.sprites;
  pet = new PetStateMachine(sprites, loaded.timing);
  pet.onSleep = () => sayRandom(pickLine("waiting"));

  registerPetController({
    react: (action) => pet.request(action),
    say: (text) => say(text),
    setStatus,
  });

  void initRuntime();
  setRunning(true);
  void installGameMode({ pause: () => setRunning(false), resume: () => setRunning(true) });

  // 设置窗安装/切换皮肤后由宿主广播，宠物窗无需重启即可换形象
  void listen("pet:skin-changed", () => {
    void (async () => {
      const url = await fetchActiveSkin();
      if (url !== skinUrl) await applySkin(url);
    })();
  });

  window.addEventListener("resize", () => {
    fitCanvas();
    syncLayout();
  });
  // dpr 变化（换显示器 / 改系统缩放）靠这条媒体查询感知，resize 事件不一定触发
  watchDpr();
  document.addEventListener("visibilitychange", () => setRunning(!document.hidden));
  window.setTimeout(() => sayRandom(pickLine("waving")), 700);
}

void init();
