// 隔离与安全回归（dev）：R3（G9-08）拆分后的入口。
// 只留骨架，实现按原 r.group 段落搬到 tests/e2e/isolation/：
//   env.mjs（常量/路径/纯工具）、consent.mjs（同意框探测）、fake-cdp.mjs（A26 假 CDP 端点）、
//   session.mjs（会话状态与有状态 helper）、teardown.mjs（收尾）、phases-*.mjs（六段主流程）。
// 断言文案、期望值、条数与顺序与拆分前逐字一致；跨段状态显式挂在 state 上。
import { argv, env } from "node:process";
import { createReport, waitForPage } from "./harness/cdp.mjs";
import { isPetPage, PORT } from "./isolation/env.mjs";
import { runAttachHandshakeSelfTest } from "./isolation/fake-cdp.mjs";
import { phaseBadge } from "./isolation/phases-badge.mjs";
import { phaseBoot } from "./isolation/phases-boot.mjs";
import { phaseConsent } from "./isolation/phases-consent.mjs";
import { phaseRender } from "./isolation/phases-render.mjs";
import { phaseSettingsHooks } from "./isolation/phases-settings-hooks.mjs";
import { phaseStorage } from "./isolation/phases-storage.mjs";
import { createSession } from "./isolation/session.mjs";
import { teardown } from "./isolation/teardown.mjs";

const r = createReport("隔离与安全回归（dev）");
if (env.GITHUB_ACTIONS === "true") {
  r.check("CI：PET_SETTINGS_DIR 必须设置（否则热键用例会写真实 settings.json）", true, Boolean(env.PET_SETTINGS_DIR));
}

if (!argv.includes("--attach-selftest")) {
  try {
    await waitForPage(PORT, isPetPage, 60_000);
  } catch {
    console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
    process.exit(2);
  }
}

// 用法：node tests/e2e/verify-isolation.mjs --attach-selftest（含 20s 的 attach 级复现）
if (argv.includes("--attach-selftest")) {
  const selfReport = createReport("A26 attach 握手容错自测（假 CDP 端点，不连应用）");
  await runAttachHandshakeSelfTest(selfReport, { withAttach: true });
  process.exit(selfReport.summary() ? 1 : 0);
}

// 往 plugins/ 写 fixture 会让 Vite 触发一次整页重载，所以先写完再连；
// 装上的宿主句柄仍可能被随后的重载冲掉，故下面的安装带退避重试。
const state = createSession({ report: r });
try {
  // 六段按拆分前的出现顺序串行；段间共享的值由 state 传递，赋值时机与原来一致。
  await phaseBoot(state);
  await phaseStorage(state);
  await phaseRender(state);
  await phaseSettingsHooks(state);
  await phaseBadge(state);
  await phaseConsent(state);
} catch (err) {
  // 断言中途抛错时别只丢一个栈：给出可读原因
  state.aborted = true;
  console.error("\n验证中断: " + String(err?.message ?? err).split("\n").slice(0, 3).join(" | "));
} finally {
  await teardown(state);
}

process.exit(state.aborted || r.summary() ? 1 : 0);
