const { contextBridge, ipcRenderer } = require('electron');

// Clean up all registered listeners on a given channel
function on(channel, fn) {
  ipcRenderer.on(channel, (_e, data) => fn(data));
  return () => ipcRenderer.removeAllListeners(channel);
}

contextBridge.exposeInMainWorld('api', {
  // ── Filesystem ──────────────────────────────
  openFolder:  ()                       => ipcRenderer.invoke('dialog:openFolder'),
  listFiles:   (folder)                 => ipcRenderer.invoke('fs:list', folder),
  readFile:    (folder, file)           => ipcRenderer.invoke('fs:read',    { folder, file }),
  writeFile:   (folder, file, content)  => ipcRenderer.invoke('fs:write',   { folder, file, content }),
  newFile:     (folder, file)           => ipcRenderer.invoke('fs:newFile', { folder, file }),
  deleteFile:  (folder, file)           => ipcRenderer.invoke('fs:delete',  { folder, file }),
  renameFile:  (folder, oldPath, newName) => ipcRenderer.invoke('fs:rename', { folder, oldPath, newName }),

  // ── Ollama chat ─────────────────────────────
  getModels: (host)    => ipcRenderer.invoke('ollama:models', { host }),
  chat:      (payload) => ipcRenderer.invoke('ollama:chat', payload),
  onChunk:   (fn) => on('ollama:chunk', fn),
  onDone:    (fn) => on('ollama:done',  fn),
  onError:   (fn) => on('ollama:error', fn),

  // ── Terminal (node-pty) ──────────────────────
  termCreate: (id, cwd) => ipcRenderer.invoke('term:create', { id, cwd }),
  termWrite:  (id, data) => ipcRenderer.invoke('term:write',  { id, data }),
  termResize: (id, cols, rows) => ipcRenderer.invoke('term:resize', { id, cols, rows }),
  termKill:   (id) => ipcRenderer.invoke('term:kill', { id }),
  onTermData: (id, fn) => on(`term:data:${id}`, fn),
  onTermExit: (id, fn) => on(`term:exit:${id}`, fn),

  // ── VS Code integration ──────────────────────
  vscodeCheck:    ()               => ipcRenderer.invoke('vscode:check'),
  vscodeOpen:     (target)         => ipcRenderer.invoke('vscode:open',     { target }),
  vscodeOpenFile: (folder, file)   => ipcRenderer.invoke('vscode:openFile', { folder, file }),
  openExternal:   (url)            => ipcRenderer.invoke('shell:openExternal', { url }),

  // ── First-run setup ──────────────────────────
  setupStatus:       ()       => ipcRenderer.invoke('setup:status'),
  installOllama:     ()       => ipcRenderer.invoke('setup:installOllama'),
  pullModel:         (model)  => ipcRenderer.invoke('setup:pullModel', { model }),
  startOllama:       ()       => ipcRenderer.invoke('setup:startOllama'),
  onSetupProgress:   (fn)     => on('setup:progress', fn),
});
