'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var bytes = require('../../src/runtime/bytes');
var asn1 = require('../../src/codecs/asn1');

var CSR_DER_BASE64 = 'MIIBVDCBvgIBADAVMRMwEQYDVQQDDApDb2RlYyBUZXN0MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDMwL15Hp6D2Fw1ZigRHVFhf/BMRekiN19H1HED/HiJ+x4ATmlCYokte14kKrXgaAYrKPlo4zCMa/MNz5k3o5zaXhEBWWHIb6PMqXslKfPiTtZBnCSgpiptzjsNBvooHcakLwqM3ZhxC65r52CmDaybI4HhSBmmML6MM5U8lWqaEwIDAQABoAAwDQYJKoZIhvcNAQELBQADgYEAt2LWTYB0KyUSvvrhLxfxEb6mub4/ZpYTX+JygeyOzb5mxvHZYNX0h7wdp2ILrglbMPCl5aT1CBGlM2LVm7iXwgaskh8m8Hy8GbLwAQGxNlmSCrXbnMH8CBsmP/VVYiL7oDa8SSXiz3qHKN0dYE/AHpsoCMbYnc44PZXFG+764J4=';
var SPKI_DER_BASE64 = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDMwL15Hp6D2Fw1ZigRHVFhf/BMRekiN19H1HED/HiJ+x4ATmlCYokte14kKrXgaAYrKPlo4zCMa/MNz5k3o5zaXhEBWWHIb6PMqXslKfPiTtZBnCSgpiptzjsNBvooHcakLwqM3ZhxC65r52CmDaybI4HhSBmmML6MM5U8lWqaEwIDAQAB';
var CERT_DER_BASE64 = 'MIICBjCCAW+gAwIBAgIUYEk6LivhRTYlDaf7vNb6TMOEyYgwDQYJKoZIhvcNAQELBQAwFTETMBEGA1UEAwwKQ29kZWMgVGVzdDAeFw0yNjA4MjcyMzA4NDZaFw0yNjA5MjYyMzA4NDZaMBUxEzARBgNVBAMMCkNvZGVjIFRlc3QwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAMzAvXkenoPYXDVmKBEdUWF/8ExF6SI3X0fUcQP8eIn7HgBOaUJiiS17XiQqteBoBiso+WjjMIxr8w3PmTejnNpeEQFZYchvo8ypeyUp8+JO1kGcJKCmKm3OOw0G+igdxqQvCozdmHELrmvnYKYNrJsjgeFIGaYwvowzlTyVapoTAgMBAAGjUzBRMB0GA1UdDgQWBBST/uscbZjU13mtuT4BkuxY6ZzqTzAfBgNVHSMEGDAWgBST/uscbZjU13mtuT4BkuxY6ZzqTzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4GBAGN8XOZGEeEFpWqPA026kuLBDNeDtocLSD/xuGdba8C6rBilw2I1V9oDRY5nKCdXGNW/PKqeAs6ceY3vdsUzNwvhODNkojAtm6cfG1kPHHFVbnJn3eBXAp3IjkOee3PVO4q6jXn7hlsX4JeuUM45GDXfcjskn5WYbhSnQX1kUNHn';

function fromHex(value) {
  return bytes.hexToBytes(value);
}

function hex(value) {
  return bytes.bytesToHex(value);
}

function expectInvalid(callback, pattern) {
  assert.throws(callback, function (error) {
    return error && error.code === 'INVALID_DER' && (!pattern || pattern.test(error.message));
  });
}

function ascii(value) {
  return bytes.utf8ToBytes(value);
}

test('DER identifiers, lengths, integers, booleans, strings, and sorted sets are canonical', function () {
  assert.equal(hex(asn1.encodeIdentifier(asn1.TAG_CLASSES.CONTEXT, true, 128)), 'bf8100');
  assert.equal(hex(asn1.encodeLength(127)), '7f');
  assert.equal(hex(asn1.encodeLength(128)), '8180');
  assert.equal(hex(asn1.derInteger(0)), '020100');
  assert.equal(hex(asn1.derInteger(127)), '02017f');
  assert.equal(hex(asn1.derInteger(128)), '02020080');
  assert.equal(hex(asn1.derInteger(-128)), '020180');
  assert.equal(hex(asn1.derInteger(-129)), '0202ff7f');
  assert.equal(asn1.decodeInteger(asn1.parseDer(asn1.derInteger(-129))), -129n);
  assert.equal(hex(asn1.derBoolean(true)), '0101ff');
  assert.equal(hex(asn1.derNull()), '0500');
  assert.equal(hex(asn1.derSet([asn1.derInteger(2), asn1.derInteger(1)])), '3106020101020102');
  assert.equal(hex(asn1.derPrintableString('Alpha 123')), '1309416c70686120313233');
  expectInvalid(function () { asn1.derPrintableString('snowman \u2603'); });
  expectInvalid(function () { asn1.derIa5String('\u00e9'); });
});

test('OBJECT IDENTIFIER encodes and decodes the standards vector', function () {
  var encoded = asn1.derObjectIdentifier('1.2.840.113549.1.1.11');
  assert.equal(hex(encoded), '06092a864886f70d01010b');
  assert.equal(asn1.decodeObjectIdentifier(asn1.parseDer(encoded)), '1.2.840.113549.1.1.11');
  var large = '2.999.123456789012345678901234567890';
  assert.equal(asn1.decodeObjectIdentifier(asn1.parseDer(asn1.derObjectIdentifier(large))), large);
  expectInvalid(function () { asn1.derObjectIdentifier('1.40.1'); });
  expectInvalid(function () { asn1.derObjectIdentifier('1.02.3'); });
});

test('BIT STRING and context-specific values retain exact bytes', function () {
  var bitString = asn1.derBitString(fromHex('a0'), 5);
  assert.equal(hex(bitString), '030205a0');
  assert.deepEqual(asn1.decodeBitString(asn1.parseDer(bitString)), {
    unusedBits: 5,
    bytes: fromHex('a0'),
  });
  assert.equal(hex(asn1.derContext(32, false, fromHex('0102'))), '9f20020102');
  expectInvalid(function () { asn1.derBitString(fromHex('a1'), 5); }, /non-zero unused/);
});

test('OpenSSL PKCS#10 vector parses and rebuilds byte-for-byte', function () {
  var csrDer = bytes.base64ToBytes(CSR_DER_BASE64);
  var spkiDer = bytes.base64ToBytes(SPKI_DER_BASE64);
  var parsed = asn1.parseCertificationRequest(csrDer);
  assert.equal(parsed.signatureAlgorithm.oid, '1.2.840.113549.1.1.11');
  assert.equal(hex(parsed.signatureAlgorithm.parameters), '0500');
  assert.deepEqual(parsed.attributes, []);
  assert.equal(bytes.bytesEqual(parsed.subjectPublicKeyInfo, spkiDer), true);

  var info = asn1.derCertificationRequestInfo({
    subject: [[{ oid: '2.5.4.3', value: 'Codec Test' }]],
    subjectPublicKeyInfo: spkiDer,
  });
  assert.equal(bytes.bytesEqual(info, parsed.certificationRequestInfo), true);
  var rebuilt = asn1.derCertificationRequest({
    info: info,
    signatureAlgorithmOid: '1.2.840.113549.1.1.11',
    signatureAlgorithmParameters: asn1.derNull(),
    signature: parsed.signature,
  });
  assert.equal(bytes.bytesEqual(rebuilt, csrDer), true);

  var pem = asn1.derToPem('CERTIFICATE REQUEST', csrDer);
  assert.equal(asn1.pemToDer(pem, 'CERTIFICATE REQUEST').label, 'CERTIFICATE REQUEST');
  assert.equal(bytes.bytesEqual(asn1.pemToDer(pem).der, csrDer), true);
});

test('SubjectPublicKeyInfo builder reproduces the OpenSSL vector', function () {
  var spkiDer = bytes.base64ToBytes(SPKI_DER_BASE64);
  var root = asn1.parseDer(spkiDer);
  var algorithm = asn1.parseAlgorithmIdentifier(root.children[0]);
  var publicKey = asn1.decodeBitString(root.children[1]);
  var rebuilt = asn1.derSubjectPublicKeyInfo({
    algorithmOid: algorithm.oid,
    algorithmParameters: algorithm.parameters,
    publicKey: publicKey.bytes,
    unusedBits: publicKey.unusedBits,
  });
  assert.equal(bytes.bytesEqual(rebuilt, spkiDer), true);
});

test('SubjectPublicKeyInfo accepts odd-width unsigned RSA material', function () {
  var modulus = new Uint8Array(160);
  modulus[0] = 0x80;
  modulus[159] = 0x03;
  var publicKey = asn1.derSequence([
    asn1.derUnsignedInteger(modulus),
    asn1.derInteger(65537),
  ]);
  var spki = asn1.derSubjectPublicKeyInfo({
    algorithmOid: '1.2.840.113549.1.1.1',
    algorithmParameters: asn1.derNull(),
    publicKey: publicKey,
  });
  var root = asn1.parseDer(spki);
  assert.equal(asn1.parseAlgorithmIdentifier(root.children[0]).oid, '1.2.840.113549.1.1.1');
  assert.equal(bytes.bytesEqual(asn1.decodeBitString(root.children[1]).bytes, publicKey), true);
  assert.equal(asn1.decodeInteger(asn1.parseDer(publicKey).children[0]) > 0n, true);
});

test('OpenSSL X.509 vector exposes validity, serial, signature, and SPKI', function () {
  var certificate = asn1.parseCertificate(bytes.base64ToBytes(CERT_DER_BASE64));
  assert.equal(certificate.version, 3);
  assert.equal(certificate.serialNumber, 0x60493a2e2be14536250da7fbbcd6fa4cc384c988n);
  assert.equal(certificate.notBefore.value, '260827230846Z');
  assert.equal(certificate.notBefore.epochMilliseconds, Date.UTC(2026, 7, 27, 23, 8, 46));
  assert.equal(certificate.notAfter.value, '260926230846Z');
  assert.equal(certificate.signatureAlgorithm.oid, '1.2.840.113549.1.1.11');
  assert.equal(certificate.tbsSignatureAlgorithm.oid, certificate.signatureAlgorithm.oid);
  assert.equal(bytes.bytesEqual(certificate.subjectPublicKeyInfo, bytes.base64ToBytes(SPKI_DER_BASE64)), true);
  assert.equal(certificate.signature.length > 0, true);
});

function syntheticCertificate(notBefore, notAfter, outerAlgorithm) {
  var signatureAlgorithm = asn1.derAlgorithmIdentifier('1.2.3', asn1.derNull());
  var name = asn1.derName([[{ oid: '2.5.4.3', value: 'Test' }]]);
  var spki = asn1.derSubjectPublicKeyInfo({
    algorithmOid: '1.2.3',
    publicKey: fromHex('00'),
  });
  var tbs = asn1.derSequence([
    asn1.derContext(0, true, asn1.derInteger(2)),
    asn1.derInteger(1),
    signatureAlgorithm,
    name,
    asn1.derSequence([notBefore, notAfter]),
    name,
    spki,
  ]);
  return asn1.derSequence([
    tbs,
    outerAlgorithm || signatureAlgorithm,
    asn1.derBitString(fromHex('01')),
  ]);
}

test('X.509 time parsing handles UTC and GeneralizedTime calendar boundaries', function () {
  var utc = asn1.encodeTlv(asn1.TAG_CLASSES.UNIVERSAL, false, asn1.UNIVERSAL_TAGS.UTC_TIME, ascii('491231235959Z'));
  var generalized = asn1.encodeTlv(asn1.TAG_CLASSES.UNIVERSAL, false, asn1.UNIVERSAL_TAGS.GENERALIZED_TIME, ascii('20500101000000Z'));
  var certificate = asn1.parseCertificate(syntheticCertificate(utc, generalized));
  assert.equal(certificate.notBefore.epochMilliseconds, Date.UTC(2049, 11, 31, 23, 59, 59));
  assert.equal(certificate.notAfter.epochMilliseconds, Date.UTC(2050, 0, 1, 0, 0, 0));

  var impossible = asn1.encodeTlv(asn1.TAG_CLASSES.UNIVERSAL, false, asn1.UNIVERSAL_TAGS.UTC_TIME, ascii('260230000000Z'));
  expectInvalid(function () { asn1.parseCertificate(syntheticCertificate(impossible, generalized)); }, /calendar/);
});

test('ECDSA raw and DER signatures convert without losing fixed-width zeroes', function () {
  var raw = new Uint8Array(64);
  raw[0] = 0x80;
  raw[31] = 1;
  raw[62] = 0x7f;
  raw[63] = 2;
  var der = asn1.ecdsaRawSignatureToDer(raw);
  assert.equal(asn1.parseDer(der).children[0].value[0], 0);
  assert.deepEqual(asn1.ecdsaDerSignatureToRaw(der, 32), raw);
  expectInvalid(function () { asn1.ecdsaRawSignatureToDer(fromHex('010203')); });
  expectInvalid(function () { asn1.ecdsaDerSignatureToRaw(fromHex('30060201ff020101'), 1); }, /negative/);
});

test('DER parser copies caller-owned input', function () {
  var encoded = asn1.derSequence([asn1.derInteger(7)]);
  var parsed = asn1.parseDer(encoded);
  encoded.fill(0);
  assert.equal(hex(parsed.raw), '3003020107');
  assert.equal(asn1.decodeInteger(parsed.children[0]), 7n);
});

test('non-canonical and truncated DER encodings fail closed', function () {
  [
    '30800000',
    '02810100',
    '0202007f',
    '0202ff80',
    '010101',
    '03020101',
    '050100',
    '0600',
    '06028000',
    '1000',
    '2200',
    '1f1e00',
    '0c02c0af',
    '30030201',
    '05000500',
    '3106020102020101',
  ].forEach(function (encoded) {
    expectInvalid(function () { asn1.parseDer(fromHex(encoded)); });
  });
});

test('DER parser enforces input, element, nesting, and element-count limits', function () {
  var nested = asn1.derSequence([asn1.derSequence([asn1.derNull()])]);
  expectInvalid(function () { asn1.parseDer(nested, { maxInputBytes: nested.length - 1 }); }, /maxInputBytes/);
  expectInvalid(function () { asn1.parseDer(nested, { maxElementBytes: 2 }); }, /maxElementBytes/);
  expectInvalid(function () { asn1.parseDer(nested, { maxDepth: 1 }); }, /maxDepth/);
  expectInvalid(function () { asn1.parseDer(nested, { maxElements: 2 }); }, /too many elements/);
  expectInvalid(function () { asn1.parseDer(nested, { maxDepth: -1 }); });
});

test('malformed CSR, certificate, PEM, and mismatched certificate algorithms fail closed', function () {
  expectInvalid(function () { asn1.parseCertificationRequest(asn1.derSequence([])); }, /number of fields/);
  expectInvalid(function () { asn1.parseCertificate(asn1.derSequence([])); }, /number of fields/);
  expectInvalid(function () { asn1.pemToDer('-----BEGIN ONE-----\nAA==\n-----END TWO-----\n'); });
  expectInvalid(function () {
    asn1.pemToDer(asn1.derToPem('CERTIFICATE', asn1.derNull()), 'CERTIFICATE REQUEST');
  }, /label/);

  var utc = asn1.encodeTlv(asn1.TAG_CLASSES.UNIVERSAL, false, asn1.UNIVERSAL_TAGS.UTC_TIME, ascii('260101000000Z'));
  var other = asn1.derAlgorithmIdentifier('1.2.4', asn1.derNull());
  expectInvalid(function () { asn1.parseCertificate(syntheticCertificate(utc, utc, other)); }, /do not match/);
});

test('bounded deterministic malformed-input sweep always terminates cleanly', function () {
  var state = 0xa51c0dec;
  function nextByte() {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state & 0xff;
  }

  for (var sample = 0; sample < 512; sample += 1) {
    var input = new Uint8Array(nextByte() % 65);
    for (var index = 0; index < input.length; index += 1) input[index] = nextByte();
    try {
      asn1.parseDer(input, {
        maxInputBytes: 64,
        maxElementBytes: 64,
        maxDepth: 8,
        maxElements: 64,
      });
    } catch (error) {
      assert.equal(error && error.code, 'INVALID_DER');
    }
  }
});
