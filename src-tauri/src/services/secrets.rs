//! 插件凭据存储（B07 / ADR-0012）。
//!
//! 落点 `%APPDATA%/<identifier>/plugins/<plugin_id>/secrets.json`，与 `store.json` 同目录。
//! 值用 Windows DPAPI（当前用户 + `CRYPTPROTECT_UI_FORBIDDEN`）加密，熵绑定 plugin_id。
//! 普通 `store.json` 不做透明加密；宿主不做旧明文迁移（copy→verify→clear 归 C06）。
//!
//! fail-closed：非 Windows / 解密失败 / 文件坏 / 非法 key 一律 Err，且**不写、不删、不回落明文**。
//! 同 realm 自报 id 的残余（ADR-0006 / ADR-0011）没有被这张卡解决，见 ADR-0012「已知未收口」。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::permission::PermissionState;
use crate::fsutil::write_atomic;
use crate::host_error::{HostError, INTERNAL, INVALID_ARG, IO, PARSE, UNSUPPORTED};

const SCHEMA: u32 = 1;
const ALG: &str = "dpapi";
const MAX_KEY_BYTES: usize = 64;
const MAX_VALUE_BYTES: usize = 16 * 1024;

/// secrets 的读-改-写统一串行。操作很少，一把全局锁比照 store 再复制一张 Weak 锁表更简单，
/// 也不会因为漏回收而只增不减。
static SECRETS_LOCK: Mutex<()> = Mutex::new(());

/// 平台加密后端。生产只走 DPAPI / Unsupported；测试注入可逆的 FakeBackend。
pub trait SecretBackend: Send + Sync {
    fn protect(&self, plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, HostError>;
    fn unprotect(&self, blob: &[u8], entropy: &[u8]) -> Result<Vec<u8>, HostError>;
}

#[cfg(windows)]
struct DpapiBackend;

#[cfg(windows)]
impl SecretBackend for DpapiBackend {
    fn protect(&self, plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, HostError> {
        dpapi(plain, entropy, true)
    }

    fn unprotect(&self, blob: &[u8], entropy: &[u8]) -> Result<Vec<u8>, HostError> {
        dpapi(blob, entropy, false)
    }
}

/// 非 Windows 或平台能力不可用时一律报 `unsupported`，绝不把明文写到磁盘。
/// Windows 生产路径不构造它，但单测用它钉住「失败也不落明文」这一支。
#[allow(dead_code)]
pub struct UnsupportedBackend;

impl SecretBackend for UnsupportedBackend {
    fn protect(&self, _plain: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, HostError> {
        Err(HostError::new(UNSUPPORTED, "凭据存储仅 Windows 可用"))
    }

    fn unprotect(&self, _blob: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, HostError> {
        Err(HostError::new(UNSUPPORTED, "凭据存储仅 Windows 可用"))
    }
}

fn default_backend() -> Box<dyn SecretBackend> {
    #[cfg(windows)]
    {
        Box::new(DpapiBackend)
    }
    #[cfg(not(windows))]
    {
        Box::new(UnsupportedBackend)
    }
}

#[cfg(windows)]
fn dpapi(input: &[u8], entropy: &[u8], protect: bool) -> Result<Vec<u8>, HostError> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        if protect {
            CryptProtectData(
                &input_blob,
                windows::core::PCWSTR::null(),
                Some(&entropy_blob),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input_blob,
                None,
                Some(&entropy_blob),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    result.map_err(|e| HostError::new(INTERNAL, format!("DPAPI 失败: {e}")))?;
    if output.pbData.is_null() {
        return Err(HostError::new(INTERNAL, "DPAPI 返回空缓冲区"));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
    }
    Ok(bytes)
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    schema: u32,
    entries: BTreeMap<String, Entry>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    v: u32,
    alg: String,
    #[serde(rename = "savedAt")]
    saved_at: u64,
    blob: String,
}

impl Envelope {
    fn empty() -> Self {
        Self {
            schema: SCHEMA,
            entries: BTreeMap::new(),
        }
    }
}

struct SecretsStore {
    path: PathBuf,
    plugin_id: String,
    backend: Box<dyn SecretBackend>,
}

impl SecretsStore {
    fn at(path: PathBuf, plugin_id: &str) -> Self {
        Self {
            path,
            plugin_id: plugin_id.to_string(),
            backend: default_backend(),
        }
    }

    #[cfg(test)]
    fn with_backend(path: PathBuf, plugin_id: &str, backend: Box<dyn SecretBackend>) -> Self {
        Self {
            path,
            plugin_id: plugin_id.to_string(),
            backend,
        }
    }

    fn get(&self, key: &str) -> Result<Option<String>, HostError> {
        check_key(key)?;
        let _guard = SECRETS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let envelope = read_envelope(&self.path)?;
        let Some(entry) = envelope.entries.get(key) else {
            return Ok(None);
        };
        let blob = entry_blob(entry, key)?;
        let plain = self
            .backend
            .unprotect(&blob, &entropy_for(&self.plugin_id))?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|_| HostError::new(INTERNAL, "凭据不是合法 UTF-8"))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), HostError> {
        check_key(key)?;
        if value.len() > MAX_VALUE_BYTES {
            return Err(HostError::new(
                INVALID_ARG,
                format!("凭据值超过 {MAX_VALUE_BYTES} 字节"),
            ));
        }
        let _guard = SECRETS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut envelope = read_envelope(&self.path)?;
        let blob = self
            .backend
            .protect(value.as_bytes(), &entropy_for(&self.plugin_id))?;
        envelope.entries.insert(
            key.to_string(),
            Entry {
                v: 1,
                alg: ALG.to_string(),
                saved_at: now_ms(),
                blob: b64_encode(&blob),
            },
        );
        write_envelope(&self.path, &envelope)
    }

    fn delete(&self, key: &str) -> Result<(), HostError> {
        check_key(key)?;
        let _guard = SECRETS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut envelope = read_envelope(&self.path)?;
        if envelope.entries.remove(key).is_some() {
            write_envelope(&self.path, &envelope)?;
        }
        Ok(())
    }

    /// 独立清理入口。生产清理路径 = `store::clear_plugin` 的 `remove_dir_all`
    /// （同目录的 `secrets.json` 会被一并删掉）；本函数无调用方，仅供测试与以后
    /// 拆出独立目录时使用。
    #[allow(dead_code)]
    pub fn clear_plugin(&self) -> Result<(), HostError> {
        let _guard = SECRETS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(HostError::io(e)),
        }
    }
}

fn check_key(key: &str) -> Result<(), HostError> {
    let ok = !key.is_empty()
        && key.len() <= MAX_KEY_BYTES
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(HostError::new(INVALID_ARG, "invalid secret key"))
    }
}

fn entropy_for(plugin_id: &str) -> Vec<u8> {
    format!("pet-secrets:v1:{plugin_id}").into_bytes()
}

fn plugin_path(root: &Path, plugin_id: &str) -> Result<PathBuf, HostError> {
    if !crate::ids::is_safe_id(plugin_id) {
        return Err(HostError::new(INVALID_ARG, "invalid plugin id"));
    }
    Ok(root.join(plugin_id).join("secrets.json"))
}

fn app_plugins_dir(app: &AppHandle) -> Result<PathBuf, HostError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("plugins"))
        .map_err(|e| HostError::new(INTERNAL, format!("无法定位应用数据目录: {e}")))
}

fn read_envelope(path: &Path) -> Result<Envelope, HostError> {
    match fs::read_to_string(path) {
        Ok(raw) => parse_envelope(&raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Envelope::empty()),
        Err(e) => Err(HostError::new(
            IO,
            format!("读取凭据文件失败 {}: {e}", path.display()),
        )),
    }
}

fn parse_envelope(raw: &str) -> Result<Envelope, HostError> {
    let envelope: Envelope = serde_json::from_str(raw)
        .map_err(|e| HostError::new(PARSE, format!("凭据文件已损坏: {e}")))?;
    if envelope.schema != SCHEMA {
        return Err(HostError::new(
            PARSE,
            format!("凭据文件 schema={} 不支持", envelope.schema),
        ));
    }
    Ok(envelope)
}

fn write_envelope(path: &Path, envelope: &Envelope) -> Result<(), HostError> {
    let json = serde_json::to_string_pretty(envelope)
        .map_err(|e| HostError::new(INTERNAL, e.to_string()))?;
    write_atomic(path, json.as_bytes())
}

fn entry_blob(entry: &Entry, key: &str) -> Result<Vec<u8>, HostError> {
    if entry.v != 1 || entry.alg != ALG {
        return Err(HostError::new(
            PARSE,
            format!("凭据条目 {key} 的形状不支持"),
        ));
    }
    b64_decode(&entry.blob)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 日志只允许出现操作名、插件 id、key 与字节数；值本身绝不进日志。
fn audit_line(op: &str, plugin_id: &str, key: &str, value: Option<&str>) -> String {
    let bytes = value.map(str::len).unwrap_or(0);
    format!("{op} plugin={plugin_id} key={key} bytes={bytes}")
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        out.push(B64[(chunk[0] >> 2) as usize] as char);
        out.push(B64[(((chunk[0] & 0x03) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64[(third & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn b64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn b64_decode(text: &str) -> Result<Vec<u8>, HostError> {
    let raw = text.as_bytes();
    if !raw.len().is_multiple_of(4) {
        return Err(HostError::new(PARSE, "凭据 blob 不是合法 base64"));
    }
    let mut out = Vec::with_capacity(raw.len() / 4 * 3);
    for (index, chunk) in raw.chunks(4).enumerate() {
        let last = index + 1 == raw.len() / 4;
        let pad = chunk.iter().rev().take_while(|c| **c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return Err(HostError::new(PARSE, "凭据 blob 的 base64 填充位置不对"));
        }
        let mut seen_pad = false;
        let mut values = [0u8; 4];
        for (slot, &byte) in chunk.iter().enumerate() {
            if byte == b'=' {
                seen_pad = true;
                continue;
            }
            if seen_pad {
                return Err(HostError::new(PARSE, "凭据 blob 的 base64 填充位置不对"));
            }
            values[slot] = b64_value(byte)
                .ok_or_else(|| HostError::new(PARSE, "凭据 blob 含非法 base64 字符"))?;
        }
        if pad == 2 && values[1] & 0x0f != 0 {
            return Err(HostError::new(PARSE, "凭据 blob 的 base64 尾位不为零"));
        }
        if pad == 1 && values[2] & 0x03 != 0 {
            return Err(HostError::new(PARSE, "凭据 blob 的 base64 尾位不为零"));
        }
        out.push((values[0] << 2) | (values[1] >> 4));
        if pad < 2 {
            out.push((values[1] << 4) | (values[2] >> 2));
        }
        if pad < 1 {
            out.push((values[2] << 6) | values[3]);
        }
    }
    Ok(out)
}

/// 凭据命令的统一入口：先过窗口归属 + 能力门禁（复用 storage），再解析落点。
fn resolve(
    window: &tauri::Window,
    perms: &PermissionState,
    root: &Path,
    plugin_id: &str,
) -> Result<PathBuf, HostError> {
    crate::gate::plugin_capability(window, perms, plugin_id, crate::plugin_caps::STORAGE)?;
    plugin_path(root, plugin_id)
}

/// 单测专用：不造 AppHandle/Window，只钉「能力门禁 + 落点」；窗口归属由 gate 单测覆盖。
#[cfg(test)]
fn resolve_for_test(
    perms: &PermissionState,
    root: &Path,
    plugin_id: &str,
) -> Result<PathBuf, HostError> {
    crate::gate::plugin_capability_for(perms, plugin_id, crate::plugin_caps::STORAGE)?;
    plugin_path(root, plugin_id)
}

#[tauri::command]
pub async fn secrets_get(
    window: tauri::Window,
    app: AppHandle,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    key: String,
) -> Result<Option<String>, HostError> {
    let root = app_plugins_dir(&app)?;
    let path = resolve(&window, &perms, &root, &plugin_id)?;
    // G3-05：DPAPI 加解密与落盘都是阻塞 IO，移到阻塞线程池
    tauri::async_runtime::spawn_blocking(move || {
        let store = SecretsStore::at(path, &plugin_id);
        let value = store.get(&key)?;
        log::debug!(
            "{}",
            audit_line("secrets_get", &plugin_id, &key, value.as_deref())
        );
        Ok(value)
    })
    .await
    .map_err(|e| HostError::new(INTERNAL, format!("凭据任务失败: {e}")))?
}

#[tauri::command]
pub async fn secrets_set(
    window: tauri::Window,
    app: AppHandle,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    key: String,
    value: String,
) -> Result<(), HostError> {
    let root = app_plugins_dir(&app)?;
    let path = resolve(&window, &perms, &root, &plugin_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = SecretsStore::at(path, &plugin_id);
        store.set(&key, &value)?;
        log::info!(
            "{}",
            audit_line("secrets_set", &plugin_id, &key, Some(&value))
        );
        Ok(())
    })
    .await
    .map_err(|e| HostError::new(INTERNAL, format!("凭据任务失败: {e}")))?
}

#[tauri::command]
pub async fn secrets_delete(
    window: tauri::Window,
    app: AppHandle,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    key: String,
) -> Result<(), HostError> {
    let root = app_plugins_dir(&app)?;
    let path = resolve(&window, &perms, &root, &plugin_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = SecretsStore::at(path, &plugin_id);
        store.delete(&key)?;
        log::info!("{}", audit_line("secrets_delete", &plugin_id, &key, None));
        Ok(())
    })
    .await
    .map_err(|e| HostError::new(INTERNAL, format!("凭据任务失败: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeBackend;

    impl SecretBackend for FakeBackend {
        fn protect(&self, plain: &[u8], entropy: &[u8]) -> Result<Vec<u8>, HostError> {
            let mut out = entropy.to_vec();
            out.extend(plain.iter().map(|b| b ^ 0x5a));
            Ok(out)
        }

        fn unprotect(&self, blob: &[u8], entropy: &[u8]) -> Result<Vec<u8>, HostError> {
            if !blob.starts_with(entropy) {
                return Err(HostError::new(INTERNAL, "fake backend: entropy mismatch"));
            }
            Ok(blob[entropy.len()..].iter().map(|b| b ^ 0x5a).collect())
        }
    }

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pet-secrets-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store_with_fake(root: &Path, plugin_id: &str) -> SecretsStore {
        let path = plugin_path(root, plugin_id).unwrap();
        SecretsStore::with_backend(path, plugin_id, Box::new(FakeBackend))
    }

    fn grant_storage(perms: &PermissionState, plugin_id: &str) {
        perms.grant(plugin_id, &["storage".to_string()]);
    }

    #[test]
    fn set_get_delete_roundtrip_keeps_plaintext_out_of_the_file() {
        let root = tmp_dir("roundtrip");
        let store = store_with_fake(&root, "com.pet.todo");
        assert_eq!(store.get("apiKey").unwrap(), None);
        store.set("apiKey", "fake-key-for-tests").unwrap();
        let raw = fs::read_to_string(&store.path).unwrap();
        assert!(!raw.contains("fake-key-for-tests"), "明文进了文件: {raw}");
        assert!(raw.contains("\"alg\": \"dpapi\""));
        assert!(raw.contains("\"schema\": 1"));
        assert_eq!(
            store.get("apiKey").unwrap(),
            Some("fake-key-for-tests".to_string())
        );
        store.delete("apiKey").unwrap();
        assert_eq!(store.get("apiKey").unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn secret_key_rules_match_the_contract() {
        let long = "k".repeat(MAX_KEY_BYTES);
        for good in ["apiKey", "cookie.v1", "a_b-c", long.as_str()] {
            assert!(check_key(good).is_ok(), "{good} 应合法");
        }
        let too_long = "k".repeat(MAX_KEY_BYTES + 1);
        for bad in ["", "a b", "a/b", "a:b", "a\\b", too_long.as_str()] {
            assert!(check_key(bad).is_err(), "{bad} 应被拒");
        }
    }

    #[test]
    fn corrupt_file_is_parse_error_and_set_does_not_overwrite_it() {
        let root = tmp_dir("corrupt");
        let store = store_with_fake(&root, "com.pet.todo");
        fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        fs::write(&store.path, "这不是合法 JSON").unwrap();
        let before = fs::read(&store.path).unwrap();
        let err = store.get("apiKey").unwrap_err();
        assert_eq!(err.code, PARSE);
        let err = store.set("apiKey", "fake-key").unwrap_err();
        assert_eq!(err.code, PARSE);
        assert_eq!(fs::read(&store.path).unwrap(), before, "坏文件被覆盖了");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn wrong_plugin_entropy_fails_and_leaves_the_file_unchanged() {
        let root = tmp_dir("entropy");
        let store_a = store_with_fake(&root, "com.pet.todo");
        store_a.set("apiKey", "fake-key").unwrap();
        let before = fs::read(&store_a.path).unwrap();
        let store_b = SecretsStore::with_backend(
            store_a.path.clone(),
            "com.pet.astock",
            Box::new(FakeBackend),
        );
        let err = store_b.get("apiKey").unwrap_err();
        assert_eq!(err.code, INTERNAL);
        assert_eq!(
            fs::read(&store_a.path).unwrap(),
            before,
            "解密失败改动了文件"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_blob_fails_without_modifying_the_file() {
        let root = tmp_dir("blob");
        let store = store_with_fake(&root, "com.pet.todo");
        store.set("apiKey", "fake-key").unwrap();
        let mut envelope = read_envelope(&store.path).unwrap();
        envelope.entries.get_mut("apiKey").unwrap().blob = b64_encode(b"garbage");
        write_envelope(&store.path, &envelope).unwrap();
        let before = fs::read(&store.path).unwrap();
        let err = store.get("apiKey").unwrap_err();
        assert_eq!(err.code, INTERNAL);
        assert_eq!(fs::read(&store.path).unwrap(), before, "解密失败改动了文件");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_algorithm_errors_only_for_that_key() {
        let root = tmp_dir("alg");
        let store = store_with_fake(&root, "com.pet.todo");
        store.set("apiKey", "fake-key").unwrap();
        store.set("cookie", "fake-cookie").unwrap();
        let mut envelope = read_envelope(&store.path).unwrap();
        envelope.entries.get_mut("apiKey").unwrap().alg = "plain".to_string();
        write_envelope(&store.path, &envelope).unwrap();
        assert_eq!(store.get("apiKey").unwrap_err().code, PARSE);
        assert_eq!(
            store.get("cookie").unwrap(),
            Some("fake-cookie".to_string())
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn oversized_value_is_rejected_before_writing() {
        let root = tmp_dir("oversize");
        let store = store_with_fake(&root, "com.pet.todo");
        let err = store
            .set("apiKey", &"x".repeat(MAX_VALUE_BYTES + 1))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARG);
        assert!(!store.path.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unsupported_backend_is_an_error_not_plaintext() {
        let root = tmp_dir("unsupported");
        let path = plugin_path(&root, "com.pet.todo").unwrap();
        let store = SecretsStore::with_backend(path, "com.pet.todo", Box::new(UnsupportedBackend));
        let err = store.set("apiKey", "fake-key").unwrap_err();
        assert_eq!(err.code, UNSUPPORTED);
        assert!(!store.path.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_denies_without_storage_grant_and_rejects_bad_ids() {
        let root = tmp_dir("resolve");
        let perms = PermissionState::new();
        let err = resolve_for_test(&perms, &root, "todo").unwrap_err();
        assert_eq!(err.code, crate::host_error::DENIED);
        grant_storage(&perms, "todo");
        let path = resolve_for_test(&perms, &root, "todo").unwrap();
        assert_eq!(path, root.join("todo").join("secrets.json"));
        assert_eq!(
            resolve_for_test(&perms, &root, "C:").unwrap_err().code,
            INVALID_ARG
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clear_plugin_removes_the_secret_file() {
        let root = tmp_dir("clear");
        let store = store_with_fake(&root, "com.pet.todo");
        store.set("apiKey", "fake-key").unwrap();
        assert!(store.path.exists());
        store.clear_plugin().unwrap();
        assert!(!store.path.exists());
        // 已不存在时也必须 Ok（撤销授权可能跑两次）
        store.clear_plugin().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn audit_line_never_contains_the_value() {
        let line = audit_line(
            "secrets_set",
            "com.pet.todo",
            "apiKey",
            Some("fake-secret-value"),
        );
        assert!(
            !line.contains("fake-secret-value"),
            "日志行泄露了值: {line}"
        );
        assert!(line.contains("bytes=17"), "日志行应只带长度: {line}");
        assert!(line.contains("key=apiKey"));
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip_is_bound_to_the_plugin_entropy() {
        let backend = DpapiBackend;
        let plain = b"fake-cookie-for-tests";
        let entropy_a = entropy_for("com.pet.todo");
        let blob = backend.protect(plain, &entropy_a).unwrap();
        assert_eq!(backend.unprotect(&blob, &entropy_a).unwrap(), plain);
        assert!(
            backend
                .unprotect(&blob, &entropy_for("com.pet.astock"))
                .is_err(),
            "换了 plugin_id 的熵仍解开了"
        );
    }

    #[test]
    fn dpapi_flags_forbid_ui_and_keep_current_user_scope() {
        // CI 的 checkout 是 CRLF（autocrlf），源码里按 `\n` 定位前先归一化：
        // 这条断言钉的是调用块的形状，不该被行尾格式影响。
        let src = include_str!("secrets.rs").replace("\r\n", "\n");
        let start = src.find("\nfn dpapi(").expect("找不到 dpapi 函数");
        let rest = &src[start..];
        let end = rest.find("\n}\n").expect("找不到 dpapi 函数结尾");
        let body = &rest[..end];
        let call_at = body
            .find("let result = unsafe {")
            .expect("找不到 DPAPI 调用块");
        let call_end = body[call_at..]
            .find("\n    };")
            .expect("找不到 DPAPI 调用块结尾");
        // `\n    };` 共 7 个字符；call_end 是相对 call_at 的偏移，必须加上起点。
        let call = &body[call_at..call_at + call_end + 7];
        let flags = call.matches("CRYPTPROTECT_UI_FORBIDDEN").count();
        assert_eq!(
            flags, 2,
            "protect 与 unprotect 两侧都要带 UI_FORBIDDEN，实际 {flags} 处"
        );
        assert!(
            !call.contains("CRYPTPROTECT_LOCAL_MACHINE"),
            "DPAPI 不得用机器级作用域"
        );
        // 5 = protect 侧 2 个 None, + unprotect 侧 3 个 None,（当前字面量）。
        let nones = call.matches("None,").count();
        assert_eq!(
            nones, 5,
            "5 = protect 侧 2 + unprotect 侧 3，实际 {nones} 处"
        );
        assert!(
            !call.contains("Some(&mut"),
            "不许给 DPAPI 传 provider/reserved 结构"
        );
        assert!(!call.contains("CryptKeyProvider"), "不许换 provider");
    }

    /// F5（B09）：真实 DPAPI 后端（不是 Fake）写盘时不得出现明文；Windows CI 直接覆盖。
    #[cfg(windows)]
    #[test]
    fn real_dpapi_backend_writes_no_plaintext_to_disk() {
        let root = tmp_dir("dpapi-disk");
        let store = SecretsStore::at(plugin_path(&root, "com.pet.todo").unwrap(), "com.pet.todo");
        let secret = "fake-cookie-for-real-dpapi";
        store.set("apiKey", secret).unwrap();
        let raw = fs::read_to_string(&store.path).unwrap();
        assert!(
            !raw.contains(secret),
            "真 DPAPI 路径把明文写进了文件: {raw}"
        );
        assert!(
            raw.contains("\"alg\": \"dpapi\"") && raw.contains("\"schema\": 1"),
            "信封形状变了: {raw}"
        );
        assert_eq!(
            store.get("apiKey").unwrap().as_deref(),
            Some(secret),
            "往返后值变了"
        );
        store.set("apiKey", "rotated-value").unwrap();
        let after = fs::read_to_string(&store.path).unwrap();
        assert!(
            !after.contains(secret) && !after.contains("rotated-value"),
            "覆盖后泄露了值"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn base64_roundtrip_and_invalid_inputs() {
        let cases: &[&[u8]] = &[b"", b"a", b"ab", b"abc", b"fake-cookie-for-tests"];
        for bytes in cases {
            assert_eq!(b64_decode(&b64_encode(bytes)).unwrap(), *bytes);
        }
        assert_eq!(b64_decode("QQ==").unwrap(), b"A");
        assert_eq!(b64_decode("QUI=").unwrap(), b"AB");
        for bad in ["A", "!!!!", "Q===", "QQ=A", "QQ==QQ=="] {
            assert!(b64_decode(bad).is_err(), "{bad} 应被拒");
        }
    }

    /// 未初始化/错误路径的静态兜底：确保我们没在紧张时把值从错误里带出来。
    #[test]
    fn host_error_messages_do_not_include_the_secret_value() {
        let root = tmp_dir("error-text");
        let store = store_with_fake(&root, "com.pet.todo");
        store.set("apiKey", "fake-key").unwrap();
        let mut envelope = read_envelope(&store.path).unwrap();
        envelope.entries.get_mut("apiKey").unwrap().blob = b64_encode(b"garbage");
        write_envelope(&store.path, &envelope).unwrap();
        let err = store.get("apiKey").unwrap_err();
        assert!(!err.message.contains("fake-key"), "错误文案泄露了值: {err}");
        let _ = fs::remove_dir_all(&root);
    }
}
