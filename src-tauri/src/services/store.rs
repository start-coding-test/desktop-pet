use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use super::permission::PermissionState;
use crate::fsutil::write_atomic;
use crate::host_error::{HostError, INTERNAL, INVALID_ARG, INVALID_STATE, IO, PARSE};

/// 插件隔离 JSON 存储：%APPDATA%/<identifier>/plugins/<plugin_id>/store.json
/// 每个插件只能读写自己的命名空间，宿主按 plugin_id 落盘。
pub struct StoreState {
    root: Mutex<Option<PathBuf>>, // app_data_dir，setup 时填充
}

/// 每个插件一份读写锁。store 是「读整份 → 改一个键 → 写回整份」，
/// 设置窗与宠物窗同时写同一个插件时，没有这把锁就是后写覆盖先写、静默丢键。
///
/// 表里存 `Weak`：锁的存活由**正在用它的调用者**决定。插件卸载后没有强引用，
/// 条目降级成死条目，下一次取锁时被顺手清掉 —— 表的大小跟着「当前活着的插件数」走，
/// 而不是跟着「历史上出现过的 id 数」走（原先存 `Arc` 时它只增不减）。
fn locks() -> &'static Mutex<HashMap<String, Weak<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(Default::default)
}

fn plugin_lock(plugin_id: &str) -> Arc<Mutex<()>> {
    let mut map = locks().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(alive) = map.get(plugin_id).and_then(Weak::upgrade) {
        return alive;
    }
    // 到这里说明这个 id 当前没有活着的锁：顺手扫掉死条目（同一把表锁下做的，
    // 不会与别的取锁者抢；`retain` 只删 strong_count == 0 的，正在用的锁不受影响）
    map.retain(|_, weak| weak.strong_count() > 0);
    let fresh = Arc::new(Mutex::new(()));
    map.insert(plugin_id.to_string(), Arc::downgrade(&fresh));
    fresh
}

impl StoreState {
    pub fn new() -> Self {
        Self {
            root: Mutex::new(None),
        }
    }

    pub fn init(&self, app: &AppHandle) -> Result<(), String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        *self.root.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir.join("plugins"));
        Ok(())
    }

    fn plugin_file(&self, plugin_id: &str) -> Result<PathBuf, HostError> {
        if !crate::ids::is_safe_id(plugin_id) {
            return Err(HostError::new(INVALID_ARG, "invalid plugin id"));
        }
        self.root
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .map(|root| root.join(plugin_id).join("store.json"))
            .ok_or_else(|| HostError::new(INVALID_STATE, "store not initialized"))
    }

    /// 删除某插件的全部存储（撤销授权时连带清理，不留孤儿数据）
    pub fn clear_plugin(&self, plugin_id: &str) -> Result<(), HostError> {
        let path = self.plugin_file(plugin_id)?;
        let dir = path
            .parent()
            .ok_or_else(|| HostError::new(INVALID_STATE, "无法定位插件存储目录"))?;
        match fs::remove_dir_all(dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(HostError::io(e)),
        }
    }

    /// 读存储。损坏时返回 Err —— 原先 `.ok()` 把解析失败当成空表，
    /// 下一次 store_set 就会用「只有新键」的内容覆盖整个文件，等于静默丢数据。
    fn read_map(path: &Path) -> Result<Map<String, Value>, HostError> {
        match fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str::<Value>(&raw)
                .map(|v| v.as_object().cloned().unwrap_or_default())
                .map_err(|e| {
                    HostError::new(PARSE, format!("插件存储文件已损坏 {}: {e}", path.display()))
                }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
            Err(e) => Err(HostError::new(
                IO,
                format!("读取插件存储失败 {}: {e}", path.display()),
            )),
        }
    }

    /// 原子写：临时文件 + rename（见 fsutil）。
    /// 直接 fs::write 若中途断电会留下半截 JSON，下次读即「为空」，再写就清空该插件全部数据。
    fn write_map(path: &Path, map: &Map<String, Value>) -> Result<(), HostError> {
        let json = serde_json::to_string_pretty(map)
            .map_err(|e| HostError::new(INTERNAL, e.to_string()))?;
        write_atomic(path, json.as_bytes())
    }
}

/// 存储命令的统一入口检查：先过窗口归属 + 能力门禁，再解析落点。
///
/// JS 桥按 manifest 逐项 gated（`ctx.storage`），但绕过桥直接 `invoke('store_get')`
/// 的插件以前不受任何约束 —— 与 BLE / http 同类问题，收在 Rust 侧（见 gate.rs）。
/// 同 realm 的插件冒名他人 id 仍拦不住，那条要等 Web Worker 宿主；
/// 但「插件自己的悬浮窗冒用别的 id」由 gate::window_owns_plugin 挡住（G3-01）。
fn resolve(
    window: &tauri::Window,
    perms: &PermissionState,
    store: &StoreState,
    plugin_id: &str,
) -> Result<PathBuf, HostError> {
    crate::gate::plugin_capability(window, perms, plugin_id, crate::plugin_caps::STORAGE)?;
    store.plugin_file(plugin_id)
}

/// 单测专用：不造 AppHandle/Window，只钉「能力门禁 + 落点」这两段；
/// 窗口归属由 gate.rs 自己的单测覆盖。
#[cfg(test)]
fn resolve_for_test(
    perms: &PermissionState,
    store: &StoreState,
    plugin_id: &str,
) -> Result<PathBuf, HostError> {
    crate::gate::plugin_capability_for(perms, plugin_id, crate::plugin_caps::STORAGE)?;
    store.plugin_file(plugin_id)
}

#[tauri::command]
pub async fn store_get(
    window: tauri::Window,
    state: tauri::State<'_, StoreState>,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    key: String,
) -> Result<Option<Value>, HostError> {
    let path = resolve(&window, &perms, &state, &plugin_id)?;
    let lock = plugin_lock(&plugin_id);
    // G3-05：读盘移到阻塞线程池，别让文件 IO 卡住主线程 / IPC 线程
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        Ok(StoreState::read_map(&path)?.get(&key).cloned())
    })
    .await
    .map_err(|e| HostError::new(INTERNAL, format!("存储任务失败: {e}")))?
}

#[tauri::command]
pub async fn store_set(
    window: tauri::Window,
    state: tauri::State<'_, StoreState>,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    key: String,
    value: Value,
) -> Result<(), HostError> {
    let path = resolve(&window, &perms, &state, &plugin_id)?;
    let lock = plugin_lock(&plugin_id);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut map = StoreState::read_map(&path)?;
        map.insert(key, value);
        StoreState::write_map(&path, &map)
    })
    .await
    .map_err(|e| HostError::new(INTERNAL, format!("存储任务失败: {e}")))?
}

#[tauri::command]
pub async fn store_delete(
    window: tauri::Window,
    state: tauri::State<'_, StoreState>,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    key: String,
) -> Result<(), HostError> {
    let path = resolve(&window, &perms, &state, &plugin_id)?;
    let lock = plugin_lock(&plugin_id);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut map = StoreState::read_map(&path)?;
        map.remove(&key);
        StoreState::write_map(&path, &map)
    })
    .await
    .map_err(|e| HostError::new(INTERNAL, format!("存储任务失败: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("pet-store-{name}"))
    }

    /// 把 root 指到临时目录，绕开 AppHandle（命令层要的三个检查都不依赖真实 app）
    fn store_rooted_at(dir: PathBuf) -> StoreState {
        let state = StoreState::new();
        *state.root.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir);
        state
    }

    /// S1：能力授权收在 Rust 侧 —— 没授权 storage 就连自己的键也读写不了。
    /// A2/ADR-0007 之后还要钉住码：门禁拒绝是 `denied`，文案一字不变。
    #[test]
    fn resolve_denies_without_storage_grant() {
        let store = store_rooted_at(tmp_store(&format!("grant-{}", std::process::id())));
        let perms = PermissionState::new();
        let err = resolve_for_test(&perms, &store, "todo").unwrap_err();
        assert!(err.message.contains("未授权 storage"), "实际: {err}");
        assert_eq!(err.code, crate::host_error::DENIED, "没授权 = denied 码");
        perms.grant("todo", &["storage".to_string()]);
        assert!(resolve_for_test(&perms, &store, "todo").is_ok());
        // 授权按插件分开：别的插件不跟着沾光
        assert!(resolve_for_test(&perms, &store, "todo.other").is_err());
    }

    /// 盘符式 id（`C:`）、穿越、分隔符、过短一律按非法 id 拒 —— 与 is_safe_id 同口径。
    /// 原先这里是手写检查（只挡 `..` `/` `\` 与空），`C:` 这种带冒号的能过。
    /// A2/ADR-0007：非法 id 的码是 `invalid-arg`，与「没授权」的 `denied` 分开（同文案必须同码）。
    #[test]
    fn resolve_rejects_ids_outside_the_vocab() {
        let store = store_rooted_at(tmp_store(&format!("vocab-{}", std::process::id())));
        let perms = PermissionState::new();
        for id in ["C:", "../evil", "a/b", r"a\b", "", "ab", "a b", "Todo/../x"] {
            let err = resolve_for_test(&perms, &store, id).unwrap_err();
            assert_eq!(
                err.message, "invalid plugin id",
                "{id} 应按非法 id 被拒，实际: {err}"
            );
            assert_eq!(err.code, INVALID_ARG, "{id} 的码应是 invalid-arg");
        }
        // 就算授权表里真有这么一条也不会放行：id 合法性排在授权之前
        perms.grant("C:", &["storage".to_string()]);
        assert!(resolve_for_test(&perms, &store, "C:").is_err());
    }

    /// 合法 id 的落点必须仍在 `plugins/<id>/store.json` 之内
    #[test]
    fn resolve_stays_inside_the_plugin_namespace() {
        let root = tmp_store(&format!("ns-{}", std::process::id()));
        let store = store_rooted_at(root.clone());
        let perms = PermissionState::new();
        perms.grant("com.pet.astock", &["storage".to_string()]);
        let path = resolve_for_test(&perms, &store, "com.pet.astock").unwrap();
        assert_eq!(path, root.join("com.pet.astock").join("store.json"));
        let _ = fs::remove_dir_all(&root);
    }

    /// F1（B09）：撤销授权走的是 `StoreState::clear_plugin` 的 `remove_dir_all`，
    /// 同目录的 `secrets.json` 必须一起被带走 —— 不能只测 secrets.rs 里无调用方的 clear。
    #[test]
    fn clear_plugin_removes_both_store_and_secrets() {
        let root = tmp_store(&format!("both-{}", std::process::id()));
        let dir = root.join("com.pet.todo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("store.json"), "{\"a\":1}").unwrap();
        fs::write(dir.join("secrets.json"), "{\"schema\":1,\"entries\":{}}").unwrap();
        let store = store_rooted_at(root.clone());
        store.clear_plugin("com.pet.todo").unwrap();
        assert!(!dir.join("store.json").exists(), "store.json 还在");
        assert!(
            !dir.join("secrets.json").exists(),
            "凭据文件没被带走：ADR-0012 第 7 条不成立"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_writes_keep_both_keys() {
        // 两个「窗口」并发写同一插件的不同键：读-改-写必须串行，两个键都要留下
        let dir = tmp_store(&format!("race-{}", std::process::id()));
        let path = dir.join("store.json");
        let _ = fs::remove_dir_all(&dir);
        let lock = plugin_lock("race");
        let mut handles = Vec::new();
        for key in ["a", "b"] {
            let path = path.clone();
            let lock = lock.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..20 {
                    let _g = lock.lock().unwrap_or_else(|p| p.into_inner());
                    let mut map = StoreState::read_map(&path).unwrap();
                    map.insert(format!("{key}{i}"), Value::from(i));
                    StoreState::write_map(&path, &map).unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let map = StoreState::read_map(&path).unwrap();
        assert_eq!(map.len(), 40, "并发写入丢了键：实际 {}", map.len());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_an_empty_map() {
        let dir = tmp_store(&format!("bad-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.json");
        fs::write(&path, "这不是合法 JSON").unwrap();
        assert!(StoreState::read_map(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 锁表不许按 plugin_id 只增不减：取过锁又放掉的 id，下一次取锁时要被顺手清掉。
    /// 断言按"这批 id 是否还在表里"判，不判全表长度 —— 别的用例也在用这张全局表。
    #[test]
    fn lock_table_drops_entries_for_ids_that_are_gone() {
        for i in 0..50 {
            drop(plugin_lock(&format!("gone.{i}")));
        }
        // 这一步会触发 retain（"live" 是新的 id），死条目应当被一并扫走
        let live = plugin_lock("live");
        let map = locks().lock().unwrap_or_else(|p| p.into_inner());
        let survivors: Vec<&String> = map.keys().filter(|k| k.starts_with("gone.")).collect();
        assert!(
            survivors.is_empty(),
            "已不再使用的插件锁条目没被回收，残留 {} 条：{survivors:?}",
            survivors.len()
        );
        drop(map);
        drop(live);
    }

    /// 回收必须"只收回死的"：正在被持有的锁不能被清掉，否则同一插件的两个写者会各拿一把锁。
    #[test]
    fn lock_table_keeps_locks_that_are_still_held() {
        let held = plugin_lock("held.plugin");
        // 别的 id 取一次锁，触发 retain —— held 还在我们手上，必须活下来
        drop(plugin_lock("bystander"));
        let again = plugin_lock("held.plugin");
        assert!(
            Arc::ptr_eq(&held, &again),
            "仍被持有的锁被换成了新对象：同一插件的写者会各拿一把锁"
        );
        drop(held);
        drop(again);
    }
}
