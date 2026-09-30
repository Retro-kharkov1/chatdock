# Meet Feature — Proposed Requirement Amendments (for owner ratification)

<overview>
Exact wording the Meet design needs added or changed in [requirements.md](../business/requirements.md).
**This file does not change the requirements.** Each item is a proposal for the owner to ratify and the
requirements owner to apply; until then the design marks these behaviours as working proposals. Terms
"call window exists", "meeting page on screen" and "live call", and the close invariants I1 to I6, are
defined in [03 §0](03-meet-flows.md).

Related decision already made outside this file: the space rule was amended on 2026-09-30 to permit, on
Linux only, the operating system's own screen-share picker (for example xdg-desktop-portal) in place of the
application's picker, conditional on Spike B showing it works and on the user still choosing explicitly
(never a silent or pre-selected source). Item A7 applies that amendment to FR-16.
</overview>

<architecture>
## A1 — FR-16: closing the call window (replaces the scenario "Closing the call window destroys it and does not quit the app")

```gherkin
  Scenario: [automatable] Closing the call window destroys it and does not quit the app (no live call)
    Given the call window is open and Meet's page does not object to being closed
    And the main Chat window is hidden to tray
    When the user closes the call window
    Then no confirmation is shown
    And the call window is destroyed (not hidden)
    And the application process keeps running
    And the tray icon remains visible
    And the main Chat window remains hidden

  Scenario: [automatable] A live call asks before the window closes (stubbed page that objects to unload)
    Given the call window shows a page that objects to being closed
    When the user closes the call window
    Then a confirmation "Close the call window?" is shown with "Close window" and "Keep window open"
    And "Keep window open" is the default and the Escape answer
    When the user chooses "Keep window open"
    Then the call window stays open and focused
    When the user closes the call window again and chooses "Close window"
    Then the call window is destroyed and the application keeps running

  Scenario: [automatable] Missing live-call signal fails toward closing without a dialog
    Given the shell cannot determine whether the page objects to being closed
    When the user closes the call window
    Then the call window is destroyed without a confirmation

  Scenario: [automatable] Closing is not silent while the source picker is open
    Given the call window has the source picker open
    When the user tries to close the call window
    Then the call window does not close
    And the source picker is raised and focused

  Scenario: [automatable] A close is never silently swallowed (invariant)
    Given a call window whose page objects to being unloaded
    When the user closes the call window by any route (title-bar close, Alt+F4, taskbar close, Exit)
    Then exactly one of these happens: the window is destroyed, or the confirmation is shown
      (or, with the picker open, the picker is raised)
    And it is never the case that nothing visibly happens

  Scenario: [automatable] A hung page does not block closing
    Given the call window's page never answers the unload check
    When the user closes the call window
    Then after the timeout (proposed 3 seconds) the page is treated as not live
    And the call window is destroyed without a confirmation

  Scenario: [automatable] The override applies only to app-initiated closes
    Given the call window's page objects to being unloaded
    When the page itself navigates (a reload or a Meet-internal navigation)
    Then the shell does not override the objection, so the navigation does not go through while the
      page objects
    # What the user sees (a prompt, or a silent block) is unverified and depends on the owner's choice
    # among the fallbacks in OQ-18 once Spike B reports; this scenario asserts only "not overridden"
    When the user instead closes the window and chooses "Close window" in the confirmation
    Then the objection is overridden for that close only and the window is destroyed

  Scenario: [automatable] No user activation means no objection, and the close goes through
    Given the page objects only after user interaction and the user has not interacted with it
    When the user closes the call window
    Then the call window is destroyed without a confirmation
```
Owner choice inside A1 (option A, B or C): [Rationale §2](07-meet-rationale.md), OQ-1. Under B add a
Settings scenario "Confirm before closing a call" off means no dialog; under C delete the second and
third scenarios.

## A2 — FR-07: Exit while a live call exists (new scenario beside "Exit via tray menu is the only way to quit")

```gherkin
  Scenario: [automatable] Exit asks first while a live call exists
    Given a call window is open and its page objects to being closed
    When the user selects "Exit" from the tray context menu
    Then a confirmation "Exit Google Chat Desktop?" is shown with "Exit" and "Cancel"
    And "Cancel" is the default and the Escape answer
    When the user chooses "Exit"
    Then the application process terminates and the tray icon disappears
    When the user chooses "Cancel"
    Then the application keeps running and the call window is unchanged

  Scenario: [automatable] Exit with the source picker open
    Given a call window is open with the source picker open
    When the user selects "Exit" from the tray context menu
    Then the source picker is closed as part of exiting and its display-capture request is denied
    And no source is shared
    And the normal Exit rules apply: a live call gets the "Exit Google Chat Desktop?" confirmation,
      otherwise the application terminates without one
    And the picker is not raised or flashed instead of exiting

  Scenario: [automatable] Exit is unchanged when there is no live call
    Given no call window exists, or its page does not object to being closed
    When the user selects "Exit" from the tray context menu
    Then the application process terminates without a confirmation
```
The Exit check is itself a close attempt on the call window (invariant I5): a page that does not object is
destroyed and Exit proceeds, so "Cancel" only has something to cancel when the page objects. The
existing scenario "Exit via tray menu is the only way to quit" stays valid for the no-call case. The
FR-07 sentence "**Exit** — the only action that actually terminates the application process" gains: "While
a live call exists it first asks for confirmation."

## A3 — FR-16: second link, replaces the "working default" and the scenario "A second Meet link focuses the existing call window"

Working default, reworded: "Activating a second Meet link while a call window exists never opens a second
window. If the call window shows a meeting page, the existing window is focused, the existing call is not
navigated, and the notification below is shown regardless of mute. If it shows no meeting page (loading,
load error, crashed, Google sign-in, Meet landing page), the new link is loaded into the existing window
and no notification is shown."

```gherkin
  Scenario: [automatable] A second Meet link while a meeting page is on screen (working default)
    Given a call window is open and shows a meeting page
    When the user activates another Meet link
    Then the existing call window is restored, raised and focused
    And no second call window is created
    And the existing call is not navigated
    And a native OS notification "A call is already open. The new link was not opened." is shown,
      even if "Mute notifications" is on
    And clicking that notification focuses the existing call window

  Scenario: [automatable] A second Meet link while no meeting page is on screen (working default)
    Given a call window is open showing its loading state, a load error, the crashed state, a Google
      sign-in page or the Meet landing page
    When the user activates another Meet link
    Then the new link is loaded into the existing call window
    And the window is raised and focused
    And no "call already open" notification is shown
    And no second call window is created

  Scenario: [automatable] An unrecognised Meet address form counts as a meeting page
    Given a call window is open on a Meet address the shell does not recognise
    When the user activates another Meet link
    Then the existing call is not navigated and the notification is shown
```

## A4 — FR-07: tray menu entry

Add to the FR-07 list: "**Show call window** — present only while a call window exists (in any of its
states); restores, raises and focuses it, and never touches the main Chat window. Placed first in the
menu."

```gherkin
  Scenario: [automatable] Show call window from the tray
    Given a call window is open behind other windows
    When the user selects "Show call window" from the tray menu
    Then the call window is restored, raised and focused
    And the main Chat window is unchanged

  Scenario: [automatable] The entry is absent without a call window
    Given no call window exists
    When the user opens the tray menu
    Then the menu contains no "Show call window" entry
```

## A5 — FR-16 / NFR-07: blocked link message

Add to NFR-07 "Call window hardening": "When the call window blocks a popup or a navigation to a host
other than `meet.google.com` or `accounts.google.com`, the user is told with the message 'A link was not
opened.'; it stays until dismissed."

```gherkin
  Scenario: [automatable] A blocked link is not silent
    Given the call window is open on a Meet page
    When the page tries to open a popup or navigate to another site
    Then the navigation is blocked
    And a status message "A link was not opened." is shown with a dismiss control
```
Owner decision still open: whether the link is also copied or opened in the system browser (OQ-3).

## A6 — FR-16: crashed page

```gherkin
  Scenario: [automatable] A crashed call page is reported and can be reloaded or closed
    Given the call window's page process has ended unexpectedly
    Then the window shows "The call window stopped working" with "Reload" and "Close window"
    When the user chooses "Close window"
    Then the call window is destroyed without a confirmation and the application keeps running
```

## A7 — FR-16: Linux OS picker conditional

Reword "Linux with PipeWire" working default: "On Linux only, and **only if Spike B shows it works**, the
operating system's own picker (for example xdg-desktop-portal) replaces the application's picker; the
user still chooses explicitly and no source is ever chosen automatically or pre-selected. Otherwise the
application's picker is used on Linux as well." This follows the space rule amended on 2026-09-30
(conditional on Spike B, explicit user choice).

## A8 — NFR-07: web-preferences assertion for the app view (for the business analyst to record)

The call window now has two views (decided by the technical lead). NFR-07's "call window hardening" row
covers the Meet view. Proposed addition, not edited here: "The call window's child **app view** is
created with context isolation on, Node integration off, sandbox on, its own non-persistent session (not
the main session), a bundled local page, and no navigation; it talks to the main process only through its
preload script's two channels (state to the view; retry, reload, close, dismiss-strip from the view)."
</architecture>

<topics>
- [Flows](03-meet-flows.md)
- [Rationale](07-meet-rationale.md)
- [Open questions](08-meet-open-questions.md)
- [Requirements — FR-16, NFR-07, FR-07](../business/requirements.md)
</topics>
