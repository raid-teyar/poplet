# Snipping Tool

## Overview

Poplet's snipping tool allows users to capture a region of the screen, annotate it with drawing tools (pencil, eraser, shapes), and save the result to the clipboard. The annotated image is also stored in clipboard history.

## Dependencies

- **grim** -- Wayland screenshot utility (captures screen regions)
- **slurp** -- Wayland region selection tool (provides geometry for grim)

Install on Arch Linux:
```sh
pacman -S grim slurp
```

Fallback capture tools (used if grim+slurp are not available):
- `gnome-screenshot` -- GNOME's built-in area capture
- `maim` -- X11 area selection capture
- `import` (ImageMagick) -- last resort fallback

## Architecture

The snipping workflow spans three layers:

```
Frontend (React)          Service Layer            Backend (Rust/Tauri)
─────────────────         ─────────────────        ─────────────────────
App.tsx                   snipService.ts           lib.rs
SnipEditor.tsx                                     (capture, annotate, window mgmt)
useDrawingEngine.ts                                (stroke engine, undo/redo)
```

## Workflow

### 1. Trigger

The user clicks the scissors icon in the tab bar, presses the configured snip shortcut (default: `Super+Shift+S`), or the app receives a `start-snip` event via the IPC socket.

### 2. Capture (`capture_screenshot_area`)

1. The Poplet window is hidden so it doesn't appear in the screenshot.
2. After a brief delay (180ms) for the compositor to hide the window, a screen capture tool is invoked.
3. Supported capture tools (tried in order):
   - **grim + slurp** (Wayland) -- user selects a region with slurp, grim captures it
   - **gnome-screenshot** -- GNOME's built-in area capture
   - **maim** -- X11 area selection capture
   - **import** (ImageMagick) -- fallback
4. The captured image is saved as `snip-<timestamp>.png` in the app's image cache directory.
5. The window stays hidden until fullscreen is applied (prevents UI flicker).

### 3. Window Maximization (`set_snip_editor_window`)

After capture, the window is maximized to provide a full-screen editing canvas:

1. Window is made resizable and shown.
2. **Hyprland**: Uses `hyprctl dispatch fullscreen 1` (maximize) after unpinning if needed.
3. **Other compositors**: Uses Tauri's `set_fullscreen(true)` after positioning/sizing to the current monitor.
4. The command is `async` -- it yields with `tokio::time::sleep` between steps so the GTK event loop can process compositor configure events and update WebKitGTK's rendering surface. This is critical on Wayland where external window resizing doesn't automatically trigger viewport updates in WebKitGTK.

### 4. Annotation (SnipEditor component)

The snip editor presents a full-screen canvas with a toolbar:

**Toolbar layout:**
```
[Snip] ── [Pencil|Eraser|Line|Rect|Circle] [Colors] [●━━ Width] [Undo|Redo] [Clear] [X]
```

**Drawing tools:**
- **Pencil** -- freehand drawing in the active color
- **Eraser** -- removes drawn strokes (reveals image beneath)
- **Line** -- draw straight lines between two points
- **Rectangle** -- draw rectangles by dragging corner to corner
- **Circle** -- draw ellipses by dragging bounding box

**Features:**
- 5 color options (red, yellow, green, blue, white)
- Stroke width slider (0.1 - 3.0, continuously adjustable)
- Undo/Redo with full stroke history
- Custom SVG cursors that reflect active tool, color, and size
- Shape preview while dragging (live feedback before committing)

**Technical implementation:**
- Stroke-based history model (`useDrawingEngine` hook) -- each drawing action stored as a typed object
- Eraser uses `globalCompositeOperation = "destination-out"` on the transparent overlay canvas
- Shapes preview by redrawing all committed strokes + in-progress shape on each `pointerMove`
- Width scales proportionally to canvas: `(canvasWidth / 180) * strokeWidth`

### 5. Save (`save_annotated_image`)

1. The canvas drawing is exported as a PNG data URL.
2. The backend decodes the base64 data, loads both the base image and the drawing overlay.
3. The drawing is resized to match the base image dimensions if needed.
4. The drawing is composited over the base image using alpha blending.
5. The final image is saved to the cache directory and copied to the system clipboard.
6. The image path is returned and added to clipboard history.

### 6. Window Restoration (`restoreSnipWindow`)

1. Fullscreen/maximize is toggled off.
2. Window is resized back to the user's configured dimensions.
3. Window is made non-resizable again.
4. Optionally hidden (if triggered via shortcut and the window should auto-hide).

## Key Technical Details

### WebKitGTK Viewport on Wayland

WebKitGTK does not automatically update its CSS viewport when the window is resized by the compositor (e.g., via Hyprland's fullscreen dispatch). The fix: `set_snip_editor_window` is an `async` Tauri command that uses `tokio::time::sleep().await` instead of `std::thread::sleep()`. This yields control back to the GTK main thread event loop, allowing it to process the Wayland configure events and update the webview's rendering surface before the frontend renders the editor.

### Hyprland Integration

- The window has compositor rules for `pin`, `float`, and `center`.
- Before fullscreening, the pin is removed (pinned windows can't be fullscreened).
- After restoring, the pin is re-applied.
- `fullscreen 1` (maximize) is used instead of `fullscreen 0` (true fullscreen) to respect panels like waybar.

### Flicker Prevention

- The `snip-active` CSS class is applied immediately when snip starts (before any backend calls), hiding the normal Poplet UI.
- The window stays hidden during capture and is only shown once fullscreen is ready.
- This ensures the user never sees the normal 450x600 Poplet UI flash during the transition.

### File Storage

Snip images are stored in `<app_data_dir>/images/` with SHA-256 content hashing to deduplicate identical captures.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `snipShortcut` | `Super+Shift+S` | System shortcut to trigger snip |
| `snipPencilWidth` | `0.25` | Initial stroke width (adjustable via slider during editing) |
