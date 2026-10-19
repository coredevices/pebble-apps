(function () {
  'use strict';

  var DEFAULT_PLAYER_KEY = 'defaultPlayerPackage';
  var MEDIA_PLAY_FROM_SEARCH = 'android.media.action.MEDIA_PLAY_FROM_SEARCH';
  var CATEGORY_DEFAULT = 'android.intent.category.DEFAULT';
  var YOUTUBE_MUSIC_PACKAGE = 'com.google.android.apps.youtube.music';
  // Public API key used by YouTube Music's unauthenticated WEB_REMIX client.
  var YOUTUBE_MUSIC_SEARCH_URL = 'https://music.youtube.com/youtubei/v1/search?alt=json&key=' +
    'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
  var YOUTUBE_MUSIC_FILTERS = {
    track: 'EgWKAQIIAWoMEA4QChADEAQQCRAF',
    album: 'EgWKAQIYAWoMEA4QChADEAQQCRAF',
    playlist: 'Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo=',
    genre: 'Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo='
  };
  var PLAYER_PACKAGES = {
    youtube_music: 'com.google.android.apps.youtube.music',
    youtube: 'com.google.android.youtube',
    spotify: 'com.spotify.music',
    apple_music: 'com.apple.android.music',
    amazon_music: 'com.amazon.mp3',
    pandora: 'com.pandora.android',
    tidal: 'com.aspiro.tidal',
    deezer: 'deezer.android.app',
    samsung_music: 'com.sec.android.app.music',
    vlc: 'org.videolan.vlc',
    plexamp: 'tv.plex.labs.plexamp',
    pocket_casts: 'au.com.shiftyjelly.pocketcasts'
  };

  function nativeAvailable() {
    return typeof _AndroidIntents !== 'undefined';
  }

  function listPlayers() {
    if (!nativeAvailable()) return [];
    try {
      var resolved = JSON.parse(_AndroidIntents.resolveActivities(JSON.stringify({
        action: MEDIA_PLAY_FROM_SEARCH,
        categories: [CATEGORY_DEFAULT]
      })));
      var players = resolved.ok ? resolved.activities.map(function (activity) {
        return { packageId: activity.packageId, name: activity.name };
      }) : [];
      if (typeof _LocalMusicNative !== 'undefined') {
        players = players.concat(JSON.parse(_LocalMusicNative.listPlayers()));
      }
      var unique = Object.create(null);
      players.forEach(function (player) { unique[player.packageId] = player; });
      return Object.keys(unique).map(function (packageId) { return unique[packageId]; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
    } catch (error) {
      console.error('Could not list Android music players:', error);
      return [];
    }
  }

  function configuredPackage() {
    return localStorage.getItem(DEFAULT_PLAYER_KEY) || PLAYER_PACKAGES.youtube_music;
  }

  function resolvePackage(player) {
    if (!player) return configuredPackage();
    return PLAYER_PACKAGES[player] || configuredPackage();
  }

  function playerName(packageId, players) {
    var match = players.filter(function (player) {
      return player.packageId === packageId;
    })[0];
    return match ? match.name : packageId;
  }

  function buildRequest(args) {
    if (!nativeAvailable()) {
      return { ok: false, code: 'PLUGIN_UNAVAILABLE', message: 'Android music control is unavailable.' };
    }
    var packageId = args.package_id || resolvePackage(args.player);
    var request = {
      query: String(args.query || '').trim(),
      packageId: packageId,
      mediaType: args.media_type || 'any',
      artist: args.artist || (args.media_type === 'artist' ? String(args.query || '').trim() : null),
      album: args.album || (args.media_type === 'album' ? String(args.query || '').trim() : null),
      title: args.title || (args.media_type === 'track' ? String(args.query || '').trim() : null),
      playlist: args.playlist || (args.media_type === 'playlist' ? String(args.query || '').trim() : null),
      genre: args.genre || (args.media_type === 'genre' ? String(args.query || '').trim() : null)
    };
    if (!request.query) {
      return { ok: false, code: 'INVALID_ARGS', message: 'Tell me what to play.' };
    }
    return request;
  }

  function play(args, callback) {
    var request = buildRequest(args || {});
    if (request.ok === false) {
      callback(request);
      return;
    }
    if (request.packageId === YOUTUBE_MUSIC_PACKAGE) {
      playYouTubeMusic(request, callback);
      return;
    }
    callback(playWithAndroidMediaSearch(request));
  }

  function playWithAndroidMediaSearch(request) {
    try {
      if (typeof _LocalMusicNative !== 'undefined') {
        var sessionResult = JSON.parse(_LocalMusicNative.playFromSearch(JSON.stringify(request)));
        if (sessionResult.ok) {
          sessionResult.packageId = request.packageId;
          return sessionResult;
        }
      }
      var extras = {
        query: request.query,
        'android.intent.extra.focus': mediaFocus(request.mediaType)
      };
      if (request.artist) extras['android.intent.extra.artist'] = request.artist;
      if (request.album) extras['android.intent.extra.album'] = request.album;
      if (request.title) extras['android.intent.extra.title'] = request.title;
      if (request.playlist) extras['android.intent.extra.playlist'] = request.playlist;
      if (request.genre) extras['android.intent.extra.genre'] = request.genre;
      var result = JSON.parse(_AndroidIntents.startActivity(JSON.stringify({
        action: MEDIA_PLAY_FROM_SEARCH,
        packageId: request.packageId,
        categories: [CATEGORY_DEFAULT],
        extras: extras
      })));
      if (result.ok) result.packageId = request.packageId;
      return result;
    } catch (error) {
      return { ok: false, code: 'UNKNOWN', message: String(error) };
    }
  }

  function playYouTubeMusic(request, callback) {
    resolveYouTubeMusicTarget(request, function (error, target) {
      if (error) {
        callback({ ok: false, code: 'SEARCH_FAILED', message: error });
        return;
      }
      try {
        var uri = 'vnd.youtube.music://music.youtube.com/watch?' +
          (target.videoId ? 'v=' + encodeURIComponent(target.videoId) :
            'list=' + encodeURIComponent(target.playlistId)) +
          '&feature=applinks';
        var result = JSON.parse(_AndroidIntents.openUri(JSON.stringify({
          uri: uri,
          packageId: YOUTUBE_MUSIC_PACKAGE
        })));
        if (result.ok) {
          result.packageId = YOUTUBE_MUSIC_PACKAGE;
          result.route = 'youtube_music_media';
        }
        callback(result);
      } catch (openError) {
        callback({ ok: false, code: 'UNKNOWN', message: String(openError) });
      }
    });
  }

  function resolveYouTubeMusicTarget(request, callback) {
    if (typeof XMLHttpRequest === 'undefined') {
      callback('YouTube Music search is unavailable.');
      return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('POST', YOUTUBE_MUSIC_SEARCH_URL, true);
    xhr.timeout = 10000;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) {
        callback('YouTube Music search failed.');
        return;
      }
      try {
        var target = firstPlayableTarget(JSON.parse(xhr.responseText));
        if (!target) {
          callback('No playable YouTube Music result was found for “' + request.query + '”.');
          return;
        }
        callback(null, target);
      } catch (parseError) {
        callback('YouTube Music returned an unreadable search result.');
      }
    };
    xhr.onerror = function () { callback('Could not reach YouTube Music.'); };
    xhr.ontimeout = function () { callback('YouTube Music search timed out.'); };
    var date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    var body = {
      context: {
        client: { clientName: 'WEB_REMIX', clientVersion: '1.' + date + '.01.00' },
        user: {}
      },
      query: request.query
    };
    var filter = YOUTUBE_MUSIC_FILTERS[youtubeMusicSearchType(request)];
    if (filter) body.params = filter;
    xhr.send(JSON.stringify(body));
  }

  function youtubeMusicSearchType(request) {
    if (request.mediaType !== 'any') return request.mediaType;
    // The agent may leave media_type as "any" for natural song requests such as
    // "Midnight City by M83". YouTube Music ranks user-uploaded videos ahead of
    // the catalog song for that unfiltered query, so use its Songs filter when
    // the request itself clearly identifies a title and artist.
    if (request.title || /\S\s+by\s+\S/i.test(request.query)) return 'track';
    return request.mediaType;
  }

  function firstPlayableTarget(value) {
    if (!value || typeof value !== 'object') return null;
    var item = value.musicResponsiveListItemRenderer;
    if (item) {
      var endpoint = item.overlay &&
        item.overlay.musicItemThumbnailOverlayRenderer &&
        item.overlay.musicItemThumbnailOverlayRenderer.content &&
        item.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer &&
        item.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer
          .playNavigationEndpoint;
      var watch = endpoint && endpoint.watchEndpoint;
      if (watch && /^[A-Za-z0-9_-]{11}$/.test(watch.videoId || '')) {
        return { videoId: watch.videoId };
      }
      var watchPlaylist = endpoint && endpoint.watchPlaylistEndpoint;
      if (watchPlaylist && /^[A-Za-z0-9_-]+$/.test(watchPlaylist.playlistId || '')) {
        return { playlistId: watchPlaylist.playlistId };
      }
    }
    if (Array.isArray(value)) {
      for (var index = 0; index < value.length; index += 1) {
        var arrayMatch = firstPlayableTarget(value[index]);
        if (arrayMatch) return arrayMatch;
      }
      return null;
    }
    var keys = Object.keys(value);
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      var objectMatch = firstPlayableTarget(value[keys[keyIndex]]);
      if (objectMatch) return objectMatch;
    }
    return null;
  }

  function mediaFocus(mediaType) {
    if (mediaType === 'artist') return 'vnd.android.cursor.item/artist';
    if (mediaType === 'album') return 'vnd.android.cursor.item/album';
    if (mediaType === 'playlist') return 'vnd.android.cursor.item/playlist';
    if (mediaType === 'track') return 'vnd.android.cursor.item/audio';
    return 'vnd.android.cursor.item/*';
  }

  Pebble.registerActionHandler(function (request, respond) {
    if (request.action !== 'play') {
      respond.error('PLUGIN_UNAVAILABLE', 'Unknown Android Music action.');
      return;
    }
    play(request.args || {}, function (result) {
      if (!result.ok) {
        respond.error(result.code || 'UNKNOWN', result.message || 'Could not start music.');
        return;
      }
      var name = playerName(result.packageId, listPlayers());
      respond.ok({
        text: 'Playing “' + String(request.args.query).trim() + '” in ' + name + '.',
        data: { player: name, package_id: result.packageId, route: result.route }
      });
    });
  });

  Pebble.registerConfigHandler(function (message, respond) {
    message = message || {};
    if (message.type === 'status') {
      var players = listPlayers();
      var packageId = configuredPackage();
      respond({ players: players, packageId: packageId, playerName: playerName(packageId, players) });
      return;
    }
    if (message.type === 'save') {
      var installed = listPlayers();
      var selected = String(message.packageId || '');
      if (!installed.some(function (player) { return player.packageId === selected; })) {
        respond({ error: 'Choose an installed player.' });
        return;
      }
      localStorage.setItem(DEFAULT_PLAYER_KEY, selected);
      respond({ ok: true, packageId: selected, playerName: playerName(selected, installed) });
      return;
    }
    if (message.type === 'test') {
      var installedPlayers = listPlayers();
      var testPackage = String(message.packageId || configuredPackage());
      if (!installedPlayers.some(function (player) { return player.packageId === testPackage; })) {
        respond({ error: 'Choose an installed player.' });
        return;
      }
      play({
        query: message.query || 'Ratatat',
        media_type: 'any',
        package_id: testPackage
      }, function (outcome) {
        if (!outcome.ok) {
          respond({ error: outcome.message || 'Could not start music.' });
          return;
        }
        var available = listPlayers();
        respond({
          ok: true,
          route: outcome.route,
          playerName: playerName(outcome.packageId, available)
        });
      });
      return;
    }
    respond({ error: 'Unknown request.' });
  });
})();
