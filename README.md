# Pebble plugins

Plugins for the Pebble / Core Devices app, one directory each. The plugin API is documented in
the app repo: [`test-apps/plugins.md`](https://github.com/coredevices/mobileapp/blob/main/test-apps/plugins.md).

## Building

Every plugin is a Pebble SDK plugin project (`"projectType": "plugin"` in `package.json`, plus a
`wscript`), so the plugins SDK builds it: install `pebble-tool` and the SDK from their `plugins`
branches, then

```sh
cd <dir> && pebble build      # writes <dir>/build/<dir>.pbw
pebble install --emulator emery
```

Each plugin's real source is in `src/`. Hand-written plugins are the project itself: the script is
`src/plugin/index.js` and the settings page `src/config.html`. Plugins with a build step keep their
source and build at the directory root and the SDK project (built script, settings page) in `pbw/`:
build, then run `pebble build` in `pbw/`.

| Plugin | Build | Test |
|---|---|---|
| `apple-notes` | `npm ci && npm run build` | `npm test` |
| `googlehome` | `npm ci && npm run build` | `npm test` |
| `chatgpt` | `npm ci && npm run build` | `npm test` |
| `location-sharing` | `npm ci --prefix ../chat/imessage && npm ci && node scripts/build-plugin.mjs` | `node --test plugin.test.cjs test/*.test.cjs` |
| `chat` | `npm ci --prefix imessage && python3 build.py` | `node --test *.test.cjs` |
| `muse` | `npm ci && npm run build` (SDK project at the root) | `npm test` |

`chat/imessage` is Chat's iMessage engine (Apple account, APNs, crypto); `location-sharing` reuses
its Apple account and crypto code through `../chat/imessage/src`. `apple-notes` vendors the CRDT
code of [icloud-md](https://github.com/coddingtonbear/icloud-md) (see `apple-notes/UPSTREAM.md`);
`googlehome` shares its Google Home client with
[googlehome-mcp](https://github.com/ericmigi/googlehome-mcp).

`scripts/pack-plugin-pbw.py <dir>` still packs a plugin without the SDK.

`hue`, `stocks`, `notion`, `ticktick`, `todoist`, `met-weather`, `plugin-test` and `weather-face`
are also bundled into the app, which still builds them from its own `test-apps/` copies.

## Icons

Each plugin has `src/icon.svg`: one 1.6px line on a 24×24 grid, round caps, no fill. The App Store
takes PNGs on white: `rsvg-convert -w 144 -h 144 -b white src/icon.svg` (large) and `-w 80 -h 80`
(small).

## Plugins

| Directory | Name |
|---|---|
| `apple-home` | Apple Home Control |
| `apple-notes` | Apple Notes |
| `apple-reminders` | Apple Reminders |
| `chat` | Chat |
| `chatgpt` | ChatGPT (Dot, Codex sessions, Codex Cloud) |
| `claude` | Claude |
| `google-tasks-keep` | Google Tasks & Keep |
| `googlehome` | GoogleHome |
| `grok-bot` | Grok Bot |
| `hue` | Hue |
| `ios-shortcuts` | iOS Shortcuts |
| `local-music` | Android Music |
| `location-sharing` | LocationSharing |
| `met-weather` | MET Norway Weather |
| `muse` | Muse |
| `notion` | Notion |
| `obsidian` | Obsidian/Markdown Notes |
| `plugin-test` | Plugin Demo: Dashboard (watchapp; needs the Pebble SDK) |
| `roam` | Roam Research |
| `spotify` | Spotify |
| `stocks` | Stocks |
| `tasks-org` | Tasks.org |
| `ticktick` | TickTick |
| `todoist` | Todoist |
| `weather-face` | Plugin Demo: Weather Face (watchface; needs the Pebble SDK) |
