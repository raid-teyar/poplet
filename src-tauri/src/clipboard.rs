//! Clipboard-content helpers: parsing image references out of clipboard text
//! (file:// URIs, <img> tags, plain paths), hashing/deduping images, and
//! persisting arboard image data to disk. Used by the clipboard watcher and
//! the editor's import path.

use crate::is_supported_image_path;
use arboard::ImageData;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::path::{Path, PathBuf};

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

pub(crate) fn image_path_from_clipboard_text(text: &str) -> Option<PathBuf> {
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
pub(crate) fn hash_rgba(width: u32, height: u32, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Persist an arboard ImageData as a PNG. Returns (absolute_path, width, height).
pub(crate) fn save_clipboard_image(dir: &Path, img: &ImageData) -> Result<(PathBuf, u32, u32), String> {
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

pub(crate) fn save_image_file_as_clipboard_image(
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
