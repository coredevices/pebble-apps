'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

// This is the exact image used by Corten's last inspectable portable NAC implementation. The
// image is fetched at runtime and hash-pinned; it is deliberately not redistributed in the PBW.
var PINNED_IMAGE_URL = 'https://raw.githubusercontent.com/JJTech0130/nacserver/main/IMDAppleServices';
var PINNED_IMAGE_SHA1 = 'e1181ccad82e6629d52c6a006645ad87ee59bd13';
var PINNED_IMAGE_SHA256 = '74c2a8fe826a478f14f6e17b3709a8b315e8c0e0e34e3fba6b9c4eee2f4516e9';
var PINNED_X86_64_SHA256 = '7f225430438171b2d460cd953fe1110a2d6699e6d0d944780471ef58fd075d9f';
var PINNED_IMAGE_SHA1_BYTES = bytes.hexToBytes(PINNED_IMAGE_SHA1);
var PINNED_IMAGE_SHA256_BYTES = bytes.hexToBytes(PINNED_IMAGE_SHA256);
var PINNED_X86_64_SHA256_BYTES = bytes.hexToBytes(PINNED_X86_64_SHA256);
var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
var FAT_MAGIC = 0xcafebabe;
var MACHO_64_MAGIC_LE = 0xfeedfacf;
var CPU_TYPE_X86_64 = 0x01000007;
var FAT_ARCH_BYTES = 20;
var MAX_FAT_ARCHES = 32;

function imageError(code, message, kind, retryable, details) {
  return new RuntimeError(code, message, {
    kind: kind,
    retryable: retryable === true,
    details: details,
  });
}

function digestPinnedImage(crypto, algorithm, value, diagnosticCode) {
  try {
    return crypto.digest(algorithm, value);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw imageError(
      'NAC_IMAGE_VERIFICATION_FAILED',
      'The NAC image could not be verified.',
      ERROR_KINDS.INTERNAL,
      false,
      { diagnosticCode: diagnosticCode }
    );
  }
}

function buildImageRequest() {
  return Object.freeze({
    method: 'GET',
    url: PINNED_IMAGE_URL,
    headers: Object.freeze([]),
    body: new Uint8Array(0),
    maxResponseBytes: MAX_IMAGE_BYTES,
  });
}

function requireBoundedImage(image) {
  if (!(image instanceof Uint8Array) || image.length < 32 || image.length > MAX_IMAGE_BYTES) {
    throw imageError('NAC_IMAGE_INVALID', 'The NAC image is malformed or too large.', ERROR_KINDS.TRANSPORT);
  }
  return image;
}

function extractX86_64Slice(image) {
  requireBoundedImage(image);
  var magic = bytes.readUint32BE(image, 0);
  if (magic !== FAT_MAGIC) {
    if (bytes.readUint32LE(image, 0) !== MACHO_64_MAGIC_LE
        || bytes.readUint32LE(image, 4) !== CPU_TYPE_X86_64) {
      throw imageError('NAC_IMAGE_INVALID', 'The NAC image has no x86-64 Mach-O slice.', ERROR_KINDS.TRANSPORT);
    }
    return new Uint8Array(image);
  }

  var count = bytes.readUint32BE(image, 4);
  if (count < 1 || count > MAX_FAT_ARCHES || 8 + count * FAT_ARCH_BYTES > image.length) {
    throw imageError('NAC_IMAGE_INVALID', 'The NAC universal image header is malformed.', ERROR_KINDS.TRANSPORT);
  }
  for (var index = 0; index < count; index += 1) {
    var entry = 8 + index * FAT_ARCH_BYTES;
    var cpuType = bytes.readUint32BE(image, entry);
    var offset = bytes.readUint32BE(image, entry + 8);
    var size = bytes.readUint32BE(image, entry + 12);
    var alignment = bytes.readUint32BE(image, entry + 16);
    if (alignment > 31 || size === 0 || offset > image.length || size > image.length - offset) {
      throw imageError('NAC_IMAGE_INVALID', 'The NAC universal image contains an invalid slice.', ERROR_KINDS.TRANSPORT);
    }
    if (cpuType === CPU_TYPE_X86_64) {
      var slice = image.slice(offset, offset + size);
      if (slice.length < 32 || bytes.readUint32LE(slice, 0) !== MACHO_64_MAGIC_LE
          || bytes.readUint32LE(slice, 4) !== CPU_TYPE_X86_64) {
        throw imageError('NAC_IMAGE_INVALID', 'The NAC x86-64 slice is malformed.', ERROR_KINDS.TRANSPORT);
      }
      return slice;
    }
  }
  throw imageError('NAC_IMAGE_INVALID', 'The NAC image has no x86-64 Mach-O slice.', ERROR_KINDS.TRANSPORT);
}

function verifyPinnedImage(image, crypto) {
  requireBoundedImage(image);
  if (!crypto || typeof crypto.digest !== 'function') {
    throw new TypeError('NAC image verification requires a digest primitive.');
  }
  var sha1 = digestPinnedImage(crypto, 'sha1', image, 'image-sha1-digest');
  var sha256 = digestPinnedImage(crypto, 'sha256', image, 'image-sha256-digest');
  if (!(sha1 instanceof Uint8Array) || !bytes.bytesEqual(sha1, PINNED_IMAGE_SHA1_BYTES)
      || !(sha256 instanceof Uint8Array) || !bytes.bytesEqual(sha256, PINNED_IMAGE_SHA256_BYTES)) {
    throw imageError('NAC_IMAGE_HASH_MISMATCH', 'The downloaded NAC image failed integrity verification.', ERROR_KINDS.TRANSPORT);
  }
  var slice = extractX86_64Slice(image);
  var sliceSha256 = digestPinnedImage(crypto, 'sha256', slice, 'slice-sha256-digest');
  if (!(sliceSha256 instanceof Uint8Array)
      || !bytes.bytesEqual(sliceSha256, PINNED_X86_64_SHA256_BYTES)) {
    throw imageError('NAC_IMAGE_HASH_MISMATCH', 'The NAC x86-64 slice failed integrity verification.', ERROR_KINDS.TRANSPORT);
  }
  return slice;
}

async function loadPinnedImage(effects, crypto) {
  if (!effects || !effects.http || typeof effects.http.request !== 'function') {
    throw new TypeError('NAC image loading requires HTTP effects.');
  }
  var response;
  try {
    response = await effects.http.request(buildImageRequest());
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw imageError('NAC_IMAGE_DOWNLOAD_FAILED', 'The NAC image download failed.', ERROR_KINDS.TRANSPORT, true);
  }
  if (!response || !Number.isSafeInteger(response.status) || !(response.body instanceof Uint8Array)) {
    throw imageError('NAC_IMAGE_DOWNLOAD_FAILED', 'The NAC image download returned a malformed response.', ERROR_KINDS.TRANSPORT, true);
  }
  if (response.status < 200 || response.status >= 300) {
    throw imageError('NAC_IMAGE_DOWNLOAD_FAILED', 'The NAC image download was rejected.', ERROR_KINDS.TRANSPORT, true, {
      httpStatus: response.status,
    });
  }
  return verifyPinnedImage(response.body, crypto);
}

module.exports = {
  CPU_TYPE_X86_64: CPU_TYPE_X86_64,
  FAT_MAGIC: FAT_MAGIC,
  MACHO_64_MAGIC_LE: MACHO_64_MAGIC_LE,
  MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
  PINNED_IMAGE_SHA1: PINNED_IMAGE_SHA1,
  PINNED_IMAGE_SHA256: PINNED_IMAGE_SHA256,
  PINNED_IMAGE_URL: PINNED_IMAGE_URL,
  PINNED_X86_64_SHA256: PINNED_X86_64_SHA256,
  buildImageRequest: buildImageRequest,
  extractX86_64Slice: extractX86_64Slice,
  loadPinnedImage: loadPinnedImage,
  verifyPinnedImage: verifyPinnedImage,
};
