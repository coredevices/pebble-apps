'use strict';
var RuntimeError = require('../../../chat/imessage/src/runtime/errors').RuntimeError;
var ERROR_KINDS = require('../../../chat/imessage/src/runtime/errors').ERROR_KINDS;
var FindMyController = require('../findmy/controller').FindMyController;
var maps = require('./maps');
var PROVIDERS = Object.freeze({
  APPLE: "apple_find_my",
  GOOGLE: "google_maps"
});
function shortText(value) {
  return { shortText: { text: String(value) } };
}
function textReading(value) {
  return { shortText: { text: String(value) }, longText: { text: String(value) } };
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
function normalizeQuery(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9@+]+/g, " ").replace(/\s+/g, " ");
}
function withoutMy(value) {
  return normalizeQuery(value).replace(/^my /, "");
}
function matchingPeople(people, query, nicknames) {
  var needle = withoutMy(query);
  if (!needle) return people.slice();
  function candidates(person) {
    var nickname = nicknames && nicknames[person.id];
    return [person.name].concat(person.handles || []).concat(nickname ? [withoutMy(nickname)] : []);
  }
  var exact = people.filter(function(person) {
    return candidates(person).some(function(candidate) {
      return normalizeQuery(candidate) === needle;
    });
  });
  if (exact.length) return exact;
  return people.filter(function(person) {
    return candidates(person).some(function(candidate) {
      var normalized = normalizeQuery(candidate);
      return normalized && (normalized.indexOf(needle) !== -1 || needle.indexOf(normalized) !== -1);
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
function personUrl(person) {
  if (!Number.isFinite(person.latitude) || !Number.isFinite(person.longitude)) return null;
  if (person.providerId === PROVIDERS.APPLE) {
    return "https://maps.apple.com/?ll=" + person.latitude + "," + person.longitude + "&q=" + encodeURIComponent(person.name);
  }
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(person.latitude + "," + person.longitude);
}
function personProperties(person) {
  var properties = {
    name: shortText(person.name),
    provider: shortText(person.provider),
    configured: booleanReading(true),
    address: textReading(person.address || "Location shared without an address"),
    stale: booleanReading(person.isOld)
  };
  if (Number.isFinite(person.latitude)) properties.latitude = numberReading(person.latitude);
  if (Number.isFinite(person.longitude)) properties.longitude = numberReading(person.longitude);
  if (Number.isFinite(person.accuracyMeters)) properties.accuracyMeters = numberReading(person.accuracyMeters);
  if (Number.isFinite(person.timestampMs)) properties.updatedAt = timestampReading(person.timestampMs);
  var url = personUrl(person);
  if (url) properties.url = { longText: { text: url } };
  return properties;
}
var SETTINGS_KEY = "location-sharing-answer-settings";
var MODE_NAMES = { drive: "drive", bike: "bike", walk: "walk" };
var MAX_PLACES = 20;
// "auto" shows walking and biking times when either is under this, otherwise driving.
var AUTO_LIMIT_SECONDS = 20 * 60;
function defaultSettings() {
  return { show: { auto: true, drive: false, bike: false, walk: false }, nicknames: {}, places: [] };
}
function cleanText(value, max) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}
/** "my wife" reads as "Your wife"; anything else is used as typed. */
function displayName(person, nicknames) {
  var nickname = cleanText(nicknames[person.id], 40);
  if (!nickname) return person.name;
  return /^my\s/i.test(nickname) ? "Your " + nickname.slice(3) : nickname;
}
function placeAt(person, places) {
  var best = null;
  places.forEach(function(place) {
    var meters = maps.straightLineMeters(person, place);
    if (meters <= place.radiusMeters && (!best || meters < best.meters)) best = { place: place, meters: meters };
  });
  return best && best.place;
}
function shortAddress(address) {
  return String(address).split(",").slice(0, 2).join(",").trim();
}
/** One notification-sized line: where they are, how fresh, and the travel times asked for. */
function answerText(person, settings, routes, nowMs) {
  var name = displayName(person, settings.nicknames);
  if (!Number.isFinite(person.latitude) || !Number.isFinite(person.longitude)) {
    return name + " is sharing, but no current location came back.";
  }
  var place = placeAt(person, settings.places);
  var where = place ? place.label : person.address ? shortAddress(person.address) :
    person.latitude.toFixed(4) + ", " + person.longitude.toFixed(4);
  var text = name + (person.isOld ? " was last seen at " : " is at ") + where;
  var trips = Object.keys(MODE_NAMES).filter(function(mode) { return routes[mode]; });
  if (trips.length) {
    text += ", " + trips.map(function(mode) { return routes[mode].duration + " " + MODE_NAMES[mode]; }).join(" or ") +
      " away (" + routes[trips[0]].distance + ")";
  }
  return text + ". Updated " + ageText(person.timestampMs, nowMs) + ".";
}
function withProvider(person, providerId, providerName) {
  var result = Object.assign({}, person);
  result.rawId = String(person.id);
  result.id = providerId + ":" + person.id;
  result.providerId = providerId;
  result.provider = providerName;
  return result;
}
function providerFailure(error, providerName) {
  if (error instanceof RuntimeError) {
    if (error.code === "AUTH_REQUIRED") return { code: "AUTH_REQUIRED", message: error.message };
    if (error.code === "RATE_LIMITED") return { code: "RATE_LIMITED", message: error.message };
    if (error.kind === ERROR_KINDS.INVALID_INPUT) {
      return { code: "INVALID_ARGS", message: error.message };
    }
    return { code: error.code || "PLUGIN_UNAVAILABLE", message: error.message };
  }
  return { code: "PLUGIN_UNAVAILABLE", message: providerName + " location sharing is unavailable." };
}
function providerStatus(controller) {
  var appleStatus = controller.appleConfiguration.status();
  var googleStatus = controller.googleClient.status();
  return {
    apple: {
      status: appleStatus.ready === true && appleStatus.phase === "ready" ? "ready" : appleStatus.phase === "needs-two-factor" ? "needsTwoFactor" : "disconnected",
      ready: appleStatus.ready === true,
      canSubmitTwoFactor: appleStatus.canSubmitTwoFactor === true
    },
    google: googleStatus
  };
}
function configReply(controller, result) {
  var status = providerStatus(controller);
  var applePeople = controller.appleClient.cached().map(function(person) {
    return withProvider(person, PROVIDERS.APPLE, "Apple Find My");
  });
  var googlePeople = controller.googleClient.cached().map(function(person) {
    return withProvider(person, PROVIDERS.GOOGLE, "Google Maps");
  });
  return Object.assign({
    ok: true,
    pluginVersion: "0.13.1",
    settings: controller.settings(),
    apple: status.apple,
    google: status.google,
    people: applePeople.concat(googlePeople).map(function(person) {
      return {
        id: person.id,
        name: person.name,
        provider: person.provider,
        address: person.address,
        nickname: controller.settings().nicknames[person.id] || "",
        updatedAt: person.timestampMs
      };
    })
  }, result || {});
}
function LocationSharingController(options) {
  if (!options || !options.appleConfiguration || !options.appleClient || !options.googleClient || typeof options.prepareAppleConfiguration !== "function") {
    throw new TypeError("Location Sharing controller dependencies are unavailable.");
  }
  this.appleConfiguration = options.appleConfiguration;
  this.appleClient = options.appleClient;
  this.googleClient = options.googleClient;
  this.now = typeof options.now === "function" ? options.now : Date.now;
  this.http = options.http || null;
  this.storage = options.storage || null;
  this.currentPosition = typeof options.currentPosition === "function" ? options.currentPosition : async function() { return null; };
  this.appleController = new FindMyController({
    configuration: options.appleConfiguration,
    client: options.appleClient,
    prepareConfiguration: options.prepareAppleConfiguration,
    now: this.now
  });
  this.busy = false;
}
LocationSharingController.prototype.settings = function() {
  var settings = defaultSettings();
  try {
    var saved = JSON.parse(this.storage && this.storage.get(SETTINGS_KEY) || "{}");
    Object.keys(settings.show).forEach(function(mode) {
      if (saved.show) settings.show[mode] = !!saved.show[mode];
    });
    if (saved.nicknames && typeof saved.nicknames === "object") settings.nicknames = saved.nicknames;
    if (Array.isArray(saved.places)) settings.places = saved.places;
  } catch (_) {
  }
  return settings;
};
LocationSharingController.prototype.saveSettings = function(settings) {
  this.storage.set(SETTINGS_KEY, JSON.stringify(settings));
};
/** Travel times from the phone's current position for the modes turned on in settings. */
LocationSharingController.prototype.routesTo = async function(person, settings) {
  var chosen = Object.keys(MODE_NAMES).filter(function(mode) { return settings.show[mode]; });
  var modes = settings.show.auto ? Object.keys(MODE_NAMES) : chosen;
  if (!modes.length || !this.http || !Number.isFinite(person.latitude) || !Number.isFinite(person.longitude)) return {};
  var origin = await this.currentPosition();
  if (!origin) return {};
  var http = this.http;
  var found = await Promise.all(modes.map(function(mode) {
    return maps.route(http, origin, person, mode).catch(function() { return null; });
  }));
  var all = {};
  modes.forEach(function(mode, index) { if (found[index]) all[mode] = found[index]; });
  return pickRoutes(all, settings.show);
};

/** The routes to show: every mode checked, plus for "auto" walk and bike if either is quick, else drive. */
function pickRoutes(all, show) {
  var picked = Object.keys(MODE_NAMES).filter(function(mode) { return show[mode]; });
  if (show.auto) {
    var quick = ["walk", "bike"].filter(function(mode) { return all[mode] && all[mode].seconds < AUTO_LIMIT_SECONDS; });
    picked = picked.concat(quick.length ? quick : ["drive"]);
  }
  var routes = {};
  picked.forEach(function(mode) { if (all[mode]) routes[mode] = all[mode]; });
  return routes;
}
LocationSharingController.prototype.readyProviders = function(requestedProvider) {
  var providers = [];
  if ((!requestedProvider || requestedProvider === PROVIDERS.APPLE) && this.appleConfiguration.status().ready === true) {
    providers.push({ id: PROVIDERS.APPLE, name: "Apple Find My", client: this.appleClient });
  }
  if ((!requestedProvider || requestedProvider === PROVIDERS.GOOGLE) && this.googleClient.status().configured === true) {
    providers.push({ id: PROVIDERS.GOOGLE, name: "Google Maps", client: this.googleClient });
  }
  return providers;
};
LocationSharingController.prototype.refreshProviders = async function(providers, query) {
  var people = [];
  var failures = [];
  for (var index = 0; index < providers.length; index += 1) {
    var provider = providers[index];
    try {
      var selectedId = null;
      if (provider.id === PROVIDERS.APPLE && query) {
        var cached = provider.client.cached().map(function(person) {
          return withProvider(person, provider.id, provider.name);
        });
        var cachedMatches = matchingPeople(cached, query);
        selectedId = cachedMatches.length === 1 ? cachedMatches[0].rawId : null;
      }
      var refreshed = await provider.client.refresh(selectedId);
      people = people.concat(refreshed.map(function(person) {
        return withProvider(person, provider.id, provider.name);
      }));
    } catch (error) {
      var failure = providerFailure(error, provider.name);
      console.error(provider.name + " refresh failed: " + failure.code);
      failures.push(failure);
    }
  }
  return { people, failures };
};
LocationSharingController.prototype.handleSource = async function(request, respond) {
  if (!request || request.category !== "people" || request.item !== "location") {
    console.error("Unsupported source: " + (request && request.category) + "/" + (request && request.item));
    respond.error("PLUGIN_UNAVAILABLE", "Unsupported Location Sharing source.");
    return;
  }
  var providers = this.readyProviders(null);
  if (!providers.length) {
    respond.data({ validUntilMs: this.now() + 6e4, instances: [] });
    return;
  }
  var result = await this.refreshProviders(providers, "");
  if (!result.people.length && result.failures.length) {
    respond.error(result.failures[0].code, result.failures[0].message);
    return;
  }
  respond.data({
    validUntilMs: this.now() + 6e4,
    instances: result.people.map(function(person) {
      return { instanceId: person.id, properties: personProperties(person) };
    })
  });
};
LocationSharingController.prototype.handleAction = async function(request, respond) {
  if (!request || request.action !== "find_person") {
    console.error("Unsupported action: " + (request && request.action));
    respond.error("PLUGIN_UNAVAILABLE", "Unknown Location Sharing action.");
    return;
  }
  if (this.busy) {
    respond.error("PLUGIN_UNAVAILABLE", "Location sharing is already refreshing.");
    return;
  }
  var args = request.args || {};
  var query = typeof args.person === "string" ? args.person.trim() : typeof args.friend === "string" ? args.friend.trim() : "";
  var requestedProvider = typeof args.provider === "string" ? args.provider : "";
  if (requestedProvider && requestedProvider !== PROVIDERS.APPLE && requestedProvider !== PROVIDERS.GOOGLE) {
    respond.error("INVALID_ARGS", "Choose Apple Find My or Google Maps as the provider.");
    return;
  }
  var providers = this.readyProviders(requestedProvider || null);
  if (!providers.length) {
    respond.error("AUTH_REQUIRED", requestedProvider === PROVIDERS.APPLE ? "Connect Apple Find My in Location Sharing settings." : requestedProvider === PROVIDERS.GOOGLE ? "Connect Google Maps in Location Sharing settings." : "Connect Apple Find My or Google Maps in Location Sharing settings.");
    return;
  }
  this.busy = true;
  try {
    var settings = this.settings();
    var result = await this.refreshProviders(providers, query);
    var matches = matchingPeople(result.people, query, settings.nicknames);
    if (!matches.length) {
      if (!result.people.length && result.failures.length) {
        respond.error(result.failures[0].code, result.failures[0].message);
      } else {
        respond.error("INVALID_ARGS", query ? "No person sharing a location matched “" + query + "”." : "No people are currently sharing a location through the connected providers.");
      }
      return;
    }
    if (query && matches.length > 1) {
      respond.error("INVALID_ARGS", "More than one sharing person matched “" + query + "”. Use a fuller name or choose a provider.");
      return;
    }
    var shown = query ? matches.slice(0, 1) : matches.slice(0, 10);
    var routes = query ? await this.routesTo(shown[0], settings) : {};
    var now = this.now();
    respond.ok({
      text: shown.map(function(person) {
        return answerText(person, settings, query ? routes : {}, now);
      }).join(" "),
      data: {
        provider: shown.length === 1 ? shown[0].provider : "Location Sharing",
        people: shown
      },
      url: shown.length === 1 ? personUrl(shown[0]) : "https://www.google.com/maps",
      refreshed: ["people/location"]
    });
  } finally {
    this.busy = false;
  }
};
LocationSharingController.prototype.handleConfig = async function(message) {
  try {
    switch (message && message.type) {
      case "status":
        return configReply(this);
      case "configureApple":
      case "configure": {
        var apple = await this.appleController.handleConfig({
          type: "configure",
          macValidationData: message.macValidationData,
          appleId: message.appleId,
          password: message.password
        });
        return apple.ok === false ? apple : configReply(this);
      }
      case "submitAppleTwoFactorCode":
      case "submitTwoFactorCode": {
        var verified = await this.appleController.handleConfig({
          type: "submitTwoFactorCode",
          code: message.code
        });
        return verified.ok === false ? verified : configReply(this);
      }
      case "refreshApple":
        await this.appleClient.refresh(null);
        return configReply(this);
      case "disconnectApple":
      case "disconnect":
        await this.appleController.handleConfig({ type: "disconnect" });
        return configReply(this);
      case "setGoogleCredentials":
        this.googleClient.setCredentials(message);
        return configReply(this);
      case "googleWebLoginUrl":
        return Object.assign(configReply(this), { url: await this.googleClient.webLoginUrl() });
      case "testGoogleConnection":
      case "refreshGoogle":
        await this.googleClient.refresh(null);
        return configReply(this);
      case "disconnectGoogle":
        this.googleClient.clear();
        return configReply(this);
      case "saveAnswerSettings": {
        var updated = this.settings();
        Object.keys(updated.show).forEach(function(mode) { updated.show[mode] = !!(message.show && message.show[mode]); });
        var nicknames = {};
        Object.keys(message.nicknames || {}).forEach(function(id) {
          var nickname = cleanText(message.nicknames[id], 40);
          if (nickname && typeof id === "string" && id.length <= 200) nicknames[id] = nickname;
        });
        updated.nicknames = nicknames;
        this.saveSettings(updated);
        return configReply(this);
      }
      case "addPlace": {
        var label = cleanText(message.label, 40);
        var address = cleanText(message.address, 200);
        var radius = Math.round(Number(message.radiusMeters));
        if (!label || !address) return Object.assign(configReply(this), { ok: false, message: "Enter a name and an address for the place." });
        if (!Number.isFinite(radius) || radius < 25 || radius > 5000) radius = 150;
        var places = this.settings();
        if (places.places.length >= MAX_PLACES) return Object.assign(configReply(this), { ok: false, message: "You can save up to " + MAX_PLACES + " places." });
        var point = this.http ? await maps.geocode(this.http, address) : null;
        if (!point) return Object.assign(configReply(this), { ok: false, message: "Google Maps couldn't find that address." });
        places.places.push({ label: label, address: address, latitude: point.latitude, longitude: point.longitude, radiusMeters: radius });
        this.saveSettings(places);
        return configReply(this);
      }
      case "removePlace": {
        var remaining = this.settings();
        var index = Number(message.index);
        if (Number.isInteger(index) && index >= 0 && index < remaining.places.length) remaining.places.splice(index, 1);
        this.saveSettings(remaining);
        return configReply(this);
      }
      default:
        console.error("Unsupported settings request: " + (message && message.type));
        return { ok: false, code: "INVALID_REQUEST", message: "Unknown Location Sharing settings request." };
    }
  } catch (error) {
    var provider = message && String(message.type || "").toLowerCase().indexOf("google") !== -1 ? "Google Maps" : "Apple Find My";
    var failure = providerFailure(error, provider);
    console.error("Settings " + (message && message.type) + " failed: " + failure.code);
    return Object.assign(configReply(this), { ok: false, code: failure.code, message: failure.message });
  }
};
module.exports = {
  LocationSharingController,
  PROVIDERS,
  answerText,
  pickRoutes,
  matchingPeople,
  personProperties,
  personUrl,
  withProvider
};
