# debug-only 默认热键覆盖（`PET_HOTKEY_DEFAULT`）（2026-10-27）

E02 卡落地。A31 的 `PET_SETTINGS_DIR` 只隔离了「热键值写到哪」，没有解决默认键本身
被 E2E 机器占用的问题：机器B 的 `Ctrl+Alt+P` 被其他应用占住且无法释放，于是
`verify-isolation` 的「Tauri 跨平台 token 被接受（默认值本身必须能设）」与「改回默认值」
两条判据一直红，只能按 L9-R2 记「未复验」。长期保留两条已知红会让组合 E2E 无法真正收口。

## 决定

1. 产品默认值仍是常量 `DEFAULT_ACCEL = "CommandOrControl+Alt+P"`，不改用户可见行为。
2. debug 构建（`cfg!(debug_assertions)`）允许用 `PET_HOTKEY_DEFAULT` 覆盖「本次生效的默认键」。
   值必须能通过 `normalize_accel`；空串、非法组合键一律静默回退产品默认值。
3. release 构建在编译期裁掉该分支，安装版不读这个变量。
4. `hotkey_status` 的 `default` 字段返回「本次生效的默认键」；设置页「恢复默认」读这个字段，
   不再写死 `CommandOrControl+Alt+P`。
5. E2E 工作流设 `PET_HOTKEY_DEFAULT=CommandOrControl+Alt+Q`（机器B 的空闲组合），
   `verify-isolation` 从 `hotkey_status.default` 取默认值来执行「设默认值 / 改回默认值」，
   并新增三条正向判据：`default` 必须存在、必须保留 `CommandOrControl` token、
   设了环境变量时必须与 `status.default` 逐字一致。
6. 产品默认值的 release 语义仍由 Rust 单测钉住：`DEFAULT_ACCEL` 以及
   `default_accel(..., allow_override=false)` 必须返回产品默认值。

## 为什么

- 机器B 的占键是环境问题，不能靠改产品默认键绕过；覆盖只发生在 debug/E2E。
- 不放宽断言：原来的两条红变成了「按宿主实际默认键执行」的等价断言，
  另加三条环境一致性判据，断言的覆盖面只增不减。
- 覆盖值走与用户输入相同的归一化与校验路径，不引入第二套语法。

## 被否掉的做法

- **把产品默认键改成别的组合**：用户可见行为变化，且不能保证任何机器都空闲。
- **删掉/跳过这两条判据**：会把「默认值能否注册」这条真实能力留成盲区。
- **只在测试里直接改 `settings.json`**：绕过了 `hotkey_set` 与真实注册路径，不能证明默认键可用。
- **E2E 里先释放机器B 的占键**：已确认无法释放，不属于代码可控范围。

## 残余风险

- debug 构建的启动者可以用该变量改变默认键；与 A31 一样属于同用户等价能力，不扩权。
- release 不读覆盖，因此 E2E 不再逐字验证 `CommandOrControl+Alt+P` 这一具体值的可注册性；
  产品默认值的常量与 release 门禁由 Rust 单测钉住，E2E 验证的是同一条代码路径。
- 如果 E2E 机器连 `Ctrl+Alt+Q` 也被占，该轮仍会在「默认值本身必须能设」上红，不会静默通过。
