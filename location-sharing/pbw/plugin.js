/*! Blink Wasm interpreter
ISC License

Copyright 2022 Justine Alexandra Roberts Tunney

Permission to use, copy, modify, and/or distribute this software for
any purpose with or without fee is hereby granted, provided that the
above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL
DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

*/
"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // ../chat/imessage/src/runtime/errors.js
  var require_errors = __commonJS({
    "../chat/imessage/src/runtime/errors.js"(exports, module) {
      "use strict";
      var ERROR_KINDS = Object.freeze({
        INVALID_INPUT: "invalid-input",
        CAPABILITY: "capability",
        TRANSPORT: "transport",
        TIMEOUT: "timeout",
        CANCELLED: "cancelled",
        STORAGE: "storage",
        CRYPTO: "crypto",
        INTERNAL: "internal"
      });
      var RuntimeError = class extends Error {
        /**
         * @param {string} code
         * @param {string} message
         * @param {{kind?: string, retryable?: boolean, details?: unknown, cause?: unknown}=} options
         */
        constructor(code, message, options) {
          if (typeof code !== "string" || code.length === 0) {
            throw new TypeError("RuntimeError code must be a non-empty string.");
          }
          if (typeof message !== "string" || message.length === 0) {
            throw new TypeError("RuntimeError message must be a non-empty string.");
          }
          super(message);
          options = options || {};
          this.name = "RuntimeError";
          this.code = code;
          this.kind = options.kind || ERROR_KINDS.INTERNAL;
          this.retryable = options.retryable === true;
          if (options.details !== void 0) {
            this.details = options.details;
          }
          if (options.cause !== void 0) {
            Object.defineProperty(this, "cause", {
              configurable: true,
              value: options.cause,
              writable: true
            });
          }
        }
        /** @returns {{name: string, code: string, message: string, kind: string, retryable: boolean, details?: unknown}} */
        toJSON() {
          var result = {
            name: this.name,
            code: this.code,
            message: this.message,
            kind: this.kind,
            retryable: this.retryable
          };
          if (this.details !== void 0) {
            result.details = this.details;
          }
          return result;
        }
      };
      function isRuntimeError(value) {
        return value instanceof RuntimeError;
      }
      function asRuntimeError(value, fallbackCode, fallbackMessage, options) {
        if (isRuntimeError(value)) {
          return value;
        }
        var wrappedOptions = Object.assign({}, options || {}, { cause: value });
        return new RuntimeError(fallbackCode, fallbackMessage, wrappedOptions);
      }
      function deserializeRuntimeError(value) {
        if (!value || typeof value !== "object") {
          throw new TypeError("Serialized runtime error must be an object.");
        }
        var serialized = (
          /** @type {{code?: unknown, message?: unknown, kind?: unknown, retryable?: unknown, details?: unknown}} */
          value
        );
        if (typeof serialized.code !== "string" || typeof serialized.message !== "string") {
          throw new TypeError("Serialized runtime error is missing its code or message.");
        }
        if (serialized.kind !== void 0 && typeof serialized.kind !== "string") {
          throw new TypeError("Serialized runtime error kind must be a string.");
        }
        if (serialized.retryable !== void 0 && typeof serialized.retryable !== "boolean") {
          throw new TypeError("Serialized runtime error retryable flag must be boolean.");
        }
        return new RuntimeError(serialized.code, serialized.message, {
          kind: serialized.kind,
          retryable: serialized.retryable,
          details: serialized.details
        });
      }
      module.exports = {
        ERROR_KINDS,
        RuntimeError,
        asRuntimeError,
        deserializeRuntimeError,
        isRuntimeError
      };
    }
  });

  // ../chat/imessage/src/runtime/bytes.js
  var require_bytes = __commonJS({
    "../chat/imessage/src/runtime/bytes.js"(exports, module) {
      "use strict";
      var RuntimeError = require_errors().RuntimeError;
      var ERROR_KINDS = require_errors().ERROR_KINDS;
      var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      var HEX_ALPHABET = "0123456789abcdef";
      function assertBytes(value, name) {
        if (!(value instanceof Uint8Array)) {
          throw invalidInput((name || "value") + " must be a Uint8Array.");
        }
      }
      function invalidInput(message) {
        return new RuntimeError("INVALID_INPUT", message, { kind: ERROR_KINDS.INVALID_INPUT });
      }
      function copyBytes(bytes) {
        assertBytes(bytes, "bytes");
        return new Uint8Array(bytes);
      }
      function concatBytes() {
        var chunks = Array.prototype.slice.call(arguments);
        var totalLength = 0;
        for (var index = 0; index < chunks.length; index += 1) {
          assertBytes(chunks[index], "chunk " + index);
          totalLength += chunks[index].length;
          if (!Number.isSafeInteger(totalLength)) {
            throw invalidInput("Combined byte length is too large.");
          }
        }
        var result = new Uint8Array(totalLength);
        var offset = 0;
        for (var chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          result.set(chunks[chunkIndex], offset);
          offset += chunks[chunkIndex].length;
        }
        return result;
      }
      function bytesEqual(left, right) {
        assertBytes(left, "left");
        assertBytes(right, "right");
        if (left.length !== right.length) return false;
        var difference = 0;
        for (var index = 0; index < left.length; index += 1) {
          difference |= left[index] ^ right[index];
        }
        return difference === 0;
      }
      function bytesToHex(bytes) {
        assertBytes(bytes, "bytes");
        var result = "";
        for (var index = 0; index < bytes.length; index += 1) {
          var value = bytes[index];
          result += HEX_ALPHABET[value >>> 4] + HEX_ALPHABET[value & 15];
        }
        return result;
      }
      function hexToBytes(value) {
        if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
          throw invalidInput("Hex input must contain an even number of hexadecimal characters.");
        }
        var result = new Uint8Array(value.length / 2);
        for (var index = 0; index < result.length; index += 1) {
          result[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
        }
        return result;
      }
      function bytesToBase64(bytes) {
        assertBytes(bytes, "bytes");
        var result = "";
        for (var index = 0; index < bytes.length; index += 3) {
          var remaining = bytes.length - index;
          var first = bytes[index];
          var second = remaining > 1 ? bytes[index + 1] : 0;
          var third = remaining > 2 ? bytes[index + 2] : 0;
          var packed = first * 65536 + second * 256 + third;
          result += BASE64_ALPHABET[packed >>> 18 & 63];
          result += BASE64_ALPHABET[packed >>> 12 & 63];
          result += remaining > 1 ? BASE64_ALPHABET[packed >>> 6 & 63] : "=";
          result += remaining > 2 ? BASE64_ALPHABET[packed & 63] : "=";
        }
        return result;
      }
      function base64ToBytes(value) {
        if (typeof value !== "string" || /\s/.test(value)) {
          throw invalidInput("Base64 input must be a string without whitespace.");
        }
        if (value.length === 0) return new Uint8Array(0);
        var firstPadding = value.indexOf("=");
        if (firstPadding !== -1) {
          if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={1,2}$/.test(value) || value.length - firstPadding > 2) {
            throw invalidInput("Base64 input has invalid padding.");
          }
        } else if (!/^[A-Za-z0-9+/]+$/.test(value) || value.length % 4 === 1) {
          throw invalidInput("Base64 input contains invalid characters or length.");
        }
        var normalized = value;
        while (normalized.length % 4 !== 0) normalized += "=";
        var padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
        var result = new Uint8Array(normalized.length / 4 * 3 - padding);
        var outputOffset = 0;
        for (var index = 0; index < normalized.length; index += 4) {
          var a = base64Value(normalized[index]);
          var b = base64Value(normalized[index + 1]);
          var c = normalized[index + 2] === "=" ? 0 : base64Value(normalized[index + 2]);
          var d = normalized[index + 3] === "=" ? 0 : base64Value(normalized[index + 3]);
          if (normalized[index + 2] === "=" && (b & 15) !== 0) {
            throw invalidInput("Base64 input has non-zero trailing bits.");
          }
          if (normalized[index + 3] === "=" && normalized[index + 2] !== "=" && (c & 3) !== 0) {
            throw invalidInput("Base64 input has non-zero trailing bits.");
          }
          var packed = a * 262144 + b * 4096 + c * 64 + d;
          if (outputOffset < result.length) result[outputOffset++] = packed >>> 16 & 255;
          if (outputOffset < result.length) result[outputOffset++] = packed >>> 8 & 255;
          if (outputOffset < result.length) result[outputOffset++] = packed & 255;
        }
        return result;
      }
      function base64Value(character) {
        var value = BASE64_ALPHABET.indexOf(character);
        if (value === -1) throw invalidInput("Base64 input contains an invalid character.");
        return value;
      }
      function utf8ToBytes(value) {
        if (typeof value !== "string") throw invalidInput("UTF-8 input must be a string.");
        var output = [];
        for (var index = 0; index < value.length; index += 1) {
          var codePoint = value.charCodeAt(index);
          if (codePoint >= 55296 && codePoint <= 56319) {
            var low = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
            if (low >= 56320 && low <= 57343) {
              codePoint = 65536 + (codePoint - 55296 << 10) + (low - 56320);
              index += 1;
            } else {
              codePoint = 65533;
            }
          } else if (codePoint >= 56320 && codePoint <= 57343) {
            codePoint = 65533;
          }
          if (codePoint <= 127) {
            output.push(codePoint);
          } else if (codePoint <= 2047) {
            output.push(192 | codePoint >>> 6, 128 | codePoint & 63);
          } else if (codePoint <= 65535) {
            output.push(
              224 | codePoint >>> 12,
              128 | codePoint >>> 6 & 63,
              128 | codePoint & 63
            );
          } else {
            output.push(
              240 | codePoint >>> 18,
              128 | codePoint >>> 12 & 63,
              128 | codePoint >>> 6 & 63,
              128 | codePoint & 63
            );
          }
        }
        return new Uint8Array(output);
      }
      function bytesToUtf8(bytes) {
        assertBytes(bytes, "bytes");
        var result = "";
        for (var index = 0; index < bytes.length; ) {
          var first = bytes[index];
          var codePoint;
          var length;
          var minimum;
          if (first <= 127) {
            codePoint = first;
            length = 1;
            minimum = 0;
          } else if (first >= 194 && first <= 223) {
            codePoint = first & 31;
            length = 2;
            minimum = 128;
          } else if (first >= 224 && first <= 239) {
            codePoint = first & 15;
            length = 3;
            minimum = 2048;
          } else if (first >= 240 && first <= 244) {
            codePoint = first & 7;
            length = 4;
            minimum = 65536;
          } else {
            throw invalidInput("UTF-8 input contains an invalid leading byte at offset " + index + ".");
          }
          if (index + length > bytes.length) {
            throw invalidInput("UTF-8 input ends in a truncated sequence at offset " + index + ".");
          }
          for (var continuationIndex = 1; continuationIndex < length; continuationIndex += 1) {
            var continuation = bytes[index + continuationIndex];
            if ((continuation & 192) !== 128) {
              throw invalidInput("UTF-8 input contains an invalid continuation byte at offset " + (index + continuationIndex) + ".");
            }
            codePoint = codePoint << 6 | continuation & 63;
          }
          if (codePoint < minimum || codePoint > 1114111 || codePoint >= 55296 && codePoint <= 57343) {
            throw invalidInput("UTF-8 input contains an invalid code point at offset " + index + ".");
          }
          if (codePoint <= 65535) {
            result += String.fromCharCode(codePoint);
          } else {
            codePoint -= 65536;
            result += String.fromCharCode(55296 + (codePoint >>> 10), 56320 + (codePoint & 1023));
          }
          index += length;
        }
        return result;
      }
      function assertRead(bytes, offset, width) {
        assertBytes(bytes, "bytes");
        if (!Number.isInteger(offset) || offset < 0 || offset + width > bytes.length) {
          throw invalidInput("Byte offset is outside the input.");
        }
      }
      function assertUnsignedInteger(value, maximum) {
        if (!Number.isInteger(value) || value < 0 || value > maximum) {
          throw invalidInput("Value must be an unsigned integer no greater than " + maximum + ".");
        }
      }
      function readUint16BE(bytes, offset) {
        offset = offset === void 0 ? 0 : offset;
        assertRead(bytes, offset, 2);
        return bytes[offset] * 256 + bytes[offset + 1];
      }
      function readUint16LE(bytes, offset) {
        offset = offset === void 0 ? 0 : offset;
        assertRead(bytes, offset, 2);
        return bytes[offset] + bytes[offset + 1] * 256;
      }
      function readUint32BE(bytes, offset) {
        offset = offset === void 0 ? 0 : offset;
        assertRead(bytes, offset, 4);
        return bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
      }
      function readUint32LE(bytes, offset) {
        offset = offset === void 0 ? 0 : offset;
        assertRead(bytes, offset, 4);
        return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536 + bytes[offset + 3] * 16777216;
      }
      function uint16BE(value) {
        assertUnsignedInteger(value, 65535);
        return new Uint8Array([value >>> 8, value]);
      }
      function uint16LE(value) {
        assertUnsignedInteger(value, 65535);
        return new Uint8Array([value, value >>> 8]);
      }
      function uint32BE(value) {
        assertUnsignedInteger(value, 4294967295);
        return new Uint8Array([value / 16777216, value >>> 16, value >>> 8, value]);
      }
      function uint32LE(value) {
        assertUnsignedInteger(value, 4294967295);
        return new Uint8Array([value, value >>> 8, value >>> 16, value / 16777216]);
      }
      module.exports = {
        assertBytes,
        base64ToBytes,
        bytesEqual,
        bytesToBase64,
        bytesToHex,
        bytesToUtf8,
        concatBytes,
        copyBytes,
        hexToBytes,
        readUint16BE,
        readUint16LE,
        readUint32BE,
        readUint32LE,
        uint16BE,
        uint16LE,
        uint32BE,
        uint32LE,
        utf8ToBytes
      };
    }
  });

  // src/google/client.js
  var require_client = __commonJS({
    "src/google/client.js"(exports, module) {
      "use strict";
      var bytes = require_bytes();
      var RuntimeError = require_errors().RuntimeError;
      var ERROR_KINDS = require_errors().ERROR_KINDS;
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
      var PLUGIN_VERSION = "0.13.1";
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
        } catch (error) {
          console.error("Google " + method + " " + url.split("?")[0] + " failed: " + (error && error.message || error));
          throw googleError("GOOGLE_LOCATION_NETWORK_ERROR", "Could not reach Google location sharing.");
        }
        if (!response || !Number.isInteger(response.status) || !(response.body instanceof Uint8Array)) {
          throw googleError("GOOGLE_LOCATION_PROTOCOL_ERROR", "Google returned a malformed response.");
        }
        if (response.status >= 400) console.error("Google " + method + " " + url.split("?")[0] + " failed: HTTP " + response.status);
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
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
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
          generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
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
    }
  });

  // src/findmy/controller.js
  var require_controller = __commonJS({
    "src/findmy/controller.js"(exports, module) {
      "use strict";
      var RuntimeError = require_errors().RuntimeError;
      var ERROR_KINDS = require_errors().ERROR_KINDS;
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
    }
  });

  // src/location-sharing/maps.js
  var require_maps = __commonJS({
    "src/location-sharing/maps.js"(exports, module) {
      "use strict";
      var bytes = require_bytes();
      var MAPS_ORIGIN = "https://www.google.com";
      var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
      var TRAVEL_MODES = Object.freeze({ drive: 0, bike: 1, walk: 2 });
      var DIRECTIONS_PB = "!1m4!3m2!3d{fromLat}!4d{fromLng}!6e2!1m4!3m2!3d{toLat}!4d{toLng}!6e2!3m12!1m3!1d3199722.634370091!2d-122.6715335!3d38.4477229!2m3!1f0.0!2f0.0!3f0.0!3m2!1i1024!2i768!4f13.1!6m62!1m5!18b1!30b1!31m1!1b1!34e1!2m4!5m1!6e2!20e3!39b1!6m31!32i1!49b1!63m0!66b1!85b1!114b1!149b1!206b1!209b1!212b1!215b1!216b1!222b1!223b1!234b1!235b1!239b1!246b1!253b1!260b1!262b1!266b1!270b1!271b1!273b1!277b1!281b1!291m0!294b1!302i300!303i100!10b1!12b1!13b1!14b1!16b1!17m1!3e1!20m5!1e{mode}!2e3!5e2!6b1!14b1!46m1!1b0!96b1!97m1!2b1!99b1!15m3!1s8X3OaoURis6Q8g-xsKqhBA!7e81!15i10142!20m28!1m6!1m2!1i0!2i0!2m2!1i530!2i768!1m6!1m2!1i974!2i0!2m2!1i1024!2i768!1m6!1m2!1i0!2i0!2m2!1i1024!2i20!1m6!1m2!1i0!2i748!2m2!1i1024!2i768!27b1!40i799!47m2!8b1!10e2";
      function get(http, url) {
        return http.request({
          method: "GET",
          url,
          headers: [["User-Agent", USER_AGENT], ["Accept-Language", "en-US"]],
          body: new Uint8Array(0),
          maxResponseBytes: 4 * 1024 * 1024
        }).then(function(response) {
          if (response.status < 200 || response.status >= 300) {
            console.error("Google Maps GET failed: HTTP " + response.status);
            throw new Error("Google Maps returned HTTP " + response.status + ".");
          }
          return bytes.bytesToUtf8(response.body);
        });
      }
      function embeddedRequest(page, pattern) {
        var match = pattern.exec(page);
        return match ? match[0].replace(/&amp;/g, "&") : null;
      }
      function parseMapsJson(text) {
        return JSON.parse(text.replace(/^\)\]\}'\s*/, ""));
      }
      function at(value, path) {
        return path.reduce(function(node, index) {
          return Array.isArray(node) ? node[index] : void 0;
        }, value);
      }
      function coordinate(point) {
        return point.latitude + "," + point.longitude;
      }
      function directRequest(from, to, mode) {
        var values = { fromLat: from.latitude, fromLng: from.longitude, toLat: to.latitude, toLng: to.longitude, mode: TRAVEL_MODES[mode] };
        var pb = DIRECTIONS_PB.replace(/\{(\w+)\}/g, function(_, name) {
          return String(values[name]);
        });
        return "preview/directions?authuser=0&hl=en&gl=us&pb=" + encodeURIComponent(pb);
      }
      async function pageRequest(http, from, to, mode) {
        var page = await get(http, MAPS_ORIGIN + "/maps/dir/" + coordinate(from) + "/" + coordinate(to) + "/data=!4m2!4m1!3e" + TRAVEL_MODES[mode] + "?hl=en");
        return embeddedRequest(page, /preview\/directions\?authuser=0&amp;[^"]*/);
      }
      function bestRoute(text) {
        var best = at(parseMapsJson(text), [0, 1, 0, 0]);
        var distance = at(best, [2]);
        var duration = at(best, [3]);
        if (!Number.isFinite(at(distance, [0])) || !Number.isFinite(at(duration, [0]))) return null;
        return {
          meters: distance[0],
          seconds: duration[0],
          distance: String(distance[1]).replace(/ miles?$/, " mi"),
          duration: String(duration[1])
        };
      }
      async function route(http, from, to, mode) {
        if (!(mode in TRAVEL_MODES)) throw new TypeError("Unknown travel mode " + mode + ".");
        try {
          var direct = bestRoute(await get(http, MAPS_ORIGIN + "/maps/" + directRequest(from, to, mode)));
          if (direct) return direct;
        } catch (_) {
        }
        var request = await pageRequest(http, from, to, mode);
        return request ? bestRoute(await get(http, MAPS_ORIGIN + "/maps/" + request)) : null;
      }
      async function geocode(http, address) {
        var page = await get(http, MAPS_ORIGIN + "/maps/search/" + encodeURIComponent(address) + "?hl=en");
        var request = embeddedRequest(page, /search\?tbm=map&amp;[^"]*/);
        if (!request) return null;
        var point = at(parseMapsJson(await get(http, MAPS_ORIGIN + "/" + request)), [0, 1, 0, 14, 9]);
        if (!Number.isFinite(at(point, [2])) || !Number.isFinite(at(point, [3]))) return null;
        return { latitude: point[2], longitude: point[3] };
      }
      function straightLineMeters(a, b) {
        var radians = Math.PI / 180;
        var dLat = (b.latitude - a.latitude) * radians;
        var dLon = (b.longitude - a.longitude) * radians;
        var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.pow(Math.sin(dLon / 2), 2);
        return 2 * 63710088e-1 * Math.asin(Math.min(1, Math.sqrt(h)));
      }
      module.exports = { TRAVEL_MODES, route, geocode, straightLineMeters };
    }
  });

  // src/location-sharing/controller.js
  var require_controller2 = __commonJS({
    "src/location-sharing/controller.js"(exports, module) {
      "use strict";
      var RuntimeError = require_errors().RuntimeError;
      var ERROR_KINDS = require_errors().ERROR_KINDS;
      var FindMyController = require_controller().FindMyController;
      var maps = require_maps();
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
      var AUTO_LIMIT_SECONDS = 20 * 60;
      function defaultSettings() {
        return { show: { auto: true, drive: false, bike: false, walk: false }, nicknames: {}, places: [] };
      }
      function cleanText(value, max) {
        return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
      }
      function displayName(person, nicknames) {
        var nickname = cleanText(nicknames[person.id], 40);
        if (!nickname) return person.name;
        return /^my\s/i.test(nickname) ? "Your " + nickname.slice(3) : nickname;
      }
      function placeAt(person, places) {
        var best = null;
        places.forEach(function(place) {
          var meters = maps.straightLineMeters(person, place);
          if (meters <= place.radiusMeters && (!best || meters < best.meters)) best = { place, meters };
        });
        return best && best.place;
      }
      function shortAddress(address) {
        return String(address).split(",").slice(0, 2).join(",").trim();
      }
      function answerText(person, settings, routes, nowMs) {
        var name = displayName(person, settings.nicknames);
        if (!Number.isFinite(person.latitude) || !Number.isFinite(person.longitude)) {
          return name + " is sharing, but no current location came back.";
        }
        var place = placeAt(person, settings.places);
        var where = place ? place.label : person.address ? shortAddress(person.address) : person.latitude.toFixed(4) + ", " + person.longitude.toFixed(4);
        var text = name + (person.isOld ? " was last seen at " : " is at ") + where;
        var trips = Object.keys(MODE_NAMES).filter(function(mode) {
          return routes[mode];
        });
        if (trips.length) {
          text += ", " + trips.map(function(mode) {
            return routes[mode].duration + " " + MODE_NAMES[mode];
          }).join(" or ") + " away (" + routes[trips[0]].distance + ")";
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
        this.currentPosition = typeof options.currentPosition === "function" ? options.currentPosition : async function() {
          return null;
        };
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
      LocationSharingController.prototype.routesTo = async function(person, settings) {
        var chosen = Object.keys(MODE_NAMES).filter(function(mode) {
          return settings.show[mode];
        });
        var modes = settings.show.auto ? Object.keys(MODE_NAMES) : chosen;
        if (!modes.length || !this.http || !Number.isFinite(person.latitude) || !Number.isFinite(person.longitude)) return {};
        var origin = await this.currentPosition();
        if (!origin) return {};
        var http = this.http;
        var found = await Promise.all(modes.map(function(mode) {
          return maps.route(http, origin, person, mode).catch(function() {
            return null;
          });
        }));
        var all = {};
        modes.forEach(function(mode, index) {
          if (found[index]) all[mode] = found[index];
        });
        return pickRoutes(all, settings.show);
      };
      function pickRoutes(all, show) {
        var picked = Object.keys(MODE_NAMES).filter(function(mode) {
          return show[mode];
        });
        if (show.auto) {
          var quick = ["walk", "bike"].filter(function(mode) {
            return all[mode] && all[mode].seconds < AUTO_LIMIT_SECONDS;
          });
          picked = picked.concat(quick.length ? quick : ["drive"]);
        }
        var routes = {};
        picked.forEach(function(mode) {
          if (all[mode]) routes[mode] = all[mode];
        });
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
              Object.keys(updated.show).forEach(function(mode) {
                updated.show[mode] = !!(message.show && message.show[mode]);
              });
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
              if (!Number.isFinite(radius) || radius < 25 || radius > 5e3) radius = 150;
              var places = this.settings();
              if (places.places.length >= MAX_PLACES) return Object.assign(configReply(this), { ok: false, message: "You can save up to " + MAX_PLACES + " places." });
              var point = this.http ? await maps.geocode(this.http, address) : null;
              if (!point) return Object.assign(configReply(this), { ok: false, message: "Google Maps couldn't find that address." });
              places.places.push({ label, address, latitude: point.latitude, longitude: point.longitude, radiusMeters: radius });
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
    }
  });

  // ../chat/imessage/src/runtime/effects.js
  var require_effects = __commonJS({
    "../chat/imessage/src/runtime/effects.js"(exports, module) {
      "use strict";
      var RuntimeError = require_errors().RuntimeError;
      var ERROR_KINDS = require_errors().ERROR_KINDS;
      var PROVIDER_METHODS = Object.freeze({
        clock: Object.freeze(["now"]),
        random: Object.freeze(["bytes"]),
        timer: Object.freeze(["after", "cancel"]),
        crypto: Object.freeze(["request"]),
        http: Object.freeze(["request"]),
        websocket: Object.freeze(["open", "send", "close"]),
        tls: Object.freeze(["open", "write", "close"]),
        storage: Object.freeze(["get", "set", "delete"]),
        trace: Object.freeze(["emit"])
      });
      function createEffects(providers) {
        if (providers === void 0) providers = {};
        if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
          throw new RuntimeError("INVALID_EFFECTS", "Effects providers must be an object.", {
            kind: ERROR_KINDS.INVALID_INPUT
          });
        }
        var unknownNames = Object.keys(providers).filter(function(name) {
          return !Object.prototype.hasOwnProperty.call(PROVIDER_METHODS, name);
        });
        if (unknownNames.length > 0) {
          throw new RuntimeError("INVALID_EFFECTS", "Unknown effects provider: " + unknownNames[0] + ".", {
            kind: ERROR_KINDS.INVALID_INPUT
          });
        }
        var effects = {};
        Object.keys(PROVIDER_METHODS).forEach(function(providerName) {
          effects[providerName] = createProviderFacade(
            providerName,
            providers[providerName],
            PROVIDER_METHODS[providerName]
          );
        });
        return Object.freeze(effects);
      }
      function createProviderFacade(providerName, provider, methodNames) {
        if (provider !== void 0 && (!provider || typeof provider !== "object")) {
          throw new RuntimeError("INVALID_EFFECTS", providerName + " effects provider must be an object.", {
            kind: ERROR_KINDS.INVALID_INPUT
          });
        }
        var facade = {};
        methodNames.forEach(function(methodName) {
          facade[methodName] = function() {
            if (!provider || typeof provider[methodName] !== "function") {
              if (!provider && providerName === "trace" && methodName === "emit") return void 0;
              throw new RuntimeError(
                "MISSING_EFFECT",
                "Missing effects capability " + providerName + "." + methodName + ".",
                { kind: ERROR_KINDS.CAPABILITY }
              );
            }
            var args = Array.prototype.slice.call(arguments);
            validateEffectArguments(providerName, methodName, args);
            var result = provider[methodName].apply(provider, args);
            return validateEffectResult(providerName, methodName, args, result);
          };
        });
        return Object.freeze(facade);
      }
      function validateEffectArguments(providerName, methodName, args) {
        if (providerName === "random" && methodName === "bytes") {
          var length = args[0];
          if (!Number.isSafeInteger(length) || length < 0) {
            throw new RuntimeError("INVALID_ARGUMENT", "Random byte length must be a non-negative safe integer.", {
              kind: ERROR_KINDS.INVALID_INPUT
            });
          }
        }
      }
      function validateEffectResult(providerName, methodName, args, result) {
        if (providerName === "clock" && methodName === "now") {
          if (typeof result !== "number" || !Number.isFinite(result)) {
            throw invalidEffectResult("clock.now must return a finite number.");
          }
        }
        if (providerName === "random" && methodName === "bytes") {
          var length = args[0];
          if (!(result instanceof Uint8Array) || result.length !== length) {
            throw invalidEffectResult("random.bytes must return a Uint8Array of the requested length.");
          }
          return new Uint8Array(result);
        }
        return result;
      }
      function invalidEffectResult(message) {
        return new RuntimeError("INVALID_EFFECT_RESULT", message, { kind: ERROR_KINDS.INTERNAL });
      }
      module.exports = {
        PROVIDER_METHODS,
        createEffects
      };
    }
  });

  // ../chat/imessage/src/runtime/host-environment.js
  var require_host_environment = __commonJS({
    "../chat/imessage/src/runtime/host-environment.js"(exports, module) {
      "use strict";
      var bytes = require_bytes();
      var RuntimeError = require_errors().RuntimeError;
      var ERROR_KINDS = require_errors().ERROR_KINDS;
      function transportError(code, message) {
        return new RuntimeError(code, message, { kind: ERROR_KINDS.TRANSPORT, retryable: true });
      }
      function validateHeader(header) {
        return Array.isArray(header) && header.length === 2 && typeof header[0] === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header[0]) && typeof header[1] === "string" && !/[\r\n]/.test(header[1]);
      }
      function responseBytes(value) {
        if (value instanceof Uint8Array) return new Uint8Array(value);
        if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
          return new Uint8Array(value);
        }
        if (value && typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
          return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        throw transportError("HTTP_INVALID_RESPONSE", "HTTP response body was not binary data.");
      }
      function responseByteLength(value) {
        if (value instanceof Uint8Array) return value.byteLength;
        if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return value.byteLength;
        if (value && typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) return value.byteLength;
        throw transportError("HTTP_INVALID_RESPONSE", "HTTP response body was not binary data.");
      }
      function parseResponseHeaders(xhr) {
        if (Array.isArray(xhr._responseHeaderEntries)) {
          return xhr._responseHeaderEntries.map(function(header) {
            if (!validateHeader(header)) {
              throw transportError("HTTP_INVALID_RESPONSE", "HTTP response contained an invalid header.");
            }
            return Object.freeze([String(header[0]).toLowerCase(), String(header[1])]);
          });
        }
        var raw = typeof xhr.getAllResponseHeaders === "function" ? xhr.getAllResponseHeaders() : "";
        if (!raw) return [];
        var result = [];
        raw.split(/\r?\n/).forEach(function(line) {
          if (!line) return;
          var separator = line.indexOf(":");
          var header = separator === -1 ? null : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
          if (!header || !validateHeader(header)) {
            throw transportError("HTTP_INVALID_RESPONSE", "HTTP response contained an invalid header.");
          }
          result.push(Object.freeze([header[0].toLowerCase(), header[1]]));
        });
        return result;
      }
      function XhrHttpProvider(XMLHttpRequestConstructor, timer, defaultTimeoutMillis) {
        if (typeof XMLHttpRequestConstructor !== "function") {
          throw new TypeError("XMLHttpRequest is unavailable.");
        }
        if (!timer || typeof timer.after !== "function" || typeof timer.cancel !== "function") {
          throw new TypeError("HTTP timer service is unavailable.");
        }
        if (defaultTimeoutMillis === void 0) defaultTimeoutMillis = 2e4;
        if (!Number.isSafeInteger(defaultTimeoutMillis) || defaultTimeoutMillis <= 0) {
          throw new TypeError("HTTP timeout is invalid.");
        }
        this.XMLHttpRequest = XMLHttpRequestConstructor;
        this.timer = timer;
        this.defaultTimeoutMillis = defaultTimeoutMillis;
      }
      XhrHttpProvider.prototype.request = function(request) {
        if (!request || typeof request !== "object" || typeof request.method !== "string" || typeof request.url !== "string" || !Array.isArray(request.headers) || !(request.body instanceof Uint8Array)) {
          return Promise.reject(new TypeError("HTTP request is malformed."));
        }
        for (var index = 0; index < request.headers.length; index += 1) {
          if (!validateHeader(request.headers[index])) {
            return Promise.reject(new TypeError("HTTP request contains an invalid header."));
          }
        }
        var Constructor = this.XMLHttpRequest;
        var timer = this.timer;
        var timeoutMillis = request.timeoutMillis === void 0 ? this.defaultTimeoutMillis : request.timeoutMillis;
        if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis <= 0) {
          return Promise.reject(new TypeError("HTTP request timeout is invalid."));
        }
        var maxResponseBytes = request.maxResponseBytes;
        if (maxResponseBytes !== void 0 && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > 64 * 1024 * 1024)) {
          return Promise.reject(new TypeError("HTTP response byte limit is invalid."));
        }
        return new Promise(function(resolve, reject) {
          var xhr = new Constructor();
          var settled = false;
          var timeoutHandle = null;
          function finish(error, value) {
            if (settled) return;
            settled = true;
            if (timeoutHandle !== null) {
              try {
                timer.cancel(timeoutHandle);
              } catch (_) {
              }
              timeoutHandle = null;
            }
            if (error) reject(error);
            else resolve(value);
          }
          xhr.responseType = "arraybuffer";
          xhr.maxResponseBytes = maxResponseBytes === void 0 ? null : maxResponseBytes;
          xhr.onprogress = function(event) {
            if (settled || maxResponseBytes === void 0 || !event || !Number.isSafeInteger(event.loaded) || event.loaded <= maxResponseBytes) return;
            finish(transportError("HTTP_RESPONSE_TOO_LARGE", "HTTP response exceeded its byte limit."));
            try {
              xhr.abort();
            } catch (_) {
            }
          };
          xhr.onload = function() {
            try {
              if (!Number.isInteger(xhr.status) || xhr.status < 100 || xhr.status > 599) {
                throw transportError("HTTP_INVALID_RESPONSE", "HTTP response status was invalid.");
              }
              if (maxResponseBytes !== void 0 && responseByteLength(xhr.response) > maxResponseBytes) {
                throw transportError("HTTP_RESPONSE_TOO_LARGE", "HTTP response exceeded its byte limit.");
              }
              finish(null, Object.freeze({
                status: xhr.status,
                headers: Object.freeze(parseResponseHeaders(xhr)),
                body: responseBytes(xhr.response)
              }));
            } catch (error) {
              finish(error);
            }
          };
          xhr.onerror = function() {
            finish(transportError(
              xhr._responseTooLarge === true ? "HTTP_RESPONSE_TOO_LARGE" : "HTTP_NETWORK_ERROR",
              xhr._responseTooLarge === true ? "HTTP response exceeded its byte limit." : "HTTP request failed."
            ));
          };
          xhr.ontimeout = function() {
            finish(transportError("HTTP_TIMEOUT", "HTTP request timed out."));
          };
          xhr.onabort = function() {
            finish(transportError("HTTP_ABORTED", "HTTP request was cancelled."));
          };
          try {
            xhr.open(request.method, request.url, true);
            request.headers.forEach(function(header) {
              xhr.setRequestHeader(header[0], header[1]);
            });
            timeoutHandle = timer.after(timeoutMillis, function() {
              if (settled) return;
              finish(transportError("HTTP_TIMEOUT", "HTTP request timed out."));
              try {
                xhr.abort();
              } catch (_) {
              }
            });
            xhr.send(new Uint8Array(request.body));
          } catch (error) {
            finish(transportError("HTTP_NETWORK_ERROR", "HTTP request could not be started."));
          }
        });
      };
      function LocalStorageProvider(storage) {
        if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") throw new TypeError("Plugin storage is unavailable.");
        this.storage = storage;
      }
      LocalStorageProvider.prototype.get = function(key) {
        return this.storage.getItem(key);
      };
      LocalStorageProvider.prototype.set = function(key, value) {
        this.storage.setItem(key, value);
      };
      LocalStorageProvider.prototype.delete = function(key) {
        this.storage.removeItem(key);
      };
      function createClockProvider() {
        return Object.freeze({ now: function() {
          return Date.now();
        } });
      }
      function createRandomProvider(crypto2) {
        if (!crypto2 || typeof crypto2.random !== "function") throw new TypeError("Crypto random source is unavailable.");
        return Object.freeze({ bytes: function(length) {
          return crypto2.random(length);
        } });
      }
      function createTraceProvider(consoleObject) {
        return Object.freeze({
          emit: function(event) {
            if (consoleObject && typeof consoleObject.info === "function") {
              consoleObject.info("[iMessage state]", event && event.kind ? event.kind : "event");
            }
          }
        });
      }
      module.exports = {
        LocalStorageProvider,
        XhrHttpProvider,
        createClockProvider,
        createRandomProvider,
        createTraceProvider,
        parseResponseHeaders
      };
    }
  });

  // src/runtime/fetch-http-provider.js
  var require_fetch_http_provider = __commonJS({
    "src/runtime/fetch-http-provider.js"(exports, module) {
      "use strict";
      var errors = require_errors();
      var bytes = require_bytes();
      var TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
      function transportError(code, message) {
        return new errors.RuntimeError(code, message, { kind: errors.ERROR_KINDS.TRANSPORT, retryable: true });
      }
      function validHeader(header) {
        return Array.isArray(header) && header.length === 2 && typeof header[0] === "string" && TOKEN.test(header[0]) && typeof header[1] === "string" && !/[\r\n]/.test(header[1]);
      }
      function responseBytes(value) {
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
        throw transportError("HTTP_INVALID_RESPONSE", "HTTP response body was not binary data.");
      }
      function FetchHttpProvider(fetchFunction, timer, defaultTimeoutMillis) {
        if (typeof fetchFunction !== "function") throw new TypeError("fetch is unavailable.");
        if (!timer || typeof timer.after !== "function" || typeof timer.cancel !== "function") {
          throw new TypeError("HTTP timer service is unavailable.");
        }
        if (defaultTimeoutMillis === void 0) defaultTimeoutMillis = 2e4;
        if (!Number.isSafeInteger(defaultTimeoutMillis) || defaultTimeoutMillis <= 0) {
          throw new TypeError("HTTP timeout is invalid.");
        }
        this.fetchFunction = fetchFunction;
        this.timer = timer;
        this.defaultTimeoutMillis = defaultTimeoutMillis;
      }
      FetchHttpProvider.prototype.request = function(request) {
        if (!request || typeof request !== "object" || typeof request.method !== "string" || typeof request.url !== "string" || !Array.isArray(request.headers) || !(request.body instanceof Uint8Array)) {
          return Promise.reject(new TypeError("HTTP request is malformed."));
        }
        if (!request.headers.every(validHeader)) {
          return Promise.reject(new TypeError("HTTP request contains an invalid header."));
        }
        var timeoutMillis = request.timeoutMillis === void 0 ? this.defaultTimeoutMillis : request.timeoutMillis;
        if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis <= 0) {
          return Promise.reject(new TypeError("HTTP request timeout is invalid."));
        }
        var maxResponseBytes = request.maxResponseBytes;
        if (maxResponseBytes !== void 0 && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > 64 * 1024 * 1024)) {
          return Promise.reject(new TypeError("HTTP response byte limit is invalid."));
        }
        var headers = /* @__PURE__ */ Object.create(null);
        request.headers.forEach(function(header) {
          headers[header[0]] = header[0] in headers ? headers[header[0]] + ", " + header[1] : header[1];
        });
        var fetchFunction = this.fetchFunction;
        var timer = this.timer;
        return new Promise(function(resolve, reject) {
          var settled = false;
          var timeoutHandle = null;
          function finish(error, value) {
            if (settled) return;
            settled = true;
            if (timeoutHandle !== null) {
              try {
                timer.cancel(timeoutHandle);
              } catch (_) {
              }
            }
            if (error) reject(error);
            else resolve(value);
          }
          var pending;
          try {
            timeoutHandle = timer.after(timeoutMillis, function() {
              finish(transportError("HTTP_TIMEOUT", "HTTP request timed out."));
            });
            pending = Promise.resolve(fetchFunction(request.url, {
              method: request.method,
              headers,
              // Stock CoreApp's fetch only sends text bodies; Google's requests are all text.
              body: request.body.length > 0 ? bytes.bytesToUtf8(request.body) : void 0,
              responseType: "arraybuffer"
            }));
          } catch (_) {
            finish(transportError("HTTP_NETWORK_ERROR", "HTTP request could not be started."));
            return;
          }
          pending.then(function(response) {
            if (settled) return void 0;
            if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
              throw transportError("HTTP_INVALID_RESPONSE", "HTTP response status was invalid.");
            }
            var responseHeaders = [];
            response.headers.forEach(function(value, name) {
              var header = [String(name).toLowerCase(), String(value)];
              if (!validHeader(header)) throw transportError("HTTP_INVALID_RESPONSE", "HTTP response contained an invalid header.");
              responseHeaders.push(Object.freeze(header));
            });
            return response.arrayBuffer().then(function(buffer) {
              var body = responseBytes(buffer);
              if (maxResponseBytes !== void 0 && body.length > maxResponseBytes) {
                throw transportError("HTTP_RESPONSE_TOO_LARGE", "HTTP response exceeded its byte limit.");
              }
              finish(null, Object.freeze({ status: response.status, headers: Object.freeze(responseHeaders), body }));
            });
          }).then(null, function(error) {
            finish(error instanceof errors.RuntimeError ? error : transportError("HTTP_NETWORK_ERROR", "HTTP request failed."));
          });
        });
      };
      module.exports = { FetchHttpProvider };
    }
  });

  // src/runtime/secure-blob-storage.js
  var require_secure_blob_storage = __commonJS({
    "src/runtime/secure-blob-storage.js"(exports, module) {
      "use strict";
      function SecureBlobStorage(secureStorage, key) {
        var self = this;
        this.secure = secureStorage;
        this.key = key;
        this.values = {};
        this.changes = {};
        this.writing = Promise.resolve();
        this.loaded = Promise.resolve(secureStorage.getItem(key)).then(function(raw) {
          self.values = parse(raw);
        });
      }
      function parse(raw) {
        if (!raw) return {};
        try {
          var parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
          return {};
        }
      }
      SecureBlobStorage.prototype.getItem = function(key) {
        return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
      };
      SecureBlobStorage.prototype.setItem = function(key, value) {
        this.values[key] = String(value);
        this.changes[key] = String(value);
      };
      SecureBlobStorage.prototype.removeItem = function(key) {
        delete this.values[key];
        this.changes[key] = null;
      };
      SecureBlobStorage.prototype.flush = function() {
        var self = this;
        var write = this.writing.then(function() {
          var changes = self.changes;
          if (!Object.keys(changes).length) return void 0;
          self.changes = {};
          return Promise.resolve(self.secure.getItem(self.key)).then(function(raw) {
            var merged = parse(raw);
            Object.keys(changes).forEach(function(name) {
              if (changes[name] === null) delete merged[name];
              else merged[name] = changes[name];
            });
            return self.secure.setItem(self.key, JSON.stringify(merged));
          }).catch(function(error) {
            Object.keys(changes).forEach(function(name) {
              if (!Object.prototype.hasOwnProperty.call(self.changes, name)) self.changes[name] = changes[name];
            });
            throw error;
          });
        });
        this.writing = write.catch(function() {
        });
        return write;
      };
      module.exports = { SecureBlobStorage };
    }
  });

  // src/reach.js
  var require_reach = __commonJS({
    "src/reach.js"(exports, module) {
      "use strict";
      var PROBES = [["google.com", "https://www.google.com/"]];
      var LAST_KEY = "location-sharing.blocked.v1";
      function blockedHost(request) {
        request = request || function(url) {
          return fetch(url);
        };
        return new Promise(function(resolve) {
          var answered = 0;
          PROBES.forEach(function(probe) {
            Promise.resolve().then(function() {
              return request(probe[1]);
            }).then(function() {
              if (++answered === PROBES.length) resolve(null);
            }, function() {
              resolve(probe[0]);
            });
          });
        });
      }
      function checkReach(storage, request) {
        return blockedHost(request).then(function(host) {
          try {
            if (host) storage.setItem(LAST_KEY, host);
            else storage.removeItem(LAST_KEY);
          } catch (e) {
          }
          return host;
        });
      }
      function lastBlocked(storage) {
        return storage.getItem(LAST_KEY);
      }
      function blockedMessage(host) {
        return "LocationSharing doesn't have permission to connect to " + host + '. Turn on "Connect to ' + host + `" in LocationSharing's Permissions, or check your internet connection.`;
      }
      module.exports = { blockedHost, checkReach, lastBlocked, blockedMessage };
    }
  });

  // src/plugin-entry.js
  var require_plugin_entry = __commonJS({
    "src/plugin-entry.js"(exports, module) {
      var GoogleMapsClient = require_client().GoogleMapsClient;
      var LocationSharingController = require_controller2().LocationSharingController;
      var createEffects = require_effects().createEffects;
      var hostEnvironment = require_host_environment();
      var FetchHttpProvider = require_fetch_http_provider().FetchHttpProvider;
      var SecureBlobStorage = require_secure_blob_storage().SecureBlobStorage;
      var reach = require_reach();
      var APPLE_UNAVAILABLE = "Apple Find My is not available in this version.";
      function appleUnavailable() {
        var error = new Error(APPLE_UNAVAILABLE);
        error.code = "PLUGIN_UNAVAILABLE";
        throw error;
      }
      var disabledAppleConfiguration = Object.freeze({
        status: function() {
          return { phase: "disabled", ready: false, canSubmitTwoFactor: false };
        },
        validateConfigurationInput: appleUnavailable,
        configure: async function() {
          appleUnavailable();
        },
        submitTwoFactor: async function() {
          appleUnavailable();
        },
        disconnect: async function() {
          return disabledAppleConfiguration.status();
        }
      });
      var disabledAppleClient = Object.freeze({
        cached: function() {
          return [];
        },
        refresh: async function() {
          return [];
        }
      });
      function noTimer() {
        var next = 0;
        return Object.freeze({ after: function() {
          return ++next;
        }, cancel: function() {
        } });
      }
      var randomProvider = Object.freeze({
        bytes: function(length) {
          var out = new Uint8Array(length);
          if (typeof crypto !== "undefined" && crypto.getRandomValues) return crypto.getRandomValues(out);
          for (var i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
          return out;
        }
      });
      function currentPosition(globalObject) {
        var geolocation = globalObject.navigator && globalObject.navigator.geolocation;
        if (!geolocation) return Promise.resolve(null);
        return new Promise(function(resolve) {
          geolocation.getCurrentPosition(function(position) {
            resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude });
          }, function() {
            resolve(null);
          }, { maximumAge: 6e4, timeout: 8e3, enableHighAccuracy: false });
        });
      }
      function createProductionController(globalObject, storage2) {
        var timer = noTimer();
        var effects = createEffects({
          clock: hostEnvironment.createClockProvider(),
          timer,
          random: randomProvider,
          http: new FetchHttpProvider(globalObject.fetch, timer),
          storage: new hostEnvironment.LocalStorageProvider(storage2),
          trace: hostEnvironment.createTraceProvider(globalObject.console)
        });
        return new LocationSharingController({
          appleConfiguration: disabledAppleConfiguration,
          appleClient: disabledAppleClient,
          googleClient: new GoogleMapsClient({ effects }),
          http: effects.http,
          storage: effects.storage,
          currentPosition: function() {
            return currentPosition(globalObject);
          },
          prepareAppleConfiguration: async function() {
          },
          now: function() {
            return effects.clock.now();
          }
        });
      }
      var storage = new SecureBlobStorage(Pebble.secureStorage, "location-sharing.state.v1");
      var controllerReady = storage.loaded.then(function() {
        return createProductionController(globalThis, storage);
      });
      var SAVE_FAILED = "Could not save Location Sharing settings. Try again.";
      function afterFlush(fn, onFailure) {
        return function() {
          var args = arguments;
          return storage.flush().then(function() {
            return fn.apply(null, args);
          }, function() {
            return onFailure(args);
          });
        };
      }
      function sameArgs(fn) {
        return function(args) {
          return fn.apply(null, args);
        };
      }
      function withBlockedHost(error) {
        return function(code, message) {
          if (code === "GOOGLE_LOCATION_NETWORK_ERROR") {
            try {
              var host = reach.lastBlocked(globalThis.localStorage);
              reach.checkReach(globalThis.localStorage).catch(function() {
              });
              if (host) message = reach.blockedMessage(host);
            } catch (_) {
            }
          }
          return error(code, message);
        };
      }
      Pebble.registerSourceHandler(function(request, respond) {
        return controllerReady.then(function(controller) {
          return controller.handleSource(request, {
            data: afterFlush(respond.data, function() {
              return respond.error("PLUGIN_UNAVAILABLE", SAVE_FAILED);
            }),
            error: afterFlush(withBlockedHost(respond.error), sameArgs(respond.error))
          });
        });
      });
      Pebble.registerActionHandler(function(request, respond) {
        return controllerReady.then(function(controller) {
          return controller.handleAction(request, {
            ok: afterFlush(respond.ok, function() {
              return respond.error("PLUGIN_UNAVAILABLE", SAVE_FAILED);
            }),
            error: afterFlush(withBlockedHost(respond.error), sameArgs(respond.error))
          });
        });
      });
      Pebble.registerConfigHandler(function(message, respond) {
        if (message && message.type === "reach") {
          return reach.checkReach(globalThis.localStorage).catch(function() {
            return null;
          }).then(function(blocked) {
            respond({ blocked });
          });
        }
        return controllerReady.then(function(controller) {
          return controller.handleConfig(message).then(afterFlush(respond, function() {
            return respond({ ok: false, error: SAVE_FAILED });
          }));
        });
      });
      module.exports = { createProductionController };
    }
  });
  require_plugin_entry();
})();
