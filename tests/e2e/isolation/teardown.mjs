// 收尾清理（原 finally 体 4013-4071）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { readdirSync } from "node:fs";
import { readEnabledIds } from "../harness/cdp.mjs";
import { restorePluginsDir } from "../harness/fixtures.mjs";
import { PLUGINS_DIR, invoke } from "./env.mjs";

/**
 * 原套件 finally 块：先把启停清单里的 zz.* 剔掉并读回，再删目录（顺序不能换，
 * 否则删目录触发的 reconcile 仍会看到清单里的 zz.* 并把它们激活、弹授权窗）。
 * 收尾口径：无论上面成功还是中途抛错都跑，plugins/ 恢回「只有真实插件」。
 */
export async function teardown(state) {
  const r = state.r;
  const { setEnabled } = state;
  // D07 C5：先把清单里的 zz.* 剔掉并读回，再删目录；否则删目录触发的 reconcile
  // 仍会看到清单里的 zz.*，把它们激活并弹授权窗。
  try {
    if (state.c) {
      const beforeCleanup = await readEnabledIds(invoke(state.c));
      const cleanIds = beforeCleanup.filter((id) => !String(id).startsWith("zz."));
      if (cleanIds.length !== beforeCleanup.length) await setEnabled(cleanIds);
      const afterCleanup = await readEnabledIds(invoke(state.c));
      r.check("D07 收尾清单不含 zz.*", [], afterCleanup.filter((id) => String(id).startsWith("zz.")));
    }
  } catch (err) {
    console.error("D07 收尾清理启停清单失败: " + String(err?.message ?? err));
  }
  // 收尾口径：不管上面成功还是中途抛错，plugins/ 都恢回「只有真实插件」的样子，别把 zz.* 留给
  // `npm run build`（tsconfig.plugins.json 会 typecheck plugins/**，残留探针会报一堆 TS2339）。
  restorePluginsDir(PLUGINS_DIR);
  const leftover = readdirSync(PLUGINS_DIR).filter((n) => n.startsWith("zz.") || n.startsWith("com.zz."));
  r.check("收尾：plugins/ 不留 zz.* / com.zz.* 探针目录", [], leftover);
  // D07：预置的 zz.consent/zz.status/hook 与热安装组的 zz.probe 由上面的
  // 「先剔清单、再删目录」统一收口；后续套件不再看到这些 fixture。
  // 探针留在宿主 realm 那条例外只服务于本套件的页面全局断言，不该活到下一轮真实使用里
  await state.c?.ev(`localStorage.removeItem('host:realm-plugin-host')`).catch(() => undefined);
  await state.c?.ev(`localStorage.removeItem('host:widget-realm-plugin-host')`).catch(() => undefined);
  // B05：收尾清理自己留下的崩溃探针噪音 —— 后跑套件 enable 时会把宠物页既存日志重放
  // （S1 核对：Log.entryAdded 与 Runtime.consoleAPICalled 两路都会进 noise）
  let b5CleanupErr = null;
  try {
    await state.c?.send("Log.clear");
    await state.c?.send("Runtime.discardConsoleEntries");
  } catch (e) {
    b5CleanupErr = String(e?.message ?? e);
  }
  const b5Probe = (n) => n.includes("派发递归") || n.includes("B3 崩溃探针");
  const b5Sentinel = "B05 哨兵：非探针噪音";
  state.c?.noise.push(b5Sentinel);
  const b5NonProbeBefore = (state.c?.noise ?? []).filter((n) => !b5Probe(n));
  if (state.c) {
    for (const arr of [state.c.noise, state.c.transitionNoise]) {
      for (let i = arr.length - 1; i >= 0; i--) if (b5Probe(arr[i])) arr.splice(i, 1);
    }
  }
  const b5NonProbeAfter = (state.c?.noise ?? []).filter((n) => !b5Probe(n));
  r.check(
    "B05 收尾后共享 noise 里不含探针记录（清理未失败）",
    "true|true|true",
    [!(state.c?.noise ?? []).some(b5Probe), !(state.c?.transitionNoise ?? []).some(b5Probe), b5CleanupErr === null].join("|"),
  );
  r.check(
    "B05 清理未吞掉其他噪音（非探针条目逐条一致，含哨兵）",
    "true|true",
    [JSON.stringify(b5NonProbeBefore) === JSON.stringify(b5NonProbeAfter), b5NonProbeAfter.includes(b5Sentinel)].join("|"),
  );
  const b5Idx = state.c?.noise.indexOf(b5Sentinel) ?? -1;
  if (b5Idx >= 0) state.c.noise.splice(b5Idx, 1);
  if (b5CleanupErr) console.error("B05 清理失败: " + b5CleanupErr);
  state.settings?.close();
  state.c?.close();
  // 等 websocket 真正关掉再退出，否则 Windows 上 Node 会在 stderr 抛一句 libuv 断言
  await new Promise((res) => setTimeout(res, 300));
}
