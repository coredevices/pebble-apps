(function () {
  'use strict';

  var SETTINGS_KEY = 'ios_shortcuts_settings_v1';
  var INPUTS_KEY = 'ios_shortcuts_inputs_v1';
  var MAX_SHORTCUTS = 30;
  var MAX_INPUTS = 10;
  var MAX_INPUT_CHARS = 32768;
  var MAX_EVENT_TEXT_CHARS = 1000;
  var MAX_RESULT_TEXT_CHARS = 2000;

  var DEFAULT_SETTINGS = {
    version: 1,
    shortcuts: [],
    inbound: { askIndex: true, quietTime: true, event: true }
  };

  function copyDefaults() {
    return {
      version: 1,
      shortcuts: [],
      inbound: { askIndex: true, quietTime: true, event: true }
    };
  }

  function asNonEmptyString(value) {
    if (typeof value !== 'string') return null;
    var trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }

  function boundedText(value, limit) {
    var text = value == null ? '' : String(value);
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
  }

  function parseJson(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  }

  function normalizeBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function hash(value) {
    var result = 2166136261;
    for (var i = 0; i < value.length; i += 1) {
      result ^= value.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  }

  function shortcutId(label, name) {
    return 'shortcut-' + hash(label.toLowerCase() + '\u0000' + name.toLowerCase());
  }

  function sanitizeShortcut(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = asNonEmptyString(raw.name);
    var label = asNonEmptyString(raw.label) || name;
    if (!name || !label || name.length > 100 || label.length > 100) return null;
    var description = asNonEmptyString(raw.description) || '';
    if (description.length > 240) description = description.slice(0, 240);
    return { id: shortcutId(label, name), label: label, name: name, description: description };
  }

  function sanitizeSettings(raw) {
    var settings = copyDefaults();
    var seenIds = {};
    var seenLabels = {};
    var seenNames = {};
    var shortcuts = raw && Array.isArray(raw.shortcuts) ? raw.shortcuts : [];
    for (var i = 0; i < shortcuts.length && settings.shortcuts.length < MAX_SHORTCUTS; i += 1) {
      var item = sanitizeShortcut(shortcuts[i]);
      if (!item) continue;
      var labelKey = item.label.toLowerCase();
      var nameKey = item.name.toLowerCase();
      if (seenIds[item.id] || seenLabels[labelKey] || seenNames[nameKey]) continue;
      seenIds[item.id] = true;
      seenLabels[labelKey] = true;
      seenNames[nameKey] = true;
      settings.shortcuts.push(item);
    }
    var inbound = raw && raw.inbound && typeof raw.inbound === 'object' ? raw.inbound : {};
    settings.inbound = {
      askIndex: normalizeBoolean(inbound.askIndex, true),
      quietTime: normalizeBoolean(inbound.quietTime, true),
      event: normalizeBoolean(inbound.event, true)
    };
    return settings;
  }

  function loadSettings() {
    return sanitizeSettings(parseJson(localStorage.getItem(SETTINGS_KEY), DEFAULT_SETTINGS));
  }

  function saveSettings(settings) {
    var sanitized = sanitizeSettings(settings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
    return sanitized;
  }

  function loadInputs() {
    var raw = parseJson(localStorage.getItem(INPUTS_KEY), []);
    return Array.isArray(raw) ? raw.slice(0, MAX_INPUTS) : [];
  }

  function saveInputs(inputs) {
    localStorage.setItem(INPUTS_KEY, JSON.stringify(inputs.slice(0, MAX_INPUTS)));
  }

  function iosShortcutsHost() {
    var host = Pebble && Pebble.iosShortcuts;
    return host && typeof host.run === 'function' ? host : null;
  }

  function findShortcut(settings, args) {
    var wanted = asNonEmptyString(args.shortcut);
    if (!wanted) return null;
    var key = wanted.toLowerCase();
    for (var i = 0; i < settings.shortcuts.length; i += 1) {
      var item = settings.shortcuts[i];
      if (item.label.toLowerCase() === key || item.name.toLowerCase() === key) return item;
    }
    return null;
  }

  function serializeShortcutInput(args) {
    var hasText = Object.prototype.hasOwnProperty.call(args, 'input');
    var hasPayload = Object.prototype.hasOwnProperty.call(args, 'payload');
    if (hasText && hasPayload) throw invalidArgs('Pass either input or payload, not both.');
    var value = '';
    if (hasPayload) {
      if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
        throw invalidArgs('payload must be a JSON object.');
      }
      try { value = JSON.stringify(args.payload); }
      catch (_) { throw invalidArgs('payload could not be serialized as JSON.'); }
    } else if (hasText) {
      if (typeof args.input !== 'string') throw invalidArgs('input must be text.');
      value = args.input;
    }
    if (value.length > MAX_INPUT_CHARS) throw invalidArgs('Shortcut Input is too long.');
    return value;
  }

  function pluginError(code, message) {
    var error = new Error(message);
    error.pluginCode = code;
    return error;
  }

  function invalidArgs(message) { return pluginError('INVALID_ARGS', message); }

  function hostError(result) {
    var status = result && result.status;
    var message = asNonEmptyString(result && result.message) || 'The Shortcut could not be run.';
    if (status === 'cancelled') return pluginError('PLUGIN_UNAVAILABLE', 'The Shortcut was cancelled.');
    if (status === 'timeout') return pluginError('TIMEOUT', message);
    if (status === 'unavailable') return pluginError('PLUGIN_UNAVAILABLE', message);
    return pluginError('PLUGIN_UNAVAILABLE', message);
  }

  function readInputAllowed(settings, command) {
    if (command === 'ask_index') return settings.inbound.askIndex;
    if (command === 'quiet_time') return settings.inbound.quietTime;
    if (command === 'event') return settings.inbound.event;
    return false;
  }

  function validateIncoming(args, settings) {
    var command = asNonEmptyString(args.command);
    if (command !== 'ask_index' && command !== 'quiet_time' && command !== 'event') {
      throw invalidArgs('command must be ask_index, quiet_time, or event.');
    }
    if (!readInputAllowed(settings, command)) {
      throw pluginError('PERMISSION_DENIED', 'This incoming Shortcuts command is disabled in plugin settings.');
    }
    if ((command === 'ask_index' || command === 'event') && !asNonEmptyString(args.text)) {
      throw invalidArgs(command + ' requires non-empty text.');
    }
    if (command === 'quiet_time' && typeof args.enabled !== 'boolean') {
      throw invalidArgs('quiet_time requires enabled=true or enabled=false.');
    }
    return command;
  }

  function recordIncoming(args, command) {
    var now = typeof args.received_at_ms === 'number' && isFinite(args.received_at_ms) && args.received_at_ms >= 0
      ? Math.floor(args.received_at_ms) : Date.now();
    var text = command === 'quiet_time'
      ? (args.enabled ? 'Enable Quiet Time' : 'Disable Quiet Time')
      : boundedText(args.text, MAX_EVENT_TEXT_CHARS);
    var result = boundedText(args.result, MAX_RESULT_TEXT_CHARS);
    var inputs = loadInputs();
    var sequence = inputs.length ? ((Number(inputs[0].sequence) || 0) + 1) : 1;
    var event = {
      id: 'input-' + now + '-' + sequence,
      sequence: sequence,
      command: command,
      text: text,
      result: result,
      status: asNonEmptyString(args.result) ? 'Handled' : 'Received',
      receivedAtMs: now
    };
    inputs.unshift(event);
    saveInputs(inputs);
    Pebble.refreshSources(['shortcuts/input']);
    return event;
  }

  function shortText(value) { return { shortText: { text: String(value) } }; }
  function longText(value) { return { longText: { text: String(value) } }; }
  function bothText(value) {
    return { shortText: { text: String(value) }, longText: { text: String(value) } };
  }

  function shortcutInstances() {
    return loadSettings().shortcuts.map(function (item) {
      return {
        instanceId: item.id,
        properties: {
          name: bothText(item.label),
          shortcut_name: longText(item.name),
          description: longText(item.description || 'Runs “' + item.name + '” in Apple Shortcuts.')
        }
      };
    });
  }

  function inputInstances() {
    return loadInputs().map(function (item) {
      return {
        instanceId: item.id,
        properties: {
          name: bothText(item.command === 'ask_index' ? 'Asked Index' : item.command === 'quiet_time' ? 'Quiet Time' : 'Shortcut event'),
          command: shortText(item.command),
          input: longText(item.text || ''),
          result: longText(item.result || ''),
          status: shortText(item.status || 'Received'),
          received_at: { timestamp: { value: Math.floor(Number(item.receivedAtMs) / 1000) } }
        }
      };
    });
  }

  function statusFor(action) {
    var settings = loadSettings();
    var hostReady = !!iosShortcutsHost();
    var configured;
    if (action === 'run_shortcut') configured = settings.shortcuts.length > 0;
    else if (action === 'receive_input') configured = settings.inbound.askIndex || settings.inbound.quietTime || settings.inbound.event;
    else configured = settings.shortcuts.length > 0 || settings.inbound.askIndex || settings.inbound.quietTime || settings.inbound.event;
    return {
      configured: configured,
      ready: action === 'receive_input' ? configured : configured && hostReady,
      platformSupported: hostReady,
      shortcutCount: settings.shortcuts.length,
      inbound: settings.inbound,
      settings: settings,
      recentInputs: loadInputs(),
      reason: hostReady ? null : 'Running Apple Shortcuts requires CoreApp on iPhone or iPad.'
    };
  }

  async function runShortcut(args) {
    var settings = loadSettings();
    var item = findShortcut(settings, args);
    if (!item) throw invalidArgs('Choose one of the shortcuts allow-listed in iOS Shortcuts settings.');
    var host = iosShortcutsHost();
    if (!host) throw pluginError('PLUGIN_UNAVAILABLE', 'Running Apple Shortcuts requires CoreApp on iPhone or iPad.');
    var input = serializeShortcutInput(args);
    var result = await host.run({ name: item.name, input: input, timeoutMs: 60000 });
    if (!result || result.status !== 'success') {
      console.error('Running a shortcut failed: ' + (result && result.status));
      throw hostError(result);
    }
    var output = boundedText(result.output, MAX_RESULT_TEXT_CHARS);
    return {
      text: output ? '“' + item.label + '” returned: ' + output : 'Ran “' + item.label + '”.'
    };
  }

  Pebble.registerSourceHandler(function (request, respond) {
    try {
      if (request.category !== 'shortcuts') throw invalidArgs('Unknown source category.');
      var instances;
      if (request.item === 'shortcut') instances = shortcutInstances();
      else if (request.item === 'input') instances = inputInstances();
      else throw invalidArgs('Unknown shortcuts source item.');
      respond.data({ validUntilMs: Date.now() + 60000, instances: instances });
    } catch (error) {
      console.error('Reading ' + (request && request.category) + '/' + (request && request.item) + ' failed: ' + ((error && error.pluginCode) || 'UNKNOWN'));
      respond.error(error.pluginCode || 'UNKNOWN', error.message || String(error));
    }
  });

  Pebble.registerActionHandler(async function (request, respond) {
    try {
      var args = request.args || {};
      if (request.action === 'run_shortcut') {
        respond.ok(await runShortcut(args));
        return;
      }
      if (request.action === 'receive_input') {
        var settings = loadSettings();
        var command = validateIncoming(args, settings);
        var event = recordIncoming(args, command);
        respond.ok({
          text: command === 'ask_index' ? 'Sent to Index.' :
            command === 'quiet_time' ? event.text + '.' : 'Received Shortcut event.',
          refreshed: ['shortcuts/input']
        });
        return;
      }
      throw invalidArgs('Unknown action: ' + request.action);
    } catch (error) {
      console.error((request && request.action) + ' failed: ' + ((error && error.pluginCode) || 'UNKNOWN'));
      respond.error(error.pluginCode || 'UNKNOWN', error.message || String(error));
    }
  });

  Pebble.registerConfigHandler(async function (message, respond) {
    try {
      var type = message && message.type;
      if (type === 'status') {
        respond(statusFor(asNonEmptyString(message.action)));
        return;
      }
      if (type === 'save') {
        var saved = saveSettings({ shortcuts: message.shortcuts, inbound: message.inbound });
        Pebble.refreshSources(['shortcuts/shortcut']);
        respond({ ok: true, settings: saved, status: statusFor(null) });
        return;
      }
      if (type === 'testShortcut') {
        var result = await runShortcut({ shortcut: message.shortcut, input: message.input || '' });
        respond({ ok: true, text: result.text });
        return;
      }
      if (type === 'clearInputs') {
        saveInputs([]);
        Pebble.refreshSources(['shortcuts/input']);
        respond({ ok: true, recentInputs: [] });
        return;
      }
      console.error('Unsupported config request: ' + type);
      respond({ error: 'Unknown config request.' });
    } catch (error) {
      console.error('Config ' + (message && message.type) + ' failed: ' + ((error && error.pluginCode) || 'UNKNOWN'));
      respond({ error: error.message || String(error), code: error.pluginCode || 'UNKNOWN' });
    }
  });
})();
