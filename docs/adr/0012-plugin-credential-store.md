# 插件凭据存储：DPAPI 加密、专用 ctx.secrets、任何失败都不回落明文（2026-10-21）

B07 卡落地。插件把 API Key / Cookie / refresh token 这类「泄漏即失陷」的值从普通 `store.json`
（明文 JSON）里分出来，落到单独的 `secrets.json`，值用 Windows DPAPI 加密。

## 决定

1. **专用接口 `ctx.secrets.get/set/delete`**，不复用 `ctx.storage.*` 的键空间，也不把普通存储改成透明加密：
   `storage` 继续是「可明文落盘、人可读、可跨版本漂」的业务数据；`secrets` 是凭据。由插件显式选择走哪条路。
   能力复用 `storage`（不新增能力名，不改同意文案）；**widget 不开放**（`WIDGET_CALL_METHODS` 不动，见 [ADR-0008](0008-widget-host-in-web-worker-render-commands.md)）。
2. **Windows DPAPI 当前用户作用域**：调用 `CryptProtectData` / `CryptUnprotectData`，`dwflags` 只带
   `CRYPTPROTECT_UI_FORBIDDEN`，**不带** `CRYPTPROTECT_LOCAL_MACHINE`。也就是说密文只能被同一 Windows
   账户解开；换账户、换机器、目录被拷走或备份泄漏时读不出明文。
   （**设计意图，未实测**：换账户/换机器解不开由 current-user scope 保证；CI 没有跨账户测试。）
3. **熵绑定**：每次加解密都带 `"pet-secrets:v1:" + plugin_id` 的 UTF-8 字节。它让「把 A 的密文复制到 B 的
   目录」解不开，但它**不是身份校验**（见「已知未收口」）。
4. **落点与信封**：`%APPDATA%/<identifier>/plugins/<plugin_id>/secrets.json`（与 `store.json` 同目录）
   ```json
   {"schema":1,"entries":{"<key>":{"v":1,"alg":"dpapi","savedAt":<ms>,"blob":"<base64>"}}}
   ```
   读坏 JSON / 未知 schema ⇒ `parse`；未知 `alg` / 条目形状不对 ⇒ 只对该键报错，不整表覆盖；
   写路径复用 [fsutil.rs](../../src-tauri/src/fsutil.rs) 的 `write_atomic`（tmp + pid + rename）。
5. **失败一律 fail-closed**：非 Windows ⇒ `unsupported`；解密失败 ⇒ `internal`；任何失败都**不写文件、
   不删文件、不回落明文、不返回空串冒充有值**。未设置 ⇒ `null`（不是 `""`）。错误码复用
   `packages/sdk/error-codes.json` 的现有 12 个码，不新增码。
6. **宿主不做迁移**：宿主永不读 `store.json` 里的秘密字段、永不把明文写回。旧明文凭据的
   `copy → verify → clear` 迁移由插件侧在 C06 落地（协议见下）。
7. **撤销授权连带清理**：`secrets.json` 与 `store.json` 同目录；**生产清理路径是 `store::clear_plugin` 的
   `remove_dir_all`**，它会连同目录里的 `secrets.json` 一起删掉（测试
   `clear_plugin_removes_both_store_and_secrets` 钉住）。`secrets::SecretsStore::clear_plugin` 是备用入口，
   当前无调用方，仅供测试与以后拆出独立目录时使用。

## 为什么

`store.json` 今天就是明文（[store.rs](../../src-tauri/src/services/store.rs)），goat-gauge 的 apiKey、
C06 的 Cookie 都会落在那里。文件权限挡不住拿到同一账户的进程或备份读取；DPAPI 至少把「静态数据」
这一层收住，且不需要新增 crate / 密钥管理（现有 `windows` crate 加一个 feature 即可）。

接口面必须显式：把业务数据和凭据混在一个键空间里，`store_get` 的失败语义（missing / parse）会被
「解密失败」污染，插件也无法在 UI 上告诉用户「这是凭据，迁移要校验」。专用接口让边界可测、可文档化。

## 被否掉的做法

- **普通存储透明加密**：业务数据也跟着进密文，排查时连 `config` 都读不了；`store_get` 的
  `null` / `parse` 语义被解密失败混入，迁移面反而更大。
- **新增 `secret` 能力名**：要改 `plugin-capabilities.json`、同意文案与双向钉死测试；本轮明确复用
  `storage`（同一份授权记录，插件少一次授权）。
- **引入 `keyring` / `aes-gcm` / 新增 crate**：前者把凭据挪到用户可见的系统凭据管理器、与「插件目录内
  密文」模型不一致；后者要自己管主密钥，收益为零。`windows` crate 已存在，只加一个 feature。
- **宿主代迁移**：宿主要知道「哪些字段是秘密」，等于把 goat-gauge 的业务模型写进宿主；且违反
  「宿主永不读明文秘密」。
- **解密失败回落明文/空串**：会把「文件损坏」伪装成「没设置」，下一次写入还可能覆盖唯一可恢复的密文。

## 迁移协议（C06 实现，本卡不改插件）

`copy → verify → clear`：

1. 读明文凭据（如 `cred.apiKey`）且 `secrets.get(alias)` 为 `null` ⇒ `secrets.set(alias, 明文)`；
2. **读回逐字校验**通过后，才把明文从 `store.json` 清掉（或置空该字段）；
3. 写失败/校验失败 ⇒ 明文原样保留 + UI 明示「暂未迁移成功」并允许重试（fail-loud）；
4. 任一步中断，最坏是「明文与密文都在」；重跑时第 2 步会通过并继续清明文，**不会两边都没有**；
5. 幂等：`secrets.get` 非空即跳过；用户主动改 key 时才覆盖并更新 `savedAt`。

回滚边界：旧版宿主不认识 `secrets.json`，不读不写；撤销授权时 `remove_dir_all` 仍会删它。回滚后
插件看到的 `cred.apiKey` 为空 ⇒ 让用户重新输入。**「校验通过才清明文」是硬规则**。

## 已知未收口（不要当作已解决）

- **`plugin_id` 仍由调用方自报**：绕过 JS 桥直接 `invoke("secrets_get")` 的同 realm 代码可以冒用
  另一个已授权插件的 id 去读它的凭据。这与 `store_*` 是同一个老缺口（[ADR-0011](0011-consent-identity-and-subscribe-acl.md)
  的「能力门禁的 plugin_id 仍由调用方自报」），要等 Web Worker 宿主全面化才有真身份。DPAPI 加密
  **不解决**这个问题；熵绑定只阻止「密文搬家」，不是调用方身份。
- **DPAPI 只保护静态数据**：同一 Windows 账户下运行的恶意进程仍可在解密后读内存/文件；
  它不防「当前用户已经被攻陷」。
- **`storage` 与 `secrets` 共用能力名**：撤销 `storage` 会同时收走两者；这是刻意的（凭据也是插件数据），
  但如果未来要分开授权，需要新能力名并改 `plugin-capabilities.json`。
- **F2 清理失败可能残留**：`permission_revoke` 对 `store.clear_plugin` 的失败只 `log::warn!`，撤销授权后
  凭据文件可能残留（与 `store.json` 同一失败面）；宿主没有自愈/重试。
- **F3 键间不绑定**：熵只绑定 `plugin_id`，同一插件文件内不同 key 的 blob 可以互换后仍解密；若要按 key
  绑定需 `pet-secrets:v2:<plugin_id>:<key>` 并写迁移说明。
- **F7 两个 root 同源**：`StoreState` 的 root 与 secrets 的 `app_plugins_dir()` 目前都指向
  `%APPDATA%/<identifier>/plugins`；F1 测试钉住了「同目录清理」，但两者仍是两个真值来源，未来改 root 必须同步。
- **F8 恢复路径**：文件损坏/解密失败时宿主不自愈；恢复路径是撤销授权（或重装）后让用户重新输入，或由
  未来卡提供显式 reset；当前没有 `secrets_reset`。
- **F9 门禁校验的是被点名的 plugin_id，不是调用者**：有 `storage` 授权的插件可以给另一个有授权的插件
  构造冒名请求；ADR-0011 的老缺口，等 Worker 宿主真身份。
- **F12 parse 文案含 serde 消息**：`parse` 的 message 带 serde 的位置型描述；当前不含输入，若未来换成
  含输入/上下文的错误文案，需要重新评估是否泄露。
