use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

use crate::host_error::{HostError, DENIED, INVALID_ARG, NOT_FOUND};
use crate::services::permission::PermissionState;

/// 跨窗口事件总线中继：任意窗口的 publish 广播到全部窗口，
/// 各窗口前端按 origin 去重后派发到本地订阅者。
/// origin 由宿主按实际调用窗口判定，前端无法伪造或抑制对他窗的投递。
///
/// S2：topic 归属与能力授权同样收在 Rust 侧。以前 JS 桥之上的 `assertPublishable`
/// 是唯一的关口，绕过桥的插件可以往 `agent:state`、`ble:heart-rate` 这类宿主 topic
/// 或他人前缀里灌数据，全桌面的窗口都会收到。
/// 拦不住的仍是「同 realm 的插件冒名他人 id」—— 那要等 Web Worker 宿主。
#[tauri::command]
pub fn bus_publish(
    window: tauri::Window,
    app: AppHandle,
    perms: tauri::State<PermissionState>,
    topic: String,
    payload: serde_json::Value,
    plugin_id: Option<String>,
) -> Result<(), HostError> {
    let label = window.label().to_string();
    let owner = resolve_owner(
        &label,
        plugin_id,
        crate::window::overlay::owner_of_label(&label),
    );
    let installed = installed_id_set(&app);
    check_publish(&label, owner.as_deref(), &topic, &installed, &|id, cap| {
        perms.is_granted(id, cap)
    })?;

    if is_widget_topic(&topic) {
        remember(&topic, &payload);
    }
    let _ = app.emit(
        "bus",
        serde_json::json!({ "origin": label, "topic": topic, "payload": payload }),
    );
    Ok(())
}

/// 归属解析（ADR-0005：分支从命令体里抽出来，好让「谁的 id 算数」这条规则可离线钉住）。
/// 悬浮窗的归属只认宿主注册表：那条 label 是开窗时宿主自己定的，页面伪造不了，
/// 所以这一路不接受客户端自报的 plugin_id；其余中继窗口才用自报值。
fn resolve_owner(
    label: &str,
    self_reported: Option<String>,
    overlay_owner: Option<String>,
) -> Option<String> {
    overlay_owner.or_else(|| {
        if relaying_from(label) {
            self_reported
        } else {
            None
        }
    })
}

/// 已安装插件 id 的集合。读磁盘这件事收在这里，命令体只拿结果。
/// G3-05：`installed_plugin_ids` 自带缓存、由插件 watcher 失效 ——
/// 每条总线消息不再全量扫一遍插件目录。
fn installed_id_set(app: &AppHandle) -> HashSet<String> {
    crate::commands::plugins::installed_plugin_ids(app)
        .map(|ids| ids.into_iter().collect())
        .unwrap_or_default()
}

/// 只有这三类窗口能往总线灌数据：宠物窗（运行时与插件同 realm）、
/// 设置窗（插件设置页）、悬浮窗（`overlay-<id>`）。同意框一类的窗口不在此列。
fn relaying_from(label: &str) -> bool {
    label == "pet" || label == "settings" || label.starts_with("overlay-")
}

/// 判定表单独成函数，好让「谁的什么 topic 要不要什么能力」这套规则有离线单测。
fn check_publish(
    label: &str,
    owner: Option<&str>,
    topic: &str,
    installed: &HashSet<String>,
    is_granted: &dyn Fn(&str, &str) -> bool,
) -> Result<(), HostError> {
    if !relaying_from(label) {
        return Err(HostError::new(
            DENIED,
            format!("窗口 {label} 不能发布总线 topic"),
        ));
    }
    let Some(id) = owner else {
        return Err(HostError::new(
            INVALID_ARG,
            "发布总线需要 pluginId：topic 归属由它判定",
        ));
    };
    if !crate::ids::is_safe_id(id) {
        return Err(HostError::new(INVALID_ARG, "invalid plugin id"));
    }
    if !installed.contains(id) {
        return Err(HostError::new(
            NOT_FOUND,
            format!("插件 {id} 没有安装，不能发布它的 topic"),
        ));
    }
    if !topic.starts_with(&format!("{id}:")) || topic == format!("{id}:") {
        return Err(HostError::new(
            DENIED,
            format!("只能发布 \"{id}:\" 前缀的 topic，收到的是 \"{topic}\""),
        ));
    }
    // `<id>:widget` 是插件给自己界面看的展示数据，桥那边 gated 在 widget 能力上，
    // 所以两条能力任一成立即放行（其余 topic 只认 bus:publish）
    let allowed = is_granted(id, crate::plugin_caps::BUS_PUBLISH)
        || (topic == format!("{id}:widget") && is_granted(id, crate::plugin_caps::WIDGET));
    if !allowed {
        return Err(HostError::new(
            DENIED,
            format!("未授权 bus:publish：{id} 需要 manifest 声明且已同意"),
        ));
    }
    Ok(())
}

/// 插件给自己界面（badge / overlay / settings）看的展示数据，统一走 `<id>:widget`
fn is_widget_topic(topic: &str) -> bool {
    topic.ends_with(":widget")
}

/// 最近一份 `*:widget` 数据 + 写入顺序（用来按上限挤掉最旧的 topic）
type Retained = Mutex<(HashMap<String, serde_json::Value>, VecDeque<String>)>;

static RETAINED: OnceLock<Retained> = OnceLock::new();

/// 只留最近这些 topic，防止某个插件刷屏把内存变成无界缓冲
const MAX_RETAINED: usize = 32;

fn retained() -> &'static Retained {
    RETAINED.get_or_init(|| Mutex::new((HashMap::new(), VecDeque::new())))
}

fn remember(topic: &str, payload: &serde_json::Value) {
    let mut guard = retained().lock().unwrap_or_else(|p| p.into_inner());
    if !guard.0.contains_key(topic) {
        guard.1.push_back(topic.to_string());
        while guard.1.len() > MAX_RETAINED {
            if let Some(old) = guard.1.pop_front() {
                guard.0.remove(&old);
            }
        }
    }
    guard.0.insert(topic.to_string(), payload.clone());
}

/// 界面刚挂上来时问宿主「这个 topic 现在该显示什么」。
///
/// 没有这一步的话，设置面板重新打开只会渲染自己的默认值：用户一碰开关，
/// 面板就把没碰过的那个也按默认值写回去，表现成「配置根本没保存」。
/// 只回 `*:widget`（插件给自己界面看的展示数据），cmd / status / devices
/// 这类指令与中间态一律不回。
///
/// S4：读展示数据也要先报自己是**谁**。以前只查窗口标签与 `:widget` 后缀，
/// 宿主 realm 里的代码 `invoke("bus_peek", { topic: "<别人的 id>:widget" })`
/// 就能读到别的插件的展示数据（P1-3 在订阅侧堵的是同一类问题）。归属照
/// `bus_publish` 那一套解析（悬浮窗只认宿主注册表，其余中继窗口才认自报值），
/// 并要求 topic 恰好是 `{id}:widget`，不满足一律 None。
///
/// 自报 id 的**形状**在这一层拦（边界校验），归属与 topic 的对应关系归 `peek_allowed`。
#[tauri::command]
pub fn bus_peek(
    window: tauri::Window,
    topic: String,
    plugin_id: Option<String>,
) -> Option<serde_json::Value> {
    let label = window.label().to_string();
    let owner = resolve_owner(
        &label,
        plugin_id,
        crate::window::overlay::owner_of_label(&label),
    );
    let owner = owner.as_deref().filter(|id| crate::ids::is_safe_id(id));
    if !peek_allowed(&label, owner, &topic) {
        return None;
    }
    retained()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .0
        .get(&topic)
        .cloned()
}

/// 「这一扇窗能不能读这个 topic 的最近一份」：窗口名单、展示数据形状、归属与 topic 是否同一家。
/// 抽成纯函数（ADR-0005），命令体只管边界校验、取锁与取值。
///
/// 这里不再重复判 id 形状：形状是调用边界上的事（命令体那一句），而**读得到数据**的前提是
/// 这个 topic 曾经进过保留表 —— 那要过 `check_publish` 的 `is_safe_id`，所以形状不合法的 id
/// 根本不会有数据可读。
fn peek_allowed(label: &str, owner: Option<&str>, topic: &str) -> bool {
    if !relaying_from(label) || !is_widget_topic(topic) {
        return false;
    }
    let Some(id) = owner else {
        return false;
    };
    topic == format!("{id}:widget")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed() -> HashSet<String> {
        ["todo".to_string(), "com.pet.astock".to_string()]
            .into_iter()
            .collect()
    }

    /// 两条 retention 测试共用全局 RETAINED（进程级静态）。默认并行跑时，
    /// `retention_is_capped` 的 42 次 remember 会把另一条刚放的 `t:widget` 挤出队列，
    /// 在 `.unwrap()` 处随机炸（A06 施工中实测复现过一次）。共享这块状态的两条必须串行。
    fn retention_serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 授权表替身：只有列出来的 (id, cap) 算已授权
    fn grant(list: &[(&str, &str)]) -> impl Fn(&str, &str) -> bool {
        let set: HashSet<(String, String)> = list
            .iter()
            .map(|(i, c)| (i.to_string(), c.to_string()))
            .collect();
        move |id, cap| set.contains(&(id.to_string(), cap.to_string()))
    }

    #[test]
    fn own_prefix_with_grant_is_allowed() {
        let g = grant(&[("todo", "bus:publish")]);
        assert!(check_publish("pet", Some("todo"), "todo:changed", &installed(), &g).is_ok());
        // 设置页与悬浮窗同理（悬浮窗的归属由调用方按注册表解析好）
        assert!(check_publish("settings", Some("todo"), "todo:cmd", &installed(), &g).is_ok());
        assert!(check_publish("overlay-todo", Some("todo"), "todo:cmd", &installed(), &g).is_ok(),);
    }

    /// 这是 S2 的正身：绕过 JS 桥直接 invoke 也灌不进别人的、更灌不进宿主的 topic。
    /// A2/ADR-0007：前缀不符是**授权判定**（denied），不是入参不合法。
    #[test]
    fn foreign_and_host_topics_are_rejected() {
        let g = grant(&[("todo", "bus:publish"), ("com.pet.astock", "bus:publish")]);
        for topic in [
            "com.pet.astock:cmd",
            "ble:heart-rate",
            "agent:state",
            "agent:event",
            "host:fullscreen",
            "todo:",
        ] {
            let err = check_publish("pet", Some("todo"), topic, &installed(), &g).unwrap_err();
            assert!(
                err.message.contains("前缀"),
                "{topic} 的错误口径不对: {err}"
            );
            assert_eq!(
                err.code, DENIED,
                "{topic} 是越权用别人/宿主的前缀，码必须是 denied"
            );
        }
    }

    #[test]
    fn without_grant_the_publish_is_rejected() {
        let g = grant(&[]);
        let err = check_publish("pet", Some("todo"), "todo:changed", &installed(), &g).unwrap_err();
        assert!(err.message.contains("未授权 bus:publish"), "实际: {err}");
        assert_eq!(err.code, DENIED, "缺能力 = denied");
    }

    #[test]
    fn widget_topic_accepts_the_widget_capability() {
        let g = grant(&[("todo", "widget")]);
        assert!(check_publish("pet", Some("todo"), "todo:widget", &installed(), &g).is_ok());
        // 但 widget 能力不能拿去发别的 topic
        assert!(check_publish("pet", Some("todo"), "todo:cmd", &installed(), &g).is_err());
    }

    /// A2/ADR-0007：四类拒绝各带各的码 —— 入参缺归属 / 非法 id 是 invalid-arg，
    /// 没装 = not-found，窗口不在发布名单 = denied。
    #[test]
    fn caller_must_be_a_known_plugin_in_a_relaying_window() {
        let g = grant(&[("todo", "bus:publish")]);
        // 没有 plugin_id：归属无从判定
        let err = check_publish("pet", None, "todo:changed", &installed(), &g).unwrap_err();
        assert_eq!(err.code, INVALID_ARG, "缺 pluginId = invalid-arg");
        // 没装着的插件（含冒用他人 id 的字面量）
        let err =
            check_publish("pet", Some("zz.gone"), "zz.gone:cmd", &installed(), &g).unwrap_err();
        assert_eq!(err.code, NOT_FOUND, "没装的插件 = not-found");
        // 非法 id 先于授权被拒
        let err = check_publish("pet", Some("C:"), "C:x", &installed(), &g).unwrap_err();
        assert_eq!(err.code, INVALID_ARG, "非法 id = invalid-arg");
        // 同意框与其它窗口不在发布名单里
        let err = check_publish("consent-r1", Some("todo"), "todo:changed", &installed(), &g)
            .unwrap_err();
        assert_eq!(err.code, DENIED, "窗口不在发布名单 = denied");
        let err =
            check_publish("main", Some("todo"), "todo:changed", &installed(), &g).unwrap_err();
        assert_eq!(err.code, DENIED, "窗口不在发布名单 = denied");
    }

    #[test]
    fn only_widget_topics_are_retained() {
        assert!(is_widget_topic("com.pet.hr-ble:widget"));
        assert!(!is_widget_topic("com.pet.hr-ble:cmd"));
        assert!(!is_widget_topic("com.pet.hr-ble:status"));
    }

    #[test]
    fn retention_keeps_only_the_latest_per_topic() {
        let _serial = retention_serial();
        remember("t:widget", &serde_json::json!({ "v": 1 }));
        remember("t:widget", &serde_json::json!({ "v": 2 }));
        let guard = retained().lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(guard.0.get("t:widget").unwrap()["v"], 2);
        assert_eq!(
            guard.1.iter().filter(|k| k.as_str() == "t:widget").count(),
            1
        );
    }

    #[test]
    fn retention_is_capped() {
        let _serial = retention_serial();
        for i in 0..(MAX_RETAINED + 10) {
            remember(&format!("cap{i}:widget"), &serde_json::json!(i));
        }
        let guard = retained().lock().unwrap_or_else(|p| p.into_inner());
        assert!(guard.0.len() <= MAX_RETAINED, "实际留下 {}", guard.0.len());
        assert!(!guard.0.contains_key("cap0:widget"), "最早的应当被挤掉");
        assert!(guard
            .0
            .contains_key(&format!("cap{}:widget", MAX_RETAINED + 9)));
    }

    /// ADR-0005：归属解析从命令体抽出来之后，「谁的 plugin_id 算数」必须逐条钉住
    #[test]
    fn overlay_owner_registry_wins_over_self_reported_id() {
        let got = resolve_owner(
            "overlay-com.pet.todo",
            Some("com.pet.astock".to_string()),
            Some("com.pet.todo".to_string()),
        );
        assert_eq!(
            got.as_deref(),
            Some("com.pet.todo"),
            "注册表说是谁就是谁，自报值作废"
        );
    }

    #[test]
    fn self_reported_id_is_only_accepted_for_relaying_windows() {
        assert_eq!(
            resolve_owner("settings", Some("com.pet.todo".to_string()), None).as_deref(),
            Some("com.pet.todo"),
            "设置窗与宠物窗是插件运行时的宿主，自报 id 在这两路有效"
        );
        assert_eq!(
            resolve_owner("pet", Some("com.pet.todo".to_string()), None).as_deref(),
            Some("com.pet.todo")
        );
        assert_eq!(
            resolve_owner("consent-r1", Some("com.pet.todo".to_string()), None),
            None,
            "同意框一类窗口既不中继，自报 id 也不该被采纳"
        );
    }

    /// S4 的正身：读展示数据要先报自己是谁，且这个 topic 必须归他 —— 报成别人也读不到别人的。
    #[test]
    fn peek_only_serves_the_topic_of_the_named_owner() {
        assert!(peek_allowed("pet", Some("todo"), "todo:widget"));
        assert!(
            !peek_allowed("pet", Some("todo"), "com.pet.astock:widget"),
            "报了自己的 id 却去读别人的 :widget"
        );
        // 展示数据之外的 topic 一律不回（cmd 这类是指令）
        assert!(!peek_allowed("pet", Some("todo"), "todo:cmd"));
        assert!(!peek_allowed("pet", Some("todo"), "ble:heart-rate"));
        assert!(!peek_allowed("pet", Some("todo"), "todo:"));
    }

    /// 缺归属、非中继窗口：全部 None（fail-closed，不许放行）
    #[test]
    fn peek_is_closed_without_an_owner_or_from_a_guest_window() {
        assert!(
            !peek_allowed("pet", None, "todo:widget"),
            "缺 plugin_id 必须拒"
        );
        assert!(!peek_allowed("consent-r1", Some("todo"), "todo:widget"));
        assert!(!peek_allowed("main", Some("todo"), "todo:widget"));
    }

    /// 非法 id 的**形状闸**在命令体的边界校验那一句（`.filter(crate::ids::is_safe_id)`）。
    /// 这里钉住它下面那层：无论 id 长什么样，topic 不与它同一家就一个字都不给 ——
    /// 形状不合法的 id 连数据都不会有（写进保留表要过 `check_publish` 的同一道闸）。
    #[test]
    fn peek_never_serves_a_topic_that_is_not_the_owners_own() {
        assert!(!peek_allowed("pet", Some("C:"), "todo:widget"));
        assert!(!peek_allowed("pet", Some("todo"), "C::widget"));
    }

    /// 悬浮窗那条 label 是宿主开窗时自己定的：归属只认注册表，自报值作废 —— 读不到别人的
    #[test]
    fn overlay_peek_uses_the_registry_owner_not_the_self_reported_id() {
        let owner = resolve_owner(
            "overlay-com.pet.todo",
            Some("com.pet.astock".to_string()),
            Some("com.pet.todo".to_string()),
        );
        assert!(peek_allowed(
            "overlay-com.pet.todo",
            owner.as_deref(),
            "com.pet.todo:widget"
        ));
        assert!(
            !peek_allowed(
                "overlay-com.pet.todo",
                owner.as_deref(),
                "com.pet.astock:widget"
            ),
            "悬浮窗按自报值读走了别人的展示数据"
        );
    }
}
