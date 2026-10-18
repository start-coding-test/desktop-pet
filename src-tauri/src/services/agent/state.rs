use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use tauri::{AppHandle, Emitter};

/// 会话静默这么久就忘掉：不是所有 Agent 都会给出显式的结束事件
const SESSION_TTL: Duration = Duration::from_secs(90);
/// 「已完成 / 失败」只是短暂提示，不用等满 90 秒才让出活跃态
const FLASH_TTL: Duration = Duration::from_secs(12);

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) fn identifier() -> String {
    const CONF: &str = include_str!("../../../tauri.conf.json");
    serde_json::from_str::<Value>(CONF)
        .ok()
        .and_then(|v| {
            v.get("identifier")
                .and_then(Value::as_str)
                .map(String::from)
        })
        .unwrap_or_else(|| "com.desktoppet.pet".into())
}

struct Session {
    state: &'static str,
    seen: Instant,
    /// 会话标题：该会话第一条用户输入的前若干字（卡片可选显示，默认不显示）
    title: String,
    /// 已发生的工具调用步数
    steps: u32,
    /// 最近一次「这轮结束」的时刻。用于吃掉迟到的 post：
    /// pre/post 相隔约 150ms 到达，post 落在 Stop 之后是常态，
    /// 若照单处理就会把会话打回 running，而 running 的 TTL 是 90 秒 —— 症状就是
    /// 「会话早就结束了，卡片还挂着正在执行」。
    stopped_at: Option<Instant>,
}

/// Stop 之后多久之内到达的工具事件算「迟到」，不再改变会话状态
const STOP_GRACE: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct AgentState {
    /// phase 文件 → 已读到的字节偏移。没有它就无法区分旧数据与新事件
    pub(super) offsets: Mutex<HashMap<PathBuf, u64>>,
    sessions: Mutex<HashMap<String, Session>>,
    /// 最近一次对外广播的状态，用于只在变化时发事件
    emitted: Mutex<String>,
    counter: AtomicU64,
}

pub struct AgentWatcher {
    pub(super) _inner: notify::RecommendedWatcher,
}

/// 事件 → 会话状态。词表与插件侧的动作映射对应
/// （running / needs_input / completed / failed / idle）
fn state_for_event(phase: &str, notification_kind: &str) -> Option<&'static str> {
    match phase {
        "session-start" | "user-prompt" | "pre" | "post" | "subagent-start" | "subagent-stop" => {
            Some("running")
        }
        "approval-request" => Some("needs_input"),
        "notification" => {
            if matches!(
                notification_kind,
                "permission_prompt" | "elicitation_dialog"
            ) {
                Some("needs_input")
            } else if matches!(notification_kind, "idle_prompt" | "agent_completed") {
                Some("completed")
            } else {
                None
            }
        }
        "stop" => Some("completed"),
        "tool-failure" | "stop-failure" => Some("failed"),
        "session-end" | "interrupt" => Some("idle"),
        _ => None,
    }
}

fn ttl_for(state: &'static str) -> Duration {
    match state {
        "completed" | "failed" => FLASH_TTL,
        _ => SESSION_TTL,
    }
}

pub(super) fn bounded_str(payload: &Value, key: &str, max: usize) -> String {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(|s| s.chars().take(max).collect())
        .unwrap_or_default()
}

/// 从 tool_input 里挑一个最能说明「在干什么」的字段。
/// 命令与路径属于敏感内容：宿主照样带出去，是否显示由插件侧的开关决定。
pub(super) fn event_detail(payload: &Value) -> String {
    const KEYS: [&str; 6] = ["command", "file_path", "path", "url", "pattern", "query"];
    let input = payload.get("tool_input");
    for key in KEYS {
        if let Some(value) = input.and_then(|v| v.get(key)).and_then(Value::as_str) {
            let one_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
            return one_line.chars().take(120).collect();
        }
    }
    String::new()
}

/// 会话标题取该会话第一条用户输入；换行压成空格，只留前 48 字
pub(super) fn prompt_title(payload: &Value) -> Option<String> {
    let prompt = payload.get("prompt").and_then(Value::as_str)?;
    let one_line = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = one_line.chars().take(48).collect();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

impl AgentState {
    /// 记下一件事件并返回该事件的状态（词表之外的事件返回 None，不参与汇总）
    pub(super) fn apply(
        &self,
        phase: &str,
        session: &str,
        kind: &str,
        title: Option<&str>,
    ) -> Option<&'static str> {
        let state = state_for_event(phase, kind)?;
        let key = if session.is_empty() {
            "default".to_string()
        } else {
            session.to_string()
        };
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        if state == "idle" {
            sessions.remove(&key);
            return Some(state);
        }
        let now = Instant::now();
        let entry = sessions.entry(key).or_insert_with(|| Session {
            state,
            seen: now,
            title: String::new(),
            steps: 0,
            stopped_at: None,
        });
        if matches!(phase, "pre" | "post" | "subagent-start" | "subagent-stop")
            && entry
                .stopped_at
                .is_some_and(|at| now.duration_since(at) < STOP_GRACE)
        {
            // 迟到的工具事件：状态保持「刚结束」，但事件照常往外发（卡片仍能更新摘要）
            return Some(entry.state);
        }
        entry.state = state;
        entry.seen = now;
        // 标题只认第一次：后续输入会把标题改成最新那句，卡片就该跟着会话走而不是跟着回合走
        if entry.title.is_empty() {
            if let Some(title) = title {
                entry.title = title.to_string();
            }
        }
        match phase {
            "stop" => entry.stopped_at = Some(now),
            // 新一轮开始，宽限期立刻作废
            "user-prompt" | "session-start" => entry.stopped_at = None,
            _ => {}
        }
        if phase == "pre" {
            entry.steps += 1;
        }
        Some(state)
    }

    /// 切换 Agent 时清空会话表。旧 Agent 的会话不该继续挂在状态卡上，
    /// 等 90 秒 TTL 才消失 —— 那是「已经换人了还在演上一位」。返回清掉的条数，便于日志与单测。
    pub(super) fn clear_sessions(&self) -> usize {
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let n = sessions.len();
        sessions.clear();
        n
    }

    /// 当前最活跃那个会话的标题与步数（卡片要显示的就是它）
    pub(super) fn active_summary(&self) -> (String, u32) {
        let sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        sessions
            .values()
            .max_by_key(|session| session.seen)
            .map(|session| (session.title.clone(), session.steps))
            .unwrap_or_default()
    }

    /// 汇总各会话：needs_input 压过 running，都没有则 idle
    pub(super) fn aggregate(&self) -> &'static str {
        let now = Instant::now();
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        sessions.retain(|_, session| now.duration_since(session.seen) < ttl_for(session.state));
        let mut running = false;
        for session in sessions.values() {
            match session.state {
                "needs_input" => return "needs_input",
                "running" | "failed" => running = true,
                _ => {}
            }
        }
        if running {
            "running"
        } else if sessions.is_empty() {
            "idle"
        } else {
            "completed"
        }
    }

    /// 只在状态真的变化时广播，返回是否广播了
    pub(super) fn publish(&self, app: &AppHandle, hint: Option<(&str, &str)>) -> bool {
        let aggregate = self.aggregate();
        let (title, steps) = self.active_summary();
        let mut emitted = self.emitted.lock().unwrap_or_else(|p| p.into_inner());
        if *emitted == aggregate {
            return false;
        }
        *emitted = aggregate.to_string();
        let counter = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let payload = match hint {
            Some((last_phase, last_state)) => json!({
                "state": aggregate,
                "counter": counter,
                "lastPhase": last_phase,
                "lastState": last_state,
                "title": title,
                "steps": steps,
                // 来源标识：A02 起每条都带，插件侧不再需要猜「现在在跟谁说话」
                "agent": super::linkage::current_agent(),
            }),
            None => json!({
                "state": aggregate,
                "counter": counter,
                "title": title,
                "steps": steps,
                "agent": super::linkage::current_agent(),
            }),
        };
        drop(emitted);
        app.emit("agent:state", payload).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{state_for_event, AgentState};

    /// interrupt 是 A02 新增的 phase（Codex 的 Interrupt 事件），语义就是「这轮被打断、回到空闲」。
    #[test]
    fn interrupt_maps_to_idle() {
        assert_eq!(state_for_event("interrupt", ""), Some("idle"));
        // 对照：session-end 一直映射到 idle，两者共用那条尾巴
        assert_eq!(state_for_event("session-end", ""), Some("idle"));
        // 白名单里其余 phase 不能因为这一行改动而漂移
        assert_eq!(state_for_event("pre", ""), Some("running"));
        assert_eq!(state_for_event("stop", ""), Some("completed"));
        assert_eq!(state_for_event("tool-failure", ""), Some("failed"));
        assert_eq!(state_for_event("approval-request", ""), Some("needs_input"));
        assert_eq!(state_for_event("no-such-phase", ""), None);
    }
    /// 切换 Agent 靠这个函数丢掉旧会话：它必须真的清空（不是只数一遍），
    /// 并且如实回报清掉了几条 —— 「清掉了 0 条」在切换时就是要能看见的事实。
    #[test]
    fn clear_sessions_drops_every_session_and_reports_how_many() {
        let state = AgentState::default();
        assert_eq!(state.apply("pre", "s1", "", None), Some("running"));
        assert_eq!(state.apply("pre", "s2", "", None), Some("running"));
        assert_eq!(state.aggregate(), "running", "两条会话都在跑");
        assert_eq!(state.clear_sessions(), 2, "两条都要清掉");
        assert_eq!(state.aggregate(), "idle", "清空之后不该还有会话挂着");
        assert_eq!(state.clear_sessions(), 0, "再清一次是 no-op，如实回 0");
    }
}
