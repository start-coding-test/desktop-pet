// 极简 WebView2 CDP 客户端与断言收集器。零依赖：Node 24 自带 fetch 与全局 WebSocket。
// 用途见 tests/e2e/verify-isolation.mjs 顶部说明。
import { execFileSync } from "node:child_process";

export async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await res.json()).filter((t) => t.type === "page");
}

/** 等到有匹配的 page target 出现（应用启动/窗口创建是异步的） */
export async function waitForPage(port, match, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const hit = (await listPages(port)).find(match);
      if (hit) return hit;
    } catch {
      /* CDP 端口还没起来 */
    }
    if (Date.now() > until) throw new Error(`等不到匹配的 target（port=${port}）`);
    await new Promise((r) => setTimeout(r, 1200));
  }
}

export async function attach(port, match, timeoutMs = 90_000) {
  const target = await waitForPage(port, match, timeoutMs);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`CDP websocket 连接失败: ${target.url}`));
  });

  let seq = 0;
  const pending = new Map();
  const onceWatchers = [];
  const noise = [];
  /**
   * 导航过渡期的 Tauri 告警单独记账。页面被换掉时，旧文档在飞的 IPC 回调会带着
   * 「Couldn't find callback id」/「IPC custom protocol failed」迟到，落到新文档的
   * console 里 —— 这两条文案本身就是 Tauri 对「导航打断了 IPC」的自述，且它会自动
   * 回退到 postMessage 继续工作，与被测行为无关；插件越多、轮询越密越容易撞上。
   * 不按时间窗筛（迟到的可能几十秒后才落），只认这两条签名，其余一律进 noise 照常断言。
   * 每套回归都会把 transitionNoise 的条数打出来，不是静默吞掉。
   */
  const transitionNoise = [];
  const TRANSITION_SIGNATURE = /Couldn't find callback id|IPC custom protocol failed/;
  const pushNoise = (text) => {
    if (TRANSITION_SIGNATURE.test(text)) transitionNoise.push(text);
    else noise.push(text);
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    for (let i = onceWatchers.length - 1; i >= 0; i--) {
      if (onceWatchers[i].method === msg.method) {
        onceWatchers[i].done();
        onceWatchers.splice(i, 1);
      }
    }
    if (msg.method === "Log.entryAdded") {
      const { text, level, url } = msg.params.entry;
      // 缺 favicon 与隔离无关，但它会淹没真消息；其余网络错误（含插件文件 404）保留
      const isFavicon = typeof url === "string" && url.endsWith("/favicon.ico");
      const where = url ? ` @ ${url}` : "";
      if (/Content Security|Refused to|do not load/i.test(text)) pushNoise(`CSP: ${text.slice(0, 200)}${where}`);
      else if (level === "error" && !isFavicon) pushNoise(`日志: ${text.slice(0, 160)}${where}`);
    }
    // 宿主的 reportError 只写 console.error；不采集就等于失败原因不可见
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      const text = (msg.params.args ?? [])
        .map((a) => a?.description ?? a?.value ?? a?.type)
        .join(" ")
        .slice(0, 300);
      const at = msg.params.stackTrace?.callFrames?.[0]?.url;
      pushNoise(`console.${msg.params.type}: ${text}${at ? ` @ ${at}:${msg.params.stackTrace.callFrames[0].lineNumber}` : ""}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      pushNoise(`异常: ${(d.exception?.description ?? d.text ?? "?").split("\n")[0].slice(0, 200)}`);
    }
  };

  const send = (method, params = {}, timeoutMs = 20_000) =>
    new Promise((res, rej) => {
      const id = ++seq;
      // 必须有超时：调试端点一旦失去响应（窗口反复建销、客户端堆积），
      // 没有超时的话整条断言链会永久挂住，看起来像「构建/测试偶发失败」，
      // 实际上没有任何输出线索。
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`CDP ${method} 超时 ${timeoutMs}ms（调试端点可能已失去响应，重启 dev 实例再试）`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        res(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Log.enable");

  return {
    url: target.url,
    send,
    noise,
    transitionNoise,
    /** 等一次事件（用于确认导航真的完成，而不是靠 sleep 赌） */
    once(method, timeoutMs = 30_000) {
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`等 ${method} 超时`)), timeoutMs);
        onceWatchers.push({ method, done: () => { clearTimeout(timer); res(); } });
      });
    },
    /**
     * 在页面里求值。注意：CDP 发起的代码不受 CSP 约束，
     * 不要用这里的 eval/import 结果来判断 CSP 是否生效 —— 那必须看页面自身代码的副作用。
     * `timeoutMs` 默认 20s，够绝大多数 IPC；只有真要等外网下载的调用才许调大
     * （宿主侧 skins 安装自己就是 4 段 × 20s 读超时，客户端先超时就是假红）。
     */
    async ev(expression, timeoutMs = 20_000) {
      const call = (ms) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, ms);
      let r;
      try {
        r = await call(timeoutMs);
      } catch (err) {
        if (!String(err).includes("CDP Runtime.evaluate 超时")) throw err;
        // 偶发「调试端点 20s 无响应」的取证点：区分「采样抖动」与「渲染主线程真被卡死」。
        // 判据与做法（T37 复盘）：先快照宿主进程 CPU/WS，再用 3 倍超时重发同一表达式；
        // 3 倍超时也回不来才按主线程卡死处理，让红带证据，而不是一句“环境中断”。
        const snap = processSnapshot();
        console.log(`  · CDP 偶发超时取证：首次 ${timeoutMs}ms 无响应；宿主进程 ${snap}`);
        const t0 = Date.now();
        try {
          r = await call(timeoutMs * 3);
          console.log(`  · 重发 Runtime.evaluate 于 ${Date.now() - t0}ms 返回 → 判采样抖动，不是主线程卡死`);
        } catch (again) {
          // 同一会话 3 倍超时都不回：再开一条新 CDP 连接验一次。
          // 新连接能算 ⇒ 旧会话卡死（WebView2 会话级问题，页面其实活着）；新连接也不算 ⇒ 主线程真没响应。
          try {
            const value = await freshEvaluate(target.webSocketDebuggerUrl, expression);
            console.log("  · 新 CDP 连接求值成功 → 旧会话卡死（会话级），已用新连接续跑");
            return value;
          } catch (freshErr) {
            console.log(`  · 新连接也超时：${freshErr.message} → 渲染主线程真没响应（不是采样抖动）`);
            throw again;
          }
        }
      }
      const err = r.result?.exceptionDetails;
      if (err) {
        throw new Error((err.exception?.description ?? err.text ?? JSON.stringify(err)).split("\n").slice(0, 3).join(" | "));
      }
      return r.result?.result?.value;
    },
    close: () => ws.close(),
  };
}
/** 偶发 CDP 超时时的一行宿主进程快照（取不到就返回 unknown，绝不让取证本身把套件搞挂）。 */
function processSnapshot() {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-Process desktop-pet -ErrorAction SilentlyContinue | Select-Object -First 1 Id,@{n='WS_MB';e={[int]($_.WS/1MB)}},CPU,@{n='Threads';e={$_.Threads.Count}} | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 5_000 },
    ).trim();
    return out || "无 desktop-pet 进程";
  } catch {
    return "进程快照读取失败";
  }
}


/** 新开一条 CDP 连接做一次求值：只在旧会话超时时用于区分「会话卡死」与「主线程卡死」。 */
async function freshEvaluate(targetUrl, expression, timeoutMs = 20_000) {
  const fresh = new WebSocket(targetUrl);
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("新连接握手超时")), 5_000);
      fresh.addEventListener("open", () => {
        clearTimeout(t);
        res();
      });
      fresh.addEventListener("error", () => {
        clearTimeout(t);
        rej(new Error("新连接握手失败"));
      });
    });
    return await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`新连接 Runtime.evaluate 超时 ${timeoutMs}ms`)), timeoutMs);
      fresh.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== 7) return;
        clearTimeout(t);
        const err = msg.result?.exceptionDetails;
        if (err) rej(new Error((err.exception?.description ?? err.text ?? "?").split("\n")[0]));
        else res(msg.result?.result?.value);
      });
      fresh.send(
        JSON.stringify({ id: 7, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }),
      );
    });
  } finally {
    try {
      fresh.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * 在 GitHub Actions 里把套件汇总行同时发成一条工作流注解（`::notice` / `::error`）。
 * 为什么：job 日志对未登录的读者是 403，而 check-run 注解经公开 API 可读 ——
 * 评审方（云端 PM）靠它核对「每个套件到底几过几挂」，不必再靠开发者抄汇总行。
 * 只在 GITHUB_ACTIONS=true 时输出，本地跑与 verify:release 的终端输出不变。
 * 注意：注解参数里的 `%`、换行必须转义，否则会被截断或吞掉。
 */
function announceSummary(title, pass, fail, failures) {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  // 失败项带「期望/实得」原文（每条截 240 字），评审方经公开 API 就能读到 FAIL 断言，不必再向执行者要日志
  const cut = (s) => (String(s).length > 240 ? String(s).slice(0, 240) + "…" : String(s));
  const msg = `${title} | ${pass} passed, ${fail} failed` + (failures.length ? ` | 失败项: ${failures.slice(0, 8).map(cut).join(" ; ")}` : "");
  console.log(`::${fail ? "error" : "notice"} title=E2E 汇总::${esc(msg)}`);
}

/**
 * 套件中途抛错（没走到 summary）时也留一条注解：套件标题 + 错误首段。
 * 只在 GITHUB_ACTIONS=true 时挂；不改变进程退出行为，原异常照常抛出。
 */
function announceCrash(title, err) {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  try {
    const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    const text = String(err?.stack ?? err?.message ?? err).slice(0, 1500);
    console.log(`::error title=E2E 崩溃::${esc(`${title} | 套件未跑完 | ${text}`)}`);
  } catch {
    /* 注解失败不影响原异常 */
  }
}

/** 断言收集器：全部跑完再统一报告，非零退出码反映给 CI/npm */
export function createReport(title) {
  let pass = 0;
  let fail = 0;
  const failures = [];
  console.log(`\n=== ${title} ===`);
  let crashHooked = false;
  const hookCrash = () => {
    if (crashHooked || process.env.GITHUB_ACTIONS !== "true") return;
    crashHooked = true;
    // Monitor 事件只观察、不接管：原异常的栈输出与退出码保持不变（unhandledRejection 也会转成它）
    process.once("uncaughtExceptionMonitor", (err) => announceCrash(title, err));
  };
  hookCrash();
  return {
    group: (name) => console.log(`\n-- ${name}`),
    check(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : ` — 期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`}`);
      if (ok) pass++;
      else {
        fail++;
        failures.push(`${label} — 期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`);
      }
    },
    info: (label, value) => console.log(`  · ${label}: ${value}`),
    summary() {
      console.log(`\n${pass} passed, ${fail} failed`);
      if (failures.length) console.log("失败项：\n  " + failures.join("\n  "));
      announceSummary(title, pass, fail, failures);
      return fail;
    },
  };
}

/** 直打宿主命令：绕过 JS 能力桥，验的是 Rust 侧规则本身 */
/**
 * 从页面 realm 发一次真实 invoke。
 * `e` 保持「人读的文案」这一条契约：未迁移的命令 reject 裸字符串，已迁移的 reject `{code,message}`
 * （ADR-0007），两种形状都取文案原文，所以按文本判的既有断言不必跟着迁移改。
 * `code` 是这次新增的一列：已迁移命令给出码表里的码，未迁移的是 null（不是 "legacy" ——
 * 那是前端规整之后的事，脚本要看的就是「宿主到底发没发码」）。
 */
export function hostInvoke(c) {
  return async (cmd, args = {}, timeoutMs) =>
    c.ev(
      `(async () => { try { const v = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}); return { ok: true, v, code: null }; } catch (e) { return { ok: false, e: typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)), code: (e && typeof e === 'object' && typeof e.code === 'string') ? e.code : null }; } })()`,
      timeoutMs,
    );
}

/** 轮询页面表达式直到为真 */
export async function waitUntil(c, expression, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await c.ev(expression).catch(() => false)) return true;
    await new Promise((res) => setTimeout(res, 800));
  }
  return false;
}

/**
 * 「只认设置窗」的命令就从设置窗发起：撤销授权、看授权表、装形象这一类门禁
 * 按窗口 label 判定，从宠物窗调用必然被拒 —— 那正是门禁本身，不是脚本写错了。
 * 由宠物窗自己把设置窗唤出来（settings_show 只认宠物窗），跟用户点托盘是同一条路。
 */
export async function openSettingsInvoker(port, petClient, timeoutMs = 25_000) {
  const invoke = hostInvoke(petClient);
  await invoke("settings_show");
  // dev 是 localhost:1420，打包版是 tauri.localhost —— 两边都要认（verify:release 用的就是后者）
  const target = await waitForPage(
    port,
    (t) => /(localhost:1420|tauri\.localhost)\/src\/settings\.html/.test(t.url),
    timeoutMs,
  );
  const client = await attach(port, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 15_000);
  await new Promise((res) => setTimeout(res, 1200));
  return {
    client,
    invoke: hostInvoke(client),
    async close() {
      await hostInvoke(client)("plugin:window|close").catch(() => undefined);
      client.close();
    },
  };
}

/**
 * 插件启停清单（C1 起唯一事实来源在宿主磁盘上）。
 * 读：任何窗口都行；写：只认设置窗（gate::settings），所以写入必须有 settings 那一侧的 invoker。
 * 回归脚本一律走这两个口 —— localStorage 里那个键现在只是「迁移前的旧副本」，
 * 碰它等于测不到真正的那份状态。
 */
export async function readEnabledIds(invoke) {
  const r = await invoke("plugin_enabled_list");
  return r.ok && Array.isArray(r.v) ? r.v : [];
}

export async function writeEnabledIds(settingsInvoke, ids) {
  const r = await settingsInvoke("plugin_enabled_set", { ids });
  if (!r.ok) throw new Error(`写启停清单失败: ${r.e}`);
  return r.v;
}

/**
 * 写完清单后让宠物窗的运行时跟上（脚本从设置窗写，宠物窗不会收到 host:plugin-toggled）。
 * reconcile 会自己向宿主重取清单，所以这一步不需要把 ids 再传一遍。
 */
export async function reconcilePetWindow(petClient) {
  return petClient.ev(`(async () => {
    const rt = await import('/src/runtime/plugin-runtime.ts');
    const list = await window.__TAURI_INTERNALS__.invoke('plugins_list');
    await rt.reconcile(list);
    return (await rt.loadEnabled()).join(',');
  })()`);
}

/**
 * 重载并确认文档真的加载完。
 * 导航刚发生时 CDP 的隐式上下文可能仍指向旧文档，直接轮询会一路拿到旧结果（实测偶发假失败）。
 * 旧文档在飞的 IPC 回调会在之后迟到成两条 Tauri 告警，那属于导航产物，
 * 由 attach 里的 pushNoise 归到 transitionNoise（各脚本会把它条数打出来）。
 */
export async function reloadAndWait(c) {
  await c.send("Page.enable");
  const loaded = c.once("Page.loadEventFired");
  await c.send("Page.reload", { ignoreCache: true });
  await loaded;
  // load 之后宿主还要异步跑 reconcile 与插件激活，交给调用方的 waitUntil
  await new Promise((res) => setTimeout(res, 600));
}
