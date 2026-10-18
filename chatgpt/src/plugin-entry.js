'use strict';

require('./text-encoder');
var PluginError = require('./util').PluginError;
var createDotsService = require('./dots').createDotsService;
var createCodexAuth = require('./codex-auth').createCodexAuth;
var createCodexRemote = require('./codex-remote').createCodexRemote;
var createCodexCloud = require('./codex-cloud').createCodexCloud;
var createCodexChats = require('./codex-chats').createCodexChats;

function createPlugin(storage, fetch, now, WebSocketImpl) {
  var dots = createDotsService(storage, fetch, now);
  var auth = createCodexAuth(storage, fetch, now);
  var remote = createCodexRemote(storage, fetch, now, WebSocketImpl, auth);
  var cloud = createCodexCloud(fetch, auth);
  var chats = createCodexChats(storage, remote, cloud);

  async function codexStatus() {
    var account = await auth.load();
    var connected = await remote.load();
    return {
      signedIn: !!account,
      email: account ? account.email : '',
      remoteControl: !!connected,
      paired: !!(connected && connected.paired),
    };
  }

  async function status() {
    return { dots: await dots.status(), codex: await codexStatus() };
  }

  async function config(message) {
    switch (message && message.type) {
      case 'status':
        return status();
      case 'dots_connect':
        await dots.connect(message.session_token);
        return status();
      case 'dots_disconnect':
        await dots.disconnect();
        return status();
      case 'codex_connect':
        await auth.connect(message.session_token);
        return status();
      case 'codex_enroll_begin':
        return auth.beginEnroll(message.entropy);
      case 'codex_enroll_finish': {
        var finished = await auth.finishEnroll(message.url);
        await remote.enroll(finished.stepUpToken, finished.seed);
        return status();
      }
      case 'codex_chats': {
        var found = await chats.list();
        return {
          chats: found.chats,
          errors: found.errors.map(function (e) { return (e.part === 'cloud' ? 'Codex Cloud: ' : 'Computers: ') + safeError(e.error).message; }),
        };
      }
      case 'codex_chat_save':
        await chats.update(message.chat, message.nickname, !!message.makeDefault);
        return { ok: true };
      case 'codex_pair':
        return { computers: await remote.pair(message.code) };
      case 'codex_computers':
        return { computers: await remote.computers() };
      case 'codex_disconnect':
        await remote.disconnect();
        await auth.signOut();
        return status();
      default:
        throw PluginError('INVALID_ARGS', 'Unknown settings request.');
    }
  }

  var actions = {
    send_to_dot: dots.send,
    send_to_codex: chats.send,
    list_codex_chats: listChats,
    start_codex_cloud_task: cloud.create,
  };

  /** One line per chat, most recent first, with what send_to_codex takes to reach it. */
  async function listChats(args) {
    var found = await chats.list(args);
    var lines = found.chats.slice(0, 15).map(function (chat) {
      var name = chat.nickname ? chat.nickname + ' = "' + chat.label.slice(0, 60) + '"' : '"' + chat.label.slice(0, 60) + '"';
      return name + ' (' + chats.where(chat) + ', ' + chat.state + (chat.isDefault ? ', default' : '') + ', chat ' + chat.id + ')';
    });
    if (!found.chats.length) lines.push('No Codex chats found.');
    found.errors.forEach(function (e) {
      lines.push((e.part === 'cloud' ? 'Codex Cloud: ' : 'Computers: ') + safeError(e.error).message);
    });
    return { text: lines.join('\n') };
  }

  async function action(request) {
    var handler = request && actions[request.action];
    if (!handler) throw PluginError('INVALID_ARGS', 'Unknown action.');
    return handler(request.args || {});
  }

  return { config: config, action: action, source: dots.source };
}

/** Never forward responses, tokens or exception text from ChatGPT or Codex. */
function safeError(error) {
  if (error && error.code) return { code: error.code, message: error.message };
  return {
    code: 'PLUGIN_UNAVAILABLE',
    message: 'Could not reach ChatGPT. If sending, delivery may be uncertain; check before trying again.',
  };
}

if (typeof Pebble !== 'undefined') {
  var plugin = createPlugin(Pebble.secureStorage, fetch, Date.now, WebSocket);

  Pebble.registerActionHandler(function (request, response) {
    plugin.action(request).then(response.ok, function (error) {
      var safe = safeError(error);
      response.error(safe.code, safe.message);
    });
  });

  Pebble.registerSourceHandler(function (request, respond) {
    plugin.source(request).then(respond.data, function (error) {
      var safe = safeError(error);
      respond.error(safe.code, safe.message);
    });
  });

  Pebble.registerConfigHandler(function (message, respond) {
    plugin.config(message).then(respond, function (error) {
      respond({ error: safeError(error).message });
    });
  });
}

module.exports = { createPlugin: createPlugin, safeError: safeError };
