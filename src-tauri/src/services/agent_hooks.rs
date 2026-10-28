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
use tauri::{AppHandle, Manager};

use crate::services::agent::adapters::{self, AgentAdapter};
use crate::services::agent::backups;
use crate::services::agent::phases::AGENT_FLAG;

/// 自家条目的识别标记。它同时是 hook 分支的 CLI 参数，两边共用这一个常量
pub const HOOK_MARKER: &str = "--pet-hook";

/// 「这条路径要先问用户」的机器标记。命令层原样把带这个前缀的错误交给设置页，页面据此弹确认框；
/// 自动路径（停用→再启用、启动清理）看到它只能**跳过并报告**，不许当成普通失败重试。
pub const NEED_CONFIRM: &str = "[need-confirm]";

/// 拼一条「要先问」的文案。正文交给适配器 —— 每家客户端要用户确认的东西不一样。
pub fn need_confirm(adapter: &dyn AgentAdapter, count: usize) -> String {
    format!("{NEED_CONFIRM} {}", adapter.consent_prompt(count))
}

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

/// 备份文件名：`<path>.pre-pet-backup`。生成侧与清理侧共用 `backups::backup_path` 这一处定义。
pub fn backup_path(path: &Path) -> PathBuf {
    backups::backup_path(path)
}

/// 账本目录 = 宿主自己的数据目录（`%APPDATA%\<identifier>`）。安装路径用它记账；清理路径在
/// `linkage::app_data_standalone` 里按同一 Windows 约定推导出同一个目录 —— 只有这一种口径。
pub fn ledger_dir(app: &AppHandle) -> Option<PathBuf> {
    match app.path().app_data_dir() {
        Ok(dir) => Some(dir),
        Err(e) => {
            log::warn!("拿不到宿主数据目录，本次无法记录备份账本: {e}");
            None
        }
    }
}

/// 写回前先备份，并**记一条账**证明这份备份是我们写的。已存在的备份不是我们的：直接跳过、
/// 也不记账（清理侧靠账本判定，所以它永远不会被删）。记账失败就删掉刚抄的那份并报错 ——
/// 宁可装不上，也不留无法证明归属的备份。
fn backup_once(path: &Path, ledger_dir: Option<&Path>) -> Result<(), String> {
    let bak = backup_path(path);
    if bak.exists() {
        return Ok(());
    }
    fs::copy(path, &bak).map_err(|e| format!("复制备份失败: {e}"))?;
    // 安装路径一定带账本目录（`install_files` 先拦住了 None）；只有卸载路径在「备份已丢、
    // 用户配置还在」的退化情形下会走到这里，那时不记账、也不拦卸载 —— 这份无主备份在清理
    // 阶段会被跳过（宁可留一份垃圾，也不能让卸载装不回去）。
    let Some(dir) = ledger_dir else {
        return Ok(());
    };
    let bytes = match fs::read(&bak) {
        Ok(bytes) => bytes,
        Err(e) => {
            let _ = fs::remove_file(&bak);
            return Err(format!("读回备份失败: {e}"));
        }
    };
    if let Err(e) = backups::record(dir, &bak, &bytes) {
        let _ = fs::remove_file(&bak);
        return Err(e);
    }
    Ok(())
}

/// 原子写：走 `fsutil::write_atomic`（临时名带 pid + 序号，写完 fsync 再 rename）。
/// G3-04：hook 配置写坏会直接影响用户 CLI 的启动，落盘必须抗断电，
/// 所以不再保留本文件里那份手写实现。
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    crate::fsutil::write_atomic(path, text.as_bytes()).map_err(|e| e.to_string())
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
fn apply_text(path: &Path, text: &str, ledger_dir: Option<&Path>) -> Result<(), String> {
    if path.exists() {
        backup_once(path, ledger_dir).map_err(|_| "备份失败，未改动配置".to_string())?;
    }
    write_atomic(path, text)
}

/// 整趟「读 → 改 → 落盘」在**同一把锁**里（PR-1 评审遗留项：上一版只串行了 IO 原语，
/// 读与写之间仍有窗口）。适配器只做纯文本变换，所以锁罩得住整趟。
///
/// `ledger_dir` 是备份账本目录（宿主数据目录）：**新建备份必然会写账本**，拿不到目录就算
/// 备份失败；已存在的备份不是我们写的，不需要记账。
///
/// `confirm` 是用户的确认状态。确认门**下沉到这一层**（而不是只留在切换弹框里）：
/// 「安装」按钮、停用→再启用的自动重装、切换 Agent 三条路径都要过它，谁也别想绕过。
/// 没确认就一个文件都不写，返回的报告带着 [`NEED_CONFIRM`] 前缀的错误；命令层据此拒绝并要求确认，
/// 自动路径据此跳过本次安装（不记 choice、不落开关记录）。
pub fn install_files(
    adapter: &dyn AgentAdapter,
    files: &[PathBuf],
    exe: &Path,
    ledger_dir: Option<&Path>,
    confirm: bool,
) -> Vec<FileReport> {
    let _io = lock_hook_io();
    if !confirm {
        if let Some(count) = pending_consent(adapter, files) {
            let reason = need_confirm(adapter, count);
            return files
                .iter()
                .map(|path| FileReport::failed(path, reason.clone()))
                .collect();
        }
    }
    let command_for = hook_command(adapter, exe);
    files
        .iter()
        .map(|path| {
            let raw = match read_existing(path) {
                Ok(raw) => raw.unwrap_or_default(),
                Err(e) => return FileReport::failed(path, e.to_string()),
            };
            match adapter.install_in_text(&raw, &command_for) {
                // A23-D1 规则 4：账本目录拿不到就不许**新建**备份 —— 备份必须可证明归属，
                // 否则清理阶段永远删不掉它。宁可装不上，也不留无主备份。
                Ok(_) if path.exists() && !backup_path(path).exists() && ledger_dir.is_none() => {
                    FileReport::failed(path, "备份失败，未改动配置".to_string())
                }
                Ok(text) => match apply_text(path, &text, ledger_dir) {
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
                Ok(Some((text, removed))) => match apply_text(path, &text, None) {
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

/// 目录里那个 `<prefix>*<suffix>` 中**最后被写过**的一份。文件名里的日期格式我们不确定，
/// 所以按 mtime 挑而不是自己拼日期 —— 拼错的表现是「永远查不出问题」，那种假绿最坏。
fn newest_log(watch: &adapters::LogWatch) -> Option<(PathBuf, u64)> {
    let entries = fs::read_dir(&watch.dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf, u64)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if !name.starts_with(watch.prefix) || !name.ends_with(watch.suffix) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if best.as_ref().is_none_or(|(t, _, _)| mtime >= *t) {
            best = Some((mtime, path, meta.len()));
        }
    }
    best.map(|(_, path, len)| (path, len))
}

/// 装之前的日志「记号」：那份日志已经写到哪了。`None` = 当时还没有这份日志
/// （没有日志目录，或目录里还没有文件）；装之后若冒出新文件，就整份当新增来读。
#[derive(Debug)]
pub struct LogMark {
    pub path: PathBuf,
    pub len: u64,
}

/// 这家客户端有可查的日志时记下记号；没有就返回 `None`（调用方据此连自检都不做）。
pub fn mark_log(adapter: &dyn AgentAdapter, home: &Path) -> Option<LogMark> {
    let (path, len) = newest_log(&adapter.log_watch(home)?)?;
    Some(LogMark { path, len })
}

/// 装后自检（方案 §3.5）：只读安装之后新增的那些行，坏行的判据住在适配器里。
///
/// **五档**结果要分开，其中最容易被糊弄的是「没查」与「查了但没新行」：
/// * `None` —— 这一家根本没有可查的日志（Codex / WorkBuddy / Qoder）。设置页显示空白，
///   不是「一切正常」。
/// * `unavailable` —— 该有日志却没读到（没文件、读不出来），要说出来。
/// * `problem` —— 查出问题并附日志原文。
/// * `pending` —— 装完到自检之间**没有任何新日志行**：客户端还没跑下一次事件，自检没的是结论，
///   不是「没问题」。上一版把它标成 `ok` 是假绿（G2-11）。
/// * `ok` —— 真读到了新增行且没有指向我们的坏行。
///
/// 把前几档说成最后一档，等于给用户一张假的安全条。
pub fn log_self_check(
    adapter: &dyn AgentAdapter,
    mark: Option<&LogMark>,
    home: &Path,
    our_command: &str,
) -> Option<Value> {
    let watch = adapter.log_watch(home)?;
    let name = adapter.display_name();
    let (path, len) = match newest_log(&watch) {
        Some(found) => found,
        // 该有日志却一份都找不到 = 「没查成」，不是「查过没问题」。归 unavailable 而不是 ok，
        // 也不能归 pending（pending 专指「日志在、但装完到自检之间没有新行」）。
        None => {
            return Some(json!({
                "status": "unavailable",
                "detail": format!("没找到 {name} 的日志文件，装后自检没做成"),
            }))
        }
    };
    // 还是那份文件就只看新增的一段；冒出新文件（跨天，或装之前根本没有日志）就整份算新增
    let start = mark.filter(|m| m.path == path).map_or(0, |m| m.len);
    if len <= start {
        return Some(json!({
            "status": "pending",
            "detail": "装完到自检之间没有新日志行：客户端还没跑下一次事件，这一项没法判定",
        }));
    }
    let Ok(all) = fs::read(&path) else {
        return Some(json!({
            "status": "unavailable",
            "detail": format!("{name} 的日志读不出来，装后自检没做成"),
        }));
    };
    let end = (len as usize).min(all.len());
    let tail = String::from_utf8_lossy(&all[start as usize..end]).to_string();
    Some(match adapter.scan_log_tail(&tail, our_command) {
        Some(line) => json!({
            "status": "problem",
            "detail": format!("{name} 读完新配置后报了错，下面这行是日志原文"),
            "logPath": path.display().to_string(),
            "line": line,
        }),
        None => json!({ "status": "ok", "detail": "日志里没有指向我们的坏行" }),
    })
}

/// 一个候选文件的「盘上事实」：真的生效了几条、命令串里是不是我们这份 exe。
#[derive(Debug, serde::Serialize)]
pub struct FileCheck {
    pub path: String,
    pub found: usize,
    pub expected: usize,
    /// 盘上的文本里有几条命令指向**当前** exe。换过安装路径时这里有值对不上。
    pub command_found: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// 装完回头读盘核对 —— 不信安装报告，只信文件里实际的条数与命令串。
///
/// 报告能对得上而盘上不对的形状有两种：写到了别的路径（候选列表只说「会写哪里」，
/// 报告说的也是同一批候选），或者 exe 换过路径导致旧命令还在。两者都会让状态页显示
/// 「已安装」而事件其实不来 —— 这正是 G2-11 要判红的假绿，所以自检必须落在盘上而不是报告上。
pub fn verify_installed(adapter: &dyn AgentAdapter, files: &[PathBuf], exe: &Path) -> Vec<FileCheck> {
    let display = exe.display().to_string();
    // JSON 里的 Windows 路径是双反斜杠，直接按显示串找会永远找不到（假红）：
    // 用 serde 转义一次，按配置文件里真实会出现的写法比对。
    let needle = serde_json::to_string(&display)
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or(display);
    let expected = adapter.events().len();
    // 候选列表为空 = 一个文件都没写下去（装完文件被删、目录不在了）：这是比条数不对更硬的假绿
    if files.is_empty() {
        return vec![FileCheck {
            path: "(候选文件列表)".to_string(),
            found: 0,
            expected,
            command_found: 0,
            problem: Some("一个候选文件都没有：配置没落盘".to_string()),
        }];
    }
    let _io = lock_hook_io();
    files
        .iter()
        .map(|path| {
            let check = |found: usize, command_found: usize, problem: Option<String>| FileCheck {
                path: path.display().to_string(),
                found,
                expected,
                command_found,
                problem,
            };
            let raw = match read_existing(path) {
                Ok(Some(raw)) => raw,
                // 候选文件不存在 = 根本没写下去。装完就不在，比条数不对更糟
                Ok(None) => return check(0, 0, Some("装完文件不存在，配置没落盘".to_string())),
                Err(e) => return check(0, 0, Some(format!("装完读不出来: {e}"))),
            };
            if let Err(e) = serde_json::from_str::<Value>(&raw) {
                return check(0, 0, Some(format!("装完解析不了（写坏了）: {e}")));
            }
            let found = adapter.managed_count(&raw);
            let command_found = raw.matches(&needle).count();
            let problem = if found != expected {
                Some(format!("盘上只有 {found} 条自家条目，应为 {expected} 条"))
            } else if command_found < expected {
                Some(format!(
                    "盘上只有 {command_found} 条命令指向当前 exe，应为 {expected} 条（可能换过安装路径）"
                ))
            } else {
                None
            };
            check(found, command_found, problem)
        })
        .collect()
}

/// 装后自检汇总：**先看盘上事实，再看日志增量**，两者都过才给绿。
///
/// * `ok` —— 每个候选文件的条数与命令串都对得上，且日志（有的话）没有坏行；
/// * `pending` —— 盘上核对通过，但日志还没有新增行（客户端没跑下一次事件）；
/// * `unverified` —— 盘上核对通过，但该有的日志读不到（没做成日志自检）；
/// * `problem` —— 任一处对不上，`detail` 指到第一个问题（路径 + 原因）。
///
/// 自检的输入是 `files` 与 `exe` 本身，不是安装返回的报告 —— 报告全绿而盘上不对时这里必须判红。
pub fn self_check(
    adapter: &dyn AgentAdapter,
    files: &[PathBuf],
    exe: &Path,
    mark: Option<&LogMark>,
    home: &Path,
    our_command: &str,
) -> Value {
    let checks = verify_installed(adapter, files, exe);
    let log = log_self_check(adapter, mark, home, our_command);
    let log_status = log
        .as_ref()
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str);
    let log_detail = log
        .as_ref()
        .and_then(|v| v.get("detail"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let expected = adapter.events().len();
    let (status, detail) = if let Some(bad) = checks.iter().find(|c| c.problem.is_some()) {
        let why = bad.problem.as_deref().unwrap_or("盘上核对失败");
        ("problem", format!("{}: {why}", bad.path))
    } else {
        match log_status {
            Some("problem") => ("problem", log_detail.to_string()),
            Some("pending") => (
                "pending",
                format!("盘上核对通过（每文件 {expected} 条）；{log_detail}"),
            ),
            Some("unavailable") => (
                "unverified",
                format!("盘上核对通过（每文件 {expected} 条），但{log_detail}"),
            ),
            Some(_) => (
                "ok",
                format!("盘上核对通过（每文件 {expected} 条）；{log_detail}"),
            ),
            // 没有可查日志的客户端：盘上核对就是全部证据，但日志自检这一环**没做** ——
            // 不能报 `ok`（那是「查过且没问题」），只能报 `unverified`（G2-11 契约）
            None => (
                "unverified",
                format!("该客户端没有可查日志；盘上核对通过（每文件 {expected} 条）"),
            ),
        }
    };
    json!({ "status": status, "detail": detail, "files": checks, "log": log })
}

/// 切换 Agent 之前问一句：这个适配器在它的候选文件里需不需要用户先确认
/// （ZCode 的总开关显式关着、且用户自己配过 hook）。多个文件要确认的条数**加总**成一个数 ——
/// 弹两次一样的框不如一次说清「一共 N 条」。
/// 读文件住在这一层：适配器只做文本变换。
pub fn pending_consent(adapter: &dyn AgentAdapter, files: &[PathBuf]) -> Option<usize> {
    let mut total = 0;
    let mut needed = false;
    for path in files {
        let Ok(Some(raw)) = read_existing(path) else {
            continue;
        };
        if let Some(count) = adapter.switch_needs_consent(&raw) {
            needed = true;
            total += count;
        }
    }
    needed.then_some(total)
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

        let reports = install_files(
            &QODER,
            std::slice::from_ref(&path),
            exe,
            Some(dir.as_path()),
            true,
        );
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
            exe,
            Some(dir.join("ledger").as_path()),
            true,
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

        let reports = install_files(
            &ZCODE,
            &ZCODE.targets(&dir),
            exe,
            Some(dir.join("ledger").as_path()),
            true,
        );
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

    /// 切换前的确认问：只有「显式关着 + 用户自己配过条目」才要问；
    /// 多个文件要确认的条数加总成一个数（弹两次一样的框不如一次说清）。
    #[test]
    fn pending_consent_only_when_the_switch_is_explicitly_off() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("consent");
        std::env::set_var("PET_AGENT_HOME", &dir);
        std::env::remove_var("PET_AGENT_CONFIG_FILES");
        let cli = dir.join(".zcode").join("cli");
        fs::create_dir_all(&cli).unwrap();
        let file = cli.join("config.json");

        fs::write(
            &file,
            r#"{"hooks":{"enabled":false,"events":{"Stop":[{"hooks":[{"type":"command","command":"keep.sh"}]}]}}}"#,
        )
        .unwrap();
        assert_eq!(
            pending_consent(&ZCODE, &ZCODE.targets(&dir)),
            Some(1),
            "关着的开关 + 用户那 1 条 → 要问"
        );

        // 用户一条都没有：打开开关不会连带启用任何东西，不该拦路
        fs::write(&file, r#"{"hooks":{"enabled":false,"events":{}}}"#).unwrap();
        assert_eq!(pending_consent(&ZCODE, &ZCODE.targets(&dir)), None);

        // 本来就开着：没什么要确认的
        fs::write(
            &file,
            r#"{"hooks":{"enabled":true,"events":{"Stop":[{"hooks":[{"type":"command","command":"keep.sh"}]}]}}}"#,
        )
        .unwrap();
        assert_eq!(pending_consent(&ZCODE, &ZCODE.targets(&dir)), None);

        // 没有这个键（ZCode 按关处理，但「开关现在是关的」那句文案不成立）→ 不问
        fs::write(
            &file,
            r#"{"hooks":{"events":{"Stop":[{"hooks":[{"type":"command","command":"keep.sh"}]}]}}}"#,
        )
        .unwrap();
        assert_eq!(pending_consent(&ZCODE, &ZCODE.targets(&dir)), None);

        // Qoder 没有总开关，永远不问
        assert_eq!(pending_consent(&QODER, std::slice::from_ref(&file)), None);

        std::env::remove_var("PET_AGENT_HOME");
        let _ = fs::remove_dir_all(&dir);
    }

    /// G2-11 / t38-B：没有可查日志的客户端，装后自检必须是 `unverified` **对象** ——
    /// 它不能报 `ok`（那是「查过且没问题」），也不能报 `null`（旧契约，e2e 已按新口径改写）。
    /// 同时仍要钉住「没日志」这个事实：`log_watch` / `mark_log` / `log_self_check` 都返回 `None`。
    /// 最后一条反查是必要的：光看三家全 `None`，「所有适配器都返回 None」这个变异也会一路绿过去。
    #[test]
    fn a_family_without_a_log_reports_unverified_instead_of_ok_or_null() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("no-log-watch");
        std::env::set_var("PET_AGENT_HOME", &dir);
        // 故意在旁边造一份 ZCode 形状的日志：没有日志可查的那三家不许读到别人的东西
        let log = dir.join(".zcode").join("cli").join("log");
        fs::create_dir_all(&log).unwrap();
        fs::write(
            log.join("zcode-2026-10-18.jsonl"),
            r#"{"event":"config_file_invalid"}"#,
        )
        .unwrap();
        let exe = Path::new(r"C:\app\desktop-pet.exe");

        for adapter in adapters::wired().iter().filter(|a| a.id() != "zcode") {
            assert!(
                adapter.log_watch(&dir).is_none(),
                "{} 没有可查的日志，log_watch 必须给 None",
                adapter.id()
            );
            assert!(
                mark_log(*adapter, &dir).is_none(),
                "{} 不该去记别人的日志号",
                adapter.id()
            );
            assert!(
                log_self_check(*adapter, None, &dir, &format!("--agent {}", adapter.id()))
                    .is_none(),
                "{} 的日志探针必须是「没这回事」",
                adapter.id()
            );

            // 先真的装上，再让自检只看盘上事实：没日志 ≠ 没装。
            // Qoder/Codex/WorkBuddy 的 targets 只认已存在的目录（claude_style::targets），
            // 夹具里先把 dir_hint 造出来；DSH 是桥形态、根本没有 hook 文件（targets 恒空），跳过。
            for leaf in adapter.dir_hint() {
                fs::create_dir_all(dir.join(leaf)).unwrap();
            }
            let files = adapter.targets(&dir);
            if files.is_empty() {
                assert_eq!(
                    adapter.id(),
                    "dsh",
                    "{} 有目标目录却没有可装的文件",
                    adapter.id()
                );
                continue;
            }
            for path in &files {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).unwrap();
                }
            }
            let reports =
                install_files(*adapter, &files, exe, Some(dir.as_path()), true);
            assert!(
                any_installed(&reports),
                "{}：夹具要先装上，否则自检看到的是「文件不存在」",
                adapter.id()
            );
            let check = self_check(
                *adapter,
                &files,
                exe,
                None,
                &dir,
                &format!("--agent {}", adapter.id()),
            );
            assert_eq!(
                check["status"], "unverified",
                "{}：没有可查日志时只能报 unverified，不能报 ok 或 null：{check}",
                adapter.id()
            );
            assert!(
                check["detail"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("没有可查日志"),
                "{}：detail 要点明没有可查日志：{check}",
                adapter.id()
            );
            uninstall_files(*adapter, &files, &json!({}));
        }
        assert!(
            log_self_check(&ZCODE, None, &dir, "--agent zcode").is_some(),
            "同一份日志摆在面前，ZCode 必须查得出（否则上面三条是全体返回 None 的假绿）"
        );
        std::env::remove_var("PET_AGENT_HOME");
    }

    #[test]
    fn self_check_separates_problem_from_ok_from_not_checked() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("selfcheck");
        std::env::set_var("PET_AGENT_HOME", &dir);
        let log = dir.join(".zcode").join("cli").join("log");
        let bad_line = r#"{"event":"config_file_invalid","path":"config.json"}"#;

        // 1) 还没有日志目录 = 没查
        assert_eq!(
            log_self_check(
                &ZCODE,
                mark_log(&ZCODE, &dir).as_ref(),
                &dir,
                "--agent zcode"
            )
            .expect("ZCode 有可查日志")["status"],
            "unavailable",
            "没日志时必须说「没查」，不是「查过且没问题」"
        );

        // 2) 装之前就有的坏行按字节偏移切掉，不算我们引入的
        fs::create_dir_all(&log).unwrap();
        let file = log.join("zcode-2026-10-18.jsonl");
        fs::write(&file, format!("{bad_line}\n")).unwrap();
        let mark = mark_log(&ZCODE, &dir).expect("该能挑出这份日志");
        fs::write(&file, format!("{bad_line}\n{{\"level\":\"info\"}}\n")).unwrap();
        let ok =
            log_self_check(&ZCODE, Some(&mark), &dir, "--agent zcode").expect("ZCode 有可查日志");
        assert_eq!(ok["status"], "ok", "新增的那行不是坏行：{ok}");

        // 3) 装之后追加坏行 → problem，并把原文交出去
        fs::write(
            &file,
            format!("{bad_line}\n{{\"level\":\"info\"}}\n{bad_line}2\n"),
        )
        .unwrap();
        let problem =
            log_self_check(&ZCODE, Some(&mark), &dir, "--agent zcode").expect("ZCode 有可查日志");
        assert_eq!(problem["status"], "problem");
        assert!(
            String::from(problem["line"].as_str().unwrap_or_default())
                .contains("config_file_invalid"),
            "设置页要能附上日志原文：{problem}"
        );

        // 4) 跨天冒出的新文件整份都算新增：记号对不上路径，不能当成「没新行」。
        //    先删掉旧的那份，免得「挑最新日志」按 mtime 比较时两份同刻、结果不稳定。
        fs::remove_file(&file).unwrap();
        fs::write(log.join("zcode-2026-10-19.jsonl"), format!("{bad_line}\n")).unwrap();
        assert_eq!(
            log_self_check(&ZCODE, Some(&mark), &dir, "--agent zcode").expect("ZCode 有可查日志")
                ["status"],
            "problem",
            "新日志文件里的坏行也是我们的责任范围"
        );

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

    /// G2-09：确认门下沉到 `install_files` 之后，「安装」按钮、停用→再启用的自动重装、
    /// 切换 Agent 三条路径共用同一道闸。没确认就必须**一个字节都不写**，且错误带机器标记
    /// （命令层据此回 `[need-confirm]`，自动路径据此跳过这次安装）。
    #[test]
    fn install_without_consent_writes_nothing_and_reports_need_confirm() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("consent-gate");
        std::env::set_var("PET_AGENT_HOME", &dir);
        std::env::remove_var("PET_AGENT_CONFIG_FILES");
        let cli = dir.join(".zcode").join("cli");
        fs::create_dir_all(&cli).unwrap();
        let file = cli.join("config.json");
        let raw = r#"{"hooks":{"enabled":false,"events":{"Stop":[{"hooks":[{"type":"command","command":"keep.sh"}]}]}}}"#;
        fs::write(&file, raw).unwrap();
        let exe = Path::new(r"C:\app\desktop-pet.exe");

        let gated = install_files(
            &ZCODE,
            &ZCODE.targets(&dir),
            exe,
            Some(dir.join("ledger").as_path()),
            false,
        );
        assert!(!any_installed(&gated), "没确认不能算装上");
        let reason = gated[0].error.clone().expect("没确认必须报错");
        assert!(
            reason.starts_with(NEED_CONFIRM),
            "错误要带机器标记，命令层才认得出来: {reason}"
        );
        assert!(reason.contains("1 条"), "文案要带要确认的条数: {reason}");
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            raw,
            "没确认就一个字节都不写"
        );

        // 确认之后同一条路径正常装上
        let installed = install_files(
            &ZCODE,
            &ZCODE.targets(&dir),
            exe,
            Some(dir.join("ledger").as_path()),
            true,
        );
        assert!(any_installed(&installed), "{:?}", installed[0].error);
        assert_eq!(installed[0].managed, ZCODE.events().len());

        std::env::remove_var("PET_AGENT_HOME");
        let _ = fs::remove_dir_all(&dir);
    }

    /// G2-11：自检必须重新读盘核对（路径 + 条数 + 命令串），不能拿安装报告当证据。
    /// 这里构造三种「报告全绿但盘上不对」的假绿：条目被切少、换过安装路径、候选文件消失。
    #[test]
    fn self_check_judges_the_files_not_the_install_report() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("selfcheck-files");
        std::env::set_var("PET_AGENT_HOME", &dir);
        std::env::remove_var("PET_AGENT_CONFIG_FILES");
        let cli = dir.join(".zcode").join("cli");
        fs::create_dir_all(&cli).unwrap();
        let file = cli.join("config.json");
        fs::write(&file, r#"{"hooks":{"enabled":true,"events":{}}}"#).unwrap();
        // 装之前先造一份 ZCode 形状的日志（进程内的 mark_log 才有记号可记）：
        // 这样「盘上对、日志没有新行」才落在 pending 这一档，而不是 unavailable。
        let log = dir.join(".zcode").join("cli").join("log");
        fs::create_dir_all(&log).unwrap();
        fs::write(log.join("zcode-2026-10-18.jsonl"), "{\"level\":\"info\"}\n").unwrap();
        let exe = Path::new(r"C:\app\desktop-pet.exe");
        let reports = install_files(
            &ZCODE,
            &ZCODE.targets(&dir),
            exe,
            Some(dir.join("ledger").as_path()),
            true,
        );
        assert!(any_installed(&reports));

        // 盘上确实有 7 条、命令指向这份 exe：日志还没新行 → pending（不能是 ok）
        let fresh = self_check(
            &ZCODE,
            &ZCODE.targets(&dir),
            exe,
            mark_log(&ZCODE, &dir).as_ref(),
            &dir,
            "--agent zcode",
        );
        assert_eq!(fresh["status"], "pending", "{fresh}");
        assert_eq!(fresh["files"][0]["found"], ZCODE.events().len());

        // 盘上只剩 1 条（装到别处 / 被别的工具改回）：报告还是 7 条，自检必须判红
        fs::write(
            &file,
            r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"x.exe --pet-hook pre --agent zcode"}]}]}}"#,
        )
        .unwrap();
        let tampered = self_check(&ZCODE, &ZCODE.targets(&dir), exe, None, &dir, "--agent zcode");
        assert_eq!(tampered["status"], "problem", "{tampered}");
        assert!(
            tampered["detail"].as_str().unwrap_or("").contains("7 条"),
            "问题要指到文件与应有的条数: {tampered}"
        );

        // 换过安装路径：条数对、命令串不是当前 exe → 同样是假绿，必须判红
        fs::write(&file, r#"{"hooks":{"enabled":true,"events":{}}}"#).unwrap();
        install_files(
            &ZCODE,
            &ZCODE.targets(&dir),
            Path::new(r"C:\old\desktop-pet.exe"),
            Some(dir.join("ledger-old").as_path()),
            true,
        );
        let moved = self_check(&ZCODE, &ZCODE.targets(&dir), exe, None, &dir, "--agent zcode");
        assert_eq!(moved["status"], "problem", "{moved}");
        assert!(
            moved["detail"].as_str().unwrap_or("").contains("exe"),
            "要指出命令串不对: {moved}"
        );

        // 装完候选文件消失 = 配置没落盘
        fs::remove_file(&file).unwrap();
        let gone = self_check(&ZCODE, &ZCODE.targets(&dir), exe, None, &dir, "--agent zcode");
        assert_eq!(gone["status"], "problem", "{gone}");

        // 没有可查日志的客户端（Qoder）：盘上核对通过，但日志自检没做 → 只能报 unverified
        let qoder = dir.join("qoder-settings.json");
        fs::write(&qoder, r#"{"theme":"dark"}"#).unwrap();
        install_files(
            &QODER,
            std::slice::from_ref(&qoder),
            exe,
            Some(dir.join("ledger-qoder").as_path()),
            true,
        );
        let no_log = self_check(
            &QODER,
            std::slice::from_ref(&qoder),
            exe,
            None,
            &dir,
            "--agent qoder",
        );
        assert_eq!(no_log["status"], "unverified", "{no_log}");
        assert_eq!(no_log["log"], Value::Null, "这家没有可查日志");
        assert!(
            no_log["detail"]
                .as_str()
                .unwrap_or("")
                .contains("没有可查日志"),
            "别把「没做日志自检」说成查过了: {no_log}"
        );

        std::env::remove_var("PET_AGENT_HOME");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 装完到自检之间没有新日志行 = `pending`，不是 `ok`。这一条是 G2-11 里最容易假绿的一档：
    /// 客户端还没跑到下一次事件时，日志本来就不会变，把它说成「查过没问题」等于没查就发合格证。
    #[test]
    fn no_new_log_lines_is_pending_not_ok() {
        let _env = adapters::lock_test_env();
        let dir = tmp_dir("pending-log");
        std::env::set_var("PET_AGENT_HOME", &dir);
        let log = dir.join(".zcode").join("cli").join("log");
        fs::create_dir_all(&log).unwrap();
        let file = log.join("zcode-2026-10-18.jsonl");
        fs::write(&file, "{\"level\":\"info\"}\n").unwrap();
        let mark = mark_log(&ZCODE, &dir).expect("该能挑出这份日志");
        let out = log_self_check(&ZCODE, Some(&mark), &dir, "--agent zcode").expect("有可查日志");
        assert_eq!(out["status"], "pending", "{out}");
        std::env::remove_var("PET_AGENT_HOME");
        let _ = fs::remove_dir_all(&dir);
    }
}
