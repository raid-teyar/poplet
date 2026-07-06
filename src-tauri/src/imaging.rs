//! Image compositing, blank canvases, page export, clipboard-image writing,
//! and file/data-url helpers used by the editor.

use crate::clipboard::{save_clipboard_image, save_image_file_as_clipboard_image};
use crate::{images_dir, is_supported_image_path, CapturedImage};
use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose, Engine as _};
use std::borrow::Cow;
use std::path::Path;

#[tauri::command]
pub fn clear_image_cache(app: tauri::AppHandle) -> Result<(), String> {
    let dir = images_dir(&app)?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Composite a transparent drawing layer (a data URL produced by the editor
/// canvas) over a base image, returning the flattened RGBA image.
fn composite_drawing(base_path: &str, drawing_data_url: &str) -> Result<image::RgbaImage, String> {
    let encoded = drawing_data_url
        .split_once(',')
        .map(|(_, data)| data)
        .ok_or_else(|| "Invalid image data URL".to_string())?;
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    let mut base = image::open(base_path).map_err(|e| e.to_string())?.to_rgba8();
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
    Ok(base)
}

#[tauri::command]
pub fn save_annotated_image(
    app: tauri::AppHandle,
    base_path: String,
    drawing_data_url: String,
) -> Result<CapturedImage, String> {
    let base = composite_drawing(&base_path, &drawing_data_url)?;
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

#[derive(serde::Deserialize)]
pub struct PageExport {
    base_path: String,
    drawing_data_url: String,
}

/// Export every editor page, in order, as zero-padded PNG files into `dir`.
/// Returns the number of pages written.
#[tauri::command]
pub fn export_pages(dir: String, pages: Vec<PageExport>) -> Result<usize, String> {
    let out_dir = Path::new(&dir);
    if !out_dir.is_dir() {
        return Err(format!("Not a folder: {dir}"));
    }
    let total = pages.len();
    for (i, page) in pages.iter().enumerate() {
        let composed = composite_drawing(&page.base_path, &page.drawing_data_url)?;
        let name = format!("poplet-page-{:02}.png", i + 1);
        composed
            .save(out_dir.join(name))
            .map_err(|e| e.to_string())?;
    }
    Ok(total)
}

/// Import an arbitrary image file (chosen via the native dialog) into the app
/// images dir so it lives inside the asset-protocol scope and can be loaded
/// into the editor.
#[tauri::command]
pub fn import_image(app: tauri::AppHandle, path: String) -> Result<CapturedImage, String> {
    let src = Path::new(&path);
    if !src.is_file() {
        return Err(format!("File not found: {path}"));
    }
    if !is_supported_image_path(src) {
        return Err("Unsupported image type".to_string());
    }
    let dir = images_dir(&app)?;
    let (path, width, height) = save_image_file_as_clipboard_image(&dir, src)?;
    Ok(CapturedImage {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
    })
}

/// Parse a "#rrggbb" string into RGBA bytes. Falls back to opaque white.
fn parse_hex_color(color: &str) -> [u8; 4] {
    let hex = color.trim().trim_start_matches('#');
    if hex.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&hex[0..2], 16),
            u8::from_str_radix(&hex[2..4], 16),
            u8::from_str_radix(&hex[4..6], 16),
        ) {
            return [r, g, b, 255];
        }
    }
    [255, 255, 255, 255]
}

/// Create a solid-color PNG of the given dimensions, used as a blank editing
/// surface. Returns the saved file as a CapturedImage.
#[tauri::command]
pub fn create_blank_canvas(
    app: tauri::AppHandle,
    width: u32,
    height: u32,
    color: String,
) -> Result<CapturedImage, String> {
    let w = width.clamp(16, 8000);
    let h = height.clamp(16, 8000);
    let rgba = parse_hex_color(&color);
    let buf = image::RgbaImage::from_pixel(w, h, image::Rgba(rgba));
    let data = ImageData {
        width: w as usize,
        height: h as usize,
        bytes: Cow::Owned(buf.into_raw()),
    };
    let dir = images_dir(&app)?;
    let (path, width, height) = save_clipboard_image(&dir, &data)?;
    Ok(CapturedImage {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
    })
}

/// Read an image file and return it as a PNG data URL (used when serializing a
/// project so base images travel inside the project file).
#[tauri::command]
pub fn read_image_as_data_url(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let b64 = general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// Decode a PNG data URL and save it into the app images dir (used when loading
/// a project so each page gets a real, scope-allowed file path again).
#[tauri::command]
pub fn save_data_url_image(
    app: tauri::AppHandle,
    data_url: String,
) -> Result<CapturedImage, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, d)| d)
        .ok_or_else(|| "Invalid image data URL".to_string())?;
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let (w, h) = (img.width(), img.height());
    let data = ImageData {
        width: w as usize,
        height: h as usize,
        bytes: Cow::Owned(img.into_raw()),
    };
    let dir = images_dir(&app)?;
    let (path, width, height) = save_clipboard_image(&dir, &data)?;
    Ok(CapturedImage {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
    })
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 200 * 1024 * 1024 {
        return Err("Project file too large (>200MB)".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_clipboard_image(path: String) -> Result<(), String> {
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
