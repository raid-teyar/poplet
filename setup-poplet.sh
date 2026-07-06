#!/bin/bash
set -e

# Poplet Setup Script for GNOME / Debian
# Run from the repo root: bash setup-poplet.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY_PATH="$REPO_ROOT/src-tauri/target/release/poplet"

if [ ! -f "$BINARY_PATH" ]; then
    echo "Error: Poplet binary not found at $BINARY_PATH"
    echo "Please run 'npm run tauri build' first."
    exit 1
fi

echo "Setting up Poplet..."

# --- 0. System dependencies ---
echo "Checking dependencies..."
MISSING=""
for cmd in xdotool wtype; do
    if ! command -v "$cmd" &>/dev/null; then
        MISSING="$MISSING $cmd"
    fi
done
# Color emoji font — without this, many emojis render as black-and-white text
if ! fc-list 2>/dev/null | grep -qi "noto color emoji"; then
    MISSING="$MISSING fonts-noto-color-emoji"
fi
if [ -n "$MISSING" ]; then
    echo "Installing:$MISSING"
    sudo apt-get install -y $MISSING
fi

# Optional: Tesseract powers the "Extract text" (OCR) button in the editor.
# Skipped silently if unavailable; install to enable the feature.
if ! command -v tesseract &>/dev/null; then
    echo "Optional: installing tesseract for image OCR (Extract text)..."
    sudo apt-get install -y tesseract-ocr tesseract-ocr-eng || \
        echo "  (skipped — OCR will be unavailable until tesseract is installed)"
fi

# --- 1. uinput kernel module ---
# Required for paste injection into all apps (including native Wayland apps like Zed).
# xdotool only works for XWayland apps; uinput works universally.
if ! lsmod | grep -q "^uinput"; then
    echo "Loading uinput kernel module..."
    sudo modprobe uinput
fi
# Persist across reboots
if [ ! -f /etc/modules-load.d/uinput.conf ]; then
    echo "uinput" | sudo tee /etc/modules-load.d/uinput.conf > /dev/null
fi

# --- 2. /dev/uinput group permissions ---
UDEV_RULE='KERNEL=="uinput", GROUP="input", MODE="0660"'
UDEV_FILE="/etc/udev/rules.d/99-uinput.rules"
if [ ! -f "$UDEV_FILE" ] || ! grep -qF "$UDEV_RULE" "$UDEV_FILE"; then
    echo "Setting udev rule for /dev/uinput..."
    echo "$UDEV_RULE" | sudo tee "$UDEV_FILE" > /dev/null
    sudo udevadm control --reload-rules
fi
# Apply permissions to the live device immediately (udev handles it on next boot)
if [ "$(stat -c '%G' /dev/uinput 2>/dev/null)" != "input" ]; then
    sudo chgrp input /dev/uinput
    sudo chmod 660 /dev/uinput
fi

# --- 3. input group membership ---
NEED_REBOOT=0
if ! id -nG "$USER" | grep -qw input; then
    echo "Adding $USER to the 'input' group..."
    sudo usermod -aG input "$USER"
    NEED_REBOOT=1
fi

# --- 4. Keyboard shortcuts ---
add_gnome_shortcut() {
    local id="$1"
    local name="$2"
    local command="$3"
    local binding="$4"
    local keypath="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/$id/"

    gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:"$keypath" name "$name"
    gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:"$keypath" command "$command"
    gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:"$keypath" binding "$binding"

    CURRENT_BINDINGS=$(gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings)
    if [[ ! "$CURRENT_BINDINGS" == *"$keypath"* ]]; then
        if [ "$CURRENT_BINDINGS" = "@as []" ] || [ "$CURRENT_BINDINGS" = "[]" ]; then
            gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "['$keypath']"
        else
            NEW_BINDINGS="${CURRENT_BINDINGS%]*}, '$keypath']"
            gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "$NEW_BINDINGS"
        fi
    fi
}

if [ -n "$HYPRLAND_INSTANCE_SIGNATURE" ] && command -v hyprctl &>/dev/null; then
    echo "Configuring live Hyprland shortcuts..."
    hyprctl keyword bind "SUPER, V, exec, $BINARY_PATH --toggle" >/dev/null || true
    hyprctl keyword bind "SUPER SHIFT, S, exec, $BINARY_PATH --snip" >/dev/null || true
    hyprctl keyword bind "CTRL SHIFT, F, fullscreen, 0" >/dev/null || true
    echo "For persistence, add these to ~/.config/hypr/hyprland.conf:"
    echo "  bind = SUPER, V, exec, $BINARY_PATH --toggle"
    echo "  bind = SUPER SHIFT, S, exec, $BINARY_PATH --snip"
    echo "  bind = CTRL SHIFT, F, fullscreen, 0"
elif command -v gsettings &>/dev/null; then
    echo "Configuring GNOME shortcuts..."
    add_gnome_shortcut "poplet" "Poplet" "$BINARY_PATH --toggle" "<Super>v"
    add_gnome_shortcut "poplet-snip" "Poplet Snip" "$BINARY_PATH --snip" "<Super><Shift>s"
else
    echo "Skipping desktop shortcuts: no supported shortcut tool was found."
fi

# --- 5. Remove old .desktop autostart (caused GDM failures) ---
if [ -f "$HOME/.config/autostart/poplet.desktop" ]; then
    echo "Removing old .desktop autostart entry..."
    rm -f "$HOME/.config/autostart/poplet.desktop"
fi

# --- 6. Systemd user service (starts after full graphical session is ready) ---
echo "Installing systemd user service..."
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/poplet.service" <<EOF
[Unit]
Description=Poplet Clipboard Manager
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=$BINARY_PATH
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
EOF

systemctl --user daemon-reload
systemctl --user enable poplet.service

# --- 7. Start Poplet (or ask for reboot first) ---
if [ "$NEED_REBOOT" = "1" ]; then
    echo ""
    echo "Setup complete, but a reboot is required for the 'input' group to take effect."
    echo "After rebooting, Poplet will start automatically on login."
    echo ""
    echo "  sudo reboot"
else
    echo "Starting Poplet..."
    systemctl --user stop poplet.service 2>/dev/null || pkill -x poplet 2>/dev/null || true
    systemctl --user start poplet.service
    echo ""
    echo "Done! Use Super+V to open Poplet."
fi
