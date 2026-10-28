use tauri_plugin_notification::NotificationExt;

use super::permission::PermissionState;
use crate::host_error::{HostError, INTERNAL, INVALID_ARG};

/// 系统通知。同样过授权表，否则任何插件都能拿它骚扰用户。
/// G3-01：先过窗口归属（悬浮窗只能以自己的名义发通知）。
#[tauri::command]
pub fn notify_show(
    window: tauri::Window,
    app: tauri::AppHandle,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    title: String,
    body: String,
) -> Result<(), HostError> {
    crate::gate::plugin_capability(&window, &perms, &plugin_id, crate::plugin_caps::NOTIFY)?;
    let title = sanitize(&title, 80);
    let text = sanitize(&body, 240);
    if title.is_empty() && text.is_empty() {
        return Err(HostError::new(INVALID_ARG, "通知内容为空"));
    }
    app.notification()
        .builder()
        .title(&title)
        .body(&text)
        .show()
        // 投递失败是系统侧的失败，不是插件的参数问题 —— 码分开，文案照旧
        .map_err(|e| HostError::new(INTERNAL, e.to_string()))
}

/// 压掉换行并限长：通知气泡不接受插件塞进来的多行长文
fn sanitize(input: &str, max_chars: usize) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}
