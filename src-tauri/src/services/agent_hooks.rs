//! Agent hook 配置文件的**读写管线**：备份、原子替换、报告，以及按适配器分派。
//!
//! 分工：配置文件长什么样（`hooks` 的嵌套形状、事件词表、超时字段叫什么）住在
//! `services/agent/adapters/`；这一层只管「怎么安全地落到磁盘上」，两边不互相漏细节。
//!
//! 「只认 `--pet-hook` 标记的自家条目、重装幂等、坏文件不覆盖」这三条由适配器实现，
//! 这一层再加三条自己的：
//! 1. 写之前先备份，备份失败就不改 —— 宁可装不上，也不能把用户配置弄成不可恢复；
//! 2. 落盘走「同目录临时文件 + rename」，且临时名带 pid；
//! 3. 装卸串行化在一把锁里（见 `HOOK_IO`），四个调用方谁都不用记得加锁。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::services::agent::adapters::{self, AgentAdapter};
use crate::services::agent::phases::AGENT_FLAG;

/// 自家条目的识别标记。它同时是 hook 分支的 CLI 参数，两边共用这一个常量
pub const HOOK_MARKER: &str = "--pet-hook";

/// 装卸串行锁。设置页点按钮、启停联动、启动清理和 `--pet-hook-cleanup` 都在做
/// 「读原文 → 改 → 原子替换」这三步，并发跑就会互相覆盖：一方按旧内容算出新文本时
/// 另一方已经写进去了，后写的那份把先写的条目抹掉（或装出双份）。
/// 锁放在这一层（而不是调用方）是因为调用方有四个，少一个就漏。
static HOOK_IO: Mutex<()> = Mutex::new(());

/// 取锁。中毒（持锁线程 panic）时继续用：配置读写本身是可重入的纯 IO，
/// 让后续装卸因一次无关 panic 永久失效，比带着锁继续跑更糟。
fn lock_hook_io() -> std::sync::MutexGuard<'static, ()> {
    HOOK_IO.lock().unwrap_or_else(|p| p.into_inner())
}

/// 装进配置里的那条命令：`"<exe>" --pet-hook <phase> --agent <id>`。
/// 来源字段取自适配器 —— 装谁的 hook 就写谁，于是「谁在给我们发事件」与命令串里的来源
/// 天然一致，不靠收件侧的缺省兜底。路径可能带空格，整体加引号；phase 来自白名单常量、
/// id 来自注册表，两处都没有注入面。
pub fn hook_command(
    adapter: &dyn AgentAdapter,
    exe: &Path,
) -> impl for<'a> Fn(&'a str) -> String + 'static {
    let exe = exe.display().to_string();
    let agent: &'static str = adapter.id();
    move |phase: &str| format!("\"{exe}\" {HOOK_MARKER} {phase} {AGENT_FLAG} {agent}")
}

#[derive(serde::Serialize)]
pub struct FileReport {
    pub path: String,
    pub managed: usize,
    pub error: Option<String>,
    /// 装之前这个文件的「总开关」原值（JSON `null` = 原来根本没这个键）。
    /// 只有在我们确实把它拨开了的时候才有值 —— 状态文件按路径存它，卸载时照单恢复。
    /// 没有总开关的客户端（Qoder）永远是 `None`，也不进序列化结果。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub switch_before: Option<Value>,
}

impl FileReport {
    fn failed(path: &Path, error: impl Into<String>) -> Self {
        Self {
            path: path.display().to_string(),
            managed: 0,
            error: Some(error.into()),
            switch_before: None,
        }
    }
}

fn backup_once(path: &Path) -> std::io::Result<()> {
    let mut name = path.as_os_str().to_os_string();
    name.push(".pre-pet-backup");
    let bak = PathBuf::from(name);
    if bak.exists() {
        return Ok(());
    }
    fs::copy(path, &bak).map(|_| ())
}

/// 原子写：先落同目录临时文件再 rename，避免写一半被打断留下坏配置。
/// 临时名必须带 pid —— 固定名会让两个来源同时安装时互相覆盖：
/// 一方还在写 `settings.json.tmp`，另一方已经把同名文件 rename 走了。
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let base = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("settings.json");
    let tmp = path.with_file_name(format!("{base}.{}.tmp", std::process::id()));
    if let Err(e) = fs::write(&tmp, text) {
        return Err(format!("写入临时文件失败: {e}"));
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(format!("替换配置文件失败: {e}"))
        }
    }
}

/// 读原文；文件不存在返回 Ok(None)
fn read_existing(path: &Path) -> Result<Option<String>, std::io::Error> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// 这批报告里有没有至少一个文件真的装上了。设置页据此决定「要不要把用户的选择记进
/// 联动状态文件」—— 全部失败时不记，否则下一次启用插件会去装一个从没成功过的 hook。
pub fn any_installed(reports: &[FileReport]) -> bool {
    reports.iter().any(|r| r.error.is_none() && r.managed > 0)
}

/// 数一数每个候选文件里自家条目有几条。读也进这把锁：装卸进行中查出来的条数
/// 必须是一个稳定时刻的，否则状态页会拿到「半装完」的中间态。
pub fn status_reports(adapter: &dyn AgentAdapter, files: &[PathBuf]) -> Vec<FileReport> {
    let _io = lock_hook_io();
    files
        .iter()
        .map(|path| match read_existing(path) {
            Ok(None) => FileReport {
                path: path.display().to_string(),
                managed: 0,
                error: None,
                switch_before: None,
            },
            Ok(Some(raw)) => match serde_json::from_str::<Value>(&raw) {
                // 先自己解析一遍只为「读不出来要报错误」这条：适配器的 managed_count 对
                // 坏文本只数出 0，状态页据此显示「未安装」，用户以为摘干净了其实没有。
                // 计数仍然交给适配器 —— 它才懂自己那种形状里哪几条是自家的。
                Ok(_) => FileReport {
                    path: path.display().to_string(),
                    managed: adapter.managed_count(&raw),
                    error: None,
                    switch_before: None,
                },
                Err(e) => FileReport::failed(path, format!("配置解析失败: {e}")),
            },
            Err(e) => FileReport::failed(path, e.to_string()),
        })
        .collect()
}

/// 写回前先备份。备份失败就不改 —— 宁可装不上，也不能把用户配置弄成不可恢复
fn apply_text(path: &Path, text: &str) -> Result<(), String> {
    if path.exists() {
        backup_once(path).map_err(|_| "备份失败，未改动配置".to_string())?;
    }
    write_atomic(path, text)
}

/// 整趟「读 → 改 → 落盘」在**同一把锁**里（PR-1 评审遗留项：上一版只串行了 IO 原语，
/// 读与写之间仍有窗口）。适配器只做纯文本变换，所以锁罩得住整趟。
pub fn install_files(adapter: &dyn AgentAdapter, files: &[PathBuf], exe: &Path) -> Vec<FileReport> {
    let _io = lock_hook_io();
    let command_for = hook_command(adapter, exe);
    files
        .iter()
        .map(|path| {
            let raw = match read_existing(path) {
                Ok(raw) => raw.unwrap_or_default(),
                Err(e) => return FileReport::failed(path, e.to_string()),
            };
            match adapter.install_in_text(&raw, &command_for) {
                Ok(text) => match apply_text(path, &text) {
                    Ok(()) => FileReport {
                        path: path.display().to_string(),
                        // 条数取「这份新文本里实际有几条自家条目」，不取追加计数：
                        // 磁盘上的事实才是状态页与「停用→再启用」恢复要相信的
                        managed: adapter.managed_count(&text),
                        error: None,
                        // 「原来不是开着」才算我们拨的：原本 true 的话卸载时不该动它
                        switch_before: adapter
                            .switch_before(&raw)
                            .filter(|was| was != &json!(true))
                            .filter(|_| adapter.has_switch()),
                    },
                    Err(e) => FileReport::failed(path, e),
                },
                Err(e) => FileReport::failed(path, e),
            }
        })
        .collect()
}

/// 卸载。`switches` 是状态文件里记的那份「装之前每个文件的总开关原值」：
/// 键是路径、值是原值（JSON `null` = 原来没这个键，恢复=删掉）；**没有这条记录就完全不碰开关**
/// —— 不是我们拨开的，就没资格关。
pub fn uninstall_files(
    adapter: &dyn AgentAdapter,
    files: &[PathBuf],
    switches: &Value,
) -> Vec<FileReport> {
    let _io = lock_hook_io();
    files
        .iter()
        .map(|path| {
            let Ok(raw) = read_existing(path) else {
                return FileReport::failed(path, "读取配置失败");
            };
            let Some(raw) = raw else {
                return FileReport {
                    path: path.display().to_string(),
                    managed: 0,
                    error: None,
                    switch_before: None,
                };
            };
            let before = switches.get(path.display().to_string());
            match adapter.uninstall_restoring_switch(&raw, before) {
                Ok(None) => FileReport {
                    path: path.display().to_string(),
                    managed: 0,
                    error: None,
                    switch_before: None,
                },
                Ok(Some((text, removed))) => match apply_text(path, &text) {
                    Ok(()) => FileReport {
                        path: path.display().to_string(),
                        managed: removed,
                        error: None,
                        switch_before: before.cloned(),
                    },
                    Err(e) => FileReport::failed(path, e),
                },
                Err(e) => FileReport::failed(path, e),
            }
        })
        .collect()
}

/// 卸载应用前的清理：把**每个已接线适配器**名下的自家条目都摘净。
///
/// 这里不按「当前联动的那个 Agent」走：应用都没了，状态文件里写的是谁已经不重要；而留在
/// 别人配置里的 `--pet-hook` 条目指向一个不存在的 exe，每来一次事件就失败一次。
/// 每个适配器只摘自己那种形状里的条目，摘不到就不改那个文件。
pub fn uninstall_everywhere(home: &Path, switches: &Value) -> Vec<FileReport> {
    adapters::wired()
        .iter()
        .flat_map(|adapter| uninstall_files(*adapter, &adapter.targets(home), switches))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::agent::adapters::claude_style::QODER;
    use crate::services::agent::adapters::zcode::ZCODE;
    use crate::services::agent::HOOK_PHASES;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pet-hook-io-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 装出来的命令必须带来源字段，且路径带空格时只对 exe 加引号。
    /// 缺 `--agent` 的行在收件侧按 qoder 兜底 —— 但「能兜底」不等于「该继续生产缺省形状」：
    /// 接线第二个 Agent 之后，少了这个字段就是桌宠对着别人的会话演。
    #[test]
    fn installed_commands_carry_the_adapter_id() {
        let dir = tmp_dir("cmd");
        let path = dir.join("settings.json");
        fs::write(&path, r#"{"theme":"dark"}"#).unwrap();
        let exe = Path::new(r"C:\Program Files\pet\desktop-pet.exe");

        let reports = install_files(&QODER, std::slice::from_ref(&path), exe);
        assert!(reports[0].error.is_none(), "{:?}", reports[0].error);
        assert_eq!(reports[0].managed, HOOK_PHASES.len());

        let text = fs::read_to_string(&path).unwrap();
        let config: Value = serde_json::from_str(&text).unwrap();
        let command = config["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .expect("命令必须是字符串")
            .to_string();
        assert_eq!(
            command,
            format!(
                "\"C:\\Program Files\\pet\\desktop-pet.exe\" {HOOK_MARKER} pre {AGENT_FLAG} qoder"
            ),
            "引号包住的是 exe，phase 后面必须跟来源"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 状态查询用的尺子与安装报告是同一把（都走适配器）；读不出来的文件必须**报错误**
    /// 而不是静默算 0 条，否则状态页会把「有陈旧条目」说成「未安装」。
    #[test]
    fn status_counts_ours_and_surfaces_unreadable_files() {
        let dir = tmp_dir("status");
        let good = dir.join("settings.json");
        let bad = dir.join("broken.json");
        fs::write(
            &good,
            r#"{"hooks":{"Stop":[{"hooks":[
            {"type":"command","command":"x.exe --pet-hook stop","timeout":2},
            {"type":"command","command":"keep.sh"}
        ]}]}}"#,
        )
        .unwrap();
        fs::write(&bad, "{ not json").unwrap();

        let reports = status_reports(&QODER, &[good, bad]);
        assert_eq!(reports[0].managed, 1, "只数自家的");
        assert_eq!(reports[0].error, None);
        assert!(
            reports[1].error.is_some(),
            "解析失败要成一条错误，不能静默算 0"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 清理按「每个适配器各摘各的」走：一个文件只出一份报告，自家摘净、用户的键留着。
    /// 这条同时是「`--pet-hook-cleanup` 走的是环境覆盖那一条路」的证据 —— 它是全仓唯一
    /// 改 `PET_AGENT_CONFIG_FILES` 的测试，别的测试都不读它，所以不会互相串。
    #[test]
    fn uninstall_everywhere_reports_each_targets_list_once_and_keeps_user_keys() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("everywhere");
        let path = dir.join("settings.json");
        let exe = Path::new(r"C:\app\desktop-pet.exe");
        std::env::set_var("PET_AGENT_CONFIG_FILES", &path);
        // ZCode 那份候选表也要钉成空的：不清这个变量，另一个测试设的目录会让它冒出候选，
        // 报告条数就不是这条能算准的了
        std::env::set_var("PET_AGENT_HOME", dir.join("no-agent-home"));
        // 环境里那两个样例文件的父目录存在才算候选；不存在时上面这条等于「一个候选都没有」
        fs::write(&path, r#"{"theme":"dark"}"#).unwrap();

        assert!(any_installed(&install_files(
            &QODER,
            &QODER.targets(&dir),
            exe
        )));

        let cleaned = uninstall_everywhere(&dir, &json!({}));
        // 报告数 = 各适配器**实际存在**的候选文件数（没有装的那个出 0 份，不是 1 份空报告）
        let expected: usize = adapters::wired()
            .iter()
            .map(|a| a.targets(&dir).len())
            .sum();
        assert_eq!(cleaned.len(), expected);
        assert_eq!(cleaned[0].managed, HOOK_PHASES.len());
        let after = fs::read_to_string(&path).unwrap();
        assert!(!after.contains(HOOK_MARKER), "自家条目该摘净");
        let config: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(config["theme"], "dark", "用户的键一个不少");

        std::env::remove_var("PET_AGENT_CONFIG_FILES");
        std::env::remove_var("PET_AGENT_HOME");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 总开关的「抄旧值 → 恢复」whole 走的是这条流水线（适配器单测只证文本变换）。
    /// 两个方向都要钉：装的时候把原值抄进报告（状态文件才有东西可存），
    /// 卸的时候**没有记录就绝不碰开关** —— 不是我们拨开的，就没资格关。
    #[test]
    fn switch_state_is_captured_on_install_and_restored_on_uninstall() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("switch");
        let cli = dir.join(".zcode").join("cli");
        fs::create_dir_all(&cli).unwrap();
        let path = cli.join("config.json");
        fs::write(&path, r#"{"hooks":{"enabled":false,"events":{}}}"#).unwrap();
        std::env::set_var("PET_AGENT_HOME", &dir);
        let exe = Path::new(r"C:\app\desktop-pet.exe");

        let reports = install_files(&ZCODE, &ZCODE.targets(&dir), exe);
        assert!(any_installed(&reports), "{:?}", reports[0].error);
        assert_eq!(
            reports[0].switch_before,
            Some(json!(false)),
            "装之前是关着的，必须记下来"
        );
        let after_install: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after_install["hooks"]["enabled"], true);

        let switches = json!({ path.display().to_string(): false });
        let cleaned = uninstall_files(&ZCODE, &ZCODE.targets(&dir), &switches);
        assert_eq!(cleaned[0].managed, ZCODE.events().len());
        let after_uninstall: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            after_uninstall,
            serde_json::from_str::<Value>(r#"{"hooks":{"enabled":false}}"#).unwrap(),
            "恢复到装之前：值写回 false，events 摘空后整个键一起删"
        );

        // 没有记录 = 不是我们拨的：一条都不该改
        fs::write(&path, r#"{"hooks":{"enabled":true,"events":{}}}"#).unwrap();
        let before = fs::read_to_string(&path).unwrap();
        let none_recorded = uninstall_files(&ZCODE, std::slice::from_ref(&path), &json!({}));
        assert_eq!(none_recorded[0].managed, 0, "没有自家条目就不算改动");
        assert_eq!(fs::read_to_string(&path).unwrap(), before, "一个字都不写");

        std::env::remove_var("PET_AGENT_HOME");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 「装成功才算用户的选择」的判据：设置页据此决定要不要往 agent-linkage.json 写选择。
    /// 全失败还去记，等于让下一次启用插件装一个从没成功过的 hook。
    #[test]
    fn any_installed_needs_a_file_without_error_and_with_entries() {
        let ok = |managed: usize, error: Option<&str>| FileReport {
            path: "x".into(),
            managed,
            error: error.map(str::to_string),
            switch_before: None,
        };
        assert!(any_installed(&[ok(12, None)]));
        assert!(
            any_installed(&[ok(0, Some("备份失败")), ok(12, None)]),
            "一个文件失败不算全失败"
        );
        assert!(!any_installed(&[]), "一个候选都没有 = 没装那个 Agent");
        assert!(
            !any_installed(&[ok(0, Some("配置解析失败"))]),
            "全部失败不能算装上"
        );
        assert!(
            !any_installed(&[ok(0, None)]),
            "managed=0 且无错 = 没写进任何条目，也不算装上"
        );
    }
}
