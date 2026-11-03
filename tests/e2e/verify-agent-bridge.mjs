// Agent 事件链路（dev）：R3（G9-08）拆分后的入口。
// 只留骨架，实现按原顺序搬到 tests/e2e/agent/：
//   env.mjs（常量/路径/夹具）、session.mjs（emitPhase、同意框应答泵、状态槽）、teardown.mjs（收尾）、
//   phases-*.mjs（六段主流程）。断言文案、期望值、条数与顺序与拆分前逐字一致。
import { createReport, waitForPage } from "./harness/cdp.mjs";
import { isPetPage, PORT } from "./agent/env.mjs";
import { phaseHook } from "./agent/phases-hook.mjs";
import { phaseOverlay } from "./agent/phases-overlay.mjs";
import { phaseQoder } from "./agent/phases-qoder.mjs";
import { phaseStatus } from "./agent/phases-status.mjs";
import { phaseWorkbuddy } from "./agent/phases-workbuddy.mjs";
import { phaseZcode } from "./agent/phases-zcode.mjs";
import { createSession } from "./agent/session.mjs";
import { teardown } from "./agent/teardown.mjs";

const r = createReport("Agent 事件链路（dev）");

try {
  await waitForPage(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

const state = createSession({ report: r });
let failed = true;
try {
  // 六段按拆分前的出现顺序串行；段间共享的值由 state 传递，赋值时机与原来一致。
  await phaseHook(state);
  await phaseStatus(state);
  await phaseOverlay(state);
  await phaseQoder(state);
  await phaseZcode(state);
  await phaseWorkbuddy(state);
} catch (err) {
  // 断言中途抛错绝不能以 0 收场：对回归工具来说，「崩了但退出码 0」比一条红断言危险得多
  r.check("脚本未抛异常", true, false);
  console.error("\n验证中断: " + String(err?.message ?? err).split("\n").slice(0, 3).join(" | "));
} finally {
  // finally 体原样在 teardown 里；它跑完才知道本跑到底红没红
  failed = await teardown(state);
}

process.exit(failed ? 1 : 0);
