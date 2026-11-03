# 插件开发手册（给参与开发的 AI 助手）

读者：被派来写插件的 AI 助手。你的产物是 `plugins/<id>/` 一个目录 + 一个运行时回归脚本，
**不改宿主本体**。想改本体先停下来提出来，由负责评审的助手评估（见文末「越界了怎么办」）。

## 0. 先读这三份，顺序别换

| 文档 | 看什么 |
|---|---|
| [PLUGIN_SDK.md](PLUGIN_SDK.md) | API 面：目录结构、生命周期、能力清单（§3）、`ctx`（§4）、widget 约定（§5）、共享资源（§6）、已知边界（§8） |
| 本文 | 交付标准、硬性规则、我们踩过的坑、自检清单 |
| [../../AGENTS.md](../../AGENTS.md) | 项目级约定与「验证」小节；`docs/architecture/ARCHITECTURE.md` 是宿主设计，写插件一般不用读 |

评审标准见 [PLUGIN-REVIEW.md](PLUGIN-REVIEW.md)，任务池见 [PLUGIN-BACKLOG.md](PLUGIN-BACKLOG.md)。

## 1. 环境

```bash
npm install
npm run dev:debug      # 终端 1：带 WebView2 远程调试端口（9223）启动
npm run verify         # 终端 2：宿主回归（147 条）
```

- Windows + Node 24。**cargo 在 `%USERPROFILE%\.cargo\bin`，新开的 shell 要手动加进 PATH**，
  否则 `dev:debug` 会卡在「找不到 cargo」。
- 只写插件时不需要碰 Rust；`npm run build`（tsc + vite）能过就说明你没弄坏前端。
- 插件目录改动**不需要重启宿主**：在设置窗把该插件关掉再打开即可（宿主按文件 mtime 给模块 URL 加版本串）。
  Vite 不 watch `plugins/`，不会有热重载。
- 单实例锁：dev 实例和便携包**共用**标识。如果桌面上已经跑着 `release-package\DesktopPet-0.2.0\desktop-pet.exe`，
  你起的 dev 会立刻退出且没有任何提示 —— 先确认 `Get-Process desktop-pet` 只有一个。

## 2. 交付物清单（缺一项就是没做完）

1. `plugins/<id>/manifest.json`：`id` 必须等于目录名；`permissions` 写全（未声明的能力被宿主**直接拒绝**，不是弹框）。
2. `plugins/<id>/index.js`：主逻辑。**分层**：纯函数（解析、判定、格式化）和副作用（网络、存储、定时器）分开，
   纯函数要能被 `import` 直接断言。参照 `plugins/com.pet.astock/market.js` + `rules.js` + `throttle.js`。
3. `plugins/<id>/widget.js`（有界面才要）：badge / overlay / settings 三个区共用一份文件。
4. `tests/e2e/verify-<id>.mjs` + `package.json` 里一条 `verify:<id>`：**真机端到端断言**，不是单元测试。
   照 `tests/e2e/verify-astock.mjs` 的结构写（`attach` / `hostInvoke` / `waitUntil` / `createReport` 来自 `tests/e2e/harness/cdp.mjs`）。
   跑完必须自己收尾：撤销授权（连带清存储）、把插件下线、恢复 `host:enabled-plugins` 原值。
5. 文档：如果新增了能力或改了约定，同步 `PLUGIN_SDK.md` 的能力表与本目录的约定条目。
6. 提交：`git add` 只加自己动过的路径（**不要用 `git add -A`**，工作区里有别人的东西），
   提交信息中文、说明「为什么」。**不要 push。**

## 3. 硬性规则（每条都有代价，别绕）

1. **外部数据一律 `textContent`，绝不拼进 `innerHTML`。** BLE 广播名、HTTP 响应、别的插件的 payload 都是不可信输入；
   closed Shadow DOM 不阻止 `<img onerror>` 执行。同理不要把外部值拼进 CSS 选择器字符串。
2. **不碰宿主 DOM 和 canvas**，只往 `mount(root, ctx)` 给你的 `root` 里写。
3. **清理表按挂载实例存（`WeakMap`，键是 `root`），不要用模块级数组。** 同一个 widget 文件会同时在三个区被挂载，
   模块级数组会让第一个卸载的人把别人的退订函数全清空 → 订阅永久泄漏。见 `com.pet.astock/widget.js` 的 `scopes`。
4. **设置页必须回显当前配置。** 面板是在另一个窗口新建的，拿不到插件的历史数据；直接渲染默认值会造成
   「配置没保存」的错觉，而且用户动一个开关会把没显示的另一项写回默认。做法：每次状态变化都 `ctx.widget.update(全量配置)`，
   面板挂载时订阅 `<id>:widget` 并据此设控件。宿主的 `bus_peek` 回灌**只在你真的推送过之后**有效。
   回显还要带**防冲写守卫**：控件正被用户编辑（`activeElement` 命中、或本地的「刚选/刚输入」标记未消费）时，
   不要把远端状态整片写回控件 —— 否则一次状态推送会把用户敲了一半的阈值、刚选的 `<select>` 抹回旧值
   （Bug4 的形态，`com.pet.astock` 与 `com.pet.goat-gauge` 的设置页都踩过；`verify:astock` / `verify:goat-gauge`
   各有一条「改了未应用 → 推送不冲掉」的断言）。这份守卫是**源码级共享**：契约与参考实现写在
   [PLUGIN_SDK](PLUGIN_SDK.md) 的「6.1 设置页回显与防冲写（编辑锁）」，两处实现分别在
   `com.pet.astock/views/settings/lock.js` 与 `com.pet.goat-gauge/views/settings/lock.js`；插件之间不能互相 import
   （`petplugin://` 只服务插件自己的目录），所以新插件复制实现时必须保留来源注释，改契约时所有副本一起改。
   照抄时把「哪些控件算正在编辑」写成常量，别散在回调里。
5. **自己的 `setInterval` / `setTimeout` 自己在 `deactivate()` 里清。** 宿主只回收总线订阅和 widget。
6. **不要用 `requestAnimationFrame` 给插件逻辑计时**：宠物因游戏模式隐身时 rAF 可能仍在跑也可能被节流。用 `setInterval` 或事件驱动。
7. **`ctx.bus.subscribe` 这个 API 本身就要在 manifest 声明 `bus:subscribe`**，不声明会在激活时被拒
   （`todo 未在 manifest 声明这些能力: bus:subscribe` 就是这么来的）。
8. **topic 前缀**：只能发布 `<你的 id>:` 前缀；订别人/宿主的 topic 要精确名字，不允许通配。
   多文件共享的 topic 常量抽到 `topics.js`，别在两个文件里各写一遍字符串。
9. **别把大 payload 塞进 `<id>:widget`。** 那是 badge/overlay/settings 三方都在收、且会跨窗中继的视图。
   序列/明细类数据单开一条 `<id>:xxx`，只在需要它的区域订阅（见 `com.pet.astock:panel` 的理由）。
10. **出网走 `ctx.http.request`，按域名逐个授权**，键不带默认端口（`https://x.com` 的键是 `x.com`）。
    首次访问新域名会弹一次同意框 —— 多域名就是多次弹框，这是设计，不是 bug。
11. **徽标（badge）没有内容时什么都别挂**。宿主按"插槽外壳有没有布局尺寸"判你有没有内容，
    空框会被当成有内容并占用一轮 5 秒的轮播位（ADR-0010 决策 1，详见 SDK §5.2）。
12. **悬浮卡的位置由你自己决定并自己存进 `ctx.storage`**：`overlay.show({ x, y, height })` 收逻辑像素，
    宿主只做屏内夹紧，不持久化、不预设锚点、不支持拖拽。别再传老的 `placement`（接受、忽略、告警，行为已变）。

## 4. 我们踩过的坑（照抄能省一轮返工）

| 坑 | 症状 | 做法 |
|---|---|---|
| overlay 显隐是 IPC | 刚 `show` 就 `deactivate` 去 `destroy`，后到的 `show` 把卡重新点亮；固定 `sleep` 赌不赢 | 显隐排成一条串行链，`deactivate()` 先 `await` 链再 `destroy`（`com.pet.astock/index.js` 的 `overlayChain`） |
| 公共行情/天气类接口 | 偶发直接掐连接（`fetch failed` / rustls unexpected-eof），无文档无配额，按行为模式识别反爬 | 所有出网收进一个口子：最小间隔 + 滚动窗口上限 + 传输层失败重试一次 + **429/403 或连续失败进阶梯冷却**；无进展时指数退避；节拍加抖动。见 `throttle.js` |
| 界面默默不更新 | 用户以为插件挂了 | 节流/冷却状态推给界面（「近 1 分钟出网 N 次」「限流冷却 Xs」） |
| 数据形态随时段变 | 断言在盘前/收盘跑就红 | 断言写成时段无关：「有价才比大小、无价必无量」，不要用固定 sleep 等异步 |
| 字段魔数/编码 | 中文名乱码、接口静默丢字段 | **先实测再写解析**，拿第二个独立源交叉验证（我们用腾讯 GBK 盘口对东财字段号）；把口径和「为什么这么写」记进代码注释与 AGENTS.md |
| CSP 只在打包版生效 | dev 一切正常，`tauri build` 产物黑屏/加载失败 | 涉及新脚本源、图片源、协议，收尾必须跑 `npm run verify:release`；判断 CSP 不能用 CDP 求值（它不受 CSP 约束），要看页面自身代码的副作用 |
| 测试脚本造窗口 | 全屏置顶窗 + `timeout` 杀父进程会耗尽会话 desktop heap（真发生过，只能强制重启） | 测试窗**非置顶、任务栏可见、定时自关**，脚本自己检查父进程存活；**不要在外层套 `timeout`** |
| 还在传 `placement:"above-pet"` | 卡不报错，但**落在桌面 (24,24)**，不再贴头顶 —— 头顶那一档已由 ADR-0010 删除 | 改传 `{ x, y, height }`（逻辑像素）并把坐标存进你自己的 `ctx.storage`；宿主只夹紧 |
| 徽标空态画了个空框 | 你那一格被宿主判成"有内容"，白占 5 秒轮播位，用户点开是空的 | 没有内容就**整块不挂**（`badge.remove()` / 不 append），别用 `display:none` 藏 —— 那会让尺寸判据恒为 0 |
| widget 里 `setAttribute("type", …)` | 输入框成不了数字框，而且**不抛错**（表外名字是静默拒收，拒满 64 次实例自锁） | `type` 走 property（`el.type = "number"`）；只有 `name` 这类走 attribute。词表看 `src/runtime/widget-protocol.ts` |
| 坐标类断言用对称值（x=y） | 接线把 x/y 对调了，全套件照样绿 —— 本项目真漏过一次 | 断言用**非对称坐标**，并分别对命令侧（物理像素×`devicePixelRatio`）与页面侧（逻辑像素）两条通道 |
| 杀进程 | `pkill -f` / `taskkill /IM` 会连带杀掉工具自身的进程 | 只按 PID + 可执行路径精确杀 |
| 临时文件 | 污染工作区 | 只进 `<仓库>/temp/`，收尾删干净；打包产物进 `<仓库>/release-package/`（**不要放 `dist/`**，那是 Vite 输出目录，每次 `npm run build` / `tauri build` 都会把它清空，已经丢过两次成品包） |

## 5. 交活前自检

```bash
npm run build                 # tsc + vite 必须过
npm run verify                # 宿主回归（CDP 驱动真实运行时）；条数会随形态漂，别拿数字当门
npm run verify:<你的 id>       # 你自己写的端到端
```

- [ ] 关掉再打开插件能生效；停用后定时器停了、订阅回收了、悬浮窗收了
- [ ] 设置页打开时改一次配置，重开设置页配置还在（回显）
- [ ] **徽标在没有内容时什么都不挂**（空框会被宿主判成"有内容"，白占一轮轮播位）
- [ ] **有悬浮卡就验一次落点**：`plugin:window|outer_position`（物理像素，乘 `devicePixelRatio`）
      或页面侧 `screenX/screenY`（逻辑像素），**用非对称坐标**（x≠y）—— 对称坐标连 x/y 对调都看不出来
- [ ] 撤销授权后存储目录被清，再启用会重新弹同意框
- [ ] 界面里没有任何一处把外部值拼进 `innerHTML` 或 CSS 选择器
- [ ] `permissions` 里的每一项都真的用到；用到的每一项都声明了
- [ ] 你的 verify 脚本跑完把状态还原了（授权撤销、插件下线、enabled 列表复原）
- [ ] 改了宿主侧 `src/runtime/widget-protocol.ts` 的词表？那 `unit:migrate` 与 SDK §5.1 必须同步
- [ ] `temp/` 已清空；没有留下你起的进程（按 PID + 可执行路径核对，`Get-Process desktop-pet` 只做计数）

## 6. 越界了怎么办

需要下面任何一项时，**停下来写清楚需求，不要自己改本体**：

- 新的宿主能力（剪贴板、文件系统、开机时间、音频焦点、前台窗口标题…）
- 改 `src-tauri/` 任何文件、`src/` 宿主运行时、CSP、`tauri.conf.json`
- 新增跨会话生效的系统级开关（这类命令一律只认设置窗，判定在 `src-tauri/src/gate.rs`）
- 想加 Rust 依赖（会撑破 `tauri build` 的版本一致性，历史上踩过）

宿主侧确实缺能力的，先按「插件内能做到的最接近版本」交付，并在 PR 描述里列出缺口。
真正的隔离边界（同 realm 插件可绕过 JS 桥）要等 Web Worker 宿主，本阶段不假装已解决。
