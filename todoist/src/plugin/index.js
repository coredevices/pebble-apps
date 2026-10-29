// Todoist API v1 reminder destination.
//
// CoreApp's trusted HostedOAuth bridge performs sign-in and keeps Todoist's developer secret out
// of this PBW. User tokens are kept in Pebble.secureStorage.

var API_ROOT = 'https://api.todoist.com/api/v1';
var TOKEN_KEY = 'todoist_access_token';
var BROKER_REFRESH_KEY = 'todoist_broker_refresh';
var EXPIRES_AT_KEY = 'todoist_expires_at';
var PROJECT_REFRESH_MS = 15 * 60 * 1000;
var MAX_PROJECT_PAGES = 10;
var PROJECT_PAGE_SIZE = 200;
var REMINDER_SOURCES = ['reminders/list', 'reminders/configured'];

// Without Pebble.permissions the host fails a request to a domain the user hasn't allowed the same way as a dead network.
var PROBES = [['api.todoist.com', 'https://api.todoist.com/']];
var BLOCKED_KEY = 'todoist.blocked.v1';

// Resolves with the first domain whose request fails, or null once every request has answered.
function unreachableHost() {
  return new Promise(function (resolve) {
    var answered = 0;
    PROBES.forEach(function (probe) {
      Promise.resolve().then(function () { return fetch(probe[1]); })
        .then(function () { if (++answered === PROBES.length) resolve(null); }, function () { resolve(probe[0]); });
    });
  });
}

// { host, sure }: the first domain not allowed (sure) or not reachable (not sure), or null.
async function blockedHost() {
  var permissions = typeof Pebble !== 'undefined' && Pebble.permissions;
  if (permissions) {
    for (var i = 0; i < PROBES.length; i++) {
      if (await permissions.query('Internet/' + PROBES[i][0]) !== 'granted') return { host: PROBES[i][0], sure: true };
    }
    return null;
  }
  var host = await unreachableHost();
  return host && { host: host, sure: false };
}

async function checkReach() {
  var blocked = await blockedHost();
  try {
    if (blocked) localStorage.setItem(BLOCKED_KEY, JSON.stringify(blocked));
    else localStorage.removeItem(BLOCKED_KEY);
  } catch (e) {}
  return blocked;
}

function lastBlocked() {
  try {
    return JSON.parse(localStorage.getItem(BLOCKED_KEY)) || null;
  } catch (e) {
    return null;
  }
}

function blockedMessage(blocked) {
  return 'Todoist doesn\'t have permission to connect to ' + blocked.host + '. Turn on "Connect to ' + blocked.host + '" in Todoist\'s Permissions' + (blocked.sure ? '.' : ', or check your internet connection.');
}

// Probes have no deadline, so an error answers from the last check and starts a new one.
// A NotAllowedError names PROBES[0][0] because every request goes there.
function unreachableMessage(fallback, error) {
  var blocked = null;
  try {
    blocked = error && error.name === 'NotAllowedError' ? { host: PROBES[0][0], sure: true } : lastBlocked();
    checkReach().catch(function () {});
  } catch (e) {}
  return blocked ? blockedMessage(blocked) : fallback;
}

async function secureItem(key) {
  return String(await Pebble.secureStorage.getItem(key) || '').trim();
}

function accessToken() {
  return secureItem(TOKEN_KEY);
}

async function saveTokenBundle(bundle) {
  var token = String(bundle && bundle.access_token || '').trim();
  if (!token) throw new Error('Todoist returned no access token.');
  await Pebble.secureStorage.setItem(TOKEN_KEY, token);
  var brokerRefresh = String(bundle.broker_refresh || '').trim();
  if (brokerRefresh) await Pebble.secureStorage.setItem(BROKER_REFRESH_KEY, brokerRefresh);
  else await Pebble.secureStorage.removeItem(BROKER_REFRESH_KEY);
  var expiresIn = Number(bundle.expires_in || 0);
  if (isFinite(expiresIn) && expiresIn > 0) {
    localStorage.setItem(EXPIRES_AT_KEY, String(Date.now() + expiresIn * 1000));
  } else {
    localStorage.removeItem(EXPIRES_AT_KEY);
  }
}

async function clearTokens() {
  await Pebble.secureStorage.removeItem(TOKEN_KEY);
  await Pebble.secureStorage.removeItem(BROKER_REFRESH_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
}

async function ensureAccessToken() {
  var token = await accessToken();
  var expiresAt = Number(localStorage.getItem(EXPIRES_AT_KEY) || 0);
  if (token && (!expiresAt || Date.now() < expiresAt - 60000)) return token;
  var brokerRefresh = await secureItem(BROKER_REFRESH_KEY);
  if (!brokerRefresh) return token;
  await saveTokenBundle(await Pebble.oauth.refresh('todoist', brokerRefresh));
  return accessToken();
}

async function requestJson(method, path, body, tokenOverride) {
  var token = tokenOverride ? String(tokenOverride).trim() : await ensureAccessToken();
  if (!token) return { ok: false, status: 401, json: null, text: '' };
  var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  try {
    var response = await fetch(API_ROOT + path, {
      method: method,
      headers: headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
    });
    var text = await response.text();
    var json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      // The status and generic operation error remain useful for non-JSON responses.
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: json,
      text: text || '',
    };
  } catch (e) {
    console.error('Todoist ' + method + ' ' + path + ' failed: ' + e);
    return { ok: false, status: 0, json: null, text: '', cause: e };
  }
}

function apiErrorMessage(response, fallback) {
  var json = response && response.json;
  if (json && typeof json.error === 'string' && json.error.trim()) return json.error.trim();
  if (json && typeof json.error_description === 'string' && json.error_description.trim()) {
    return json.error_description.trim();
  }
  if (json && typeof json.error_tag === 'string' && json.error_tag.trim()) {
    return json.error_tag.trim();
  }
  return fallback;
}

function respondWithHttpError(response, respond, operation) {
  console.error('Failed to ' + operation + ': HTTP ' + response.status + ' ' + response.text);
  if (response.status === 401 || response.status === 403) {
    respond.error('AUTH_REQUIRED', 'Todoist authorization is missing, expired, or lacks data:read_write access.');
    return;
  }
  if (response.status === 429) {
    respond.error('RATE_LIMITED', 'Todoist rate-limited ' + operation + '.');
    return;
  }
  if (response.status === 0) {
    respond.error('PLUGIN_UNAVAILABLE', unreachableMessage('Could not reach Todoist.', response.cause));
    return;
  }
  respond.error(
    'PLUGIN_UNAVAILABLE',
    apiErrorMessage(response, 'Todoist failed to ' + operation + ' (HTTP ' + response.status + ').')
  );
}

function shortText(text) {
  return { shortText: { text: String(text) } };
}

function longText(text) {
  return { longText: { text: String(text) } };
}

function booleanReading(value) {
  return {
    boolean: { value: !!value },
    shortText: { text: value ? 'Connected' : 'Not connected' },
  };
}

async function respondConfigured(respond) {
  var configured = (await accessToken()).length > 0;
  respond.data({
    validUntilMs: Date.now() + 60 * 1000,
    instances: [{
      instanceId: 'todoist',
      properties: { name: shortText('Todoist'), configured: booleanReading(configured) },
    }],
  });
}

function projectUrl(projectId) {
  return 'https://app.todoist.com/app/project/' + encodeURIComponent(projectId);
}

function taskUrl(taskId) {
  // Todoist API v1 deliberately removed response `url`; this is its documented v2-ID URL.
  return 'https://app.todoist.com/app/task/' + encodeURIComponent(taskId);
}

function projectsFromResponse(response) {
  if (Array.isArray(response)) {
    // Compatibility with the former REST response shape during the API v1 migration.
    return { results: response, nextCursor: null };
  }
  if (!response || !Array.isArray(response.results)) return null;
  return {
    results: response.results,
    nextCursor: typeof response.next_cursor === 'string' && response.next_cursor
      ? response.next_cursor
      : null,
  };
}

async function loadProjects(tokenOverride, limitPages) {
  var projects = [];
  var cursor = null;
  var pageLimit = limitPages || MAX_PROJECT_PAGES;

  for (var page = 0; page < pageLimit; page += 1) {
    var path = '/projects?limit=' + PROJECT_PAGE_SIZE;
    if (cursor) path += '&cursor=' + encodeURIComponent(cursor);
    var response = await requestJson('GET', path, null, tokenOverride);
    if (!response.ok) return response;

    var parsed = projectsFromResponse(response.json);
    if (!parsed) {
      return {
        ok: false,
        status: 502,
        json: null,
        text: 'Todoist returned a malformed project list.',
      };
    }
    projects = projects.concat(parsed.results);
    cursor = parsed.nextCursor;
    if (!cursor) return { ok: true, status: 200, projects: projects };
    // Configuration only needs one authenticated response to validate a freshly pasted token.
    if (pageLimit === 1) {
      return { ok: true, status: 200, projects: projects, hasMore: true };
    }
  }

  return {
    ok: false,
    status: 502,
    json: null,
    text: 'Todoist returned too many project pages.',
  };
}

Pebble.registerSourceHandler(async function (request, respond) {
  if (request.category === 'reminders' && request.item === 'configured') {
    await respondConfigured(respond);
    return;
  }
  if (request.category !== 'reminders' || request.item !== 'list') {
    respond.error('INVALID_REQUEST', 'Unsupported Todoist source.');
    return;
  }
  if (!(await accessToken())) {
    respond.error('AUTH_REQUIRED', 'Connect Todoist in the plugin gear page.');
    return;
  }

  var response = await loadProjects(null, MAX_PROJECT_PAGES);
  if (!response.ok) {
    if (response.text === 'Todoist returned a malformed project list.' ||
        response.text === 'Todoist returned too many project pages.') {
      respond.error('PLUGIN_UNAVAILABLE', response.text);
    } else {
      respondWithHttpError(response, respond, 'load projects');
    }
    return;
  }

  var instances = response.projects.filter(function (project) {
    return project && project.is_archived !== true && project.is_deleted !== true &&
      project.is_frozen !== true &&
      typeof project.id === 'string' && project.id.length > 0 &&
      typeof project.name === 'string' && project.name.trim().length > 0;
  }).map(function (project) {
    return {
      instanceId: project.id,
      properties: {
        name: shortText(project.name.trim()),
        destination: shortText('Todoist project'),
        url: longText(projectUrl(project.id)),
      },
    };
  });

  respond.data({
    validUntilMs: Date.now() + PROJECT_REFRESH_MS,
    instances: instances,
  });
});

/** Strictly parse the absolute RFC3339 subset shared by CoreApp destination plugins. */
function todoistDueDate(value) {
  var match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;

  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var hour = Number(match[4]);
  var minute = Number(match[5]);
  var second = Number(match[6]);
  var offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  var offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  var leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  var days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 ||
    day < 1 || day > days[month - 1] ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) {
    return null;
  }

  var date = new Date(value);
  if (isNaN(date.getTime())) return null;
  // Normalize the instant to UTC. Todoist renders it in the account/device time zone, avoiding
  // the wall-clock/UTC confusion that caused the original TickTick prototype's timestamp bug.
  return date.toISOString();
}

function validWholeMilliseconds(value) {
  return typeof value === 'number' && isFinite(value) &&
    Math.floor(value) === value && value >= 0;
}

async function addRelativeNotification(taskId, milliseconds) {
  return requestJson('POST', '/reminders', {
    task_id: taskId,
    reminder_type: 'relative',
    minute_offset: Math.round(milliseconds / 60000),
    service: 'push',
    is_urgent: false,
  });
}

Pebble.registerActionHandler(async function (request, respond) {
  if (request.action !== 'create_reminder') {
    respond.error('INVALID_REQUEST', 'Unsupported Todoist action.');
    return;
  }
  if (!(await accessToken())) {
    respond.error('AUTH_REQUIRED', 'Connect Todoist in the plugin gear page.');
    return;
  }

  var args = request.args || {};
  var title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) {
    respond.error('INVALID_ARGS', 'title must not be empty.');
    return;
  }

  var task = { content: title };
  if (Object.prototype.hasOwnProperty.call(args, 'instanceId')) {
    if (typeof args.instanceId !== 'string' || !args.instanceId.trim()) {
      respond.error('INVALID_ARGS', 'instanceId must be a non-empty Todoist project ID.');
      return;
    }
    task.project_id = args.instanceId.trim();
  }

  var hasDue = Object.prototype.hasOwnProperty.call(args, 'due_iso');
  if (hasDue) {
    if (typeof args.due_iso !== 'string' || !args.due_iso) {
      respond.error('INVALID_ARGS', 'due_iso must be an absolute RFC3339 date-time.');
      return;
    }
    var dueDate = todoistDueDate(args.due_iso);
    if (!dueDate) {
      respond.error(
        'INVALID_ARGS',
        'due_iso must be a valid absolute RFC3339 date-time with Z or a numeric offset.'
      );
      return;
    }
    if (typeof args.timezone !== 'string' || !args.timezone.trim()) {
      respond.error('INVALID_ARGS', 'timezone is required with due_iso.');
      return;
    }
    task.due_datetime = dueDate;
  }

  if (Object.prototype.hasOwnProperty.call(args, 'notify_before_ms') &&
      !validWholeMilliseconds(args.notify_before_ms)) {
    respond.error('INVALID_ARGS', 'notify_before_ms must be a non-negative integer.');
    return;
  }

  var response = await requestJson('POST', '/tasks', task);
  if (!response.ok) {
    respondWithHttpError(response, respond, 'create the reminder');
    return;
  }
  if (!response.json || typeof response.json.id !== 'string' || !response.json.id) {
    respond.error('PLUGIN_UNAVAILABLE', 'Todoist created no identifiable task.');
    return;
  }

  var notificationWarning = '';
  if (hasDue) {
    var leadTime = Object.prototype.hasOwnProperty.call(args, 'notify_before_ms')
      ? args.notify_before_ms
      : 0;
    var notification = await addRelativeNotification(response.json.id, leadTime);
    if (!notification.ok) {
      // The task is already durable, and Todoist restricts explicit reminders by account plan.
      // Report success instead of inviting an agent retry that would create a duplicate task.
      notificationWarning = ' Notification follows your Todoist account defaults.';
    }
  }

  respond.ok({
    text: 'Created “' + title + '” in Todoist.' + notificationWarning,
    url: taskUrl(response.json.id),
  });
});

Pebble.registerConfigHandler(async function (message, respond) {
  if (message && message.type === 'reach') {
    respond({ blocked: await checkReach().catch(function () { return null; }) });
    return;
  }
  switch (message && message.type) {
    case 'status': {
      var connected = (await accessToken()).length > 0;
      respond({ configured: connected, ready: connected });
      return;
    }

    case 'connect': {
      var bundle;
      try { bundle = await Pebble.oauth.authorize('todoist'); }
      catch (error) {
        respond({ error: error.message || 'Could not connect Todoist.' });
        return;
      }
      var token = String(bundle && bundle.access_token || '').trim();
      var validation = await loadProjects(token, 1);
      if (!validation.ok) {
        if (validation.status === 401 || validation.status === 403) {
          respond({ error: 'Todoist rejected the new authorization.' });
        } else if (validation.status === 0) {
          respond({ error: 'Could not reach Todoist to verify this token.' });
        } else {
          respond({ error: apiErrorMessage(validation, 'Todoist could not verify this token (HTTP ' + validation.status + ').') });
        }
        return;
      }
      try { await saveTokenBundle(bundle); }
      catch (error) {
        respond({ error: error.message || 'Todoist returned no access token.' });
        return;
      }
      Pebble.refreshSources(REMINDER_SOURCES);
      respond({ configured: true, ready: true, projectCount: validation.projects.length });
      return;
    }

    case 'unlink':
      await clearTokens();
      Pebble.refreshSources(REMINDER_SOURCES);
      respond({ configured: false, ready: false });
      return;

    default:
      respond({ error: 'Unknown message type.' });
  }
});
