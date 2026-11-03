// 插件页 Qoder hook 接入端到端（原 1221-1758）
// 由 tests/e2e/verify-agent-bridge.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { env } from "node:process";
import { listPages, openSettingsInvoker, reconcilePetWindow, waitUntil, writeEnabledIds } from "../harness/cdp.mjs";
import { agentIsolationEnv, hostIsolationProblems, realHomeAgentFiles, unisolatedAgentAdapters } from "../harness/fixtures.mjs";
import { waitWidgetRealm } from "../harness/widget-realm.mjs";
import { AGENT_ID, E2E_DIR, EXE, INBOX, PORT, linkageAgent, seedAgentCandidates, sleep } from "./env.mjs";
import { emitPhase } from "./session.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseQoder(state) {
  const r = state.r;
  const token = state.token;
  const bubbleNow = state.bubbleNow;
  const waitStatusSlot = state.waitStatusSlot;
  const awaitGranted = state.awaitGranted;
  const ourTail = state.ourTail;
  const recExpr = state.recExpr;
  const stateExpr = state.stateExpr;
  const clickShadow = state.clickShadow;
  const statusText = state.statusText;
  r.group("插件页：Qoder hook 接入（端到端，只碰 temp 样例）");
  // A9a：入口在 agent 桥自己的设置页（settings 区 widget）。写盘类断言一律只碰
  // PET_AGENT_CONFIG_FILES 指到的 temp/a9a 样例；不满足就整组跳过并说清原因。
  const TEMP_ROOT = resolve(E2E_DIR, "../../temp");
  state.TEMP_ROOT = TEMP_ROOT;
  const A9A_DIR = join(TEMP_ROOT, "a9a");
  const cfgA = join(A9A_DIR, "cfg-a.json");
  const cfgB = join(A9A_DIR, "cfg-b.json");
  mkdirSync(A9A_DIR, { recursive: true });
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
  writeFileSync(cfgA, foreignOnly("a"));
  writeFileSync(cfgB, foreignOnly("b"));

  if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c);
  r.info("预置三家候选落点", `种了 ${seedAgentCandidates()} 个文件（只碰 PET_AGENT_HOME/temp）`);
  const st0 = await state.settings.invoke("agent_hooks_status");
  const files0 = Array.isArray(st0.v?.files) ? st0.v.files : [];
  const underTemp = files0.length > 0 && files0.every((f) => resolve(String(f.path)).startsWith(TEMP_ROOT + sep));
  state.underTemp = underTemp;
  r.info("hook 配置落点", files0.map((f) => f.path).join(" ； ") || "(空)");
  r.check("目标文件都在 temp/ 下（写盘断言只碰样例，不碰真实用户配置）", true, underTemp);
  // G2-01：隔离判据只有一份 —— 宿主回报的 `everywhere`（它按自己的 env 解析出的、**实际会写**的
  // 全部候选路径：Qoder 的 PET_AGENT_CONFIG_FILES、ZCode/Codex/WorkBuddy 的 PET_AGENT_HOME 换根、
  // Codex/WorkBuddy 的逐文件变量）。旧判据是套件自己按 env 拼（claude_style.rs:170-191、
  // zcode.rs:140-153）：宿主换了解析口径套件不知道，判据会静默变松 —— 正是这次 Bug1 的形状。
  // 现在按「宿主说会写哪里」判：缺 everywhere、表外 agent、少回报一家、任何一条路径不在 temp 下
  // 都判红（fail-closed）；红在前、正文不跑，避免真跑到写盘那步改掉用户的配置。
  const everywhere = st0.v && typeof st0.v === "object" ? st0.v.everywhere : undefined;
  const hostProblems = hostIsolationProblems(everywhere, { realHome: homedir() });
  r.check(
    "宿主回报的候选路径全部在 temp 下（含 PET_AGENT_HOME / *_FILES 解析后的值）",
    [],
    hostProblems,
  );
  r.info("宿主实际生效 home", String(everywhere?.home ?? "(未回报)"));
  // 子进程（卸载清理）另有一份 env：宿主回报的是它自己的解析结果，子进程继承的是会话 env，
  // 两者都得成立 —— 任一份不成立都不 spawn。
  const isolationGap = unisolatedAgentAdapters(env, homedir());
  if (isolationGap.length > 0) {
    r.check("cleanup 子进程的 env 也已换根（四家）", [], isolationGap);
  }
  // 写盘断言要按「宿主说会写的那几家」拿候选路径（G2-01 之后判据只剩 everywhere 这一份），
  // 不再自己按 env 拼 —— 拼出来的值和宿主解析口径一漂，夹具就种到了宿主不会扫的地方。
  const AGENT_FAMILIES = (Array.isArray(everywhere?.adapters) ? everywhere.adapters : [])
    .filter((a) => Array.isArray(a?.files) && a.files.length > 0)
    .map((a) => ({ id: String(a.agent), claudeStyle: String(a.agent) !== "zcode", paths: a.files.map(String) }));
  const writesSafe = underTemp && hostProblems.length === 0 && isolationGap.length === 0;
  if (!writesSafe) {
    r.skip(
      "写盘断言",
      `隔离前置不成立（${[...hostProblems, ...isolationGap].join("；") || "Qoder 的候选文件不在 temp 下"}）；本组一个文件都不写`,
    );
  } else {
    // 「他人条目未变」沿用「逐字段未变」的同一口径：按键排序的规范串比较。
    // 注意这个排序只是**比对手段**，不代表宿主的行为：A02 起宿主开了 serde_json 的
    // preserve_order，整文件重写不再把键归一成字母序，而是原样保留用户自己的键序
    // （改 ZCode 那种混着 MCP/权限开关的配置就必须这样）。键序真被改坏时，
    // 红的是 commands/agent.rs 那条「往返后键序不变」的单测，不是这里。
    const canon = (value) => {
      if (Array.isArray(value)) return value.map(canon);
      if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value).sort()) out[k] = canon(value[k]);
        return out;
      }
      return value;
    };
    const foreignOf = (path) => {
      const v = JSON.parse(readFileSync(path, "utf8"));
      const out = [];
      for (const [event, groups] of Object.entries(v.hooks ?? {})) {
        for (const g of groups ?? []) {
          for (const h of g.hooks ?? []) {
            if (!String(h.command ?? "").includes("--pet-hook")) out.push([event, canon(h)]);
          }
        }
      }
      return JSON.stringify(out);
    };

    // Bug1 缺口（P1）的夹具：安装前在四家的候选文件里各放一条「别人家」的条目 + 一条自家
    // 陈旧条目（模拟旧 exe 路径留下的残渣）。自家那条是关键：不种它，「卸载后 --pet-hook 计数
    // 为 0」永远是 0，等于没判（P1 Bug4 那类伪断言）；种上之后，只有卸载真的扫到这家才会归零
    // —— 而它扫的正是 adapters::wired() 四家的 targets(home)，也就是 Bug1 出事的那条路径。
    const staleHook = (agent, timeoutField = "timeout") => ({
      type: "command",
      command: `"D:\\old\\desktop-pet.exe" --pet-hook stop --agent ${agent}`,
      [timeoutField]: 2,
    });
    const foreignWithStale = (tag, agent) =>
      JSON.stringify(
        {
          theme: "dark",
          note: `keep-${tag}`,
          hooks: {
            PreToolUse: [
              { hooks: [{ type: "command", command: `other-tool-${tag} --notify`, timeout: 5 }, staleHook(agent)] },
            ],
          },
        },
        null,
        2,
      );
    // ZCode 的形状与另外三家不同：事件挂在 hooks.events.<事件> 下、自家条目独占一个分组、
    // 超时字段叫 timeoutMs（zcode.rs:36-37、:181-195），另有一个 hooks.enabled 总开关
    // （语义与 WorkBuddy 的 disableAllHooks 相反：true = 开着）。总开关种成 **false**：⑨组
    // 的 ZCode 夹具原值就是 false（sample(false)），而 linkage 只在卸载/切回时清 hooksEnabled
    // —— 万一上一轮崩在「ZCode 已装、还没切回」之间，这条记录会留到本轮，于是这里的卸载会
    // 按记录 restore_switch 一次。原值对齐 false，那次恢复就是写回 false，不会把这条判据
    // 变成假红；反过来若种成 true，宿主一次**合法**的恢复就会让它红。总开关照旧进快照
    // （别人家的键同样是别人的东西）：真要有人把它改成 true，该红。
    const zcodeForeignWithStale = (tag) =>
      JSON.stringify(
        {
          mcpServers: { [`fake-${tag}`]: { command: `npx fake-mcp-${tag}` } },
          hooks: {
            enabled: false,
            events: {
              Stop: [
                { hooks: [{ type: "command", command: `other-tool-${tag}.cmd`, timeoutMs: 3000 }] },
                { hooks: [staleHook("zcode", "timeoutMs")] },
              ],
            },
          },
          permissions: { allow: ["Bash"] },
        },
        null,
        2,
      );
    // 「别人家的东西未变」的规范化快照：摘掉带 --pet-hook 的条目后再按键排序规整整篇。
    // 比只比 hooks 内层严：非 hooks 的键（theme/note/mcpServers/permissions/总开关）与分组上的
    // matcher 一起进快照 —— 卸载动的是别人整份文件，只对 hooks 内层取值等于少判一半；
    // 也比「原文逐字节」稳：宿主真改写时会重新序列化，缩进/空行会让原文比对假红，
    // 而「别人的条目与键有没有变」才是本组的判据（键序另有 Rust 那条往返单测钉住）。
    const withoutManaged = (groups) => {
      const kept = [];
      for (const g of groups ?? []) {
        const inner = (g?.hooks ?? []).filter((h) => !String(h?.command ?? "").includes("--pet-hook"));
        if (inner.length > 0) kept.push({ ...g, hooks: inner });
      }
      return kept;
    };
    const claudeStyleSnapshot = (path) => {
      const v = JSON.parse(readFileSync(path, "utf8"));
      const hooks = {};
      for (const [event, groups] of Object.entries(v.hooks ?? {})) {
        const kept = withoutManaged(groups);
        if (kept.length > 0) hooks[event] = kept;
      }
      return JSON.stringify(canon({ ...v, hooks }));
    };
    const zcodeSnapshot = (path) => {
      const v = JSON.parse(readFileSync(path, "utf8"));
      const events = {};
      for (const [event, groups] of Object.entries(v?.hooks?.events ?? {})) {
        const kept = withoutManaged(groups);
        if (kept.length > 0) events[event] = kept;
      }
      return JSON.stringify(canon({ ...v, hooks: { ...(v?.hooks ?? {}), events } }));
    };
    const familySnapshot = (fam) => {
      const take = fam.claudeStyle ? claudeStyleSnapshot : zcodeSnapshot;
      return fam.paths.map((p) => `${fam.id}|${p}|${existsSync(p) ? take(p) : "<缺文件>"}`);
    };
    const allFamilies = () => AGENT_FAMILIES.flatMap(familySnapshot);
    const petHooksIn = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("--pet-hook").length - 1 : "<缺文件>");

    // 落种子。Qoder 的 cfgA/cfgB 在上面已种过（且 ② 还要再改写 cfgA），所以这里只种另外三家。
    // 目录也建：targets() 只把「父目录存在」的当候选（claude_style.rs:180-191 的 exists 过滤，
    // ZCode 更是 `.zcode` 不存在就一个候选都不给），少了这条，卸载根本扫不到它，判据成了空判。
    for (const fam of AGENT_FAMILIES) {
      if (fam.id === "qoder") continue;
      for (const [i, p] of fam.paths.entries()) {
        const tag = `${fam.id}${i === 0 ? "" : i + 1}`;
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, fam.claudeStyle ? foreignWithStale(tag, fam.id) : zcodeForeignWithStale(tag));
      }
    }

    // 打开 agent 桥的插件页（套件前面已把它加进启用清单；没加上就补一次开关，与用户点开关同一条路径）
    await state.settings.client.ev(`document.querySelector('#nav-plugins .nav-item[data-view=${JSON.stringify(AGENT_ID)}]')?.click(); true`);
    if (!(await state.settings.client.ev(`document.getElementById('plugin-toggle')?.checked === true`))) {
      await state.settings.client.ev(`(() => { const t = document.getElementById('plugin-toggle'); t.checked = true; t.dispatchEvent(new Event('change')); return true; })()`);
    }
    const panelReady = await waitUntil(
      state.settings.client,
      `(async () => { const rec = ${recExpr}; return !!rec?.shadow?.querySelector('.hk-status'); })()`,
      20_000,
    );
    r.check("插件页挂出「Qoder hook 接入」块", true, panelReady);
    r.check(
      "插件页插槽的 realm 戳是 worker（默认路线）",
      "worker",
      (await waitWidgetRealm(state.settings.client, AGENT_ID, "settings", "worker", 20_000)).actual,
    );

    // ① 未装：样例里只有别人的 hook，managed=0
    const absent = await waitUntil(state.settings.client, stateExpr("absent"), 20_000);
    r.check("未装状态文案：挂载即回显「未安装」", true, absent && String(await statusText()).includes("未安装"));

    // ② 需要修复：cfg-a 塞两条自家陈旧条目（managed=2 ≠ 2×12）
    const stale = JSON.stringify(
      {
        theme: "dark",
        hooks: {
          Stop: [{ hooks: [
            { type: "command", command: `"D:\\old\\desktop-pet.exe" --pet-hook stop`, timeout: 2 },
            { type: "command", command: `"D:\\old\\desktop-pet.exe" --pet-hook pre`, timeout: 2 },
            { type: "command", command: "keep.sh", timeout: 3 },
          ] }],
        },
      },
      null,
      2,
    );
    writeFileSync(cfgA, stale);
    const expectForeign = `${foreignOf(cfgA)}|${foreignOf(cfgB)}`;
    // 四家的「别人条目」基线：这一刻四家的种子都已就位（cfgA 刚被改写成 stale），正是
    // 「安装之前」的口径；安装后与卸载后各比一次，判据只加严不改宽。
    const expectForeignAll = allFamilies();
    await clickShadow(".hk-refresh", "「刷新」按钮存在且可点");
    const repair = await waitUntil(state.settings.client, stateExpr("repair"), 15_000);
    const repairText = String(await statusText());
    r.check("需要修复状态：条数不对时不被显示成「已安装」", true, repair && repairText.includes("需要修复") && !repairText.includes("已安装"));

    // ③ 点安装 → 已装；每个样例文件恰好 expectedPerFile 条；回显与随后一次 status() 一致
    const clickedInstall = await clickShadow(".hk-install", "「安装」按钮存在且可点");
    const installed = clickedInstall && (await waitUntil(state.settings.client, stateExpr("installed"), 20_000));
    r.check("点安装后回显为已安装", true, installed);
    const stAfterInstall = (await state.settings.invoke("agent_hooks_status")).v;
    r.check(
      "安装后宿主 status：installed 为真且总数 = 文件数×expectedPerFile",
      true,
      stAfterInstall?.installed === true && stAfterInstall.managed === stAfterInstall.files.length * stAfterInstall.expectedPerFile,
    );
    for (const f of stAfterInstall?.files ?? []) {
      r.check("安装后样例文件恰好 expectedPerFile 条", stAfterInstall.expectedPerFile, readFileSync(f.path, "utf8").split("--pet-hook").length - 1);
    }
    // 装出来的条目必须带来源字段：不带的话，收件侧只能靠「缺省按 qoder」兜底 ——
    // 接线第二个 Agent 之后，那个兜底就是「桌宠对着别人的会话演」。
    // files.length 也钉住，否则空数组的 every() 恒真是条假绿。
    r.check(
      "装好的条目带 --agent qoder",
      true,
      (stAfterInstall?.files?.length ?? 0) > 0 &&
        (stAfterInstall?.files ?? []).every((f) =>
          readFileSync(f.path, "utf8").includes("--pet-hook pre --agent qoder"),
        ),
    );
    r.check("安装不改别人条目（复用按键排序规范串口径）", expectForeign, `${foreignOf(cfgA)}|${foreignOf(cfgB)}`);
    // 四家判据（Bug1 缺口）：安装只装 linkage 里当前那一家（commands/agent.rs:149-172 只扫
    // current_adapter），所以另外三家的条目一个字都不该动，它们那几条陈旧条目也该还在。
    // 反过来说：安装若也做全盘清扫，扫的同样是四家的 targets(home)，与卸载是同一颗雷。
    r.check("安装后四家的别人条目逐家未变（整篇规范化快照，含非 hooks 键）", expectForeignAll, allFamilies());
    for (const fam of AGENT_FAMILIES) {
      if (fam.id === "qoder") continue;
      for (const p of fam.paths) {
        r.check(`安装后 ${fam.id} 的陈旧条目仍在（安装只动当前那一家）`, 1, petHooksIn(p));
      }
    }
    const shownInstall = String(await statusText());
    r.check("回显条数与随后一次 status() 一致", true, shownInstall.includes(`共 ${stAfterInstall.managed} 条`));

    // ④ 点卸载 → 归零；别人条目仍未变
    const clickedUninstall = await clickShadow(".hk-uninstall", "「卸载」按钮存在且可点");
    const absent2 = clickedUninstall && (await waitUntil(state.settings.client, stateExpr("absent"), 20_000));
    r.check("点卸载后回显为未安装", true, absent2);
    for (const p of [cfgA, cfgB]) {
      r.check("卸载后 --pet-hook 条目归零", 0, readFileSync(p, "utf8").split("--pet-hook").length - 1);
    }
    r.check("卸载不动别人条目（与 verify-isolation 同口径：按键排序规范串）", expectForeign, `${foreignOf(cfgA)}|${foreignOf(cfgB)}`);
    // Bug1 缺口的正面判据：卸载走 uninstall_everywhere（agent_hooks.rs:398-403），扫的是
    // adapters::wired() 四家的 targets(home)，所以四家都要逐家验 —— 只验 Qoder 那两份的话，
    // 另外三家在真实 home 下被顺手摘掉时这里照样全绿，而那正是 Bug1 的原貌。
    // 两条判据互补：① 别人家的条目与键逐家未变（整篇规范化快照，逐家逐文件带路径）；
    // ② 每家每份文件的 --pet-hook 计数归零（种子里的陈旧条目必须被真摘掉，证明这家确实被扫到）。
    r.check("卸载后四家的别人条目逐家未变（整篇规范化快照，含非 hooks 键）", expectForeignAll, allFamilies());
    for (const fam of AGENT_FAMILIES) {
      for (const p of fam.paths) {
        r.check(`卸载后 ${fam.id} 的 --pet-hook 计数为 0（${p}）`, 0, petHooksIn(p));
      }
    }

    // ⑤ 旧断言「agent:hooks 的授权弹过同意框」已删除：它写的是「这一轮跑动期间真实 Agent
    // 插件的授权弹过框」，用户本就启用并授权 com.pet.agent-bridge 时收尾门控原样保留授权，
    // 这一轮不弹框，断言随继承状态红绿交替。同一宿主规则（声明 agent:hooks 的插件第一次
    // 调用必经同意框）改由上面探针组的首调断言钉住（起手必然没授权，那一扇框必然弹）。

    // ⑥ 启停联动（派单 §2 验收第一条）：停用插件要把自家条目摘净，再启用要装回来。
    // reconcile 就跑在同一次 plugin_enabled_set 调用里（装卸失败不拦启停，但顺序是先落盘
    // 再装卸），所以命令一返回磁盘上就已是结果 —— 不需要轮询等副作用追上来。
    r.group("启停联动：停用摘净、再启用恢复（只碰 temp 样例）");
    const ours = (p) => readFileSync(p, "utf8").split("--pet-hook").length - 1;
    // 状态文件在宿主自己的数据目录（不是 Agent 的配置），套件只读它取证
    const agentField = linkageAgent;

    // 起点：先经设置页装一次 —— 那是「用户显式选择」的唯一记录点，也是下面能自动装回来的前提
    const clickedReinstall = await clickShadow(".hk-install", "「安装」按钮再次可点（联动恢复的起点）");
    r.check(
      "再点安装后回显为已安装",
      true,
      clickedReinstall && (await waitUntil(state.settings.client, stateExpr("installed"), 20_000)),
    );
    const perFile = (await state.settings.invoke("agent_hooks_status")).v?.expectedPerFile ?? 0;
    r.check("停用前基线：两个样例各装满", [perFile, perFile], [ours(cfgA), ours(cfgB)]);
    r.check("设置页装成功就记下了用户选的 Agent", "qoder", agentField());
    const foreignBeforeToggle = `${foreignOf(cfgA)}|${foreignOf(cfgB)}`;

    const disabledIds = state.origEnabled.filter((id) => id !== AGENT_ID);
    // 停用之前先让插件手里确实挂着一条常驻行 —— 不预置这条基线，「停用把行摘掉」就成了空判
    emitPhase("pre", { tool_name: "Bash", session_id: "verify-line" });
    r.check(
      "停用前基线：本插件挂着一条非空的常驻行",
      true,
      await waitUntil(
        state.c,
        `(() => { const s = window.__pet.status; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) return s[i][1] !== null; return false; })()`,
        12_000,
      ),
    );
    await writeEnabledIds(state.settings.invoke, disabledIds);
    // 宠物窗不会收到 host:plugin-toggled（脚本是从设置窗写的），所以 JS 生命周期得靠既有入口
    // reconcile 一下 —— `rt.reconcile` 内部就是对未启用者调 `deactivatePlugin`、对启用者调
    // `activatePlugin`（plugin-runtime.ts:333-348）。上一轮 6&7 两条红就是漏了这一步：
    // Rust 侧 reconcile 把 hook 条目卸干净了（下面那条绿），但宠物窗里的 JS 还活着。
    await reconcilePetWindow(state.c);
    r.check("停用插件后自家条目归零", [0, 0], [ours(cfgA), ours(cfgB)]);
    r.check("停用插件不动用户自己的 hook 条目", foreignBeforeToggle, `${foreignOf(cfgA)}|${foreignOf(cfgB)}`);
    r.check("停用不清空 agent 字段（再启用全靠它恢复）", "qoder", agentField());
    // 原「停用后 overlay.destroy()」的实质（插件下线就别把东西留在桌面上）搬到常驻行上。
    // 归因要说清（A04-D9 第 4 条）：这条读的是**记录**（控制器被调用），不是气泡现状；但宿主在
    // disposeAll 的 register 回调与 worker terminate 收尾里还各兜底一次（bridge.ts / worker-plugin-host.ts:118），
    // 三个来源在同一个记录点上不可区分 ⇒ 真正把 M2（结束/停用不清 null）钉死的是上面那条
    // 「会话结束后常驻行清成 null」—— 那条时刻宿主没有任何兜底通路。这里只作第二证。
    r.check("停用插件时把自家那条常驻行摘掉（最后一次 set 是 null）", null, await ourTail());
    await waitStatusSlot();
    const afterOff = await bubbleNow();
    r.check("停用之后气泡没有还挂着一条单行化的常驻行", false, afterOff.show === true && afterOff.status === true);

    // 暂停广播：停用期间落一条事件，watcher 只该推进偏移量 —— 不发 agent:event、不进状态机。
    // 再启用后再写一条并真的跑一轮：只有新那条该被广播，停用期间那条永远不重放
    // （偏移量已经走过去）。两半合起来才是「只推进偏移量」，只看前一半等于没测后一半。
    const eventCount = async () =>
      (await state.c.ev(`window.__topics.filter(([k]) => k === 'host-event').length`));
    const eventsBeforePause = await eventCount();
    emitPhase("pre", { tool_name: "Bash", session_id: "verify-paused" });
    await sleep(1_500);
    r.check("停用期间不广播 agent 事件", eventsBeforePause, await eventCount());

    // 不先钉这条授权，下面的绿可能只是「没授权所以本来就不会装」
    r.check("再启用所需的 agent:hooks 授权仍在", true, await awaitGranted("agent:hooks"));
    await writeEnabledIds(state.settings.invoke, [...disabledIds, AGENT_ID]);
    // 同一段道理：JS 侧要 reconcile 才真的再激活（`activate()` 会把 seenCounter/agentName 复位）。
    await reconcilePetWindow(state.c);
    r.check("再启用后条目装回来", [perFile, perFile], [ours(cfgA), ours(cfgB)]);
    r.check("再启用同样不动别人条目", foreignBeforeToggle, `${foreignOf(cfgA)}|${foreignOf(cfgB)}`);

    emitPhase("post", { tool_name: "Bash", session_id: "verify-resumed" });
    await sleep(1_500);
    r.check(
      "再启用只广播新事件、不重放停用期间那条",
      eventsBeforePause + 1,
      await eventCount(),
    );
    r.check(
      "再启用之后事件一来常驻行就回来",
      true,
      await waitUntil(
        state.c,
        `(() => { const s = window.__pet.status; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] === ${JSON.stringify(AGENT_ID)}) return s[i][1] !== null; return false; })()`,
        12_000,
      ),
    );

    // ⑦ 来源过滤（A02）：与当前 Agent 不一致的事件只推进偏移量，不进状态机也不广播。
    // 用真 exe 注入而不是直接写收件文件：一次跑完「--agent 参数 → JSONL → watcher」整条链。
    r.group("来源过滤：别的 Agent 的事件不驱动桌宠");
    const foreignSess = `verify-foreign-${Date.now()}`;
    const eventsBeforeFilter = await eventCount();
    const foreign = spawnSync(EXE, ["--pet-hook", "pre", "--agent", "zcode"], {
      input: JSON.stringify({ session_id: foreignSess, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    r.check("带 --agent zcode 的 hook 分支退出码为 0", 0, foreign.status);
    await sleep(1_500);
    r.check("外来来源不产生 agent:event", eventsBeforeFilter, await eventCount());
    r.check(
      "外来事件确实落了盘（红在这条说明是采集坏了，而不是过滤生效）",
      true,
      readFileSync(join(INBOX, "pre.jsonl"), "utf8").includes(foreignSess),
    );
    // 对照：同一 phase 换成当前来源必须照常广播 —— 没有这条，上面的绿可能只是整条链断了
    const mine = spawnSync(EXE, ["--pet-hook", "pre", "--agent", "qoder"], {
      input: JSON.stringify({ session_id: `verify-mine-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    r.check("带 --agent qoder 的 hook 分支退出码为 0", 0, mine.status);
    r.check(
      "当前来源照常广播，且 payload 带上 agent 字段",
      true,
      await waitUntil(
        state.c,
        `(window.__topics.slice().reverse().find(([k]) => k === 'host-event')?.[1]?.agent === 'qoder')`,
        8_000,
      ),
    );
    r.check(
      "agent:state 也带上 agent 字段",
      true,
      await waitUntil(
        state.c,
        `(window.__topics.slice().reverse().find(([k]) => k === 'host-state')?.[1]?.agent === 'qoder')`,
        8_000,
      ),
    );

    // 缺省（不带 --agent）的旧形状必须仍然可用：A01 装好的条目就是这个形状
    const legacy = spawnSync(EXE, ["--pet-hook", "post"], {
      input: JSON.stringify({ session_id: `verify-legacy-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    r.check("不带 --agent 的旧 hook 条目退出码为 0", 0, legacy.status);
    r.check(
      "不带 --agent 时按 qoder 处理，事件照常被采集",
      true,
      await waitUntil(
        state.c,
        `(window.__topics.slice().reverse().find(([k]) => k === 'host-event')?.[1]?.phase === 'post')`,
        8_000,
      ),
    );

    // ⑧ --pet-hook-cleanup：NSIS 卸载前那条清理分支。跑在真的 dev 实例旁边，
    // 顺带证明分流发生在单实例锁与建窗之前 —— 排错了要么条目不被清，要么现成实例被干扰。
    r.group("卸载前清理分支（起一个 exe --pet-hook-cleanup）");
    const readInboxLen = () => {
      try {
        return readFileSync(join(INBOX, "pre.jsonl"), "utf8").length;
      } catch {
        return 0;
      }
    };
    const pagesBefore = (await listPages(PORT).catch(() => [])).length;
    const inboxBefore = readInboxLen();
    // 独立进程只从 environment 取夹具路径：显式带上**全套**隔离变量，避免 runner 环境差异
    // 让 cleanup 去扫真实 home（基线里 stripped=0 的首个失败点）。
    // 只转发 PET_AGENT_CONFIG_FILES 不够（Bug1）：cleanup 走 uninstall_everywhere，扫的是
    // adapters::wired() 四家 —— Qoder 认逐文件变量，ZCode 只认 PET_AGENT_HOME，Codex 与
    // WorkBuddy 缺省时也退到 PET_AGENT_HOME。漏一个，用户真配置里的条目就被摘掉了。
    // 所以先当场算一次「哪几家还会退到真实 home」，名单非空就一个子进程都不起：
    // 宁可少跑这一组，也不拿用户自己的配置当夹具。
    const REAL_HOME = homedir();
    const isolationGap = unisolatedAgentAdapters(env, REAL_HOME);
    r.check("隔离变量齐备：四家都不会退到真实 home", [], isolationGap);
    if (isolationGap.length > 0) {
      r.skip("转发的隔离变量", "隔离前置不成立，一个都不转发");
      r.skip(
        "清理分支",
        `这几家的候选文件仍落在真实 home：${isolationGap.join(", ")}；给 dev:debug 与本套件带上同一个 PET_AGENT_HOME（temp 下）再跑`,
      );
    } else {
      // agentIsolationEnv 现在对「设了却没隔离」的值直接抛错（G2-03/G7-09）：
      // 静默丢值会让子进程退回真实 home，等于把最危险的配置当默认值用。
      const isolationPatch = agentIsolationEnv(env);
      r.info("转发的隔离变量", Object.keys(isolationPatch).join(", ") || "(一个都没设)");
      const cleanupEnv = { ...env, ...isolationPatch };
      // 真实 home 下四家的候选文件：先记下「在不在 + 我们那种条目有几条」。判据用条数而不是
      // mtime —— Qoder 自己随时可能重写 settings.json，mtime 会变红但那与清理分支无关；
      // 而「cleanup 顺手摘掉真实条目」必然让带 --pet-hook 的行数掉下来。
      const REAL_FILES = realHomeAgentFiles(REAL_HOME);
      const realOurs = () =>
        REAL_FILES.map((f) => {
          try {
            return `${f}=${readFileSync(f, "utf8").split("--pet-hook").length - 1}`;
          } catch {
            return `${f}=缺文件`;
          }
        });
      const realBefore = realOurs();
      const cleanup = spawnSync(EXE, ["--pet-hook-cleanup"], {
        encoding: "utf8",
        timeout: 5_000,
        env: cleanupEnv,
      });
      r.info("cleanup stdout", String(cleanup.stdout ?? "").trim());
      r.check("清理分支 5 秒内退出且退出码为 0", 0, cleanup.status);
      r.check("清理分支没有被超时杀掉", undefined, cleanup.error);
      r.check(
        "stdout 报告摘掉了条目",
        true,
        /result=done .*stripped=[1-9]\d* .*failed=0/.test(String(cleanup.stdout)),
      );
      r.check("清理后自家条目归零", [0, 0], [ours(cfgA), ours(cfgB)]);
      r.check("清理不动别人条目与其他键", foreignBeforeToggle, `${foreignOf(cfgA)}|${foreignOf(cfgB)}`);
      r.check("清理分支不往收件目录写（没被当成一条 hook 事件）", inboxBefore, readInboxLen());
      // 只判「没多出页面」：本组前后可能有一张状态卡按自己的超时收起，那与清理分支无关
      const pagesAfter = (await listPages(PORT).catch(() => [])).length;
      r.check("清理分支没有开新窗口", true, pagesAfter <= pagesBefore);
      r.check("dev 实例仍然存活（没被单实例锁抢占或重载）", token, await state.c.ev(`window.__verifyToken ?? null`));

      // 第二遍专撞坏配置：清理失败绝不能拦住卸载，所以退码仍是 0 且文件一字不改
      const broken = "{ 半截 JSON";
      writeFileSync(cfgA, broken);
      const brokenB = readFileSync(cfgB, "utf8");
      const cleanup2 = spawnSync(EXE, ["--pet-hook-cleanup"], {
        encoding: "utf8",
        timeout: 5_000,
        env: cleanupEnv,
      });
      r.info("cleanup2 stdout", String(cleanup2.stdout ?? "").trim());
      r.check("撞到坏配置仍然退出码 0", 0, cleanup2.status);
      r.check("坏配置文件一字不改", broken, readFileSync(cfgA, "utf8"));
      r.check("坏配置不牵连另一个文件", brokenB, readFileSync(cfgB, "utf8"));
      r.check("坏配置在 stdout 里留痕", true, /failed=1/.test(String(cleanup2.stdout)));

      // Bug1 的显式判据：两遍 cleanup 之后，真实 home 下四家的配置文件一条都没被摘走
      r.check("真实 home 下四家的 --pet-hook 条数未被 cleanup 改动", realBefore, realOurs());
      r.info("真实 home 候选文件", realBefore.join(" ； ") || "(本机一家客户端都没装)");
    }

    // 复位成套件后面用例需要的样子：两份样例都只留用户自己的条目，不带我们的东西
    writeFileSync(cfgA, foreignOnly("a"));
    writeFileSync(cfgB, foreignOnly("b"));
    r.info("样例配置已复位", "两份都只剩用户自己的 hook 条目");
  }

  // ⑨ ZCode 切换（A02-4）：夹具目录由本套件自建自删，工作流不负责预置。
  // 本组只跑 ZCode；Codex 与 WorkBuddy 各有自己的组在下面（A03），三组共用这套夹具目录与界面判据。
}
