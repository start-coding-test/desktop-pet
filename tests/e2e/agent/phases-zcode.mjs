// ZCode 与 Codex 切换（原 1759-2099）
// 由 tests/e2e/verify-agent-bridge.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { env } from "node:process";
import { reconcilePetWindow, waitUntil, writeEnabledIds } from "../harness/cdp.mjs";
import { AGENT_ID, EXE, linkageAgent, sleep } from "./env.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseZcode(state) {
  const r = state.r;
  const recExpr = state.recExpr;
  const stateExpr = state.stateExpr;
  const clickShadow = state.clickShadow;
  const statusText = state.statusText;
  const TEMP_ROOT = state.TEMP_ROOT;
  const underTemp = state.underTemp;
  r.group("ZCode 切换：确认门、双文件、总开关恢复（只碰 PET_AGENT_HOME 下的夹具）");
  const ZHOME = String(env.PET_AGENT_HOME ?? "");
  state.ZHOME = ZHOME;
  // 两组前置都要满足：PET_AGENT_HOME 在 temp 下（写盘安全），且④那组真的把设置页开起来了
  // （本组的切换走界面 —— 设置区 widget 没挂载就没有按钮可点，那是前置不成立而不是行为坏了）
  const zhomeOk = ZHOME !== "" && resolve(ZHOME).startsWith(TEMP_ROOT + sep) && underTemp;
  state.zhomeOk = zhomeOk;
  r.check("前置齐备：PET_AGENT_HOME 在 temp 下 + 设置页已挂载", true, zhomeOk);
  if (!zhomeOk) {
    r.skip("ZCode 组", "PET_AGENT_HOME 未设/不在 temp 下，或设置页没打开；本组一个文件都不写");
  } else {
    const zcli = join(ZHOME, ".zcode", "cli");
    rmSync(zcli, { recursive: true, force: true });
    mkdirSync(zcli, { recursive: true });
    const zcfg = join(zcli, "config.json");
    const zset = join(zcli, "setting.json");
    const userHook = { type: "command", command: "user-hook.sh", timeoutMs: 3000 };
    const sample = (enabled) =>
      JSON.stringify(
        {
          mcpServers: { fake: { command: "npx fake-mcp" } },
          ...(enabled === undefined ? {} : { hooks: { enabled, events: { Stop: [{ hooks: [userHook] }] } } }),
          permissions: { allow: ["Bash"] },
        },
        null,
        2,
      );

    writeFileSync(zcfg, sample(false));
    const zBefore = readFileSync(zcfg, "utf8");
    const denied = await state.settings.invoke("agent_linkage_set", { agent: "zcode" });
    r.check("总开关显式关着且用户配过条目 → 第一次切换被要求确认", false, denied.ok);
    r.check("确认文案带上用户自己的条数", true, /1 条/.test(String(denied.e)));
    r.check(
      "确认拒绝带 ASCII 机器可读前缀（界面靠它判，不靠猜中文）",
      "[need-confirm]",
      String(denied.e).slice(0, 14),
    );
    r.check("被拦下时一个文件都没动", zBefore, readFileSync(zcfg, "utf8"));
    r.check("未知来源的 agent 值直接被拒（不是任意非空字符串）", false, (await state.settings.invoke("agent_linkage_set", { agent: "nope" })).ok);

    // 真正走一遍界面：点四选一里的 ZCode → 桥 → Worker 通道 agentHooks.set → 宿主。
    // 这条链上任何一环没接上，表现都是「按了没反应」，所以判据必须是界面状态而不是 invoke 结果。
    const clickedZ = await clickShadow(".hk-agent-zcode", "四选一里有 ZCode 这个按钮");
    // 最早断点：监听到底有没有被调到（widget 在 click 处理器第一行写这个标记）。
    // 没有它，「点了没反应」就得分不清是监听没注册、还是宿主调用失败、还是失败被覆盖。
    r.check(
      "点 ZCode 的监听被调到（面板 dataset.lastSwitch）",
      "zcode",
      await state.settings.client.ev(
        `(async () => { const rec = ${recExpr}; return rec?.shadow?.querySelector('.hk-status')?.dataset.lastSwitch ?? ""; })()`,
      ),
    );
    r.check(
      "第一趟停在确认门（界面 dataset.state=consent）",
      true,
      clickedZ && (await waitUntil(state.settings.client, stateExpr("consent"), 12_000)),
    );
    // 上一轮这条判据红但看不出红在哪一步：把面板原文打出来，日志里就能直接读到
    // 界面收到的那句（是宿主的拒绝、还是别的），不用再猜。
    r.info("点 ZCode 之后面板原文", String(await statusText()));
    r.check("确认提示没改写宿主原话", true, /1 条/.test(String(await statusText())));
    // 「按钮出现了」以前只查 .hk-consent 在不在 —— 那个按钮是常驻 DOM、靠 class 显隐的，
    // 所以那条判据永远真，等于没判。改成查槽位的 class 是不是亮着。
    const slotOn = await state.settings.client.ev(
      `(async () => { const rec = ${recExpr}; return String(rec?.shadow?.querySelector('.hk-consent-slot')?.className ?? '').includes("on"); })()`,
    );
    r.check("确认槽位亮着（不是「元素在就等于按钮在」）", true, slotOn);
    const clickedConsent = await clickShadow(".hk-consent", "「仍要打开」点得到");
    r.check(
      "点「仍要打开」之后装上（界面 state=installed）",
      true,
      clickedConsent && (await waitUntil(state.settings.client, stateExpr("installed"), 20_000)),
    );
    const zText = readFileSync(zcfg, "utf8");
    r.check("装了 7 个事件（ZCode 没有 SessionEnd/Notification/Subagent）", 7, zText.split("--pet-hook").length - 1);
    r.check("条目带 --agent zcode", true, zText.includes("--pet-hook pre --agent zcode"));
    r.check("只写文档列出的字段（不写 matcher / args）", false, /matcher|"args"/.test(zText));
    r.check("timeoutMs 用毫秒", true, zText.includes("\"timeoutMs\": 2000"));
    r.check("总开关被打开", true, JSON.parse(zText).hooks.enabled === true);
    const zc = JSON.parse(zText);
    const inner = zc.hooks.events.Stop.flatMap((g) => g.hooks ?? []);
    const mine = inner.find((h) => String(h.command).includes("--pet-hook"));
    const kept = inner.find((h) => !String(h.command).includes("--pet-hook"));
    r.check("我们的条目独占一个分组", true, zc.hooks.events.Stop.length >= 2 && kept?.command === "user-hook.sh" && !!mine);
    r.check("其他键一个不少，且顶层键序原样（preserve_order 的端到端证据）", ["mcpServers", "hooks", "permissions"], Object.keys(zc));
    r.check("没装过的那份 setting.json 不被凭空造出来", false, existsSync(zset));

    const stZ = (await state.settings.invoke("agent_hooks_status")).v;
    r.check("状态页按当前那一家报（agent=zcode，每文件 7 条）", ["zcode", 7, 7], [stZ?.agent, stZ?.expectedPerFile, stZ?.managed]);
    r.check("五选一清单列全五个槽位", ["codex", "dsh", "qoder", "workbuddy", "zcode"], (stZ?.options ?? []).map((o) => o.id).sort());
    // A02 时这里是「codex/workbuddy 标 wired=false」。A03 把两家接上线之后事实变了，
    // 判据跟着变严而不是删掉：五家全 true，且清单仍由宿主的 options 给（界面不自己养名单）。
    // 第五家 dsh 是 bridge 形态（没有 hook 文件可装），它的 hint 必须指路到桥插件的 install_bundle。
    r.check("五家都已接线（不再有禁选槽位）", [true, true, true, true, true], (stZ?.options ?? []).map((o) => o.wired).sort());
    const dshOption = (stZ?.options ?? []).find((o) => o.id === "dsh");
    r.check("dsh 的选项指路到桥插件的 install_bundle", true, /install_bundle/.test(String(dshOption?.hint)));
    r.check("装完提示由适配器给（新开会话才生效）", true, /新开/.test(String(stZ?.hint)));

    // G7-12（a）：**非 Qoder** 时的停用摘除/再启用。上面 ⑥ 只覆盖 qoder 适配器；
    // ZCode 的落点是 ~/.zcode 双文件 + 我们拨开的总开关，停用走的是「当前那家」的决定，
    // 用 Qoder 的绿来推断它是错的（那正是审计说的缺口）。
    const zOurs = () => readFileSync(zcfg, "utf8").split("--pet-hook").length - 1;
    const withoutAgent = state.origEnabled.filter((id) => id !== AGENT_ID);
    await writeEnabledIds(state.settings.invoke, withoutAgent);
    await reconcilePetWindow(state.c);
    r.check("停用插件后 ZCode 的条目也摘净（不是只摘 Qoder）", 0, zOurs());
    r.check("停用 ZCode 时不动用户自己的条目", true, readFileSync(zcfg, "utf8").includes("user-hook.sh"));
    r.check("停用不清空 agent 字段（再启用全靠它恢复）", "zcode", linkageAgent());
    // 停用把总开关恢复成「装之前的 false」。这条不只是回显：**再启用会不会静默装回条目，
    // 全看这一刻开关是不是 false**（`switch_needs_consent` 只在显式关着时才返回 Some）。
    r.check("停用 ZCode 时总开关恢复成装之前的 false", false, JSON.parse(readFileSync(zcfg, "utf8")).hooks.enabled);
    await writeEnabledIds(state.settings.invoke, [...new Set([...withoutAgent, AGENT_ID])]);
    await reconcilePetWindow(state.c);
    // G2-09 / N8：**重新勾选启用 ≠ 对「拨开 ZCode 总开关」的同意**。启停联动走的是自动路径，
    // 确认位恒为 false（linkage::apply 里 install(..., false)），撞上确认门就一个文件都不写、
    // 一个字节都不动。上一版期望「再启用即装回 7 条」正是被复核掉的绕过 —— 期望必须反过来，
    // 否则这套件是在给漏洞背书，跑绿反而更糟。
    r.check("再启用不自动装回 ZCode 条目（自动路径撞确认门，7 条变 0）", 0, zOurs());
    r.check("再启用不写任何 --pet-hook 条目", false, readFileSync(zcfg, "utf8").includes("--pet-hook"));
    r.check(
      "再启用不动总开关（仍是装之前的 false，不替用户拨开）",
      false,
      JSON.parse(readFileSync(zcfg, "utf8")).hooks.enabled,
    );
    r.check("再启用不动用户自己的条目", true, readFileSync(zcfg, "utf8").includes("user-hook.sh"));
    // 「一个都没写」还要证明是**被确认门拦下**，不是别的失败静默跳过：同一条安装命令不带
    // confirm 必须回 [need-confirm] 且仍不动盘（界面「安装」第一趟正是这个调用）。
    const recheck = await state.settings.invoke("agent_hooks_install");
    r.check("再启用后重新安装（不带 confirm）回 [need-confirm]", "[need-confirm]", String(recheck.e).slice(0, 14));
    r.check("被确认门拦下时文件仍一个字节没动", 0, zOurs());
    // 真确认才装得回来：走界面「安装」→「仍要打开」，原来那 7 条逐条核对全部保留
    const clickedReinstallZ = await clickShadow(".hk-install", "确认门之后「安装」仍可点");
    r.check(
      "点「安装」第一趟停在确认门（界面 dataset.state=consent）",
      true,
      clickedReinstallZ && (await waitUntil(state.settings.client, stateExpr("consent"), 12_000)),
    );
    const clickedYesZ = await clickShadow(".hk-consent", "「仍要打开」点得到");
    r.check(
      "点「仍要打开」之后才装回来（界面 state=installed）",
      true,
      clickedYesZ && (await waitUntil(state.settings.client, stateExpr("installed"), 20_000)),
    );
    // 诊断：确认那一下之后面板到底说了什么（失败时把宿主的原话留下来，省得只看见 true/false）
    r.info("确认后面板原文", `${await statusText()} ｜ 文件里 --pet-hook 条数=${zOurs()}`);
    r.check("确认后 ZCode 的条目装回来（7 条，带 --agent zcode）", [7, true], [
      zOurs(),
      readFileSync(zcfg, "utf8").includes("--pet-hook pre --agent zcode"),
    ]);
    r.check("确认后总开关才被拨开（装回来的副作用一致）", true, JSON.parse(readFileSync(zcfg, "utf8")).hooks.enabled === true);

    // 来源过滤在真实切换之后仍只对当前那一家放行：注入 qoder 事件不该动桌宠，zcode 事件该动
    const evCount = async () =>
      (await state.c.ev(`window.__topics.filter(([k]) => k === 'host-event').length`));
    const evBefore = await evCount();
    spawnSync(EXE, ["--pet-hook", "pre", "--agent", "qoder"], {
      input: JSON.stringify({ session_id: `verify-back-qoder-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    await sleep(1_500);
    r.check("当前是 ZCode 时，注入 qoder 事件不广播", evBefore, await evCount());
    spawnSync(EXE, ["--pet-hook", "pre", "--agent", "zcode"], {
      input: JSON.stringify({ session_id: `verify-zcode-live-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    r.check("切到 ZCode 后自己的事件照常广播", true, await waitUntil(state.c, `(window.__topics.slice().reverse().find(([k]) => k === 'host-event')?.[1]?.agent === 'zcode')`, 8_000));

    // 切回 Qoder：走界面（点四选一里的 Qoder），ZCode 的条目摘净，并且**总开关回到装之前的
    // false**（hooksEnabled 记录的端到端证据）
    const clickedBack = await clickShadow(".hk-agent-qoder", "四选一里 Qoder 是选中态、也能点");
    r.check(
      "切回 Qoder 后界面回到已安装",
      true,
      clickedBack && (await waitUntil(state.settings.client, stateExpr("installed"), 20_000)),
    );
    const zAfter = readFileSync(zcfg, "utf8");
    r.check("ZCode 的条目摘净", 0, zAfter.split("--pet-hook").length - 1);
    r.check("总开关恢复成装之前的 false", true, JSON.parse(zAfter).hooks.enabled === false);
    r.check("用户自己的条目仍然在", "user-hook.sh", JSON.parse(zAfter).hooks.events.Stop.flatMap((g) => g.hooks ?? [])[0]?.command);
    r.check("恢复后键序与内容回到原样", ["mcpServers", "hooks", "permissions"], Object.keys(JSON.parse(zAfter)));
    const stQ = (await state.settings.invoke("agent_hooks_status")).v;
    r.check("状态页跟着回到 Qoder", ["qoder", 12], [stQ?.agent, stQ?.expectedPerFile]);

    // 夹具目录自己删：工作流不负责预置，也不能把它留给下一轮
    rmSync(join(ZHOME, ".zcode"), { recursive: true, force: true });
    r.check("夹具目录已自删", false, existsSync(zcli));
  }

  // ⑩ Codex 切换（A03）：`~/.codex/hooks.json`，与 Qoder 同构，**没有总开关**。
  // 夹具目录由本组自建自删；`PET_AGENT_HOME` 已被 claude_style 的 targets() 认作 home 根，
  // 所以真实用户目录一个都不会被碰到。
  r.group("Codex 切换：目录在就建文件、10 个事件、timeout 按秒、不谎称查过自检");
  if (!zhomeOk) {
    r.skip("Codex 组", "前置不成立（PET_AGENT_HOME 不在 temp 下或设置页没挂载），本组一个文件都不写");
  } else {
    const cdir = join(ZHOME, ".codex");
    const cf = join(cdir, "hooks.json");
    rmSync(cdir, { recursive: true, force: true });
    mkdirSync(cdir, { recursive: true });
    // Qoder 那侧的条目数直接从它的文件读：status() 只按「当前那家」报，切换之后看不到上一家的残局
    const qfiles = String(env.PET_AGENT_CONFIG_FILES ?? "")
      .split(";")
      .map((x) => String(x).trim())
      .filter(Boolean);
    const qMine = () =>
      qfiles.reduce((n, f) => n + (existsSync(f) ? readFileSync(f, "utf8").split("--pet-hook").length - 1 : 0), 0);

    r.check("前置：.codex 在但 hooks.json 不在", false, existsSync(cf));
    r.check("前置：Qoder 那侧有条目可摘（切换才有东西要卸）", true, qMine() > 0);

    const clickedC = await clickShadow(".hk-agent-codex", "四选一里有 Codex 这个按钮");
    r.check(
      "点 Codex 的监听被调到（面板 dataset.lastSwitch）",
      "codex",
      await state.settings.client.ev(
        `(async () => { const rec = ${recExpr}; return rec?.shadow?.querySelector('.hk-status')?.dataset.lastSwitch ?? ""; })()`,
      ),
    );
    // Codex 没有 disableAllHooks 那种键：走到确认门就是错的（它会拦住一次本来不需要问的切换）
    r.check(
      "Codex 没有总开关 → 不该出现确认门，直接装上（界面 state=installed）",
      true,
      clickedC && (await waitUntil(state.settings.client, stateExpr("installed"), 20_000)),
    );
    r.check("目录在而文件不在时把 hooks.json 建出来", true, existsSync(cf));
    const cText = readFileSync(cf, "utf8");
    r.check("装了 10 个事件（含 Interrupt，不含 PostToolUseFailure）", 10, cText.split("--pet-hook").length - 1);
    r.check("条目带 --agent codex", true, cText.includes("--pet-hook pre --agent codex"));
    r.check(
      "timeout 用秒的那个键名（不是 ZCode 的 timeoutMs）",
      true,
      /"timeout": 2/.test(cText) && !cText.includes("timeoutMs"),
    );
    r.check("与 Qoder 同构：一个 matcher 都不写", false, /"matcher"/.test(cText));
    const cj = JSON.parse(cText);
    r.check("形状是 hooks.<事件>[].hooks[]", true, Array.isArray(cj.hooks?.PreToolUse?.[0]?.hooks));
    r.check("切走 Qoder 时把它的条目摘净（同一时间只联动一个）", 0, qMine());

    const stC = (await state.settings.invoke("agent_hooks_status")).v;
    r.check(
      "状态页按 Codex 报（agent=codex，每文件 10 条）",
      ["codex", 10, 10],
      [stC?.agent, stC?.expectedPerFile, stC?.managed],
    );
    r.check("装完提示由适配器给（要去 /hooks 信任）", true, /\/hooks/.test(String(stC?.hint)));

    // 再点一次：幂等，且 selfCheck 必须是「这一家没这回事」而不是「查过且没问题」
    const reC = await state.settings.invoke("agent_linkage_set", { agent: "codex" });
    r.check("重复切换不越装越多（还是 10 条）", 10, readFileSync(cf, "utf8").split("--pet-hook").length - 1);
    r.check(
      "Codex 的装后自检是 unverified（没有可查日志，不是 null 也不是 ok）",
      true,
      reC.ok === true &&
        reC.v?.selfCheck?.status === "unverified" &&
        /没有可查日志/.test(String(reC.v?.selfCheck?.detail)),
    );

    // 用户在同一个文件里配过东西：重装只动我们那些，别的键与条一个都不许碰
    const withUser = JSON.parse(readFileSync(cf, "utf8"));
    withUser.model = "gpt-5-codex";
    withUser.hooks.PreToolUse.push({ hooks: [{ type: "command", command: "user-codex-hook.sh", timeout: 5 }] });
    writeFileSync(cf, JSON.stringify(withUser, null, 2));
    const reC2 = await state.settings.invoke("agent_linkage_set", { agent: "codex" });
    const cAfter = JSON.parse(readFileSync(cf, "utf8"));
    r.check(
      "用户自己那条 hook 没被摘掉",
      true,
      (cAfter.hooks.PreToolUse ?? []).some((g) => (g.hooks ?? []).some((h) => h.command === "user-codex-hook.sh")),
    );
    r.check("我们那些仍是 10 条", 10, reC2.v?.files?.reduce((n, f) => n + (f.managed ?? 0), 0));
    r.check("没写过的顶层键原样留着（model）", "gpt-5-codex", cAfter.model);

    // G7-12（b）：非 Qoder 时的停用摘除也一样要覆盖 Codex（没有总开关的那家，
    // 停用只该动 `--pet-hook` 条目，model / 用户 hook 一律原样）。
    const cOurs = () => readFileSync(cf, "utf8").split("--pet-hook").length - 1;
    const withoutAgentC = state.origEnabled.filter((id) => id !== AGENT_ID);
    await writeEnabledIds(state.settings.invoke, withoutAgentC);
    await reconcilePetWindow(state.c);
    r.check("停用插件后 Codex 的条目也摘净", 0, cOurs());
    const cOff = JSON.parse(readFileSync(cf, "utf8"));
    r.check(
      "停用 Codex 只摘我们的条目，用户 hook 与他家键都还在",
      [true, "gpt-5-codex"],
      [(cOff.hooks.PreToolUse ?? []).some((g) => (g.hooks ?? []).some((h) => h.command === "user-codex-hook.sh")), cOff.model],
    );
    await writeEnabledIds(state.settings.invoke, [...new Set([...withoutAgentC, AGENT_ID])]);
    await reconcilePetWindow(state.c);
    r.check("再启用后 Codex 的条目装回来（10 条，带 --agent codex）", [10, true], [
      cOurs(),
      readFileSync(cf, "utf8").includes("--pet-hook pre --agent codex"),
    ]);
    r.check("再启用后用户 hook 仍未被误摘", true, readFileSync(cf, "utf8").includes("user-codex-hook.sh"));

    // 来源过滤：当前是 Codex 时，qoder 的事件不该驱动桌宠，codex 的事件要能
    const evCountC = async () => (await state.c.ev(`window.__topics.filter(([k]) => k === 'host-event').length`));
    const evBeforeC = await evCountC();
    spawnSync(EXE, ["--pet-hook", "pre", "--agent", "qoder"], {
      input: JSON.stringify({ session_id: `verify-back-codex-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    await sleep(1_500);
    r.check("当前是 Codex 时，注入 qoder 事件不广播", evBeforeC, await evCountC());
    spawnSync(EXE, ["--pet-hook", "pre", "--agent", "codex"], {
      input: JSON.stringify({ session_id: `verify-codex-live-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    r.check(
      "切到 Codex 后自己的事件照常广播",
      true,
      await waitUntil(
        state.c,
        `(window.__topics.slice().reverse().find(([k]) => k === 'host-event')?.[1]?.agent === 'codex')`,
        8_000,
      ),
    );

    // 中途把客户端目录删掉：查状态要按「没装」报，而且不许凭空造回目录（每次装卸都重新检测的端到端证据）
    rmSync(cdir, { recursive: true, force: true });
    const stGone = (await state.settings.invoke("agent_hooks_status")).v;
    r.check("目录被删掉之后一个候选都不给（按未安装报）", 0, (stGone?.files ?? []).length);
    r.check("查状态不会凭空造出 .codex 目录", false, existsSync(cdir));

    const clickedBackC = await clickShadow(".hk-agent-qoder", "四选一里 Qoder 可点（切回）");
    r.check(
      "切回 Qoder 后界面回到已安装",
      true,
      clickedBackC && (await waitUntil(state.settings.client, stateExpr("installed"), 20_000)),
    );
    const stQ2 = (await state.settings.invoke("agent_hooks_status")).v;
    r.check("状态页跟着回到 Qoder", ["qoder", 12], [stQ2?.agent, stQ2?.expectedPerFile]);
    r.check("切回之后 .codex 仍然不存在（没被顺手建出来）", false, existsSync(cdir));

    rmSync(cdir, { recursive: true, force: true });
    r.check("Codex 夹具目录已自删", false, existsSync(cdir));
  }

  // ⑪ WorkBuddy 切换（A03）：`~/.workbuddy/settings.json`，总开关是**反向**的 disableAllHooks，
  // 而且我们不替用户改它 —— 所以确认门必须排在卸旧之前，否则会出现「旧的已摘、新的没装」那种两边都不动的状态。
}
