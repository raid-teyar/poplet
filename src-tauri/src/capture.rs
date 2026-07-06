//! Screen-area capture — shells out to whatever screenshot tool is installed.

use crate::{executable_exists, images_dir, CapturedImage};
use std::path::Path;
use std::time::Duration;
use tauri::Manager;

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
pub async fn capture_screenshot_area(app: tauri::AppHandle) -> Result<CapturedImage, String> {
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
