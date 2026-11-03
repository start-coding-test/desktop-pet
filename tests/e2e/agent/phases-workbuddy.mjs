// WorkBuddy 切换与收尾完整性（原 2100-2314）
// 由 tests/e2e/verify-agent-bridge.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { waitUntil } from "../harness/cdp.mjs";
import { AGENT_ID, EXE, PLUGINS_DIR, sleep } from "./env.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseWorkbuddy(state) {
  const r = state.r;
  const token = state.token;
  const seededBytes = state.seededBytes;
  const stripComments = state.stripComments;
  const recExpr = state.recExpr;
  const stateExpr = state.stateExpr;
  const clickShadow = state.clickShadow;
  const statusText = state.statusText;
  const ZHOME = state.ZHOME;
  const zhomeOk = state.zhomeOk;
  r.group("WorkBuddy 切换：卸旧之前的预检、7 个事件、matcher 只给工具类、不动用户的开关");
  if (!zhomeOk) {
    r.skip("WorkBuddy 组", "前置不成立，本组一个文件都不写");
  } else {
    const wdir = join(ZHOME, ".workbuddy");
    const wf = join(wdir, "settings.json");
    rmSync(wdir, { recursive: true, force: true });
    mkdirSync(wdir, { recursive: true });
    const wfiles = String(env.PET_AGENT_CONFIG_FILES ?? "")
      .split(";")
      .map((x) => String(x).trim())
      .filter(Boolean);
    const wMine = () =>
      wfiles.reduce((n, f) => n + (existsSync(f) ? readFileSync(f, "utf8").split("--pet-hook").length - 1 : 0), 0);
    const userGroup = { matcher: "Bash", hooks: [{ type: "command", command: "user-wb-hook.sh", timeout: 5 }] };
    writeFileSync(
      wf,
      JSON.stringify(
        { theme: "dark", disableAllHooks: true, hooks: { PreToolUse: [userGroup] }, model: "wb-sonnet" },
        null,
        2,
      ),
    );
    const wBefore = readFileSync(wf, "utf8");
    const st0 = (await state.settings.invoke("agent_hooks_status")).v;
    // 这里比的是「当前那家是谁 + 每文件应有几条」；`managed` 是所有目标文件加起来的条数，
    // runner 上 Qoder 有两个样例文件（cfg-a / cfg-b），装满是 24 不是 12 —— 别拿它当每文件的数。
    r.check("前置：当前是 Qoder", "qoder", st0?.agent);
    r.check("前置：Qoder 装满了条目", [12, true], [st0?.expectedPerFile, (st0?.managed ?? 0) > 0]);
    const qManagedBefore = st0?.managed;

    const clickedW = await clickShadow(".hk-agent-workbuddy", "四选一里有 WorkBuddy 这个按钮");
    r.check(
      "点 WorkBuddy 的监听被调到（面板 dataset.lastSwitch）",
      "workbuddy",
      await state.settings.client.ev(
        `(async () => { const rec = ${recExpr}; return rec?.shadow?.querySelector('.hk-status')?.dataset.lastSwitch ?? ""; })()`,
      ),
    );
    r.check(
      "disableAllHooks 为 true → 第一趟停在确认门",
      true,
      clickedW && (await waitUntil(state.settings.client, stateExpr("consent"), 12_000)),
    );
    r.info("点 WorkBuddy 之后面板原文", String(await statusText()));
    const panel = String(await statusText());
    r.check("确认文案点名是哪个开关", true, panel.includes("disableAllHooks"));
    r.check(
      "确认文案说清我们不替用户改（照 ZCode 那句讲就是在骗人）",
      true,
      panel.includes("不会替你改") && !panel.includes("打开以后你之前配的"),
    );
    r.check("确认文案带上用户自己的条数", true, /1 条/.test(panel));
    // 本组的核心一条：预检若排在卸旧之后，症状是 Qoder 已被摘干净、WorkBuddy 又没装上，桌宠从此两边都不动。
    const keptQ = (await state.settings.invoke("agent_hooks_status")).v;
    r.check(
      "被拦下时旧的那家一条没卸（预检排在卸旧之前）",
      ["qoder", qManagedBefore],
      [keptQ?.agent, keptQ?.managed],
    );
    r.check("被拦下时 WorkBuddy 的文件一个字节没动", wBefore, readFileSync(wf, "utf8"));

    const clickedYesW = await clickShadow(".hk-consent", "「仍要打开」点得到");
    r.check(
      "点「仍要打开」之后装上（界面 state=installed）",
      true,
      clickedYesW && (await waitUntil(state.settings.client, stateExpr("installed"), 20_000)),
    );
    const wText = readFileSync(wf, "utf8");
    r.check("装了 7 个事件（实测会触发的那 7 条）", 7, wText.split("--pet-hook").length - 1);
    r.check("条目带 --agent workbuddy", true, wText.includes("--pet-hook pre --agent workbuddy"));
    const wj = JSON.parse(wText);
    const ourGroupOf = (ev) =>
      (wj.hooks?.[ev] ?? []).find((g) => (g.hooks ?? []).some((h) => String(h.command).includes("--pet-hook")));
    r.check(
      "工具类事件（PreToolUse / PostToolUse）带 matcher",
      true,
      ["PreToolUse", "PostToolUse"].every((ev) => ourGroupOf(ev)?.matcher === ".*"),
    );
    r.check(
      "其余五个事件不写 matcher",
      true,
      ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Notification", "Stop"].every(
        (ev) => ourGroupOf(ev) !== undefined && !("matcher" in ourGroupOf(ev)),
      ),
    );
    r.check(
      "timeout 按秒（CodeBuddy 文档口径）",
      true,
      JSON.stringify(ourGroupOf("Stop").hooks).includes('"timeout":2'),
    );
    r.check("disableAllHooks 没被我们改动（仍是 true）", true, wj.disableAllHooks === true);
    r.check(
      "用户自己那条与它的 matcher 原样还在",
      true,
      (wj.hooks.PreToolUse ?? []).some((g) => g.matcher === "Bash" && g.hooks?.[0]?.command === "user-wb-hook.sh"),
    );
    r.check(
      "其他顶层键一个不少，且键序原样",
      ["theme", "disableAllHooks", "hooks", "model"],
      Object.keys(wj),
    );
    r.check("确认之后旧的那家才被摘净", 0, wMine());

    const stW = (await state.settings.invoke("agent_hooks_status")).v;
    r.check(
      "状态页按 WorkBuddy 报（agent=workbuddy，每文件 7 条）",
      ["workbuddy", 7, 7],
      [stW?.agent, stW?.expectedPerFile, stW?.managed],
    );
    r.check("装完提示由适配器给（彻底退出 + 实验性）", true, /退出/.test(String(stW?.hint)) && /实验性/.test(String(stW?.hint)));
    // 自检字段只在 `agent_linkage_set` 的返回里（status 没有这个键，比它等于没比）。
    const setW = await state.settings.invoke("agent_linkage_set", { agent: "workbuddy", confirm: true });
    r.check(
      "WorkBuddy 没有可查日志，set 返回的 selfCheck 是 unverified（不是 null 也不是 ok）",
      true,
      setW.ok === true &&
        setW.v?.selfCheck?.status === "unverified" &&
        /没有可查日志/.test(String(setW.v?.selfCheck?.detail)),
    );

    const evCountW = async () => (await state.c.ev(`window.__topics.filter(([k]) => k === 'host-event').length`));
    const evBeforeW = await evCountW();
    spawnSync(EXE, ["--pet-hook", "pre", "--agent", "zcode"], {
      input: JSON.stringify({ session_id: `verify-back-wb-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    await sleep(1_500);
    r.check("当前是 WorkBuddy 时，别家（zcode）的事件不广播", evBeforeW, await evCountW());
    spawnSync(EXE, ["--pet-hook", "pre", "--agent", "workbuddy"], {
      input: JSON.stringify({ session_id: `verify-wb-live-${Date.now()}`, tool_name: "Bash" }),
      encoding: "utf8",
      timeout: 15_000,
    });
    r.check(
      "切到 WorkBuddy 后自己的事件照常广播",
      true,
      await waitUntil(
        state.c,
        `(window.__topics.slice().reverse().find(([k]) => k === 'host-event')?.[1]?.agent === 'workbuddy')`,
        8_000,
      ),
    );

    const clickedBackW = await clickShadow(".hk-agent-qoder", "切回 Qoder 的按钮可点");
    r.check(
      "切回 Qoder 后界面回到已安装",
      true,
      clickedBackW && (await waitUntil(state.settings.client, stateExpr("installed"), 20_000)),
    );
    const wAfter = JSON.parse(readFileSync(wf, "utf8"));
    r.check("WorkBuddy 的条目摘净", 0, readFileSync(wf, "utf8").split("--pet-hook").length - 1);
    r.check("摘完也不碰用户的开关（disableAllHooks 仍是 true）", true, wAfter.disableAllHooks === true);
    r.check(
      "用户自己那条还在",
      true,
      (wAfter.hooks?.PreToolUse ?? []).some((g) => g.hooks?.[0]?.command === "user-wb-hook.sh"),
    );
    r.check("摘完之后键序与其余内容回到原样", ["theme", "disableAllHooks", "hooks", "model"], Object.keys(wAfter));
    const stQ3 = (await state.settings.invoke("agent_hooks_status")).v;
    r.check("状态页跟着回到 Qoder", ["qoder", 12], [stQ3?.agent, stQ3?.expectedPerFile]);

    rmSync(wdir, { recursive: true, force: true });
    r.check("WorkBuddy 夹具目录已自删", false, existsSync(wdir));
  }

  // 整轮跑完（含 ⑥ 那组一次真的停用 → 再激活）之后再对一次字节：
  // 只在事件之后对，就漏掉了「激活时顺手写回 config」这条路径（M9 打的正是它）
  r.check(
    "整轮跑完之后存储仍是预置那一份字节（插件一次都没写它）",
    true,
    state.legacySeed.read() === seededBytes,
  );
  // A07/M9（按 `#D-FIX` A07-D3 选 A 改成**静态源码判据**）：运行时那两条摘干净，不留观测。
  // 原因如实记：我对 `window.__TAURI_INTERNALS__.invoke` 的重新赋值在该 realm 静默无效
  // （正式轮 run 39454676546 实测 `__invokeLog` 一条都没记到，连套件自己打的 plugins_list 都没进），
  // 留着它只会得到一条「空数组等于 []」的空判绿。
  // 实质换过一茬，写清楚：静态判据管得住「这个插件的源码里没有任何存储调用面」，
  // **管不住**运行时绕过 JS 桥另寻途径写存储（同 realm 直接 invoke，或宿主代写）—— 那条路径本卡不覆盖。
  const m9Manifest = JSON.parse(readFileSync(join(PLUGINS_DIR, AGENT_ID, "manifest.json"), "utf8"));
  const m9Files = [
    ...new Set(
      [m9Manifest.entry, m9Manifest.widget, ...readdirSync(join(PLUGINS_DIR, AGENT_ID)).filter((f) => f.endsWith(".js"))].filter(
        (f) => typeof f === "string",
      ),
    ),
  ];
  const m9Stripped = m9Files.map((f) => stripComments(readFileSync(join(PLUGINS_DIR, AGENT_ID, f), "utf8")));
  // 匹配面用「子串」而不是 `\bstorage\b`：A04 的 M3a 就是因为 needle 少了可选链写法而漏。
  // `storage` 这个子串把 `ctx.storage` / `storage?.x` / `storage[x]` / `{ storage }` / `storage:`
  // 全覆盖（当前 HEAD 剥注释后零命中，所以不会因为宽而在干净码上误伤），再加两个宿主命令名。
  const m9Find = (text) => ["storage", "store_get", "store_set"].filter((needle) => text.includes(needle));
  const m9Synthetic =
    'await ctx.storage.get("config").then((c) => c && ctx.storage.set("config", c));';
  r.check(
    "前提：M9 静态源码判据不空判（按 manifest 枚举到 js、每份剥注释后非空、同一匹配函数喂 M9 合成串必命中）",
    "true|true|true",
    [
      String(m9Files.length > 0 && m9Files.includes(m9Manifest.entry) && m9Files.includes(m9Manifest.widget)),
      String(m9Stripped.every((s) => s.trim().length > 0)),
      String(m9Find(m9Synthetic).length > 0),
    ].join("|"),
  );
  r.check(
    "M9 静态源码判据：本插件被 manifest 引用的每一份 js（剥注释后）都不含任何存储调用面（storage / store_get / store_set）",
    [],
    m9Files.flatMap((f, i) => m9Find(m9Stripped[i]).map((needle) => `${f}:${needle}`)),
  );

  r.group("收尾前的完整性");
  r.check("测试期间宠物窗未被重载", token, await state.c.ev(`window.__verifyToken ?? null`));
  await sleep(500); // console 事件异步送达
  r.info("导航过渡期告警（reload 切断在飞 IPC 的产物，单独归类）", String(state.c.transitionNoise.length));
  r.check("零噪音", [], state.c.noise);
}
