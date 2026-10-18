'use strict';

var util = require('./util');
var PluginError = util.PluginError;

var PREFS_KEY = 'chatgpt.codex.chats.v1';
var MAX_NICKNAME = 40;

function keyOf(chat) {
  return chat.kind + ':' + chat.id;
}

function where(chat) {
  return chat.kind === 'task' ? 'Codex Cloud' : chat.computer;
}

/**
 * The user's Codex chats in one list (live sessions on their computers and Codex Cloud tasks),
 * with the nicknames and default chat they picked in settings.
 */
function createCodexChats(storage, remote, cloud) {
  async function prefs() {
    var raw = await storage.getItem(PREFS_KEY);
    var saved = raw ? JSON.parse(raw) : null;
    return { defaultChat: saved && saved.defaultChat || null, nicknames: saved && saved.nicknames || {} };
  }

  function savePrefs(value) {
    return storage.setItem(PREFS_KEY, JSON.stringify(value));
  }

  /** Every reachable chat, most recent first; [errors] says which half couldn't be listed. */
  async function list(args) {
    var saved = await prefs();
    var chats = [];
    var errors = [];
    try {
      chats = chats.concat(await remote.chats(args));
    } catch (error) {
      errors.push({ part: 'computers', error: error });
    }
    if (!args || !args.computer) {
      try {
        chats = chats.concat((await cloud.tasks()).map(function (task) {
          return { kind: 'task', id: task.id, label: task.title.slice(0, 80), state: 'cloud', updatedAt: task.updatedAt };
        }));
      } catch (error) {
        errors.push({ part: 'cloud', error: error });
      }
    }
    var defaultKey = saved.defaultChat && keyOf(saved.defaultChat);
    chats.forEach(function (chat) {
      var nick = saved.nicknames[keyOf(chat)];
      chat.nickname = nick ? nick.nickname : '';
      chat.isDefault = keyOf(chat) === defaultKey;
    });
    chats.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return { chats: chats, errors: errors };
  }

  /** Saves [nickname] (empty clears it) and, when [makeDefault], the chat as the default. */
  async function update(chat, nickname, makeDefault) {
    if (!chat || (chat.kind !== 'session' && chat.kind !== 'task') || typeof chat.id !== 'string' || !chat.id) {
      throw PluginError('INVALID_ARGS', 'Pick a Codex chat first.');
    }
    var name = typeof nickname === 'string' ? nickname.trim().slice(0, MAX_NICKNAME) : '';
    var saved = await prefs();
    var entry = { kind: chat.kind, id: chat.id, computer: chat.computer || '', label: String(chat.label || '').slice(0, 80) };
    Object.keys(saved.nicknames).forEach(function (key) {
      // A nickname names one chat; giving it to another moves it.
      if (name && key !== keyOf(entry) && saved.nicknames[key].nickname.toLowerCase() === name.toLowerCase()) {
        delete saved.nicknames[key];
      }
    });
    if (name) saved.nicknames[keyOf(entry)] = Object.assign({ nickname: name }, entry);
    else delete saved.nicknames[keyOf(entry)];
    if (makeDefault) saved.defaultChat = entry;
    await savePrefs(saved);
    return saved;
  }

  /** The chat [query] names (a nickname first, then an id or title), or the default chat. */
  async function resolve(query) {
    var saved = await prefs();
    var wanted = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!wanted) {
      if (saved.defaultChat) return saved.defaultChat;
      throw PluginError('INVALID_ARGS', 'No default Codex chat yet. Pick one in plugin settings, or name the chat.');
    }
    var nicknamed = Object.keys(saved.nicknames).map(function (key) { return saved.nicknames[key]; });
    var exact = nicknamed.filter(function (n) { return n.nickname.toLowerCase() === wanted; });
    if (exact.length === 1) return exact[0];
    var partial = nicknamed.filter(function (n) { return n.nickname.toLowerCase().indexOf(wanted) >= 0; });
    if (partial.length === 1) return partial[0];
    var found = await list();
    return util.pick(found.chats, query, function (chat) { return chat.nickname || chat.label; }, 'Codex chat');
  }

  async function send(args) {
    var text = args && args.message;
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) {
      throw PluginError('INVALID_ARGS', 'Provide a message between 1 and 16,000 characters.');
    }
    var chat = await resolve(args.chat);
    if (chat.kind === 'task') return cloud.followUp({ message: text, task: chat.id });
    return remote.send({ message: text, session: chat.id, computer: chat.computer });
  }

  return { list: list, update: update, resolve: resolve, send: send, prefs: prefs, keyOf: keyOf, where: where };
}

module.exports = { createCodexChats: createCodexChats };
