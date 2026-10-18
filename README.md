# Pebble plugins

Plugins for the Pebble / Core Devices app, one directory each. The plugin API is documented in
the app repo: [`test-apps/plugins.md`](https://github.com/coredevices/mobileapp/blob/main/test-apps/plugins.md).

## Building

A directory with a `package.json` that has a `pebble` block is a packaged plugin:

```sh
python3 scripts/pack-plugin-pbw.py <dir>      # writes <dir>/build/<name>.pbw
```

Plugins with a bundled source tree keep the source at the directory root and the packaged plugin
in `pbw/`. Build the bundle, then pack `pbw/`:

| Plugin | Build | Test |
|---|---|---|
| `chatgpt` | `npm ci && npm run build` | `npm test` |
| `location-sharing` | `npm ci --prefix ../imessage && npm ci && node scripts/build-plugin.mjs` | `node --test plugin.test.cjs test/*.test.cjs` |
| `chat` | `npm ci --prefix ../imessage && python3 build.py` | `node --test *.test.cjs` |
| `local-music`, `apple-home` | `python3 build.py` (packs to `build/`) | `node --test plugin.test.cjs` |

`imessage` isn't a plugin on its own: `chat` and `location-sharing` reuse its Apple account,
APNs and crypto code through `../imessage/src`.

`hue`, `stocks`, `notion`, `ticktick`, `todoist`, `met-weather`, `plugin-test` and `weather-face`
are also bundled into the app, which still builds them from its own `test-apps/` copies.

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
