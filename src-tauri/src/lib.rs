use arboard::{Clipboard, ImageData};
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
    Text { content: String },
    Image { path: String, width: u32, height: u32 },
}

struct AppState {
    prev_window_id: Mutex<Option<String>>,
    /// Signaled by on_window_event(Focused(false)) so perform_paste knows
    /// the compositor has actually moved focus away before we inject keys.
    blur_notify: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// /dev/uinput virtual keyboard — works for ALL apps (X11, XWayland, native
    /// Wayland) without requiring wtype or ydotool. Requires the user to be in
    /// the `input` group (setup-poplet.sh handles this).
    virtual_kb: Mutex<Option<evdev::uinput::VirtualDevice>>,
}

fn socket_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        PathBuf::from(dir).join("poplet.sock")
    } else {
        PathBuf::from("/tmp/poplet.sock")
    }
}

/// Try to deliver a "toggle" message to the running primary instance.
/// Returns true if the message was sent (caller should exit), false if no
/// primary is reachable (caller should become the primary).
fn send_toggle_via_socket() -> bool {
    match UnixStream::connect(socket_path()) {
        Ok(mut s) => {
            let _ = s.write_all(b"toggle\n");
            let _ = s.flush();
            true
        }
        Err(_) => false,
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

/// Hash the raw RGBA bytes so identical images dedup to the same file.
fn hash_rgba(width: u32, height: u32, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Persist an arboard ImageData as a PNG. Returns (absolute_path, width, height).
fn save_clipboard_image(
    dir: &Path,
    img: &ImageData,
) -> Result<(PathBuf, u32, u32), String> {
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
            let _ = window.show();
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

    // If a primary is already listening on the socket, hand off and exit BEFORE
    // Tauri/WebKit loads. Prevents gsd-media-keys from spawning a fresh ~300MB
    // process on every Super+V press.
    if send_toggle_via_socket() {
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
            blur_notify: Mutex::new(None),
            virtual_kb: Mutex::new(virtual_kb),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            perform_paste,
            set_clipboard_image,
            clear_image_cache
        ])
        .setup(move |app| {
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
                                let _ = s.read(&mut buf);
                                eprintln!("[poplet] toggle requested via socket");
                                let h = lis_handle.clone();
                                let r = lis_handle.run_on_main_thread(move || {
                                    eprintln!("[poplet] toggle: on main thread");
                                    toggle_window(&h);
                                    eprintln!("[poplet] toggle: done");
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

            let handle = app.handle().clone();

            std::thread::spawn(move || {
                let mut clipboard = loop {
                    match Clipboard::new() {
                        Ok(cb) => break cb,
                        Err(_) => std::thread::sleep(Duration::from_secs(2)),
                    }
                };
                let mut last_text = String::new();
                let mut last_image_hash = String::new();

                loop {
                    // Text — cheap to read, check first.
                    let text_seen = if let Ok(text) = clipboard.get_text() {
                        if !text.is_empty() && text != last_text {
                            last_text = text.clone();
                            // Same hash counter for images — text overrides reset.
                            last_image_hash.clear();
                            let _ = handle.emit(
                                "clipboard-changed",
                                ClipboardEvent::Text { content: text },
                            );
                            true
                        } else {
                            !text.is_empty()
                        }
                    } else {
                        false
                    };

                    // Only probe image when there's no text on the clipboard
                    // (otherwise text+image always emits the image too).
                    if !text_seen {
                        if let Ok(img) = clipboard.get_image() {
                            let hash =
                                hash_rgba(img.width as u32, img.height as u32, &img.bytes);
                            if hash != last_image_hash {
                                last_image_hash = hash;
                                if let Ok(dir) = images_dir(&handle) {
                                    if let Ok((path, w, h)) =
                                        save_clipboard_image(&dir, &img)
                                    {
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
                    }

                    std::thread::sleep(Duration::from_millis(500));
                }
            });

            let app_for_blur = app.handle().clone();
            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(focused) = event {
                    if !focused {
                        let _ = window_clone.hide();
                        // Signal perform_paste that focus has actually left our window
                        if let Some(state) = app_for_blur.try_state::<AppState>() {
                            if let Some(tx) = state.blur_notify.lock().unwrap().take() {
                                let _ = tx.send(());
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
