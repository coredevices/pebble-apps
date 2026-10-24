var API_ROOT = 'https://append-api.roamresearch.com';
var GRAPH_KEY = 'roam_graph_name';
var TOKEN_KEY = 'roam_graph_token';
var NEST_UNDER_KEY = 'roam_nest_under';
var TIMESTAMP_KEY = 'roam_prepend_timestamp';
var DEFAULT_NEST_UNDER = '[[Pebble Captures]]';
var DESTINATION_SOURCES = ['notes/destination'];

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The graph token is a credential, so it lives in secure storage; the rest is plain settings.
async function storedConfig() {
  var storedNest = localStorage.getItem(NEST_UNDER_KEY);
  var storedTimestamp = localStorage.getItem(TIMESTAMP_KEY);
  return {
    graphName: stringValue(localStorage.getItem(GRAPH_KEY)),
    token: stringValue(await Pebble.secureStorage.getItem(TOKEN_KEY)),
    nestUnder: storedNest === null ? DEFAULT_NEST_UNDER : stringValue(storedNest),
    prependTimestamp: storedTimestamp === null || storedTimestamp === 'true',
  };
}

function configured(config) {
  return !!config.graphName && !!config.token;
}

function validateGraphName(value) {
  var graphName = stringValue(value);
  if (!graphName) return { error: 'Enter your Roam graph name.' };
  if (graphName.length > 200 || /[\u0000-\u001f\u007f/?#]/.test(graphName)) {
    return { error: 'Enter a valid Roam graph name.' };
  }
  return { value: graphName };
}

function validateToken(value) {
  var token = stringValue(value);
  if (!token) return { error: 'Enter an append-only Roam graph token.' };
  if (token.length > 512 || token.indexOf('roam-graph-token-') !== 0 || /\s/.test(token)) {
    return { error: 'Enter a valid append-only Roam graph token.' };
  }
  return { value: token };
}

function validateNestUnder(value) {
  var nestUnder = stringValue(value);
  if (nestUnder.length > 500 || /[\r\n]/.test(nestUnder)) {
    return { error: 'The grouping block must be one line and no more than 500 characters.' };
  }
  return { value: nestUnder };
}

function utf8ByteLength(value) {
  var length = 0;
  for (var index = 0; index < value.length; index += 1) {
    var code = value.charCodeAt(index);
    if (code <= 0x7f) length += 1;
    else if (code <= 0x7ff) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      length += 4;
      index += 1;
    } else length += 3;
  }
  return length;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dailyNoteDate(date) {
  return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + '-' + date.getFullYear();
}

function localTime(date) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

function graphUrl(graphName) {
  return 'https://roamresearch.com/#/app/' + encodeURIComponent(graphName);
}

function appendUrl(graphName) {
  return API_ROOT + '/api/graph/' + encodeURIComponent(graphName) + '/append-blocks';
}

async function appendBlocks(config, location, strings) {
  var body = JSON.stringify({
    location: location,
    'append-data': strings.map(function (string) { return { string: string }; }),
  });
  if (utf8ByteLength(body) > 200 * 1024) {
    return { ok: false, status: 413, text: '' };
  }
  try {
    var response = await fetch(appendUrl(config.graphName), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + config.token,
        'Content-Type': 'application/json',
      },
      body: body,
    });
    var text = await response.text();
    var captureSuccessful = false;
    if (response.status === 200) {
      try {
        captureSuccessful = JSON.parse(text || '{}').captureSuccessful === true;
      } catch (error) {
        captureSuccessful = false;
      }
    }
    return { ok: response.status === 200 && captureSuccessful, status: response.status, text: text };
  } catch (error) {
    // Not the error itself: it can include the URL, whose path names the graph.
    console.error('Roam append-blocks request failed: ' + (error && error.name));
    return { ok: false, status: 0, text: '' };
  }
}

function actionFailure(response) {
  console.error('Roam capture failed: HTTP ' + response.status);
  if (response.status === 401 || response.status === 403) {
    return { code: 'AUTH_REQUIRED', message: 'Roam authorization is invalid or no longer available.' };
  }
  if (response.status === 400) {
    return { code: 'INVALID_ARGS', message: 'Roam rejected the graph, destination, or note text.' };
  }
  if (response.status === 413) {
    return { code: 'INVALID_ARGS', message: 'The note is too large to capture in Roam.' };
  }
  if (response.status === 429) {
    return { code: 'RATE_LIMITED', message: 'Roam is receiving captures too quickly. Try again shortly.' };
  }
  if (response.status === 0 || response.status >= 500 || response.status === 200) {
    return {
      code: 'UNKNOWN',
      message: 'Roam may have received this note, but Pebble could not confirm it. Check Roam before retrying.',
    };
  }
  return { code: 'UNKNOWN', message: 'Roam could not capture the note (HTTP ' + response.status + ').' };
}

function configFailure(response) {
  var failure = actionFailure(response);
  if (failure.code === 'AUTH_REQUIRED') {
    return 'The graph name and append-only token did not match. Check both values in Roam.';
  }
  return failure.message;
}

function shortText(text) {
  return { shortText: { text: String(text) } };
}

function textReading(text) {
  return { shortText: { text: String(text) }, longText: { text: String(text) } };
}

function booleanReading(value) {
  return {
    boolean: { value: !!value },
    shortText: { text: value ? 'Connected' : 'Not connected' },
  };
}

function destinationLabel(config) {
  if (!configured(config)) return "Today's daily note";
  return config.nestUnder
    ? "Today's daily note under " + config.nestUnder
    : "Today's daily note";
}

Pebble.registerSourceHandler(async function (request, respond) {
  if (request.category !== 'notes' || request.item !== 'destination') {
    console.error('Unsupported source: ' + request.category + '/' + request.item);
    respond.error('PLUGIN_UNAVAILABLE', 'Unsupported Roam source.');
    return;
  }
  var config = await storedConfig();
  respond.data({
    validUntilMs: Date.now() + 60000,
    instances: [{
      instanceId: 'roam',
      properties: {
        name: shortText('Roam Research'),
        configured: booleanReading(configured(config)),
        location: textReading(destinationLabel(config)),
        url: { longText: { text: graphUrl(config.graphName) } },
      },
    }],
  });
});

Pebble.registerActionHandler(async function (request, respond) {
  if (request.action !== 'create_note') {
    console.error('Unsupported action: ' + request.action);
    respond.error('PLUGIN_UNAVAILABLE', 'Unsupported Roam action.');
    return;
  }
  var args = request.args || {};
  if (args.instanceId !== undefined && args.instanceId !== 'roam') {
    respond.error('INVALID_ARGS', 'instanceId must be roam.');
    return;
  }
  if (typeof args.text !== 'string' || !args.text.trim()) {
    respond.error('INVALID_ARGS', 'text must not be empty.');
    return;
  }

  var config = await storedConfig();
  if (!configured(config)) {
    respond.error('AUTH_REQUIRED', 'Configure a Roam graph and append-only token first.');
    return;
  }

  var text = args.text;
  var now = new Date();
  var capturedText = config.prependTimestamp ? localTime(now) + ' ' + text : text;

  var location = { page: { title: { 'daily-note-page': dailyNoteDate(now) } } };
  if (config.nestUnder) location['nest-under'] = { string: config.nestUnder };
  var response = await appendBlocks(config, location, [capturedText]);
  if (!response.ok) {
    var failure = actionFailure(response);
    respond.error(failure.code, failure.message);
    return;
  }
  respond.ok({
    text: 'Captured note in Roam.',
    url: graphUrl(config.graphName),
  });
});

Pebble.registerConfigHandler(async function (message, respond) {
  var config = await storedConfig();
  switch (message && message.type) {
    case 'status':
      respond({
        configured: configured(config),
        ready: configured(config),
        graphName: config.graphName,
        nestUnder: config.nestUnder,
        prependTimestamp: config.prependTimestamp,
      });
      return;

    case 'save': {
      var graphResult = validateGraphName(message.graphName);
      if (graphResult.error) {
        respond({ error: graphResult.error });
        return;
      }
      var tokenResult = validateToken(stringValue(message.token) || config.token);
      if (tokenResult.error) {
        respond({ error: tokenResult.error });
        return;
      }
      var nestResult = validateNestUnder(message.nestUnder);
      if (nestResult.error) {
        respond({ error: nestResult.error });
        return;
      }
      var candidate = {
        graphName: graphResult.value,
        token: tokenResult.value,
        nestUnder: nestResult.value,
        prependTimestamp: message.prependTimestamp !== false,
      };
      var validation = await appendBlocks(
        candidate,
        { page: { title: 'Pebble Connection Check' } },
        ['Connection from Pebble to Roam verified']
      );
      if (!validation.ok) {
        respond({ error: configFailure(validation), configured: configured(config) });
        return;
      }
      localStorage.setItem(GRAPH_KEY, candidate.graphName);
      await Pebble.secureStorage.setItem(TOKEN_KEY, candidate.token);
      localStorage.setItem(NEST_UNDER_KEY, candidate.nestUnder);
      localStorage.setItem(TIMESTAMP_KEY, candidate.prependTimestamp ? 'true' : 'false');
      Pebble.refreshSources(DESTINATION_SOURCES);
      respond({
        configured: true,
        ready: true,
        graphName: candidate.graphName,
        nestUnder: candidate.nestUnder,
        prependTimestamp: candidate.prependTimestamp,
      });
      return;
    }

    case 'unlink':
    case 'disconnect':
      localStorage.removeItem(GRAPH_KEY);
      await Pebble.secureStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(NEST_UNDER_KEY);
      localStorage.removeItem(TIMESTAMP_KEY);
      Pebble.refreshSources(DESTINATION_SOURCES);
      respond({ configured: false, ready: false });
      return;

    default:
      respond({ error: 'Unknown message type.' });
  }
});
