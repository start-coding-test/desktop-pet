//! 宿主出站请求的代理选择（B10 / ADR-0011 追加节）。
//!
//! 为什么住宿主而不给插件：CSP 的 `connect-src` 只放行 `'self'` 与 `ipc:`，插件的出站本来就是
//! 宿主代发的（见 `http.rs`）；代理属于「出哪台机器」这一层，同样是宿主的事实，不能让插件选。
//!
//! 这里的解析与决策**全是纯函数**：`&[RawSource]` 进去、`Settings`/`Option<ProxySpec>` 出来，
//! 单测不碰注册表、不碰真机环境变量、不出网。只有 [`read_sources`] 依赖平台。
//!
//! 三条不退化的边界（ADR-0011 追加节逐条对齐）：
//! 1. 域名授权与逐跳重定向复核在 `http.rs`，本文件**不参与**授权判定，只决定「这一跳经不经过代理」；
//! 2. 回环 / 私网 / 本机名目标**永远直连**，优先级高于 `ProxyOverride` 与任何环境变量；
//! 3. 代理 URL 里的账号口令不进日志、错误信息或事件：`ProxySpec` 手写 `Debug`（口令打 `***`），
//!    缓存键与日志只带 `host:port` 与「有没有凭据」的布尔，[`redact`] 负责把外部错误文案洗一遍。

use std::env;
use std::fmt;

/// 一个 URL 的规范化目标。**必须**用 `Url` 解析后的主机名来判，不要拿原始字符串判：
/// `Url` 已做小写化与百分号解码，尾点与 IPv6 括号由 [`Target::from_url_str`] 统一处理。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    /// 小写、不含端口
    pub scheme: String,
    /// 小写、去括号、去尾点
    pub host: String,
    pub port: u16,
}

/// 一个可用的代理端点。`user`/`pass` 只在这里出现，任何 `Debug`/日志都不带原文。
#[derive(Clone, PartialEq, Eq)]
pub struct ProxySpec {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub pass: Option<String>,
}

/// 手写 `Debug`：凭据只报「有没有」，永不落原文（B10 行为 3）。
impl fmt::Debug for ProxySpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "ProxySpec {{ host: {:?}, port: {}, creds: {} }}",
            self.host,
            self.port,
            self.user.is_some() && self.pass.is_some()
        )
    }
}

impl ProxySpec {
    /// 缓存键：不含口令。换用户名/密码但同端点时**故意**不重建 agent 吗？不是 —— 用户名一起进键，
    /// 只是不把口令本身带进键，避免键被日志带出去时泄密。
    pub fn key(&self) -> String {
        match (&self.user, &self.pass) {
            (Some(u), Some(p)) => format!("{}:{}?u={}&p=len{}", self.host, self.port, u, p.len()),
            (Some(u), None) => format!("{}:{}?u={}", self.host, self.port, u),
            _ => format!("{}:{}", self.host, self.port),
        }
    }
    /// 给 ureq 的形态串（带 scheme，不含凭据时用不到 `@`）。
    pub fn to_url(&self) -> String {
        match (&self.user, &self.pass) {
            (Some(u), Some(p)) => format!("http://{}:{}@{}:{}", u, p, self.host, self.port),
            _ => format!("http://{}:{}", self.host, self.port),
        }
    }
    /// 会被 ureq 的报错原样带出来的几种写法，供 [`redact`] 用。
    fn fingerprints(&self) -> Vec<String> {
        let host_port = format!("{}:{}", self.host, self.port);
        let mut v = vec![host_port.clone(), self.to_url()];
        if let (Some(u), Some(p)) = (&self.user, &self.pass) {
            v.push(format!("{}:{}", u, p));
            v.push(format!("{}@{}", u, p));
            v.push(u.clone());
        }
        v
    }
}

/// 原始设置来源。注册表三项 / 环境变量三件都归到这里，好让「优先级」这件事在单测里可枚举。
#[derive(Clone, Debug, Default)]
pub enum RawSource {
    #[default]
    Empty,
    /// `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
    Registry {
        enable: Option<u32>,
        server: Option<String>,
        proxy_override: Option<String>,
    },
    Env {
        https: Option<String>,
        http: Option<String>,
        all: Option<String>,
    },
}

/// `ProxyOverride` 的一条规则。不支持的形态归 [`OverrideRule::Ignored`]（忽略该条，不影响其它条）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OverrideRule {
    /// `<local>`：本机名（无点主机名 / `localhost`）直连
    Local,
    /// `*.example.com`（也接受 `.example.com` 与 `example.com` 后缀写法）
    Suffix(String),
    /// `<-host>` / `<-*.host>`：WinINet 的「即使命中 bypass 也走代理」，优先级最高
    Force(Box<OverrideRule>),
    /// PAC 脚本地址、正则等本卡不实现的形态
    Ignored,
}

/// 给 `http.rs` 用的别名：本模块内部叫 `Settings`（就是一份设置），外面看到的意思是
/// 「系统当前的代理设置快照」。
pub type ProxySettings = Settings;

/// 解析完的系统设置：按目标 scheme 取代理，外加 bypass 规则表。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Settings {
    pub http: Option<ProxySpec>,
    pub https: Option<ProxySpec>,
    pub overrides: Vec<OverrideRule>,
}

const REG_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/// 读取顺序（行为 1）：**注册表 → `HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY` → 直连**。
/// 只取第一个「能解析出可用代理」的来源：注册表开着但值是 socks/非法，也继续往下档回落，
/// 最后一档仍没有才是直连 —— 反过来「注册表明确 `ProxyEnable=0`」是**用户意图**，
/// 不再回落到环境变量（否则在 Clash 界面里关掉总开关却仍被 shell 里的 env 拽走代理）。
pub fn parse_sources(sources: &[RawSource]) -> Settings {
    for src in sources {
        match src {
            RawSource::Registry {
                enable,
                server,
                proxy_override,
            } => {
                // ProxyEnable == 0 是**用户显式关掉**总开关：整条决策就是直连，
                // 不再往下看环境变量（否则在 Clash 界面里关掉，却仍被 shell 里的 env 拽走代理）。
                if *enable == Some(0) {
                    return Settings::default();
                }
                // enable 为 None：这台机器从没配过 IE 代理设置，**不算「关掉」**，继续往下档找
                if enable.is_none() {
                    continue;
                }
                let Some(server) = server.as_deref().filter(|s| !s.trim().is_empty()) else {
                    continue;
                };
                let (http, https) = parse_proxy_server(server);
                if http.is_none() && https.is_none() {
                    continue; // socks / 非法值：忽略并回落到下一档（ADR-0011 追加节写了理由）
                }
                return Settings {
                    http,
                    https,
                    overrides: parse_override_list(proxy_override.as_deref().unwrap_or("")),
                };
            }
            RawSource::Env { https, http, all } => {
                // 逐档取：HTTPS_PROXY → HTTP_PROXY → ALL_PROXY（大小写两版都在 read_sources 里并进来）
                for raw in [https.as_deref(), http.as_deref(), all.as_deref()] {
                    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    if let Some(spec) = parse_env_proxy(raw) {
                        return Settings {
                            https: Some(spec.clone()),
                            http: Some(spec),
                            overrides: Vec::new(),
                        };
                    }
                }
            }
            RawSource::Empty => {}
        }
    }
    Settings::default()
}

/// 注册表 `ProxyServer` 的三种形态：`host:port`、`scheme=host:port;scheme2=…`、`http://host:port`。
/// socks 条目一律忽略（返回 None），因为 `ureq` 的 `socks` feature 没开，交给它会得到
/// `InvalidProxyUrl` —— 与其报错，不如按「这个协议没有代理」办（行为 2）。
pub fn parse_proxy_server(raw: &str) -> (Option<ProxySpec>, Option<ProxySpec>) {
    let mut http = None;
    let mut https = None;
    let text = raw.trim();
    if text.is_empty() {
        return (None, None);
    }
    // 带 `=` 的是「按协议分派」的写法；分号或逗号分隔
    if text.contains('=') {
        for part in text.split([';', ',']) {
            let Some((scheme, value)) = part.split_once('=') else {
                continue;
            };
            let Some(spec) = parse_env_proxy(value) else {
                continue;
            };
            match scheme.trim().to_ascii_lowercase().as_str() {
                // 同名协议重复出现时以第一条为准（`get_or_insert` 的语义）
                "http" => {
                    http.get_or_insert(spec.clone());
                }
                "https" => {
                    https.get_or_insert(spec.clone());
                }
                // socks/socks4/socks5/ftp 等：不识别 ⇒ 忽略该条，也不回落到 http 那条上
                _ => {}
            }
        }
        (http, https)
    } else {
        match parse_env_proxy(text) {
            Some(spec) => (Some(spec.clone()), Some(spec)),
            None => (None, None),
        }
    }
}

/// 单个代理端点：允许 `http://host:port`、`host:port`、`user:pass@host:port`、`http://u:p@host:port`。
/// 只承认 HTTP CONNECT 代理；socks 前缀、无端口、端口越界、空主机都解析失败。
pub fn parse_env_proxy(raw: &str) -> Option<ProxySpec> {
    let text = raw.trim().trim_end_matches('/');
    if text.is_empty() {
        return None;
    }
    let (scheme, rest) = match text.split_once("://") {
        Some((s, rest)) => (Some(s.to_ascii_lowercase()), rest),
        None => (None, text),
    };
    if let Some(s) = &scheme {
        if s != "http" {
            return None; // socks/socks5/https 代理等：本卡不支持，忽略
        }
    }
    // 凭据用 rsplitn 取最后一个 `@`，主机名里合法出现 `@` 的极端形态按「凭据」处理（WinINet 也这么判）
    let (creds, host_port) = match rest.rsplit_once('@') {
        Some((creds, hp)) => (Some(creds), hp),
        None => (None, rest),
    };
    if host_port.is_empty() {
        return None;
    }
    let (host, port) = split_host_port(host_port)?;
    if host.is_empty() || !valid_proxy_host(&host) {
        return None;
    }
    let (user, pass) = match creds {
        Some(c) => {
            let (u, p) = c.split_once(':')?;
            if u.is_empty() {
                return None;
            }
            (Some(u.to_string()), Some(p.to_string()))
        }
        None => (None, None),
    };
    Some(ProxySpec {
        host: host.to_ascii_lowercase(),
        port,
        user,
        pass,
    })
}

fn split_host_port(text: &str) -> Option<(String, u16)> {
    if let Some(inner) = text.strip_prefix('[') {
        let (v6, port) = inner.split_once("]:")?;
        let port: u16 = port.parse().ok()?;
        return Some((format!("[{v6}]"), port));
    }
    let mut parts = text.rsplitn(2, ':');
    let port: u16 = parts.next()?.parse().ok()?;
    let host = parts.next()?;
    let host = host.trim_end_matches('.');
    if port == 0 {
        return None;
    }
    Some((host.to_ascii_lowercase(), port))
}

fn valid_proxy_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']');
    !h.is_empty()
        && !h
            .chars()
            .any(|c| matches!(c, ' ' | '/' | '\\' | ';' | ',' | '='))
}

/// `ProxyOverride`：`;` 分隔。支持 `<local>`、`*.x`/`.x`/`x`、`<-…>` 强制项；
/// `<SCRIPT>`、URL、含正则形态的一律 `Ignored`（不影响其它规则）。
pub fn parse_override_list(raw: &str) -> Vec<OverrideRule> {
    let mut out = Vec::new();
    for item in raw.split(';') {
        let entry = item.trim();
        if entry.is_empty() {
            continue;
        }
        out.push(parse_override_entry(entry));
    }
    out
}

fn parse_override_entry(entry: &str) -> OverrideRule {
    if let Some(inner) = entry.strip_prefix("<-").and_then(|s| s.strip_suffix('>')) {
        let inner = inner.trim();
        if inner.is_empty() {
            return OverrideRule::Ignored;
        }
        return OverrideRule::Force(Box::new(parse_override_entry(inner)));
    }
    if entry.eq_ignore_ascii_case("<local>") {
        return OverrideRule::Local;
    }
    // PAC 脚本引用与其它 <> 形态：忽略这一条
    if entry.starts_with('<')
        || entry.contains('/')
        || entry.contains(':')
        || (entry.contains('*') && !entry.starts_with('*'))
    {
        return OverrideRule::Ignored;
    }
    let pattern = entry.trim_start_matches('.').trim_start_matches("*.");
    if pattern.is_empty() {
        return OverrideRule::Ignored;
    }
    OverrideRule::Suffix(pattern.to_ascii_lowercase())
}

impl Settings {
    /// **某一跳该走哪一档代理**：`Some("http")` / `Some("https")` / `None`（直连）。
    /// 重定向的每一跳都要重新问这里（公网 → 内网的重定向不许沿用上一跳的路线）；
    /// `http.rs::Route::agent_for` 与下面的单测共用这一个入口，判定只允许有一处实现。
    /// 解析不出来的目标按直连 —— 代理是把流量交给第三方进程的那一侧，判不明白时不该选它。
    pub fn proxy_scheme_for(&self, url: &str) -> Option<&'static str> {
        let target = Target::from_url_str(url)?;
        self.proxy_for(&target)?;
        Some(if target.scheme == "https" {
            "https"
        } else {
            "http"
        })
    }

    /// 这一跳要不要走代理。顺序：**私网/本机第一道否决 → scheme 取代理 → bypass 规则**。
    pub fn proxy_for(&self, target: &Target) -> Option<ProxySpec> {
        if is_local_or_private(target) {
            return None;
        }
        let spec = match target.scheme.as_str() {
            "https" => self.https.clone(),
            _ => self.http.clone(),
        }?;
        // Force 优先于任何 bypass；没有命中规则时默认走代理
        for rule in &self.overrides {
            if matches!(rule, OverrideRule::Force(inner) if bypass_matches(inner, target)) {
                return Some(spec);
            }
        }
        for rule in &self.overrides {
            if !matches!(rule, OverrideRule::Force(_)) && bypass_matches(rule, target) {
                return None;
            }
        }
        Some(spec)
    }
}

fn bypass_matches(rule: &OverrideRule, target: &Target) -> bool {
    match rule {
        OverrideRule::Local => target.is_machine_local(),
        OverrideRule::Suffix(pattern) => {
            target.host.eq_ignore_ascii_case(pattern)
                || target.host.ends_with(&format!(".{pattern}"))
        }
        // Force 由 proxy_for 单独处理；Ignored 永不匹配
        OverrideRule::Force(_) | OverrideRule::Ignored => false,
    }
}

impl Target {
    /// 从 URL 字符串构造。解析失败返回 None（调用方按「直连」处理，绝不因为读不懂就换个走法）。
    pub fn from_url_str(url: &str) -> Option<Target> {
        let parsed = tauri::Url::parse(url).ok()?;
        let scheme = parsed.scheme().to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return None;
        }
        let host = parsed.host_str()?.to_ascii_lowercase();
        // `Url` 已去百分号与 IPv6 括号；尾点是唯一还需手工去的东西（`localhost.` 与 `localhost` 同机）
        let host = host.trim_end_matches('.').to_string();
        let port = parsed.port_or_known_default()?;
        Some(Target { scheme, host, port })
    }
    /// 「本机」判定：`localhost`、无点主机名（WinINet `<local>` 的口径），以及 mDNS 的 `.local`
    /// —— 后者靠组播解析，交给任何 HTTP 代理都连不通，功能上就必须直连（不是安全判断，是可用性判断）。
    pub fn is_machine_local(&self) -> bool {
        // 「无点主机名」这条不能吞掉 IPv6 字面量：`::1`、`2606:…` 都没有点，但不是「本机名」，
        // 它们的内/外网判定走 ipv6_form（那里才分得出回环与公网）。
        self.host == "localhost"
            || self.host.ends_with(".local")
            || (!self.host.contains('.') && !self.host.contains(':'))
    }
}

/// 回环 / 私网 / 链路本地 / 运营商 NAT / 未指定地址 —— **永远直连**，优先于一切代理设置。
/// 覆盖字面 IP 与本机名；解析到内网 IP 的公网域名由出站解析守卫逐次拒
/// （`services::http` 的 `GuardedResolver`，G3-03；申报口径见 ADR-0011 追加节）。
pub fn is_local_or_private(target: &Target) -> bool {
    let host = target.host.trim_start_matches('[').trim_end_matches(']');
    // 本机名走同一个判定函数，别让「`<local>` 的口径」与「第一道否决的口径」有两份实现
    if target.is_machine_local() {
        return true;
    }
    if let Some(v4) = ipv4(host) {
        return is_private_v4(v4);
    }
    if let Some(v6) = ipv6_form(host) {
        return v6;
    }
    false
}

/// 解析出来的这条地址能不能连（G3-03）：与 `is_local_or_private` 同一份口径，
/// 只是输入换成「已经解析出的 IP」。出站解析器每次解析都过它 ——
/// 「第一次解析到公网、复解到内网」的 DNS rebinding 在连出去之前就被拒。
pub fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => !is_private_v4(v4.octets()),
        // IPv4-mapped 折回 v4 判（`::ffff:127.0.0.1` 不能因为「是 v6」就放行）
        std::net::IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => !is_private_v4(v4.octets()),
            None => !ipv6_form(&v6.to_string()).unwrap_or(false),
        },
    }
}

/// 回环字面量（G3-03 分档用）：`127.0.0.0/8`、`::1`，以及 IPv4-mapped 的回环写法
/// （`::ffff:127.0.0.1`、`::ffff:7f00:1`）。只认「写死在 URL 里、解析不经过 DNS」的形态；
/// `localhost` 这类本机名由调用方另判（`services::http` 的 `is_stable_local_target`）。
pub fn is_loopback_literal(host: &str) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    if let Some([127, ..]) = ipv4(host) {
        return true;
    }
    let lower = host.to_ascii_lowercase();
    lower == "::1"
        || lower == "0:0:0:0:0:0:0:1"
        || mapped_v4(&lower).is_some_and(|v| v[0] == 127)
}

/// 点分四段（含前导零宽松解析失败即不认）才返回；主机名不是 IP 时返回 None。
fn ipv4(host: &str) -> Option<[u8; 4]> {
    let mut it = host.split('.');
    let mut out = [0u8; 4];
    for slot in out.iter_mut() {
        let part = it.next()?;
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse::<u8>().ok()?;
    }
    if it.next().is_some() {
        return None;
    }
    Some(out)
}

fn is_private_v4(v: [u8; 4]) -> bool {
    let [a, b, ..] = v;
    a == 0                    // 0.0.0.0/8「本网络」
        || a == 10              // 私网
        || a == 127             // 回环
        || (a == 100 && (b & 0xc0) == 64) // 100.64.0.0/10 运营商级 NAT
        || (a == 169 && b == 254)         // 链路本地（含云元数据 169.254.169.254）
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && v[2] == 0) // 192.0.0.0/24 IETF 协议分配
        || (a == 198 && (b == 18 || b == 19)) // 基准测试
        || a >= 224 // 组播 / 保留（224.0.0.0/4 起）
}

/// IPv6 字面量里属于「本机/内网」的那几类，并把 IPv4-mapped 形态折回 IPv4 判断。
fn ipv6_form(host: &str) -> Option<bool> {
    if !host.contains(':') {
        return None;
    }
    let h = host.to_ascii_lowercase();
    if h == "::" || h == "::1" || h == "0:0:0:0:0:0:0:1" || h == "0:0:0:0:0:0:0:0" {
        return Some(true);
    }
    // fc00::/7 唯一本地、fe80::/10 链路本地
    if let Some(first) = h.split(':').next() {
        if first.starts_with("fc")
            || first.starts_with("fd")
            || first.starts_with("fe8")
            || first.starts_with("feb")
        {
            return Some(true);
        }
    }
    if let Some(mapped) = mapped_v4(&h) {
        return Some(is_private_v4(mapped));
    }
    Some(false)
}

/// `::ffff:127.0.0.1`、`::ffff:7f00:1`、`64:ff9b::…` 之外的映射形态都在这两种写法里。
fn mapped_v4(h: &str) -> Option<[u8; 4]> {
    for prefix in ["::ffff:", "0:0:0:0:0:ffff:"] {
        if let Some(rest) = h.strip_prefix(prefix) {
            if let Some(v4) = ipv4(rest) {
                return Some(v4);
            }
            // 十六进制两段的写法：::ffff:7f00:1 ⇒ 127.0.0.1
            let mut parts = rest.split(':');
            let hi = u16::from_str_radix(parts.next()?, 16).ok()?;
            let lo = u16::from_str_radix(parts.next()?, 16).ok()?;
            if parts.next().is_some() {
                return None;
            }
            return Some([
                (hi >> 8) as u8,
                (hi & 0xff) as u8,
                (lo >> 8) as u8,
                (lo & 0xff) as u8,
            ]);
        }
    }
    None
}

/// 外部错误文案脱敏：把代理端点、带凭据的完整 URL、用户名与口令原文统统换成 `[proxy]`。
/// 只做「已知敏感串替换」，不改写其它内容 —— `http.rs` 里那条既有的 `请求失败: {e}` 因此可以照旧返回。
pub fn redact(text: &str, settings: &Settings) -> String {
    let mut out = text.to_string();
    let mut needles: Vec<String> = Vec::new();
    for spec in [settings.http.as_ref(), settings.https.as_ref()]
        .into_iter()
        .flatten()
    {
        needles.extend(spec.fingerprints());
    }
    // 长的先替换，避免短串先命中后剩下半截地址
    needles.sort_by_key(|n| std::cmp::Reverse(n.len()));
    for needle in needles {
        if !out.contains(&needle) {
            continue;
        }
        out = out.replace(&needle, "[proxy]");
    }
    out
}

/// 平台相关的读取：Windows 走 HKCU 的 Internet Settings，非 Windows 只有环境变量。
/// 每个值都取不到就是 `None` —— 读失败**绝不**当成「关掉了代理」，也绝不 panic。
pub fn read_sources() -> Vec<RawSource> {
    let mut sources = Vec::new();
    #[cfg(windows)]
    if let Some(registry) = read_registry() {
        sources.push(registry);
    }
    sources.push(RawSource::Env {
        https: first_env(["HTTPS_PROXY", "https_proxy"]),
        http: first_env(["HTTP_PROXY", "http_proxy"]),
        all: first_env(["ALL_PROXY", "all_proxy"]),
    });
    sources
}

fn first_env<K: AsRef<[&'static str]>>(keys: K) -> Option<String> {
    keys.as_ref()
        .iter()
        .filter_map(|k| env::var(k).ok())
        .find(|v| !v.trim().is_empty())
}

/// 每次请求都问一次（行为 4）。`Err` 只在完全读不到时返回，调用方按直连处理。
pub fn current_settings() -> Settings {
    parse_sources(&read_sources())
}

#[cfg(windows)]
fn read_registry() -> Option<RawSource> {
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::WIN32_ERROR;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };

    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let key = wide(REG_PATH);
    unsafe {
        let enable = {
            let name = wide("ProxyEnable");
            let mut value: u32 = 0;
            let mut size = std::mem::size_of::<u32>() as u32;
            let code = RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut c_void),
                Some(&mut size),
            );
            if code == WIN32_ERROR(0) {
                Some(value)
            } else {
                None
            }
        };
        let string_of = |name_str: &str| -> Option<String> {
            let name = wide(name_str);
            let mut size = 0u32;
            let probe = RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut size),
            );
            if probe != WIN32_ERROR(0) || size <= 2 {
                return None;
            }
            let mut buf = vec![0u16; (size as usize) / 2 + 1];
            let mut actual = size;
            let read = RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut c_void),
                Some(&mut actual),
            );
            if read != WIN32_ERROR(0) {
                return None;
            }
            let used = (actual as usize / 2).saturating_sub(1).min(buf.len());
            Some(String::from_utf16_lossy(&buf[..used]))
        };
        Some(RawSource::Registry {
            enable,
            server: string_of("ProxyServer"),
            proxy_override: string_of("ProxyOverride"),
        })
    }
}

#[cfg(not(windows))]
fn read_registry() -> Option<RawSource> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(url: &str) -> Target {
        Target::from_url_str(url).expect("测试用的 URL 必须能解析")
    }

    fn reg(enable: Option<u32>, server: Option<&str>, over: Option<&str>) -> RawSource {
        RawSource::Registry {
            enable,
            server: server.map(str::to_string),
            proxy_override: over.map(str::to_string),
        }
    }

    fn envs(https: Option<&str>, http: Option<&str>, all: Option<&str>) -> RawSource {
        RawSource::Env {
            https: https.map(str::to_string),
            http: http.map(str::to_string),
            all: all.map(str::to_string),
        }
    }

    /// 行为 1：注册表开着就用它，且不看环境变量
    #[test]
    fn registry_takes_priority_over_env_when_enabled() {
        let s = parse_sources(&[
            reg(Some(1), Some("127.0.0.1:7897"), None),
            envs(Some("http://127.0.0.1:9"), None, None),
        ]);
        assert_eq!(s.http.as_ref().map(|p| p.port), Some(7897));
        assert_eq!(s.https.as_ref().map(|p| p.port), Some(7897));
    }

    /// 行为 1：`ProxyEnable=0` 是用户意图 —— 即使 ProxyServer 有值也不走代理，
    /// 且**不回落**到环境变量（变异 MB1 的反向面：把这条删了就会从这里红）
    #[test]
    fn proxy_enable_zero_means_direct_even_with_server_and_env() {
        let s = parse_sources(&[
            reg(Some(0), Some("127.0.0.1:7897"), None),
            envs(Some("127.0.0.1:8888"), None, None),
        ]);
        assert_eq!(s, Settings::default(), "关掉总开关却仍解析出了代理: {s:?}");
        assert_eq!(s.http, None);
    }

    /// 注册表里没有 ProxyEnable（从没配过）⇒ 不算「关掉」，继续往下档回落
    #[test]
    fn missing_enable_falls_through_to_env() {
        let s = parse_sources(&[
            reg(None, Some("127.0.0.1:7897"), None),
            envs(Some("127.0.0.1:8888"), None, None),
        ]);
        assert_eq!(s.http.as_ref().map(|p| p.port), Some(8888));
    }

    /// 行为 1：环境变量三档的先后次序（HTTPS_PROXY 优先，且各档只取第一个能解析的）
    #[test]
    fn env_priority_is_https_then_http_then_all() {
        let s = parse_sources(&[envs(
            Some("127.0.0.1:1"),
            Some("127.0.0.1:2"),
            Some("127.0.0.1:3"),
        )]);
        assert_eq!(s.https.as_ref().unwrap().port, 1);
        let s = parse_sources(&[envs(
            Some("socks5://127.0.0.1:1"),
            Some("127.0.0.1:2"),
            None,
        )]);
        assert_eq!(
            s.https.as_ref().unwrap().port,
            2,
            "非法/不支持的第一档必须继续往下找"
        );
        assert!(parse_sources(&[envs(None, None, None)]).http.is_none());
    }

    /// 行为 2：`host:port` 形态
    #[test]
    fn parses_bare_host_port() {
        let spec = parse_env_proxy("127.0.0.1:7897").unwrap();
        assert_eq!((spec.host.as_str(), spec.port), ("127.0.0.1", 7897));
        assert_eq!(spec.user, None);
    }

    /// 行为 2：按协议分派 `http=a;https=b`，各 scheme 用自己的那条
    #[test]
    fn parses_named_pairs_per_scheme() {
        let (http, https) = parse_proxy_server("http=10.0.0.1:8080;https=10.0.0.2:8443");
        assert_eq!(http.unwrap().port, 8080);
        assert_eq!(https.unwrap().port, 8443);
        // 只有一个协议的条目时，另一个协议**不许**借用它
        let (http, https) = parse_proxy_server("https=10.0.0.2:8443");
        assert!(http.is_none());
        assert_eq!(https.unwrap().port, 8443);
    }

    /// 行为 2：带 scheme 与尾斜杠
    #[test]
    fn parses_scheme_prefixed_and_trailing_slash() {
        for raw in ["http://proxy.corp:3128", "http://proxy.corp:3128/"] {
            let spec = parse_env_proxy(raw).unwrap();
            assert_eq!(
                (spec.host.as_str(), spec.port),
                ("proxy.corp", 3128),
                "{raw}"
            );
        }
    }

    /// 行为 2：socks 条目忽略并回退直连（`ureq` 没开 socks feature）
    #[test]
    fn socks_entries_are_ignored_and_fall_back_to_direct() {
        assert!(parse_env_proxy("socks5://127.0.0.1:1080").is_none());
        assert!(parse_env_proxy("socks=127.0.0.1:1080").is_none());
        let (http, https) = parse_proxy_server("socks=127.0.0.1:1080;socks5=127.0.0.1:1081");
        assert!(http.is_none() && https.is_none());
        let s = parse_sources(&[reg(Some(1), Some("socks=127.0.0.1:1080"), None)]);
        assert_eq!(
            s.proxy_for(&target("https://api.example.com/")),
            None,
            "socks 不该被当成 http 代理用"
        );
    }

    /// 行为 2：空值与非法值一律不 panic、不产出半截代理
    #[test]
    fn empty_and_malformed_inputs_never_yield_a_partial_proxy() {
        for bad in [
            "",
            "   ",
            "=",
            "=http",
            "http=",
            "host:",
            ":3128",
            "127.0.0.1:notaport",
            "127.0.0.1:70000",
            "127.0.0.1:0",
            "://x",
            "http://",
            "@127.0.0.1:8080",
            "a b:80",
            "127.0.0.1:8080/path",
        ] {
            assert!(
                parse_env_proxy(bad).is_none(),
                "非法值被当成可用代理: {bad:?}"
            );
        }
        assert_eq!(parse_proxy_server(""), (None, None));
        assert!(parse_override_list("").is_empty());
    }

    /// 行为 2 + 3：凭据形态能解析，但 `Debug`/键/URL 都不带口令原文
    #[test]
    fn credentials_parse_but_never_appear_in_debug_or_key() {
        let spec = parse_env_proxy("http://john:s3cr3t@proxy.corp:3128").unwrap();
        assert_eq!(spec.user.as_deref(), Some("john"));
        let dbg = format!("{spec:?}");
        assert!(!dbg.contains("s3cr3t"), "Debug 泄露口令: {dbg}");
        assert!(
            !spec.key().contains("s3cr3t"),
            "缓存键泄露口令: {}",
            spec.key()
        );
        assert!(
            spec.to_url().contains("s3cr3t"),
            "给 ureq 的 URL 当然要带凭据"
        );
    }

    /// 行为 2：`ProxyOverride` 的三种支持形态 + 强制项优先
    #[test]
    fn override_list_handles_local_suffix_and_force() {
        let rules = parse_override_list("<local>;*.example.com;internal.corp;<-.bypass.me>");
        assert!(matches!(rules[0], OverrideRule::Local));
        assert_eq!(rules[1], OverrideRule::Suffix("example.com".into()));
        assert_eq!(rules[2], OverrideRule::Suffix("internal.corp".into()));
        assert!(
            matches!(&rules[3], OverrideRule::Force(inner) if **inner == OverrideRule::Suffix("bypass.me".into()))
        );
        // 不支持的形态只忽略自己，不牵连其它条
        let rules = parse_override_list("<- ; <SCRIPT src=\"http://a/pac\">;*.ok");
        assert_eq!(rules.len(), 3);
        assert_eq!(rules[2], OverrideRule::Suffix("ok".into()));
    }

    /// 行为 3：`<local>` 命中本机名与无点主机名
    #[test]
    fn local_rule_bypasses_for_machine_names() {
        let s = Settings {
            http: Some(parse_env_proxy("127.0.0.1:7897").unwrap()),
            https: Some(parse_env_proxy("127.0.0.1:7897").unwrap()),
            overrides: parse_override_list("<local>"),
        };
        assert!(
            s.proxy_for(&target("http://intranet/x")).is_none(),
            "无点主机名应视为本机"
        );
        assert!(s.proxy_for(&target("http://localhost:1420/y")).is_none());
        assert!(s.proxy_for(&target("https://api.example.com/")).is_some());
    }

    /// 行为 3：后缀/通配命中走直连，`<-` 强制项压过 bypass
    #[test]
    fn suffix_bypass_and_force_precedence() {
        let base = || Settings {
            http: Some(parse_env_proxy("127.0.0.1:7897").unwrap()),
            https: Some(parse_env_proxy("127.0.0.1:7897").unwrap()),
            overrides: parse_override_list("*.example.com"),
        };
        assert!(base()
            .proxy_for(&target("https://a.example.com/x"))
            .is_none());
        assert!(base().proxy_for(&target("https://example.com/x")).is_none());
        assert!(
            base()
                .proxy_for(&target("https://notexample.com/x"))
                .is_some(),
            "后缀匹配不许吃子串"
        );
        let forced = Settings {
            overrides: parse_override_list("*.example.com;<-forced.example.com>"),
            ..base()
        };
        assert!(
            forced
                .proxy_for(&target("https://forced.example.com/"))
                .is_some(),
            "`<-` 强制项被 bypass 盖掉了"
        );
    }

    /// 行为 3（第一道否决）：回环、本机（含 mDNS `.local`）、各类私网/保留地址**永不**走代理，且压过 `<-` 强制项
    #[test]
    fn loopback_and_private_never_use_proxy() {
        let s = Settings {
            http: Some(parse_env_proxy("127.0.0.1:7897").unwrap()),
            https: Some(parse_env_proxy("127.0.0.1:7897").unwrap()),
            overrides: parse_override_list("<-127.0.0.1;<-192.168.1.1"),
        };
        for url in [
            "http://localhost:1420/src/index.html",
            "http://localhost./x",
            "http://127.0.0.1:9/",
            "http://127.5.5.5/",
            "http://10.1.2.3/",
            "http://172.16.0.9/",
            "http://192.168.4.4/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.7/",
            "http://0.0.0.0/",
            "http://[::1]:8080/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:7f00:1]/",
            "http://[fd00::21]/",
            "http://[fe80::1]/",
            "http://printer.local/x",
        ] {
            let t = target(url);
            assert!(
                is_local_or_private(&t),
                "{url} 被判成公网地址（host={})",
                t.host
            );
            assert!(s.proxy_for(&t).is_none(), "{url} 走了代理：第一道否决失效");
        }
    }

    /// 反向对照：公网地址必须走代理（否则上面那条「永不走代理」可以靠「全部否决」蒙过测试）
    #[test]
    fn public_hosts_do_use_the_proxy() {
        let s = Settings {
            http: Some(parse_env_proxy("127.0.0.1:7897").unwrap()),
            https: Some(parse_env_proxy("127.0.0.1:7897").unwrap()),
            overrides: Vec::new(),
        };
        for url in [
            "https://example.com/",
            "http://1.1.1.1/",
            "https://sub.domain.example.cn/p",
        ] {
            assert!(s.proxy_for(&target(url)).is_some(), "{url} 没走代理");
        }
        // 非映射的普通 IPv6 公网地址也算公网
        assert!(!is_local_or_private(&target(
            "http://[2606:4700:4700::1111]/"
        )));
    }

    /// 目标 scheme 决定用哪条代理（`http=` 与 `https=` 分开时不能串用）
    #[test]
    fn scheme_picks_the_matching_entry() {
        let s = parse_sources(&[reg(
            Some(1),
            Some("http=10.0.0.1:80;https=10.0.0.2:443"),
            None,
        )]);
        assert_eq!(s.proxy_for(&target("http://a.example/")).unwrap().port, 80);
        assert_eq!(
            s.proxy_for(&target("https://a.example/")).unwrap().port,
            443
        );
    }

    /// 行为 3（脱敏）：外部错误文案里的端点、完整 URL、用户名与口令都不留原文
    #[test]
    fn redact_removes_proxy_endpoint_and_credentials_from_messages() {
        let s = parse_sources(&[envs(Some("http://john:s3cr3t@proxy.corp:3128"), None, None)]);
        let raw = "请求失败: Connecting to http://john:s3cr3t@proxy.corp:3128 failed: Connection refused (os error 10061)";
        let out = redact(raw, &s);
        for leak in ["s3cr3t", "john:s3cr3t", "proxy.corp:3128", "john@proxy"] {
            assert!(!out.contains(leak), "脱敏失败，残留 {leak:?}：{out}");
        }
        assert!(out.contains("[proxy]"), "脱敏后应留下占位符：{out}");
        // 没有代理设置时原文照旧，不做无谓改写
        assert_eq!(redact("boom", &Settings::default()), "boom");
    }

    /// 解析不出/读不到时的兜底：`Target` 解析失败按直连处理，不 panic、不换走法
    #[test]
    fn unreadable_targets_are_treated_as_direct() {
        assert!(Target::from_url_str("not a url").is_none());
        assert!(Target::from_url_str("file:///C:/Windows/win.ini").is_none());
        // 端口越界时 Url 会拒绝；万一接受了，也必须被第一道否决挡住
        if let Some(t) = Target::from_url_str("http://127.0.0.1:99999/") {
            assert!(is_local_or_private(&t));
        }
        let s = Settings::default();
        assert_eq!(
            s.proxy_for(&target("https://example.com/")),
            None,
            "没代理却返回了代理"
        );
    }

    /// 端口规范化：默认端口不写进 URL 也要能判（授权键的口径见 http.rs 的 host_key）
    #[test]
    fn target_port_normalizes_defaults() {
        assert_eq!(target("https://example.com/").port, 443);
        assert_eq!(target("http://example.com/").port, 80);
        assert_eq!(target("http://127.0.0.1:9/").port, 9);
        assert_eq!(target("http://LocalHost.:8080/x").host, "localhost");
    }

    /// Windows 注册表读取：只钉「不 panic、返回结构合法」——**不**断言这台机器的真实代理状态
    #[cfg(windows)]
    #[test]
    fn registry_reader_never_panics_or_invents_a_proxy() {
        let src = read_registry().expect("HKCU 的 Internet Settings 一定读得到一项（哪怕是空）");
        match src.clone() {
            RawSource::Registry {
                enable,
                server,
                proxy_override,
            } => {
                // 读不到 ProxyEnable 是合法的（从没动过 IE 设置的账户），但绝不能凭空造出端点
                if enable.unwrap_or(0) == 0 {
                    let s = parse_sources(std::slice::from_ref(&src));
                    assert_eq!(
                        s,
                        Settings::default(),
                        "ProxyEnable 不为 1 却解析出了代理: {s:?}"
                    );
                }
                let _ = (server.map(|v| v.len()), proxy_override.map(|v| v.len()));
            }
            _ => panic!("read_registry 返回了非注册表来源"),
        }
    }

    /// 每跳重新决定：公网首跳走代理，它 302 到回环 / 私网时那一跳必须换回直连
    #[test]
    fn each_redirect_hop_is_decided_on_its_own_target() {
        let s = parse_sources(&[reg(Some(1), Some("127.0.0.1:7897"), None)]);
        assert!(
            s.proxy_scheme_for("https://api.example.com/").is_some(),
            "首跳就该走代理"
        );
        for hop in [
            "http://127.0.0.1:9/",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.5/internal",
            "http://localhost:1420/redirected",
        ] {
            assert!(
                s.proxy_scheme_for(hop).is_none(),
                "{hop} 这一跳沿用了上一跳的代理路线"
            );
        }
        // 解析不出来的目标按直连（不把流量交给第三方进程才是保守的一侧）
        assert!(
            s.proxy_scheme_for("not a url").is_none(),
            "解析不出目标却走了代理"
        );
    }

    /// scheme 不同 ⇒ 该跳用各自的代理端点（`http=a;https=b` 时不许串）
    #[test]
    fn hops_pick_scheme_specific_proxy() {
        let s = parse_sources(&[reg(
            Some(1),
            Some("http=10.1.0.1:8080;https=10.2.0.2:8443"),
            None,
        )]);
        let http_target = target("http://api.example.com/");
        let https_target = target("https://api.example.com/");
        assert_eq!(s.proxy_for(&http_target).unwrap().port, 8080);
        assert_eq!(s.proxy_for(&https_target).unwrap().port, 8443);
    }

    /// 全链路口径：注册表开着 + 目标公网 ⇒ 走代理；目标回环 ⇒ 直连。这是 B10 的行为 1+3 的合体钉子
    #[test]
    fn end_to_end_decision_from_registry_to_route() {
        let s = parse_sources(&[reg(
            Some(1),
            Some("127.0.0.1:7897"),
            Some("<local>;*.internal"),
        )]);
        assert_eq!(
            s.proxy_for(&target("https://api.goat.example/v1"))
                .unwrap()
                .key(),
            "127.0.0.1:7897"
        );
        assert!(s.proxy_for(&target("https://repo.internal/")).is_none());
        assert!(s.proxy_for(&target("http://127.0.0.1:1420/")).is_none());
    }

    /// G3-03 分档用的回环字面量判定：v4/v6/mapped 都认，公网与私网都不算
    #[test]
    fn loopback_literal_covers_v4_v6_and_mapped_forms() {
        for host in [
            "127.0.0.1",
            "127.255.0.9",
            "[::1]",
            "::1",
            "0:0:0:0:0:0:0:1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
        ] {
            assert!(is_loopback_literal(host), "{host} 是回环字面量");
        }
        for host in [
            "127.0.0.1.example.com",
            "example.com",
            "10.0.0.1",
            "8.8.8.8",
            "::",
            "fe80::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!is_loopback_literal(host), "{host} 不是回环字面量");
        }
    }
}
