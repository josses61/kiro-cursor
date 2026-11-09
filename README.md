# DevPilot — Local AI Code Editor

A **Cursor/VS Code-style Electron desktop app** with an integrated terminal, AI chat powered by a local Ollama model, and VS Code integration. Packages into a single `.exe` installer.

---

## Features

| Feature | Details |
|---|---|
| **Auto-setup** | Detects Ollama on first launch; installs and pulls the model automatically |
| **Monaco editor** | Full VS Code editor engine: syntax highlighting for 30+ languages, Ctrl+S save, minimap |
| **Integrated terminal** | Real PowerShell/bash terminal with xterm.js rendering, Ctrl+` toggle, multiple tabs, drag to resize |
| **AI chat** | Streams responses from local Ollama, markdown-rendered with code blocks + Copy button |
| **Agent mode** | AI proposes `<edit file="...">` patches with Apply + Diff buttons |
| **VS Code integration** | Open current workspace or active file directly in VS Code |
| **File explorer** | Collapsible folder tree, file icons, right-click menu (delete, copy path, open in VS Code) |
| **Model picker** | Dropdown populated from your local Ollama models |

---

## Run in dev

```powershell
npm install
npm start
```

On first launch DevPilot checks Ollama and the default model, walking through install/pull if needed.

---

## Build a distributable `.exe`

```powershell
npm run build
```

This produces `dist/DevPilot Setup 1.0.0.exe` — a standard Windows NSIS installer with:
- Desktop shortcut
- Start menu entry
- Add/Remove Programs entry
- Selectable install directory

> **Optional:** Add a `build/icon.ico` (256×256 or multi-res) before building to use a custom icon. See `build/README.md`.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` | Send chat message |
| `Ctrl+S` | Save active file |
| `` Ctrl+` `` | Toggle terminal |
| `Ctrl+W` | Close / clear chat |

---

## VS Code integration

When VS Code is detected on your system, two buttons appear:

- **VS Code** (top bar) — opens the current workspace folder in VS Code
- **↗ VS Code** (tab bar) — opens the currently active file in VS Code at the right line

---

## Terminal

- Launches in the workspace folder automatically when you open a project
- Uses **node-pty** (full PTY) when available, falls back to **PowerShell spawn** otherwise
- `Ctrl+`` `` opens/closes the terminal
- Click **+** to open additional terminal tabs
- Drag the resize handle to adjust terminal height
- The AI can see recent terminal output when "Terminal context" is checked

---

## Project structure

```
main.js          — Electron main: IPC, Ollama streaming, terminal (pty+fallback), VS Code, setup
preload.js       — Secure IPC bridge (window.api)
renderer/
  index.html     — HTML shell: setup overlay, editor, terminal, chat
  renderer.js    — All UI logic: setup, Monaco, file tree, terminal, chat, agent mode
  styles.css     — Full dark theme
build/
  installer.nsh  — NSIS installer customization
  README.md      — Icon instructions
package.json     — Scripts, dependencies, electron-builder config
```
