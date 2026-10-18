'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
var DOCTYPE = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
var LEGACY_DOCTYPE = '<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
var XML_PLIST_REAL_VALUES = new WeakMap();
var DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 100000,
  maxContainerLength: 100000,
  maxStringBytes: 8 * 1024 * 1024,
  maxDataBytes: 8 * 1024 * 1024,
});

/** @param {string} message @returns {RuntimeError} */
function invalidPlist(message) {
  return new RuntimeError('INVALID_XML_PLIST', message, {
    kind: ERROR_KINDS.INVALID_INPUT,
  });
}

/** @param {Object=} options @returns {Object} */
function limitsFrom(options) {
  options = options || {};
  var result = {};
  Object.keys(DEFAULT_LIMITS).forEach(function (name) {
    var value = options[name] === undefined ? DEFAULT_LIMITS[name] : options[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidPlist(name + ' must be a non-negative safe integer.');
    }
    result[name] = value;
  });
  return result;
}

/** @param {string} value */
function assertXmlCharacters(value) {
  for (var index = 0; index < value.length; index += 1) {
    var code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      var low = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (low < 0xdc00 || low > 0xdfff) throw invalidPlist('String contains an unpaired surrogate.');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalidPlist('String contains an unpaired surrogate.');
    } else if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff) {
      throw invalidPlist('String contains a character forbidden by XML 1.0.');
    }
  }
}

/** @param {string} value @returns {string} */
function escapeXml(value) {
  assertXmlCharacters(value);
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  var prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Wrap a finite JavaScript number so the XML encoder emits a plist <real> instead of an
 * <integer>. Decoding intentionally returns an ordinary number because JavaScript has one
 * numeric type; the wrapper only controls the wire representation.
 *
 * @param {number} value
 * @returns {Object}
 */
function real(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidPlist('Plist real values must be finite numbers.');
  }
  var wrapper = Object.freeze({ value: value });
  XML_PLIST_REAL_VALUES.set(wrapper, value);
  return wrapper;
}

/**
 * Encode the plist value types used by the send-only protocol. Object key order is preserved.
 *
 * @param {unknown} value
 * @param {Object=} options
 * @returns {Uint8Array}
 */
function encodeXmlPlist(value, options) {
  var limits = limitsFrom(options);
  var nodeCount = 0;
  var active = [];

  /** @param {unknown} item @param {number} depth @returns {string} */
  function encodeValue(item, depth) {
    if (depth > limits.maxDepth) throw invalidPlist('Plist nesting exceeds maxDepth.');
    nodeCount += 1;
    if (nodeCount > limits.maxNodes) throw invalidPlist('Plist contains too many nodes.');

    if (item !== null && typeof item === 'object' && XML_PLIST_REAL_VALUES.has(item)) {
      var realValue = XML_PLIST_REAL_VALUES.get(item);
      if (!Number.isFinite(realValue)) throw invalidPlist('Plist real values must be finite numbers.');
      return '<real>' + (Object.is(realValue, -0) ? '-0' : String(realValue)) + '</real>';
    }
    if (typeof item === 'string') {
      if (bytes.utf8ToBytes(item).length > limits.maxStringBytes) throw invalidPlist('String exceeds maxStringBytes.');
      return '<string>' + escapeXml(item) + '</string>';
    }
    if (typeof item === 'boolean') return item ? '<true/>' : '<false/>';
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw invalidPlist('Plist integers must be safe integers.');
      return '<integer>' + String(item) + '</integer>';
    }
    if (item instanceof Uint8Array) {
      if (item.length > limits.maxDataBytes) throw invalidPlist('Data exceeds maxDataBytes.');
      return '<data>' + bytes.bytesToBase64(item) + '</data>';
    }
    if (item instanceof Date) {
      if (!Number.isFinite(item.getTime())) throw invalidPlist('Plist date is invalid.');
      var isoDate = item.toISOString();
      if (!/^\d{4}-/.test(isoDate)) throw invalidPlist('XML plist date year must use four digits.');
      return '<date>' + isoDate + '</date>';
    }
    if (item === null) throw invalidPlist('XML property lists cannot represent null.');

    if (Array.isArray(item) || isPlainObject(item)) {
      if (active.indexOf(item) !== -1) throw invalidPlist('Plist contains a cycle.');
      active.push(item);
      var encoded;
      if (Array.isArray(item)) {
        if (item.length > limits.maxContainerLength) throw invalidPlist('Array exceeds maxContainerLength.');
        encoded = '<array>';
        for (var arrayIndex = 0; arrayIndex < item.length; arrayIndex += 1) {
          encoded += encodeValue(item[arrayIndex], depth + 1);
        }
        encoded += '</array>';
      } else {
        var keys = Object.keys(item);
        if (keys.length > limits.maxContainerLength) throw invalidPlist('Dictionary exceeds maxContainerLength.');
        encoded = '<dict>';
        for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          var key = keys[keyIndex];
          if (bytes.utf8ToBytes(key).length > limits.maxStringBytes) throw invalidPlist('Dictionary key exceeds maxStringBytes.');
          encoded += '<key>' + escapeXml(key) + '</key>' + encodeValue(item[key], depth + 1);
        }
        encoded += '</dict>';
      }
      active.pop();
      return encoded;
    }
    throw invalidPlist('Unsupported plist value type.');
  }

  var xml = XML_HEADER + '<plist version="1.0">' + encodeValue(value, 0) + '</plist>\n';
  var output = bytes.utf8ToBytes(xml);
  if (output.length > limits.maxOutputBytes) throw invalidPlist('Encoded plist exceeds maxOutputBytes.');
  return output;
}

/** @param {string} text @returns {string} */
function decodeEntities(text) {
  var result = '';
  for (var index = 0; index < text.length;) {
    if (text[index] !== '&') {
      result += text[index++];
      continue;
    }
    var semicolon = text.indexOf(';', index + 1);
    if (semicolon === -1) throw invalidPlist('XML entity is unterminated.');
    var entity = text.slice(index + 1, semicolon);
    var replacement;
    if (entity === 'amp') replacement = '&';
    else if (entity === 'lt') replacement = '<';
    else if (entity === 'gt') replacement = '>';
    else if (entity === 'quot') replacement = '"';
    else if (entity === 'apos') replacement = "'";
    else if (/^#[0-9]+$/.test(entity)) replacement = entityCodePoint(parseInt(entity.slice(1), 10));
    else if (/^#x[0-9a-fA-F]+$/.test(entity)) replacement = entityCodePoint(parseInt(entity.slice(2), 16));
    else throw invalidPlist('XML contains an unsupported entity.');
    result += replacement;
    index = semicolon + 1;
  }
  assertXmlCharacters(result);
  return result;
}

/** @param {number} codePoint @returns {string} */
function entityCodePoint(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      codePoint === 0xfffe || codePoint === 0xffff) {
    throw invalidPlist('XML numeric entity is not a valid XML character.');
  }
  if (codePoint <= 0xffff) return String.fromCharCode(codePoint);
  codePoint -= 0x10000;
  return String.fromCharCode(0xd800 + (codePoint >>> 10), 0xdc00 + (codePoint & 0x3ff));
}

/**
 * Decode a deliberately small, non-expanding XML plist grammar. DTD declarations other than
 * Apple's fixed plist declaration, processing instructions, attributes, and custom entities fail.
 *
 * @param {Uint8Array|string} input
 * @param {Object=} options
 * @returns {unknown}
 */
function decodeXmlPlist(input, options) {
  var limits = limitsFrom(options);
  var xml;
  if (typeof input === 'string') {
    if (bytes.utf8ToBytes(input).length > limits.maxInputBytes) throw invalidPlist('Input exceeds maxInputBytes.');
    xml = input;
  } else {
    try { bytes.assertBytes(input, 'input'); } catch (error) { throw invalidPlist('Input must be UTF-8 bytes or a string.'); }
    if (input.length > limits.maxInputBytes) throw invalidPlist('Input exceeds maxInputBytes.');
    try { xml = bytes.bytesToUtf8(input); } catch (error) { throw invalidPlist('Input is not well-formed UTF-8.'); }
  }
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);

  var offset = 0;
  var nodeCount = 0;

  function skipWhitespace() {
    while (offset < xml.length && /[\t\n\r ]/.test(xml[offset])) offset += 1;
  }

  function skipComments() {
    for (;;) {
      skipWhitespace();
      if (xml.slice(offset, offset + 4) !== '<!--') return;
      var end = xml.indexOf('-->', offset + 4);
      if (end === -1 || xml.slice(offset + 4, end).indexOf('--') !== -1) throw invalidPlist('XML comment is malformed.');
      offset = end + 3;
    }
  }

  function consume(literal) {
    if (xml.slice(offset, offset + literal.length) !== literal) {
      throw invalidPlist('Expected ' + literal + ' at character ' + offset + '.');
    }
    offset += literal.length;
  }

  function consumeEmptyTag(name) {
    if (xml.slice(offset, offset + name.length + 3) === '<' + name + '/>') {
      offset += name.length + 3;
      return true;
    }
    var match = xml.slice(offset).match(new RegExp('^<' + name + '[\\t\\n\\r ]+/>'));
    if (!match) return false;
    offset += match[0].length;
    return true;
  }

  function readTextElement(name) {
    if (consumeEmptyTag(name)) return '';
    consume('<' + name + '>');
    var end = xml.indexOf('</' + name + '>', offset);
    if (end === -1) throw invalidPlist('Element ' + name + ' is unterminated.');
    var raw = xml.slice(offset, end);
    if (raw.indexOf('<') !== -1) throw invalidPlist('Element ' + name + ' cannot contain nested markup.');
    offset = end + name.length + 3;
    return decodeEntities(raw);
  }

  function countNode(depth) {
    if (depth > limits.maxDepth) throw invalidPlist('Plist nesting exceeds maxDepth.');
    nodeCount += 1;
    if (nodeCount > limits.maxNodes) throw invalidPlist('Plist contains too many nodes.');
  }

  /** @param {number} depth @returns {unknown} */
  function parseValue(depth) {
    skipComments();
    countNode(depth);
    if (xml.slice(offset, offset + 7) === '<string' && (xml[offset + 7] === '>' || /[\t\n\r /]/.test(xml[offset + 7] || ''))) {
      var stringValue = readTextElement('string');
      if (bytes.utf8ToBytes(stringValue).length > limits.maxStringBytes) throw invalidPlist('String exceeds maxStringBytes.');
      return stringValue;
    }
    if (consumeEmptyTag('true')) return true;
    if (consumeEmptyTag('false')) return false;
    if (xml.slice(offset, offset + 9) === '<integer>') {
      var integerText = readTextElement('integer').trim();
      if (!/^-?(0|[1-9][0-9]*)$/.test(integerText)) throw invalidPlist('Integer element is malformed.');
      var integer = Number(integerText);
      if (!Number.isSafeInteger(integer)) throw invalidPlist('Integer exceeds JavaScript safe-integer range.');
      return integer;
    }
    if (xml.slice(offset, offset + 6) === '<real>') {
      var realText = readTextElement('real').trim();
      if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?(?:0|[1-9][0-9]*))?$/.test(realText)) {
        throw invalidPlist('Real element is malformed.');
      }
      var real = Number(realText);
      if (!Number.isFinite(real)) throw invalidPlist('Real element is outside the finite range.');
      return real;
    }
    if (xml.slice(offset, offset + 5) === '<data' && (xml[offset + 5] === '>' || /[\t\n\r /]/.test(xml[offset + 5] || ''))) {
      var dataText = readTextElement('data').replace(/[\t\n\r ]/g, '');
      var data;
      try { data = bytes.base64ToBytes(dataText); } catch (error) { throw invalidPlist('Data element contains malformed base64.'); }
      if (data.length > limits.maxDataBytes) throw invalidPlist('Data exceeds maxDataBytes.');
      return data;
    }
    if (xml.slice(offset, offset + 6) === '<date>') {
      var dateText = readTextElement('date').trim();
      var dateMatch = dateText.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
      if (!dateMatch) throw invalidPlist('Date element is malformed.');
      var timestamp = Date.parse(dateText);
      if (!Number.isFinite(timestamp)) throw invalidPlist('Date element is invalid.');
      var date = new Date(timestamp);
      if (date.getUTCFullYear() !== Number(dateMatch[1]) || date.getUTCMonth() + 1 !== Number(dateMatch[2]) ||
          date.getUTCDate() !== Number(dateMatch[3]) || date.getUTCHours() !== Number(dateMatch[4]) ||
          date.getUTCMinutes() !== Number(dateMatch[5]) || date.getUTCSeconds() !== Number(dateMatch[6])) {
        throw invalidPlist('Date element is invalid.');
      }
      return date;
    }
    if (xml.slice(offset, offset + 7) === '<array>') {
      consume('<array>');
      var array = [];
      for (;;) {
        skipComments();
        if (xml.slice(offset, offset + 8) === '</array>') break;
        if (array.length >= limits.maxContainerLength) throw invalidPlist('Array exceeds maxContainerLength.');
        array.push(parseValue(depth + 1));
      }
      consume('</array>');
      return array;
    }
    if (consumeEmptyTag('array')) return [];
    if (xml.slice(offset, offset + 6) === '<dict>') {
      consume('<dict>');
      var dictionary = {};
      var dictionaryLength = 0;
      for (;;) {
        skipComments();
        if (xml.slice(offset, offset + 7) === '</dict>') break;
        if (dictionaryLength >= limits.maxContainerLength) throw invalidPlist('Dictionary exceeds maxContainerLength.');
        if (xml.slice(offset, offset + 4) !== '<key') throw invalidPlist('Dictionary entry is missing a key.');
        var key = readTextElement('key');
        if (bytes.utf8ToBytes(key).length > limits.maxStringBytes) throw invalidPlist('Dictionary key exceeds maxStringBytes.');
        if (Object.prototype.hasOwnProperty.call(dictionary, key)) throw invalidPlist('Dictionary contains a duplicate key.');
        var child = parseValue(depth + 1);
        Object.defineProperty(dictionary, key, { value: child, enumerable: true, writable: true, configurable: true });
        dictionaryLength += 1;
      }
      consume('</dict>');
      return dictionary;
    }
    if (consumeEmptyTag('dict')) return {};
    throw invalidPlist('Unsupported or malformed plist value at character ' + offset + '.');
  }

  skipComments();
  if (xml.slice(offset, offset + 5) === '<?xml') {
    var declaration = xml.slice(offset).match(/^<\?xml[\t\n\r ]+version=(?:"1\.0"|'1\.0')(?:[\t\n\r ]+encoding=(?:"UTF-8"|'UTF-8'))?(?:[\t\n\r ]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[\t\n\r ]*\?>/);
    if (!declaration) throw invalidPlist('XML declaration is malformed or unsupported.');
    offset += declaration[0].length;
  }
  skipComments();
  if (xml.slice(offset, offset + 9) === '<!DOCTYPE') {
    var doctypeLength = xml.slice(offset, offset + DOCTYPE.length) === DOCTYPE
      ? DOCTYPE.length
      : (xml.slice(offset, offset + LEGACY_DOCTYPE.length) === LEGACY_DOCTYPE
        ? LEGACY_DOCTYPE.length : 0);
    if (!doctypeLength) throw invalidPlist('Only the fixed Apple plist DOCTYPE is accepted.');
    offset += doctypeLength;
  }
  skipComments();
  var wrapped = xml.slice(offset, offset + 6) === '<plist';
  if (wrapped) {
    var root = xml.slice(offset).match(/^<plist[\t\n\r ]+version=(?:"1\.0"|'1\.0')[\t\n\r ]*>/);
    if (!root) throw invalidPlist('Plist root must declare version 1.0 and no other attributes.');
    offset += root[0].length;
  }
  var value = parseValue(0);
  skipComments();
  if (wrapped) consume('</plist>');
  skipComments();
  if (offset !== xml.length) throw invalidPlist('Unexpected content after plist root.');
  return value;
}

module.exports = {
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  decodeXmlPlist: decodeXmlPlist,
  encodeXmlPlist: encodeXmlPlist,
  real: real,
};
