// 带 WebView2 远程调试端口启动 dev，供 tests/e2e/verify-isolation.mjs 连接。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { argv, env, platform } from "node:process";
import {
  cleanAgentTempState,
  clearPreseedFixtures,
  devAgentHomeDefault,
  devDshHomeDefault,
  prunePreseedEnabledIds,
  removePreseedFixtures,
  writePreseedFixtures,
} from "../tests/e2e/harness/fixtures.mjs";

const port = env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "9223";
const GATE = env.GITHUB_ACTIONS === "true" || env.PET_E2E_PRESEED === "1";
const pluginsDir = fileURLToPath(new URL("../plugins", import.meta.url));
const tempRoot = fileURLToPath(new URL("../temp", import.meta.url));
const appDataDir = env.APPDATA
  ? join(env.APPDATA, JSON.parse(readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8")).identifier)
  : null;

/**
 * G2-02：dev 实例一启动就会按 `PET_AGENT_HOME` 扫各家配置；没设时必须给 temp 下的缺省值，
 * 设成白名单之外（典型是真实 home）时直接拒绝启动 —— 否则 dev 里点一次「安装」
 * 就把用户自己的 `~/.zcode` / `~/.codex` 改了。缺省值同时写回 env，子进程一并继承。
 */
function prepareAgentHome() {
  const home = devAgentHomeDefault(env, { tempRoot });
  if (env.PET_AGENT_HOME !== home) {
    if (env.PET_AGENT_HOME) console.log(`[dev-debug] PET_AGENT_HOME 在 temp 白名单内: ${home}`);
    else console.log(`[dev-debug] PET_AGENT_HOME 未设，缺省隔离到: ${home}`);
    env.PET_AGENT_HOME = home;
  }
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * G2-06：桥检测读 `~/.dsh` 的 profile；dev 实例缺省要落到 temp，否则会读到开发机真实的
 * DSH profile（在 dev 里点一次「连接 DSH」就会去改真实 profile 的 bundles）。
 */
function prepareDshHome() {
  const dshHome = devDshHomeDefault(env, { tempRoot });
  if (env.PET_DSH_HOME !== dshHome) {
    if (env.PET_DSH_HOME) console.log(`[dev-debug] PET_DSH_HOME 在 temp 白名单内: ${dshHome}`);
    else console.log(`[dev-debug] PET_DSH_HOME 未设，缺省隔离到: ${dshHome}`);
    env.PET_DSH_HOME = dshHome;
  }
  mkdirSync(dshHome, { recursive: true });
  return dshHome;
}

/**
 * A31：GATE 下把热键设置的落盘目录挪进隔离目录。
 * 真实 app_data 目录绝不允许被清：路径与它重叠（含它是目标的祖先/后代）直接拒绝；
 * 只有 <仓库>/temp/ 下的目标才递归清空，其他目录只删其中的 settings.json。
 */
function prepareSettingsDir() {
  const target = resolve(env.PET_SETTINGS_DIR || join(tempRoot, "settings-e2e"));
  const realAppDir = appDataDir ? resolve(appDataDir) : null;
  const overlapsReal =
    realAppDir &&
    (target === realAppDir ||
      target.startsWith(`${realAppDir}${sep}`) ||
      realAppDir.startsWith(`${target}${sep}`));
  if (overlapsReal) {
    throw new Error(`PET_SETTINGS_DIR 不能与真实 app_data 目录重叠: ${target} vs ${realAppDir}`);
  }
  if (target.startsWith(`${resolve(tempRoot)}${sep}`)) {
    rmSync(target, { recursive: true, force: true });
  } else {
    rmSync(join(target, "settings.json"), { force: true });
  }
  mkdirSync(target, { recursive: true });
  return target;
}

/** 启动前只剔掉清单里的 zz.*，保留用户的其它插件启停状态（C2：不清空、不备份）。 */
function prunePreseedEnabled() {
  if (!appDataDir) return;
  const file = join(appDataDir, "plugins-enabled.json");
  if (!existsSync(file)) return;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed?.ids)) throw new Error("plugins-enabled.json 缺 ids 数组");
  const kept = prunePreseedEnabledIds(parsed.ids);
  if (kept.length === parsed.ids.length) return;
  const tmp = `${file}.d07.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...parsed, ids: kept }, null, 2));
  renameSync(tmp, file);
}

function preseed() {
  clearPreseedFixtures(pluginsDir);
  writePreseedFixtures(pluginsDir);
  prunePreseedEnabled();
  const configFiles = String(env.PET_AGENT_CONFIG_FILES ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  // E2E 作业必须带两套 agent 样例；本地不带这个 env 时保持原行为。
  if (configFiles.length) {
    cleanAgentTempState({
      tempRoot,
      configFiles,
      agentHome: env.PET_AGENT_HOME ?? agentHome,
    });
  } else if (env.GITHUB_ACTIONS === "true") {
    throw new Error("GITHUB_ACTIONS 下缺 PET_AGENT_CONFIG_FILES，拒绝在脏 agent 状态下启动");
  }
}

let settingsDir = env.PET_SETTINGS_DIR || null;
// 无论 GATE 与否都要先定隔离 home：本地 dev 与 CI 一样不该读真实 home。
const agentHome = prepareAgentHome();
prepareDshHome();

if (GATE) {
  try {
    settingsDir = prepareSettingsDir();
    preseed();
  } catch (err) {
    console.error("[dev-debug] D07/A31 预置失败，不启动宿主:", err);
    process.exit(1);
  }
}

const child = spawn("npm", ["run", "tauri", "--", "dev"], {
  stdio: "inherit",
  shell: true,
  env: {
    ...env,
    ...(settingsDir ? { PET_SETTINGS_DIR: settingsDir } : {}),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
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
    if (GATE) cleanupFixtures();
    if (platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    } else {
      child.kill(sig);
    }
  });
}

child.on("exit", (code) => {
  if (GATE) cleanupFixtures();
  process.exit(code ?? 0);
});
