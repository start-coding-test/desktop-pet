//! 宿主侧落盘的公共小工具。
//!
//! 「tmp + pid + rename」这套写法在形象安装、hook 配置、授权表、插件存储里各有一份，
//! 少一处原子性就会留下半截 JSON（下次启动直接当成空表）。统一到这里。
//!
//! G3-04：
//! - 临时名带 pid + 进程内自增序号 + 纳秒后缀：只带 pid 时同一进程里的两次并发写仍会撞名
//!   （一方还在写 `<x>.<pid>.tmp`，另一方已经把同名文件 rename 走了）；
//! - 写完 `sync_all` 再 rename：rename 只保证目录项的原子替换，不保证数据已落盘。
//!   hook 配置、授权表这类「拔电也不能坏」的文件必须自己把数据刷下去。
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::host_error::{HostError, IO};

/// 进程内临时文件序号：只靠 pid 区分不了同进程里的并发写入者
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);
/// 进程内另加一层纳秒分量：序号已经能分开并发，这里再兜一层，跨进程复用 pid 也不会撞
fn temp_path(path: &Path) -> PathBuf {
    let base = path.file_name().and_then(|s| s.to_str()).unwrap_or("file");
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    path.with_file_name(format!("{base}.{}.{seq}.{nanos}.tmp", std::process::id()))
}

/// 原子写：先落同目录临时文件（写完 fsync）再 rename。
/// 临时名带 pid + 序号 —— 固定名会让两个写入者互相覆盖：
/// 一方还在写 `x.tmp`，另一方已经把同名文件 rename 走了。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), HostError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| HostError::new(IO, format!("创建目录失败 {parent:?}: {e}")))?;
    }
    let tmp = temp_path(path);
    let written = fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(HostError::new(IO, format!("写入临时文件失败: {e}")));
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(HostError::new(IO, format!("替换文件失败: {e}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("pet-fsutil-{}", std::process::id()));
        let path = dir.join("payload.json");
        write_atomic(&path, b"{\"ok\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"ok\":1}");
        // 只留下目标文件本身
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(vec!["payload.json".to_string()], leftovers);
        let _ = fs::remove_dir_all(&dir);
    }

    /// G3-04：同进程的两次并发写不能拿到同一个临时名
    #[test]
    fn temp_names_are_unique_and_carry_the_pid() {
        let dir = std::env::temp_dir().join(format!("pet-fsutil-names-{}", std::process::id()));
        let path = dir.join("payload.json");
        let a = temp_path(&path);
        let b = temp_path(&path);
        assert_ne!(a, b, "两次取的临时名必须不同");
        for p in [&a, &b] {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            assert!(
                name.contains(&std::process::id().to_string()),
                "临时名没带 pid: {name}"
            );
            assert!(name.ends_with(".tmp"), "临时名不自证身份: {name}");
            assert!(
                name.matches('.').count() >= 3,
                "临时名只有 pid 不够（同进程并发会撞名）: {name}"
            );
        }
    }

    /// G3-04：多个线程同时原子写同一个目标 —— 不许留下半截内容，也不许残留临时文件
    #[test]
    fn concurrent_writers_never_leave_temp_files() {
        let dir = std::env::temp_dir().join(format!("pet-fsutil-race-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("payload.json");
        let mut handles = Vec::new();
        for i in 0..8u8 {
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                for round in 0..10 {
                    write_atomic(&path, format!("{{\"v\":{i},\"r\":{round}}}").as_bytes()).unwrap();
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        let raw = fs::read_to_string(&path).unwrap();
        assert!(
            raw.starts_with('{') && raw.ends_with('}'),
            "落盘内容不完整: {raw}"
        );
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
