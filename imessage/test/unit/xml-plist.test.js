'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var bytes = require('../../src/runtime/bytes');
var xmlPlist = require('../../src/codecs/xml-plist');

test('XML plist round-trips send-only scalar and container values deterministically', function () {
  var value = {
    account: 'user+test@example.com',
    escaped: '<tag attr="yes">Tom & Jerry</tag>',
    enabled: true,
    disabled: false,
    count: -9007199254740991,
    payload: new Uint8Array([0, 1, 127, 128, 255]),
    created: new Date('2024-02-03T04:05:06.789Z'),
    nested: ['🪶', { empty: '' }],
  };

  var first = xmlPlist.encodeXmlPlist(value);
  var second = xmlPlist.encodeXmlPlist(value);
  assert.deepEqual(first, second);
  assert.deepEqual(xmlPlist.decodeXmlPlist(first), value);
  assert.match(bytes.bytesToUtf8(first), /&lt;tag attr=&quot;yes&quot;&gt;Tom &amp; Jerry&lt;\/tag&gt;/);
});

test('XML plist real wrapper selects real wire type without changing decoded numeric values', function () {
  var encoded = xmlPlist.encodeXmlPlist({
    integer: 1,
    realInteger: xmlPlist.real(1),
    realFraction: xmlPlist.real(-0.125),
    negativeZero: xmlPlist.real(-0),
  });
  var xml = bytes.bytesToUtf8(encoded);

  assert.match(xml, /<key>integer<\/key><integer>1<\/integer>/);
  assert.match(xml, /<key>realInteger<\/key><real>1<\/real>/);
  assert.match(xml, /<key>realFraction<\/key><real>-0\.125<\/real>/);
  assert.match(xml, /<key>negativeZero<\/key><real>-0<\/real>/);
  var decoded = xmlPlist.decodeXmlPlist(encoded);
  assert.equal(decoded.integer, 1);
  assert.equal(decoded.realInteger, 1);
  assert.equal(decoded.realFraction, -0.125);
  assert.equal(Object.is(decoded.negativeZero, -0), true);
  assert.throws(function () { xmlPlist.real(Infinity); }, /finite numbers/);
  assert.throws(function () { xmlPlist.real(NaN); }, /finite numbers/);
});

test('XML plist decoder accepts canonical whitespace, comments, entities, and split base64', function () {
  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><!-- safe comment --><dict>\n' +
    '<key>message</key><string>A&amp;B &#x1FABA;</string>\n' +
    '<key>data</key><data>AAE=\n</data><key>emptyData</key><data />' +
    '<key>items</key><array /></dict></plist>';

  assert.deepEqual(xmlPlist.decodeXmlPlist(xml), {
    message: 'A&B 🪺',
    data: new Uint8Array([0, 1]),
    emptyData: new Uint8Array(0),
    items: [],
  });
});

test('XML plist decoder accepts the standard standalone declaration emitted by Apple services', function () {
  var encoded = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict><key>value</key><string>ok</string>'
    + '<key>interval</key><real>10.0</real></dict></plist>';
  assert.deepEqual(xmlPlist.decodeXmlPlist(encoded), { value: 'ok', interval: 10 });

  var legacy = encoded.replace('-//Apple//DTD', '-//Apple Computer//DTD');
  assert.deepEqual(xmlPlist.decodeXmlPlist(legacy), { value: 'ok', interval: 10 });
});

test('XML plist decoder accepts the bare value root used by encrypted GSA service data', function () {
  var bare = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<dict><key>account</key><string>test</string>'
    + '<key>tokens</key><array><integer>1</integer><true/></array></dict>';
  assert.deepEqual(xmlPlist.decodeXmlPlist(bare), {
    account: 'test',
    tokens: [1, true],
  });
  assert.equal(xmlPlist.decodeXmlPlist('<string>bare</string>'), 'bare');
});

test('XML plist parser rejects DTD expansion, nested markup, duplicates, and null encoding', function () {
  assert.throws(function () {
    xmlPlist.decodeXmlPlist('<!DOCTYPE plist [<!ENTITY x "boom">]><plist version="1.0"><string>&x;</string></plist>');
  }, /fixed Apple plist DOCTYPE/);
  assert.throws(function () {
    xmlPlist.decodeXmlPlist('<plist version="1.0"><string><b>nested<\/b></string></plist>');
  }, /nested markup/);
  assert.throws(function () {
    xmlPlist.decodeXmlPlist('<plist version="1.0"><dict><key>x</key><true/><key>x</key><false/></dict></plist>');
  }, /duplicate key/);
  assert.throws(function () { xmlPlist.encodeXmlPlist(null); }, /cannot represent null/);
  assert.throws(function () { xmlPlist.encodeXmlPlist('\ud800'); }, /unpaired surrogate/);
});

test('XML plist parsing enforces byte, depth, node, container, string, and data bounds', function () {
  var encoded = xmlPlist.encodeXmlPlist({ value: ['abc', new Uint8Array([1, 2, 3])] });
  assert.throws(function () { xmlPlist.decodeXmlPlist(encoded, { maxInputBytes: encoded.length - 1 }); }, /maxInputBytes/);
  assert.throws(function () { xmlPlist.decodeXmlPlist(encoded, { maxDepth: 1 }); }, /maxDepth/);
  assert.throws(function () { xmlPlist.decodeXmlPlist(encoded, { maxNodes: 2 }); }, /too many nodes/);
  assert.throws(function () { xmlPlist.decodeXmlPlist(encoded, { maxContainerLength: 0 }); }, /maxContainerLength/);
  assert.throws(function () { xmlPlist.decodeXmlPlist(encoded, { maxStringBytes: 2 }); }, /maxStringBytes/);
  assert.throws(function () { xmlPlist.decodeXmlPlist(encoded, { maxDataBytes: 2 }); }, /maxDataBytes/);
});

test('XML plist rejects malformed UTF-8, integers, dates, base64, and trailing content', function () {
  assert.throws(function () { xmlPlist.decodeXmlPlist(new Uint8Array([0xff])); }, /UTF-8/);
  assert.throws(function () { xmlPlist.decodeXmlPlist('<plist version="1.0"><integer>01</integer></plist>'); }, /Integer/);
  assert.throws(function () { xmlPlist.decodeXmlPlist('<plist version="1.0"><date>not-a-date</date></plist>'); }, /Date/);
  assert.throws(function () { xmlPlist.decodeXmlPlist('<plist version="1.0"><date>2024-02-30T00:00:00Z</date></plist>'); }, /Date/);
  assert.throws(function () { xmlPlist.decodeXmlPlist('<plist version="1.0"><data>***</data></plist>'); }, /base64/);
  assert.throws(function () { xmlPlist.decodeXmlPlist('<plist version="1.0"><true/></plist>junk'); }, /after plist root/);
});
