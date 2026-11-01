# 发版清单（Release Checklist）

每个版本一节，按顺序勾；**读数必须带日期与来源，没跑过的写「未跑」或「未验」，不要写「已验」**。
本机没有 `gh`、也没有仓库 token —— 标「管理员」的步骤只能在 GitHub 网页或持有 token 的机器上做，本轮一律**未执行**。

## 通用步骤（每版按序）

1. **CI 绿**：目标提交上 `.github/workflows/ci.yml` 的 `windows` job 通过（unit / check:* / lint / build / cargo test）。
2. **E2E 门**：同一提交上 `.github/workflows/e2e.yml`（`workflow_dispatch`）跑绿。判据读 `.github/workflows/e2e-gate.json`：
   skip 即红；每套件断言数不得低于 floor；`knownEnvFailures` 只登记有到期日、有反证的环境红 —— **不把红洗成绿**。
3. **分支保护（管理员）**：`main` 必须走 PR、必需检查选 `windows`、`enforce_admins: true`、审批数 0、
   `restrictions: null`。命令与整段 JSON body 见 [BRANCHES.md](BRANCHES.md)「七、`main` 分支保护命令」。
   **本轮未执行**：保护仍是关闭状态（直推可用）。
4. **版本号一致**：`package.json` / `package-lock.json`（两处）/ `src-tauri/tauri.conf.json` /
   `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` 的 `desktop-pet` 条目。
5. **构建**：便携包 `npm run tauri build -- --no-bundle`；NSIS 安装包 `npm run tauri build`（产物在
   `src-tauri/target/release/bundle/nsis/`）。核对 exe 的 mtime 晚于 `src/`、`src-tauri/` 最后一次提交。
6. **校验**：`npm run verify:release` 全绿（打包版 CSP 与插件加载；dev 不注入 CSP，测不出来）。
   记录产物 SHA256；便携包按 `release-package/DesktopPet-<版本>/` 口径组装（`desktop-pet.exe` + `plugins/` +
   `integrations/` + `更新说明.txt`，**不是 `dist/`**，那里每次构建都会被清空）。
7. **打 tag**：`git tag -a v<版本> -m "<说明>" <提交>` 并推送。tag 必须落在 CI 绿的提交上 ——
   0.2.3 / 0.2.4 都违反过：出包早于 CI 门（历史事实，照记不洗）。
8. **Release notes**：按 [RELEASE-NOTES-0.2.x.md](RELEASE-NOTES-0.2.x.md) 的格式写；
   「安装器内嵌桥为修复前版本」这类已知事实必须写明。
9. **GitHub Release（管理员）**：上传安装包 + 便携包 + notes。本机无 gh/token，**本轮未建**。
10. **收尾**：`git status` 复核无凭据入库；更新本文件对应版本节、HOST-BACKLOG 的发版行（S 前缀）与读数。

## 0.2.4（2026-10-28，修复轮）

- 提交：`7448b3f`（DSH 桥，第五家）、`02e5102`（0.2.3）、`4df82f9`（收件目录回退修复轮）、
  `b6d98cd`（release）。**不在 0.2.4 包内的 tag 后提交**：`993e1f2`（B6 拖动态；不是 `b6d98cd` 的祖先）、
  `f2e9fd0`（文档）、`a18ec21`（F01′–F06 修复轮）。
- tag：`v0.2.4`（annotated → `b6d98cd`）**已打**；GitHub Release **未建**（管理员）。
- CI / E2E 门：`b6d98cd` 的 CI 绿（run `40643854516`，success）；E2E 门（`e2e.yml`）**未触发**。
  本地读数（工作区、不是 tag 字节）：`verify` 485/0、`verify:agent` 303/4（t38 修复前记录；2026-11-01 复跑为 318/0）、
  `verify:drag` 41/0、`verify:dsh` 43/0；现行基线见 `.github/workflows/e2e-gate.json` 的 `floorBasis`。
  tag 后 `a18ec21` 的 CI **红在 Rust fmt**（run `40725727745` / `40725728961`）；修复提交 `33c78d8` 的 main CI
  **全绿**（run `41323567293`，15 步、250s），详见 HOST-BACKLOG R1。
- 已知事实：0.2.3 安装器**作废**（内嵌收件目录修复前的桥）；0.2.4 修复轮含收件目录回退、CRLF 判据、
  四家卸载断言、13 条恒真断言转真与发版口径纠偏。
- 产物：`release-package/DesktopPet_0.2.4_x64-setup.exe`、`release-package/DesktopPet-0.2.4/`
  （本地产物、`.gitignore` 覆盖，不作为入库证据）；SHA256 **待补录**（本机未复跑产物校验）。
- 未验：真机安装/覆盖升级、DSH 真机 `install_bundle` 一次后桌宠联动。
- **2026-11-01 修复轮（提交 `33c78d8`，已推送 main；不是 0.2.4 包字节）**：Rust fmt 已收口 ——
  `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` 退出 0、0 处差异，写模式 fmt 前后
  `git diff -- src-tauri/src` 指纹一致（零字节改动）；离线门 `npm run unit` 2638/0、
  `cargo test` 428/0、`check:docs` / `check:shape` / `check:e2e-gate` / `lint` / `build` 全部退出 0；
  clippy `-D warnings` 退出 0。**CI 已复验**：main run `41323567293`（head `33c78d8`）15 步全绿、250s，
  原先红的第 12 步「Rust 格式检查」及其后的 clippy / 单测 / Tauri debug 构建全部通过。
  **E2E 门仍未触发**（`e2e.yml` 是 `workflow_dispatch` + 自托管 runner）；本机 `node tools/e2e-run.mjs` 实测
  四套全绿：`verify` 485/0、`verify:agent` 318/0、`verify:drag` 41/0、`verify:dsh` 43/0。
  这一轮**不等于 0.2.4 发版前置**：0.2.4 的包字节仍是 `b6d98cd`，E2E 门没有在 0.2.4 上触发过。

## 0.2.3（作废）

- 安装器内嵌的桥是**收件目录修复前**的版本，**不要发放**；`release-package/` 里已无 0.2.3 产物（现只有 0.2.4 安装器与便携包），历史 tag 仍在。
- tag `v0.2.3` → `02e5102` 仍在；GitHub Release 未建。

## 0.2.2（2026-10-27，参照格式）

- tag `v0.2.2` → `bf585fe`；GitHub Release 双资产；真机 A27/A28/A29/A30/A32/C09/E03 通过；
  `verify:release` 36/0；完整读数见 [HOST-BACKLOG](HOST-BACKLOG.md) 的 S3 行。
