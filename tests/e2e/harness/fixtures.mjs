// 验证用临时插件 fixture：由脚本写入 plugins/、跑完删除（.gitignore 已忽略这两个名字，
// 中途崩溃也不会被误提交）。前缀 zz. 便于人工识别残留。
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

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
