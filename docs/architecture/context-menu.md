# Right-click context menu (UI-08)

<overview>
Electron draws no context menu, so right-click in the message box, the search box and on images did nothing
([Browser parity gaps](browser-parity-gaps.md) row 1). `src/main/contextMenu.js` builds a native popup menu in the main
process from the `context-menu` event params. No page injection, no new IPC channel, no preload change, no permission
change. Spelling languages are out of scope (UI-09), as are image/file paste (BUG-11) and shortcuts (UI-11).
</overview>

## Where it applies

- The main Chat window (`index.js`, next to `bindSmartCopyMain`).
- Every Google app window (`googleAppWindow.js`, optional `bindContextMenu` hook, same place as `bindSmartCopy`).
- Not the call window, Settings, the source picker or Help (they keep their minimal surface).

## What the menu contains

`buildContextMenuTemplate(params, actions)` is a pure function; sections are separated by one separator, and an empty
template means no menu is shown.

| Section | Shown when | Items |
|---|---|---|
| Spelling | editable field and `misspelledWord` set | up to 5 `dictionarySuggestions` (`replaceMisspelling`), or a disabled "No spelling suggestions"; "Add to dictionary" (`session.addWordToSpellCheckerDictionary`, persisted with the `persist:` session) |
| Edit | editable field | Cut, Copy, Paste, Select all, each enabled only by the matching `editFlags` value (roles `cut`/`copy`/`paste`/`selectAll`) |
| Selection | not editable, non-empty `selectionText`, `canCopy` | Copy |
| Link | `copyableLinkUrl(linkURL)` is not null (http, https, mailto, unwrapped `google.com/url?q=`) | Copy link |
| Image | `mediaType` is `image` | Copy image (`copyImageAt`, when image contents exist); Save image as... (only for an `https:` `srcURL`) |

## Rules kept

- **No doubled menu.** Chromium emits `context-menu` only when the page did not `preventDefault()` the `contextmenu`
  event, so a page that draws its own menu (Chat message actions) gets no second one.
- **Quit only from the tray.** No quit, exit, close or window-management item, and no application menu is installed;
  a test pins the absence.
- **Save image** calls `webContents.downloadURL(srcURL)`, so it hits the existing session `will-download` handler
  (`downloads.js`: scheme rule for the main window, host rules for Google windows, always a Save dialog). `blob:`,
  `data:` and `http:` sources get no Save item.
- **Smart copy is unchanged.** The silent right-click link copy and the "Link copied" hint in `smartCopy.js` still run on the
  same event; "Copy link" in the menu is the explicit form of the same filtered URL. Copy-on-select is untouched.
- **External links** still go only through the link router; the menu has no "Open link" item.
- **Logging**: `contextmenu shown` or a failure name only; never a word, suggestion, URL or selection.

## Test-coverage map

U = unit (`test/contextMenu.test.js`, injected fakes). M = manual on a real desktop.

| Surface | Level | Asserted |
|---|---|---|
| Template: edit | U | enabled per `editFlags`, missing/non-boolean flags disabled |
| Template: spelling | U | suggestions capped at 5, placeholder, Add to dictionary, junk dropped, needs an editable field |
| Template: selection / link / image | U | Copy only with a selection; Copy link filtering (`tel:`, `javascript:` none; wrapper unwrapped); image items, https-only Save |
| Template: structure | U | one separator between sections, empty template for nothing to offer, never throws, no quit/close item |
| Binder | U | one popup on the contents' window, none when empty/destroyed/no window, no `preventDefault`, actions reach the contents, throwing action contained, no content logged |
| Wiring | U | `googleAppWindow` hook once per window; `index.js` binds main + Google windows; call/Settings/picker/Help do not; preloads untouched |
| Real desktop | M | right-click composer and search box (Windows): edit items enabled/disabled correctly; misspelled word -> replace and Add to dictionary (stays after restart); image in a message -> Copy image pastes elsewhere, Save image shows the Save dialog; a link -> Copy link and the silent copy hint; a Chat message action menu appears alone; Drive/Docs window; the tray still has the only Exit |
