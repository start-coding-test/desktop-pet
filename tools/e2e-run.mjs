#!/usr/bin/env node
/**
 * tools/e2e-run.mjs —— e2e「一套件一实例」编排。
 *
 * 为什么要有它：e2e 套件跑的是 `npm run dev:debug` 起的真实桌宠实例，预置夹具（plugins/zz.*、
 * temp/agent-home-e2e 等）在 `PET_E2E_PRESEED=1` 启动时一次性写入；套件收尾会删夹具，所以
 * 同一实例上连跑第二个套件必断（D07 会报「预置 fixture 缺失」）。这个脚本负责：每个套件跑前
 * taskkill 残留 → 带全套隔离变量冷启动实例 → 等 CDP 就绪 → 跑套件 → **无论成败都杀实例**。
 *
 * 重要：跑 e2e 期间**不要改 `src-tauri/`** —— `tauri dev` 的 watcher 会 rebuild 并重启实例，
 * 正在跑的套件会以「CDP Runtime.evaluate 超时」的形式假红。编排会把这种场景标成
 * `INTERRUPTED`（退出码 2）：不计 pass/fail，也不该被写进门禁下限判据。
 *
 * 用法：
 *   node tools/e2e-run.mjs            # 跑全部套件
 *   node tools/e2e-run.mjs --list     # 只列出会跑哪些（verify 用得到，不启动实例）
 *   node tools/e2e-run.mjs --only verify:drag,verify:dsh
 *   node tools/e2e-run.mjs --keep     # 跑完留着最后一个实例（调试用）
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const TEMP = join(ROOT, "temp");
// 联动状态是宿主在 APPDATA 下的真实数据文件（linkage.rs:83 `<app_data>/agent-linkage.json`）。
// 套件正常收尾会把它恢复成原样，但**中断的跑**会留下「当前 Agent=上一次切的那家」，
// 下一轮 D07 的「启动前默认 qoder/12/0」就会误红（t27 实测：一次 abort 之后 verify 连红 3 条）。
// 所以编排在开跑前把它钉回基线、跑完恢复原文件；这是环境前置，不是把产品红藏起来。
const LINKAGE = join(env.APPDATA, "com.desktoppet.pet", "agent-linkage.json");
const LINKAGE_BASELINE = `${JSON.stringify({ schema: 1, agent: "qoder", hooksEnabled: {} }, null, 2)}
`;
const LOG_DIR = join(TEMP, "e2e-run");
const READY_TIMEOUT_MS = 240_000;
const SUITE_TIMEOUT_MS = 900_000;

/** 套件清单：名字 = npm script；scope 只用来在汇总里标出「DSH 用例」这类重点。 */
const SUITES = [
  { name: "verify", script: "verify", note: "隔离与 hook 安全（含 D07/B05 启停清理）" },
  { name: "verify:agent", script: "verify:agent", note: "Agent 桥（设置窗 / 收件 / 状态归一）" },
  { name: "verify:drag", script: "verify:drag", note: "拖动（G6-01/02/03/04/08/16）" },
  { name: "verify:dsh", script: "verify:dsh", note: "DSH 桥（G6-09 + 接线/自卸）" },
];

/** 实例与套件共用的一套隔离变量（dev-debug 会再按白名单校正）。 */
function e2eEnv() {
  return {
    PET_E2E_PRESEED: "1",
    PET_HOTKEY_DEFAULT: "CommandOrControl+Alt+Q",
    PET_AGENT_CONFIG_FILES: [join(TEMP, "a9a/cfg-a.json"), join(TEMP, "a9a/cfg-b.json")].join(";"),
    PET_AGENT_HOME: join(TEMP, "agent-home-e2e"),
    PET_AGENT_INBOX: join(TEMP, "inbox-e2e"),
    PET_DSH_HOME: join(TEMP, "dsh-home-e2e"),
    PET_SETTINGS_DIR: join(TEMP, "settings-e2e"),
    CDP_PORT: String(CDP_PORT),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

/** 杀干净实例（desktop-pet.exe 及其 cargo 父进程）；失败也继续。 */
function killInstance() {
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-Process desktop-pet,cargo -ErrorAction SilentlyContinue | ForEach-Object { taskkill /F /T /PID $_.Id | Out-Null }",
    ],
    { stdio: "ignore", windowsHide: true },
  );
}

/** 清掉预置夹具与探针目录，保证 plugins/ 只剩真实插件（失败也无所谓）。 */
/** 开跑前把联动状态钉回基线（qoder/未装），跑完由 restoreLinkage 还原原文件。 */
function resetLinkage() {
  try {
    mkdirSync(dirname(LINKAGE), { recursive: true });
    writeFileSync(LINKAGE, LINKAGE_BASELINE);
  } catch {
    /* 环境前置失败由套件自己判红 */
  }
}

function restoreLinkage(snapshot) {
  try {
    if (snapshot === null) rmSync(LINKAGE, { force: true });
    else writeFileSync(LINKAGE, snapshot);
  } catch {
    /* ignore */
  }
}

function cleanFixtures() {
  const dir = join(ROOT, "plugins");
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith("zz.") || name.startsWith("com.zz.")) {
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
}

async function cdpPages() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 等 CDP 起来且桌宠页（/src/index.html）可见；实例进程提前退出则抛错。 */
async function waitInstanceReady(child) {
  const started = Date.now();
  let exited = null;
  child.once("exit", (code) => {
    exited = code;
  });
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (exited !== null) throw new Error(`dev 实例提前退出（code ${exited}）`);
    const pages = await cdpPages();
    if (Array.isArray(pages) && pages.some((p) => /src\/index\.html/.test(String(p.url)))) {
      log(`  · CDP 就绪（${Math.round((Date.now() - started) / 1000)}s，${pages.length} 个页面）`);
      return;
    }
    await sleep(2000);
  }
  throw new Error(`等 CDP 就绪超时（${READY_TIMEOUT_MS / 1000}s）`);
}

/** 起实例并把 stdout/stderr 落到 temp/e2e-run/<suite>.instance.log。 */
function startInstance(suiteName, env) {
  const logFile = join(LOG_DIR, `${safeName(suiteName)}.instance.log`);
  // 流式落盘：套件挂死时也能马上看实例侧到哪一步（tauri dev 的 rebuild 也会打在这）。
  try {
    writeFileSync(logFile, "");
  } catch {
    /* 日志写失败不影响判定 */
  }
  const child = spawn("cmd", ["/c", "npm", "run", "dev:debug"], {
    cwd: ROOT,
    env: { ...process.env, ...env, RUST_LOG: process.env.RUST_LOG || "info" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const state = { watching: false, interrupted: false };
  const REBUILD = /Rebuilding application|could not compile `desktop-pet`|error\[E0\d+\]/;
  const pipe = (chunk) => {
    try {
      appendFileSync(logFile, chunk);
    } catch {
      /* ignore */
    }
    if (state.watching && REBUILD.test(chunk.toString())) state.interrupted = true;
  };
  child.stdout.on("data", pipe);
  child.stderr.on("data", pipe);
  child.on("exit", () => {
    if (state.watching) state.interrupted = true;
  });
  return { child, state };
}

/** 跑一个套件并回传读数（从输出里抓 `N passed, M failed` / `N 通过 / M 失败`）。 */
function runSuite(suite, env) {
  return new Promise((resolveRun) => {
    const logFile = join(LOG_DIR, `${safeName(suite.name)}.log`);
    const out = [];
    const started = Date.now();
    const child = spawn("cmd", ["/c", "npm", "run", suite.script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (d) => {
      out.push(d.toString());
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out.push(d.toString());
      process.stderr.write(d);
    });
    const timer = setTimeout(() => {
      killInstance();
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, SUITE_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const text = out.join("");
      try {
        writeFileSync(logFile, text);
      } catch {
        /* ignore */
      }
      resolveRun({ code: code ?? 1, ms: Date.now() - started, reading: readReading(text) });
    });
  });
}

function readReading(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /(\d+)\s+passed,\s+(\d+)\s+failed/.exec(lines[i]);
    if (m) return `${m[1]} passed / ${m[2]} failed`;
    const c = /(\d+)\s*通过\s*[/／]\s*(\d+)\s*失败/.exec(lines[i]);
    if (c) return `${c[1]} 通过 / ${c[2]} 失败`;
  }
  return "(未识别出读数行)";
}

function safeName(name) {
  return name.replace(/[^a-z0-9]+/gi, "-");
}

async function runOne(suite) {
  const env = e2eEnv();
  log(`\n=== ${suite.name} —— ${suite.note}`);
  log("  · 清残留实例/夹具");
  killInstance();
  await sleep(1500);
  cleanFixtures();
  resetLinkage();
  const { child: instance, state } = startInstance(suite.name, env);
  let result = { name: suite.name, code: 1, ms: 0, reading: "(实例未能启动)" };
  try {
    await waitInstanceReady(instance);
    state.watching = true; // 套件开跑之后，实例侧再出现 rebuild/编译错就算被打断
    result = await runSuite(suite, env);
    result.name = suite.name;
  } catch (err) {
    result = { name: suite.name, code: 1, ms: 0, reading: `编排失败：${err.message}` };
  } finally {
    state.watching = false;
    killInstance();
    await sleep(1500);
    cleanFixtures();
  }
  if (state.interrupted && result.code !== 0) {
    result.code = 2;
    result.reading = "INTERRUPTED（tauri dev 在跑动中被 rebuild/重启，不计 pass/fail）";
  }
  const verdict = result.code === 0 ? "GREEN" : result.code === 2 ? "INTERRUPTED" : "RED";
  log(`  · ${suite.name}: ${verdict}  ${result.reading}  ${Math.round(result.ms / 1000)}s`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const s of SUITES) log(`${s.name.padEnd(14)} npm run ${s.script}   ${s.note}`);
    return;
  }
  const onlyArg = args.find((a) => a.startsWith("--only"));
  const only = onlyArg
    ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1] || "").split(",").filter(Boolean)
    : null;
  const linkageSnapshot = existsSync(LINKAGE) ? readFileSync(LINKAGE) : null;
  mkdirSync(LOG_DIR, { recursive: true });
  const suites = only ? SUITES.filter((s) => only.includes(s.name)) : SUITES;
  if (suites.length === 0) {
    log(`没匹配到套件：${only?.join(",")}；可用：${SUITES.map((s) => s.name).join(",")}`);
    process.exitCode = 2;
    return;
  }
  log(`e2e 编排：${suites.length} 个套件（一套件一实例）`);
  const results = [];
  try {
    for (const suite of suites) results.push(await runOne(suite));
  } finally {
    killInstance();
    cleanFixtures();
    restoreLinkage(linkageSnapshot);
  }
  log("\n=== 汇总");
  let red = 0;
  let total = 0;
  for (const r of results) {
    total += r.ms;
    if (r.code !== 0) red += 1;
    const label = r.code === 0 ? "GREEN" : r.code === 2 ? "INTER" : "RED  ";
    log(`  ${label}  ${r.name.padEnd(14)} ${r.reading}  ${Math.round(r.ms / 1000)}s`);
  }
  const interrupted = results.filter((r) => r.code === 2).length;
  log(`  总耗时 ${Math.round(total / 1000)}s；红 ${red}/${results.length}，被打断 ${interrupted} 个`);
  if (red > 0) process.exitCode = 1;
  else if (interrupted > 0) process.exitCode = 2;
}

main().catch((err) => {
  killInstance();
  cleanFixtures();
  console.error(`编排异常：${err?.stack ?? err}`);
  process.exitCode = 1;
});

// 兜底：Ctrl+C 也先把实例杀了再走。
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killInstance();
    cleanFixtures();
    process.exit(130);
  });
}
