//! 插件启停清单（C1）：唯一事实来源落到宿主磁盘上。
//!
//! 原先这份清单存在 WebView 的 localStorage 里，而它决定「哪些插件会被激活」——
//! 属于跨会话状态。清一次 WebView 缓存（或换 webview 数据目录）用户给的启停就全没了，
//! 而且插件 JS 在同一 realm 里也能改写它。现在：
//!   * 读写都走宿主命令，落 `<app_data>/plugins-enabled.json`，原子写（fsutil）
//!   * 写只认设置窗（与其他跨会话开关同一口径，见 gate.rs）
//!   * 老用户的第一次启动由宠物窗运行时做一次性迁移（`plugin_enabled_migrate`，
//!     只在文件还不存在时生效，重复调用是 no-op）
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::fsutil::write_atomic;
use crate::host_error::{HostError, INTERNAL, IO};

const FILE_NAME: &str = "plugins-enabled.json";

fn file(app: &AppHandle) -> Result<PathBuf, HostError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(FILE_NAME))
        // 拿不到自己的数据目录 = 宿主起不来，不是调用方的错
        .map_err(|e| HostError::new(INTERNAL, e.to_string()))
}

/// 只保留符合 id 词表的那些（清单里可能有指向已删除插件的残留 id，
/// 那类 id 在 reconcile 时本来就会被忽略，但别让它把 `../x` 这种形态带进文件）。
fn sanitize(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if !crate::ids::is_safe_id(id) {
            continue;
        }
        if seen.insert(id.clone()) {
            out.push(id.clone());
        }
    }
    out
}

/// 读清单。返回 `None` = 还没写过（新安装，或老用户尚未迁移）。
/// 文件在但读不动/形状不对时按 `None` 处理并留日志 —— 这条恢复路径由迁移那一步接管，
/// 但**不在此处覆盖原文件**（写只发生在 set / migrate）。
fn read_ids(path: &PathBuf) -> Result<Option<Vec<String>>, HostError> {
    let raw = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(HostError::new(IO, format!("读取启停清单失败: {e}"))),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) => Ok(value.get("ids").and_then(Value::as_array).map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })),
        Err(e) => {
            log::warn!("启停清单读坏了，本次按未初始化处理并等运行时迁移: {path:?}: {e}");
            Ok(None)
        }
    }
}

fn write_ids(app: &AppHandle, ids: &[String]) -> Result<(), HostError> {
    let path = file(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| HostError::new(IO, format!("创建宿主数据目录失败: {e}")))?;
    }
    let json = serde_json::to_string_pretty(&serde_json::json!({ "ids": ids }))
        .map_err(|e| HostError::new(INTERNAL, e.to_string()))?;
    write_atomic(&path, json.as_bytes())
}

#[tauri::command]
pub fn plugin_enabled_list(app: AppHandle) -> Result<Option<Vec<String>>, HostError> {
    read_ids(&file(&app)?)
}

/// 宿主认定的当前清单，供联动现算「已启用插件里有没有声明 agent:hooks」。
/// `None` = 说不出现状（还没写过，或读坏了）—— 调用方必须把这两种情况都当成
/// 「不要动手」，而不是「全都没启用」。
pub fn list_ids(app: &AppHandle) -> Option<Vec<String>> {
    match read_ids(&file(app).ok()?) {
        Ok(ids) => ids,
        Err(e) => {
            log::warn!("读取启停清单失败: {e}");
            None
        }
    }
}

/// 设置窗写启停清单。读回的值由宿主给出，不信任前端传来的顺序与重复。
/// 写完向所有窗口广播 `host:enabled-changed`：每个窗口手里是一份同步缓存，
/// 谁写的人都必须让别窗知道，否则设置页会拿旧名单判定「这个插件没启用」而不挂它的页面。
///
/// 联动挂在**这里**（比较新旧清单来装卸 hook），并且必须在清单已落盘之后：
/// 装卸失败不能拦启停，所以 `reconcile` 没有 Result，也没人拿 `?` 拦它。
#[tauri::command]
pub fn plugin_enabled_set(
    app: AppHandle,
    window: tauri::Window,
    ids: Vec<String>,
) -> Result<Vec<String>, HostError> {
    crate::gate::settings(&window, "改动插件启停清单")?;
    let cleaned = sanitize(&ids);
    let previous = read_ids_before_write(&app);
    write_ids(&app, &cleaned)?;
    cancel_pending_for_removed(&app, previous.as_deref(), &cleaned);
    let _ = app.emit("host:enabled-changed", &cleaned);
    // 用户主动勾选启用就是对「恢复停用时还原的总开关」的同意（G2-09 / t38-A）：
    // 这条路径按已确认装；启动补写、清单迁移、目录扫描都不是用户动作，仍走严格确认门。
    crate::services::agent::linkage::reconcile(
        &app,
        previous.as_deref(),
        &cleaned,
        crate::services::agent::linkage::InstallMode::UserConfirmed,
    );
    Ok(cleaned)
}

/// 停用某个插件时取消它挂起的同意请求，并清掉旧拒绝锁（不写新锁）。
/// 抽成函数是为了让 `plugin_enabled_set` 的命令体保持薄层。
fn cancel_pending_for_removed(app: &AppHandle, previous: Option<&[String]>, cleaned: &[String]) {
    let latched = crate::services::permission::latched_plugin_ids(app);
    let targets = latch_cleanup_targets(previous, cleaned, &latched);
    for id in &targets {
        crate::services::permission::cancel_pending_for_plugin(app, id, true);
    }
}

/// 「这次停用要清谁的拒绝锁」的决策。抽成纯函数：`cancel_pending_for_removed` 往下要真
/// `AppHandle`，单测造不出它（同 `cancel_plan` 的抽取理由，见 D10）。
///
/// 读得到旧清单时按 `previous − cleaned`；**读不到时不能整段跳过** —— 拒绝锁活在内存里，
/// 跳过就是「关→开永不再弹，直到重启」。那时唯一的事实源是宿主自己记得的锁集合。
/// 两种情况下仍在 `cleaned` 里的插件都不清，保住「同一启用周期内被拒后不重复骚扰」。
pub(crate) fn latch_cleanup_targets(
    previous: Option<&[String]>,
    cleaned: &[String],
    latched: &[String],
) -> Vec<String> {
    let candidates: &[String] = match previous {
        Some(prev) => prev,
        None => latched,
    };
    candidates
        .iter()
        .filter(|id| !cleaned.contains(*id))
        .cloned()
        .collect()
}

/// 写盘前把旧清单读出来。读失败不拦这次写入，只降级成「说不出」（None）。
/// 独立成函数是为了把 `?` 留在能传播错误的那一侧，命令体里只做一件事。
fn read_ids_before_write(app: &AppHandle) -> Option<Vec<String>> {
    let path = match file(app) {
        Ok(path) => path,
        Err(e) => {
            log::warn!("拿不到启停清单路径，联动本次按「说不出」处理: {e}");
            return None;
        }
    };
    match read_ids(&path) {
        Ok(ids) => ids,
        Err(e) => {
            log::warn!("读旧启停清单失败，联动本次按「说不出」处理: {e}");
            None
        }
    }
}

/// 一次性迁移：把 WebView 里那份旧清单搬进宿主。
/// 只认宠物窗里的运行时，且**只在文件还不存在（或读坏了）时**写入 —— 之后重复调用
/// 一律原样回读现有那份，免得某个带着旧 localStorage 的窗口把用户最新的启停覆盖回去。
/// 返回值就是宿主认定的那份，调用方直接拿来用（不用自己猜过滤结果）。
///
/// 迁移这一次也要过联动，但**不会自动装 hook**：第一次写清单不是用户点了开关
/// （见 `linkage::decide` 的 `prev_on = None` 分支），这里只是把广播闸门拨到与现状一致。
#[tauri::command]
pub fn plugin_enabled_migrate(
    app: AppHandle,
    window: tauri::Window,
    ids: Vec<String>,
) -> Result<Vec<String>, HostError> {
    crate::gate::pet(&window, "迁移插件启停清单")?;
    let path = file(&app)?;
    if let Some(existing) = read_ids(&path)? {
        return Ok(existing);
    }
    let cleaned = sanitize(&ids);
    write_ids(&app, &cleaned)?;
    let _ = app.emit("host:enabled-changed", &cleaned);
    // 迁移不是用户动作：严格确认门，需要确认的客户端保持原样（t38-A）
    crate::services::agent::linkage::reconcile(
        &app,
        None,
        &cleaned,
        crate::services::agent::linkage::InstallMode::Strict,
    );
    log::info!("已从 WebView 迁移插件启停清单到宿主");
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pet-enabled-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// A22：停用那一次读不到旧启停清单（`previous = None`）时，清锁不能整段跳过 ——
    /// 现场形状是「风险能力被拒 → 关 → 开，同进程内再也不弹，重启才弹」。
    #[test]
    fn unreadable_old_list_must_still_clear_latched_plugins() {
        let latched = vec!["com.pet.goat-gauge".to_string()];
        let targets = latch_cleanup_targets(None, &[], &latched);
        assert_eq!(
            targets, latched,
            "读不到旧清单时必须退回宿主记得的锁集合 —— 返回空就是「停用不清锁」那个缺陷的形状"
        );
        assert!(
            latch_cleanup_targets(None, &latched, &latched).is_empty(),
            "仍在启用清单里的插件不该被清，同周期不重复骚扰的口径不变"
        );
    }

    /// 正向对照：`previous` 读得到时，判定必须与旧实现逐字一致（防止回退改动顺手改了主路径）
    #[test]
    fn readable_old_list_keeps_the_previous_minus_cleaned_rule() {
        let previous = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let cleaned = vec!["a".to_string(), "c".to_string()];
        assert_eq!(
            latch_cleanup_targets(Some(&previous), &cleaned, &["b".to_string()]),
            vec!["b".to_string()],
            "读得到旧清单时按 previous − cleaned，与锁集合无关"
        );
        assert!(
            latch_cleanup_targets(Some(&previous), &previous, &[]).is_empty(),
            "没停用任何插件时不该清任何锁"
        );
    }

    /// 文件层的读写与形状判定（命令层要 AppHandle，这里把同一份逻辑对着临时目录测）
    #[test]
    fn missing_file_reads_as_none() {
        let path = tmp_dir("missing").join(FILE_NAME);
        assert_eq!(
            read_ids(&path).unwrap(),
            None,
            "没写过 = None，让运行时去迁移"
        );
    }

    #[test]
    fn roundtrip_keeps_order_and_dedupe() {
        let dir = tmp_dir("roundtrip");
        let path = dir.join(FILE_NAME);
        let ids = vec!["todo".to_string(), "com.pet.astock".to_string()];
        fs::write(
            &path,
            serde_json::to_string(&serde_json::json!({ "ids": ids })).unwrap(),
        )
        .unwrap();
        assert_eq!(read_ids(&path).unwrap(), Some(ids));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_reads_as_none_without_touching_it() {
        // 读坏要能被迁移那一步救回来（返回 None），但也绝不能在这里覆盖原文件：
        // 半截清单被当成「没写过」再写回空表，等于把用户的启停抹了
        let dir = tmp_dir("corrupt");
        let path = dir.join(FILE_NAME);
        fs::write(&path, "{ 这不是合法 json").unwrap();
        assert_eq!(read_ids(&path).unwrap(), None);
        assert!(
            fs::read_to_string(&path).unwrap().contains("这不是合法"),
            "读坏不该改写文件"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_shape_reads_as_none() {
        let dir = tmp_dir("shape");
        let path = dir.join(FILE_NAME);
        fs::write(&path, r#"{"ids":{"not":"an array"}}"#).unwrap();
        assert_eq!(read_ids(&path).unwrap(), None);
        let path2 = dir.join(FILE_NAME);
        fs::write(&path2, r#"{"other":[]}"#).unwrap();
        assert_eq!(read_ids(&path2).unwrap(), None, "缺 ids 键按未初始化处理");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_drops_ids_outside_the_vocab_and_duplicates() {
        let input = vec![
            "todo".to_string(),
            "todo".to_string(),
            "C:".to_string(),
            "../evil".to_string(),
            "a/b".to_string(),
            "ab".to_string(),
            "com.pet.hr-ble".to_string(),
            "".to_string(),
        ];
        assert_eq!(
            sanitize(&input),
            vec!["todo".to_string(), "com.pet.hr-ble".to_string()],
            "非法 id 与重复项都该被挡在文件外"
        );
    }

    #[test]
    fn empty_list_is_a_valid_state() {
        // 「全部停用」是有意义的状态，必须与「还没写过（None）」区分开
        let dir = tmp_dir("empty");
        let path = dir.join(FILE_NAME);
        fs::write(
            &path,
            serde_json::to_string(&serde_json::json!({ "ids": [] })).unwrap(),
        )
        .unwrap();
        assert_eq!(read_ids(&path).unwrap(), Some(vec![]));
        assert!(
            read_ids(&path).unwrap().is_some(),
            "空表不该被误判成未初始化"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
