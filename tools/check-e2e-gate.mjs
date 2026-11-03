// tools/check-e2e-gate.mjs — E2E 门的离线核对（报告 G1-05 / G1-06 / G1-09 / N2 / N4）
//
// 为什么要有这个工具：`.github/workflows/e2e.yml` 只在开发机的自托管 runner 上、由人手动触发，
// 而它的判据（套件清单、断言下限、允许的 skip、环境豁免）全在 `e2e-gate.json` 里。配置写错时
// 唯一的反馈是「下次有人手动跑门才知道」，那等于没有门。这里把能离线判的部分全判掉：
//   G1 配置能解析、版本对得上；         G2 modes 里的套件名形如 npm script；
//   G3 每个套件要么有断言下限、要么明确标成 floorPending（core 模式一律不许 pending）；
//   G4 每个套件的入口脚本都会打出 `E2E-SUMMARY suite=...`（否则门判 NO-SUMMARY-RED）；
//   G5 package.json 里每个 verify* 脚本都进了某个 mode（G1-09：不许有套件没有自动入口）；
//   G6 allowedSkips 每条都有 suite/match/理由/未过期的到期日（N2：skip 必须是登记的，不是搜出来的）；
//   G7 knownEnvFailures 同样要理由与到期日（当前允许为空集）；
//   G8 旧判据必须已经消失：配置里不许再有 skipMarkers，工作流里不许再按字面量整份日志搜；
//   G9 下限是正整数且不高于 floorBasis 里记的读数（免得把下限写在实际读数之上，门永远红）；
//   G10 工作流与本工具认同一个结构化标记（改了 harness 的字段名，这里先红）。
// 输出：每条违例一行 `  - <说明>`，末行
//   `RESULT suites=<n> floors=<n> pending=<n> skips=<n> failing=<n>`，有违例则退出码 1。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, ".github", "workflows", "e2e-gate.json");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "e2e.yml");
const HARNESS = path.join(ROOT, "tests", "e2e", "harness", "cdp.mjs");
const SUMMARY_MARK = "E2E-SUMMARY suite=";

const failures = [];
const fail = (msg) => failures.push(msg);
const readText = (p) => fs.readFileSync(p, "utf8");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

// ---- G1 -------------------------------------------------------------------
if (!fs.existsSync(CONFIG)) {
  console.log(`  - 缺 ${rel(CONFIG)}：门没有下限与 skip 登记表就只剩「跑完没崩」，那是假绿（G1-05）`);
  console.log("RESULT suites=0 floors=0 pending=0 skips=0 failing=1");
  process.exit(1);
}
let config;
try {
  config = JSON.parse(readText(CONFIG));
} catch (e) {
  console.log(`  - ${rel(CONFIG)} 不是合法 JSON: ${e.message}`);
  console.log("RESULT suites=0 floors=0 pending=0 skips=0 failing=1");
  process.exit(1);
}
if (config.version !== 2) fail(`${rel(CONFIG)} 的 version 应为 2（v1 的整份日志搜「跳过」判据已作废，N2），实际 ${config.version}`);

// ---- G2 / G3 --------------------------------------------------------------
const modes = config.modes || {};
const modeNames = Object.keys(modes);
if (modeNames.length === 0) fail(`${rel(CONFIG)} 没有 modes：工作流无法知道某个模式下该跑哪些套件`);
const allSuites = new Set();
for (const [name, list] of Object.entries(modes)) {
  if (!Array.isArray(list) || list.length === 0) fail(`modes.${name} 为空或不是数组`);
  for (const suite of list || []) {
    if (typeof suite !== "string" || !/^verify(:[a-z0-9-]+)?$/.test(suite)) {
      fail(`modes.${name} 里的 "${suite}" 不像 npm script（应形如 verify 或 verify:agent）`);
    }
    allSuites.add(suite);
  }
}
const floors = config.minAssertions || {};
const pending = config.floorPending || {};
for (const suite of allSuites) {
  const has = Object.hasOwn(floors, suite);
  const pend = Object.hasOwn(pending, suite);
  if (has && pend) fail(`${suite} 同时出现在 minAssertions 与 floorPending：只能选一个（有下限，或者承认还没量过）`);
  if (!has && !pend) fail(`${suite} 既没有 minAssertions 也没有 floorPending：门不知道它该有多少条断言`);
}
for (const suite of (modes.core || [])) {
  if (Object.hasOwn(pending, suite)) fail(`core 模式的 ${suite} 还挂在 floorPending 上：核心套件必须有可执行的下限`);
}
for (const suite of Object.keys(floors)) {
  if (!allSuites.has(suite)) fail(`minAssertions 里的 ${suite} 不在任何 mode 里：那是文档，不是门`);
}
for (const suite of Object.keys(pending)) {
  if (!allSuites.has(suite)) fail(`floorPending 里的 ${suite} 不在任何 mode 里`);
  if (typeof pending[suite] !== "string" || pending[suite].trim().length < 10) {
    fail(`floorPending.${suite} 要写清「为什么还没有下限、谁来补」，不能是空话`);
  }
}

// ---- G9 / G5 / G4 ---------------------------------------------------------
const pkg = JSON.parse(readText(path.join(ROOT, "package.json")));
const scripts = pkg.scripts || {};
const floorBasis = config.floorBasis || {};
for (const [suite, floor] of Object.entries(floors)) {
  if (!Number.isInteger(floor) || floor <= 0) fail(`minAssertions.${suite} 不是正整数：${floor}`);
  const basis = floorBasis[suite];
  const basisPassed = basis ? Number.parseInt(String(basis).match(/^(\d+)/)?.[1] ?? "", 10) : NaN;
  if (Number.isNaN(basisPassed)) fail(`floorBasis.${suite} 应形如 "485/0（日期与来源）"，读不出 passed 数`);
  else if (floor > basisPassed) fail(`minAssertions.${suite}=${floor} 高于 floorBasis 记的 ${basisPassed}：门会永远红，先回填读数再抬下限`);
}
for (const suite of Object.keys(scripts)) {
  if (!/^verify(:[a-z0-9-]+)?$/.test(suite)) continue;
  if (!allSuites.has(suite)) fail(`package.json 的 ${suite} 不在任何 mode 里：这套件没有任何自动入口（G1-09）`);
}
const entryFile = (suite) => {
  const cmd = String(scripts[suite] ?? "");
  const hit = cmd.match(/tests[\\/][\w./\\-]+\.mjs/);
  return hit ? path.join(ROOT, hit[0].replace(/\\/g, "/")) : null;
};
for (const suite of allSuites) {
  const file = entryFile(suite);
  if (!file) {
    if (!Object.hasOwn(scripts, suite)) fail(`package.json 里没有 ${suite} 这个脚本，但 e2e-gate.json 的 modes 里点名了它`);
    else fail(`读不出 ${suite} 的入口脚本路径（形如 node tests/e2e/verify-x.mjs）`);
    continue;
  }
  if (!fs.existsSync(file)) {
    fail(`${suite} 的入口脚本 ${rel(file)} 不存在`);
    continue;
  }
  // G4：门的 GREEN 依赖这条机器行；入口脚本自己打不出来，就永远是 NO-SUMMARY-RED。
  // R3（G9-08）拆分后入口只留骨架，summary 落在它 import 的本地模块里（如 agent/teardown.mjs），
  // 所以这里沿一层相对 import 找，而不是只盯入口文件本身。
  const srcOf = (f) => {
    try {
      return readText(f);
    } catch {
      return "";
    }
  };
  const localImports = (text) =>
    [...text.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)]
      .map((m) => path.resolve(path.dirname(file), m[1]))
      .filter((f) => f.endsWith(".mjs"));
  const src = srcOf(file);
  const emits =
    src.includes(".summary(") || localImports(src).some((f) => fs.existsSync(f) && srcOf(f).includes(".summary("));
  if (!emits) fail(`${rel(file)} 没有调用 report.summary()（含它 import 的本地模块）：门的 NO-SUMMARY-RED 会一直红`);
}

// ---- G6 / G7 / G8 ---------------------------------------------------------
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = new Date().toISOString().slice(0, 10);
const checkRegistry = (label, entries, { allowEmpty }) => {
  if (entries === undefined) return;
  if (!Array.isArray(entries)) {
    fail(`${label} 必须是数组`);
    return;
  }
  if (entries.length === 0 && !allowEmpty) fail(`${label} 不能为空`);
  for (const [i, item] of entries.entries()) {
    const at = `${label}[${i}]`;
    if (!item || typeof item !== "object") {
      fail(`${at} 不是对象`);
      continue;
    }
    if (!allSuites.has(item.suite)) fail(`${at}.suite="${item.suite}" 不在任何 mode 里`);
    if (typeof item.match !== "string" || item.match.trim() === "") fail(`${at}.match 必须是非空字符串（拿什么去对标签）`);
    if (typeof item.reason !== "string" || item.reason.trim().length < 10) fail(`${at}.reason 要写清为什么可以这样（≥10 字），空话不算理由`);
    if (typeof item.expires !== "string" || !DATE.test(item.expires)) {
      fail(`${at}.expires 必须是 YYYY-MM-DD`);
    } else if (item.expires < today) {
      fail(`${at} 已于 ${item.expires} 过期：到期即失效，要么续，要么修掉`);
    }
  }
};
checkRegistry("allowedSkips", config.allowedSkips, { allowEmpty: false });
checkRegistry("knownEnvFailures", config.knownEnvFailures, { allowEmpty: true });
if (Object.hasOwn(config, "skipMarkers")) {
  fail(`${rel(CONFIG)} 还留着 skipMarkers：整份日志搜字面量的判据会被普通文案误伤，已由 allowedSkips + 结构化 SKIP 行取代（N2）`);
}

// ---- G10 ------------------------------------------------------------------
const workflow = readText(WORKFLOW);
const harness = readText(HARNESS);
if (!harness.includes(SUMMARY_MARK)) fail(`${rel(HARNESS)} 不再打印 "${SUMMARY_MARK}"：工作流认的就是这个标记，两边必须一致`);
if (!workflow.includes(SUMMARY_MARK)) fail(`${rel(WORKFLOW)} 不再按 "${SUMMARY_MARK}" 取数：门又回到「日志里最后一行 N passed」那种能被误读的判据`);
if (!workflow.includes("$config.modes")) fail(`${rel(WORKFLOW)} 没有从 e2e-gate.json 的 modes 取套件清单：模式与配置就分家了`);
if (workflow.includes("skipMarkers")) fail(`${rel(WORKFLOW)} 还在用 skipMarkers`);
if (!String(pkg.scripts?.["check:e2e-gate"] ?? "").includes("check-e2e-gate.mjs")) {
  fail("package.json 里缺 check:e2e-gate 脚本（应指向 tools/check-e2e-gate.mjs）：这个核对本身要能一键跑");
}

const suites = allSuites.size;
for (const f of failures) console.log(`  - ${f}`);
console.log(
  `RESULT suites=${suites} floors=${Object.keys(floors).length} pending=${Object.keys(pending).length} ` +
    `skips=${(config.allowedSkips || []).length} failing=${failures.length}`,
);
if (failures.length > 0) process.exitCode = 1;
