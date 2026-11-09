# DevPilot — Local AI Code Editor

A lightweight **Electron desktop app** with a dark Cursor-style UI and an AI chat panel powered by a **local Ollama model**. On first launch, DevPilot detects whether Ollama is installed and whether the default model has been downloaded — and walks you through setup automatically if anything is missing.

## Features

- **Auto-setup on first run** — detects Ollama installation, starts the service, and pulls the default model (`llama3.2`) automatically.
- **Cursor-like layout** — workspace/folder explorer, central code editor (Monaco when available), AI side panel.
- **Local Ollama chat** — streams responses from `http://localhost:11434` (configurable).
- **AI chat with code context** — optionally includes the active file in prompts.
- **Agent (propose edits) mode** — asks the model to propose file changes in a structured `<edit file="...">...</edit>` format. Proposed edits appear with **Review & Apply** buttons.
- **Model/host settings** — choose the Ollama host and model from the top bar.

## Setup & Run

From this folder:

```powershell
npm install
npm start
```

On first launch:
1. DevPilot checks if Ollama is installed and running.
2. If Ollama is missing, click **Install Ollama & pull model automatically** — this downloads and runs the Ollama installer, then pulls `llama3.2`.
3. If Ollama is installed but the model isn't pulled yet, it pulls it automatically.
4. Once everything is ready, the editor opens.

> **Note:** The first model pull downloads ~2 GB. Subsequent launches skip this entirely.

## Using the editor

1. Click **Open Folder** and select a project/workspace.
2. Open a file from the explorer.
3. Set **Ollama** host/model if needed, then click **Check** to verify connectivity.
4. Use **Chat** mode for Q&A, or **Agent (propose edits)** to request changes and apply proposed edits.

Press `Ctrl+Enter` in the prompt box to send.

## How Agent edits work

In **Agent** mode, the assistant emits structured change proposals:

```text
<edit file="relative/path/to/file.js">
...full new file content...
</edit>
```

The app parses these and shows an **Apply** button per file. Applying writes the file to the opened workspace (with a path-traversal safety check). Always review before applying.

## Project structure

```
main.js          — Electron main process (window, file system IPC, Ollama streaming proxy, setup/install IPC)
preload.js       — Safe IPC bridge (window.api)
renderer/
  index.html     — HTML shell: setup overlay + main editor layout
  renderer.js    — UI logic: setup flow, Monaco editor, file ops, chat, streaming, agent edits
  styles.css     — Dark theme, setup overlay styles
package.json     — Scripts / dependencies
```

## Notes / Limitations

- No LSP, git UI, or terminal — this is a practical AI editing scaffold.
- Monaco loads from `node_modules/monaco-editor`; falls back to a plain textarea if it fails.
- File explorer is a simplified flat view (excludes `node_modules`, `.git`, build dirs).
- Ollama must stay running for chat to work after the initial setup.
