// 验证用临时插件 fixture：由脚本写入 plugins/、跑完删除（.gitignore 已忽略这两个名字，
// 中途崩溃也不会被误提交）。前缀 zz. 便于人工识别残留。
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_ID = "zz.probe";
export const NET_ID = "zz.net"; // 只声明 http：用于验证「按域名逐个授权」这条规则
export const SPOOF_DIR = "com.zz.spoof"; // 目录名与 manifest.id 不一致 → 必须被宿主剔除
export const SPOOF_CLAIMED_ID = "com.pet.hr-ble";

const PROBE_MANIFEST = {
  id: PROBE_ID,
  name: "隔离探针",
  version: "0.0.0",
  entry: "index.js",
  widget: "widget.js",
  permissions: [],
  description: "验证用探针：以零权限第三方身份尝试越权，结果写进 window.__probes。",
};

const NET_MANIFEST = {
  id: NET_ID,
  name: "网络探针",
  version: "0.0.0",
  entry: "index.js",
  permissions: ["http"],
  description: "只声明 http：验证按域名逐个授权的规则。全程不启用，故不会被激活。",
};

const SPOOF_MANIFEST = {
  id: SPOOF_CLAIMED_ID,
  name: "冒名插件",
  version: "0.0.0",
  entry: "index.js",
  permissions: ["ble:connect"],
};

// 探针 widget：mount 时逐项尝试，并把结果 append 到 window.__probes。
// 注意其中 eval / <style> 注入两项是「页面自身代码」的行为，因此才可用于判断 CSP 是否强制；
// 由 CDP 直接求值的同名调用不受 CSP 约束，不能当判据。
const PROBE_WIDGET = `export function mount(root, ctx) {
  const r = { region: ctx.region, attempts: {} };
  const attempt = (label, fn) => {
    try { fn(); r.attempts[label] = "THROUGH"; } catch { r.attempts[label] = "BLOCKED"; }
  };
  r.busKeys = Object.keys(ctx.bus).sort();
  r.hasInject = typeof ctx.bus.inject === "function";
  r.hasHandlers = "handlers" in ctx.bus;

  attempt("publish_own", () => ctx.bus.publish("${PROBE_ID}:self", {}));
  attempt("publish_foreign", () => ctx.bus.publish("com.pet.hr-ble:bpm", { bpm: 1 }));
  attempt("publish_host", () => ctx.bus.publish("ble:heart-rate", { bpm: 666 }));
  attempt("publish_wildcard", () => ctx.bus.publish("${PROBE_ID}:*", {}));
  attempt("subscribe_own", () => ctx.bus.subscribe("${PROBE_ID}:own", () => {}));
  attempt("subscribe_own_wildcard", () => ctx.bus.subscribe("${PROBE_ID}:*", () => {}));
  attempt("subscribe_host", () => ctx.bus.subscribe("ble:heart-rate", () => {}));
  attempt("subscribe_all_wildcard", () => ctx.bus.subscribe("*", () => {}));
  attempt("subscribe_foreign_wildcard", () => ctx.bus.subscribe("com.pet.hr-ble:*", () => {}));

  try {
    (0, eval)("1");
    r.csp = "unforced";
  } catch (err) {
    r.csp = /unsafe-eval/.test(String(err)) ? "enforced" : "eval-error";
  }

  const style = document.createElement("style");
  style.textContent = ".zzp{color: rgb(1, 2, 3);}";
  const node = document.createElement("div");
  node.className = "zzp";
  root.append(style, node);
  r.styleApplied = getComputedStyle(node).color === "rgb(1, 2, 3)";

  (window.__probes = window.__probes || []).push(r);
}

export function unmount() {}
`;

const PROBE_INDEX = `export function activate(ctx) {
  window.__probeCtxKeys = Object.keys(ctx).sort();
  window.__probeActivated = (window.__probeActivated || 0) + 1;
}
export function deactivate() {
  window.__probeDeactivated = (window.__probeDeactivated || 0) + 1;
}
`;

function writePlugin(pluginsDir, dirName, manifest, files) {
  const dir = join(pluginsDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

export function writeFixtures(pluginsDir) {
  writePlugin(pluginsDir, PROBE_ID, PROBE_MANIFEST, { "index.js": PROBE_INDEX, "widget.js": PROBE_WIDGET });
  writePlugin(pluginsDir, NET_ID, NET_MANIFEST, { "index.js": PROBE_INDEX });
  // 冒名目录只放 manifest 与空入口：它应当在 plugins_list 阶段就被剔除，根本轮不到加载
  writePlugin(pluginsDir, SPOOF_DIR, SPOOF_MANIFEST, { "index.js": "export function activate() {}\n" });
}

/**
 * 只写 zz.probe 一个探针（热安装组用）。
 *
 * 为什么不用 writeFixtures：热安装组要断言「页面没被热重载」，而宿主的 dev 热重载是
 * 「覆盖了承载中插件的模块文件 → 本窗整页换茬」（src/runtime/hot-reload.ts，产品行为）。
 * zz.net 在更早的分组里已被启用并保持 active，此时若顺手重写它的 index.js，就会触发一次
 * 合法的热重载、掀掉本组刚埋的哨兵与广播探针 —— 那是套件自己制造的干扰，不是产品缺陷。
 * 所以热安装组只碰「此刻不承载」的 zz.probe。
 */
export function writeProbeFixtures(pluginsDir) {
  writePlugin(pluginsDir, PROBE_ID, PROBE_MANIFEST, { "index.js": PROBE_INDEX, "widget.js": PROBE_WIDGET });
}

export function removeFixtures(pluginsDir) {
  for (const name of [PROBE_ID, NET_ID, SPOOF_DIR]) {
    rmSync(join(pluginsDir, name), { recursive: true, force: true });
  }
}

// D07：宿主启动前预置的 fixture。只被 tools/dev-debug.mjs 调用（E2E 门控），
// import 本模块不得产生任何磁盘副作用。
export const PRESEED_PROBE_ID = "zz.probe";
export const PRESEED_NET_ID = "zz.net";
export const PRESEED_CONSENT_ID = "zz.consent";
export const PRESEED_STATUS_A = "zz.status";
export const PRESEED_STATUS_B = "zz.status2";
export const PRESEED_HOOK_ID = "zz.hookprobe";
export const PRESEED_HOOK_UNDECLARED_ID = "zz.hookundeclared";
export const PRESEED_SPOOF_DIR = "com.zz.spoof";

const PRESEED_PROBE_PERMISSIONS = [
  "bus:publish",
  "bus:subscribe",
  "storage",
  "ble:connect",
  "ble:scan",
  "overlay",
  "widget",
];

const PRESEED_STATUS_INDEX = `let live = true;
export async function activate(ctx) {
  const pid = ctx.pluginId;
  const reply = (id, body) => { if (live) ctx.bus.publish(pid + ":res", Object.assign({ id: id }, body)); };
  ctx.bus.subscribe(pid + ":cmd", async (msg) => {
    try {
      if (msg.action === "set") reply(msg.id, { ok: true, v: await ctx.pet.setStatus(msg.text) });
      else if (msg.action === "clear") reply(msg.id, { ok: true, v: await ctx.pet.setStatus(null) });
      else if (msg.action === "say") { await ctx.pet.say(String(msg.text)); reply(msg.id, { ok: true }); }
      else if (msg.action === "boom") { reply(msg.id, { ok: true }); setTimeout(() => { throw new Error("B3 崩溃探针：故意未捕获"); }, 0); }
      else reply(msg.id, { ok: false, e: "未知 action" });
    } catch (e) {
      reply(msg.id, { ok: false, e: String(e && e.message ? e.message : e) });
    }
  });
}
export function deactivate() { live = false; }
`;

const PRESEED_HOOK_WIDGET = `export function mount(root, ctx) {
  const node = ctx.dom.createElement("div");
  node.className = "zz-hookprobe";
  node.textContent = ctx.region;
  root.append(node);
  ctx.bus.publish("${PRESEED_HOOK_ID}:fact", {
    region: ctx.region,
    hostIsUndefined: typeof ctx.host === "undefined",
    hasAgentHooks: !!(ctx.host && ctx.host.agentHooks),
    keys: ctx.host ? Object.keys(ctx.host).sort() : [],
  });
  ctx.bus.subscribe("${PRESEED_HOOK_ID}:cmd", async (msg) => {
    const api = ctx.host && ctx.host.agentHooks;
    let out;
    if (!api) out = { ok: false, e: "no host.agentHooks on ctx" };
    else {
      try { out = { ok: true, v: await api[msg.name]() }; }
      catch (e) { out = { ok: false, e: String(e && e.message ? e.message : e) }; }
    }
    ctx.bus.publish("${PRESEED_HOOK_ID}:res", { id: msg.id, region: ctx.region, ...out });
  });
}
export function unmount() {}
`;

const PRESEED_STATUS_MANIFEST = (id) => ({
  id,
  name: `常驻行探针 ${id}`,
  version: "0.0.0",
  entry: "index.js",
  permissions: ["pet:say", "bus:publish", "bus:subscribe"],
  description: "验证气泡常驻行的显示、仲裁与回收（B3）。",
});

/** C2：只剔除清单里的 zz.*，保留其它插件启停状态；纯函数，供 dev-debug 与干跑共用。 */
export function prunePreseedEnabledIds(ids) {
  return ids.filter((id) => !String(id).startsWith("zz."));
}

export const PRESEED_PLUGIN_IDS = [
  PRESEED_PROBE_ID,
  PRESEED_NET_ID,
  PRESEED_CONSENT_ID,
  PRESEED_STATUS_A,
  PRESEED_STATUS_B,
  PRESEED_HOOK_ID,
  PRESEED_HOOK_UNDECLARED_ID,
];

/** 启动前清掉旧的 zz.* / com.zz.* fixture；不碰其它插件目录。 */
export function clearPreseedFixtures(pluginsDir) {
  let entries;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("zz.") || entry.name.startsWith("com.zz.")) {
      rmSync(join(pluginsDir, entry.name), { recursive: true, force: true });
    }
  }
}

/** 宿主 spawn 前一次性写入所有 D07 fixture（幂等；失败让调用方不要 spawn）。 */
export function writePreseedFixtures(pluginsDir) {
  writePlugin(
    pluginsDir,
    PRESEED_PROBE_ID,
    { ...PROBE_MANIFEST, permissions: PRESEED_PROBE_PERMISSIONS },
    { "index.js": PROBE_INDEX, "widget.js": PROBE_WIDGET },
  );
  writePlugin(pluginsDir, PRESEED_NET_ID, NET_MANIFEST, { "index.js": PROBE_INDEX });
  writePlugin(pluginsDir, PRESEED_SPOOF_DIR, SPOOF_MANIFEST, { "index.js": "export function activate() {}\n" });
  writePlugin(
    pluginsDir,
    PRESEED_CONSENT_ID,
    {
      id: PRESEED_CONSENT_ID,
      name: "同意合流探针",
      version: "0.0.0",
      entry: "index.js",
      permissions: ["storage", "notify"],
      description: "验证 ADR-0013 的合流、去重、拒绝锁与未启用门禁。",
    },
    { "index.js": "export function activate() {}\nexport function deactivate() {}\n" },
  );
  for (const id of [PRESEED_STATUS_A, PRESEED_STATUS_B]) {
    writePlugin(pluginsDir, id, PRESEED_STATUS_MANIFEST(id), { "index.js": PRESEED_STATUS_INDEX });
  }
  writePlugin(
    pluginsDir,
    PRESEED_HOOK_UNDECLARED_ID,
    {
      id: PRESEED_HOOK_UNDECLARED_ID,
      name: "未声明钩子能力探针",
      version: "0.0.0",
      entry: "index.js",
      permissions: ["storage"],
      description: "D07：不含 agent:hooks 的未声明对照。",
    },
    { "index.js": "export function activate() {}\nexport function deactivate() {}\n" },
  );
  writePlugin(
    pluginsDir,
    PRESEED_HOOK_ID,
    {
      id: PRESEED_HOOK_ID,
      name: "钩子能力探针",
      version: "0.0.0",
      entry: "index.js",
      widget: "widget.js",
      apiVersion: 2,
      permissions: ["bus:publish", "bus:subscribe", "agent:hooks"],
      description: "验证 agent:hooks 的受控注入面与同意流程（D07 预置）。",
    },
    {
      "index.js": "export function activate() {}\nexport function deactivate() {}\n",
      "widget.js": PRESEED_HOOK_WIDGET,
    },
  );
}

/** verify-isolation 收尾删除：只删 fixture 目录，不碰清单（清单由调用方先清理）。 */
export function removePreseedFixtures(pluginsDir) {
  clearPreseedFixtures(pluginsDir);
}

/**
 * 套件收尾的统一口径：把 `plugins/` 恢复成「只有真实插件」的样子（清掉所有 zz.* / com.zz.*）。
 * 成功、失败、中断都要走到这一步 —— `tsconfig.plugins.json` 会 typecheck `plugins/**`，
 * 残留的探针目录会让 `npm run build` 报一堆 TS2339、`npm run lint` 的文件数也会漂。
 */
export function restorePluginsDir(pluginsDir) {
  clearPreseedFixtures(pluginsDir);
}

function findPrePetBackups(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findPrePetBackups(full, out);
    else if (entry.name.endsWith(".pre-pet-backup")) out.push(full);
  }
  return out;
}

/**
 * D07-D16：E2E 启动前清掉测试自建的 agent 临时状态。只允许 tempRoot 下的路径；
 * 宿主第一次改写配置会留下 *.pre-pet-backup，下一轮 agent_hooks_status 会把它们
 * 也算进 files（上一轮 files=4 的来源）。两份 live 样例复位成只有用户自己的条目。
 * 纯调用式，不 import 时不产生任何磁盘副作用。
 */
export function cleanAgentTempState({ tempRoot, configFiles, agentHome }) {
  const root = resolve(tempRoot);
  const files = (configFiles ?? []).map((p) => resolve(p));
  if (files.length !== 2) throw new Error(`PET_AGENT_CONFIG_FILES 应为 2 个文件，实得 ${files.length}`);
  for (const file of files) {
    if (!file.startsWith(root + sep)) throw new Error(`拒绝清理 temp/ 外的 agent 配置: ${file}`);
  }
  const home = agentHome ? resolve(agentHome) : "";
  if (home && !home.startsWith(root + sep)) {
    throw new Error(`拒绝清理 temp/ 外的 PET_AGENT_HOME: ${home}`);
  }
  const removedBackups = findPrePetBackups(root);
  for (const file of removedBackups) rmSync(file, { force: true });
  const removedDirs = [];
  if (home) {
    for (const name of [".zcode", ".codex", ".workbuddy"]) {
      const dir = join(home, name);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removedDirs.push(dir);
      }
    }
  }
  const foreignOnly = (tag) =>
    JSON.stringify(
      {
        theme: "dark",
        note: `keep-${tag}`,
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `other-tool-${tag} --notify`, timeout: 5 }] }] },
      },
      null,
      2,
    );
  files.forEach((file, i) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, foreignOnly(i === 0 ? "a" : "b"));
  });
  const live = files.filter(existsSync);
  if (live.length !== 2) throw new Error(`agent 临时配置读回失败: 期望 2 个文件，实得 ${live.length}`);
  const leftovers = findPrePetBackups(root);
  if (leftovers.length) throw new Error(`agent 临时备份未清干净: ${leftovers.join(", ")}`);
  return { files: live, removedBackups, removedDirs };
}

// ==== Agent 隔离 env 的统一口径（Bug1）====
// 写文件的四家适配器候选文件全从 env 解析，而变量不止一个：Qoder 认 `PET_AGENT_CONFIG_FILES`、
// Codex 认 `PET_AGENT_CODEX_FILES`、WorkBuddy 认 `PET_AGENT_WORKBUDDY_FILES`，ZCode 只认
// `PET_AGENT_HOME`（zcode.rs:140-153，它没有逐文件变量）。逐文件变量缺省时也退到
// `PET_AGENT_HOME` 整体换根，两者都没有才用真实 home（claude_style.rs:170-191）。
// 所以「只设 PET_AGENT_CONFIG_FILES」只隔离了一家：凡是起一个会改配置的子进程
//（`--pet-hook-cleanup` → `uninstall_everywhere` 扫 `adapters::wired()`），
// 都会顺着真实 home 去探测并摘掉另外三家用户自己的条目。
// 各套件不要再各拼一份 env —— 拼漏一个就是事故。
//
// DSH 是第五家但不在「跨 home 改写」这条风险里：它 `installs_files() == false`，
// 没有 hook 配置文件，卸载路径也不会碰真实 home（桥是 DSH 侧插件，见 integrations/dsh-bridge）。
// 它仍然进表（好让「JS 表 = Rust WIRED」的跨语言判据继续满员），但 `realHomeFiles` 为空、
// `filesEnv` 为 null，隔离缺口判定会跳过它。

/** 与 `adapters::WIRED` 一一对应。`filesEnv` 为 null = 这家没有逐文件变量，只能靠换根隔离。
 * `realHomeFiles` 是它在**真实 home** 下的候选文件（相对 home，正斜杠）——
 * 抄自 `claude_style.rs:271-274`（Qoder 两个目录 / settings.json）、`zcode.rs:42-44`
 * 与 `:140-153`、`codex.rs:41-47`、`workbuddy.rs:38-43`。适配器改了落点就要跟着改这里，
 * 判据靠它钉住「没隔离的子进程到底会改写哪些用户文件」。
 * `realHomeFiles` 为空 = 这家没有可改写的配置文件（DSH），隔离缺口判定跳过。 */
export const AGENT_ISOLATION_ADAPTERS = [
  {
    id: "qoder",
    filesEnv: "PET_AGENT_CONFIG_FILES",
    realHomeFiles: [".qoder/settings.json", ".qoder-cn/settings.json"],
  },
  { id: "zcode", filesEnv: null, realHomeFiles: [".zcode/cli/config.json", ".zcode/cli/setting.json"] },
  { id: "codex", filesEnv: "PET_AGENT_CODEX_FILES", realHomeFiles: [".codex/hooks.json"] },
  { id: "workbuddy", filesEnv: "PET_AGENT_WORKBUDDY_FILES", realHomeFiles: [".workbuddy/settings.json"] },
  // 桥插件路线：没有 hook 文件可装，卸载也不碰 home（dsh.rs 的 installs_files() 返回 false）
  { id: "dsh", filesEnv: null, realHomeFiles: [] },
];

/** 会随子进程一起带过去的隔离变量全集。收件目录也算：不设的话本机全局 hook 的真实会话
 * 会混进套件读的那份 inbox（口径同 verify-agent-bridge.mjs 顶部的 INBOX 注释）。
 * `PET_DSH_HOME` 也算（G2-06）：桥读的是 `~/.dsh` 里的 profile，不隔离就会读到开发机真实
 * 的 DSH profile（fixtures 只做变量名单与转发校验；e2e.yml 的同一行改动在 F04′ 的 CI 卡里）。 */
export const AGENT_ISOLATION_ENV_NAMES = [
  "PET_AGENT_CONFIG_FILES",
  "PET_AGENT_HOME",
  "PET_AGENT_CODEX_FILES",
  "PET_AGENT_WORKBUDDY_FILES",
  "PET_AGENT_INBOX",
  "PET_DSH_HOME",
];

/** 本表认识的 agent id 白名单。宿主回报的 `everywhere` 里出现表外的 id 时，
 * 套件**不能**当作「它没有配置文件、跳过」—— 那正是「新接了一家、隔离判据静默变松」的形状，
 * 必须判红让人把落点补进表里（G2-03 的 fail-closed 口径）。 */
export const AGENT_ISOLATION_AGENT_IDS = AGENT_ISOLATION_ADAPTERS.map((a) => a.id);

/** 表外的 agent id（空数组才放行）。 */
export function unknownAgentIsolationAdapters(ids = []) {
  const known = new Set(AGENT_ISOLATION_AGENT_IDS);
  return [...new Set(ids)].filter((id) => !known.has(id));
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 允许写 agent 配置的临时根白名单。只有落在这些根下面的路径才算「已隔离」——
 * 判不出（空值、相对路径、真实 home、盘符根）一律按未隔离算，不再「设了变量就信」。 */
export function agentIsolationRoots(extra = []) {
  return [tmpdir(), join(REPO_ROOT, "temp"), ...extra.filter(Boolean)];
}

const isBlankEnv = (value) => typeof value !== "string" || value.trim() === "";

/** 路径归一化：绝对化 + 反斜杠转正斜杠 + 小写（Windows 上大小写不敏感，
 * 原来的 `startsWith` 区分大小写，`C:\Users\X` 与 `c:\users\x` 会被判成两处）。 */
const normalizeAgentPath = (value) => resolve(String(value)).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** `candidate` 是否就是 `root` 或在它内部（都按归一化后比较）。`root` 空 = 不构成包含关系。 */
export function isAgentPathInside(candidate, root) {
  if (isBlankEnv(candidate) || isBlankEnv(root)) return false;
  const c = normalizeAgentPath(candidate);
  const r = normalizeAgentPath(root);
  return c === r || c.startsWith(`${r}/`);
}

/** 一个路径是否落在白名单临时根内。**只信落点**，不看它来自哪个变量：
 * `PET_AGENT_CONFIG_FILES=C:\Users\me\.qoder\settings.json` 与没设同样危险。 */
export function isIsolatedAgentPath(candidate, roots = agentIsolationRoots()) {
  return roots.some((root) => isAgentPathInside(candidate, root));
}

/** `PET_AGENT_CONFIG_FILES` 这类「分号分隔多路径」的变量：每一项都要在 temp 下才算隔离。 */
function agentEnvPaths(value) {
  return String(value)
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/** 隔离变量的问题清单（空数组 = 可以转发给子进程）。值落在真实 home 或白名单之外时
 * 直接列出来 —— 「设了但没隔离」是这次的根因，不能静默丢值。 */
export function agentIsolationEnvProblems(source = {}, { roots = agentIsolationRoots(), realHome = "" } = {}) {
  const problems = [];
  for (const name of AGENT_ISOLATION_ENV_NAMES) {
    // 空白值在 Rust 侧等于「没设」（`!v.trim().is_empty()`），不构成隔离也不构成风险；
    // 这种情形由 unisolatedAgentAdapters 按「换根没成功」兜住。
    if (isBlankEnv(source[name])) continue;
    const values = agentEnvPaths(source[name]);
    if (values.length === 0) {
      problems.push(`${name} 是空白值`);
      continue;
    }
    for (const value of values) {
      if (!isIsolatedAgentPath(value, roots)) problems.push(`${name}=${value} 不在 temp 下`);
      else if (isAgentPathInside(value, realHome)) problems.push(`${name}=${value} 落在真实 home`);
    }
  }
  return problems;
}

/** G2-02：`tools/dev-debug.mjs` 用的 agent home 缺省值。
 * 没设 `PET_AGENT_HOME` 时落到 `<仓库>/temp/agent-home`（dev 实例一启动就会按这个变量扫配置，
 * 留空等于去读真实 home）；设了但不在白名单临时根下（典型：真实 home）直接抛 ——
 * dev 里点一次「安装」就会改到用户自己的 `~/.zcode`，宁可拒绝启动。 */
export function devAgentHomeDefault(source = {}, { roots = agentIsolationRoots(), tempRoot = join(REPO_ROOT, "temp") } = {}) {
  const raw = typeof source.PET_AGENT_HOME === "string" ? source.PET_AGENT_HOME.trim() : "";
  if (raw === "") return join(tempRoot, "agent-home");
  if (!isIsolatedAgentPath(raw, roots)) {
    throw new Error(`PET_AGENT_HOME=${raw} 不在 temp 白名单根下，拒绝启动（G2-02 fail-closed）`);
  }
  return resolve(raw);
}

/** G2-06：`tools/dev-debug.mjs` 用的 DSH home 缺省值。
 * 桥的检测读 `~/.dsh`（`PET_DSH_HOME` → `PET_AGENT_HOME/.dsh` → 真实 home）；dev 实例不设时
 * 会落到真实 home 下的 profile，所以缺省给 `<仓库>/temp/dsh-home`，并沿用同一套白名单校验。 */
export function devDshHomeDefault(source = {}, { roots = agentIsolationRoots(), tempRoot = join(REPO_ROOT, "temp") } = {}) {
  const raw = typeof source.PET_DSH_HOME === "string" ? source.PET_DSH_HOME.trim() : "";
  if (raw === "") return join(tempRoot, "dsh-home");
  if (!isIsolatedAgentPath(raw, roots)) {
    throw new Error(`PET_DSH_HOME=${raw} 不在 temp 白名单根下，拒绝启动（G2-06 fail-closed）`);
  }
  return resolve(raw);
}

/**
 * 从给定 env 里挑出**已通过白名单校验**的隔离变量，返回可直接展开进 spawn `env:` 的补丁对象。
 * 与旧版最大的不同：不是「设了就转发」—— 设了却在 temp 之外（典型是真实 home）时直接抛错。
 * 静默丢弃会让子进程退回真实 home，等于把最危险的配置当默认值用。
 */
export function agentIsolationEnv(source = {}, options = {}) {
  const problems = agentIsolationEnvProblems(source, options);
  if (problems.length > 0) {
    throw new Error(`拒绝转发未隔离的 agent 变量: ${problems.join("；")}`);
  }
  const out = {};
  for (const name of AGENT_ISOLATION_ENV_NAMES) {
    if (!isBlankEnv(source[name])) out[name] = source[name];
  }
  return out;
}

/**
 * 给定 env 下**仍会退到真实 home / 写到真实目录**的适配器 id 列表；返回空数组才允许起一个
 * 会改 agent 配置的子进程。
 *
 * fail-closed 三条（G2-03）：
 * 1. 逐文件变量设了也要看落点：值不在白名单 temp 根下（或落在真实 home）仍判未隔离；
 * 2. 没有逐文件变量的那家（ZCode）只认 `PET_AGENT_HOME`，换根不成功就判未隔离；
 * 3. 判不出（空值/空白）与「等于真实 home」同判未隔离。
 * 没有 `realHomeFiles` 的适配器（DSH）不参与：它没有可改写的文件，天然不构成跨 home 风险。
 */
export function unisolatedAgentAdapters(source = {}, realHome = "", options = {}) {
  const roots = options.tempRoots ?? agentIsolationRoots();
  const out = [];
  for (const adapter of AGENT_ISOLATION_ADAPTERS) {
    if (adapter.realHomeFiles.length === 0) continue;
    if (adapter.filesEnv) {
      const raw = source[adapter.filesEnv];
      if (!isBlankEnv(raw)) {
        const paths = agentEnvPaths(raw);
        const ok =
          paths.length > 0 &&
          paths.every((p) => isIsolatedAgentPath(p, roots) && !isAgentPathInside(p, realHome));
        if (!ok) out.push(adapter.id);
        continue;
      }
    }
    const home = source.PET_AGENT_HOME;
    if (isBlankEnv(home) || !isIsolatedAgentPath(home, roots) || isAgentPathInside(home, realHome)) {
      out.push(adapter.id);
    }
  }
  return out;
}

/** 真实 home 下会写文件的几家的候选文件（绝对路径）。文件在不在由调用方判，这里只拼路径 ——
 * 一个都没有也是合法结果（那台机器没装这些客户端）。 */
export function realHomeAgentFiles(realHome) {
  return AGENT_ISOLATION_ADAPTERS.flatMap((a) => a.realHomeFiles.map((rel) => join(realHome, ...rel.split("/"))));
}

/**
 * G2-01：宿主 `agent_hooks_status` 回报的 `everywhere` 里，哪些路径**不在 temp 下**。
 * 返回空数组才允许起会改写 agent 配置的子进程。
 *
 * 这是套件唯一可信的隔离判据：宿主按自己的 env 解析出「实际生效的候选路径」，
 * 套件不用再猜宿主认哪个变量。fail-closed —— 任何判不出来的形状都返回问题：
 * - 没回报 `everywhere`（旧宿主 / 字段被删）→ 判红；
 * - `everywhere.home` 不在 temp 下 → 判红；
 * - 适配器 id 不在白名单（表外的 agent 说明隔离判据没人维护）→ 判红；
 * - 表里的适配器没回报（少一家 = 少一处检查）→ 判红；
 * - 任何一条候选路径不在 temp 下 / 落在真实 home → 判红。
 *
 * @param {unknown} everywhere `agent_hooks_status` 返回对象里的 `everywhere`
 * @param {{roots?: string[], realHome?: string}} [options]
 */
export function hostIsolationProblems(everywhere, { roots = agentIsolationRoots(), realHome = "" } = {}) {
  const record = everywhere !== null && typeof everywhere === "object" ? everywhere : null;
  const adapters = Array.isArray(record?.adapters) ? record.adapters : null;
  if (!adapters) return ["宿主没有回报 everywhere.adapters（判不出就判红）"];
  const problems = [];
  if (!isIsolatedAgentPath(record.home, roots) || isAgentPathInside(record.home, realHome)) {
    problems.push(`宿主实际生效 home=${String(record.home)} 不在 temp 下`);
  }
  const specs = new Map(AGENT_ISOLATION_ADAPTERS.map((spec) => [spec.id, spec]));
  const seen = new Set();
  for (const item of adapters) {
    const id = typeof item?.agent === "string" ? item.agent : "";
    const spec = specs.get(id);
    if (!spec) {
      problems.push(`表外 agent id=${id || "<空>"}（隔离白名单里没有，判不出就判红）`);
      continue;
    }
    seen.add(id);
    const files = Array.isArray(item.files) ? item.files : null;
    if (!files) {
      problems.push(`${id}: 没回报文件列表（判不出就判红）`);
      continue;
    }
    for (const file of files) {
      if (!isIsolatedAgentPath(file, roots) || isAgentPathInside(file, realHome)) {
        problems.push(`${id}: ${String(file)} 不在 temp 下`);
      }
    }
    if (item.installsFiles !== false && spec.realHomeFiles.length > 0 && files.length === 0) {
      problems.push(`${id}: 装文件型适配器却回报了空候选路径`);
    }
  }
  for (const id of specs.keys()) {
    if (!seen.has(id)) problems.push(`${id}: 宿主没回报（少一家 = 少一处检查，判红）`);
  }
  return problems;
}

/**
 * 把一组文件拍成可逐项比较的快照串：`路径|mtime|size`，读不到记 `路径|missing`。
 * 判「子进程只在隔离目录里干活、真实 home 的配置一个字没动」用这条。
 * 单看 mtime 不够：文件被删时 mtime 根本读不到，必须与「有文件」区分开，所以三种情况都进串。
 */
export function snapshotAgentFiles(files) {
  return files.map((file) => {
    try {
      const st = statSync(file);
      return `${file}|${st.mtimeMs}|${st.size}`;
    } catch {
      return `${file}|missing`;
    }
  });
}
