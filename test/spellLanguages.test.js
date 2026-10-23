'use strict';

// UI-09 coverage map (acceptance -> test):
//   uk and en both checked when both preferred      -> 'keeps every available preferred language, in order'
//   regional tag maps to base / regional dictionary -> 'maps a regional tag...', 'bare base picks en-US'
//   unavailable language skipped                    -> 'skips an unavailable language'
//   empty / nothing remains -> en-US                -> 'falls back...' (x3)
//   duplicates, junk input                          -> 'drops duplicates', 'ignores malformed tags'
//   applied on the given session, log = count+codes -> 'applySpellLanguages...'
//   API failure does not throw                      -> 'never throws'

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseSpellLanguages, applySpellLanguages } = require('../src/main/spellLanguages');

const AVAIL = ['en-US', 'en-GB', 'uk', 'de', 'pt-BR', 'fr'];

test('keeps every available preferred language, in order', () => {
  assert.deepEqual(chooseSpellLanguages(['uk-UA', 'en-US'], AVAIL), ['uk', 'en-US']);
});

test('maps a regional tag to its base dictionary and exact regional ones case-insensitively', () => {
  assert.deepEqual(chooseSpellLanguages(['de-AT', 'pt-br', 'en_GB'], AVAIL), ['de', 'pt-BR', 'en-GB']);
});

test('bare base picks en-US when available, else the first regional dictionary', () => {
  assert.deepEqual(chooseSpellLanguages(['en'], AVAIL), ['en-US']);
  assert.deepEqual(chooseSpellLanguages(['en'], ['en-GB', 'en-AU']), ['en-GB']);
});

test('skips an unavailable language', () => {
  assert.deepEqual(chooseSpellLanguages(['xx-YY', 'fr-FR'], AVAIL), ['fr']);
});

test('falls back to en-US on empty, all-unavailable or non-array input', () => {
  assert.deepEqual(chooseSpellLanguages([], AVAIL), ['en-US']);
  assert.deepEqual(chooseSpellLanguages(['xx'], AVAIL), ['en-US']);
  assert.deepEqual(chooseSpellLanguages(undefined, undefined), ['en-US']);
});

test('drops duplicates', () => {
  assert.deepEqual(chooseSpellLanguages(['uk-UA', 'uk', 'en', 'en-US'], AVAIL), ['uk', 'en-US']);
});

test('ignores malformed tags', () => {
  assert.deepEqual(chooseSpellLanguages([42, null, '', '../x', 'uk'], AVAIL), ['uk']);
});

test('applySpellLanguages sets the list on the session and logs only count and codes', () => {
  const set = [];
  const logs = [];
  const ses = { availableSpellCheckerLanguages: AVAIL, setSpellCheckerLanguages: (l) => set.push(l) };
  const app = { getPreferredSystemLanguages: () => ['uk-UA', 'en-US', 'xx-ZZ'] };
  const result = applySpellLanguages(ses, app, (m) => logs.push(m));
  assert.deepEqual(result, ['uk', 'en-US']);
  assert.deepEqual(set, [['uk', 'en-US']]);
  assert.deepEqual(logs, ['spellcheck languages: count=2 codes=uk,en-US']);
  assert.ok(!logs[0].includes('xx-ZZ'));
});

test('never throws when the session API fails', () => {
  const logs = [];
  const ses = {
    availableSpellCheckerLanguages: AVAIL,
    setSpellCheckerLanguages: () => {
      throw new Error('boom: secret');
    },
  };
  assert.equal(applySpellLanguages(ses, { getPreferredSystemLanguages: () => ['uk'] }, (m) => logs.push(m)), undefined);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('secret'));
});
