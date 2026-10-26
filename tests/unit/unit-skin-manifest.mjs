// D01：v3 图集清单（同目录 pet.json 的 desktopPet）离线单测。
// 覆盖 §5.3 的合法/拒绝分支、帧序映射、sliceAtlasV3 几何、pet.json 读取与状态机 timing。
import { check, deep, eq, group } from "./harness.mjs";

const manifest = await import("../../src/pet/skin-manifest.ts");
const sprites = await import("../../src/pet/sprites.ts");
const { PetStateMachine } = await import("../../src/pet/state-machine.ts");
const { PET_STATES, frameSeconds } = await import("../../src/pet/petdex-states.ts");

const {
  parseDesktopPetManifest,
  parseDesktopPetJson,
  frameCell,
  manifestTiming,
  V3_MAX_DECODED_BYTES,
} = manifest;

// 2048×4096：16 列 × 8 行 → 128×512 单元格，解码后 32 MiB，落在全部上限内
const IMAGE = { width: 2048, height: 4096 };

const validManifest = () => ({
  desktopPet: {
    version: 3,
    grid: { columns: 16, rows: 8 },
    states: {
      idle: { row: 0, frames: 6, durationMs: 1200 },
      waving: { row: 1, frames: 4, durationMs: 640 },
      "running-right": { row: 2, frames: 2, durationMs: 160 },
    },
  },
});

const parse = (raw, image = IMAGE) => parseDesktopPetManifest(raw, image);

/* ============================ 触发条件：不是 v3 一律走 v1/v2 ============================ */
group("v3 清单触发条件");

{
  eq("没有 desktopPet → none", "none", parse({}).kind);
  eq("desktopPet 不是对象 → none", "none", parse({ desktopPet: [] }).kind);
  eq("version 2 → none", "none", parse({ desktopPet: { version: 2 } }).kind);
  eq("version 4 → none", "none", parse({ desktopPet: { version: 4 } }).kind);
  eq("version 是字符串 \"3\" → none", "none", parse({ desktopPet: { version: "3" } }).kind);
  eq("顶层是数组 → none", "none", parse([]).kind);
  eq("JSON 非法 → none", "none", parseDesktopPetJson("{not json", IMAGE).kind);
  eq("空文本 → none", "none", parseDesktopPetJson("", IMAGE).kind);
  eq("null 文本 → none", "none", parseDesktopPetJson(null, IMAGE).kind);
  eq("JSON null → none", "none", parseDesktopPetJson("null", IMAGE).kind);
}

/* ============================ 合法清单 ============================ */
group("v3 清单合法分支");

{
  const result = parse(validManifest());
  eq("合法清单返回 v3", "v3", result.kind);
  deep("三个状态按原样保留", result.manifest.states, {
    idle: { row: 0, frames: 6, durationMs: 1200 },
    waving: { row: 1, frames: 4, durationMs: 640 },
    "running-right": { row: 2, frames: 2, durationMs: 160 },
  });
  eq("列数固定为 16", 16, result.manifest.grid.columns);
  deep("没有未知状态时不产生警告", result.warnings, []);

  const text = JSON.stringify(validManifest());
  eq("JSON 文本入口同样识别 v3", "v3", parseDesktopPetJson(text, IMAGE).kind);

  const unknown = validManifest();
  unknown.desktopPet.states.dancing = { row: 3, frames: 2, durationMs: 160 };
  const unknownResult = parse(unknown);
  eq("未知状态 id 不导致清单失效", "v3", unknownResult.kind);
  eq("未知状态被忽略", undefined, unknownResult.manifest.states.dancing);
  deep("未知状态给出一次警告文案", unknownResult.warnings, ["未知状态 id 已忽略: dancing"]);
  eq("已知状态不受未知状态影响", 6, unknownResult.manifest.states.idle.frames);
}

/* ============================ §5.3 逐条拒绝 ============================ */
group("v3 清单校验拒绝");

{
  const reject = (name, mutate, image = IMAGE, includes = "") => {
    const raw = validManifest();
    mutate(raw.desktopPet);
    const result = parse(raw, image);
    eq(name, "invalid", result.kind);
    if (includes) {
      check(`${name}（文案含 ${includes}）`, String(result.reason).includes(includes), result.reason);
    }
  };

  reject("grid 缺失", (dp) => delete dp.grid, IMAGE, "grid");
  reject("grid.columns 不是 16", (dp) => (dp.grid.columns = 8), IMAGE, "columns");
  reject("grid.rows 为 0", (dp) => (dp.grid.rows = 0), IMAGE, "rows");
  reject("grid.rows 不是整数", (dp) => (dp.grid.rows = 2.5), IMAGE, "rows");
  reject(
    "图宽不能被 16 整除",
    () => {},
    { width: 2049, height: 4096 },
    "整除",
  );
  reject(
    "图高不能被 rows 整除",
    () => {},
    { width: 2048, height: 4095 },
    "整除",
  );
  reject("每边超过 8192", () => {}, { width: 8208, height: 4096 }, "8192");
  reject(
    "解码后超过 128 MiB",
    () => {},
    { width: 8192, height: 8192 },
    "字节",
  );
  reject("states 缺失", (dp) => delete dp.states, IMAGE, "states");
  reject("状态 row 为负", (dp) => (dp.states.idle.row = -1), IMAGE, "row");
  reject("frames 为 0", (dp) => (dp.states.idle.frames = 0), IMAGE, "frames");
  reject("frames 超过 64", (dp) => (dp.states.idle.frames = 65), IMAGE, "frames");
  reject("durationMs 不是整数", (dp) => (dp.states.idle.durationMs = 1200.5), IMAGE, "durationMs");
  reject(
    "durationMs / frames 小于 16ms",
    (dp) => (dp.states.idle.durationMs = 95),
    IMAGE,
    "16ms",
  );
  reject(
    "durationMs 超过 20000",
    (dp) => (dp.states.idle.durationMs = 20001),
    IMAGE,
    "20000",
  );
  reject(
    "行区间超出 grid.rows",
    (dp) => (dp.states.waving = { row: 7, frames: 17, durationMs: 400 }),
    IMAGE,
    "超出",
  );
  reject(
    "两个状态行区间相交",
    (dp) => {
      dp.states.idle = { row: 0, frames: 17, durationMs: 400 };
      dp.states.waving = { row: 1, frames: 1, durationMs: 32 };
    },
    IMAGE,
    "相交",
  );
  reject(
    "两个状态共用同一行（重叠）",
    (dp) => {
      dp.states.idle = { row: 0, frames: 1, durationMs: 32 };
      dp.states.waving = { row: 0, frames: 8, durationMs: 256 };
    },
    IMAGE,
    "相交",
  );
  reject(
    "缺少 idle",
    (dp) => {
      delete dp.states.idle;
    },
    IMAGE,
    "idle",
  );
  reject(
    "状态值不是对象",
    (dp) => (dp.states.idle = 42),
    IMAGE,
    "idle",
  );
}

{
  const adjacent = validManifest();
  adjacent.desktopPet.states.idle = { row: 0, frames: 16, durationMs: 512 };
  adjacent.desktopPet.states.waving = { row: 1, frames: 1, durationMs: 32 };
  eq("行区间相邻（前一状态占满整行）合法", "v3", parse(adjacent).kind);
}

{
  // 每条数值规则的边界值都应有通过用例
  const edge = {
    desktopPet: {
      version: 3,
      grid: { columns: 16, rows: 8 },
      states: {
        idle: { row: 0, frames: 6, durationMs: 96 }, // durationMs / frames 正好 16
        waving: { row: 1, frames: 64, durationMs: 20000 }, // frames 与 durationMs 上限
        jumping: { row: 7, frames: 1, durationMs: 32 }, // frames 下限，且末行正好用满
      },
    },
  };
  const edgeImage = { width: 8192, height: 4096 }; // 每边上限；8192×4096×4 正好 128 MiB
  eq("边界值全部通过", "v3", parse(edge, edgeImage).kind);
  eq("图片正好 128 MiB 时放行", 128 * 1024 * 1024, edgeImage.width * edgeImage.height * 4);
}

/* ============================ 帧序：row + floor(k/16)，列 k%16 ============================ */
group("v3 帧序");

{
  const raw = {
    desktopPet: {
      version: 3,
      grid: { columns: 16, rows: 8 },
      states: {
        idle: { row: 2, frames: 64, durationMs: 1024 },
        waving: { row: 7, frames: 1, durationMs: 32 },
      },
    },
  };
  const result = parse(raw);
  eq("64 帧清单合法", "v3", result.kind);
  deep("第 1 帧在第 2 行第 0 列", frameCell(result.manifest, "idle", 0), { row: 2, col: 0 });
  deep("第 16 帧仍在第 2 行第 15 列", frameCell(result.manifest, "idle", 15), { row: 2, col: 15 });
  deep("第 17 帧跨到第 3 行第 0 列", frameCell(result.manifest, "idle", 16), { row: 3, col: 0 });
  deep("第 18 帧在第 3 行第 1 列", frameCell(result.manifest, "idle", 17), { row: 3, col: 1 });
  deep("第 64 帧在第 5 行第 15 列", frameCell(result.manifest, "idle", 63), { row: 5, col: 15 });
  eq("越界帧号返回 null", null, frameCell(result.manifest, "idle", 64));
  eq("负帧号返回 null", null, frameCell(result.manifest, "idle", -1));
  eq("小数帧号返回 null", null, frameCell(result.manifest, "idle", 1.5));
  eq("清单外的状态返回 null", null, frameCell(result.manifest, "review", 0));
}

/* ============================ timing：整行时长 / 帧数 ============================ */
group("v3 timing");

{
  const result = parse(validManifest());
  const timing = manifestTiming(result.manifest);
  check(
    "idle 帧间隔 = 1200ms / 6",
    Math.abs(timing.idle.frameSec - 0.2) < 1e-12,
    `actual=${timing.idle.frameSec}`,
  );
  check(
    "idle 整轮时长 = 1200ms",
    Math.abs(timing.idle.cycleSec - 1.2) < 1e-12,
    `actual=${timing.idle.cycleSec}`,
  );
  check(
    "waving 帧间隔 = 640ms / 4",
    Math.abs(timing.waving.frameSec - 0.16) < 1e-12,
    `actual=${timing.waving.frameSec}`,
  );
  check(
    "waving 整轮时长 = 640ms",
    Math.abs(timing.waving.cycleSec - 0.64) < 1e-12,
    `actual=${timing.waving.cycleSec}`,
  );
  eq("只包含清单里的状态", undefined, timing.review);
}

/* ============================ sliceAtlasV3 几何 ============================ */
group("v3 切片几何");

{
  const raw = {
    desktopPet: {
      version: 3,
      grid: { columns: 16, rows: 8 },
      states: {
        idle: { row: 2, frames: 64, durationMs: 1024 },
        waving: { row: 7, frames: 1, durationMs: 32 },
      },
    },
  };
  const parsed = parse(raw);
  // Node 里没有 DOM：sliceAtlasV3 只读 width/height，用同名构造器冒充 canvas 即可
  const RealCanvas = globalThis.HTMLCanvasElement;
  globalThis.HTMLCanvasElement = class {};
  try {
    const canvas = Object.assign(new globalThis.HTMLCanvasElement(), { width: 2048, height: 4096 });
    const { sprites: set, timing } = sprites.sliceAtlasV3(canvas, parsed.manifest);
    eq("idle 切出 64 帧", 64, set.idle.length);
    eq("waving 切出 1 帧", 1, set.waving.length);
    eq("清单外的状态不伪造帧", undefined, set.review);

    const cellW = 2048 / 16;
    const cellH = 4096 / 8;
    const at = (frame) => ({
      sx: Math.round(frame.sx / cellW),
      sy: Math.round(frame.sy / cellH),
    });
    deep("第 1 帧取自 row2/col0", at(set.idle[0]), { sx: 0, sy: 2 });
    deep("第 16 帧取自 row2/col15", at(set.idle[15]), { sx: 15, sy: 2 });
    deep("第 17 帧取自 row3/col0", at(set.idle[16]), { sx: 0, sy: 3 });
    deep("第 64 帧取自 row5/col15", at(set.idle[63]), { sx: 15, sy: 5 });
    deep("waving 取自 row7/col0", at(set.waving[0]), { sx: 0, sy: 7 });

    check(
      "所有帧共用同一份源图",
      [...set.idle, ...set.waving].every((frame) => frame.source === canvas),
      "存在帧指向了别的源图",
    );
    eq("源矩形宽 = 单元格宽", cellW, set.idle[0].sw);
    eq("源矩形高 = 单元格高", cellH, set.idle[0].sh);
    // 128×512 的单元格 contain 进 360 正方形：宽 0.25、高 1、水平居中
    eq("目标矩形宽按长边缩放", 0.25, set.idle[0].nw);
    eq("目标矩形高占满", 1, set.idle[0].nh);
    eq("目标矩形水平居中", 0.375, set.idle[0].nx);
    eq("目标矩形垂直居中", 0, set.idle[0].ny);
    check(
      "timing 随切片一起返回",
      Math.abs(timing.idle.frameSec - 0.016) < 1e-12,
      `actual=${timing.idle.frameSec}`,
    );
    check(
      "timing 的整轮时长来自清单",
      Math.abs(timing.idle.cycleSec - 1.024) < 1e-12,
      `actual=${timing.idle.cycleSec}`,
    );
  } finally {
    if (RealCanvas === undefined) delete globalThis.HTMLCanvasElement;
    else globalThis.HTMLCanvasElement = RealCanvas;
  }

  eq("上限常量是 128 MiB", 128 * 1024 * 1024, V3_MAX_DECODED_BYTES);
}

/* ============================ pet.json 读取：同目录 / 2 秒超时 ============================ */
group("pet.json 读取");

{
  eq("默认读取超时是 2 秒", 2000, sprites.PET_JSON_TIMEOUT_MS);
  const realFetch = globalThis.fetch;
  const realDocument = globalThis.document;
  try {
    globalThis.document = { baseURI: "http://tauri.localhost/" };
    let seen = "";
    globalThis.fetch = async (url) => {
      seen = String(url);
      return { ok: true, text: async () => '{"desktopPet":{"version":3}}' };
    };
    const text = await sprites.readDesktopPetJson(
      "http://petskin.localhost/skin-a/sprite.webp",
    );
    eq("读取同目录的 pet.json", "http://petskin.localhost/skin-a/pet.json", seen);
    eq("返回原始 JSON 文本", '{"desktopPet":{"version":3}}', text);

    globalThis.fetch = async () => ({ ok: false, text: async () => "not found" });
    eq("404 按无清单处理", null, await sprites.readDesktopPetJson("http://petskin.localhost/a/sprite.webp"));

    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    eq("网络错误按无清单处理", null, await sprites.readDesktopPetJson("http://petskin.localhost/a/sprite.webp"));

    eq("无法解析的图集地址按无清单处理", null, await sprites.readDesktopPetJson("http://[", 30));

    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const started = Date.now();
    const timedOut = await sprites.readDesktopPetJson("http://petskin.localhost/a/sprite.webp", 30);
    const elapsed = Date.now() - started;
    eq("超时按无清单处理", null, timedOut);
    check("超时等到配置的时限才放弃", elapsed >= 25, `elapsed=${elapsed}ms`);
  } finally {
    globalThis.fetch = realFetch;
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
}

/* ============================ 状态机：timing 影响帧间隔与手势 dwell ============================ */
group("状态机 timing");

const frames = (n) =>
  Array.from({ length: n }, (_, i) => ({
    source: {},
    sx: i,
    sy: 0,
    sw: 1,
    sh: 1,
    nx: 0,
    ny: 0,
    nw: 1,
    nh: 1,
  }));

const timingSet = () => ({
  idle: frames(4),
  waving: frames(4),
  jumping: frames(4),
  failed: frames(4),
  "running-right": frames(4),
  "running-left": frames(4),
  running: frames(4),
  review: frames(4),
  waiting: frames(4),
});

{
  const sm = new PetStateMachine(timingSet());
  sm.request("waving");
  sm.update(0.69);
  eq("v1/v2 不传 timing 时 waving 仍按表里的 700ms 停留", "waving", sm.action);
  sm.update(0.02);
  eq("到表里的 dwell 后回落 idle", "idle", sm.action);
}

{
  const sm = new PetStateMachine(timingSet(), {
    waving: { frameSec: 0.01, cycleSec: 2 },
  });
  sm.request("waving");
  sm.update(1.9);
  eq("清单给的 cycleSec=2 还没到点", "waving", sm.action);
  sm.update(0.2);
  eq("到清单的 dwell 后回落 idle", "idle", sm.action);
}

{
  const sm = new PetStateMachine(timingSet(), {
    idle: { frameSec: 0.1, cycleSec: 1 },
  });
  eq("新状态机从第 1 帧开始", 0, sm.frame.sx);
  sm.update(0.05);
  eq("未到清单的帧间隔时停在原帧", 0, sm.frame.sx);
  sm.update(0.06);
  eq("到清单的帧间隔后推进一帧", 1, sm.frame.sx);
}

{
  const sm = new PetStateMachine(timingSet());
  sm.update(0.1);
  eq("v1/v2 的 idle 按表值 1100/6ms 推进：100ms 时还没换帧", 0, sm.frame.sx);
  sm.update(0.1);
  eq("v1/v2 的 idle 到表值间隔后换帧", 1, sm.frame.sx);
}

{
  const sm = new PetStateMachine(timingSet());
  sm.request("waving");
  sm.update(0.6);
  eq("换帧表前 waving 仍在", "waving", sm.action);
  sm.setSprites(timingSet(), { waving: { frameSec: 0.01, cycleSec: 2 } });
  sm.update(1.0);
  eq("setSprites 后按新 cycleSec 重算 dwell（1.6s 时仍不结束）", "waving", sm.action);
  sm.update(0.5);
  eq("setSprites 后到新 dwell 才回落", "idle", sm.action);
}

{
  const sm = new PetStateMachine(timingSet());
  sm.update(0.1);
  eq("换帧表前 idle 100ms 不换帧", 0, sm.frame.sx);
  sm.setSprites(timingSet(), { idle: { frameSec: 0.02, cycleSec: 1 } });
  eq("setSprites 后帧序重置到第 1 帧", 0, sm.frame.sx);
  sm.update(0.03);
  eq("setSprites 后按新 frameSec 推进", 1, sm.frame.sx);
}

{
  const sm = new PetStateMachine(timingSet(), {
    idle: { frameSec: 0.01, cycleSec: 1 },
  });
  sm.update(0.015);
  eq("带 timing 时 idle 按 10ms 间隔推进", 1, sm.frame.sx);
  sm.setSprites(timingSet());
  eq("换回无 timing 的帧表后仍保持当前状态", "idle", sm.action);
  eq("换回无 timing 后帧回到第一帧", 0, sm.frame.sx);
  sm.update(0.1);
  eq("换回无 timing 后 idle 帧间隔恢复表值（100ms 不换帧）", 0, sm.frame.sx);
  sm.update(0.09);
  eq("换回无 timing 后到表值间隔（约 183ms）换帧", 1, sm.frame.sx);
}

{
  // 验收：v1 → v3 → v1，waving 的帧间隔与 dwell 依次回到各自素材
  const v1Set = timingSet();
  const v3Set = timingSet();
  v3Set.waving = frames(12);
  const sm = new PetStateMachine(v1Set);
  sm.request("waving");
  sm.update(0.65);
  eq("v1 waving 的 dwell 是表值 700ms", "waving", sm.action);
  sm.update(0.06);
  eq("v1 710ms 回落 idle", "idle", sm.action);
  const smV1 = new PetStateMachine(v1Set);
  smV1.request("waving");
  smV1.update(0.15);
  eq("v1 waving 帧间隔 175ms：150ms 不换帧", 0, smV1.frame.sx);
  smV1.update(0.04);
  eq("v1 waving 到 190ms 换帧", 1, smV1.frame.sx);

  sm.setSprites(v3Set, { waving: { frameSec: 0.05, cycleSec: 0.6 } });
  sm.request("waving");
  sm.update(0.55);
  eq("切到 v3 后 waving dwell 用清单 cycleSec=0.6（550ms 仍在）", "waving", sm.action);
  sm.update(0.06);
  eq("v3 610ms 回落 idle", "idle", sm.action);
  const smV3 = new PetStateMachine(v3Set, { waving: { frameSec: 0.05, cycleSec: 0.6 } });
  smV3.request("waving");
  smV3.update(0.04);
  eq("v3 waving 帧间隔 50ms：40ms 不换帧", 0, smV3.frame.sx);
  smV3.update(0.02);
  eq("v3 60ms 换到下一帧", 1, smV3.frame.sx);

  sm.setSprites(v1Set);
  sm.request("waving");
  sm.update(0.65);
  eq("换回 v1 后 waving 恢复表值 700ms", "waving", sm.action);
  sm.update(0.06);
  eq("换回 v1 后 710ms 回落 idle", "idle", sm.action);
  const smBack = new PetStateMachine(v1Set);
  smBack.request("waving");
  smBack.update(0.15);
  eq("换回 v1 后 waving 帧间隔恢复 175ms", 0, smBack.frame.sx);
  smBack.update(0.04);
  eq("换回 v1 后 190ms 换帧", 1, smBack.frame.sx);
}

{
  // v1/v2 不传 timing：九个状态的默认帧间隔逐项等于 frameSeconds(PET_STATES)
  const set = timingSet();
  const observed = [];
  for (const state of PET_STATES) {
    const sm = new PetStateMachine(set);
    if (state.id !== "idle") sm.request(state.id);
    const interval = frameSeconds(state);
    sm.update(interval * 0.9);
    const before = sm.frame.sx;
    sm.update(interval * 0.2);
    observed.push(`${state.id}:${before}->${sm.frame.sx}`);
  }
  check(
    "九个状态的默认帧间隔都与 PET_STATES.frameSeconds 一致",
    observed.every((item) => item.endsWith(":0->1")),
    observed.join(","),
  );
}
