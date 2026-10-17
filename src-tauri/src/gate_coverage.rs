//! S5：命令门禁覆盖面。判据来自「宿主真正注册了哪些命令」，不是靠人记得改注释。
//!
//! 做法：读 lib.rs 的 `generate_handler!` 拿到全部已注册命令 → 在 src/ 里找到各自的定义 →
//! 凡参数表里带 `plugin_id` 的，函数体必须出现一把能力门禁（直接或经本文件的一层薄封装），
//! 或者出现在下面的「窗口门禁名单」里并写明理由。
//! 于是新增一条带 plugin_id 的命令而漏了门禁，这条测试当场变红；
//! 名单里的命令改了签名不再带 plugin_id，也会被反向抓到。
#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    /// 不经能力门禁的命令：它们靠窗口门禁或根本不构成能力面，改这里要写清理由
    const WINDOW_GATED: &[(&str, &str)] = &[
        (
            "overlay_reclaim",
            "宿主回收通道：只认宠物窗里的运行时（gate::pet），撤销授权后能力已没，窗还得收得掉",
        ),
        ("permission_check", "授权表本身的查询接口，门禁就是它"),
        (
            "permission_request",
            "授权表本身的申请接口，未声明的能力在这里被拒",
        ),
        (
            "permission_revoke",
            "只认设置窗（gate::settings），撤销会连带清存储与悬浮层",
        ),
        (
            "plugin_file_version",
            "取文件 mtime 给 import() 拼 cache-busting，由 id + rel 校验兜底，不是能力面",
        ),
        (
            "bus_peek",
            "只读回灌：只认调用方自己 \"{id}:widget\"，归属由 resolve_owner 加 topic 等值判定，\
             悬浮窗只认宿主注册表；自报 id 的残余风险见 ADR-0011",
        ),
    ];

    /// 直接调门禁的写法
    const DIRECT: &[&str] = &[
        "gate::plugin_capability",
        "require_granted",
        "check_granted",
    ];
    /// 本文件里的薄封装：封装体必须真的去查门禁，否则不算
    const WRAPPERS: &[&str] = &[
        "resolve(",
        "check_grant(",
        "check_publish(",
        "assert_caller(",
    ];

    fn src_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
    }

    fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("读不到 src 目录") {
            let path = entry.expect("目录项").path();
            if path.is_dir() {
                rs_files(&path, out);
            } else if path.extension().map(|e| e == "rs").unwrap_or(false) {
                out.push(path);
            }
        }
    }

    /// lib.rs 里 generate_handler![...] 列出的命令名（按注册顺序）
    fn registered_commands(lib_rs: &str) -> Vec<String> {
        let start = lib_rs
            .find("generate_handler![")
            .expect("lib.rs 里找不到 generate_handler!");
        let body = &lib_rs[start + "generate_handler!".len() + 1..];
        let end = body.find("])").expect("generate_handler! 没有收尾");
        body[..end]
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(|s| s.rsplit("::").next().unwrap_or(&s).to_string())
            .collect()
    }

    /// 从 `pub [async] fn name(` 开始，按括号/花括号配对取出（签名, 函数体）
    fn extract_fn(src: &str, name: &str) -> Option<(String, String)> {
        for prefix in [
            format!("pub fn {name}("),
            format!("pub async fn {name}("),
            format!("fn {name}("),
            format!("async fn {name}("),
        ] {
            let mut at = 0usize;
            while let Some(rel) = src[at..].find(&prefix) {
                let start = at + rel;
                // 只有正处在行首的才算定义，注释与字符串里的同名串要排除
                let line_begin = src[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
                at = start + 1;
                if !src[line_begin..start].trim().is_empty() {
                    continue;
                }
                let params_start = start + prefix.len();
                let (params, used) = match_balanced(&src[params_start..], '(', ')')?;
                let after_params = params_start + used;
                let brace_at = after_params + src[after_params..].find('{')?;
                let (body, _) = match_balanced(&src[brace_at + 1..], '{', '}')?;
                return Some((params, body));
            }
        }
        None
    }

    /// 从 str 开头（配对的开括号已被调用方消费）走到配对闭合，返回内容与消费掉的长度
    fn match_balanced(str: &str, open: char, close: char) -> Option<(String, usize)> {
        let mut depth = 1usize;
        let mut out = String::new();
        for (i, ch) in str.char_indices() {
            if ch == open {
                depth += 1;
            } else if ch == close {
                depth -= 1;
                if depth == 0 {
                    return Some((out, i + 1));
                }
            }
            out.push(ch);
        }
        None
    }

    fn gated_by_capability(body: &str, file_src: &str) -> bool {
        if DIRECT.iter().any(|m| body.contains(m)) {
            return true;
        }
        WRAPPERS.iter().any(|w| {
            let name = w.trim_end_matches('(');
            body.contains(w)
                && extract_fn(file_src, name)
                    .map(|(_, helper)| {
                        helper.contains("gate::plugin_capability") || helper.contains("is_granted")
                    })
                    .unwrap_or(false)
        })
    }

    /// 主断言：注册表里每条带 plugin_id 的命令都要有门禁
    #[test]
    fn every_registered_command_with_a_plugin_id_is_gated() {
        let root = src_root();
        let mut files = Vec::new();
        rs_files(&root, &mut files);
        let sources: BTreeMap<PathBuf, String> = files
            .into_iter()
            .map(|p| {
                let text = std::fs::read_to_string(&p).expect("读文件失败");
                (p, text)
            })
            .collect();
        let lib = sources
            .get(&root.join("lib.rs"))
            .expect("找不到 lib.rs")
            .clone();

        let commands = registered_commands(&lib);
        assert!(
            commands.len() >= 40,
            "generate_handler! 只解析出 {} 条命令，解析本身大概坏了",
            commands.len()
        );

        let mut plugin_faced = 0usize;
        for name in &commands {
            let mut hit: Option<(&PathBuf, &String, (String, String))> = None;
            for (path, src) in &sources {
                if let Some(found) = extract_fn(src, name) {
                    hit = Some((path, src, found));
                    break;
                }
            }
            let Some((path, file_src, (params, body))) = hit else {
                panic!("命令 {name} 在 generate_handler! 里，但 src/ 下找不到它的定义");
            };
            if !params.contains("plugin_id") {
                continue;
            }
            plugin_faced += 1;
            if let Some((_, reason)) = WINDOW_GATED.iter().find(|(n, _)| *n == name) {
                let has_window_gate = body.contains("gate::settings")
                    || body.contains("gate::pet")
                    || body.contains("is_safe_id")
                    // 授权表自己的查询口（permission_check 走它）
                    || body.contains("check_capability")
                    || body.contains("declared_capabilities");
                assert!(
                    has_window_gate,
                    "{name} 挂在窗口门禁名单上（{reason}），函数体里却看不到那把门禁"
                );
                continue;
            }
            assert!(
                gated_by_capability(&body, file_src),
                "命令 {name}（{}）带 plugin_id 但没有能力门禁 —— 给它加 gate::plugin_capability，\
                 或说明它为什么只走窗口门禁并把它写进 WINDOW_GATED 名单",
                path.display()
            );
        }
        assert!(
            plugin_faced >= 14,
            "只找到 {plugin_faced} 条带 plugin_id 的命令，S1/S2/S3 那批门禁大概被改掉了"
        );
    }

    /// 名单不许烂在里面：列出来的命令若已不再带 plugin_id，就该从名单里删掉
    #[test]
    fn the_window_gated_list_has_no_stale_entries() {
        let root = src_root();
        let mut files = Vec::new();
        rs_files(&root, &mut files);
        for (name, reason) in WINDOW_GATED {
            let found = files
                .iter()
                .filter_map(|p| std::fs::read_to_string(p).ok().map(|s| (p, s)))
                .find_map(|(p, s)| extract_fn(&s, name).map(|f| (p, f)));
            let Some((path, (params, _))) = found else {
                panic!("WINDOW_GATED 里的 {name} 已经找不到定义了（{reason}）");
            };
            assert!(
                params.contains("plugin_id"),
                "{name}（{}）已不再带 plugin_id，应从 WINDOW_GATED 删掉（{reason}）",
                path.display()
            );
        }
    }

    #[test]
    fn the_handler_parse_covers_the_known_commands() {
        let lib = std::fs::read_to_string(src_root().join("lib.rs")).unwrap();
        let commands = registered_commands(&lib);
        for name in [
            "store_get",
            "bus_publish",
            "overlay_show",
            "overlay_reclaim",
            "ble_start_scan",
            "http_request",
            "notify_show",
        ] {
            assert!(commands.iter().any(|c| c == name), "{name} 没被解析到");
        }
        // 注释里的命令名不算：generate_handler! 的每一项都得是路径
        assert!(
            !commands.iter().any(|c| c.contains('/')),
            "解析把注释当成了命令"
        );
    }
}
