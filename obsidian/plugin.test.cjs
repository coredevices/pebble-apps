const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const store = {};
const context = {
  console,
  Pebble: { registerSourceHandler() {}, registerActionHandler() {}, registerConfigHandler() {} },
  localStorage: { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value; } },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'src/plugin/index.js'), 'utf8'), context);
const plugin = context;

const now = new Date(2026, 10, 4, 9, 43, 30, 899);

test('default filename format is unchanged', () => {
  assert.strictEqual(plugin.noteFilename('{timestamp}-{slug}', 'Hi Miss Mel\nbody', now), '2026-11-04-094330-899-Hi-Miss-Mel');
});

test('filename format fills placeholders and strips unsafe characters', () => {
  assert.strictEqual(plugin.noteFilename('{date} {title}', 'Call: Bob / re #3?', now), '2026-11-04 Call Bob re 3');
  assert.strictEqual(plugin.noteFilename('{time} {title}', 'x', now), '0943 x');
  assert.strictEqual(plugin.noteFilename('{title}', '...', now), 'note');
  assert.strictEqual(plugin.noteFilename('../{title}', 'a', now), 'a');
});

test('lists are cleaned and deduplicated', () => {
  assert.deepStrictEqual(Array.from(plugin.cleanLists(' Shopping \nshopping\n\nWork/Home\n')), ['Shopping', 'Work Home']);
  assert.deepStrictEqual(Array.from(plugin.cleanLists('constructor\n__proto__')), ['constructor', '__proto__']);
});

test('reminder lists resolve to files next to the reminder file', () => {
  plugin.saveConfig({ remindersPath: 'Tasks/Index Reminders.md', reminderLists: 'Shopping\nGroceries' });
  const current = plugin.config();
  assert.strictEqual(plugin.reminderPath(current, undefined), 'Tasks/Index Reminders.md');
  assert.strictEqual(plugin.reminderPath(current, 'markdown-reminders'), 'Tasks/Index Reminders.md');
  assert.strictEqual(plugin.reminderPath(current, 'list:shopping'), 'Tasks/Shopping.md');
  assert.strictEqual(plugin.reminderPath(current, 'list:Nope'), null);
  assert.strictEqual(plugin.reminderPath(current, 'other'), null);
});

test('names stay under the file system byte limit', () => {
  const bytes = (value) => Buffer.byteLength(value, 'utf8');
  assert.ok(bytes(plugin.cleanLists('a'.repeat(300))[0]) <= 240);
  const cjk = '漢字'.repeat(60);
  const name = plugin.noteFilename('{title}{title}{title}', cjk, now);
  assert.ok(bytes(name) <= 240);
  assert.ok(name.startsWith('漢字漢字'));
  assert.ok(bytes(plugin.cleanName('😀'.repeat(100))) <= 240);
  assert.ok(!plugin.cleanName('😀'.repeat(100)).includes('\uFFFD'));
});
