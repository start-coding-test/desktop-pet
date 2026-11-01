// 心率蓝牙插件（主逻辑，运行于宠物窗上下文）
// 数据流：Rust ble:heart-rate → 本插件整理 → `${PID}:bpm` 总线 → 各窗口 widget 渲染
// 设置面板（设置窗）通过 `${PID}:cmd` 下发指令，本插件执行并回发状态。
// 悬浮窗只在「波形图模式 + 已连接设备」时显示，断开即自动关闭。
import { TOPIC_BPM, TOPIC_CMD, TOPIC_DEVICES, TOPIC_STATUS } from "./topics.js";
import { stripSignalSuffix } from "./label.js";

let ctx = null;
let config = { device: null, deviceName: null, mode: "badge" };
let connected = false;
const timers = new Set();

// 总线订阅不用自己记账：宿主在插件停用时统一回收（见 src/runtime/subscriptions.ts）。
// ctx.bus.subscribe 返回的是 Promise（要先过权限），旧代码把它当退订函数 push 进数组，
// 停用时 off() 必然抛错被吞 —— 那份记账从来没生效过。

/** 受管理的定时器：deactivate 一律清掉，不留「插件已经停了但回调还在跑」 */
function later(ms, fn) {
  const id = setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
  return id;
}

function clearTimers() {
  for (const id of timers) clearTimeout(id);
  timers.clear();
}

function status(text, level = "info") {
  ctx?.bus.publish(TOPIC_STATUS, { text, level });
}

async function persist() {
  try {
    await ctx?.storage.set("config", config);
  } catch (err) {
    ctx?.log?.("保存配置失败", err);
  }
}

/**
 * 悬浮窗显隐与「模式 + 连接状态」联动，同时把这份状态推给各区域界面。
 * 停用后（ctx 已置空）一律不动：host 回收订阅与 `void` 发起的异步链可能比赛，别在这里抛。
 */
async function syncOverlay() {
  if (!ctx) return;
  if (config.mode === "overlay" && connected) {
    await ctx.overlay.show();
  } else {
    await ctx.overlay.hide();
  }
  // 设置面板重新挂载时由宿主回灌这份数据，它才可能显示当前选项而不是默认值
  ctx.widget.update({ mode: config.mode, connected, deviceName: config.deviceName });
}

/** 意外掉线的自动重连：退避几轮就收手，别把蓝牙栈打爆 */
const RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000];
let retries = 0;

function scheduleReconnect() {
  if (!ctx || !config.device || retries >= RETRY_DELAYS.length) {
    if (config.device) status("自动重连没成功，请到设置窗里重新连接");
    return;
  }
  const wait = RETRY_DELAYS[retries];
  retries += 1;
  status(`连接断了，${Math.round(wait / 1000)} 秒后自动重连（第 ${retries}/${RETRY_DELAYS.length} 次）`);
  later(wait, () => {
    // 期间用户手动断开（config.device 置空）或插件已停用就别再连
    if (!ctx || !config.device) return;
    void handleCmd({ action: "connect", deviceId: config.device, deviceName: config.deviceName });
  });
}

async function handleCmd(cmd) {
  try {
    switch (cmd.action) {
      case "scan": {
        await ctx.ble.startScan();
        status("正在扫描蓝牙设备…（打开手环的心率广播）");
        break;
      }
      case "connect": {
        await ctx.ble.connect(cmd.deviceId);
        config.device = cmd.deviceId;
        // 名字只留干净的真名：设置面板的选项文本带着「（-60 dBm）」后缀，别把它当设备身份存下来（G5-12）
        config.deviceName = stripSignalSuffix(cmd.deviceName);
        connected = true;
        retries = 0;
        await persist();
        await syncOverlay();
        status(`已连接 ${config.deviceName ?? cmd.deviceId}`, "ok");
        break;
      }
      case "disconnect": {
        await ctx.ble.disconnect();
        // config.device 置空即可：排在路上的自动重连回调看到没有目标设备就自己收手
        config.device = null;
        config.deviceName = null;
        connected = false;
        retries = 0;
        await persist();
        await syncOverlay(); // 断开即自动关闭悬浮窗
        status("已断开连接");
        break;
      }
      case "mode": {
        config.mode = cmd.value === "overlay" ? "overlay" : "badge";
        await persist();
        await syncOverlay();
        status(
          config.mode === "overlay"
            ? connected
              ? "波形图模式（桌面左上角）"
              : "波形图模式：连接设备后显示悬浮窗"
            : "徽标模式（宠物旁小字）",
        );
        break;
      }
      default:
        status(`未知指令: ${cmd.action}`, "error");
    }
  } catch (err) {
    status(String(err?.message ?? err), "error");
  }
}

export async function activate(context) {
  ctx = context;

  // 恢复持久化配置（只认白名单字段）
  try {
    const saved = await ctx.storage.get("config");
    if (saved && typeof saved === "object") {
      config = {
        device: typeof saved.device === "string" ? saved.device : null,
        // 老版本可能把「（-60 dBm）」一起存进了名字：读回来时统一剥掉（G5-12）
        deviceName: stripSignalSuffix(saved.deviceName),
        mode: saved.mode === "overlay" ? "overlay" : "badge",
      };
    }
  } catch (err) {
    ctx.log("读取配置失败", err);
  }

  // 事件接线（退订由宿主在停用时统一回收）
  // 这些回调可能在停用过程中被最后一次事件唤醒：ctx 已置空时一律当空操作，别抛出去
  ctx.bus.subscribe("ble:heart-rate", (e) => {
    ctx?.bus.publish(TOPIC_BPM, { bpm: e.bpm });
  });
  ctx.bus.subscribe("ble:device-found", (d) => {
    ctx?.bus.publish(TOPIC_DEVICES, d);
  });
  ctx.bus.subscribe("ble:disconnected", () => {
    connected = false;
    void syncOverlay().catch(() => {}); // 设备掉线自动关闭悬浮窗
    status("设备连接已断开", "error");
    scheduleReconnect();
  });
  ctx.bus.subscribe(TOPIC_CMD, handleCmd);

  // 恢复显示状态
  await syncOverlay();
  if (config.device) {
    // 稍等 BLE 子系统就绪后自动重连
    later(800, () => {
      void handleCmd({ action: "connect", deviceId: config.device, deviceName: config.deviceName });
    });
  } else {
    status("就绪，请选择蓝牙设备");
  }
}

export async function deactivate() {
  clearTimers();
  try {
    await ctx?.overlay.destroy();
  } catch {
    /* 忽略 */
  }
  try {
    await ctx?.ble.stopScan();
    await ctx?.ble.disconnect();
  } catch {
    /* 忽略 */
  }
  connected = false;
  retries = 0;
  ctx = null;
}
