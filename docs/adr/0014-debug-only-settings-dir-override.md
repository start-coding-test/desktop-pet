# 热键设置目录的 debug-only 覆盖（`PET_SETTINGS_DIR`）（2026-10-26）

A31 卡落地。E2E 的「改键成功」用例会调用 `hotkey_set`，原先固定写
`%APPDATA%/com.desktoppet.pet/settings.json`；不带隔离跑一次就会把开发机的真实热键改掉
（机器B E2E-DIAG 残留 F9、L09 现场同形）。本决策给 debug 构建一个显式的目录覆盖入口。

## 决定

1. `hotkeys.rs` 的 `settings_file` 先取 `app_data_dir()`，再经纯函数
   `settings_dir(app_data_dir, raw_override, allow_override)` 决定目录；生产包装传
   `allow_override = cfg!(debug_assertions)`。
2. `PET_SETTINGS_DIR` **只接受绝对路径**；空串/相对路径忽略并回退 `app_data_dir`。
   `read_saved` / `write_saved` / 启动时的 `restore` 都走同一个 `settings_file`，所以两条写路径
   一并被重定向。
3. 命中覆盖时 `log::debug!` 只记目录路径，**不记热键值**。
4. release 构建里 `cfg!(debug_assertions)` 为 false，该分支在编译期被裁掉：安装版不读这个变量，
   `verify:release` 与用户真实行为零影响。
5. E2E 隔离由三处同口径：
   - `.github/workflows/e2e.yml` 的 job env 设 `<workspace>\temp\settings-e2e`；
   - `tools/dev-debug.mjs` 在 GATE 下缺省同一目录，启动前清空（仅 `<仓库>/temp/` 下递归清，
     其他目录只删其中的 `settings.json`；与真实 app_data 目录重叠则拒绝启动）；
   - `verify-isolation.mjs` 只读隔离副本的内容，真实 `%APPDATA%\com.desktoppet.pet\settings.json`
     只取 sha256/是否存在做前后比对，**不读内容**。
6. CI 下若 `PET_SETTINGS_DIR` 缺失，`verify-isolation` 直接判红，不跳过。

## 为什么

- `app_data_dir()` 在 Windows 走 `SHGetKnownFolderPath(FOLDERID_RoamingAppData)`，**不读 `%APPDATA%`**；
  现有 `PET_AGENT_*` 只覆盖 agent 的配置/home/inbox，没有宿主级 settings 路径。所以必须新增一个
  显式入口，不能靠改 `APPDATA`。
- 只开 debug 构建是面最小的做法：能设置启动环境的人本来就能改同用户 `%APPDATA%` 下的
  `settings.json`，不构成提权；运行中的进程环境变量也不能被其他进程改。
- 绝对路径限制避免 cwd 变化把文件写到意外位置。

## 被否掉的做法

- **塞进 `PET_AGENT_INBOX` 等 agent 隔离目录**：CI 下能隔离，但热键不是 agent 数据，且本机不设该
  变量时仍落回真实路径；还会与 agent 套件的清理/断言耦合。
- **并入 `plugins-enabled.json`**：同一 `app_data_dir()`，并没有被任何环境变量覆盖，只换文件名。
- **`appDirectoriesOverride` 隔离整棵 app_data**：隔离更彻底，但要连带改 `verify-isolation` 的
  `STORE_DIR`、`verify-agent-bridge` 的 store/linkage 路径与 `dev-debug` 的清单路径，全局口径变化
  超出本卡；留作以后升级路径。
- **只在 E2E 用例里改完再还原真实 settings.json**：进程被硬杀/runner 重启时 `finally`/`always()`
  来不及执行，残留正是本卡要消的现象；且测试期间真实文件仍会被改成 F9。

## 残余风险（未解决）

- 本地手起 dev（不经 `dev-debug` GATE）且未 export `PET_SETTINGS_DIR` 时，`npm run verify` 仍会写
  真实 settings.json；CI 有守卫、dev-debug GATE 有默认隔离，裸跑不在保护内。
- debug 构建的启动者可用该变量重定向热键设置（同用户等价能力，不扩权）；按 A31-D1 不限制必须在
  temp 下。
- 真实 settings 的 sha256 前后比对假设运行期间没有第二个实例改它；若有，会误红而不是放宽。
- release 不读该变量，因此没有 release 级热键 E2E 覆盖；`verify:release` 本就不测热键。
