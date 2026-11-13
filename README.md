# DevPilot — Local AI code editor

DevPilot is a desktop code editor built with Electron that talks to a model running on your own
machine through [Ollama](https://ollama.com). It gives you the three things a coding agent needs:
a real editor, a real terminal, and a model that can propose changes to your files.

Nothing is uploaded. There is no account, no API key and no telemetry — point it at your local
Ollama instance and it stays there.

---

## Features

- **Monaco editor** — the same editor component VS Code uses, with the usual language support.
- **Real terminal** — xterm.js backed by `node-pty`, so shells, pipes and interactive programs work.
- **File explorer** — open a folder and browse it; the editor, terminal and agent all work against it.
- **Streaming chat** — responses stream token by token from Ollama's `/api/chat` endpoint.
- **Agent mode** — ask for a change and the model answers with concrete file edits. Each proposal
  is shown as a diff with an **Apply** button; nothing touches your files until you click it.
- **Two model modes** — *chat* for questions, *agent* for edits. Agent mode uses a stricter prompt
  that forces the model to answer with edits in a fixed format.
- **Setup assistant** — on first launch DevPilot checks whether Ollama is installed, whether the
  service is running and whether your model is pulled, and offers to fix each of them for you,
  including a one-click install and model pull.

---

## Requirements

- **Node.js 18 or newer** (to run from source)
- **Ollama** — <https://ollama.com/download>

DevPilot talks to Ollama over HTTP. By default it looks at `http://localhost:11434` and uses the
`llama3.2` model.

---

## Quick start

```bash
git clone https://github.com/josses61/kiro-cursor.git
cd kiro-cursor

npm install
npm start
```

On first launch, follow the setup assistant: it will offer to install Ollama, start the service and
pull the model.

### Scripts

| Command | What it does |
|---|---|
| `npm start` | Runs the Electron app |
| `npm run dev` | Same as `npm start` |
| `npm run build` | Builds a Windows installer (NSIS, x64) into `dist/` |
| `npm run build:mac` | Builds a macOS `.dmg` |
| `npm run build:linux` | Builds a Linux `.AppImage` |
| `npm run rebuild` | Rebuilds native dependencies for Electron |

---

## Building an installer

```bash
npm install
npm run build          # Windows installer
npm run build:mac      # macOS disk image
npm run build:linux    # Linux AppImage
```

Output lands in `dist/`. The Windows build uses NSIS with a desktop and Start-menu shortcut; the
Mac build lands in the developer-tools category; the Linux build produces an AppImage.

---

## How the agent mode works

Agent mode does not edit files behind your back. The renderer asks Ollama for a response in a
fixed shape — a list of file paths, the new content for each, and a short reason. The proposals
are rendered as an editable list with an **Apply** button per change. You can apply one change or
all of them.

If no folder is open, the agent says so instead of guessing at a path.

---

## Project layout

```
kiro-cursor/
├── main.js               Electron main process: windows, IPC, Ollama HTTP calls
├── preload.js            context bridge exposing the IPC API to the renderer
├── renderer/
│   ├── index.html        app shell
│   ├── renderer.js       editor, terminal, chat and agent-mode logic
│   └── styles.css        UI styling
├── build/
│   └── installer.nsh     custom NSIS script for the Windows build
└── package.json          electron-builder configuration
```

---

## Configuration

DevPilot reads its defaults from `main.js`:

| Setting | Default | Where to change |
|---|---|---|
| Ollama host | `http://localhost:11434` | `OLLAMA_HOST` in `main.js` |
| Model | `llama3.2` | `DEFAULT_MODEL` in `main.js` |
| App id | `com.devpilot.app` | `build.appId` in `package.json` |

The host is also editable from the setup screen, so you can point DevPilot at Ollama on another
machine.

---

## Troubleshooting

**"Ollama error: is Ollama running?"** — the app cannot reach the Ollama HTTP API. Check that
`ollama serve` is running and that `http://localhost:11434/api/tags` responds.

**The model never answers** — the chat request is streaming, so a model that is still loading
looks like a hang. Open a terminal and run `ollama pull llama3.2` to warm it up.

**Terminal shows garbled characters** — that is the Windows console code page, not DevPilot.

---

## Contributing

Pull requests are welcome. The renderer talks to the main process only through the preload bridge,
so keep new backend work in `main.js` and expose it there first.

---

## License

No license file has been added yet. Ask before reusing the code.
