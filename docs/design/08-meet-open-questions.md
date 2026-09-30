# Meet Feature — Open Questions

<overview>
Everything the Meet design leaves undecided or depends on something unverified. Each item says what the
design assumes meanwhile and who has to answer. The owner answers product questions; the implementer
answers feasibility questions before the affected screen is built. The exact requirement wording each
ratification item needs is in [09](09-meet-proposed-amendments.md).
</overview>

<architecture>
| # | Question | Design assumes meanwhile | Who answers | Affects |
|---|---|---|---|---|
| OQ-1 | Close confirmation: option A (confirm on live call, no setting), B (A plus a Settings switch, drawn in [06 §8](06-meet-shared-components.md)) or C (never confirm)? Does Meet's page really object to being closed only during a call? What is the behaviour on the pre-join screen? Note: a browser engine honours a page's unload objection only after the user has interacted with the page, so a user who never clicked or typed in the window may not trigger it; that is the "signal missing" case and fails toward closing without a dialog (I6). The hung-page timeout (proposed 3 s) is also an owner-adjustable value, **and it is unfixed**: a busy renderer during a live call may answer the unload check slowly, and a timeout that is too short would destroy a live call without a confirmation. Spike B must measure the typical answer time during a live call (camera on, screen shared, many participants) before the value is fixed | A. If Spike B cannot prove the signal, fall back to C | Owner (choice), implementer (signal, Spike B) | F5, SC-2, 09 A1 |
| OQ-2 | Exit while a live call exists asks first. This changes FR-07 for that case. Accept? | Yes, keyed on the same live-call check as OQ-1; missing signal means no dialog | Owner; requirements owner amends FR-07 | F6, 09 A2 |
| OQ-3 | A link blocked inside the call window: keep the neutral strip message only (designed), also copy it, open it in the system browser, or show nothing? Nothing is silent and is not recommended; the browser route conflicts with "call window denies its own popups" | Message only | Owner | F10, SC-1, 09 A5 |
| OQ-4 | Linux: Spike B must show whether the OS picker (xdg-desktop-portal, PipeWire) works with the user choosing explicitly and nothing pre-selected. The space rule already permits it on Linux only. Until then the app picker is used, including SP-8 for a single PipeWire source | App picker on Windows and, until Spike B, Linux | Implementer (Spike B), then owner | F3, F3b, SP-0, SP-8 |
| OQ-5 | In the OS-picker path, can the shell find out that the OS refused or the user cancelled, to say anything? | Meet's own "not presenting" message is the only feedback | Implementer | F3b |
| OQ-6 | Can the picker leave out the call window itself? | Left out if possible; otherwise shown as "(this call)" | Implementer | Picker list |
| OQ-7 | Share system audio with a screen or window (Windows)? Not requested | Not offered | Owner | Picker |
| OQ-8 | On a Meet load error, offer "Open in browser"? Depends on what the owner wants if Spike B shows Meet does not work in Electron (ADR-0004) | Not offered | Owner | CW-3 |
| OQ-9 | Remember the call window's size and position between calls? | No; opens 1024×720, centred | Owner | Call window |
| OQ-10 | The tray gains "Show call window" while a call window exists. FR-07 lists menu contents "at minimum", so this is additive but should be recorded there. Owner ratification | Added | Owner; requirements owner | SC-4, 09 A4 |
| OQ-11 | "A call is already open. The new link was not opened." is shown whenever a meeting page is on screen, which includes Meet's own end page, where "already open" is slightly early. Accept, or word it differently (fixed by the requirement today)? | Requirement wording | Owner | SC-3 |
| OQ-12 | Chat notification sounds during a call are not muted automatically (owner decision that notifications keep arriving), so other participants may hear them through the microphone. Mute stays on the tray | No automatic ducking | Owner | F9 |
| OQ-13 | Second link when no meeting page is on screen loads into the existing window instead of showing "call already open". Owner confirmation needed; it revises the FR-16 working default | Load into the existing window | Owner | F4, 09 A3 |
| OQ-14 | Working assumptions in FR-16 still pending the owner: one call window with a native notification regardless of mute; OS picker on Linux; tray Show/Hide acts on the main window only; indicators fire during a call. The design follows all four (the first as revised by OQ-13) | As stated | Owner | F4, F3b, F7, F9 |
| OQ-15 | **Decided by the technical lead.** The call window's own web contents is Meet (no preload); a child app view (bundled local page, own preload, own non-persistent session, sandboxed, no navigation) draws CW-1, CW-3, CW-4 and the strip over two messages (full state to the view; retry, reload, close, dismiss-strip back). Confirmed in the design: the panels give way when Meet loads; Google sign-in and the Meet landing page show the Meet view with the app view hidden; a crashed Meet page leaves the app view alive to draw CW-4; a close consults Meet's unload objection (invariants I1 to I6). **Requirements follow-up for the business analyst (not edited here):** NFR-07 needs a web-preferences assertion row for the app view (sandbox on, context isolation on, Node integration off, own non-persistent session, no navigation, bundled local page) beside the row for the Meet view | Decided | Business analyst records it in NFR-07 | CW-1, CW-3, CW-4, SC-1, SC-5 |
| OQ-16 | If Spike B shows Meet does not work inside Electron at all, most of this set changes. The design assumes it works | Works | Implementer (Spike B), then owner | All |
| OQ-18 | Page-initiated navigation while Meet objects to unloading (a Meet reload, Meet-internal navigation). **Premise unverified:** the design earlier assumed Meet keeps its own "Leave site?" prompt; in Electron an unhandled objection likely blocks the navigation **silently** (architecture Spike B item 12). If Spike B shows a silent block, choose: **(a)** accept it — narrow exposure, because the app's own reload and retry appear only in no-live-call states and there is no Ctrl+R; **(b)** show an app "Leave this page?" confirmation from a synchronous dialog inside the handler, which blocks the main process briefly (the main process also runs the tray, notifications and blink timer); **(c)** allow the unload for page-initiated navigations and drop the protection. **Recommendation: (a)**, because the block applies only while Meet says a call is live, which is the protection's whole purpose, and the app itself offers no route that navigates a live call. Reject (b) because stalling the main process affects Chat notifications and the tray for a rare case. Fall back to (c) only if Spike B shows a real Meet control that navigates during a live call and is being blocked with no feedback | (a) pending Spike B | Implementer (Spike B item 12), then owner | I4, F5 step 5, 09 A1 |
| OQ-17 | If Google blocks sign-in inside the call window, the user is told nothing by the app; the route is main-window sign-in then re-click (F12). Is that acceptable, or should the error panel say it? | Documented route only | Owner | F12, CW-5 |
</architecture>

<topics>
- [Flows](03-meet-flows.md)
- [Call window](04-meet-call-window.md)
- [Source picker](05-meet-source-picker.md)
- [Shared components](06-meet-shared-components.md)
- [Rationale](07-meet-rationale.md)
- [Proposed requirement amendments](09-meet-proposed-amendments.md)
</topics>
