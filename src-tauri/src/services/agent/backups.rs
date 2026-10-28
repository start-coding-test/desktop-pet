//! 备份账本：证明 `<被管理文件>.pre-pet-backup` 确实是我们抄的，才有资格在清理时删掉它。
//!
//! 为什么不只看文件名：用户完全可能本来就有同名文件 —— `backup_once` 遇到已存在的备份会直接
//! 跳过，那份不是我们写的，删掉它就是在删用户的数据。所以生成侧记账（路径 + 长度 + 内容哈希），
//! 清理侧只有「账本命中且长度、哈希都吻合」才删，其余一律跳过并计入 `skipped`。
//!
//! 账本落在宿主自己的数据目录（`%APPDATA%\<identifier>\agent-backups.json`），由调用方注入目录：
//! 安装路径取 `agent_hooks::ledger_dir(app)`，清理路径取同一个数据目录（见 `linkage` 里两处推导
//! 的注释），单测传临时目录。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::adapters;

/// 备份文件名后缀。生成侧（`agent_hooks::backup_once`）与清理侧共用这一处定义。
pub const BACKUP_SUFFIX: &str = ".pre-pet-backup";
/// 账本文件名。
const LEDGER_FILE: &str = "agent-backups.json";

/// FNV-1a 64 位。只用来判「这份备份还是当初那份」，不是密码学用途；自己实现，不引入依赖。
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// `<path>.pre-pet-backup`。只追加后缀，不换扩展名、不换目录。
pub fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(BACKUP_SUFFIX);
    PathBuf::from(name)
}

pub fn ledger_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(LEDGER_FILE)
}

/// 账本内容：备份路径 → (长度, FNV-1a 64)。
pub type Ledger = BTreeMap<String, (u64, u64)>;

/// 读账本。文件不存在或读坏都按**空账本**处理：空账本一条都不删，宁可少删不可误删。
pub fn load(app_data_dir: &Path) -> Ledger {
    let path = ledger_file(app_data_dir);
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ledger::new();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) => parse_ledger(&value),
        Err(e) => {
            log::warn!("备份账本解析失败，本次按空账本处理（不会删除任何备份）: {e}");
            Ledger::new()
        }
    }
}

fn parse_ledger(value: &Value) -> Ledger {
    let mut ledger = Ledger::new();
    let Some(object) = value.as_object() else {
        return ledger;
    };
    for (key, entry) in object {
        let len = entry.get("len").and_then(Value::as_u64);
        let hash = entry.get("hash").and_then(Value::as_u64);
        if let (Some(len), Some(hash)) = (len, hash) {
            ledger.insert(key.clone(), (len, hash));
        }
    }
    ledger
}

/// 记一条：这份备份是我们刚写的，内容是 `bytes`。
pub fn record(app_data_dir: &Path, backup: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut ledger = load(app_data_dir);
    ledger.insert(
        backup.display().to_string(),
        (bytes.len() as u64, fnv1a64(bytes)),
    );
    write_ledger(app_data_dir, &ledger)
}

/// 删掉账本里若干条（清理成功之后）。写失败只记日志 —— 账本多一条不影响正确性。
pub fn forget(app_data_dir: &Path, removed: &[String]) {
    if removed.is_empty() {
        return;
    }
    let mut ledger = load(app_data_dir);
    for key in removed {
        ledger.remove(key);
    }
    if let Err(e) = write_ledger(app_data_dir, &ledger) {
        log::warn!("清理后回写备份账本失败（不影响本次删除）: {e}");
    }
}

fn write_ledger(app_data_dir: &Path, ledger: &Ledger) -> Result<(), String> {
    fs::create_dir_all(app_data_dir).map_err(|e| format!("建账本目录失败: {e}"))?;
    let mut object = serde_json::Map::new();
    for (key, (len, hash)) in ledger {
        object.insert(key.clone(), json!({ "len": len, "hash": hash }));
    }
    let text = serde_json::to_string_pretty(&Value::Object(object))
        .map_err(|e| format!("序列化账本失败: {e}"))?;
    // 与配置写入同一策略：先落同目录临时文件再 rename，避免写一半留下坏账本
    let path = ledger_file(app_data_dir);
    let tmp = path.with_file_name(format!("{LEDGER_FILE}.{}.tmp", std::process::id()));
    if let Err(e) = fs::write(&tmp, text) {
        return Err(format!("写账本临时文件失败: {e}"));
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换账本失败: {e}"));
    }
    Ok(())
}

/// 单个候选的判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Remove,
    Skip,
}

/// 「这份备份能不能删」的纯决策：必须是普通文件、不是符号链接、且账本记录与实得长度/哈希都吻合。
/// 抽成纯函数是为了能离线喂各种事实（Windows 上建符号链接要权限，直接造不出来）。
pub fn classify(
    is_regular_file: bool,
    is_symlink: bool,
    actual_len: u64,
    actual_hash: u64,
    ledger: Option<(u64, u64)>,
) -> Decision {
    if !is_regular_file || is_symlink {
        return Decision::Skip;
    }
    match ledger {
        Some((len, hash)) if len == actual_len && hash == actual_hash => Decision::Remove,
        _ => Decision::Skip,
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BackupStats {
    pub removed: usize,
    pub failed: usize,
    pub skipped: usize,
}

/// 清理路径专用：只认**已接线适配器的被管理文件**旁边的 `<file>.pre-pet-backup`。
/// 不通配（只拼这一个后缀）、不递归（不看目录里别的文件）、不跟随符号链接
/// （`symlink_metadata` 判类型；链接本身也不删）。拿不到账本目录时一条都不删。
pub fn remove_backups_everywhere(home: &Path, app_data_dir: Option<&Path>) -> BackupStats {
    let mut stats = BackupStats::default();
    let Some(dir) = app_data_dir else {
        return stats;
    };
    let ledger = load(dir);
    let mut forgotten: Vec<String> = Vec::new();
    for adapter in adapters::wired() {
        for target in adapter.targets(home) {
            let backup = backup_path(&target);
            let Ok(meta) = fs::symlink_metadata(&backup) else {
                continue;
            };
            let is_symlink = meta.file_type().is_symlink();
            let is_regular_file = meta.file_type().is_file();
            let (len, hash) = if is_regular_file && !is_symlink {
                match fs::read(&backup) {
                    Ok(bytes) => (bytes.len() as u64, fnv1a64(&bytes)),
                    Err(_) => (0, 0),
                }
            } else {
                (0, 0)
            };
            let key = backup.display().to_string();
            match classify(
                is_regular_file,
                is_symlink,
                len,
                hash,
                ledger.get(&key).copied(),
            ) {
                Decision::Remove => match fs::remove_file(&backup) {
                    Ok(()) => {
                        stats.removed += 1;
                        forgotten.push(key);
                    }
                    Err(e) => {
                        log::warn!("删除备份失败 {}: {e}", backup.display());
                        stats.failed += 1;
                    }
                },
                Decision::Skip => stats.skipped += 1,
            }
        }
    }
    forget(dir, &forgotten);
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::adapters;
    use std::fs;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pet-backups-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 造一个「装了 hook 之后」的文件：正文 + 备份 + 账本记录，返回 (配置, 备份, env 作用域)
    fn installed_pair(dir: &Path, leaf: &str, body: &str) -> (PathBuf, PathBuf, EnvScope) {
        let (config, scope) = managed_file(dir, leaf, body);
        let backup = backup_path(&config);
        fs::copy(&config, &backup).unwrap();
        let bytes = fs::read(&backup).unwrap();
        record(dir, &backup, &bytes).unwrap();
        (config, backup, scope)
    }

    /// 把适配器的候选文件指向临时文件。环境变量是进程级的：持 `TEST_ENV` 锁并在 Drop 时清掉，
    /// 否则会污染同进程里别的用例（`targets()` 会读到我们的临时路径）。
    struct EnvScope {
        _lock: std::sync::MutexGuard<'static, ()>,
        names: Vec<&'static str>,
    }

    impl EnvScope {
        fn set(vars: &[(&'static str, String)]) -> EnvScope {
            let lock = adapters::lock_test_env();
            for (name, value) in vars {
                std::env::set_var(name, value);
            }
            EnvScope {
                _lock: lock,
                names: vars.iter().map(|(name, _)| *name).collect(),
            }
        }
    }

    impl Drop for EnvScope {
        fn drop(&mut self) {
            for name in &self.names {
                std::env::remove_var(name);
            }
        }
    }

    /// 造一个「被适配器管理」的文件：写正文，并用 WorkBuddy 的文件级覆盖把它指成候选
    fn managed_file(dir: &Path, leaf: &str, body: &str) -> (PathBuf, EnvScope) {
        let config = dir.join(leaf);
        if let Some(parent) = config.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&config, body).unwrap();
        let scope = EnvScope::set(&[("PET_AGENT_WORKBUDDY_FILES", config.display().to_string())]);
        (config, scope)
    }

    #[test]
    fn fnv1a64_matches_known_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_ne!(fnv1a64(b"a"), fnv1a64(b"b"));
    }

    #[test]
    fn classify_only_removes_owned_regular_files() {
        let owned = Some((3, 42));
        assert_eq!(classify(true, false, 3, 42, owned), Decision::Remove);
        // 用户预置的同名文件：账本没有
        assert_eq!(classify(true, false, 3, 42, None), Decision::Skip);
        // 账本有，但内容被改过
        assert_eq!(classify(true, false, 4, 42, owned), Decision::Skip);
        assert_eq!(classify(true, false, 3, 7, owned), Decision::Skip);
        // 符号链接与目录一律不碰
        assert_eq!(classify(false, true, 3, 42, owned), Decision::Skip);
        assert_eq!(classify(false, false, 3, 42, owned), Decision::Skip);
    }

    #[test]
    fn removes_only_the_exact_backup_name_and_keeps_lookalikes() {
        let dir = tmp_dir("exact");
        let (_config, backup, _scope) = installed_pair(&dir, "settings.json", r#"{"a":1}"#);
        let lookalikes = [
            "settings.json.pre-pet-backup2",
            "settings.json.bak",
            "settings.pre-pet-backup",
        ];
        for name in lookalikes {
            fs::write(dir.join(name), "keep me").unwrap();
        }
        let stats = remove_backups_everywhere(&dir, Some(&dir));
        assert_eq!(stats.removed, 1, "{stats:?}");
        assert!(!backup.exists(), "自己的备份应当被删");
        for name in lookalikes {
            assert!(dir.join(name).exists(), "{name} 不该被删");
        }
    }

    #[test]
    fn skips_user_pre_existing_backup_without_ledger() {
        let dir = tmp_dir("unowned");
        let (config, _scope) = managed_file(&dir, "settings.json", r#"{"a":1}"#);
        let user_file = backup_path(&config);
        fs::write(&user_file, "用户自己的同名文件").unwrap();
        let stats = remove_backups_everywhere(&dir, Some(&dir));
        assert_eq!((stats.removed, stats.skipped), (0, 1), "{stats:?}");
        assert!(user_file.exists());
    }

    #[test]
    fn skips_when_content_changed_after_recording() {
        let dir = tmp_dir("changed");
        let (_config, backup, _scope) = installed_pair(&dir, "settings.json", r#"{"a":1}"#);
        fs::write(&backup, "被改过了").unwrap();
        let stats = remove_backups_everywhere(&dir, Some(&dir));
        assert_eq!((stats.removed, stats.skipped), (0, 1), "{stats:?}");
        assert!(backup.exists());
    }

    #[test]
    fn skips_directories_named_like_backups() {
        let dir = tmp_dir("dirlike");
        let (config, _scope) = managed_file(&dir, "settings.json", r#"{"a":1}"#);
        fs::create_dir_all(backup_path(&config)).unwrap();
        let stats = remove_backups_everywhere(&dir, Some(&dir));
        assert_eq!((stats.removed, stats.skipped), (0, 1), "{stats:?}");
        assert!(backup_path(&config).is_dir());
    }

    #[test]
    fn removal_keeps_config_body_and_other_user_keys() {
        let dir = tmp_dir("body");
        let body = r#"{"hooks":{"keep":"me"},"theme":"dark"}"#;
        let (config, backup, _scope) = installed_pair(&dir, "settings.json", body);
        remove_backups_everywhere(&dir, Some(&dir));
        assert!(!backup.exists());
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            body,
            "配置本体不得被改动"
        );
        assert!(fs::read_to_string(&config)
            .unwrap()
            .contains("\"theme\":\"dark\""));
    }

    #[test]
    fn ui_style_install_records_then_cleanup_removes_it() {
        // 与设置页 `agent_hooks_install` 同一个签名：传账本目录 → 记账 → 清理能删
        let dir = tmp_dir("ui");
        let ledger = dir.join("ledger");
        let home = dir.join("home");
        fs::create_dir_all(home.join(".qoder")).unwrap();
        let config = home.join(".qoder").join("settings.json");
        fs::write(&config, r#"{"theme":"dark"}"#).unwrap();
        let _env = adapters::lock_test_env();
        std::env::set_var("PET_AGENT_HOME", &home);
        let qoder = adapters::by_id("qoder").expect("qoder 已接线");
        let reports = crate::services::agent_hooks::install_files(
            qoder,
            &qoder.targets(&home),
            Path::new(r"C:\app\desktop-pet.exe"),
            Some(ledger.as_path()),
            true,
        );
        std::env::remove_var("PET_AGENT_HOME");
        assert!(
            reports.iter().all(|r| r.error.is_none()),
            "{:?}",
            reports.iter().map(|r| r.error.clone()).collect::<Vec<_>>()
        );
        let backup = backup_path(&config);
        assert!(backup.exists(), "安装必须留下备份");
        assert!(!load(&ledger).is_empty(), "安装必须写账本");
        let stats = remove_backups_everywhere(&home, Some(&ledger));
        assert_eq!(stats.removed, 1, "{stats:?}");
        assert!(!backup.exists(), "清理后备份必须不存在");
        assert!(load(&ledger).is_empty(), "删掉后账本条目要一并回写掉");
    }

    #[test]
    fn install_without_ledger_dir_fails_and_leaves_config_untouched() {
        // A23-D1 规则 4：拿不到账本目录就不许新建备份 —— 备份必须可证明归属
        let dir = tmp_dir("noledger");
        let home = dir.join("home");
        fs::create_dir_all(home.join(".qoder")).unwrap();
        let config = home.join(".qoder").join("settings.json");
        let body = r#"{"theme":"dark"}"#;
        fs::write(&config, body).unwrap();
        let _env = adapters::lock_test_env();
        std::env::set_var("PET_AGENT_HOME", &home);
        let qoder = adapters::by_id("qoder").expect("qoder 已接线");
        let reports = crate::services::agent_hooks::install_files(
            qoder,
            &qoder.targets(&home),
            Path::new(r"C:\app\desktop-pet.exe"),
            None,
            true,
        );
        std::env::remove_var("PET_AGENT_HOME");
        assert_eq!(
            reports[0].error.as_deref(),
            Some("备份失败，未改动配置"),
            "{:?}",
            reports[0].error
        );
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            body,
            "拦下时配置不得改动"
        );
        assert!(!backup_path(&config).exists(), "不许留无主备份");
    }

    #[test]
    fn all_five_managed_files_lose_their_backups_on_cleanup() {
        // 五类 = Qoder 的两个目录（.qoder/.qoder-cn）+ ZCode + Codex + WorkBuddy
        let dir = tmp_dir("five");
        let home = dir.join("home");
        let ledger = dir.join("ledger");
        let qoder = home.join(".qoder");
        let qoder_cn = home.join(".qoder-cn");
        let zcode = home.join(".zcode").join("cli");
        let codex_file = dir.join("codex").join("hooks.json");
        let wb_file = dir.join("workbuddy").join("settings.json");
        for d in [&qoder, &qoder_cn, &zcode] {
            fs::create_dir_all(d).unwrap();
        }
        fs::create_dir_all(codex_file.parent().unwrap()).unwrap();
        fs::create_dir_all(wb_file.parent().unwrap()).unwrap();
        fs::write(qoder.join("settings.json"), r#"{"theme":"dark"}"#).unwrap();
        fs::write(qoder_cn.join("settings.json"), r#"{"theme":"dark"}"#).unwrap();
        fs::write(
            zcode.join("config.json"),
            r#"{"hooks":{"enabled":false,"events":{}}}"#,
        )
        .unwrap();
        fs::write(&codex_file, r#"{"hooks":{}}"#).unwrap();
        fs::write(&wb_file, r#"{"disableAllHooks":false}"#).unwrap();

        let qoder_list = format!(
            "{};{}",
            qoder.join("settings.json").display(),
            qoder_cn.join("settings.json").display()
        );
        let _env = EnvScope::set(&[
            ("PET_AGENT_CONFIG_FILES", qoder_list),
            ("PET_AGENT_HOME", home.display().to_string()),
            ("PET_AGENT_CODEX_FILES", codex_file.display().to_string()),
            ("PET_AGENT_WORKBUDDY_FILES", wb_file.display().to_string()),
        ]);
        let exe = Path::new(r"C:\app\desktop-pet.exe");
        let mut attempted = 0;
        for adapter in adapters::wired() {
            let files = adapter.targets(&home);
            if files.is_empty() {
                continue;
            }
            attempted += files.len();
            let reports = crate::services::agent_hooks::install_files(
                *adapter,
                &files,
                exe,
                Some(ledger.as_path()),
                true,
            );
            for report in &reports {
                assert!(
                    report.error.is_none(),
                    "{} 装失败: {} -> {:?}",
                    adapter.id(),
                    report.path,
                    report.error
                );
            }
        }
        assert_eq!(
            attempted, 5,
            "五类被管理文件都要真的装上（Qoder 两目录 + ZCode + Codex + WorkBuddy）"
        );

        let configs = [
            qoder.join("settings.json"),
            qoder_cn.join("settings.json"),
            zcode.join("config.json"),
            codex_file,
            wb_file,
        ];
        let backups: Vec<PathBuf> = configs.iter().map(|p| backup_path(p)).collect();
        for backup in &backups {
            assert!(backup.exists(), "装完应有备份: {}", backup.display());
        }
        let stats = remove_backups_everywhere(&home, Some(&ledger));
        assert_eq!(stats.removed, 5, "{stats:?}");
        for backup in &backups {
            assert!(!backup.exists(), "清理后不该有备份: {}", backup.display());
        }
    }
}
