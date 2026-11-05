// The watchapp's PKJS keeps the history in the same localStorage: newest first, at most ten.
var HISTORY_KEY = 'history';

function history() {
  try {
    var parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function longText(text) {
  return { longText: { text: String(text || '') } };
}

Pebble.registerSourceHandler(function (request, respond) {
  if (!request || request.category !== 'music' || request.item !== 'identified') {
    respond.error('INVALID_REQUEST', "Unsupported What's Playing source.");
    return;
  }
  respond.data({
    validUntilMs: Date.now() + 60 * 1000,
    instances: history().filter(function (entry) {
      return entry && entry.title;
    }).map(function (entry, index) {
      var properties = {
        title: longText(entry.title),
        artist: longText(entry.artist),
        album: longText(entry.album),
      };
      var seconds = Math.floor(Date.parse(entry.time) / 1000);
      if (isFinite(seconds)) properties.identified = { timestamp: { value: seconds } };
      if (entry.song_link) properties.url = longText(entry.song_link);
      return { instanceId: String(entry.time || index), properties: properties };
    }),
  });
});
