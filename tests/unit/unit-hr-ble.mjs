// 验收报告（desktop-pet-验收-a18ec21-2026-10-29）G5-12 / G5-13 的心率部分：
//   G5-12 设置面板把「（-60 dBm）」当设备名存下来 → 界面上显示「已连接 Polar H10（-60 dBm）」
//   G5-13 断开/停用后界面与悬浮窗状态不一致（波形留在「已断开」的窗上、badge 留旧读数）
// 另钉住协议广播可消费（ble:heart-rate / ble:device-found → 插件 topic）与模式单选框的编辑锁。
// 全离线：没有任何真机蓝牙访问，全部是假宿主。
import { group, check, eq, deep } from "./harness.mjs";
import { WidgetRenderSession, createDomFacade } from "../../src/runtime/widget-node.ts";
import { stripSignalSuffix } from "../../plugins/com.pet.hr-ble/label.js";
import {
  TOPIC_BPM,
  TOPIC_CMD,
  TOPIC_DEVICES,
  TOPIC_STATUS,
  TOPIC_WIDGET,
} from "../../plugins/com.pet.hr-ble/topics.js";
import { mount, unmount } from "../../plugins/com.pet.hr-ble/widget.js";
import { activate, deactivate } from "../../plugins/com.pet.hr-ble/index.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const propOf = (ops, id, name) => ops.filter((o) => o.k === "prop" && o.id === id && o.name === name);
const texts = (ops) => ops.filter((o) => o.k === "text").map((o) => String(o.value));

/* ============================== 设备名清洗（G5-12） ============================== */
group("hr 设备名清洗：RSSI 后缀不是设备身份（G5-12）");
{
  eq("全角括号后缀被剥掉", stripSignalSuffix("Polar H10（-60 dBm）"), "Polar H10");
  eq("半角括号后缀也被剥掉", stripSignalSuffix("Polar H10 (-60 dBm)"), "Polar H10");
  eq("正信号强度同样处理", stripSignalSuffix("Polar H10（+4 dBm）"), "Polar H10");
  eq("没有后缀的名字原样", stripSignalSuffix("Polar H10"), "Polar H10");
  eq("名字里自带括号但不像 RSSI：不误删", stripSignalSuffix("手环（备用）"), "手环（备用）");
  eq("字符串空串归一成 null", stripSignalSuffix("   "), null);
  eq("null 归一成 null", stripSignalSuffix(null), null);
  eq("undefined 归一成 null", stripSignalSuffix(undefined), null);
  eq("非字符串归一成 null", stripSignalSuffix(42), null);
  eq("只有后缀时剥完整成 null", stripSignalSuffix("（-60 dBm）"), null);
}

/* ======================= 设置面板：设备行、连接名、状态回显 ======================= */
function widgetRig() {
  const sent = [];
  const session = new WidgetRenderSession((msg) => sent.push(msg));
  const dom = createDomFacade(session);
  const subs = new Map();
  const published = [];
  const bus = {
    subscribe: (topic, fn) => {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic).add(fn);
      return () => subs.get(topic)?.delete(fn);
    },
    publish: (topic, payload) => published.push([topic, payload]),
  };
  const emit = (topic, payload) => {
    for (const fn of [...(subs.get(topic) ?? [])]) fn(payload);
  };
  const ops = () => {
    session.flush();
    const out = sent.flatMap((m) => m.ops ?? []);
    sent.length = 0;
    return out;
  };
  return { session, dom, bus, emit, published, ops };
}

group("hr 设置面板：设备行不空、连接发的是干净设备名（G5-12）");
{
  const { session, dom, bus, emit, published, ops } = widgetRig();
  const root = session.root;
  mount(root, { dom, bus, region: "settings" });
  const build = ops();
  const selectId = build.find((o) => o.k === "create" && o.tag === "select")?.id;
  const buttonId = (label) => build.find((o) => o.k === "text" && o.value === label)?.id;
  const [scanId, connectId, disconnectId] = ["扫描", "连接", "断开"].map(buttonId);
  check("面板有一个设备下拉和三个按钮", [selectId, scanId, connectId, disconnectId].every((id) => typeof id === "number"), JSON.stringify({ selectId, scanId, connectId, disconnectId }));
  check("下拉首项是「点扫描」的占位提示，不是空白", texts(build).some((t) => t.includes("点击「扫描」")), JSON.stringify(texts(build)));

  emit(TOPIC_DEVICES, { id: "d1", name: "Polar H10", rssi: -60 });
  const listed = ops();
  check(
    "设备行带 RSSI 显示（方便挑设备）",
    texts(listed).some((t) => t === "Polar H10（-60 dBm）"),
    JSON.stringify(texts(listed)),
  );

  // 没选设备就点连接：提示而不是发一条空指令
  published.length = 0;
  session.handleEvent(connectId, "click", {});
  eq("没选设备不发 connect", published.length, 0);
  const afterEmpty = ops();
  check("没选设备给提示", texts(afterEmpty).includes("请先扫描并选择设备"), JSON.stringify(texts(afterEmpty)));

  // 选中设备后连接：deviceName 必须是干净名字
  session.handleEvent(selectId, "change", { value: "d1" });
  ops();
  session.handleEvent(connectId, "click", {});
  ops();
  deep("连接指令发的是干净设备名（不带 dBm）", published.filter(([topic]) => topic === TOPIC_CMD).map(([, p]) => p), [
    { action: "connect", deviceId: "d1", deviceName: "Polar H10" },
  ]);

  unmount(root);
}

group("hr 设置面板：断开与广播不打架（G5-13 / 编辑锁）");
{
  const { session, dom, bus, emit, published, ops } = widgetRig();
  const root = session.root;
  mount(root, { dom, bus, region: "settings" });
  const build = ops();
  const statusId = build.find((o) => o.k === "text" && o.value === "就绪")?.id;
  const radioIds = {};
  for (const value of ["badge", "overlay"]) {
    radioIds[value] = build.find((o) => o.k === "prop" && o.name === "value" && o.value === value)?.id;
  }
  check("两个模式单选框都建出来了", Object.values(radioIds).every((id) => typeof id === "number"), JSON.stringify(radioIds));
  check("状态行建出来了", typeof statusId === "number", String(statusId));
  deep("默认 badge 被勾上", propOf(build, radioIds.badge, "checked").map((o) => o.value), [true]);

  // 用户点 overlay：立刻发指令，并上锁
  published.length = 0;
  session.handleEvent(radioIds.overlay, "change", { checked: true });
  ops();
  deep("切模式立刻发 cmd", published.filter(([topic]) => topic === TOPIC_CMD).map(([, p]) => p), [
    { action: "mode", value: "overlay" },
  ]);

  // 在途旧快照（mode=badge）不许把刚点的选项冲回去
  emit(TOPIC_WIDGET, { mode: "badge", connected: false });
  const stale = ops();
  check(
    "旧快照没把 overlay 取消掉",
    propOf(stale, radioIds.overlay, "checked").every((o) => o.value !== false),
    JSON.stringify(propOf(stale, radioIds.overlay, "checked")),
  );

  // 推送追上（mode=overlay）后放锁；之后外部改回 badge 能进来
  emit(TOPIC_WIDGET, { mode: "overlay", connected: false });
  ops();
  emit(TOPIC_WIDGET, { mode: "badge", connected: false });
  const external = ops();
  // 假 DOM 不做单选组的互斥，所以「回显 badge」在节点上表现为把 overlay 取消掉。
  check(
    "追上之后外部改模式能回显",
    propOf(external, radioIds.overlay, "checked").some((o) => o.value === false),
    JSON.stringify(propOf(external, radioIds.overlay, "checked")),
  );

  // 连接状态：连上显示「已连接 干净名」，断开要换掉，不许留旧文案
  emit(TOPIC_WIDGET, { mode: "badge", connected: true, deviceName: "Polar H10" });
  const connectedOps = ops();
  check("连上时显示「已连接 Polar H10」", texts(connectedOps).includes("已连接 Polar H10"), JSON.stringify(texts(connectedOps)));
  emit(TOPIC_WIDGET, { mode: "badge", connected: false });
  const goneOps = ops();
  check("断开时状态行跟着改", texts(goneOps).includes("设备已断开"), JSON.stringify(texts(goneOps)));
  check(
    "断开态是 error 级",
    goneOps.some((o) => o.k === "attr" && o.id === statusId && o.name === "class" && String(o.value).includes("error")),
    JSON.stringify(goneOps.filter((o) => o.k === "attr" && o.id === statusId)),
  );

  // 从来没见过连接态的推送，别凭空写「设备已断开」
  emit(TOPIC_WIDGET, { mode: "badge", connected: false });
  const quiet = ops();
  check("没连过就不乱报断开", !texts(quiet).includes("设备已断开"), JSON.stringify(texts(quiet)));

  unmount(root);
}

group("hr badge：断开清旧读数、未连接不挂空框（G5-13）");
{
  const { session, dom, bus, emit, ops } = widgetRig();
  const root = session.root;
  mount(root, { dom, bus, region: "badge" });
  ops();
  check("还没连接：根上只有样式，不挂空徽标", true, "");

  emit(TOPIC_WIDGET, { connected: true });
  ops();
  emit(TOPIC_BPM, { bpm: 72 });
  const beat = ops();
  check("收到 BPM 后写读数", texts(beat).includes("72"), JSON.stringify(texts(beat)));

  emit(TOPIC_WIDGET, { connected: false });
  const off = ops();
  check("断开后读数退回 --", texts(off).includes("--"), JSON.stringify(texts(off)));
  check(
    "断开后徽标从树里摘掉",
    off.some((o) => o.k === "remove"),
    JSON.stringify(off.filter((o) => o.k === "remove")),
  );

  unmount(root);
}

/* ========================= 主逻辑：广播可消费、断开即收窗（G5-13） ========================= */
function hrHost({ saved = null } = {}) {
  const subs = new Map();
  const published = [];
  const widgets = [];
  const overlay = [];
  const bleCalls = [];
  const writes = [];
  const logs = [];
  const bus = {
    subscribe: (topic, fn) => {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic).add(fn);
      return () => subs.get(topic)?.delete(fn);
    },
    publish: (topic, payload) => published.push([topic, payload]),
  };
  const emit = (topic, payload) => {
    for (const fn of [...(subs.get(topic) ?? [])]) fn(payload);
  };
  const ctx = {
    storage: {
      get: async () => saved,
      set: async (key, value) => writes.push([key, value]),
    },
    bus,
    widget: { update: (data) => widgets.push(data) },
    overlay: {
      show: async () => overlay.push("show"),
      hide: async () => overlay.push("hide"),
      destroy: async () => overlay.push("destroy"),
    },
    ble: {
      startScan: async () => bleCalls.push("startScan"),
      connect: async () => bleCalls.push("connect"),
      disconnect: async () => bleCalls.push("disconnect"),
      stopScan: async () => bleCalls.push("stopScan"),
    },
    log: (...args) => logs.push(args),
  };
  const cmd = async (payload) => {
    for (const fn of subs.get(TOPIC_CMD) ?? []) await fn(payload);
    await settle();
  };
  return { ctx, emit, cmd, published, widgets, overlay, bleCalls, writes, logs };
}

group("hr 主逻辑：协议广播可消费（ble → 插件 topic）");
{
  const host = hrHost();
  await activate(host.ctx);
  check(
    "激活时就绪提示不装已连接",
    host.published.some(([topic, p]) => topic === TOPIC_STATUS && String(p.text).includes("就绪")),
    JSON.stringify(host.published),
  );
  deep("激活后推给界面的状态是未连接", host.widgets.at(-1), { mode: "badge", connected: false, deviceName: null });
  check("未连接且徽标模式：悬浮窗是隐藏的", host.overlay.at(-1) === "hide", JSON.stringify(host.overlay));

  host.published.length = 0;
  host.emit("ble:heart-rate", { bpm: 88 });
  deep("心率广播被转成插件 topic", host.published.filter(([topic]) => topic === TOPIC_BPM).map(([, p]) => p), [{ bpm: 88 }]);

  host.published.length = 0;
  host.emit("ble:device-found", { id: "d1", name: "Polar H10", rssi: -60 });
  deep("设备发现广播被转出去", host.published.filter(([topic]) => topic === TOPIC_DEVICES).map(([, p]) => p), [
    { id: "d1", name: "Polar H10", rssi: -60 },
  ]);

  await deactivate();
}

group("hr 主逻辑：连接/断开/模式与悬浮窗状态一致（G5-13）");
{
  const host = hrHost();
  await activate(host.ctx);

  await host.cmd({ action: "connect", deviceId: "d1", deviceName: "Polar H10（-60 dBm）" });
  eq("连接调的是宿主 ble.connect", host.bleCalls.includes("connect"), true);
  deep("推送里的设备名不含信号后缀", host.widgets.at(-1), { mode: "badge", connected: true, deviceName: "Polar H10" });
  check(
    "落盘也只存干净名字",
    host.writes.some(([key, value]) => key === "config" && value.deviceName === "Polar H10"),
    JSON.stringify(host.writes),
  );
  check(
    "状态文案用干净名字",
    host.published.some(([topic, p]) => topic === TOPIC_STATUS && p.text === "已连接 Polar H10"),
    JSON.stringify(host.published.filter(([t]) => t === TOPIC_STATUS)),
  );

  // 已连接 + 波形图模式：悬浮窗真的显示
  host.overlay.length = 0;
  await host.cmd({ action: "mode", value: "overlay" });
  eq("已连接切波形图模式会显示悬浮窗", host.overlay.at(-1), "show");
  deep("模式推送同步到界面", host.widgets.at(-1), { mode: "overlay", connected: true, deviceName: "Polar H10" });

  // 掉线：悬浮窗收起、界面断开、状态 error
  host.overlay.length = 0;
  host.published.length = 0;
  host.emit("ble:disconnected", {});
  await settle();
  eq("掉线自动收起悬浮窗", host.overlay.at(-1), "hide");
  deep("掉线后界面状态是未连接", host.widgets.at(-1), { mode: "overlay", connected: false, deviceName: "Polar H10" });
  check(
    "掉线有 error 提示",
    host.published.some(([topic, p]) => topic === TOPIC_STATUS && p.level === "error"),
    JSON.stringify(host.published.filter(([t]) => t === TOPIC_STATUS)),
  );

  await deactivate();
  eq("停用带着宿主断开蓝牙", host.bleCalls.slice(-2).join(","), "stopScan,disconnect");
  eq("停用销毁悬浮窗", host.overlay.at(-1), "destroy");

  // 停用后的迟到广播：不许抛、不许再发布
  const before = host.published.length;
  host.emit("ble:heart-rate", { bpm: 99 });
  eq("停用后迟到心率不再发布", host.published.length, before);
}

group("hr 主逻辑：恢复配置时清洗历史脏名字（G5-12）");
{
  const host = hrHost({ saved: { device: "d9", deviceName: "Polar H10（-70 dBm）", mode: "overlay" } });
  await activate(host.ctx);
  deep("恢复的是干净设备名与模式", host.widgets.at(-1), { mode: "overlay", connected: false, deviceName: "Polar H10" });
  eq("未连接时波形图模式不显示悬浮窗", host.overlay.includes("show"), false);
  await deactivate();
}
