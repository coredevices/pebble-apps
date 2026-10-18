'use strict';

const {
  appendPath,
  decodeByteString,
  isByteString,
  validateEffect,
  validateJson,
} = require('./schema');

function equal() {
  return { equal: true };
}

function mismatch(path, reason, left, right, byteOffset) {
  const result = { equal: false, path, reason, left, right };
  if (byteOffset !== undefined) result.byteOffset = byteOffset;
  return result;
}

function compareBytes(left, right, path) {
  const leftBytes = decodeByteString(left);
  const rightBytes = decodeByteString(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let offset = 0; offset < sharedLength; offset += 1) {
    if (leftBytes[offset] !== rightBytes[offset]) {
      return mismatch(
        path,
        `byte differs at offset ${offset}`,
        leftBytes[offset],
        rightBytes[offset],
        offset,
      );
    }
  }
  if (leftBytes.length !== rightBytes.length) {
    return mismatch(
      path,
      `byte length differs (${leftBytes.length} !== ${rightBytes.length})`,
      leftBytes.length > sharedLength ? leftBytes[sharedLength] : undefined,
      rightBytes.length > sharedLength ? rightBytes[sharedLength] : undefined,
      sharedLength,
    );
  }
  return equal();
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Deterministic structural comparison for harness JSON. Object field order is
 * irrelevant; array order, duplicate headers, and byte order are significant.
 */
function compareExact(left, right, path = '$') {
  if (Object.is(left, right)) return equal();

  const leftIsBytes = isByteString(left);
  const rightIsBytes = isByteString(right);
  if (leftIsBytes || rightIsBytes) {
    if (!leftIsBytes || !rightIsBytes) {
      return mismatch(path, 'one value is binary and the other is not', left, right);
    }
    return compareBytes(left, right, path);
  }

  const leftType = valueType(left);
  const rightType = valueType(right);
  if (leftType !== rightType) {
    return mismatch(path, `type differs (${leftType} !== ${rightType})`, left, right);
  }

  if (leftType === 'array') {
    const sharedLength = Math.min(left.length, right.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const comparison = compareExact(left[index], right[index], `${path}[${index}]`);
      if (!comparison.equal) return comparison;
    }
    if (left.length !== right.length) {
      return mismatch(
        `${path}[${sharedLength}]`,
        `array length differs (${left.length} !== ${right.length})`,
        left[sharedLength],
        right[sharedLength],
      );
    }
    return equal();
  }

  if (leftType === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    const keys = Array.from(new Set([...leftKeys, ...rightKeys])).sort();
    for (const key of keys) {
      const leftHas = Object.prototype.hasOwnProperty.call(left, key);
      const rightHas = Object.prototype.hasOwnProperty.call(right, key);
      const fieldPath = appendPath(path, key);
      if (!leftHas || !rightHas) {
        return mismatch(
          fieldPath,
          `field exists only on ${leftHas ? 'left' : 'right'}`,
          leftHas ? left[key] : undefined,
          rightHas ? right[key] : undefined,
        );
      }
      const comparison = compareExact(left[key], right[key], fieldPath);
      if (!comparison.equal) return comparison;
    }
    return equal();
  }

  return mismatch(path, 'value differs', left, right);
}

function normalizeComparatorResult(result, fallbackDescription) {
  if (result === undefined || result === null) return undefined;
  if (result === true) return equal();
  if (result === false) return mismatch('$', fallbackDescription || 'semantic comparison failed');
  if (typeof result !== 'object' || typeof result.equal !== 'boolean') {
    throw new TypeError('Comparator must return boolean, { equal, ... }, null, or undefined');
  }
  if (result.equal) return equal();
  return {
    equal: false,
    path: result.path || '$',
    reason: result.reason || fallbackDescription || 'semantic comparison failed',
    left: result.left,
    right: result.right,
    ...(result.byteOffset === undefined ? {} : { byteOffset: result.byteOffset }),
  };
}

/**
 * Returns a comparator hook from a semantic predicate. The predicate receives
 * `(left, right, context)` and may validate signatures or decoded structures.
 */
function semanticComparator(predicate, description = 'semantic comparison failed') {
  if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
  return (left, right, context) => normalizeComparatorResult(
    predicate(left, right, context),
    description,
  );
}

function getComparator(comparators, kind) {
  if (!comparators) return undefined;
  if (comparators instanceof Map) return comparators.get(kind) || comparators.get('*');
  return comparators[kind] || comparators['*'];
}

function compareEffects(left, right, options = {}) {
  validateEffect(left, '$.left');
  validateEffect(right, '$.right');

  if (left.kind !== right.kind) return compareExact(left, right);
  const hook = getComparator(options.comparators, left.kind);
  if (hook) {
    const context = Object.freeze({
      kind: left.kind,
      effectIndex: options.effectIndex,
      turn: options.turn,
      compareExact,
      mismatch,
    });
    const result = normalizeComparatorResult(hook(left, right, context));
    if (result !== undefined) return result;
  }
  return compareExact(left, right);
}

function compareSnapshots(left, right, comparator, context = {}) {
  validateJson(left, '$.leftSnapshot');
  validateJson(right, '$.rightSnapshot');
  if (comparator) {
    const result = normalizeComparatorResult(comparator(left, right, Object.freeze({
      ...context,
      compareExact,
      mismatch,
    })));
    if (result !== undefined) return result;
  }
  return compareExact(left, right);
}

module.exports = {
  compareBytes,
  compareEffects,
  compareExact,
  compareSnapshots,
  mismatch,
  semanticComparator,
};
