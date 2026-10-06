'use strict';

// FR-15 renderer logic for the Settings window. Talks to main exclusively through
// `window.__gcdSettingsBridge` (src/preload/settingsPreload.js) — no Node/Electron access here,
// consistent with `contextIsolation: true`/`sandbox: true` (docs/architecture/ipc-contract.md
// "Settings window"). Implements docs/design/00-settings-surface-spec.md §4 (immediate apply +
// optimistic UI + reconciliation, live two-way Mute sync) and §5 (Loading/Default/Toggling/
// Unavailable/Muted states).

(async () => {
  const bridge = window.__gcdSettingsBridge;

  const switches = {
    startAtLogin: document.getElementById('startAtLogin'),
    soundEnabled: document.getElementById('soundEnabled'),
    notificationsMuted: document.getElementById('notificationsMuted'),
    blinkOnUnread: document.getElementById('blinkOnUnread'),
  };
  const errorStartAtLogin = document.getElementById('error-startAtLogin');
  const retryStartAtLogin = document.getElementById('retry-startAtLogin');
  const blinkNote = document.getElementById('note-blinkOnUnread');
  const about = document.getElementById('about');
  const appRoot = document.getElementById('app');

  let lastFailedAttempt = null; // { key, value } — only meaningfully retried for startAtLogin.

  function setSwitch(key, value) {
    switches[key].checked = Boolean(value);
  }

  function enableAllControls() {
    for (const el of Object.values(switches)) {
      el.disabled = false;
      el.removeAttribute('tabindex');
    }
  }

  function updateBlinkNote() {
    // Design spec §4 "Blink pauses, doesn't grey out, while muted": the switch stays interactive;
    // only the inline status note toggles.
    blinkNote.hidden = !switches.notificationsMuted.checked;
  }

  function showStartAtLoginError(message) {
    errorStartAtLogin.textContent = message;
    errorStartAtLogin.hidden = false;
    retryStartAtLogin.hidden = false;
    switches.startAtLogin.setAttribute('aria-describedby', 'error-startAtLogin');
  }

  function clearStartAtLoginError() {
    errorStartAtLogin.hidden = true;
    errorStartAtLogin.textContent = '';
    retryStartAtLogin.hidden = true;
    switches.startAtLogin.removeAttribute('aria-describedby');
  }

  /**
   * applyChange(key, value) — optimistic UI is already reflected by the native checkbox's own
   * click/keyboard toggle before this runs; this function asks main to apply it and reconciles
   * (reverts) on failure, per design spec §4.
   */
  async function applyChange(key, value) {
    let result;
    try {
      result = await bridge.set(key, value);
    } catch (err) {
      result = { ok: false, message: 'Something went wrong applying this change.' };
    }

    if (!result || result.ok !== true) {
      setSwitch(key, !value); // revert — never claim a setting is on when main disagrees.
      if (key === 'startAtLogin') {
        lastFailedAttempt = { key, value };
        showStartAtLoginError(
          (result && result.message) || 'Something went wrong applying this change.'
        );
      }
      return;
    }

    if (key === 'startAtLogin') {
      lastFailedAttempt = null;
      clearStartAtLoginError();
    }
    if (key === 'notificationsMuted') updateBlinkNote();
  }

  for (const key of Object.keys(switches)) {
    switches[key].addEventListener('change', (event) => {
      applyChange(key, event.target.checked);
    });
  }

  // UI-06: opens the in-app Help window (main validates the sender; nothing is passed).
  document.getElementById('open-help').addEventListener('click', () => bridge.openHelp());

  retryStartAtLogin.addEventListener('click', () => {
    if (!lastFailedAttempt || lastFailedAttempt.key !== 'startAtLogin') return;
    const { value } = lastFailedAttempt;
    setSwitch('startAtLogin', value);
    applyChange('startAtLogin', value);
  });

  // Design spec §4 "Keyboard": Escape closes the window — equivalent to the title-bar close
  // button, does not quit the app (no app.quit() reachable from this window at all).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close();
  });

  // Live two-way sync (design spec §4): a change made elsewhere (today, only the tray's Mute
  // checkbox) is pushed here and reflected without re-triggering a `settings:set` call — this
  // listener only ever *reads* the pushed value into the DOM, it never calls bridge.set().
  bridge.onChanged(({ key, value }) => {
    if (!(key in switches)) return;
    setSwitch(key, value);
    if (key === 'notificationsMuted') updateBlinkNote();
  });

  // BUG-06: report the content height to main (which sizes the window to it). Started only after
  // the first real state is rendered, so the window is never shown at the loading-state height.
  let lastReported = null;
  function reportHeight() {
    const height = Math.ceil(appRoot.getBoundingClientRect().height);
    if (height > 0 && height !== lastReported) {
      lastReported = height;
      bridge.reportContentHeight(height);
    }
  }
  function startReportingHeight() {
    reportHeight();
    new ResizeObserver(reportHeight).observe(appRoot);
  }

  try {
    const all = await bridge.getAll();
    setSwitch('startAtLogin', all.startAtLogin);
    setSwitch('soundEnabled', all.soundEnabled);
    setSwitch('notificationsMuted', all.notificationsMuted);
    setSwitch('blinkOnUnread', all.blinkOnUnread);
    updateBlinkNote();
    about.textContent = `Google Chat Desktop ${all.version || ''}`.trim();
    about.hidden = false;
    enableAllControls();
    appRoot.setAttribute('aria-busy', 'false');
    startReportingHeight();
  } catch (err) {
    about.textContent = 'Settings unavailable — something went wrong loading preferences.';
    about.hidden = false;
    console.error('[gcd-settings] failed to load settings', err);
    startReportingHeight();
  }
})();
