//! 窗口来源门禁：命令由哪个窗口发来，决定它能不能改宿主。
//!
//! 判定只看 `window.label()` —— 那是宿主自己建窗时定的，前端伪造不了。
//! 插件 JS 就跑在宠物窗里，所以这条门禁拦得住「绕过 JS 桥直接 invoke」的插件越权；
//! 拦不住的是宠物窗内插件之间的区分（同 realm，宿主看不出是哪个插件），
//! 那要等 Web Worker 宿主才收口（见 ARCHITECTURE.md 信任模型）。
//!
//! G3-01：插件调用面还要再判「这个窗能不能代表这个 plugin_id」——
//! 悬浮窗（`overlay-*`）的标签由宿主开窗时定，归属查宿主注册表
//! （`window::overlay::owner_of_label`），页面伪造不了；同意框（`consent-*`）则一律拒。
use tauri::Window;

use crate::host_error::{HostError, DENIED, INVALID_ARG};
use crate::services::permission::PermissionState;

/// 跨会话生效的系统级开关、授权表、形象与 hook 配置：只认设置窗
pub fn settings(window: &Window, what: &str) -> Result<(), HostError> {
    require(window.label(), "settings", "设置窗", what)
}

/// 影响宠物本体显隐与宿主窗口自身的动作：只认宠物窗
pub fn pet(window: &Window, what: &str) -> Result<(), HostError> {
    require(window.label(), "pet", "宠物窗", what)
}

/// 插件调用面的第二道门：命令带 `pluginId` 时，除窗口归属外还要该能力已授权。
/// 与 BLE 命令的 `require_granted` 同一口径（兜的是「绕过 JS 桥直接 invoke」）；
/// 同 realm 的插件之间仍分不出，那条缺口要等 Web Worker 宿主（ADR-0006）。
///
/// ADR-0007：这里是一半以上错误文案的出生地，所以它先迁 ——
/// 「非法 id」是 `invalid-arg`，「没授权」是 `denied`，两种以前都只是字符串，
/// 前端要按文案分支才能区分；现在码就在负载里。未迁移的调用方靠
/// `impl From<HostError> for String` 继续拿原文案，`?` 一行都不用改。
pub fn plugin_capability(
    window: &Window,
    state: &PermissionState,
    plugin_id: &str,
    capability: &str,
) -> Result<(), HostError> {
    window_owns_plugin(window, plugin_id)?;
    plugin_capability_for(state, plugin_id, capability)
}

/// G3-01：这个窗能不能代表这个 plugin_id（只看宿主自己的注册表，不信调用方自报）。
///
/// - `overlay-*`：只认宿主注册表里归属的插件（`owner_of_label`）；悬窗标签由宿主开窗时定，
///   页面改不了，所以别的插件冒用 id 从这条路进来会被拒；
/// - `consent-*`：同意框只该回答它自己那张弹窗，任何情况下都不代表插件调用能力；
/// - 其余窗口（宠物窗、设置窗）：插件 JS 就跑在宠物窗里，标签分不出插件，
///   这里放行，交给下半段的授权表 —— 同 realm 之间的缺口仍要等 Worker 宿主（ADR-0006）。
pub fn window_owns_plugin(window: &Window, plugin_id: &str) -> Result<(), HostError> {
    let label = window.label();
    let owner = crate::window::overlay::owner_of_label(label);
    owns_plugin_for_label(label, owner.as_deref(), plugin_id)
}

/// 归属判定的纯函数形态（label 与注册表归属由调用方给）：单测不造 Window，
/// 生产路径 `window_owns_plugin` 只是从 Window 取这两个值再调它。
fn owns_plugin_for_label(
    label: &str,
    owner: Option<&str>,
    plugin_id: &str,
) -> Result<(), HostError> {
    if label.starts_with("consent-") {
        return Err(HostError::new(
            DENIED,
            format!("窗口 {label} 不能代表插件 {plugin_id} 调用能力"),
        ));
    }
    if label.starts_with("overlay-") && owner != Some(plugin_id) {
        return Err(HostError::new(
            DENIED,
            format!("悬浮窗 {label} 不能代表插件 {plugin_id}：归属不符"),
        ));
    }
    Ok(())
}

/// 能力表判定（与窗口无关的那半段）：`plugin_capability` 的后半段，
/// 也给只有插件 id 的单测留直通口（生产命令一律走带 Window 的入口）。
pub(crate) fn plugin_capability_for(
    state: &PermissionState,
    plugin_id: &str,
    capability: &str,
) -> Result<(), HostError> {
    if !crate::ids::is_safe_id(plugin_id) {
        return Err(HostError::new(INVALID_ARG, "invalid plugin id"));
    }
    if state.is_granted(plugin_id, capability) {
        Ok(())
    } else {
        Err(HostError::new(
            DENIED,
            format!("未授权 {capability}：需要 manifest 声明且已同意"),
        ))
    }
}

fn require(label: &str, expected: &str, name: &str, what: &str) -> Result<(), HostError> {
    if label == expected {
        Ok(())
    } else {
        Err(HostError::new(DENIED, format!("只有{name}可以{what}")))
    }
}

#[cfg(test)]
mod tests {
    use super::{owns_plugin_for_label, plugin_capability_for, require};
    use crate::host_error::{DENIED, INVALID_ARG};
    use crate::services::permission::PermissionState;

    #[test]
    fn only_the_named_window_passes() {
        assert!(require("settings", "settings", "设置窗", "改动开机自启").is_ok());
        let err = require("pet", "settings", "设置窗", "改动开机自启").unwrap_err();
        assert_eq!(err.message, "只有设置窗可以改动开机自启");
        assert_eq!(err.code, DENIED, "窗口门禁的拒绝是 denied 码，不是别的");
        // overlay / consent 这类窗口都不在放行名单里
        assert!(require("overlay-com-pet-hr-ble", "settings", "设置窗", "撤销授权").is_err());
    }

    /// B2：带 pluginId 的插件调用面 —— 未授权被拒、授权后放行、逐项校验、非法 id 被拒
    #[test]
    fn plugin_capability_requires_grant_and_valid_id() {
        let state = PermissionState::new();
        assert!(plugin_capability_for(&state, "zz.probe", "agent:hooks").is_err());
        state.grant("zz.probe", &["agent:hooks".to_string()]);
        assert!(plugin_capability_for(&state, "zz.probe", "agent:hooks").is_ok());
        // 逐项校验：同一插件没授权的另一个能力仍然被拒
        assert!(plugin_capability_for(&state, "zz.probe", "ble:scan").is_err());
        // 别的插件没被连带授权
        assert!(plugin_capability_for(&state, "zz.other", "agent:hooks").is_err());
        // 非法 id 一律拒（与 is_safe_id 对齐），且码与「没授权」不同 —— ADR-0007 要求同文案同码
        let bad = plugin_capability_for(&state, "../evil", "agent:hooks").unwrap_err();
        assert_eq!(bad.code, INVALID_ARG, "非法 id 不能混进 denied");
        assert_eq!(bad.message, "invalid plugin id");
        let missing = plugin_capability_for(&state, "zz.other", "agent:hooks").unwrap_err();
        assert_eq!(missing.code, DENIED);
        assert!(
            missing.message.contains("未授权 agent:hooks"),
            "实际: {missing}"
        );
    }

    /// G3-01：悬浮窗只能代表宿主登记的那个插件；同意框谁也不代表。
    #[test]
    fn overlay_window_only_represents_its_registered_owner() {
        // 自己插件：放行
        assert!(
            owns_plugin_for_label("overlay-com.pet.todo", Some("com.pet.todo"), "com.pet.todo")
                .is_ok()
        );
        // 冒用别的插件 id：拒，且是 denied 码
        let err = owns_plugin_for_label(
            "overlay-com.pet.todo",
            Some("com.pet.todo"),
            "com.pet.ble",
        )
        .unwrap_err();
        assert_eq!(err.code, DENIED);
        assert!(err.message.contains("归属不符"), "实际: {err}");
        // 没登记归属的悬浮窗：同样拒
        assert!(owns_plugin_for_label("overlay-unknown", None, "com.pet.todo").is_err());
        // 同意框即使标签上有归属也不代表插件
        let consent = owns_plugin_for_label(
            "consent-com.pet.todo",
            Some("com.pet.todo"),
            "com.pet.todo",
        )
        .unwrap_err();
        assert_eq!(consent.code, DENIED);
        assert!(consent.message.contains("不能代表插件"), "实际: {consent}");
        // 宠物窗/设置窗不是悬浮窗，不适用「冒用别人 id」的判定
        assert!(owns_plugin_for_label("pet", None, "com.pet.todo").is_ok());
        assert!(owns_plugin_for_label("settings", None, "com.pet.todo").is_ok());
    }
}
