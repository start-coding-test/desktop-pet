// 打包版校验：CSP 是否真的强制、页面自身代码在 CSP 下能否经 petplugin 协议加载插件。
// 自己拉起/回收 release exe —— 单实例按 identifier 抢占，跑之前必须先停掉 dev 实例。
//   npm run verify:release              先 tauri build --no-bundle（约 3~4 分钟）
//   npm run verify:release -- --skip-build
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { argv, env } from "node:process";

import { attach, createReport, hostInvoke, listPages, openSettingsInvoker, readEnabledIds, reloadAndWait, waitUntil, writeEnabledIds } from "./harness/cdp.mjs";
import { NET_ID, PROBE_ID, removeFixtures, writeFixtures } from "./harness/fixtures.mjs";
import { WIDGET_HOST_REALM_FLAG, waitWidgetRealm } from "./harness/widget-realm.mjs";

// ==== A20-PURE-BEGIN ====
// 这一段只依赖入参与 node:path，不碰 fs、不读 process.env ——
// temp/a20-pure-preview.mjs 按这对标记从**本文件的真实源码**里截取后执行（A20-D1 的 C4：不得手抄函数），
// 所以 M1/M2/M3 改的就是这里，预演杀的就是改过的那一份。
const AGENT_DIR_NAMES = [".qoder", ".qoder-cn", ".zcode", ".codex", ".workbuddy", ".codebuddy"];
const AGENT_ENV_NAMES = ["PET_AGENT_CONFIG_FILES", "PET_AGENT_HOME", "PET_AGENT_INBOX"];

/** 归一成「正斜杠 + 小写 + 无尾分隔符」的绝对路径；Windows 大小写不敏感，POSIX 上这样比更保守（宁可多判危险）。 */
function normPath(p) {
  return resolve(p)
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** 验收标准 3：exe 位置尊重外部 `CARGO_TARGET_DIR`（空串按未设），次级来源 `CARGO_BUILD_TARGET_DIR`。
 * 相对值不猜 cargo 的基准（是 cwd 还是 `src-tauri` 不确定），直接判错。 */
function resolveReleaseExe(primary, secondary, repoRoot) {
  const raw = [primary, secondary].find((v) => typeof v === "string" && v.trim() !== "");
  if (raw === undefined) {
    return {
      absolute: true,
      exe: join(repoRoot, "src-tauri", "target", "release", "desktop-pet.exe"),
      source: "默认（仓库内 src-tauri/target）",
    };
  }
  const value = raw.trim();
  if (!isAbsolute(value)) return { absolute: false, exe: null, source: value, reason: "须为绝对路径" };
  return { absolute: true, exe: join(resolve(value), "release", "desktop-pet.exe"), source: value };
}

/** 验收标准 4：`missing` / `stale` / `unknown` / `ok` —— 拿不到 mtime 或 git 时间时不默认放行。 */
function exeFreshness(mtimeMs, commitMs) {
  if (typeof mtimeMs !== "number") return "missing";
  if (typeof commitMs !== "number") return "unknown";
  return mtimeMs >= commitMs ? "ok" : "stale";
}

/** 验收标准 6：取值格式与 `tools/check-nsis-cleanup.ps1:41` 一致 —— CONFIG_FILES 是 `;` 连接的 json **文件**路径，
 * HOME 与 INBOX 是隔离根下互不重叠的子目录。 */
function agentPaths(isoRoot) {
  return {
    PET_AGENT_CONFIG_FILES: [join(isoRoot, "cfg-a.json"), join(isoRoot, "cfg-b.json")].join(";"),
    PET_AGENT_HOME: join(isoRoot, "home"),
    PET_AGENT_INBOX: join(isoRoot, "inbox"),
  };
}

/** 要建的目录：隔离根 + HOME + INBOX（两个 cfg 文件直接落根下，父目录就是根） */
function agentDirs(isoRoot) {
  return [isoRoot, join(isoRoot, "home"), join(isoRoot, "inbox")];
}

/** 验收标准 7：外部同名变量解析后落在真实 home 的 agent 目录里 = 危险。
 * 判据是「等于 `<home>/<名>`」或「以 `<home>/<名>/` 为前缀」—— 所以 `.qoder-cn2` 不算命中（M3 去掉那个 `/` 就会被杀）；
 * `CONFIG_FILES` 先按 `;` 拆开逐个判；`PET_AGENT_HOME` 等于真实 home 本身也算（四家 agent 目录都建在它下面，见 claude_style.rs:182-184）。 */
function agentEnvHazard(inputEnv, home) {
  const hits = [];
  if (typeof home !== "string" || home.trim() === "") return hits;
  const homeNorm = normPath(home);
  for (const name of AGENT_ENV_NAMES) {
    const raw = inputEnv[name];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    for (const part of raw.split(";")) {
      const value = part.trim();
      if (value === "") continue;
      const target = normPath(value);
      const isHomeRoot = name === "PET_AGENT_HOME" && target === homeNorm;
      const inside = AGENT_DIR_NAMES.some((dir) => {
        const base = normPath(join(homeNorm, dir));
        return target === base || target.startsWith(`${base}/`);
      });
      if (isHomeRoot || inside) hits.push(`${name}=${value}`);
    }
  }
  return hits;
}

/** 真实 spawn 的唯一 env 入口（C3）：`...iso` 排在 `...baseEnv` 之后 ⇒ 我们的值一定覆盖外部同名值。
 * 「尊重外部值」不体现在这里，而体现在 hazard：外部值被检测、命中就在 build 之前中止（A20-D2 Q4）。 */
function buildSpawnEnv(baseEnv, iso, port) {
  return {
    ...baseEnv,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    ...iso,
  };
}
// ==== A20-PURE-END ====

/** HEAD 的提交时间（`%ct`，非作者时间）；git 取不到返回 null ⇒ 判 `unknown` 红，不默认放行。 */
function headCommitMs(cwd) {
  const res = spawnSync("git", ["log", "-1", "--format=%ct", "HEAD"], { cwd, encoding: "utf8" });
  if (res.status !== 0) return null;
  const seconds = Number(String(res.stdout).trim());
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

const skipBuild = argv.includes("--skip-build");
const PORT = Number(env.CDP_PORT ?? 9224);
const REPO_ROOT = resolve(import.meta.dirname, "../..");
/** exe 位置由外部 `CARGO_TARGET_DIR` 决定（A20：共用 runner 上产物就在仓库外，写死仓库内会验到陈旧二进制） */
const exePlan = resolveReleaseExe(env.CARGO_TARGET_DIR, env.CARGO_BUILD_TARGET_DIR, REPO_ROOT);
// 相对值时 exePlan.exe 是 null，这里给个占位路径：预检 B 会在任何 fs 操作与 spawn 之前退出
const EXE = exePlan.exe ?? join(REPO_ROOT, "src-tauri", "target", "release", "desktop-pet.exe");
const PLUGINS_DIR = join(dirname(EXE), "plugins");
/** L1 原型（ADR-0006）的取证插件：仓库里那份夹具装进打包版的插件目录，跑完删 */
const L1_ID = "zz.l1-probe";
const L1_FIXTURE = resolve(import.meta.dirname, "../fixtures/l1-probe");
const L1_DIR = join(PLUGINS_DIR, L1_ID);
/** 留在宿主 realm 的例外名单（默认空 = 全部走 Worker） */
const REALM_FLAG = "host:realm-plugin-host";
const r = createReport("CSP 与插件加载（release）");

/**
 * 预检 A（A20-D2 Q4/C5）：外部 `PET_AGENT_*` 已指向真实 homedir 的 agent 目录时**在 build 之前就中止**。
 * 那种环境下 hook 路线会写到用户正在用的配置里，安全优先于下面 32 条读数。
 */
r.group("预检 A：外部 PET_AGENT_* 没有指向真实 homedir 的 agent 目录");
const hazards = agentEnvHazard(env, homedir());
r.check("外部 PET_AGENT_* 没有指向真实 homedir 的 agent 目录", true, hazards.length === 0);
if (hazards.length > 0) {
  r.info("命中的外部变量原值", hazards.join(" ; "));
  r.info("处置", "不构建、不起应用（外部值指向真实 agent 目录，读数没有意义）");
  r.summary();
  process.exit(1);
}

if (!skipBuild) {
  console.log("构建 release（tauri build --no-bundle）…");
  // 必须是这一整串：spawn 传数组会让第二个 `--` 原样落到 tauri，
  // 而 tauri 把它之后的参数转交给 cargo，cargo 不认 --no-bundle 直接失败。
  const build = spawn("npm run tauri build -- --no-bundle", { stdio: "inherit", shell: true });
  if ((await new Promise((res) => build.on("exit", res))) !== 0) {
    console.error("tauri build 失败");
    process.exit(2);
  }
}
/**
 * 预检 B（A20-D1 C5）：exe 的存在性与新鲜度放在 build 之后、spawn 之前。
 * 陈旧或不存在都具名红并非零退出、**不启动应用** —— 拿上一轮的 exe 验这一轮的代码，32 条全绿也是无效读数。
 * 已知副作用（预期行为）：只改测试的提交之后用 `--skip-build` 复用旧 exe，会正确判红。
 */
r.group("预检 B：release exe 的定位与新鲜度");
const exeExists = exePlan.absolute && existsSync(EXE);
r.check("CARGO_TARGET_DIR 是绝对路径（相对值不猜 cargo 的基准）", true, exePlan.absolute);
r.check("release exe 在解析出的 target 目录下存在", true, exeExists);
const commitMs = headCommitMs(REPO_ROOT);
const mtimeMs = exeExists ? statSync(EXE).mtimeMs : null;
const verdict = exeFreshness(mtimeMs, commitMs);
r.check("release exe 不比 HEAD 提交更旧（陈旧即上一轮的二进制）", "ok", verdict);
r.info("exe 查找", `source=${exePlan.source}${exePlan.reason ? ` reason=${exePlan.reason}` : ""} verdict=${verdict} exe=${EXE}`);
r.info("时间基准", `mtime=${mtimeMs ?? "-"} headCommit=${commitMs ?? "-"}`);
if (verdict !== "ok" || !exePlan.absolute) {
  r.summary();
  process.exit(1);
}

/** 预检全过才建隔离根：早退路径不留临时目录（C5） */
const ISO_ROOT = mkdtempSync(join(tmpdir(), "pet-release-iso-"));
for (const dir of agentDirs(ISO_ROOT)) mkdirSync(dir, { recursive: true });
const ISO = agentPaths(ISO_ROOT);
const isoAllUnderRoot = [...ISO.PET_AGENT_CONFIG_FILES.split(";"), ISO.PET_AGENT_HOME, ISO.PET_AGENT_INBOX].every(
  (p) => normPath(p).startsWith(`${normPath(ISO_ROOT)}/`),
);
r.group("预检 C：本次 spawn 自带的 PET_AGENT_* 隔离");
r.check("三个 PET_AGENT_* 都落在本次新建的临时隔离根下", true, isoAllUnderRoot);
r.check("隔离根建在 os.tmpdir() 之下", true, normPath(ISO_ROOT).startsWith(normPath(tmpdir())));
r.info("隔离取值", JSON.stringify(ISO));

mkdirSync(PLUGINS_DIR, { recursive: true });
const app = spawn(EXE, [], {
  stdio: "ignore",
  env: buildSpawnEnv(env, ISO, PORT),
});

let exitCode = 1;
try {
  writeFixtures(PLUGINS_DIR);
  const c = await attach(PORT, (t) => /tauri\.localhost\/src\/index\.html$/.test(t.url), 90_000);
  try {
    r.info("已连接", c.url);
    const invoke = hostInvoke(c);
    // 脚手架探针的入口把事实写进 `window.__probes` / `__probeActivated`，断言在页面 realm 读它们，
    // 所以把它们留在宿主 realm（真实插件与下面的 zz.l1-probe 不受这条影响，仍走 Worker）
    await c.ev(`localStorage.setItem(${JSON.stringify(REALM_FLAG)}, ${JSON.stringify(`${PROBE_ID},${NET_ID}`)})`);
    // widget 自阶段二收口起也默认进 Worker；这份探针的 widget 测的正是**页面自身代码**在打包版
    // CSP 下的行为（eval / <style> 注入），所以要一起点名留在宿主 realm。
    // 下面那条 zz.l1-probe 不受影响 —— 它就是用来证打包版 Worker 里 petplugin + CSP 走得通的。
    await c.ev(
      `localStorage.setItem(${JSON.stringify(WIDGET_HOST_REALM_FLAG)}, ${JSON.stringify(PROBE_ID)})`,
    );

    r.group("CSP 是否随文档下发（Tauri 用响应头，不是 meta 标签）");
    const header = await c.ev(
      `(async () => { const res = await fetch('/src/index.html'); return res.headers.get('content-security-policy') ?? ''; })()`,
    );
    r.check("响应头含 CSP", true, header.includes("default-src 'none'"));
    r.check("script-src 不含 unsafe-inline", false, /script-src[^;]*unsafe-inline/.test(header));
    r.check("script-src 放行了插件协议", true, /script-src[^;]*petplugin\.localhost/.test(header));

    r.group("桌宠图集在打包版 CSP 下真的能解码（dev 不注入 CSP，这条只能在 release 验）");
    const skin = await invoke("pet_skin_active");
    const skinList = await invoke("pet_skin_list");
    // 原来这条钉的是「激活的必须是 deepseek」——那是「用户从没换过形象」的隐含前提，
    // 换过一次皮肤就常年红。真正要验的是随包那份形象装上了、且当前激活的那张图能被 CSP 解码（下一条）。
    r.check(
      "随包的默认形象 deepseek 在列表里",
      true,
      (skinList.v ?? []).some((s) => s.slug === "deepseek"),
    );
    r.check("img-src 放行 petskin 协议", true, /img-src[^;]*petskin\.localhost/.test(header));
    // v3 皮肤还要 fetch 同目录 pet.json；connect-src 一收紧，打包版会静默退回占位帧，dev 不注入 CSP 测不出来
    r.check(
      "connect-src 放行 petskin 协议（v3 要 fetch pet.json）",
      true,
      /connect-src[^;]*petskin\.localhost/.test(header),
    );
    const petProbeSkin = skin.v ?? (skinList.v ?? []).find((s) => s.slug === "deepseek");
    const petJsonProbe = await c.ev(`(async () => {
      const base = ${JSON.stringify(petProbeSkin?.url ?? "")};
      if (!base) return { ok: false, reason: "no-skin" };
      const url = new URL("pet.json", base).href;
      try {
        const res = await fetch(url, { cache: "no-store" });
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        return { ok: res.ok, status: res.status, url, parsed };
      } catch (e) {
        return { ok: false, url, reason: String(e) };
      }
    })()`);
    r.check("打包版能真实读到 pet.json（connect-src 未收紧）", true, petJsonProbe?.ok === true);
    r.check(
      "pet.json 是合法 JSON",
      true,
      petJsonProbe?.parsed !== null && typeof petJsonProbe?.parsed === "object",
    );
    const petManifestVersion = petJsonProbe?.parsed?.desktopPet?.version ?? null;
    r.info(
      "pet.json 探测",
      JSON.stringify({
        url: petJsonProbe?.url ?? null,
        status: petJsonProbe?.status ?? null,
        reason: petJsonProbe?.reason ?? null,
        desktopPetVersion: petManifestVersion,
      }),
    );
    r.check(
      "若 pet.json 带 desktopPet 清单则 version 为 3",
      true,
      petManifestVersion === null || petManifestVersion === 3,
    );
    // 由页面自己发起的 <img> 加载才受 img-src 约束；被 CSP 拦下会走 onerror
    const decoded = await c.ev(`(async () => {
      const url = ${JSON.stringify(skin.v?.url ?? "")};
      if (!url) return "no-skin";
      return await new Promise((res) => {
        const img = new Image();
        const timer = setTimeout(() => res("timeout"), 20_000);
        img.onload = () => { clearTimeout(timer); res(img.naturalWidth + 'x' + img.naturalHeight); };
        img.onerror = () => { clearTimeout(timer); res("blocked"); };
        img.src = url;
      });
    })()`);
    r.check("图集解码成功且尺寸是 petdex v1 布局", "1536x1872", decoded);

    r.group("宿主自身在 CSP 下加载插件（真实启动路径，非 CDP 发起）");
    // 启停清单归宿主（C1）：写只认设置窗，打包版也一样（这一组同时在验打包版的门禁与协议）
    const prev = await readEnabledIds(invoke);
    const settingsWin = await openSettingsInvoker(PORT, c).catch(() => null);
    if (settingsWin) await writeEnabledIds(settingsWin.invoke, [PROBE_ID]);
    else r.check("打包版能唤出设置窗（写启停清单要用）", true, false);
    await settingsWin?.close().catch(() => undefined);
    await reloadAndWait(c);
    // 刚构建完的首次冷启动（杀软扫描 + WebView2 初始化）可能超过 20s，这里放宽
    const badgeSelector = `#widget-badge > div[data-plugin-id=${JSON.stringify(PROBE_ID)}]`;
    const mounted = await waitUntil(c, `!!document.querySelector(${JSON.stringify(badgeSelector)})`, 60_000);
    if (!mounted) {
      console.log(
        "     现场: probes=" +
          (await c.ev(`(window.__probes ?? []).length`)) +
          " activated=" +
          (await c.ev(`window.__probeActivated ?? 'none'`)) +
          " 选择器再查=" +
          (await c.ev(`!!document.querySelector(${JSON.stringify(badgeSelector)})`)) +
          " 全部插槽=" +
          JSON.stringify(await c.ev(`[...document.querySelectorAll('div[data-plugin-id]')].map(d=>d.dataset.pluginId+':'+d.dataset.region)`)) +
          " badge容器=" +
          JSON.stringify(await c.ev(`document.getElementById('widget-badge')?.innerHTML?.slice(0,120) ?? '(无)'`)),
      );
    }
    r.check("探针 widget 挂载成功", true, mounted);
    const probe = await c.ev(`(window.__probes ?? [])[0] ?? null`);
    // 探针内的 eval 是页面代码发起的，才受 CSP 约束；CDP 直接求值不受约束，不能当判据
    r.check("探针内 eval 被拒（证明策略真的在强制）", "enforced", probe?.csp);
    r.check("widget 注入 <style> 被 style-src 放行", true, probe?.styleApplied);

    r.group("宿主侧规则在发布版同样有效");
    const undeclared = await invoke("permission_request", {
      pluginId: PROBE_ID,
      capabilities: ["ble:scan"],
    });
    r.check("未声明能力被拒", true, !undeclared.ok && /未在 manifest 声明/.test(String(undeclared.e)));
    const spoof = await invoke("consent_answer", { reqId: "rNOPE", granted: true });
    r.check("非同意框窗口不能应答授权", true, !spoof.ok && /does not own/.test(String(spoof.e)));

    r.group("L1 Worker 宿主在打包版 CSP 下成立（ADR-0006）");
    // 打包版没有 /src/*.ts，dev 套件那句「动态 import 宿主模块」在这里必然失败；
    // 所以换 Worker 复装走真实用户的路径：删掉插件目录再装回去，由宿主的 watcher 触发 reconcile
    r.check(
      "CSP 未单列 worker-src（Worker 回落到 script-src 的 'self'）",
      false,
      /worker-src/.test(header),
    );
    installL1Probe("leaf-v1");
    const beforeL1 = await readEnabledIds(invoke);
    const l1Win = await openSettingsInvoker(PORT, c).catch(() => null);
    if (!l1Win) r.check("Worker 组能唤出设置窗（写启停清单要用）", true, false);
    if (l1Win) {
      await l1Win.invoke("permission_revoke", { pluginId: L1_ID });
      await writeEnabledIds(l1Win.invoke, [...new Set([...beforeL1, L1_ID])]);
      await l1Win.close().catch(() => undefined);
    }
    await nap(1200);
    // 不再需要「打开开关」：入口默认就走 Worker，zz.l1-probe 不在例外名单里
    await reloadAndWait(c);
    let stopPump = false;
    void pumpConsent(() => stopPump);
    const l1Booted = await waitUntil(c, l1KeyIs("booted", "true"), 90_000);
    r.check("探针在打包版 CSP 下于 Worker 里 activate 成功", true, l1Booted);
    const l1Facts = await readL1Facts(c);
    r.info("入口 URL", String(l1Facts?.entryUrl));
    r.info("裸说明符解析失败的原因", String(l1Facts?.bareImportText));
    r.check("Worker 里没有 window", false, l1Facts?.hasWindow);
    r.check("Worker 里没有 document", false, l1Facts?.hasDocument);
    r.check("__TAURI_INTERNALS__ 在 Worker 里不可达", false, l1Facts?.hasInternals);
    r.check("裸说明符 @tauri-apps/api/core 解析不了", "rejected", l1Facts?.bareImport);
    r.check("入口的相对子模块在打包版 Worker 里取到", "leaf-v1", l1Facts?.leaf);
    r.check("入口 URL 带上 ?v= 令牌", true, /\?v=\d+/.test(String(l1Facts?.entryUrl)));
    r.check("协议表外的方法名被宿主拒", false, l1Facts?.forged?.unknownMethod?.ok);
    r.check("借表内方法发别人的 topic 被前缀归属拦下", false, l1Facts?.forged?.publishAsOther?.ok);
    r.check("跨插件读不到别人的存储", null, l1Facts?.crossPluginRead);

    /**
     * widget 自阶段二收口起也默认进 Worker，而打包版的 CSP 是**另一套**（响应头下发、
     * 没有 dev 那层 Vite 直出），所以这条必须在这里各证一遍，不能拿第⑧组的 dev 读数代替。
     */
    const widgetArrived = await waitUntil(c, l1KeyIs("widgetFacts.realm", '"worker"'), 90_000);
    if (!widgetArrived) r.info("widget 实得的 realm", String((await readL1WidgetFacts(c))?.realm));
    r.check("探针 widget 在打包版 CSP 下的 Worker realm 里挂载", true, widgetArrived);
    const wFacts = await readL1WidgetFacts(c);
    r.check(
      "打包版 widget 路线里没有 document 也没有 window",
      "false|false",
      `${wFacts?.hasDocument}|${wFacts?.hasWindow}`,
    );
    r.check("打包版 widget 路线上 ctx.dom 在（渲染只能走指令通道）", true, wFacts?.hasDom);
    // 逢 call 必回在打包版同样要成立：不回包时这个 widget 只是永远起不来，不会报错
    r.check("打包版同样逢 call 必回：表外方法收到的是拒绝", "answered:denied", wFacts?.forbidden);
    r.check(
      "插槽壳上的 realm 戳在打包版也是 worker",
      "worker",
      (await waitWidgetRealm(c, L1_ID, "badge", "worker", 60_000)).actual,
    );

    // 复装之前先把插件目录整个删掉（这也会让宿主把它的授权收走，pump 继续负责点同意框），
    // 再按「leaf.js 先落盘、manifest.json 最后」的顺序装回去 ——
    // 装回时 leaf 的内容就已经是 leaf-v2，新 Worker 取到的必须是新的那一份
    rmSync(L1_DIR, { recursive: true, force: true });
    await nap(2500);
    installL1Probe("leaf-v2");
    const refreshed = await waitUntil(c, l1KeyIs("facts.leaf", JSON.stringify("leaf-v2")), 90_000);
    // 复装这一步也要继续点同意框：删插件目录会触发 prune_orphan_grants 把授权收走，
    // 重新装载就是一次全新的首次授权（不是「缓存里还剩一份」）
    stopPump = true;
    if (!refreshed) r.info("复装后实得的 leaf", String((await readL1Facts(c))?.leaf));
    r.check("换一个 Worker 后取到新内容（no-store 在打包版 Worker 路径上成立）", true, refreshed);
    await c.ev(`localStorage.removeItem(${JSON.stringify(REALM_FLAG)})`).catch(() => undefined);
    await c.ev(`localStorage.removeItem(${JSON.stringify(WIDGET_HOST_REALM_FLAG)})`).catch(() => undefined);

    r.group("无 CSP 违规");
    const violations = c.noise.filter((n) => n.startsWith("CSP:"));
    r.check("违规条数", 0, violations.length);
    /**
     * 只钉「widget 起不来」这一类，不做「一条 console.error 都不许有」：
     * 上面那 24 条断言全绿的同时，日志里正躺着两条 widget 404 —— 打包版的 widget 路线
     * 曾经没有任何断言看着，靠这条兜住「装载失败但套件说绿」。
     */
    const widgetFails = c.noise.filter((n) => /widget 起不来/.test(n));
    r.check("打包版没有 widget 装载失败", 0, widgetFails.length);
    for (const n of c.noise.filter((n) => !n.startsWith("CSP:"))) console.log("   " + n);

    // 恢复用户那份清单（写仍然只认设置窗）
    {
      const back = await openSettingsInvoker(PORT, c).catch(() => null);
      if (back) await writeEnabledIds(back.invoke, prev).catch(() => undefined);
      // 撤销会连带清掉该插件的隔离存储目录，比留一份探针写的垃圾干净
      if (back) await back.invoke("permission_revoke", { pluginId: L1_ID }).catch(() => undefined);
      await back?.close().catch(() => undefined);
    }
  } finally {
    exitCode = r.summary() ? 1 : 0;
    c.close();
  }
} catch (err) {
  // 内层 finally 已经把 exitCode 按断言结果算过一次，异常路径必须覆盖回非零：
  // 否则「跑到一半崩了、但已跑的断言全绿」会以 0 退出，CI 看到的是绿
  exitCode = 1;
  console.error("\n校验未启动:", String(err?.message ?? err).split("\n")[0]);
  console.error("若一直连不上 CDP：多半是 dev 实例还开着，单实例插件让 release 直接退出。");
} finally {
  app.kill();
  // 只按「可执行路径正好是本次要验的那个 exe」收残留进程。
  // /IM 按镜像名一刀切会连用户自己开着的那份一起杀掉。
  if (process.platform === "win32") {
    spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-Process -Name desktop-pet -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${JSON.stringify(
          EXE,
        )} } | ForEach-Object { Stop-Process -Id $_.Id -Force }`,
      ],
      { stdio: "ignore", shell: false },
    );
  }
  removeFixtures(PLUGINS_DIR);
  rmSync(L1_DIR, { recursive: true, force: true });
  // C7：Windows 上 app 刚被 kill，隔离根里的文件可能还被占用。这里放最后、包 try/catch（带 maxRetries）：
  // 抛错既不能跳过上面的收口，也不能改变退出码 —— 收不掉就只留一个临时目录，比弄脏判定便宜。
  try {
    rmSync(ISO_ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  } catch (err) {
    console.log(`  · 隔离临时目录未删净（不影响退出码）：${ISO_ROOT} — ${String(err?.message ?? err).slice(0, 80)}`);
  }
}

process.exit(exitCode);

/** Worker 组用的等待与安装：打包版的插件目录在 exe 同级，不是仓库根的 plugins/ */
function nap(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * 把 L1 取证插件装进打包版的插件目录。
 * 顺序是有意的：`leaf.js`（内容按参数写）与 `index.js` 先落盘，`manifest.json` 最后 ——
 * 宿主是在读到 manifest 的那一轮才 reconcile 的，这样「装载」看到的就是这一轮要验的那份 leaf 内容。
 */
function installL1Probe(leafValue) {
  mkdirSync(L1_DIR, { recursive: true });
  writeFileSync(join(L1_DIR, "leaf.js"), `export const LEAF_MARKER = ${JSON.stringify(leafValue)};\n`);
  copyFileSync(join(L1_FIXTURE, "index.js"), join(L1_DIR, "index.js"));
  // widget.js 必须一起装：manifest 声明了它，翻默认后宿主会去 Worker 里 import 它。
  // 这份夹具以前只装 index.js，打包版的 widget 装载一直 404，而这套件里没有一条断言看它。
  copyFileSync(join(L1_FIXTURE, "widget.js"), join(L1_DIR, "widget.js"));
  copyFileSync(join(L1_FIXTURE, "manifest.json"), join(L1_DIR, "manifest.json"));
}

/** 读探针写进自己隔离存储的一条事实（`key` 支持 `facts.leaf` 这种两段路径） */
function l1KeyIs(key, want) {
  const [head, tail] = key.split(".");
  const expr = tail ? `__v?.${tail}` : "__v";
  return `(async () => { try { const __v = await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(L1_ID)}, key: ${JSON.stringify(head)} }); return ${expr} === ${want}; } catch { return false; } })()`;
}

async function readL1Facts(c) {
  return c
    .ev(`(async () => { try { return await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(L1_ID)}, key: 'facts' }) ?? null; } catch { return null; } })()`)
    .catch(() => null);
}

/** widget 那份自报由入口经总线中继进同一个隔离存储（closed shadow 里没有别的出口） */
async function readL1WidgetFacts(c) {
  return c
    .ev(`(async () => { try { return await window.__TAURI_INTERNALS__.invoke('store_get', { pluginId: ${JSON.stringify(L1_ID)}, key: 'widgetFacts' }) ?? null; } catch { return null; } })()`)
    .catch(() => null);
}

/** 授权只能走真实同意框：打包版也一样，所以整轮持续点「允许」 */
async function pumpConsent(stop) {
  while (!stop()) {
    const target = (await listPages(PORT).catch(() => [])).find((t) => /consent/.test(t.url));
    if (!target) {
      await nap(400);
      continue;
    }
    try {
      const cs = await attach(PORT, (t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl, 8_000);
      try {
        await cs.ev(`document.getElementById('btn-allow').click()`);
      } finally {
        cs.close();
      }
    } catch (e) {
      console.log(`  · 同意框应答失败，重试：${String(e).slice(0, 70)}`);
    }
    await nap(300);
  }
}
