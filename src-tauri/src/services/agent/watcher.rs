use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use tauri::{AppHandle, Emitter, Manager};

use super::inbox::{enforce_inbox_cap, inbox_dir};
use super::state::{bounded_str, event_detail, now_ms, prompt_title, AgentState, AgentWatcher};

/// 超过这个长度的行视为畸形数据，跳过以免永久卡住读取偏移
const MAX_LINE_BYTES: usize = 256 * 1024;

/// 一批增量里能算「已消费」的部分：到最后一个换行为止。
/// 返回 (该换行的下标, 前进后的偏移)；整段里没有换行时返回 None —— 这时偏移不能动。
pub(super) fn complete_line_prefix(start: u64, bytes: &[u8]) -> Option<(usize, u64)> {
    let end = bytes.iter().rposition(|b| *b == b'\n')?;
    Some((end, start + end as u64 + 1))
}

/// 读增量该从哪一字节开始：没记过从 0 起；记过且不超过当前长度就沿用；
/// 记录比文件还大说明文件被 `enforce_inbox_cap` 清空或轮换过，**从头再读**而不是钳到末尾。
pub(super) fn resume_offset(stored: Option<u64>, size: u64) -> u64 {
    match stored {
        Some(offset) if offset <= size => offset,
        _ => 0,
    }
}

/// 一行事件里的来源 Agent。缺 `agent` 字段的行按 `qoder` 处理：A01 及更早写的收件文件
/// 就是这个形状，不能因为没带来源就把用户已经在跑的事件丢掉。
/// 这一行该不该进状态机与广播：只有来源与当前联动的 Agent 一致才进。
/// 单独成函数是为了让「一致/不一致」两种情况都能离线断言 —— 过滤反了是最致命的写法，
/// 只靠 runner 抓等于把它留到运行时才发现。
fn source_matches(value: &Value, current: &str) -> bool {
    line_agent(value) == current
}

fn line_agent(value: &Value) -> &str {
    value
        .get("agent")
        .and_then(Value::as_str)
        .unwrap_or(super::phases::DEFAULT_AGENT)
}

/// 读一个 phase 文件的增量。只消费到最后一个换行，半行留给下一次。
///
/// 偏移量只在真正消费掉若干整行之后才前进：原先是先写成 `size` 再读，
/// 于是「读失败」或「增量里还没有换行」（hook 写一半触发 watcher 的常见形状）
/// 都会把没消费的字节当成已消费，那些事件永久丢失 —— 注释里承诺的「留给下一次」并不成立。
fn drain_file(state: &Arc<AgentState>, app: &AppHandle, path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    let size = meta.len();

    let start = {
        let offsets = state.offsets.lock().unwrap_or_else(|p| p.into_inner());
        resume_offset(offsets.get(path).copied(), size)
    };
    if start == size {
        return;
    }

    let Ok(mut file) = fs::File::open(path) else {
        return;
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut bytes = Vec::new();
    if (&mut file)
        .take(size - start)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return;
    }
    drop(file);

    let Some((end, next)) = complete_line_prefix(start, &bytes) else {
        // 还没有完整一行：偏移保持不动，等 hook 把这一行写完再读
        return;
    };
    state
        .offsets
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(path.to_path_buf(), next);

    // 联动关着：偏移量照样推进（这是「只推进偏移量」的字面意思 —— 重新启用插件时
    // 不会把这些陈旧事件当作新事件重放一遍），但不进状态机、不发 agent:event、不拨总状态。
    if !super::linkage::broadcast_allowed() {
        return;
    }

    let phase_from_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();

    for line in bytes[..=end].split(|b| *b == b'\n') {
        if line.is_empty() || line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        // 来源过滤：与当前 Agent 不一致的行不进状态机、不广播。偏移量在本函数开头
        // 已经推进过了，所以「只推进偏移量」在这里天然成立 —— 切换那一两秒里旧 Agent
        // 还在路上的事件、卸旧失败的残余条目、用户手拷过去的旧配置，都走这一条。
        let source = line_agent(&value);
        if !source_matches(&value, &super::linkage::current_agent()) {
            log::debug!("忽略来源为 {source} 的 Agent 事件：与当前联动的 Agent 不一致");
            continue;
        }
        let phase = value
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or(&phase_from_name);
        let payload = value.get("payload").cloned().unwrap_or(Value::Null);
        let kind = payload
            .get("notification_type")
            .or_else(|| payload.get("notification_kind"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let session = bounded_str(&payload, "session_id", 96);
        let detail = event_detail(&payload);
        let title = prompt_title(&payload);

        let Some(event_state) = state.apply(phase, &session, kind, title.as_deref()) else {
            continue;
        };
        let (title_now, steps_now) = state.active_summary();
        let _ = app.emit(
            "agent:event",
            json!({
                "phase": phase,
                "sessionId": session,
                // 来源标识：payload 只增字段，既有字段一名不改
                "agent": source,
                "toolName": bounded_str(&payload, "tool_name", 64),
                // 命令/路径摘要：是否显示交给插件侧的开关
                "detail": detail,
                "notificationKind": kind,
                // 总状态只在翻转时广播，插件冷启动（会话已进行中才启用）时拿不到，
                // 所以每条事件都顺带当前会话的标题与步数，卡片不至于空白
                "title": title_now,
                "steps": steps_now,
                "at": value.get("at").and_then(Value::as_i64).unwrap_or_else(now_ms),
            }),
        );
        state.publish(app, Some((phase, event_state)));
    }
}

/// 启动时把已有文件对齐到末尾：历史事件不该在每次开机时重放一遍
fn fast_forward(state: &AgentState, dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut offsets = state.offsets.lock().unwrap_or_else(|p| p.into_inner());
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            if let Ok(meta) = fs::metadata(&path) {
                offsets.insert(path, meta.len());
            }
        }
    }
}

fn drain_all(state: &Arc<AgentState>, app: &AppHandle, dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                drain_file(state, app, &path);
            }
        }
    }
}

pub fn spawn_agent_watcher(app: &AppHandle) -> Result<AgentWatcher, String> {
    use notify::{EventKind, RecursiveMode, Watcher};

    let dir = inbox_dir(&app.path().app_data_dir().map_err(|e| e.to_string())?);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 Agent 收件目录失败: {e}"))?;

    let state = app.state::<Arc<AgentState>>().inner().clone();
    fast_forward(&state, &dir);

    let sink = app.clone();
    let root = dir.clone();
    // 一次事件会连发多个通知，且落盘与通知之间有延迟：用一把闸合并成一轮，
    // 每轮扫两遍（间隔 120ms），第二遍负责吃掉刚追上来的尾巴
    let ticking = Arc::new(AtomicBool::new(false));
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if matches!(event.kind, EventKind::Access(_) | EventKind::Remove(_)) {
            return;
        }
        let flag = ticking.clone();
        if flag.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = sink.clone();
        let state = state.clone();
        let root = root.clone();
        std::thread::spawn(move || {
            drain_all(&state, &app, &root);
            std::thread::sleep(Duration::from_millis(120));
            drain_all(&state, &app, &root);
            // 暂停时连总状态也不拨：见 drain_file 里同一条口径的注释
            if super::linkage::broadcast_allowed() {
                state.publish(&app, None);
            }
            flag.store(false, Ordering::SeqCst);
        });
    })
    .map_err(|e| format!("创建 Agent 收件 watcher 失败: {e}"))?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("监听 Agent 收件目录失败: {e}"))?;
    Ok(AgentWatcher { _inner: watcher })
}

/// 会话过期的兜底：没有新事件时也得有人把状态拨回 idle
pub fn start_agent_ticker(app: &AppHandle) {
    let sink = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(20));
        let Ok(app_data) = sink.path().app_data_dir() else {
            continue;
        };
        let dir = inbox_dir(&app_data);
        enforce_inbox_cap(&dir);
        let state = sink.state::<Arc<AgentState>>().inner().clone();
        // 收件目录的上限检查照做（那是磁盘卫生，与广播无关），只是暂停时不往外拨状态
        if super::linkage::broadcast_allowed() {
            state.publish(&sink, None);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{complete_line_prefix, line_agent, resume_offset, source_matches};
    use serde_json::json;

    /// 读取闸门的核心不变量：没有换行 = 一个字节都不算消费。
    /// 写反了（推进到末尾）的症状是「hook 写一半时 watcher 醒来 → 那行永久丢失」，
    /// 而且运行时只表现为偶尔少一个事件，离线很难复现。
    #[test]
    fn a_half_written_line_is_never_counted_as_consumed() {
        assert_eq!(complete_line_prefix(0, b""), None);
        assert_eq!(complete_line_prefix(0, b"{\"phase\":\"pre\"}"), None);
        // 换行在中间：只消费到换行（含），后面那半行留给下一次
        assert_eq!(complete_line_prefix(10, b"abc\ndef"), Some((3, 14)));
        // 多个换行：停在最后一个
        assert_eq!(complete_line_prefix(0, b"a\nb\n"), Some((3, 4)));
    }

    /// 记录比文件还大（被 `enforce_inbox_cap` 清空/轮换）= 从头读，不能钳到末尾装没事。
    #[test]
    fn a_truncated_inbox_is_reread_from_the_start() {
        assert_eq!(resume_offset(None, 100), 0, "没记过从 0 起");
        assert_eq!(resume_offset(Some(40), 100), 40, "记录合法就沿用");
        assert_eq!(resume_offset(Some(100), 100), 100, "正好等于长度也算合法");
        assert_eq!(resume_offset(Some(1000), 100), 0, "文件变短说明被清空过");
    }

    /// 缺字段 = qoder（旧行必须继续可用）；非字符串的 agent 值退回缺省，
    /// 不能拿脏值当来源标识参与过滤
    #[test]
    fn the_source_of_a_line_falls_back_to_qoder() {
        assert_eq!(line_agent(&json!({ "phase": "pre" })), "qoder");
        assert_eq!(line_agent(&json!({})), "qoder");
        assert_eq!(line_agent(&json!({ "agent": "zcode" })), "zcode");
        assert_eq!(line_agent(&json!({ "agent": 7 })), "qoder");
        assert_eq!(line_agent(&json!({ "agent": null })), "qoder");
    }

    /// 过滤的方向必须钉死：一致才放行。反过来的后果是把当前 Agent 的事件全丢了、
    /// 别人的反而照单全收 —— 桌宠会「对着不存在的会话动」，而且看起来一切正常。
    #[test]
    fn only_the_current_source_is_accepted() {
        assert!(source_matches(&json!({ "agent": "qoder" }), "qoder"));
        assert!(!source_matches(&json!({ "agent": "zcode" }), "qoder"));
        assert!(
            source_matches(&json!({ "phase": "pre" }), "qoder"),
            "缺 agent 的旧行按 qoder，必须仍然放行"
        );
        assert!(!source_matches(&json!({ "agent": "qoder" }), "zcode"));
    }
}
