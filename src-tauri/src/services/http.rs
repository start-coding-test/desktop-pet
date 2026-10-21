use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::http_proxy::{self, ProxySettings};
use super::permission::PermissionState;
use crate::host_error::{HostError, DENIED, INTERNAL, INVALID_ARG, NETWORK, PARSE};

/// 出站 HTTP 代理。
///
/// 为什么必须由宿主代发：CSP 的 connect-src 只放行 'self' 与 ipc:，插件在 webview 里
/// 直连外域本来就走不通；同时按「插件 × 域名」逐个授权，才不会出现某个插件声明了
/// http 就能访问任意主机（含内网与云元数据端点）。
///
/// 系统代理（B10）：`ureq` 2.12 的代理只能建在 `Agent` 上（请求级没有 proxy 参数），
/// 而「回环/私网目标永不走代理」必须按**目标**判 ⇒ 只能两个 agent 并存、按跳选路。
pub struct HttpState {
    direct: OnceLock<ureq::Agent>,
    /// 设置快照 + 走代理的那个 agent。锁只在取快照与克隆 agent 时持有，**不跨网络请求**。
    proxy: Mutex<Option<CachedSettings>>,
}

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY_BYTES: usize = 1 << 20; // 1 MiB：防止某个大响应吃掉内存
/// 重定向由我们自己逐跳跟：ureq 自动跟的话只校验首跳域名，
/// 拿到一个已授权域名的插件就能弹到任意主机（内网、169.254.169.254）
const MAX_REDIRECTS: usize = 5;
/// 每次请求都问一次系统代理（行为 4：用户开关 Clash 不用重启宿主）。
/// TTL 只是「同一个瞬间的并发请求不必各读一遍注册表」的合并窗口，不是缓存陈旧的上限。
const PROXY_TTL: Duration = Duration::from_secs(5);

/// 一次请求的路由视图：拿完之后与 `HttpState` 再无关系（agent 是 `Arc` 包底的廉价克隆）。
/// http 与 https 各一个代理 agent：注册表的 `ProxyServer` 可以按协议给两个不同端点
/// （`http=a:80;https=b:443`），只建一份就会把 https 塞进 http 那条代理里。
pub struct Route {
    direct: ureq::Agent,
    proxied_http: Option<ureq::Agent>,
    proxied_https: Option<ureq::Agent>,
    settings: ProxySettings,
}

struct CachedSettings {
    fetched_at: Instant,
    settings: ProxySettings,
    http_key: Option<String>,
    https_key: Option<String>,
    http_agent: Option<ureq::Agent>,
    https_agent: Option<ureq::Agent>,
}

#[derive(Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
    pub truncated: bool,
}

/// `redirects(0)` 与三个 timeout 是两个 agent 共用的口径 —— 走代理**不许**顺带把
/// 「宿主自己跟重定向并逐跳复核授权」这条改成 ureq 自动跟。
fn build_agent(proxy: Option<&str>) -> ureq::Agent {
    let builder = ureq::AgentBuilder::new()
        .timeout_connect(TIMEOUT)
        .timeout_read(TIMEOUT)
        .timeout_write(TIMEOUT)
        // 0 = 不自动跟重定向，3xx 原样返回给 send_following_redirects 逐跳复核域名
        .redirects(0);
    match proxy.and_then(|url| ureq::Proxy::new(url).ok()) {
        Some(p) => builder.proxy(p),
        None => builder,
    }
    .build()
}

impl HttpState {
    pub fn new() -> Self {
        Self {
            direct: OnceLock::new(),
            proxy: Mutex::new(None),
        }
    }

    fn direct(&self) -> ureq::Agent {
        self.direct.get_or_init(|| build_agent(None)).clone()
    }

    /// 取一份本次请求用的路由：TTL 内复用快照，否则重读注册表 + 环境变量。
    fn route(&self) -> Route {
        let direct = self.direct();
        let mut guard = self.proxy.lock().unwrap_or_else(|p| p.into_inner());
        let fresh = guard
            .as_ref()
            .is_some_and(|c| c.fetched_at.elapsed() < PROXY_TTL);
        if !fresh {
            let settings = http_proxy::current_settings();
            let previous = guard.take();
            *guard = Some(CachedSettings {
                fetched_at: Instant::now(),
                http_agent: refresh_agent(
                    previous.as_ref().map(|c| (&c.http_key, &c.http_agent)),
                    settings.http.as_ref(),
                ),
                https_agent: refresh_agent(
                    previous.as_ref().map(|c| (&c.https_key, &c.https_agent)),
                    settings.https.as_ref(),
                ),
                http_key: settings.http.as_ref().map(|s| s.key()),
                https_key: settings.https.as_ref().map(|s| s.key()),
                settings,
            });
        }
        let cached = guard.as_ref().expect("上面刚写过");
        Route {
            direct,
            proxied_http: cached.http_agent.clone(),
            proxied_https: cached.https_agent.clone(),
            settings: cached.settings.clone(),
        }
    }
}

/// 端点没换就留住原来的 agent（连接池不白丢）；换了就重建；这一档没有代理就是 None。
fn refresh_agent(
    previous: Option<(&Option<String>, &Option<ureq::Agent>)>,
    spec: Option<&http_proxy::ProxySpec>,
) -> Option<ureq::Agent> {
    let key = spec.map(|s| s.key())?;
    if previous.is_some_and(|(old, agent)| agent.is_some() && old.as_deref() == Some(key.as_str()))
    {
        return previous.and_then(|(_, agent)| agent.clone());
    }
    Some(build_agent(Some(
        &spec.expect("上面判过 key 存在").to_url(),
    )))
}

impl Route {
    /// 这一跳走哪儿。**判不出目标（理论上不该发生）就直连** —— 代理是那条把流量交给
    /// 第三方进程的路线，判不明白时不该选它。
    fn agent_for(&self, url: &tauri::Url) -> ureq::Agent {
        // 判定只有一处实现：`http_proxy::hop_uses_proxy`（单测钉的就是它）
        match self.settings.proxy_scheme_for(url.as_str()) {
            // 决策说有代理却拿不到对应 agent（理论上不该发生）⇒ 退回直连，绝不猜一个代理用
            Some("https") => self
                .proxied_https
                .clone()
                .unwrap_or_else(|| self.direct.clone()),
            Some(_) => self
                .proxied_http
                .clone()
                .unwrap_or_else(|| self.direct.clone()),
            None => self.direct.clone(),
        }
    }

    fn redact(&self, text: String) -> String {
        http_proxy::redact(&text, &self.settings)
    }
}

/// 授权粒度用的 host 键：**只在有非默认端口时才带端口**。
///
/// 前端桥按 `new URL(url).host` 申请授权，而 URL 规范会把缺省端口与等于默认值的
/// 端口都省掉。原先这里用 `port_or_known_default()`，它对「没写端口」的 https
/// 凭空补出 `:443`，两边永远对不上 —— 任何 https 请求都会被判「未授权」。
/// 带显式非默认端口的地址（`http://127.0.0.1:9`）两边一致，所以这个错只在 https 上暴露。
/// `Url::port()` 的语义正好是「缺省或等于默认值时为 None」，所以直接用它。
/// 重定向逐跳复核共用这一个函数，避免两处各写一份而漂移。
fn host_key(parsed: &tauri::Url) -> Result<String, HostError> {
    let host = parsed
        .host_str()
        .ok_or_else(|| HostError::new(INVALID_ARG, "URL 缺少主机名"))?;
    Ok(match parsed.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    })
}

/// 只放行 http/https，并返回授权粒度的 host 键
fn parse_host(url: &str) -> Result<String, HostError> {
    let parsed = tauri::Url::parse(url)
        .map_err(|e| HostError::new(INVALID_ARG, format!("URL 非法: {e}")))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(HostError::new(
                INVALID_ARG,
                format!("只允许 http/https，收到 {other}"),
            ))
        }
    }
    host_key(&parsed)
}

fn host_allowed(granted: &[String], host: &str) -> bool {
    let cap = crate::plugin_caps::http_host_key(host);
    granted.iter().any(|c| c == crate::plugin_caps::HTTP) && granted.iter().any(|c| c == &cap)
}

fn check_granted(state: &PermissionState, plugin_id: &str, host: &str) -> Result<(), HostError> {
    if host_allowed(&state.granted_caps(plugin_id), host) {
        return Ok(());
    }
    Err(HostError::new(
        DENIED,
        format!("未授权访问 {host}：需要 manifest 声明 http 且已同意该域名"),
    ))
}

/// 逐跳发送并校验域名。重定向不再由 ureq 自动跟随：每一跳的新 host 都要重新过一次授权，
/// 换主机时还把 authorization / cookie 摘掉，免得凭据跟着跳转漏给另一个域名。
fn send_following_redirects(
    route: &Route,
    granted: &[String],
    url: &str,
    method: &str,
    headers: &[(String, String)],
    body: Option<&str>,
) -> Result<HttpResponse, HostError> {
    let mut current = tauri::Url::parse(url)
        .map_err(|e| HostError::new(INVALID_ARG, format!("URL 非法: {e}")))?;
    let mut method = method.to_string();
    let mut body = body;
    let mut last_host = String::new();

    for hop in 0..=MAX_REDIRECTS {
        let host = host_key(&current)?;
        if !host_allowed(granted, &host) {
            return Err(HostError::new(
                DENIED,
                format!("未授权访问 {host}：需要 manifest 声明 http 且已同意该域名"),
            ));
        }
        let cross_host = hop > 0 && host != last_host;
        last_host = host;

        // 每一跳都用**该跳的目标**重新决定走不走代理：公网 → 内网的重定向不能沿用上一跳的代理路线
        let agent = route.agent_for(&current);
        let mut req = agent.request(&method, current.as_str());
        for (name, value) in headers {
            if is_valid_header_name(name) && !(cross_host && is_credential_header(name)) {
                req = req.set(name, value);
            }
        }
        let resp = match body {
            Some(text) => req.send_string(text),
            None => req.call(),
        }
        // 走代理时 ureq 的报错会把代理端点（可能连凭据一起）带出来 ⇒ 出口前先洗一遍（B10 行为 3）
        .map_err(|e| HostError::new(NETWORK, route.redact(format!("请求失败: {e}"))))?;

        let status = resp.status();
        if !(300..400).contains(&status) {
            return read_body(resp, status);
        }
        let Some(location) = resp.header("location") else {
            return read_body(resp, status);
        };
        if hop == MAX_REDIRECTS {
            return Err(HostError::new(
                NETWORK,
                format!("重定向超过 {MAX_REDIRECTS} 跳，已放弃"),
            ));
        }
        current = current
            .join(location)
            .map_err(|e| HostError::new(PARSE, format!("重定向目标非法: {e}")))?;
        // 303 一律转 GET；301/302 对非 GET 也转 GET（与浏览器一致）；307/308 保留方法与 body
        if status != 307 && status != 308 {
            method = "GET".to_string();
            body = None;
        }
    }
    Err(HostError::new(
        NETWORK,
        format!("重定向超过 {MAX_REDIRECTS} 跳，已放弃"),
    ))
}

fn is_credential_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "cookie" | "proxy-authorization"
    )
}

/// 从 Content-Type 里取 `charset=` 参数值（去空白与引号，大小写保持原样）。
///
/// 真实响应头的写法很杂：腾讯是 `text/html; charset=GBK`（大写值），新浪是
/// `application/javascript; charset=GB18030`，还有 `text/html;charset=gbk;` 这种
/// 无空格且带尾分号的。所以按 `;` 切开逐个参数比对键名（键名大小写不敏感），
/// 值只做 trim，匹配留给调用方按大小写不敏感做。
fn charset_of(content_type: Option<&str>) -> Option<&str> {
    let ct = content_type?;
    for param in ct.split(';').skip(1) {
        let Some((key, value)) = param.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("charset") {
            let value = value.trim().trim_matches('"').trim();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/// 把响应字节解成字符串。
///
/// 只认 GBK 家族这三个标签，其余（没有 charset、utf-8、认不出来的值）一律保持原先的
/// UTF-8 lossy 行为不变 —— 不做「猜编码」，也就不会让既有插件的解析结果漂移。
///
/// 为什么必须解对而不能只影响显示：腾讯的行情用 `~` 分段，名称段排在数字段前面，
/// 而 GBK 允许 0x7E（就是 `~`）做尾字节（如「硚」= b3 7e）。按 UTF-8 lossy 解时那个
/// 字节会变成一个真的分隔符，后面每个字段整体挪一位，把「今开」读成「现价」——
/// 这是静默错价，比显示乱码严重得多。
///
/// WHATWG 里 gbk / gb2312 / gb18030 共用同一个 GBK 解码器，所以三个标签走同一条路；
/// 用 `decode_without_bom_handling` 是刻意的：不做 BOM 嗅探、不改判编码，声明什么就用什么，
/// 且该解码器只会把坏字节换成 U+FFFD，没有「解码失败」这种状态，不必也不该向上抛错。
fn decode_body(buf: &[u8], content_type: Option<&str>) -> String {
    let gbk_family = charset_of(content_type).is_some_and(|cs| {
        ["gbk", "gb2312", "gb18030"]
            .iter()
            .any(|k| cs.eq_ignore_ascii_case(k))
    });
    if gbk_family {
        let (text, _had_errors) = encoding_rs::GBK.decode_without_bom_handling(buf);
        return text.into_owned();
    }
    String::from_utf8_lossy(buf).into_owned()
}

fn read_body(resp: ureq::Response, status: u16) -> Result<HttpResponse, HostError> {
    let content_type = resp.header("content-type").map(str::to_string);
    let mut buf = Vec::new();
    // 多取 1 字节：正好等于上限的合法响应不该被当成超长
    let read = resp
        .into_reader()
        .take(MAX_BODY_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| HostError::new(NETWORK, format!("读取响应失败: {e}")))?;
    let truncated = read > MAX_BODY_BYTES;
    if truncated {
        buf.truncate(MAX_BODY_BYTES);
    }
    let body = decode_body(&buf, content_type.as_deref());
    Ok(HttpResponse {
        status,
        content_type,
        body,
        truncated,
    })
}

/// 只放行这五个方法（ADR-0005：规则抽成函数，命令体只留委托）。入参不合法 → invalid-arg。
fn assert_allowed_method(method: &str) -> Result<(), HostError> {
    if matches!(method, "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
        return Ok(());
    }
    Err(HostError::new(
        INVALID_ARG,
        format!("不支持的方法: {method}"),
    ))
}

/// 插件出站请求。host 由 Rust 自己从 URL 解析，不采信前端传来的域名。
#[tauri::command]
pub async fn http_request(
    http: tauri::State<'_, HttpState>,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    url: String,
    method: Option<String>,
    headers: Option<Vec<(String, String)>>,
    body: Option<String>,
) -> Result<HttpResponse, HostError> {
    if !crate::ids::is_safe_id(&plugin_id) {
        return Err(HostError::new(INVALID_ARG, "invalid plugin id"));
    }
    let host = parse_host(&url)?;
    check_granted(&perms, &plugin_id, &host)?;

    let method = method.unwrap_or_else(|| "GET".into()).to_ascii_uppercase();
    assert_allowed_method(&method)?;

    // 阻塞线程里拿不到 State，先把这个插件已授权的能力取一份快照带进去
    let granted = perms.granted_caps(&plugin_id);
    let headers = headers.unwrap_or_default();
    // 取路由 = 读一次系统代理设置（TTL 内复用）；锁在这里就放掉了，不跨网络请求持有
    let route = http.route();
    let sent = tauri::async_runtime::spawn_blocking(move || {
        send_following_redirects(&route, &granted, &url, &method, &headers, body.as_deref())
    })
    .await
    .map_err(|e| HostError::new(INTERNAL, format!("HTTP 任务失败: {e}")))??;
    Ok(sent)
}

fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '!' | '#'
                        | '$'
                        | '%'
                        | '&'
                        | '\''
                        | '*'
                        | '+'
                        | '-'
                        | '.'
                        | '^'
                        | '_'
                        | '`'
                        | '|'
                        | '~'
                )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 腾讯实时行情响应的真实前缀（实抓 `https://qt.gtimg.cn/q=sh600000`，
    /// 响应头 `text/html; charset=GBK`）。「浦发银行」的 GBK 字节是 c6 d6 b7 a2 d2 f8 d0 d0。
    const TENCENT_GBK_PREFIX: &[u8] =
        b"v_sh600000=\"1~\xc6\xd6\xb7\xa2\xd2\xf8\xd0\xd0~600000~9.54~9.70~9.70\";";

    fn granted(caps: &[&str]) -> Vec<String> {
        caps.iter().map(|c| c.to_string()).collect()
    }

    #[test]
    fn charset_parameter_is_parsed_from_the_real_world_shapes() {
        assert_eq!(charset_of(Some("text/html; charset=GBK")), Some("GBK"));
        assert_eq!(
            charset_of(Some("application/javascript; charset=GB18030")),
            Some("GB18030")
        );
        // 无空格、带尾分号
        assert_eq!(charset_of(Some("text/html;charset=gbk;")), Some("gbk"));
        assert_eq!(
            charset_of(Some("text/html; charset=gbk; boundary=x")),
            Some("gbk")
        );
        // 带引号 / 键名大写 / 等号周围有空格
        assert_eq!(
            charset_of(Some("text/html; charset=\"GB2312\"")),
            Some("GB2312")
        );
        assert_eq!(
            charset_of(Some("text/html; CHARSET = gb18030")),
            Some("gb18030")
        );
        assert_eq!(charset_of(Some("text/html")), None);
        assert_eq!(charset_of(Some("text/html; charset=")), None);
        assert_eq!(charset_of(Some("text/html; charset")), None);
        assert_eq!(charset_of(None), None);
    }

    #[test]
    fn gbk_charset_decodes_chinese_stock_name() {
        // 真实响应头是大写的 GBK，别按小写写死
        let text = decode_body(TENCENT_GBK_PREFIX, Some("text/html; charset=GBK"));
        assert!(text.contains("浦发银行"), "{text}");
        assert!(!text.contains('\u{FFFD}'), "{text}");
        let fields: Vec<&str> = text.split('~').collect();
        assert_eq!(fields[1], "浦发银行");
        assert_eq!(fields[3], "9.54");
    }

    #[test]
    fn gb18030_charset_decodes_too() {
        // 新浪的形状：application/javascript; charset=GB18030，名称在逗号分段的开头
        let body = b"var hq_str_sh600000=\"\xc6\xd6\xb7\xa2\xd2\xf8\xd0\xd0,9.700,9.700,9.540\";";
        let text = decode_body(body, Some("application/javascript; charset=GB18030"));
        assert!(text.contains("\"浦发银行,9.700"), "{text}");
        assert!(!text.contains('\u{FFFD}'), "{text}");
        // 三个标签走同一条路：小写、gb2312 等价标签也必须命中
        assert_eq!(decode_body(body, Some("text/html; charset=gb18030")), text);
        assert_eq!(decode_body(body, Some("text/html;charset=gb2312;")), text);
    }

    #[test]
    fn gbk_name_with_tilde_trailing_byte_does_not_shift_fields() {
        // 「硚」的 GBK 是 b3 7e —— 尾字节正好等于腾讯的分段符 `~`。按 UTF-8 lossy 解时，
        // 这个字节会变成真分隔符，名称段被切成两段，后面数字整体挪一位：现价那格读到股票代码。
        let body: &[u8] = b"v_sh600000=\"1~\xb3\x7e\xbf\xda\xd2\xf8\xd0\xd0~600000~9.54~9.70\";";
        let text = decode_body(body, Some("text/html; charset=GBK"));
        let fields: Vec<&str> = text.split('~').collect();
        assert_eq!(fields[1], "硚口银行");
        assert_eq!(fields[3], "9.54", "现价被名称里的 0x7E 挪位了: {text}");

        // 对照：lossy 那一份确实多切一刀、现价那格被顶成股票代码（这就是必须解字节的理由）
        let lossy = String::from_utf8_lossy(body);
        let lossy_fields: Vec<&str> = lossy.split('~').collect();
        assert_eq!(
            lossy_fields.len(),
            fields.len() + 1,
            "样例没构造出多切一刀的效果"
        );
        assert_eq!(lossy_fields[3], "600000", "样例没构造出错位的效果");
    }

    #[test]
    fn absent_or_unrecognised_charset_keeps_the_lossy_behaviour() {
        // 样例本身含非法 UTF-8 字节（GBK 的「浦发银行」），这条回归才不是空断言
        let lossy = String::from_utf8_lossy(TENCENT_GBK_PREFIX).into_owned();
        assert!(
            lossy.contains('\u{FFFD}'),
            "样例不含非法字节，证明不了回落没被改掉"
        );
        for ct in [
            None,
            Some("text/html"),
            Some("text/html; charset=utf-8"),
            Some("text/html; charset=UTF-8"),
            // 认不出来的标签不猜编码，保持原行为
            Some("text/html; charset=iso-8859-1"),
            Some("text/html; charset=big5"),
            // 只整体命中这三个标签，不做前缀/包含匹配
            Some("text/html; charset=gb2312x"),
            Some("text/html; charset=utf-8; charset=gbk"),
        ] {
            assert_eq!(
                decode_body(TENCENT_GBK_PREFIX, ct),
                lossy,
                "content-type = {ct:?}"
            );
        }
    }

    #[test]
    fn http_alone_does_not_allow_any_host() {
        assert!(!host_allowed(&granted(&["http"]), "example.com"));
    }

    #[test]
    fn only_the_granted_host_is_allowed() {
        let g = granted(&["http", "http:api.example.com"]);
        assert!(host_allowed(&g, "api.example.com"));
        assert!(!host_allowed(&g, "evil.example.com"));
        // 端口属于授权粒度
        assert!(!host_allowed(&g, "api.example.com:8443"));
    }

    #[test]
    fn default_ports_are_not_part_of_the_host_key() {
        // 前端桥用 new URL(url).host 申请授权，它不带默认端口；这边带了就会永远判未授权
        assert_eq!(
            parse_host("https://push2.eastmoney.com/api/x").unwrap(),
            "push2.eastmoney.com"
        );
        assert_eq!(parse_host("http://127.0.0.1/x").unwrap(), "127.0.0.1");
        // 显式写出的默认端口同样被 URL 规范省掉
        assert_eq!(parse_host("https://x.com:443/y").unwrap(), "x.com");
    }

    #[test]
    fn non_default_ports_stay_in_the_host_key() {
        assert_eq!(
            parse_host("http://localhost:1420/").unwrap(),
            "localhost:1420"
        );
        assert_eq!(parse_host("https://x.com:8443/y").unwrap(), "x.com:8443");
        assert_eq!(parse_host("http://127.0.0.1:9/x").unwrap(), "127.0.0.1:9");
    }

    #[test]
    fn granted_host_key_matches_what_the_bridge_asks_for() {
        // 端到端一致性：桥申请 `http:` + 浏览器 URL.host，宿主按同一口径复核
        let key = parse_host("https://api.example.com/v1").unwrap();
        let g = vec!["http".to_string(), format!("http:{key}")];
        assert!(host_allowed(&g, &key));
    }

    /// A2/ADR-0007：URL 形状检查（http_request 与重定向两路的共同入口）的两类失败
    /// 都是调用方的输入问题 → invalid-arg，文案逐字保持迁移前。
    #[test]
    fn url_shape_errors_are_invalid_arg() {
        let err = parse_host("ftp://example.com/x").unwrap_err();
        assert_eq!(
            err.code, INVALID_ARG,
            "非 http/https 的 scheme = invalid-arg"
        );
        assert_eq!(err.message, "只允许 http/https，收到 ftp");
        let err = parse_host("not a url").unwrap_err();
        assert_eq!(err.code, INVALID_ARG, "解析不了的 URL = invalid-arg");
        assert!(err.message.starts_with("URL 非法: "), "实际: {err}");
    }

    /// 没有主机名的 URL（非特殊 scheme 的裸路径）在 host_key 处被拒，同码 invalid-arg
    #[test]
    fn missing_host_is_invalid_arg() {
        let url = tauri::Url::parse("foo:/path").unwrap();
        assert!(url.host_str().is_none(), "样例没构造出「无主机名」的形状");
        let err = host_key(&url).unwrap_err();
        assert_eq!(err.code, INVALID_ARG);
        assert_eq!(err.message, "URL 缺少主机名");
    }

    /// A2/ADR-0007：域名没授权的拒绝是 denied（`:93` 与重定向逐跳复核同文案同码）；
    /// 授权表放行后同一次调用成功。
    #[test]
    fn host_grant_denial_carries_the_denied_code() {
        let perms = PermissionState::new();
        let err = check_granted(&perms, "todo", "example.com").unwrap_err();
        assert_eq!(err.code, DENIED, "缺域名同意 = denied");
        assert_eq!(
            err.message,
            "未授权访问 example.com：需要 manifest 声明 http 且已同意该域名"
        );
        perms.grant(
            "todo",
            &["http".to_string(), "http:example.com".to_string()],
        );
        assert!(check_granted(&perms, "todo", "example.com").is_ok());
    }

    /// A2/ADR-0007：放行名单外的方法拒绝是 invalid-arg（`:253` 站点），文案逐字不变。
    #[test]
    fn unsupported_method_is_invalid_arg() {
        for ok in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            assert!(assert_allowed_method(ok).is_ok(), "{ok} 应当放行");
        }
        let err = assert_allowed_method("TRACE").unwrap_err();
        assert_eq!(err.code, INVALID_ARG, "名单外的方法 = invalid-arg");
        assert_eq!(err.message, "不支持的方法: TRACE");
    }

    #[test]
    fn credential_headers_are_recognised_case_insensitively() {
        assert!(is_credential_header("Authorization"));
        assert!(is_credential_header("COOKIE"));
        assert!(is_credential_header("Proxy-Authorization"));
        assert!(!is_credential_header("Content-Type"));
    }
}
