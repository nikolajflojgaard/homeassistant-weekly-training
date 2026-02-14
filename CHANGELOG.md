# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- (none)

## 0.1.1 - 2026-02-14

- Weekly canvas UI (Week + weekday selection) and improved people management in the card.
- Updated README + tablet/mobile screenshots to match the new UI.

## 0.1.2 - 2026-02-14

- Fix: register frontend card + websocket/services from `async_setup_entry` as well (more reliable in config-entry-only setups).

## 0.1.3 - 2026-02-14

- Fix: card JS syntax error (stray CSS after `customElements.define`), which could prevent the custom element from registering.

## 0.1.4 - 2026-02-14

- Card UI overhaul:
  - Week header (no week switching yet)
  - People managed from a top "People" modal
  - Day list on the left + workout detail panel on the right
  - Day click opens a workout popup to generate/replace the session
- Add card config: `max_width` (e.g. `1100px`)

## 0.1.5 - 2026-02-14

- Tablet-first polish (iPad portrait shows the 2-column layout).
- More neutral/minimal look:
  - Use HA theme scrim color for modals (no hard-coded overlay color).
  - Screenshots updated to a neutral accent color.

## 0.1.6 - 2026-02-14

- UI fix: the card always fills the available Lovelace column width (no auto-centering).

## 0.1.7 - 2026-02-14

- Header redesign (tablet-first):
  - Week bar with date range (week switching disabled for now)
  - Persistent people avatars in the header (click to edit/update/delete)
  - Gear icon opens exercise settings (disable built-ins + add custom exercises)
- Exercise settings are stored in HA storage and applied to session generation.

## 0.1.8 - 2026-02-14

- UI polish:
  - Day list shows date per day and marks TODAY
  - Detail panel gets a colored accent matching the selected person
  - Exercise settings redesigned to a grouped grid (by primary muscle group)
- Focus stability:
  - No re-render on settings search or planning-mode toggle (keeps iPad focus/cursor stable)
- Week rollover:
  - New week starts at **Monday 01:00** (local time), not at midnight
- Compatibility:
  - Remove optional chaining/nullish coalescing from the card JS (avoids parse errors on older WebViews)

## 0.1.9 - 2026-02-14

- People:
  - Click avatar chip: set active person (UI accent follows)
  - Long-press avatar chip: edit person
  - Person color is editable and persisted (used across UI)
- Week header:
  - Clean header: week number + date range (no arrows)
- Day list:
  - Dates always shown (person-independent)
  - TODAY is strongly highlighted
  - Shows multiple per-person workout badges per day (Workout/Done)
- Workouts:
  - Swipe right on a generated workout: toggle Completed
  - Swipe left: Delete workout
  - Completed bar at the bottom shows all completed workouts for the current week across all people
- Automation:
  - Previous week is cleared automatically at **Monday 01:00** (local time)

## 0.1.10 - 2026-02-14

- Fix: calendar runtime (`today`, `current_week_start`, week number) is now included on all websocket state updates.
  - Prevents TODAY marker and dates from changing/disappearing when switching active person or toggling completed/delete.

## 0.1.11 - 2026-02-14

- UI fix: active person color now accents only the workout detail panel (right side), not the entire card.
- TODAY highlight uses theme primary color (calendar-driven), not active person color.

## 0.1.12 - 2026-02-14

- UX: when a workout is swiped to Completed, the right detail panel becomes blank (completed workouts live in the bottom Completed bar).

## 0.1.13 - 2026-02-14

- UI redesign (tablet-first):
  - Cleaner typography/spacing and consistent surfaces
  - People bar restyled (no dashed outline)
  - Day list badges and workout detail panel look more like a paid product while staying HA-native

## 0.1.14 - 2026-02-14

- Fix: active person accent color now updates correctly when switching people (CSS variable scope).
- Board: completed workouts no longer show as “Done” on the day list; they disappear from the board and live only in Completed.
- Completed: long-press a completed chip to open a workout detail popup.

## 0.1.15 - 2026-02-14

- Settings: when adding a custom exercise you can pick a Category (Lower body/Push/Pull/Shoulders/Core/Arms/Other).
  - New custom exercises are automatically tagged so they appear in the right category section grid.
- UI: updated subtle surfaces to avoid large gray blocks while keeping HA theme-native styling.

## 0.2.0 - 2026-02-14

- Undo:
  - Swipe right (Completed) and swipe left (Delete) now show an Undo snackbar.
- Hardening:
  - Optimistic concurrency via `rev` + conflict detection (reload prompt when changed on another device).
  - Loading overlay while saving/generating.
- Training:
  - Add session `Intensity` (Easy/Normal/Hard) affecting main lift load % and volume.
- History:
  - Completed workouts are archived on week rollover (Monday 01:00 local time) and kept for the last 4 weeks.
  - History viewer in Settings.
- Backup:
  - Import/Export people + exercise settings from Settings.

## 0.2.1 - 2026-02-14

- Swipe UI: right-panel swipe feedback colors
  - Swipe right shows a green background (complete)
  - Swipe left shows a red background (delete)

## 0.2.2 - 2026-02-14

- History retention: archived workouts are kept for the newest 4 weeks only (4-week cycle), based on `week_start`.

## 0.2.3 - 2026-02-14

- Fix: workout generation no longer fails with `expected_rev` validation (WS schema updated).
- Completed workout popup:
  - Add Delete button (removes the workout from Completed).
- Swipe hardening:
  - Swipe actions trigger only on clear left/right gestures (vertical scrolling is not affected).

## 0.2.4 - 2026-02-14

- UI polish (tablet-first):
  - Header is now single-line: Week + People + Settings.
  - Modals: action buttons are pinned to the bottom (with a red Delete button where relevant).
  - Subtle elevation/gradients for a more premium HA-native look.

## 0.2.5 - 2026-02-14

- Fix: saving Exercise settings (adding custom exercises) no longer triggers `expected_rev` conflicts.
- UI: modal footer/buttons adjusted to better match native Home Assistant styling (Delete stays red).

## 0.2.6 - 2026-02-14

- UI: day list (left) now uses compact card boxes matching the workout item style (right), without increasing height.

## 0.2.7 - 2026-02-14

- UX: auto-reload state on `rev` conflicts (no more "Tap Reload" / restart-like prompts in Settings).

## 0.2.8 - 2026-02-14

- Settings:
  - Adding a custom exercise updates the grouped grid immediately (no need to Save + reopen).
  - Custom list action renamed to **Delete** and styled red.
- UI: popup buttons now use consistent pill styling matching the rest of the UI (Delete stays red).

## 0.3.0 - 2026-02-14

- Week navigation:
  - Week header now has arrows to browse up to **3 weeks back/forward**.
  - Tap the week chip to jump back to the current week.
  - Week selection is calendar-driven (not tied to a person).
- Progression:
  - When planning future weeks, suggested loads for main lifts automatically increase week-to-week (default **+2.5% / week**).
- 4-week cycle planning:
  - Enable a 4-week cycle with presets (**Strength-ish**, **Hypertrophy-ish**, **Minimalist**).
  - Choose which weekdays you train; planned days are highlighted in the day list.
  - Week 1-3 increases suggested loads; week 4 is **deload** (reduced load/volume).

## 0.3.1 - 2026-02-14

- Cycle planning UX:
  - Move 4-week cycle planning out of Settings and into the main UI (empty workout panel).
  - Add a dedicated Cycle Planner modal and a one-click **bulk generator** for the next N weeks.

## 0.3.2 - 2026-02-14

- Workout details:
  - Long-press the workout in the right panel to open a popup where you can **edit** or **delete** it.

## 0.3.3 - 2026-02-14

- Cycle delete:
  - Swipe-left delete on a cycle workout now prompts: **Delete workout** or **Delete series** (4 weeks).

## 0.3.4 - 2026-02-14

- Cycle planner:
  - Add **Clear planned** (removes planned markers only, does not delete workouts).

## 0.3.5 - 2026-02-14

- Fix: cycle planning now works again (WS `generate_cycle` accepts `expected_rev`).
- Fix: **Planned** markers only show from the cycle start week and forward (not backwards), limited to the configured cycle window.

## 0.3.6 - 2026-02-14

- Cycles: 4-week cycle config is now **per person** (only one active cycle per person).
- Cycles: automatically clears an expired cycle (after its configured window).
- Week navigation: clamp browsing to **-1 week back** and **+3 weeks forward**.
- Focus hardening: re-renders while typing no longer drop focus/cursor in inputs (tablet UX).

## 0.3.7 - 2026-02-14

- Fix: cycle planning no longer fails with `start_week_start must be an ISO date` (planner always uses the currently selected week).

## 0.3.8 - 2026-02-14

- Fix (hardening): bulk cycle planning (`generate_cycle`) now tolerates empty/invalid `start_week_start` and falls back to the currently selected week.

## 0.3.9 - 2026-02-14

- Fix (hardening): cycle planner no longer blocks planning if the start week date is stale/missing; it auto-reloads state and computes a safe fallback date.

## 0.3.10 - 2026-02-14

- UX: left day list is now navigation-only (selects which day is shown on the right). Workout creation is only available from the right panel.

## 0.3.11 - 2026-02-14

- Cycle (Strength-ish): planned workouts now follow an **A/B/C rotation** (instead of repeating the same day template), matching a more realistic weekly program structure.
