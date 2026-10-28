// Q4 插件纯函数离线单测：com.pet.todo 的 todo.txt 解析/序列化。
//
// 运行：npm run unit（或 npm run unit:plugins）
//
// 关于「hr-ble 的 BPM uint8/uint16 解析」：那段实际在 Rust 侧
// （src-tauri/src/services/ble.rs::parse_heart_rate），插件只收广播好的 {bpm}，
// 所以它的单测随 Q5 一起放在 cargo test 里，不在本文件（本文件不造假蓝牙数据）。
//
// 口径以插件自身与 verify:todo 为准：`+` 是上下文、`@` 是项目 ——
// 这与上游 todo.txt 规范（+project / @context）相反，但改它等于动用户已有数据与
// 设置页显示，不在本波范围；这里把**现有**行为钉住，防止解析层被无意改漂。
import { deep, eq, group, check } from "./harness.mjs";

const { parseLine, formatLine, today, dueRank, sortOpen } = await import(
  new URL("../../plugins/com.pet.todo/todo-txt.js", import.meta.url)
);

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

/* ============================ parseLine ============================ */
group("todo-txt 解析");

{
  const t = parseLine("(A) 2016-05-04 写周报 due:2016-05-10 @工作 +老板 x:2016-05-06");
  eq("优先级取圆括号里的大写字母", t.priority, "A");
  eq("行首日期当创建日", t.created, "2016-05-04");
  eq("正文只剩描述", t.text, "写周报");
  deep("项目来自 @", t.projects, ["工作"]);
  deep("上下文来自 +", t.contexts, ["老板"]);
  deep("key:value 进 meta", t.meta, { due: "2016-05-10" });
  eq("带 x: 就是已完成", t.done, true);
  eq("x: 的值当完成日并从 meta 里取出", t.completed, "2016-05-06");
}

{
  const t = parseLine("买牛奶");
  eq("裸句子没有优先级", t.priority, null);
  eq("裸句子没有创建日", t.created, null);
  eq("正文原样", t.text, "买牛奶");
  eq("未完成", t.done, false);
  deep("没有项目", t.projects, []);
  deep("meta 是空表", t.meta, {});
}

{
  const empty = parseLine("");
  eq("空行也是合法任务对象", empty.text, "");
  eq("空行不算完成", empty.done, false);
  const spaces = parseLine("   ");
  eq("纯空格按空行处理", spaces.text, "");
  const nul = parseLine(null);
  eq("null 入参不炸", nul.text, "");
}

{
  const lower = parseLine("(a) 小写不算优先级");
  eq("小写括号不当优先级", lower.priority, null);
  eq("小写括号留在正文里", lower.text, "(a) 小写不算优先级");
  const noSpace = parseLine("(A)没空格");
  eq("优先级标记后必须有空格", noSpace.priority, null);
}

{
  const midDate = parseLine("写周报 2016-05-04 收尾");
  eq("不在行首的日期不当创建日", midDate.created, null);
  check("日期留在正文里", midDate.text.includes("2016-05-04"), midDate.text);
}

{
  const t = parseLine("喝水 due: 提醒:每小时");
  eq("冒号后没值的不算 meta", t.text, "喝水 due: 提醒:每小时");
  deep("没有 key:value 落进 meta", t.meta, {});
  // \w 不含汉字（不是 /u 模式），中文键留在正文里 —— 这是现有口径，别当成 bug 改漂
  const ascii = parseLine("喝水 note:hourly");
  deep("ASCII 键才进 meta", ascii.meta, { note: "hourly" });
  eq("进了 meta 的就不在正文里", ascii.text, "喝水");
}

{
  const weirdDate = parseLine("x:bad 收尾");
  eq("x: 值不是日期时仍算完成", weirdDate.done, true);
  eq("但完成日留空", weirdDate.completed, null);
  deep("非日期的 x: 值不落到 meta", weirdDate.meta, {});
}

{
  const t = parseLine("  多   空格   正文  ");
  eq("正文里的连续空格压成单个", t.text, "多 空格 正文");
}

/* ============================ formatLine ============================ */
group("todo-txt 序列化");

{
  eq(
    "未完成任务按优先级/创建日/正文/meta/上下文/项目排",
    formatLine({
      done: false,
      priority: "B",
      created: "2026-10-01",
      text: "写周报",
      contexts: ["老板"],
      projects: ["工作"],
      meta: { due: "2026-10-02" },
    }),
    "(B) 2026-10-01 写周报 due:2026-10-02 +老板 @工作",
  );
  eq("没有优先级就没有括号段", formatLine({ done: false, text: "买牛奶", meta: {} }), "买牛奶");
  eq(
    "完成项写 x: 而不是优先级",
    formatLine({ done: true, priority: "A", completed: "2026-10-03", text: "买牛奶", meta: {} }),
    "x:2026-10-03 买牛奶",
  );
  eq(
    "完成但没记完成日时补今天",
    formatLine({ done: true, text: "买牛奶", meta: {} }).startsWith(`x:${today()}`),
    true,
  );
  eq("正文里的连续空格被压平", formatLine({ done: false, text: "多  空格", meta: {} }), "多 空格");
  eq("空正文不会留下多余空格", formatLine({ done: false, text: "  ", meta: {} }), "");
}

{
  // 解析 → 序列化 → 再解析，字段要站得住（verify:todo 那条「存下来的是原样」的离线版）。
  // 注意 formatLine 的段序是固定的（优先级/创建日/正文/meta/+上下文/@项目），
  // 所以这里用同一段序的行做往返 —— 它同时钉住了「写回去的规范形状」。
  const raw = "(C) 2026-09-30 交房租 due:2026-10-15 +房东 @生活";
  const once = parseLine(raw);
  const line = formatLine(once);
  eq("序列化回去的是同一行", line, raw);
  deep("再解析一次字段不变", parseLine(line), once);
  const messy = parseLine("(C) 2026-09-30 交房租 @生活 +房东 due:2026-10-15");
  eq("输入段序不同也会被规范化", formatLine(messy), raw);
}

/* ============================ today / dueRank ============================ */
group("到期判定");

{
  eq("today 是本地 YYYY-MM-DD", dateRe.test(today()), true);
  const now = new Date();
  const manual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  eq("today 用本地日期而不是 UTC（晚上不该生成前一天的日期）", today(), manual);
}

{
  eq("逾期排 0", dueRank({ meta: { due: "2000-01-01" } }), 0);
  eq("今天到期排 1", dueRank({ meta: { due: today() } }), 1);
  eq("将来到期排 2", dueRank({ meta: { due: "2999-12-31" } }), 2);
  eq("没有 due 排最后", dueRank({ meta: {} }), 4);
  eq("due 不是日期形状也排最后", dueRank({ meta: { due: "明天" } }), 4);
  eq("meta 缺失不炸", dueRank({}), 4);
}

/* ============================ sortOpen ============================ */
group("未完成排序");

{
  const overdue = parseLine("(B) 逾期A due:2000-01-02");
  const overdueEarly = parseLine("(C) 逾期B due:2000-01-01");
  const todayTask = parseLine("(A) 今天 due:" + today());
  const futureLate = parseLine("(A) 将来晚 due:2999-12-31");
  const futureSoon = parseLine("(Z) 将来早 due:2030-01-01");
  const noDue = parseLine("没有到期日");
  const done = parseLine("x:" + today() + " 已做完");

  const sorted = sortOpen([futureLate, noDue, done, futureSoon, todayTask, overdue, overdueEarly]);
  deep(
    "逾期 < 今天 < 将来 < 无 due，且同档按到期日升序",
    sorted.map((t) => t.text),
    ["逾期B", "逾期A", "今天", "将来早", "将来晚", "没有到期日"],
  );
  eq("已完成项不进清单", sorted.some((t) => t.done), false);
  const input = [noDue, todayTask];
  const out = sortOpen(input);
  eq("sortOpen 返回新数组，不改入参", input.map((t) => t.text).join(","), "没有到期日,今天");
  check("排完序的第一条是今天那条", out[0].text === "今天", out[0].text);
}

{
  // 同一天、同到期：优先级字母序（A 先），这是状态卡报「下一个到期」时的次要键
  const a = parseLine("(A) 甲 due:2000-01-01");
  const b = parseLine("(B) 乙 due:2000-01-01");
  const c = parseLine("丙 due:2000-01-01");
  deep("同到期日按优先级，无优先级排最后", sortOpen([b, c, a]).map((t) => t.text), ["甲", "乙", "丙"]);
}

/* ===================== G5-07 / G5-08 / G5-09 ===================== */
const { readFileSync: readFile } = await import("node:fs");
const manifestOf = (id) =>
  JSON.parse(readFile(new URL(`../../plugins/${id}/manifest.json`, import.meta.url), "utf8"));

group("插件 manifest 与实现对齐（G5-07/G5-08）");
{
  const agentBridge = manifestOf("com.pet.agent-bridge");
  check(
    "agent-bridge 不再申请没用到的 storage 权限（G5-07）",
    !agentBridge.permissions.includes("storage"),
    JSON.stringify(agentBridge.permissions),
  );
  check(
    "agent-bridge 仍保留真正用到的能力",
    ["bus:publish", "bus:subscribe", "widget", "agent:hooks"].every((p) => agentBridge.permissions.includes(p)),
    JSON.stringify(agentBridge.permissions),
  );

  const astock = manifestOf("com.pet.astock");
  const desc = String(astock.description ?? "");
  check(
    "astock 描述写明三家数据源（G5-08）",
    ["东方财富", "腾讯", "新浪"].every((s) => desc.includes(s)),
    desc,
  );
  const hosts = [
    "push2.eastmoney.com",
    "push2his.eastmoney.com",
    "searchadapter.eastmoney.com",
    "proxy.finance.qq.com",
    "qt.gtimg.cn",
    "web.ifzq.gtimg.cn",
    "ifzq.gtimg.cn",
    "hq.sinajs.cn",
  ];
  check("astock 描述列出全部 8 个可能访问的域名（G5-08）", hosts.every((h) => desc.includes(h)), desc);
  check("astock 描述提到后备源开关（G5-08）", desc.includes("后备"), desc);

  const { MARKET_HOSTS } = await import(new URL("../../plugins/com.pet.astock/market.js", import.meta.url));
  check(
    "描述里的域名与注册表 MARKET_HOSTS 完全一致（不再手写漂移）",
    hosts.slice().sort().join(",") === MARKET_HOSTS.slice().sort().join(","),
    MARKET_HOSTS.join(","),
  );
}

group("todo 完成状态先落盘再碰宠物（G5-09）");
{
  const { commitDone, DONE_EMOJI } = await import(new URL("../../plugins/com.pet.todo/order.js", import.meta.url));

  // 顺利路径：落盘的 await 在宠物调用之前
  const task = { text: "写周报", done: false, completed: null };
  const calls = [];
  await commitDone(task, true, {
    completed: "2026-10-28",
    save: async () => {
      calls.push("save");
    },
    react: async (level) => {
      calls.push(`react:${level}`);
    },
    say: async (text) => {
      calls.push(`say:${text.includes(DONE_EMOJI)}`);
    },
  });
  eq("落盘先于宠物反应", calls[0], "save");
  eq("完成态与完成日都写进内存", [task.done, task.completed].join(","), "true,2026-10-28");
  eq("宠物台词带完成符号", calls.at(-1), "say:true");
  eq("宠物反应在落盘之后", calls[1], "react:jumping");

  // 原 bug 的复现路径：宠物调用 reject 时状态不许丢、异常不许冒出去
  const risky = { text: "买牛奶", done: false, completed: null };
  let noted = null;
  await commitDone(risky, true, {
    completed: "2026-10-28",
    save: async () => {},
    react: async () => {
      throw new Error("permission denied");
    },
    note: (err) => {
      noted = err;
    },
  });
  eq("宠物 reject 后完成状态仍在", [risky.done, risky.completed].join(","), "true,2026-10-28");
  eq("失败只记一笔、不抛", noted?.message, "permission denied");

  // 落盘自己失败：内存回滚并抛出，别再碰宠物
  const failedSave = { text: "回滚", done: false, completed: null };
  const failedCalls = [];
  let rolled = null;
  let failure = null;
  try {
    await commitDone(failedSave, true, {
      completed: "2026-10-28",
      save: async () => {
        failedCalls.push("save");
        throw new Error("disk full");
      },
      rollback: (err) => {
        rolled = err;
      },
      react: async () => {
        failedCalls.push("react");
      },
    });
  } catch (err) {
    failure = err;
  }
  eq("落盘失败要抛出去（调用方才知道没存上）", failure?.message, "disk full");
  eq("内存回滚到未完成", [failedSave.done, failedSave.completed].join(","), "false,");
  eq("回滚钩子拿到错误", rolled?.message, "disk full");
  eq("落盘失败时不再碰宠物", failedCalls.join(","), "save");

  // 取消完成：只落盘，不触发宠物
  const reopen = { text: "重新打开", done: true, completed: "2026-10-01" };
  const reopenCalls = [];
  await commitDone(reopen, false, {
    save: async () => {
      reopenCalls.push("save");
    },
    react: async () => {
      reopenCalls.push("react");
    },
  });
  eq("取消完成只落盘", reopenCalls.join(","), "save");
  eq("completed 清空", [reopen.done, reopen.completed].join(","), "false,");
}
