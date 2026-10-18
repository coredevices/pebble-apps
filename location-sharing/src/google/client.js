'use strict';
var bytes = require('../../../chat/imessage/src/runtime/bytes');
var RuntimeError = require('../../../chat/imessage/src/runtime/errors').RuntimeError;
var ERROR_KINDS = require('../../../chat/imessage/src/runtime/errors').ERROR_KINDS;
var AUTH_URL = "https://android.clients.google.com/auth";
var OAUTH_LOGIN_URL = "https://accounts.google.com/OAuthLogin";
var MERGE_SESSION_URL = "https://accounts.google.com/MergeSession";
var MAPS_HOME_URL = "https://www.google.com/maps";
var LOCATION_URL = "https://www.google.com/maps/_/MapsWizUi/data/batchexecute";
var OAUTH_LOGIN_SERVICE = "oauth2:https://www.google.com/accounts/OAuthLogin";
var CLIENT_SIG = "38918a453d07199354f8b19af05ec6562ced5788";
var WEB_LOGIN_APP = "com.google.android.apps.chromecast.app";
var WEB_LOGIN_CLIENT_SIG = "24bb24c05e47e0aefa68a58a766179d9b613a600";
var ROTATE_COOKIES_URL = "https://accounts.google.com/RotateCookies";
var PLAY_SERVICES_VERSION = "240913000";
var PLACEHOLDER_EMAIL = "a@gmail.com";
var DEFAULT_ANDROID_ID = "0123456789abcdef";
var STORE_MASTER_TOKEN = "location-sharing-google-master-token";
var STORE_OAUTH_TOKEN = "location-sharing-google-oauth-token";
var STORE_ANDROID_ID = "location-sharing-google-android-id";
var STORE_EMAIL = "location-sharing-google-email";
var STORE_COOKIES = "location-sharing-google-cookies";
var STORE_CACHE = "location-sharing-google-people-v1";
var STORE_DIAGNOSTICS = "location-sharing-google-diagnostics-v1";
var PLUGIN_VERSION = "0.12.0";
var MAX_DIAGNOSTIC_EVENTS = 40;
var MAPS_RPC_ID = "Qt4aBe";
var MAPS_RPC_METHOD = "/MapsLocationSharingService.GetState";
var MAPS_BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9"
};
function googleError(code, message, kind, details) {
  return new RuntimeError(code, message, {
    kind: kind || ERROR_KINDS.TRANSPORT,
    details
  });
}
function text(value) {
  return value === void 0 || value === null ? "" : String(value).trim();
}
function at(value, index) {
  return Array.isArray(value) ? value[index] : void 0;
}
function finite(value) {
  return Number.isFinite(value) ? value : null;
}
function formEncode(values) {
  return Object.keys(values).map(function(key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(values[key]);
  }).join("&");
}
function mapsUrl(baseUrl, account, values) {
  var query = Object.assign({}, values || {}, {
    authuser: text(account && account.email) || "0"
  });
  return baseUrl + "?" + formEncode(query);
}
function parseAuthResponse(value) {
  var result = {};
  String(value || "").split("\n").forEach(function(line) {
    var split = line.indexOf("=");
    if (split > 0) result[line.slice(0, split)] = line.slice(split + 1).trim();
  });
  return result;
}
function requestBody(value) {
  // The runtime HTTP effect accepts byte arrays only. GET requests need an explicitly
  // empty body instead of null or the adapter rejects them before any network call.
  return value === void 0 || value === null ? new Uint8Array(0) : bytes.utf8ToBytes(String(value));
}
function responseHeader(headers, name) {
  var needle = String(name).toLowerCase();
  var match = (headers || []).find(function(header) {
    return Array.isArray(header) && String(header[0]).toLowerCase() === needle;
  });
  return match ? String(match[1]) : "";
}
function safeGoogleRedirect(currentUrl, location) {
  var value = text(location);
  if (!value) return "";
  if (value.charAt(0) === "/") {
    var origin = /^https:\/\/accounts\.google\.com\//.test(currentUrl) ? "https://accounts.google.com" : "https://www.google.com";
    value = origin + value;
  }
  if (!/^https:\/\/(?:accounts\.google\.com|www\.google\.com)(?:[\/?#]|$)/.test(value)) {
    throw googleError("GOOGLE_LOCATION_PROTOCOL_ERROR", "Google returned an untrusted session redirect.");
  }
  return value;
}
async function request(effects, method, url, headers, body) {
  var response;
  try {
    response = await effects.http.request({
      method,
      url,
      headers: Object.keys(headers || {}).map(function(name) {
        return [name, headers[name]];
      }),
      body: requestBody(body),
      maxResponseBytes: 4 * 1024 * 1024
    });
  } catch (_) {
    throw googleError("GOOGLE_LOCATION_NETWORK_ERROR", "Could not reach Google location sharing.");
  }
  if (!response || !Number.isInteger(response.status) || !(response.body instanceof Uint8Array)) {
    throw googleError("GOOGLE_LOCATION_PROTOCOL_ERROR", "Google returned a malformed response.");
  }
  return {
    status: response.status,
    text: bytes.bytesToUtf8(response.body),
    headers: response.headers || []
  };
}
async function postAuth(effects, values) {
  var response = await request(effects, "POST", AUTH_URL, {
    "User-Agent": "GoogleAuth/1.4",
    "Accept-Encoding": "identity",
    "Content-Type": "application/x-www-form-urlencoded"
  }, formEncode(values));
  if (response.status < 200 || response.status >= 300) {
    throw googleError("AUTH_REQUIRED", "Google authorization failed. Sign in again.");
  }
  return parseAuthResponse(response.text);
}
async function exchangeOAuthToken(effects, oauthToken, androidId) {
  var response = await postAuth(effects, {
    accountType: "HOSTED_OR_GOOGLE",
    Email: PLACEHOLDER_EMAIL,
    has_permission: "1",
    add_account: "1",
    ACCESS_TOKEN: "1",
    Token: oauthToken,
    service: "ac2dm",
    source: "android",
    androidId,
    device_country: "us",
    operatorCountry: "us",
    lang: "en",
    sdk_version: "17",
    google_play_services_version: PLAY_SERVICES_VERSION,
    client_sig: CLIENT_SIG,
    callerSig: CLIENT_SIG,
    droidguard_results: "dummy123"
  });
  if (!response.Token) {
    throw googleError("AUTH_REQUIRED", "Google sign-in could not create a master token. Sign in again.");
  }
  return { masterToken: response.Token, email: text(response.Email) };
}
async function issueWebLoginToken(effects, account) {
  var response = await postAuth(effects, {
    accountType: "HOSTED_OR_GOOGLE",
    Email: account.email || PLACEHOLDER_EMAIL,
    has_permission: "1",
    EncryptedPasswd: account.masterToken,
    service: OAUTH_LOGIN_SERVICE,
    source: "android",
    androidId: account.androidId,
    app: WEB_LOGIN_APP,
    client_sig: WEB_LOGIN_CLIENT_SIG,
    device_country: "us",
    operatorCountry: "us",
    lang: "en",
    sdk_version: "17",
    google_play_services_version: PLAY_SERVICES_VERSION
  });
  if (!response.Auth) {
    throw googleError("AUTH_REQUIRED", "The Google master token is no longer authorized. Sign in again.");
  }
  return response.Auth;
}
function mapsPageTokens(value) {
  var html = String(value || "");
  var xsrfMatch = /[\"']SNlM0e[\"']\s*:\s*[\"']([^\"']+)[\"']/.exec(html);
  var keiMatch = /kEI\s*=\s*[\"']([^\"']+)[\"']/.exec(html);
  if (!xsrfMatch || !keiMatch) {
    throw googleError("AUTH_REQUIRED", "Google Maps did not accept the minted account session.", ERROR_KINDS.TRANSPORT, {
      stage: "maps-page-tokens",
      hasXsrfMarker: /[\"']SNlM0e[\"']\s*:/.test(html),
      hasXsrf: !!xsrfMatch,
      hasKeiMarker: /\bkEI\s*=/.test(html),
      hasKei: !!keiMatch
    });
  }
  return { xsrf: xsrfMatch[1], kei: keiMatch[1] };
}
function mapsBatchBody(tokens) {
  var innerPayload = JSON.stringify([
    1,
    [tokens.kei, null, null, null, null, null, 81, null, null, null, null, null, null, null, 312733]
  ]);
  var rpcPayload = JSON.stringify([[[MAPS_RPC_METHOD, innerPayload, null, "generic"]]]);
  return formEncode({ "f.req": rpcPayload, at: tokens.xsrf });
}
function parseLocationResponse(value) {
  var dataLine = String(value || "").split(/\r?\n/).map(function(line) {
    return line.trim();
  }).find(function(line) {
    return line.indexOf('[["wrb.fr"') === 0;
  });
  var envelope;
  try {
    envelope = dataLine ? JSON.parse(dataLine) : null;
  } catch (_) {
    envelope = null;
  }
  var innerText = Array.isArray(envelope) && Array.isArray(envelope[0]) && envelope[0][0] === "wrb.fr" && envelope[0][1] === MAPS_RPC_METHOD ? envelope[0][2] : null;
  var data;
  try {
    data = typeof innerText === "string" ? JSON.parse(innerText) : null;
  } catch (_) {
    data = null;
  }
  if (!Array.isArray(data)) {
    throw googleError("GOOGLE_LOCATION_PROTOCOL_ERROR", "Google Maps returned an unexpected location-sharing response.");
  }
  if (data[0] === null) {
    throw googleError("AUTH_REQUIRED", "Google Maps did not accept the account session. Sign in again.");
  }
  return (Array.isArray(data[0]) ? data[0] : []).map(function(entry) {
    var identity = at(entry, 0);
    var location = at(entry, 1);
    var profile = at(entry, 6);
    var coordinates = at(location, 1);
    var battery = at(entry, 13);
    var name = text(at(profile, 2)) || text(at(identity, 3)) || text(at(profile, 3)) || "Shared person";
    var nickname = text(at(profile, 3));
    var id = text(at(profile, 0)) || text(at(identity, 0)) || name;
    return {
      id,
      name,
      handles: nickname && nickname !== name ? [nickname] : [],
      latitude: finite(at(coordinates, 2)),
      longitude: finite(at(coordinates, 1)),
      accuracyMeters: finite(at(location, 3)),
      timestampMs: finite(at(location, 2)),
      address: text(at(location, 4)),
      isOld: !Number.isFinite(at(location, 2)),
      batteryPercent: finite(at(battery, 1)),
      charging: at(battery, 0) === true
    };
  });
}
function loadCached(storage) {
  try {
    var value = JSON.parse(storage.get(STORE_CACHE) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}
function loadDiagnostics(storage) {
  try {
    var value = JSON.parse(storage.get(STORE_DIAGNOSTICS) || "[]");
    return Array.isArray(value) ? value.slice(-MAX_DIAGNOSTIC_EVENTS) : [];
  } catch (_) {
    return [];
  }
}
function diagnosticFailure(error, stage) {
  var result = {
    operationStage: stage,
    errorName: error && typeof error.name === "string" ? error.name : "Error",
    message: error instanceof RuntimeError ? error.message : "Unexpected plugin runtime failure."
  };
  if (error instanceof RuntimeError) {
    result.code = error.code;
    result.kind = error.kind;
    result.retryable = error.retryable === true;
    if (error.details && Number.isInteger(error.details.httpStatus)) {
      result.httpStatus = error.details.httpStatus;
    }
    if (error.details && typeof error.details.stage === "string") {
      result.failureStage = error.details.stage;
    }
    ["hasXsrfMarker", "hasXsrf", "hasKeiMarker", "hasKei"].forEach(function(name) {
      if (error.details && typeof error.details[name] === "boolean") result[name] = error.details[name];
    });
  }
  return result;
}
function GoogleMapsClient(options) {
  if (!options || !options.effects) throw new TypeError("Google Maps client dependencies are missing.");
  this.effects = options.effects;
  this.storage = options.effects.storage;
  this.people = loadCached(this.storage);
  this.diagnosticEvents = loadDiagnostics(this.storage);
}
GoogleMapsClient.prototype.recordDiagnostic = function(stage, details) {
  var event = Object.assign({
    timestamp: new Date().toISOString(),
    stage
  }, details || {});
  this.diagnosticEvents = this.diagnosticEvents.concat([event]).slice(-MAX_DIAGNOSTIC_EVENTS);
  this.storage.set(STORE_DIAGNOSTICS, JSON.stringify(this.diagnosticEvents));
};
GoogleMapsClient.prototype.diagnostics = function() {
  var status = this.status();
  return {
    plugin: "Location Sharing",
    pluginVersion: PLUGIN_VERSION,
    generatedAt: new Date().toISOString(),
    google: {
      ready: status.ready,
      configured: status.configured,
      exchangePending: status.exchangePending
    },
    redaction: "Tokens, cookies, request URLs, headers, and response bodies are never recorded.",
    events: this.diagnosticEvents.slice()
  };
};
GoogleMapsClient.prototype.clearDiagnostics = function() {
  this.diagnosticEvents = [];
  this.storage.delete(STORE_DIAGNOSTICS);
  return this.diagnostics();
};
GoogleMapsClient.prototype.cookieHeader = function() {
  var cookies = JSON.parse(this.storage.get(STORE_COOKIES) || "{}");
  return Object.keys(cookies).map(function(name) {
    return name + "=" + cookies[name];
  }).join("; ");
};
GoogleMapsClient.prototype.status = function() {
  var masterToken = text(this.storage.get(STORE_MASTER_TOKEN));
  var oauthToken = text(this.storage.get(STORE_OAUTH_TOKEN));
  var hasCookies = !!this.cookieHeader();
  return {
    ready: !!masterToken || hasCookies,
    configured: !!(masterToken || oauthToken) || hasCookies,
    exchangePending: !masterToken && !!oauthToken,
    email: text(this.storage.get(STORE_EMAIL))
  };
};
GoogleMapsClient.prototype.setCredentials = function(credentials) {
  credentials = credentials || {};
  var cookies = {};
  Object.keys(credentials.cookies || {}).forEach(function(name) {
    var value = credentials.cookies[name];
    if (/^[\w-]+$/.test(name) && typeof value === "string" && /^[^;\s]+$/.test(value)) cookies[name] = value;
  });
  if (Object.keys(cookies).length > 0) {
    [STORE_MASTER_TOKEN, STORE_OAUTH_TOKEN, STORE_ANDROID_ID].forEach(this.storage.delete.bind(this.storage));
    this.storage.set(STORE_COOKIES, JSON.stringify(cookies));
    if (text(credentials.email)) this.storage.set(STORE_EMAIL, text(credentials.email));
    else this.storage.delete(STORE_EMAIL);
    this.people = [];
    this.storage.delete(STORE_CACHE);
    return this.status();
  }
  var masterToken = text(credentials.masterToken);
  var oauthToken = text(credentials.oauthToken);
  if (!masterToken && !oauthToken) {
    throw googleError("INVALID_ARGS", "Enter a Google oauth_token or master token.", ERROR_KINDS.INVALID_INPUT);
  }
  var androidId = text(credentials.androidId);
  if (androidId && !/^[0-9a-fA-F]{16}$/.test(androidId)) {
    throw googleError("INVALID_ARGS", "Android ID must contain 16 hexadecimal characters.", ERROR_KINDS.INVALID_INPUT);
  }
  if (!androidId) {
    androidId = oauthToken ? bytes.bytesToHex(this.effects.random.bytes(8)) : DEFAULT_ANDROID_ID;
  }
  this.storage.delete(STORE_COOKIES);
  if (masterToken) this.storage.set(STORE_MASTER_TOKEN, masterToken);
  else this.storage.delete(STORE_MASTER_TOKEN);
  if (oauthToken && !masterToken) this.storage.set(STORE_OAUTH_TOKEN, oauthToken);
  else this.storage.delete(STORE_OAUTH_TOKEN);
  this.storage.set(STORE_ANDROID_ID, androidId.toLowerCase());
  var email = text(credentials.email);
  if (email) this.storage.set(STORE_EMAIL, email);
  else this.storage.delete(STORE_EMAIL);
  this.people = [];
  this.storage.delete(STORE_CACHE);
  return this.status();
};
GoogleMapsClient.prototype.credentials = async function() {
  var masterToken = text(this.storage.get(STORE_MASTER_TOKEN));
  var androidId = text(this.storage.get(STORE_ANDROID_ID)) || DEFAULT_ANDROID_ID;
  var email = text(this.storage.get(STORE_EMAIL));
  if (!masterToken) {
    var oauthToken = text(this.storage.get(STORE_OAUTH_TOKEN));
    if (!oauthToken) throw googleError("AUTH_REQUIRED", "Connect Google Maps location sharing first.");
    var exchanged = await exchangeOAuthToken(this.effects, oauthToken, androidId);
    masterToken = exchanged.masterToken;
    email = exchanged.email || email;
    this.storage.set(STORE_MASTER_TOKEN, masterToken);
    this.storage.delete(STORE_OAUTH_TOKEN);
    if (email) this.storage.set(STORE_EMAIL, email);
  }
  return { masterToken, androidId, email };
};
// The plugin's fetch has no cookie jar, so the MergeSession link is loaded in a web sign-in, whose
// cookies are the session the Maps requests then carry.
GoogleMapsClient.prototype.webLoginUrl = async function() {
  var account = await this.credentials();
  var authToken = await issueWebLoginToken(this.effects, account);
  var oauthLogin = await request(this.effects, "GET", OAUTH_LOGIN_URL + "?source=ChromiumBrowser&issueuberauth=1", { Authorization: "Bearer " + authToken });
  this.recordDiagnostic("oauth-login", { httpStatus: oauthLogin.status, responseCharacters: oauthLogin.text.length });
  if (oauthLogin.status < 200 || oauthLogin.status >= 300 || !text(oauthLogin.text)) {
    throw googleError("AUTH_REQUIRED", "Google could not start a Maps web session. Sign in again.", ERROR_KINDS.TRANSPORT, { httpStatus: oauthLogin.status, stage: "oauth-login" });
  }
  return MERGE_SESSION_URL + "?service=mail&continue=" + encodeURIComponent("https://www.google.com/") + "&uberauth=" + encodeURIComponent(text(oauthLogin.text));
};
GoogleMapsClient.prototype.refresh = async function() {
  var stage = "credentials";
  this.recordDiagnostic("refresh-start");
  try {
    var cookieHeader = this.cookieHeader();
    var account = cookieHeader ? { email: text(this.storage.get(STORE_EMAIL)) } : await this.credentials();
    var browserHeaders = cookieHeader ? Object.assign({}, MAPS_BROWSER_HEADERS, { Cookie: cookieHeader }) : MAPS_BROWSER_HEADERS;
    this.recordDiagnostic("credentials-ready", { hadStoredMasterToken: this.status().ready, webSession: !!cookieHeader });
    if (!cookieHeader) {
      stage = "web-login-token";
      var authToken = await issueWebLoginToken(this.effects, account);
      this.recordDiagnostic("web-login-token", { received: !!authToken });
      stage = "oauth-login";
      var authorizationHeaders = { Authorization: "Bearer " + authToken };
      var oauthLogin = await request(this.effects, "GET", OAUTH_LOGIN_URL + "?source=ChromiumBrowser&issueuberauth=1", authorizationHeaders);
      this.recordDiagnostic("oauth-login", { httpStatus: oauthLogin.status, responseCharacters: oauthLogin.text.length });
      if (oauthLogin.status < 200 || oauthLogin.status >= 300 || !text(oauthLogin.text)) {
        throw googleError("AUTH_REQUIRED", "Google could not start a Maps web session. Sign in again.", ERROR_KINDS.TRANSPORT, { httpStatus: oauthLogin.status, stage });
      }
      stage = "merge-session";
      var mergeUrl = MERGE_SESSION_URL + "?service=mail&continue=" + encodeURIComponent("https://www.google.com") + "&uberauth=" + encodeURIComponent(text(oauthLogin.text));
      var merge = await request(this.effects, "GET", mergeUrl, Object.assign({}, MAPS_BROWSER_HEADERS, authorizationHeaders));
      var redirectUrl = safeGoogleRedirect(mergeUrl, responseHeader(merge.headers, "location"));
      this.recordDiagnostic("merge-session", { httpStatus: merge.status, responseCharacters: merge.text.length, hasRedirect: !!redirectUrl });
      if (merge.status < 200 || merge.status >= 400) {
        throw googleError("AUTH_REQUIRED", "Google could not create a Maps session. Sign in again.", ERROR_KINDS.TRANSPORT, { httpStatus: merge.status, stage });
      }
      if (redirectUrl) {
        stage = "merge-redirect";
        var redirectHops = 0;
        var seenRedirects = {};
        while (redirectUrl) {
          if (redirectHops >= 6 || seenRedirects[redirectUrl]) {
            throw googleError("AUTH_REQUIRED", "Google returned an invalid account session redirect chain.", ERROR_KINDS.TRANSPORT, { stage });
          }
          seenRedirects[redirectUrl] = true;
          redirectHops += 1;
          var mergeRedirect = await request(this.effects, "GET", redirectUrl, MAPS_BROWSER_HEADERS);
          var nextRedirect = safeGoogleRedirect(redirectUrl, responseHeader(mergeRedirect.headers, "location"));
          this.recordDiagnostic("merge-redirect", {
            hop: redirectHops,
            httpStatus: mergeRedirect.status,
            responseCharacters: mergeRedirect.text.length,
            hasRedirect: !!nextRedirect
          });
          if (mergeRedirect.status < 200 || mergeRedirect.status >= 400) {
            throw googleError("AUTH_REQUIRED", "Google could not finish the account session redirect.", ERROR_KINDS.TRANSPORT, { httpStatus: mergeRedirect.status, stage });
          }
          if (mergeRedirect.status >= 300) {
            if (!nextRedirect) {
              throw googleError("AUTH_REQUIRED", "Google returned an incomplete account session redirect.", ERROR_KINDS.TRANSPORT, { httpStatus: mergeRedirect.status, stage });
            }
            redirectUrl = nextRedirect;
          } else {
            redirectUrl = "";
          }
        }
      }
      stage = "rotate-cookies";
      try {
        var rotated = await request(this.effects, "POST", ROTATE_COOKIES_URL, {
          "Content-Type": "application/json",
          "Origin": "https://accounts.google.com"
        }, '[000,"-0000000000000000000"]');
        this.recordDiagnostic("rotate-cookies", { httpStatus: rotated.status, responseCharacters: rotated.text.length });
      } catch (_) {
        this.recordDiagnostic("rotate-cookies", { unavailable: true });
      }
    }
    stage = "maps-page";
    var mapsPageUrl = mapsUrl(MAPS_HOME_URL, account, { hl: "en" });
    var mapsPage = await request(this.effects, "GET", mapsPageUrl, browserHeaders);
    this.recordDiagnostic("maps-page", { httpStatus: mapsPage.status, responseCharacters: mapsPage.text.length });
    if (mapsPage.status === 401 || mapsPage.status === 403) {
      throw googleError("AUTH_REQUIRED", "Google Maps location sharing authorization expired. Sign in again.", ERROR_KINDS.TRANSPORT, { httpStatus: mapsPage.status, stage });
    }
    if (mapsPage.status < 200 || mapsPage.status >= 300) {
      throw googleError("GOOGLE_LOCATION_UNAVAILABLE", "Google Maps could not load the location-sharing session (HTTP " + mapsPage.status + ").", ERROR_KINDS.TRANSPORT, { httpStatus: mapsPage.status, stage: "maps-page" });
    }
    var tokens = mapsPageTokens(mapsPage.text);
    this.recordDiagnostic("maps-page-tokens", {
      hasXsrf: !!tokens.xsrf,
      hasKei: !!tokens.kei,
      accountBound: !!text(account.email)
    });
    var locationHeaders = Object.assign({}, browserHeaders, {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      "X-Same-Domain": "1",
      "Origin": "https://www.google.com",
      "Referer": "https://www.google.com/maps/"
    });
    stage = "location-sharing-rpc";
    var locationUrl = mapsUrl(LOCATION_URL, account, {
      rpcids: MAPS_RPC_ID,
      hl: "en",
      rt: "c"
    });
    var location = await request(this.effects, "POST", locationUrl, locationHeaders, mapsBatchBody(tokens));
    this.recordDiagnostic("location-sharing-rpc", {
      httpStatus: location.status,
      responseCharacters: location.text.length,
      hasRpcEnvelope: location.text.indexOf('[["wrb.fr"') !== -1
    });
    if (location.status === 401 || location.status === 403) {
      throw googleError("AUTH_REQUIRED", "Google Maps location sharing authorization expired. Sign in again.", ERROR_KINDS.TRANSPORT, { httpStatus: location.status, stage });
    }
    if (location.status < 200 || location.status >= 300) {
      throw googleError(
        "GOOGLE_LOCATION_UNAVAILABLE",
        "Google Maps location sharing request failed (HTTP " + location.status + ").",
        ERROR_KINDS.TRANSPORT,
        { httpStatus: location.status, stage: "location-sharing-rpc" }
      );
    }
    this.people = parseLocationResponse(location.text);
    this.storage.set(STORE_CACHE, JSON.stringify(this.people));
    this.recordDiagnostic("parse-success", { peopleCount: this.people.length });
    return this.people.slice();
  } catch (error) {
    this.recordDiagnostic("refresh-error", diagnosticFailure(error, stage));
    throw error;
  }
};
GoogleMapsClient.prototype.cached = function() {
  return this.people.slice();
};
GoogleMapsClient.prototype.clear = function() {
  [STORE_MASTER_TOKEN, STORE_OAUTH_TOKEN, STORE_ANDROID_ID, STORE_EMAIL, STORE_COOKIES, STORE_CACHE].forEach(this.storage.delete.bind(this.storage));
  this.people = [];
};
module.exports = {
  GoogleMapsClient,
  MAPS_RPC_ID,
  STORE_ANDROID_ID,
  STORE_COOKIES,
  STORE_DIAGNOSTICS,
  STORE_MASTER_TOKEN,
  STORE_OAUTH_TOKEN,
  exchangeOAuthToken,
  issueWebLoginToken,
  parseLocationResponse
};
