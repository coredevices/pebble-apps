'use strict';

// noble calls TextEncoder while loading; JavaScriptCore (iOS plugins) has none.
if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = function TextEncoder() {};
  globalThis.TextEncoder.prototype.encode = function (text) {
    var binary = unescape(encodeURIComponent(String(text === undefined ? '' : text)));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
}
