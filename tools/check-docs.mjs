// tools/check-docs.mjs — 文档与磁盘一致性门禁（优化清单第 32 项；卡 R7 交付物）
//
// 十条规则（R-A…R-F 口径见 .dispatch/arch-p2/work/T04/check-docs-rules.md（工作区、不入库）与卡 R7 §3；R-G 见卡 R8 §2；R-H 见清单 R4；R-I/R-J 见清单 G8-01）：
//   R-A 正式文档里的 md 相对链接可达（http(s):/mailto:/纯 #片段 除外）
//   R-B ARCHITECTURE.md §4 树对 src-tauri/src/services/ 的覆盖双向成立
//   R-C README「目录速览」的 plugins/ 行点名四个插件 id
//   R-D 正式文档里的路径形反引号引用（七前缀）在磁盘上存在
//   R-E md 链接文字若是 .md 路径，其文件名必须与目标文件名一致
//   R-F AGENTS.md 字节数 ≤ 6000（上限由 PM 定，勿改回 5000）
//   R-G §4 树全量双向核对：树还原出的每条相对路径逐条 existsSync（树有、磁盘无 → 红）；
//       磁盘顶层目录与领域成员（目录级口径）必须在树里（磁盘有、树无 → 红）
//   R-H 坐标必须对读者可达：反引号里以盘符开头的机器绝对路径 → 红；
//       指向派单工作区 `.dispatch/…`（.gitignore 整目录不入库）的引用必须同行写「不入库」→ 否则红
//
// 退出码语义：任何一条规则为假 → process.exitCode = 1（CI 只认退出码，不打退出码等于没门禁）。
// 末尾固定打一行 `RESULT rules=8 failing=K`；--json 输出同样一份汇总的 JSON 形态。
//
// 例外全部是显式的常量表（EXEMPT_*），每条带出处与理由；口径论证见
// .dispatch/arch-p2/work/R7/exemptions.md。不许用"看起来不像路径"这类模糊启发式。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const linesOf = (rel) => read(rel).split(/\r?\n/);
const existsRel = (rel) => fs.existsSync(path.join(ROOT, rel.replace(/\/+$/, '')));

// ---- 15 份正式文档口径（卡 §3）：11 份固定 + docs/adr/*.md 全量。不扩面 ----
const BASE_DOCS = [
  'AGENTS.md',
  'README.md',
  'CONTEXT.md',
  'docs/architecture/ARCHITECTURE.md',
  'docs/process/CONVENTIONS.md',
  'docs/process/CODE-REVIEW.md',
  'docs/process/HOST-BACKLOG.md',
  'docs/plugin-dev/PLUGIN_SDK.md',
  'docs/plugin-dev/PLUGIN-HANDBOOK.md',
  'docs/plugin-dev/PLUGIN-REVIEW.md',
  'docs/plugin-dev/PLUGIN-BACKLOG.md',
];
function docList() {
  const adrDir = path.join(ROOT, 'docs', 'adr');
  const adr = fs
    .readdirSync(adrDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => `docs/adr/${e.name}`)
    .sort();
  return [...BASE_DOCS, ...adr];
}

// ===== 显式例外表（每条带出处；论证见 work/R7/exemptions.md）=====
// 形状级例外（判定前先过滤，不是"看着不像"的启发式，而是钉死的形态分类）：
//   - 反引号里含 < > { } * 的是模板/占位写法（如 `plugins/<id>/index.js`、`verify-*.mjs`），
//     机器无法也不该对占位求存在性；
//   - 含 `://` 的是协议/URL 写法（如 `petplugin://…`、`https://petdex.dev/…`）；
//   - `src-tauri/target/` 下是构建产物树（不进版本库，卡 §3 把 src-tauri/target/ 列为排除项）：
//     判"存在"与否取决于本机是否构建过，不是文档漂移，CI 上必须稳定跳过。
const PLACEHOLDER_SHAPE = /[<>{}*]/;
const EXEMPT_PREFIXES = [
  { prefix: 'src-tauri/target/', reason: '构建产物树，不入版本库（卡 §3 排除项）' },
  {
    prefix: 'release-package/',
    reason:
      '本地打包产物（.gitignore 覆盖），存在与否取决于本机是否打过包；CI 全新 checkout 必然没有，' +
      'R-G 正向面必须稳定跳过（口径同 src-tauri/target/；卡 R8 §6 把它列在「不进文档的目录」里）',
  },
];
// 全局 token 例外（在任何正式文档里出现都算合法）：
const EXEMPT_TOKENS = new Map([
  ['src/lib/pet-states.ts', '上游仓库 crafter-station/petdex 的源码路径：README.md:104 致谢一节照搬映射出处，本仓按设计不带这些文件'],
  ['src/lib/sprite-atlas.ts', '同上（上游仓库源码路径，README.md:104）'],
  ['packages/petdex-cli/src/hooks/bubble-runner.ts', '同上（上游仓库源码路径，README.md:104）'],
  ['plugins/llm-token-usage', '示例插件按用户决定暂缓、目录未建（2026-10-10 决定；CONVENTIONS.md:83 已标注「暂缓」，AGENTS.md 明说未做）'],
  // R-H 的 H1 例外：仓库外的备份落点。这条绝对路径本身就是内容（「备份不在这个库里」），不是文档坐标。
  ['D:/test/git-purge-backup-20261015', '2026-10-15 历史重写的仓库外备份目录（清单 R4，CONVENTIONS「派单工作区不入库」一条）：它按定义在库外，绝对路径就是它的含义'],
]);
// 按 (文档, token) 精确豁免：A01 拆分（2026-10-12）把 services/agent.rs、services/skins.rs 拆成
// 目录（agent/、skins/）之前写下的「文件:行号」坐标引用，保留原坐标（文档冻结期不改，PM 决定是改形态还是留记录）。
const EXEMPT_FILE_TOKENS = [
  {
    file: 'docs/process/CODE-REVIEW.md',
    token: 'src-tauri/src/services/agent.rs',
    reason: '2026-10-08 评审记录的行号坐标；agent.rs 已由 A01 拆成 agent/ 目录（HOOK_PHASES 现居 agent/phases.rs）',
  },
  {
    file: 'docs/process/CODE-REVIEW.md',
    token: 'src-tauri/src/services/skins.rs',
    reason: '2026-10-08 评审记录的行号坐标；skins.rs 已由 A01 拆成 skins/ 目录',
  },
  {
    file: 'docs/process/HOST-BACKLOG.md',
    token: 'src-tauri/src/services/agent.rs',
    reason: '任务卡 A2 的「必读」坐标（写于 A01 拆分前；同一任务的边界句沿用同形态）',
  },
  // M5（2026-10-13）插件目录改名 todo → com.pet.todo 后，CODE-REVIEW.md 里
  // 2026-10-08 评审记录的「文件:行号」坐标按口径不改（历史坐标），按 (文档, token) 精确豁免：
  {
    file: 'docs/process/CODE-REVIEW.md',
    token: 'plugins/todo/index.js',
    reason: '2026-10-08 评审记录的行号坐标；todo 插件已由 M5 改名 com.pet.todo，历史坐标保留不搬',
  },
  {
    file: 'docs/process/CODE-REVIEW.md',
    token: 'plugins/todo/todo-txt.js',
    reason: '同上：2026-10-08 评审记录的行号坐标；todo 插件已由 M5 改名 com.pet.todo，历史坐标保留不搬',
  },
];

// ---- R-A：md 相对链接可达 ----
// 解析锚点两个都试：仓库书写的「根相对」惯例（R5 link-check 口径）+ markdown 标准的
// 「文档目录相对」（T04 link-check A 节口径）。磁盘上 55 条路径链接里 26 条只有文档目录
// 能命中、7 条只有根能命中，两边并集才与卡 §3 的「真」一致。
function ruleA(docs) {
  const failures = [];
  const RE = /\[([^\]]*)\]\(([^()\s]+)\)/g;
  let checked = 0;
  let external = 0;
  for (const doc of docs) {
    const docAbs = path.join(ROOT, doc);
    for (const [i, line] of linesOf(doc).entries()) {
      for (const m of line.matchAll(RE)) {
        const target = m[2];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
          external += 1;
          continue;
        }
        if (target.startsWith('#')) continue;
        checked += 1;
        let t = target.replace(/[?#].*$/, '');
        try {
          t = decodeURIComponent(t);
        } catch {
          // 含非法转义（如裸 %）的按原文判
        }
        const ok =
          fs.existsSync(path.resolve(ROOT, t)) || fs.existsSync(path.resolve(path.dirname(docAbs), t));
        if (!ok) failures.push(`${doc}:${i + 1} [${m[1]}](${target}) 目标不存在`);
      }
    }
  }
  return { name: 'R-A', ok: failures.length === 0, failures, detail: `links=${checked} external=${external} broken=${failures.length}` };
}

// ---- R-B：§4 树对 services/ 的覆盖（双向）----
// 树解析口径同 work/R6/check-tree.mjs：只取「## 四、目录结构」下第一个代码块，
// 按 4 字符一级的树形前缀还原相对路径，`#` 注释与纯说明行不参与。
function ruleB() {
  try {
    const ls = linesOf('docs/architecture/ARCHITECTURE.md');
    const start = ls.findIndex((l) => /^##\s*四、目录结构/.test(l));
    if (start < 0) throw new Error('找不到「## 四、目录结构」');
    const open = ls.findIndex((l, i) => i > start && /^```/.test(l));
    if (open < 0) throw new Error('§4 下没有代码块');
    const close = ls.findIndex((l, i) => i > open && /^```/.test(l));
    if (close < 0) throw new Error('§4 代码块没有闭合');
    const stack = [];
    const docNames = new Set();
    for (const raw of ls.slice(open + 1, close)) {
      const m = raw.match(/^([│\s]*)(?:├──|└──)\s(.+)$/u);
      if (!m) continue;
      if (m[1].length % 4 !== 0) throw new Error(`缩进不是 4 的倍数: ${JSON.stringify(raw)}`);
      const depth = m[1].length / 4;
      let name = m[2].split('#')[0].trim();
      if (!name || name.startsWith('#')) continue;
      const isDir = name.endsWith('/');
      name = name.replace(/\/*$/, '');
      stack.length = depth;
      stack.push(name);
      if (stack.length === 4 && stack[0] === 'src-tauri' && stack[1] === 'src' && stack[2] === 'services') {
        docNames.add(`${stack[3]}${isDir ? '/' : ''}`);
      }
    }
    const diskNames = fs
      .readdirSync(path.join(ROOT, 'src-tauri', 'src', 'services'), { withFileTypes: true })
      .filter((e) => e.name !== 'mod.rs' && !e.name.endsWith('.tests.rs'))
      .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`)
      .sort();
    const diskSet = new Set(diskNames);
    const failures = [];
    for (const n of diskNames) if (!docNames.has(n)) failures.push(`磁盘有、§4 树未点名: src-tauri/src/services/${n}`);
    for (const n of docNames) if (!diskSet.has(n)) failures.push(`§4 树点名、磁盘没有: src-tauri/src/services/${n}`);
    return { name: 'R-B', ok: failures.length === 0, failures, detail: `disk=${diskNames.length} doc=${docNames.size}` };
  } catch (err) {
    return { name: 'R-B', ok: false, failures: [`§4 树解析失败: ${err.message}`], detail: 'parse-error' };
  }
}

// ---- R-C：README「目录速览」plugins/ 行点名四个插件 ----
const PLUGIN_IDS = ['com.pet.hr-ble', 'com.pet.agent-bridge', 'com.pet.todo', 'com.pet.astock'];
function ruleC() {
  const ls = linesOf('README.md');
  const start = ls.findIndex((l) => /^##\s*目录速览/.test(l));
  if (start < 0) {
    return { name: 'R-C', ok: false, failures: ['README.md 找不到「## 目录速览」小节'], detail: `ids=0/${PLUGIN_IDS.length}` };
  }
  let end = ls.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = ls.length;
  const hit = ls.slice(start + 1, end).findIndex((l) => /^\s*-\s*`plugins\/`/.test(l));
  if (hit < 0) {
    return { name: 'R-C', ok: false, failures: ['速览里找不到以 `plugins/` 开头的条目行'], detail: `ids=0/${PLUGIN_IDS.length}` };
  }
  const lineNo = start + 1 + hit + 1;
  const line = ls[lineNo - 1];
  const failures = [];
  for (const id of PLUGIN_IDS) {
    if (!line.includes(id)) failures.push(`README.md:${lineNo} 速览行未点名插件 id: ${id}`);
  }
  return { name: 'R-C', ok: failures.length === 0, failures, detail: `ids=${PLUGIN_IDS.length - failures.length}/${PLUGIN_IDS.length}` };
}

// ---- R-D：路径形反引号引用必须在磁盘上存在 ----
// 判定形状（卡 §3）：按正斜杠归一后，首段恰好是以下七个仓库顶层目录之一。
// 端点片段（stock/get 等）与 ~ / %VAR% 机器路径会因首段不在这七项里自然出界 —— 不是启发式，
// 是"首段必须在仓库根真实存在"的机械判定；`services/…`、`commands/…` 这类短形源码引用
// 同理出界（卡 §6：按仓库内路径处理即可，不得当断链）。
const PREFIXES = ['src', 'src-tauri', 'plugins', 'docs', 'packages', 'tests', 'tools'];
function normalizeRef(raw) {
  let t = raw.trim().replace(/\\/g, '/');
  t = t.split('::')[0]; // cdp.mjs::openSettingsInvoker → cdp.mjs
  t = t.replace(/:(\d.*)$/, ''); // http.rs:36-44, 89-90 → http.rs
  t = t.replace(/^\.\//, '');
  t = t.replace(/[.,;，。、]+$/, '');
  return t;
}
function ruleD(docs) {
  const failures = [];
  const RE = /`([^`\n]+)`/g;
  let checked = 0;
  let exempted = 0;
  for (const doc of docs) {
    for (const [i, line] of linesOf(doc).entries()) {
      for (const m of line.matchAll(RE)) {
        const raw = m[1].trim();
        const t = normalizeRef(raw);
        if (!t.includes('/')) continue;
        if (!PREFIXES.includes(t.split('/')[0])) continue;
        if (PLACEHOLDER_SHAPE.test(raw) || raw.includes('://')) {
          exempted += 1;
          continue; // 模板占位 / 协议写法
        }
        if (EXEMPT_PREFIXES.some((e) => t.startsWith(e.prefix))) {
          exempted += 1;
          continue;
        }
        if (EXEMPT_TOKENS.has(t)) {
          exempted += 1;
          continue;
        }
        if (EXEMPT_FILE_TOKENS.some((e) => e.file === doc && e.token === t)) {
          exempted += 1;
          continue;
        }
        checked += 1;
        if (!existsRel(t)) failures.push(`${doc}:${i + 1} \`${raw}\` → ${t} 磁盘上没有`);
      }
    }
  }
  return { name: 'R-D', ok: failures.length === 0, failures, detail: `checked=${checked} exempted=${exempted} broken=${failures.length}` };
}

// ---- R-E：链接文字与目标文件名一致 ----
function ruleE(docs) {
  const failures = [];
  const RE = /\[([^\]]*)\]\(([^()\s]+)\)/g;
  let pairs = 0;
  for (const doc of docs) {
    for (const [i, line] of linesOf(doc).entries()) {
      for (const m of line.matchAll(RE)) {
        const text = m[1].trim();
        const target = m[2];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        if (!/\.md$/i.test(text)) continue;
        pairs += 1;
        const nameOf = (s) => s.replace(/[?#].*$/, '').replace(/\\/g, '/').split('/').pop();
        if (nameOf(text) !== nameOf(target)) failures.push(`${doc}:${i + 1} 文字「${text}」与目标「${target}」文件名不一致`);
      }
    }
  }
  return { name: 'R-E', ok: failures.length === 0, failures, detail: `pairs=${pairs} mismatched=${failures.length}` };
}

// ---- R-F：AGENTS.md 字节预算 ----
const AGENTS_LIMIT = 6000; // 清单原文 5KB 与「技术决策」整节 2982 字节物理冲突，PM 拍板 6000（勿改回）
function ruleF() {
  const size = fs.statSync(path.join(ROOT, 'AGENTS.md')).size;
  const failures = size > AGENTS_LIMIT ? [`AGENTS.md = ${size} 字节，超上限 ${AGENTS_LIMIT}`] : [];
  return { name: 'R-F', ok: failures.length === 0, failures, detail: `bytes=${size} limit=${AGENTS_LIMIT}` };
}

// ---- R-G：§4 树全量核对（卡 R8）----
// 树还原口径与 work/R6/check-tree.mjs 一致：只取「## 四、目录结构」下第一个代码块，
// 按 4 字符一级的树形前缀还原完整相对路径；`#` 之后的注释不参与，纯说明行（名字以 # 开头）跳过。
// 本规则与 ruleB 分工：ruleB 的 services 双向核对原样保留，R-G 负责全树（反向面随卡 R8 §2 口径）。
function parseArchTree() {
  const ls = linesOf('docs/architecture/ARCHITECTURE.md');
  const start = ls.findIndex((l) => /^##\s*四、目录结构/.test(l));
  if (start < 0) throw new Error('找不到「## 四、目录结构」');
  const open = ls.findIndex((l, i) => i > start && /^```/.test(l));
  if (open < 0) throw new Error('§4 下没有代码块');
  const close = ls.findIndex((l, i) => i > open && /^```/.test(l));
  if (close < 0) throw new Error('§4 代码块没有闭合');
  const found = [];
  const stack = [];
  for (const raw of ls.slice(open + 1, close)) {
    const m = raw.match(/^([│\s]*)(?:├──|└──)\s(.+)$/u);
    if (!m) continue;
    if (m[1].length % 4 !== 0) throw new Error(`缩进不是 4 的倍数: ${JSON.stringify(raw)}`);
    let name = m[2].split('#')[0].trim();
    if (!name || name.startsWith('#')) continue;
    const isDir = name.endsWith('/');
    name = name.replace(/\/*$/, '');
    stack.length = m[1].length / 4;
    found.push(`${[...stack, name].join('/')}${isDir ? '/' : ''}`);
    stack.push(name);
  }
  return found;
}

// R-G 反向面的纳管口径（卡 R8 §2，目录级）：白名单 = 必须在 §4 树里出现的顶层模块；
// 排除表 = 产物/临时/流水线目录（每条带理由）。磁盘上的顶层目录必须命中二者之一，
// 都不中标 → 红（不许用"遍历全部子目录"的写法，也不许新顶层目录静默漏过）。
const TOP_CHECKED = [
  'src',
  'src-tauri',
  'plugins',
  'integrations',
  'packages',
  'tests',
  'tools',
  'docs',
  'assets',
  '.github',
  'public',
];
const TOP_EXCLUDED = new Map([
  ['dist', 'Vite 构建产物（.gitignore 覆盖），存在与否取决于本机是否构建过'],
  ['node_modules', '依赖目录（.gitignore 覆盖）'],
  ['temp', '临时目录（.gitignore 覆盖）'],
  ['release-package', '本地打包产物（.gitignore 覆盖），存在与否取决于本机是否打过包'],
  ['.git', '版本库元数据'],
  ['.dispatch', '派单流水线工作区（.gitignore 整目录覆盖，含台账与卡片，只在本地）'],
  ['.workbuddy', '外部 AI 助手产物（.gitignore 覆盖）'],
  // AgentTeams 团队会话的运行时目录（team.json + inbox/*.jsonl）：只在成员本机存在、不进仓库，
  // CI 检出里没有它；不收口的话任何人在团队工作区跑 check:docs 都会被 R-G 判红（t8 收口）。
  // 只排除这一个目录，别改成通配/前缀豁免——那会把别的未知顶层目录一起放过去。
  ['.agent-teams', 'AgentTeams 团队运行时目录（team.json / inbox，未入库；本工作区才有，CI 检出里不存在）'],
  ['.vscode', '编辑器本地配置（.gitignore 整目录覆盖，不入库）'],
]);

// R-G 反向面的显式放行名单：e2e 套件运行时写进 plugins/ 的探针插件（tests/e2e/harness/fixtures.mjs），
// 正常收尾会自行删除，崩溃/被杀时残留。逐个目录名登记（禁止 zz.* 前缀、禁止通配）：前缀放行等于
// 把以后误建的 plugins/zz.anything 一起放过——那正是 t22 卡面要求不许发生的放水。
// 名单外的目录（哪怕只差一个字符）照旧走 `磁盘有、§4 树未点名` 判红。
const E2E_PROBE_PLUGIN_DIRS = new Map([
  ['zz.probe', 'verify-isolation / verify-release：writeFixtures() 的权限探针'],
  ['com.zz.spoof', 'verify-isolation / verify-release：目录名与 manifest.id 不一致的剔除探针'],
  ['zz.net', 'verify-isolation / verify-release：按域名逐个授权的网络探针'],
  ['zz.consent', 'writePreseedFixtures()：ADR-0013 同意合流探针'],
  ['zz.hookprobe', 'writePreseedFixtures()：Agent hook 收件探针'],
  ['zz.hookundeclared', 'writePreseedFixtures()：未声明 agent.hooks 权限的探针'],
  ['zz.status', 'writePreseedFixtures()：状态归一化探针 A'],
  ['zz.status2', 'writePreseedFixtures()：状态归一化探针 B'],
]);

function ruleG() {
  try {
    const treePaths = parseArchTree();
    const docSet = new Set(treePaths);
    const failures = [];
    let checked = 0;
    let exempted = 0;
    for (const rel of treePaths) {
      const norm = rel.replace(/\/+$/, '');
      const hit = EXEMPT_PREFIXES.some((e) => {
        const p = e.prefix.replace(/\/+$/, '');
        return norm === p || norm.startsWith(`${p}/`);
      });
      if (hit || EXEMPT_TOKENS.has(norm)) {
        exempted += 1;
        continue;
      }
      checked += 1;
      if (!existsRel(norm)) failures.push(`§4 树有、磁盘没有: ${rel}`);
    }

    // 反向：磁盘 → 树（顶层目录分类必须覆盖磁盘现状）
    let reverse = 0;
    const need = (rel, why) => {
      reverse += 1;
      if (!docSet.has(rel)) failures.push(`磁盘有、§4 树未点名: ${rel}（${why}）`);
    };
    const topDirs = fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const d of topDirs) {
      if (TOP_CHECKED.includes(d)) need(`${d}/`, '顶层模块');
      else if (!TOP_EXCLUDED.has(d)) failures.push(`顶层目录 ${d}/ 不在白名单也不在显式排除表——分类必须显式维护`);
    }
    // 领域成员：src/ 子目录、src-tauri/src 的根模块与 services/window/commands 成员、
    // plugins/ 每个插件 id、packages/ 与 tests/ 子目录、docs/ 四个子目录（卡 R8 §2 的目录级口径）
    const dirNames = (rel) =>
      fs
        .readdirSync(path.join(ROOT, rel), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${e.name}/`)
        .sort();
    for (const d of dirNames('src')) need(`src/${d}`, 'src 子目录');
    const crateRoot = fs
      .readdirSync(path.join(ROOT, 'src-tauri', 'src'), { withFileTypes: true })
      .filter((e) => e.isDirectory() || (e.isFile() && e.name.endsWith('.rs')))
      .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`)
      .sort();
    for (const m of crateRoot) need(`src-tauri/src/${m}`, 'crate 根模块/子目录');
    for (const sub of ['services', 'window', 'commands']) {
      const members = fs
        .readdirSync(path.join(ROOT, 'src-tauri', 'src', sub), { withFileTypes: true })
        .filter((e) => e.name !== 'mod.rs' && !e.name.endsWith('.tests.rs'))
        .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`)
        .sort();
      for (const m of members) need(`src-tauri/src/${sub}/${m}`, `${sub} 成员`);
    }
    // e2e 探针目录：按 E2E_PROBE_PLUGIN_DIRS 的**名字精确匹配**跳过（不做前缀匹配），
    // 名单外的目录照旧判红，见名单定义的注释。
    let probes = 0;
    for (const d of dirNames('plugins')) {
      if (E2E_PROBE_PLUGIN_DIRS.has(d.replace(/\/+$/, ''))) {
        probes += 1;
        continue;
      }
      need(`plugins/${d}`, '插件 id');
    }
    for (const d of dirNames('integrations')) need(`integrations/${d}`, '外部集成 id');
    for (const d of dirNames('packages')) need(`packages/${d}`, 'packages 子目录');
    for (const d of dirNames('tests')) need(`tests/${d}`, 'tests 子目录');
    for (const d of dirNames('docs')) need(`docs/${d}`, 'docs 子目录');

    return {
      name: 'R-G',
      ok: failures.length === 0,
      failures,
      detail: `tree=${treePaths.length} checked=${checked} exempted=${exempted} reverse=${reverse} excl=${TOP_EXCLUDED.size} probeSkip=${probes} broken=${failures.length}`,
    };
  } catch (err) {
    return { name: 'R-G', ok: false, failures: [`§4 树解析失败: ${err.message}`], detail: 'parse-error' };
  }
}

// ---- R-H：文档里的坐标必须对读者可达（清单 R4）----
// 两条子判据，都只按形状判，不用「看着像不像」的启发式：
//   H1 反引号 token 以盘符开头（`D:\…`、`c:/…`）→ 红。机器绝对路径只对写它的那台机器成立，
//      CI 全新 checkout 与第三方助手都打不开；S6 那句「仓库内 grep 不到 D:/test」由这条钉住。
//   H2 首段是 `.dispatch`（派单工作区，.gitignore 整目录覆盖）的 token 必须**同行**含「不入库」→ 否则红。
//      R-D 按设计看不见它（判定要求首段命中七个入库顶层目录），所以「文档把唯一证据点写到库外」
//      这件事只有这条拦得住。引用本身可以留（历史坐标有价值），但必须当场写明它在库外、读者去哪儿找。
function ruleH(docs) {
  const failures = [];
  let checked = 0;
  let exempted = 0;
  for (const doc of docs) {
    for (const [i, line] of linesOf(doc).entries()) {
      for (const m of line.matchAll(/`([^`\n]+)`/g)) {
        const raw = m[1].trim();
        const norm = raw.replace(/\\/g, '/');
        const isDrive = /^[A-Za-z]:[\\/]/.test(raw);
        const isWorkspace = norm.split('/')[0] === '.dispatch';
        if (!isDrive && !isWorkspace) continue;
        if (EXEMPT_TOKENS.has(norm)) {
          exempted += 1;
          continue; // 显式例外表：带出处的常量，不是启发式
        }
        checked += 1;
        if (isDrive) {
          failures.push(`${doc}:${i + 1} 机器绝对路径进了文档（改成仓库根相对路径）: ${raw.slice(0, 90)}`);
          continue;
        }
        if (!line.includes('不入库')) {
          failures.push(`${doc}:${i + 1} 指向派单工作区却没在同一行写「不入库」: ${raw.slice(0, 90)}`);
        }
      }
    }
  }
  return {
    name: 'R-H',
    ok: failures.length === 0,
    failures,
    detail: `checked=${checked} exempted=${exempted} broken=${failures.length}`,
  };
}

// ---- R-I：正式文档里不许有「本次提交」占位（清单 G8-01）----
// 提交列只有两种合法写法：真实短哈希，或显式「未提交」（工作树/未入库）。
// 「本次提交」在下一批人读到时就已过期，属于台账漂移，必须当场拦。
function ruleI(docs) {
  const bad = '| B9 | 示例卡 | 回归 | **待排** | — | 本次提交 |';
  const good = ['| B9 | 示例卡 | 回归 | **待排** | — | `abc1234` |', '| B9 | 示例卡 | 回归 | **待排** | — | 未提交 |'];
  const hits = (s) => (s.includes('本次提交') ? 1 : 0);
  if (hits(bad) !== 1 || good.some((g) => hits(g) !== 0)) {
    return {
      name: 'R-I',
      ok: false,
      failures: ['R-I 自检未通过：正反例判据失效（含占位必须红、真实提交号/未提交必须绿）'],
      detail: 'selftest-failed',
    };
  }
  const failures = [];
  let checked = 0;
  for (const doc of docs) {
    for (const [i, line] of linesOf(doc).entries()) {
      if (!line.includes('本次提交')) continue;
      checked += 1;
      failures.push(`${doc}:${i + 1} 出现「本次提交」占位（改成真实提交号，或显式写「未提交」）`);
    }
  }
  return { name: 'R-I', ok: failures.length === 0, failures, detail: `checked=${checked} broken=${failures.length}` };
}

// ---- R-J：HOST-BACKLOG 状态板卡号不许重复（清单 G8-01）----
// 状态板是「一卡一行」的台账：同一卡号两行会让状态列自相矛盾（2026-10-28 清账前有两行 S3）。
// 只扫状态板小节，不把卡面正文里的同名引用算进来。
function boardCardIds(text) {
  const ids = [];
  let inBoard = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      inBoard = line.includes('状态板');
      continue;
    }
    if (!inBoard) continue;
    const m = /^\|\s*([A-Z][A-Za-z0-9]*)\s*\|/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}
function duplicateIds(ids) {
  const seen = new Set();
  const dup = new Set();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    else seen.add(id);
  }
  return [...dup].sort();
}
function ruleJ() {
  const wrap = (rows) => `## 1. 状态板\n\n${rows}\n`;
  const badRows = [
    '| S3 | 发布旧版 | 已完成 | — | `abc1234` | — |',
    '| S3 | Worker 卡 | 已放行 | — | `def5678` | — |',
  ].join('\n');
  const goodRows = [
    '| S3 | 发布旧版 | 已完成 | — | `abc1234` | — |',
    '| B7 | Worker 卡 | 已放行 | — | `def5678` | — |',
  ].join('\n');
  const badDup = duplicateIds(boardCardIds(wrap(badRows)));
  const goodDup = duplicateIds(boardCardIds(wrap(goodRows)));
  if (badDup.length !== 1 || badDup[0] !== 'S3' || goodDup.length !== 0) {
    return {
      name: 'R-J',
      ok: false,
      failures: ['R-J 自检未通过：正反例判据失效（重复卡号必须红、唯一卡号必须绿）'],
      detail: 'selftest-failed',
    };
  }
  const rel = 'docs/process/HOST-BACKLOG.md';
  const ids = boardCardIds(read(rel));
  const dups = duplicateIds(ids);
  return {
    name: 'R-J',
    ok: dups.length === 0,
    failures: dups.map((id) => `${rel} 状态板卡号重复: ${id}（一卡一行；重号请并入或改号）`),
    detail: `rows=${ids.length} dups=${dups.length}`,
  };
}

// ---- 跑 ----
function safeRule(name, fn) {
  try {
    return fn();
  } catch (err) {
    return { name, ok: false, failures: [`规则执行抛错: ${err.message}`], detail: 'crash' };
  }
}
const jsonMode = process.argv.includes('--json') || process.env.npm_config_json === 'true';
const docs = docList();
const results = [
  safeRule('R-A', () => ruleA(docs)),
  safeRule('R-B', () => ruleB()),
  safeRule('R-C', () => ruleC()),
  safeRule('R-D', () => ruleD(docs)),
  safeRule('R-E', () => ruleE(docs)),
  safeRule('R-F', () => ruleF()),
  safeRule('R-G', () => ruleG()),
  safeRule('R-H', () => ruleH(docs)),
  safeRule('R-I', () => ruleI(docs)),
  safeRule('R-J', () => ruleJ()),
];
const failing = results.filter((r) => !r.ok).length;

if (jsonMode) {
  console.log(
    JSON.stringify(
      { rules: results.length, failing, results: results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail, failures: r.failures })) },
      null,
      2,
    ),
  );
} else {
  for (const r of results) {
    console.log(`[${r.name}] ${r.ok ? 'ok' : 'FAIL'} ${r.detail}`);
    for (const f of r.failures) console.log(`  - ${f}`);
  }
  console.log(`RESULT rules=${results.length} failing=${failing}`);
}
if (failing > 0) process.exitCode = 1;
