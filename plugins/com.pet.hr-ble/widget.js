// 心率插件 widget 渲染器（能力由宿主注入 ctx.bus，topic 常量与 index.js 共用一份）
// 区域约定：badge=宠物旁小字 / overlay=左上角波形图 / settings=设置面板
// Worker 路线（ADR-0008，旧写法→契约写法的对照表见 PLUGIN_SDK.md 5.1）：这里没有
// document / window，节点一律由调用点传入的 ctx.dom 建、事件走 node.on、画布由 ctx.onCanvas 交接。
import { TOPIC_BPM, TOPIC_CMD, TOPIC_DEVICES, TOPIC_STATUS, TOPIC_WIDGET } from "./topics.js";
import { stripSignalSuffix } from "./label.js";

// 每个挂载实例（badge/overlay/settings）各自一份清理表，互不干扰
const scopes = new WeakMap();

export function mount(root, ctx) {
  const cleanups = [];
  scopes.set(root, cleanups);
  if (ctx.region === "badge") return mountBadge(root, ctx, cleanups);
  if (ctx.region === "overlay") return mountChart(root, ctx, cleanups);
  if (ctx.region === "settings") return mountSettings(root, ctx, cleanups);
}

export function unmount(root) {
  const cleanups = scopes.get(root) ?? [];
  scopes.delete(root);
  for (const off of cleanups) {
    try {
      off();
    } catch {
      /* 忽略 */
    }
  }
}

/* ---------- 宠物旁小字 ---------- */
function mountBadge(root, ctx, cleanups) {
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .hr-badge {
      display: inline-flex; align-items: baseline; gap: 3px;
      padding: 4px 10px; border-radius: 10px;
      background: rgba(10, 14, 20, 0.5);
      backdrop-filter: blur(3px);
      border: 1px solid rgba(255, 255, 255, 0.12);
    }
    .hr-badge .heart { color: #ff5d5d; font-size: 14px; }
    .hr-badge .num {
      font-size: 19px; font-weight: 700; color: #fff;
      font-variant-numeric: tabular-nums;
      text-shadow: 0 1px 3px rgba(0,0,0,.5);
    }
    .hr-badge .unit { font-size: 10px; color: rgba(255,255,255,.82); margin-left: 1px; }
  `;
  const el = ctx.dom.createElement("div");
  el.className = "hr-badge";
  const span = (dom, cls, text) => {
    const n = dom.createElement("span");
    n.className = cls;
    n.textContent = text;
    return n;
  };
  const num = span(ctx.dom, "num", "--");
  el.append(span(ctx.dom, "heart", "♥"), num, span(ctx.dom, "unit", "BPM"));
  // 空态（未连接设备）什么都不进树：老是画一个「♥ -- BPM」的框正是判据分不出
  // 「有没有内容」的现场证据（ADR-0010 落地口径第 1 条）。样式先挂，它零尺寸不干扰量外壳。
  root.append(style);

  let connected = false;
  const sync = () => {
    if (connected) root.append(el);
    else el.remove();
  };
  cleanups.push(
    ctx.bus.subscribe(TOPIC_BPM, ({ bpm }) => {
      // 广播数据不可信：只写 textContent，永不把总线 payload 拼进 innerHTML
      num.textContent = Number.isFinite(bpm) ? String(bpm) : "--";
    }),
  );
  // 连接状态由插件自己经 `${PID}:widget` 推来（连上/断开都会推一次）；挂载时宿主的回灌补齐当前值
  cleanups.push(
    ctx.bus.subscribe(TOPIC_WIDGET, (d) => {
      connected = d?.connected === true;
      // 断开就把最后一次读数清掉：否则重新连上、心跳还没来时，徽标会先把旧数字显示一遍
      if (!connected) num.textContent = "--";
      sync();
    }),
  );
}

/* ---------- 左上角透明波形图 ---------- */
function mountChart(root, ctx, cleanups) {
  const HEART_PATH =
    "M23.6 2c-3.2 0-6 1.9-7.6 4.6C14.4 3.9 11.6 2 8.4 2 3.8 2 .2 5.7.2 10.2c0 8.1 12.3 16.6 15.8 18.6 3.5-2 15.8-10.5 15.8-18.6C31.8 5.7 28.2 2 23.6 2z";

  const style = ctx.dom.createElement("style");
  style.textContent = `
    .hr-card {
      display: flex; align-items: center; gap: 14px;
      width: fit-content;
      padding: 16px 18px; border-radius: 18px;
      background: linear-gradient(140deg, rgba(22,26,36,.20), rgba(10,13,20,.13));
      border: 1px solid rgba(255,255,255,.09);
      backdrop-filter: blur(3px);
      box-shadow: 0 6px 22px rgba(0,0,0,.16), inset 0 1px 0 rgba(255,255,255,.05);
    }
    .hr-readout { display: flex; flex-direction: column; align-items: center; min-width: 86px; }
    .hr-heart {
      width: 26px; height: 26px; margin-bottom: 2px;
      filter: drop-shadow(0 0 8px rgba(255, 70, 100, .6));
      animation: hr-beat var(--beat, 1s) ease-in-out infinite;
      transform-origin: 50% 60%;
    }
    @keyframes hr-beat {
      0% { transform: scale(1); }
      12% { transform: scale(1.3); }
      24% { transform: scale(1); }
      36% { transform: scale(1.16); }
      50%, 100% { transform: scale(1); }
    }
    .hr-num {
      font-size: 42px; font-weight: 800; line-height: 1.05;
      font-family: "Segoe UI", "Segoe UI Variable", sans-serif;
      font-variant-numeric: tabular-nums;
      background: linear-gradient(180deg, #ffb3ab 0%, #ff3d5e 90%);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      filter: drop-shadow(0 1px 3px rgba(0, 0, 0, .65)) drop-shadow(0 0 14px rgba(255, 70, 90, .35));
    }
    .hr-unit {
      font-size: 10px; letter-spacing: 3px; margin-top: 3px;
      color: rgba(255, 255, 255, .8);
      text-shadow: 0 1px 3px rgba(0, 0, 0, .7);
    }
    .hr-chart-wrap { position: relative; }
    .hr-chart-wrap canvas { display: block; }
  `;

  const card = ctx.dom.createElement("div");
  card.className = "hr-card";

  // 心形（随 BPM 节奏跳动）
  const heart = ctx.dom.createElementNS("http://www.w3.org/2000/svg", "svg");
  heart.setAttribute("viewBox", "0 0 32 32");
  heart.setAttribute("class", "hr-heart");
  const heartPath = ctx.dom.createElementNS("http://www.w3.org/2000/svg", "path");
  heartPath.setAttribute("d", HEART_PATH);
  const grad = ctx.dom.createElementNS("http://www.w3.org/2000/svg", "defs");
  const gradInner = ctx.dom.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
  gradInner.setAttribute("id", "hrHeartGrad");
  gradInner.setAttribute("x1", "0");
  gradInner.setAttribute("y1", "0");
  gradInner.setAttribute("x2", "0");
  gradInner.setAttribute("y2", "1");
  const stop1 = ctx.dom.createElementNS("http://www.w3.org/2000/svg", "stop");
  stop1.setAttribute("offset", "0");
  stop1.setAttribute("stop-color", "#ff7a8c");
  const stop2 = ctx.dom.createElementNS("http://www.w3.org/2000/svg", "stop");
  stop2.setAttribute("offset", "1");
  stop2.setAttribute("stop-color", "#e4173f");
  gradInner.append(stop1, stop2);
  grad.append(gradInner);
  heart.append(grad);
  heartPath.setAttribute("fill", "url(#hrHeartGrad)");
  heart.append(heartPath);

  const readout = ctx.dom.createElement("div");
  readout.className = "hr-readout";
  const num = ctx.dom.createElement("div");
  num.className = "hr-num";
  num.textContent = "--";
  const unit = ctx.dom.createElement("div");
  unit.className = "hr-unit";
  unit.textContent = "BPM";
  readout.append(heart, num, unit);

  const wrap = ctx.dom.createElement("div");
  wrap.className = "hr-chart-wrap";
  const canvas = ctx.dom.createElement("canvas");
  const W = 200;
  const H = 118;
  const DPR = 2;
  // 位图尺寸不写在节点上（width / height 不是契约里的 property，宿主对已交接的画布也会拒收），
  // 留给 onCanvas 拿到的那块画布；节点上只留 CSS 尺寸
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  wrap.append(canvas);

  card.append(readout, wrap);
  root.append(style, card);

  // 画布控制权交接（宿主在 create 一落地就交出来，可能早于 append 到达）：回调里不碰树、
  // 也不量尺寸 —— 位图大小用挂载时就定好的 W / H / DPR 常量；交接之前 draw 是空操作
  let g = null;
  cleanups.push(
    ctx.onCanvas((id, off) => {
      if (id !== canvas.nodeId) return;
      off.width = W * DPR;
      off.height = H * DPR;
      g = off.getContext("2d");
      draw();
    }),
  );

  const history = [];
  const MAX = 60;

  function draw() {
    if (!g) return;
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    g.clearRect(0, 0, W, H);

    if (history.length < 2) {
      // 空状态：虚线基线 + 提示
      g.strokeStyle = "rgba(255,255,255,.16)";
      g.lineWidth = 1.5;
      g.setLineDash([5, 6]);
      g.beginPath();
      g.moveTo(4, H / 2);
      g.lineTo(W - 4, H / 2);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = "rgba(255,255,255,.34)";
      g.font = "12px 'Segoe UI', sans-serif";
      g.textAlign = "center";
      g.fillText("等待心率数据…", W / 2, H / 2 - 10);
      return;
    }

    const min = Math.min(...history) - 4;
    const max = Math.max(...history) + 4;
    const span = Math.max(10, max - min);
    const stepX = W / (MAX - 1);
    const px = (i) => W - (history.length - 1 - i) * stepX;
    const py = (v) => H - 12 - ((v - min) / span) * (H - 24);
    const pts = history.map((v, i) => [px(i), py(v)]);

    // 面积填充（沿平滑曲线）
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    g.lineTo(pts[pts.length - 1][0], H);
    g.lineTo(pts[0][0], H);
    g.closePath();
    const fill = g.createLinearGradient(0, 0, 0, H);
    fill.addColorStop(0, "rgba(255, 80, 105, .30)");
    fill.addColorStop(1, "rgba(255, 80, 105, .01)");
    g.fillStyle = fill;
    g.fill();

    // 平滑曲线 + 辉光
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    const line = g.createLinearGradient(0, 0, W, 0);
    line.addColorStop(0, "rgba(255, 100, 120, .2)");
    line.addColorStop(0.55, "#ff5d75");
    line.addColorStop(1, "#ff2e55");
    g.strokeStyle = line;
    g.lineWidth = 3;
    g.lineJoin = "round";
    g.lineCap = "round";
    g.shadowColor = "rgba(255, 60, 95, .75)";
    g.shadowBlur = 14;
    g.stroke();
    g.shadowBlur = 0;

    // 端点：白心 + 光环
    const [ex, ey] = pts[pts.length - 1];
    g.beginPath();
    g.arc(ex, ey, 7.5, 0, Math.PI * 2);
    g.fillStyle = "rgba(255, 255, 255, .25)";
    g.fill();
    g.beginPath();
    g.arc(ex, ey, 4, 0, Math.PI * 2);
    g.fillStyle = "#fff";
    g.shadowColor = "rgba(255,255,255,.95)";
    g.shadowBlur = 10;
    g.fill();
    g.shadowBlur = 0;
  }

  cleanups.push(
    ctx.bus.subscribe(TOPIC_BPM, ({ bpm }) => {
      // 一个 NaN 进 history 之后 min/max 全变 NaN，波形要再攒 60 个有效点才自愈
      if (!Number.isFinite(bpm)) return;
      num.textContent = String(bpm);
      // 心形图标按真实心率节奏跳动：契约的 style 是闭集、写不了自定义属性，
      // 直接把 animation 写到心形节点上（内联样式覆盖样式表里 var(--beat, 1s) 的默认值）
      heart.style.animation = `hr-beat ${(60 / Math.max(30, bpm)).toFixed(2)}s ease-in-out infinite`;
      history.push(bpm);
      if (history.length > MAX) history.shift();
      draw();
    }),
  );
  // 断开要跟界面一致：波形与读数退回空态，别把最后一段活曲线留在「已断开」的窗上
  cleanups.push(
    ctx.bus.subscribe(TOPIC_WIDGET, (d) => {
      if (d?.connected === true) return;
      history.length = 0;
      num.textContent = "--";
      draw();
    }),
  );
  draw();
}

/* ---------- 设置面板（设置窗内） ---------- */
function mountSettings(root, ctx, cleanups) {
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .hr-panel { font-size: 13px; color: #2b2f36; display: flex; flex-direction: column; gap: 10px; }
    .hr-panel label { display: flex; align-items: center; gap: 6px; }
    .hr-panel select { flex: 1; font-size: 12px; padding: 3px 6px; }
    .hr-panel button {
      font-size: 12px; padding: 4px 12px; border-radius: 5px;
      border: 1px solid #d0d5dd; background: #fff; cursor: pointer;
    }
    .hr-panel button:hover { background: #f2f4f7; }
    .hr-panel .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .hr-panel .status { font-size: 12px; color: #667085; min-height: 16px; }
    .hr-panel .status.ok { color: #2f9e63; }
    .hr-panel .status.error { color: #d92d20; }
    .hr-panel .radios { display: flex; gap: 14px; }
    .hr-panel .radios label { gap: 4px; }
    .hr-panel .sec { font-size: 12px; color: #98a2b3; margin-bottom: -4px; }
  `;

  const panel = ctx.dom.createElement("div");
  panel.className = "hr-panel";
  // 原 innerHTML 模板逐节点拆开（契约没有 html op）：15 个元素 + 9 处 textContent。
  // 建节点时就把引用存住 —— Worker 里没有 querySelector，$ 那套查询整个不在了
  const secDevices = ctx.dom.createElement("div");
  secDevices.className = "sec";
  secDevices.textContent = "蓝牙设备";

  const devicesRow = ctx.dom.createElement("div");
  devicesRow.className = "row";
  const devicesSel = ctx.dom.createElement("select");
  devicesSel.className = "devices";
  const placeholder = ctx.dom.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "— 点击「扫描」查找设备 —";
  devicesSel.append(placeholder);
  devicesRow.append(devicesSel);
  // 设备项的引用自己存着（去重与「按值找名」都不再查询 DOM）
  const deviceOptions = [placeholder];
  /** 设备 id → 干净设备名（不含 RSSI 后缀）：连接时发真名，不发选项文本（G5-12） */
  const deviceNames = new Map();

  const actionsRow = ctx.dom.createElement("div");
  actionsRow.className = "row";
  const scanBtn = ctx.dom.createElement("button");
  scanBtn.className = "scan";
  scanBtn.textContent = "扫描";
  const connectBtn = ctx.dom.createElement("button");
  connectBtn.className = "connect";
  connectBtn.textContent = "连接";
  const disconnectBtn = ctx.dom.createElement("button");
  disconnectBtn.className = "disconnect";
  disconnectBtn.textContent = "断开";
  actionsRow.append(scanBtn, connectBtn, disconnectBtn);

  const secMode = ctx.dom.createElement("div");
  secMode.className = "sec";
  secMode.textContent = "显示方式";

  const radiosBox = ctx.dom.createElement("div");
  radiosBox.className = "radios";
  // 这组 radio 原来靠 name 分组再 querySelectorAll 找回：改成建的时候就把引用 push 进数组，
  // 切模式与回显时遍历它写 checked（name 属性仍保留，宿主侧就是同一组单选框）
  const modeRadios = [];
  const makeRadio = (dom, value, labelText, checked) => {
    const input = dom.createElement("input");
    input.type = "radio";
    input.setAttribute("name", "hr-mode");
    input.value = value;
    input.checked = checked;
    const label = dom.createElement("label");
    // 文字放进一个 span，而不是写 `label.textContent`：`text` 是一次整段赋值，
    // 写在 append 之后会把 radio 冲掉，写在之前又把「圆点在左、文字在右」翻成反向。
    // 建 span 与待办 / agent 桥那两个插件同式，视觉次序与原模板一致。
    const text = dom.createElement("span");
    text.textContent = labelText;
    label.append(input, text);
    modeRadios.push(input);
    radiosBox.append(label);
  };
  makeRadio(ctx.dom, "badge", "宠物旁小字", true);
  makeRadio(ctx.dom, "overlay", "桌面左上角波形图", false);

  const statusEl = ctx.dom.createElement("div");
  statusEl.className = "status";
  statusEl.textContent = "就绪";

  panel.append(secDevices, devicesRow, actionsRow, secMode, radiosBox, statusEl);
  root.append(style, panel);

  function setStatus(text, level = "info") {
    statusEl.textContent = text;
    statusEl.className = "status" + (level === "info" ? "" : ` ${level}`);
  }
  /** 面板上当前是否正显示「已连接 …」：断开推送来时要把它换掉，别留在旧状态 */
  let shownConnected = false;

  // Worker 里读不到真元素：select 的当前值靠宿主在 change 快照里回推，这里记一份给连接按钮用
  let selectedDeviceId = "";
  /** 用户刚点过、还等着推送追上的那个模式单选框（编辑锁，N 类问题同 Bug4） */
  let modeLock = null;
  scanBtn.on("click", () => ctx.bus.publish(TOPIC_CMD, { action: "scan" }));
  connectBtn.on("click", () => {
    if (!selectedDeviceId) {
      setStatus("请先扫描并选择设备", "error");
      return;
    }
    // 设备名取「扫描时留下的干净名字」，不取选项文本（那里带着「（-60 dBm）」后缀，G5-12）
    const name = deviceNames.get(selectedDeviceId) ?? null;
    ctx.bus.publish(TOPIC_CMD, { action: "connect", deviceId: selectedDeviceId, deviceName: name });
  });
  disconnectBtn.on("click", () => ctx.bus.publish(TOPIC_CMD, { action: "disconnect" }));
  devicesSel.on("change", () => {
    selectedDeviceId = devicesSel.value;
  });
  for (const radio of modeRadios) {
    radio.on("change", () => {
      // 只认「被选中」的那一次，并把锁记下：用户刚点的选项不许被在途的旧快照冲回去
      if (!radio.checked) return;
      modeLock = radio;
      ctx.bus.publish(TOPIC_CMD, { action: "mode", value: radio.value });
    });
  }

  cleanups.push(
    ctx.bus.subscribe(TOPIC_DEVICES, (d) => {
      // 设备 id 来自广播：只做值比对，文本一律走 textContent
      if (deviceOptions.some((o) => o.value === d.id)) return;
      const cleanName = stripSignalSuffix(d.name);
      // 名字单独记一份干净的：选项文本为了好挑设备带着 RSSI，但连接时不能用它当名字（G5-12）
      deviceNames.set(d.id, cleanName ?? "未命名设备");
      const opt = ctx.dom.createElement("option");
      opt.value = d.id;
      opt.textContent = `${cleanName ?? "未命名设备"}${d.rssi != null ? `（${d.rssi} dBm）` : ""}`;
      deviceOptions.push(opt);
      devicesSel.append(opt);
    }),
  );
  cleanups.push(
    ctx.bus.subscribe(TOPIC_STATUS, (s) => setStatus(s.text, s.level ?? "info")),
  );
  // 回显当前配置：面板重新挂载时宿主会把最近一份 `*:widget` 数据回灌过来，
  // 不接这份数据的话单选框永远显示模板里的默认值，用户一点就把另一项写回默认
  cleanups.push(
    ctx.bus.subscribe(TOPIC_WIDGET, (d) => {
      if (!d || typeof d !== "object") return;
      const want = d.mode === "overlay" ? "overlay" : "badge";
      // 编辑锁：用户刚点过某个模式，等推送追上那一项才放锁；在途旧帧不许把点过的选项冲回去
      if (modeLock) {
        if (modeLock.checked && modeLock.value === want) modeLock = null;
      } else {
        for (const radio of modeRadios) {
          if (radio.checked !== (radio.value === want)) radio.checked = radio.value === want;
        }
      }
      // 连接状态文案跟着推送走：断开时别把「已连接 X」留在面板上
      if (d.connected) {
        shownConnected = true;
        setStatus(`已连接 ${d.deviceName ?? "设备"}`, "ok");
      } else if (shownConnected) {
        shownConnected = false;
        setStatus("设备已断开", "error");
      }
    }),
  );
}
