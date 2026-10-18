// L1 原型（ADR-0006）的离线契约单测：Worker 通道这张表就是插件的全部发言面。
//
// 三层钉法：
//   ① 表本身 —— 24 个名字逐条钉死，且每个叶子名都能在 packages/sdk/index.d.ts 里找到成员声明；
//   ② 宿主派发表完备 —— 22 个「纯参数进纯值出」的方法在 worker-plugin-host.ts 里必须逐条点名；
//   ③ 隔离前提 —— Worker 侧那两个文件里不许出现 @tauri-apps 或 host-error（一旦漏进去，
//      裸 IPC 就跟着 bundle 进了 Worker realm，本波要收口的洞当场作废）。
//
// 运行：npm run unit（随全量离线单测一起跑；真机那部分见 npm run verify:worker）
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, deep, eq, group } from "./harness.mjs";
import { inspect } from "./import-graph.mjs";

const proto = await import(new URL("../../src/runtime/plugin-worker-protocol.ts", import.meta.url));
const { LEGACY_CODE } = await import(new URL("../../src/runtime/host-error.ts", import.meta.url));

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const sdkSrc = read("../../packages/sdk/index.d.ts");
const hostSrc = read("../../src/runtime/worker-plugin-host.ts");
const workerSrc = read("../../src/runtime/plugin-worker.ts");
const runtimeSrc = read("../../src/runtime/plugin-runtime.ts");
const sorted = (list) => [...list].sort();

/** ADR-0006 契约里那张 23 个方法的表，逐字钉死（改名、增删都要先改 ADR）
 *  —— 第 23 个是 B3 的 `pet.setStatus`，见 ADR-0006「增项记录（2026-10-17）」 */
const EXPECTED = [
  "agentHooks.install",
  "agentHooks.set",
  "agentHooks.status",
  "agentHooks.uninstall",
  "ble.connect",
  "ble.connectedDevice",
  "ble.disconnect",
  "ble.startScan",
  "ble.stopScan",
  "bus.publish",
  "bus.subscribe",
  "http.request",
  "log",
  "notify.show",
  "overlay.destroy",
  "overlay.hide",
  "overlay.show",
  "pet.react",
  "pet.say",
  "pet.setStatus",
  "storage.delete",
  "storage.get",
  "storage.set",
  "widget.update",
];

group("Worker 通道方法表");
deep("方法表恰好是既定的 24 个名字", sorted(proto.PLUGIN_WORKER_METHODS), EXPECTED);
eq("方法表条数", proto.PLUGIN_WORKER_METHODS.length, 24);
eq("方法表无重复", new Set(proto.PLUGIN_WORKER_METHODS).size, 24);
for (const name of EXPECTED) {
  const leaf = name === "log" ? "log" : name.split(".")[1];
  check(`SDK 类型面里有 "${leaf}("`, sdkSrc.includes(`${leaf}(`), `packages/sdk/index.d.ts 里找不到 ${leaf}(`);
}
check(
  "命名空间只落在 PluginContext 的那几个成员上",
  [...new Set(proto.PLUGIN_WORKER_METHODS.map((m) => m.split(".")[0]))].every((ns) =>
    ["bus", "storage", "ble", "widget", "pet", "http", "notify", "overlay", "agentHooks", "log"].includes(ns),
  ),
);

group("宿主派发表完备");
const proxied = EXPECTED.filter((name) => name !== "bus.subscribe" && name !== "log");
eq("表内需实现的方法数", proxied.length, 22);
for (const name of proxied) {
  check(`worker-plugin-host.ts 点名实现了 "${name}"`, hostSrc.includes(`"${name}":`), "派发表里没有这一条");
}
check("两个带函数的方法在 dispatch 里特判", hostSrc.includes('msg.method === "bus.subscribe"') && hostSrc.includes('msg.method === "log"'));

group("入站方法名判据");
for (const name of EXPECTED) {
  check(`"${name}" 被接受`, proto.isWorkerMethod(name) === true);
}
for (const bad of ["plugins_list", "permission_revoke", "constructor", "__proto__", "", "storage", "log.get"]) {
  check(`"${bad}" 被拒`, proto.isWorkerMethod(bad) === false);
}
for (const bad of [undefined, null, 42, {}, []]) {
  check(`非字符串方法名被拒（${JSON.stringify(bad)}）`, proto.isWorkerMethod(bad) === false);
}

group("错误负载过通道");
const codes = JSON.parse(read("../../packages/sdk/error-codes.json")).codes.map((c) => c.code);
eq("兜底码与 host-error 的 LEGACY_CODE 同值", proto.WORKER_LEGACY_CODE, LEGACY_CODE);
for (const code of codes) {
  check(`码表里的 "${code}" 原样通过`, proto.normalizeWorkerCode(code) === code);
}
eq("不在码表里的码退成兜底码", proto.normalizeWorkerCode("nope"), LEGACY_CODE);
eq("非字符串的码退成兜底码", proto.normalizeWorkerCode(undefined), LEGACY_CODE);
const rebuilt = proto.fromWorkerError({ code: "denied", message: "[zz.l1-probe] 权限被拒绝: storage" });
check("还原出来的是 Error 且名字是 HostError", rebuilt instanceof Error && rebuilt.name === "HostError");
eq("文案逐字不变", rebuilt.message, "[zz.l1-probe] 权限被拒绝: storage");
eq("码挂在 Error 上", rebuilt.code, "denied");

group("Worker 侧不得带进裸 IPC（传递闭包，P2-5）");
// 旧判据是两个手写正则：只认双引号、只看**直接** import —— 改成单引号，或者中间过一层
// re-export，它就看不见了。现在真的把 import 图走一遍（AST 取说明符 + 递归相对导入），
// Worker 侧入口的**整个**可达闭包里出现 IPC 入口即红。
const entryPath = (rel) => fileURLToPath(new URL(rel, import.meta.url));
for (const [label, entry] of [
  ["plugin-worker.ts", entryPath("../../src/runtime/plugin-worker.ts")],
  ["widget-worker.ts", entryPath("../../src/runtime/widget-worker.ts")],
]) {
  const hit = inspect(entry);
  check(`${label} 的传递闭包不触及 @tauri-apps`, hit.tauri.length === 0, `命中: ${hit.tauri.join(", ")}`);
  check(`${label} 的传递闭包不触及 host-error`, hit.hostErrorFiles.length === 0, `命中: ${hit.hostErrorFiles.join(", ")}`);
  check(`${label} 的闭包不是空的（防判据空转）`, hit.files.length >= 2, `闭包内文件数 ${hit.files.length}`);
}
// 反向对照：宿主侧入口必须命中 host-error，否则说明这套闭包判据根本没走到 IPC 入口那一层
check(
  "宿主侧入口的闭包命中 host-error（反向对照）",
  inspect(entryPath("../../src/runtime/worker-plugin-host.ts")).hostErrorFiles.length === 1,
);
check("Worker 本体不碰 window.", !workerSrc.includes("window."));
check("宿主侧才 import 真实通道", hostSrc.includes('from "./host-error"'));

group("闭包判据自身可信（防空转，P2-5）");
{
  // 造两个「违规」模块做负向对照：① 用**单引号** import @tauri-apps —— 旧正则正是被这一手绕过的；
  // ② 把 host-error 藏在下一层的相对导入里 —— 旧判据只看直接 import，同样看不见。
  const tmpDir = mkdtempSync(join(tmpdir(), "pet-import-graph-"));
  const bad = join(tmpDir, "bad.ts");
  writeFileSync(bad, "import { invoke } from '@tauri-apps/api/core';\nimport { x } from './mid';\nexport const y = [invoke, x];\n");
  writeFileSync(join(tmpDir, "mid.ts"), "import { z } from './host-error';\nexport const x = z;\n");
  writeFileSync(join(tmpDir, "host-error.ts"), "export const z = 1;\n");
  const hit = inspect(bad);
  check("单引号 import @tauri-apps 被抓到（旧正则会漏）", hit.tauri.length === 1, `命中: ${hit.tauri.join(", ")}`);
  check(
    "隔一层的 host-error 也被抓到（旧判据只看直接 import）",
    hit.hostErrorFiles.length === 1,
    `命中: ${hit.hostErrorFiles.join(", ")}`,
  );
  rmSync(tmpDir, { recursive: true, force: true });
}

group("例外名单与接线");
eq("例外键名", proto.REALM_HOST_FLAG, "host:realm-plugin-host");
check("缺省（键不存在）= 走 Worker", proto.shouldUseWorkerHost("com.pet.todo", null) === true);
check("空名单 = 走 Worker", proto.shouldUseWorkerHost("com.pet.todo", "") === true);
check("别人的 id 在名单里不算", proto.shouldUseWorkerHost("com.pet.todo", "com.pet.hr-ble") === true);
check("点名的插件留在宿主 realm", proto.shouldUseWorkerHost("com.pet.todo", "com.pet.hr-ble, com.pet.todo") === false);
check("只有它自己也被剔出 Worker", proto.shouldUseWorkerHost("zz.probe", "zz.probe") === false);
check("宠物窗按名单分流", runtimeSrc.includes("shouldUseWorkerHost(") && runtimeSrc.includes("workerHost()"));
check("启停两条路径都在", runtimeSrc.includes(".activate(manifest)") && runtimeSrc.includes(".deactivate(pluginId)"));
check("Worker 宿主的插件不再触发整页重载", runtimeSrc.includes("!workerHosted.has(id)"));
check(
  "plugin-runtime.ts 不在顶层 import Worker 宿主（`?worker` 说明符 node 解析不了）",
  !/\nimport \{ workerPluginHost \} from "\.\/worker-plugin-host"/.test(runtimeSrc),
);
