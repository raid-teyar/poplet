use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose, Engine as _};
use evdev::{uinput::VirtualDeviceBuilder, AttributeSet, EventType, InputEvent, Key};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

/// Payload for the `clipboard-changed` event sent to the frontend.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ClipboardEvent {
    Text {
        content: String,
    },
    Image {
        path: String,
        width: u32,
        height: u32,
    },
}

#[derive(serde::Serialize)]
struct CapturedImage {
    path: String,
    width: u32,
    height: u32,
}

#[derive(serde::Serialize)]
struct ShortcutApplyResult {
    desktop: String,
    applied: bool,
    message: String,
}

struct AppState {
    prev_window_id: Mutex<Option<String>>,
    pointer_inside: Mutex<bool>,
    pending_snip: Mutex<bool>,
    hide_on_blur_delay_ms: Mutex<u64>,
    /// Signaled by on_window_event(Focused(false)) so perform_paste knows
    /// the compositor has actually moved focus away before we inject keys.
    blur_notify: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// /dev/uinput virtual keyboard — works for ALL apps (X11, XWayland, native
    /// Wayland) without requiring wtype or ydotool. Requires the user to be in
    /// the `input` group (setup-poplet.sh handles this).
    virtual_kb: Mutex<Option<evdev::uinput::VirtualDevice>>,
}

#[derive(serde::Deserialize)]
struct HyprClient {
    address: String,
    class: String,
    title: String,
    floating: bool,
    pinned: bool,
    fullscreen: Option<serde_json::Value>,
}

fn socket_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        PathBuf::from(dir).join("poplet.sock")
    } else {
        PathBuf::from("/tmp/poplet.sock")
    }
}

fn is_hyprland() -> bool {
    std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok()
}

fn current_exe_command(arg: &str) -> String {
    std::env::current_exe()
        .map(|path| format!("{} {arg}", path.to_string_lossy()))
        .unwrap_or_else(|_| format!("poplet {arg}"))
}

fn hyprctl(args: &[&str]) -> bool {
    std::process::Command::new("hyprctl")
        .args(args)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn install_hyprland_window_rules() {
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
fn send_toggle_via_socket() -> bool {
    send_socket_message("toggle")
}

fn send_snip_via_socket() -> bool {
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

fn parse_shortcut(shortcut: &str) -> Result<(Vec<String>, String), String> {
    let parts: Vec<String> = shortcut
        .split('+')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    if parts.len() < 2 {
        return Err("Use a shortcut like Super+V or Super+Shift+S".to_string());
    }
    let key = parts.last().cloned().unwrap_or_default();
    let modifiers = parts[..parts.len() - 1].to_vec();
    Ok((modifiers, key))
}

fn shortcut_to_gnome(shortcut: &str) -> Result<String, String> {
    let (modifiers, key) = parse_shortcut(shortcut)?;
    let mut binding = String::new();
    for modifier in modifiers {
        let normalized = match modifier.to_ascii_lowercase().as_str() {
            "super" | "meta" | "win" => "Super",
            "shift" => "Shift",
            "ctrl" | "control" => "Control",
            "alt" => "Alt",
            other => return Err(format!("Unsupported modifier for GNOME: {other}")),
        };
        binding.push_str(&format!("<{normalized}>"));
    }
    binding.push_str(&key.to_ascii_lowercase());
    Ok(binding)
}

fn shortcut_to_hyprland(shortcut: &str) -> Result<(String, String), String> {
    let (modifiers, key) = parse_shortcut(shortcut)?;
    let mut hypr_mods = Vec::new();
    for modifier in modifiers {
        let normalized = match modifier.to_ascii_lowercase().as_str() {
            "super" | "meta" | "win" => "SUPER",
            "shift" => "SHIFT",
            "ctrl" | "control" => "CTRL",
            "alt" => "ALT",
            other => return Err(format!("Unsupported modifier for Hyprland: {other}")),
        };
        hypr_mods.push(normalized);
    }
    Ok((hypr_mods.join(" "), key.to_ascii_uppercase()))
}

fn configure_gnome_shortcut(
    id: &str,
    name: &str,
    command: &str,
    shortcut: &str,
) -> Result<(), String> {
    let binding = shortcut_to_gnome(shortcut)?;
    let keypath = format!("/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/{id}/");
    let schema =
        format!("org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{keypath}");

    for (key, value) in [
        ("name", name),
        ("command", command),
        ("binding", binding.as_str()),
    ] {
        let status = std::process::Command::new("gsettings")
            .args(["set", &schema, key, value])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("gsettings rejected the shortcut update".to_string());
        }
    }

    let output = std::process::Command::new("gsettings")
        .args([
            "get",
            "org.gnome.settings-daemon.plugins.media-keys",
            "custom-keybindings",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let current = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if current.contains(&keypath) {
        return Ok(());
    }
    let next = if current == "@as []" || current == "[]" || current.is_empty() {
        format!("['{keypath}']")
    } else if current.ends_with(']') {
        format!("{}, '{keypath}']", current.trim_end_matches(']'))
    } else {
        return Err("Could not parse current GNOME shortcut list".to_string());
    };
    let status = std::process::Command::new("gsettings")
        .args([
            "set",
            "org.gnome.settings-daemon.plugins.media-keys",
            "custom-keybindings",
            &next,
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("gsettings rejected the custom shortcut list".to_string())
    }
}

fn configure_hyprland_shortcut(command: &str, shortcut: &str) -> Result<(), String> {
    let (mods, key) = shortcut_to_hyprland(shortcut)?;
    let bind = format!("{mods}, {key}, exec, {command}");
    if hyprctl(&["keyword", "bind", &bind]) {
        Ok(())
    } else {
        Err("hyprctl could not update the live Hyprland bind".to_string())
    }
}

fn configure_hyprland_dispatch_shortcut(
    dispatcher: &str,
    argument: &str,
    shortcut: &str,
) -> Result<(), String> {
    let (mods, key) = shortcut_to_hyprland(shortcut)?;
    let bind = format!("{mods}, {key}, {dispatcher}, {argument}");
    if hyprctl(&["keyword", "bind", &bind]) {
        Ok(())
    } else {
        Err("hyprctl could not update the live Hyprland bind".to_string())
    }
}

fn build_virtual_keyboard() -> Option<evdev::uinput::VirtualDevice> {
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

fn images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn is_supported_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff"
            )
        })
        .unwrap_or(false)
}

fn decode_file_uri(uri: &str) -> String {
    let stripped = uri.strip_prefix("file://").unwrap_or(uri);
    stripped
        .replace("%20", " ")
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%5B", "[")
        .replace("%5D", "]")
}

fn extract_img_src(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let img_pos = lower.find("<img")?;
    let tail = &text[img_pos..];
    let lower_tail = &lower[img_pos..];
    let src_pos = lower_tail.find("src")?;
    let after_src = &tail[src_pos + 3..];
    let eq_pos = after_src.find('=')?;
    let value = after_src[eq_pos + 1..].trim_start();
    let quote = value.chars().next()?;
    if quote == '"' || quote == '\'' {
        let rest = &value[quote.len_utf8()..];
        let end = rest.find(quote)?;
        Some(rest[..end].to_string())
    } else {
        let end = value
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(value.len());
        Some(value[..end].to_string())
    }
}

fn image_path_from_clipboard_text(text: &str) -> Option<PathBuf> {
    let candidate = extract_img_src(text).unwrap_or_else(|| {
        text.lines()
            .find(|line| {
                let trimmed = line.trim();
                !trimmed.is_empty() && !trimmed.starts_with('#')
            })
            .unwrap_or(text)
            .trim()
            .to_string()
    });
    let path_text = if candidate.starts_with("file://") {
        decode_file_uri(&candidate)
    } else {
        candidate
    };
    let path = PathBuf::from(path_text.trim());
    if path.is_file() && is_supported_image_path(&path) {
        Some(path)
    } else {
        None
    }
}

/// Hash the raw RGBA bytes so identical images dedup to the same file.
fn hash_rgba(width: u32, height: u32, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Persist an arboard ImageData as a PNG. Returns (absolute_path, width, height).
fn save_clipboard_image(dir: &Path, img: &ImageData) -> Result<(PathBuf, u32, u32), String> {
    let w = img.width as u32;
    let h = img.height as u32;
    let hash = hash_rgba(w, h, &img.bytes);
    let path = dir.join(format!("{hash}.png"));
    if !path.exists() {
        let buf = image::RgbaImage::from_raw(w, h, img.bytes.to_vec())
            .ok_or_else(|| "RGBA buffer size mismatch".to_string())?;
        buf.save(&path).map_err(|e| e.to_string())?;
    }
    Ok((path, w, h))
}

fn save_image_file_as_clipboard_image(
    dir: &Path,
    path: &Path,
) -> Result<(PathBuf, u32, u32), String> {
    let img = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    let data = ImageData {
        width: w as usize,
        height: h as usize,
        bytes: Cow::Owned(img.into_raw()),
    };
    save_clipboard_image(dir, &data)
}

fn executable_exists(name: &str) -> bool {
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path_var).any(|dir| dir.join(name).is_file())
}

fn run_capture_command(path: &Path) -> Result<(), String> {
    if executable_exists("grim") && executable_exists("slurp") {
        let geometry = std::process::Command::new("slurp")
            .output()
            .map_err(|e| e.to_string())?;
        if !geometry.status.success() {
            return Err("Screen area selection was cancelled".to_string());
        }
        let geometry = String::from_utf8_lossy(&geometry.stdout).trim().to_string();
        if geometry.is_empty() {
            return Err("Screen area selection was cancelled".to_string());
        }
        let status = std::process::Command::new("grim")
            .args(["-g", &geometry])
            .arg(path)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
    }

    if executable_exists("gnome-screenshot") {
        let status = std::process::Command::new("gnome-screenshot")
            .args(["-a", "-f"])
            .arg(path)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
    }

    if executable_exists("maim") {
        let status = std::process::Command::new("maim")
            .arg("-s")
            .arg(path)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
    }

    if executable_exists("import") {
        let status = std::process::Command::new("import")
            .arg(path)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
    }

    Err("Install grim + slurp, gnome-screenshot, maim, or ImageMagick import to capture a screen area".to_string())
}

#[tauri::command]
fn clear_image_cache(app: tauri::AppHandle) -> Result<(), String> {
    let dir = images_dir(&app)?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

#[tauri::command]
async fn capture_screenshot_area(app: tauri::AppHandle) -> Result<CapturedImage, String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    tokio::time::sleep(Duration::from_millis(180)).await;

    let dir = images_dir(&app)?;
    let path = dir.join(format!(
        "snip-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    ));

    let capture_result = tokio::task::spawn_blocking({
        let path = path.clone();
        move || run_capture_command(&path)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Window stays hidden here — set_snip_editor_window will show it
    // after fullscreen is applied to prevent flicker.

    capture_result?;
    let img = image::open(&path).map_err(|e| e.to_string())?;

    Ok(CapturedImage {
        path: path.to_string_lossy().into_owned(),
        width: img.width(),
        height: img.height(),
    })
}

#[tauri::command]
fn save_annotated_image(
    app: tauri::AppHandle,
    base_path: String,
    drawing_data_url: String,
) -> Result<CapturedImage, String> {
    let encoded = drawing_data_url
        .split_once(',')
        .map(|(_, data)| data)
        .ok_or_else(|| "Invalid image data URL".to_string())?;
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    let mut base = image::open(&base_path)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let mut drawing = image::load_from_memory(&bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    if drawing.dimensions() != base.dimensions() {
        drawing = image::imageops::resize(
            &drawing,
            base.width(),
            base.height(),
            image::imageops::FilterType::Nearest,
        );
    }
    image::imageops::overlay(&mut base, &drawing, 0, 0);
    let (width, height) = (base.width(), base.height());
    let data = ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::Owned(base.into_raw()),
    };
    let dir = images_dir(&app)?;
    let (path, width, height) = save_clipboard_image(&dir, &data)?;
    set_clipboard_image(path.to_string_lossy().into_owned())?;
    Ok(CapturedImage {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
    })
}

#[tauri::command]
fn set_clipboard_image(path: String) -> Result<(), String> {
    let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(ImageData {
            width: w as usize,
            height: h as usize,
            bytes: Cow::Owned(img.into_raw()),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_and_copy_file_content(path: String) -> Result<String, String> {
    let file_path = Path::new(&path);
    if !file_path.is_file() {
        return Err(format!("File not found: {path}"));
    }
    let metadata = std::fs::metadata(file_path).map_err(|e| e.to_string())?;
    // Limit to 10MB to prevent memory issues with large files
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("File too large (>10MB)".to_string());
    }
    let content = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(&content).map_err(|e| e.to_string())?;
    Ok(content)
}

#[tauri::command]
fn set_pointer_inside(state: tauri::State<'_, AppState>, inside: bool) {
    *state.pointer_inside.lock().unwrap() = inside;
}

#[tauri::command]
fn set_hide_on_blur_delay(state: tauri::State<'_, AppState>, delay_ms: u64) {
    *state.hide_on_blur_delay_ms.lock().unwrap() = delay_ms.min(120_000);
}

#[tauri::command]
fn set_poplet_window_size(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
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
struct SnipWindowResult {
    width: u32,
    height: u32,
}

#[tauri::command]
async fn set_snip_editor_window(
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
fn apply_system_shortcuts(
    poplet_shortcut: String,
    snip_shortcut: String,
    fullscreen_shortcut: Option<String>,
) -> Result<ShortcutApplyResult, String> {
    let toggle_command = current_exe_command("--toggle");
    let snip_command = current_exe_command("--snip");

    if is_hyprland() {
        configure_hyprland_shortcut(&toggle_command, &poplet_shortcut)?;
        configure_hyprland_shortcut(&snip_command, &snip_shortcut)?;
        if let Some(shortcut) = fullscreen_shortcut.filter(|shortcut| !shortcut.trim().is_empty()) {
            configure_hyprland_dispatch_shortcut("fullscreen", "0", &shortcut)?;
        }
        return Ok(ShortcutApplyResult {
            desktop: "Hyprland".to_string(),
            applied: true,
            message: "Updated the live Hyprland binds. Add the same binds to hyprland.conf if you want them to persist after reload.".to_string(),
        });
    }

    if executable_exists("gsettings") {
        configure_gnome_shortcut("poplet", "Poplet", &toggle_command, &poplet_shortcut)?;
        configure_gnome_shortcut("poplet-snip", "Poplet Snip", &snip_command, &snip_shortcut)?;
        return Ok(ShortcutApplyResult {
            desktop: "GNOME".to_string(),
            applied: true,
            message: "Updated GNOME custom keyboard shortcuts.".to_string(),
        });
    }

    Ok(ShortcutApplyResult {
        desktop: "Unknown".to_string(),
        applied: false,
        message: "Saved shortcuts in Poplet, but this desktop was not updated automatically."
            .to_string(),
    })
}

#[tauri::command]
fn hide_preview_window() {}

fn toggle_window(app: &tauri::AppHandle) {
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

fn start_snip(app: &tauri::AppHandle) {
    let prev_win = capture_active_window();
    if let Some(state) = app.try_state::<AppState>() {
        *state.prev_window_id.lock().unwrap() = prev_win;
        *state.pending_snip.lock().unwrap() = true;
    }
    let _ = app.emit("start-snip", ());
}

#[tauri::command]
fn take_pending_snip(state: tauri::State<'_, AppState>) -> bool {
    let mut pending = state.pending_snip.lock().unwrap();
    let should_start = *pending;
    *pending = false;
    should_start
}

#[tauri::command]
async fn perform_paste(
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let is_toggle = args.iter().any(|a| a == "--toggle");
    let is_snip = args.iter().any(|a| a == "--snip");

    // If a primary is already listening on the socket, hand off and exit BEFORE
    // Tauri/WebKit loads. Prevents gsd-media-keys from spawning a fresh ~300MB
    // process on every Super+V press.
    if is_snip && send_snip_via_socket() {
        return;
    }
    if !is_snip && send_toggle_via_socket() {
        return;
    }

    // No primary is reachable — we become it. Remove any stale socket file
    // left by a previous crashed instance (otherwise bind() would fail).
    let _ = std::fs::remove_file(socket_path());

    // Try to create the virtual keyboard at startup so it has time to be
    // registered with the kernel before the first paste.
    let virtual_kb = build_virtual_keyboard();

    tauri::Builder::default()
        .manage(AppState {
            prev_window_id: Mutex::new(None),
            pointer_inside: Mutex::new(false),
            pending_snip: Mutex::new(false),
            hide_on_blur_delay_ms: Mutex::new(250),
            blur_notify: Mutex::new(None),
            virtual_kb: Mutex::new(virtual_kb),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            perform_paste,
            set_clipboard_image,
            read_and_copy_file_content,
            set_pointer_inside,
            set_hide_on_blur_delay,
            set_poplet_window_size,
            hide_preview_window,
            clear_image_cache,
            capture_screenshot_area,
            save_annotated_image,
            set_snip_editor_window,
            apply_system_shortcuts,
            take_pending_snip
        ])
        .setup(move |app| {
            install_hyprland_window_rules();

            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show Poplet", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = app.emit("window-shown", ());
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            // Listen on a Unix socket for "toggle" messages from `poplet --toggle`
            // invocations spawned by gsd-media-keys. Avoids signal-handling
            // complexity (signals + tokio + Tauri caused segfaults).
            match UnixListener::bind(socket_path()) {
                Ok(listener) => {
                    eprintln!("[poplet] listening on {}", socket_path().display());
                    let lis_handle = app.handle().clone();
                    std::thread::spawn(move || {
                        for stream in listener.incoming() {
                            if let Ok(mut s) = stream {
                                let mut buf = [0u8; 32];
                                let len = s.read(&mut buf).unwrap_or(0);
                                let message =
                                    String::from_utf8_lossy(&buf[..len]).trim().to_string();
                                eprintln!("[poplet] {message} requested via socket");
                                let h = lis_handle.clone();
                                let r = lis_handle.run_on_main_thread(move || {
                                    if message == "snip" {
                                        start_snip(&h);
                                    } else {
                                        eprintln!("[poplet] toggle: on main thread");
                                        toggle_window(&h);
                                        eprintln!("[poplet] toggle: done");
                                    }
                                });
                                eprintln!("[poplet] dispatch ok={}", r.is_ok());
                            }
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[poplet] socket bind failed: {e}");
                }
            }

            // Cold-start case: launched directly with --toggle when no primary
            // exists yet (e.g. user pressed Super+V before the systemd service
            // started). Open the window immediately.
            if is_toggle {
                toggle_window(&app.handle().clone());
            }
            if is_snip {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    start_snip(&handle);
                });
            }

            let handle = app.handle().clone();

            std::thread::spawn(move || {
                let mut clipboard = loop {
                    match Clipboard::new() {
                        Ok(cb) => break cb,
                        Err(_) => std::thread::sleep(Duration::from_secs(2)),
                    }
                };
                let mut last_image_hash = String::new();
                let mut last_text = String::new();

                loop {
                    let mut saw_image = false;

                    if let Ok(img) = clipboard.get_image() {
                        saw_image = true;
                        let hash = hash_rgba(img.width as u32, img.height as u32, &img.bytes);
                        if hash != last_image_hash {
                            last_image_hash = hash;
                            last_text.clear();
                            if let Ok(dir) = images_dir(&handle) {
                                if let Ok((path, w, h)) = save_clipboard_image(&dir, &img) {
                                    let _ = handle.emit(
                                        "clipboard-changed",
                                        ClipboardEvent::Image {
                                            path: path.to_string_lossy().into_owned(),
                                            width: w,
                                            height: h,
                                        },
                                    );
                                }
                            }
                        }
                    }

                    if !saw_image {
                        if let Ok(text) = clipboard.get_text() {
                            if !text.is_empty() && text != last_text {
                                last_text = text.clone();
                                if let Ok(dir) = images_dir(&handle) {
                                    if let Some(path) = image_path_from_clipboard_text(&text) {
                                        if let Ok((path, w, h)) =
                                            save_image_file_as_clipboard_image(&dir, &path)
                                        {
                                            last_image_hash = path
                                                .file_stem()
                                                .and_then(|s| s.to_str())
                                                .unwrap_or_default()
                                                .to_string();
                                            let _ = handle.emit(
                                                "clipboard-changed",
                                                ClipboardEvent::Image {
                                                    path: path.to_string_lossy().into_owned(),
                                                    width: w,
                                                    height: h,
                                                },
                                            );
                                            std::thread::sleep(Duration::from_millis(500));
                                            continue;
                                        }
                                    }
                                }
                                last_image_hash.clear();
                                let _ = handle.emit(
                                    "clipboard-changed",
                                    ClipboardEvent::Text { content: text },
                                );
                            }
                        }
                    }

                    std::thread::sleep(Duration::from_millis(500));
                }
            });

            let app_for_blur = app.handle().clone();
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_visible_on_all_workspaces(true);
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(focused) = event {
                    if !focused {
                        // Signal perform_paste that focus has actually left our window
                        if let Some(state) = app_for_blur.try_state::<AppState>() {
                            if let Some(tx) = state.blur_notify.lock().unwrap().take() {
                                let _ = tx.send(());
                            }
                            let app = app_for_blur.clone();
                            let window = window_clone.clone();
                            let delay_ms = *state.hide_on_blur_delay_ms.lock().unwrap();
                            tauri::async_runtime::spawn(async move {
                                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                                if let Some(state) = app.try_state::<AppState>() {
                                    let pointer_inside = *state.pointer_inside.lock().unwrap();
                                    let focused = window.is_focused().unwrap_or(false);
                                    if !pointer_inside && !focused {
                                        let _ = window.hide();
                                    }
                                }
                            });
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
