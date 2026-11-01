// 运行时验收回归（附录2 N4 / N5 / N6 / N7 / N9 + G4 错误分类）。
//
// 这份文件只做离线判定：import 的是产品里的纯模块与真类，源码形状断言读的是同一份磁盘文件。
// 覆盖的是「坏插件不能把整个运行时带下去」这一组行为：
//   - 生命周期隔离：某一步抛错不许跳过后面的收尾（N5）；
//   - 错误分类：插件域错误不许被当成致命错误（G4）；
//   - 热重载：同一 id 只算一次、空 id 不进会话表（N6）；
//   - 停用终态：丢弃后的 widget 会话不许被回调复活（N7）；
//   - 悬浮窗自愈：认不出主人/插件没了要关掉自己，别留关不掉的空窗（N4）；
//   - 资源账本：停用后不残留持有者，重复释放不误伤别人（N9 口径）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  INTERNAL,
  IO,
  LEGACY_CODE,
  NETWORK,
  NOT_FOUND,
  PLUGIN_SCOPED_CODES,
  classifyError,
  deniedError,
  errorCodeOf,
  isPluginScopedError,
} from "../../src/runtime/host-error.ts";
import { runIsolated, safeCallback } from "../../src/runtime/lifecycle.ts";
import {
  changedIdsFrom,
  decideHotReload,
  reloadIdsFrom,
} from "../../src/runtime/hot-reload.ts";
import {
  OWNER_GRACE_MS,
  OWNER_RETRY_MS,
  closeReason,
  decideOverlayAction,
} from "../../src/overlay/lifecycle.ts";
import { disposeAll, pendingCount, register } from "../../src/runtime/subscriptions.ts";
import { claim, release, releaseAll } from "../../src/runtime/resources.ts";
import { WidgetRenderSession } from "../../src/runtime/widget-node.ts";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const BOOT_SRC = read("../../src/boot-error.ts");
const RUNTIME_SRC = read("../../src/runtime/plugin-runtime.ts");
const OVERLAY_MAIN_SRC = read("../../src/overlay/main.ts");
const WORKER_WIDGET_SRC = read("../../src/runtime/worker-widget-host.ts");
const WORKER_PLUGIN_SRC = read("../../src/runtime/worker-plugin-host.ts");

/** 计数用的 host 错误负载 */
const hostError = (code, message = "boom") => ({ code, message });

describe("错误分类（G4：普通插件错误不误标致命）", () => {
  it("启动阶段的未捕获错误才是 fatal", () => {
    assert.equal(classifyError(new Error("页面没装配起来"), { bootPhase: true }), "fatal");
    assert.equal(classifyError(hostError(IO), { bootPhase: true }), "fatal");
  });

  it("插件域可预期拒绝归 warning，不再盖整窗红条", () => {
    for (const code of PLUGIN_SCOPED_CODES) {
      assert.equal(classifyError(hostError(code), {}), "warning", `${code} 应为 warning`);
    }
    assert.equal(classifyError(deniedError("未授权"), {}), "warning");
  });

  it("带 pluginId 的上下文一律按插件域处理（哪怕码表里是中性的码）", () => {
    assert.equal(classifyError(hostError(IO), { pluginId: "com.pet.todo" }), "warning");
    assert.equal(classifyError("随便什么", { pluginId: "com.pet.todo" }), "warning");
  });

  it("宿主服务的真失败仍是 error，不是 fatal 也不是插件警告", () => {
    for (const code of [IO, NETWORK, INTERNAL, LEGACY_CODE]) {
      assert.equal(classifyError(hostError(code), {}), "error", `${code} 应为 error`);
    }
    assert.equal(classifyError(new Error("渲染帧失败"), {}), "error");
    assert.equal(classifyError(null, {}), "error");
    assert.equal(classifyError(undefined, {}), "error");
  });

  it("码表边界：插件域名单不含宿主服务码", () => {
    assert.ok(PLUGIN_SCOPED_CODES.includes(NOT_FOUND));
    assert.ok(!PLUGIN_SCOPED_CODES.includes(IO));
    assert.ok(!PLUGIN_SCOPED_CODES.includes(NETWORK));
    assert.ok(!PLUGIN_SCOPED_CODES.includes(INTERNAL));
    assert.equal(isPluginScopedError(hostError(NETWORK)), false);
  });

  it("取码：非宿主错误形状落到 legacy，不会把 undefined 当码", () => {
    assert.equal(errorCodeOf(new Error("x")), LEGACY_CODE);
    assert.equal(errorCodeOf("裸字符串"), LEGACY_CODE);
    assert.equal(errorCodeOf({ code: 42, message: "x" }), LEGACY_CODE);
    assert.equal(errorCodeOf(hostError(NOT_FOUND)), NOT_FOUND);
  });

  it("兜底条只在 fatal 时亮：源码里没有无条件 show", () => {
    assert.match(BOOT_SRC, /classifyError\(rejection, \{ bootPhase: !bootReady \}\)/);
    assert.match(BOOT_SRC, /if \(severity === "fatal"\)/);
    // 监听器必须走 report()，而不是直接 show()
    assert.match(BOOT_SRC, /window\.addEventListener\("error", \(e\) => report\(/);
    assert.ok(!/addEventListener\("error", \(e\) => show/.test(BOOT_SRC));
    // 浏览器噪声过滤（现场红条来源之一）
    assert.match(BOOT_SRC, /ResizeObserver loop/);
  });
});

describe("生命周期隔离（N5：坏插件只影响它自己）", () => {
  it("中间一步抛错，后面的收尾照跑，顺序不变", async () => {
    const log = [];
    const failed = await runIsolated(
      [
        { name: "deactivate", run: () => log.push("deactivate") },
        {
          name: "subscriptions",
          run: () => {
            log.push("subscriptions");
            throw new Error("坏插件的 deactivate 抛了");
          },
        },
        { name: "widget", run: () => log.push("widget") },
        { name: "resources", run: () => log.push("resources") },
      ],
      () => {},
    );
    assert.deepEqual(failed, ["subscriptions"]);
    assert.deepEqual(log, ["deactivate", "subscriptions", "widget", "resources"]);
  });

  it("异步拒绝同样被隔离，runIsolated 永不 throw", async () => {
    const errors = [];
    const failed = await runIsolated(
      [
        { name: "a", run: async () => Promise.reject(new Error("reject")) },
        { name: "b", run: () => undefined },
      ],
      (step, err) => errors.push([step, err.message]),
    );
    assert.deepEqual(failed, ["a"]);
    assert.deepEqual(errors, [["a", "reject"]]);
  });

  it("上报回调自己抛错也不许带停后续步骤", async () => {
    const log = [];
    const failed = await runIsolated(
      [
        { name: "a", run: () => Promise.reject(new Error("x")) },
        { name: "b", run: () => Promise.reject(new Error("y")) },
        { name: "c", run: () => log.push("c") },
      ],
      () => {
        throw new Error("上报路径也坏了");
      },
    );
    assert.deepEqual(failed, ["a", "b"]);
    assert.deepEqual(log, ["c"]);
  });

  it("safeCallback：同步抛与 thenable 拒绝都收敛，正常返回值不打扰上报", async () => {
    const seen = [];
    const onError = (label, err) => seen.push([label, err.message]);
    safeCallback("sync", () => {
      throw new Error("sync");
    }, (label, err) => onError(label, err))(1);
    await Promise.resolve();
    assert.deepEqual(seen, [["sync", "sync"]]);

    const rejected = safeCallback("async", async () => {
      throw new Error("async");
    }, (label, err) => onError(label, err));
    rejected(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(seen.at(-1), ["async", "async"]);

    safeCallback("ok", () => "fine", (label, err) => onError(label, err))(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(seen.length, 2);
  });

  it("订阅回收：一个 cleanup 抛错不拦其它回收，账本清空", () => {
    const ran = [];
    register("com.pet.bad", () => ran.push("a"));
    register("com.pet.bad", () => {
      ran.push("b");
      throw new Error("cleanup 抛了");
    });
    register("com.pet.bad", () => ran.push("c"));
    assert.equal(pendingCount("com.pet.bad"), 3);
    assert.equal(disposeAll("com.pet.bad"), 2);
    assert.deepEqual(ran, ["a", "b", "c"]);
    assert.equal(pendingCount("com.pet.bad"), 0);
  });

  it("提前退订只生效一次（重复调用不重复收）", () => {
    let calls = 0;
    const off = register("com.pet.early", () => {
      calls += 1;
    });
    off();
    off();
    assert.equal(calls, 1);
    assert.equal(disposeAll("com.pet.early"), 0);
  });

  it("插件运行时：激活失败要回滚、停用走隔离步骤", () => {
    assert.match(RUNTIME_SRC, /async function rollbackActivation\(/);
    assert.match(RUNTIME_SRC, /await rollbackActivation\(manifest\.id\)/);
    assert.match(RUNTIME_SRC, /runIsolated\(/);
    for (const name of ["deactivate", "subscriptions", "widget", "resources"]) {
      assert.match(RUNTIME_SRC, new RegExp(`name: "${name}"`), `缺收尾步骤 ${name}`);
    }
    // 监听回调统一走 listenSafe（G4-11：listen handler 不吞异常会变成整窗红条）
    const listenSafeUses = RUNTIME_SRC.match(/listenSafe</g) ?? [];
    assert.ok(listenSafeUses.length >= 6, `listenSafe 覆盖不足：${listenSafeUses.length}`);
    assert.match(RUNTIME_SRC, /async function listenSafe/);
  });
});

describe("热重载（N6：同 id 只算一次，空 id 不进会话表）", () => {
  it("重复 id 去重，空白与非字符串被丢掉", () => {
    assert.deepEqual(reloadIdsFrom({ reloadIds: ["a", "a", " b ", "", "   ", 3, null] }), ["a", "b"]);
  });

  it("坏载荷按空数组处理，不抛", () => {
    assert.deepEqual(reloadIdsFrom(null), []);
    assert.deepEqual(reloadIdsFrom({}), []);
    assert.deepEqual(reloadIdsFrom({ reloadIds: "a" }), []);
    assert.deepEqual(reloadIdsFrom({ ids: ["x"] }), []);
  });

  it("changedIdsFrom 与 reloadIdsFrom 各读各的键", () => {
    const payload = { ids: ["a", "b"], reloadIds: ["b"] };
    assert.deepEqual(changedIdsFrom(payload), ["a", "b"]);
    assert.deepEqual(reloadIdsFrom(payload), ["b"]);
  });

  it("判定：非 dev 不重载、没有承载也不重载、承载去重后重载", () => {
    assert.deepEqual(decideHotReload([], () => true, true), { carried: [], shouldReload: false });
    assert.deepEqual(decideHotReload(["a"], () => true, false), { carried: ["a"], shouldReload: false });
    assert.deepEqual(decideHotReload(["a", "a", "b"], (id) => id === "a", true), {
      carried: ["a"],
      shouldReload: true,
    });
  });

  it("Worker 承载的插件也走同 id 重载，不留空 map", () => {
    // 判定后必须「先停后启」，不是只 reload 宿主文档那一套
    assert.match(RUNTIME_SRC, /if \(!workerHosted\.has\(id\)\) continue;/);
    assert.match(RUNTIME_SRC, /await deactivatePlugin\(id\)/);
    assert.match(RUNTIME_SRC, /await activatePlugin\(manifest\)/);
    // 宿主文档重载只认非 Worker 承载的那些
    assert.match(RUNTIME_SRC, /active\.has\(id\) && !workerHosted\.has\(id\)/);
  });
});

describe("悬浮窗自己关自己（N4：空 pet web 不留空窗）", () => {
  it("认不出归属：宽限期内等，超时关", () => {
    const base = { ownerId: null, installed: false, enabled: false, hasWidget: false, mounted: false };
    assert.equal(decideOverlayAction({ ...base, ownerMissingMs: 0 }), "wait");
    assert.equal(decideOverlayAction({ ...base, ownerMissingMs: OWNER_GRACE_MS - 1 }), "wait");
    assert.equal(decideOverlayAction({ ...base, ownerMissingMs: OWNER_GRACE_MS }), "close");
    assert.ok(OWNER_RETRY_MS > 0 && OWNER_RETRY_MS < OWNER_GRACE_MS);
  });

  it("认出来了但没内容可挂：直接关", () => {
    const owned = { ownerId: "com.pet.todo", installed: true, enabled: true, hasWidget: true, mounted: false };
    assert.equal(decideOverlayAction({ ...owned, installed: false }), "close");
    assert.equal(decideOverlayAction({ ...owned, enabled: false }), "close");
    assert.equal(decideOverlayAction({ ...owned, hasWidget: false }), "close");
  });

  it("已挂载什么都不做；其余挂上去", () => {
    const owned = { ownerId: "com.pet.todo", installed: true, enabled: true, hasWidget: true, mounted: false };
    assert.equal(decideOverlayAction(owned), "mount");
    assert.equal(decideOverlayAction({ ...owned, mounted: true }), "wait");
  });

  it("关窗原因写得出是哪条路收的窗", () => {
    assert.match(closeReason({ ownerId: null, installed: false, enabled: false, hasWidget: false, mounted: false }), /归属/);
    assert.match(closeReason({ ownerId: "x", installed: false, enabled: false, hasWidget: false, mounted: false }), /清单/);
    assert.match(closeReason({ ownerId: "x", installed: true, enabled: false, hasWidget: false, mounted: false }), /停用/);
    assert.match(closeReason({ ownerId: "x", installed: true, enabled: true, hasWidget: false, mounted: false }), /overlay widget/);
  });

  it("接入层真的按判定走（不是只把纯函数摆着）", () => {
    assert.match(OVERLAY_MAIN_SRC, /decideOverlayAction\(/);
    assert.match(OVERLAY_MAIN_SRC, /async function closeSelf\(/);
    assert.match(OVERLAY_MAIN_SRC, /OWNER_RETRY_MS/);
    // 认不出主人时必须落到判定，而不是只 console.error 一句就干等
    assert.match(OVERLAY_MAIN_SRC, /if \(!owner\) \{[\s\S]{0,600}decideOverlayAction/);
    // main 自己失败也要收窗（半透明置顶窗不能留在屏幕上）
    assert.match(OVERLAY_MAIN_SRC, /await closeSelf\("启动失败"\)/);
    // 关窗前先卸载 widget，别留悬挂插槽
    assert.match(OVERLAY_MAIN_SRC, /await widgetHost\.unmount\(pluginId\)/);
  });
});

describe("停用终态与计时器（N7：discard 之后不许复活）", () => {
  it("丢弃后的写入不再产生 op", async () => {
    const batches = [];
    const session = new WidgetRenderSession((message) => batches.push(message));
    const node = session.create("div");
    node.textContent = "首帧";
    await Promise.resolve();
    const before = batches.length;
    assert.ok(before >= 1);

    session.discard();
    assert.equal(session.isDisposed, true);
    // 插件残留回调（定时器/await 之后）继续写：必须全部丢弃
    node.textContent = "复活一次";
    node.style.color = "red";
    session.flush();
    await Promise.resolve();
    assert.equal(batches.length, before);
  });

  it("flush 在丢弃后清空缓冲，seq 不再前进", async () => {
    const batches = [];
    const session = new WidgetRenderSession((message) => batches.push(message));
    const node = session.create("span");
    node.textContent = "x";
    session.discard();
    session.flush();
    await Promise.resolve();
    assert.equal(batches.length, 0);
    node.textContent = "y";
    assert.equal(batches.length, 0);
  });

  it("会话清理确实断开计时器与监听（源码口径）", () => {
    // Worker widget：deactivate 等 ack 的那个监听必须摘、超时计时器必须清
    assert.match(WORKER_WIDGET_SRC, /removeEventListener\("message", wait\)/);
    assert.match(WORKER_WIDGET_SRC, /clearTimeout\(done\)/);
    assert.match(WORKER_WIDGET_SRC, /worker\.terminate\(\)/);
    // 先摘表再等 ack：等的时候新挂载不该被旧会话影响
    assert.match(WORKER_WIDGET_SRC, /sessions\.delete\(key\)[\s\S]{0,400}new Promise/);
  });

  it("插件 Worker：迟到的订阅在会话已销毁时立即退订", () => {
    assert.match(WORKER_PLUGIN_SRC, /if \(this\.sessions\.get\(session\.pluginId\) !== session\) \{[\s\S]{0,300}off\(\)/);
    // ack 的计时器要清，否则 60s 后还在等一个已死的 Worker
    assert.match(WORKER_PLUGIN_SRC, /clearTimeout/);
    assert.match(WORKER_PLUGIN_SRC, /worker\.terminate\(\)/);
  });
});

describe("资源账本（N9 口径：释放与持有必须成对）", () => {
  it("非持有者释放不误伤别人；最后一个持有者退出才算释放", () => {
    claim("ble", "com.pet.a");
    claim("ble", "com.pet.b");
    assert.equal(release("ble", "com.pet.c"), false);
    assert.equal(release("ble", "com.pet.a"), false);
    assert.equal(release("ble", "com.pet.b"), true);
    assert.equal(release("ble", "com.pet.b"), false);
    releaseAll("com.pet.c");
  });

  it("停用一次就释放它全部占用；重复释放不再返回 true", () => {
    claim("ble", "com.pet.d");
    claim("ble-scan", "com.pet.d");
    assert.deepEqual(releaseAll("com.pet.d"), { ble: true, "ble-scan": true });
    assert.deepEqual(releaseAll("com.pet.d"), { ble: false, "ble-scan": false });
  });
});
