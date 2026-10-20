# Spotify

Reads Spotify playback and controls Spotify Connect devices. Can resume or pause, skip, seek, change volume/shuffle/repeat, search Spotify, play tracks, albums, artists or playlists, queue a track, and transfer playback.

Sign in to Spotify in plugin settings and choose a default device. Build: see the [repository README](../README.md#building).

## Functions

### `set_playing(on, device_id?)`

Resume Spotify when on is true or pause it when false, on the explicitly supplied device or the device selected in Spotify plugin settings.

- `on` (boolean): True to resume, false to pause.
- `device_id` (string, optional): Spotify Connect device ID. Plugin settings provide the default.

### `play(query?, type?, uri?, device_id?, position_ms?)`

Resume Spotify, or find and play one track, album, artist, or playlist. Prefer an exact Spotify URI/URL when the user supplied one; otherwise provide query and type. The configured Spotify Connect device is used unless device_id is supplied.

- `query` (string, optional): Name or Spotify search query. Omit to resume current playback.
- `type` (string, optional): Content type; defaults to track for a text query. One of `track`, `album`, `artist`, `playlist`.
- `uri` (string, optional): Exact spotify: URI or open.spotify.com URL; preferred over query.
- `device_id` (string, optional)
- `position_ms` (integer, optional): starting position for a track.

### `play_playlist(playlist, device_id?)`

Play a Spotify playlist by name, Spotify URI, or open.spotify.com URL on the configured device.

- `playlist` (string): Playlist name, spotify:playlist URI, or Spotify URL.
- `device_id` (string, optional)

### `pause(device_id?)`

Pause Spotify on the explicitly supplied or configured device.

- `device_id` (string, optional)

### `next_track(device_id?)`

Skip to the next Spotify track.

- `device_id` (string, optional)

### `previous_track(device_id?)`

Return to the previous Spotify track.

- `device_id` (string, optional)

### `seek(position_ms, device_id?)`

Seek within the current Spotify track to an absolute position in milliseconds.

- `position_ms` (integer)
- `device_id` (string, optional)

### `set_volume(volume_percent, device_id?)`

Set Spotify playback volume from 0 to 100 percent on the explicitly supplied or configured device.

- `volume_percent` (integer)
- `device_id` (string, optional)

### `set_shuffle(enabled, device_id?)`

Enable or disable shuffle for Spotify playback.

- `enabled` (boolean)
- `device_id` (string, optional)

### `set_repeat(mode, device_id?)`

Set Spotify repeat mode to off, context, or track.

- `mode` (string) One of `off`, `context`, `track`.
- `device_id` (string, optional)

### `search(query, type, limit?)`

Search Spotify for tracks, albums, artists, or playlists and return the best matches with names and Spotify URIs. This does not start playback.

- `query` (string)
- `type` (string) One of `track`, `album`, `artist`, `playlist`.
- `limit` (integer, optional)

### `add_to_queue(query?, uri?, device_id?)`

Find a track by name or use an exact Spotify track URI/URL, then add it to the end of the Spotify queue.

- `query` (string, optional)
- `uri` (string, optional)
- `device_id` (string, optional)

### `transfer_playback(device, play?)`

Transfer Spotify playback to a Spotify Connect device. Supply its exact ID or case-insensitive name from music/device.

- `device` (string): Spotify device ID or device name.
- `play` (boolean, optional): Whether playback should start after transfer.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `music/track`: title, artist, album, playing, progress, duration, device, shuffle, repeat, url
- `music/device`: name, type, active, restricted, volume, supports_volume
