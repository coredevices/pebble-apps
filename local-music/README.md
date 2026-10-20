# Android Music plugin

Starts a search in a compatible Android media player. Player discovery and cold-start playback
use CoreApp's generic, manifest-scoped `AndroidIntents` bridge; player selection, request shaping,
configuration, and Index action handling remain JavaScript. The only music-specific native code
dispatches play-from-search directly to an already-active Android media session.

The host prefers an existing media session, which can work while the phone is locked. If the
selected player has no session, JS sends its declared `MEDIA_PLAY_FROM_SEARCH` activity.
That cold-start fallback remains subject to Android's background-activity restrictions.

Build with:

```sh
python3 local-music/build.py
```

## Functions

### `play(query, player?, media_type?, artist?, album?, title?, playlist?, genre?)`

Play music or a subscribed podcast in an Android app on this phone. Put the artist, song, album, playlist, genre, podcast, episode, or natural-language request in query. When the user names a player, set player; YouTube Music is youtube_music and Pocket Casts is pocket_casts. Omit player to use the configured default.

- `query` (string): What to play, such as Ratatat, Get Lucky by Daft Punk, my Discover Mix, or the exact name of a subscribed Pocket Casts show or episode.
- `player` (string, optional): requested Android player. Omit to use the default selected in plugin settings. One of `youtube_music`, `youtube`, `spotify`, `apple_music`, `amazon_music`, `pandora`, `tidal`, `deezer`, `samsung_music`, `vlc`, `plexamp`, `pocket_casts`.
- `media_type` (string, optional): hint about what query identifies. Use any for podcasts or when uncertain. One of `any`, `artist`, `track`, `album`, `playlist`, `genre`.
- `artist` (string, optional): exact artist hint.
- `album` (string, optional): exact album hint.
- `title` (string, optional): exact song or episode title.
- `playlist` (string, optional): exact playlist name.
- `genre` (string, optional): genre name.

