// 环境常量、路径、联动状态读取与夹具播种（原顶层 35-95）
// 由 tests/e2e/verify-agent-bridge.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { argv, env } from "node:process";

// 模块已从 tests/e2e/ 搬进 tests/e2e/isolation/：相对路径基准显式钉在上一层，避免 dirname 深一层解析错目录
const E2E_DIR = resolve(import.meta.dirname, "..");

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const AGENT_ID = "com.pet.agent-bridge";
// 常驻行挂在宠物本体那扇窗的气泡上；隐身是整扇窗 hide（src-tauri/src/window/pet.rs 的
// set_pet_hidden → get_webview_window("pet")），所以「这一行看不看得见」的硬信号只有窗级的那一个
const PET_WINDOW_LABEL = "pet";
// 探针插件：只为钉住「声明 agent:hooks 的插件第一次调用必经同意框」这条宿主规则。
// 规则与用户此刻有没有授权过真实的 Agent 插件无关 —— 探针起手必然没授权，所以那一扇框
// 是必然要弹的；运行时自建自删，全程不碰 com.pet.agent-bridge 的授权状态。
const PROBE_ID = "zz.agentconsent";
const PLUGINS_DIR = resolve(E2E_DIR, "../../plugins");
const PROBE_DIR = join(PLUGINS_DIR, PROBE_ID);
const EXE = join(E2E_DIR, "../../src-tauri/target/debug/desktop-pet.exe");
// 没有 APPDATA 就拼不出收件目录，断言会打在 cwd 下一个同名相对路径上 ——
// 那种失败和「宿主真的没收到事件」长得一模一样，必须当场拒绝开跑
if (!env.APPDATA) {
  console.error("缺 APPDATA 环境变量：找不到宿主收件目录，拒绝开跑。");
  process.exit(2);
}
// 与 Rust 侧 inbox_dir 同一条规则：设了 PET_AGENT_INBOX 就用它（宿主实例也必须带同一个值），
// 否则落回 APPDATA 下的共享目录 —— 那时本机全局 Qoder hook 的真实会话会混进来
const INBOX = env.PET_AGENT_INBOX || join(env.APPDATA, "com.desktoppet.pet", "agent", "inbox");
const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);

/**
 * 让三家「装文件型」适配器的候选落点先存在，再问宿主 everywhere（G2-01 的前置）。
 * targets() 只回报「父目录已存在」的落点，zcode.rs:42-44 的注释写明它不替用户造文件；
 * t26 之后 everywhere.home 报的是**生效** home（temp），不种的话三家候选全空，
 * precheck 会先红、整组写盘断言连坐跳过，「空候选=安全放行」的反向判据也失去意义。
 * 只碰 PET_AGENT_HOME（temp）下的东西；⑨/⑩/⑪ 三组各自还会清掉自建夹具。
 */
function seedAgentCandidates() {
  const home = String(env.PET_AGENT_HOME ?? "");
  const tempRoot = resolve(E2E_DIR, "../../temp");
  if (home === "" || !resolve(home).startsWith(tempRoot + sep)) return 0;
  const seed = [
    [join(home, ".codex", "hooks.json"), { hooks: {} }],
    [join(home, ".workbuddy", "settings.json"), { hooks: {} }],
    [join(home, ".zcode", "cli", "config.json"), { hooks: { enabled: false }, permissions: { allow: [] } }],
    [join(home, ".zcode", "cli", "setting.json"), { hooks: { enabled: false } }],
  ];
  for (const [file, body] of seed) {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, JSON.stringify(body, null, 2));
  }
  return seed.length;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// 联动状态文件在宿主自己的数据目录（不是 Agent 的配置），套件只读它取证。
// 放模块级：⑥ 与 ⑨ 两组都要读，留在某一组的 else 里会让另一组 ReferenceError（G7-12a 的断链）。
const TAURI_IDENTIFIER = JSON.parse(
  readFileSync(resolve(E2E_DIR, "../../src-tauri/tauri.conf.json"), "utf8"),
).identifier;
const LINKAGE_FILE = join(env.APPDATA, TAURI_IDENTIFIER, "agent-linkage.json");
function linkageAgent() {
  try {
    return JSON.parse(readFileSync(LINKAGE_FILE, "utf8")).agent ?? null;
  } catch {
    return "<读不到>";
  }
}

export { PORT, AGENT_ID, PET_WINDOW_LABEL, PROBE_ID, PLUGINS_DIR, PROBE_DIR, EXE, INBOX, isPetPage, seedAgentCandidates, sleep, TAURI_IDENTIFIER, LINKAGE_FILE, linkageAgent, E2E_DIR };
