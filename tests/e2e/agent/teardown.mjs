// 收尾清理（原 finally 体 2320-2405）
// 由 tests/e2e/verify-agent-bridge.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { rmSync } from "node:fs";
import { hostInvoke, openSettingsInvoker, reloadAndWait, waitUntil, writeEnabledIds } from "../harness/cdp.mjs";
import { restorePluginsDir } from "../harness/fixtures.mjs";
import { AGENT_ID, PLUGINS_DIR, PORT, PROBE_DIR, PROBE_ID, sleep } from "./env.mjs";

/**
 * 原套件 finally 块：先把启停清单里的 zz.* 剔掉并读回，再删目录（顺序不能换，
 * 否则删目录触发的 reconcile 仍会看到清单里的 zz.* 并把它们激活、弹授权窗）。
 * 收尾口径：无论上面成功还是中途抛错都跑，plugins/ 恢回「只有真实插件」。
 */
export async function teardown(state) {
  const r = state.r;
  // 隐身判据中途抛错也绝不能把宠物窗留在隐身态（用户桌上会一片空白）：先放回来再谈别的收尾
  if (state.petHidden && state.c) {
    await hostInvoke(state.c)("set_pet_hidden", { hidden: false }).catch(() => undefined);
    state.petHidden = false;
    r.info("隐身兜底恢复", "执行了（正常路径不该走到这里）");
  }
  // 临时启用过心率就必须先还原清单（否则用户跑完一轮回归，桌面多了一个心率徽标）
  if (state.hrTempEnabled) {
    state.hrTempEnabled = false;
    if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c).catch(() => null);
    if (state.settings) await writeEnabledIds(state.settings.invoke, state.origEnabled).catch(() => undefined);
    r.info("心率插件的临时启用已还原", "是");
  }
  // 本跑预置进插件存储的那份老配置：恢复成本跑之前的样子（原来不存在就删掉），不给这台机器留残file
  if (state.legacySeed) {
    try {
      state.legacySeed.restore();
      r.info("插件存储已恢复成本跑之前的样子", "是");
    } catch (e) {
      r.info("插件存储恢复失败（需要手工清的落点）", String(e).slice(0, 120));
    }
    state.legacySeed = null;
  }
  // 收尾顺序：停同意框应答 → 趁一切还在把插件下线（不要拿重载当下线手段）→ 撤销授权
  // → 最后重载换新文档，把本跑的 console 输出连同旧文档一起丢掉，别污染下一次 attach
  state.consentPump.stop();
  await state.pumpDone?.catch(() => undefined);
  if (state.c) {
    // 探针收尾：先撤销授权（撤销只认设置窗，目录一删宿主就把它当孤儿了），再删目录，
    // 最后断言授权已被 prune_orphan_grants 回收。顺序不能反。
    if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c).catch(() => null);
    const probeRevoked = state.settings
      ? await state.settings.invoke("permission_revoke", { pluginId: PROBE_ID }).catch(() => undefined)
      : { ok: false, e: "设置窗没开起来" };
    r.info("探针授权撤销", JSON.stringify(probeRevoked?.ok ?? false));
    rmSync(PROBE_DIR, { recursive: true, force: true });
    await sleep(1500); // 等 watcher 跑一轮，prune_orphan_grants 把孤儿授权回收掉
    // 这条断言不许因「设置窗没开起来」而静默消失——那样总条数会悄悄少一条，看起来像套件本来就少一条。
    const probeTable = state.settings
      ? ((await state.settings.invoke("permission_list").catch(() => ({ v: {} }))).v ?? {})
      : { [PROBE_ID]: ["设置窗没开起来，无法确认授权已回收"] };
    r.check("探针下线后授权被回收", [], Object.keys(probeTable).filter((id) => id === PROBE_ID));
    const wasEnabled = state.origEnabled.includes(AGENT_ID);
    {
      // 原样恢复用户那份清单。先前这里会把 agent-bridge 从清单里摘掉，
      // 用户本来开着它，跑完一轮回归它就悄悄下线了
      if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c).catch(() => null);
      if (state.settings) await writeEnabledIds(state.settings.invoke, state.origEnabled).catch(() => undefined);
      await state.c
        .ev(`(async () => {
          const rt = await import('/src/runtime/plugin-runtime.ts');
          await rt.loadEnabled();
          ${wasEnabled ? "" : `await rt.deactivatePlugin(${JSON.stringify(AGENT_ID)});`}
          return true;
        })()`)
        .catch(() => undefined);
      await sleep(1200);
    }
    if (!wasEnabled) {
      // 只撤销本跑自己申请到的授权；撤销只认设置窗，所以走那一页的命令通道
      if (!state.settings) state.settings = await openSettingsInvoker(PORT, state.c).catch(() => null);
      const revoked = state.settings
        ? await state.settings.invoke("permission_revoke", { pluginId: AGENT_ID })
        : { ok: false, e: "设置窗没开起来，授权留在原地" };
      r.info("已撤销授权", JSON.stringify(revoked.ok ? revoked.v : revoked.e));
    } else {
      r.info("用户本来就开着它", "授权与启用清单原样保留");
    }
    state.settings?.close();
    state.settings = null;
    await reloadAndWait(state.c).catch(() => undefined);
    // 等这一轮的收尾彻底落地再退出：下一套断言脚本紧跟着 attach 的话，
    // 会撞在这次重载的尾巴上，红在一堆与本跑无关的断言上
    await waitUntil(state.c, `!!window.__TAURI_INTERNALS__ && !!document.querySelector('#pet-canvas')`, 10_000);
    await sleep(1200);
  } else {
    state.settings?.close();
    // 页面没连上就中断的场合，探针目录也要删掉，别给后面所有套件留一个孤儿插件
    rmSync(PROBE_DIR, { recursive: true, force: true });
  }
  // 无论上面成功还是中途抛错，plugins/ 都恢回「只有真实插件」的样子：zz.* 探针目录会让
  // `tsconfig.plugins.json` 的 typecheck 报 TS2339、`npm run lint` 的文件数也漂。
  restorePluginsDir(PLUGINS_DIR);
  const failed = r.summary();
  state.c?.close();
  await sleep(500);
  return failed;
}
