//! Q5：蓝牙侧可测纯逻辑的单测（由 ble.rs 里 `#[cfg(test)] mod tests` 引入）。
//!
//! 分工要说清：卡片里那条「持有者计数」在 JS 侧（`src/runtime/resources.ts`，
//! 共享 BLE 会话/扫描按插件计数），它已由 `npm run unit:runtime` 离线覆盖；
//! Rust 这边能独立测的是**通知报文解析**与**连接代际的清理判定** ——
//! 两者都不需要真蓝牙硬件。
use super::*;

use crate::host_error::{DENIED, DEVICE_UNAVAILABLE, INVALID_ARG, INVALID_STATE};
use crate::services::permission::PermissionState;

#[test]
fn uint8_flag_clear_reads_second_byte() {
    // 心率报文：首字节 bit0 = 0 表示 Rate 是一个 uint8
    assert_eq!(parse_heart_rate(&[0x00, 72]), Some(72));
    assert_eq!(parse_heart_rate(&[0x00, 1]), Some(1));
    assert_eq!(parse_heart_rate(&[0x00, 250]), Some(250));
}

#[test]
fn uint16_flag_uses_little_endian_pair() {
    // bit0 = 1 → uint16，小端：低字节在前
    assert_eq!(parse_heart_rate(&[0x01, 72, 0x00]), Some(72));
    assert_eq!(
        parse_heart_rate(&[0x01, 0xC8, 0x00]),
        Some(200),
        "小端取法：低字节 0xC8 = 200"
    );
    assert_eq!(
        parse_heart_rate(&[0x01, 0x00, 0xC8]),
        None,
        "按大端会读成 12288 —— 超范围即丢弃，这条是字节序的反证"
    );
    assert_eq!(
        parse_heart_rate(&[0x01, 0x00, 0x01]),
        None,
        "256 超出生理范围"
    );
}

#[test]
fn other_flag_bits_do_not_change_the_width() {
    // bit1 传感器接触、bit2 接触支持、bit3 能量消耗字段都不影响 Rate 的宽度
    assert_eq!(parse_heart_rate(&[0x02, 88]), Some(88));
    assert_eq!(parse_heart_rate(&[0x04, 99]), Some(99));
    assert_eq!(
        parse_heart_rate(&[0x08, 110, 0x00, 0x00]),
        Some(110),
        "带能量消耗字段时仍按 uint8 取第二字节"
    );
    assert_eq!(
        parse_heart_rate(&[0x03, 110, 0x00]),
        Some(110),
        "bit0 才是宽度位"
    );
}

#[test]
fn short_payloads_are_rejected_not_guessed() {
    assert_eq!(parse_heart_rate(&[]), None);
    assert_eq!(parse_heart_rate(&[0x00]), None, "只有一字节 = 没有数值");
    assert_eq!(
        parse_heart_rate(&[0x01, 0x2C]),
        None,
        "声明 uint16 却只给了两字节"
    );
}

#[test]
fn out_of_range_values_are_dropped() {
    // 1..=250：0 与超上限都不广播出去，否则波形上会出现假的心跳
    assert_eq!(parse_heart_rate(&[0x00, 0]), None);
    assert_eq!(parse_heart_rate(&[0x00, 251]), None);
    assert_eq!(parse_heart_rate(&[0x00, 255]), None);
}

#[test]
fn only_the_owning_generation_clears_the_task_slot() {
    // 同设备重连：旧流退出时它的 gen 已经不是当前那一代，不能把新连接的记录抹掉
    assert!(task_is_this_generation(Some(7), 7));
    assert!(!task_is_this_generation(Some(8), 7), "代际不同就不该清");
    assert!(!task_is_this_generation(None, 7), "槽位已空就不必再清");
    assert!(
        !task_is_this_generation(None, 0),
        "0 也要走同一判定，别把它当「无代际」特殊对待"
    );
}

#[test]
fn only_the_matching_device_clears_the_connection() {
    // 断开 A 不该把 B 的连接状态清掉
    assert!(connected_is_this_device(Some("AA:BB"), "AA:BB"));
    assert!(!connected_is_this_device(Some("AA:BB"), "CC:DD"));
    assert!(!connected_is_this_device(None, "AA:BB"));
}

#[test]
fn hr_characteristic_lookup_uses_the_service_uuid() {
    // 这条不碰硬件：只钉住「心率特征 UUID 是 0x2A37」这个常量口径，
    // 免得日后有人按 16 位短 UUID 去匹配（btleplug 给的是 128 位形式）
    assert_eq!(
        HR_MEASUREMENT,
        Uuid::parse_str("00002a37-0000-1000-8000-00805f9b34fb").unwrap()
    );
    assert_eq!(
        HR_SERVICE,
        Uuid::parse_str("0000180d-0000-1000-8000-00805f9b34fb").unwrap()
    );
    assert_ne!(HR_MEASUREMENT, HR_SERVICE);
}

/// ADR-0005：心率判定从命令体的 `||` 拆成两个条件，四种组合都要钉住 ——
/// 尤其是「有特征值但没有服务」和反过来那两种，它们以前共用一条错误文案，看不出漏了哪半边
#[test]
fn heart_rate_requires_both_characteristic_and_service() {
    assert!(
        !device_lacks_heart_rate(true, true),
        "特征值与服务都在 = 合格设备，不该拒绝"
    );
    assert!(
        device_lacks_heart_rate(false, true),
        "只声明了 0x180D 服务、没有 0x2A37 特征值 → 拒"
    );
    assert!(
        device_lacks_heart_rate(true, false),
        "只找到特征值、服务枚举里没有 0x180D → 拒"
    );
    assert!(device_lacks_heart_rate(false, false), "两者都没有 → 拒");
}

/// A04：BLE 五条命令的门禁链 —— 非法 id 的码是 invalid-arg，与「没授权」的 denied 分开。
/// G3-01 之后 `require_granted` 收调用窗（归属判定需要 Window），单测直接钉它包住的
/// 那把门禁 `plugin_capability_for`（能力表判定与窗口无关的部分）。
#[test]
fn require_granted_rejects_unsafe_id_with_invalid_arg() {
    let perms = PermissionState::new();
    let err = crate::gate::plugin_capability_for(&perms, "../evil", crate::plugin_caps::BLE_SCAN)
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARG, "非法 id 不能混进 denied");
    assert_eq!(err.message, "invalid plugin id");
}

/// A04：没授权 = denied（scan 面：start / stop 两条命令的门禁都走这一条）
#[test]
fn require_granted_rejects_ungranted_scan_with_denied() {
    let perms = PermissionState::new();
    let err = crate::gate::plugin_capability_for(&perms, "zz.probe", crate::plugin_caps::BLE_SCAN)
        .unwrap_err();
    assert_eq!(err.code, DENIED);
    assert!(err.message.starts_with("未授权 ble:scan"), "实际: {err}");
    perms.grant("zz.probe", &["ble:scan".to_string()]);
    assert!(
        crate::gate::plugin_capability_for(&perms, "zz.probe", crate::plugin_caps::BLE_SCAN)
            .is_ok()
    );
}

/// A04：没授权 = denied（connect 面：connect / disconnect / connected_device 的门禁走这一条）
#[test]
fn require_granted_rejects_ungranted_connect_with_denied() {
    let perms = PermissionState::new();
    let err =
        crate::gate::plugin_capability_for(&perms, "zz.probe", crate::plugin_caps::BLE_CONNECT)
            .unwrap_err();
    assert_eq!(err.code, DENIED);
    // 逐项校验：只授权 scan 不连带 connect（同插件也不行）
    let perms2 = PermissionState::new();
    perms2.grant("zz.probe", &["ble:scan".to_string()]);
    let err2 =
        crate::gate::plugin_capability_for(&perms2, "zz.probe", crate::plugin_caps::BLE_CONNECT)
            .unwrap_err();
    assert_eq!(err2.code, DENIED);
}

/// A04：未初始化就起扫描 = invalid-state（不是 internal、不是 device-unavailable）
#[test]
fn begin_adapter_scan_without_init_is_invalid_state() {
    let state = BleState::new();
    let err = tauri::async_runtime::block_on(begin_adapter_scan(&state)).unwrap_err();
    assert_eq!(
        err.code, INVALID_STATE,
        "invalid-state 的定义明文包含「未初始化」"
    );
    assert_eq!(err.message, "BLE init failed");
}

/// A04：未初始化就按 id 取设备 = invalid-state（同一条「BLE init failed」链）
#[test]
fn lookup_peripheral_without_init_is_invalid_state() {
    let state = BleState::new();
    let err = tauri::async_runtime::block_on(lookup_peripheral(&state, "AA:BB")).unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    assert_eq!(err.message, "BLE init failed");
}

/// A04：init 失败链（建 manager / 枚举适配器 / 找适配器）统一 device-unavailable。
/// 适配器缺失的机器上执行断言；本机实测有适配器（init_ble 直接成功，见 eprintln），
/// 所以这条在本机只验证「不报别的错」——设备可达类分支不在这条断言的目标内。
#[test]
fn init_ble_failure_chain_is_device_unavailable() {
    let state = BleState::new();
    match tauri::async_runtime::block_on(init_ble(&state)) {
        Err(err) => {
            assert_eq!(err.code, DEVICE_UNAVAILABLE, "实际: {err}");
            eprintln!("[a04] init_ble 失败链命中：{}", err.message);
        }
        Ok(()) => {
            eprintln!("[a04] 本机有蓝牙适配器，init_ble 成功；device-unavailable 链留给无硬件机器")
        }
    }
}
