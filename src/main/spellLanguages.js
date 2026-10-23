'use strict';

// UI-09 (browser-parity-gaps.md row 2): spellcheck in every OS-preferred language, no setting, no control.
//
// Platform behaviour (Electron 44 docs, tutorial/spellchecker and api/session):
//   Windows, Linux: Chromium's Hunspell checker; session.setSpellCheckerLanguages() takes effect (dictionaries are
//                   downloaded on first use). Electron does NOT use the Windows OS spellchecker.
//   macOS:          OS spellchecker, language detected by the OS; the API is a documented no-op (the app ships no
//                   macOS build; the call is harmless there).
//
// Privacy: only the count and the language codes are ever logged (codes are locale tags, never user text).

const FALLBACK = 'en-US';

/** Case-insensitive lookup of `code` in `available`; returns the available spelling or undefined. */
function exact(available, code) {
  const lower = code.toLowerCase();
  return available.find((a) => a.toLowerCase() === lower);
}

/** Resolves one preferred tag ("uk-UA", "en", "pt_BR") to an available dictionary code, or undefined. */
function resolveOne(tag, available) {
  if (typeof tag !== 'string') return undefined;
  const code = tag.trim().replace(/_/g, '-');
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code)) return undefined;
  const direct = exact(available, code);
  if (direct) return direct;
  const base = code.split('-')[0];
  const baseHit = exact(available, base);
  if (baseHit) return baseHit;
  // Bare "en" (or a region without its own dictionary): prefer the fallback region, else the first regional one.
  const regional = available.filter((a) => a.toLowerCase().startsWith(`${base.toLowerCase()}-`));
  if (regional.length === 0) return undefined;
  return regional.find((a) => a.toLowerCase() === FALLBACK.toLowerCase()) || regional[0];
}

/**
 * chooseSpellLanguages(preferred, available) -> string[] (never empty).
 * Order of the preferred list is kept, duplicates dropped, unavailable languages skipped, en-US when nothing remains.
 */
function chooseSpellLanguages(preferred, available) {
  const avail = Array.isArray(available) ? available.filter((a) => typeof a === 'string') : [];
  const out = [];
  for (const tag of Array.isArray(preferred) ? preferred : []) {
    const hit = resolveOne(tag, avail);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out.length > 0 ? out : [FALLBACK];
}

/**
 * applySpellLanguages(ses, app, log) - sets the languages on the Chat session. Never throws.
 * `log(message)` receives the count and the codes only.
 */
function applySpellLanguages(ses, app, log = () => {}) {
  try {
    const preferred = typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : [];
    const languages = chooseSpellLanguages(preferred, ses.availableSpellCheckerLanguages);
    ses.setSpellCheckerLanguages(languages);
    log(`spellcheck languages: count=${languages.length} codes=${languages.join(',')}`);
    return languages;
  } catch (err) {
    log(`spellcheck languages: not applied (${err && err.name ? err.name : 'error'})`);
    return undefined;
  }
}

module.exports = { FALLBACK, chooseSpellLanguages, applySpellLanguages };
