# Pebble Sports

Live sports scores on the wrist. Originally built by Pebble Technology and last released in 2016;
revived in 2026 for current Pebble hardware. The API it talks to is
[coredevices/pebble-sports-api](https://github.com/coredevices/pebble-sports-api), at
`https://sports.cluster.repebble.com` (`PEBBLE_SPORTS_API_ROOT` in `src/pkjs/index.js`).

The app shows a league list, a scrolling list of today's games, and a game card with live scores
that refreshes while it's open. Favouriting a team from a game card collects its games under
TIMELINE and puts a pin on the watch's timeline. Buttons and touch both work, on all seven
platforms.

## Build

```bash
npm ci
npm test
pebble build
```

Builds for all seven platforms: `aplite`, `basalt`, `chalk`, `diorite`, `emery`, `flint`, `gabbro`.

## Run

```bash
pebble install --emulator basalt --logs
```

`--logs` streams both watch `APP_LOG` output and phone-side `pkjs` console output, and it launches
the app directly rather than dropping you at the launcher. To reach a real watch, use `--phone <ip>`
instead of `--emulator`.

## Release

Bump `version` in `package.json` and add its notes to `CHANGELOG.md`; pushing to `main` publishes it
to the App Store.

## Source layout

```
src/
  *.c, *.h           app logic - sports.c holds state, card.c holds the open card
  windows/           one file per screen: splash, leagues, games, card, actions
  layers/, ui/       reusable drawing pieces
  keys.json          AppMessage protocol, single source of truth
  pkjs/              PebbleKit JS - runs on the phone, talks to the API
```

Two generated-code paths are worth knowing about:

`src/keys.json` generates `build/src/generated/keys.h` (C enums) and `src/pkjs/generated/keys.js`
during the build, so the watch and phone can't disagree about the protocol. Edit the JSON, never the
generated files. `messageKeys` in `package.json` generates the `MESSAGE_KEY_*` symbols the C side
uses to address AppMessage fields.

## Working on layout code

The `GRect` passed to `graphics_draw_text` is a *layout box*, not the glyphs.
Text sits inside it, pushed down by the font's internal leading — measured on
emery:

| font | box height | leading above ink | ink |
|---|---|---|---|
| `GOTHIC_28_BOLD` | 28 | 10 | 18 |
| `GOTHIC_24_BOLD` | 24 | 10 | 14 |
| `GOTHIC_18` | 18 | 7 | 11 |
| `GOTHIC_14` | 14 | 5 | 9 |

This is why layout code is full of small negative `y` offsets: they crop that
leading so caps land where you want them. Two rules follow, and both have been
violated in this codebase before:

- A box must be at least as tall as the font's **ink extent**, not its nominal
  size, or `GTextOverflowModeTrailingEllipsis` silently truncates.
- If you measure with `graphics_text_layout_get_content_size`, measure with the
  **same font you draw with**. Divergence produces a box too small for its own
  text.

`STATUS_BAR_LAYER_HEIGHT` is **not** 16 everywhere — it's 16, 20 on
emery/gabbro, and 24 on chalk. Derive from the constant rather than a literal.
