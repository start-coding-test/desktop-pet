// Petdex 桌宠资源安装链路断言：默认形象、宿主按窗口标签的鉴权、真图集切片、
// 设置窗按名字安装 → 换装（不重启）→ 删除回落。
//   终端 1: npm run dev:debug      终端 2: npm run verify:skin
// 会真的走网络（petdex.dev 公开目录 + assets.petdex.dev 图集），并临时装一个第二形象后删掉。
import { argv, env } from "node:process";
import { attach, createReport, hostInvoke, waitForPage, waitUntil } from "./harness/cdp.mjs";

const PORT = Number(env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 9223);
const isPetPage = (t) => /localhost:1420\/(src\/)?index\.html$/.test(t.url);
const isSettingsPage = (t) => /localhost:1420\/src\/settings\.html/.test(t.url);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const r = createReport("桌宠资源安装（dev）");

const DEFAULT_SLUG = "deepseek";
const EXTRA_SLUG = "boba"; // 只为验证「输入名字即安装」，跑完删掉

let c = null;
let cs = null;
let installedExtra = false;
// 用户当前挑的形象，收尾要还回去。回归可以改状态，但不该替用户做选择。
let initialSlug = "";

try {
  c = await attach(PORT, isPetPage, 60_000);
} catch {
  console.error(`连不上 dev 实例的 CDP 端口 ${PORT}。请先用 npm run dev:debug 启动。`);
  process.exit(2);
}

const inv = hostInvoke(c);

try {
  r.group(`随包默认形象 ${DEFAULT_SLUG} 已装好，当前形象取自已安装列表`);
  const listed = await inv("pet_skin_list");
  r.check("pet_skin_list 可调", true, listed.ok);
  const active = await inv("pet_skin_active");
  r.check("pet_skin_active 可调", true, active.ok);
  initialSlug = String(active.v?.slug ?? active.v ?? "");
  const isInstalled = (slug) => (listed.v ?? []).some((s) => s.slug === slug);
  // 「已安装列表里有随包默认形象」是宿主不变量；「当前形象是谁」是用户状态，
  // 上一版把它钉成 deepseek，用户换过一次装就整片红，于是改判成它必须是列表里的某一个。
  r.check(`已安装列表含随包默认形象 ${DEFAULT_SLUG}`, true, isInstalled(DEFAULT_SLUG));
  r.check(`当前形象是已安装列表里的形象（本次为 ${initialSlug}）`, true, isInstalled(initialSlug));
  r.check(
    "图集按当前形象经 petskin 协议下发",
    true,
    initialSlug !== "" &&
      String(active.v?.url ?? "").startsWith(`http://petskin.localhost/${initialSlug}/`),
  );

  r.group("安装类命令只认设置窗（宿主按窗口标签判定，绕过 JS 桥也一样）");
  for (const [cmd, args] of [
    ["pet_skin_install", { name: EXTRA_SLUG }],
    ["pet_skin_use", { slug: EXTRA_SLUG }],
    ["pet_skin_remove", { slug: EXTRA_SLUG }],
  ]) {
    const res = await inv(cmd, args);
    r.check(`${cmd} 在宠物窗被拒`, false, res.ok);
    r.check(`${cmd} 的拒绝理由指向设置窗`, true, /设置窗/.test(String(res.e ?? "")));
  }

  r.group("真图集在宠物窗里被切成 petdex 九状态");
  const sliced = await c.ev(`(async () => {
    const { activeSkin } = await import('/src/pet/skins.ts');
    const { loadSpriteSet, decodedAtlases } = await import('/src/pet/sprites.ts');
    const { PET_STATES } = await import('/src/pet/petdex-states.ts');
    const skin = await activeSkin();
    const { sprites: set } = await loadSpriteSet(skin.url);
    const counts = {};
    for (const st of PET_STATES) counts[st.id] = set[st.id]?.length ?? 0;
    return {
      slug: skin.slug,
      version: skin.spriteVersionNumber,
      counts,
      // 帧是源矩形 + 单位化目标矩形，不再是烘焙画布：真图集切出来的每一帧
      // 都得指回同一张源图，且目标矩形不越出单位方块
      sameSource: PET_STATES.every((st) => (set[st.id] ?? []).every((f) => f.source === set.idle[0].source)),
      inUnitSquare: PET_STATES.every((st) => (set[st.id] ?? []).every((f) =>
        f.nx >= 0 && f.ny >= 0 && f.nw > 0 && f.nh > 0 && f.nx + f.nw <= 1.0001 && f.ny + f.nh <= 1.0001)),
      decoded: decodedAtlases(),
    };
  })()`);
  r.check("九个状态各取到自己那行的帧数", "6,8,8,4,5,8,6,6,6", Object.values(sliced.counts).join(","));
  r.check("所有帧共用同一份已解码图集", true, sliced.sameSource);
  r.check("目标矩形都落在立绘单位方块内", true, sliced.inUnitSquare);
  // 页面自己认的当前形象必须和宿主报的是同一个，否则「解码记录里有它」这条会钉错对象
  r.check("页面读到的当前形象与宿主一致", initialSlug, sliced.slug);
  r.check(`解码记录里有 ${initialSlug} 的图集`, true, sliced.decoded.some((u) => u.includes(initialSlug)));

  r.group("设置窗：输入名字 → 从公开画廊安装");
  await inv("settings_show", {});
  try {
    await waitForPage(PORT, isSettingsPage, 20_000);
    cs = await attach(PORT, isSettingsPage, 20_000);
  } catch {
    cs = null;
  }
  if (!cs) {
    r.check("设置窗可用（回归经宿主 settings_show 打开）", true, false);
  } else {
    const sInv = hostInvoke(cs);
    // 画廊安装是本套件唯一走外网大文件的调用：目录 900 KB + 图集 2.4 MB + zip 2.4 MB，
    // 实测 2026-10-15 上午这条链路要 15s 以上，20s 的默认求值上限会把它截成一条假红
    const installed = await sInv("pet_skin_install", { name: EXTRA_SLUG }, 90_000);
    installedExtra = installed.ok;
    // 红了要能一眼看出是上游画廊的问题还是宿主的问题，不然只能再复现一次去捞文案
    if (!installed.ok) r.info("安装失败原因", String(installed.e).slice(0, 240));
    r.check(`安装 ${EXTRA_SLUG} 成功`, true, installed.ok);
    r.check(`装好的 slug 是 ${EXTRA_SLUG}`, EXTRA_SLUG, installed.v?.slug);
    r.check("版本号来自画廊目录", true, [1, 2].includes(installed.v?.spriteVersionNumber));

    const missing = await sInv("pet_skin_install", { name: "definitely-not-a-pet-xyz" }, 90_000);
    r.check("不存在的名字给出可读失败", false, missing.ok);
    r.check("错误里带上找不到的名字", true, /definitely-not-a-pet-xyz|找不到|不存在/.test(String(missing.e ?? "")));

    const traversal = await sInv("pet_skin_install", { name: "../../windows" });
    r.check("目录穿越式的名字被拒", false, traversal.ok);

    const used = await sInv("pet_skin_use", { slug: EXTRA_SLUG });
    r.check("切换形象成功", true, used.ok);
    const after = await inv("pet_skin_active");
    r.check(`宠物窗读到当前形象变成 ${EXTRA_SLUG}`, EXTRA_SLUG, after.v?.slug);
    // 换装不该重启宠物窗：靠 pet:skin-changed 让正在跑的文档自己重载图集
    const swapped = await waitUntil(
      c,
      `(async () => (await import('/src/pet/sprites.ts')).decodedAtlases().some(u => u.includes('${EXTRA_SLUG}')))()`,
      15_000,
    );
    r.check("宠物窗不重启就解码了新图集", true, swapped);

    const removed = await sInv("pet_skin_remove", { slug: EXTRA_SLUG });
    r.check("删除成功", true, removed.ok);
    const back = await inv("pet_skin_active");
    r.check("删掉正在用的形象会回落到默认", DEFAULT_SLUG, back.v?.slug);
    const list2 = await inv("pet_skin_list");
    r.check(
      `列表里不再有 ${EXTRA_SLUG}`,
      false,
      (list2.v ?? []).some((s) => s.slug === EXTRA_SLUG),
    );
  }
} catch (err) {
  r.check("脚本未抛异常", true, false);
  console.error(err);
} finally {
  // 无论哪一步红，都把临时形象收掉，别把第二张图集留给后面的回归
  if (installedExtra) {
    // 换装类命令宠物窗一律被拒（本套件第 2 组钉着），清理必须走设置窗
    const sInv = hostInvoke(cs);
    await sInv("pet_skin_remove", { slug: EXTRA_SLUG }).catch(() => undefined);
    // 删掉在用形象只会回落到随包默认形象；用户原本挑的不是它就得显式换回去
    if (initialSlug && initialSlug !== DEFAULT_SLUG) {
      await sInv("pet_skin_use", { slug: initialSlug }).catch(() => undefined);
    }
  }
  await sleep(600);
  const failed = r.summary();
  cs?.close();
  c?.close();
  await sleep(400);
  process.exit(failed ? 1 : 0);
}
