/* global monaco, Terminal, FitAddon, WebLinksAddon */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // ════════════════════════════════════════════
  // FIRST-RUN SETUP
  // ════════════════════════════════════════════
  const overlay   = $('setupOverlay');
  const appShell  = $('appShell');
  const stepsEl   = $('setupSteps');
  const logEl     = $('setupLog');
  const actionsEl = $('setupActions');

  function logMsg(text) {
    if (!text || !text.trim()) return;
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderSteps(items) {
    stepsEl.innerHTML = '';
    const icons = { done: '✓', pending: '○', active: '⟳', skip: '–' };
    for (const item of items) {
      const div = document.createElement('div');
      div.className = `step-item step-${item.state}`;
      div.innerHTML = `<span class="step-icon">${icons[item.state] || '○'}</span> ${item.label}`;
      stepsEl.appendChild(div);
    }
  }

  function clearActions() { actionsEl.innerHTML = ''; }

  function addAction(label, cls, onClick) {
    const btn = document.createElement('button');
    btn.className = `btn ${cls}`;
    btn.textContent = label;
    btn.onclick = onClick;
    actionsEl.appendChild(btn);
    return btn;
  }

  window.api.onSetupProgress(logMsg);

  async function runSetup() {
    overlay.classList.remove('hidden');
    logMsg('Checking environment...');
    const status = await window.api.setupStatus();

    const steps = [
      { label: 'Install Ollama',        state: status.ollamaInstalled ? 'done' : 'pending' },
      { label: 'Start Ollama service',  state: status.ollamaRunning   ? 'done' : status.ollamaInstalled ? 'pending' : 'skip' },
      { label: `Pull ${status.model}`,  state: status.modelPulled     ? 'done' : 'pending' },
    ];
    renderSteps(steps);

    if (status.ollamaInstalled && status.ollamaRunning && status.modelPulled) {
      logMsg('All good — launching DevPilot!');
      setTimeout(showApp, 600);
      return;
    }

    if (!status.ollamaInstalled) {
      logMsg('Ollama is not installed.');
      clearActions();
      addAction('Auto-install Ollama + pull model', 'primary', async () => {
        clearActions();
        steps[0].state = 'active'; renderSteps(steps);
        const r = await window.api.installOllama();
        if (!r.ok) {
          logMsg(`Install failed: ${r.error}`);
          logMsg('Please install manually: https://ollama.com/download — then restart DevPilot.');
          addAction('Open ollama.com', 'ghost', () => window.api.openExternal('https://ollama.com/download'));
          addAction('Retry', 'btn', () => { logEl.innerHTML = ''; runSetup(); });
          return;
        }
        steps[0].state = 'done'; steps[1].state = 'done'; renderSteps(steps);
        await doPull(steps, status.model);
      });
      return;
    }

    if (!status.ollamaRunning) {
      logMsg('Ollama installed but not running.');
      steps[1].state = 'active'; renderSteps(steps);
      const r = await window.api.startOllama();
      if (!r.ok) {
        logMsg(`Could not start Ollama: ${r.error}`);
        addAction('Retry', 'btn', () => { logEl.innerHTML = ''; runSetup(); });
        return;
      }
      steps[1].state = 'done'; renderSteps(steps);
    }

    if (!status.modelPulled) await doPull(steps, status.model);
    else showApp();
  }

  async function doPull(steps, model) {
    const idx = steps.findIndex((s) => s.label.startsWith('Pull'));
    if (idx >= 0) { steps[idx].state = 'active'; renderSteps(steps); }
    logMsg(`Pulling "${model}" — may take several minutes on first run...`);
    clearActions();
    const r = await window.api.pullModel(model);
    if (!r.ok) {
      logMsg(`Pull failed: ${r.error}`);
      addAction('Retry', 'btn', () => { logEl.innerHTML = ''; runSetup(); });
      return;
    }
    if (idx >= 0) { steps[idx].state = 'done'; renderSteps(steps); }
    logMsg(`Model "${model}" ready!`);
    setTimeout(showApp, 700);
  }

  function showApp() {
    overlay.classList.add('hidden');
    appShell.classList.remove('hidden');
    initApp();
  }

  // ════════════════════════════════════════════
  // MAIN APP
  // ════════════════════════════════════════════
  function initApp() {
    const state = {
      folder: null,
      files: [],
      activeFile: null,
      activeContent: '',
      dirty: false,
      editor: null,
      monacoModels: new Map(),   // relPath -> monaco model
      messages: [],
      busy: false,
      pending: new Map(),        // streamId -> {content, el}
      openDirs: new Set(),       // expanded directory paths
      vsCodeAvailable: false,
      terminals: [],             // [{id, xterm, fitAddon, tabEl, containerEl}]
      activeTermIdx: 0,
      terminalVisible: false,
    };

    const els = {
      openFolderBtn:         $('openFolderBtn'),
      workspaceLabel:        $('workspaceLabel'),
      fileTree:              $('fileTree'),
      activeFile:            $('activeFile'),
      saveBtn:               $('saveBtn'),
      editor:                $('editor'),
      editorFallback:        $('editorFallback'),
      fallbackTextarea:      $('fallbackTextarea'),
      messages:              $('messages'),
      proposals:             $('proposals'),
      promptInput:           $('promptInput'),
      sendBtn:               $('sendBtn'),
      clearBtn:              $('clearBtn'),
      hostInput:             $('hostInput'),
      modelSelect:           $('modelSelect'),
      modeSelect:            $('modeSelect'),
      includeFileCtx:        $('includeFileCtx'),
      includeTermCtx:        $('includeTermCtx'),
      status:                $('status'),
      refreshModelsBtn:      $('refreshModelsBtn'),
      vscodebtn:             $('vscodebtn'),
      openInVscodeFileBtn:   $('openInVscodeFileBtn'),
      newFileBtn:            $('newFileBtn'),
      refreshTreeBtn:        $('refreshTreeBtn'),
      terminalArea:          $('terminalArea'),
      terminalContainer:     $('terminalContainer'),
      termTabs:              $('termTabs'),
      newTermBtn:            $('newTermBtn'),
      closeTermBtn:          $('closeTermBtn'),
      toggleTermBtn:         $('toggleTermBtn'),
      termResizeHandle:      $('termResizeHandle'),
      editorArea:            $('editorArea'),
    };

    // ── Helpers ────────────────────────────────
    function setStatus(text, cls = '') {
      els.status.textContent = text;
      els.status.className = 'status' + (cls ? ' ' + cls : '');
    }

    function esc(s) {
      return String(s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    // ── Monaco ─────────────────────────────────
    function initEditor() {
      try {
        if (!window.require) throw new Error('loader missing');
        window.require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
        window.require(['vs/editor/editor.main'], () => {
          state.editor = monaco.editor.create(els.editor, {
            value: '',
            language: 'plaintext',
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: { enabled: true, scale: 0.8 },
            fontSize: 13,
            padding: { top: 12 },
            scrollBeyondLastLine: false,
            renderLineHighlight: 'line',
            suggestOnTriggerCharacters: true,
            quickSuggestions: true,
            wordWrap: 'off',
          });
          state.editor.onDidChangeModelContent(() => {
            if (!state.activeFile) return;
            state.activeContent = state.editor.getValue();
            state.dirty = true;
            els.saveBtn.disabled = false;
            updateTab();
          });
          // Ctrl+S save
          state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => els.saveBtn.click());
        }, () => useFallback());
      } catch { useFallback(); }
    }

    function useFallback() {
      els.editor.classList.add('hidden');
      els.editorFallback.classList.remove('hidden');
      els.fallbackTextarea.addEventListener('input', () => {
        if (!state.activeFile) return;
        state.activeContent = els.fallbackTextarea.value;
        state.dirty = true;
        els.saveBtn.disabled = false;
        updateTab();
      });
      els.fallbackTextarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); els.saveBtn.click(); }
      });
    }

    function setEditorValue(text, filePath) {
      state.activeContent = text || '';
      if (state.editor) {
        const lang = guessLang(filePath);
        // Reuse existing model if we have one
        if (state.monacoModels.has(filePath)) {
          const m = state.monacoModels.get(filePath);
          m.setValue(state.activeContent);
          state.editor.setModel(m);
        } else {
          const m = monaco.editor.createModel(state.activeContent, lang);
          state.monacoModels.set(filePath, m);
          state.editor.setModel(m);
        }
        state.editor.setScrollPosition({ scrollTop: 0 });
      } else {
        els.fallbackTextarea.value = state.activeContent;
      }
    }

    function guessLang(p) {
      if (!p) return 'plaintext';
      const ext = p.split('.').pop().toLowerCase();
      return ({
        js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
        ts: 'typescript', tsx: 'typescript',
        json: 'json', jsonc: 'json',
        html: 'html', htm: 'html',
        css: 'css', scss: 'scss', sass: 'scss', less: 'less',
        md: 'markdown',
        py: 'python',
        rs: 'rust',
        go: 'go',
        java: 'java',
        c: 'c', h: 'c',
        cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
        cs: 'csharp',
        rb: 'ruby',
        php: 'php',
        swift: 'swift',
        kt: 'kotlin', kts: 'kotlin',
        sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
        ps1: 'powershell', psm1: 'powershell',
        yml: 'yaml', yaml: 'yaml',
        toml: 'ini',
        xml: 'xml', svg: 'xml',
        sql: 'sql',
        r: 'r',
        lua: 'lua',
        dockerfile: 'dockerfile',
      })[ext] || 'plaintext';
    }

    function updateTab() {
      els.activeFile.textContent = state.activeFile
        ? (state.activeFile + (state.dirty ? ' ●' : ''))
        : 'No file open';
    }

    // ── VS Code detection ───────────────────────
    async function checkVSCode() {
      const r = await window.api.vscodeCheck();
      state.vsCodeAvailable = r.available;
      if (r.available) {
        els.vscodebtn.classList.remove('hidden');
      }
    }
    checkVSCode();

    els.vscodebtn.onclick = async () => {
      if (!state.folder) { addSystem('Open a folder first.'); return; }
      const r = await window.api.vscodeOpen(state.folder);
      if (!r.ok) addSystem(`VS Code: ${r.error}`);
    };

    els.openInVscodeFileBtn.onclick = async () => {
      if (!state.folder || !state.activeFile) return;
      const r = await window.api.vscodeOpenFile(state.folder, state.activeFile);
      if (!r.ok) addSystem(`VS Code: ${r.error}`);
    };

    // ── Workspace / files ──────────────────────
    els.openFolderBtn.onclick = async () => {
      const folder = await window.api.openFolder();
      if (!folder) return;
      state.folder = folder;
      state.openDirs.clear();
      const parts = folder.replace(/\\/g, '/').split('/');
      els.workspaceLabel.textContent = parts[parts.length - 1] || folder;
      els.workspaceLabel.title = folder;
      // Open a new terminal in this folder
      if (state.terminalVisible || state.terminals.length === 0) {
        spawnTerminal(folder);
      }
      await refreshFiles();
    };

    async function refreshFiles() {
      if (!state.folder) return;
      state.files = await window.api.listFiles(state.folder);
      renderTree();
    }

    // Render tree with collapsible folders
    function renderTree() {
      els.fileTree.innerHTML = '';
      if (!state.files.length) {
        els.fileTree.innerHTML = '<div class="muted" style="padding:8px">Empty workspace.</div>';
        return;
      }
      els.fileTree.classList.remove('muted');

      for (const item of state.files) {
        const div = document.createElement('div');
        const depth = item.depth || 0;
        div.style.paddingLeft = `${8 + depth * 14}px`;

        if (item.type === 'dir') {
          const isOpen = state.openDirs.has(item.path);
          div.className = 'file-item dir-item';
          div.innerHTML = `<span class="tree-arrow">${isOpen ? '▾' : '▸'}</span><span class="tree-icon">📁</span>${esc(item.name)}`;
          div.onclick = () => {
            if (isOpen) state.openDirs.delete(item.path);
            else state.openDirs.add(item.path);
            renderTree();
          };
          // Only show if parent is open (or root level)
          if (depth > 0 && !isParentOpen(item.path)) continue;
        } else {
          // Skip files whose parent dir is collapsed
          if (!isParentOpen(item.path)) continue;
          const isActive = item.path === state.activeFile;
          div.className = 'file-item' + (isActive ? ' active' : '');
          const icon = fileIcon(item.name);
          div.innerHTML = `<span class="tree-icon">${icon}</span><span class="file-name">${esc(item.name)}</span>`;
          div.onclick = () => openFile(item.path);
          div.title = item.path;

          // Right-click context menu
          div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(e, item);
          });
        }
        els.fileTree.appendChild(div);
      }
    }

    function isParentOpen(itemPath) {
      const normalized = itemPath.replace(/\\/g, '/');
      const parts = normalized.split('/');
      if (parts.length <= 1) return true; // root level
      // Check all ancestor dirs are open
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join('/');
        if (!state.openDirs.has(ancestor) && !state.openDirs.has(ancestor.replace(/\//g, '\\'))) {
          return false;
        }
      }
      return true;
    }

    function fileIcon(name) {
      const ext = name.split('.').pop().toLowerCase();
      const icons = {
        js: '🟨', jsx: '🟨', ts: '🔷', tsx: '🔷',
        json: '📋', html: '🌐', css: '🎨', scss: '🎨',
        md: '📝', py: '🐍', rs: '🦀', go: '🐹',
        java: '☕', c: '⚙️', cpp: '⚙️', cs: '💜',
        sh: '🐚', ps1: '🔵', yml: '⚙️', yaml: '⚙️',
        sql: '🗃️', png: '🖼️', jpg: '🖼️', gif: '🖼️', svg: '🖼️',
        pdf: '📄', zip: '📦', env: '🔒',
      };
      return icons[ext] || '📄';
    }

    // Right-click context menu
    let ctxMenu = null;
    function showContextMenu(e, item) {
      removeContextMenu();
      const menu = document.createElement('div');
      menu.className = 'ctx-menu';
      menu.style.left = `${e.clientX}px`;
      menu.style.top  = `${e.clientY}px`;

      const actions = [
        { label: '📂 Open File',            action: () => openFile(item.path) },
        { label: '↗ Open in VS Code',       action: async () => { if (!state.folder) return; await window.api.vscodeOpenFile(state.folder, item.path); }, disabled: !state.vsCodeAvailable },
        { label: '🗑 Delete',               action: () => confirmDelete(item) },
        null, // separator
        { label: '⌨️ Copy path',             action: () => navigator.clipboard?.writeText(item.path).catch(()=>{}) },
      ];

      for (const a of actions) {
        if (!a) { const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep); continue; }
        const btn = document.createElement('div');
        btn.className = 'ctx-item' + (a.disabled ? ' disabled' : '');
        btn.textContent = a.label;
        if (!a.disabled) btn.onclick = () => { removeContextMenu(); a.action(); };
        menu.appendChild(btn);
      }

      document.body.appendChild(menu);
      ctxMenu = menu;
      setTimeout(() => document.addEventListener('click', removeContextMenu, { once: true }), 0);
    }

    function removeContextMenu() {
      if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
    }

    async function confirmDelete(item) {
      if (!confirm(`Delete "${item.path}"? This cannot be undone.`)) return;
      await window.api.deleteFile(state.folder, item.path);
      if (state.activeFile === item.path) {
        state.activeFile = null;
        if (state.editor) state.editor.setModel(monaco.editor.createModel('', 'plaintext'));
        else els.fallbackTextarea.value = '';
        updateTab();
      }
      await refreshFiles();
    }

    els.newFileBtn.onclick = async () => {
      if (!state.folder) { addSystem('Open a folder first.'); return; }
      const name = prompt('New file name (relative to workspace):');
      if (!name || !name.trim()) return;
      const r = await window.api.newFile(state.folder, name.trim());
      if (r.ok) { await refreshFiles(); openFile(name.trim()); }
      else addSystem(`Could not create file: ${r.error}`);
    };

    els.refreshTreeBtn.onclick = () => refreshFiles();

    async function openFile(relPath) {
      if (!state.folder) return;
      try {
        const res = await window.api.readFile(state.folder, relPath);
        if (res.tooLarge) addSystem(`File is large — truncated at 2 MB: ${relPath}`);
        state.activeFile = relPath;
        state.dirty = false;
        els.saveBtn.disabled = true;
        if (state.vsCodeAvailable) els.openInVscodeFileBtn.classList.remove('hidden');
        setEditorValue(res.content, relPath);
        updateTab();
        renderTree();
      } catch (err) {
        addSystem(`Failed to open ${relPath}: ${err.message}`);
      }
    }

    els.saveBtn.onclick = async () => {
      if (!state.folder || !state.activeFile) return;
      const content = state.editor ? state.editor.getValue() : els.fallbackTextarea.value;
      await window.api.writeFile(state.folder, state.activeFile, content);
      state.activeContent = content;
      state.dirty = false;
      els.saveBtn.disabled = true;
      updateTab();
      addSystem(`Saved ${state.activeFile}`);
    };

    // ── Model selector ─────────────────────────
    async function refreshModels() {
      setStatus('refreshing...', 'busy');
      const host = els.hostInput.value.trim() || 'http://localhost:11434';
      const res = await window.api.getModels(host);
      if (res.error) {
        addSystem(`Ollama error: ${res.error}. Is Ollama running at ${host}?`);
        setStatus('ollama error', 'err');
        return;
      }
      const models = (res.models || []).map((m) => m.name);
      // Rebuild <select>
      const prev = els.modelSelect.value;
      els.modelSelect.innerHTML = '';
      if (!models.length) {
        const o = document.createElement('option');
        o.value = 'llama3.2'; o.textContent = 'llama3.2 (not pulled)';
        els.modelSelect.appendChild(o);
      } else {
        for (const name of models) {
          const o = document.createElement('option');
          o.value = name; o.textContent = name;
          els.modelSelect.appendChild(o);
        }
        if (models.includes(prev)) els.modelSelect.value = prev;
      }
      addSystem(`Ollama OK. ${models.length} model(s): ${models.join(', ')}`);
      setStatus('ready', 'ok');
    }

    els.refreshModelsBtn.onclick = refreshModels;
    // Auto-load model list on start
    setTimeout(refreshModels, 1200);

    // ── Terminal ───────────────────────────────
    let termIdCounter = 0;

    function spawnTerminal(cwd) {
      const id = `term-${++termIdCounter}`;
      const container = document.createElement('div');
      container.className = 'xterm-instance';
      container.dataset.id = id;
      els.terminalContainer.appendChild(container);

      // Hide all other terminals
      for (const t of state.terminals) {
        t.containerEl.style.display = 'none';
        t.tabEl.classList.remove('active');
      }

      const term = new Terminal({
        theme: {
          background:  '#0b0f14',
          foreground:  '#d7e1ee',
          cursor:      '#4da3ff',
          selectionBackground: 'rgba(77,163,255,.25)',
          black:       '#0b0f14',
          brightBlack: '#3a4a5c',
          red:         '#ff6b7a',
          green:       '#3fbf8f',
          yellow:      '#e7b75f',
          blue:        '#4da3ff',
          magenta:     '#7c6cff',
          cyan:        '#47ccd6',
          white:       '#d7e1ee',
          brightWhite: '#eef5ff',
        },
        fontFamily: 'ui-monospace, Consolas, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        allowTransparency: true,
        scrollback: 3000,
      });

      const fitAddon = new FitAddon.FitAddon();
      const webLinksAddon = new WebLinksAddon.WebLinksAddon((e, uri) => window.api.openExternal(uri));
      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.open(container);

      // Fit after a small delay to let layout settle
      setTimeout(() => { try { fitAddon.fit(); } catch {} }, 50);

      // Tab
      const tab = document.createElement('button');
      tab.className = 'term-tab active';
      tab.textContent = `bash ${termIdCounter}`;
      tab.onclick = () => activateTerminal(id);
      els.termTabs.appendChild(tab);

      const entry = { id, xterm: term, fitAddon, tabEl: tab, containerEl: container };
      state.terminals.push(entry);
      state.activeTermIdx = state.terminals.length - 1;

      // Spawn pty
      window.api.termCreate(id, cwd || state.folder || os?.homedir?.() || process?.env?.USERPROFILE || 'C:\\').then((r) => {
        if (!r.ok) {
          term.writeln(`\x1b[31mTerminal error: ${r.error}\x1b[0m`);
          return;
        }
        // Update tab name based on shell
        tab.textContent = process?.platform === 'win32' ? `cmd ${termIdCounter}` : `bash ${termIdCounter}`;
      });

      window.api.onTermData(id, (data) => term.write(data));
      window.api.onTermExit(id, ({ exitCode }) => {
        term.writeln(`\x1b[33m[process exited ${exitCode}]\x1b[0m`);
        tab.classList.add('dead');
      });

      term.onData((data) => window.api.termWrite(id, data));
      term.onResize(({ cols, rows }) => window.api.termResize(id, cols, rows));

      return entry;
    }

    function activateTerminal(id) {
      for (const t of state.terminals) {
        const active = t.id === id;
        t.containerEl.style.display = active ? 'flex' : 'none';
        t.tabEl.classList.toggle('active', active);
        if (active) {
          state.activeTermIdx = state.terminals.indexOf(t);
          setTimeout(() => { try { t.fitAddon.fit(); t.xterm.focus(); } catch {} }, 30);
        }
      }
    }

    function toggleTerminal(show) {
      state.terminalVisible = show !== undefined ? show : !state.terminalVisible;
      if (state.terminalVisible) {
        els.terminalArea.classList.remove('hidden');
        els.termResizeHandle.classList.remove('hidden');
        if (state.terminals.length === 0) spawnTerminal(state.folder);
        else {
          const t = state.terminals[state.activeTermIdx] || state.terminals[0];
          if (t) setTimeout(() => { try { t.fitAddon.fit(); t.xterm.focus(); } catch {} }, 60);
        }
      } else {
        els.terminalArea.classList.add('hidden');
        els.termResizeHandle.classList.add('hidden');
      }
    }

    els.toggleTermBtn.onclick  = () => toggleTerminal();
    els.closeTermBtn.onclick   = () => toggleTerminal(false);
    els.newTermBtn.onclick     = () => spawnTerminal(state.folder);

    // Resize handle drag for terminal height
    let termDragging = false, termDragStartY = 0, termDragStartH = 0;
    els.termResizeHandle.addEventListener('mousedown', (e) => {
      termDragging = true;
      termDragStartY = e.clientY;
      termDragStartH = els.terminalArea.offsetHeight;
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!termDragging) return;
      const delta = termDragStartY - e.clientY;
      const newH = Math.max(80, Math.min(600, termDragStartH + delta));
      els.terminalArea.style.height = `${newH}px`;
      const t = state.terminals[state.activeTermIdx];
      if (t) try { t.fitAddon.fit(); } catch {}
    });
    document.addEventListener('mouseup', () => {
      if (!termDragging) return;
      termDragging = false;
      document.body.style.userSelect = '';
    });

    // ── Chat ───────────────────────────────────
    function addMessage(role, content) {
      const msg = { role, content };
      state.messages.push(msg);
      const div = document.createElement('div');
      div.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
      const contentEl = document.createElement('div');
      contentEl.className = 'content';
      div.innerHTML = `<div class="role">${esc(role)}</div>`;
      div.appendChild(contentEl);
      if (role === 'user') {
        contentEl.textContent = content;
      } else {
        contentEl.innerHTML = renderMarkdown(content);
      }
      els.messages.appendChild(div);
      els.messages.scrollTop = els.messages.scrollHeight;
      return contentEl;
    }

    function addSystem(text) {
      const div = document.createElement('div');
      div.className = 'msg system';
      div.innerHTML = `<div class="role">system</div><div class="content"></div>`;
      div.querySelector('.content').textContent = text;
      els.messages.appendChild(div);
      els.messages.scrollTop = els.messages.scrollHeight;
    }

    // Simple markdown renderer (code blocks, inline code, bold, italic, headers, lists)
    function renderMarkdown(text) {
      let html = esc(text);
      // Fenced code blocks
      html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
        `<div class="code-block"><div class="code-lang">${esc(lang || 'code')}</div><pre><code>${code}</code></pre><button class="copy-btn" onclick="navigator.clipboard?.writeText(this.parentElement.querySelector('code').textContent)">Copy</button></div>`
      );
      // Inline code
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      // Headers
      html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
      html = html.replace(/^## (.+)$/gm,  '<h3>$1</h3>');
      html = html.replace(/^# (.+)$/gm,   '<h2>$1</h2>');
      // Bold and italic
      html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
      html = html.replace(/\*\*(.+?)\*\*/g,      '<strong>$1</strong>');
      html = html.replace(/\*(.+?)\*/g,           '<em>$1</em>');
      // Unordered list items
      html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>[\s\S]+?<\/li>)/g, '<ul>$1</ul>');
      // Paragraphs (double newlines)
      html = html.replace(/\n\n+/g, '</p><p>');
      html = '<p>' + html + '</p>';
      // Single newlines inside paragraphs
      html = html.replace(/<\/p><p>/g, '</p><p>');
      html = html.replace(/\n/g, '<br>');
      return html;
    }

    function buildSystemPrompt() {
      const base = `You are DevPilot, a helpful local AI coding assistant inside a desktop editor (like Cursor/VS Code). Be concise, practical, and accurate. Use markdown for code — wrap code in fenced code blocks with the language specified.`;
      if (els.modeSelect.value !== 'agent') return base;
      return base + `

AGENT MODE — when asked to change code/files:
1. Write a short plan first.
2. Then for each file, output EXACTLY:
<edit file="relative/path.ext">
...FULL new file content here...
</edit>
Use paths relative to the workspace. Multiple <edit> blocks are allowed.`;
    }

    function currentFileContext() {
      if (!els.includeFileCtx.checked || !state.activeFile) return '';
      const content = state.editor ? state.editor.getValue() : state.activeContent;
      const trimmed = content.length > 16000 ? content.slice(0, 16000) + '\n...[truncated]...' : content;
      return `\n\nActive file (${state.activeFile}):\n\`\`\`\n${trimmed}\n\`\`\``;
    }

    function currentTermContext() {
      if (!els.includeTermCtx.checked) return '';
      const t = state.terminals[state.activeTermIdx];
      if (!t) return '';
      // xterm doesn't expose a clean buffer API without the serialize addon,
      // so we capture the last N lines from the visible viewport
      try {
        const lines = [];
        const buffer = t.xterm.buffer.active;
        const start = Math.max(0, buffer.length - 50);
        for (let i = start; i < buffer.length; i++) {
          const line = buffer.getLine(i);
          if (line) lines.push(line.translateToString(true));
        }
        const termText = lines.join('\n').trim();
        if (!termText) return '';
        return `\n\nRecent terminal output:\n\`\`\`\n${termText}\n\`\`\``;
      } catch { return ''; }
    }

    async function send() {
      const prompt = els.promptInput.value.trim();
      if (!prompt || state.busy) return;
      els.promptInput.value = '';
      els.proposals.classList.add('hidden');
      els.proposals.innerHTML = '';

      const userText = prompt
        + (els.includeFileCtx.checked && state.activeFile ? `\n\n[Context: ${state.activeFile}]` : '')
        + (els.includeTermCtx.checked ? '\n[Terminal context included]' : '');
      addMessage('user', userText);

      const apiMessages = [{ role: 'system', content: buildSystemPrompt() }];
      const hist = state.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-14);
      for (const m of hist) {
        if (m.role === 'user' && m.content === userText)
          apiMessages.push({ role: 'user', content: prompt + currentFileContext() + currentTermContext() });
        else
          apiMessages.push({ role: m.role, content: m.content });
      }

      state.busy = true;
      els.sendBtn.disabled = true;
      setStatus('thinking...', 'busy');

      const streamId = String(Date.now()) + Math.random();
      const contentEl = addMessage('assistant', '');
      state.pending.set(streamId, { content: '', el: contentEl });

      try {
        await window.api.chat({
          host: els.hostInput.value.trim() || 'http://localhost:11434',
          model: els.modelSelect.value || 'llama3.2',
          messages: apiMessages,
          streamId,
        });
      } catch (err) {
        contentEl.textContent += `\n[Error: ${err.message}]`;
        finishStream(streamId, true);
      }
    }

    function finishStream(streamId, isErr) {
      const p = state.pending.get(streamId);
      state.pending.delete(streamId);
      state.busy = false;
      els.sendBtn.disabled = false;
      setStatus(isErr ? 'error' : 'ready', isErr ? 'err' : 'ok');
      if (p) {
        // Re-render final content as markdown
        p.el.innerHTML = renderMarkdown(p.content);
        if (els.modeSelect.value === 'agent') parseProposals(p.content);
      }
    }

    window.api.onChunk(({ streamId, content }) => {
      const p = state.pending.get(streamId);
      if (!p) return;
      p.content += content;
      // Live plain-text while streaming, render markdown on finish
      p.el.textContent = p.content;
      els.messages.scrollTop = els.messages.scrollHeight;
    });
    window.api.onDone(({ streamId }) => finishStream(streamId, false));
    window.api.onError(({ streamId, error }) => {
      const p = state.pending.get(streamId);
      if (p) p.el.textContent += `\n[Ollama error: ${error}]`;
      finishStream(streamId, true);
    });

    function parseProposals(text) {
      const re = /<edit\s+file="([^"]+)">\s*([\s\S]*?)\s*<\/edit>/g;
      let m; const edits = [];
      while ((m = re.exec(text))) edits.push({ file: m[1].replace(/\\/g, '/'), content: m[2] });
      if (!edits.length) return;
      if (!state.folder) { addSystem('Open a workspace folder to apply proposed edits.'); return; }
      els.proposals.innerHTML = `<div class="proposals-header">Proposed edits</div>`;
      for (const ed of edits) {
        const div = document.createElement('div');
        div.className = 'proposal';
        div.innerHTML = `
          <div class="path">${esc(ed.file)}</div>
          <div class="actions">
            <button class="btn primary apply">Apply</button>
            <button class="btn ghost diff-btn">Diff</button>
          </div>`;
        div.querySelector('.apply').onclick = async () => {
          await window.api.writeFile(state.folder, ed.file, ed.content);
          addSystem(`Applied: ${ed.file}`);
          await refreshFiles();
          if (state.activeFile === ed.file) openFile(ed.file);
          div.querySelector('.apply').textContent = '✓ Applied';
          div.querySelector('.apply').disabled = true;
        };
        div.querySelector('.diff-btn').onclick = () => {
          // Simple diff: show in editor (left = current, right = proposed via Monaco diff)
          if (!state.editor) { addSystem('Diff view requires Monaco editor.'); return; }
          const currentContent = state.monacoModels.has(ed.file) ? state.monacoModels.get(ed.file).getValue() : '';
          const originalModel = monaco.editor.createModel(currentContent, guessLang(ed.file));
          const modifiedModel = monaco.editor.createModel(ed.content, guessLang(ed.file));
          state.editor.dispose();
          const diffEl = els.editor;
          diffEl.innerHTML = '';
          const diffEditor = monaco.editor.createDiffEditor(diffEl, { theme: 'vs-dark', automaticLayout: true, readOnly: true });
          diffEditor.setModel({ original: originalModel, modified: modifiedModel });
          addSystem(`Showing diff for ${ed.file}. Re-open a file to return to normal editor.`);
        };
        els.proposals.appendChild(div);
      }
      els.proposals.classList.remove('hidden');
    }

    // ── Keyboard shortcuts ──────────────────────
    els.sendBtn.onclick = send;
    els.clearBtn.onclick = () => {
      state.messages = [];
      els.messages.innerHTML = '';
      els.proposals.classList.add('hidden');
      els.proposals.innerHTML = '';
      setStatus('idle');
    };
    els.promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    });

    // Global: Ctrl+` toggles terminal (like VS Code)
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '`') { e.preventDefault(); toggleTerminal(); }
    });

    // ── Init ────────────────────────────────────
    initEditor();
    setStatus('idle');
  }

  // Kick off
  runSetup();
})();
