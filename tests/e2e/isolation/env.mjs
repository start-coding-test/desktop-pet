// 环境常量、路径与纯工具（原 verify-isolation.mjs 顶层 41-78 / 84 / 165-202 / 244-255 / 272-285）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv, env } from "node:process";
import { hostInvoke } from "../harness/cdp.mjs";
import { PROBE_ID } from "../harness/fixtures.mjs";

// 模块已从 tests/e2e/ 搬进 tests/e2e/isolation/：相对路径基准显式钉在上一层，避免 dirname 深一层解析错目录
const E2E_DIR = resolve(import.meta.dirname, "..");

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const PLUGINS_DIR = resolve(E2E_DIR, "../../plugins");
// 没有 APPDATA 时 join('', ...) 会把存储路径指到 cwd 下的相对路径，
// 「文件不在」会被读成「隔离没生效」—— 这类失败必须当场拒绝开跑
if (!env.APPDATA) {
  console.error("缺 APPDATA 环境变量：定位不到插件存储目录，拒绝开跑。");
  process.exit(2);
}
// store.rs 落在 app_data_dir()/plugins/<id>/；Windows 上 app_data_dir = %APPDATA%/<identifier>
const STORE_DIR = join(env.APPDATA, "com.desktoppet.pet", "plugins", PROBE_ID);
// A31：热键设置的真实落盘位置与本轮 E2E 的隔离位置。真实文件只取 sha256/是否存在，
// 绝不读内容；内容检查只针对 PET_SETTINGS_DIR 下的副本。
const REAL_SETTINGS = join(env.APPDATA, "com.desktoppet.pet", "settings.json");
const E2E_SETTINGS = env.PET_SETTINGS_DIR ? join(env.PET_SETTINGS_DIR, "settings.json") : null;
function fileSha256OrNull(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}
function readE2eHotkey() {
  if (!E2E_SETTINGS) return "未设 PET_SETTINGS_DIR";
  try {
    return JSON.parse(readFileSync(E2E_SETTINGS, "utf8")).hotkey ?? "缺 hotkey 字段";
  } catch (err) {
    return `读不到/坏 JSON: ${String(err?.message ?? err).split("\n")[0].slice(0, 120)}`;
  }
}
const probeManifest = (permissions) =>
  `{ id: ${JSON.stringify(PROBE_ID)}, widget: 'widget.js', permissions: ${JSON.stringify(permissions)} }`;
const MOUNT_BARE = `window.__wh.mount(${probeManifest([])}, 'badge')`;
// 正向对照挂 overlay 而不是 settings：S3 之后 settings 区一律进 Worker，而这份探针的 widget
// 是照宿主 realm 写的（要读 window.__probes、要试 `(0,eval)`），被点名留在宿主 realm 的
// 例外通道对那一区已不生效。这条对照组验的是「声明了能力就放行」，与区无关，
// 所以换一个仍认例外名单的区；settings 区自己的取证在「agent:hooks 受控能力」那组（Worker 契约）。
const MOUNT_CAPPED = `window.__wh.mount(${probeManifest(["bus:publish", "bus:subscribe"])}, 'overlay', document.body)`;
const invoke = (c) => hostInvoke(c);
const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const DENY_TEXT = "本次已拒绝，关闭插件再开启后可再次申请";
const STOP_TEXT = "插件已停用，授权请求已取消";
/**
 * D09 两个新口径，都写死成常量，别散在各调用点：
 * - `DENY_LOCK_SETTLE_MS=5_000`：拒绝锁应当**立刻**把 false 交回调用方；给 5s 而不是 3s 是卡面口径
 *   （成功路径零成本，只有实现真的坏了才会等满），超时用哨兵，不再靠 CDP 的 20 秒硬超时打断整组。
 * - `OBSERVE_MS=1_200`：「不该出现窗」的最小观察期（6 倍扫描间隔）。窗是异步建的，几百毫秒后才落位，
 *   只扫一次等于没扫 —— W-1 的不可证伪就出在这儿。
 */
const DENY_LOCK_SETTLE_MS = 5_000;
const OBSERVE_MS = 1_200;

/**
 * `reportError` 的 console 行落在哪个文件 —— **只钉文件，不钉行号**。
 * 2026-11-01 实红：t3 重排 `src/runtime/plugin-runtime.ts` 后该行从 :166 漂到 :212，
 * 窗口切片整段变空（窗口 D/E 四条集体期望 1 实得 0），而发射点语义其实没变。
 * 判据仍要求同一个文件 + 同一个文案（见 denyText），只是不再被无关编辑打断。
 */
const RUNTIME_REPORT_SITE = /src\/runtime\/plugin-runtime\.ts:\d+/;

/**
 * D07 C6 + D09-D4 第 6 条：一行 noise 算不算「本卡该核销的运行时拒绝/停用噪音」。
 * 两种形状都必须认，只认 `plugin-runtime.ts` 的那一版对
 * `Uncaught (in promise) HostError: … @ plugin-worker-protocol.ts` 是瞎的（D09 第一轮就是这样盲绿的）：
 *  - `reportError` 的 console 行（发射点固定在 plugin-runtime.ts，行号会随编辑漂移）
 *  - Worker RPC 里未捕获的 HostError 回包（plugin-worker-protocol.ts）
 * 纯函数、只吃 noise 行数组，好让套件里能用日志原文自测它（下面两条判据）。
 */
function runtimeNoiseMatches(line, ids) {
  const shaped =
    RUNTIME_REPORT_SITE.test(line) ||
    (line.includes("Uncaught (in promise)") && line.includes("plugin-worker-protocol.ts"));
  return shaped && ids.some((id) => line.includes(id));
}

function probeZOrder(seconds) {
  const script = resolve(E2E_DIR, "../../tools/win-zorder.ps1");
  const run = spawnSync("pwsh.exe", ["-NoProfile", "-File", script, "-Seconds", String(seconds)], {
    encoding: "utf8",
    timeout: (seconds + 60) * 1000,
    windowsHide: true,
  });
  if (run.error) return `spawn失败 ${run.error.message}`;
  const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const machine = out.split(/\r?\n/).find((l) => l.startsWith("ZORDER "))?.trim() ?? "没有 ZORDER 行";
  return `${run.status} ${machine}`;
}
const RESET_CHANGE_SPY = `(async () => {
  if (!window.__changeSpy) {
    // 注入代码不经 Vite 转换，裸说明符解析不了；本套件只连 dev 实例（1420），走 dev 服务器可解析的路径
    const { listen } = await import('/node_modules/@tauri-apps/api/event.js');
    window.__changeSpy = [];
    await listen('host:plugins-changed', (e) => window.__changeSpy.push(e.payload ?? null));
  }
  window.__changeSpy.length = 0;
  return true;
})()`;

/** 探针里是否收到过一条「载荷带得出该插件 id」的广播 */
const sawChangedId = (id) =>
  `Array.isArray(window.__changeSpy) && window.__changeSpy.some((p) => Array.isArray(p?.ids) && p.ids.includes(${JSON.stringify(id)}))`;

export { PORT, PLUGINS_DIR, STORE_DIR, REAL_SETTINGS, E2E_SETTINGS, fileSha256OrNull, readE2eHotkey, probeManifest, MOUNT_BARE, MOUNT_CAPPED, invoke, isPetPage, sleep, DENY_TEXT, STOP_TEXT, DENY_LOCK_SETTLE_MS, OBSERVE_MS, RUNTIME_REPORT_SITE, runtimeNoiseMatches, probeZOrder, RESET_CHANGE_SPY, sawChangedId, E2E_DIR };
