'use strict';

var util = require('./util');
var PluginError = util.PluginError;
var jwtClaims = util.jwtClaims;
var uuid = util.uuid;

var KEY = 'chatgpt-dots.connection.v1';
var API = 'https://chatgpt.com/backend-api';
var SESSION_URL = 'https://chatgpt.com/api/auth/session';
var SESSION_COOKIE = '__Secure-next-auth.session-token';
var MAX_MESSAGE = 16000;
var MAX_TOKEN = 16384;
var RENEW_BEFORE_MS = 5 * 60 * 1000;

function authRequired() {
  return PluginError('AUTH_REQUIRED', 'ChatGPT sign-in expired. Sign in again in plugin settings.');
}

function validToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN && !/[\r\n;]/.test(value);
}

/** The ChatGPT account, user and expiry carried in the access token's claims. */
function identity(accessToken) {
  var claims = validToken(accessToken) ? jwtClaims(accessToken) : null;
  if (!claims) return null;
  var auth = claims['https://api.openai.com/auth'] || {};
  var profile = claims['https://api.openai.com/profile'] || {};
  if (typeof auth.chatgpt_account_id !== 'string' || !auth.chatgpt_account_id ||
      typeof auth.chatgpt_user_id !== 'string' || !auth.chatgpt_user_id ||
      typeof claims.exp !== 'number' || !claims.exp) return null;
  return {
    account: auth.chatgpt_account_id,
    user: auth.chatgpt_user_id,
    email: typeof profile.email === 'string' ? profile.email : '',
    expiresAt: claims.exp * 1000,
  };
}

/** [storage] is `Pebble.secureStorage`: the saved connection holds the ChatGPT session. */
function createDotsService(storage, fetch, now) {
  async function load() {
    var raw = await storage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  }
  function save(state) {
    return storage.setItem(KEY, JSON.stringify(state));
  }
  async function required() {
    var state = await load();
    if (!state) throw PluginError('AUTH_REQUIRED', 'Sign in to ChatGPT in plugin settings.');
    return state;
  }

  async function failure(response, path) {
    if (response.status === 401) return authRequired();
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

  async function call(state, method, path, body) {
    var response = await fetch(API + path, {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + state.accessToken,
        'ChatGPT-Account-Id': state.account,
        'X-OpenAI-Expected-Account-Id': state.account,
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

  /** Trades a session token for a fresh access token, and the session token ChatGPT rotated to. */
  async function exchange(sessionToken) {
    var response = await fetch(SESSION_URL, { headers: { 'Cookie': SESSION_COOKIE + '=' + sessionToken } });
    if (response.status !== 200) throw authRequired();
    var session = await response.json();
    var signedIn = session && validToken(session.sessionToken) ? identity(session.accessToken) : null;
    if (!signedIn || signedIn.expiresAt - now() < 60 * 1000) throw authRequired();
    return { accessToken: session.accessToken, sessionToken: session.sessionToken, identity: signedIn };
  }

  async function renew(state) {
    var renewed = await exchange(state.sessionToken);
    if (renewed.identity.account !== state.account || renewed.identity.user !== state.user) throw authRequired();
    state.accessToken = renewed.accessToken;
    state.sessionToken = renewed.sessionToken;
    state.expiresAt = renewed.identity.expiresAt;
    // A connection still being set up is saved only once its Dot is verified.
    if (state.room) await save(state);
  }

  /** Renews ahead of expiry, and once more if ChatGPT rejects the access token anyway. */
  async function authed(state, method, path, body) {
    if (state.expiresAt - now() < RENEW_BEFORE_MS) await renew(state);
    try {
      return await call(state, method, path, body);
    } catch (error) {
      if (error.status !== 401) throw error;
      await renew(state);
      return call(state, method, path, body);
    }
  }

  /** The account's primary Dot and its one-to-one room, verified against the signed-in user. */
  async function discover(state) {
    var primary = await authed(state, 'GET', '/tbo/primary');
    var selection = primary && primary.selection;
    if (!selection || !selection.available) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'No Dot found. Set up a Dot in ChatGPT first.');
    }
    if (!selection.thread_id || !selection.aeon_id || !selection.messaging_room_id) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'ChatGPT returned an incomplete Dot.');
    }
    var profile = await authed(state, 'GET', '/tbo/by-thread/' + encodeURIComponent(selection.thread_id));
    if (!profile || profile.status !== 'active' || profile.id !== selection.aeon_id ||
        profile.messaging_room_id !== selection.messaging_room_id ||
        (profile.active_root_thread_id && profile.active_root_thread_id !== selection.thread_id)) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'Your Dot did not match its room. Open ChatGPT, then sign in again.');
    }
    var room = await authed(state, 'GET', '/messaging/rooms/' + encodeURIComponent(profile.messaging_room_id));
    var members = room && Array.isArray(room.members) ? room.members : [];
    var hasDot = members.some(function (m) { return m && m.aeon_id === profile.id && m.account_user_id; });
    var humans = members.filter(function (m) { return m && !m.aeon_id; });
    if (!room || room.type !== 'DM' || room.app_source !== 'chatgpt:messaging' || room.id !== profile.messaging_room_id ||
        room.aeon_id !== profile.id || members.length !== 2 || !hasDot || humans.length !== 1 ||
        humans[0].account_user_id !== state.user) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'Your Dot did not match its room. Open ChatGPT, then sign in again.');
    }
    return { room: room.id, dotName: typeof profile.display_name === 'string' && profile.display_name ? profile.display_name : 'Dot' };
  }

  function status(state) {
    return state
      ? { configured: true, email: state.email, dotName: state.dotName }
      : { configured: false };
  }

  async function connect(sessionToken) {
    if (!validToken(sessionToken)) {
      throw PluginError('AUTH_REQUIRED', 'ChatGPT sign-in returned an invalid session. Please try again.');
    }
    var signedIn = await exchange(sessionToken);
    var state = {
      accessToken: signedIn.accessToken,
      sessionToken: signedIn.sessionToken,
      account: signedIn.identity.account,
      user: signedIn.identity.user,
      email: signedIn.identity.email,
      expiresAt: signedIn.identity.expiresAt,
    };
    var dot = await discover(state);
    state.room = dot.room;
    state.dotName = dot.dotName;
    await save(state);
    return status(state);
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
    var sent = await authed(state, 'POST', '/messaging/rooms/' + encodeURIComponent(state.room) + '/messages', {
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
