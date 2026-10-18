// Grok Bot plugin. Talks to the user's Grok Bot computer over the same private HTTPS API the
// Grok Bot apps use: a Cursor access token (from the native sign-in) asks Cursor's backend where
// the user's box is, then each call is `POST {gatewayUrl}/api/<method>` on that box.
// Unofficial and undocumented: method names and shapes come from the Grok Bot client.

var KEY = "grokbot.connection.v1";
var POLL_URL = "https://api2.cursor.sh/auth/poll";
var ENSURE_URL = "https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox";
var BOX_URL = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.cursorvm\.com$/i;
var MAX_MESSAGE = 16000;
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






function createService(storage, fetch) {
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
    return function call(method, args) {
      return post(url + "/api/" + method, headers, args, deadline);
    };
  }

  async function bots(call) {
    var data = await call("listAgents", {});
    var list = Array.isArray(data) ? data : Array.isArray(data.agents) ? data.agents : [];
    return list
      .filter(function (a) { return a && (a.id || a.agentId); })
      .map(function (a) {
        var members = a.memberIds || a.memberAgentIds || [];
        return {
          id: String(a.id || a.agentId),
          name: a.name || a.title || "Untitled bot",
          group: a.isGroup === true || (a.isGroup == null && members.length > 0),
        };
      });
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
    var all = await bots(call);
    var bot = all.find(function (b) { return b.id === state.botId; });
    if (!bot) throw new PluginError("INVALID_ARGS", "The selected Grok Bot is unavailable. Choose a bot in plugin settings.");
    return bot;
  }

  function settings(state, list) {
    return {
      configured: !!state,
      selected: state ? state.botId : null,
      bots: list ? list.map(function (b) { return { id: b.id, title: b.group ? b.name + " (group)" : b.name }; }) : undefined,
    };
  }

  async function connectWith(token) {
    if (typeof token !== "string" || !token || token.length > 8192 || /[\r\n]/.test(token))
      throw new PluginError("AUTH_REQUIRED", "Grok Bot sign-in returned an invalid session. Please try again.");
    var list = await bots(await box(token, Date.now() + READ_BUDGET_MS));
    var previous = load();
    var keep = previous && list.some(function (b) { return b.id === previous.botId; });
    var first = list.find(function (b) { return !b.group; }) || list[0];
    var state = { accessToken: token, botId: keep ? previous.botId : first ? first.id : null };
    save(state);
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
        return settings(current, await bots(await box(current.accessToken, deadline)));
      }
      case "selectBot": {
        var s = required();
        var all = await bots(await box(s.accessToken, deadline));
        if (!all.some(function (b) { return b.id === message.id; }))
          throw new PluginError("INVALID_ARGS", "That bot is no longer available. Refresh the list and choose a bot.");
        s.botId = message.id;
        save(s);
        return settings(s);
      }
      case "disconnect":
        storage.removeItem(KEY);
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
    var bot = await selectedBot(call, state);
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
    var bot = await selectedBot(call, state);
    var replies = (await tail(call, bot.id)).map(replyText).filter(Boolean).slice(-limit);
    return { text: replies.length ? bot.name + ": " + replies.join("\n\n") : bot.name + " has no replies yet." };
  }

  async function action(request) {
    switch (request && request.action) {
      case "send_to_grok_bot":
        return send(request.args);
      case "read_grok_bot":
        return read(request.args);
      default:
        throw new PluginError("INVALID_ARGS", "Unknown action.");
    }
  }

  return { config: config, action: action };
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
  var service = createService(secureCache, fetch);
  Pebble.registerActionHandler(async function (request, respond) {
    try {
      respond.ok(await service.action(request));
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
