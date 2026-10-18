import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { capturePublicVector, deterministicRandomWords } from './capture.mjs';

const require = createRequire(import.meta.url);
const bplist = require('../../src/codecs/binary-plist');

const SESSION_REQUEST = new Uint8Array([1, 3, 3, 7]);
const SESSION_INFO = new Uint8Array([9, 8, 7, 6]);
const VALIDATION = new Uint8Array([4, 2, 4, 2]);
const SESSION_ID = 'a'.repeat(64);

function success(request, result) {
  return { schema_version: 1, request_id: request.request_id, ok: true, result };
}

function mismatch(request) {
  return {
    schema_version: 1,
    request_id: request.request_id,
    ok: false,
    error: { code: 'deterministic_random_mismatch' },
  };
}

test('deterministic random sequence is stable and bounded', () => {
  assert.deepEqual(deterministicRandomWords(3), [0x6d2b79f5, 0x0b62f3ae, 0xa99a6d67]);
  assert.throws(() => deterministicRandomWords(4097), { code: 'NAC_CAPTURE_RANDOM_INVALID' });
});

test('captures one public session and proves the exact oracle transcript twice', async () => {
  let activeCount = null;
  let initializationPosts = 0;
  let completions = 0;
  const oracle = {
    async request(request) {
      if (request.operation === 'initialize_nac_validation') {
        const count = request.arc4random_words.length;
        if (count < 2) return mismatch(request);
        assert.equal(activeCount, null);
        activeCount = count;
        return success(request, {
          session_id: SESSION_ID,
          session_info_request_base64: Buffer.from(SESSION_REQUEST).toString('base64'),
        });
      }
      if (request.operation === 'complete_nac_validation') {
        assert.equal(request.session_id, SESSION_ID);
        assert.deepEqual(Buffer.from(request.session_info_base64, 'base64'), Buffer.from(SESSION_INFO));
        const count = activeCount;
        activeCount = null;
        completions += 1;
        if (count < 4) return mismatch(request);
        return success(request, {
          session_id: SESSION_ID,
          validation_data_base64: Buffer.from(VALIDATION).toString('base64'),
          arc4random_words_consumed: 4,
          corten_commit: '501403fcbe8802cc427e9ccab3573c5367508fdf',
          nac_binary_sha1: 'e1181ccad82e6629d52c6a006645ad87ee59bd13',
          nac_binary_sha256: '74c2a8fe826a478f14f6e17b3709a8b315e8c0e0e34e3fba6b9c4eee2f4516e9',
          nac_x86_64_slice_sha256: '7f225430438171b2d460cd953fe1110a2d6699e6d0d944780471ef58fd075d9f',
        });
      }
      assert.fail(`unexpected oracle operation ${request.operation}`);
    },
  };

  const bag = bplist.encodeBinaryPlist({
    'id-authenticate-ds-id': 'https://identity.ess.apple.com/auth',
    'id-get-handles': 'https://identity.ess.apple.com/handles',
    'id-register': 'https://identity.ess.apple.com/register',
    'id-query': 'https://identity.ess.apple.com/query',
    'id-validation-cert': 'http://static.ess.apple.com/validation/cert',
    'id-initialize-validation': 'https://identity.ess.apple.com/initialize',
  });
  const responses = {
    'https://init.ess.apple.com/WebObjects/VCInit.woa/wa/getBag?ix=3': bplist.encodeBinaryPlist({ bag }),
    'https://static.ess.apple.com/validation/cert': bplist.encodeBinaryPlist({ cert: new Uint8Array([5, 4, 3, 2, 1]) }),
    'https://identity.ess.apple.com/initialize': bplist.encodeBinaryPlist({ 'session-info': SESSION_INFO }),
  };
  const httpRequest = async (request) => {
    assert.deepEqual(request.headers, []);
    if (request.method === 'POST') initializationPosts += 1;
    const body = responses[request.url];
    assert.ok(body, `unexpected URL ${request.url}`);
    return { status: 200, body };
  };

  const vector = await capturePublicVector({
    oracle, httpRequest, hardware: require('./vector').SYNTHETIC_HARDWARE,
  });
  assert.equal(initializationPosts, 1);
  assert.equal(completions, 4);
  assert.equal(activeCount, null);
  assert.deepEqual(vector.arc4randomWords, deterministicRandomWords(4));
  assert.equal(vector.expected.sessionInfoRequest.base64, Buffer.from(SESSION_REQUEST).toString('base64'));
  assert.equal(vector.expected.validationData.base64, Buffer.from(VALIDATION).toString('base64'));
  assert.match(vector.id, /^apple-public-nac-[0-9a-f]{16}-[0-9a-f]{16}$/);
});

test('cancels the pending context if the single public initialization request fails', async () => {
  const operations = [];
  const oracle = {
    async request(request) {
      operations.push(request.operation);
      if (request.operation === 'initialize_nac_validation') {
        return success(request, {
          session_id: SESSION_ID,
          session_info_request_base64: Buffer.from(SESSION_REQUEST).toString('base64'),
        });
      }
      if (request.operation === 'cancel_nac_validation') {
        return success(request, { session_id: SESSION_ID, cancelled: true });
      }
      assert.fail(`unexpected operation ${request.operation}`);
    },
  };
  const bag = bplist.encodeBinaryPlist({
    'id-authenticate-ds-id': 'https://identity.ess.apple.com/auth',
    'id-get-handles': 'https://identity.ess.apple.com/handles',
    'id-register': 'https://identity.ess.apple.com/register',
    'id-query': 'https://identity.ess.apple.com/query',
    'id-validation-cert': 'https://static.ess.apple.com/validation/cert',
    'id-initialize-validation': 'https://identity.ess.apple.com/initialize',
  });
  const httpRequest = async (request) => {
    if (request.url === 'https://init.ess.apple.com/WebObjects/VCInit.woa/wa/getBag?ix=3') {
      return { status: 200, body: bplist.encodeBinaryPlist({ bag }) };
    }
    if (request.url.includes('/validation/cert')) {
      return { status: 200, body: bplist.encodeBinaryPlist({ cert: new Uint8Array([1]) }) };
    }
    return { status: 503, body: new Uint8Array() };
  };
  await assert.rejects(
    capturePublicVector({
      oracle, httpRequest, hardware: require('./vector').SYNTHETIC_HARDWARE,
    }),
    { code: 'NAC_CAPTURE_HTTP_REJECTED' },
  );
  assert.deepEqual(operations, ['initialize_nac_validation', 'cancel_nac_validation']);
});
