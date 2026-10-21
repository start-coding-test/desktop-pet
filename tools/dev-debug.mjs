// 带 WebView2 远程调试端口启动 dev，供 tests/e2e/verify-isolation.mjs 连接。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { argv, env, platform } from "node:process";
import { clearPreseedFixtures, removePreseedFixtures, writePreseedFixtures } from "../tests/e2e/harness/fixtures.mjs";

const port = env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "9223";
const GATE = env.GITHUB_ACTIONS === "true" || env.PET_E2E_PRESEED === "1";
const pluginsDir = fileURLToPath(new URL("../plugins", import.meta.url));
const appDataDir = env.APPDATA
  ? join(env.APPDATA, JSON.parse(readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8")).identifier)
  : null;

/** 启动前只剔掉清单里的 zz.*，保留用户的其它插件启停状态（C2：不清空、不备份）。 */
function prunePreseedEnabled() {
  if (!appDataDir) return;
  const file = join(appDataDir, "plugins-enabled.json");
  if (!existsSync(file)) return;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed?.ids)) throw new Error("plugins-enabled.json 缺 ids 数组");
  const kept = parsed.ids.filter((id) => !String(id).startsWith("zz."));
  if (kept.length === parsed.ids.length) return;
  const tmp = `${file}.d07.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...parsed, ids: kept }, null, 2));
  renameSync(tmp, file);
}

function preseed() {
  clearPreseedFixtures(pluginsDir);
  writePreseedFixtures(pluginsDir);
  prunePreseedEnabled();
}

if (GATE) {
  try {
    preseed();
  } catch (err) {
    console.error("[dev-debug] D07 预置失败，不启动宿主:", err);
    process.exit(1);
  }
}

const child = spawn("npm", ["run", "tauri", "--", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});

/** 本地 best-effort；CI 的 taskkill /T /F 不会等这里，收尾由 workflow 的 zz.* 清理兜底。 */
function cleanupFixtures() {
  try {
    removePreseedFixtures(pluginsDir);
  } catch {
    /* 进程树正在退出，清理失败交给 workflow */
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    // 只杀 npm 包装进程会留下 vite 与 desktop-pet.exe：1420 被占且 strictPort，
    // 下次 dev 直接起不来。按进程树整棵收掉（vite 是 node 子进程，不能按镜像名杀）。
    cleanupFixtures();
    if (platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    } else {
      child.kill(sig);
    }
  });
}

child.on("exit", (code) => {
  cleanupFixtures();
  process.exit(code ?? 0);
});
