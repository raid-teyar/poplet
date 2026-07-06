//! Window management: Hyprland/GNOME window rules, the single-instance Unix
//! socket, /dev/uinput virtual-keyboard paste injection, and the Tauri
//! commands that toggle, size, and drive the Poplet + snip-editor windows.

use crate::AppState;
use evdev::{uinput::VirtualDeviceBuilder, AttributeSet, EventType, InputEvent, Key};
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Emitter, Manager};

#[derive(serde::Deserialize)]
struct HyprClient {
    address: String,
    class: String,
    title: String,
    floating: bool,
    pinned: bool,
    fullscreen: Option<serde_json::Value>,
}

pub(crate) fn socket_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        PathBuf::from(dir).join("poplet.sock")
    } else {
        PathBuf::from("/tmp/poplet.sock")
    }
}

pub(crate) fn is_hyprland() -> bool {
    std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok()
}

pub(crate) fn current_exe_command(arg: &str) -> String {
    std::env::current_exe()
        .map(|path| format!("{} {arg}", path.to_string_lossy()))
        .unwrap_or_else(|_| format!("poplet {arg}"))
}

pub(crate) fn hyprctl(args: &[&str]) -> bool {
    std::process::Command::new("hyprctl")
        .args(args)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub(crate) fn install_hyprland_window_rules() {
    if !is_hyprland() {
        return;
    }

    // Hyprland 0.54 uses the v3 window rule grammar. Pinning is more reliable
    // as a compositor rule than trying to toggle pin after every map.
    let _ = hyprctl(&["keyword", "windowrule", "match:class ^(poplet)$, pin on"]);
    let _ = hyprctl(&["keyword", "windowrule", "match:class ^(poplet)$, float on"]);
    let _ = hyprctl(&["keyword", "windowrule", "match:class ^(poplet)$, center on"]);
}

fn hyprland_clients() -> Vec<HyprClient> {
    let Ok(output) = std::process::Command::new("hyprctl")
        .args(["clients", "-j"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    serde_json::from_slice::<Vec<HyprClient>>(&output.stdout).unwrap_or_default()
}

fn hyprland_poplet_client() -> Option<HyprClient> {
    hyprland_clients()
        .into_iter()
        .find(|client| client.class == "poplet" && client.title == "Poplet")
}


fn ensure_hyprland_pinned(class_name: &str, title: &str) {
    if !is_hyprland() {
        return;
    }

    for client in hyprland_clients()
        .into_iter()
        .filter(|client| client.class == class_name && client.title == title && client.floating)
    {
        if !client.pinned {
            install_hyprland_window_rules();
            let selector = format!("address:{}", client.address);
            let _ = hyprctl(&["dispatch", "pin", &selector]);
        }
    }
}

fn set_hyprland_poplet_fullscreen(enabled: bool) -> bool {
    if !is_hyprland() {
        return false;
    }
    let Some(client) = hyprland_poplet_client() else {
        return false;
    };
    let is_fullscreen = match client.fullscreen.as_ref() {
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::Number(value)) => value.as_i64().unwrap_or(0) != 0,
        _ => false,
    };
    if is_fullscreen == enabled {
        if !enabled {
            ensure_hyprland_pinned("poplet", "Poplet");
        }
        return true;
    }
    let selector = format!("address:{}", client.address);
    let _ = hyprctl(&["dispatch", "focuswindow", &selector]);
    if enabled && client.pinned {
        let _ = hyprctl(&["dispatch", "pin", &selector]);
    }
    let ok = hyprctl(&["dispatch", "fullscreen", "1"]);
    if !enabled {
        ensure_hyprland_pinned("poplet", "Poplet");
    }
    ok
}

/// Try to deliver a "toggle" message to the running primary instance.
/// Returns true if the message was sent (caller should exit), false if no
/// primary is reachable (caller should become the primary).
pub(crate) fn send_toggle_via_socket() -> bool {
    send_socket_message("toggle")
}

pub(crate) fn send_snip_via_socket() -> bool {
    send_socket_message("snip")
}

fn send_socket_message(message: &str) -> bool {
    match UnixStream::connect(socket_path()) {
        Ok(mut s) => {
            let _ = s.write_all(message.as_bytes());
            let _ = s.write_all(b"\n");
            let _ = s.flush();
            true
        }
        Err(_) => false,
    }
}

pub(crate) fn build_virtual_keyboard() -> Option<evdev::uinput::VirtualDevice> {
    let mut keys = AttributeSet::<Key>::new();
    keys.insert(Key::KEY_LEFTCTRL);
    keys.insert(Key::KEY_V);
    let result = (|| -> std::io::Result<evdev::uinput::VirtualDevice> {
        VirtualDeviceBuilder::new()?
            .name("Poplet")
            .with_keys(&keys)?
            .build()
    })();
    match result {
        Ok(kb) => Some(kb),
        Err(e) => {
            eprintln!("[poplet] virtual keyboard error: {e} (is uinput module loaded? run: sudo modprobe uinput)");
            None
        }
    }
}

fn inject_ctrl_v_uinput(kb: &mut evdev::uinput::VirtualDevice) {
    let _ = kb.emit(&[
        InputEvent::new(EventType::KEY, Key::KEY_LEFTCTRL.code(), 1),
        InputEvent::new(EventType::SYNCHRONIZATION, 0, 0),
        InputEvent::new(EventType::KEY, Key::KEY_V.code(), 1),
        InputEvent::new(EventType::SYNCHRONIZATION, 0, 0),
        InputEvent::new(EventType::KEY, Key::KEY_V.code(), 0),
        InputEvent::new(EventType::SYNCHRONIZATION, 0, 0),
        InputEvent::new(EventType::KEY, Key::KEY_LEFTCTRL.code(), 0),
        InputEvent::new(EventType::SYNCHRONIZATION, 0, 0),
    ]);
}

fn capture_active_window() -> Option<String> {
    std::process::Command::new("xdotool")
        .arg("getactivewindow")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn set_pointer_inside(state: tauri::State<'_, AppState>, inside: bool) {
    *state.pointer_inside.lock().unwrap() = inside;
}

#[tauri::command]
pub fn set_hide_on_blur_delay(state: tauri::State<'_, AppState>, delay_ms: u64) {
    *state.hide_on_blur_delay_ms.lock().unwrap() = delay_ms.min(120_000);
}

#[tauri::command]
pub fn set_poplet_window_size(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    let width = if width.is_finite() {
        width.clamp(320.0, 1000.0)
    } else {
        450.0
    };
    let height = if height.is_finite() {
        height.clamp(360.0, 1200.0)
    } else {
        600.0
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = set_hyprland_poplet_fullscreen(false);
        let _ = window.set_fullscreen(false);
        let _ = window.unmaximize();
        let _ = window.set_resizable(true);

        if is_hyprland() {
            // Use hyprctl to resize on Hyprland for reliability with pinned/floating windows
            if let Some(client) = hyprland_poplet_client() {
                let selector = format!("address:{}", client.address);
                let _ = hyprctl(&[
                    "dispatch",
                    "resizewindowpixel",
                    &format!("exact {} {},{}", width as u32, height as u32, selector),
                ]);
                let _ = hyprctl(&["dispatch", "centerwindow", &selector]);
            }
        } else {
            window
                .set_size(tauri::LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            let _ = window.center();
        }
        let _ = window.set_resizable(false);
    }
    Ok(())
}

fn fill_current_monitor(window: &tauri::WebviewWindow) -> Result<(), String> {
    let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? else {
        return Err("Could not find the current monitor for snip mode".to_string());
    };
    let _ = window.set_fullscreen(false);
    let _ = window.unmaximize();
    let _ = window.set_resizable(true);
    window
        .set_position(*monitor.position())
        .map_err(|e| e.to_string())?;
    window
        .set_size(*monitor.size())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct SnipWindowResult {
    width: u32,
    height: u32,
}

#[tauri::command]
pub async fn set_snip_editor_window(
    app: tauri::AppHandle,
    active: bool,
    width: f64,
    height: f64,
    hide_after: Option<bool>,
) -> Result<Option<SnipWindowResult>, String> {
    if let Some(window) = app.get_webview_window("main") {
        if active {
            let _ = window.set_resizable(true);
            if is_hyprland() {
                // Hyprland needs the window visible to dispatch fullscreen.
                // Show and immediately fullscreen to minimize flicker.
                let _ = window.show();
                let _ = window.set_focus();
                tokio::time::sleep(Duration::from_millis(50)).await;
                set_hyprland_poplet_fullscreen(true);
            } else {
                // For other compositors, set fullscreen before showing
                // to avoid any visible resize.
                fill_current_monitor(&window)?;
                window.set_fullscreen(true).map_err(|e| e.to_string())?;
                let _ = window.show();
                let _ = window.set_focus();
            }
            // Yield to let GTK event loop process the configure/resize events
            // from the compositor. This is critical — without yielding, GTK
            // never updates WebKitGTK's rendering surface.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let _ = window.set_focus();
            // Return actual window size in logical (CSS) pixels
            let scale = window.scale_factor().unwrap_or(1.0);
            let size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(
                width as u32,
                height as u32,
            ));
            return Ok(Some(SnipWindowResult {
                width: (size.width as f64 / scale) as u32,
                height: (size.height as f64 / scale) as u32,
            }));
        } else {
            if is_hyprland() {
                set_hyprland_poplet_fullscreen(false);
            } else {
                let _ = window.set_fullscreen(false);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            set_poplet_window_size(app, width, height)?;
            let _ = window.set_resizable(false);
            if hide_after.unwrap_or(false) {
                let _ = window.hide();
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn hide_preview_window() {}

pub(crate) fn toggle_window(app: &tauri::AppHandle) {
    eprintln!("[poplet] toggle: capture_active_window");
    let prev_win = capture_active_window();
    eprintln!("[poplet] toggle: store prev_win");
    if let Some(state) = app.try_state::<AppState>() {
        *state.prev_window_id.lock().unwrap() = prev_win;
    }
    eprintln!("[poplet] toggle: get_webview_window");
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        eprintln!("[poplet] toggle: is_visible={is_visible}");
        if is_visible {
            eprintln!("[poplet] toggle: hide()");
            let _ = window.hide();
            eprintln!("[poplet] toggle: hide() returned");
        } else {
            eprintln!("[poplet] toggle: show()");
            install_hyprland_window_rules();
            let _ = window.set_visible_on_all_workspaces(true);
            let _ = window.show();
            ensure_hyprland_pinned("poplet", "Poplet");
            eprintln!("[poplet] toggle: set_focus()");
            let _ = window.set_focus();
            eprintln!("[poplet] toggle: emit window-shown");
            let _ = app.emit("window-shown", ());
            eprintln!("[poplet] toggle: emit returned");
        }
    } else {
        eprintln!("[poplet] toggle: NO main window found");
    }
}

pub(crate) fn start_snip(app: &tauri::AppHandle) {
    let prev_win = capture_active_window();
    if let Some(state) = app.try_state::<AppState>() {
        *state.prev_window_id.lock().unwrap() = prev_win;
        *state.pending_snip.lock().unwrap() = true;
    }
    let _ = app.emit("start-snip", ());
}

#[tauri::command]
pub fn take_pending_snip(state: tauri::State<'_, AppState>) -> bool {
    let mut pending = state.pending_snip.lock().unwrap();
    let should_start = *pending;
    *pending = false;
    should_start
}

#[tauri::command]
pub async fn perform_paste(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let prev_window = state.prev_window_id.lock().unwrap().clone();

    // Register the blur notifier BEFORE hiding so we cannot miss the event.
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    *state.blur_notify.lock().unwrap() = Some(tx);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    // Wait until on_window_event(Focused(false)) fires, meaning the compositor
    // has confirmed our window lost focus. Timeout at 500ms as a safety net.
    let _ = tokio::time::timeout(Duration::from_millis(500), rx).await;

    // Give the compositor a moment to activate the previous app's surface.
    tokio::time::sleep(Duration::from_millis(80)).await;

    // 1st choice: /dev/uinput — works for ALL apps on Linux regardless of protocol
    let used_uinput = {
        let mut guard = state.virtual_kb.lock().unwrap();
        if let Some(ref mut kb) = *guard {
            let _ = inject_ctrl_v_uinput(kb);
            true
        } else {
            false
        }
    };

    if !used_uinput {
        // 2nd choice: wtype — works on wlroots compositors; usually fails on GNOME
        let wtype_ok = std::env::var("WAYLAND_DISPLAY").is_ok()
            && std::process::Command::new("wtype")
                .args(["-M", "ctrl", "-P", "v", "-p", "v", "-m", "ctrl"])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);

        if !wtype_ok {
            // 3rd choice: xdotool — works for X11 / XWayland apps only
            if let Some(ref win_id) = prev_window {
                let _ = std::process::Command::new("xdotool")
                    .args(["windowfocus", "--sync", win_id])
                    .output();
            }
            let _ = std::process::Command::new("xdotool")
                .args(["key", "--clearmodifiers", "ctrl+v"])
                .spawn();
        }
    }

    Ok(())
}
