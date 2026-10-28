const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const nodeCrypto = require('node:crypto');
const vm = require('node:vm');
const path = require('node:path');

const SOURCE = readFileSync(path.join(__dirname, '..', 'pbw', 'plugin.js'), 'utf8');
const NOW = 1_800_000_000_000;
const API = 'https://chatgpt.com/backend-api';
const SESSION = 'GET https://chatgpt.com/api/auth/session';
const REQUIREMENTS = `POST ${API}/sentinel/chat-requirements`;
const PREPARE = `POST ${API}/f/conversation/prepare`;
const CONVERSATION = `POST ${API}/f/conversation`;
const LIST = `GET ${API}/conversations`;

function accessToken(exp = NOW / 1000 + 3600) {
  const claims = { exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_user_id: 'user-1' } };
  return 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
}

function json(status, body) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

function sse(status, events) {
  const body = events.map((e) => (typeof e === 'string' ? e : 'data: ' + JSON.stringify(e))).join('\n\n') + '\n\n';
  return { status, text: async () => body };
}

/** A v1 delta stream, as chatgpt.com sends it: a reasoning message, then the reply streamed by appends. */
const REPLY_STREAM = [
  'event: delta_encoding\ndata: "v1"',
  { type: 'resume_conversation_token', token: 'r', conversation_id: 'c-1' },
  { type: 'input_message', input_message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] } }, conversation_id: 'c-1' },
  'event: delta\ndata: ' + JSON.stringify({ p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'thoughts', thoughts: [] } }, conversation_id: 'c-1' }, c: 0 }),
  { p: '/message/content/thoughts', o: 'append', v: [{ summary: 'thinking', content: 'secret' }] },
  'event: delta\ndata: ' + JSON.stringify({ p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: [''] } }, conversation_id: 'c-1' }, c: 1 }),
  { p: '/message/content/parts/0', o: 'append', v: 'Hello' },
  { v: ' there' },
  { p: '', o: 'patch', v: [{ p: '/message/content/parts/0', o: 'append', v: '.' }, { p: '/message/status', o: 'replace', v: 'finished_successfully' }] },
  { type: 'message_stream_complete', conversation_id: 'c-1' },
  'data: [DONE]',
];

function fixture({ routes = {}, storage = new Map(), clock = { now: NOW } } = {}) {
  const calls = [];
  const backend = {
    [SESSION]: () => json(200, { accessToken: accessToken(), sessionToken: 'session-2' }),
    [LIST]: () => json(200, { items: [] }),
    [`GET ${API}/wham/tasks/list`]: () => json(200, { items: [] }),
    [REQUIREMENTS]: () => json(200, { token: 'chat-token', proofofwork: { required: true, seed: 'seed-1', difficulty: '0fffff' }, turnstile: { required: false } }),
    [PREPARE]: () => json(200, { conduit_token: 'conduit-1' }),
    [CONVERSATION]: () => sse(200, REPLY_STREAM),
    ...routes,
  };
  const fetch = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url.split('?')[0]}`;
    calls.push({ key, url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = backend[key];
    assert.ok(handler, 'unexpected request ' + key);
    return handler(init);
  };
  class FakeDate extends Date {}
  FakeDate.now = () => (typeof clock.now === 'function' ? clock.now() : clock.now);
  let action, config, source;
  vm.runInNewContext(SOURCE, {
    fetch, btoa, atob, WebSocket: class {}, Date: FakeDate,
    Pebble: {
      secureStorage: {
        getItem: async (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: async (k, v) => { storage.set(k, v); },
        removeItem: async (k) => { storage.delete(k); },
      },
      registerActionHandler: (fn) => (action = fn),
      registerConfigHandler: (fn) => (config = fn),
      registerSourceHandler: (fn) => (source = fn),
    },
  });
  const configure = (message) => new Promise((resolve, reject) =>
    config(message, (r) => (r && r.error ? reject(new Error(r.error)) : resolve(r))));
  const send = (args) => new Promise((resolve) => action(
    { action: 'send_to_agent', args },
    { ok: (value) => resolve({ ok: true, ...value }), error: (code, message) => resolve({ code, message }) },
  ));
  const agentChats = () => new Promise((resolve) => source({ category: 'agent', item: 'chats' }, {
    data: resolve, error: (code, message) => resolve({ code, message }),
  }));
  const signIn = () => configure({ type: 'codex_connect', session_token: 'session-1' });
  const call = (key) => calls.filter((c) => c.key === key).at(-1);
  return { calls, storage, backend, clock, configure, send, agentChats, signIn, call };
}

/** What the server checks: sha3-512 of seed + answer starts at or below the difficulty. */
function solves(token, prefix, seed, difficulty) {
  assert.ok(token.startsWith(prefix));
  const answer = token.slice(prefix.length);
  const hash = nodeCrypto.createHash('sha3-512').update(seed + answer).digest('hex');
  return hash.slice(0, difficulty.length) <= difficulty && JSON.parse(Buffer.from(answer, 'base64').toString('utf8'));
}

test('a new ChatGPT chat is sent the way the web app sends it, and the receipt quotes the reply', async () => {
  const f = fixture();
  await f.signIn();
  const before = f.calls.length;
  const result = await f.send({ message: 'hello ChatGPT', chat_id: 'new-chat' });
  assert.equal(result.text, 'Started a new ChatGPT chat (chat_id c-1). ChatGPT replied: Hello there.');
  assert.deepEqual(f.calls.slice(before).map((c) => c.key), [REQUIREMENTS, PREPARE, CONVERSATION]);

  const sent = f.call(CONVERSATION);
  const headers = sent.init.headers;
  assert.equal(headers.Authorization, 'Bearer ' + accessToken());
  assert.equal(headers['ChatGPT-Account-Id'], 'acct-1');
  assert.equal(headers.Accept, 'text/event-stream');
  assert.equal(headers['openai-sentinel-chat-requirements-token'], 'chat-token');
  assert.equal(headers['x-conduit-token'], 'conduit-1');
  assert.match(headers['oai-device-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  assert.ok(f.calls.slice(before).every((c) => c.init.headers['oai-device-id'] === headers['oai-device-id']));
  assert.equal(sent.body.action, 'next');
  assert.equal(sent.body.model, 'auto');
  assert.equal(sent.body.parent_message_id, 'client-created-root');
  assert.equal(sent.body.conversation_id, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.body.messages.map((m) => [m.author.role, m.content]))),
    [['user', { content_type: 'text', parts: ['hello ChatGPT'] }]]);
  assert.equal(f.call(PREPARE).body.parent_message_id, 'client-created-root');
  assert.ok(solves(f.call(REQUIREMENTS).body.p, 'gAAAAAC', '', ''));
});

test('the proof of work solves a known seed and difficulty, and is left out when not asked for', async () => {
  const f = fixture({ routes: { [REQUIREMENTS]: () => json(200, { token: 't', proofofwork: { required: true, seed: '0.8164', difficulty: '00ffff' } }) } });
  await f.signIn();
  assert.equal((await f.send({ message: 'hi', chat_id: 'new-chat' })).ok, true);
  const config = solves(f.call(CONVERSATION).init.headers['openai-sentinel-proof-token'], 'gAAAAAB', '0.8164', '00ffff');
  assert.ok(config, 'proof does not meet the difficulty');
  assert.equal(config.length, 18);
  assert.equal(config[9], config[3] >> 1);

  f.backend[REQUIREMENTS] = () => json(200, { token: 't', proofofwork: { required: false } });
  await f.send({ message: 'hi', chat_id: 'new-chat' });
  assert.equal(f.call(CONVERSATION).init.headers['openai-sentinel-proof-token'], undefined);
});

test('a required browser check or an unsolvable proof of work refuses the send before anything is posted', async () => {
  const f = fixture({ routes: { [REQUIREMENTS]: () => json(200, { token: 't', turnstile: { required: true, dx: 'x' } }) } });
  await f.signIn();
  const turnstile = await f.send({ message: 'hi', chat_id: 'new-chat' });
  assert.equal(turnstile.code, 'PERMISSION_DENIED');
  assert.match(turnstile.message, /ChatGPT app/);

  let t = NOW;
  f.clock.now = () => (t += 1000);
  f.backend[REQUIREMENTS] = () => json(200, { token: 't', proofofwork: { required: true, seed: 's', difficulty: '00000000' } });
  const hard = await f.send({ message: 'hi', chat_id: 'new-chat' });
  assert.equal(hard.code, 'PERMISSION_DENIED');
  assert.ok(!f.calls.some((c) => c.key === CONVERSATION || c.key === PREPARE));
});

test('an existing chat from agent/chats continues from its current message, also when named by title', async () => {
  const f = fixture({ routes: {
    [LIST]: () => json(200, { items: [
      { id: 'c-9', title: 'Trip plans', update_time: '2027-01-15T08:00:00Z' },
      { id: 'c-old', title: 'Old', update_time: '2026-01-15T08:00:00Z', is_archived: true },
    ] }),
    [`GET ${API}/conversation/c-9`]: () => json(200, { current_node: 'node-7', mapping: {} }),
  } });
  await f.signIn();
  const listed = await f.agentChats();
  assert.deepEqual(Array.from(listed.instances, (i) => [i.instanceId, i.properties.name.shortText.text]),
    [['new-chat', 'New ChatGPT chat'], ['c-9', 'Trip plans']]);
  for (const chat_id of ['c-9', 'trip']) {
    const result = await f.send({ message: 'add Lisbon', chat_id });
    assert.equal(result.text, 'Sent to ChatGPT chat "Trip plans". ChatGPT replied: Hello there.');
    const body = f.call(CONVERSATION).body;
    assert.equal(body.conversation_id, 'c-9');
    assert.equal(body.parent_message_id, 'node-7');
    assert.equal(f.call(PREPARE).body.conversation_id, 'c-9');
  }
});

test('a stream of full message snapshots is read too, and a stream that only errors is reported as uncertain', async () => {
  const snapshot = (text, extra = {}) => ({ message: { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: [text] } }, conversation_id: 'c-2', ...extra });
  const f = fixture({ routes: { [CONVERSATION]: () => sse(200, [snapshot('Hi'), snapshot('Hi you'), 'data: [DONE]']) } });
  await f.signIn();
  assert.equal((await f.send({ message: 'x', chat_id: 'new-chat' })).text, 'Started a new ChatGPT chat (chat_id c-2). ChatGPT replied: Hi you');

  f.backend[CONVERSATION] = () => sse(200, [{ conversation_id: 'c-2', error: 'Something went wrong' }, 'data: [DONE]']);
  assert.match((await f.send({ message: 'x', chat_id: 'new-chat' })).message, /did not confirm/);
  f.backend[CONVERSATION] = () => sse(403, []);
  assert.equal((await f.send({ message: 'x', chat_id: 'new-chat' })).code, 'PERMISSION_DENIED');
});

test('a long reply is cut short, and an unfinished stream sends no reply text', async () => {
  const long = 'x'.repeat(400);
  const f = fixture({ routes: { [CONVERSATION]: () => sse(200, [
    { p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: [long] } }, conversation_id: 'c-3' } },
  ]) } });
  await f.signIn();
  assert.equal((await f.send({ message: 'x', chat_id: 'new-chat' })).text, 'Started a new ChatGPT chat (chat_id c-3).');
  f.backend[CONVERSATION] = () => sse(200, [
    { p: '', o: 'add', v: { message: { author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: [long] } }, conversation_id: 'c-3' } },
    'data: [DONE]',
  ]);
  const text = (await f.send({ message: 'x', chat_id: 'new-chat' })).text;
  assert.equal(text.length, 'Started a new ChatGPT chat (chat_id c-3). ChatGPT replied: '.length + 300);
});

test('a near-expiry sign-in renews once and the whole send uses the renewed token', async () => {
  const storage = new Map();
  const f = fixture({ storage });
  await f.signIn();
  const saved = JSON.parse(storage.get('chatgpt.codex.session.v1'));
  saved.expiresAt = NOW + 60_000;
  saved.accessToken = 'old-token';
  storage.set('chatgpt.codex.session.v1', JSON.stringify(saved));
  f.backend[SESSION] = () => json(200, { accessToken: accessToken(NOW / 1000 + 7200), sessionToken: 'session-3' });
  const before = f.calls.length;
  assert.equal((await f.send({ message: 'x', chat_id: 'new-chat' })).ok, true);
  const during = f.calls.slice(before);
  assert.deepEqual(during.map((c) => c.key), [SESSION, REQUIREMENTS, PREPARE, CONVERSATION]);
  assert.equal(during[0].init.headers.Cookie, '__Secure-next-auth.session-token=session-2');
  assert.ok(during.slice(1).every((c) => c.init.headers.Authorization === 'Bearer ' + accessToken(NOW / 1000 + 7200)));
  assert.equal(JSON.parse(storage.get('chatgpt.codex.session.v1')).sessionToken, 'session-3');
});

test('without a ChatGPT sign-in, a new chat asks to sign in and is not listed', async () => {
  const f = fixture();
  assert.equal((await f.send({ message: 'x', chat_id: 'new-chat' })).code, 'AUTH_REQUIRED');
  assert.deepEqual(Array.from((await f.agentChats()).instances || []), []);
});
