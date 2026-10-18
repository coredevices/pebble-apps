const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(
  players = [{ packageId: 'com.google.android.apps.youtube.music', name: 'YouTube Music' }],
  activeSession = true,
  youtubeEndpoint = { watchEndpoint: { videoId: 'BcoPKWzLjrE' } },
) {
  let actionHandler;
  let configHandler;
  let request;
  let openedUri;
  let networkRequest;
  const storage = new Map();
  const context = {
    console,
    JSON,
    String,
    Array,
    Date,
    encodeURIComponent,
    XMLHttpRequest: class FakeXMLHttpRequest {
      open(method, url) { networkRequest = { method, url }; }
      setRequestHeader() {}
      send(body) {
        networkRequest.body = JSON.parse(body);
        this.status = 200;
        this.responseText = JSON.stringify({
          contents: [{
            musicResponsiveListItemRenderer: {
              overlay: {
                musicItemThumbnailOverlayRenderer: {
                  content: {
                    musicPlayButtonRenderer: {
                      playNavigationEndpoint: youtubeEndpoint,
                    },
                  },
                },
              },
            },
          }],
        });
        this.onload();
      }
    },
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    _AndroidIntents: {
      resolveActivities: () => JSON.stringify({
        ok: true,
        activities: players.map(player => ({
          packageId: player.packageId,
          activityName: 'PlayerActivity',
          name: player.name,
        })),
      }),
      startActivity: json => {
        request = JSON.parse(json);
        return JSON.stringify({ ok: true, route: 'android_activity' });
      },
      openUri: json => {
        openedUri = JSON.parse(json);
        return JSON.stringify({ ok: true, route: 'android_activity' });
      },
    },
    _LocalMusicNative: {
      listPlayers: () => JSON.stringify(players),
      playFromSearch: json => {
        request = JSON.parse(json);
        return JSON.stringify(activeSession
          ? { ok: true, route: 'media_session' }
          : { ok: false, code: 'NO_ACTIVE_SESSION' });
      },
    },
    Pebble: {
      registerActionHandler: handler => { actionHandler = handler; },
      registerConfigHandler: handler => { configHandler = handler; },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'plugin.js'), 'utf8'),
    context,
  );
  return {
    actionHandler,
    configHandler,
    storage,
    request: () => request,
    openedUri: () => openedUri,
    networkRequest: () => networkRequest,
  };
}

function invokeAction(handler, args) {
  return new Promise(resolve => handler(
    { action: 'play', args },
    {
      ok: value => resolve({ ok: true, ...value }),
      error: (code, message) => resolve({ ok: false, code, message }),
    },
  ));
}

function config(handler, message) {
  return new Promise(resolve => handler(message, resolve));
}

(async () => {
  const h = harness();
  const result = await invokeAction(h.actionHandler, {
    query: 'Ratatat',
    player: 'youtube_music',
    media_type: 'artist',
    artist: 'Ratatat',
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /YouTube Music/);
  assert.deepEqual(h.openedUri(), {
    uri: 'vnd.youtube.music://music.youtube.com/watch?v=BcoPKWzLjrE&feature=applinks',
    packageId: 'com.google.android.apps.youtube.music',
  });
  assert.equal(h.networkRequest().method, 'POST');
  assert.equal(h.networkRequest().body.query, 'Ratatat');
  assert.equal(h.networkRequest().body.params, undefined);

  const naturalTrack = harness();
  const naturalTrackResult = await invokeAction(naturalTrack.actionHandler, {
    query: 'Midnight City by M83',
    player: 'youtube_music',
    media_type: 'any',
  });
  assert.equal(naturalTrackResult.ok, true);
  assert.equal(naturalTrack.networkRequest().body.params, 'EgWKAQIIAWoMEA4QChADEAQQCRAF');

  const album = harness(undefined, true, {
    watchPlaylistEndpoint: { playlistId: 'OLAK5uy_kNhM2yaBTOVwrcZJepB1C9P3-n5_Sfy5c' },
  });
  const albumResult = await invokeAction(album.actionHandler, {
    query: 'Random Access Memories Daft Punk',
    player: 'youtube_music',
    media_type: 'album',
  });
  assert.equal(albumResult.ok, true);
  assert.deepEqual(album.openedUri(), {
    uri: 'vnd.youtube.music://music.youtube.com/watch?list=' +
      'OLAK5uy_kNhM2yaBTOVwrcZJepB1C9P3-n5_Sfy5c&feature=applinks',
    packageId: 'com.google.android.apps.youtube.music',
  });
  assert.equal(album.networkRequest().body.params, 'EgWKAQIYAWoMEA4QChADEAQQCRAF');

  const cold = harness([
    { packageId: 'au.com.shiftyjelly.pocketcasts', name: 'Pocket Casts' },
  ], false);
  const coldResult = await invokeAction(cold.actionHandler, {
    query: 'Avengers: Infinity War',
    player: 'pocket_casts',
    media_type: 'track',
  });
  assert.equal(coldResult.ok, true, JSON.stringify(coldResult));
  assert.equal(coldResult.data.route, 'android_activity');
  assert.deepEqual(cold.request(), {
    action: 'android.media.action.MEDIA_PLAY_FROM_SEARCH',
    packageId: 'au.com.shiftyjelly.pocketcasts',
    categories: ['android.intent.category.DEFAULT'],
    extras: {
      query: 'Avengers: Infinity War',
      'android.intent.extra.focus': 'vnd.android.cursor.item/audio',
      'android.intent.extra.title': 'Avengers: Infinity War',
    },
  });

  const saved = await config(h.configHandler, {
    type: 'save',
    packageId: 'com.google.android.apps.youtube.music',
  });
  assert.equal(saved.ok, true);
  assert.equal(h.storage.get('defaultPlayerPackage'), 'com.google.android.apps.youtube.music');

  const invalid = harness([]);
  assert.equal((await config(invalid.configHandler, { type: 'save', packageId: 'bad' })).error,
    'Choose an installed player.');
  assert.equal((await invokeAction(invalid.actionHandler, { query: ' ' })).code, 'INVALID_ARGS');

  const preview = harness([
    { packageId: 'com.google.android.apps.youtube.music', name: 'YouTube Music' },
    { packageId: 'org.videolan.vlc', name: 'VLC' },
  ], false);
  const previewResult = await config(preview.configHandler, {
    type: 'test',
    packageId: 'org.videolan.vlc',
    query: 'Ratatat',
  });
  assert.equal(previewResult.ok, true);
  assert.equal(preview.request().packageId, 'org.videolan.vlc');
  assert.equal(preview.storage.has('defaultPlayerPackage'), false);
  const appinfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'appinfo.json'), 'utf8'));
  assert.equal(appinfo.plugin.usesPermissions.includes('AndroidIntents'), true);
  const internet = appinfo.plugin.usesPermissions.find(permission => (
    permission && permission.name === 'Internet'
  ));
  assert.deepEqual(internet.parameters.domains, ['music.youtube.com']);
  const actionInternet = appinfo.plugin.actions[0].usesPermissions.find(permission => (
    permission && permission.name === 'Internet'
  ));
  assert.deepEqual(actionInternet.parameters.domains, ['music.youtube.com']);
  assert.equal(appinfo.plugin.androidIntents.activities[0].packages.includes(
    'com.google.android.apps.youtube.music'), true);
  assert.deepEqual(appinfo.plugin.androidIntents.activities[1], {
    actions: ['android.intent.action.VIEW'],
    packages: ['com.google.android.apps.youtube.music'],
    schemes: ['vnd.youtube.music'],
  });
  console.log('Android Music plugin tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
