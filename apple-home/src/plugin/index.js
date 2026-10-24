(function () {
  'use strict';
  var sourceKeys = ['home/home', 'home/room', 'home/device', 'home/scene', 'home/automation'];
  function fail(code, message) { var error = new Error(message); error.code = code; throw error; }
  function native(operation, args) {
    if (!Pebble.appleHome) fail('PLUGIN_UNAVAILABLE', 'Apple Home Control requires an iPhone build with HomeKit support.');
    return Pebble.appleHome.request(operation, args || {});
  }
  function text(value) { return { shortText: { text: String(value == null ? '' : value) } }; }
  function detail(value) { return { longText: { text: typeof value === 'string' ? value : JSON.stringify(value) } }; }
  function number(value, unit) { return { numericValue: { value: value, unit: unit } }; }
  function bool(value) { return { boolean: { value: value === true } }; }
  function normalized(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
  function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function errorReply(respond, error, operation) {
    // Not the message: it can name the home and its devices.
    console.error(operation + ' failed: ' + (error.code || 'PLUGIN_UNAVAILABLE'));
    respond.error(error.code || 'PLUGIN_UNAVAILABLE', error.message || 'Apple Home request failed.');
  }
  function keys(args, permitted) {
    Object.keys(args).forEach(function (key) {
      if (permitted.indexOf(key) < 0) fail('INVALID_ARGS', 'Unknown argument: ' + key);
    });
  }
  function nonempty(args, key) {
    if (has(args, key) && !normalized(args[key])) fail('INVALID_ARGS', key + ' must be a nonempty string.');
  }
  function numeric(args, key, minimum, maximum) {
    var value = args[key];
    if (typeof value !== 'number' || !isFinite(value) || value < minimum || value > maximum) {
      fail('INVALID_ARGS', key + ' must be a number from ' + minimum + ' through ' + maximum + '.');
    }
    return value;
  }
  function aliases(action, input) {
    var args = Object.assign({}, input);
    function move(from, to) {
      if (!has(args, from)) return;
      if (has(args, to)) fail('INVALID_ARGS', 'Provide only one of ' + from + ' and ' + to + '.');
      args[to] = args[from]; delete args[from];
    }
    move('name', action === 'run_scene' ? 'scene' : 'device');
    move('type', 'device_type'); move('brightness_pct', 'brightness'); move('volume_pct', 'volume');
    if (action === 'set_thermostat') {
      ['temperature_c', 'temperature_f'].forEach(function (key) {
        if (!has(args, key)) return;
        if (has(args, 'temperature') || has(args, 'unit')) fail('INVALID_ARGS', 'Provide exactly one temperature with its unit.');
        args.temperature = args[key]; args.unit = key === 'temperature_c' ? 'celsius' : 'fahrenheit'; delete args[key];
      });
    }
    return args;
  }
  async function structure() {
    var result = await native('structure');
    if (!result || !result.home || !Array.isArray(result.devices) || !Array.isArray(result.rooms) || !Array.isArray(result.scenes)) {
      fail('PLUGIN_UNAVAILABLE', 'Apple Home returned an invalid catalogue.');
    }
    return result;
  }
  function checkHome(catalogue, args) {
    nonempty(args, 'home');
    if (args.home && normalized(args.home) !== normalized(catalogue.home.id) && normalized(args.home) !== normalized(catalogue.home.name)) {
      fail('INVALID_ARGS', 'This plugin is connected to ' + catalogue.home.name + '. Choose another home in its settings.');
    }
  }
  function resolveRoom(catalogue, query) {
    var matches = catalogue.rooms.filter(function (room) { return normalized(room.id) === normalized(query); });
    if (!matches.length) matches = catalogue.rooms.filter(function (room) { return normalized(room.name) === normalized(query); });
    if (matches.length !== 1) fail('INVALID_ARGS', matches.length ? 'Room name is ambiguous; use its ID.' : 'Room not found. Read home/room for exact names and IDs.');
    return matches[0].id;
  }
  function supports(device, values) {
    return Object.keys(values).every(function (key) {
      return device.capabilities.filter(function (capability) { return capability.key === key && capability.writable; }).length === 1;
    });
  }
  function devices(catalogue, args, values) {
    checkHome(catalogue, args);
    ['device', 'instanceId', 'room', 'device_type'].forEach(function (key) { nonempty(args, key); });
    if (has(args, 'all') && typeof args.all !== 'boolean') fail('INVALID_ARGS', 'all must be a boolean.');
    if (args.device && args.instanceId) fail('INVALID_ARGS', 'Use device or instanceId, not both.');
    var room = args.room ? resolveRoom(catalogue, args.room) : null;
    var candidates = catalogue.devices.filter(function (device) {
      return (!room || device.roomId === room) && (!args.device_type || device.type === args.device_type);
    });
    var id = args.instanceId;
    var name = args.device;
    if (args.all === true) {
      if (id || name || !room || !args.device_type || !Object.keys(values).length) {
        fail('INVALID_ARGS', 'Group control requires all=true, room, and device_type, without a device selector.');
      }
      candidates = candidates.filter(function (device) { return supports(device, values); });
    } else {
      if (!id && !name) fail('INVALID_ARGS', 'Choose a device by instanceId or exact device name.');
      candidates = candidates.filter(function (device) {
        return id ? normalized(device.id) === normalized(id) :
          normalized(device.name) === normalized(name) || normalized(device.accessoryName) === normalized(name);
      });
      if (candidates.length > 1 && Object.keys(values).length) candidates = candidates.filter(function (device) { return supports(device, values); });
      if (candidates.length > 1) fail('INVALID_ARGS', 'Device name is ambiguous; specify room or use a service instanceId from home/device.');
    }
    if (!candidates.length) fail('INVALID_ARGS', 'No matching device supports this request. Read home/device for names, IDs, and capabilities.');
    if (candidates.length > 10) fail('INVALID_ARGS', 'Control at most 10 devices at once; narrow the room or device type.');
    candidates.forEach(function (device) {
      if (!supports(device, values)) fail('INVALID_ARGS', device.name + ' does not support this control.');
      if (Object.keys(values).length && !device.reachable) fail('PLUGIN_UNAVAILABLE', device.name + ' is unreachable. No controls were sent.');
    });
    return candidates;
  }
  function controlValues(action, args) {
    switch (action) {
      case 'turn_on': return { power: true };
      case 'turn_off': return { power: false };
      case 'set_brightness': return { brightness: numeric(args, 'brightness', 0, 100) };
      case 'set_color': return { hue: numeric(args, 'hue', 0, 360), saturation: numeric(args, 'saturation', 0, 100) };
      case 'set_color_temperature':
        if (has(args, 'kelvin') === has(args, 'mireds')) fail('INVALID_ARGS', 'Provide exactly one of kelvin or mireds.');
        return { color_temperature: has(args, 'kelvin') ? Math.round(1000000 / numeric(args, 'kelvin', 1, 1000000)) : numeric(args, 'mireds', 1, 1000000) };
      case 'set_volume': return { volume: numeric(args, 'volume', 0, 100) };
      case 'set_muted':
        if (typeof args.muted !== 'boolean') fail('INVALID_ARGS', 'muted must be a boolean.');
        return { muted: args.muted };
      case 'media_control':
        if (['play', 'pause', 'stop'].indexOf(args.command) < 0) fail('INVALID_ARGS', 'command must be play, pause, or stop.');
        return { media_state: args.command };
      case 'lock': return { locked: true };
      case 'unlock': return { locked: false };
      case 'set_fan_speed': return { fan_speed: numeric(args, 'speed', 0, 100) };
      case 'set_thermostat': {
        var values = {};
        if (has(args, 'temperature')) {
          if (args.unit !== 'celsius' && args.unit !== 'fahrenheit') fail('INVALID_ARGS', 'Provide unit=celsius or fahrenheit with temperature.');
          values.target_temperature = numeric(args, 'temperature', -100, 212);
        } else if (has(args, 'unit')) fail('INVALID_ARGS', 'unit requires temperature.');
        if (has(args, 'mode')) {
          if (['off', 'heat', 'cool', 'auto'].indexOf(args.mode) < 0) fail('INVALID_ARGS', 'Unsupported thermostat mode.');
          values.thermostat_mode = args.mode;
        }
        if (!Object.keys(values).length) fail('INVALID_ARGS', 'Provide temperature or mode.');
        return values;
      }
      default: fail('INVALID_REQUEST', 'Unknown Apple Home action.');
    }
  }
  function controlSummary(action, args, names) {
    switch (action) {
      case 'turn_on': return 'Turned on ' + names + '.';
      case 'turn_off': return 'Turned off ' + names + '.';
      case 'lock': return 'Locked ' + names + '.';
      case 'unlock': return 'Unlocked ' + names + '.';
      case 'set_brightness': return 'Set ' + names + ' brightness to ' + args.brightness + '%.';
      case 'set_color': return 'Set ' + names + ' color to hue ' + args.hue + '° and ' + args.saturation + '% saturation.';
      case 'set_color_temperature':
        return 'Set ' + names + ' color temperature to ' + (has(args, 'kelvin') ? args.kelvin + ' K' : args.mireds + ' mireds') + '.';
      case 'set_fan_speed': return 'Set ' + names + ' fan speed to ' + args.speed + '%.';
      case 'set_volume': return 'Set ' + names + ' volume to ' + args.volume + '%.';
      case 'set_muted': return (args.muted ? 'Muted ' : 'Unmuted ') + names + '.';
      case 'media_control':
        return { play: 'Started', pause: 'Paused', stop: 'Stopped' }[args.command] + ' playback on ' + names + '.';
      case 'set_thermostat': {
        var setting = has(args, 'temperature') ? args.temperature + (args.unit === 'fahrenheit' ? '°F' : '°C') : '';
        if (has(args, 'mode')) setting += (setting ? ' in ' : '') + args.mode + ' mode';
        return 'Set ' + names + ' to ' + setting + '.';
      }
      default: fail('INVALID_REQUEST', 'Unknown Apple Home action.');
    }
  }
  var parameters = {
    turn_on: [], turn_off: [], set_brightness: ['brightness'], set_color: ['hue', 'saturation'],
    set_color_temperature: ['mireds', 'kelvin'],
    set_volume: ['volume'], set_muted: ['muted'], media_control: ['command'], lock: [], unlock: [], set_fan_speed: ['speed'], set_thermostat: ['temperature', 'unit', 'mode'],
    get_state: [], run_scene: ['scene', 'instanceId', 'home'],
  };
  var selectors = ['instanceId', 'device', 'room', 'home', 'device_type', 'all'];
  Pebble.registerSourceHandler(async function (request, respond) {
    try {
      if (sourceKeys.indexOf(request.category + '/' + request.item) < 0) fail('INVALID_REQUEST', 'Unknown Apple Home source.');
      var catalogue = await structure();
      var instances;
      if (request.item === 'home') instances = [{ instanceId: catalogue.home.id, properties: { name: text(catalogue.home.name) } }];
      if (request.item === 'room') instances = catalogue.rooms.map(function (room) {
        return { instanceId: room.id, properties: { name: text(room.name), home: text(catalogue.home.name) } };
      });
      if (request.item === 'device') instances = catalogue.devices.map(function (device) {
        var properties = {
          name: text(device.name), accessory: text(device.accessoryName), room: text(device.room), home: text(catalogue.home.name),
          type: text(device.type), online: bool(device.reachable), capabilities: detail(device.capabilities),
          cached_state: detail(device.cachedState), freshness: text(device.stateFreshness),
        };
        var state = device.cachedState || {};
        [['power', 'on'], ['muted', 'muted']].forEach(function (pair) {
          if (typeof state[pair[0]] === 'boolean') properties[pair[1]] = bool(state[pair[0]]);
        });
        [['brightness', 'brightness', '%'], ['volume', 'volume', '%'], ['fan_speed', 'fan_speed', '%'],
          ['current_temperature', 'ambient_temperature', '°C'], ['target_temperature', 'setpoint', '°C'],
          ['humidity', 'humidity', '%'], ['battery_level', 'battery', '%']].forEach(function (row) {
          if (typeof state[row[0]] === 'number') properties[row[1]] = number(state[row[0]], row[2]);
        });
        if (state.color_temperature > 0) properties.color_temperature = number(Math.round(1000000 / state.color_temperature), 'K');
        if (state.thermostat_mode) properties.thermostat_mode = text(state.thermostat_mode);
        if (state.current_media_state) properties.media_state = text(state.current_media_state);
        if (state.lock_state === 0 || state.lock_state === 1) properties.locked = bool(state.lock_state === 1);
        return { instanceId: device.id, properties: properties };
      });
      if (request.item === 'scene' || request.item === 'automation') {
        var automations = request.item === 'automation' ? catalogue.automations || catalogue.scenes : catalogue.scenes;
        instances = automations.map(function (scene) {
          var properties = { name: text(scene.name), home: text(catalogue.home.name), kind: text(scene.kind || 'scene'),
            runnable: bool(scene.runnable), manually_runnable: bool(scene.runnable), blocked_reason: text(scene.blockedReason || ''),
            starters: detail(scene.starters || [{ type: 'manual' }]), actions: detail(scene.actions || []) };
          if (typeof scene.enabled === 'boolean') properties.enabled = bool(scene.enabled);
          if (scene.kind === 'trigger') properties.trigger_details = detail({ scenes: scene.scenes || [],
            hasConditions: scene.hasConditions, endEventCount: scene.endEventCount, executeOnce: scene.executeOnce });
          return { instanceId: scene.id, properties: properties };
        });
      }
      respond.data({ validUntilMs: Date.now() + 30000, instances: instances });
    } catch (error) { errorReply(respond, error, 'Reading ' + (request && request.category) + '/' + (request && request.item)); }
  });
  Pebble.registerActionHandler(async function (request, respond) {
    try {
      var action = request.action === 'run_automation' ? 'run_scene' : request.action;
      if (!has(parameters, action)) fail('INVALID_REQUEST', 'Unknown Apple Home action.');
      var args = aliases(action, request.args || {});
      keys(args, action === 'run_scene' ? parameters[action] : selectors.concat(parameters[action]));
      var values = action === 'get_state' || action === 'run_scene' ? {} : controlValues(action, args);
      var catalogue = await structure();
      if (action === 'run_scene') {
        checkHome(catalogue, args);
        ['scene', 'instanceId'].forEach(function (key) { nonempty(args, key); });
        if (!!args.scene === !!args.instanceId) fail('INVALID_ARGS', 'Provide exactly one scene name or instanceId.');
        var candidates = request.action === 'run_automation' ? catalogue.automations || catalogue.scenes : catalogue.scenes;
        var scenes = candidates.filter(function (scene) {
          return args.instanceId ? normalized(scene.id) === normalized(args.instanceId) : normalized(scene.name) === normalized(args.scene);
        });
        if (scenes.length !== 1) fail('INVALID_ARGS', 'Scene or automation is missing or ambiguous; use an instanceId from home/' + (request.action === 'run_automation' ? 'automation' : 'scene') + '.');
        if (!scenes[0].runnable) fail('PERMISSION_DENIED', scenes[0].blockedReason || 'This scene contains unsupported controls.');
        var sceneResult = await native('runScene', { sceneId: scenes[0].id });
        if (!sceneResult.ok) fail(sceneResult.code || 'PLUGIN_UNAVAILABLE', sceneResult.message || 'Scene execution was not confirmed.');
        respond.ok({ text: 'Ran ' + scenes[0].name + '.', data: sceneResult, refreshed: ['home/device'] });
        return;
      }
      if ((action === 'lock' || action === 'unlock') && args.all === true) fail('INVALID_ARGS', 'Choose one lock by exact name or instanceId.');
      var targets = devices(catalogue, args, values);
      if (action === 'get_state') {
        var state = await native('getState', { deviceId: targets[0].id });
        respond.ok({ text: 'Read ' + targets[0].name + '. Unavailable readings are not current state.', data: state });
        return;
      }
      var successText = controlSummary(action, args, targets.map(function (device) { return device.name; }).join(', '));
      var requests = targets.map(function (device) { return { deviceId: device.id, values: values, temperatureUnit: args.unit || 'celsius' }; });
      for (var i = 0; i < requests.length; i++) await native('validateControl', requests[i]);
      var results = [];
      for (var j = 0; j < requests.length; j++) {
        var result;
        try { result = await native('control', requests[j]); }
        catch (error) {
          fail(error.code || 'PLUGIN_UNAVAILABLE', (error.message || 'Control failed') + ' ' + results.length + ' device(s) confirmed; remaining devices were not attempted. Read state before retrying.');
        }
        if (!result.ok) fail(result.code || 'PLUGIN_UNAVAILABLE', (result.message || 'Control was not confirmed.') + ' ' + results.length + ' earlier device(s) confirmed; remaining devices were not attempted.');
        results.push(result);
      }
      respond.ok({ text: successText,
        data: { devices: results }, refreshed: ['home/device'] });
    } catch (error) { errorReply(respond, error, request && request.action); }
  });
  Pebble.registerConfigHandler(async function (message, respond) {
    try {
      if (!message || ['status', 'requestAccess', 'homes', 'selectHome', 'disconnect', 'structure'].indexOf(message.type) < 0) fail('INVALID_REQUEST', 'Unknown configuration request.');
      var result = await native(message.type, message.type === 'selectHome' ? { homeId: message.homeId } : {});
      if (message.type === 'selectHome' || message.type === 'disconnect') Pebble.refreshSources(sourceKeys);
      respond(result);
    } catch (error) {
      console.error('Config ' + (message && message.type) + ' failed: ' + (error.code || 'PLUGIN_UNAVAILABLE'));
      respond({ error: error.message || 'Apple Home setup failed.', code: error.code || 'PLUGIN_UNAVAILABLE' });
    }
  });
})();
