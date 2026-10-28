//! DSH 桥插件的检测：装没装，不看文件条数，看 profile 的 bundles 清单。
//!
//! 四家的「已安装」判据是「配置文本里有几条带 `--pet-hook` 的条目」。DSH 没有那份文本，
//! 它的等价判据是：某个 profile 的 `package.json` 里 `dsh.profile.bundles` 列了桥的包名。
//! 之所以读清单而不是扫 `node_modules/`：包可能装了但没进 bundles（等于没启用），
//! 而以 bundles 为准恰好是「DSH 启动时会不会加载它」的同一判据。
//!
//! 宠物**不代装**：`install_bundle` 会改写 profile 的 `package.json` / `cordis.patch.yml` /
//! 依赖树，DSH 文档要求这些由它自己的安装路径完成。这里只负责说清「还差哪一步」。
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

use crate::host_error::{HostError, INTERNAL};
use crate::services::agent::adapters::dsh::BRIDGE_PACKAGE;

/// 开发/复演时把 `~/.dsh` 指到别处（与 `PET_AGENT_HOME` 同类的隔离开关）。
pub const HOME_ENV: &str = "PET_DSH_HOME";

/// 桥目录相对仓库根（dev）或资源目录（release）的位置。
pub const BUNDLE_DIR: &str = "integrations/dsh-bridge";

/// 桥的检测结果。字段名走 camelCase：设置页 widget 直接渲染它。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bridge {
    /// 桥插件的包名。
    pub package: &'static str,
    /// 至少一个 profile 的 bundles 里列了它。
    pub detected: bool,
    /// 列了它的 profile 数（用户可能有多个 profile）。
    pub profiles: usize,
    /// 桥目录的实际路径：用户在 DSH 里 `install_bundle` 时填的就是它。
    pub bundle_dir: String,
    /// `~/.dsh` 的实际路径（诊断用：路径不对时用户能一眼看出）。
    pub dsh_home: String,
}

/// `~/.dsh`：`PET_DSH_HOME`（空值视为没设）优先，其次 `<home>/.dsh`。
pub fn dsh_home(home: &Path) -> PathBuf {
    match std::env::var_os(HOME_ENV) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home.join(".dsh"),
    }
}

/// 列出所有 profile 目录（含 `package.json` 的那种）。
pub fn profiles(dsh_home: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(dsh_home.join("profiles")) else {
        return found;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if dir.join("package.json").is_file() {
            found.push(dir);
        }
    }
    found
}

/// 一个 profile 的 `package.json` 里有没有列桥。
///
/// `dsh.profile.bundles` 是字符串数组（实测值形如 `"dsh-ops"`、`"@deepseek-ai/dsh-base"`）。
/// 同时接受 `name@version` 写法，避免将来清单里带版本号就误判成没装。
pub fn lists_bundle(manifest: &Value) -> bool {
    manifest
        .pointer("/dsh/profile/bundles")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.as_str().is_some_and(|name| {
                    name == BRIDGE_PACKAGE
                        || name
                            .strip_prefix(BRIDGE_PACKAGE)
                            .is_some_and(|rest| rest.starts_with('@'))
                })
            })
        })
}

/// 扫一遍 profile，数出「列了桥」的个数。读不出来的 profile 跳过（不是错误：DSH 自己会报）。
pub fn detect(home: &Path, bundle_dir: &Path) -> Bridge {
    let dsh_home = dsh_home(home);
    let mut profiles_with_bundle = 0;
    for profile in profiles(&dsh_home) {
        let Ok(raw) = std::fs::read_to_string(profile.join("package.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if lists_bundle(&manifest) {
            profiles_with_bundle += 1;
        }
    }
    Bridge {
        package: BRIDGE_PACKAGE,
        detected: profiles_with_bundle > 0,
        profiles: profiles_with_bundle,
        bundle_dir: bundle_dir.to_string_lossy().to_string(),
        dsh_home: dsh_home.to_string_lossy().to_string(),
    }
}

/// 桥没装上时的核心文案。`linkage::switch_agent` 与 `agent_hooks_install` 共用一份：
/// 「怎么装」这句提示只能有一条说法，两处各写一遍迟早漂移成两个版本。
pub fn not_detected(display_name: &str, bundle_dir: &Path) -> String {
    format!(
        "没检测到 {display_name} 的桥插件：先在 DSH 里用 plugin_manager 的 install_bundle 装一次 {}",
        bundle_dir.display()
    )
}

/// 桥目录：dev 读仓库根 `integrations/dsh-bridge`；release 读资源目录
/// `integrations/dsh-bridge`（打包时由 `bundle.resources` 复制）。
pub fn bundle_dir(app: &tauri::AppHandle) -> Result<PathBuf, HostError> {
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../integrations/dsh-bridge"));
    }
    app.path()
        .resource_dir()
        .map(|dir| dir.join(BUNDLE_DIR))
        .map_err(|e| HostError::new(INTERNAL, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::adapters::lock_test_env;
    use serde_json::json;

    /// 临时 home：`detect()` 自己会往下拼 `.dsh`，所以夹具建在 `<root>/.dsh/profiles`。
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pet-dsh-bridge-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".dsh").join("profiles").join("desktop"))
            .expect("能建临时 profile");
        dir
    }

    fn write_profile(root: &Path, name: &str, manifest: &Value) {
        let dir = root.join(".dsh").join("profiles").join(name);
        std::fs::create_dir_all(&dir).expect("能建 profile");
        std::fs::write(dir.join("package.json"), manifest.to_string()).expect("能写 package.json");
    }

    #[test]
    fn detects_the_bundle_listed_in_a_profile() {
        // detect() 会读 PET_DSH_HOME：与改环境的用例串行，免得被覆盖值带偏
        let _env = lock_test_env();
        let root = scratch("detected");
        write_profile(
            &root,
            "desktop",
            &json!({ "dsh": { "profile": { "bundles": ["dsh-ops", BRIDGE_PACKAGE] } } }),
        );
        let bridge = detect(&root, Path::new("C:\\app\\integrations\\dsh-bridge"));
        assert!(bridge.detected);
        assert_eq!(bridge.profiles, 1);
        assert_eq!(bridge.package, BRIDGE_PACKAGE);
        assert!(bridge.bundle_dir.ends_with("dsh-bridge"));
        assert!(bridge.dsh_home.ends_with(".dsh"));
    }

    #[test]
    fn absent_when_no_profile_lists_it() {
        let _env = lock_test_env();
        let root = scratch("absent");
        write_profile(
            &root,
            "desktop",
            &json!({ "dsh": { "profile": { "bundles": ["dsh-ops"] } } }),
        );
        let bridge = detect(&root, Path::new("bundle"));
        assert!(!bridge.detected);
        assert_eq!(bridge.profiles, 0);
    }

    #[test]
    fn versioned_listing_still_counts() {
        // 清单里带版本号不算「没装」：判据是包名，不是字符串全等。
        assert!(lists_bundle(&json!({
            "dsh": { "profile": { "bundles": ["dsh-pet-agent-bridge@0.1.0"] } }
        })));
    }

    #[test]
    fn broken_or_unrelated_manifests_are_skipped_not_fatal() {
        let _env = lock_test_env();
        let root = scratch("broken");
        // 坏 JSON
        std::fs::write(
            root.join(".dsh")
                .join("profiles")
                .join("desktop")
                .join("package.json"),
            "{ not json",
        )
        .expect("能写坏文件");
        // 形状不对：bundles 不是数组
        write_profile(
            &root,
            "second",
            &json!({ "dsh": { "profile": { "bundles": "nope" } } }),
        );
        // 没有 dsh 段
        write_profile(&root, "third", &json!({ "name": "x" }));
        let bridge = detect(&root, Path::new("bundle"));
        assert!(!bridge.detected, "读不出来的 profile 一律不算装上");
    }

    #[test]
    fn missing_profiles_directory_is_absent_not_fatal() {
        let _env = lock_test_env();
        let root =
            std::env::temp_dir().join(format!("pet-dsh-bridge-no-profiles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("能建临时 home");
        // 没装过 DSH 的机器就是这个样子：~/.dsh 都不存在
        let bridge = detect(&root, Path::new("bundle"));
        assert!(!bridge.detected);
        assert_eq!(bridge.profiles, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn home_override_wins_when_set() {
        let _guard = lock_test_env();
        let root = scratch("override");
        let previous = std::env::var_os(HOME_ENV);
        // 环境变量在测试内串行改动（lock_test_env 保证同一时刻只有一个用例）。
        std::env::set_var(HOME_ENV, root.join("elsewhere"));
        assert_eq!(dsh_home(&root), root.join("elsewhere"));
        match previous {
            Some(value) => std::env::set_var(HOME_ENV, value),
            None => std::env::remove_var(HOME_ENV),
        }
    }

    #[test]
    fn empty_home_override_falls_back_to_dot_dsh() {
        let _guard = lock_test_env();
        let previous = std::env::var_os(HOME_ENV);
        // 同上，环境变量用例已串行化。
        std::env::set_var(HOME_ENV, "");
        assert_eq!(
            dsh_home(Path::new("C:\\Users\\x")),
            Path::new("C:\\Users\\x").join(".dsh")
        );
        match previous {
            Some(value) => std::env::set_var(HOME_ENV, value),
            None => std::env::remove_var(HOME_ENV),
        }
    }
}
