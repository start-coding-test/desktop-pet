// 常驻单测的公共断言层（Q2）。底层是 node:test + node:assert，
// 所以 `node --test` 直接给出「每条断言一个用例」的结果与总计，不需要各自数 pass/fail。
//
// 为什么值仍在调用点算：迁移前这些函数是「当场判定、只记录结果」，
// 把 test() 的回调推迟执行但不能改变求值时机，所以 expected/actual 保持实参求值，
// 迁移前后判定内容一字不差（断言只许变严不许变松，这里连口径都没动）。
import { test } from "node:test";
import assert from "node:assert/strict";

const counts = new Map();
let current = "未分组";
let skipped = 0;

/** 开一个分组；用例名会带上 [分组]，CI 输出按它归组可读 */
export function group(name) {
  current = name;
  if (!counts.has(name)) counts.set(name, 0);
}

function record() {
  counts.set(current, (counts.get(current) ?? 0) + 1);
}

/** 注册一条布尔断言。
 * G7-04 的防呆：cond 必须是真布尔。以前 `check(..., "false")` 或漏写 `===` 的表达式会被
 * `cond === true` 静默判成失败/通过，而报错只写「期望条件成立，实际为 …」，看不出是写错了类型。
 * 现在类型不对时直接按失败断言报出来（仍然走 test()，不中断整份文件）。
 */
export function check(name, cond, detail = "") {
  record();
  const shape =
    typeof cond === "boolean" ? "" : `[harness] check() 的 cond 必须是布尔值，收到 ${cond === null ? "null" : typeof cond}`;
  test(`[${current}] ${name}`, () => {
    assert.ok(shape === "", shape);
    assert.ok(cond === true, detail || `期望条件成立，实际为 ${String(cond)}`);
  });
}

/** 环境缺失的断言（报告 N7 / G2-N10）：**不计入通过**，单独计数并在汇总里报 SKIPPED。
 * 与 check 的语义区别：check 失败是回归，skip 只说明这台机器跑不了（例如没有 pwsh）。
 * 用它替掉「没有环境就直接判红」的硬依赖，同时保持「没跑过 ≠ 通过」。 */
export function skip(name, reason = "") {
  skipped++;
  test(`[${current}] ${name}`, { skip: reason || "环境缺失" }, () => {});
}

/** 相等断言：沿用迁移前的 Object.is 口径（NaN 等于 NaN、+0 不等于 -0） */
export function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

/** 结构化断言：按 JSON 串比较，键序敏感 —— 不比迁移前松 */
export function deep(name, actual, expected) {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
}

/** 抛错断言：必须抛 Error；给了 includes 还要命中错误文案 */
export function throws(name, fn, includes = "") {
  record();
  test(`[${current}] ${name}`, () => {
    assert.throws(
      fn,
      (err) => err instanceof Error && (!includes || String(err.message).includes(includes)),
      `期望抛 Error${includes ? ` 且消息含 "${includes}"` : ""}`,
    );
  });
}

process.on("exit", () => {
  let total = 0;
  for (const [name, n] of counts) {
    console.log(`[${name}] ${n}`);
    total += n;
  }
  console.log(`ASSERTIONS ${total}`);
  if (skipped > 0) console.log(`SKIPPED ${skipped}`);
});
