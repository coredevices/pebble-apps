'use strict';
var RuntimeError = require('../../../chat/imessage/src/runtime/errors').RuntimeError;
var ERROR_KINDS = require('../../../chat/imessage/src/runtime/errors').ERROR_KINDS;
function pageStatus(status) {
  if (status && status.ready === true && status.phase === "ready") return "ready";
  if (status && status.phase === "needs-two-factor") return "needsTwoFactor";
  return "disconnected";
}
function safeFailure(error, operation) {
  if (error instanceof RuntimeError) {
    if (error.code === "AUTH_REQUIRED" || error.code === "CREDENTIALS_REQUIRED" || error.code === "MAC_AUTHORIZATION_REQUIRED" || error.code === "MAC_VALIDATION_REQUIRED" || error.code === "INVALID_TWO_FACTOR_CODE") {
      return { code: "AUTH_REQUIRED", message: error.message || "Sign in to Find My again." };
    }
    if (error.code === "RATE_LIMITED") return { code: "RATE_LIMITED", message: error.message };
    if (error.kind === ERROR_KINDS.INVALID_INPUT) {
      return { code: "INVALID_ARGS", message: error.message || "Find My setup input is invalid." };
    }
  }
  return operation === "configure" ? { code: "PLUGIN_UNAVAILABLE", message: "Find My setup could not be completed." } : { code: "PLUGIN_UNAVAILABLE", message: "Apple Find My is unavailable." };
}
function shortText(text) {
  return { shortText: { text: String(text) } };
}
function textReading(text) {
  return { shortText: { text: String(text) }, longText: { text: String(text) } };
}
function booleanReading(value) {
  return { boolean: { value: !!value }, shortText: { text: value ? "Connected" : "Not connected" } };
}
function numberReading(value) {
  return { numericValue: { value } };
}
function timestampReading(value) {
  return { timestamp: { value: Math.floor(value / 1e3) } };
}
function mapsUrl(friend) {
  if (!Number.isFinite(friend.latitude) || !Number.isFinite(friend.longitude)) return null;
  return "https://maps.apple.com/?ll=" + friend.latitude + "," + friend.longitude + "&q=" + encodeURIComponent(friend.name);
}
function friendProperties(friend) {
  var properties = {
    name: shortText(friend.name),
    configured: booleanReading(true),
    address: textReading(friend.address || "Location shared without an address"),
    stale: booleanReading(friend.isOld)
  };
  if (Number.isFinite(friend.latitude)) properties.latitude = numberReading(friend.latitude);
  if (Number.isFinite(friend.longitude)) properties.longitude = numberReading(friend.longitude);
  if (Number.isFinite(friend.accuracyMeters)) properties.accuracyMeters = numberReading(friend.accuracyMeters);
  if (Number.isFinite(friend.timestampMs)) properties.updatedAt = timestampReading(friend.timestampMs);
  var url = mapsUrl(friend);
  if (url) properties.url = { longText: { text: url } };
  return properties;
}
function normalizeQuery(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9@+]+/g, " ").replace(/\s+/g, " ");
}
function matchingFriends(friends, query) {
  var needle = normalizeQuery(query);
  if (!needle) return friends.slice();
  var exact = friends.filter(function(friend) {
    return [friend.name].concat(friend.handles || []).some(function(candidate) {
      return normalizeQuery(candidate) === needle;
    });
  });
  if (exact.length) return exact;
  return friends.filter(function(friend) {
    return [friend.name].concat(friend.handles || []).some(function(candidate) {
      var normalized = normalizeQuery(candidate);
      return normalized.indexOf(needle) !== -1 || needle.indexOf(normalized) !== -1;
    });
  });
}
function ageText(timestampMs, nowMs) {
  if (!Number.isFinite(timestampMs)) return "at an unknown time";
  var seconds = Math.max(0, Math.round((nowMs - timestampMs) / 1e3));
  if (seconds < 60) return seconds + " seconds ago";
  var minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  var hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  var days = Math.round(hours / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}
function friendSummary(friend, nowMs) {
  if (!Number.isFinite(friend.latitude) || !Number.isFinite(friend.longitude)) {
    return friend.name + " is sharing with you, but Find My did not return a location.";
  }
  var place = friend.address || friend.latitude.toFixed(5) + ", " + friend.longitude.toFixed(5);
  var freshness = ageText(friend.timestampMs, nowMs);
  return friend.name + (friend.isOld ? " was last seen at " : " is at ") + place + " (" + freshness + ").";
}
function configReply(status, friends) {
  return {
    ok: true,
    status: pageStatus(status),
    ready: status && status.ready === true,
    canSubmitTwoFactor: status && status.canSubmitTwoFactor === true,
    friends: (friends || []).map(function(friend) {
      return { id: friend.id, name: friend.name, address: friend.address, updatedAt: friend.timestampMs };
    })
  };
}
function FindMyController(options) {
  if (!options || !options.configuration || !options.client || typeof options.prepareConfiguration !== "function") {
    throw new TypeError("Find My controller dependencies are unavailable.");
  }
  this.configuration = options.configuration;
  this.client = options.client;
  this.prepareConfiguration = options.prepareConfiguration;
  this.now = typeof options.now === "function" ? options.now : Date.now;
  this.busy = false;
}
FindMyController.prototype.handleSource = async function(request, respond) {
  if (!request || request.category !== "people" || request.item !== "location") {
    respond.error("PLUGIN_UNAVAILABLE", "Unsupported Find My source.");
    return;
  }
  var status = this.configuration.status();
  if (!status.ready) {
    respond.data({ validUntilMs: this.now() + 6e4, instances: [] });
    return;
  }
  try {
    var friends = await this.client.refresh(null);
    respond.data({
      validUntilMs: this.now() + 6e4,
      instances: friends.map(function(friend) {
        return { instanceId: friend.id, properties: friendProperties(friend) };
      })
    });
  } catch (error) {
    var failure = safeFailure(error, "read");
    respond.error(failure.code, failure.message);
  }
};
FindMyController.prototype.handleAction = async function(request, respond) {
  if (!request || request.action !== "find_friend") {
    respond.error("PLUGIN_UNAVAILABLE", "Unknown Find My action.");
    return;
  }
  if (!this.configuration.status().ready) {
    respond.error("AUTH_REQUIRED", "Configure Find My first.");
    return;
  }
  if (this.busy) {
    respond.error("PLUGIN_UNAVAILABLE", "A Find My refresh is already in progress.");
    return;
  }
  var args = request.args || {};
  var query = typeof args.friend === "string" ? args.friend.trim() : "";
  this.busy = true;
  try {
    var cached = this.client.cached();
    var preselected = matchingFriends(cached, query);
    var selectedId = preselected.length === 1 ? preselected[0].id : null;
    var friends = await this.client.refresh(selectedId);
    var matches = matchingFriends(friends, query);
    if (matches.length === 0) {
      respond.error("INVALID_ARGS", query ? "No friend sharing a location matched “" + query + "”." : "No friends are currently sharing a location with this Apple account.");
      return;
    }
    if (query && matches.length > 1) {
      respond.error("INVALID_ARGS", "More than one sharing friend matched “" + query + "”. Use a fuller name.");
      return;
    }
    var shown = query ? matches.slice(0, 1) : matches.slice(0, 10);
    var nowMs = this.now();
    var summaries = shown.map(function(friend) {
      return friendSummary(friend, nowMs);
    });
    var url = shown.length === 1 ? mapsUrl(shown[0]) : "https://www.icloud.com/find/";
    respond.ok({
      text: summaries.join(" "),
      data: { provider: "Find My", friends: shown },
      url,
      refreshed: ["people/location"]
    });
  } catch (error) {
    var failure = safeFailure(error, "read");
    respond.error(failure.code, failure.message);
  } finally {
    this.busy = false;
  }
};
FindMyController.prototype.handleConfig = async function(message) {
  try {
    switch (message && message.type) {
      case "status":
        return configReply(this.configuration.status(), this.client.cached());
      case "configure": {
        var credentials = {
          macValidationData: String(message.macValidationData || "").trim(),
          username: String(message.appleId || "").trim(),
          password: String(message.password || "")
        };
        if (!credentials.macValidationData || !credentials.username || !credentials.password) {
          return { ok: false, code: "INVALID_ARGS", message: "Mac + RustPush token, Apple ID, and password are required." };
        }
        try {
          this.configuration.validateConfigurationInput(credentials);
          await this.prepareConfiguration();
          return configReply(await this.configuration.configure(credentials), this.client.cached());
        } finally {
          credentials.password = "";
          credentials.macValidationData = "";
          credentials = null;
        }
      }
      case "submitTwoFactorCode": {
        var code = String(message.code || "").trim();
        if (!/^[0-9]{6}$/.test(code)) {
          return { ok: false, code: "INVALID_ARGS", message: "Enter the six-digit verification code." };
        }
        var reply = configReply(await this.configuration.submitTwoFactor(code), this.client.cached());
        code = "";
        return reply;
      }
      case "refresh":
        return configReply(this.configuration.status(), await this.client.refresh(null));
      case "disconnect":
        this.client.clear();
        return configReply(await this.configuration.disconnect(), []);
      default:
        return { ok: false, code: "INVALID_REQUEST", message: "Unknown Find My settings request." };
    }
  } catch (error) {
    var failure = safeFailure(error, "configure");
    return {
      ok: false,
      code: failure.code,
      message: failure.message,
      status: pageStatus(this.configuration.status())
    };
  }
};
module.exports = {
  FindMyController,
  friendProperties,
  friendSummary,
  matchingFriends,
  safeFailure
};
