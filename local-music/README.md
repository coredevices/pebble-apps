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
