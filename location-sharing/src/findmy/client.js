'use strict';
var bytes = require('../../../imessage/src/runtime/bytes');
var RuntimeError = require('../../../imessage/src/runtime/errors').RuntimeError;
var ERROR_KINDS = require('../../../imessage/src/runtime/errors').ERROR_KINDS;
var STATE_KEY = "find-my-fmf-runtime-v1";
var SERVER_MIN = 101;
var SERVER_COUNT = 82;
function findMyError(code, message, kind, details) {
  return new RuntimeError(code, message, {
    kind: kind || ERROR_KINDS.INVALID_INPUT,
    details
  });
}
function string(value) {
  return typeof value === "string" ? value.trim() : "";
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function array(value) {
  return Array.isArray(value) ? value : [];
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function base64Authorization(username, password) {
  if (!string(username) || !string(password) || /[\u0000-\u0020\u007f:]/.test(username)) {
    throw findMyError("FIND_MY_PROTOCOL_ERROR", "Find My authorization is malformed.");
  }
  return "Basic " + bytes.bytesToBase64(bytes.utf8ToBytes(username + ":" + password));
}
function replaceHeader(headers, name, value) {
  var lower = name.toLowerCase();
  var result = array(headers).filter(function(header) {
    return Array.isArray(header) && String(header[0]).toLowerCase() !== lower;
  }).map(function(header) {
    return [String(header[0]), String(header[1])];
  });
  result.push([name, value]);
  return result;
}
function mmeClientInfo(runtime) {
  return "<" + runtime.productType + "> <macOS;" + runtime.productVersion + ";" + runtime.buildVersion + "> <com.apple.AuthKit/1 (com.apple.findmy/375.20)>";
}
function fmfHeaders(runtime) {
  var firstICloudUaPart = string(runtime.icloudUa).split(/\s/)[0];
  var headers = replaceHeader(runtime.anisetteHeaders, "X-Mme-Client-Info", mmeClientInfo(runtime));
  [
    ["User-Agent", "FMFD/1.0 " + firstICloudUaPart],
    ["X-Apple-Realm-Support", "1.0"],
    ["X-Apple-AuthScheme", "Forever"],
    ["X-Apple-Find-API-Ver", "2.0"],
    ["Accept-Language", "en-US,en;q=0.9"],
    ["Accept", "application/json"],
    ["Content-Type", "application/json"],
    ["X-Apple-I-Locale", "en_US"],
    ["X-FMF-Model-Version", "1"],
    ["Authorization", base64Authorization(runtime.dsid, runtime.fmfToken)]
  ].forEach(function(entry) {
    headers = replaceHeader(headers, entry[0], entry[1]);
  });
  return Object.freeze(headers.map(function(header) {
    return Object.freeze(header);
  }));
}
function defaultState(randomBytes) {
  var sample = randomBytes(2);
  return {
    version: 1,
    server: SERVER_MIN + sample[0] % SERVER_COUNT,
    processId: String(600 + (sample[0] * 256 + sample[1]) % 1400),
    hasInit: false,
    dataContext: {},
    serverContext: {},
    followers: [],
    following: [],
    contactDetails: []
  };
}
function restoreState(storage, randomBytes) {
  var raw = storage.get(STATE_KEY);
  if (!raw) return defaultState(randomBytes);
  try {
    var state = JSON.parse(raw);
    if (state.version !== 1 || !Number.isInteger(state.server) || state.server < SERVER_MIN || state.server >= SERVER_MIN + SERVER_COUNT || !/^[0-9]{3,4}$/.test(state.processId)) throw new Error("invalid");
    state.hasInit = state.hasInit === true;
    state.dataContext = record(state.dataContext);
    state.serverContext = record(state.serverContext);
    state.followers = array(state.followers);
    state.following = array(state.following);
    state.contactDetails = array(state.contactDetails);
    return state;
  } catch (_) {
    storage.delete(STATE_KEY);
    return defaultState(randomBytes);
  }
}
function friendId(friend) {
  return string(record(friend).id);
}
function applyUpdate(state, update) {
  update = record(update);
  if (Array.isArray(update.followers)) state.followers = clone(update.followers);
  if (Array.isArray(update.contactDetails)) state.contactDetails = clone(update.contactDetails);
  if (Array.isArray(update.following)) {
    var oldById = {};
    state.following.forEach(function(friend) {
      var id = friendId(friend);
      if (id) oldById[id] = friend;
    });
    state.following = clone(update.following).map(function(friend) {
      var previous = oldById[friendId(friend)];
      if (previous && previous.lastLocation !== void 0) friend.lastLocation = previous.lastLocation;
      return friend;
    });
  }
  array(update.locations).forEach(function(element) {
    var id = friendId(element);
    var friend = state.following.find(function(candidate) {
      return friendId(candidate) === id;
    });
    if (friend) friend.lastLocation = element.location === void 0 ? null : clone(element.location);
  });
  if (Array.isArray(update.locateInProgress)) {
    state.following.forEach(function(friend) {
      friend.locateInProgress = false;
    });
    update.locateInProgress.forEach(function(entry) {
      var friend = state.following.find(function(candidate) {
        return friendId(candidate) === friendId(entry);
      });
      if (friend) friend.locateInProgress = true;
    });
  }
  state.dataContext = record(update.dataContext);
  state.serverContext = record(update.serverContext);
  state.hasInit = true;
  return state;
}
function clientContext(runtime, state, selectedFriend, nowMs) {
  return {
    appName: "fmfd",
    appVersion: "7.0",
    apsToken: bytes.bytesToHex(runtime.apsToken).toUpperCase(),
    buildVersion: runtime.buildVersion,
    countryCode: "CA",
    currentTime: nowMs / 1e3,
    deviceClass: "Mac",
    deviceHasPasscode: true,
    deviceUDID: runtime.udid.toLowerCase(),
    fencingEnabled: true,
    isFMFAppRemoved: false,
    osVersion: runtime.productVersion,
    platform: "macosx",
    processId: state.processId,
    productType: runtime.productType,
    selectedFriend: selectedFriend || null,
    regionCode: "US",
    signedInAs: runtime.username,
    timezone: "America/Los_Angeles",
    unlockState: 0
  };
}
function buildRequest(runtime, state, selectedFriend, nowMs) {
  var path = !state.hasInit ? "initClient" : selectedFriend ? "minCallback/selFriend/refreshClient" : "minCallback/refreshClient";
  var url = "https://p" + state.server + "-fmfmobile.icloud.com/fmipservice/friends/fmfd/" + encodeURIComponent(runtime.dsid) + "/" + encodeURIComponent(runtime.udid.toUpperCase()) + "/" + path;
  return Object.freeze({
    method: "POST",
    url,
    headers: fmfHeaders(runtime),
    body: bytes.utf8ToBytes(JSON.stringify({
      clientContext: clientContext(runtime, state, selectedFriend, nowMs),
      dataContext: state.dataContext,
      serverContext: state.serverContext
    })),
    maxResponseBytes: 4 * 1024 * 1024
  });
}
function parseResponse(response) {
  if (!response || !Number.isInteger(response.status) || !(response.body instanceof Uint8Array)) {
    throw findMyError("FIND_MY_NETWORK_ERROR", "Find My returned a malformed response.", ERROR_KINDS.TRANSPORT);
  }
  if (response.status === 401 || response.status === 403) {
    throw findMyError("AUTH_REQUIRED", "Apple authorization expired. Sign in to Find My again.");
  }
  if (response.status === 429) {
    throw findMyError("RATE_LIMITED", "Find My is refreshing too quickly. Try again shortly.");
  }
  if (response.status < 200 || response.status >= 300) {
    throw findMyError("FIND_MY_UNAVAILABLE", "Apple Find My is unavailable.", ERROR_KINDS.TRANSPORT, {
      httpStatus: response.status
    });
  }
  try {
    var parsed = JSON.parse(bytes.bytesToUtf8(response.body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed;
  } catch (_) {
    throw findMyError("FIND_MY_PROTOCOL_ERROR", "Find My returned an unexpected response.");
  }
}
function contactFor(state, id) {
  return state.contactDetails.find(function(contact) {
    return friendId(contact) === id;
  }) || {};
}
function handleList(friend, contact) {
  var values = [];
  ["emails", "phones", "invitationAcceptedHandles", "invitationFromHandles"].forEach(function(key) {
    array(contact[key]).concat(array(friend[key])).forEach(function(value) {
      value = string(value);
      if (value && values.indexOf(value) === -1) values.push(value);
    });
  });
  return values;
}
function friendName(friend, contact) {
  var direct = string(contact.displayName) || string(contact.name) || string(friend.displayName) || string(friend.name);
  if (direct) return direct;
  var combined = [contact.firstName, contact.lastName].map(string).filter(Boolean).join(" ");
  if (combined) return combined;
  return handleList(friend, contact)[0] || "Shared friend";
}
function locationTimestamp(location) {
  var value = location.locationTimestamp;
  if (!Number.isFinite(value)) value = location.timestamp;
  if (!Number.isFinite(value)) value = location.timeStamp;
  if (!Number.isFinite(value)) value = location.secureLocationTs;
  return Number.isFinite(value) ? value : null;
}
function formattedAddress(location) {
  var address = record(location.address);
  if (Array.isArray(address.formattedAddressLines)) {
    var lines = address.formattedAddressLines.map(string).filter(Boolean);
    if (lines.length) return lines.join(", ");
  }
  var parts = [address.streetAddress, address.locality, address.stateCode, address.country].map(string).filter(Boolean);
  return parts.join(", ");
}
function normalizedFriends(state) {
  return state.following.map(function(friend) {
    var id = friendId(friend);
    var contact = contactFor(state, id);
    var location = record(friend.lastLocation);
    return Object.freeze({
      id,
      name: friendName(friend, contact),
      handles: Object.freeze(handleList(friend, contact)),
      latitude: Number.isFinite(location.latitude) ? location.latitude : null,
      longitude: Number.isFinite(location.longitude) ? location.longitude : null,
      accuracyMeters: Number.isFinite(location.horizontalAccuracy) ? location.horizontalAccuracy : null,
      timestampMs: locationTimestamp(location),
      address: formattedAddress(location),
      isOld: location.isOld === true,
      locateInProgress: friend.locateInProgress === true
    });
  });
}
function FindMyFriendsClient(options) {
  if (!options || !options.effects || !options.configuration) throw new TypeError("Find My client dependencies are missing.");
  this.effects = options.effects;
  this.configuration = options.configuration;
  this.state = null;
}
FindMyFriendsClient.prototype.refresh = async function(selectedFriend) {
  if (this.state === null) {
    this.state = restoreState(this.effects.storage, this.effects.random.bytes.bind(this.effects.random));
  }
  var runtime = await this.configuration.findMyRuntime();
  var request = buildRequest(runtime, this.state, string(selectedFriend) || null, this.effects.clock.now());
  var response;
  try {
    response = await this.effects.http.request(request);
  } catch (_) {
    throw findMyError("FIND_MY_NETWORK_ERROR", "Could not reach Apple Find My.", ERROR_KINDS.TRANSPORT);
  }
  applyUpdate(this.state, parseResponse(response));
  this.effects.storage.set(STATE_KEY, JSON.stringify(this.state));
  return normalizedFriends(this.state);
};
FindMyFriendsClient.prototype.cached = function() {
  if (this.state === null) return [];
  return normalizedFriends(this.state);
};
FindMyFriendsClient.prototype.clear = function() {
  this.effects.storage.delete(STATE_KEY);
  this.state = null;
};
module.exports = {
  FindMyFriendsClient,
  STATE_KEY,
  applyUpdate,
  buildRequest,
  clientContext,
  fmfHeaders,
  normalizedFriends,
  parseResponse
};
