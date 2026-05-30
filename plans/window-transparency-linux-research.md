# Window-Level Background Transparency on Linux (Obsidian/Electron)

## Context

Obsidian exposes an OS-level "Translucent window" toggle **only on macOS**. On Linux, CSS
snippets can make workspace/leaf backgrounds transparent, but you still see Obsidian's own
opaque window backing — not the desktop behind it ("partway", as observed). The goal is to
get genuine window-level background transparency on **Linux**, and to understand which
Electron APIs make this possible and which don't.

This research establishes *why* it's macOS-only today and what is actually achievable on
Linux, then plans the one shippable Crucible feature plus a documented power-user path.

---

## Findings: the Electron transparency API landscape

Electron exposes **three different** transparency mechanisms, and critically, only one is
runtime-mutable on each platform:

| Mechanism | API | Runtime-settable? | Platforms | Effect |
|---|---|---|---|---|
| Window transparency | `transparent: true` (constructor only) | **No — creation-time only** | all (Linux fragile) | True background-only see-through (text stays crisp) |
| Vibrancy | `win.setVibrancy(type)` | **Yes** | **macOS only** | Native NSVisualEffectView blur |
| System material | `win.setBackgroundMaterial('mica'\|'acrylic')` | **Yes** | **Windows 11 only** (Electron 30+) | Mica/acrylic blur |
| Uniform opacity | `win.setOpacity(0–1)` | Yes | macOS, Windows | Fades **whole** window |

**Why Obsidian's toggle is macOS-only:** `setVibrancy` is the *only* transparency API that
can be turned on/off at runtime on macOS. Obsidian's main process calls it when you toggle
"Translucent window", and CSS supplies the transparent backgrounds for the desktop/blur to
show through. There is no equivalent runtime API on Linux.

**The Linux blocker (the key finding):**
- `transparent: true` **must be passed when the `BrowserWindow` is constructed and cannot be
  changed afterward.** Obsidian's *main* process owns window creation; a plugin runs in the
  *renderer*, which loads only after the window already exists.
- `setVibrancy` → macOS only. `setBackgroundMaterial` → Windows only.
- `win.setOpacity()` is a **confirmed no-op on Linux** (electron/electron#23922).

⇒ **A pure Obsidian plugin cannot enable true window transparency on Linux at runtime.**
There is no API surface for it. This must be stated up front — the macOS-style "flip a
setting" experience is not reproducible on Linux from within a plugin.

What *is* possible on Linux splits into two paths with a real tradeoff:

- **Compositor uniform opacity** (`_NET_WM_WINDOW_OPACITY` via picom/xprop): works on any X11
  window today, no Obsidian modification — but fades the **entire** window uniformly,
  including text and UI. Good for a "glassy" look; cannot keep text opaque.
- **Electron `transparent:true` + CSS**: gives background-**only** transparency (crisp text,
  see-through background) — but requires patching how Obsidian constructs its window
  (asar patch). Not a plugin; breaks on every Obsidian update; Linux transparency also needs
  a compositing WM and the `--enable-transparent-visuals` flag, and is historically fragile.

---

## Recommended approach (Linux)

Ship **Path A** as a Crucible feature (the realistic, maintainable win), and **document
Path B** as an advanced opt-in for users who want true background-only transparency.

### Path A — Crucible "Window opacity" command + setting (shippable, X11)

A renderer-side feature that drives the compositor's per-window opacity. Uniform opacity, but
real, runtime, no Obsidian modification.

How it works:
1. Get the X11 window id (XID) of Obsidian's window from the renderer:
   `require('@electron/remote').getCurrentWindow().getNativeWindowHandle()` returns a Buffer
   holding the XID on X11 (`buf.readUInt32LE(0)`). *Confirm `@electron/remote` is the correct
   require in current Obsidian during implementation (fall back to `require('electron').remote`).*
2. Set opacity by shelling out to `picom-trans -w <xid> <0–100>` (or `xprop -id <xid> -f
   _NET_WM_WINDOW_OPACITY 32c -set _NET_WM_WINDOW_OPACITY <0xFFFFFFFF-scaled>`), reusing the
   **existing lazy `child_process` loader pattern** in `src/providers.ts:4-30` (desktop-only,
   `require('child_process')`).
3. Guard the feature:
   - `Platform.isLinux` (pattern already used in `src/utils.ts:16`).
   - Detect Wayland (`process.env.WAYLAND_DISPLAY` / `XDG_SESSION_TYPE === 'wayland'`) and
     `picom`/`xprop` availability; if Wayland or no compositor, show a notice pointing to
     Path B / compositor window rules instead of silently failing.

Files to touch (reuse existing patterns, don't introduce new infra):
- `src/main.ts` — register a command near the existing `this.addCommand({…})` at
  `src/main.ts:428` (e.g. "Set window opacity"); optionally a small modal/slider.
- `src/settings.ts` — add a "Window transparency (Linux/X11)" section to
  `CrucibleSettingTab` (`src/settings.ts:84`): opacity slider + apply-on-startup toggle,
  persisted in the plugin settings + restored in `onload`.
- New small helper `src/windowOpacity.ts` — XID lookup + compositor invocation, importing the
  `child_process` accessor style from `src/providers.ts`.

Limitation to surface in the setting's description: this fades the whole window uniformly
(text included); for crisp-text + transparent-background, see Path B.

### Path B — True background-only transparency (documented, not shipped in plugin)

For users who want crisp text over a see-through background, document a power-user recipe:
1. Repack Obsidian's `app.asar`/main bundle so the `BrowserWindow` is created with
   `transparent: true` and `backgroundColor: "#00000000"`.
2. Launch Obsidian with `--enable-transparent-visuals` (and a compositing WM; some
   GPU/driver combos additionally need `--disable-gpu`).
3. Apply a CSS snippet making `.workspace`, `body`, and leaf backgrounds transparent.

Deliver this as a `docs/`/`plans/` note (and optionally a patch helper script), clearly
flagged as fragile and reset by every Obsidian update. Do **not** bundle asar-patching into
the plugin.

---

## Verification

- **Path A (X11):** Build the plugin, load in Obsidian on an X11 session with `picom` running.
  Run the "Set window opacity" command / move the slider → Obsidian window (and visible
  desktop behind it) becomes translucent in real time; setting persists across restart if the
  apply-on-startup toggle is on. Confirm graceful notice on Wayland and when `picom`/`xprop`
  are absent. Cross-check the XID by comparing `getNativeWindowHandle().readUInt32LE(0)`
  against `xprop`/`wmctrl -l` for the Obsidian window.
- **Path B:** After patching + flag + CSS snippet, confirm desktop shows through the editor
  background while text remains fully opaque; note exact Obsidian/Electron version tested.

---

## Sources
- [Electron BrowserWindow docs](https://www.electronjs.org/docs/latest/api/browser-window)
- [transparent option / allowable bg colors (#14762)](https://github.com/electron/electron/pull/14762)
- [Mica/Acrylic on Windows (#38163)](https://github.com/electron/electron/pull/38163/files)
- [setOpacity not implemented on Linux (#23922)](https://github.com/electron/electron/issues/23922)
- [Linux transparency requires --enable-transparent-visuals (#15947, #25153)](https://github.com/electron/electron/issues/15947)
- [@electron/remote getCurrentWindow](https://github.com/electron/remote)
- [Obsidian Electron Window Tweaker plugin (precedent for renderer-side window APIs)](https://www.obsidianstats.com/plugins/obsidian-electron-window-tweaker)
- [picom-trans / _NET_WM_WINDOW_OPACITY](https://picom.app/picom-trans.1.html)
