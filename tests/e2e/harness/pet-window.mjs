// tests/e2e/harness/pet-window.mjs —— 从 Node 侧驱动宠物窗的 Win32 小工具（verify-pet-drag 用）。
//
// 为什么搬窗要绕到桌面侧：宠物窗的 capability（src-tauri/capabilities/pet.json）没给
// core:window:allow-set-position，页面里调 plugin:window|set_position 会被拒；而 verify 要的
// 正是「窗口真的动了」—— 外部 SetWindowPos 产生真 WM_MOVE → tauri://move →
// getCurrentWindow().onMoved，和鼠标拖拽撞的是同一条链路（判定/去抖/状态机都是被测代码）。
//
// 依赖：pwsh.exe（PowerShell 7）。脚本本身只用 Add-Type + user32，不装任何模块。
// 所有函数读的是 pet-window.ps1 打印的单行 JSON；失败抛 Error（调用方转成 r.check 红）。

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PS1 = fileURLToPath(new URL("./pet-window.ps1", import.meta.url));
const PS = process.platform === "win32" ? "pwsh.exe" : "pwsh";

/** @type {Set<import("node:child_process").ChildProcess>} */
const children = new Set();

function parseLastLine(stdout) {
  const line = String(stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function fail(res, line) {
  const stderr = String(res.stderr ?? "").trim();
  if (res.error) {
    throw new Error(
      `起不了 pwsh.exe（本套件需要 PowerShell 7 在 PATH 上）：${res.error.message}`,
    );
  }
  if (res.status === 3) {
    throw new Error(
      "找不到宠物窗（class=\"Tauri Window\" / title=\"DesktopPet\"）。先确认 `npm run dev:debug` 在跑、宠物窗没被隐藏。",
    );
  }
  throw new Error(
    `pet-window.ps1 失败（退出码 ${res.status}）：${line || stderr || "(无输出)"}`,
  );
}

/** 同步调用一个 action（info/rect/cursor/wait-transparent）。 */
function call(args, timeoutMs = 30_000) {
  const res = spawnSync(
    PS,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, ...args],
    { encoding: "utf8", timeout: timeoutMs },
  );
  const parsed = parseLastLine(res.stdout);
  if (res.error || res.status !== 0) fail(res, parsed ? JSON.stringify(parsed) : "");
  if (!parsed || parsed.ok !== true) {
    throw new Error(`pet-window.ps1 输出异常：${JSON.stringify(parsed)}`);
  }
  return parsed;
}

/** 读宠物窗：{ok,hwnd,pid,class,rect:{left,top,width,height},exStyle,transparent,cursor:{x,y}} */
export function readPetWindow() {
  return call(["-Action", "info"]);
}

/** 把系统光标放到屏幕绝对坐标（物理像素）。 */
export function setCursor(x, y) {
  return call(["-Action", "cursor", "-X", String(Math.round(x)), "-Y", String(Math.round(y))]);
}

/** 等点击穿透位变成期望值；返回 {matched, elapsedMs, transparent, exStyle}。 */
export function waitTransparent(expectTransparent, timeoutMs = 4000) {
  return call(
    [
      "-Action",
      "wait-transparent",
      "-ExpectTransparent",
      expectTransparent ? "1" : "0",
      "-TimeoutMs",
      String(timeoutMs),
    ],
    timeoutMs + 15_000,
  );
}

/**
 * 异步搬窗（每个 step 搬 (dx,dy)，步间等 delayMs），并等它退干净。
 * 用异步 spawn 是为了让 CDP 在该子进程跑的时候还能继续读页面（判定是页面侧实时发生的）。
 * 返回 {ok, steps, from, to}。
 */
export function movePetWindow({ dx = 0, dy = 0, steps = 1, delayMs = 0 }) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    PS1,
    "-Action",
    "move",
    "-Dx",
    String(Math.round(dx)),
    "-Dy",
    String(Math.round(dy)),
    "-Steps",
    String(steps),
    "-DelayMs",
    String(delayMs),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(PS, args, { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      children.delete(child);
      reject(
        new Error(`起不了 pwsh.exe（本套件需要 PowerShell 7 在 PATH 上）：${err.message}`),
      );
    });
    child.on("close", (code) => {
      children.delete(child);
      const parsed = parseLastLine(stdout);
      if (code !== 0) {
        return reject(
          new Error(
            `搬窗失败（exit ${code}）：${parsed ? JSON.stringify(parsed) : stderr.trim() || "(无输出)"}`,
          ),
        );
      }
      if (!parsed || parsed.ok !== true) {
        return reject(new Error(`搬窗输出异常：${JSON.stringify(parsed)}`));
      }
      resolve(parsed);
    });
  });
}

/**
 * 常驻搬窗进程：一次 pwsh 启动（~390ms）之后靠 stdin 连发 `move`，每次往返毫秒级。
 * verify-pet-drag 需要「拖动期间持续位移」把 G6-02 的 250ms 静默兜底喂住 —— 每次新起
 * 进程搬一下时启动比静默窗口还长，拖动态会在两次搬窗之间被收掉。
 * 返回 { ready, move, close }：ready 在 ps1 打出 serve 就绪行后 resolve。
 */
export function startMover() {
  const child = spawn(
    PS,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, "-Action", "serve"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.add(child);
  let buf = "";
  let stderr = "";
  const waiters = [];
  let readyResolve = () => {};
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  const settle = (res) => {
    const waiter = waiters.shift();
    if (waiter) waiter(res);
  };
  child.stdout.on("data", (d) => {
    buf += d;
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
      if (!line) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.serve) {
        readyResolve(parsed);
        continue;
      }
      settle(parsed);
    }
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  child.on("error", (err) => {
    children.delete(child);
    readyResolve({ ok: false, error: err.message });
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter) waiter({ ok: false, error: err.message });
    }
  });
  child.on("close", (code) => {
    children.delete(child);
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter) waiter({ ok: false, error: `常驻搬窗进程退出（code ${code}）：${stderr.trim()}` });
    }
  });
  return {
    ready,
    move({ dx = 0, dy = 0, steps = 1, delayMs = 0 }) {
      return new Promise((resolve, reject) => {
        waiters.push((res) => {
          if (res && res.ok === true) resolve(res);
          else reject(new Error(`常驻搬窗失败：${JSON.stringify(res)}`));
        });
        child.stdin.write(`move ${Math.round(dx)} ${Math.round(dy)} ${steps} ${delayMs}\n`);
      });
    },
    close() {
      try {
        child.stdin.write("quit\n");
      } catch {
        /* 已退出 */
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
      }, 300);
    },
  };
}

/** 兜底：套件异常退出时别把搬窗子进程留在后台。 */
export function killAll() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* 已经退出就算了 */
    }
  }
  children.clear();
}
