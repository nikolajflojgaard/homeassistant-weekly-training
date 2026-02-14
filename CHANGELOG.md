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
