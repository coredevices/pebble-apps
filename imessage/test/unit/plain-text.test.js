'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decodeBinaryPlist } = require('../../src/codecs/binary-plist');
const { ungzip } = require('../../src/codecs/gzip');
const plainText = require('../../src/imessage/plain-text');

test('plain-text body preserves Unicode, spaces, and line breaks exactly', function () {
  const text = '  hello 👋🏽\ne\u0301  ';
  const message = plainText.buildPlainTextMessage({
    recipient: 'mailto:recipient@example.invalid',
    sender: 'tel:+15555550123',
    text,
    messageId: '00112233-4455-4677-8899-AABBCCDDEEFF',
    conversationId: 'FFEEDDCC-BBAA-4988-8776-554433221100',
  });
  assert.equal(message.command, 100);
  assert.equal(message.id, '00112233-4455-4677-8899-AABBCCDDEEFF');
  assert.deepEqual(decodeBinaryPlist(ungzip(message.body)), {
    t: text,
    p: ['mailto:recipient@example.invalid', 'tel:+15555550123'],
    gid: 'ffeeddcc-bbaa-4988-8776-554433221100', pv: 0, gv: '8', v: '1',
  });
});

test('UUID formatting fixes version and variant without mutating random input', function () {
  const random = new Uint8Array(16);
  assert.equal(plainText.formatUuid(random, true), '00000000-0000-4000-8000-000000000000');
  assert.deepEqual(random, new Uint8Array(16));
});

test('plain text accepts whitespace but rejects empty text and non-normalized handles', function () {
  const base = {
    recipient: 'tel:+15555550123', sender: 'mailto:sender@example.invalid', text: ' ',
    messageId: '00112233-4455-4677-8899-AABBCCDDEEFF',
    conversationId: 'FFEEDDCC-BBAA-4988-8776-554433221100',
  };
  assert.doesNotThrow(() => plainText.buildPlainTextMessage(base));
  assert.throws(() => plainText.buildPlainTextMessage({ ...base, text: '' }), /non-empty/);
  assert.throws(() => plainText.buildPlainTextMessage({ ...base, recipient: '+15555550123' }), /normalized/);
});
