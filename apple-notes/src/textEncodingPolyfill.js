// JavaScriptCore provides ECMAScript but not the browser TextEncoder/TextDecoder APIs used by
// @bufbuild/protobuf. Android WebView already has them; this narrow UTF-8 fallback keeps the
// exact same PBW runnable on iOS without asking the host for another privileged bridge.
(function installTextEncoding(global) {
  if (typeof global.TextEncoder !== 'function') {
    global.TextEncoder = function TextEncoder() {};
    global.TextEncoder.prototype.encode = function encode(value) {
      var text = String(value === undefined ? '' : value);
      var bytes = [];
      for (var i = 0; i < text.length; i++) {
        var code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
          var low = text.charCodeAt(i + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
            i++;
          } else {
            code = 0xfffd;
          }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          code = 0xfffd;
        }
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) bytes.push(0xc0 | code >> 6, 0x80 | code & 63);
        else if (code < 0x10000) {
          bytes.push(0xe0 | code >> 12, 0x80 | code >> 6 & 63, 0x80 | code & 63);
        } else {
          bytes.push(0xf0 | code >> 18, 0x80 | code >> 12 & 63, 0x80 | code >> 6 & 63, 0x80 | code & 63);
        }
      }
      return new Uint8Array(bytes);
    };
  }

  if (typeof global.TextDecoder !== 'function') {
    global.TextDecoder = function TextDecoder(label) {
      if (label && !/^utf-?8$/i.test(String(label))) throw new RangeError('Only UTF-8 is supported.');
    };
    global.TextDecoder.prototype.decode = function decode(input) {
      var bytes = input ? new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength) :
        new Uint8Array(0);
      var out = '';
      for (var i = 0; i < bytes.length;) {
        var first = bytes[i++];
        var code;
        var needed;
        var minimum;
        if (first < 0x80) { code = first; needed = 0; minimum = 0; }
        else if (first >= 0xc2 && first <= 0xdf) { code = first & 31; needed = 1; minimum = 0x80; }
        else if (first >= 0xe0 && first <= 0xef) { code = first & 15; needed = 2; minimum = 0x800; }
        else if (first >= 0xf0 && first <= 0xf4) { code = first & 7; needed = 3; minimum = 0x10000; }
        else { out += '\ufffd'; continue; }
        var start = i;
        var valid = true;
        for (var offset = 0; offset < needed; offset++) {
          var next = bytes[i + offset];
          if (next === undefined || (next & 0xc0) !== 0x80) { valid = false; break; }
          code = code << 6 | next & 63;
        }
        if (!valid) { out += '\ufffd'; i = start; continue; }
        i += needed;
        if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
          out += '\ufffd';
        } else if (code <= 0xffff) {
          out += String.fromCharCode(code);
        } else {
          code -= 0x10000;
          out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
        }
      }
      return out;
    };
  }
})(globalThis);
