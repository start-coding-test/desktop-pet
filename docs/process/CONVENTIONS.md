# 约定与验收明细

本文件承接 `AGENTS.md` 移出的明细条目：流程与交付、实施步骤、验收标准与套件索引、数据源口径、宿主门禁与安全边界，以及其余长期约定。
移出的原因：`AGENTS.md` 每次会话都要整份进模型上下文，而下面这些条目只在做对应的一类改动时才需要查阅；那里只留索引与硬约束。
搬家规则：条目正文原样搬运、只改实测数字；分组的判据是条目的开头文字，开头对不上任何一组的都留在「其余约定」。

## 流程与交付

- **评审波次（2026-10-08）**：[docs/process/CODE-REVIEW.md](docs/process/CODE-REVIEW.md) 的 45 条已逐条核过并修掉可复现的部分。两条不成立，别再照着"修"：P0 #1（Tauri 2 的 `Window::emit` 走 `manager().emit`，本来就向全部 webview 广播，跨窗总线一直是通的，`verify:todo` 的桌面卡片就是它的运行时证据）；P2 #32（`request()` 里 includes 与优先级判断的先后没有可观察差异 —— 会打断的请求根本不进队列）。

- **协作分工（2026-10-11 起，全项目）**：本会话任**项目经理**——需求拆分、规划、派单、验收；**实现一律交给外部敏捷开发模型**，本会话不接自己的卡（发布/工程类 `S` 卡除外）。四份文档是这条流水线的接口：
  [docs/plugin-dev/PLUGIN-HANDBOOK.md](docs/plugin-dev/PLUGIN-HANDBOOK.md)（接活者的交付标准与坑清单）、
  [docs/plugin-dev/PLUGIN-REVIEW.md](docs/plugin-dev/PLUGIN-REVIEW.md)（评审口径，含「先取证再下结论」与两次误判先例）、
  [docs/plugin-dev/PLUGIN-BACKLOG.md](docs/plugin-dev/PLUGIN-BACKLOG.md)（插件域任务卡、派单模板、需要宿主新能力才能做的提案区、已否决项）、
  [docs/process/HOST-BACKLOG.md](docs/process/HOST-BACKLOG.md)（本体/构建发布/文档域的派单模板、状态板、**验收证据矩阵**：哪类改动必须跑哪个 verify 套件与其断言下限）。
  派单时复制对应 BACKLOG §0 的模板（插件用 PLUGIN-BACKLOG，本体/工程用 HOST-BACKLOG）；
  评审时按 REVIEW §7 的格式输出，「已核不成立」一节必须写，**断言只许变严不许变松**。
  规划方不凭「看起来缺」自行开需求卡，**候选插件 A1–A7 已被用户否决（2026-10-10）**：不要主动提"再加个 XX 插件"，新需求等用户直接提。

- **派单工作区 `.dispatch/` 不入库（清单 S6 → R4，2026-10-15 定）**：`.dispatch/<功能名>/` 里放台账 `ledger.md`、`cards/`（任务卡）、`results/`（执行回传）、`work/`（取证与变异脚本）、`prompts/`（启动语），`.gitignore` 整目录覆盖；2026-10-15 的历史重写把旧副本连同整目录从库里摘掉了，仓库外的备份在 `D:/test/git-purge-backup-20261015`。三条后果，都是别人踩过的：
  ① **新波次的功能名一律 ASCII**（`arch-p2` 这种）。已有的中文目录（`.dispatch/A股盯盘质量加固/`，工作区、不入库）属历史波次，保留原名不改——改名会让备份与旧引用两头对不上。
  ② **入库文档不许把唯一证据点写在工作区里**。被 ADR／评审／BACKLOG 当依据引用的取证件要收进库（例：`docs/process/T16-WIDGET-REALM-GAPS.md` 就是 ADR-0008 的输入，原来只在工作区，谁都打不开）；台账与卡片这类过程稿留在工作区，确实要留历史坐标的，**同一行写明「不入库」**。这条由 `npm run check:docs` 的 **R-H** 机器拦，它同时拦反引号里的盘符绝对路径（文档坐标一律按仓库根相对写，CI 与第三方才打得开）。
  ③ 进度事实源是本地 `ledger.md`，它不在库里 ⇒ 换机器先取备份；交给外部助手的只有 docs 下那三份接口文档，不是卡片原文。

- **便携包出到 `release-package/`，不要出到 `dist/`**：`dist/` 是 Vite 的输出目录，任何 `npm run build` / `tauri build`
  都会把它清空 —— 已经因此丢过两次成品包。产物 = `release-package/DesktopPet-<版本>/`（exe + 旁边的 `plugins/` + 更新说明.txt）
  + 同名 zip，`.gitignore` 已覆盖。重出前先核 `src-tauri/target/release/desktop-pet.exe` 的 mtime 晚于
  `src/` 与 `src-tauri/` 的最后一次提交，否则是过期二进制；插件是磁盘加载，改 `plugins/` 不需要重编本体。

## 实施步骤

1. **脚手架 + 宠物窗** ✅
2. **插件运行时** ✅
3. **Rust 能力服务** ✅（store / http 白名单代理 / notify / BLE / 权限同意框均已实现）
4. **三个示例插件**：`heart-rate-ble` ✅、`com.pet.todo` ✅（纯插件、零本体改动）；`llm-token-usage` 暂缓（用户决定）
5. **文档收尾**：[docs/plugin-dev/PLUGIN_SDK.md](docs/plugin-dev/PLUGIN_SDK.md) ✅
6. **桌宠形象改由 Petdex 提供**：九状态图集渲染 ✅ + 设置窗按名字安装 + 默认形象 `deepseek`（本波次）

## 验收标准与套件索引

- `npm run tauri dev` 启动：透明置顶宠物显示并播放 idle 动画，可拖拽，托盘可用 ✅
- plugins/ 目录放入/移除插件后生效 ✅（目录 watcher + 设置窗启停）；单插件异常不崩溃宿主 ✅
- 有应用全屏时宠物自动隐身并停止动画，退出后恢复 ✅（`npm run verify:game` 15 条）。隐身由宿主命令 `set_pet_hidden` 统一负责：宠物窗与贴在它身上的 overlay 悬浮 UI（状态卡、心率波形）一起收放，恢复时按插件当时的意愿重新显示
- 心率插件可扫描/连接并显示实时 BPM ✅；`llm-token-usage` 未做
- 待办插件可增删改勾、桌面卡片、到期提醒，并广播标准 topic `com.pet.todo:changed` ✅（`npm run verify:todo` 30 条）。字段照 todo.txt 约定，数据只存插件自己的隔离存储
- 断开后可直接重连同一设备，不必重新扫描（代码级修复：扫描不再清空句柄缓存，缓存未命中时回落 `adapter.peripherals()`）。**本机无蓝牙硬件，未经真实心率设备验证**
- 设置窗安装 Qoder hook 后，Agent 的工具调用/等确认/结束/失败能驱动宠物 ✅（`npm run verify:agent` 50 条断言）。**已用真实 Qoder 会话验证**：hook 确实被调用、事件按形状落盘并驱动宠物；状态卡贴在宠物头顶显示会话状态、工具名与步数，一轮结束 3 秒后自动收起
  （**这句是 2026-09-30 当时的形态**。「宠物头顶」那一档已由 [ADR-0010](../adr/0010-badge-visibility-overlay-position-and-window-layering.md) 决策 3
  从宿主整体删除（`134dfce`），agent 桥现在传 `placement:"above-pet"` 会被接受但忽略、卡落在桌面 `(24,24)`；
  卡片本体的移除归 B3（ADR-0010 决策 6），**别把"现在在左上角"读成 B3 已完成**。现行断言集见 `verify:agent`（79 条，`bfd9951` 起位置断言按请求坐标判）
- 设置页两级导航：**侧栏只有「宠物设置」+ 插件列表**（一个插件一条），点插件进去是宿主给的壳（启停 / id / 权限 / 撤销授权）+ 插件自己用 `widget.js` 的 `settings` 区渲染的页面；「宠物设置」里收全部非插件配置（形象 / 快捷键 / 自启 / Agent 接入 / 游戏模式）；搜索框过滤的是插件导航项 ✅（`npm run verify` 的「侧栏结构 / 点插件 → 插件页 / 搜索过滤」三组：切页只留一个面板、停用不挂页且说明原因、启用后 widget 挂进来、离开时摘干净）
- 全局快捷键唤出插件页、开机自启 ✅（非法组合键被拒、`CommandOrControl` 这类跨平台 token 可用、改键成功并归一化、自启与快捷键只认设置窗）
- **点击穿透的原点缓存必须跟着窗口走**：`click-through.ts` 用 `tauri://move` 的**载荷位置**刷新原点（不要再回一趟 `outerPosition`，那会在页面重载时制造在飞 IPC），并保留穿透态下的定期重读兜底。系统拖拽会吞掉 `mouseup`，所以 `main.ts` 以「按键已松开」的 mousemove 认定拖完并复位 `dragEngaged` —— 少了这一步，穿透再也不会上开，宠物整块挡鼠标。真鼠标回归见 `temp` 期手工跑过的 SendInput 三步（第一次能拖、拖完仍可点、能连第二次）
- 未授权能力调用被拒绝且触发同意框 ✅；SDK 文档 ✅
- 宠物按 petdex 九状态播放真序列帧（图集 8×9 / 8×11、单元格 192×208）✅（`npm run verify` 的「petdex 图集几何与九状态切片」组）
- 设置窗输入 Petdex 名字（如 `deepseek`）即从公开画廊下载并换装，默认形象 `deepseek`，切换不必重启 ✅（`npm run verify:skin` 28 条：真网络安装 boba、目录穿越被拒、安装类命令只认设置窗、换装后宠物窗不重启就解码新图集、删掉当前形象回落默认）。**它钉的是「当前形象必须是已安装列表里的某一个」，不是钉死 `deepseek`** —— 后者把用户状态当宿主不变量，用户换过一次装就整片红（2026-10-15 实测：换成 qwen 后红 3 条）；随包默认形象仍在列表里单独钉一条。收尾也从此不再替用户做选择：跑完把形象还回用户原来挑的那个（旧写法走宠物窗发 `pet_skin_use`，而那条命令自己被第 2 组断言钉着「宠物窗必被拒」，所以它一直是个静默空操作）。画廊安装要下图集 + zip 各 2.4 MB，实测 2026-10-15 上午整条链路 > 20s，套件的 CDP 求值默认上限会把红写成「调试端点失去响应」，故这两次调用单独给 90s。已用真实截图确认宠物窗里播的就是画廊下载的默认形象
- 上述大部分由 `npm run verify` 的运行时断言把守（见「约定」），不是靠人工回归

## 数据源口径

- **东财公开接口的三处坑（2026-10-09 实测，改 `market.js` 前先看）**：① `stock/get` 的**五档字段（买 f19/f20…f11/f12、卖 f39/f40…f31/f32）只在省略 `fields` 参数时才返回**，显式点名会被静默丢掉（实测 `fields=f43,f11,f12,f19,f20` 只回 f43）；`f51/f52` 是交易所给的涨/跌停**价**（主板 10%、创业/科创 20%、北交所 920xxx 30%），比按代码前缀猜准，但 ST 拿到的仍是 ±10%。**同一份 `stock/get` 里 `f43`（最新价）与 `f19`/`f39`（买一/卖一）来自不同时刻的聚合**：2026-10-13 盘中对 600519 连采 10 次有 3 次「现价 > 卖一」，越界幅度恰好一个最小变动价位（0.01）—— 所以运行时断言**不许写 `买一 ≤ 现价 ≤ 卖一`**（正确的数据也会随机红），要写成「现价在 `f44/f45` 的当日高低区间内」+「与买一/卖一的越界不超过一个 tick」，后者照样能抓住字段错位。② `kline/get` 的 `klt=102/103`（周K/月K）**实测退化回日K**（内容与 `dktotal` 与 101 完全相同），所以 `KLINE_PERIODS` 里不放周/月；`trends2` 的最后一列是**当日累计均价**，而 `kline` 的同一列是**换手率**，别当同一字段复用。③ 北交所新代码段 `920xxx` 是 9 开头但市场号是 **0**，`secidOf` 里必须排在「9=沪」前面判掉（早先会把 920185 拼成 1.920185 查不到）。
- **腾讯/新浪后端的字段口径（2026-10-09 与 10-10 实测，改 `market.js` 多源那批解析前先看）**：① 腾讯 `qt.gtimg.cn` 一行 88 段、`~` 分隔，**北交所那行是 87 段** —— 段位校验要按「对齐到 48 段」写，别硬卡总数等于 88。`3` 现价 `4` 昨收 `6` 成交量(手) `9..18` 买五 `19..28` 卖五（价/量交替）`47/48` 交易所给的涨/跌停价（沪主板 ±10%、创业板 +20%、北交所 ±30% 三例实测吻合，语义等价东财 `f51/f52`，**不要按代码前缀猜幅度**）；涨跌停不供时是 `-1`，必须落成 `null` 参与比较。**提醒判定（`rules.js`）的封板优先用这个价**：有价按价判（不再依赖 pct 与"顶在最高价"），只有该源不供价（东财批量快照、新浪、-1/0）才回落到 `limitPct` 的前缀表——北交所（92/4/8 开头，口径与 `secidOf` 一致）已在回落表里补成 30%，ST 的 5% 判不出、不假装解决。② 分钟 K 只能走 `kline/mkline`（`fqkline` 上 m1/m5/m15/m30/m60 返回 200 但**没有任何数组**）；日/周 K 走 `fqkline`，且**北交所只回当日 0~1 根** —— 少于 2 根判「该源不供这个标的的历史」，别拿一根冒充历史。③ 分时响应自带 `qt` 段，昨收就地取，没有额外请求；面板优先用主轮询快照的 `prevClose`，让平盘基准线和行情表一致。④ 新浪 `hq.sinajs.cn` 必须带 `referer`，量是**股**（÷100 才等于腾讯的手），**没有涨跌停字段**，且收盘后盘口段被清成 0 —— 所以它只做价格兜底、不供五档。⑤ **跨源时间戳不可直接比大小**：东财是秒 epoch、腾讯是 `YYYYMMDDHHMMSS`、新浪是日期+时间，且腾讯与新浪对同一收盘时刻的措辞能差约 40 分钟。解析层一律归一成 epoch 毫秒，`progressOf` 在切源那一轮不判进展、也不计入退避 —— 否则「换了家源」会被当成价格不动，把退避间隔越拉越长。⑥ 新浪对不存在的代码回空串：整行解不出名字与价格就丢掉，**整批都这样才判源失败**；否则一个坏代码会被当成「取数成功、1 条」，把上一轮的真价格挤掉。
- **插件侧的悬浮窗显隐要排成一条链**（`com.pet.astock/index.js` 的 `overlayChain`）：`show`/`hide` 是 IPC，刚发完一次 `show` 就 `deactivate()` 去 `destroy`，后到的 `show` 会把卡重新点亮 —— 固定 sleep 赌不赢，`verify:astock` 的「停用后卡收掉」就是这么炸的。`deactivate()` 先 `await overlayChain` 再 destroy。
- **A股插件的所有出网必须过 `index.js` 的 `out()`**，不许直接调 `ctx.http.request`。东财这套公开接口没有配额也没有文档，服务端按行为模式识别反爬，`throttle.js` 里那套节制的依据是：① 一次批量快照就把全部自选（≤40 secid）带走，**股票数量不增加请求数**；② 全局最小间隔 350ms + 滚动 60 秒窗口 30 次上限，最坏约 0.4 次/秒、24 次/分钟，比常见反爬阈值低 1–2 个数量级；③ 传输层失败（实测偶发 `fetch failed` / rustls unexpected-eof）在 `out()` 里重试一次，而 **429/403 或连续 3 次失败进 1→5→15→30 分钟阶梯冷却**，冷却期主轮询直接跳过 —— 被拒之后继续按原节奏撞等于把临时限流坐实成长期封禁；④ 行情时间戳连续不前进（休市/停牌/节假日）就按 2 的幂把间隔退避到 30 分钟封顶，有进展立刻恢复，避免 7×24 空转；⑤ 定时器节拍加 ±15% 抖动，不做完美等间隔。**故意不伪装成浏览器 UA**：我们的量不需要伪装，自称 `DesktopPet/0.1` 更容易被判定为正常客户端；真被封了该降频率而不是换马甲。节流状态走 `*:widget` 的 `net` 字段显示在插件页（「近 1 分钟出网 N 次」「限流冷却 Xs」），别让用户看到默默不更新。
- **本机对东财行情主机的通路会漂，不许把「某家源必坏」写进断言（2026-10-09 实测不可达，2026-10-12 实测已恢复）**：`push2` / `push2his` 曾在约 100ms 内 `ECONNRESET`（死在 **TLS ClientHello**，HTTP 请求还没产生，所以换 `user-agent`、补浏览器头、换目标 IP 都无效），而 `www` / `quote` / `emweb.securities` / `searchadapter` / 腾讯 / 新浪 / `baidu` / `petdex.dev` 全通 —— 拦截按 `push2*` 这批主机来；**2026-10-12 同一台机器上 `push2.eastmoney.com` 与 `push2his.eastmoney.com` 已能正常建连**（根路径回 404，说明 TLS+HTTP 通了）。结论：这是分域、随时段变的网络状态，不是代码属性。客户端唯一有效的手段是换源。`verify:astock` 已按 **A11**（2026-10-12）改成**源无关但仍严格**：套件开头做 preflight（逐 host 探可达性，结论用 `r.info` 进报告），各条源断言按「本轮可用性 + 插件回显的失败明细」分支判定（判定层 = `tests/e2e/harness/astock-source-branch.mjs` 纯函数，全通 / 有坏源 / 只有新浪三种形态都有离线单测钉住）；全通时换源或请求数撞满多家照旧判红。改动前先看报告里的 preflight 行确认是哪一类网络状态，别照着「全绿」验收

## 宿主门禁与安全边界

- 跨会话生效的系统级开关一律**只认设置窗**（指的是**设置窗这个 realm**、不再是"只有宿主代码能碰"：`agent:hooks` 已把 hook 配置开给声明了该能力的插件设置页，边界靠 manifest 声明 + 同意框，见 ADR-0001）：`autostart_set`、`hotkey_set`、`hotkey_test`、`permission_list`、`permission_revoke`、`plugin_enabled_set`、`agent_hooks_*`（与 `pet_skin_install/use/remove` 同一套门禁，判定收在 `src-tauri/src/gate.rs`，新增这类命令在那儿加一行即可；命令带可选 `pluginId` 时再加一层能力校验，见 `gate::plugin_capability`）；`settings_show` 反过来只认宠物窗，免得插件页面把设置窗弹来弹去。回归要调这些「只认设置窗」的命令，就用 `tests/e2e/harness/cdp.mjs::openSettingsInvoker` 从设置窗发起，别在宠物窗里指望它放行
- **store / 总线 / overlay 的能力门禁收在 Rust 侧（S1–S3，2026-10-12）**：`store_get/set/delete` 查 `storage`；`bus_publish` 要 `pluginId` + topic 落在 `<pluginId>:` 前缀内 + 已授权 `bus:publish`（`<id>:widget` 认 `widget`），且只有宠物窗 / 设置窗 / 悬浮窗能中继（同意框一类窗口直接拒）；`overlay_show/hide/destroy` 查 `overlay` 且调用窗口必须是宠物窗、设置窗或该插件自己那扇窗（归属由宿主注册表判定）。这三条兜的都是「绕过 JS 桥直接 invoke」——以前只有桥上面挡着，与自述的能力模型不符。**宿主的回收面是分开的**：插件停用走 `overlay_reclaim`（`gate::pet`），撤销授权与孤儿授权回收时 Rust 内部直接收窗，因为那时能力已经没了、走插件面门禁反而留下没人能关的置顶窗
- **插件启停清单归宿主（C1，2026-10-12）**：`<app_data>/plugins-enabled.json` 是唯一事实来源（`services/enabled.rs`，原子写、id 过 `ids.rs` 词表、空表与「还没写过」区分开）。以前它躺在 WebView 的 localStorage 里 —— 清一次 WebView 缓存用户给的启停就全没，而它决定哪些插件被激活。读写分三个命令：`plugin_enabled_list`（任何窗口可读）、`plugin_enabled_set`（只认设置窗）、`plugin_enabled_migrate`（只认宠物窗，且只在文件不存在时写入，返回宿主认定的那份）。运行时每个窗口持一份同步缓存（`loadEnabled()` 取，`getEnabled()` 读），reconcile 每次都向宿主重取。**回归脚本别再写 `host:enabled-plugins`**：用 `tests/e2e/harness/cdp.mjs` 的 `readEnabledIds` / `writeEnabledIds`（写需要设置窗的 invoker）。
- **BLE 命令也查授权表**：`ble_start_scan/stop_scan/connect/disconnect/connected_device` 都收 `pluginId` 并逐项校验 `ble:scan`/`ble:connect`（JS 桥负责传）。以前只有桥上面挡着，绕过桥的插件可以自由扫描连接
- **widget 跑在哪个 realm 看插槽壳上的 `data-widget-realm`**：closed shadow root 里面外部读不到，壳的 dataset 是唯一取证点（`widget-host.ts` 的 `createSlot` 戳的）。取值有三个：`host` / `worker` / **`blocked`** —— apiVersion 没到渲染契约那一版的旧 widget 在**取 widget 文件之前**就被拦下，插槽里显示一行可读迁移提示而不是白屏（`2163de4`：`legacyWidgetReason(manifest, pinnedRaw)`，判定排在 `widgetUsesWorker` 之前）。**被点名进宿主 realm 例外名单的插件不受这道拦**，逃生门照旧可用。翻默认之后，`verify` 与 `verify:release` 里那个页面级探针 `zz.probe` 的 widget **必须**点名留在宿主 realm：
它要测的是「页面自身代码在 CSP 下能不能 eval、能不能注 `<style>`」，结果写进 `window.__probes` 由页面 realm 读 ——
放进 Worker 那些就不成立了。这条点名顺带就是「例外名单在真实装载路径上管用」的证据，`verify` 里有一条 realm 戳断言钉它。
同一时间四套运行时套件各钉一条 realm 戳断言：`verify`（hr-ble 的 badge）273 条、`verify:todo`（badge）36 条、`verify:agent`（settings）79 条、`verify:astock`（settings）159 条上下。读戳用 `tests/e2e/harness/widget-realm.mjs` 那三件套（点名 / 读戳 / 等戳），别在套件里各写一份选择器。
- **http 授权键不带默认端口**：宿主算的键必须与桥申请的 `new URL(url).host` 一致。早先用 `port_or_known_default()` 会给 https 凭空补出 `:443`，于是**任何 https 请求都判未授权**；本地测试地址带显式端口（`http://127.0.0.1:9`）两边恰好一致，所以这个错一直藏着 —— 加 https 相关断言时别只用带端口的地址
- **http 按响应 `Content-Type` 的 charset 解码**（`services/http.rs::decode_body`）：只认 `gbk` / `gb2312` / `gb18030` 三个标签（大小写与键名都不敏感，认 `text/html;charset=gbk;` 这种写法），其余一律保持原来的 UTF-8 lossy —— 不猜编码，既有插件不会漂移。腾讯（`charset=GBK`）与新浪（`charset=GB18030`）的实时接口因此才可用。**为什么必须在宿主解**：腾讯行情用 `~` 分段而名称段排在所有数字段之前，GBK 的尾字节允许 `0x7E`（就是 `~`，实测「硚」= `b3 7e`），lossy 之后会变成一个真分隔符，后面每个字段整体挪一位 —— 把「今开」读成「现价」，**静默错价比显示乱码严重**；而字节到 JS 侧已经丢了，救不回来
- **http 的重定向由宿主逐跳跟**：ureq 设 `redirects(0)`，`http.rs::send_following_redirects` 自己走，每一跳的新 host 都要重新过 `http:<host>` 授权（否则授权一个域名就能被 302 弹到内网 / `169.254.169.254`）；跨主机时不带 `authorization`/`cookie`
- **插件身份仍是自报的**：`store_*`、`overlay_*`、`http_request`、`bus_publish` 的 `pluginId` 由调用方给出，能力授权现在都在 Rust 侧查了（见上一条），但同 realm 里插件 A **冒名 B** 仍然拦不住（要等 Web Worker 宿主）。已收紧的两条边角：`overlay_show` 只给确实装着的插件开窗；id 词表在 Rust 侧与前端 `validateManifest` 的字符集对齐
- **插件 id 只有一份校验实现**：`src-tauri/src/ids.rs::is_safe_id`（S4）。原先 `commands::plugins`、`services::permission::valid_id`、`services::store` 各写一套，后两套只挡 `..` `/` `\`，`C:` 这类盘符 id 能过 —— id 同时是存储目录名、overlay 标签来源与授权表键，口径必须唯一。**新增带 `pluginId` 的命令一律走 `gate::plugin_capability`**，漏了会被 `src-tauri/src/gate_coverage.rs` 拦下：它从 `lib.rs` 的 `generate_handler!` 反查全部已注册命令，逐条核对是否过了门禁（只走窗口门禁的例外要写进它的 `WINDOW_GATED` 名单并说明理由）
- **命令体必须是薄层（A1，[ADR-0005](../adr/0005-command-layering-thin-command-bodies.md)）**：一条 `#[tauri::command]` 只许做「参数与 id 校验 → 门禁判定 → **一次**委托 → 映射返回值」。机器拦三条：命令体里出现 IO 原语（`fs::` / `File::` / `read_to_string` / `read_dir` / `remove_file` / `reqwest` / `send()`）即红；命令体非空行 > 20 即红；命令 Err 侧出现裸 `String`（不是 `{code, message}`）即红（S3，2026-10-14 A07 收口后升成拦截项）—— `npm run check:shape`，CI 里紧跟在 `check:docs` 之后。业务规则一律抽成能力域内的函数好离线单测；`Peripheral`/`AppHandle` 在测试里构造不出来的那些判定，拆成只吃布尔或纯数据的函数（`device_lacks_heart_rate`、`consent_outcome`、`plan_active_after_removal` 是样板）。**新增命令与它的能力同模块**，不要往 `src-tauri/src/commands/` 搬目录——48 条里 41 条本来就在能力域，搬家不改一个函数体，只把账付在 `§4` 树、`gate_coverage` 反查和 CI 上
- **命令错误统一成 `{code, message}`（A2，[ADR-0007](../adr/0007-unified-command-error-codes.md)）**：48 条注册命令的 Err 侧全是 `HostError`；码表唯一来源是 `packages/sdk/error-codes.json`（Rust 用 `include_str!`、TS 直接 import **同一份磁盘文件** —— 改一边两侧测试都红），12 个码不许改名、要拆细只能加新码。`message` 逐字保持原样，所以 `verify` 里按文本判的断言不受影响。命令 Err 侧用没用规范形状由 `npm run check:shape` 的 S3 拦截（读数 42 → 0 之后升成门禁，2026-10-14）。前端 `legacy` 码保留、不改名（ADR-0007 规则 2）：它只兜 **Tauri 框架自己发出的裸字符串错误**（命令名写错、参数序列化失败这类），不再是「未迁移命令」的迁移标记。
- Agent watcher 的偏移只在**真的消费掉整行**之后才前进（`complete_line_prefix` 有单测）：以前先写偏移再读，hook 写一半时那批事件永久丢

- **插件样式注入契约暂不收紧**：打包版 CSP 的 `style-src` 保留 `'unsafe-inline'` —— 三个示例插件都用「运行时往自己的 Shadow Root 注入样式表」的写法，且 `tests/e2e/verify-release.mjs` 里有一条断言在替第三方插件作者钉这个契约；真要收紧必须先做 Web Worker 宿主并逐条实测 U-1…U-7。另一类（markup 里的内联 `style=` 属性）已由 M2a 清零，所以这条豁免只覆盖「style 元素」。取舍全文见 [ADR-0004](docs/adr/0004-style-src-unsafe-inline-kept.md)
### 从 AGENTS.md 搬入：安全边界共识、Rust 侧已覆盖范围、CSP 生效面（A17，2026-10-22）

下面三段正文自 `AGENTS.md` 原样搬入，一字未改（只改实测数字这条也遵守：本节没有数字需要改）；搬出原因是 R-F 给 `AGENTS.md` 的预算只有 6000 字节，而它每次会话整份进上下文。出处按搬运前的行号记：`AGENTS.md` 原第 25 / 27 / 29 行。

**安全边界共识**：进程内 JS 插件不是硬安全边界，v1 以「manifest 权限声明 + 能力校验 + 首次授权弹窗」做策略层；桥接 API 面向未来设计，后续可平滑切换到 Web Worker 宿主实现真隔离。为此插件不得直接操作 DOM/画布，widget 一律运行在各自的 Shadow DOM 容器内。

已落到 Rust 侧、有回归断言覆盖的部分：请求的能力必须等于 manifest 声明（`http:<host>` 视为被 `http` 覆盖）、同意框只能由它自己的窗口应答且插件名只认磁盘 manifest、插件目录名必须等于 manifest.id、`bus_publish` 的 origin 由宿主按调用窗口判定、存储按 id 隔离且原子写、订阅侧只认公开 topic。**仍然拦不住的**：同 realm 的插件自己 `import { invoke }` 绕过 JS 桥（多插件共用宠物窗，宿主无法从窗口身份区分是哪个插件）—— 这条要等 Web Worker 宿主才能收口，改动时不要假装它已解决；`settings` 区点名落宿主 realm 那条已收口（S3）：一律进 Worker，例外只对 badge / overlay 生效。

**CSP 只在打包产物生效**：`tauri dev` 的文档由 Vite 直出，Tauri 没有注入点，`devCsp` 同样无效；打包版则以 `content-security-policy` **响应头**下发（文档里没有 meta）。判 CSP 是否强制不能用 CDP/DevTools 发起的求值（不受 CSP 约束），要看页面自身代码的副作用。


## 其余约定

- **带打包（NSIS）的构建在这台机器上是跑通了的（2026-10-16 实测，两轮都 0 退出）**：工具链落在
  `%LOCALAPPDATA%\tauri\NSIS`，落成之后就会被复用（第二次 2m22s，日志零 `Downloading`）。
  **别把这个目录当缓存删掉** —— 它没有版本标记文件，删了就要重新联网。产物落
  `src-tauri/target/release/bundle/nsis/`，按发布口径另存一份到 `release-package/`（**不放 `dist/`**，
  那是 Vite 输出目录、每次构建清空）。这条门再红时**先探 URL 再定性**：
  `curl -o /dev/null -w "http=%{http_code}"` 打一次 `nsis-3.11.zip`，GitHub release 资产通路和 A股 push2
  一样是状态量，历史上的 `timeout: global` 就是网络态不是配置错。装机运行（安装器跑起来）仍未证明，
  细节与否证记在 [本体任务卡](HOST-BACKLOG.md) 的 S1 段。
- 标准事件 topic：`ble:heart-rate`、`agent:state`（`running｜needs_input｜completed｜idle`，只在变化时广播）、`agent:event`（细粒度 hook 事件：phase / toolName / detail / steps / title，每次工具调用都发）、`llm:token-usage`、`com.pet.todo:changed`
- 宿主窗口事件（不是总线 topic，插件收不到）：`host:fullscreen`（`{active,title}`，最近 3 次采样的多数票）
- Agent 会话状态：`Stop` 之后 2 秒内到达的 pre/post 算迟到事件，不再把会话打回 running（否则卡片会挂着「正在执行」直到 90 秒 TTL 过期）；新一轮的 user-prompt/session-start 立刻作废该宽限期
- topic 归属：`<插件id>:` 前缀归该插件。插件只能**发布**自己前缀；**订阅**他人/宿主 topic 除声明 `bus:subscribe` 外，还必须是**公开 topic**（`packages/sdk/topics.js` 的 `PUBLIC_TOPICS` = 五条标准 topic + `ble:device-found`/`ble:disconnected`/`ble:error`）—— 其他插件的私有 topic 一律拒（2026-10-17 / ADR-0011 收紧；此前「声明了 bus:subscribe 就能订任意 topic」），且**不允许通配**越过自己的前缀
- 能力名见 docs/plugin-dev/PLUGIN_SDK.md 第 3 节；新增能力时要同时更新桥、Rust 校验与那份表格
- 共享资源（BLE 会话、BLE 扫描）按插件持有者计数，释放只对真正的持有者生效；overlay 悬浮窗**按插件各开一扇**（标签 `overlay-<id>`，页面按标签认归属），摆放/尺寸/显隐互不影响 —— 早先共用一扇窗导致「后打开的卡片显示不出来」，改成按插件分开后两扇可同时存在
- 插件存储位置：`%APPDATA%/com.desktoppet.pet/plugins/<id>`（插件间隔离，撤销授权会连带清目录）
- **热键设置目录隔离（A31，2026-10-26）**：debug 构建可被 `PET_SETTINGS_DIR` 重定向（仅绝对路径；release 由 `cfg!(debug_assertions)` 编译期裁掉，安装版不读）。CI 的 job env 与 `dev-debug` GATE 都指 `<仓库>\temp\settings-e2e`；`verify-isolation` 只读隔离副本的内容，真实 `%APPDATA%\com.desktoppet.pet\settings.json` 只比 sha256/是否存在、不读内容。`%APPDATA%` 本身改不了 `app_data_dir()`（Windows Known Folder API），别拿它当隔离开关。
- 首批插件目录：`plugins/com.pet.hr-ble`（已做）、`plugins/com.pet.agent-bridge`（已做：订阅宿主 `agent:state` 把编码 Agent 的会话状态转成宠物反应）、`plugins/com.pet.todo`（已做：目录名与 id 一致，标准 topic `com.pet.todo:changed` 落在它自己的命名空间里）、`plugins/com.pet.astock`（已做：A股盯盘，出网走宿主 http 代理按域名授权，数据源东方财富公开接口；自选+提醒+badge/overlay，插件页另有分时/K线/五档面板。**2026-10-09 K线与分时已加腾讯后端**：`market.js` 的 `MARKET_SOURCES` 源注册表，每个源一套自己的列序映射（腾讯是「开收高低」，与东财同序不同实现），先试上一次成功的源、一个源内部再主入口→两个后备入口；快照与五档仍只有东财一条，等阶段二。**2026-10-10 阶段二落地**：四个 kind 都有多源，快照/五档为「东财 → 腾讯 `qt.gtimg.cn` → 新浪 `hq.sinajs.cn`」，新浪只兜价格、不供五档与涨跌停）、`plugins/llm-token-usage`（暂缓）
- 面板（分时/K线/五档）只在设置页活着时刷：`PANEL_TTL_MS` 90 秒，由设置页 widget 每 60 秒发一次 `sync` 续期（`watchView(ctx, render, { beatMs })`），badge/overlay 不续期 —— 人走了额外出网要自己停。
- `ctx.bus.subscribe` 这个 API **本身**就要在 manifest 声明 `bus:subscribe`，不声明会在激活时被拒（`com.pet.todo 未在 manifest 声明这些能力: bus:subscribe`）；ACL 放宽的只是「自己前缀不需要额外授权」，别把两者混为一谈
- **验证**：离线常驻单测有十五份文件，合计 `npm run unit` = **1249 个用例**（2026-10-17 实测；本轮 P1/P2 加固前的基线是 1236）：`unit:astock`（`tests/unit/unit-market.mjs` 247 + `tests/unit/unit-aux.mjs` 186）、`unit:runtime`（`src/` 运行时纯逻辑 107 条，含 C1 的启停清单迁移，靠 `tests/unit/ts-loader.mjs` 把 .ts 现场转译进 `node --test`，并把 `@tauri-apps/api/*` 换成 `tests/unit/tauri-stub.mjs`）、`unit:worker-host`（L1 的 Worker 通道契约：22 个方法表、派发表完备、Worker 侧入口的**传递 import 闭包**不许触及 IPC 入口 —— P2-5 起判据是 `tests/unit/import-graph.mjs` 真的把 import 图走一遍（AST 取说明符，与引号风格无关），并带一条「单引号 + 隔层」的负向对照防它空转；旧的手写正则只认双引号、只看直接 import，已删）、`unit:widget-protocol` + `unit:widget-worker`（L2 阶段二的渲染契约、Worker 侧虚拟节点与 Worker 运行时共 92 条（`2163de4` 给 apiVersion 拦截加了 8 条）：12 个 op kind 是闭集、五张名字白名单、**没有 html op 也没有 class kind**、批次在微任务里合并并按 512 切分、宿主回推事件不回声）、`unit-widget-migrations.mjs` 18 条（`npm run unit:migrate`：把插件的 widget 真跑一遍 Worker 侧运行时，离线抓残留 `document.*` 与表外名字，跑的就是生产默认那条路（widget 一律进 Worker），另有一条合成 widget 的负向对照防它空转（一个还用 `document.createElement` 的模块必须当场挂）；它还会把 mount 期间登记的每个监听都真触发一次，因为设置页大量渲染只发生在事件回调里，并有两条合成 widget 自证这条抓得到；**列表 / 盘面那类数据驱动的渲染必须按 topic 喂假 payload（`BUS_POKE`）才会被执行**，断言要求每个订阅都匹配到 payload、喂进去要多发 op —— A10 有一条「回调里用表外事件名」的变异在只跑 mount() 时存活过，就是这个缺口；迁移卡的离线取证用这个，抢不到 CDP 端口也能自验，作者临时点名用 `PET_WIDGET_SMOKE=<id>`；**判定按标题不按总数** —— 还没照契约写的 widget（那种还用 `document.createElement`）在这套冒烟里**必须**当场红，它是反向对照而不是缺陷；`PET_WIDGET_SMOKE` 点名里每多一个 id，总数就多一格）
- **改过 `src/` 之后必须先冷重启 dev 实例，再跑任何 CDP 套件（2026-10-15 实测，代价是一次误判）**：Vite dev 会给「刚被改过」的模块 URL 加 `?t=时间戳`，页面加载的是那一份；
  而套件里 `await import('/src/runtime/plugin-runtime.ts')` 用的是**不带查询串**的 URL → 那是**第二份模块实例**，
  它的 `active` / `workerHosted` 等模块级状态是空的。症状非常有迷惑性：`deactivatePlugin` 看似调用成功却什么都没关
  （`sessionCount` 仍是 2）、插件的 `deactivated` 写不出来、覆盖子模块后 `leaf` 还停在旧值 —— 看起来像产品缺陷，其实是测量工具在骗人。
  同一条判据在冷启动的实例上一次就过（阶段一 diff：热打补丁跑 3 条红，冷重启后同一套命令 28/0）。
  所以规矩写死：**动过 `src/` 或 `plugins/` 的运行时代码 → 杀掉 dev 实例重起 → 再跑套件**；
  同一实例上连跑多套本就要注意端点失联（见下面那条），现在再加一条「源码热改过就别再复用这个实例」。
- **桥的授权缓存是按「页面文档实例」活的，宿主侧 `permission_revoke` 不会让它失效（2026-10-15 A09 实测）**：`src/runtime/bridge.ts` 里的 `ensurePermissions` 先查模块内的 `granted` Map，命中就**连 `permission_check` 都不发**，更不会 `permission_request`。于是「这次调用有没有问过宿主」在连跑时变成了「这份文档重建过没有」的函数——同一台实例连跑三次实测到 **绿/红/绿**。凡是要钉「首次调用必经同意框」这类事实，**必须先 `reloadAndWait` 重建那份文档再调**，否则红的是缓存不是宿主规则。与上一条同族但方向相反：那条是模块 URL 分裂出第二份实例，这条是同一份实例里的缓存拒不失效。
- **`verify:agent` 的「轮次结束状态」那一组对并发 agent 会话敏感（2026-10-15 实测）**：宿主归一化的是收件目录里**所有**会话的状态。跑这套件时如果另有一个 Qoder 会话正在干活（**外派出去的执行会话自己就是**），它的 pre/post 事件会混进总状态，红 4 条（总状态仍是本轮完成 / 悬浮卡 3 秒收起 / 宿主广播了 idle / 会话结束后卡片收起）。既不是判据写错也不是宿主坏了：等那个会话安静下来再跑，或者别在派发执行会话的同时跑这套件。
  **污染源也包括主会话自己**（2026-10-15 取证到手）：这台机器装了全局 Qoder hook，我每调一次工具就往共享 inbox 写一条 `session_id` 是主会话的 pre/post —— 而 `PET_AGENT_CONFIG_FILES` **只重定向 hook 配置文件，不重定向 inbox**。同一条 `npm run verify:agent`：一边跑一边在会话里干活 **71 passed / 6 failed**，什么都不做等它跑完 **77/0**。
  **这条已经有隔离入口了（`d4f627f`）**：`PET_AGENT_INBOX` 覆盖收件目录，hook 分支、watcher、套件三处按同一规则取，
  `e2e.yml` 把它指到 `temp\agent-inbox`；**不设这个变量时行为与以前一样**，所以手动复演不带它时这条坑仍然成立。所以这套件的复演必须「发出去就别碰任何东西」；判据仍是同环境重跑两次，不是把断言改松。**现在有了隔离入口 `PET_AGENT_INBOX`**（2026-10-16）：宿主实例与 `verify:agent` 都带同一个目录（如 `<仓库>\temp\agent-inbox`），全局 hook 不带它、照旧写默认 inbox，两边不再串；`e2e.yml` 的 job env 已设。本机复演不带这个变量时退回旧行为，上面那条照旧成立。
- **同意框应答泵的老缺陷：「窗口在 CDP 列表里」≠「已渲出内容」（2026-10-16 定位并修掉，三轮一次的偶发红有了根因）**：
  `tests/e2e/verify-agent-bridge.mjs` 的 pump 一在页面列表里看到 `consent` 就 attach、读 `#plugin-name`/`#cap-list` 并点「允许」。
  但同意框的内容要等 `consent_details` 这条 IPC 回来才填（`src/consent/main.ts:17` 之后才是同步的填内容 + 挂监听），
  抢在那个 `await` 之前读会记下 `{ who: "", caps: [] }` 这种**假证据**，而紧接着的 click 在监听器挂上之前是空操作。
  于是「渲染恰好落在读完与点下去之间」时，框被应答掉了而账上没内容 —— 红的却是离它很远的
  「探针首次调用弹出的同意框列出了 agent:hooks」，看起来像能力清单回归。修法两条：pump 先轮询到**渲出内容**（`#cap-list` 里有 `li`
  就是那段同步尾巴跑完的可靠前置）再读再点，最多等 4 秒，超时仍照原样应答（免得宿主 60 秒超时把它误判成拒绝）；
  并新增一条硬失败「pump 应答过的每一扇同意框都渲出过内容」，把这类竞态从**静默假阴**变成点名可归因的红。
  两轮冷启动各 **80 passed / 0 failed**；把等待轮询掐成空转后这条当场翻红（不是靠"再跑一次没红"交差）。
- **`check:docs` 的 R-G 会把 `verify:agent` 的临时探针插件当成目录漂移**（2026-10-16 现场误判一次）：
  那套件的 `PROBE_ID=zz.agentconsent` 是**跑起来才写进 `plugins/`、收尾删掉**的（`verify-agent-bridge.mjs:128` 与 `:809`），
  所以与它并发跑 `npm run check:docs` 会得到 `tree=102 … broken=1` 的红。判据本身没错，是并发窗口撞上了夹具 ——
  要么等套件跑完再跑文档门，要么把它排进互斥清单。**这条与「一套件一实例」是同一条纪律的两侧**：并发不只抢 CDP 端口，也抢磁盘上的插件目录。
- **CDP 运行时套件的 CI 通路是 `.github/workflows/e2e.yml`：`workflow_dispatch` 手动触发，白名单是 `verify` / `verify:agent` / `verify:worker` / `verify:todo` / `verify:game`（清单 A3，2026-10-15 写；`verify:game` 于 2026-10-16 `ee533f8` 加入，只在点名时跑，不进默认清单）**。其余套件各有一条不能进默认清单的理由：`verify:game` 是全屏置顶窗 + 定时器（桌面堆风险，见上面那条）、`verify:release` 自占 9224 还要再编一次、`verify:astock|http|skin` 出网且数据形态随时段漂。两条形状要求：起实例前先 `npx tauri build --debug --no-bundle` 编一遍，**把编译时间挡在 `tools/wait-cdp.mjs` 的就绪等待之外**（否则那个超时看着像「webview 起不来」，其实根本没轮到它）；`verify:agent` 的写盘组要求实例带 `PET_AGENT_CONFIG_FILES`（`;` 分隔的两个路径，落在 `<仓库>/temp/a9a/`，**文件由套件自己写**），不带就是 `54 passed / 1 failed` 那种假红。本机按那几步原样复演过：等待脚本正负两支都实测（活实例上 `READY` 退 0；对着空端口 `TIMEOUT` 退 1）、`verify` **270/0**、`verify:agent` **77/0**（就是上面那条并发坑——发出去之后别再碰任何东西）。
**同一条环境教训在 2026-10-16 U01 复测时又踩了一次**：只给实例带 `PET_AGENT_INBOX`、漏掉 `PET_AGENT_CONFIG_FILES`，
`verify` 不会报红而是**少跑 15 条**（当场读数 256/0，看着像"回归缩了"）—— 两套件的假红形态不一样，
`verify:agent` 的写盘组是 `54/1`，`verify` 的 `agent:hooks` 组是静默跳过。带全两个变量冷启动复测：
**`verify` 271/0**（多的一条是 U01 的「带旧 placement 的调用仍能开窗」过渡期兼容断言）、**`verify:agent` 79/0**
（位置断言换成「按请求坐标落座」两条，见 `bfd9951`）、`verify:worker` 66/0（含 U03 第⑨组）。
**同日 U04 / U06 / U07 三张卡放行后再复测（同一环境、一套件一冷启动）：`verify` 273/0、`verify:todo` 36/0、
`verify:astock` 159/0、`verify:worker` 66/0，`tools/win-zorder.ps1` 仍 exit 0** —— 悬浮卡挪到插件自定坐标之后
「本体压住 overlay」这条没回退；159 只是那次盘面形态下的读数，判覆盖仍比标题集合。
**同日收尾两笔欠账后再复测（同一环境）：`verify` 278/0（新加「隐身再恢复」一组 5 条，r.check 唯一标题 252→257）、
`verify:agent` 两轮冷启动各 80/0（同意框那一组 +1 条，唯一标题 75→76）、`unit` 1236/0、cargo 189/0、
clippy `-D warnings` 与 fmt `--check` 退出码 0、`check:shape` 48 全 0、`check:docs` rules=8 failing=0**
（文档门那次 `broken=1` 是与 `verify:agent` 并发撞到的临时探针夹具，见上面 R-G 那条）。
**这条门已证明跑绿：run 38776535438（2026-10-16，开发机自托管 runner CHEN，跑了 verify + verify:agent）**，
  而**托管 windows-latest 已被证否**（run 38757735230：编译与起 dev 都过，之后每个进程以
  `-1073741502 = 0xC0000142`（DLL 初始化失败）退出，套件一条没跑 —— 服务会话撑不起 WebView2）。
  由此三条约束别图省事改掉：runner 标签 `desktop-pet-e2e` 只给这条工作流用（`ci.yml` 留在托管，PR/fork 不会落到开发机）；
  runner **必须以交互方式跑**（已登录桌面里 `run.cmd`，装成服务会原样复现 0xC0000142）；
  开工前先退掉自己那台宠物实例（9223 + 单实例锁，「预检」那步直接判红）。
  自托管还去掉了 `setup-node` / `actions/cache`（开发机上卡 20 分钟，run 38759736236），改为校验本机 Node 24；
  run 块写**纯 ASCII**（Windows PowerShell 5.1 按 GBK 读无 BOM 的临时脚本会解析失败，run 38773272057）；
  `verify:agent` 的收件目录用 `PET_AGENT_INBOX` 指到 `temp\agent-inbox`，全局 Qoder hook 不再串进来。
  **隔离已在 runner 上实证（2026-10-16）**：run 38832924368 跑 `verify:agent` 时 Qoder 一直在调工具，结果 **77/0**（以前同样的情形是 71/6）。
  **`verify:game` 在这条门上跑绿**：run 38832007396 **15/0**（runner chen_work）。之前两次红都是套件的问题，不是被测行为的回归：
  ① 套件探针写到默认 inbox，没读 `PET_AGENT_INBOX`，宿主收不到（`462663c`）；
  ② 「关掉开关」那组写 `localStorage` 后紧接着复原，WebView2 大约 5 秒才批量落盘，收尾步骤一硬杀，「关」落了盘、复原的那次写入丢了，下一跑从传感关闭开始，连锁 4 条假红（`c1184ad`：开跑前发现是关就临时打开，收尾时复原原值后等 6.5 秒）。
- **CI 的 node 必须与本仓开发机同大版本（2026-10-15 实测）**：`ci.yml` 曾钉 `node-version: '22'`，
  run #10（2026-10-14 17:12，node 22.23.3）挂在第 9 步 `npm run unit`，报
  `Unable to deserialize cloned data due to invalid or unsupported version.`，`failureType: 'uncaughtException'`，
  栈全在 `node:internal/test_runner/runner` 的 `processRawBuffer` —— **那是 node 测试运行器解不开子进程回传的序列化报告，不是断言失败**
  （`unit-market.mjs` 里 247 条全 `ok`，总账 `tests 977 / pass 976 / fail 1`，那 1 是文件级包装）。
  本地用同一个 22.23.3 便携版量过：单文件 `--test unit-market.mjs` **5/5 必红**，
  而 CI 那条九文件 `--test-concurrency=1` 的命令形状本地 **3/3 绿**；node 24.9.0 两种形状各 5/5 全绿
  → 判定为 **node 22 报告通道的负载相关间歇缺陷**，修法是把 CI 对齐到 24，不是改套件判据。
  复现口径记下来，下次别靠猜：`temp/` 里解压官方便携版跑同一条命令做 A/B（用完删，不碰 nvm 的符号链接）
- **跑运行时回归的两条前置（都是踩过才记的）**：
  ① `verify:agent` 的写盘组要求宿主被 `PET_AGENT_CONFIG_FILES="<仓库>\\temp\\a9a\\cfg-a.json;<仓库>\\temp\\a9a\\cfg-b.json" npm run dev:debug` 指到 temp 样例；
  不带这个变量起实例时**整组自跳**，守卫「目标文件都在 temp/ 下」当场判红（读数会变成 `54 passed / 1 failed`，看着像回归、其实是启动方式不对；带对了是 **76/0**，A09 之后）。
  样例路径必须正好是 `temp/a9a/cfg-a.json`/`cfg-b.json` —— 套件写的是这两个文件，指到别处会得到另一条「K 线/条目归零」类的假红。
  ② **跑套件期间不要改 `src/` 下的宿主模块**。Vite 会用 `?t=` 重发变更过的模块，
  而套件里按干净 URL 动态 import（如 `verify-isolation.mjs:1411` 取 `bridge.ts` 的能力缓存）会拿到**第二个实例**，
  缓存自然是空的 —— 表现成「桥缓存里少了一条能力」的假红。改完代码再起一次干净实例（或先 `reloadAndWait`）复跑，
  别急着怀疑产品。真红与否的判据是**同环境重跑两次**：数据通路类的红（东财 push2his 那轮失败）会随形态漂移，
  `verify:astock` 的条数也因此只在 152~155 间浮动，比标题集合不比数字。、`unit:plugins`（插件纯函数 53 条，现为 todo-txt；**hr-ble 的 BPM uint8/uint16 解析在 Rust 侧 `ble.rs::parse_heart_rate`，它的单测归 cargo test**）、`unit:astock-views`（插件页分节拆出的纯函数 82 条，M4b）、`unit:capabilities`（能力名单与风险面元数据 159 条，K3/S2）、`unit:manifest-schema` 90 条（K4）、`unit:sdk-topics` 24 条（K2）。**这些条数只会随波次变，验收时读 `npm run unit` 尾部的 `ℹ pass / ℹ fail`，不要拿某个历史数字当常量**（单份文件要单独跑就得带对应的 npm 脚本：`unit:capabilities` / `unit:runtime` / `unit:manifest` 需要 `--import ./tests/unit/ts-loader.mjs`，直接 `node --test` 会得到假的失败）。全部零 GUI、零联网、秒级，用 `import.meta.url` 相对解析被测源码，与 cwd 无关 —— 改 `plugins/` 与 `src/` 的纯逻辑前先跑对应的套件，断言只许增不许减；其余都是 CDP 运行时套件。`npm run dev:debug` + `npm run verify`（WebView2 CDP 驱动真实 webview 的回归断言，覆盖隔离、权限、热安装、渲染几何）；`npm run verify:game` 单跑游戏模式（真起一个铺满显示器的窗口当触发源）；该窗**非置顶、任务栏可见、10~16 秒自关**，PowerShell 每轮检查父进程是否存活，脚本被中断时自己收窗不留孤儿；跑它会抢前台，期间别的置顶程序可能短暂闪动，不要在外面套 `timeout`（2026-09-30 就是「全屏 + TopMost + 每 150ms 注 ALT + timeout 杀父进程」把用户会话压垮过一次）；`npm run verify:agent` 单跑 Agent 桥端到端（脚本直接往 Agent 收件目录写事件，宿主 watcher 负责归一化）；`npm run verify:skin` 单跑桌宠资源安装链路（会真的连 petdex.dev 下载并临时装一个第二形象，跑完自动删掉）；`npm run verify:todo` 单跑待办插件端到端（解析/落盘/广播/桌面卡片/回显，跑完撤销授权并下线）；`npm run verify:worker` 单跑 L1 的 Worker 宿主取证（临时把 `tests/fixtures/l1-probe` 装进 `plugins/`，量 realm 事实、协议层伪造、`?v=` 与 `no-store` 在 Worker 取回路径上是否成立，并断言 todo 插件真的在 Worker 里跑得动；跑完撤销授权、下线插件、删掉探针目录，见 ADR-0006；**阶段二起它还含第⑦组「宿主侧 apply」**——在真 closed shadow root 上跑一遍渲染契约：建出的树与虚拟节点一致、未知 nodeId 与表外名字被拒收并计数、反向事件只回净化快照（keydown 给按键名、change 给 value/checked）、`preventDefault` 必须由 listen op 事先声明、画布控制权真的交给 Worker（主线程再 getContext 必须抛）、拒绝越界后 session 自锁；**第⑧组「widget 接缝」**默认进 Worker、点名决定谁例外留在宿主 realm（名单按插件 id，不按区），两条路线各证一遍 realm 事实（宿主 realm 看得见 document 且没有 `ctx.dom`；Worker 路线反之）、徽标插槽没被搬丢、点名清掉后能翻回 Worker，以及「逢 call 必回」——调用面之外的方法收到的是拒绝包而不是 4 秒悬着；生产用的就是这条默认：**localStorage 的 `host:widget-realm-plugin-host` 是「留在宿主 realm」的例外名单（第三方老 widget 的逃生门，不是配置项）**（ADR-0008 决策 9 记了两步：迁移期靠代码台账，四片齐之后翻默认、删台账、点名键换名换义）；现 66 条，含 U03 加的第⑨组「徽标仲裁」8 条）；`npm run verify:astock` 单跑 A股盯盘端到端（会真出网拉行情与盘面数据、弹一次系统通知测试提醒、开一扇左上角盯盘卡、把设置页点到插件页并截图数画布像素证明图真的画出来了（**widget 进 Worker 路线后画布控制权已交给 Worker，主线程 `getContext` 必抛 `InvalidStateError`**，所以这条只能看合成后的画面：CDP `Page.captureScreenshot` 按画布矩形裁剪 → `tests/e2e/harness/png.mjs` 解码 → 数与背景的色差像素；解码器自己由 `unit-png.mjs` 七条钉住，含「空白画布必须数出 0」这条防假绿），跑完撤销授权并下线；盘前/竞价时段数据形态不同，断言按「有价才比大小、无价必无量」写成时段无关的形式，**因此它的总条数是形态相关的，判覆盖要比标题集合不要比数字**）；`npm run verify:release` 单独验打包版 CSP，每波次收尾手工跑一次（约 3~4 分钟构建，改测试脚本不带源码改动时可 `-- --skip-build` 复跑）；**它的 L1 夹具必须连 `widget.js` 一起装进打包版插件目录**（`installL1Probe()`）—— 只装 `index.js` + `manifest.json` 是翻默认之后才暴露的空档：widget 路线 404 掉，而那 24 条断言没有一条看着它，日志里的两条 `widget 起不来` 是靠「打包版没有 widget 装载失败」这条兜住的。现 30 条，其中 6 条专证打包版 widget 的 Worker 路线（realm 事实、`ctx.dom` 在、逢 call 必回、插槽 realm 戳、装载零失败）。`npm run verify:http` 单跑宿主 http 的 charset 解码链路（临时装一个只用来拿能力的探针插件、真出网请求腾讯 GBK 与新浪 GB18030、各弹一次域名同意框并断言授权键不带 `:443`，跑完撤销授权并删探针；**起手先排空上一轮遗留的授权与没点掉的同意框，并把它当成两条断言钉住** —— 2026-10-15 实测：带着残留跑，新浪那次请求直接被已有授权放行、第二扇框不弹，红的却是「两个域名各弹了一次」这种看起来像判据写错的地方，共 23 条）。**同一份 dev 实例上连跑多套 CDP 套件时先跑 `verify`**：`verify:astock` / `verify:todo` 这类会撤销授权、关窗并重载文档，跑完后调试端点可能失去响应，后跑的套件会在 `Runtime.evaluate` 上撞 20 秒超时报错（2026-10-13 实测：先 astock 后 verify 连炸两次同一个同意框后的调用，重启实例单跑 `verify` 即 219/0）。这不是被测行为的回归，遇到时重启实例复跑，别去改判据。
- Agent 接入约定：hook 事件由宿主自己收 —— `--pet-hook <phase>` 分支在建窗之前分流，落成 `agent/inbox/<phase>.jsonl`，watcher 读增量并归一化成会话状态后广播。不读 petdex、不开本地端口。phase 必须命中白名单（它同时是文件名与 CLI 参数）；安装/卸载只按 `--pet-hook` 标记增删自己的条目，不动其他 hook，写配置前先备份且原子落盘。
- 状态词表：**只有 petdex 的九个状态** `idle / running-right / running-left / waving / jumping / failed / waiting / running / review`（行号、每行帧数与整行时长见 `src/pet/petdex-states.ts`）。原来的 12 个自造状态（walk/greet/sleep/react/curious/teasing/blush/angry/night）已取消，别再往回加。`ctx.pet.react()` 只认这九个名字，Agent 桥的 phase→状态映射也照搬 petdex 的 `stateForEvent`
- 桌宠资源：磁盘位置只有 Rust `services/skins.rs` 的 skins 目录一个解析点，经 `petskin://<slug>/sprite.webp`（Windows 上即 `http://petskin.localhost/…`）读给 webview；打包版 CSP 的 `img-src` 必须包含 `http://petskin.localhost`，否则只有 `tauri build` 产物会黑屏（dev 不注入 CSP，测不出来）。D01 例外（2026-10-26，用户选 A）：v3 皮肤清单要 `fetch` 同目录 `pet.json`，打包版 `connect-src` 追加 `http://petskin.localhost` 一个来源，其余指令不动。名字解析走公开接口 `https://petdex.dev/api/manifest/v2`（`pets` 是数组的数组，列序由其 `fields` 给出，别硬编下标）
- overlay 窗口标签把 id 里的 `.` 编码成 `_`（不是 `-`）：id 词表里没有下划线，所以 `a.b` 与 `a-b` 不再抢同一扇窗；回归里的 `overlayLabelFor` 要跟着改
- 运行时的异步生命周期收在三个地方：`plugin-runtime.ts` 每个插件一条串行链（activate/deactivate 排队，弹同意框期间切开关不再产生幽灵激活）、`subscriptions.ts` 由宿主回收插件的总线订阅、`bridge.ts` 缓存会话内已授权的能力并在 `host:permission-revoked` 时失效。插件自己的 `setInterval` 不在回收范围内，仍要自己清
- 插件代码覆盖后免重启：`plugin_file_version` 给出文件 mtime，`pluginFileUrl` 给 `import()` 的 URL 拼 `?v=`（petplugin 协议按 path 找文件，查询串不影响）
- 渲染层不再逐帧烘焙：`SpriteFrame = 源矩形 + 单位化目标矩形`，57 帧共用一份已解码图集（原先 57 张 360×dpr 画布在 dpr=2 时约 118 MB），DPI 变化只需 `fitCanvas` 不必重切片；解码图集缓存按 LRU 限 2 份
- 原子写只有一份实现：`src-tauri/src/fsutil.rs::write_atomic`（tmp 名带 pid），形象 / hook 配置 / 授权表 / 插件存储 / 启停清单都走它，别再复制第六份
- std Mutex 一律 `unwrap_or_else(|p| p.into_inner())`：`panic = "abort"` 下释放版是当场 abort，但 dev 与将来可能的 catch 路径里，锁中毒不该放大成整进程退出
- 加速键字符串必须过 `services/hotkeys.rs::normalize_accel` 再注册：至少一个修饰键、恰好一个主键，`CommandOrControl`/`CmdOrCtrl` 这类跨平台 token 要认（默认值本身就用它写成，不认就会导致「恢复默认」失败）
- 宿主日志：`%LOCALAPPDATA%\com.desktoppet.pet\logs\host.log`
