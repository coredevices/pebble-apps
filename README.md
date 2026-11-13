# Pebble apps

Source for the plugins and watchapps Core Devices publishes on the [Pebble App Store](https://apps.repebble.com/plugins),
one directory each. They're also working examples of the plugin API.

## Getting started

- **Install the SDK.** Follow [Installing the Pebble SDK](https://developer.repebble.com/sdk/): `uv tool install pebble-tool`,
  then `pebble sdk install latest`.
- **New to Pebble development?** Start with the [tutorials](https://developer.repebble.com/tutorials/).
- **Plugins** are JavaScript that runs on the phone and gives watchfaces, apps and the Index agent data and
  actions. Read the [plugins guide](https://developer.repebble.com/guides/plugins/preview/) (plugins are off by
  default: turn them on in the Pebble app under Settings → Plugins) and
  [publishing plugins](https://developer.repebble.com/guides/plugins/publishing-plugins/).
- **Command reference:** [`pebble` tool](https://developer.repebble.com/guides/tools-and-resources/pebble-tool/).

## Building

```sh
cd <dir> && pebble build      # writes <dir>/build/<name>.pbw
pebble install --emulator emery
```

A plugin's source is in `src/`: `src/plugin/index.js` for the script and `src/config.html` for the settings
page. Plugins with a build step keep their source at the directory root and the SDK project in `pbw/`; build
them first:

| Plugin | Build | Test |
|---|---|---|
| `apple-notes`, `chatgpt`, `googlehome` | `npm ci && npm run build` | `npm test` |
| `muse` | `npm ci && npm run build` (SDK project at the root) | `npm test` |
| `location-sharing` | `npm ci --prefix ../chat/imessage && npm ci && node scripts/build-plugin.mjs` | `node --test plugin.test.cjs test/*.test.cjs` |
| `chat` | `npm ci --prefix imessage && node scripts/build-plugin.mjs` | `node --test *.test.cjs` |

If `pebble build` gives you an empty pbw for a plugin-only project, package it with
`python3 scripts/pack-plugin-pbw.py <dir>` (or `<dir>/pbw`), which is what CI does.

## Icons

Each plugin has `src/icon.svg`: one 1.6px line on a 24×24 grid, round caps, no fill.

## Contents

| Directory | Name |
|---|---|
| `apple-notes` | Apple Notes |
| `chat` | Chat |
| `chatgpt` | ChatGPT (Dot, ChatGPT chats, Codex sessions, Codex Cloud) |
| `claude` | Claude |
| `compass` | Compass (watchapp) |
| `complication-face` | Complication Face (Plugin Demo) (watchface) |
| `find-my-phone` | Find My Phone (watchapp) |
| `google-tasks-keep` | Google Tasks & Keep |
| `googlehome` | Google Home |
| `grok-bot` | Grok Bot |
| `hue` | Hue |
| `location-sharing` | Location Sharing |
| `met-weather` | MET Norway Weather |
| `muse` | Muse |
| `notion` | Notion |
| `obsidian` | Obsidian/Markdown Notes |
| `plugin-test` | Dashboard (Plugin Demo) (watchapp) |
| `remember-the-milk` | Remember The Milk |
| `roam` | Roam Research |
| `sliding-text` | Sliding Text (watchface) |
| `sports` | Sports (watchapp) |
| `stocks` | Stocks |
| `stopwatch` | Stopwatch (watchapp) |
| `tasks-org` | Tasks.org |
| `ticktick` | TickTick |
| `timer` | Timer (watchapp) |
| `todoist` | Todoist |
| `weather-face` | Weather Face (Plugin Demo) (watchface) |
| `whatsplaying` | What's Playing (watchapp) |
