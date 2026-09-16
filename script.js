(function(){
  const THEME_KEY = 'noted-theme';

  let appData = { classes: [] };
  let selectedClassId = null;
  let view = 'list'; // 'list' | 'editor'
  let currentNoteId = null;
  let pendingDoubleEnter = false;
  let saveTimer = null;

  const authScreen = document.getElementById('authScreen');
  const appEl = document.getElementById('app');
  const tabsRow = document.getElementById('tabsRow');
  const content = document.getElementById('content');

  // ---------- utils ----------
  function uid(){ return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  function escapeHtml(str){
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function stripHtml(html){
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return tmp.textContent || '';
  }

  function formatDate(ts){
    return new Date(ts).toLocaleString(undefined, {month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'});
  }

  async function sha256Hex(str){
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  function randomSalt(){
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  // ---------- data (backed by the shared database) ----------
  async function loadData(){
    try{
      const res = await fetch('/api/notes');
      if(!res.ok) throw new Error('load failed');
      appData = await res.json();
    }catch(e){
      appData = { classes: [] };
      throw e;
    }
  }

  async function saveData(){
    try{
      await fetch('/api/notes', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(appData)
      });
    }catch(e){ /* connection dropped; next edit will retry via scheduleSave */ }
  }

  // ---------- theme (kept per-device; not shared) ----------
  function applyTheme(){
    let stored;
    try{ stored = localStorage.getItem(THEME_KEY); }catch(e){ stored = null; }
    if(stored === 'light' || stored === 'dark'){
      document.documentElement.setAttribute('data-theme', stored);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
  function toggleTheme(){
    const attr = document.documentElement.getAttribute('data-theme');
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const currentlyDark = attr ? attr === 'dark' : systemDark;
    const next = currentlyDark ? 'light' : 'dark';
    try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
    document.documentElement.setAttribute('data-theme', next);
  }

  // ---------- auth (stored server-side so it's the same password on every device) ----------
  async function fetchAuth(){
    const res = await fetch('/api/auth');
    if(!res.ok) throw new Error('auth fetch failed');
    return res.json();
  }

  function renderAuthLoading(){
    authScreen.innerHTML = `
      <div class="auth-card">
        <div class="auth-mark">NOTED</div>
        <h1 class="auth-title">Loading…</h1>
        <p class="auth-sub">Connecting to your notes.</p>
      </div>
    `;
  }

  function renderAuthError(){
    authScreen.innerHTML = `
      <div class="auth-card">
        <div class="auth-mark">NOTED</div>
        <h1 class="auth-title">Couldn't connect</h1>
        <p class="auth-sub">The backend didn't respond. Check your connection and try again.</p>
        <button class="btn btn-primary" id="retryBtn">Retry</button>
      </div>
    `;
    document.getElementById('retryBtn').addEventListener('click', renderAuthScreen);
  }

  async function renderAuthScreen(){
    renderAuthLoading();
    let auth;
    try{
      auth = await fetchAuth();
    }catch(e){
      renderAuthError();
      return;
    }

    if(!auth){
      authScreen.innerHTML = `
        <div class="auth-card">
          <div class="auth-mark">NOTED</div>
          <h1 class="auth-title">Set a password</h1>
          <p class="auth-sub">This protects your notes on every device you use. There's no way to recover it if you forget it, so pick something you'll remember.</p>
          <label class="field-label" for="setPw">Password</label>
          <input class="text-input" type="password" id="setPw" autocomplete="new-password">
          <label class="field-label" for="setPw2">Confirm password</label>
          <input class="text-input" type="password" id="setPw2" autocomplete="new-password">
          <div class="auth-error" id="authErr"></div>
          <button class="btn btn-primary" id="setPwBtn">Create password</button>
        </div>
      `;
      document.getElementById('setPwBtn').addEventListener('click', async () => {
        const p1 = document.getElementById('setPw').value;
        const p2 = document.getElementById('setPw2').value;
        const err = document.getElementById('authErr');
        if(!p1 || p1.length < 4){
          err.textContent = 'Use at least 4 characters.';
          return;
        }
        if(p1 !== p2){
          err.textContent = "Passwords don't match.";
          return;
        }
        const salt = randomSalt();
        const hash = await sha256Hex(salt + p1);
        try{
          const res = await fetch('/api/auth', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({salt, hash})
          });
          if(res.status === 409){
            err.textContent = 'A password was just set from another device — enter it instead.';
            renderAuthScreen();
            return;
          }
          if(!res.ok) throw new Error('save failed');
        }catch(e){
          err.textContent = "Couldn't save your password — check your connection.";
          return;
        }
        unlockApp();
      });
    } else {
      authScreen.innerHTML = `
        <div class="auth-card">
          <div class="auth-mark">NOTED</div>
          <h1 class="auth-title">Enter your password</h1>
          <p class="auth-sub">Unlock to see your classes and notes.</p>
          <label class="field-label" for="loginPw">Password</label>
          <input class="text-input" type="password" id="loginPw" autocomplete="current-password">
          <div class="auth-error" id="authErr"></div>
          <button class="btn btn-primary" id="loginBtn">Unlock</button>
          <button class="auth-reset" id="resetBtn">Forgot it? Reset all data everywhere</button>
        </div>
      `;
      const doLogin = async () => {
        const p1 = document.getElementById('loginPw').value;
        const err = document.getElementById('authErr');
        const hash = await sha256Hex(auth.salt + p1);
        if(hash === auth.hash){
          unlockApp();
        } else {
          err.textContent = 'Wrong password.';
        }
      };
      document.getElementById('loginBtn').addEventListener('click', doLogin);
      document.getElementById('loginPw').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });
      document.getElementById('resetBtn').addEventListener('click', async () => {
        if(confirm('This deletes your password AND every class and note, on every device. This cannot be undone. Continue?')){
          try{
            await fetch('/api/auth', {method: 'DELETE'});
            await fetch('/api/notes', {method: 'DELETE'});
          }catch(e){}
          appData = { classes: [] };
          renderAuthScreen();
        }
      });
    }
  }

  async function unlockApp(){
    authScreen.innerHTML = `
      <div class="auth-card">
        <div class="auth-mark">NOTED</div>
        <h1 class="auth-title">Loading your notes…</h1>
      </div>
    `;
    try{
      await loadData();
    }catch(e){
      renderAuthError();
      return;
    }
    authScreen.classList.add('hidden');
    appEl.classList.remove('hidden');
    if(appData.classes.length && !selectedClassId){
      selectedClassId = appData.classes[0].id;
    }
    renderApp();
  }

  function lockApp(){
    view = 'list';
    currentNoteId = null;
    appEl.classList.add('hidden');
    authScreen.classList.remove('hidden');
    renderAuthScreen();
  }

  // ---------- main app render ----------
  function renderApp(){
    renderTabs();
    if(view === 'editor' && currentNoteId){
      renderEditor();
    } else {
      renderNotesList();
    }
  }

  function renderTabs(){
    if(appData.classes.length === 0){
      tabsRow.innerHTML = `<button class="add-class-btn" id="addClassBtn">+ Add a class</button>`;
      document.getElementById('addClassBtn').addEventListener('click', addClass);
      return;
    }
    tabsRow.innerHTML = appData.classes.map(c => `
      <button class="class-tab ${c.id === selectedClassId ? 'active' : ''}" data-id="${c.id}">
        <span class="tab-name">${escapeHtml(c.name)}</span>
        <span class="tab-del" data-del="${c.id}">✕</span>
      </button>
    `).join('') + `<button class="add-class-btn" id="addClassBtn">+</button>`;

    tabsRow.querySelectorAll('.class-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        if(e.target.dataset.del){
          e.stopPropagation();
          deleteClass(e.target.dataset.del);
          return;
        }
        selectedClassId = tab.dataset.id;
        view = 'list';
        currentNoteId = null;
        renderApp();
      });
      tab.querySelector('.tab-name').addEventListener('dblclick', () => renameClass(tab.dataset.id));
    });
    document.getElementById('addClassBtn').addEventListener('click', addClass);
  }

  function addClass(){
    const name = prompt('Class name:');
    if(!name || !name.trim()) return;
    const c = { id: uid(), name: name.trim(), notes: [] };
    appData.classes.push(c);
    selectedClassId = c.id;
    saveData();
    renderApp();
  }

  function renameClass(id){
    const c = appData.classes.find(x => x.id === id);
    if(!c) return;
    const name = prompt('Rename class:', c.name);
    if(!name || !name.trim()) return;
    c.name = name.trim();
    saveData();
    renderApp();
  }

  function deleteClass(id){
    const c = appData.classes.find(x => x.id === id);
    if(!c) return;
    if(!confirm(`Delete "${c.name}" and all its notes? This can't be undone.`)) return;
    appData.classes = appData.classes.filter(x => x.id !== id);
    if(selectedClassId === id){
      selectedClassId = appData.classes.length ? appData.classes[0].id : null;
    }
    view = 'list';
    currentNoteId = null;
    saveData();
    renderApp();
  }

  function renderNotesList(){
    if(appData.classes.length === 0){
      content.innerHTML = `
        <div class="empty-state">
          <h3>No classes yet</h3>
          <p>Add your first class to start taking notes.</p>
          <button class="btn btn-primary" id="firstClassBtn" style="width:auto;">+ Add a class</button>
        </div>`;
      document.getElementById('firstClassBtn').addEventListener('click', addClass);
      return;
    }
    const cls = appData.classes.find(c => c.id === selectedClassId) || appData.classes[0];
    selectedClassId = cls.id;

    if(cls.notes.length === 0){
      content.innerHTML = `
        <div class="notes-header">
          <h2>${escapeHtml(cls.name)}</h2>
          <button class="btn" id="newNoteBtn">+ New note</button>
        </div>
        <div class="empty-state">
          <h3>No notes yet</h3>
          <p>Start your first note for this class.</p>
        </div>`;
      document.getElementById('newNoteBtn').addEventListener('click', () => createNote(cls));
      return;
    }

    const sorted = [...cls.notes].sort((a,b) => b.createdAt - a.createdAt);
    content.innerHTML = `
      <div class="notes-header">
        <h2>${escapeHtml(cls.name)}</h2>
        <button class="btn" id="newNoteBtn">+ New note</button>
      </div>
      ${sorted.map(n => {
        const preview = stripHtml(n.lines && n.lines[0] ? n.lines[0].html : '').slice(0, 80);
        return `
        <div class="note-card" data-id="${n.id}">
          <div class="note-card-main">
            <div class="note-card-title">${escapeHtml(n.title)}</div>
            <div class="note-card-meta">${preview ? escapeHtml(preview) : 'Empty note'}</div>
          </div>
          <button class="note-card-del" data-del="${n.id}">🗑</button>
        </div>`;
      }).join('')}
    `;
    document.getElementById('newNoteBtn').addEventListener('click', () => createNote(cls));
    content.querySelectorAll('.note-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if(e.target.dataset.del){
          e.stopPropagation();
          deleteNote(cls, e.target.dataset.del);
          return;
        }
        currentNoteId = card.dataset.id;
        view = 'editor';
        renderApp();
      });
    });
  }

  function createNote(cls){
    const note = {
      id: uid(),
      title: formatDate(Date.now()),
      createdAt: Date.now(),
      lines: [{html: '', header: false}]
    };
    cls.notes.push(note);
    saveData();
    currentNoteId = note.id;
    view = 'editor';
    renderApp();
  }

  function deleteNote(cls, noteId){
    const note = cls.notes.find(n => n.id === noteId);
    if(!note) return;
    if(!confirm(`Delete "${note.title}"? This can't be undone.`)) return;
    cls.notes = cls.notes.filter(n => n.id !== noteId);
    saveData();
    renderApp();
  }

  // ---------- editor ----------
  function findNote(){
    const cls = appData.classes.find(c => c.id === selectedClassId);
    if(!cls) return null;
    return cls.notes.find(n => n.id === currentNoteId) || null;
  }

  function renderEditor(){
    const note = findNote();
    if(!note){
      view = 'list';
      renderApp();
      return;
    }
    content.innerHTML = `
      <div class="editor-topline">
        <button class="back-btn" id="backBtn">← Back</button>
        <input class="title-input" id="titleInput" value="${escapeHtml(note.title)}">
        <button class="note-del-btn" id="delNoteBtn">🗑</button>
      </div>
      <div class="toolbar">
        <button class="tb-btn tb-bold" id="tbBold" title="Bold">B</button>
        <button class="tb-btn tb-italic" id="tbItalic" title="Italic">I</button>
        <button class="tb-btn" id="tbHeader" title="Toggle header on current line">H</button>
      </div>
      <div class="note-body" id="noteBody" contenteditable="true"></div>
      <div class="hint">Tip: press Enter twice to turn a line into a header</div>
    `;

    document.getElementById('backBtn').addEventListener('click', () => {
      view = 'list';
      currentNoteId = null;
      renderApp();
    });
    document.getElementById('delNoteBtn').addEventListener('click', () => {
      const cls = appData.classes.find(c => c.id === selectedClassId);
      deleteNote(cls, note.id);
    });
    document.getElementById('titleInput').addEventListener('input', (e) => {
      note.title = e.target.value;
      scheduleSave();
    });

    const noteBody = document.getElementById('noteBody');
    buildEditorDOM(noteBody, note.lines);

    document.getElementById('tbBold').addEventListener('click', () => { noteBody.focus(); document.execCommand('bold'); scheduleSave(); });
    document.getElementById('tbItalic').addEventListener('click', () => { noteBody.focus(); document.execCommand('italic'); scheduleSave(); });
    document.getElementById('tbHeader').addEventListener('click', () => {
      const sel = window.getSelection();
      if(!sel.rangeCount) return;
      let node = sel.getRangeAt(0).startContainer;
      while(node && !(node.nodeType === 1 && node.classList && node.classList.contains('line'))){
        node = node.parentNode;
      }
      if(node) node.classList.toggle('line-header');
      scheduleSave();
    });

    noteBody.addEventListener('keydown', (e) => handleEditorKeydown(e, noteBody));
    noteBody.addEventListener('input', scheduleSave);
  }

  function buildEditorDOM(noteBody, lines){
    noteBody.innerHTML = '';
    const use = (lines && lines.length) ? lines : [{html:'', header:false}];
    use.forEach(line => {
      const div = document.createElement('div');
      div.className = 'line' + (line.header ? ' line-header' : '');
      if(line.html && line.html.trim() !== ''){
        div.innerHTML = line.html;
      } else {
        div.appendChild(document.createElement('br'));
      }
      noteBody.appendChild(div);
    });
  }

  function placeCaretAtStart(el){
    el.focus();
    const range = document.createRange();
    const sel = window.getSelection();
    if(el.firstChild){
      range.setStart(el.firstChild, 0);
    } else {
      range.setStart(el, 0);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function handleEditorKeydown(e, noteBody){
    if(e.key === 'Enter'){
      e.preventDefault();
      const sel = window.getSelection();
      if(!sel.rangeCount) return;
      let currentLine = sel.getRangeAt(0).startContainer;
      while(currentLine && !(currentLine.nodeType === 1 && currentLine.classList && currentLine.classList.contains('line'))){
        currentLine = currentLine.parentNode;
      }
      if(!currentLine) return;

      const isEmpty = currentLine.textContent.trim() === '';

      if(isEmpty && pendingDoubleEnter){
        const prevLine = currentLine.previousElementSibling;
        if(prevLine && prevLine.classList.contains('line') && prevLine.textContent.trim() !== ''){
          prevLine.classList.add('line-header');
        }
        pendingDoubleEnter = false;
        placeCaretAtStart(currentLine);
        scheduleSave();
        return;
      }

      const newLine = document.createElement('div');
      newLine.className = 'line';
      newLine.appendChild(document.createElement('br'));
      currentLine.after(newLine);
      placeCaretAtStart(newLine);
      pendingDoubleEnter = !isEmpty;
      scheduleSave();
      return;
    }

    if(!['Shift','Control','Alt','Meta','CapsLock','Tab'].includes(e.key)){
      pendingDoubleEnter = false;
    }
  }

  function scheduleSave(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const note = findNote();
      const noteBody = document.getElementById('noteBody');
      if(note && noteBody){
        const lines = Array.from(noteBody.querySelectorAll(':scope > .line')).map(div => ({
          html: div.innerHTML === '<br>' ? '' : div.innerHTML,
          header: div.classList.contains('line-header')
        }));
        note.lines = lines;
      }
      saveData();
    }, 500);
  }

  // ---------- init ----------
  applyTheme();
  document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);
  document.getElementById('lockBtn').addEventListener('click', lockApp);
  renderAuthScreen();
})();