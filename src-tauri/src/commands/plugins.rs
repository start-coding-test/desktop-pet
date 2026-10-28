use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::host_error::{HostError, INTERNAL, INVALID_ARG, IO, PARSE};
use crate::ids::is_safe_id;

/// manifest 字段约束的唯一数据源（K4）：与 TS 侧 import 的是同一份磁盘文件
/// （`src/runtime/plugin-runtime.ts` 读它、`webview` 与这里都不许自带副本）。
/// 编译期内嵌，打包版无需把 schema 放进 bundle.resources。
const MANIFEST_SCHEMA_JSON: &str = include_str!("../../../packages/sdk/manifest.schema.json");

/// 首次访问时解析内嵌 schema（编译期文件，解析只做一次）。
fn manifest_schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(MANIFEST_SCHEMA_JSON).expect("manifest.schema.json 不是合法 JSON")
    })
}

/// 按 manifest.schema.json 校验 manifest 的字段约束（K4）：
/// 必填键清单、id 的长度上下限（字符集部分仍归 `ids::is_safe_id` —— 唯一实现，S4）、
/// permissions 的元素类型与成员资格（`plugin_caps::is_known`）。
/// 拒绝发生在扫描阶段：坏 manifest 不进列表，只经 `host:plugin-error` 上报。
fn validate_manifest_fields(manifest: &Value) -> Result<(), HostError> {
    let schema = manifest_schema();
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .ok_or(HostError::new(INTERNAL, "manifest.schema.json 缺 required"))?;
    for key in required {
        let key = key.as_str().ok_or(HostError::new(
            INTERNAL,
            "manifest.schema.json 的 required 项必须是字符串",
        ))?;
        if manifest.get(key).is_none() {
            return Err(HostError::new(INVALID_ARG, format!("manifest 缺少 {key}")));
        }
    }
    let id_rule = schema
        .get("properties")
        .and_then(|p| p.get("id"))
        .ok_or(HostError::new(
            INTERNAL,
            "manifest.schema.json 缺 properties.id",
        ))?;
    let id_min = id_rule
        .get("minLength")
        .and_then(Value::as_u64)
        .ok_or(HostError::new(
            INTERNAL,
            "manifest.schema.json 缺 id.minLength",
        ))?;
    let id_max = id_rule
        .get("maxLength")
        .and_then(Value::as_u64)
        .ok_or(HostError::new(
            INTERNAL,
            "manifest.schema.json 缺 id.maxLength",
        ))?;
    let id = manifest
        .get("id")
        .and_then(Value::as_str)
        .ok_or(HostError::new(INVALID_ARG, "manifest 缺少 id"))?;
    if !(id_min..=id_max).contains(&(id.chars().count() as u64)) || !is_safe_id(id) {
        return Err(HostError::new(INVALID_ARG, format!("非法插件 id: {id}")));
    }
    if let Some(value) = manifest.get("permissions") {
        let arr = value
            .as_array()
            .ok_or(HostError::new(INVALID_ARG, "permissions 必须是数组"))?;
        for item in arr {
            // 以前这里对非字符串元素 filter_map 静默丢弃：
            // 「声明了但类型写错」的能力等于没声明，现场只剩「未在 manifest 声明这些能力」，
            // 看不出真正原因（K4 修复）。
            let name = item.as_str().ok_or_else(|| {
                HostError::new(INVALID_ARG, format!("permissions 元素必须是字符串: {item}"))
            })?;
            if !crate::plugin_caps::is_known(name) {
                return Err(HostError::new(INVALID_ARG, format!("未知能力名: {name}")));
            }
        }
    }
    Ok(())
}

/// 插件目录根：dev 读仓库根 plugins/；release 读资源目录 plugins/（打包时由 bundle.resources 复制）。
fn plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, HostError> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"))
    } else {
        app.path()
            .resource_dir()
            .map(|dir| dir.join("plugins"))
            .map_err(|e| HostError::new(INTERNAL, e.to_string()))
    }
}

// 插件 id 的规则只在 `crate::ids::is_safe_id` 有一份实现（S4）——
// 它同时是存储目录名、overlay 窗口标签与授权表键的来源，各处的口径必须一致。

fn read_manifest(dir: &Path, plugin_id: &str) -> Result<Value, HostError> {
    let path = dir.join(plugin_id).join("manifest.json");
    let raw = std::fs::read_to_string(&path).map_err(HostError::io)?;
    serde_json::from_str::<Value>(&raw).map_err(|e| HostError::new(PARSE, e.to_string()))
}

/// 扫描 plugins 目录，收集合法插件的 manifest。
/// 目录名必须等于 manifest.id —— 否则插件可冒用他人身份，读写其存储与 widget 路径。
fn collect_manifests(app: &tauri::AppHandle) -> Result<Vec<Value>, HostError> {
    let dir = plugins_dir(app)?;
    let mut manifests = Vec::new();
    let mut errors: Vec<(String, String)> = Vec::new();
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| HostError::new(IO, format!("读取插件目录失败: {e}")))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.path().join("manifest.json").is_file() {
            continue;
        }
        let loaded = read_manifest(&dir, &name).and_then(|v| {
            validate_manifest_fields(&v)?;
            match v.get("id").and_then(Value::as_str) {
                Some(id) if id == name => Ok(v),
                Some(id) => Err(HostError::new(
                    INVALID_ARG,
                    format!("manifest.id \"{id}\" 与目录名 \"{name}\" 不一致"),
                )),
                None => Err(HostError::new(INVALID_ARG, "manifest 缺少 id")),
            }
        });
        match loaded {
            Ok(v) => manifests.push(v),
            Err(e) => errors.push((name, format!("manifest 无效: {e}"))),
        }
    }
    report_manifest_errors(app, &errors);
    Ok(manifests)
}

/// 这一轮该新报哪些 manifest 错误（纯函数：与上一次上报表比较）。
/// 错误内容没变的插件不再重复广播 —— `host:plugin-error` 以前挂在每次扫描上，
/// 插件列表/总线消息一多就把前端日志刷爆（G3-05）。
fn fresh_manifest_errors(
    reported: &HashMap<String, String>,
    errors: &[(String, String)],
) -> Vec<(String, String)> {
    errors
        .iter()
        .filter(|(plugin, error)| reported.get(plugin) != Some(error))
        .cloned()
        .collect()
}

/// 上报坏 manifest：只在新增/内容变化时发事件；修好或删掉的从表里移除，下次再坏还会再报。
fn report_manifest_errors(app: &tauri::AppHandle, errors: &[(String, String)]) {
    static REPORTED: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let to_emit = {
        let mut reported = REPORTED
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let fresh = fresh_manifest_errors(&reported, errors);
        let current: HashMap<&str, &str> = errors
            .iter()
            .map(|(plugin, error)| (plugin.as_str(), error.as_str()))
            .collect();
        reported.retain(|plugin, _| current.contains_key(plugin.as_str()));
        for (plugin, error) in errors {
            reported.insert(plugin.clone(), error.clone());
        }
        fresh
    };
    for (plugin, error) in to_emit {
        let _ = app.emit(
            "host:plugin-error",
            serde_json::json!({ "plugin": plugin, "error": error }),
        );
    }
}

#[tauri::command]
pub async fn plugins_list(app: tauri::AppHandle) -> Result<Vec<Value>, HostError> {
    // G3-05：目录扫描是阻塞 IO，移到阻塞线程池，别占 IPC/主线程
    tauri::async_runtime::spawn_blocking(move || collect_manifests(&app))
        .await
        .map_err(|e| HostError::new(INTERNAL, format!("插件扫描任务失败: {e}")))?
}

/// 插件文件的修改时间（毫秒）。前端拿它给 `import()` 拼 cache-busting 查询串：
/// 「放进目录即生效」要对代码变更也成立，否则同名 URL 永远命中模块缓存，
/// 覆盖 entry.js 之后非重启 webview 不可。
#[tauri::command]
pub fn plugin_file_version(
    app: tauri::AppHandle,
    plugin_id: String,
    rel: String,
) -> Result<u64, HostError> {
    if !is_safe_id(&plugin_id) || !is_safe_rel(&rel) {
        return Err(HostError::new(INVALID_ARG, "invalid plugin file"));
    }
    let path = plugins_dir(&app)?.join(&plugin_id).join(&rel);
    file_modified_millis(&path)
}

/// 读文件的 mtime 并折算成 epoch 毫秒（ADR-0005：IO 不住在命令体里）。
/// mtime 早于 epoch（老文件系统 / 时钟回拨）时按 0 计，不能让 cache-busting 拿到负数。
fn file_modified_millis(path: &std::path::Path) -> Result<u64, HostError> {
    let meta = std::fs::metadata(path)
        .map_err(|e| HostError::new(IO, format!("读取 {path:?} 失败: {e}")))?;
    let modified = meta.modified().map_err(HostError::io)?;
    Ok(modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

/// 已安装插件 id 的缓存（G3-05）。`installed_plugin_ids` 以前每调一次就全量扫目录：
/// `bus_publish` 每条总线消息、`overlay_show` 每次开窗都要重扫一遍，全是主线程上的目录 IO。
/// 目录内容只会被 watcher 看见变化 —— 它在去抖落定后调 `invalidate_installed_plugin_ids`，
/// 下一次读取才重扫；扫描失败不写缓存（下次仍会重试，不会把「读失败」当成「没插件」缓存住）。
fn installed_ids_cache() -> &'static Mutex<Option<Vec<String>>> {
    static CACHE: OnceLock<Mutex<Option<Vec<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 仅 watcher 调用：磁盘上的插件集合变了，缓存作废
pub fn invalidate_installed_plugin_ids() {
    *installed_ids_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = None;
}

/// 当前实际安装的插件 id 集合，用于回收已删除插件留下的授权。
pub fn installed_plugin_ids(app: &tauri::AppHandle) -> Result<Vec<String>, HostError> {
    if let Some(cached) = installed_ids_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return Ok(cached);
    }
    let ids: Vec<String> = collect_manifests(app)?
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    *installed_ids_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(ids.clone());
    Ok(ids)
}

/// 磁盘 manifest 里的展示名，供同意框显示「你在给谁授权」（ADR-0011）。
/// 缺 name 或写错类型时退回 id：名字缺失不该让整条授权流程失败，
/// 但**绝不**退回调用方自报的值 —— 那正是这条要堵的洞。
pub fn manifest_display_name(app: &tauri::AppHandle, plugin_id: &str) -> Result<String, HostError> {
    if !is_safe_id(plugin_id) {
        return Err(HostError::new(INVALID_ARG, "invalid plugin id"));
    }
    let manifest = read_manifest(&plugins_dir(app)?, plugin_id)?;
    Ok(manifest
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(plugin_id)
        .to_string())
}

/// manifest 声明的能力列表。以磁盘上的 manifest 为唯一事实来源，
/// 供 permission_request 校验「请求的能力确实声明过」。
/// 非字符串元素与不在名单里的名字都是明确错误，不再静默丢弃（K4）。
pub fn declared_capabilities(
    app: &tauri::AppHandle,
    plugin_id: &str,
) -> Result<Vec<String>, HostError> {
    if !is_safe_id(plugin_id) {
        return Err(HostError::new(INVALID_ARG, "invalid plugin id"));
    }
    let manifest = read_manifest(&plugins_dir(app)?, plugin_id)?;
    let Some(value) = manifest.get("permissions") else {
        return Ok(Vec::new());
    };
    let arr = value
        .as_array()
        .ok_or(HostError::new(INVALID_ARG, "permissions 必须是数组"))?;
    let mut declared = Vec::with_capacity(arr.len());
    for item in arr {
        let name = item.as_str().ok_or_else(|| {
            HostError::new(INVALID_ARG, format!("permissions 元素必须是字符串: {item}"))
        })?;
        if !crate::plugin_caps::is_known(name) {
            return Err(HostError::new(INVALID_ARG, format!("未知能力名: {name}")));
        }
        declared.push(name.to_string());
    }
    Ok(declared)
}

/// `petplugin://<插件 id>/<相对路径>`：把插件文件从宿主认定的 plugins 目录读给 webview。
/// Windows 上 WebView2 把它映射成 `http://petplugin.localhost/...`。
/// 磁盘位置只有 `plugins_dir()` 一个解析点，因此不必在配置里重复写一遍路径 ——
/// asset 协议 + scope 的方案正是因为 `$CARGO_MANIFEST_DIR` 在 dev 下不展开而 403。
pub fn register_plugin_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol("petplugin", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .filter(|o| is_local_origin(o))
            .map(str::to_string);
        let path = request.uri().path().to_string();
        // 读盘走 blocking 线程池，不与 tokio worker 抢时间；一条请求一条裸线程的话
        // 插件页一刷新就是十几条线程
        tauri::async_runtime::spawn_blocking(move || {
            responder.respond(file_response(&app, &path, origin))
        });
    })
}

/// 只把 CORS 反射给本地 origin：任何真实外站都不该读到本地插件文件
fn is_local_origin(origin: &str) -> bool {
    tauri::Url::parse(origin)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h == "localhost" || h.ends_with(".localhost"))
        })
        .unwrap_or(false)
}

/// 每一段只允许 [A-Za-z0-9._-] 且不为 . / ..
/// —— 拼出 plugins 目录之外的路径在这一步就没有可能。
fn is_safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && rel.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
}

fn content_type(path: &str) -> &'static str {
    match path
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("js") | Some("mjs") => "text/javascript",
        Some("json") => "application/json",
        Some("css") => "text/css",
        Some("wasm") => "application/wasm",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn file_response(
    app: &tauri::AppHandle,
    url_path: &str,
    origin: Option<String>,
) -> tauri::http::Response<Vec<u8>> {
    let mut segments = url_path.trim_start_matches('/').splitn(2, '/');
    let plugin_id = segments.next().unwrap_or_default();
    let rel = segments.next().unwrap_or_default();

    let mut body: Option<Vec<u8>> = None;
    if is_safe_id(plugin_id) && is_safe_rel(rel) {
        if let Ok(file) = plugins_dir(app).map(|dir| dir.join(plugin_id).join(rel)) {
            body = std::fs::read(file).ok();
        }
    }

    let found = body.is_some();
    let mut resp = tauri::http::Response::new(body.unwrap_or_default());
    if !found {
        *resp.status_mut() = tauri::http::StatusCode::NOT_FOUND;
    }
    if let Ok(value) = content_type(url_path).parse() {
        resp.headers_mut()
            .insert(tauri::http::header::CONTENT_TYPE, value);
    }
    // 插件文件必须每次回源：覆盖代码免重启生效的前提是 HTTP 层不夹缓存
    //（ESM 模块映射表由文档重载解决，见 src/runtime/hot-reload.ts；这里只管协议层）。
    resp.headers_mut().insert(
        tauri::http::header::CACHE_CONTROL,
        tauri::http::HeaderValue::from_static("no-store"),
    );
    if let Some(origin) = origin {
        if let Ok(value) = origin.parse() {
            resp.headers_mut()
                .insert("Access-Control-Allow-Origin", value);
        }
    }
    resp
}

/// 持有 notify watcher。RecommendedWatcher 一旦被 drop 就停止监听，
/// 所以必须由 app state 长期持有，不能只在 setup 里造个局部变量。
/// 只用于持有 watcher（被 drop 即停止监听），字段本身不读
#[allow(dead_code)]
pub struct PluginWatcher(pub notify::RecommendedWatcher);

/// 去抖窗口内的待播报清单。`in_flight` 与 `paths` 在同一把锁里翻动：
/// 「取走路径」和「置回可开新轮」必须原子，否则新事件会与上一轮广播交错（漏播或把两轮并错）。
#[derive(Default)]
struct PendingChanges {
    paths: Vec<PathBuf>,
    in_flight: bool,
}

/// 把一批事件路径折叠成「受影响的插件 id」列表：只认 plugins 根目录**第一层**的名字，
/// 且必须通过 `crate::ids::is_safe_id`（与 collect_manifests、overlay 标签同一口径）。
/// 纯函数：不碰 IO、不碰 AppHandle，watcher 线程与单测共用同一份判定。
///
/// 递归监听下事件会带子目录里的文件（`<id>/nested/leaf.js`），剥到第一段就归一了；
/// Windows 上一次写入连发多个事件（CreateFile + ChangeMetadata…），同一 id 只留一个。
/// 只有 JS 模块被覆盖才需要「丢掉整张 ESM 模块映射表」（判定侧见 `src/runtime/hot-reload.ts`）。
/// manifest.json / 资源文件的改动靠 reconcile 重读就够了，不该因此掀翻正在显示这一插件的文档 ——
/// 宿主的回归脚本就是靠反复重写 manifest 来逐项要回能力的，把它算进重载集合会让套件中途丢全局。
fn is_module_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("js") | Some("mjs") | Some("cjs")
    )
}

fn plugin_ids_from_paths(plugins_root: &Path, paths: &[PathBuf]) -> Vec<String> {
    collect_ids(plugins_root, paths, false)
}

/// 同一份折叠，但只收「这一轮里确实被覆盖过模块文件」的插件 id。
fn plugin_reload_ids_from_paths(plugins_root: &Path, paths: &[PathBuf]) -> Vec<String> {
    collect_ids(plugins_root, paths, true)
}

fn collect_ids(plugins_root: &Path, paths: &[PathBuf], modules_only: bool) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for path in paths {
        if modules_only && !is_module_file(path) {
            continue;
        }
        let Ok(rel) = path.strip_prefix(plugins_root) else {
            continue;
        };
        // 根目录自身、以及用 `..` 爬出去的第一段都不算插件目录
        let Some(std::path::Component::Normal(dir)) = rel.components().next() else {
            continue;
        };
        let id = dir.to_string_lossy();
        if !is_safe_id(&id) {
            continue;
        }
        if !ids.iter().any(|seen| seen == id.as_ref()) {
            ids.push(id.to_string());
        }
    }
    ids
}

/// 监听 plugins 目录变化（递归：插件入口引出的子模块被覆盖也要发事件），
/// 去抖后广播 `host:plugins-changed`，载荷 `{ "ids": [...], "reloadIds": [...] }`：
/// `ids` 是这一轮被动过的插件 id（取不到合法 id 时是空数组，广播照发，保留既有「目录被动过」的语义），
/// `reloadIds` 是其中**模块文件被覆盖**的那部分 —— 只有它们值得让承载窗口整页换茬，
/// 见 `plugin_reload_ids_from_paths` 与 `src/runtime/hot-reload.ts`。
/// 宠物窗据此 reconcile 启停并按需重载文档、设置窗/悬浮窗刷新列表。
pub fn spawn_plugins_watcher(app: &tauri::AppHandle) -> Result<PluginWatcher, HostError> {
    use notify::{EventKind, RecursiveMode, Watcher};

    let dir = plugins_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| HostError::new(IO, format!("创建插件目录失败: {e}")))?;

    let sink = app.clone();
    let root = dir.clone();
    let pending = Arc::new(Mutex::new(PendingChanges::default()));
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        // 只读访问与属性变化不代表插件集合变了
        if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
            return;
        }
        // 一次安装/覆盖会连发多个事件：600ms 内合并成一次广播，窗口内的路径先全部攒下
        let start_round = {
            let mut state = pending.lock().unwrap_or_else(|p| p.into_inner());
            state.paths.extend(event.paths.iter().cloned());
            if state.in_flight {
                false
            } else {
                state.in_flight = true;
                true
            }
        };
        if !start_round {
            return;
        }
        let sink = sink.clone();
        let state = pending.clone();
        let root = root.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            let paths = {
                let mut state = state.lock().unwrap_or_else(|p| p.into_inner());
                state.in_flight = false;
                std::mem::take(&mut state.paths)
            };
            let ids = plugin_ids_from_paths(&root, &paths);
            let reload_ids = plugin_reload_ids_from_paths(&root, &paths);
            // G3-05：插件集合可能变了 —— 先让已安装 id 缓存失效，下面这些读盘逻辑才会重扫
            invalidate_installed_plugin_ids();
            crate::services::permission::prune_orphan_grants(&sink);
            // 删插件目录是「关闭联动」的第二条路：运行期没有卸载命令，只有这里看得见
            // 磁盘上的变化。resync 自己比较新旧判据，删个无关插件不会把 hook 摘掉。
            crate::services::agent::linkage::resync(&sink);
            let _ = sink.emit(
                "host:plugins-changed",
                serde_json::json!({ "ids": ids, "reloadIds": reload_ids }),
            );
        });
    })
    .map_err(|e| HostError::new(INTERNAL, e.to_string()))?;
    // 递归：插件入口引出的子模块（如 astock 的 sources/ 与 views/settings/）也要收事件，
    // 改子目录里的文件同样要让承载该插件的窗口知道 —— id 折叠见 plugin_ids_from_paths
    watcher
        .watch(&dir, RecursiveMode::Recursive)
        .map_err(|e| HostError::new(INTERNAL, e.to_string()))?;
    Ok(PluginWatcher(watcher))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// S4：id 规则只剩 `crate::ids::is_safe_id` 一份。这里钉住「本模块确实引用的是那一份」，
    /// 免得日后又在这个文件里长出第二套手写检查。
    /// 只看 `#[cfg(test)]` 之前的代码，否则断言里那些字面量会自我命中。
    #[test]
    fn plugins_module_uses_the_single_id_validator() {
        let full = include_str!("plugins.rs");
        let code = full.split("#[cfg(test)]").next().unwrap_or(full);
        assert!(
            code.contains("use crate::ids::is_safe_id;"),
            "plugins.rs 没有引用统一实现"
        );
        for banned in ["pub fn is_safe_id(", "fn valid_id(", "contains(\"..\")"] {
            assert!(
                !code.contains(banned),
                "plugins.rs 里出现了第二份 id 检查: {banned}"
            );
        }
    }

    /// G3-05：坏 manifest 的 `host:plugin-error` 只在「新坏 / 错误内容变了」时发，
    /// 同一份坏 manifest 被反复扫到不该反复刷前端日志。
    #[test]
    fn manifest_errors_are_reported_only_when_they_change() {
        let mut reported = HashMap::new();
        let bad = vec![("broken".to_string(), "manifest 无效: 缺 id".to_string())];
        assert_eq!(
            fresh_manifest_errors(&reported, &bad),
            bad,
            "第一次发现必须上报"
        );
        reported.extend(bad.clone());
        assert!(
            fresh_manifest_errors(&reported, &bad).is_empty(),
            "同一份错误重复扫描不该再报"
        );
        let changed = vec![("broken".to_string(), "manifest 无效: 缺 name".to_string())];
        assert_eq!(
            fresh_manifest_errors(&reported, &changed),
            changed,
            "错误内容变了要再报一次"
        );
    }

    /// K4：schema 的 id 约束（模式串 + 长度上下限）必须与 `ids.rs` 的词表是同一件事 ——
    /// 改 schema 里 pattern/minLength/maxLength 任一处，这里即红（负向自证用的就是这条）。
    #[test]
    fn schema_id_bounds_match_the_ids_vocab() {
        let id_rule = &manifest_schema()["properties"]["id"];
        assert_eq!(
            id_rule["pattern"], "^[a-z0-9][a-z0-9.-]{2,63}$",
            "schema 的 id 模式串变了 —— 它必须逐字照抄既有前端正则"
        );
        let min = id_rule["minLength"]
            .as_u64()
            .expect("schema 缺 id.minLength");
        let max = id_rule["maxLength"]
            .as_u64()
            .expect("schema 缺 id.maxLength");
        assert_eq!(
            (min, max),
            (3, 64),
            "schema 的 id 长度上下限与模式串 {{2,63}} 的展开不一致"
        );
        for len in [2u64, 3, 64, 65] {
            let id = "a".repeat(len as usize);
            let schema_ok = (min..=max).contains(&len);
            assert_eq!(
                schema_ok,
                is_safe_id(&id),
                "长度 {len} 处 schema 与 ids.rs 的判定不一致"
            );
        }
    }

    /// K4：`validate_manifest_fields` 按 schema 拒绝 —— 缺必填键、坏 id、坏 permissions。
    /// A2/ADR-0007：manifest 校验链的拒绝都是 invalid-arg（入参不合法）。
    #[test]
    fn manifest_fields_are_validated_against_the_schema() {
        let good = || {
            serde_json::json!({
                "id": "zz.good",
                "name": "好插件",
                "version": "0.0.1",
                "entry": "index.js",
                "permissions": ["storage"]
            })
        };
        assert!(
            validate_manifest_fields(&good()).is_ok(),
            "合法 manifest 被拒"
        );

        for key in ["id", "name", "version", "entry"] {
            let mut m = good();
            m.as_object_mut().unwrap().remove(key);
            let err = validate_manifest_fields(&m).unwrap_err();
            assert!(err.message.contains(key), "缺 {key} 的报错没带键名: {err}");
            assert_eq!(err.code, INVALID_ARG, "缺 {key} = invalid-arg");
        }

        let mut m = good();
        m["id"] = serde_json::json!("Todo");
        let err = validate_manifest_fields(&m).unwrap_err();
        assert!(err.message.contains("非法插件 id"));
        assert_eq!(err.code, INVALID_ARG, "坏 id = invalid-arg");
        let mut m = good();
        m["id"] = serde_json::json!("a".repeat(64));
        assert!(
            validate_manifest_fields(&m).is_ok(),
            "64 字符 id 应当合法（上限边界）"
        );
        let mut m = good();
        m["id"] = serde_json::json!("a".repeat(65));
        assert!(validate_manifest_fields(&m).is_err(), "65 字符 id 应当被拒");

        let mut m = good();
        m["permissions"] = serde_json::json!(["storage", 42]);
        let err = validate_manifest_fields(&m).unwrap_err();
        assert!(
            err.message.contains("必须是字符串") && err.message.contains("42"),
            "非字符串元素的报错: {err}"
        );
        assert_eq!(
            err.code, INVALID_ARG,
            "permissions 元素类型错 = invalid-arg"
        );
        let mut m = good();
        m["permissions"] = serde_json::json!(["not-a-cap"]);
        let err = validate_manifest_fields(&m).unwrap_err();
        assert!(
            err.message.contains("未知能力名") && err.message.contains("not-a-cap"),
            "未在名单里的能力名报错: {err}"
        );
        assert_eq!(err.code, INVALID_ARG, "未知能力名 = invalid-arg");
        let mut m = good();
        m["permissions"] = serde_json::json!("storage");
        let err = validate_manifest_fields(&m).unwrap_err();
        assert_eq!(err.code, INVALID_ARG, "permissions 非数组 = invalid-arg");
    }

    /// A2/ADR-0007：manifest 读取链的两类失败分码 —— 读不到文件 = io，
    /// 读到但 JSON 解析坏 = parse（A05 决策 1 里那个 internal 兜底要修掉的就是这两类）。
    #[test]
    fn manifest_read_failures_split_io_and_parse() {
        let dir = std::env::temp_dir().join(format!("pet-manifest-read-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("zz.bad")).unwrap();
        std::fs::write(dir.join("zz.bad").join("manifest.json"), b"{ not json").unwrap();

        let err = read_manifest(&dir, "zz.missing").unwrap_err();
        assert_eq!(err.code, IO, "读文件失败 = io");
        let err = read_manifest(&dir, "zz.bad").unwrap_err();
        assert_eq!(err.code, PARSE, "磁盘 JSON 解析失败 = parse");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 签名层钉子（A03 样板）：命令函数不能取符号（会把 tauri 命令机制拉进测试 exe 的
    /// 链接，0xc0000139），而这两条命令形状一改、前端裸 invoke 调用点必须同卡跟上，
    /// 所以 Err 侧形状在源码文本层钉住。
    #[test]
    fn plugin_command_signatures_declare_host_error() {
        let flat = include_str!("plugins.rs")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            flat.contains(
                "pub fn plugins_list(app: tauri::AppHandle) -> Result<Vec<Value>, HostError>"
            ),
            "plugins_list 的 Err 侧必须是 HostError"
        );
        assert!(
            flat.contains("rel: String, ) -> Result<u64, HostError>"),
            "plugin_file_version 的 Err 侧必须是 HostError"
        );
    }

    /// K4：四个在售插件的真 manifest 全部通过新校验 —— 加 apiVersion/minHostVersion
    /// 是扩接口，不改现有插件也必须兼容。
    #[test]
    fn shipped_manifests_pass_the_schema() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins");
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).expect("plugins 目录").flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(raw) = std::fs::read_to_string(entry.path().join("manifest.json")) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            // 目录名与 id 的一致归 collect_manifests 判，这里只管字段约束
            if value.get("id").and_then(Value::as_str) != Some(name.as_str()) {
                continue;
            }
            validate_manifest_fields(&value)
                .unwrap_or_else(|e| panic!("{name} 的真 manifest 未通过 schema 校验: {e}"));
            checked += 1;
        }
        assert!(
            checked >= 4,
            "只校验到 {checked} 个真实插件，扫目录的口径大概坏了"
        );
    }

    /* ---------- H2：递归 watcher 的「事件路径 → 插件 id」折叠 ---------- */
    // 与 watcher 用同一个根：dev 下 plugins_dir() 就是 CARGO_MANIFEST_DIR/../plugins，
    // notify 的事件路径按监听根原样前缀拼出，所以这里也用同一种构造才等价于现场

    fn plugins_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins")
    }

    /// 嵌套子目录里的文件（入口引出的子模块）必须归到所属插件的 id
    #[test]
    fn nested_submodule_paths_fold_to_their_plugin_id() {
        let root = plugins_root();
        let paths = vec![
            root.join("zz.a").join("nested").join("leaf.js"),
            root.join("com.pet.astock")
                .join("sources")
                .join("eastmoney.js"),
        ];
        assert_eq!(
            plugin_ids_from_paths(&root, &paths),
            vec!["zz.a".to_string(), "com.pet.astock".to_string()]
        );
    }

    /// 第一层目录名过不去 id 词表的（大写、下划线、过短、带空格）一律丢弃
    #[test]
    fn invalid_directory_names_are_dropped() {
        let root = plugins_root();
        let paths = vec![
            root.join("BadDir").join("index.js"),
            root.join("a_b").join("index.js"),
            root.join("ab").join("index.js"),
            root.join("a b").join("index.js"),
        ];
        assert!(plugin_ids_from_paths(&root, &paths).is_empty());
    }

    /// Windows 上一次写入会连发多个事件：同一插件出现多少次都只出一个 id
    #[test]
    fn repeated_events_for_one_plugin_collapse_to_one_id() {
        let root = plugins_root();
        let entry = root.join("zz.a").join("index.js");
        let paths = vec![
            entry.clone(),
            entry.clone(),
            entry,
            root.join("zz.a").join("widget.js"),
        ];
        assert_eq!(
            plugin_ids_from_paths(&root, &paths),
            vec!["zz.a".to_string()]
        );
    }

    /// 一次窗口里动到多个插件时，各自都要出现
    #[test]
    fn paths_of_different_plugins_each_appear() {
        let root = plugins_root();
        let paths = vec![
            root.join("zz.a").join("index.js"),
            root.join("zz.b")
                .join("nested")
                .join("deep")
                .join("leaf.js"),
        ];
        assert_eq!(
            plugin_ids_from_paths(&root, &paths),
            vec!["zz.a".to_string(), "zz.b".to_string()]
        );
    }

    /// 插件目录之外的路径（兄弟目录、用 `..` 爬出去、根自身）一概不产出
    #[test]
    fn paths_outside_the_plugins_root_produce_nothing() {
        let root = plugins_root();
        let paths = vec![
            root.parent()
                .unwrap()
                .join("src")
                .join("runtime")
                .join("plugin-runtime.ts"),
            root.join("..").join("etc"),
            root.clone(),
        ];
        assert!(plugin_ids_from_paths(&root, &paths).is_empty());
    }

    /// H2：只有模块文件被覆盖才进 `reloadIds` —— manifest.json 之类的改动 reconcile 重读就够，
    /// 为它整页换茬会抹掉窗口里的运行状态（宿主的回归脚本正是靠反复重写 manifest 逐项要能力）。
    #[test]
    fn only_module_files_make_a_plugin_reload_candidate() {
        let root = plugins_root();
        let paths = vec![
            root.join("zz.a").join("manifest.json"),
            root.join("zz.b").join("widget.js"),
            root.join("zz.c").join("views").join("settings.js"),
            root.join("zz.d").join("sprite.webp"),
        ];
        assert_eq!(
            plugin_ids_from_paths(&root, &paths),
            vec![
                "zz.a".to_string(),
                "zz.b".to_string(),
                "zz.c".to_string(),
                "zz.d".to_string()
            ],
            "被动过的插件都要报出来（reconcile 与列表刷新用得上）"
        );
        assert_eq!(
            plugin_reload_ids_from_paths(&root, &paths),
            vec!["zz.b".to_string(), "zz.c".to_string()],
            "重载集合里只该有模块被覆盖的那两个（嵌套子目录里的也算）"
        );
    }

    /// 目录名必须直接满足 id 词表：超过 64 字符的名字同样丢弃
    /// （防「只取第一段」被绕过成任意长字符串带进事件载荷）
    #[test]
    fn overlong_directory_names_are_dropped() {
        let root = plugins_root();
        let paths = vec![
            root.join("a".repeat(65)).join("index.js"),
            root.join("a".repeat(64)).join("index.js"),
        ];
        assert_eq!(plugin_ids_from_paths(&root, &paths), vec!["a".repeat(64)]);
    }

    /// ADR-0005：mtime 的读法从命令体抽出来后，它自己必须可离线钉住
    #[test]
    fn file_version_reads_epoch_millis_and_errors_on_missing_file() {
        let dir = std::env::temp_dir().join(format!("pet-file-version-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("index.js");
        std::fs::write(&f, b"export const v = 1").unwrap();
        let got = file_modified_millis(&f).unwrap();
        assert!(
            got > 1_700_000_000_000,
            "epoch 毫秒应落在 2023 年之后，实得 {got}"
        );
        let err = file_modified_millis(&dir.join("没有这个文件.js")).unwrap_err();
        assert!(
            err.message.starts_with("读取 "),
            "错误文案要带路径便于排查，实得 {err}"
        );
        assert_eq!(err.code, IO, "读文件失败 = io");
        std::fs::remove_dir_all(&dir).ok();
    }
}
