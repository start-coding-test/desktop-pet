# 同意框身份只认磁盘 manifest、topic 订阅侧只认公开名单、settings 区一律进 Worker（2026-10-17 加固）

2026-10-17 对全仓通读评审后落地的 P1/P2 加固（方案见 [优化方案 2026-10-17](../process/OPTIMIZATION-PLAN-2026-10-17.md)）。
其中五条改变了**对外可观察的行为或契约**，所以先写下来：第 1–3 条是当批落地的，第 4 条是同一批里
被拆出去的 P1-1，随后由 S3 卡落地 —— 它当时没做的真实原因是套件里那组探针要按 Worker 契约重写，
不是「改一行就完」；第 5 条是同一类缺口在**读取侧**的那一半，S4 卡补上（两条见下）。

**决定：**

1. **`permission_request` 不再接受调用方自报的 `plugin_name`**；同意框上显示的名字一律从
   `plugins/<id>/manifest.json` 的 `name` 读（缺字段或类型不对时退回 `id`，
   `commands::plugins::manifest_display_name` 是唯一出口）。
2. **topic 订阅侧收紧**：跨命名空间订阅只认 `PUBLIC_TOPICS`
   （`packages/sdk/topics.js` 导出的冻结名单 = 五条标准 topic ∪ `ble:device-found` /
   `ble:disconnected` / `ble:error`）；**别人插件的私有 topic 一律拒**，不再因为声明了
   `bus:subscribe` 就放行。发布侧规则不动。
3. **`set_click_through` 补上 `gate::pet`**，并把 `let _ =` 吞错改成如实返回 `HostError`。
   它是全项目唯一没有门禁的命令。
4. **`settings` 区不再认 `host:widget-realm-plugin-host` 例外名单**：该区一律进 Worker，
   例外名单只对 `badge` / `overlay` 生效；旧接口（没写 `apiVersion: 2`）widget 在 `settings` 区的
   正确表现是**被拦下并给出可读原因**（`mountNotice`，壳上 `data-widget-realm="blocked"`），
   不是「留在宿主 realm 跑起来」。判据是纯函数（`regionForcesWorker` / `widgetUsesWorker` /
   `legacyWidgetReason` 都带上了所在区），且有离线单测钉住。
5. **`bus_peek` 增加 `plugin_id` 并校验 topic 归属**（S4，同日补上）：读 `<id>:widget` 的最近一份
   回灌时，调用方要先报自己是谁，归属照 `bus_publish` 那一套解析（悬浮窗只认宿主注册表，其余中继
   窗口才认自报值），且 topic 必须恰好是 `{id}:widget`，否则回 `None`；缺 `plugin_id` 也回 `None`
   （fail-closed）。这与第 2 条是同一类缺口的两侧：第 2 条堵的是插件「订」别人的展示数据，
   本条堵的是直接 `invoke("bus_peek")` 把别人的展示数据读走。
   插件与 widget 的订阅路径（`topic-acl` / `bridge`）传下去的是**订阅方自己的身份**，不是从 topic
   前缀解析出来的 —— 否则订别人的 topic 会自动带上别人的 id，校验就形同虚设（`unit-runtime` 里
   有一条反例专门钉这一点）。

同批落地但不构成决策（不改对外契约，只修工程面）：widget boot 加 15s 超时、
`store` 的 per-plugin 锁表改 `Weak` 回收、Worker 侧「不许带进裸 IPC」的判据从手写正则改成
**传递 import 闭包**（`tests/unit/import-graph.mjs`）。

## 为什么第 1 条算决策

同意框是**策略层的边界**本身（AGENTS.md「安全边界共识」：manifest 权限声明 + 能力校验 +
首次授权弹窗）。而「你在给谁授权」这件事以前由调用方传进来：

```
permission_request(pluginId, pluginName, capabilities)   ← pluginName 由前端给
```

绕过 JS 桥直接 `invoke` 的插件可以把这个字段填成任何一个名字。它拦不到「授权被误发」，
但让边界上最重要的一句提示变成不可信 —— 同意的对象正是「这个插件是谁」。
改动的效果是**不可逆的契约变化**：调用方再多传一个 `pluginName` 不会报错（serde 忽略未知字段），
但那份值永远不再被使用。

## 为什么第 2 条算决策

它改变了写进 PLUGIN_SDK 的插件可观察行为：以前「声明了 `bus:subscribe`」等价于
「可读任意命名空间的 topic」，现在等价于「可读自己前缀 + 公开名单」。
这条是被评审点名为「ACL 只防发布不防订阅」的缺口 —— 插件能订到别人的 `:widget`
展示数据（含自选股列表这类内容）。

收紧口径是**白名单**而不是黑名单：新增一条宿主广播 topic 时必须同时登记进 `PUBLIC_TOPICS`，
漏登记的表现是「插件订不到」（当场可见），而不是「默默放开一个别人的私有 topic」。
`tests/unit/unit-sdk-topics.mjs` 反向钉住名单与插件现场字面串的一致性。

## 为什么第 4 条算决策

设置窗的 realm **就是宿主壳的 realm**，而设置窗那套命令门禁只认 `window.label()`。被例外名单
点名、留在宿主 realm 跑的设置页因此直接拿得到 `permission_revoke` / `plugin_enabled_set` /
`autostart_set` / `hotkey_set` / `pet_skin_*` 与 hook 安装这些宿主级命令 —— 默认的 Worker 路
够不着，逃生门被点名时够得着。逃生门是给「第三方 widget 还没照渲染契约写」留的，
它不该同时开向「一扇与宿主同 realm 的窗」。

把粒度从「哪扇窗」收到「谁」在这一区做不到：同一扇窗里宿主分不出「谁」（第 2 条那条老缺口，
要等 Worker 宿主）。所以这一区干脆不再给例外名单开门。代价是第三方旧接口 widget 的设置页
显示一张迁移说明卡，收益是设置页不再有一条提权路。

上一批把它拆出去、没顺手做的真实原因不是「改法只有一行」：`verify-isolation.mjs` 的
「agent:hooks 受控能力（settings 区专属）」整组靠 `localStorage` 把探针留在宿主 realm，
事实写进 `window.__hookProbes`，探针 manifest 也没写 `apiVersion`。settings 区一律进 Worker 后
这组按原样会整组变红，得先把探针按 Worker 契约重写（`ctx.dom` 建节点 + `bus.publish` 回传事实）；
而「事实只能经总线回传」又意味着探针要先真拿到 `bus:publish` / `bus:subscribe` 授权
（两条都过 JS 桥与 Rust 两侧门禁）。所以它是「一次真机套件改造」，不是一次一行改动。

## 被否掉的做法

- **给设置窗的命令加「宿主壳凭证」**：同 realm 内不可防 —— 插件代码能 `import` 到宿主壳的模块，
  也能 `listen` 同一个事件。真正能收口只有 Worker 隔离一条路（见下）。
- **保留 `plugin_name` 形参但忽略它**：留一个「看起来还能传身份」的签名面，
  下一个人会以为它有效。签名里不该有这个位置。
- **把订阅 ACL 做成黑名单（拒已知的他人前缀）**：宿主需要另一份「所有插件 id」的实时视图，
  且新增插件时默认放开，方向正好相反。

## 已知未收口（不要当作已解决）

- **例外名单本身还在**，只是收到了 `badge` / `overlay` 两区（第三方旧接口 widget 的逃生门）。
  它不再是一条提权路：这两区的插槽本来就在各自窗口里，够不着宿主级命令。
- **能力门禁的 `plugin_id` 仍由调用方自报**，同 realm 插件之间分不出（ADR-0006 那条老缺口）。
  第 5 条（`bus_peek`）是同一处残余：绕过 JS 桥直接 `invoke` 的插件仍可自报成别人去读别人的
  `:widget` —— S4 收掉的是「不报归属也能读」这条默认路，不是这条老缺口本身。
- S3 收的是 **widget** 的分流这一条路：插件入口（`index.js`）的点名键 `host:realm-plugin-host`
  没动，那条要等 Web Worker 宿主才能一起收口。
- `http` 的域名白名单纯按域名判，对 DNS rebinding 无防护；重定向只复核 host 不复核 scheme。
  本轮未动（需要真机与专门的取证设计）。

## 追加节（2026-10-21，B10）：出站走系统代理后的边界

`ctx.http.request` 原先只直连（`ureq::AgentBuilder` 不配 proxy），所以用户开着 Clash（系统代理
`127.0.0.1:7897`）时宿主仍然出不了网。B10 让宿主**默认跟随系统代理**，判定与解析收在
`src-tauri/src/services/http_proxy.rs`（纯函数 + 平台读取各一半），`src-tauri/src/services/http.rs`
只负责按判定选路。

1. **读取顺序**：`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的
   `ProxyEnable`/`ProxyServer`/`ProxyOverride` → 环境变量 `HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY`
   （大小写都试）→ 都没有才直连。**不用** `ureq` 的 `try_proxy_from_env`：它写死的顺序是
   `ALL_PROXY → HTTPS_PROXY → HTTP_PROXY`，与本 ADR 要求的次序不符，而且它完全不读注册表。
   `ProxyEnable == 0` 是**用户显式关掉**总开关 ⇒ 整条决策就是直连，**不**再回落到环境变量
   （否则在 Clash 界面里关掉，仍会被 shell 里残留的 env 拽走）；`ProxyEnable` 根本不存在则不算
   「关掉」，继续往下档找。每次请求都问一次（TTL 5 秒只为合并同一瞬间的并发请求），
   用户开关代理不必重启宿主。
2. **两个 agent、逐跳决定**：`ureq` 2.12 的代理只能建在 `Agent` 上（请求级没有 proxy 参数），
   而「哪些目标不许经过代理」是按**目标**判的 ⇒ 直连 agent 与代理 agent 并存（`http=`/`https=`
   两种协议各一个代理 agent，注册表 `ProxyServer` 允许给它们不同端点），每一跳重新问
   `Settings::proxy_scheme_for`。重定向逐跳复核授权这条（本 ADR 第 3 条）不变，且**公网 → 内网**
   的重定向在换完目标之后不会再沿用上一跳的代理路线。`redirects(0)`、三个 timeout、跨主机摘除
   `authorization`/`cookie` 全部原样。
3. **回环与私网永不走代理**（第一道否决，压过 `ProxyOverride` 与 `<-host>` 强制项）：`localhost`、
   无点主机名、mDNS 的 `.local`（组播解析，交给 HTTP 代理本来就连不通）、`::1`、`0.0.0.0`，
   以及字面 IPv4 的 `127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`（CGNAT）、
   `192.0.0/24`、`198.18/15`、`224/4` 起；IPv4-mapped 的 IPv6 写法（`::ffff:127.0.0.1`、
   `::ffff:7f00:1`）折回 IPv4 判。运行时的反向证据是 `verify` 里那条真打
   `http://localhost:1420/…` 的断言：这道否决一旦失效，那一跳就会红。
4. **不夸口的地方**（必须连着上面一条一起读）：否决只看**字面**主机名/IP。一个解析到内网 IP 的
   公网域名**不在本节的防护内** —— 挡住它的是本 ADR 的逐域名授权（`http:169.254.169.254` 这类
   默认没人授权），不是 B10。要做「先解析再判私网」需要引入 DNS 解析（新依赖 + 新的时序攻击面），
   本轮不做。`ProxyOverride` 也**只影响选路**，不构成对插件输入的任何限制。
5. **新增的信任面**（这是本节的重点，别当成免费的功能）：开启之后，被授权域名的**目标主机名、
   端口，以及除被摘掉的凭据头以外的请求头**都会交给系统代理程序 —— 本机 Clash 时等于交给本机那
   个进程，企业/公共代理时等于交给第三方。HTTPS 走 CONNECT，正文与 TLS 仍在端点之间；明文 HTTP
   本来就是明文。用户如果不想让宿主经第三方出网，关掉系统代理或在设置里把该域名收回授权。
6. **代理 URL 的账号口令不外泄**：`ureq::Proxy` 是 `#[derive(Debug)]` 且字段带 `user`/`password`
   ⇒ 全链路不对它做 `Debug`/Display；`ProxySpec` 手写 `Debug`（口令只报「有没有」），缓存键与日志
   只带 `host:port` 与用户名；走代理时 ureq 的报错可能把代理端点带出来，所以出口统一过一遍
   `http_proxy::redact`（端点、`user:pass@host:port`、整条 URL、用户名、口令原文一律换成 `[proxy]`）。
7. **socks 条目忽略并直连**：本仓 `ureq = "2"` 没开 `socks` feature，`Proxy::new("socks5://…")`
   只会得到 `InvalidProxyUrl`。把它当 HTTP 代理用会把 CONNECT 发给一个听不懂的端口，报错又会让
   插件以为「自己没网」——所以按「这个协议没有配代理」处理：忽略该条、继续往下档找、最后直连。
   同理 `ProxyOverride` 里的 PAC/`<SCRIPT>` 与不认识的形态只忽略**那一条**，不牵连其它规则。
8. **非 Windows 与「什么都没配」的路径行为不变**：没有注册表、三个环境变量也没设 ⇒
   `Settings::default()` ⇒ 每一跳都用原来那个直连 agent（配置项与改动前逐项相同）。
9. **不扩面**：不新增宿主命令、不动方法表（`PLUGIN_WORKER_METHODS` 仍 27、`WIDGET_CALL_METHODS`
   不动）、不新增 crate —— 注册表读取用已有的 `windows` 依赖，只在 `src-tauri/Cargo.toml` 给它加
   一个 `Win32_System_Registry` feature（`Cargo.lock` 不记 feature ⇒ 零差异）。
   被否掉的替代：直接依赖传递树里已有的 `winreg`（lock 里同时有 0.10 与 0.55 两份，选哪个都是新增依赖）。

**已知未收口（本追加节新增的部分）**

- 真实 Clash / 企业代理下的端到端行为没有自动化判据：判定与脱敏全是离线单测，`verify` 只能证明
  「回环那跳没走代理」与「公网那跳仍然通」，不能证明「确实经过了 `127.0.0.1:7897`」。真机验证
  归统一测试的人工项。
- 代理端点自身不可信时没有二次校验：我们只保证不把凭据头带过去、不把口令写进日志，不校验
  代理返回的内容是否被篡改（那是 TLS 的事，明文 HTTP 则本来就无解）。
- 「解析到内网 IP 的域名」仍靠逐域名授权挡（见第 4 条）。
