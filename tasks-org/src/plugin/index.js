// Tasks.org Index plugin. Native access is intentionally narrow: the host exposes
// Pebble.tasksOrg only to plugins declaring the TasksOrg permission (Android only).

var DESTINATION_ID_KEY = 'tasks_org_destination_id';
var DESTINATION_TITLE_KEY = 'tasks_org_destination_title';
var TASKS_URL = 'content://org.tasks.api/v0/tasks';
var SOURCE_VALID_MS = 5 * 60 * 1000;
var MAX_TITLE_LENGTH = 4096;
var configLane = Promise.resolve();

function nativeApi() {
  return Pebble && Pebble.tasksOrg ? Pebble.tasksOrg : null;
}

function storedDestinationId() {
  return String(localStorage.getItem(DESTINATION_ID_KEY) || '').trim();
}

function storedDestinationTitle() {
  return String(localStorage.getItem(DESTINATION_TITLE_KEY) || '').trim();
}

function shortText(text) {
  return { shortText: { text: text } };
}

function longText(text) {
  return { longText: { text: text } };
}

function bridgeErrorCode(error) {
  return error && typeof error.code === 'string' ? error.code : '';
}

function userFacingError(error, operation) {
  var code = bridgeErrorCode(error);
  // Bridge messages can echo task titles, so only the code is logged for them.
  console.error('Tasks.org could not ' + operation + ': ' + (code || (error && error.message) || error));
  if (code === 'AUTH_REQUIRED' || code === 'PERMISSION_DENIED') {
    return { code: 'AUTH_REQUIRED', message: 'Allow Pebble to access tasks.org.' };
  }
  if (code === 'INVALID_ARGS') {
    return { code: 'INVALID_ARGS', message: error && error.message ? error.message : 'Invalid request.' };
  }
  if (code === 'UNSUPPORTED') {
    return { code: 'PLUGIN_UNAVAILABLE', message: 'Install the tasks.org app to use this plugin.' };
  }
  return { code: 'PLUGIN_UNAVAILABLE', message: 'Tasks.org could not ' + operation + '.' };
}

function validStatus(value) {
  return value && typeof value.supported === 'boolean' &&
    (value.authorization === 'authorized' || value.authorization === 'denied' ||
      value.authorization === 'restricted');
}

async function readStatus() {
  var api = nativeApi();
  if (!api || typeof api.status !== 'function') {
    return { supported: false, authorization: 'restricted' };
  }
  var status = await api.status();
  if (!validStatus(status)) throw new Error('Malformed tasks.org status');
  return status;
}

function validList(value) {
  return value && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.title === 'string' && value.title.trim().length > 0;
}

async function readLists() {
  var api = nativeApi();
  if (!api || typeof api.listLists !== 'function') {
    var unsupported = new Error('Tasks.org is unavailable');
    unsupported.code = 'UNSUPPORTED';
    throw unsupported;
  }
  var result = await api.listLists();
  if (!result || !Array.isArray(result.lists)) {
    throw new Error('Malformed tasks.org list response');
  }
  var lists = result.lists.filter(validList).map(function (list) {
    return {
      id: list.id,
      title: list.title.trim(),
      isDefault: list.isDefault === true || list.id === result.defaultListId,
    };
  });
  return { defaultListId: result.defaultListId || null, lists: lists };
}

function absoluteRfc3339(value) {
  if (typeof value !== 'string') return false;
  var match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var hour = Number(match[4]);
  var minute = Number(match[5]);
  var second = Number(match[6]);
  var offsetHour = Number(match[8] || 0);
  var offsetMinute = Number(match[9] || 0);
  var leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59 &&
    offsetHour <= 23 && offsetMinute <= 59 && !isNaN(new Date(value).getTime());
}

function serializeConfig(operation) {
  var run = configLane.then(operation, operation);
  configLane = run.then(function () {}, function () {});
  return run;
}

async function configurationStatus() {
  var status;
  try {
    status = await readStatus();
  } catch (error) {
    console.error('Reading tasks.org status failed: ' + (bridgeErrorCode(error) || (error && error.message) || error));
    return { configured: false, ready: false, supported: false, authorization: 'restricted' };
  }
  var response = {
    configured: status.supported && status.authorization === 'authorized',
    ready: status.supported && status.authorization === 'authorized',
    supported: status.supported,
    authorization: status.authorization,
    selectedListId: storedDestinationId() || null,
    selectedListTitle: storedDestinationTitle() || null,
  };
  if (!response.ready || !response.selectedListId) return response;

  try {
    var result = await readLists();
    var selectedExists = result.lists.some(function (list) {
      return list.id === response.selectedListId;
    });
    if (!selectedExists) {
      response.configured = false;
      response.ready = false;
      response.error = 'The selected list no longer exists. Choose another list.';
    }
  } catch (error) {
    response.configured = false;
    response.ready = false;
    response.error = userFacingError(error, 'load lists').message;
  }
  return response;
}

Pebble.registerSourceHandler(async function (request, respond) {
  if (request.category !== 'reminders' || request.item !== 'list') {
    console.error('Unsupported source: ' + request.category + '/' + request.item);
    respond.error('INVALID_REQUEST', 'Unsupported tasks.org source.');
    return;
  }
  try {
    var status = await readStatus();
    if (!status.supported) {
      respond.error('PLUGIN_UNAVAILABLE', 'Install the tasks.org app to use this plugin.');
      return;
    }
    if (status.authorization !== 'authorized') {
      respond.error('AUTH_REQUIRED', 'Allow Pebble to access tasks.org first.');
      return;
    }
    var result = await readLists();
    respond.data({
      validUntilMs: Date.now() + SOURCE_VALID_MS,
      instances: result.lists.map(function (list) {
        return {
          instanceId: list.id,
          properties: {
            name: shortText(list.title),
            destination: shortText(list.isDefault ? 'Default tasks.org list' : 'Tasks.org list'),
            url: longText(TASKS_URL),
          },
        };
      }),
    });
  } catch (error) {
    var failure = userFacingError(error, 'load lists');
    respond.error(failure.code, failure.message);
  }
});

Pebble.registerActionHandler(async function (request, respond) {
  if (request.action !== 'create_reminder') {
    console.error('Unsupported action: ' + request.action);
    respond.error('INVALID_REQUEST', 'Unsupported tasks.org action.');
    return;
  }
  var args = request.args || {};
  var title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title || title.length > MAX_TITLE_LENGTH) {
    respond.error('INVALID_ARGS', 'title must be between 1 and 4096 characters.');
    return;
  }

  var create = { title: title };
  if (Object.prototype.hasOwnProperty.call(args, 'due_iso')) {
    if (!absoluteRfc3339(args.due_iso)) {
      respond.error('INVALID_ARGS', 'due_iso must be a valid absolute RFC3339 date-time.');
      return;
    }
    create.dueIso = args.due_iso;
  }
  if (Object.prototype.hasOwnProperty.call(args, 'notify_before_ms')) {
    if (typeof args.notify_before_ms !== 'number' || !isFinite(args.notify_before_ms) ||
        Math.floor(args.notify_before_ms) !== args.notify_before_ms || args.notify_before_ms < 0 ||
        args.notify_before_ms > 2147483647) {
      respond.error('INVALID_ARGS', 'notify_before_ms must be an integer from 0 through 2147483647.');
      return;
    }
    // The due reminder itself fires at zero; a zero lead would just duplicate it.
    if (create.dueIso && args.notify_before_ms > 0) create.notifyBeforeMs = args.notify_before_ms;
  }

  var explicitListId = Object.prototype.hasOwnProperty.call(args, 'instanceId');
  if (explicitListId && (typeof args.instanceId !== 'string' || !args.instanceId.trim())) {
    respond.error('INVALID_ARGS', 'instanceId must be a non-empty tasks.org list id.');
    return;
  }
  var listId = explicitListId ? args.instanceId.trim() : storedDestinationId();
  if (listId) create.listId = listId;

  try {
    var status = await readStatus();
    if (!status.supported) {
      respond.error('PLUGIN_UNAVAILABLE', 'Install the tasks.org app to use this plugin.');
      return;
    }
    if (status.authorization !== 'authorized') {
      respond.error('AUTH_REQUIRED', 'Allow Pebble to access tasks.org first.');
      return;
    }
    var api = nativeApi();
    if (!api || typeof api.createReminder !== 'function') {
      respond.error('PLUGIN_UNAVAILABLE', 'This CoreApp build does not support tasks.org plugins.');
      return;
    }
    var created = await api.createReminder(create);
    if (!created || typeof created.id !== 'string' || !created.id) {
      throw new Error('Malformed tasks.org create response');
    }
    var listTitle = typeof created.listTitle === 'string' && created.listTitle.trim()
      ? created.listTitle.trim() : 'Tasks.org';
    respond.ok({
      text: 'Created “' + title + '” in ' + listTitle + '.',
      url: typeof created.url === 'string' && created.url ? created.url : TASKS_URL,
    });
  } catch (error) {
    var failure = userFacingError(error, 'create the task');
    respond.error(failure.code, failure.message);
  }
});

Pebble.registerConfigHandler(function (message, respond) {
  serializeConfig(async function () {
    switch (message && message.type) {
      case 'status':
        respond(await configurationStatus());
        return;
      case 'requestAccess': {
        var api = nativeApi();
        if (!api || typeof api.requestAccess !== 'function') {
          respond({ error: 'Tasks.org is available only on the Android version of CoreApp.' });
          return;
        }
        try {
          var status = await api.requestAccess();
          if (!validStatus(status)) throw new Error('Malformed tasks.org status');
          var reply = await configurationStatus();
          if (status.authorization !== 'authorized') {
            reply.error = 'Access was not granted. Allow tasks.org reminders to continue.';
          }
          respond(reply);
        } catch (error) {
          respond({ error: userFacingError(error, 'request access').message });
        }
        return;
      }
      case 'listLists':
        try {
          var status = await readStatus();
          if (!status.supported || status.authorization !== 'authorized') {
            respond({ error: 'Allow Pebble to access tasks.org first.' });
            return;
          }
          var result = await readLists();
          respond({
            lists: result.lists,
            defaultListId: result.defaultListId,
            selectedListId: storedDestinationId() || null,
          });
        } catch (error) {
          respond({ error: userFacingError(error, 'load lists').message });
        }
        return;
      case 'saveDestination':
        try {
          var id = String(message.listId || '').trim();
          if (!id) {
            respond({ error: 'Choose a task list.' });
            return;
          }
          var available = await readLists();
          var chosen = available.lists.find(function (list) { return list.id === id; });
          if (!chosen) {
            respond({ error: 'That task list is no longer available.' });
            return;
          }
          localStorage.setItem(DESTINATION_ID_KEY, chosen.id);
          localStorage.setItem(DESTINATION_TITLE_KEY, chosen.title);
          Pebble.refreshSources(['reminders/list']);
          respond({ configured: true, ready: true, selectedListId: chosen.id, selectedListTitle: chosen.title });
        } catch (error) {
          respond({ error: userFacingError(error, 'save the destination').message });
        }
        return;
      case 'useSystemDefault':
        localStorage.removeItem(DESTINATION_ID_KEY);
        localStorage.removeItem(DESTINATION_TITLE_KEY);
        Pebble.refreshSources(['reminders/list']);
        respond({ configured: true, ready: true, selectedListId: null, selectedListTitle: null });
        return;
      default:
        respond({ error: 'Unknown tasks.org configuration request.' });
    }
  }).catch(function (error) {
    respond({ error: String(error && error.message ? error.message : error) });
  });
});
