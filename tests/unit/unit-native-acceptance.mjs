// 验收 a18ec21 的原生侧行为单测（只测「调度顺序」这类 JS 侧真接线的部分）。
//
// 为什么这里只有订阅/门禁顺序，没有网络策略：出站策略（TUN fake-ip、跨源敏感头、两档超时）
// 全在 Rust 侧，证据是 `cargo test --manifest-path src-tauri/Cargo.toml` 里的
// `services::http::tests::*` 与 `services::http_proxy::tests::*`。在 JS 里再写一遍常量
// 对照等于只测常量，反而给人「已经有人看着」的错觉。
//
// 本文件钉的是验收 N6：**先验证能力，再建订阅** —— 被拒的订阅不许在总线里留下空挂的监听，
// 否则一次失败的 subscribe 会永久收到事件（插件已经 settle 失败，回调却还在跑）。
//
// 运行：随 `npm run unit` 一起跑（`tests/unit/unit-*.mjs`）。
import { check, group } from "./harness.mjs";
import { resetStub, setReply } from "./tauri-stub.mjs";

resetStub();
// 授权表按「已同意」桩：本文件要验的是 ACL 与建订阅的先后，不是同意框那条路
setReply("permission_check", true);
setReply("permission_request", true);

const { buildContext } = await import(new URL("../../src/runtime/bridge.ts", import.meta.url));
const { bus } = await import(new URL("../../src/runtime/event-bus.ts", import.meta.url));
const { BUS_SUBSCRIBE } = await import(new URL("../../src/runtime/plugin-capabilities.ts", import.meta.url));

// 声明了 bus:subscribe ⇒ 能力门禁不是拦它的那一层，能单独验 topic ACL 与建订阅的先后
const manifest = {
  id: "uz.acceptance",
  name: "验收夹具",
  version: "0.0.0",
  permissions: [BUS_SUBSCRIBE],
};
const ctx = buildContext(manifest);

group("N6 订阅：先验证再建，被拒不留监听");

// ① 越过自己命名空间、又不在公开 topic 表里 —— 必须拒（这是 ACL 的判定，不是能力门禁）
let delivered = 0;
let rejected = null;
try {
  await ctx.bus.subscribe("someone.else:widget", () => {
    delivered += 1;
  });
} catch (err) {
  rejected = err;
}
check("跨命名空间订阅非公开 topic 抛错", rejected !== null, "没有抛错，ACL 可能被绕过");
check(
  "拒的理由是 topic 归属（不是「缺能力」那条路）",
  String(rejected).includes("只能订自己的前缀"),
  `实际文案: ${String(rejected)}`,
);

// ② 关键顺序断言：被拒之后，这条 topic 上**不能**有监听。
//    `bus.publish` 是本窗口即时派发，若上一步先 subscribe 再 throw，上面的 handler 就会被调到。
bus.publish("someone.else:widget", { probe: 1 });
check("被拒的订阅没有在总线上留下监听", delivered === 0, `仍收到 ${delivered} 次派发`);

// ③ 自己的命名空间：允许订阅，且确实能收到（正例，防 ACL 改成一律拒还全绿）
const ctx2 = buildContext({ id: "uz.acceptance.own", name: "自己", version: "0.0.0", permissions: [BUS_SUBSCRIBE] });
let got = null;
const off = await ctx2.bus.subscribe("uz.acceptance.own:changed", (payload) => {
  got = payload;
});
bus.publish("uz.acceptance.own:changed", { ok: true });
check("同命名空间订阅能收到自己的事件", got?.ok === true, `实际 ${JSON.stringify(got)}`);
off();

group("N6 发布：越界发布/未声明能力都真报错");

let pubRejected = null;
try {
  // publish 是 gated 包装过的异步方法：不 await 的话异常变成未处理的 rejection，
  // 测试会在「没抛错」上假绿
  await ctx.bus.publish("someone.else:widget", { x: 1 });
} catch (err) {
  pubRejected = err;
}
check("越界发布抛错（不静默丢弃）", pubRejected !== null, "没有抛错");

// 没声明 bus:subscribe 的插件：门禁必须先拒（同意的桩改成「用户拒绝」）
setReply("permission_check", false);
setReply("permission_request", false);
const noCaps = buildContext({ id: "uz.acceptance.nocaps", name: "无能力", version: "0.0.0", permissions: [] });
let gateRejected = null;
let gateDelivered = 0;
try {
  await noCaps.bus.subscribe("uz.acceptance.nocaps:changed", () => {
    gateDelivered += 1;
  });
} catch (err) {
  gateRejected = err;
}
check("未声明 bus:subscribe 的订阅被门禁拒", gateRejected !== null, "没有抛错");
check(
  "拒的文案点出缺的那个能力名",
  String(gateRejected).includes(BUS_SUBSCRIBE),
  `实际文案: ${String(gateRejected)}`,
);
bus.publish("uz.acceptance.nocaps:changed", { probe: 2 });
check("门禁拒掉的订阅同样没留下监听", gateDelivered === 0, `仍收到 ${gateDelivered} 次派发`);
