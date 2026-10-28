'use strict';

var util = require('./util');
var PluginError = util.PluginError;

var PREFS_KEY = 'chatgpt.codex.chats.v1';
var CACHE_KEY = 'chatgpt.codex.chats.cache.v1';
var MAX_NICKNAME = 40;

function keyOf(chat) {
  return chat.kind + ':' + chat.id;
}

/**
 * The user's Codex and ChatGPT chats in one list (live sessions on their computers, Codex Cloud tasks
 * and chatgpt.com conversations),
 * with the nicknames they gave them in settings.
 */
function accountKey(a) {
  return a ? a.account + ':' + a.user : null;
}

function sameAccount(a, b) {
  return !!a && !!b && a.account === b.account && a.user === b.user;
}

/** [auth] tags the cache with the Codex account: settings and requests run in separate sessions. */
function createCodexChats(storage, remote, cloud, chatgpt, auth, now) {
  // Within one session, an older listing finishing last doesn't overwrite a newer one.
  var started = 0;
  var landed = 0;

  async function stored() {
    var raw = await storage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  }

  /** The signed-in Codex account's default chat and nicknames, and the no-chat destination. */
  async function prefs() {
    var saved = await stored();
    var key = accountKey(await auth.load());
    if (key && !saved.accounts && (saved.defaultChat || saved.nicknames)) {
      // v0.2.0 prefs had no account: they belong to the first account that reads them.
      var accounts = {};
      accounts[key] = { defaultChat: saved.defaultChat || null, nicknames: saved.nicknames || {} };
      saved = { destination: saved.destination || null, accounts: accounts };
      try { await storage.setItem(PREFS_KEY, JSON.stringify(saved)); } catch (_) { /* adopted again next read */ }
    }
    var mine = key && saved.accounts && saved.accounts[key] || {};
    return { defaultChat: mine.defaultChat || null, nicknames: mine.nicknames || {}, destination: saved.destination || null };
  }

  async function savePrefs(value) {
    var saved = await stored();
    var key = accountKey(await auth.load());
    var next = Object.assign({}, saved, { destination: value.destination || null });
    if (key) {
      next.accounts = Object.assign({}, saved.accounts);
      next.accounts[key] = { defaultChat: value.defaultChat || null, nicknames: value.nicknames };
      delete next.defaultChat;
      delete next.nicknames;
    }
    return storage.setItem(PREFS_KEY, JSON.stringify(next));
  }

  /** [chats] with their current nicknames, most recent first. */
  async function named(chats) {
    var saved = await prefs();
    var defaultKey = saved.defaultChat && keyOf(saved.defaultChat);
    chats.forEach(function (chat) {
      var nick = saved.nicknames[keyOf(chat)];
      chat.nickname = nick ? nick.nickname : '';
      chat.isDefault = keyOf(chat) === defaultKey;
    });
    return chats.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  /** The signed-in account's last list that reached at least one half, as { chats, at }, or null. */
  async function cached() {
    try {
      var raw = await storage.getItem(CACHE_KEY);
      var entry = raw ? JSON.parse(raw) : null;
      if (!entry || !sameAccount(entry, await auth.load())) return null;
      return { chats: await named(entry.chats), at: entry.at };
    } catch (_) {
      return null;
    }
  }

  async function remember(owner, seq, chats) {
    try {
      // Dropped if another session signed out or switched account while this list was fetched.
      if (seq <= landed || !sameAccount(owner, await auth.load())) return;
      landed = seq;
      await storage.setItem(CACHE_KEY, JSON.stringify({ account: owner.account, user: owner.user, at: now(), chats: chats }));
    } catch (_) { /* The cache is best-effort. */ }
  }

  /** Every reachable chat, most recent first; [errors] says which part couldn't be listed. */
  async function list() {
    var seq = ++started;
    var owner = null;
    try { owner = await auth.load(); } catch (_) { /* then nothing is cached */ }
    var errors = [];
    function part(name, promise) {
      return promise.catch(function (error) {
        console.error('Listing Codex ' + name + ' chats failed: ' + ((error && error.code) || (error && error.name) || error));
        errors.push({ part: name, error: error });
        return [];
      });
    }
    var halves = await Promise.all([
      part('computers', remote.chats()),
      part('cloud', cloud.tasks().then(function (tasks) {
        return tasks.map(function (task) {
          return { kind: 'task', id: task.id, label: task.title.slice(0, 80), state: 'cloud', updatedAt: task.updatedAt };
        });
      })),
      part('chatgpt', chatgpt.list()),
    ]);
    var chats = halves[0].concat(halves[1], halves[2]);
    if (errors.length < halves.length) await remember(owner, seq, chats);
    return { chats: await named(chats), errors: errors };
  }

  /** Saves [nickname] (empty clears it, undefined leaves it) and, when [makeDefault], the chat as the default. */
  async function update(chat, nickname, makeDefault) {
    if (!chat || (chat.kind !== 'session' && chat.kind !== 'task' && chat.kind !== 'chat') || typeof chat.id !== 'string' || !chat.id) {
      throw PluginError('INVALID_ARGS', 'Pick a Codex chat first.');
    }
    var name = typeof nickname === 'string' ? nickname.trim().slice(0, MAX_NICKNAME) : '';
    var saved = await prefs();
    var entry = { kind: chat.kind, id: chat.id, computer: chat.computer || '', label: String(chat.label || '').slice(0, 80) };
    if (nickname !== undefined) {
      Object.keys(saved.nicknames).forEach(function (key) {
        // A nickname names one chat; giving it to another moves it.
        if (name && key !== keyOf(entry) && saved.nicknames[key].nickname.toLowerCase() === name.toLowerCase()) {
          delete saved.nicknames[key];
        }
      });
      if (name) saved.nicknames[keyOf(entry)] = Object.assign({ nickname: name }, entry);
      else delete saved.nicknames[keyOf(entry)];
    }
    if (makeDefault) saved.defaultChat = entry;
    await savePrefs(saved);
    return saved;
  }

  /** The chat [query] names: an id (cached, then freshly listed) first, then a nickname, then a title. */
  async function resolve(query) {
    var saved = await prefs();
    var wanted = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!wanted) throw PluginError('INVALID_ARGS', 'Name the Codex chat.');
    var nicknamed = Object.keys(saved.nicknames).map(function (key) { return saved.nicknames[key]; });
    function byId(chats) {
      return chats.filter(function (c) { return c.id.toLowerCase() === wanted; })[0];
    }
    var known = byId(nicknamed.concat((await cached() || { chats: [] }).chats));
    if (known) return known;
    var found = await list();
    var listed = byId(found.chats);
    if (listed) return listed;
    var exact = nicknamed.filter(function (n) { return n.nickname.toLowerCase() === wanted; });
    if (exact.length === 1) return exact[0];
    var partial = nicknamed.filter(function (n) { return n.nickname.toLowerCase().indexOf(wanted) >= 0; });
    if (partial.length === 1) return partial[0];
    return util.pick(found.chats, query, function (chat) { return chat.nickname || chat.label; }, 'Codex chat');
  }

  async function send(args) {
    var text = args && args.message;
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) {
      throw PluginError('INVALID_ARGS', 'Provide a message between 1 and 16,000 characters.');
    }
    return deliver(await resolve(args.chat), text);
  }

  function deliver(chat, text) {
    if (chat.kind === 'task') return cloud.followUp({ message: text, task: chat.id });
    if (chat.kind === 'chat') return chatgpt.send({ message: text, conversation: chat.id, title: chat.nickname || chat.label });
    return remote.send({ message: text, session: chat.id, computer: chat.computer });
  }

  /** Where a send with no chat named goes when both are possible: 'dot' or 'codex'. */
  async function setDestination(value) {
    if (value !== 'dot' && value !== 'codex') throw PluginError('INVALID_ARGS', 'Choose the Dot or the Codex default chat.');
    var saved = await prefs();
    saved.destination = value;
    await savePrefs(saved);
  }

  async function forget() {
    try {
      await storage.removeItem(CACHE_KEY);
    } catch (_) { /* The cache is best-effort. */ }
  }

  return {
    list: list, cached: cached, forget: forget, update: update, resolve: resolve, send: send, deliver: deliver,
    setDestination: setDestination, prefs: prefs, keyOf: keyOf,
  };
}

module.exports = { createCodexChats: createCodexChats };
