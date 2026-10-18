const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { activityLabel } = require('./src/settings/dom');
const { chatAddress, chatPresentation } = require('./src/settings/chat-display');

test('packaged settings script parses', () => {
  const html = fs.readFileSync(path.join(__dirname, 'config.html'), 'utf8');
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test('activity timestamps accept seconds and milliseconds and hide missing dates', () => {
  const now = new Date(); now.setSeconds(0, 0);
  assert.match(activityLabel(now.getTime()), /^Today,/);
  assert.equal(activityLabel(now.getTime()), activityLabel(now.getTime() / 1000));
  assert.equal(activityLabel(null), '');
  assert.equal(activityLabel('unavailable'), '');
});

test('chat identity preserves nickname, original name, and phone across saved and search entries', () => {
  for (const address of [{ roomId: 'tel:+14155550123' }, { phone: '+14155550123' }, { roomId: '14155550123@s.whatsapp.net' }, { aliases: ['alex', 'tel:+14155550123'] }]) {
    const display = chatPresentation({ name: 'Alex Example', nickname: 'Mom', ...address });
    assert.equal(display.title, 'Mom');
    assert.equal(display.originalName, 'Alex Example');
    assert.equal(display.address, '+1 (415) 555-0123');
  }
});

test('phone display uses the direct recipient and never interprets opaque IDs or group members as phone numbers', () => {
  const members = [{ user_id: '@self', identifiers: ['tel:+14155550999'] }, { user_id: '@alex', identifiers: ['tel:+14155550123'] }];
  assert.equal(chatAddress({ recipient: '@alex', members }), '+14155550123');
  assert.equal(chatAddress({ is_group: true, recipient: '@alex', members }), '');
  assert.equal(chatAddress({ isGroup: true, aliases: ['+14155550123'] }), '');
  assert.equal(chatAddress({ room_id: '14155550123@lid' }), '');
  assert.equal(chatAddress({ room_id: 'user:14155550123' }), '');
  assert.equal(chatAddress({ roomId: 'mailto:alex@example.test' }), 'alex@example.test');
});
