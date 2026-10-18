const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const nodeCrypto = require('node:crypto');
const vm = require('node:vm');
const path = require('node:path');

const SOURCE = readFileSync(path.join(__dirname, '..', 'pbw', 'plugin.js'), 'utf8');
const NOW = 1_800_000_000_000;
const ACCOUNT = 'acct-1';
const REDIRECT = 'http://localhost:1455/auth/callback';
const RC = 'https://chatgpt.com/backend-api/codex/remote/control';
const ENTROPY = nodeCrypto.randomBytes(96);
const WHAM = 'https://chatgpt.com/backend-api/wham';

function jwt(claims) {
  return 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
}

function accessToken(exp = NOW / 1000 + 3600) {
  return jwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT, chatgpt_user_id: 'user-1' }, 'https://api.openai.com/profile': { email: 'eric@example.com' } });
}

function json(status, body) {
  return { status, json: async () => body };
}

function verify(spkiBase64, payloadBase64, signatureBase64) {
  const key = nodeCrypto.createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
  return nodeCrypto.verify('sha256', Buffer.from(payloadBase64, 'base64'), key, Buffer.from(signatureBase64, 'base64'));
}

function challenge(path, extra = {}) {
  return {
    type: 'remoteControlClientEnrollment', nonce: 'n-1', purpose: 'p', audience: 'aud', challenge_id: 'ch-1',
    target_origin: 'https://chatgpt.com', target_path: '/backend-api/codex/remote/control' + path,
    account_user_id: 'au-1', client_id: 'client-1', challenge_token: 'ct-1', challenge_expires_at: 99, ...extra,
  };
}

/** A relay that answers the app-server JSON-RPC requests the plugin sends. */
function relay(threads, onQueue) {
  return class FakeSocket {
    constructor(url, protocols, options) {
      FakeSocket.last = this;
      this.url = url;
      this.headers = options.headers;
      this.sent = [];
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({
        type: 'device_key_challenge', nonce: 'cn', audience: 'aud', sessionId: 'sess', targetOrigin: 'https://chatgpt.com',
        targetPath: '/backend-api/codex/remote/control/client', accountUserId: 'au-1', clientId: 'client-1',
        tokenSha256Base64url: 'th', tokenExpiresAt: 5, scopes: ['rc'],
      }) }));
    }
    send(text) {
      const frame = JSON.parse(text);
      this.sent.push(frame);
      const message = frame.message;
      if (!message || message.id === undefined) return;
      const reply = (result) => queueMicrotask(() => this.onmessage({ data: JSON.stringify({
        type: 'server_message', client_id: 'client-1', env_id: frame.env_id, stream_id: frame.stream_id, seq_id: 7, cursor: 'c-1',
        message: { id: message.id, result },
      }) }));
      if (message.method === 'initialize' && FakeSocket.unpaired) {
        queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'server_message', client_id: 'client-1', seq_id: 2, message: {
          method: 'error', params: { error: { message: 'Remote environment is not paired for this client' }, threadId: '__remote_control_transport__', willRetry: false } } }) }));
        return;
      }
      if (message.method === 'initialize') reply({ userAgent: 'codex' });
      if (message.method === 'thread/list') reply({ data: threads, nextCursor: null });
      if (message.method === 'thread/queue/add') {
        if (onQueue) onQueue(message.params);
        reply({ queuedSubmission: { id: 'q-1', input: message.params.input, clientUserMessageId: message.params.clientUserMessageId } });
      }
    }
    close() { this.closed = true; }
  };
}

function fixture({ routes = {}, storage = new Map(), WebSocket = class {} } = {}) {
  const calls = [];
  const backend = {
    'GET https://chatgpt.com/api/auth/session': () => json(200, { accessToken: accessToken(), sessionToken: 'session-2' }),
    'POST https://auth.openai.com/oauth/token': () => json(200, { access_token: 'step-up-token', refresh_token: 'r', id_token: 'i' }),
    [`POST ${RC}/client/enroll/start`]: () => json(200, { client_id: 'client-1', account_user_id: 'au-1', device_key_challenge: challenge('/client/enroll/finish') }),
    [`POST ${RC}/client/enroll/finish`]: () => json(200, { client_id: 'client-1', account_user_id: 'au-1', remote_control_token: 'rc-token', expires_at: new Date(NOW + 3600_000).toISOString(), scopes: ['rc'] }),
    [`GET ${RC}/environments`]: () => json(200, [{ id: 'env-1', name: 'taz-runner', online: true, busy: false, os: 'linux', kind: 'single' }]),
    'GET https://chatgpt.com/backend-api/wham/tasks/list': () => json(200, { items: [] }),
    ...routes,
  };
  const fetch = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url.split('?')[0]}`;
    calls.push({ key, url, init });
    const handler = backend[key];
    assert.ok(handler, 'unexpected request ' + key);
    return handler(init);
  };
  let action, config;
  vm.runInNewContext(SOURCE, {
    fetch, WebSocket, btoa, atob, queueMicrotask,
    Date: Object.assign(function () {}, { now: () => NOW, parse: Date.parse }),
    Pebble: {
      secureStorage: {
        getItem: async (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: async (k, v) => { storage.set(k, v); },
        removeItem: async (k) => { storage.delete(k); },
      },
      registerActionHandler: (fn) => (action = fn),
      registerConfigHandler: (fn) => (config = fn),
      registerSourceHandler: () => {},
    },
  });
  const configure = (message) => new Promise((resolve, reject) =>
    config(message, (r) => (r && r.error ? reject(new Error(r.error)) : resolve(r))));
  const run = (name, args) => new Promise((resolve) => action(
    { action: name, args },
    { ok: (value) => resolve({ ok: true, ...value }), error: (code, message) => resolve({ code, message }) },
  ));
  async function signIn() {
    return configure({ type: 'codex_connect', session_token: 'session-1' });
  }
  async function enroll(entropy = ENTROPY) {
    const begun = new URL((await configure({ type: 'codex_enroll_begin', entropy: entropy.toString('base64') })).url);
    return configure({ type: 'codex_enroll_finish', url: `  ${REDIRECT}?code=enroll-code&scope=x&state=${begun.searchParams.get('state')}\n` });
  }
  return { calls, storage, backend, configure, run, signIn, enroll };
}

test('Codex signs in with the ChatGPT web session, like the Dot', async () => {
  const f = fixture();
  const status = await f.signIn();
  assert.deepEqual(JSON.parse(JSON.stringify(status.codex)), { signedIn: true, email: 'eric@example.com', remoteControl: false, paired: false });
  assert.equal(f.calls[0].init.headers.Cookie, '__Secure-next-auth.session-token=session-1');
  assert.equal(JSON.parse(f.storage.get('chatgpt.codex.session.v1')).sessionToken, 'session-2');
  await assert.rejects(() => f.configure({ type: 'codex_connect', session_token: 'bad;cookie' }), /invalid session/);
});

test('connecting computers takes its PKCE and device key from the settings page entropy', async () => {
  const f = fixture();
  await f.signIn();
  const begun = new URL((await f.configure({ type: 'codex_enroll_begin', entropy: ENTROPY.toString('base64') })).url);
  assert.equal(begun.origin + begun.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(begun.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(begun.searchParams.get('scope'), 'codex.remote_control.enroll');
  assert.equal(begun.searchParams.get('max_age'), '0');
  assert.equal(begun.searchParams.get('state'), ENTROPY.subarray(32, 48).toString('base64url'));
  await f.configure({ type: 'codex_enroll_finish', url: `${REDIRECT}?code=enroll-code&state=${begun.searchParams.get('state')}` });

  const exchange = new URLSearchParams(f.calls.find((c) => c.key === 'POST https://auth.openai.com/oauth/token').init.body);
  assert.equal(exchange.get('code_verifier'), ENTROPY.subarray(0, 32).toString('base64url'));
  assert.equal(nodeCrypto.createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), begun.searchParams.get('code_challenge'));
  const finish = f.calls.find((c) => c.key === `POST ${RC}/client/enroll/finish`);
  const body = JSON.parse(finish.init.body);
  assert.equal(body.step_up_token, 'step-up-token');
  assert.equal(finish.init.headers['x-codex-client-id'], 'client-1');
  assert.equal(finish.init.headers['ChatGPT-Account-Id'], ACCOUNT);
  const signed = JSON.parse(Buffer.from(body.device_key_proof.signed_payload_base64, 'base64'));
  assert.equal(signed.domain, 'codex-device-key-sign-payload/v1');
  assert.equal(signed.payload.type, 'remoteControlClientEnrollment');
  assert.ok(verify(body.device_identity.public_key_spki_der_base64, body.device_key_proof.signed_payload_base64, body.device_key_proof.signature_der_base64));
  assert.equal((await f.configure({ type: 'status' })).codex.remoteControl, true);
});

test('the device key follows the page entropy, not anything the plugin makes up', async () => {
  const keyFor = async (entropy) => {
    const f = fixture();
    await f.signIn();
    await f.enroll(entropy);
    return JSON.parse(f.calls.find((c) => c.key.endsWith('/enroll/finish')).init.body).device_identity.public_key_spki_der_base64;
  };
  assert.equal(await keyFor(ENTROPY), await keyFor(ENTROPY));
  assert.notEqual(await keyFor(ENTROPY), await keyFor(nodeCrypto.randomBytes(96)));
});

test('a pasted address for another sign-in, or too little entropy, is refused', async () => {
  const f = fixture();
  await f.signIn();
  await assert.rejects(() => f.configure({ type: 'codex_enroll_begin', entropy: 'AAAA' }), /too little randomness/);
  await f.configure({ type: 'codex_enroll_begin', entropy: ENTROPY.toString('base64') });
  await assert.rejects(() => f.configure({ type: 'codex_enroll_finish', url: `${REDIRECT}?code=x&state=forged` }), /Paste the whole address/);
  await assert.rejects(() => f.configure({ type: 'codex_enroll_finish', url: 'localhost' }), /Paste the whole address/);
  assert.ok(!f.calls.some((c) => c.key.includes('oauth/token')));
});

test('an enrollment challenge for another path is refused', async () => {
  const f = fixture({ routes: { [`POST ${RC}/client/enroll/start`]: () => json(200, { client_id: 'client-1', account_user_id: 'au-1', device_key_challenge: challenge('/elsewhere') }) } });
  await f.signIn();
  await assert.rejects(() => f.enroll(), /unexpected challenge/);
  assert.ok(!f.calls.some((c) => c.key.endsWith('/client/enroll/finish')));
});

const threads = [
  { id: 'th-old', name: null, preview: 'fix the BLE reconnect bug', status: { type: 'notLoaded' }, ephemeral: false, updatedAt: NOW / 1000 - 7200 },
  { id: 'th-live', name: 'Index feed polish', preview: 'x', status: { type: 'idle' }, ephemeral: false, updatedAt: NOW / 1000 - 60 },
];
const cloudTasks = { [`GET ${WHAM}/tasks/list`]: () => json(200, { items: [
  { id: 'task_e_1', title: 'Fix login', updated_at: NOW / 1000 - 600, task_status_display: { latest_turn_status_display: { turn_id: 'turn-9' } } },
  { id: 'task_e_2', title: 'Old', archived: true },
] }), [`POST ${WHAM}/tasks`]: () => json(200, { task: { id: 'task_e_1' } }) };

async function chatsOf(f) {
  return (await f.configure({ type: 'codex_chats' })).chats;
}

test('the chat list merges computer sessions and Cloud tasks, most recent first', async () => {
  const f = fixture({ WebSocket: relay(threads), routes: cloudTasks });
  await f.signIn();
  await f.enroll();
  const chats = await chatsOf(f);
  assert.deepEqual(JSON.parse(JSON.stringify(chats.map((c) => [c.kind, c.id, c.state]))), [
    ['session', 'th-live', 'open'], ['task', 'task_e_1', 'cloud'], ['session', 'th-old', 'not open'],
  ]);
  assert.equal(chats[0].computer, 'taz-runner');
  assert.equal(chats[0].updatedAt, NOW - 60_000);
});

test('"send … to Codex" goes to the default chat picked in settings, through the relay', async () => {
  let queued;
  const Socket = relay(threads, (params) => { queued = params; });
  const f = fixture({ WebSocket: Socket });
  await f.signIn();
  await f.enroll();
  assert.equal((await f.run('send_to_codex', { message: 'go' })).code, 'INVALID_ARGS');
  const live = (await chatsOf(f)).find((c) => c.id === 'th-live');
  await f.configure({ type: 'codex_chat_save', chat: live, nickname: '', makeDefault: true });
  assert.equal((await chatsOf(f)).find((c) => c.isDefault).id, 'th-live');

  const result = await f.run('send_to_codex', { message: 'run the tests' });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.text, 'Sent to Codex session "Index feed polish" on taz-runner.');
  assert.equal(queued.threadId, 'th-live');
  assert.deepEqual(JSON.parse(JSON.stringify(queued.input)), [{ type: 'text', text: 'run the tests', textElements: [] }]);

  const socket = Socket.last;
  assert.equal(socket.url, 'wss://chatgpt.com/backend-api/codex/remote/control/client');
  assert.equal(socket.headers['x-codex-client-session-token'], 'Bearer rc-token');
  assert.equal(socket.headers['chatgpt-account-id'], ACCOUNT);
  assert.equal(socket.headers['x-codex-name'], 'Pebble Plugin');
  const [proof, init, initialized, list, add, closed] = socket.sent;
  const enrolled = JSON.parse(f.calls.find((c) => c.key.endsWith('/enroll/finish')).init.body);
  assert.equal(proof.type, 'device_key_proof');
  assert.ok(verify(enrolled.device_identity.public_key_spki_der_base64, proof.signedPayloadBase64, proof.signatureDerBase64));
  assert.equal(JSON.parse(Buffer.from(proof.signedPayloadBase64, 'base64')).payload.sessionId, 'sess');
  assert.equal(init.message.method, 'initialize');
  assert.equal(init.message.params.capabilities.experimentalApi, true);
  assert.equal(init.message.params.clientInfo.title, 'Pebble Plugin');
  assert.deepEqual([init.seq_id, initialized.seq_id, list.seq_id, add.seq_id], [1, 2, 3, 4]);
  assert.equal(init.env_id, 'env-1');
  assert.equal(add.cursor, 'c-1');
  assert.equal(initialized.message.method, 'initialized');
  assert.equal(closed.type, 'client_closed');
  assert.ok(socket.closed);
});

test('a nickname reaches its chat, and moves if given to another chat', async () => {
  let queued;
  const f = fixture({ WebSocket: relay(threads, (params) => { queued = params; }), routes: cloudTasks });
  await f.signIn();
  await f.enroll();
  const chats = await chatsOf(f);
  await f.configure({ type: 'codex_chat_save', chat: chats.find((c) => c.id === 'th-old'), nickname: 'BLE' });
  const named = await f.run('send_to_codex', { message: 'go', chat: 'ble' });
  assert.match(named.text, /Queued for Codex session "fix the BLE reconnect bug" on taz-runner; it runs when the session is next opened/);
  assert.equal(queued.threadId, 'th-old');

  await f.configure({ type: 'codex_chat_save', chat: chats.find((c) => c.id === 'task_e_1'), nickname: 'ble' });
  const listed = await chatsOf(f);
  assert.equal(listed.find((c) => c.id === 'th-old').nickname, '');
  assert.equal(listed.find((c) => c.id === 'task_e_1').nickname, 'ble');
  const moved = await f.run('send_to_codex', { message: 'also update docs', chat: 'BLE' });
  assert.equal(moved.text, 'Sent a follow-up to Codex Cloud task "Fix login".');
  const body = JSON.parse(f.calls.at(-1).init.body);
  assert.deepEqual(body.follow_up, { task_id: 'task_e_1', turn_id: 'turn-9', run_environment_in_qa_mode: false });
});

test('a chat is also found by its title, and an unknown name lists the choices', async () => {
  const f = fixture({ WebSocket: relay(threads), routes: cloudTasks });
  await f.signIn();
  await f.enroll();
  assert.equal((await f.run('send_to_codex', { message: 'go', chat: 'feed polish' })).text, 'Sent to Codex session "Index feed polish" on taz-runner.');
  const unknown = await f.run('send_to_codex', { message: 'go', chat: 'nothing like it' });
  assert.equal(unknown.code, 'INVALID_ARGS');
  assert.match(unknown.message, /"Index feed polish", "Fix login", "fix the BLE reconnect bug"/);
});

test('pairing claims the computer\'s code, manual or from the QR link', async () => {
  const bodies = [];
  const f = fixture({ routes: { [`POST ${RC}/client/pair`]: (init) => { bodies.push(JSON.parse(init.body)); return json(200, {}); } } });
  await f.signIn();
  await f.enroll();
  assert.equal((await f.configure({ type: 'status' })).codex.paired, false);
  const paired = await f.configure({ type: 'codex_pair', code: ' abcd-efgh ' });
  assert.equal(paired.computers[0].name, 'taz-runner');
  assert.equal((await f.configure({ type: 'status' })).codex.paired, true);
  await f.configure({ type: 'codex_pair', code: 'https://chatgpt.com/codex/pair?pairing_code=pc_123&x=1' });
  assert.deepEqual(bodies, [{ client_id: 'client-1', manual_pairing_code: 'ABCD-EFGH' }, { client_id: 'client-1', pairing_code: 'pc_123' }]);
  assert.equal(f.calls.find((c) => c.key === `POST ${RC}/client/pair`).init.headers['x-codex-client-id'], 'client-1');
  await assert.rejects(() => f.configure({ type: 'codex_pair', code: 'two words' }), /Paste the pairing code/);
});

test('an expired pairing code is explained', async () => {
  const f = fixture({ routes: { [`POST ${RC}/client/pair`]: () => json(400, { detail: 'expired' }) } });
  await f.signIn();
  await f.enroll();
  await assert.rejects(() => f.configure({ type: 'codex_pair', code: 'ABCD-EFGH' }), /did not work/);
});

test('a computer that has not paired this phone fails fast instead of hanging', async () => {
  const Socket = relay(threads);
  Socket.unpaired = true;
  const f = fixture({ WebSocket: Socket, routes: cloudTasks });
  await f.signIn();
  await f.enroll();
  const listed = await f.configure({ type: 'codex_chats' });
  assert.deepEqual(JSON.parse(JSON.stringify(listed.chats.map((c) => c.id))), ['task_e_1']);
  assert.match(listed.errors[0], /has not paired this phone/);
  assert.ok(Socket.last.closed);
});

test('a computer that has not paired is skipped when another has', async () => {
  let opened = 0;
  const Base = relay(threads);
  class Socket extends Base {
    constructor(url, protocols, options) {
      super(url, protocols, options);
      Base.unpaired = ++opened === 1;
    }
  }
  const f = fixture({
    WebSocket: Socket,
    routes: { [`GET ${RC}/environments`]: () => json(200, [
      { id: 'env-1', name: 'MacBook-Air.local', online: true }, { id: 'env-2', name: 'taz-runner', online: true },
    ]) },
  });
  await f.signIn();
  await f.enroll();
  const listed = await f.configure({ type: 'codex_chats' });
  assert.deepEqual(JSON.parse(JSON.stringify(listed.errors)), []);
  assert.ok(listed.chats.every((c) => c.computer === 'taz-runner'));
  assert.equal((await f.configure({ type: 'status' })).codex.paired, true);
});

test('no online computer is explained before any socket opens', async () => {
  let opened = false;
  const f = fixture({
    WebSocket: class { constructor() { opened = true; } },
    routes: { [`GET ${RC}/environments`]: () => json(200, [{ id: 'env-1', name: 'taz-runner', online: false }]) },
  });
  await f.signIn();
  await f.enroll();
  await f.configure({ type: 'codex_chat_save', chat: { kind: 'session', id: 'th-live', computer: 'taz-runner', label: 'x' }, makeDefault: true });
  const result = await f.run('send_to_codex', { message: 'go' });
  assert.match(result.message, /None of your computers is online/);
  assert.equal(opened, false);
});

test('sending to a computer session before connecting computers asks to connect them', async () => {
  const f = fixture();
  await f.signIn();
  await f.configure({ type: 'codex_chat_save', chat: { kind: 'session', id: 'th-live', computer: 'taz-runner', label: 'x' }, makeDefault: true });
  assert.equal((await f.run('send_to_codex', { message: 'go' })).code, 'AUTH_REQUIRED');
});

test('an expiring ChatGPT access token is renewed from the session before the call', async () => {
  const storage = new Map();
  const f = fixture({ storage, routes: { 'GET https://chatgpt.com/backend-api/wham/environments': () => json(200, []) } });
  await f.signIn();
  const saved = JSON.parse(storage.get('chatgpt.codex.session.v1'));
  saved.expiresAt = NOW + 60_000;
  storage.set('chatgpt.codex.session.v1', JSON.stringify(saved));
  await f.run('start_codex_cloud_task', { prompt: 'x' });
  const renewals = f.calls.filter((c) => c.key === 'GET https://chatgpt.com/api/auth/session');
  assert.equal(renewals.at(-1).init.headers.Cookie, '__Secure-next-auth.session-token=session-2');
});

test('listing shows nicknames, the default and chat ids for send_to_codex', async () => {
  const f = fixture({ WebSocket: relay(threads), routes: cloudTasks });
  await f.signIn();
  await f.enroll();
  const chats = await chatsOf(f);
  await f.configure({ type: 'codex_chat_save', chat: chats.find((c) => c.id === 'th-old'), nickname: 'ble', makeDefault: true });
  const result = await f.run('list_codex_chats', {});
  assert.equal(result.text, [
    '"Index feed polish" (taz-runner, open, chat th-live)',
    '"Fix login" (Codex Cloud, cloud, chat task_e_1)',
    'ble = "fix the BLE reconnect bug" (taz-runner, not open, default, chat th-old)',
  ].join('\n'));
});

test('listing before connecting computers still lists Cloud tasks', async () => {
  const f = fixture({ routes: cloudTasks });
  await f.signIn();
  const result = await f.run('list_codex_chats', {});
  assert.equal(result.text, '"Fix login" (Codex Cloud, cloud, chat task_e_1)\nComputers: Connect your computers in the plugin settings first.');
});

test('a Codex Cloud task starts in the named environment on its default branch', async () => {
  const f = fixture({
    routes: {
      [`GET ${WHAM}/environments`]: () => json(200, [
        { id: 'e-1', label: 'coreapp', repo_map: { r: { default_branch: 'develop' } }, env_vars: { SECRET: 'x' } },
        { id: 'e-2', label: 'appstore-backend' },
      ]),
      [`POST ${WHAM}/tasks`]: () => json(200, { task: { id: 'task_e_1' } }),
    },
  });
  await f.signIn();
  const result = await f.run('start_codex_cloud_task', { prompt: 'add a test', environment: 'coreapp' });
  assert.equal(result.text, 'Started a Codex Cloud task in coreapp.');
  const body = JSON.parse(f.calls.at(-1).init.body);
  assert.deepEqual(body.new_task, { environment_id: 'e-1', branch: 'develop', run_environment_in_qa_mode: false });
  assert.equal(body.input_items[0].content[0].text, 'add a test');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('signing out of Codex forgets the account and the computers', async () => {
  const f = fixture();
  await f.signIn();
  await f.enroll();
  const status = await f.configure({ type: 'codex_disconnect' });
  assert.equal(status.codex.signedIn, false);
  assert.equal(status.codex.remoteControl, false);
});
