'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var TAG_CLASSES = Object.freeze({
  UNIVERSAL: 0,
  APPLICATION: 1,
  CONTEXT: 2,
  PRIVATE: 3,
});
var UNIVERSAL_TAGS = Object.freeze({
  BOOLEAN: 1,
  INTEGER: 2,
  BIT_STRING: 3,
  OCTET_STRING: 4,
  NULL: 5,
  OBJECT_IDENTIFIER: 6,
  UTF8_STRING: 12,
  SEQUENCE: 16,
  SET: 17,
  PRINTABLE_STRING: 19,
  IA5_STRING: 22,
  UTC_TIME: 23,
  GENERALIZED_TIME: 24,
});
var DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxElementBytes: 16 * 1024 * 1024,
  maxDepth: 32,
  maxElements: 100000,
});
var MAX_TAG_NUMBER = 0x1fffffff;

/** @param {string} message @returns {RuntimeError} */
function invalidDer(message) {
  return new RuntimeError('INVALID_DER', message, { kind: ERROR_KINDS.INVALID_INPUT });
}

/** @param {Object=} options @returns {{maxInputBytes: number, maxElementBytes: number, maxDepth: number, maxElements: number}} */
function limitsFrom(options) {
  options = options || {};
  var result = {};
  Object.keys(DEFAULT_LIMITS).forEach(function (name) {
    var value = options[name] === undefined ? DEFAULT_LIMITS[name] : options[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidDer(name + ' must be a non-negative safe integer.');
    }
    result[name] = value;
  });
  return result;
}

/** @param {number} tagClass @param {boolean} constructed @param {number} tagNumber @returns {Uint8Array} */
function encodeIdentifier(tagClass, constructed, tagNumber) {
  if (!Number.isInteger(tagClass) || tagClass < 0 || tagClass > 3) {
    throw invalidDer('Tag class is outside the ASN.1 range.');
  }
  if (!Number.isInteger(tagNumber) || tagNumber < 0 || tagNumber > MAX_TAG_NUMBER) {
    throw invalidDer('Tag number is outside the supported range.');
  }
  var first = (tagClass << 6) | (constructed ? 0x20 : 0);
  if (tagNumber < 31) return new Uint8Array([first | tagNumber]);

  var encoded = [];
  var remaining = tagNumber;
  do {
    encoded.unshift(remaining & 0x7f);
    remaining = Math.floor(remaining / 128);
  } while (remaining > 0);
  for (var index = 0; index < encoded.length - 1; index += 1) encoded[index] |= 0x80;
  encoded.unshift(first | 0x1f);
  return new Uint8Array(encoded);
}

/** @param {number} length @returns {Uint8Array} */
function encodeLength(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw invalidDer('DER length is invalid.');
  if (length < 128) return new Uint8Array([length]);
  var octets = [];
  var remaining = length;
  while (remaining > 0) {
    octets.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  if (octets.length > 6) throw invalidDer('DER length is too large.');
  octets.unshift(0x80 | octets.length);
  return new Uint8Array(octets);
}

/**
 * @param {number} tagClass
 * @param {boolean} constructed
 * @param {number} tagNumber
 * @param {Uint8Array} content
 * @returns {Uint8Array}
 */
function encodeTlv(tagClass, constructed, tagNumber, content) {
  bytes.assertBytes(content, 'content');
  return bytes.concatBytes(
    encodeIdentifier(tagClass, constructed, tagNumber),
    encodeLength(content.length),
    content
  );
}

/** @param {Array<Uint8Array>} elements @returns {Uint8Array} */
function concatElements(elements) {
  if (!Array.isArray(elements)) throw invalidDer('DER elements must be an array.');
  elements.forEach(function (element, index) { bytes.assertBytes(element, 'element ' + index); });
  return bytes.concatBytes.apply(null, elements);
}

/** @param {Uint8Array} left @param {Uint8Array} right @returns {number} */
function compareEncoded(left, right) {
  var length = Math.min(left.length, right.length);
  for (var index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

/** @param {Array<Uint8Array>} elements @returns {Uint8Array} */
function derSequence(elements) {
  return encodeTlv(TAG_CLASSES.UNIVERSAL, true, UNIVERSAL_TAGS.SEQUENCE, concatElements(elements));
}

/** @param {Array<Uint8Array>} elements @returns {Uint8Array} */
function derSet(elements) {
  if (!Array.isArray(elements)) throw invalidDer('DER set elements must be an array.');
  var sorted = elements.map(function (element) {
    bytes.assertBytes(element, 'set element');
    return new Uint8Array(element);
  }).sort(compareEncoded);
  return encodeTlv(TAG_CLASSES.UNIVERSAL, true, UNIVERSAL_TAGS.SET, concatElements(sorted));
}

/** @param {number|bigint} value @returns {Uint8Array} */
function derInteger(value) {
  var integer;
  if (typeof value === 'bigint') integer = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) integer = BigInt(value);
  else throw invalidDer('DER integer must be a safe integer or bigint.');

  var content;
  if (integer === 0n) {
    content = new Uint8Array([0]);
  } else if (integer > 0n) {
    var positive = [];
    while (integer > 0n) {
      positive.unshift(Number(integer & 0xffn));
      integer >>= 8n;
    }
    if ((positive[0] & 0x80) !== 0) positive.unshift(0);
    content = new Uint8Array(positive);
  } else {
    var width = 1;
    while (integer < -(1n << BigInt(width * 8 - 1))) width += 1;
    var twosComplement = (1n << BigInt(width * 8)) + integer;
    var negative = new Uint8Array(width);
    for (var index = width - 1; index >= 0; index -= 1) {
      negative[index] = Number(twosComplement & 0xffn);
      twosComplement >>= 8n;
    }
    content = negative;
  }
  return encodeTlv(TAG_CLASSES.UNIVERSAL, false, UNIVERSAL_TAGS.INTEGER, content);
}

/** @param {Uint8Array} magnitude @returns {Uint8Array} */
function derUnsignedInteger(magnitude) {
  bytes.assertBytes(magnitude, 'magnitude');
  var offset = 0;
  while (offset < magnitude.length && magnitude[offset] === 0) offset += 1;
  var content = magnitude.slice(offset);
  if (content.length === 0) content = new Uint8Array([0]);
  else if ((content[0] & 0x80) !== 0) content = bytes.concatBytes(new Uint8Array([0]), content);
  return encodeTlv(TAG_CLASSES.UNIVERSAL, false, UNIVERSAL_TAGS.INTEGER, content);
}

/** @param {boolean} value @returns {Uint8Array} */
function derBoolean(value) {
  if (typeof value !== 'boolean') throw invalidDer('DER boolean must be boolean.');
  return encodeTlv(TAG_CLASSES.UNIVERSAL, false, UNIVERSAL_TAGS.BOOLEAN, new Uint8Array([value ? 0xff : 0]));
}

/** @returns {Uint8Array} */
function derNull() {
  return encodeTlv(TAG_CLASSES.UNIVERSAL, false, UNIVERSAL_TAGS.NULL, new Uint8Array(0));
}

/** @param {string} oid @returns {Uint8Array} */
function derObjectIdentifier(oid) {
  if (typeof oid !== 'string') throw invalidDer('Object identifier must be a string.');
  var parts = oid.split('.');
  if (parts.length < 2 || parts.some(function (part) { return !/^(0|[1-9][0-9]*)$/.test(part); })) {
    throw invalidDer('Object identifier has invalid arcs.');
  }
  var arcs = parts.map(function (part) { return BigInt(part); });
  if (arcs[0] > 2n || (arcs[0] < 2n && arcs[1] > 39n)) {
    throw invalidDer('Object identifier first arcs are invalid.');
  }

  var combined = [arcs[0] * 40n + arcs[1]].concat(arcs.slice(2));
  var content = [];
  combined.forEach(function (arc) {
    if (arc < 0n) throw invalidDer('Object identifier arc is negative.');
    var encoded = [Number(arc & 0x7fn)];
    arc >>= 7n;
    while (arc > 0n) {
      encoded.unshift(Number(arc & 0x7fn) | 0x80);
      arc >>= 7n;
    }
    content.push.apply(content, encoded);
  });
  return encodeTlv(TAG_CLASSES.UNIVERSAL, false, UNIVERSAL_TAGS.OBJECT_IDENTIFIER, new Uint8Array(content));
}

/** @param {string} value @returns {Uint8Array} */
function derUtf8String(value) {
  if (typeof value !== 'string') throw invalidDer('UTF8String value must be a string.');
  return encodeTlv(TAG_CLASSES.UNIVERSAL, false, UNIVERSAL_TAGS.UTF8_STRING, bytes.utf8ToBytes(value));
}

/** @param {string} value @returns {Uint8Array} */
function derPrintableString(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(value)) {
    throw invalidDer('PrintableString contains an unsupported character.');
  }
  return encodeTlv(TAG_CLASSES.UNIVERSAL, false, UNIVERSAL_TAGS.PRINTABLE_STRING, bytes.utf8ToBytes(value));
}

/** @param {string} value @returns {Uint8Array} */
function derIa5String(value) {
  if (typeof value !== 'string' || /[^\x00-\x7f]/.test(value)) {
    throw invalidDer('IA5String contains a non-ASCII character.');
  }
  return encodeTlv(TAG_CLASSES.UNIVERSAL, false, UNIVERSAL_TAGS.IA5_STRING, bytes.utf8ToBytes(value));
}

/** @param {Uint8Array} value @returns {Uint8Array} */
function derOctetString(value) {
  bytes.assertBytes(value, 'value');
  return encodeTlv(TAG_CLASSES.UNIVERSAL, false, UNIVERSAL_TAGS.OCTET_STRING, value);
}

/** @param {Uint8Array} value @param {number=} unusedBits @returns {Uint8Array} */
function derBitString(value, unusedBits) {
  bytes.assertBytes(value, 'value');
  unusedBits = unusedBits === undefined ? 0 : unusedBits;
  if (!Number.isInteger(unusedBits) || unusedBits < 0 || unusedBits > 7) {
    throw invalidDer('BIT STRING unused-bit count is invalid.');
  }
  if (value.length === 0 && unusedBits !== 0) throw invalidDer('Empty BIT STRING cannot have unused bits.');
  if (value.length > 0 && unusedBits > 0 && (value[value.length - 1] & ((1 << unusedBits) - 1)) !== 0) {
    throw invalidDer('BIT STRING has non-zero unused bits.');
  }
  return encodeTlv(
    TAG_CLASSES.UNIVERSAL,
    false,
    UNIVERSAL_TAGS.BIT_STRING,
    bytes.concatBytes(new Uint8Array([unusedBits]), value)
  );
}

/** @param {number} tagNumber @param {boolean} constructed @param {Uint8Array} content @returns {Uint8Array} */
function derContext(tagNumber, constructed, content) {
  return encodeTlv(TAG_CLASSES.CONTEXT, constructed, tagNumber, content);
}

/** @param {string} oid @param {Uint8Array=} parameters @returns {Uint8Array} */
function derAlgorithmIdentifier(oid, parameters) {
  var elements = [derObjectIdentifier(oid)];
  if (parameters !== undefined) {
    bytes.assertBytes(parameters, 'parameters');
    parseDer(parameters);
    elements.push(parameters);
  }
  return derSequence(elements);
}

/**
 * @param {Array<Array<{oid: string, value: string, type?: string}>>} rdns
 * @returns {Uint8Array}
 */
function derName(rdns) {
  if (!Array.isArray(rdns)) throw invalidDer('Name must be an array of RDNs.');
  return derSequence(rdns.map(function (rdn) {
    if (!Array.isArray(rdn) || rdn.length === 0) throw invalidDer('RDN must be a non-empty array.');
    return derSet(rdn.map(function (attribute) {
      if (!attribute || typeof attribute !== 'object') throw invalidDer('Name attribute must be an object.');
      var encodedValue;
      if (attribute.type === undefined || attribute.type === 'utf8') encodedValue = derUtf8String(attribute.value);
      else if (attribute.type === 'printable') encodedValue = derPrintableString(attribute.value);
      else if (attribute.type === 'ia5') encodedValue = derIa5String(attribute.value);
      else throw invalidDer('Name attribute string type is unsupported.');
      return derSequence([derObjectIdentifier(attribute.oid), encodedValue]);
    }));
  }));
}

/**
 * @param {{algorithmOid: string, algorithmParameters?: Uint8Array, publicKey: Uint8Array, unusedBits?: number}} options
 * @returns {Uint8Array}
 */
function derSubjectPublicKeyInfo(options) {
  if (!options || typeof options !== 'object') throw invalidDer('SPKI options must be an object.');
  return derSequence([
    derAlgorithmIdentifier(options.algorithmOid, options.algorithmParameters),
    derBitString(options.publicKey, options.unusedBits),
  ]);
}

/**
 * @param {{subject: Uint8Array|Array<Array<{oid: string, value: string, type?: string}>>, subjectPublicKeyInfo: Uint8Array, attributes?: Array<Uint8Array>}} options
 * @returns {Uint8Array}
 */
function derCertificationRequestInfo(options) {
  if (!options || typeof options !== 'object') throw invalidDer('CSR info options must be an object.');
  var subject = options.subject instanceof Uint8Array ? options.subject : derName(options.subject);
  var spki = options.subjectPublicKeyInfo;
  requireUniversal(parseDer(subject), UNIVERSAL_TAGS.SEQUENCE, true, 'CSR subject');
  requireUniversal(parseDer(spki), UNIVERSAL_TAGS.SEQUENCE, true, 'CSR subject public key info');
  var attributes = options.attributes || [];
  if (!Array.isArray(attributes)) throw invalidDer('CSR attributes must be an array.');
  var sortedAttributes = attributes.map(function (attribute) {
    bytes.assertBytes(attribute, 'CSR attribute');
    parseDer(attribute);
    return new Uint8Array(attribute);
  }).sort(compareEncoded);
  return derSequence([
    derInteger(0),
    subject,
    spki,
    derContext(0, true, concatElements(sortedAttributes)),
  ]);
}

/**
 * @param {{info: Uint8Array, signatureAlgorithmOid: string, signatureAlgorithmParameters?: Uint8Array, signature: Uint8Array}} options
 * @returns {Uint8Array}
 */
function derCertificationRequest(options) {
  if (!options || typeof options !== 'object') throw invalidDer('CSR options must be an object.');
  requireUniversal(parseDer(options.info), UNIVERSAL_TAGS.SEQUENCE, true, 'CSR info');
  return derSequence([
    options.info,
    derAlgorithmIdentifier(options.signatureAlgorithmOid, options.signatureAlgorithmParameters),
    derBitString(options.signature),
  ]);
}

/** @param {string} label @param {Uint8Array} der @returns {string} */
function derToPem(label, der) {
  if (typeof label !== 'string' || !/^[A-Z0-9][A-Z0-9 ]*[A-Z0-9]$/.test(label)) {
    throw invalidDer('PEM label is invalid.');
  }
  bytes.assertBytes(der, 'der');
  var base64 = bytes.bytesToBase64(der);
  var lines = [];
  for (var offset = 0; offset < base64.length; offset += 64) lines.push(base64.slice(offset, offset + 64));
  return '-----BEGIN ' + label + '-----\n' + lines.join('\n') + '\n-----END ' + label + '-----\n';
}

/** @param {string} pem @param {string=} expectedLabel @returns {{label: string, der: Uint8Array}} */
function pemToDer(pem, expectedLabel) {
  if (typeof pem !== 'string') throw invalidDer('PEM input must be a string.');
  var normalized = pem.replace(/\r\n/g, '\n');
  var match = normalized.match(/^-----BEGIN ([A-Z0-9][A-Z0-9 ]*[A-Z0-9])-----\n([A-Za-z0-9+/=\n]+)\n-----END \1-----\n?$/);
  if (!match) throw invalidDer('PEM input is malformed.');
  if (expectedLabel !== undefined && match[1] !== expectedLabel) throw invalidDer('PEM label does not match.');
  var payload = match[2].split('\n').join('');
  var der;
  try { der = bytes.base64ToBytes(payload); } catch (error) { throw invalidDer('PEM payload is invalid base64.'); }
  parseDer(der);
  return { label: match[1], der: der };
}

/**
 * Parse exactly one canonical DER element and all constructed descendants.
 *
 * @param {Uint8Array} input
 * @param {Object=} options
 * @returns {Object}
 */
function parseDer(input, options) {
  bytes.assertBytes(input, 'input');
  var limits = limitsFrom(options);
  if (input.length > limits.maxInputBytes) throw invalidDer('DER input exceeds maxInputBytes.');
  var source = new Uint8Array(input);
  var state = { count: 0 };
  var parsed = parseElement(source, 0, source.length, 0, limits, state);
  if (parsed.nextOffset !== source.length) throw invalidDer('DER input contains trailing data.');
  return parsed.element;
}

/** @returns {{element: Object, nextOffset: number}} */
function parseElement(source, offset, boundary, depth, limits, state) {
  if (depth > limits.maxDepth) throw invalidDer('DER nesting exceeds maxDepth.');
  state.count += 1;
  if (state.count > limits.maxElements) throw invalidDer('DER contains too many elements.');
  var start = offset;
  if (offset >= boundary) throw invalidDer('DER element is truncated before its identifier.');
  var first = source[offset++];
  var tagClass = first >>> 6;
  var constructed = (first & 0x20) !== 0;
  var tagNumber = first & 0x1f;

  if (tagNumber === 0x1f) {
    tagNumber = 0;
    var tagOctets = 0;
    for (;;) {
      if (offset >= boundary) throw invalidDer('High-tag-number identifier is truncated.');
      var tagOctet = source[offset++];
      tagOctets += 1;
      if (tagOctets === 1 && (tagOctet & 0x7f) === 0) throw invalidDer('High-tag-number identifier is not minimal.');
      tagNumber = tagNumber * 128 + (tagOctet & 0x7f);
      if (tagNumber > MAX_TAG_NUMBER) throw invalidDer('Tag number exceeds the supported range.');
      if ((tagOctet & 0x80) === 0) break;
    }
    if (tagNumber < 31) throw invalidDer('High-tag-number identifier is not minimal.');
  }

  if (offset >= boundary) throw invalidDer('DER element is truncated before its length.');
  var firstLength = source[offset++];
  var length;
  if (firstLength < 0x80) {
    length = firstLength;
  } else {
    var lengthOctets = firstLength & 0x7f;
    if (lengthOctets === 0) throw invalidDer('DER indefinite lengths are forbidden.');
    if (lengthOctets > 6 || offset + lengthOctets > boundary) throw invalidDer('DER length is truncated or too large.');
    if (source[offset] === 0) throw invalidDer('DER length is not minimal.');
    length = 0;
    for (var lengthIndex = 0; lengthIndex < lengthOctets; lengthIndex += 1) {
      length = length * 256 + source[offset++];
      if (!Number.isSafeInteger(length)) throw invalidDer('DER length is too large.');
    }
    if (length < 128) throw invalidDer('DER length is not minimal.');
  }
  if (length > limits.maxElementBytes) throw invalidDer('DER element exceeds maxElementBytes.');
  var contentStart = offset;
  var end = contentStart + length;
  if (!Number.isSafeInteger(end) || end > boundary) throw invalidDer('DER element content is truncated.');

  validateUniversalEncoding(source, tagClass, constructed, tagNumber, contentStart, end);
  var children = null;
  if (constructed) {
    children = [];
    var childOffset = contentStart;
    while (childOffset < end) {
      var parsedChild = parseElement(source, childOffset, end, depth + 1, limits, state);
      children.push(parsedChild.element);
      childOffset = parsedChild.nextOffset;
    }
    if (tagClass === TAG_CLASSES.UNIVERSAL && tagNumber === UNIVERSAL_TAGS.SET) {
      for (var setIndex = 1; setIndex < children.length; setIndex += 1) {
        if (compareEncoded(children[setIndex - 1].raw, children[setIndex].raw) > 0) {
          throw invalidDer('SET elements are not in canonical DER order.');
        }
      }
    }
  }

  return {
    element: {
      tagClass: tagClass,
      constructed: constructed,
      tagNumber: tagNumber,
      headerLength: contentStart - start,
      length: length,
      start: start,
      end: end,
      raw: source.subarray(start, end),
      value: source.subarray(contentStart, end),
      children: children,
    },
    nextOffset: end,
  };
}

function validateUniversalEncoding(source, tagClass, constructed, tagNumber, start, end) {
  if (tagClass !== TAG_CLASSES.UNIVERSAL) return;
  if (tagNumber === UNIVERSAL_TAGS.SEQUENCE || tagNumber === UNIVERSAL_TAGS.SET) {
    if (!constructed) throw invalidDer('SEQUENCE and SET must use constructed encoding.');
    return;
  }
  if (constructed) throw invalidDer('Primitive universal value uses constructed encoding.');
  var length = end - start;
  if (tagNumber === UNIVERSAL_TAGS.BOOLEAN) {
    if (length !== 1 || (source[start] !== 0 && source[start] !== 0xff)) throw invalidDer('BOOLEAN is not canonical DER.');
  } else if (tagNumber === UNIVERSAL_TAGS.INTEGER) {
    if (length === 0) throw invalidDer('INTEGER is empty.');
    if (length > 1 && source[start] === 0 && (source[start + 1] & 0x80) === 0) throw invalidDer('INTEGER has redundant leading zeroes.');
    if (length > 1 && source[start] === 0xff && (source[start + 1] & 0x80) !== 0) throw invalidDer('INTEGER has redundant leading ones.');
  } else if (tagNumber === UNIVERSAL_TAGS.BIT_STRING) {
    if (length === 0) throw invalidDer('BIT STRING omits its unused-bit count.');
    var unused = source[start];
    if (unused > 7 || (length === 1 && unused !== 0)) throw invalidDer('BIT STRING unused-bit count is invalid.');
    if (length > 1 && unused > 0 && (source[end - 1] & ((1 << unused) - 1)) !== 0) throw invalidDer('BIT STRING has non-zero unused bits.');
  } else if (tagNumber === UNIVERSAL_TAGS.NULL) {
    if (length !== 0) throw invalidDer('NULL must be empty.');
  } else if (tagNumber === UNIVERSAL_TAGS.OBJECT_IDENTIFIER) {
    decodeObjectIdentifierContent(source.subarray(start, end));
  } else if (tagNumber === UNIVERSAL_TAGS.UTF8_STRING) {
    try { bytes.bytesToUtf8(source.subarray(start, end)); } catch (error) { throw invalidDer('UTF8String is malformed.'); }
  } else if (tagNumber === UNIVERSAL_TAGS.PRINTABLE_STRING) {
    var printable = bytes.bytesToUtf8(source.subarray(start, end));
    if (!/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(printable)) throw invalidDer('PrintableString contains an unsupported character.');
  } else if (tagNumber === UNIVERSAL_TAGS.IA5_STRING) {
    for (var index = start; index < end; index += 1) if (source[index] > 0x7f) throw invalidDer('IA5String contains non-ASCII data.');
  }
}

/** @param {Object} element @param {number} tagNumber @param {boolean} constructed @param {string} name @returns {Object} */
function requireUniversal(element, tagNumber, constructed, name) {
  if (!element || element.tagClass !== TAG_CLASSES.UNIVERSAL ||
      element.tagNumber !== tagNumber || element.constructed !== constructed) {
    throw invalidDer(name + ' has the wrong DER tag.');
  }
  return element;
}

/** @param {Uint8Array} content @returns {string} */
function decodeObjectIdentifierContent(content) {
  bytes.assertBytes(content, 'OID content');
  if (content.length === 0) throw invalidDer('Object identifier is empty.');
  var subidentifiers = [];
  var offset = 0;
  while (offset < content.length) {
    var value = 0n;
    var count = 0;
    for (;;) {
      if (offset >= content.length) throw invalidDer('Object identifier arc is truncated.');
      var octet = content[offset++];
      count += 1;
      if (count === 1 && octet === 0x80) throw invalidDer('Object identifier arc is not minimal.');
      value = (value << 7n) | BigInt(octet & 0x7f);
      if ((octet & 0x80) === 0) break;
    }
    subidentifiers.push(value);
  }
  var firstCombined = subidentifiers.shift();
  var first = firstCombined < 40n ? 0n : firstCombined < 80n ? 1n : 2n;
  var second = firstCombined - first * 40n;
  return [first, second].concat(subidentifiers).map(function (arc) { return arc.toString(); }).join('.');
}

/** @param {Object} element @returns {string} */
function decodeObjectIdentifier(element) {
  requireUniversal(element, UNIVERSAL_TAGS.OBJECT_IDENTIFIER, false, 'Object identifier');
  return decodeObjectIdentifierContent(element.value);
}

/** @param {Object} element @returns {bigint} */
function decodeInteger(element) {
  requireUniversal(element, UNIVERSAL_TAGS.INTEGER, false, 'Integer');
  var value = 0n;
  for (var index = 0; index < element.value.length; index += 1) value = (value << 8n) | BigInt(element.value[index]);
  if ((element.value[0] & 0x80) !== 0) value -= 1n << BigInt(element.value.length * 8);
  return value;
}

/** @param {Object} element @returns {{unusedBits: number, bytes: Uint8Array}} */
function decodeBitString(element) {
  requireUniversal(element, UNIVERSAL_TAGS.BIT_STRING, false, 'Bit string');
  return { unusedBits: element.value[0], bytes: element.value.slice(1) };
}

/** @param {Object} element @returns {{oid: string, parameters: Uint8Array|null}} */
function parseAlgorithmIdentifier(element) {
  requireUniversal(element, UNIVERSAL_TAGS.SEQUENCE, true, 'Algorithm identifier');
  if (element.children.length < 1 || element.children.length > 2) throw invalidDer('Algorithm identifier has the wrong number of fields.');
  return {
    oid: decodeObjectIdentifier(element.children[0]),
    parameters: element.children.length === 2 ? element.children[1].raw.slice() : null,
  };
}

/** @param {Object} element @returns {{type: string, value: string, epochMilliseconds: number}} */
function parseTime(element) {
  var value;
  try { value = bytes.bytesToUtf8(element.value); } catch (error) { throw invalidDer('Time value is not ASCII.'); }
  var match;
  var year;
  var type;
  if (element.tagClass === TAG_CLASSES.UNIVERSAL && element.tagNumber === UNIVERSAL_TAGS.UTC_TIME && !element.constructed) {
    match = value.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) throw invalidDer('UTCTime is not in canonical X.509 form.');
    year = Number(match[1]);
    year += year >= 50 ? 1900 : 2000;
    type = 'utc';
  } else if (element.tagClass === TAG_CLASSES.UNIVERSAL && element.tagNumber === UNIVERSAL_TAGS.GENERALIZED_TIME && !element.constructed) {
    match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) throw invalidDer('GeneralizedTime is not in canonical X.509 form.');
    year = Number(match[1]);
    type = 'generalized';
  } else {
    throw invalidDer('Certificate time has the wrong DER tag.');
  }
  var month = Number(match[2]);
  var day = Number(match[3]);
  var hour = Number(match[4]);
  var minute = Number(match[5]);
  var second = Number(match[6]);
  var epoch = Date.UTC(year, month - 1, day, hour, minute, second);
  var date = new Date(epoch);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw invalidDer('Certificate time is outside the calendar range.');
  }
  return { type: type, value: value, epochMilliseconds: epoch };
}

/** @param {Uint8Array} input @param {Object=} options @returns {Object} */
function parseCertificationRequest(input, options) {
  var root = requireUniversal(parseDer(input, options), UNIVERSAL_TAGS.SEQUENCE, true, 'CSR');
  if (root.children.length !== 3) throw invalidDer('CSR has the wrong number of fields.');
  var info = requireUniversal(root.children[0], UNIVERSAL_TAGS.SEQUENCE, true, 'CSR info');
  if (info.children.length !== 4) throw invalidDer('CSR info has the wrong number of fields.');
  if (decodeInteger(info.children[0]) !== 0n) throw invalidDer('CSR version is not zero.');
  requireUniversal(info.children[1], UNIVERSAL_TAGS.SEQUENCE, true, 'CSR subject');
  requireUniversal(info.children[2], UNIVERSAL_TAGS.SEQUENCE, true, 'CSR subject public key info');
  if (info.children[3].tagClass !== TAG_CLASSES.CONTEXT || info.children[3].tagNumber !== 0 || !info.children[3].constructed) {
    throw invalidDer('CSR attributes have the wrong tag.');
  }
  for (var attributeIndex = 1; attributeIndex < info.children[3].children.length; attributeIndex += 1) {
    if (compareEncoded(info.children[3].children[attributeIndex - 1].raw, info.children[3].children[attributeIndex].raw) > 0) {
      throw invalidDer('CSR attributes are not in canonical DER order.');
    }
  }
  var signature = decodeBitString(root.children[2]);
  if (signature.unusedBits !== 0) throw invalidDer('CSR signature BIT STRING has unused bits.');
  return {
    certificationRequestInfo: info.raw.slice(),
    subject: info.children[1].raw.slice(),
    subjectPublicKeyInfo: info.children[2].raw.slice(),
    attributes: info.children[3].children.map(function (element) { return element.raw.slice(); }),
    signatureAlgorithm: parseAlgorithmIdentifier(root.children[1]),
    signature: signature.bytes,
  };
}

/** @param {Uint8Array} input @param {Object=} options @returns {Object} */
function parseCertificate(input, options) {
  var root = requireUniversal(parseDer(input, options), UNIVERSAL_TAGS.SEQUENCE, true, 'Certificate');
  if (root.children.length !== 3) throw invalidDer('Certificate has the wrong number of fields.');
  var tbs = requireUniversal(root.children[0], UNIVERSAL_TAGS.SEQUENCE, true, 'TBSCertificate');
  var fields = tbs.children;
  var offset = 0;
  var version = 1;
  if (fields[0] && fields[0].tagClass === TAG_CLASSES.CONTEXT && fields[0].tagNumber === 0 && fields[0].constructed) {
    if (fields[0].children.length !== 1) throw invalidDer('Certificate version wrapper is malformed.');
    var encodedVersion = decodeInteger(fields[0].children[0]);
    if (encodedVersion < 0n || encodedVersion > 2n) throw invalidDer('Certificate version is unsupported.');
    version = Number(encodedVersion) + 1;
    offset += 1;
  }
  if (fields.length < offset + 6) throw invalidDer('TBSCertificate is truncated.');
  var serialNumber = decodeInteger(fields[offset]);
  if (serialNumber < 0n) throw invalidDer('Certificate serial number is negative.');
  var tbsSignatureAlgorithm = parseAlgorithmIdentifier(fields[offset + 1]);
  requireUniversal(fields[offset + 2], UNIVERSAL_TAGS.SEQUENCE, true, 'Certificate issuer');
  var validity = requireUniversal(fields[offset + 3], UNIVERSAL_TAGS.SEQUENCE, true, 'Certificate validity');
  if (validity.children.length !== 2) throw invalidDer('Certificate validity has the wrong number of fields.');
  requireUniversal(fields[offset + 4], UNIVERSAL_TAGS.SEQUENCE, true, 'Certificate subject');
  requireUniversal(fields[offset + 5], UNIVERSAL_TAGS.SEQUENCE, true, 'Certificate subject public key info');
  var signature = decodeBitString(root.children[2]);
  if (signature.unusedBits !== 0) throw invalidDer('Certificate signature BIT STRING has unused bits.');
  var signatureAlgorithm = parseAlgorithmIdentifier(root.children[1]);
  if (!bytes.bytesEqual(fields[offset + 1].raw, root.children[1].raw)) {
    throw invalidDer('Certificate signature algorithms do not match.');
  }
  return {
    version: version,
    serialNumber: serialNumber,
    tbsCertificate: tbs.raw.slice(),
    tbsSignatureAlgorithm: tbsSignatureAlgorithm,
    issuer: fields[offset + 2].raw.slice(),
    notBefore: parseTime(validity.children[0]),
    notAfter: parseTime(validity.children[1]),
    subject: fields[offset + 4].raw.slice(),
    subjectPublicKeyInfo: fields[offset + 5].raw.slice(),
    signatureAlgorithm: signatureAlgorithm,
    signature: signature.bytes,
  };
}

/** @param {Uint8Array} rawSignature @returns {Uint8Array} */
function ecdsaRawSignatureToDer(rawSignature) {
  bytes.assertBytes(rawSignature, 'rawSignature');
  if (rawSignature.length === 0 || rawSignature.length % 2 !== 0) {
    throw invalidDer('Raw ECDSA signature must contain two equal-width components.');
  }
  var width = rawSignature.length / 2;
  return derSequence([
    derUnsignedInteger(rawSignature.slice(0, width)),
    derUnsignedInteger(rawSignature.slice(width)),
  ]);
}

/** @param {Object} element @returns {Uint8Array} */
function positiveIntegerBytes(element) {
  var value = decodeInteger(element);
  if (value < 0n) throw invalidDer('ECDSA signature component is negative.');
  var content = element.value;
  if (content.length > 1 && content[0] === 0) content = content.subarray(1);
  return content.slice();
}

/** @param {Uint8Array} derSignature @param {number} componentLength @returns {Uint8Array} */
function ecdsaDerSignatureToRaw(derSignature, componentLength) {
  if (!Number.isSafeInteger(componentLength) || componentLength <= 0) {
    throw invalidDer('ECDSA component length must be a positive safe integer.');
  }
  var sequence = requireUniversal(parseDer(derSignature), UNIVERSAL_TAGS.SEQUENCE, true, 'ECDSA signature');
  if (sequence.children.length !== 2) throw invalidDer('ECDSA signature must contain two integers.');
  var r = positiveIntegerBytes(sequence.children[0]);
  var s = positiveIntegerBytes(sequence.children[1]);
  if (r.length > componentLength || s.length > componentLength) throw invalidDer('ECDSA signature component is too large.');
  var result = new Uint8Array(componentLength * 2);
  result.set(r, componentLength - r.length);
  result.set(s, componentLength * 2 - s.length);
  return result;
}

module.exports = {
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  TAG_CLASSES: TAG_CLASSES,
  UNIVERSAL_TAGS: UNIVERSAL_TAGS,
  decodeBitString: decodeBitString,
  decodeInteger: decodeInteger,
  decodeObjectIdentifier: decodeObjectIdentifier,
  derAlgorithmIdentifier: derAlgorithmIdentifier,
  derBitString: derBitString,
  derBoolean: derBoolean,
  derCertificationRequest: derCertificationRequest,
  derCertificationRequestInfo: derCertificationRequestInfo,
  derContext: derContext,
  derIa5String: derIa5String,
  derInteger: derInteger,
  derName: derName,
  derNull: derNull,
  derObjectIdentifier: derObjectIdentifier,
  derOctetString: derOctetString,
  derPrintableString: derPrintableString,
  derSequence: derSequence,
  derSet: derSet,
  derSubjectPublicKeyInfo: derSubjectPublicKeyInfo,
  derToPem: derToPem,
  derUnsignedInteger: derUnsignedInteger,
  derUtf8String: derUtf8String,
  ecdsaDerSignatureToRaw: ecdsaDerSignatureToRaw,
  ecdsaRawSignatureToDer: ecdsaRawSignatureToDer,
  encodeIdentifier: encodeIdentifier,
  encodeLength: encodeLength,
  encodeTlv: encodeTlv,
  parseAlgorithmIdentifier: parseAlgorithmIdentifier,
  parseCertificate: parseCertificate,
  parseCertificationRequest: parseCertificationRequest,
  parseDer: parseDer,
  pemToDer: pemToDer,
};
