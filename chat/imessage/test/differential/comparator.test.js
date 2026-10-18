'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  byteString,
  compareExact,
  semanticComparator,
} = require('../../harness');

test('exact comparison identifies the first nested field divergence', () => {
  const result = compareExact(
    { headers: [['one', 'same'], ['two', 'left']] },
    { headers: [['one', 'same'], ['two', 'right']] },
  );
  assert.deepEqual(
    { equal: result.equal, path: result.path, reason: result.reason },
    { equal: false, path: '$.headers[1][1]', reason: 'value differs' },
  );
});

test('exact comparison identifies the first byte and length divergence', () => {
  const changed = compareExact(byteString([0x10, 0x20, 0x30]), byteString([0x10, 0x20, 0x31]));
  assert.equal(changed.path, '$');
  assert.equal(changed.byteOffset, 2);
  assert.equal(changed.left, 0x30);
  assert.equal(changed.right, 0x31);

  const truncated = compareExact(byteString([1, 2]), byteString([1, 2, 3]));
  assert.equal(truncated.byteOffset, 2);
  assert.match(truncated.reason, /byte length differs/);
});

test('semantic comparator wraps a decoded-equivalence predicate', () => {
  const comparator = semanticComparator(
    (left, right) => left.digest === right.digest,
    'decoded digests differ',
  );
  assert.deepEqual(comparator(
    { digest: 'same', randomizedSignature: 'one' },
    { digest: 'same', randomizedSignature: 'two' },
    {},
  ), { equal: true });
  assert.deepEqual(comparator(
    { digest: 'left' },
    { digest: 'right' },
    {},
  ), {
    equal: false,
    path: '$',
    reason: 'decoded digests differ',
    left: undefined,
    right: undefined,
  });
});
