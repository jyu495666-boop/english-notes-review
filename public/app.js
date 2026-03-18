/**
 * 英语笔记复习助手 — 前端核心逻辑
 * 模块：ReviewScheduler | FlashCardEngine | SearchEngine | UIController
 */

const App = (() => {
  // ============================================================
  // 状态
  // ============================================================
  let allNotes = [];          // 从 /api/notes 加载的全部笔记
  let todayTasks = [];        // 今日复习任务（含笔记数据）
  let ocrResult = null;       // OCR 解析结果（待保存）
  let dontKnowMode = false;   // 「不认识」模式标志，防止双击
  let flashState = {
    queue: [],                // [{noteId, type, index, recordId}]
    current: 0,
    revealed: false,
    stats: { ok: 0, wrong: 0, unknown: 0 }
  };

  // ============================================================
  // 工具方法
  // ============================================================
  function toast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast show ${type}`;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.className = 'toast'; }, 3000);
  }

  function getTodayStr() {
    return new Date().toISOString().split('T')[0];
  }

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ============================================================
  // Tab 导航
  // ============================================================
  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`panel-${tab}`).classList.add('active');

        if (tab === 'library' && allNotes.length === 0) loadLibrary();
      });
    });
  }

  // ============================================================
  // 模态框
  // ============================================================
  function openModal(title, bodyHTML) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    document.getElementById('note-modal').style.display = 'flex';
  }
  function closeModal() {
    document.getElementById('note-modal').style.display = 'none';
  }

  // ============================================================
  // 飞书机器人通知
  // ============================================================
  async function sendNotify() {
    const today = getTodayStr();
    const pending = todayTasks.length;
    const msg = `📚 英语复习提醒（${today}）\n今日有 ${pending} 条复习任务，请及时完成！`;
    try {
      const r = await fetchJSON('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg })
      });
      toast(r.success ? '飞书提醒已发送！' : r.message, r.success ? 'success' : '');
    } catch (e) {
      toast('通知失败：' + e.message, 'error');
    }
  }

  // ============================================================
  // ReviewScheduler — 加载今日复习任务
  // ============================================================
  async function loadTodayReview() {
    const loadingEl = document.getElementById('review-loading');
    const emptyEl = document.getElementById('review-empty');
    const cardArea = document.getElementById('flashcard-area');
    const doneEl = document.getElementById('review-done');

    loadingEl.style.display = 'block';
    emptyEl.style.display = 'none';
    cardArea.style.display = 'none';
    doneEl.style.display = 'none';

    document.getElementById('review-date').textContent = `📅 ${getTodayStr()}`;

    try {
      // 获取今日复习记录
      const taskRes = await fetchJSON('/api/review/today');
      const tasks = taskRes.tasks || [];

      // 获取对应笔记内容
      const notesRes = await fetchJSON('/api/notes');
      allNotes = notesRes.notes || [];

      // 构建复习队列：每个任务按笔记的 words + phrases + sentences 拆成闪卡
      const queue = [];
      for (const task of tasks) {
        const note = allNotes.find(n => n.note_id === task.note_id);
        if (!note) continue;
        (note.words || []).forEach((w, i) => queue.push({ type: 'word', data: w, note, recordId: task.id }));
        (note.phrases || []).forEach((p, i) => queue.push({ type: 'phrase', data: p, note, recordId: task.id }));
        (note.sentences || []).forEach((s, i) => queue.push({ type: 'sentence', data: s, note, recordId: task.id }));
      }

      todayTasks = tasks;
      const badge = document.getElementById('review-badge');
      if (tasks.length > 0) {
        badge.textContent = tasks.length;
        badge.style.display = 'inline';
      } else {
        badge.style.display = 'none';
      }

      loadingEl.style.display = 'none';

      if (queue.length === 0) {
        emptyEl.style.display = 'block';
        return;
      }

      flashState = { queue, current: 0, revealed: false, stats: { ok: 0, wrong: 0, unknown: 0 } };
      cardArea.style.display = 'block';
      renderFlashCard();

    } catch (e) {
      loadingEl.style.display = 'none';
      toast('加载复习任务失败：' + e.message, 'error');
    }
  }

  // ============================================================
  // FlashCardEngine — 闪卡逻辑
  // ============================================================
  function renderFlashCard() {
    const { queue, current } = flashState;
    if (current >= queue.length) {
      showReviewDone();
      return;
    }

    // 更新进度条
    const pct = Math.round((current / queue.length) * 100);
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-text').textContent = `${current} / ${queue.length}`;

    const item = queue[current];
    const card = document.getElementById('flash-card');

    // 重置翻转状态
    card.classList.remove('flipped');
    flashState.revealed = false;
    dontKnowMode = false;
    // 恢复按钮状态
    const btnOk = document.getElementById('btn-ok');
    const btnWrong = document.getElementById('btn-wrong');
    btnOk.textContent = '✅ 知道了';
    btnWrong.style.display = 'inline-flex';

    // 设置前面内容
    const typeMap = { word: '单词', phrase: '短语', sentence: '例句' };
    document.getElementById('card-label').textContent = typeMap[item.type] || item.type;

    let question = '', hint = '', answer = '', synonym = '';

    if (item.type === 'word') {
      question = item.data.en || '';
      hint = '记得中文意思吗？';
      answer = item.data.cn || '';
      synonym = item.data.synonym ? `近义词：${item.data.synonym}` : '';
    } else if (item.type === 'phrase') {
      question = item.data.en || '';
      hint = '知道这个短语的含义吗？';
      answer = item.data.cn || '';
    } else if (item.type === 'sentence') {
      const bw = item.data.blank_word;
      if (bw) {
        question = (item.data.en || '').replace(new RegExp(bw, 'i'), '___');
        hint = `填入缺失单词`;
      } else {
        question = item.data.en || '';
        hint = '翻译这个句子';
      }
      answer = item.data.cn || (item.data.blank_word ? item.data.blank_word : '');
    }

    document.getElementById('card-question').textContent = question;
    document.getElementById('card-hint').textContent = hint;
    document.getElementById('card-answer').textContent = answer;
    document.getElementById('card-synonym').textContent = synonym;

    // 显示/隐藏操作按钮
    document.getElementById('dontknow-row').style.display = 'block';
    document.getElementById('btn-reveal').style.display = 'inline-flex';
  }

  function revealAnswer() {
    if (flashState.revealed) return;
    flashState.revealed = true;
    const card = document.getElementById('flash-card');
    card.classList.add('flipped');
    document.getElementById('dontknow-row').style.display = 'none';
  }

  async function handleResult(result) {
    // 统计
    flashState.stats[result] = (flashState.stats[result] || 0) + 1;

    // 如果是最后一张 "不知道" 后直接翻开的，说明前面已经翻了
    // 记录复习结果（每个 task 只记录一次，用 recordId 去重的话选第一次碰到时记录）
    const item = flashState.queue[flashState.current];
    if (item) {
      try {
        await fetchJSON('/api/review/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ record_id: item.recordId, result })
        });
      } catch (e) { /* 静默失败 */ }
    }

    flashState.current++;
    renderFlashCard();
  }

  function handleDontKnow() {
    revealAnswer();
    dontKnowMode = true;
    document.getElementById('btn-ok').textContent = '➡️ 下一题';
    document.getElementById('btn-wrong').style.display = 'none';
  }

  function showReviewDone() {
    document.getElementById('flashcard-area').style.display = 'none';
    document.getElementById('review-done').style.display = 'block';
    const { ok, wrong, unknown } = flashState.stats;
    const total = ok + wrong + unknown;
    document.getElementById('done-summary').textContent =
      `共 ${total} 张卡片：知道 ${ok} 张 · 记错了 ${wrong} 张 · 不认识 ${unknown} 张`;
    document.getElementById('progress-fill').style.width = '100%';
    document.getElementById('progress-text').textContent = `${total} / ${total}`;
    toast('🌟 本轮复习完成！', 'success');

    // 触发飞书完成通知（异步，不影响页面）
    fetch('/api/notify/complete', { method: 'POST' }).catch(() => {});
  }

  async function startReview() {
    await loadTodayReview();
  }

  // ============================================================
  // Upload — 图片 OCR 流程
  // ============================================================
  let selectedFile = null;

  function initUpload() {
    const fileInput = document.getElementById('file-input');
    const drop = document.getElementById('upload-drop');
    const preview = document.getElementById('upload-preview');
    const previewImg = document.getElementById('preview-img');

    function showPreview(file) {
      selectedFile = file;
      const reader = new FileReader();
      reader.onload = e => {
        previewImg.src = e.target.result;
        drop.style.display = 'none';
        preview.style.display = 'flex';
      };
      reader.readAsDataURL(file);
    }

    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) showPreview(e.target.files[0]);
    });

    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) showPreview(file);
    });
    drop.addEventListener('click', () => fileInput.click());

    document.getElementById('btn-reselect').addEventListener('click', resetUpload);
    document.getElementById('btn-ocr').addEventListener('click', doOCR);
    document.getElementById('btn-save').addEventListener('click', saveNote);
    document.getElementById('btn-discard').addEventListener('click', () => {
      resetUpload();
      document.getElementById('ocr-result').style.display = 'none';
    });
    document.getElementById('btn-parse-text').addEventListener('click', parseManualText);
    document.getElementById('btn-raw-parse').addEventListener('click', parseRawText);
    document.getElementById('btn-raw-cancel').addEventListener('click', () => {
      document.getElementById('ocr-raw-area').style.display = 'none';
      resetUpload();
    });
  }

  function resetUpload() {
    selectedFile = null;
    ocrResult = null;
    document.getElementById('upload-drop').style.display = 'block';
    document.getElementById('upload-preview').style.display = 'none';
    document.getElementById('ocr-loading').style.display = 'none';
    document.getElementById('ocr-result').style.display = 'none';
    document.getElementById('file-input').value = '';
  }

  async function doOCR() {
    if (!selectedFile) return;
    document.getElementById('upload-preview').style.display = 'none';
    const loadingEl = document.getElementById('ocr-loading');
    loadingEl.style.display = 'block';
    loadingEl.innerHTML = '<div class="spinner"></div><p id="ocr-progress-text">正在加载 OCR 引擎…</p>';

    try {
      // Step 1: Tesseract.js 识别图片文字
      const { data: { text } } = await Tesseract.recognize(
        selectedFile,
        'eng+chi_sim',
        {
          logger: m => {
            if (m.status === 'recognizing text') {
              const pct = Math.round(m.progress * 100);
              const el = document.getElementById('ocr-progress-text');
              if (el) el.textContent = `正在识别图片文字… ${pct}%`;
            }
          }
        }
      );

      loadingEl.style.display = 'none';

      // Step 2: 展示原始文字，让用户编辑后再解析
      const rawArea = document.getElementById('ocr-raw-area');
      document.getElementById('ocr-raw-text').value = text.trim();
      rawArea.style.display = 'block';
    } catch (e) {
      loadingEl.style.display = 'none';
      document.getElementById('upload-preview').style.display = 'flex';
      toast('识别失败：' + e.message, 'error');
    }
  }

  async function parseRawText() {
    const text = document.getElementById('ocr-raw-text').value.trim();
    if (!text) { toast('文字内容为空', 'error'); return; }

    document.getElementById('ocr-raw-area').style.display = 'none';
    const loadingEl = document.getElementById('ocr-loading');
    loadingEl.innerHTML = '<div class="spinner"></div><p>DeepSeek AI 正在解析笔记结构…</p>';
    loadingEl.style.display = 'block';

    try {
      const data = await fetchJSON('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ocrText: text })
      });
      ocrResult = data.parsed;
      loadingEl.style.display = 'none';
      document.getElementById('ocr-result').style.display = 'block';
      renderOCRResult(ocrResult);
      toast('解析成功！请检查并编辑内容', 'success');
    } catch (e) {
      loadingEl.style.display = 'none';
      document.getElementById('ocr-raw-area').style.display = 'block';
      toast('解析失败：' + e.message, 'error');
    }
  }

  function renderOCRResult(parsed) {
    renderWordsList(parsed.words || []);
    renderPhrasesList(parsed.phrases || []);
    renderSentencesList(parsed.sentences || []);
  }

  function renderWordsList(words) {
    const container = document.getElementById('words-list');
    container.innerHTML = '';
    words.forEach((w, i) => {
      container.appendChild(makeWordRow(w, i));
    });
  }

  function makeWordRow(w, i) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.index = i;
    row.innerHTML = `
      <input type="text" placeholder="英文单词" value="${escHtml(w.en || '')}" data-field="en" />
      <input type="text" placeholder="中文释义" value="${escHtml(w.cn || '')}" data-field="cn" />
      <input type="text" placeholder="近义词（选填）" value="${escHtml(w.synonym || '')}" data-field="synonym" style="max-width:130px" />
      <button class="item-del" title="删除">✕</button>
    `;
    row.querySelector('.item-del').addEventListener('click', () => { row.remove(); syncOCRResult(); });
    row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', syncOCRResult));
    return row;
  }

  function renderPhrasesList(phrases) {
    const container = document.getElementById('phrases-list');
    container.innerHTML = '';
    phrases.forEach((p, i) => container.appendChild(makePhraseRow(p, i)));
  }

  function makePhraseRow(p, i) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <input type="text" placeholder="英文短语" value="${escHtml(p.en || '')}" data-field="en" />
      <input type="text" placeholder="中文释义" value="${escHtml(p.cn || '')}" data-field="cn" />
      <button class="item-del" title="删除">✕</button>
    `;
    row.querySelector('.item-del').addEventListener('click', () => { row.remove(); syncOCRResult(); });
    row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', syncOCRResult));
    return row;
  }

  function renderSentencesList(sentences) {
    const container = document.getElementById('sentences-list');
    container.innerHTML = '';
    sentences.forEach((s, i) => container.appendChild(makeSentenceRow(s, i)));
  }

  function makeSentenceRow(s, i) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <input type="text" placeholder="英文例句" value="${escHtml(s.en || '')}" data-field="en" style="flex:2" />
      <input type="text" placeholder="中文翻译" value="${escHtml(s.cn || '')}" data-field="cn" style="flex:2" />
      <input type="text" placeholder="填空单词（选填）" value="${escHtml(s.blank_word || '')}" data-field="blank_word" style="max-width:120px" />
      <button class="item-del" title="删除">✕</button>
    `;
    row.querySelector('.item-del').addEventListener('click', () => { row.remove(); syncOCRResult(); });
    row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', syncOCRResult));
    return row;
  }

  function syncOCRResult() {
    // 从 DOM 读回内容同步到 ocrResult
    ocrResult = ocrResult || {};
    ocrResult.words = readRows('words-list', ['en', 'cn', 'synonym']);
    ocrResult.phrases = readRows('phrases-list', ['en', 'cn']);
    ocrResult.sentences = readRows('sentences-list', ['en', 'cn', 'blank_word']);
  }

  function readRows(containerId, fields) {
    const rows = document.querySelectorAll(`#${containerId} .item-row`);
    return Array.from(rows).map(row => {
      const obj = {};
      fields.forEach(f => {
        const inp = row.querySelector(`[data-field="${f}"]`);
        if (inp) obj[f] = inp.value.trim();
      });
      return obj;
    }).filter(obj => Object.values(obj).some(v => v));
  }

  // 添加空行
  function addWord() {
    document.getElementById('words-list').appendChild(makeWordRow({ en: '', cn: '', synonym: '' }, -1));
  }
  function addPhrase() {
    document.getElementById('phrases-list').appendChild(makePhraseRow({ en: '', cn: '' }, -1));
  }
  function addSentence() {
    document.getElementById('sentences-list').appendChild(makeSentenceRow({ en: '', cn: '', blank_word: '' }, -1));
  }

  async function saveNote() {
    syncOCRResult();
    if (!ocrResult ||
        (ocrResult.words.length === 0 && ocrResult.phrases.length === 0 && ocrResult.sentences.length === 0)) {
      toast('请先识别并填写内容', 'error');
      return;
    }

    const btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.textContent = '保存中…';

    try {
      const today = getTodayStr();
      const note_id = `N${today.replace(/-/g, '')}${Date.now().toString().slice(-4)}`;
      const data = await fetchJSON('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          note_id,
          date: today,
          words: ocrResult.words,
          phrases: ocrResult.phrases,
          sentences: ocrResult.sentences
        })
      });

      toast('✅ 笔记已保存到飞书，复习计划已生成！', 'success');
      allNotes = []; // 清空缓存，下次重新加载
      resetUpload();
      document.getElementById('ocr-result').style.display = 'none';

      // 切换到复习 Tab 并刷新
      document.querySelector('[data-tab="review"]').click();
      setTimeout(loadTodayReview, 800);

    } catch (e) {
      toast('保存失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 保存到飞书';
    }
  }

  // ============================================================
  // SearchEngine
  // ============================================================
  function initSearch() {
    const input = document.getElementById('search-input');
    const btn = document.getElementById('btn-search');

    const doSearch = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) return;
      if (allNotes.length === 0) {
        loadLibrary().then(() => renderSearchResults(q));
      } else {
        renderSearchResults(q);
      }
    };

    btn.addEventListener('click', doSearch);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  }

  function renderSearchResults(query) {
    const results = allNotes.filter(note => {
      const text = JSON.stringify(note).toLowerCase();
      return text.includes(query);
    });

    const container = document.getElementById('search-results');
    const emptyEl = document.getElementById('search-empty');

    if (results.length === 0) {
      container.innerHTML = '';
      emptyEl.style.display = 'block';
    } else {
      emptyEl.style.display = 'none';
      container.innerHTML = '';
      results.forEach(note => container.appendChild(makeNoteCard(note)));
    }
  }

  // ============================================================
  // Library
  // ============================================================
  async function loadLibrary() {
    const loadingEl = document.getElementById('library-loading');
    const grid = document.getElementById('library-grid');
    const emptyEl = document.getElementById('library-empty');

    loadingEl.style.display = 'block';
    grid.innerHTML = '';
    emptyEl.style.display = 'none';

    try {
      const data = await fetchJSON('/api/notes');
      allNotes = data.notes || [];
      loadingEl.style.display = 'none';

      document.getElementById('library-count').textContent = `共 ${allNotes.length} 条笔记`;

      if (allNotes.length === 0) {
        emptyEl.style.display = 'block';
        return;
      }

      // 按日期倒序排列
      const sorted = [...allNotes].sort((a, b) => (b.date > a.date ? 1 : -1));
      sorted.forEach(note => grid.appendChild(makeNoteCard(note)));
    } catch (e) {
      loadingEl.style.display = 'none';
      toast('加载笔记失败：' + e.message, 'error');
    }
  }

  function makeNoteCard(note) {
    const card = document.createElement('div');
    card.className = 'note-card';

    const words = (note.words || []).slice(0, 5);
    const phrases = (note.phrases || []).slice(0, 3);

    const wordChips = words.map(w => `<span class="word-chip">${escHtml(w.en || '')}</span>`).join('');
    const phraseChips = phrases.map(p => `<span class="word-chip phrase-chip">${escHtml(p.en || '')}</span>`).join('');
    const moreCount = (note.words?.length || 0) + (note.phrases?.length || 0) - words.length - phrases.length;

    card.innerHTML = `
      <div class="note-card-date">📅 ${note.date || '未知日期'}</div>
      <div class="note-card-words">${wordChips}${phraseChips}${moreCount > 0 ? `<span class="word-chip" style="opacity:.6">+${moreCount}</span>` : ''}</div>
      <div class="note-card-stats">
        <span class="stat-item">📖 ${note.words?.length || 0} 单词</span>
        <span class="stat-item">💬 ${note.phrases?.length || 0} 短语</span>
        <span class="stat-item">📜 ${note.sentences?.length || 0} 例句</span>
      </div>
    `;
    card.addEventListener('click', () => openNoteModal(note));
    return card;
  }

  function openNoteModal(note) {
    const wordsHTML = (note.words || []).map(w => `
      <div class="modal-item">
        <span class="modal-item-en">${escHtml(w.en || '')}</span>
        <span class="modal-item-cn">${escHtml(w.cn || '')}</span>
        ${w.synonym ? `<span class="modal-item-syn">${escHtml(w.synonym)}</span>` : ''}
      </div>`).join('');

    const phrasesHTML = (note.phrases || []).map(p => `
      <div class="modal-item">
        <span class="modal-item-en">${escHtml(p.en || '')}</span>
        <span class="modal-item-cn">${escHtml(p.cn || '')}</span>
      </div>`).join('');

    const sentencesHTML = (note.sentences || []).map(s => `
      <div class="modal-item" style="flex-direction:column;gap:4px">
        <div style="color:#f0f2ff;font-weight:500">${escHtml(s.en || '')}</div>
        <div style="color:#8899bb;font-size:.88rem">${escHtml(s.cn || '')}</div>
        ${s.blank_word ? `<div style="color:#6d5dff;font-size:.8rem">填空：${escHtml(s.blank_word)}</div>` : ''}
      </div>`).join('');

    const bodyHTML = `
      ${wordsHTML ? `<div class="modal-section"><h4>📖 单词</h4>${wordsHTML}</div>` : ''}
      ${phrasesHTML ? `<div class="modal-section"><h4>💬 短语</h4>${phrasesHTML}</div>` : ''}
      ${sentencesHTML ? `<div class="modal-section"><h4>📜 例句</h4>${sentencesHTML}</div>` : ''}
    `;

    openModal(`笔记 · ${note.date}`, bodyHTML);
  }

  // ============================================================
  // Utils
  // ============================================================
  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    initTabs();
    initUpload();
    initSearch();

    // 闪卡操作
    document.getElementById('btn-reveal').addEventListener('click', revealAnswer);
    document.getElementById('btn-ok').addEventListener('click', () => {
      if (dontKnowMode) {
        // 「不认识」模式下点「下一题」→ 记为 unknown
        handleResult('unknown');
      } else {
        handleResult('ok');
      }
    });
    document.getElementById('btn-wrong').addEventListener('click', () => handleResult('wrong'));
    document.getElementById('btn-dontknow').addEventListener('click', handleDontKnow);

    // 飞书通知
    document.getElementById('notify-btn').addEventListener('click', sendNotify);

    // 模态框关闭
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('note-modal').addEventListener('click', e => {
      if (e.target.id === 'note-modal') closeModal();
    });

    // 键盘快捷键
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
      // 空格键翻牌
      if (e.key === ' ' && document.getElementById('panel-review').classList.contains('active')) {
        e.preventDefault();
        const card = document.getElementById('flash-card');
        if (!card.classList.contains('flipped')) revealAnswer();
      }
    });

    // 首次加载今日复习
    loadTodayReview();
  }

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露给 HTML onclick 使用的方法
  // ============================================================
  // 模式切换：拍照识别 / 直接输入
  // ============================================================
  function switchMode(mode) {
    const photoMode = document.getElementById('upload-area');
    const textMode = document.getElementById('text-input-area');
    const btnPhoto = document.getElementById('mode-photo');
    const btnText = document.getElementById('mode-text');

    if (mode === 'photo') {
      photoMode.style.display = 'block';
      textMode.style.display = 'none';
      btnPhoto.classList.add('active');
      btnText.classList.remove('active');
    } else {
      photoMode.style.display = 'none';
      textMode.style.display = 'block';
      btnPhoto.classList.remove('active');
      btnText.classList.add('active');
    }
    // 关闭已有结果
    document.getElementById('ocr-result').style.display = 'none';
    document.getElementById('ocr-loading').style.display = 'none';
  }

  async function parseManualText() {
    const text = document.getElementById('manual-text').value.trim();
    if (!text) { toast('请先输入笔记内容', 'error'); return; }

    const btn = document.getElementById('btn-parse-text');
    btn.disabled = true;
    btn.textContent = '解析中…';
    document.getElementById('ocr-loading').innerHTML = '<div class="spinner"></div><p>DeepSeek AI 正在解析笔记结构…</p>';
    document.getElementById('ocr-loading').style.display = 'block';

    try {
      const data = await fetchJSON('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ocrText: text })
      });
      ocrResult = data.parsed;
      document.getElementById('ocr-loading').style.display = 'none';
      document.getElementById('ocr-result').style.display = 'block';
      renderOCRResult(ocrResult);
      toast('解析成功！请检查并编辑内容', 'success');
    } catch (e) {
      document.getElementById('ocr-loading').style.display = 'none';
      toast('解析失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🤖 AI 解析';
    }
  }

  return { addWord, addPhrase, addSentence, startReview, loadTodayReview, switchMode, parseManualText, parseRawText };
})();
