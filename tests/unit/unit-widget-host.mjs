// widget 宿主回归（附录2 N4 / N7 + G4-04/06）：批次、事件回声、停用终态与挂载竞态。
//
// 这里的「宿主」有两层：
//   1) 真跑起来的 `WidgetRenderSession`（宿主侧的虚拟 DOM 与 op 流），可以直接断言行为；
//   2) `widget-host.ts` / `worker-widget-host.ts` 的挂载-卸载竞态，只能对源码做形状断言
//      （它们直接依赖 WebView / Worker，离线跑不起来），断言点选的是「竞态窗口必须被处理」。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { WIDGET_MAX_OPS_PER_MESSAGE } from "../../src/runtime/widget-protocol.ts";
import {
  WidgetRenderSession,
  createDomFacade,
} from "../../src/runtime/widget-node.ts";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const WIDGET_HOST_SRC = read("../../src/runtime/widget-host.ts");
const WORKER_WIDGET_SRC = read("../../src/runtime/worker-widget-host.ts");

const SVG_NS = "http://www.w3.org/2000/svg";

/** 造一个能收集 op 批次的会话 */
function rig() {
  const batches = [];
  const session = new WidgetRenderSession((message) => batches.push(message));
  return { session, batches, ops: () => batches.flatMap((b) => b.ops) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("op 批次（G4-04：停用窗口里不再有杂乱写入）", () => {
  it("一次微任务里的多次写入合并成一批，序号从 0 起", async () => {
    const { session, batches, ops } = rig();
    const box = session.create("div");
    box.className = "card";
    box.textContent = "hello";
    session.root.append(box);
    await settle();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].t, "ops");
    assert.equal(batches[0].seq, 0);
    assert.deepEqual(
      ops().map((op) => op.k),
      ["create", "attr", "text", "append"],
    );
  });

  it("显式 flush 之后，排队的微任务不再重复发（不会双写宿主）", async () => {
    const { session, batches } = rig();
    const node = session.create("span");
    node.textContent = "x";
    session.flush();
    assert.equal(batches.length, 1);
    await settle();
    assert.equal(batches.length, 1);
  });

  it("超过单批上限就分片，序号连续递增", async () => {
    const { session, batches } = rig();
    const node = session.create("div");
    const total = WIDGET_MAX_OPS_PER_MESSAGE + 5;
    for (let i = 0; i < total; i += 1) node.className = `c${i}`;
    session.flush();
    assert.equal(batches.length, 2);
    assert.equal(batches[0].ops.length, WIDGET_MAX_OPS_PER_MESSAGE);
    // create 占掉 1 条，剩下的写才会溢到第二批
    assert.equal(batches[1].ops.length, 1 + total - WIDGET_MAX_OPS_PER_MESSAGE);
    assert.deepEqual(
      batches.map((b) => b.seq),
      [0, 1],
    );
  });

  it("没有写入就不发空批（宿主不该被空转唤醒）", async () => {
    const { session, batches } = rig();
    session.flush();
    await settle();
    assert.equal(batches.length, 0);
  });
});

describe("宿主回推事件（G4-06：action 失败/回声不能假装成功）", () => {
  it("回推 value 先落到本地再派发 handler", () => {
    const { session } = rig();
    const select = session.create("select");
    let seen = null;
    select.on("change", (event) => {
      seen = { value: select.value, target: event.target === select };
    });
    session.handleEvent(select.nodeId, "change", { value: "pet" });
    assert.deepEqual(seen, { value: "pet", target: true });
  });

  it("checked 按布尔回声，写回 false 也要生效", () => {
    const { session } = rig();
    const box = session.create("input");
    box.checked = true;
    session.handleEvent(box.nodeId, "change", { checked: false });
    assert.equal(box.checked, false);
  });

  it("keyboard 事件的 key 只在是字符串时带上", () => {
    const { session } = rig();
    const input = session.create("input");
    const keys = [];
    input.on("keydown", (event) => keys.push(event.key));
    session.handleEvent(input.nodeId, "keydown", { key: "Enter" });
    session.handleEvent(input.nodeId, "keydown", { key: 13 });
    assert.deepEqual(keys, ["Enter", undefined]);
  });

  it("没有 handler 的回推不抛；未知 id 落到 root 也不抛", () => {
    const { session } = rig();
    const span = session.create("span");
    assert.doesNotThrow(() => session.handleEvent(span.nodeId, "click", {}));
    assert.doesNotThrow(() => session.handleEvent(99_999, "click", { value: "x" }));
  });

  it("停用之后再回推事件是空操作（Worker 已经 terminate）", () => {
    const { session } = rig();
    const btn = session.create("button");
    let calls = 0;
    btn.on("click", () => {
      calls += 1;
    });
    session.discard();
    assert.doesNotThrow(() => session.handleEvent(btn.nodeId, "click", {}));
    assert.equal(calls, 0);
  });
});

describe("停用终态（N7：回调不复活已下线的 widget）", () => {
  it("discard 丢掉缓冲，迟到写入既不排队也不发批", async () => {
    const { session, batches } = rig();
    const node = session.create("div");
    node.textContent = "排队中";
    session.discard();
    assert.equal(session.isDisposed, true);
    session.flush();
    await settle();
    assert.equal(batches.length, 0);

    node.textContent = "复活尝试";
    node.className = "zombie";
    await settle();
    assert.equal(batches.length, 0);
  });

  it("新会话不受旧会话停用影响，序号各算各的", async () => {
    const first = rig();
    first.session.discard();
    const second = rig();
    second.session.create("div").textContent = "新挂载";
    await settle();
    assert.equal(second.batches.length, 1);
    assert.equal(second.batches[0].seq, 0);
  });
});

describe("DOM 面", () => {
  it("createElement / createElementNS 走同一会话并分配递增 id", () => {
    const { session } = rig();
    const dom = createDomFacade(session);
    const div = dom.createElement("div");
    const svg = dom.createElementNS(SVG_NS, "circle");
    assert.ok(div.nodeId > 0);
    assert.equal(svg.nodeId, div.nodeId + 1);
  });

  it("只接受 SVG 那一个命名空间", () => {
    const { session } = rig();
    const dom = createDomFacade(session);
    assert.throws(() => dom.createElementNS("http://example.com/xml", "g"), /命名空间/);
  });
});

describe("挂载/卸载竞态（G4-04：await 期间不许留下悬挂插槽）", () => {
  it("卸载先把 epoch 抬起来再去等 in-flight 挂载", () => {
    const unmount = WIDGET_HOST_SRC.slice(WIDGET_HOST_SRC.indexOf("async unmount("));
    const epochAt = unmount.indexOf("this.epoch.set(pluginId");
    const awaitAt = unmount.indexOf("await Promise.all(inflight)");
    assert.ok(epochAt >= 0, "卸载必须自增 epoch");
    assert.ok(awaitAt > epochAt, "先抬 epoch 再等 in-flight，否则等回来的挂载会把插槽又插上去");
  });

  it("卸载会把登记表删除，并对每个插槽跑插件自己的 unmount", () => {
    const unmount = WIDGET_HOST_SRC.slice(WIDGET_HOST_SRC.indexOf("async unmount("));
    assert.match(unmount, /this\.mounted\.delete\(pluginId\)/);
    assert.match(unmount, /record\.mod\.unmount\?\.\(record\.shadow\)/);
    assert.match(unmount, /record\.host\.remove\(\)/);
    assert.match(unmount, /dropBadgeSlot\(pluginId, record\.host\)/);
  });

  it("同 id 同区域重复挂载被挡掉，不会出现两份插槽", () => {
    assert.match(WIDGET_HOST_SRC, /if \(!manifest\.widget \|\| this\.has\(manifest\.id, region\) \|\| this\.mounting\.has\(key\)\) return;/);
  });

  it("Worker 挂载失败要清掉刚建的插槽，不留空壳", () => {
    const workerMount = WIDGET_HOST_SRC.slice(WIDGET_HOST_SRC.indexOf("doMountInWorker"));
    assert.match(workerMount, /workerWidgetHost\.mount\(/);
    assert.match(workerMount, /dropBadgeSlot/);
    assert.match(workerMount, /host\.remove\(\)/);
  });

  it("has() 按区域认，不是只看插件 id", () => {
    assert.match(WIDGET_HOST_SRC, /dataset\.region/);
  });
});

describe("Worker widget 宿主", () => {
  it("boot 有超时，失败会销毁会话而不是挂着一个死 Worker", () => {
    assert.match(WORKER_WIDGET_SRC, /WIDGET_BOOT_TIMEOUT_MS = 15_000/);
    assert.match(WORKER_WIDGET_SRC, /catch \(error\) \{[\s\S]{0,200}this\.destroy\(key, session\);/);
    assert.match(WORKER_WIDGET_SRC, /finally \{\s*clearTimeout\(bootTimer\);/);
  });

  it("op 流交给渲染器，事件回推交给 call 兜底（每个 call 都有回执）", () => {
    assert.match(WORKER_WIDGET_SRC, /renderer\.apply\(/);
    assert.match(WORKER_WIDGET_SRC, /case "call":|t: "call"/);
  });

  it("销毁顺序：退订、拆渲染器、终止 Worker", () => {
    const destroy = WORKER_WIDGET_SRC.slice(WORKER_WIDGET_SRC.indexOf("destroy(key: string"));
    assert.match(destroy, /unsubscribers/);
    assert.match(destroy, /renderer\.destroy\(\)/);
    assert.match(destroy, /worker\.terminate\(\)/);
  });
});
