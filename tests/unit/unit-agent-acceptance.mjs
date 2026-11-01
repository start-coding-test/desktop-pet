// 验收附录1（N3 / N4 / N5）的行为单测：设置页 Agent 面板「问一次再动手」、自检五态、
// 桥提示，以及 `agent:hooks` 通道的 confirm 透传。
//
// 为什么测这里而不是只测纯函数：报告里的三条缺陷都是**接线**问题 —— 前缀判断写在了
// 切换里却没写进安装、自检结论少认两个状态、bridgeHint 只回到返回值没人显示。
// 这些只有「真的挂一次面板、点一下按钮」才验得出来。
//
// 全部离线：DOM 用最小替身（只实现 widget 实际用到的那几种动作），
// 宿主侧走 tests/unit/tauri-stub.mjs 的 invoke 记录。
import { check, eq, group } from "./harness.mjs";
import { calls as tauriCalls, resetStub, setReply } from "./tauri-stub.mjs";

const widget = await import(new URL("../../plugins/com.pet.agent-bridge/widget.js", import.meta.url));
const caps = await import(new URL("../../src/runtime/plugin-capabilities.ts", import.meta.url));
const { createAgentHooksApi, invalidatePermissions } = await import(
  new URL("../../src/runtime/bridge.ts", import.meta.url)
);

/** widget 实际用到的 DOM 动作：createElement / className / dataset / textContent / on / append / replaceChildren */
class FakeEl {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.dataset = {};
    this.handlers = new Map();
    this.classList = {
      toggle: (name, force) => {
        const tokens = new Set(String(this.className).split(" ").filter(Boolean));
        const on = force === undefined ? !tokens.has(name) : Boolean(force);
        if (on) tokens.add(name);
        else tokens.delete(name);
        this.className = [...tokens].join(" ");
      },
      contains: (name) => String(this.className).split(" ").includes(name),
    };
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  on(event, handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  fire(event) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler();
  }
}

/** 面板里按 class 找一个节点（含自身） */
const findClass = (node, cls) => {
  if (!node || typeof node === "string") return null;
  if (String(node.className ?? "").split(" ").includes(cls)) return node;
  for (const child of node.children ?? []) {
    const hit = findClass(child, cls);
    if (hit) return hit;
  }
  return null;
};

const mountPanel = (agentHooks) => {
  const root = new FakeEl("div");
  widget.mount(root, {
    region: "settings",
    dom: { createElement: (tag) => new FakeEl(tag) },
    bus: { publish() {}, subscribe: () => () => {} },
    host: { agentHooks },
  });
  return root;
};

/** 让 run()/refresh() 的 Promise 链跑完（setImmediate 会跨过微任务与一次 I/O 轮） */
const settle = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const snapshot = (over = {}) => ({
  agent: "qoder",
  displayName: "Qoder",
  mode: "hook",
  installed: false,
  managed: 0,
  expectedPerFile: 7,
  files: [{ path: "/home/u/.qoder/settings.json", managed: 0 }],
  options: [
    { id: "qoder", displayName: "Qoder", wired: true },
    { id: "zcode", displayName: "ZCode", wired: true },
    { id: "dsh", displayName: "DSH", wired: true },
  ],
  ...over,
});

const OK_CHECK = { status: "ok", detail: "盘上核对通过（每文件 7 条）" };

/* ==================== N3：安装也要走确认（ZCode 的 hooks 总开关） ==================== */
group("N3：需要确认的安装先问用户，再带 confirm:true 重试");

{
  const attempts = [];
  let installed = false;
  let firstTry = true;
  const root = mountPanel({
    status: async () =>
      snapshot({
        agent: "zcode",
        displayName: "ZCode",
        files: [{ path: "/home/u/.zcode/hooks.json", managed: installed ? 7 : 0 }],
        installed,
        managed: installed ? 7 : 0,
      }),
    install: async (confirm) => {
      attempts.push(Boolean(confirm));
      if (!confirm && firstTry) {
        firstTry = false;
        throw new Error("[need-confirm] ZCode 的 hooks 总开关当前是关的，装条目会顺带打开它");
      }
      installed = true;
      return { selfCheck: OK_CHECK };
    },
    uninstall: async () => ({}),
    set: async () => ({}),
  });
  await settle();

  const st = findClass(root, "hk-status");
  check("挂载即拉一次状态", st.textContent.includes("未安装"));

  findClass(root, "hk-install").fire("click");
  await settle();
  eq("第一趟不带确认", attempts[0], false);
  check(
    "面板说人话：显示宿主那句说明，而不是 [need-confirm] 机器前缀",
    !st.textContent.includes("[need-confirm]") && st.textContent.includes("hooks 总开关"),
  );
  eq("进入等待确认态（不再显示成失败）", st.dataset.state, "consent");
  const slot = findClass(root, "hk-consent-slot");
  check("确认条出现", slot.classList.contains("on"));
  eq("确认条文案仍是「仍要打开」（e2e 依赖这个词）", findClass(root, "hk-consent").textContent, "仍要打开");

  findClass(root, "hk-consent").fire("click");
  await settle();
  eq("点「仍要打开」用 confirm:true 重试同一件事", attempts[1], true);
  check(
    "重试后真的装上了（status 回显已安装 7 条）",
    st.textContent.includes("已安装（ZCode）") && st.textContent.includes("共 7 条"),
    st.textContent,
  );
  check("装上后确认条收起来", !slot.classList.contains("on"));
}

/* ==================== N3 + N5：切换的确认重试与 bridgeHint ==================== */
group("N3/N5：切换失败问一次；桥仍挂着的提示留在面板上");

{
  const attempts = [];
  const bridgeHint =
    "桥插件仍挂在 DSH 的 2 个 profile 里：宿主只摘掉四家 Agent 的 hook，桥要到 DSH 里用 plugin_manager 卸载（宿主不代卸）。";
  const root = mountPanel({
    status: async () => snapshot(),
    install: async () => ({}),
    uninstall: async () => ({}),
    set: async (id, confirm) => {
      attempts.push([id, Boolean(confirm)]);
      if (!confirm) throw new Error("[need-confirm] 拨开 DSH 的钩子入口会顺带启用 3 条事件");
      return {
        hint: "重启 DSH 后生效",
        bridgeHint,
        selfCheck: { status: "unverified", detail: "该客户端没有可查日志" },
      };
    },
  });
  await settle();

  const picker = findClass(root, "hk-agents");
  const dshBtn = picker.children.find((node) => node.dataset.agent === "dsh");
  check("五选一清单来自宿主的 options（含 DSH）", Boolean(dshBtn));
  dshBtn.fire("click");
  await settle();

  const st = findClass(root, "hk-status");
  check(
    "第一趟被拒时显示宿主说明 + 「当前选中未变」",
    st.textContent.includes("顺带启用 3 条事件") && st.textContent.includes("当前选中未变"),
  );
  eq("第一趟不带确认", attempts[0][1], false);

  findClass(root, "hk-consent").fire("click");
  await settle();
  eq("确认后带 confirm:true 重试", attempts[1][1], true);
  check("N5：bridgeHint 显示在面板上（不只是一次性返回值）", st.textContent.includes("仍挂在 DSH 的 2 个 profile 里"));
  check(
    "N4：unverified 显示成「自检未复核」，不被说成通过",
    st.textContent.includes("自检未复核") && !st.textContent.includes("自检通过"),
  );
}

/* ==================== N4：自检五态的文案与颜色 ==================== */
group("N4：自检五态都有文案；红色只给 problem");

{
  const cases = [
    {
      name: "ok",
      selfCheck: OK_CHECK,
      want: "自检通过",
      bad: false,
      warn: false,
    },
    {
      name: "pending",
      selfCheck: { status: "pending", detail: "日志里还有一条等用户确认的记录" },
      want: "自检待确认",
      bad: false,
      warn: true,
    },
    {
      name: "unverified",
      selfCheck: { status: "unverified", detail: "该客户端没有可查日志" },
      want: "自检未复核",
      bad: false,
      warn: false,
    },
    {
      name: "unavailable",
      selfCheck: { status: "unavailable", detail: "日志文件读不动" },
      want: "自检未做",
      bad: false,
      warn: false,
    },
    {
      name: "problem（带日志原文）",
      selfCheck: {
        status: "problem",
        detail: "/home/u/.zcode/hooks.json: 条数不对",
        log: { logPath: "/home/u/.zcode/log.txt", line: "hook 未执行：找不到 exe" },
      },
      want: "自检发现问题",
      line: "hook 未执行：找不到 exe",
      bad: true,
      warn: false,
    },
    {
      name: "problem（盘上核对失败，无日志原文）",
      selfCheck: { status: "problem", detail: "/home/u/.zcode/hooks.json: 文件不存在" },
      want: "自检发现问题",
      bad: true,
      warn: false,
    },
  ];

  for (const item of cases) {
    const root = mountPanel({
      status: async () => snapshot(),
      install: async () => ({ selfCheck: item.selfCheck }),
      uninstall: async () => ({}),
      set: async () => ({}),
    });
    await settle();
    findClass(root, "hk-install").fire("click");
    await settle();

    const st = findClass(root, "hk-status");
    check(`${item.name}：有可读文案（不是空白）`, st.textContent.includes(item.want), st.textContent);
    eq(`${item.name}：红色只跟 problem 走`, st.classList.contains("bad"), item.bad);
    eq(`${item.name}：warn 只跟 pending 走`, st.classList.contains("warn"), item.warn);
    if (item.line) {
      check(`${item.name}：日志原文取自 selfCheck.log.line`, st.textContent.includes(item.line));
    } else {
      check(`${item.name}：不拼出「日志原文：undefined」`, !st.textContent.includes("undefined"));
    }
  }
}

/* ==================== N3：agent:hooks 通道的 confirm 透传 ==================== */
group("N3：bridge 的 install 把 confirm 透传给宿主命令");

{
  resetStub();
  invalidatePermissions();
  setReply("permission_check", true);
  setReply("agent_hooks_install", { files: [] });
  const hooks = createAgentHooksApi({
    id: "uz.agent-accept",
    name: "A",
    permissions: [caps.AGENT_HOOKS],
  });
  await hooks.install();
  await hooks.install(true);
  const installs = tauriCalls.filter((call) => call.cmd === "agent_hooks_install");
  eq("两次安装都落到宿主的 agent_hooks_install", installs.length, 2);
  eq("不传时默认 confirm:false", installs[0].args.confirm, false);
  eq("传 true 时透传成 confirm:true", installs[1].args.confirm, true);
  check(
    "插件 id 照旧带上",
    installs.every((call) => call.args.pluginId === "uz.agent-accept"),
  );
}
