// NSIS 卸载钩子的静态检查（离线，不打包）。
//
// 为什么要它：`--pet-hook-cleanup` 那条真实链路只有出 NSIS 包并真的卸载一次才跑得到，
// 而 runner 的套件白名单里没有 verify:release（它自己起 release exe、占 9224、还要 3~4 分钟打包），
// 派单也明令不得改那套件的清单。所以「钩子有没有接上」只能机械地查磁盘与配置：
// 配置指向的文件在不在、宏在不在、命令串拼得对不对、失败会不会拦住卸载。
// 真实安装包那条路仍由 PM 在发版前跑 tools/check-nsis-cleanup.ps1 取证。
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, group } from "./harness.mjs";
import {
  AGENT_ISOLATION_ADAPTERS,
  AGENT_ISOLATION_ENV_NAMES,
  agentIsolationEnv,
  devAgentHomeDefault,
  devDshHomeDefault,
  hostIsolationProblems,
  realHomeAgentFiles,
  snapshotAgentFiles,
  unknownAgentIsolationAdapters,
  unisolatedAgentAdapters,
} from "../e2e/harness/fixtures.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const hooksPath = conf?.bundle?.windows?.nsis?.installerHooks;

group("NSIS 钩子接线");
check("tauri.conf.json 配了 bundle.windows.nsis.installerHooks", typeof hooksPath === "string" && hooksPath !== "");
// 路径以 src-tauri 为基准（与 tauri.conf.json 同目录），不是仓库根。
// 读不到就留空串继续跑：让下面每条断言各自变红，而不是整个文件在 import 阶段炸掉 ——
// 炸掉的红色没有名字，看不出去向。
const hookRel = `src-tauri/${hooksPath}`;
const hookExists = (() => {
  try {
    readFileSync(join(REPO, hookRel));
    return true;
  } catch {
    return false;
  }
})();
check("钩子文件真的存在", hookExists, hookRel);

const hook = hookExists ? read(hookRel) : "";
// 从配置读产物名，不写死：改 Cargo.toml 的 package.name 就该连带改这里
const cargoName = read("src-tauri/Cargo.toml").match(/^\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/m)?.[1];
check("Cargo.toml 里读得到二进制名", typeof cargoName === "string" && cargoName !== "", String(cargoName));

// A13 删掉的 MAINBINARYNAME 兜底必须永远回不来：installer.nsi 先 include 钩子文件（line 32），
// 之后才无条件 !define MAINBINARYNAME（line 48）；钩子里再定义一次就是 makensis 的致命重定义错误，
// L5.2 的 `npm run tauri build` 两次都红在这里。
// 只扫非注释行：文件头那段说明注释里就有 "!define" 与 "MAINBINARYNAME" 两个词，全文正则会自己判红。
const defineHits = hook
  .split(/\r?\n/)
  .map((text, i) => ({ no: i + 1, text }))
  .filter(({ text }) => {
    const head = text.replace(/^\s+/, "");
    return head !== "" && !head.startsWith(";") && !head.startsWith("#");
  })
  .filter(({ text }) => /^\s*!define\s+MAINBINARYNAME\b/i.test(text));
check(
  "钩子文件不得定义 MAINBINARYNAME（模板会无条件 !define，撞名致 makensis 失败）",
  defineHits.length === 0,
  defineHits.length
    ? defineHits.map((h) => `命中 ${h.no}: ${h.text}`).join(" | ")
    : "非注释行里没有 MAINBINARYNAME 定义",
);

group("NSIS_HOOK_PREUNINSTALL 宏");
check("定义了 NSIS_HOOK_PREUNINSTALL", hook.includes("!macro NSIS_HOOK_PREUNINSTALL"));
// 空文件会让「两边都是 0」成立，所以先要求至少有一个宏 —— 否则这条判据是空转的
const macroOpen = (hook.match(/!macro\s/g) ?? []).length;
check(
  "宏有配对收尾",
  macroOpen > 0 && macroOpen === (hook.match(/!macroend/g) ?? []).length,
  `open=${macroOpen} end=${(hook.match(/!macroend/g) ?? []).length}`,
);
// 取宏体：只在这一段里判，免得文件头注释里的同名词自己命中自己
const macroBody = hook.slice(
  hook.indexOf("!macro NSIS_HOOK_PREUNINSTALL"),
  hook.indexOf("!macroend", hook.indexOf("!macro NSIS_HOOK_PREUNINSTALL")),
);

check("卸载前调用的是本包里的 exe", macroBody.includes('ExecWait \'"$INSTDIR\\'), macroBody.slice(0, 200));
check("命令串整体带引号（$INSTDIR 可能有空格）", /ExecWait\s+'"\$INSTDIR\\.*?\.exe"/.test(macroBody));
check("参数是 --pet-hook-cleanup", macroBody.includes("--pet-hook-cleanup"));
check("exe 名取自 MAINBINARYNAME 宏而不是写死", /\$\{MAINBINARYNAME\}\.exe/.test(macroBody));

group("卸载不能被清理失败拦住");
check("宏体里没有 Abort", !macroBody.includes("Abort"), macroBody);
check("没有按退出码分支（只打印）", !/\$\{\s*If\}\s+\$0/.test(macroBody) && !/IfErr/.test(macroBody));
check("退出码进了 DetailPrint", /\${\s*DetailPrint[^$]*\$0/.test(macroBody) || macroBody.includes("$0 ("));

group("升级时不能把 hook 摘掉");
// Tauri 的卸载器在覆盖安装时可能被安装器自己调起；模板用 UpdateMode 区分，
// 启动侧「只摘不装」，所以这里不跟着分流就会留下一次静默失效
check("按 UpdateMode 分流", /\$\{If\}\s+\$UpdateMode\s+<>\s+1/.test(macroBody));
const elseAt = macroBody.search(/\$\{Else\}/);
const endAt = macroBody.search(/\$\{EndIf\}/);
check("有 Else 分支可走", elseAt >= 0 && endAt > elseAt, `else=${elseAt} endif=${endAt}`);
const elseBody = elseAt >= 0 && endAt > elseAt ? macroBody.slice(elseAt, endAt) : "";
check("升级分支里不清理", elseBody.length > 0 && !elseBody.includes("ExecWait"), elseBody);

group("钩子文件与宿主分流的一致性");
// 不用 /[^\x00-\x7F]/ 这种写法：biome 的 noControlCharactersInRegex 拦控制字符区间
const nonAscii = (text) => Array.from(text).filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);
check("钩子文件纯 ASCII（makensis 按代码页读的坑）", nonAscii(hook).length === 0, JSON.stringify(nonAscii(hook).slice(0, 5)));
// PowerShell 5.1 读没有 BOM 的 .ps1 按系统 ANSI（GBK）解码，中文注释能把脚本自己弄炸
const ps1 = (() => { try { return read("tools/check-nsis-cleanup.ps1"); } catch { return ""; } })();
check("发版前手动脚本存在", ps1.length > 0, "tools/check-nsis-cleanup.ps1 读不到");
check("手动脚本纯 ASCII", nonAscii(ps1).length === 0, JSON.stringify(nonAscii(ps1).slice(0, 5)));
check("手动脚本没设 PET_AGENT_CONFIG_FILES 就拒绝跑", ps1.includes("PET_AGENT_CONFIG_FILES is not set"));
check("手动脚本挡开真实 agent 目录", ps1.includes(".qoder-cn") && ps1.includes(".workbuddy"));
const lib = read("src-tauri/src/lib.rs");
check("lib.rs 分流了 --pet-hook-cleanup", lib.includes('"--pet-hook-cleanup"'));
check("分流后调用的是 linkage 的清理实体", lib.includes("linkage::run_cleanup_cli()"));
const cleanupAt = lib.indexOf("--pet-hook-cleanup");
const builderAt = lib.indexOf("tauri::Builder::default()");
check("分流排在建窗之前", cleanupAt >= 0 && cleanupAt < builderAt, `cleanup=${cleanupAt} builder=${builderAt}`);

group("bundle.resources 真的投递到 plugins/<插件ID>/");
// 两种写法都会静默丢插件，且都不出包就看不出来：
// 数组形式里 `..` 被 tauri 渲染成字面目录 `_up_`，资源根下没有 plugins/；
// 对象映射的源一旦含通配符就走 glob 分支，目标只取文件名 —— 五个插件的 manifest.json 同名互相覆盖。
//
// 现在有两个资源根：`plugins/`（各插件目录）与 `integrations/`（DSH 桥 bundle，
// 要落成 <安装目录>/integrations/dsh-bridge 供用户在 DSH 里 install_bundle）。
// 判定因此放宽成「目标 = 源目录名 + /」，但根白名单钉死，多的根必须显式加进来 ——
// 否则又会出现「资源被投到 <安装目录>/foo/ 却没人文件名对得上」的静默错。
const RESOURCE_ROOTS = ["plugins/", "integrations/"];
const judgeResources = (value) => {
  const out = { object: false, mapped: false, noWildcard: false };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  out.object = true;
  const entries = Object.entries(value);
  out.mapped =
    entries.length > 0 &&
    entries.every(([from, to]) => {
      if (typeof to !== "string" || !RESOURCE_ROOTS.some((root) => to.startsWith(root))) return false;
      // `<dir>` → `<dir>/`：目标必须与源目录同名，拍平或改名都会让运行时按 id 找不到资源
      const base = from.replace(/\/+$/u, "").split(/[\\/]/u).pop();
      return to === `${base}/`;
    });
  out.noWildcard = entries.length > 0 && entries.every(([from]) => !from.includes("*"));
  return out;
};
const resources = conf?.bundle?.resources;
const judged = judgeResources(resources);
const dump = JSON.stringify(resources);
check("bundle.resources 是对象映射而不是数组", judged.object, dump);
check("每个源都有同名目标、且只投到 plugins|integrations 两个根（空串与缺失都判红）", judged.mapped, dump);
check("bundle.resources 的源不含通配符（含则层级被拍平）", judged.noWildcard, dump);
// 反向对照：同一组判定喂给三个历史反例，必须各自判假，防「怎么改都绿」的空判
const arrayShape = judgeResources(["../plugins/**/*"]);
const globShape = judgeResources({ "../plugins/**/*": "plugins/" });
const renamedShape = judgeResources({ "../plugins": "foo/" });
check(
  // glob 那条在新口径下被两道拦（目标该是 `*/`、键里还有 `*`），反例只要求「别全绿」
  "反向对照：数组被 object/mapped 拦下，glob 被 mapped+noWildcard 拦下，改名目标被 mapped 拦下",
  !arrayShape.object &&
    !arrayShape.mapped &&
    globShape.object &&
    !globShape.mapped &&
    !globShape.noWildcard &&
    renamedShape.object &&
    !renamedShape.mapped &&
    renamedShape.noWildcard,
  JSON.stringify({ arrayShape, globShape, renamedShape }),
);

// ==== Bug1 / G2-03 / G7-09：agent 隔离 env 的收口 ====
// 「只设 PET_AGENT_CONFIG_FILES」曾经只隔离 Qoder 一家：卸载前那条 --pet-hook-cleanup
// 走 uninstall_everywhere，扫的是 adapters::wired() 四家，ZCode 只认 PET_AGENT_HOME、
// Codex 与 WorkBuddy 缺省也退到它。G2-03 又把判据改成 fail-closed 白名单：变量**设了**
// 但值落在 temp 之外（典型是真实 home）同样算没隔离 —— 旧口径「设了变量就信」正好
// 放过这种最危险的配置（值就指向用户真配置）。这里把判据钉成行为级反例。
group("Agent 隔离 env 收口（Bug1 / G2-03）");
// 反斜杠必须成对写：源里单写 `\U` 会被 JS 当无效转义吃掉，REAL 就退化成 "C:Usersme"，
// 下面所有 startsWith / 等值判定会全绿但测的是个假路径 —— 所以专门钉一条防住这个坑。
const REAL = "C:\\Users\\me";
const TEMP_ROOT = tmpdir();
const tempPath = (...parts) => join(TEMP_ROOT, "pet-iso-fixtures", ...parts);
const tempIsolation = () =>
  JSON.stringify({
    PET_AGENT_CONFIG_FILES: `${tempPath("a.json")};${tempPath("b.json")}`,
    PET_AGENT_HOME: tempPath("agent-home"),
  });
check("夹具 home 是带反斜杠的 Windows 路径（转义没被吃掉）", REAL.includes("\\Users\\me"), REAL);
check(
  "一个隔离变量都没设：四家全裸奔",
  JSON.stringify(unisolatedAgentAdapters({}, REAL)) === JSON.stringify(["qoder", "zcode", "codex", "workbuddy"]),
  JSON.stringify(unisolatedAgentAdapters({}, REAL)),
);
check(
  "只设 PET_AGENT_CONFIG_FILES（值在 temp 下）：ZCode/Codex/WorkBuddy 仍退到真实 home",
  JSON.stringify(unisolatedAgentAdapters({ PET_AGENT_CONFIG_FILES: `${tempPath("a.json")};${tempPath("b.json")}` }, REAL)) ===
    JSON.stringify(["zcode", "codex", "workbuddy"]),
  JSON.stringify(unisolatedAgentAdapters({ PET_AGENT_CONFIG_FILES: `${tempPath("a.json")};${tempPath("b.json")}` }, REAL)),
);
check(
  "fail-closed 反例：逐文件变量齐设、值都指向真实 home —— 旧口径「设了就算隔离」会放行，新版四家全红",
  JSON.stringify(
    unisolatedAgentAdapters(
      {
        PET_AGENT_CONFIG_FILES: `${join(REAL, ".qoder", "settings.json")};${join(REAL, ".qoder-cn", "settings.json")}`,
        PET_AGENT_CODEX_FILES: join(REAL, ".codex", "hooks.json"),
        PET_AGENT_WORKBUDDY_FILES: join(REAL, ".workbuddy", "settings.json"),
        PET_AGENT_HOME: REAL,
      },
      REAL,
    ),
  ) === JSON.stringify(["qoder", "zcode", "codex", "workbuddy"]),
  JSON.stringify(
    unisolatedAgentAdapters(
      {
        PET_AGENT_CONFIG_FILES: `${join(REAL, ".qoder", "settings.json")};${join(REAL, ".qoder-cn", "settings.json")}`,
        PET_AGENT_CODEX_FILES: join(REAL, ".codex", "hooks.json"),
        PET_AGENT_WORKBUDDY_FILES: join(REAL, ".workbuddy", "settings.json"),
        PET_AGENT_HOME: REAL,
      },
      REAL,
    ),
  ),
);
check(
  "三个逐文件变量齐设（都在 temp）但没换根：只剩 ZCode（它没有逐文件变量）",
  JSON.stringify(
    unisolatedAgentAdapters(
      {
        PET_AGENT_CONFIG_FILES: `${tempPath("a.json")};${tempPath("b.json")}`,
        PET_AGENT_CODEX_FILES: tempPath("c.json"),
        PET_AGENT_WORKBUDDY_FILES: tempPath("w.json"),
      },
      REAL,
    ),
  ) === JSON.stringify(["zcode"]),
);
check(
  "换根到 temp：四家都隔离",
  unisolatedAgentAdapters({ PET_AGENT_HOME: tempPath("agent-home") }, REAL).length === 0,
);
check(
  "PET_AGENT_HOME 指到真实 home 本身：四家全判未隔离（与「没设」同判）",
  JSON.stringify(unisolatedAgentAdapters({ PET_AGENT_HOME: REAL }, REAL)) ===
    JSON.stringify(["qoder", "zcode", "codex", "workbuddy"]),
  JSON.stringify(unisolatedAgentAdapters({ PET_AGENT_HOME: REAL }, REAL)),
);
check(
  "PET_AGENT_HOME 是真实 home 的子目录：白名单之外，新版判未隔离（旧口径的「换根成功」太宽）",
  unisolatedAgentAdapters({ PET_AGENT_HOME: join(REAL, "temp-x") }, REAL).length === 4,
  JSON.stringify(unisolatedAgentAdapters({ PET_AGENT_HOME: join(REAL, "temp-x") }, REAL)),
);
check(
  "大小写不敏感：TEMP 路径写成大写仍算隔离（旧实现区分大小写会误判）",
  unisolatedAgentAdapters({ ...JSON.parse(tempIsolation()), PET_AGENT_HOME: tempPath("agent-home").toUpperCase() }, REAL).length === 0,
);
check("空串与全空白都算没设", unisolatedAgentAdapters({ PET_AGENT_HOME: "   " }, REAL).length === 4);
check(
  "表外的 agent id 直接判红，不静默跳过（G2-03 fail-closed）",
  JSON.stringify(unknownAgentIsolationAdapters(["qoder", "claude", "dsh", "claude"])) === JSON.stringify(["claude"]),
  JSON.stringify(unknownAgentIsolationAdapters(["qoder", "claude", "dsh", "claude"])),
);
check(
  "agentIsolationEnv 只转发白名单内的值：temp 值留下、空白键不留",
  JSON.stringify(agentIsolationEnv({ PET_AGENT_CONFIG_FILES: tempPath("a.json"), PET_AGENT_HOME: "  ", PET_AGENT_INBOX: tempPath("inbox") })) ===
    JSON.stringify({ PET_AGENT_CONFIG_FILES: tempPath("a.json"), PET_AGENT_INBOX: tempPath("inbox") }),
  JSON.stringify(agentIsolationEnv({ PET_AGENT_CONFIG_FILES: tempPath("a.json"), PET_AGENT_HOME: "  ", PET_AGENT_INBOX: tempPath("inbox") })),
);
check(
  "agentIsolationEnv 对真实 home 的值直接抛错，不静默转发（转发=让子进程写用户真配置）",
  (() => {
    try {
      agentIsolationEnv({ PET_AGENT_HOME: REAL });
      return false;
    } catch (err) {
      return /未隔离|不在 temp|真实 home/.test(String(err.message));
    }
  })(),
);
check(
  "隔离变量全集覆盖逐文件三件套 + 换根 + 收件目录 + DSH home（G2-06）",
  AGENT_ISOLATION_ENV_NAMES.join(",") ===
    "PET_AGENT_CONFIG_FILES,PET_AGENT_HOME,PET_AGENT_CODEX_FILES,PET_AGENT_WORKBUDDY_FILES,PET_AGENT_INBOX,PET_DSH_HOME",
  AGENT_ISOLATION_ENV_NAMES.join(","),
);
check(
  "真实 home 候选文件：Qoder 两份 + ZCode 两份 + Codex/WorkBuddy 各一份",
  realHomeAgentFiles(REAL).length === 6 &&
    realHomeAgentFiles(REAL).every((p) => p.startsWith(REAL)) &&
    realHomeAgentFiles(REAL).includes(join(REAL, ".zcode", "cli", "config.json")) &&
    realHomeAgentFiles(REAL).includes(join(REAL, ".codex", "hooks.json")) &&
    realHomeAgentFiles(REAL).includes(join(REAL, ".workbuddy", "settings.json")),
  JSON.stringify(realHomeAgentFiles(REAL)),
);
check("snapshotAgentFiles 把缺文件与有文件区分开", JSON.stringify(snapshotAgentFiles([join(REAL, "no-such-dir", "x.json")])[0]).includes("missing"));

// 跨语言一致性：JS 侧这张表是给 e2e 判「哪家会退到真实 home」用的，Rust 加了适配器而这里没跟上，
// 隔离判据会静默变松 —— 所以按 mod.rs 的 WIRED 数组体反查数量与 id。
const adaptersDir = "src-tauri/src/services/agent/adapters";
const modSrc = read(`${adaptersDir}/mod.rs`);
const wiredBody = modSrc.match(/static WIRED[^=]*=\s*&\[([\s\S]*?)\];/)?.[1] ?? "";
const wiredEntries = [...wiredBody.matchAll(/&([a-z_]+)::([A-Z_]+)/g)].map((m) => ({ mod: m[1], name: m[2] }));
check(
  "JS 隔离表的数量与 Rust WIRED 一致",
  wiredEntries.length > 0 && wiredEntries.length === AGENT_ISOLATION_ADAPTERS.length,
  `rust=${wiredEntries.length} js=${AGENT_ISOLATION_ADAPTERS.length}`,
);
const rustIds = wiredEntries
  .map(({ mod: m }) => {
    const src = (() => {
      try {
        return read(`${adaptersDir}/${m}.rs`);
      } catch {
        return "";
      }
    })();
    return (
      src.match(/fn id\(&self\)\s*->\s*&'static str\s*\{\s*"([a-z-]+)"/)?.[1] ??
      src.match(/\bid:\s*"([a-z-]+)"/)?.[1] ??
      "?"
    );
  })
  .sort()
  .join(",");
check(
  "JS 隔离表的 id 与 Rust 适配器 id 逐一对应",
  rustIds === AGENT_ISOLATION_ADAPTERS.map((a) => a.id).sort().join(","),
  `rust=${rustIds} js=${AGENT_ISOLATION_ADAPTERS.map((a) => a.id).sort().join(",")}`,
);

// G2-02：dev-debug 未设 PET_AGENT_HOME 时必须给 temp 缺省值、把真实 home 拒掉（行为判据）
const devDefault = devAgentHomeDefault({}, { roots: [TEMP_ROOT], tempRoot: TEMP_ROOT });
check("G2-02 未设 PET_AGENT_HOME 时缺省值落在 temp 下", devDefault.startsWith(resolve(TEMP_ROOT)), devDefault);
let devRefused = "";
try {
  devAgentHomeDefault({ PET_AGENT_HOME: join(REAL, ".zcode") }, { roots: [TEMP_ROOT], tempRoot: TEMP_ROOT });
} catch (err) {
  devRefused = String(err?.message ?? err);
}
check("G2-02 PET_AGENT_HOME 指向真实 home 时拒绝启动", devRefused.includes("拒绝启动"), devRefused);
const devKept = devAgentHomeDefault({ PET_AGENT_HOME: tempPath("agent-home") }, { roots: [TEMP_ROOT], tempRoot: TEMP_ROOT });
check("G2-02 已隔离的 PET_AGENT_HOME 原样保留", devKept === resolve(tempPath("agent-home")), devKept);

// G2-06：桥读 `~/.dsh` 的 profile —— dev 缺省必须落在 temp，真实 DSH profile 要拒。
const dshDefault = devDshHomeDefault({}, { roots: [TEMP_ROOT], tempRoot: TEMP_ROOT });
check("G2-06 未设 PET_DSH_HOME 时缺省值落在 temp 下", dshDefault.startsWith(resolve(TEMP_ROOT)), dshDefault);
let dshRefused = "";
try {
  devDshHomeDefault({ PET_DSH_HOME: join(REAL, ".dsh") }, { roots: [TEMP_ROOT], tempRoot: TEMP_ROOT });
} catch (err) {
  dshRefused = String(err?.message ?? err);
}
check("G2-06 PET_DSH_HOME 指向真实 home 时拒绝启动", dshRefused.includes("拒绝启动"), dshRefused);
const dshKept = devDshHomeDefault({ PET_DSH_HOME: tempPath("dsh-home") }, { roots: [TEMP_ROOT], tempRoot: TEMP_ROOT });
check("G2-06 已隔离的 PET_DSH_HOME 原样保留", dshKept === resolve(tempPath("dsh-home")), dshKept);
check(
  "G2-06 dev-debug 启动前真的会应用 DSH home 缺省",
  read("tools/dev-debug.mjs").includes("prepareDshHome()") && read("tools/dev-debug.mjs").includes("devDshHomeDefault"),
);

// G2-01：隔离守卫只信宿主回报的 everywhere —— 形状缺失/表外 agent/少一家/路径不在 temp
// 都必须判红（fail-closed）。这几条反例是「套件自己按 env 拼路径」那种旧判据抓不到的。
const everywhereOk = {
  home: tempPath("agent-home"),
  overrides: [],
  adapters: AGENT_ISOLATION_ADAPTERS.map((a) => ({
    agent: a.id,
    displayName: a.id,
    installsFiles: a.realHomeFiles.length > 0,
    files: a.realHomeFiles.map((rel) => tempPath("agent-home", ...rel.split("/"))),
  })),
};
const isoProblems = (value) => hostIsolationProblems(value, { roots: [TEMP_ROOT], realHome: REAL });
check("G2-01 宿主回报全在 temp 下时放行", isoProblems(everywhereOk).length === 0, isoProblems(everywhereOk).join("；"));
// A3（R1）：上面这组以前写成 `check(name, true, <真实布尔>)` —— harness 的第三参只是失败
// 消息，判定恒真（把 detail 改成 false 仍绿），不能当 G2-01 的证据。现在判定写在第二参上，
// 并额外钉住 fail-closed 的最低保证：缺回报 / 空对象 / 缺 files 列表都必须返回问题项。
check("G2-01 缺 everywhere 判红（fail-closed）", isoProblems(undefined).length > 0, isoProblems(undefined).join("；"));
check("G2-01 everywhere 是空对象也判红", isoProblems({}).length > 0, isoProblems({}).join("；"));
check(
  "G2-01 宿主回报里缺 files 列表判红（fail-closed）",
  isoProblems({ ...everywhereOk, adapters: [{ agent: "qoder" }] }).length > 0,
  isoProblems({ ...everywhereOk, adapters: [{ agent: "qoder" }] }).join("；"),
);
check("G2-01 宿主没回报 everywhere 判红", isoProblems(undefined).join("；").includes("没有回报"), isoProblems(undefined).join("；"));
const withUnknown = {
  ...everywhereOk,
  adapters: [...everywhereOk.adapters, { agent: "claude", displayName: "Claude", installsFiles: true, files: [tempPath("claude.json")] }],
};
check("G2-01 表外 agent（隔离白名单里没有）判红", isoProblems(withUnknown).join("；").includes("表外 agent"), isoProblems(withUnknown).join("；"));
const missingOne = { ...everywhereOk, adapters: everywhereOk.adapters.filter((a) => a.agent !== "dsh") };
check("G2-01 表里的适配器少回报一家判红", isoProblems(missingOne).join("；").includes("dsh: 宿主没回报"), isoProblems(missingOne).join("；"));
const realPath = {
  ...everywhereOk,
  adapters: everywhereOk.adapters.map((a) => (a.agent === "zcode" ? { ...a, files: [join(REAL, ".zcode", "cli", "config.json")] } : a)),
};
check("G2-01 任一候选路径落在真实 home 判红", isoProblems(realPath).join("；").includes("zcode"), isoProblems(realPath).join("；"));
check("G2-01 缺文件列表判红（判不出就判红）", isoProblems({ ...everywhereOk, adapters: [{ agent: "qoder" }] }).join("；").includes("没回报文件列表"), isoProblems({ ...everywhereOk, adapters: [{ agent: "qoder" }] }).join("；"));

// 手动脚本那条路：隔离 guard 是**行为**判据 —— 用 pwsh 真跑反例（G2-04 / G7-09），
// 而不是查源码里有没有某句话：把判断改成恒真时字符串还在、断言照样绿。
const PS_SHELL =
  ["pwsh", "powershell"].find(
    (exe) => spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0,
  ) ?? "";
const guardRun = spawnSync(
  PS_SHELL || "pwsh",
  ["-NoProfile", "-NonInteractive", "-File", join(REPO, "tools/check-nsis-cleanup.ps1"), "-GuardSelfTest"],
  { encoding: "utf8" },
);
const guardOut = String(guardRun.stdout ?? "");
const guardCases = guardOut.split(/\r?\n/).filter((line) => line.startsWith("guard-case "));
check(
  "手动脚本的隔离 guard 用 pwsh 真跑反例并全部命中期望（G7-09）",
  PS_SHELL !== "" && guardRun.status === 0 && /GUARD-SELFTEST ok cases=\d+/.test(guardOut),
  `shell=${PS_SHELL} status=${guardRun.status} ${guardOut.slice(-400)}${String(guardRun.stderr ?? "").slice(-200)}`,
);
// 覆盖必须真的含这几类反例：真实 profile、TEMP 白名单外、落在真实 agent 目录、
// CODEX / WORKBUDDY 的 FILES（G2-04 补的两个变量）、inbox、DSH home（G2-06）、
// 两条 A3（R4）新增的子规则反例（强制 CONFIG_FILES、file-vars 的真实 agent 目录检查）。
const guardCoverage = [
  "home-is-the-real-profile",
  "home-outside-temp",
  "home-sits-in-a-real-agent-dir",
  "codex-files-point-at-real-home",
  "workbuddy-files-outside-temp",
  "inbox-outside-temp",
  "dsh-home-temp-is-ok",
  "dsh-home-outside-temp",
  "dsh-home-is-the-real-profile",
  "config-files-missing",
  "codex-files-sit-in-a-real-agent-dir-inside-temp",
];
const guardCaseNames = new Set(guardCases.map((line) => line.match(/^guard-case name=(\S+) /)?.[1]).filter(Boolean));
check(
  "guard 反例覆盖四家的变量（含 G2-04 的 CODEX / WORKBUDDY、G2-06 的 DSH、A3 的两条子规则）",
  guardCases.length >= 14 && guardCoverage.every((name) => guardCaseNames.has(name)),
  `cases=${guardCases.length} names=${[...guardCaseNames].join(",")}`,
);
// A3（R2）：阈值 >= 14 只是下限；DSH 三条必须**真实存在**于 ps1 的 -GuardSelfTest 输出里
// （用 name= 集合反查，而不是 includes 模糊匹配），删用例或改名都会红。
const dshHomeCases = ["dsh-home-temp-is-ok", "dsh-home-outside-temp", "dsh-home-is-the-real-profile"];
check(
  "每条 dsh-home-* 都在 guard 真跑输出里（名单与 ps1 双向一致）",
  dshHomeCases.every((name) => guardCaseNames.has(name)),
  `missing=${dshHomeCases.filter((name) => !guardCaseNames.has(name)).join(",") || "none"} names=${[...guardCaseNames].join(",")}`,
);
// 「未设 PET_AGENT_HOME 时自填一次性 temp 根」也不能只查源码：反例里必须有这一条。
check(
  "guard 反例含「只设了文件变量、home 没设」这条（fail-closed）",
  guardCases.some((line) => line.includes("config-only-leaves-home-unset")),
  guardCases.join(" | "),
);

// 套件那条路：cleanup 子进程的 env 必须来自同一份收口，而不是各拼一份
const bridge = read("tests/e2e/verify-agent-bridge.mjs");
check(
  "cleanup 子进程的 env 走统一的 agentIsolationEnv",
  bridge.includes("const isolationPatch = agentIsolationEnv(env)") &&
    bridge.includes("const cleanupEnv = { ...env, ...isolationPatch }"),
);
check("起子进程前先判隔离缺口，名单非空就不 spawn", bridge.includes("unisolatedAgentAdapters(env, REAL_HOME)") && bridge.includes("if (isolationGap.length > 0)"));
check("cleanup 跑完显式判真实 home 的条数未变", bridge.includes("realHomeAgentFiles(REAL_HOME)") && bridge.includes("--pet-hook 条数未被 cleanup 改动"));

// A3（R3，已知边界，不修代码）：ps1 主流程里「真实 home 的 --pet-hook 安装前后各数一次 + 相等断言」
// （tools/check-nsis-cleanup.ps1 的 BEFORE/AFTER 段）只在**真跑安装/卸载**时执行 —— 需要装好的
// NSIS 安装包与本机卸载流程；`-GuardSelfTest` 只跑隔离守卫，不执行那两段。离线单测没有行为级钉子
// （最多也只能核源码里那几行存在），不要把「self-test 全绿」当 BEFORE/AFTER 的行为证据。
