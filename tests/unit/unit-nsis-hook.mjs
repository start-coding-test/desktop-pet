// NSIS 卸载钩子的静态检查（离线，不打包）。
//
// 为什么要它：`--pet-hook-cleanup` 那条真实链路只有出 NSIS 包并真的卸载一次才跑得到，
// 而 runner 的套件白名单里没有 verify:release（它自己起 release exe、占 9224、还要 3~4 分钟打包），
// 派单也明令不得改那套件的清单。所以「钩子有没有接上」只能机械地查磁盘与配置：
// 配置指向的文件在不在、宏在不在、命令串拼得对不对、失败会不会拦住卸载。
// 真实安装包那条路仍由 PM 在发版前跑 tools/check-nsis-cleanup.ps1 取证。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, group } from "./harness.mjs";

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
