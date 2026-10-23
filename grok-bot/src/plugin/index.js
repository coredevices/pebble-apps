// Grok Bot plugin. Talks to the user's Grok Bot computer over the same private HTTPS API the
// Grok Bot apps use: a Cursor access token (from the native sign-in) asks Cursor's backend where
// the user's box is, then each call is `POST {gatewayUrl}/api/<method>` on that box.
// Unofficial and undocumented: method names and shapes come from the Grok Bot client.

var KEY = "grokbot.connection.v1";
// Last bot list for agent/chats, in plain storage: it isn't secret and must never fail a request.
var BOTS_KEY = "grokbot.bots.v1";
var BOTS_TTL_MS = 5 * 60 * 1000;
var POLL_URL = "https://api2.cursor.sh/auth/poll";
var ENSURE_URL = "https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox";
var BOX_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.cursorvm\.com$/i;
var MAX_MESSAGE = 16000;
var MAX_NICKNAME = 40;
// Whole-request budgets, under the host's limits (120s per send action, 60s per read).
var SEND_BUDGET_MS = 18000;
var READ_BUDGET_MS = 18000;
// Below this much time left, a send is refused rather than risk an unknown delivery.
var SEND_MIN_LEFT_MS = 8000;
var SIGN_IN_POLL_MS = 15000;

class PluginError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

var timers = new Map();
globalThis.__hostTimerDispatch = function (id) {
  var callback = timers.get(id);
  timers.delete(id);
  if (callback) callback();
};
// Stock CoreApp gives plugins no timers: Android blocks setTimeout and iOS has none.
var hasTimer = typeof _HostTimer !== "undefined";

/** Without a host timer this doesn't wait, so callers poll back to back. */
function sleep(ms) {
  if (!hasTimer) return Promise.resolve();
  return new Promise(function (resolve) { timers.set(_HostTimer.schedule(ms), resolve); });
}

/**
 * The host's fetch has no timeout or AbortSignal, so race it against the request's deadline. With
 * no host timer the host's own action limit bounds the request instead.
 */
function within(deadline, promise) {
  var left = deadline - Date.now();
  var late = new PluginError("PLUGIN_UNAVAILABLE", "Grok Bot took too long to respond. Try again shortly.");
  if (left <= 0) return Promise.reject(late);
  if (!hasTimer) return promise;
  return Promise.race([promise, sleep(left).then(function () { throw late; })]);
}

function nonce() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function cleanHeaders(raw) {
  var out = {};
  if (!raw || typeof raw !== "object") return out;
  Object.keys(raw).forEach(function (name) {
    var value = raw[name];
    if (/^[a-z0-9-]{1,64}$/i.test(name) && typeof value === "string" && value && !/[\r\n]/.test(value))
      out[name.toLowerCase()] = value;
  });
  return out;
}

var BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The Cursor user a token belongs to (its JWT `sub`), or null when it isn't a readable JWT. */
function tokenUser(token) {
  var part = String(token).split(".")[1];
  if (!part) return null;
  var bits = 0, value = 0, text = "";
  for (var i = 0; i < part.length; i++) {
    var c = BASE64URL.indexOf(part[i]);
    if (c < 0) return null;
    value = ((value << 6) | c) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      text += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  try {
    var sub = JSON.parse(text).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch (e) {
    return null;
  }
}

/** Text of a bot reply, or null for anything else in the transcript (prompts, tool calls...). */
function replyText(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.kind === "send-message") {
    var m = entry.message;
    var text = m && typeof m === "object" ? m.content : entry.text;
    return typeof text === "string" && text ? text : null;
  }
  if (entry.role === "assistant" && typeof (entry.text || entry.content) === "string") return entry.text || entry.content;
  return null;
}






function createService(storage, fetch, cache) {
  function load() {
    var raw = storage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  }
  function save(value) {
    storage.setItem(KEY, JSON.stringify(value));
  }
  function required() {
    var state = load();
    if (!state) throw new PluginError("AUTH_REQUIRED", "Sign in to Grok Bot in plugin settings.");
    return state;
  }

  // Cache entries belong to one sign-in; connections saved before 0.2.0 have no signIn id.
  function account(state) {
    return state.signIn || "legacy";
  }
  function readCache() {
    try {
      return JSON.parse(cache.getItem(BOTS_KEY));
    } catch (e) {
      return null;
    }
  }
  function cachedBots(state) {
    var entry = readCache();
    return entry && entry.account === account(state) && Array.isArray(entry.bots) ? entry : null;
  }
  /**
   * Drops a list fetched for a sign-in that has since changed (checked against persisted storage,
   * since another session may have signed in again), or older than the cached one.
   */
  async function cacheBots(tag, listedAt, list) {
    try {
      var raw = storage.persisted ? await storage.persisted(KEY) : storage.getItem(KEY);
      if (!raw || account(JSON.parse(raw)) !== tag) return;
      var entry = readCache();
      if (entry && entry.account === tag && entry.listedAt > listedAt) return;
      cache.setItem(BOTS_KEY, JSON.stringify({ account: tag, listedAt: listedAt, bots: list }));
    } catch (e) {}
  }
  function clearBots() {
    try {
      cache.removeItem(BOTS_KEY);
    } catch (e) {}
  }

  async function post(url, headers, body, deadline) {
    var text, response;
    await within(deadline, (async function () {
      response = await fetch(url, { method: "POST", headers: headers, body: JSON.stringify(body || {}) });
      text = await response.text();
    })());
    if (!response.ok) throw new PluginError("HTTP", "HTTP " + response.status, response.status);
    try {
      return text ? JSON.parse(text) : {};
    } catch (e) {
      throw new PluginError("PLUGIN_UNAVAILABLE", "Grok Bot sent an unreadable response.");
    }
  }

  // ponytail: looks the box up on every request (one extra call, survives box moves and token
  // rotation); cache it in storage if that latency matters.
  async function box(accessToken, deadline) {
    var body = await post(ENSURE_URL, {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: "Bearer " + accessToken,
      "x-cursor-client-type": "sand",
      "x-cursor-client-version": "0.20.0",
      "x-sand-box-namespace": "prod",
    }, {}, deadline);
    var url = String(body.gatewayUrl || body.gateway_url || "").replace(/\/$/, "");
    var token = body.gatewayToken || body.gateway_token;
    if (!BOX_URL.test(url) || typeof token !== "string" || !token || /[\r\n]/.test(token))
      throw new PluginError("PLUGIN_UNAVAILABLE", "Your Grok Bot computer is not available. Open Grok Bot to check your plan.");
    var headers = cleanHeaders(body.gatewayHeaders || body.gateway_headers);
    var network = body.anyrunNetworkToken || body.anyrun_network_token || body.networkToken;
    if (!Object.keys(headers).length && typeof network === "string") headers = cleanHeaders({ "x-anyrun-network-token": network });
    headers["content-type"] = "application/json";
    headers.authorization = "Bearer " + token;
    var call = function (method, args) {
      return post(url + "/api/" + method, headers, args, deadline);
    };
    call.host = url.slice("https://".length).toLowerCase();
    return call;
  }

  /** Lists the account's bots, caching them for agent/chats when given the connection. */
  async function bots(call, state) {
    var listedAt = Date.now();
    var data = await call("listAgents", {});
    var raw = Array.isArray(data) ? data : Array.isArray(data.agents) ? data.agents : [];
    var list = raw
      .filter(function (a) { return a && (a.id || a.agentId); })
      .map(function (a) {
        var members = a.memberIds || a.memberAgentIds || [];
        return {
          id: String(a.id || a.agentId),
          name: a.name || a.title || "Untitled bot",
          group: a.isGroup === true || (a.isGroup == null && members.length > 0),
        };
      });
    if (state) await cacheBots(account(state), listedAt, list);
    return list;
  }

  async function tail(call, botId) {
    var data = await call("getAgentTranscriptTail", { id: botId, limit: 60 });
    return Array.isArray(data && data.entries) ? data.entries : [];
  }

  /** The host's own record of our send: its status and the transcript entry it became. */

  /** The host's own record of our send, or null when it can't say. */
  async function acceptance(call, clientNonce) {
    var data = await call("promptAcceptanceStatus", { accountSlot: "host", clientNonce: clientNonce });
    var record = data && (data.record || data);
    return record && typeof record === "object" ? record : null;
  }

  async function selectedBot(call, state) {
    var all = await bots(call, state);
    var bot = all.find(function (b) { return b.id === state.botId; });
    if (!bot) throw new PluginError("INVALID_ARGS", "The selected Grok Bot is unavailable. Choose a bot in plugin settings.");
    return bot;
  }

  function nickname(state, id) {
    return (state && state.nicknames && state.nicknames[id]) || "";
  }
  /** What the user calls a bot: its nickname when set, else its name. */
  function spoken(state, bot) {
    return nickname(state, bot.id) || bot.name;
  }

  /**
   * chat_id is a bot id from agent/chats, a nickname or a bot name: exact id, then exact nickname,
   * then exact name, then a unique partial nickname or name. With none, the bot chosen in settings.
   */
  async function targetBot(call, state, chatId) {
    if (chatId !== undefined && chatId !== null && typeof chatId !== "string")
      throw new PluginError("INVALID_ARGS", "Name a Grok Bot.");
    var query = (chatId || "").trim().toLowerCase();
    if (!query) return selectedBot(call, state);
    var all = await bots(call, state);
    var byId = all.find(function (b) { return b.id === chatId.trim(); });
    if (byId) return byId;
    var is = function (text) { return text.toLowerCase() === query; };
    var has = function (text) { return text.toLowerCase().indexOf(query) >= 0; };
    var byNickname = all.filter(function (b) { return is(nickname(state, b.id)); });
    var byName = all.filter(function (b) { return is(b.name); });
    // A bot renamed after the nickname was saved: refuse rather than guess.
    if (byNickname.length && byName.some(function (b) { return byNickname.indexOf(b) < 0; }))
      throw new PluginError("INVALID_ARGS", "“" + chatId.trim() + "” is both a nickname and another bot’s name. Rename one in settings, or use the bot’s id.");
    var matches = byNickname.length ? byNickname : byName.length ? byName
      : all.filter(function (b) { return has(nickname(state, b.id)) || has(b.name); });
    if (matches.length === 1) return matches[0];
    throw new PluginError("INVALID_ARGS", matches.length
      ? "Several Grok Bots match that name. Use the exact nickname, name or id."
      : "No Grok Bot matches that name. Choose one from agent/chats.");
  }

  /**
   * Gives bot [id] the nickname [name] (empty clears it). A nickname names one bot, so giving it to
   * another moves it; another bot's id or name is refused because those resolve first.
   */
  function setNickname(state, list, id, name) {
    if (typeof name !== "string" || name.trim().length > MAX_NICKNAME)
      throw new PluginError("INVALID_ARGS", "Use a nickname of at most " + MAX_NICKNAME + " characters.");
    name = name.trim();
    if (!list.some(function (b) { return b.id === id; }))
      throw new PluginError("INVALID_ARGS", "That bot is no longer available. Refresh the list and choose a bot.");
    var clash = list.find(function (b) {
      return b.id !== id && (b.id.toLowerCase() === name.toLowerCase() || b.name.toLowerCase() === name.toLowerCase());
    });
    if (name && clash)
      throw new PluginError("INVALID_ARGS", "“" + name + "” is already another bot’s name. Choose another nickname.");
    var names = state.nicknames || {};
    Object.keys(names).forEach(function (key) {
      if (name && names[key].toLowerCase() === name.toLowerCase()) delete names[key];
    });
    if (name) names[id] = name;
    else delete names[id];
    state.nicknames = names;
  }

  function settings(state, list) {
    if (!state) return { configured: false };
    return {
      configured: true,
      selected: state.botId,
      defaultName: state.botId ? nickname(state, state.botId) || state.botName || "" : "",
      signedInAt: state.signedInAt || null,
      bots: list ? list.map(function (b) {
        return { id: b.id, name: b.name, group: b.group, nickname: nickname(state, b.id) };
      }) : undefined,
    };
  }

  async function connectWith(token) {
    if (typeof token !== "string" || !token || token.length > 8192 || /[\r\n]/.test(token))
      throw new PluginError("AUTH_REQUIRED", "Grok Bot sign-in returned an invalid session. Please try again.");
    var call = await box(token, Date.now() + READ_BUDGET_MS);
    var list = await bots(call);
    var account = tokenUser(token) ? "user:" + tokenUser(token) : "box:" + call.host;
    var previous = load();
    // Default and nicknames belong to one account; untagged ones go to the first account to sign in.
    var previousUser = previous && tokenUser(previous.accessToken);
    var previousAccount = previous && (previous.account || (previousUser && "user:" + previousUser));
    if (previousAccount && previousAccount !== account) previous = null;
    var keep = previous && list.some(function (b) { return b.id === previous.botId; });
    var first = list.find(function (b) { return !b.group; }) || list[0];
    var bot = keep ? list.find(function (b) { return b.id === previous.botId; }) : first;
    var nicknames = {};
    if (previous && previous.nicknames)
      list.forEach(function (b) { if (previous.nicknames[b.id]) nicknames[b.id] = previous.nicknames[b.id]; });
    var state = { accessToken: token, account: account, signIn: nonce(), signedInAt: Date.now(), nicknames: nicknames,
      botId: bot ? bot.id : null, botName: bot ? bot.name : null };
    save(state);
    clearBots();
    await cacheBots(state.signIn, Date.now(), list);
    return settings(state, list);
  }

  /** Cursor's PKCE login: once the browser side finishes, the poll hands over the access token. */
  async function pollSignIn(uuid, verifier) {
    if (!/^[0-9a-f-]{36}$/i.test(String(uuid)) || !/^[A-Za-z0-9_-]{43,128}$/.test(String(verifier)))
      throw new PluginError("INVALID_ARGS", "Grok Bot sign-in was not started correctly. Please try again.");
    var url = POLL_URL + "?uuid=" + encodeURIComponent(uuid) + "&verifier=" + encodeURIComponent(verifier);
    var deadline = Date.now() + SIGN_IN_POLL_MS;
    while (Date.now() < deadline) {
      var response = await fetch(url, { method: "GET" });
      if (response.status === 200) {
        var body = await response.json();
        if (body && typeof body.accessToken === "string") return body.accessToken;
      }
      await sleep(1000);
    }
    throw new PluginError("AUTH_REQUIRED", "Grok Bot sign-in did not finish. Please try again.");
  }

  async function config(message) {
    var deadline = Date.now() + READ_BUDGET_MS;
    switch (message && message.type) {
      case "status":
        return settings(load());
      case "connect":
        return connectWith(message.accessToken);
      case "finishSignIn":
        return connectWith(await pollSignIn(message.uuid, message.verifier));
      case "listBots": {
        var current = required();
        return settings(current, await bots(await box(current.accessToken, deadline), current));
      }
      case "selectBot": {
        var s = required();
        var all = await bots(await box(s.accessToken, deadline), s);
        var chosen = all.find(function (b) { return b.id === message.id; });
        if (!chosen)
          throw new PluginError("INVALID_ARGS", "That bot is no longer available. Refresh the list and choose a bot.");
        s.botId = chosen.id;
        s.botName = chosen.name;
        save(s);
        return settings(s, all);
      }
      case "saveNickname": {
        var n = required();
        var listed = await bots(await box(n.accessToken, deadline), n);
        setNickname(n, listed, message.id, message.nickname);
        save(n);
        return settings(n, listed);
      }
      case "disconnect":
        storage.removeItem(KEY);
        clearBots();
        return settings(null);
      default:
        throw new PluginError("INVALID_ARGS", "Unknown settings request.");
    }
  }

  async function send(args) {
    var deadline = Date.now() + SEND_BUDGET_MS;
    var message = args && args.message;
    if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE)
      throw new PluginError("INVALID_ARGS", "Provide a message between 1 and 16,000 characters.");
    var state = required();
    var call = await box(state.accessToken, deadline);
    var bot = await targetBot(call, state, args.chat_id);
    if (deadline - Date.now() < SEND_MIN_LEFT_MS)
      throw new PluginError("PLUGIN_UNAVAILABLE", "Grok Bot is responding slowly, so the message was not sent. Try again shortly.");
    var clientNonce = nonce();
    try {
      await call("sendPrompt", { agentId: bot.id, prompt: message, clientNonce: clientNonce });
    } catch (e) {
      // A refusal is safe to report as not sent; anything else may have landed.
      if (e instanceof PluginError && e.status && e.status < 500) throw e;
      throw new PluginError("PLUGIN_UNAVAILABLE", "Grok Bot delivery is uncertain. Check Grok Bot before sending again.");
    }
    var record = await acceptance(call, clientNonce).catch(function () { return null; });
    if (record && record.status === "rejected")
      throw new PluginError("PLUGIN_UNAVAILABLE", bot.name + " did not accept the message, so it was not sent.");
    return { text: "Message sent to " + bot.name + ". Read Grok Bot's replies later for its answer." };
  }

  async function read(args) {
    var deadline = Date.now() + READ_BUDGET_MS;
    var limit = Math.max(1, Math.min(20, Math.trunc(Number(args && args.limit)) || 3));
    var state = required();
    var call = await box(state.accessToken, deadline);
    var bot = await targetBot(call, state, args && args.chat_id);
    var replies = (await tail(call, bot.id)).map(replyText).filter(Boolean).slice(-limit);
    return { text: replies.length ? bot.name + ": " + replies.join("\n\n") : bot.name + " has no replies yet." };
  }

  async function action(request) {
    switch (request && request.action) {
      case "send_to_agent":
        return send(request.args);
      case "read_grok_bot":
        return read(request.args);
      default:
        throw new PluginError("INVALID_ARGS", "Unknown action.");
    }
  }

  async function source(request) {
    if (!request || request.category !== "agent") throw new PluginError("INVALID_ARGS", "Unsupported Grok Bot source.");
    if (request.item === "configured") {
      var state = load();
      var ready = !!(state && state.botId);
      return { validUntilMs: Date.now() + 60000, instances: [{ instanceId: "grok-bot", properties: {
        name: { shortText: { text: ready ? nickname(state, state.botId) || state.botName || "Grok Bot" : "" } },
        configured: { boolean: { value: ready }, shortText: { text: ready ? "Connected" : state ? "Choose a bot in settings" : "Sign in in settings" } },
      } }] };
    }
    if (request.item !== "chats") throw new PluginError("INVALID_ARGS", "Unsupported Grok Bot source.");
    // The host reads this with a short timeout, so a recent list is served without the network.
    var state = required();
    var cached = cachedBots(state);
    var list;
    if (cached && Date.now() - cached.listedAt < BOTS_TTL_MS) list = cached.bots;
    else {
      try {
        list = await bots(await box(state.accessToken, Date.now() + READ_BUDGET_MS), state);
      } catch (e) {
        if (!cached) throw e;
        list = cached.bots;
      }
    }
    return { validUntilMs: Date.now() + 900000, instances: list.map(function (b) {
      return { instanceId: b.id, properties: { name: { shortText: { text: spoken(state, b) } } } };
    }) };
  }

  return { config: config, action: action, source: source };
}

// Never forward server bodies, tokens, box URLs or native exception text.
function safeError(error) {
  if (error instanceof PluginError && error.code !== "HTTP") return { code: error.code, message: error.message };
  if (error && (error.status === 401 || error.status === 403))
    return { code: "AUTH_REQUIRED", message: "Grok Bot sign-in expired. Sign in again in plugin settings." };
  return { code: "PLUGIN_UNAVAILABLE", message: "Could not reach Grok Bot. Try again shortly." };
}

if (typeof Pebble !== "undefined") {
  var SECURE_KEYS = [KEY];
  // Credentials live in Pebble.secureStorage, which is async, while this plugin reads them
  // synchronously: they are loaded once per session (and again after a failed write), and writes land,
  // in order, before it responds.
  var secureCache = (function () {
    var values = {};
    var writing = Promise.resolve();
    var failure = null;
    var SAVE_FAILED = 'Could not save this plugin\'s credentials. Try again.';
    function load() {
      return Promise.all(SECURE_KEYS.map(function (key) {
        return Pebble.secureStorage.getItem(key).then(function (value) { values[key] = value; });
      }));
    }
    var loaded = load();
    function enqueue(write) {
      writing = writing.then(write).catch(function (error) { failure = failure || error; });
    }
    function flush() {
      return writing.then(function () {
        var error = failure;
        failure = null;
        if (!error) return undefined;
        var rethrow = function () { throw error; };
        return load().then(rethrow, rethrow);
      });
    }
    function after(fn, onFailure) {
      return function () {
        var args = arguments;
        return flush().then(function () { return fn.apply(null, args); }, function () { return onFailure(args); });
      };
    }
    function wrap(name, wrapResponder, fail) {
      var register = Pebble[name];
      Pebble[name] = function (handler) {
        register(function (request, respond) {
          var responder = wrapResponder(respond);
          return loaded.then(function () { return handler(request, responder); }, function () { return fail(respond); });
        });
      };
    }
    wrap('registerActionHandler', function (r) {
      var failed = function () { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); };
      return { ok: after(r.ok, failed), error: after(r.error, function (args) { return r.error.apply(null, args); }) };
    }, function (r) { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); });
    wrap('registerSourceHandler', function (r) {
      var failed = function () { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); };
      return { data: after(r.data, failed), error: after(r.error, function (args) { return r.error.apply(null, args); }) };
    }, function (r) { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); });
    wrap('registerConfigHandler', function (r) {
      return after(r, function () { return r({ error: SAVE_FAILED }); });
    }, function (r) { return r({ error: SAVE_FAILED }); });
    return {
      has: function (key) { return SECURE_KEYS.indexOf(key) !== -1; },
      getItem: function (key) { return values[key] === undefined ? null : values[key]; },
      // What's stored now, after this session's pending writes, including other sessions' writes.
      persisted: function (key) { return writing.then(function () { return Pebble.secureStorage.getItem(key); }); },
      setItem: function (key, value) {
        values[key] = String(value);
        enqueue(function () { return Pebble.secureStorage.setItem(key, String(value)); });
      },
      removeItem: function (key) {
        values[key] = null;
        enqueue(function () { return Pebble.secureStorage.removeItem(key); });
      },
    };
  })();
  var service = createService(secureCache, fetch, localStorage);
  Pebble.registerActionHandler(async function (request, respond) {
    try {
      respond.ok(await service.action(request));
    } catch (error) {
      var safe = safeError(error);
      respond.error(safe.code, safe.message);
    }
  });
  Pebble.registerSourceHandler(async function (request, respond) {
    try {
      respond.data(await service.source(request));
    } catch (error) {
      var safe = safeError(error);
      respond.error(safe.code, safe.message);
    }
  });
  Pebble.registerConfigHandler(async function (message, respond) {
    try {
      respond(await service.config(message));
    } catch (error) {
      respond({ error: safeError(error).message });
    }
  });
}

if (typeof module !== "undefined") module.exports = { createService: createService, safeError: safeError };
