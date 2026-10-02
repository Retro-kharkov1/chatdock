'use strict';

// Screen-share picker renderer (docs/design/05-meet-source-picker.md). Talks to the main process
// only through window.__gcdPickerBridge (getSources / choose / cancel). All text is written with
// textContent; thumbnails are data: URLs set as <img> sources. Nothing is ever pre-selected and
// nothing is shared until the user presses Share.

(function () {
  const bridge = window.__gcdPickerBridge;

  const el = {
    tabs: Array.from(document.querySelectorAll('[role="tab"]')),
    refresh: document.getElementById('refresh-button'),
    content: document.getElementById('content'),
    loading: document.getElementById('loading-state'),
    error: document.getElementById('error-state'),
    errorCode: document.getElementById('error-code'),
    empty: document.getElementById('empty-state'),
    emptyGlyph: document.getElementById('empty-glyph'),
    emptyTitle: document.getElementById('empty-title'),
    emptyDetail: document.getElementById('empty-detail'),
    list: document.getElementById('source-list'),
    status: document.getElementById('status'),
    cancel: document.getElementById('cancel-button'),
    retry: document.getElementById('retry-button'),
    share: document.getElementById('share-button'),
    toolbar: document.getElementById('toolbar'),
  };

  const IDLE_TEXT = 'Select a screen or window to share.';

  const state = {
    phase: 'loading', // 'loading' | 'list' | 'error'
    sources: [],
    tab: 'screen', // 'screen' | 'window'
    selectedId: null,
    sharing: false,
  };

  function show(node, visible) {
    node.hidden = !visible;
  }

  function setStatus(text, isError) {
    el.status.textContent = text;
    el.status.classList.toggle('is-error', Boolean(isError));
  }

  function sourcesOfTab() {
    return state.sources.filter((s) => s.kind === state.tab);
  }

  function selectedSource() {
    return state.sources.find((s) => s.id === state.selectedId) || null;
  }

  function syncTabs() {
    for (const tab of el.tabs) {
      const active = tab.dataset.kind === state.tab;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
    }
  }

  function syncFooter() {
    const loaded = state.phase === 'list';
    show(el.retry, state.phase === 'error');
    show(el.share, state.phase !== 'error');
    el.refresh.disabled = state.phase === 'loading' || state.sharing;
    el.share.disabled = !(loaded && state.selectedId !== null) || state.sharing;
    show(el.toolbar, state.phase !== 'error');
  }

  function renderCard(source) {
    const label = document.createElement('label');
    label.className = 'card';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'source';
    input.value = source.id;
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    if (typeof source.thumbnail === 'string' && source.thumbnail.startsWith('data:image/')) {
      img.src = source.thumbnail;
    }
    const name = document.createElement('span');
    name.className = 'label';
    name.textContent = source.name;
    name.title = source.name;
    const check = document.createElement('span');
    check.className = 'check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    label.append(input, img, name, check);
    input.addEventListener('change', () => select(source.id));
    return label;
  }

  function select(id) {
    state.selectedId = id;
    for (const card of el.list.querySelectorAll('.card')) {
      const on = card.querySelector('input').value === id;
      card.classList.toggle('is-selected', on);
    }
    const source = selectedSource();
    setStatus(source ? 'Selected: ' + source.name : IDLE_TEXT, false);
    syncFooter();
  }

  function renderEmpty() {
    const total = state.sources.length;
    show(el.empty, true);
    if (total === 0) {
      el.emptyGlyph.textContent = '(!)';
      el.emptyTitle.textContent = 'Nothing to share was found';
      el.emptyDetail.textContent =
        'No screens or windows could be listed. Press Refresh to try again, or cancel to go back to the call.';
      setStatus('Nothing selected.', false);
    } else {
      el.emptyGlyph.textContent = '(i)';
      if (state.tab === 'window') {
        el.emptyTitle.textContent = 'No windows to share';
        el.emptyDetail.textContent =
          'Open the window you want to share, then press Refresh. You can also share a whole screen from the Screens tab.';
      } else {
        el.emptyTitle.textContent = 'No screens to share';
        el.emptyDetail.textContent =
          'Press Refresh to try again. You can also share a single window from the Windows tab.';
      }
      setStatus(IDLE_TEXT, false);
    }
  }

  function render() {
    syncTabs();
    show(el.loading, state.phase === 'loading');
    show(el.error, state.phase === 'error');
    show(el.empty, false);
    show(el.list, false);
    el.content.setAttribute('aria-busy', state.phase === 'loading' ? 'true' : 'false');

    if (state.phase === 'list') {
      const items = sourcesOfTab();
      el.list.textContent = '';
      if (items.length === 0) {
        renderEmpty();
      } else {
        for (const source of items) el.list.appendChild(renderCard(source));
        show(el.list, true);
        const source = selectedSource();
        setStatus(source ? 'Selected: ' + source.name : IDLE_TEXT, false);
      }
    }
    syncFooter();
  }

  async function load(keepStatus) {
    state.phase = 'loading';
    state.selectedId = null;
    if (!keepStatus) setStatus(IDLE_TEXT, false);
    render();
    try {
      const list = await bridge.getSources();
      state.sources = Array.isArray(list) ? list : [];
      state.phase = 'list';
      // Screens first; if there are no screens but there are windows, show the windows.
      if (!state.sources.some((s) => s.kind === state.tab) && state.sources.length > 0) {
        state.tab = state.sources[0].kind;
      }
    } catch (err) {
      state.phase = 'error';
      el.errorCode.textContent = 'Code: ' + ((err && err.name) || 'Error');
      setStatus('Nothing has been shared.', false);
    }
    render();
  }

  function switchTab(kind, focusTab) {
    if (state.phase !== 'list' || kind === state.tab) return;
    state.tab = kind;
    state.selectedId = null;
    render();
    if (focusTab) el.tabs.find((t) => t.dataset.kind === kind).focus();
  }

  async function share() {
    const source = selectedSource();
    if (!source || state.sharing) return;
    state.sharing = true;
    syncFooter();
    let reply = null;
    try {
      reply = await bridge.choose(source.id);
    } catch (err) {
      reply = null;
    }
    state.sharing = false;
    if (reply && reply.ok === true) return; // main closes the picker
    // The chosen source is gone (or the choice was refused): say so, refresh, clear the selection.
    const wasWindow = source.kind === 'window';
    await load(true);
    setStatus(
      wasWindow
        ? 'That window was closed. Choose another one.'
        : 'That screen is no longer available. Choose another one.',
      true
    );
    const first = el.list.querySelector('input');
    if (first) first.focus();
  }

  // --- wiring ------------------------------------------------------------------------------------
  for (const tab of el.tabs) {
    tab.addEventListener('click', () => switchTab(tab.dataset.kind, false));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      switchTab(state.tab === 'screen' ? 'window' : 'screen', true);
    });
  }
  el.refresh.addEventListener('click', () => load(false));
  el.retry.addEventListener('click', () => load(false));
  el.cancel.addEventListener('click', () => bridge.cancel());
  el.share.addEventListener('click', share);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      bridge.cancel();
    }
  });

  // Loading state first: the window is already showing; only now ask main for the (slow) list.
  syncTabs();
  el.tabs[0].focus();
  load(false);
})();
