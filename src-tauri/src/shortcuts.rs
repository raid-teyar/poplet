//! Desktop keyboard-shortcut registration (GNOME gsettings / Hyprland binds).

use crate::executable_exists;
use crate::window::{current_exe_command, hyprctl, is_hyprland};

#[derive(serde::Serialize)]
pub struct ShortcutApplyResult {
    desktop: String,
    applied: bool,
    message: String,
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

#[tauri::command]
pub fn apply_system_shortcuts(
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
