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
