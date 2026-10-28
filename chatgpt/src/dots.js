'use strict';

var util = require('./util');
var PluginError = util.PluginError;
var uuid = util.uuid;

var KEY = 'chatgpt-dots.connection.v1';
var API = 'https://chatgpt.com/backend-api';
var MAX_MESSAGE = 16000;

/** [storage] is `Pebble.secureStorage`: it keeps the Dot's room; [auth] is the shared ChatGPT session. */
function createDotsService(storage, fetch, auth) {
  /** The saved Dot, if it belongs to the signed-in account. */
  async function load() {
    var session = await auth.load();
    var raw = await storage.getItem(KEY);
    var state = raw ? JSON.parse(raw) : null;
    return state && session && state.account === session.account && state.user === session.user
      ? Object.assign({ email: session.email }, state) : null;
  }
  async function required() {
    var state = await load();
    if (state) return state;
    if (await auth.load()) throw PluginError('PLUGIN_UNAVAILABLE', 'No Dot found. Set up a Dot in ChatGPT, then sign in again in plugin settings.');
    throw PluginError('AUTH_REQUIRED', 'Sign in to ChatGPT in plugin settings.');
  }

  async function failure(response, path) {
    if (response.status === 401) return PluginError('AUTH_REQUIRED', 'ChatGPT sign-in expired. Sign in again in plugin settings.');
    if (response.status === 403) {
      return PluginError('PERMISSION_DENIED',
        'ChatGPT blocked the request or wants you to verify your account. Open ChatGPT, then sign in again.');
    }
    if (response.status === 429) return PluginError('RATE_LIMITED', 'ChatGPT is rate limiting requests. Try again shortly.');
    if (response.status === 404 && path === '/tbo/primary') {
      var body = null;
      try { body = await response.json(); } catch (_) { /* not JSON */ }
      if (body && body.detail === 'Not Found') {
        return PluginError('PLUGIN_UNAVAILABLE', 'ChatGPT Dots is not available in your region yet.');
      }
    }
    return PluginError('PLUGIN_UNAVAILABLE', 'ChatGPT returned an error (HTTP ' + response.status + ').');
  }

  async function call(session, method, path, body) {
    var response = await fetch(API + path, {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + session.accessToken,
        'ChatGPT-Account-Id': session.account,
        'X-OpenAI-Expected-Account-Id': session.account,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status < 200 || response.status >= 300) {
      console.error('ChatGPT ' + method + ' ' + path.replace(/\/(by-thread|rooms)\/[^/]+/g, '/$1/:id') + ': HTTP ' + response.status);
      var error = await failure(response, path);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  /** Renews once more if ChatGPT rejects the access token anyway. */
  async function authed(method, path, body) {
    var session = await auth.current();
    try {
      return await call(session, method, path, body);
    } catch (error) {
      if (error.status !== 401) throw error;
      return call(await auth.renew(), method, path, body);
    }
  }

  /** The account's primary Dot and its one-to-one room, verified against the signed-in user. */
  async function discover() {
    var primary = await authed('GET', '/tbo/primary');
    var selection = primary && primary.selection;
    if (!selection || !selection.available) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'No Dot found. Set up a Dot in ChatGPT first.');
    }
    if (!selection.thread_id || !selection.aeon_id || !selection.messaging_room_id) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'ChatGPT returned an incomplete Dot.');
    }
    var profile = await authed('GET', '/tbo/by-thread/' + encodeURIComponent(selection.thread_id));
    if (!profile || profile.status !== 'active' || profile.id !== selection.aeon_id ||
        profile.messaging_room_id !== selection.messaging_room_id ||
        (profile.active_root_thread_id && profile.active_root_thread_id !== selection.thread_id)) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'Your Dot did not match its room. Open ChatGPT, then sign in again.');
    }
    var room = await authed('GET', '/messaging/rooms/' + encodeURIComponent(profile.messaging_room_id));
    var members = room && Array.isArray(room.members) ? room.members : [];
    var hasDot = members.some(function (m) { return m && m.aeon_id === profile.id && m.account_user_id; });
    var humans = members.filter(function (m) { return m && !m.aeon_id; });
    var session = await auth.load();
    if (!room || room.type !== 'DM' || room.app_source !== 'chatgpt:messaging' || room.id !== profile.messaging_room_id ||
        room.aeon_id !== profile.id || members.length !== 2 || !hasDot || humans.length !== 1 ||
        !session || !session.user || humans[0].account_user_id !== session.user) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'Your Dot did not match its room. Open ChatGPT, then sign in again.');
    }
    return { account: session.account, user: session.user, room: room.id, dotName: typeof profile.display_name === 'string' && profile.display_name ? profile.display_name : 'Dot' };
  }

  function status(state) {
    return state
      ? { configured: true, email: state.email, dotName: state.dotName }
      : { configured: false };
  }

  /** Finds the signed-in account's Dot and saves it. */
  async function connect() {
    var dot = await discover();
    await storage.setItem(KEY, JSON.stringify({ account: dot.account, user: dot.user, room: dot.room, dotName: dot.dotName }));
    return status(await load());
  }

  async function disconnect() {
    await storage.removeItem(KEY);
    return status(null);
  }

  async function send(args) {
    var text = args && args.message;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE) {
      throw PluginError('INVALID_ARGS', 'Provide a message between 1 and 16,000 characters.');
    }
    var state = await required();
    var id = uuid();
    var sent = await authed('POST', '/messaging/rooms/' + encodeURIComponent(state.room) + '/messages', {
      content: { text: text },
      request_id: id,
      idempotency_token: id,
    });
    if (!sent || !sent.id || sent.request_id !== id) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'ChatGPT did not confirm the message; check your Dot before sending again.');
    }
    return { text: 'Message sent to ' + state.dotName + '.' };
  }

  return {
    status: async function () { return status(await load()); },
    connect: connect, disconnect: disconnect, send: send,
  };
}

module.exports = { createDotsService: createDotsService };
