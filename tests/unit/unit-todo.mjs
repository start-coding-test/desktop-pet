// 验收报告（desktop-pet-验收-a18ec21-2026-10-29）G5-09 的待办部分：
//   N8  persist 吞异常 → commitDone 的回滚分支是死代码；同一次 toggle 还写了两遍存储
// 另外钉住「桌面卡片只在有未完成项时显示」（不凭空弹窗），以及宠物调用失败不许影响已落盘状态。
// 全离线：不碰网络、不碰真实存储（用内存假宿主）。
import { group, check, eq } from "./harness.mjs";
import { activate, deactivate } from "../../plugins/com.pet.todo/index.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeHost({ tasks = null, config = null, failSetKeys = [], petFails = false } = {}) {
  const handlers = new Map();
  const published = [];
  const widgets = [];
  const overlay = [];
  const logs = [];
  const writes = [];
  const storage = {
    get: async (key) => (key === "tasks" ? tasks : key === "config" ? config : null),
    set: async (key, value) => {
      if (failSetKeys.includes(key)) throw new Error(`磁盘写入失败: ${key}`);
      writes.push([key, value]);
    },
  };
  const ctx = {
    storage,
    bus: {
      subscribe: (topic, fn) => {
        handlers.set(topic, fn);
        return () => handlers.delete(topic);
      },
      publish: (topic, payload) => published.push([topic, payload]),
    },
    widget: { update: (data) => widgets.push(data) },
    overlay: {
      show: async (opts) => overlay.push(["show", opts]),
      hide: async () => overlay.push(["hide"]),
      destroy: async () => overlay.push(["destroy"]),
    },
    notify: { show: async () => {} },
    pet: {
      react: async () => {
        if (petFails) throw new Error("宠物反应被拒");
      },
      say: async () => {
        if (petFails) throw new Error("宠物台词被拒");
      },
    },
    log: (...args) => logs.push(args),
  };
  const cmd = async (payload) => {
    handlers.get("com.pet.todo:cmd")?.(payload);
    await settle();
  };
  return { ctx, cmd, published, widgets, overlay, logs, writes, handlers };
}

const lastWidget = (widgets) => widgets.at(-1) ?? {};

/* ========================= 完成状态落盘：顺序、回滚、只写一遍 ========================= */
group("todo 完成状态：先落盘再碰宠物，落盘失败要回滚（G5-09 / N8）");
{
  const host = makeHost({
    tasks: [
      { id: "a", text: "买菜", done: false, completed: null, meta: {} },
      { id: "b", text: "写周报", done: false, completed: null, meta: {} },
    ],
  });
  await activate(host.ctx);
  eq("激活时恢复了两条", lastWidget(host.widgets).openCount, 2);

  host.writes.length = 0;
  await host.cmd({ action: "toggle", id: "a", done: true });

  const taskWrites = host.writes.filter(([key]) => key === "tasks");
  eq("一次 toggle 只写一遍 tasks（不是原先的两遍）", taskWrites.length, 1);
  const savedTasks = taskWrites.at(-1)?.[1] ?? [];
  eq("落盘的确实是「已完成」", savedTasks.find((t) => t.id === "a")?.done, true);
  check("完成日期也落盘了", typeof savedTasks.find((t) => t.id === "a")?.completed === "string", JSON.stringify(savedTasks[0]));
  check(
    "状态提示是「已完成」",
    host.published.some(([topic, p]) => topic === "com.pet.todo:status" && String(p.text).includes("已完成：买菜")),
    JSON.stringify(host.published.filter(([t]) => t === "com.pet.todo:status")),
  );
  eq("界面上未完成数立刻减一", lastWidget(host.widgets).openCount, 1);

  await deactivate();
}

group("todo 落盘失败：回滚内存状态，不许界面显示成功（N8）");
{
  const host = makeHost({
    tasks: [{ id: "a", text: "买菜", done: false, completed: null, meta: {} }],
    failSetKeys: ["tasks"],
  });
  await activate(host.ctx);
  host.published.length = 0;
  host.widgets.length = 0;
  await host.cmd({ action: "toggle", id: "a", done: true });

  eq("落盘失败时未完成数不变（回滚生效）", lastWidget(host.widgets).openCount, 1);
  check(
    "没有把「已完成」发到界面",
    !host.published.some(([topic, p]) => topic === "com.pet.todo:status" && String(p.text).includes("已完成")),
    JSON.stringify(host.published.filter(([t]) => t === "com.pet.todo:status")),
  );
  check(
    "回滚有日志（不是静默吞掉）",
    host.logs.some((args) => String(args[0]).includes("完成状态落盘失败")),
    JSON.stringify(host.logs.map((args) => String(args[0]))),
  );
  check(
    "指令异常被接住，没有变成未处理的 rejection",
    host.logs.some((args) => String(args[0]).includes("待办指令失败")),
    JSON.stringify(host.logs.map((args) => String(args[0]))),
  );

  await deactivate();
}

group("todo 宠物调用失败：不影响已落盘状态（G5-09）");
{
  const host = makeHost({
    tasks: [{ id: "a", text: "买菜", done: false, completed: null, meta: {} }],
    petFails: true,
  });
  await activate(host.ctx);
  host.writes.length = 0;
  host.widgets.length = 0;
  await host.cmd({ action: "toggle", id: "a", done: true });

  const savedTasks = host.writes.filter(([key]) => key === "tasks").at(-1)?.[1] ?? [];
  eq("宠物失败也已落盘为完成", savedTasks.find((t) => t.id === "a")?.done, true);
  eq("界面上已算完成", lastWidget(host.widgets).openCount, 0);
  check(
    "宠物失败只记日志",
    host.logs.some((args) => String(args[0]).includes("宠物反应失败")),
    JSON.stringify(host.logs.map((args) => String(args[0]))),
  );

  await deactivate();
}

/* ======================= 桌面卡片：没有未完成项就不显示 / 不重开 ======================= */
group("todo 桌面卡片只在有未完成项时显示（不凭空弹窗）");
{
  const host = makeHost({
    tasks: [{ id: "a", text: "买菜", done: false, completed: null, meta: {} }],
    config: { card: true, remind: true, cardX: 100, cardY: 200 },
  });
  await activate(host.ctx);
  const shown = host.overlay.filter(([kind]) => kind === "show");
  eq("配置开着且有未完成项：显示卡片", shown.length, 1);
  eq("卡片高度按插件约定", shown[0]?.[1]?.height, 176);

  host.overlay.length = 0;
  await host.cmd({ action: "toggle", id: "a", done: true });
  check(
    "最后一条完成：卡片收起来，不再弹新窗",
    host.overlay.every(([kind]) => kind === "hide"),
    JSON.stringify(host.overlay),
  );

  await deactivate();
}

group("todo 卡片开关关着时不许弹窗");
{
  const host = makeHost({
    tasks: [{ id: "a", text: "买菜", done: false, completed: null, meta: {} }],
    config: { card: false, remind: true },
  });
  await activate(host.ctx);
  check(
    "开关关着：只有 hide，没有 show",
    host.overlay.every(([kind]) => kind !== "show"),
    JSON.stringify(host.overlay),
  );
  await deactivate();
}

/* ============================ 指令面：未知指令不静默 ============================ */
group("todo 未知指令给出错误提示，不假装成功");
{
  const host = makeHost({ tasks: [] });
  await activate(host.ctx);
  host.published.length = 0;
  await host.cmd({ action: "nope" });
  check(
    "未知指令有 error 提示",
    host.published.some(([topic, p]) => topic === "com.pet.todo:status" && p.level === "error"),
    JSON.stringify(host.published),
  );
  await deactivate();
}
