// 待办插件主逻辑，运行在宠物窗上下文。
// 数据只存插件自己的隔离存储（宿主按 id 分目录），不碰用户本机文件。
// 清单变化 → 广播标准 topic `com.pet.todo:changed`；界面数据一律经 ctx.widget.update
// 推到 `<id>:widget`，面板重新挂载时由宿主回灌，所以设置面板能显示当前状态。
import { TOPIC_CHANGED, TOPIC_CMD, TOPIC_STATUS } from "./topics.js";
import { commitDone } from "./order.js";
import { formatLine, parseLine, sortOpen, today } from "./todo-txt.js";

let ctx = null;
let tasks = [];
let config = { card: false, remind: true, cardX: 560, cardY: 140 };
let notified = {}; // { 任务 id: 已提醒过的日期 }，一天最多提醒一次
let timer = 0;

// 总线订阅不用自己记账：宿主在插件停用时统一回收（见 src/runtime/subscriptions.ts）。
// 原先这里 push 的是 ctx.bus.subscribe 返回的 Promise（它是异步的，要先过权限），
// 停用时 off() 必然抛错被吞掉，等于从来没退订过。

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function status(text, level = "info") {
  ctx?.bus.publish(TOPIC_STATUS, { text, level });
}

async function persist() {
  try {
    await ctx.storage.set("tasks", tasks);
    await ctx.storage.set("config", config);
    await ctx.storage.set("notified", notified);
  } catch (err) {
    ctx?.log?.("保存待办失败", err);
  }
}

/** 推给各界面的视图：只给未完成的、最多 20 条，附一条 todo.txt 原文方便核对 */
function pushState() {
  const open = sortOpen(tasks);
  ctx?.widget.update({
    today: today(),
    config,
    openCount: open.length,
    doneCount: tasks.filter((t) => t.done).length,
    tasks: open.slice(0, 20).map((t) => ({ ...t, line: formatLine(t) })),
  });
}

function emitChanged() {
  const open = sortOpen(tasks);
  ctx?.bus.publish(TOPIC_CHANGED, {
    open: open.length,
    total: tasks.length,
    nextDue: open[0]?.meta?.due ?? null,
    nextText: open[0]?.text ?? "",
  });
}

/** 同步桌面卡片：开关开着且有未完成项才显示；坐标是插件自定的逻辑像素（宿主只做屏内夹紧） */
async function syncCard() {
  const want = config.card === true && sortOpen(tasks).length > 0;
  try {
    // 改完配置会再走一遍这里：已存在的窗带新坐标重 show 时宿主会真的挪窗
    if (want) await ctx.overlay.show({ x: config.cardX, y: config.cardY, height: 176 });
    else await ctx.overlay.hide();
  } catch (err) {
    ctx?.log?.("桌面卡片切换失败", err);
  }
}

/** 到期检查：逾期与今天到期的各提醒一次（按日去重），并让宠物有反应 */
async function checkDue(force = false) {
  if (!config.remind) return;
  const now = today();
  let fired = 0;
  for (const task of sortOpen(tasks)) {
    const due = task.meta?.due;
    if (!due || due > now) continue;
    if (!force && notified[task.id] === now) continue;
    const overdue = due < now;
    // 三条都得成功才算「今天已经提醒过」：原先先写标记再 await，
    // 通知一抛错这条任务今天就再也不提醒，而且循环整个断掉、异常没人接
    try {
      await ctx.notify.show(overdue ? "待办已逾期" : "待办今天到期", formatLine(task));
      await ctx.pet.react(overdue ? "failed" : "waiting");
      await ctx.pet.say(overdue ? `「${task.text}」已经逾期了……` : `「${task.text}」今天到期哦`);
    } catch (err) {
      ctx?.log?.("到期提醒失败", err);
      continue;
    }
    notified[task.id] = now;
    fired += 1;
  }
  if (fired > 0) await persist();
}

async function handleCmd(cmd) {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.action) {
    case "sync":
      pushState();
      return;
    case "add": {
      const raw = String(cmd.text ?? "").trim();
      if (!raw) {
        status("先写点什么再添加", "error");
        return;
      }
      const parsed = parseLine(raw);
      if (!parsed.text && !parsed.priority) {
        status("这条里没有可显示的文字", "error");
        return;
      }
      tasks.push({ ...parsed, id: newId() });
      await afterChange(`已添加：${parsed.text}`);
      break;
    }
    case "toggle": {
      const task = tasks.find((t) => t.id === cmd.id);
      if (!task) return;
      const done = cmd.done === true;
      const wasNotified = notified[task.id];
      if (done) delete notified[task.id];
      // 先落盘、再 await 宠物调用（G5-09）：宠物 reject 时状态已经存下了，不会被丢
      await commitDone(task, done, {
        completed: today(),
        save: persist,
        rollback: (err) => {
          if (wasNotified !== undefined) notified[task.id] = wasNotified;
          ctx?.log?.("完成状态落盘失败，已回滚", err);
        },
        react: (level) => ctx.pet.react(level),
        say: (text) => ctx.pet.say(text),
        note: (err) => ctx?.log?.("宠物反应失败（状态已落盘）", err),
      });
      await afterChange(done ? `已完成：${task.text}` : `重新打开：${task.text}`);
      break;
    }
    case "remove": {
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== cmd.id);
      if (tasks.length !== before) {
        delete notified[cmd.id];
        await afterChange("已删除一条");
      }
      break;
    }
    case "clearDone": {
      const removed = tasks.filter((t) => t.done).length;
      tasks = tasks.filter((t) => !t.done);
      await afterChange(removed > 0 ? `已清掉 ${removed} 条完成项` : "没有可清的完成项");
      break;
    }
    case "config": {
      if (cmd.card !== undefined) config.card = cmd.card === true;
      if (cmd.remind !== undefined) config.remind = cmd.remind === true;
      // 坐标只在是有限数字时收：怪值不落库，卡片继续按上一次的坐标显示
      if (Number.isFinite(cmd.cardX)) config.cardX = cmd.cardX;
      if (Number.isFinite(cmd.cardY)) config.cardY = cmd.cardY;
      await persist();
      pushState();
      await syncCard();
      status(`桌面卡片 ${config.card ? "开" : "关"}、到期提醒 ${config.remind ? "开" : "关"}`);
      break;
    }
    default:
      status(`未知指令: ${String(cmd.action)}`, "error");
  }
}

async function afterChange(note) {
  await persist();
  pushState();
  emitChanged();
  await syncCard();
  if (note) status(note, "ok");
}

export async function activate(context) {
  // 重复激活不叠定时器（宿主已把启停排进同一串行链，这里再兜一层）
  if (timer) clearInterval(timer);
  ctx = context;
  // 指令链的异常不能变成未处理的 rejection（停用中、存储/宠物调用失败都走这里）
  ctx.bus.subscribe(TOPIC_CMD, (p) => {
    void handleCmd(p).catch((err) => ctx?.log?.("待办指令失败", err));
  });

  for (const key of ["tasks", "config", "notified"]) {
    try {
      const saved = await ctx.storage.get(key);
      if (key === "tasks") {
        if (Array.isArray(saved)) tasks = saved.filter((t) => t && typeof t.id === "string");
      } else if (saved && typeof saved === "object") {
        // 逐字段严格恢复：存储里混进什么类型都不该让 config.card 变成 truthy 的怪值、
        // 也不该让坐标变成 NaN／字符串／true（不是有限数字就回兜底缺省）
        if (key === "config") {
          config = {
            card: saved.card === true,
            remind: saved.remind !== false,
            cardX: Number.isFinite(saved.cardX) ? saved.cardX : 560,
            cardY: Number.isFinite(saved.cardY) ? saved.cardY : 140,
          };
        }
        if (key === "notified") {
          notified = {};
          for (const [id, day] of Object.entries(saved)) {
            if (typeof day === "string") notified[id] = day;
          }
        }
      }
    } catch (err) {
      ctx.log?.(`读取 ${key} 失败`, err);
    }
  }

  pushState();
  emitChanged();
  await syncCard();
  await checkDue();
  timer = setInterval(() => void checkDue(), 60_000);
  status(`待办已就绪：${sortOpen(tasks).length} 项未完成`);
}

export async function deactivate() {
  if (timer) clearInterval(timer);
  timer = 0;
  try {
    await ctx?.overlay.destroy();
  } catch {
    /* 没开过就没有卡片 */
  }
  ctx = null;
}
