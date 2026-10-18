use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::phases::MAX_HOOK_BYTES;
use super::state::{identifier, now_ms};

/// 单个 phase 文件的上限，超过则清空重记，避免长期运行写满盘
const INBOX_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// 收件目录。两处调用（hook 分支与 watcher）共用这一个式子。
///
/// `PET_AGENT_INBOX` 是开发与测试的覆盖入口（与 `PET_AGENT_CONFIG_FILES` 同类）：开发机装了全局
/// Qoder hook 时，真实会话会往默认 inbox 写事件，跑 `verify:agent` 的实例读的若也是它，
/// 断言就会被并发会话污染（CONVENTIONS 记过 71/6 对 77/0）。实例与套件都带上这个变量，
/// 就各读各的目录；全局 hook 不带它，照旧写默认目录，互不相干。空值视为没设。
pub fn inbox_dir(app_data: &Path) -> PathBuf {
    match std::env::var_os("PET_AGENT_INBOX") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => app_data.join("agent").join("inbox"),
    }
}

/// hook 分支没有 AppHandle，只能按 Windows 的 app_data_dir 约定自己拼
fn app_data_dir_standalone() -> Result<PathBuf, String> {
    let base = std::env::var("APPDATA").map_err(|_| "环境里没有 APPDATA".to_string())?;
    Ok(PathBuf::from(base).join(identifier()))
}

/// 收全 stdin 并落成 JSONL 的一行。这里出错一律静默返回：该分支既没有日志系统
/// 也没有窗口，报错无处可显示，更不能反过来挡住 Agent。
///
/// `agent` 是来源标识，取自命令行校验过的结果（见 `phases::hook_phase_from_args`）——
/// **不能**从 hook 的 payload 里取，那是外部输入，来源过滤拿它当依据就等于让事件自己声明来源。
pub fn hook_ingest(phase: &'static str, agent: &'static str) {
    let dir = match app_data_dir_standalone().map(|p| inbox_dir(&p)) {
        Ok(dir) => dir,
        Err(_) => return,
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }

    let mut buf = Vec::new();
    let _ = std::io::stdin()
        .lock()
        .take(MAX_HOOK_BYTES)
        .read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let text = text.trim();

    let mut encoded = line_for(phase, agent, text).to_string();
    encoded.push('\n');
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{phase}.jsonl")))
    {
        let _ = file.write_all(encoded.as_bytes());
    }
}

/// 把 stdin 原文包成一行 JSONL 的对象：除新增的 `agent` 外，键、格式与从前一致。
///
/// 单独成函数是因为 `hook_ingest` 要读 stdin，单测造不出那个环境；键集合这条判据
/// （「新行的键恰好等于旧键加 agent」）只能在这里成立。
fn line_for(phase: &str, agent: &str, text: &str) -> Value {
    // 重新序列化保证「一条事件 = 一行」，否则读侧的行切分会被多行 JSON 打乱
    match serde_json::from_str::<Value>(text) {
        Ok(payload) => {
            json!({ "phase": phase, "at": now_ms(), "agent": agent, "payload": payload })
        }
        Err(_) => json!({ "phase": phase, "at": now_ms(), "agent": agent, "raw": text }),
    }
}

/// 收件目录的体积上限：超了就清空重记，宁可丢历史也不写满盘
pub(super) fn enforce_inbox_cap(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if fs::metadata(&path)
            .map(|m| m.len() > INBOX_MAX_BYTES)
            .unwrap_or(false)
        {
            let _ = fs::write(&path, b"");
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn keys(value: &Value) -> Vec<String> {
        let mut got: Vec<String> = value
            .as_object()
            .expect("必须是对象")
            .keys()
            .cloned()
            .collect();
        got.sort();
        got
    }

    /// 一行里只多了 `agent`，其余键与从前一致；非 JSON 的旧形状也一样。
    /// （`keys()` 按字典序排过，所以 `payload` 排在 `phase` 前面：`pa` < `ph`。）
    #[test]
    fn ingest_line_keys_are_the_old_ones_plus_agent() {
        let good = line_for("pre", "zcode", r#"{"session_id":"s1"}"#);
        assert_eq!(
            keys(&good),
            vec![
                "agent".to_string(),
                "at".to_string(),
                "payload".to_string(),
                "phase".to_string()
            ]
        );
        assert_eq!(good["agent"], "zcode");
        assert_eq!(good["phase"], "pre");
        assert_eq!(
            good["payload"]["session_id"], "s1",
            "payload 原样带着，没被拆"
        );
        assert!(good["at"].is_i64(), "时间戳还得在");

        let bad = line_for("post", "qoder", "这不是 JSON");
        assert_eq!(
            keys(&bad),
            vec![
                "agent".to_string(),
                "at".to_string(),
                "phase".to_string(),
                "raw".to_string()
            ]
        );
        assert_eq!(bad["raw"], "这不是 JSON");
    }
}
