const test = require('node:test');
const assert = require('node:assert/strict');
const { withSetupProgress } = require('./src/settings/connections');

for (const fails of [false, true]) test(`setup progress restores controls after ${fails ? 'failure' : 'success'}`, async () => {
  function element() {
    return { children: [], attrs: {}, append(...items) { this.children.push(...items); },
      setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.removed = true; } };
  }
  global.document = { createElement: element };
  const parent = element();
  const controls = [{ disabled: false }, { disabled: true }];
  parent.querySelectorAll = () => controls;
  let finish;
  const pending = withSetupProgress(parent, 'Finishing iMessage setup…', () => new Promise((resolve, reject) => {
    finish = () => fails ? reject(Error('failed')) : resolve('done');
  }));
  assert.ok(controls.every(control => control.disabled));
  assert.equal(parent.attrs['aria-busy'], 'true');
  assert.equal(parent.children[0].attrs.role, 'status');
  finish();
  if (fails) await assert.rejects(pending, /failed/); else assert.equal(await pending, 'done');
  assert.equal(parent.attrs['aria-busy'], 'false');
  assert.equal(parent.children[0].removed, true);
  assert.deepEqual(controls.map(control => control.disabled), [false, true]);
});
