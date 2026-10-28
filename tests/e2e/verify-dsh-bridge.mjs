// DSH 桥的运行时断言（G6-09）：桥装没装、接入、退出联动三条路径都在**真实例**上跑。
//   终端 1: PET_DSH_HOME=<仓库>/temp/dsh-home-e2e npm run dev:debug
//   终端 2: PET_DSH_HOME=<仓库>/temp/dsh-home-e2e npm run verify:dsh
//
// 为什么单独一套而不是并进 verify:agent：桥的「装没装」不是配置文本，而是 DSH profile
// 的 `dsh.profile.bundles` 清单；这条路径要**在跑着的实例上改 profile 文件再看宿主回显**，
// 与 verify:agent 的 hook 文本夹具是两套前置（前者要进程里换 profile 内容，后者要一次性
// preseed 的配置文件）。并进 verify:agent 会让那份 preseed 夹具变成「跑完安装/卸载再被
// 桥用例读」，前置互相污染；独立一套的代价只是多一次冷启动。
//
// 前置（缺一条就 exit 2，绝不静默降级）：
//   * 能连上 dev 实例的 CDP 端口（与别的 UI 套件一样，先 npm run dev:debug）；
//   * 实例与套件**同一个** PET_DSH_HOME，且该路径在 temp 白名单内（隔离守卫，G2-06）；
//   * APPDATA 可用（要读/还原宿主的 agent-linkage.json）。
//
// 覆盖：
//   ① 没 profile 列桥时：切/装 DSH 都被拒，错误文案指路 install_bundle（检测不到桥）；
//   ② 假 profile 的 bundles 列了包名后：检测为已装，attach 成功、写 agent=dsh、零 hook 文件；
//   ③ 桥目录消失再装：运行时判据跟着变回「未装」（同一进程里两态都验）；
//   ④ detach 到 qoder：hook 装到 qoder、agent-linkage 记 qoder、提示桥仍留在 DSH profile；
//   ⑤ 卸载：bridgeHint 说明桥还在，agent 记成 null。
//
// 收尾：把 agent-linkage.json 与 qoder 配置文件恢复成本跑之前的样子，删掉假 profile。
// 不要与别的 UI 套件并发跑：preseed 夹具与宠物窗都只有一份。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, env } from "node:process";
import {
  attach,
  createReport,
  openSettingsInvoker,
  waitForPage,
} from "./harness/cdp.mjs";
import { devDshHomeDefault } from "./harness/fixtures.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const BRIDGE_PACKAGE = "dsh-pet-agent-bridge";
const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** 前置缺失统一走 exit 2：红是「环境没准备好」，不是「功能坏了」，两者不能混报 */
function missing(why) {
  console.error(`\n缺前置，拒绝开跑（exit 2）：${why}`);
  process.exit(2);
}

if (!env.APPDATA) missing("APPDATA 未设置，找不到宿主状态目录（agent-linkage.json）");
if (!env.PET_DSH_HOME) missing("PET_DSH_HOME 未设置：本套件要往假 profile 里写 bundles 清单");
let dshHome;
try {
  // 与 dev-debug 同一套白名单判据：不在 temp 下直接抛，别把开发机真实 ~/.dsh 当夹具改
  dshHome = devDshHomeDefault(env, { tempRoot: join(REPO_ROOT, "temp") });
} catch (err) {
  missing(String(err?.message ?? err));
}
const identifier = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri/tauri.conf.json"), "utf8")).identifier;
const APP_DIR = join(env.APPDATA, identifier);
const LINKAGE_FILE = join(APP_DIR, "agent-linkage.json");
const PROFILE_DIR = join(dshHome, "profiles", "zz-e2e-dsh");
const PROFILE_FILE = join(PROFILE_DIR, "package.json");
const BUNDLE_DIR = join(REPO_ROOT, "integrations/dsh-bridge");
// qoder 的候选文件走 PET_AGENT_CONFIG_FILES（预设的两份 temp 样例）；没有它时退回 PET_AGENT_HOME 下的目录
const QODER_FILES = String(env.PET_AGENT_CONFIG_FILES ?? "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
const agentHome = env.PET_AGENT_HOME ? resolve(env.PET_AGENT_HOME) : null;

const norm = (p) => String(p ?? "").replaceAll("\\", "/").toLowerCase();
/** 展平路径里的 `..`/`.`：宿主 dev 形态报的是 CARGO_MANIFEST_DIR/../integrations/dsh-bridge，
 * 和 resolve 过的 BUNDLE_DIR 逐字不同，但指同一个目录（断言的是「用户能照着装」）。 */
const flatten = (p) => {
  const out = [];
  for (const seg of norm(p).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
};
const r = createReport("DSH 桥运行时（dev）");

/** 写一份「列了桥」的 profile；DSH 实际把 profile 放在 ~/.dsh/profiles/<name>/package.json */
function writeProfile(bundles) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  writeFileSync(
    PROFILE_FILE,
    JSON.stringify({ name: "zz-e2e-dsh", version: "0.0.0", private: true, dsh: { profile: { bundles } } }, null, 2),
  );
}

const readLinkage = () => {
  try {
    return JSON.parse(readFileSync(LINKAGE_FILE, "utf8"));
  } catch {
    return null;
  }
};

// 备份：本跑会改 agent-linkage.json 与（detach 时）qoder 的配置文件，收尾原样写回。
// 原来不存在 ≠ 写成空对象：那样下一轮启动会认为「用户选过某个 Agent」。
const origLinkage = existsSync(LINKAGE_FILE) ? readFileSync(LINKAGE_FILE, "utf8") : null;
const origQoder = QODER_FILES.map((p) => (existsSync(p) ? readFileSync(p, "utf8") : null));

/** qoder 的候选文件只在「父目录存在」时才算数（claude_style.rs:170-191 的 filter），
 *  所以 detach 之前要把两份 temp 样例的父目录与文件补齐；收尾按备份恢复/删除。 */
function ensureQoderFixtures() {
  for (const p of QODER_FILES) {
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, "{}");
  }
}

let c = null;
let settings = null;

try {
  await waitForPage(PORT, isPetPage, 60_000);
} catch {
  missing(`连不上 dev 实例的 CDP 端口 ${PORT}；请先带同一个 PET_DSH_HOME 启动 npm run dev:debug`);
}

try {
  // 起手把上一轮可能残留的假 profile 清掉，否则「未检测到桥」那组会红在继承状态上
  rmSync(PROFILE_DIR, { recursive: true, force: true });

  c = await attach(PORT, isPetPage);
  settings = await openSettingsInvoker(PORT, c);

  r.group("前置：套件与实例同一份隔离环境");
  const status0 = await settings.invoke("agent_hooks_status");
  r.check("起手能读到宿主状态", true, status0.ok);
  r.info("PET_DSH_HOME", dshHome);
  r.info("桥目录", BUNDLE_DIR);
  if (!status0.ok) throw new Error(`agent_hooks_status 失败: ${status0.e}`);
  // 注意：hook 形态的 snapshot 不带 bridge 字段（只有 dsh 形态才带），所以这里不能拿
  // bridge.dshHome 当硬前置。真正对账放在下面「本该被拒却切成功了」的分支里：只有切成功后
  // 才会出现 bridge 字段，用它就能区分「实例跑的是另一份 PET_DSH_HOME」和「检测逻辑坏」。
  const hostBridge0 = status0.v?.bridge ?? null;
  if (hostBridge0) r.info("宿主读到的 PET_DSH_HOME", String(hostBridge0.dshHome ?? "(空)"));

  // ① 没装桥：检测不到 → 拒切（错误要指路 install_bundle，而不是「未知错误」）
  r.group("没装桥：DSH 不可接入（检测不到桥）");
  writeProfile([]);
  const rejectSet = await settings.invoke("agent_linkage_set", { agent: "dsh" });
  if (rejectSet.ok) {
    // 本该被拒却切成功了：先分清是「实例看的是另一份 PET_DSH_HOME」（换了实例/没带 env 重启，
    // 那个目录里恰好残留了列着桥的 profile）还是「检测本身坏了」。前者按环境没准备好退 2。
    const afterStatus = await settings.invoke("agent_hooks_status").catch(() => ({ ok: false, v: {} }));
    const hostHome = String(afterStatus?.v?.bridge?.dshHome ?? "");
    if (flatten(hostHome) !== flatten(dshHome)) {
      missing(
        `实例的 PET_DSH_HOME 与套件不一致：宿主=${hostHome || "(空)"} 套件=${dshHome}；请用同一份 env 重启 dev 实例（空 profile 写的是 ${PROFILE_DIR}）`,
      );
    }
  }
  r.check("没桥时切到 dsh 被拒", false, rejectSet.ok);
  r.check("拒绝码是 not-found", "not-found", rejectSet.code);
  r.check("拒绝文案指路 install_bundle", true, /install_bundle/.test(String(rejectSet.e)));
  r.check(
    "拒绝文案带上桥目录的实际路径（用户能照着装）",
    true,
    flatten(rejectSet.e).includes(flatten(BUNDLE_DIR)),
  );
  const straddled = existsSync(LINKAGE_FILE) ? readFileSync(LINKAGE_FILE, "utf8") : null;
  r.check("被拒之后 agent-linkage 没被改写（逐字节等于备份）", origLinkage, straddled);

  // ② 假 profile 的 bundles 列了桥：检测为已装 → attach 成功，且不写任何 hook 文件
  r.group("profile 里列了桥：检测到 + attach（写 agent=dsh、零 hook 文件）");
  const hookFilesBefore = agentHome ? listHookFiles(agentHome) : null;
  writeProfile(["dsh-ops", BRIDGE_PACKAGE]);
  const attached = await settings.invoke("agent_linkage_set", { agent: "dsh" });
  r.check("列了桥之后切到 dsh 成功", true, attached.ok);
  if (attached.ok) {
    const v = attached.v;
    r.check("返回的 agent 是 dsh", "dsh", v.agent);
    r.check("attach 不写任何 hook 文件", [], v.files);
    r.check("返回 bridge.detected 为真", true, v.bridge?.detected);
    r.check("返回 bridge.profiles 为 1", 1, v.bridge?.profiles);
    r.check("返回 bridge.package 是桥包名", BRIDGE_PACKAGE, v.bridge?.package);
    r.check("返回 bridge.bundleDir 指向 integrations/dsh-bridge", true, norm(v.bridge?.bundleDir).endsWith("integrations/dsh-bridge"));
    r.check("返回 bridge.dshHome 与套件的 PET_DSH_HOME 一致", true, norm(v.bridge?.dshHome) === norm(dshHome));
    r.check("bridge 形态没有自检（null 不是「查过且干净」）", null, v.selfCheck);
  }
  const stBridge = (await settings.invoke("agent_hooks_status")).v;
  r.check("状态回显 mode=bridge", "bridge", stBridge.mode);
  r.check("状态回显 installed=true", true, stBridge.installed);
  r.check("状态回显 agent=dsh", "dsh", stBridge.agent);
  r.check("bridge 形态 managed=0", 0, stBridge.managed);
  r.check("bridge 形态 expectedPerFile=0", 0, stBridge.expectedPerFile);
  r.check("bridge 形态 files 为空", [], stBridge.files);
  r.check("设置页候选里 dsh 的 hint 指路 install_bundle", true, /install_bundle/.test(
    String((stBridge.options ?? []).find((o) => o.id === "dsh")?.hint),
  ));
  r.check("agent-linkage.json 记下了 dsh", "dsh", readLinkage()?.agent);
  r.check("attach 前后 qoder 的 hook 文件一字未动（dsh 不碰别家）", [],
    hookFilesBefore === null ? [] : diffFiles(hookFilesBefore, listHookFiles(agentHome)));

  // ③ 桥目录消失：同一个进程里判据跟着变回「未装」—— attach 命令被拒，装回去又能成功
  r.group("桥目录消失/恢复：运行时判据跟着变（不缓存旧检测）");
  rmSync(PROFILE_DIR, { recursive: true, force: true });
  const gone = await settings.invoke("agent_hooks_install");
  r.check("桥没了之后「接入」被拒", false, gone.ok);
  r.check("拒装码是 not-found", "not-found", gone.code);
  r.check("拒装文案指路 install_bundle", true, /install_bundle/.test(String(gone.e)));
  writeProfile([BRIDGE_PACKAGE]);
  const back = await settings.invoke("agent_hooks_install");
  r.check("桥装回来之后再「接入」成功", true, back.ok);
  r.check("装回来仍不写 hook 文件", [], back.ok ? back.v.files : "接入失败");
  r.check("装回来 bridge.detected 为真", true, back.ok ? back.v.bridge?.detected : "接入失败");

  // ④ detach 到 qoder：hook 装到 qoder、选择记 qoder、提示桥仍挂在 DSH profile 里
  r.group("detach 到 qoder：选择换人、桥留在 DSH 里（bridgeHint 说清）");
  ensureQoderFixtures();
  const qoder = await settings.invoke("agent_linkage_set", { agent: "qoder" });
  r.check("切到 qoder 成功", true, qoder.ok);
  if (qoder.ok) {
    r.check("返回 agent 是 qoder", "qoder", qoder.v.agent);
    r.check("返回 bridgeHint 点名桥还在 DSH 的 1 个 profile 里", true,
      /桥插件仍挂在 DSH 的 1 个 profile 里/.test(String(qoder.v.bridgeHint)));
    r.check("bridgeHint 指路 DSH 里用 plugin_manager 卸载（不是宿主代卸）", true,
      /plugin_manager/.test(String(qoder.v.bridgeHint)));
  }
  const stHook = (await settings.invoke("agent_hooks_status")).v;
  r.check("detach 后状态回显 mode=hook", "hook", stHook.mode);
  r.check("detach 后状态回显 agent=qoder", "qoder", stHook.agent);
  r.check("detach 后状态回显已安装（qoder hook 真的写下去了）", true, stHook.installed);
  r.check("detach 后 agent-linkage.json 记 qoder", "qoder", readLinkage()?.agent);
  r.check("detach 没有去动 DSH 的 bundles（宿主不代卸桥）", true, listsBridge());

  // ⑤ 卸载：agent 记 null，bridgeHint 仍提示桥留在 DSH
  r.group("卸载：记 null，但桥还在（bridgeHint 留给用户下一步）");
  const reAttach = await settings.invoke("agent_linkage_set", { agent: "dsh" });
  r.check("切回 dsh 成功", true, reAttach.ok);
  const uninstalled = await settings.invoke("agent_hooks_uninstall");
  r.check("卸载成功", true, uninstalled.ok);
  r.check("卸载返回 bridgeHint 说明桥仍在 DSH 1 个 profile", true,
    /桥插件仍挂在 DSH 的 1 个 profile 里/.test(String(uninstalled.v?.bridgeHint)));
  r.check("卸载之后 agent 记成 null（明确退出）", null, readLinkage()?.agent);
} catch (err) {
  r.check("脚本未抛异常", true, false);
  console.error("\n验证中断: " + String(err?.message ?? err).split("\n").slice(0, 3).join(" | "));
} finally {
  // 收尾 1：删掉假 profile（别把「桥已装」的状态留给下一轮套件或用户）
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true });
  } catch (e) {
    r.info("假 profile 删除失败（需要手工清）", String(e).slice(0, 120));
  }
  // 收尾 2：恢复 agent-linkage.json 与 qoder 配置文件。恢复的是原文，不是「重新选一次」：
  // 后者会把用户上一次的 hooksEnabled/prevHooksEnabled 等键抹成当前默认值。
  try {
    if (origLinkage === null) rmSync(LINKAGE_FILE, { force: true });
    else writeFileSync(LINKAGE_FILE, origLinkage);
    QODER_FILES.forEach((p, i) => {
      if (origQoder[i] === null) rmSync(p, { force: true });
      else writeFileSync(p, origQoder[i]);
    });
    r.info("宿主状态与 qoder 夹具已恢复", "是");
  } catch (e) {
    r.info("状态恢复失败（需要手工清的落点）", String(e).slice(0, 160));
  }
  settings?.close();
  c?.close();
  const failed = r.summary();
  await sleep(400);
  process.exit(failed ? 1 : 0);
}

/** 读 profile 的 bundles 里有没有桥（用于断言「宿主没去改对方清单」） */
function listsBridge() {
  try {
    const manifest = JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
    return (manifest?.dsh?.profile?.bundles ?? []).includes(BRIDGE_PACKAGE);
  } catch {
    return false;
  }
}

/** 递归列出 agent home 下的配置文件（只用于「attach 不该写文件」的对照，数量少） */
function listHookFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else out.push({ path: p, size: readFileSync(p).length });
    }
  };
  walk(root, 0);
  return out;
}

function diffFiles(before, after) {
  const map = new Map(before.map((f) => [f.path, f.size]));
  return after
    .filter((f) => map.get(f.path) !== f.size)
    .map((f) => f.path);
}
