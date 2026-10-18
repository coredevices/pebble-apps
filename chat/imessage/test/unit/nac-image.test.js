'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const bytes = require('../../src/runtime/bytes');
const image = require('../../src/nac/image');

function writeU32BE(target, offset, value) {
  target.set(bytes.uint32BE(value), offset);
}

function writeU32LE(target, offset, value) {
  target.set(bytes.uint32LE(value), offset);
}

function thinImage(marker) {
  const result = new Uint8Array(64);
  writeU32LE(result, 0, image.MACHO_64_MAGIC_LE);
  writeU32LE(result, 4, image.CPU_TYPE_X86_64);
  result[32] = marker;
  return result;
}

function universalImage(slice) {
  const offset = 64;
  const result = new Uint8Array(offset + slice.length);
  writeU32BE(result, 0, image.FAT_MAGIC);
  writeU32BE(result, 4, 2);
  writeU32BE(result, 8, 7);
  writeU32BE(result, 16, 48);
  writeU32BE(result, 20, 8);
  writeU32BE(result, 24, 2);
  writeU32BE(result, 28, image.CPU_TYPE_X86_64);
  writeU32BE(result, 36, offset);
  writeU32BE(result, 40, slice.length);
  writeU32BE(result, 44, 4);
  result.set(slice, offset);
  return result;
}

test('NAC image request pins the Corten-compatible source entirely in JS', function () {
  assert.deepEqual(image.buildImageRequest(), {
    method: 'GET', url: image.PINNED_IMAGE_URL, headers: [], body: new Uint8Array(0),
    maxResponseBytes: image.MAX_IMAGE_BYTES,
  });
  assert.equal(image.PINNED_IMAGE_URL,
    'https://raw.githubusercontent.com/JJTech0130/nacserver/main/IMDAppleServices');
  assert.equal(image.PINNED_IMAGE_SHA1, 'e1181ccad82e6629d52c6a006645ad87ee59bd13');
});

test('NAC image parser copies thin x86-64 images and extracts bounded universal slices', function () {
  const thin = thinImage(41);
  const direct = image.extractX86_64Slice(thin);
  assert.deepEqual(direct, thin);
  assert.notEqual(direct, thin);

  const extracted = image.extractX86_64Slice(universalImage(thin));
  assert.deepEqual(extracted, thin);
  assert.equal(extracted[32], 41);
});

test('NAC image parser rejects missing architectures, truncated slices, and oversized inputs', function () {
  const wrong = thinImage(0);
  writeU32LE(wrong, 4, 7);
  assert.throws(() => image.extractX86_64Slice(wrong), /no x86-64/);

  const truncated = universalImage(thinImage(0));
  writeU32BE(truncated, 40, 1024);
  assert.throws(() => image.extractX86_64Slice(truncated), /invalid slice/);

  assert.throws(() => image.extractX86_64Slice(new Uint8Array(image.MAX_IMAGE_BYTES + 1)), /too large/);
});

test('NAC image verification fails closed before parsing when the SHA-1 pin differs', function () {
  const thin = thinImage(9);
  const algorithms = [];
  assert.throws(() => image.verifyPinnedImage(thin, {
    digest: function (algorithm) {
      algorithms.push(algorithm);
      return new Uint8Array(algorithm === 'sha1' ? 20 : 32);
    },
  }), error => error.code === 'NAC_IMAGE_HASH_MISMATCH');
  assert.deepEqual(algorithms, ['sha1', 'sha256']);
});

test('NAC image verification normalizes generic digest failures with a safe stage', function () {
  assert.throws(() => image.verifyPinnedImage(thinImage(9), {
    digest: function () { throw new Error('provider detail must not escape'); },
  }), error => error.code === 'NAC_IMAGE_VERIFICATION_FAILED'
    && error.details.diagnosticCode === 'image-sha1-digest'
    && !error.message.includes('provider detail'));
});

test('NAC image loader validates HTTP and returns only the verified x86-64 slice', async function () {
  const thin = thinImage(73);
  const fat = universalImage(thin);
  const result = await image.loadPinnedImage({ http: { request: async function (request) {
    assert.equal(request.url, image.PINNED_IMAGE_URL);
    return { status: 200, headers: [], body: fat };
  } } }, { digest: function (algorithm, value) {
    if (algorithm === 'sha1') return bytes.hexToBytes(image.PINNED_IMAGE_SHA1);
    return bytes.hexToBytes(value === fat ? image.PINNED_IMAGE_SHA256 : image.PINNED_X86_64_SHA256);
  } });
  assert.deepEqual(result, thin);

  await assert.rejects(image.loadPinnedImage({ http: { request: async function () {
    return { status: 503, headers: [], body: new Uint8Array(0) };
  } } }, { digest: function () { throw new Error('must not hash'); } }), error => (
    error.code === 'NAC_IMAGE_DOWNLOAD_FAILED' && error.details.httpStatus === 503
  ));
});
