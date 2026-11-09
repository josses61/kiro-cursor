const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execFile, spawn, exec } = require('child_process');
const os = require('os');

const APP_NAME = 'DevPilot';
const DEFAULT_MODEL = 'llama3.2';
const OLLAMA_HOST = 'http://localhost:11434';

// node-pty is a native module — gracefully fail if not built yet
let pty;
try { pty = require('@homebridge/node-pty-prebuilt-multiarch'); } catch { pty = null; }

// Fallback: track if we're using pty or basic spawn-based terminal
const HAS_PTY = !!pty;

let mainWindow;

// ──────────────────────────────────────────────
// Window
// ──────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#0b0f14',
    title: APP_NAME,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  // Kill all active ptys on quit
  for (const entry of activePtys.values()) {
    try { entry.handle ? entry.handle.kill() : entry.kill(); } catch {}
  }
  if (process.platform !== 'darwin') app.quit();
});

// ──────────────────────────────────────────────
// Path helpers
// ──────────────────────────────────────────────

function safeResolve(base, target) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(base, target);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase)
    throw new Error('Path escapes workspace');
  return resolved;
}

// ──────────────────────────────────────────────
// Filesystem IPC
// ──────────────────────────────────────────────

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

function walkDir(dir, base, out, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target']);
  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory()
      ? a.name.localeCompare(b.name)
      : a.isDirectory() ? -1 : 1
  );
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      out.push({ type: 'dir', name: e.name, path: rel, depth });
      walkDir(full, base, out, depth + 1);
    } else {
      out.push({ type: 'file', name: e.name, path: rel, depth });
    }
  }
}

ipcMain.handle('fs:list', async (_e, folder) => {
  if (!folder) return [];
  const out = [];
  walkDir(folder, folder, out, 0);
  return out.slice(0, 5000);
});

ipcMain.handle('fs:read', async (_e, { folder, file }) => {
  const full = safeResolve(folder, file);
  const buf = fs.readFileSync(full);
  if (buf.length > 2 * 1024 * 1024) return { tooLarge: true, content: buf.slice(0, 2 * 1024 * 1024).toString('utf8') };
  return { content: buf.toString('utf8') };
});

ipcMain.handle('fs:write', async (_e, { folder, file, content }) => {
  const full = safeResolve(folder, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return { ok: true };
});

ipcMain.handle('fs:newFile', async (_e, { folder, file }) => {
  const full = safeResolve(folder, file);
  if (fs.existsSync(full)) return { ok: false, error: 'File already exists' };
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '', 'utf8');
  return { ok: true };
});

ipcMain.handle('fs:delete', async (_e, { folder, file }) => {
  const full = safeResolve(folder, file);
  fs.rmSync(full, { recursive: true, force: true });
  return { ok: true };
});

ipcMain.handle('fs:rename', async (_e, { folder, oldPath, newName }) => {
  const oldFull = safeResolve(folder, oldPath);
  const newFull = path.join(path.dirname(oldFull), newName);
  fs.renameSync(oldFull, newFull);
  return { ok: true, newPath: path.relative(folder, newFull) };
});

// ──────────────────────────────────────────────
// Ollama helpers
// ──────────────────────────────────────────────

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ ok: true, body: JSON.parse(data) }); }
        catch { resolve({ ok: true, body: data }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
  });
}

async function ollamaRunning(host) {
  const r = await httpGet(`${host}/api/tags`, 3000);
  return r.ok && r.body && Array.isArray(r.body.models);
}

async function modelPulled(host, modelName) {
  const r = await httpGet(`${host}/api/tags`, 3000);
  if (!r.ok || !Array.isArray(r.body.models)) return false;
  return r.body.models.some((m) => m.name === modelName || m.name.startsWith(modelName + ':'));
}

ipcMain.handle('ollama:models', async (_e, { host }) => {
  const url = new URL('/api/tags', host || OLLAMA_HOST);
  return await new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Invalid response', raw: data }); }
      });
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ error: 'Timeout' }); });
  });
});

ipcMain.handle('ollama:chat', async (e, payload) => {
  const { host, model, messages, streamId } = payload;
  const url = new URL('/api/chat', host || OLLAMA_HOST);
  const body = JSON.stringify({ model, messages, stream: true });
  return await new Promise((resolve) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
              const json = JSON.parse(line);
              if (json.message && json.message.content)
                e.sender.send('ollama:chunk', { streamId, content: json.message.content });
              if (json.done) e.sender.send('ollama:done', { streamId });
            } catch {}
          }
        });
        res.on('end', () => resolve({ ok: true }));
      }
    );
    req.on('error', (err) => {
      e.sender.send('ollama:error', { streamId, error: err.message });
      resolve({ error: err.message });
    });
    req.write(body);
    req.end();
  });
});

// ──────────────────────────────────────────────
// Terminal (node-pty with spawn fallback)
// ──────────────────────────────────────────────

const activePtys = new Map();   // id -> pty/proc handle

ipcMain.handle('term:create', (e, { cwd, id }) => {
  const workDir = (cwd && fs.existsSync(cwd)) ? cwd : os.homedir();

  // ── node-pty path ──────────────────────────
  if (HAS_PTY) {
    const shell = process.platform === 'win32'
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/bash');

    try {
      const p = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 120, rows: 30,
        cwd: workDir,
        env: { ...process.env },
      });

      activePtys.set(id, { type: 'pty', handle: p });

      p.onData((data) => { try { e.sender.send(`term:data:${id}`, data); } catch {} });
      p.onExit(({ exitCode }) => {
        activePtys.delete(id);
        try { e.sender.send(`term:exit:${id}`, { exitCode }); } catch {}
      });

      return { ok: true, mode: 'pty' };
    } catch (err) {
      // pty.spawn failed — fall through to spawn fallback
    }
  }

  // ── Spawn fallback (no node-pty) ──────────
  // Uses PowerShell on Windows; bash on Unix.
  // Not a full PTY but functional for running commands.
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const args  = isWin ? ['-NoLogo', '-NoExit'] : [];

  const proc = spawn(shell, args, {
    cwd: workDir,
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: false,
  });

  activePtys.set(id, { type: 'spawn', handle: proc });

  const encoder = new TextEncoder();

  proc.stdout.on('data', (d) => {
    try { e.sender.send(`term:data:${id}`, d.toString('utf8')); } catch {}
  });
  proc.stderr.on('data', (d) => {
    try { e.sender.send(`term:data:${id}`, d.toString('utf8')); } catch {}
  });
  proc.on('close', (code) => {
    activePtys.delete(id);
    try { e.sender.send(`term:exit:${id}`, { exitCode: code }); } catch {}
  });
  proc.on('error', (err) => {
    try { e.sender.send(`term:data:${id}`, `\r\n\x1b[31mShell error: ${err.message}\x1b[0m\r\n`); } catch {}
  });

  return { ok: true, mode: 'spawn' };
});

ipcMain.handle('term:write', (_e, { id, data }) => {
  const entry = activePtys.get(id);
  if (!entry) return { ok: false };
  if (entry.type === 'pty') entry.handle.write(data);
  else if (entry.handle.stdin && !entry.handle.stdin.destroyed) entry.handle.stdin.write(data);
  return { ok: true };
});

ipcMain.handle('term:resize', (_e, { id, cols, rows }) => {
  const entry = activePtys.get(id);
  if (entry && entry.type === 'pty') entry.handle.resize(cols, rows);
  return { ok: true };
});

ipcMain.handle('term:kill', (_e, { id }) => {
  const entry = activePtys.get(id);
  if (entry) {
    try {
      if (entry.type === 'pty') entry.handle.kill();
      else entry.handle.kill();
    } catch {}
    activePtys.delete(id);
  }
  return { ok: true };
});

// ──────────────────────────────────────────────
// VS Code integration
// ──────────────────────────────────────────────

async function findVSCode() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft VS Code', 'Code.exe'),
        'code', // if in PATH
      ]
    : process.platform === 'darwin'
    ? ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', 'code']
    : ['code', '/usr/bin/code', '/snap/bin/code'];

  for (const c of candidates) {
    const found = await new Promise((resolve) => {
      // For full paths, check existence; for bare 'code', try execFile
      if (c.includes(path.sep) || c.includes('/')) {
        resolve(fs.existsSync(c) ? c : null);
      } else {
        execFile(c, ['--version'], { timeout: 3000 }, (err) => resolve(err ? null : c));
      }
    });
    if (found) return found;
  }
  return null;
}

ipcMain.handle('vscode:check', async () => {
  const codePath = await findVSCode();
  return { available: !!codePath, path: codePath };
});

ipcMain.handle('vscode:open', async (_e, { target }) => {
  const codePath = await findVSCode();
  if (!codePath) return { ok: false, error: 'VS Code not found' };
  return await new Promise((resolve) => {
    const proc = spawn(codePath, [target], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    proc.unref();
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
    // Give it a moment then assume success
    setTimeout(() => resolve({ ok: true }), 500);
  });
});

ipcMain.handle('vscode:openFile', async (_e, { folder, file }) => {
  const codePath = await findVSCode();
  if (!codePath) return { ok: false, error: 'VS Code not found' };
  const full = safeResolve(folder, file);
  return await new Promise((resolve) => {
    const proc = spawn(codePath, ['--goto', full], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    proc.unref();
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
    setTimeout(() => resolve({ ok: true }), 500);
  });
});

ipcMain.handle('shell:openExternal', async (_e, { url }) => {
  await shell.openExternal(url);
  return { ok: true };
});

// ──────────────────────────────────────────────
// Setup / first-run IPC
// ──────────────────────────────────────────────

ipcMain.handle('setup:status', async () => {
  const platform = process.platform;
  const model = DEFAULT_MODEL;
  const installed = await new Promise((resolve) => {
    execFile('ollama', ['--version'], { timeout: 4000 }, (err) => resolve(!err));
  });
  const running = installed ? await ollamaRunning(OLLAMA_HOST) : false;
  const pulled = running ? await modelPulled(OLLAMA_HOST, model) : false;
  return { ollamaInstalled: installed, ollamaRunning: running, modelPulled: pulled, model, platform };
});

ipcMain.handle('setup:installOllama', async (e) => {
  const send = (msg) => { try { e.sender.send('setup:progress', msg); } catch {} };
  const platform = process.platform;
  const tmpDir = os.tmpdir();
  try {
    if (platform === 'win32') {
      const installerUrl = 'https://ollama.com/download/OllamaSetup.exe';
      const dest = path.join(tmpDir, 'OllamaSetup.exe');
      send('Downloading Ollama installer...');
      await downloadFile(installerUrl, dest, (pct) => send(`Downloading Ollama... ${pct}%`));
      send('Running installer silently...');
      await new Promise((resolve, reject) => {
        const proc = spawn(dest, ['/SILENT'], { detached: false });
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Installer exited ${code}`))));
        proc.on('error', reject);
      });
      send('Ollama installed. Waiting for service...');
      await waitForOllama(OLLAMA_HOST, 30, send);
    } else if (platform === 'darwin') {
      const zipUrl = 'https://ollama.com/download/Ollama-darwin.zip';
      const dest = path.join(tmpDir, 'Ollama-darwin.zip');
      send('Downloading Ollama for macOS...');
      await downloadFile(zipUrl, dest, (pct) => send(`Downloading... ${pct}%`));
      send('Installing...');
      await runCmd('unzip', ['-o', dest, '-d', '/Applications']);
      await runCmd('open', ['-a', 'Ollama']);
      await waitForOllama(OLLAMA_HOST, 30, send);
    } else {
      send('Installing Ollama via official script...');
      await new Promise((resolve, reject) => {
        const proc = spawn('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { stdio: 'pipe' });
        proc.stdout.on('data', (d) => send(d.toString().trim()));
        proc.stderr.on('data', (d) => send(d.toString().trim()));
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Script exited ${code}`))));
        proc.on('error', reject);
      });
      await waitForOllama(OLLAMA_HOST, 30, send);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('setup:pullModel', async (e, { model }) => {
  const send = (msg) => { try { e.sender.send('setup:progress', msg); } catch {} };
  const name = model || DEFAULT_MODEL;
  send(`Pulling model "${name}" — this may take a few minutes...`);
  return await new Promise((resolve) => {
    const proc = spawn('ollama', ['pull', name], { stdio: 'pipe' });
    proc.stdout.on('data', (d) => send(d.toString().trim()));
    proc.stderr.on('data', (d) => send(d.toString().trim()));
    proc.on('close', (code) => {
      if (code === 0) { send(`Model "${name}" ready.`); resolve({ ok: true }); }
      else resolve({ ok: false, error: `ollama pull exited ${code}` });
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

ipcMain.handle('setup:startOllama', async (e) => {
  const send = (msg) => { try { e.sender.send('setup:progress', msg); } catch {} };
  send('Starting Ollama service...');
  const proc = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  proc.unref();
  const ok = await waitForOllama(OLLAMA_HOST, 20, send);
  return ok ? { ok: true } : { ok: false, error: 'Ollama did not start in time' };
});

// ──────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    function doRequest(reqUrl) {
      const mod = reqUrl.startsWith('https') ? https : http;
      mod.get(reqUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          doRequest(res.headers.location);
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total && onProgress) onProgress(Math.round((received / total) * 100));
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    }
    doRequest(url);
  });
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    proc.on('error', reject);
  });
}

async function waitForOllama(host, retries, send) {
  for (let i = 0; i < retries; i++) {
    const ok = await ollamaRunning(host);
    if (ok) return true;
    if (send && i % 3 === 0) send(`Waiting for Ollama... (${i + 1}/${retries})`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
