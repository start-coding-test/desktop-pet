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
            "授权表本身的申请接口，未声明的能力在这里被拒；另过 G3-01 的窗口归属（同意框不能代表插件）",
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

    /// G3-01：这些命令必须拿到调用窗，才能分辨「是插件自己的悬浮窗，还是别的窗冒用 id」。
    /// 漏一个就红 —— 签名里没有 Window 的命令，宿主只能看调用方自报的 plugin_id，
    /// 而悬浮窗正是自报 id 的唯一来源（见 gate::window_owns_plugin）。
    const MUST_TAKE_WINDOW: &[(&str, &str)] = &[
        ("http_request", "按插件逐域名授权，调用窗必须能归属到该插件"),
        ("store_get", "插件隔离存储，悬浮窗不能读别人的键"),
        ("store_set", "插件隔离存储，悬浮窗不能写别人的键"),
        ("store_delete", "插件隔离存储，悬浮窗不能删别人的键"),
        ("secrets_get", "凭据按插件隔离，悬浮窗不能读别人的凭据"),
        ("secrets_set", "凭据按插件隔离，悬浮窗不能写别人的凭据"),
        ("secrets_delete", "凭据按插件隔离，悬浮窗不能删别人的凭据"),
        ("notify_show", "系统通知以插件名义弹出，调用窗必须能归属"),
        ("ble_start_scan", "蓝牙按插件授权，调用窗必须能归属"),
        ("ble_stop_scan", "蓝牙按插件授权，调用窗必须能归属"),
        ("ble_connect", "蓝牙按插件授权，调用窗必须能归属"),
        ("ble_disconnect", "蓝牙按插件授权，调用窗必须能归属"),
        ("ble_connected_device", "蓝牙按插件授权，调用窗必须能归属"),
        ("permission_request", "同意框窗口不能代表插件申请能力"),
        ("overlay_show", "悬浮层是插件的脸面，别的窗不能替它开"),
        ("overlay_hide", "悬浮层是插件的脸面，别的窗不能替它收"),
        ("overlay_destroy", "悬浮层是插件的脸面，别的窗不能替它销毁"),
        (
            "overlay_reclaim",
            "重认领会带回本插件的悬浮层，调用窗必须能归属",
        ),
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

    /// `body` 里是否**真的调用了** `name`：注释、字符串与字符字面量里的同名串不算。
    ///
    /// 收紧前这里是 `body.contains("window_owns_plugin")`：函数体里只要有一句
    /// `// window_owns_plugin 由上层调用` 的注释，漏掉调用的命令也会假绿（t18 审计 / t25）。
    fn calls(body: &str, name: &str) -> bool {
        let code = code_only(body);
        code.contains(&format!("{name}("))
    }

    /// 只留代码骨架：`//` 行注释、`/* */` 块注释、`"…"` 字符串、`'x'` 字符字面量都剥掉。
    /// 剥字符串是为了不让错误文案里的 `"gate::plugin_capability("` 之类假命中。
    fn code_only(src: &str) -> String {
        let chars: Vec<char> = src.chars().collect();
        let mut out = String::with_capacity(src.len());
        let mut i = 0usize;
        while i < chars.len() {
            match chars[i] {
                '/' if chars.get(i + 1) == Some(&'/') => {
                    while i < chars.len() && chars[i] != '\n' {
                        i += 1;
                    }
                }
                '/' if chars.get(i + 1) == Some(&'*') => {
                    i += 2;
                    while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                        i += 1;
                    }
                    i = (i + 2).min(chars.len());
                }
                '"' => {
                    i += 1;
                    while i < chars.len() {
                        if chars[i] == '\\' {
                            i += 2;
                        } else if chars[i] == '"' {
                            i += 1;
                            break;
                        } else {
                            i += 1;
                        }
                    }
                }
                '\'' if char_literal_len(&chars, i) > 0 => i += char_literal_len(&chars, i),
                c => {
                    out.push(c);
                    i += 1;
                }
            }
        }
        out
    }

    /// `'x'` / `'\n'` / `'\''` 这类字符字面量的长度；`'a`（生命周期）返回 0，按普通代码保留。
    fn char_literal_len(chars: &[char], i: usize) -> usize {
        match (chars.get(i + 1), chars.get(i + 2)) {
            (Some('\\'), Some(_)) if chars.get(i + 3) == Some(&'\'') => 4,
            (Some(_), Some('\'')) => 3,
            _ => 0,
        }
    }

    fn gated_by_capability(body: &str, file_src: &str) -> bool {
        if DIRECT.iter().any(|m| calls(body, m)) {
            return true;
        }
        WRAPPERS.iter().any(|w| {
            let name = w.trim_end_matches('(');
            calls(body, name)
                && extract_fn(file_src, name)
                    .map(|(_, helper)| {
                        calls(&helper, "gate::plugin_capability") || calls(&helper, "is_granted")
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
                let has_window_gate = calls(&body, "gate::settings")
                    || calls(&body, "gate::pet")
                    || calls(&body, "is_safe_id")
                    // 授权表自己的查询口（permission_check 走它）
                    || calls(&body, "check_capability")
                    || calls(&body, "declared_capabilities");
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

    /// G3-01：这批插件调用面命令必须收 `Window` —— 没有调用窗就只能信插件自报的 id，
    /// 而悬浮窗正是「冒用别人 id」的唯一入口。漏一条就从这条路漏一个洞。
    #[test]
    fn plugin_facing_commands_receive_the_calling_window() {
        let root = src_root();
        let mut files = Vec::new();
        rs_files(&root, &mut files);
        for (name, reason) in MUST_TAKE_WINDOW {
            let found = files
                .iter()
                .filter_map(|p| std::fs::read_to_string(p).ok().map(|s| (p, s)))
                .find_map(|(p, s)| extract_fn(&s, name).map(|f| (p, f)));
            let Some((path, (params, _))) = found else {
                panic!("{name} 在 MUST_TAKE_WINDOW 里，但 src/ 下找不到它的定义（{reason}）");
            };
            assert!(
                params.contains("Window"),
                "{name}（{}）的签名里没有 Window —— {reason}",
                path.display()
            );
        }
    }

    /// G3-01 的另一半：门禁本身也得收 Window，否则调用方可以绕开归属校验直接查授权表。
    #[test]
    fn capability_gate_itself_takes_the_calling_window() {
        let gate = std::fs::read_to_string(src_root().join("gate.rs")).unwrap();
        let (params, body) = extract_fn(&gate, "plugin_capability")
            .expect("gate.rs 里找不到 pub fn plugin_capability");
        assert!(
            params.contains("window: &Window"),
            "gate::plugin_capability 必须收 &Window，实际参数表: {params}"
        );
        assert!(
            calls(&body, "window_owns_plugin"),
            "gate::plugin_capability 收了 Window 却没判归属"
        );
    }

    /// t25：`calls` 必须区分「真的调用」与「注释 / 字符串里提一句」。
    /// 注释里写 `// window_owns_plugin 由上层调用` 而函数体没有调用时，`calls` 必须判否。
    #[test]
    fn calls_ignores_comments_and_literals() {
        assert!(calls(
            "gate::plugin_capability(window, &perms, plugin_id, cap)?;",
            "gate::plugin_capability"
        ));
        assert!(calls("let ok = state.is_granted(id, cap);", "is_granted"));
        assert!(!calls(
            "// window_owns_plugin 由上层调用",
            "window_owns_plugin"
        ));
        assert!(!calls("/* window_owns_plugin(x) */", "window_owns_plugin"));
        assert!(!calls(
            "let hint = \"window_owns_plugin(\";",
            "window_owns_plugin"
        ));
        // 字符字面量里的引号不能吞掉同一行后面的真实调用
        assert!(calls(
            "let q = '\"'; gate::settings(window, \"改动\")?;",
            "gate::settings"
        ));
        // 字符串里的 `//` 不能把后面的代码当注释吃掉
        assert!(calls(
            "let u = \"https://example.com\"; gate::pet(window, \"x\")?;",
            "gate::pet"
        ));
    }
}
