mod capture;
mod clipboard;
mod imaging;
mod shortcuts;
mod vault;
mod window;

use arboard::Clipboard;
use std::io::Read;
use std::os::unix::net::UnixListener;
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
pub(crate) struct CapturedImage {
    pub(crate) path: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) struct AppState {
    pub(crate) prev_window_id: Mutex<Option<String>>,
    pub(crate) pointer_inside: Mutex<bool>,
    pub(crate) pending_snip: Mutex<bool>,
    /// A clipboard value the watcher must NOT record to history (a copied
    /// vault secret). Cleared once the watcher sees and skips it.
    pub(crate) clipboard_skip: Mutex<Option<String>>,
    pub(crate) hide_on_blur_delay_ms: Mutex<u64>,
    /// Signaled by on_window_event(Focused(false)) so window::perform_paste knows
    /// the compositor has actually moved focus away before we inject keys.
    pub(crate) blur_notify: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// /dev/uinput virtual keyboard — works for ALL apps (X11, XWayland, native
    /// Wayland) without requiring wtype or ydotool. Requires the user to be in
    /// the `input` group (setup-poplet.sh handles this).
    pub(crate) virtual_kb: Mutex<Option<evdev::uinput::VirtualDevice>>,
}


pub(crate) fn images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub(crate) fn is_supported_image_path(path: &Path) -> bool {
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


pub(crate) fn executable_exists(name: &str) -> bool {
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path_var).any(|dir| dir.join(name).is_file())
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

/// Run Tesseract OCR on an image file and return the recognized text.
/// Shells out to the `tesseract` binary (same approach as the screen-capture
/// tools) so no native library linkage is required.
#[tauri::command]
async fn extract_text_from_image(path: String) -> Result<String, String> {
    if !executable_exists("tesseract") {
        return Err(
            "Tesseract is not installed. Install it (e.g. `tesseract` + `tesseract-data-eng`) to extract text."
                .to_string(),
        );
    }
    let src = Path::new(&path);
    if !src.is_file() {
        return Err(format!("File not found: {path}"));
    }
    let path = path.clone();
    let output = tokio::task::spawn_blocking(move || {
        // `stdout` output base means tesseract writes the text to stdout.
        std::process::Command::new("tesseract")
            .arg(&path)
            .arg("stdout")
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Tesseract failed: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Copy a vault secret to the clipboard WITHOUT it being recorded to history,
/// and auto-clear it after a short delay.
#[tauri::command]
fn copy_secret(state: tauri::State<'_, AppState>, text: String) -> Result<(), String> {
    *state.clipboard_skip.lock().unwrap() = Some(text.clone());
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(&text).map_err(|e| e.to_string())?;
    let secret = text;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        if let Ok(mut cb) = Clipboard::new() {
            if let Ok(current) = cb.get_text() {
                if current == secret {
                    let _ = cb.set_text("");
                }
            }
        }
    });
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
    if is_snip && window::send_snip_via_socket() {
        return;
    }
    if !is_snip && window::send_toggle_via_socket() {
        return;
    }

    // No primary is reachable — we become it. Remove any stale socket file
    // left by a previous crashed instance (otherwise bind() would fail).
    let _ = std::fs::remove_file(window::socket_path());

    // Try to create the virtual keyboard at startup so it has time to be
    // registered with the kernel before the first paste.
    let virtual_kb = window::build_virtual_keyboard();

    tauri::Builder::default()
        .manage(AppState {
            prev_window_id: Mutex::new(None),
            pointer_inside: Mutex::new(false),
            pending_snip: Mutex::new(false),
            clipboard_skip: Mutex::new(None),
            hide_on_blur_delay_ms: Mutex::new(250),
            blur_notify: Mutex::new(None),
            virtual_kb: Mutex::new(virtual_kb),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(vault::VaultState::default())
        .invoke_handler(tauri::generate_handler![
            window::perform_paste,
            imaging::set_clipboard_image,
            read_and_copy_file_content,
            window::set_pointer_inside,
            window::set_hide_on_blur_delay,
            window::set_poplet_window_size,
            window::hide_preview_window,
            imaging::clear_image_cache,
            capture::capture_screenshot_area,
            imaging::save_annotated_image,
            imaging::import_image,
            imaging::create_blank_canvas,
            imaging::export_pages,
            imaging::read_image_as_data_url,
            imaging::save_data_url_image,
            imaging::write_text_file,
            imaging::read_text_file,
            extract_text_from_image,
            vault::vault_setup,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_is_unlocked,
            vault::vault_encrypt,
            vault::vault_decrypt,
            vault::backup_seal,
            vault::backup_open,
            copy_secret,
            window::set_snip_editor_window,
            shortcuts::apply_system_shortcuts,
            window::take_pending_snip
        ])
        .setup(move |app| {
            window::install_hyprland_window_rules();

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
            match UnixListener::bind(window::socket_path()) {
                Ok(listener) => {
                    eprintln!("[poplet] listening on {}", window::socket_path().display());
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
                                        window::start_snip(&h);
                                    } else {
                                        eprintln!("[poplet] toggle: on main thread");
                                        window::toggle_window(&h);
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
                window::toggle_window(&app.handle().clone());
            }
            if is_snip {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    window::start_snip(&handle);
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
                        let hash = clipboard::hash_rgba(img.width as u32, img.height as u32, &img.bytes);
                        if hash != last_image_hash {
                            last_image_hash = hash;
                            last_text.clear();
                            if let Ok(dir) = images_dir(&handle) {
                                if let Ok((path, w, h)) = clipboard::save_clipboard_image(&dir, &img) {
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
                            // A copied vault secret must never reach history.
                            let skip = handle
                                .try_state::<AppState>()
                                .and_then(|s| s.clipboard_skip.lock().unwrap().clone());
                            if let Some(secret) = skip {
                                if secret == text {
                                    last_text = text.clone();
                                    if let Some(s) = handle.try_state::<AppState>() {
                                        *s.clipboard_skip.lock().unwrap() = None;
                                    }
                                    std::thread::sleep(Duration::from_millis(500));
                                    continue;
                                }
                            }
                            if !text.is_empty() && text != last_text {
                                last_text = text.clone();
                                if let Ok(dir) = images_dir(&handle) {
                                    if let Some(path) = clipboard::image_path_from_clipboard_text(&text) {
                                        if let Ok((path, w, h)) =
                                            clipboard::save_image_file_as_clipboard_image(&dir, &path)
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
                        // Signal window::perform_paste that focus has actually left our window
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
