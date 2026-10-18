'use strict';

const { node, button, input, activityLabel, chatIdentity } = require('./settings/dom');
const { renderConnection } = require('./settings/connections');
const { normalizeRecipient } = require('../../imessage/src/imessage/recipient');
const { chatId } = require('./chat-reference');
const el = id => document.getElementById(id);
let overview = { connections: [], approved: [] };
let page = 'home', selectedConnection = '', connectionState = {}, connectionActions = null;
let nextCursor = '', searchEpoch = 0, searchBinding = '', rows = [], polling = false, busy = 0, started = false;
const directories = new Set();
let searchTimer;
let refreshingBeeper = false;
let searchQueue = Promise.resolve();

function notice(text) { el('notice').textContent = text || ''; }
async function call(operation, args = {}) {
  const result = await Pebble.sendMessage('plugin', { operation, args });
  if (result.error) throw Error(result.error);
  if (['connections.disable', 'connections.delete', 'directory.stop'].includes(operation)) directories.delete(args.connection);
  return result;
}
async function run(target, operation) {
  if (target?.disabled) return;
  if (target) target.disabled = true;
  busy++;
  notice('');
  try { await operation(); }
  catch (error) { notice(String(error.message || error)); }
  finally { if (target) target.disabled = false; busy--; }
}
function act(label, operation, kind) { return button(label, target => run(target, operation), kind); }
function navigate(destination) {
  if (refreshingBeeper && destination !== 'picker-page') { refreshingBeeper = false; notice(''); }
  clearTimeout(searchTimer);
  page = destination;
  for (const id of ['home', 'connection-page', 'picker-page', 'chat-page']) el(id).hidden = id !== destination;
  searchEpoch++;
  window.scrollTo(0, 0);
}
async function permission(kind) {
  const result = await Pebble.chatPermissions.request(kind);
  if (result.error) throw Error(result.error);
  if (!result.granted) notice(result.open_settings ? 'Allow access in Settings, then return to Chat.' : 'Access was not granted. You can try again from Chat settings.');
}
async function startDirectories() {
  for (const connection of overview.connections) {
    if (connection.id !== 'imessage' && connection.enabled && connection.state?.connected && !directories.has(connection.id) && (connection.id.startsWith('beeper-') || !connection.state.directory_complete)) {
      await call('directory.start', { connection: connection.id }); directories.add(connection.id);
    }
  }
}
async function refreshOverview() {
  overview = await call('status');
  renderHome();
}
function renderHome() {
  el('connections').replaceChildren();
  for (const connection of overview.connections.filter(connection => connection.available)) {
    const row = act('', async () => {
      if (!connection.enabled && !connection.configured) await call('connections.enable', { connection: connection.id });
      selectedConnection = connection.id; navigate('connection-page'); await refreshConnection();
    }, 'account-row');
    const label = node('span');
    const status = !connection.enabled ? (connection.configured ? 'Paused' : 'Tap to connect') : connection.error || connection.state?.needs_reconnect ? 'Needs attention' : connection.state?.ready ? 'Connected' : 'Finish setup';
    label.append(node('strong', connection.name), node('span', status, 'subtle'));
    if (connection.enabled && connection.state?.connection_warning && !connection.state.needs_reconnect) label.append(node('span', connection.state.connection_warning, 'subtle'));
    row.append(label, node('span', '›', 'chevron'));
    row.setAttribute('aria-label', connection.name + ', ' + status);
    el('connections').append(row);
  }
  const approved = overview.approved;
  el('approved-count').textContent = approved.length + (approved.length === 1 ? ' chat allowed' : ' chats allowed');
  el('approved').replaceChildren();
  for (const chat of approved) {
    const row = node('div', null, 'row chat-row');
    const label = chatIdentity(chat);
    const edit = act('Edit', async () => editChat(chat), 'link');
    edit.setAttribute('aria-label', 'Edit ' + (chat.nickname || chat.name) + ' on ' + chat.connection_name);
    row.append(label, edit); el('approved').append(row);
  }
  if (!approved.length) el('approved').append(node('p', 'No chats added yet.', 'empty'));
  el('add-chats').disabled = !overview.connections.some(connection => connection.enabled && connection.state?.connected);
}
function editChat(chat) {
  navigate('chat-page'); el('chat-title').textContent = 'Edit chat';
  const parent = el('chat-content'); parent.replaceChildren(chatIdentity(chat));
  const nick = input(parent, 'Nickname', { value: chat.nickname || '', maxLength: 64, placeholder: 'Optional, e.g. Mom' });
  parent.append(act('Save', async () => {
    await call('approve', { chat_id: chat.chat_id, nickname: nick.value.trim() }); await home(); notice('Saved.');
  }, 'wide'));
  parent.append(node('hr'));
  parent.append(act('Remove chat', async () => { await call('remove', { chat_id: chat.chat_id }); await home(); }, 'danger'));
}
async function renderContactAccess() {
  const result = await call('contacts.status');
  const target = el('contact-access'); target.replaceChildren();
  if (!result.granted) {
    target.append(act('Search phone contacts too', async () => { await permission('contacts'); await renderContactAccess(); await search(false); }, 'link'));
  }
}
async function home() {
  navigate('home'); await refreshOverview(); await renderContactAccess(); await startDirectories();
}
async function refreshConnection({ startDirectory = true } = {}) {
  const id = selectedConnection;
  const info = await call('connections');
  const connection = info.connections.find(item => item.id === id);
  const state = await call('status', { connection: id });
  if (selectedConnection !== id || page !== 'connection-page') return;
  connectionState = state;
  el('connection-title').textContent = connection.name;
  connectionActions = { call, run, notice, home, permission, reload: refreshConnection };
  renderConnection(el('connection-content'), connection, state, connectionActions);
  if (startDirectory && connection.enabled && state.connected && id !== 'imessage' && !directories.has(id) && (id.startsWith('beeper-') || !state.directory_complete)) {
    await call('directory.start', { connection: id }); directories.add(id);
  }
}
function refreshableConnections() { return overview.connections.filter(item => selectedFilters().includes(item.id) && item.enabled && item.state?.connected && ['beeper-android', 'beeper-ios', 'whatsapp', 'telegram'].includes(item.id)); }
function selectedFilters() { return [...el('connection-filters').querySelectorAll('input:checked')].map(input => input.value); }
async function openPicker() {
  await refreshOverview();
  navigate('picker-page');
  const filters = el('connection-filters'); filters.replaceChildren(node('legend', 'Search in'));
  for (const connection of overview.connections.filter(item => item.enabled && item.state?.connected)) {
    const label = node('label', null, 'filter-chip');
    const check = node('input'); check.type = 'checkbox'; check.value = connection.id; check.checked = true;
    check.onchange = () => { clearTimeout(searchTimer); run(null, () => search(false)); };
    label.append(check, node('span', connection.name)); filters.append(label);
  }
  const manual = overview.connections.filter(item => ['imessage', 'whatsapp', 'telegram', 'sms-android'].includes(item.id) && item.enabled && item.state?.ready);
  el('manual-recipient').hidden = !manual.length;
  el('manual-account').replaceChildren();
  for (const connection of manual) { const option = node('option', connection.name); option.value = connection.id; el('manual-account').append(option); }
  manualAccountChanged();
  await renderContactAccess();
  await search(false);
}
async function search(more) {
  const filters = selectedFilters();
  el('refresh-chats').hidden = !refreshableConnections().length;
  const query = el('query').value.trim();
  const binding = JSON.stringify([query, filters]);
  if (more && binding !== searchBinding) more = false;
  const epoch = ++searchEpoch;
  if (!filters.length) { rows = []; el('results').replaceChildren(); el('search-status').textContent = 'Choose an account above.'; el('more').hidden = true; return; }
  el('search-status').textContent = 'Searching…';
  const args = { query, connections: filters, cursor: more ? nextCursor : '' };
  searchQueue = searchQueue.catch(() => {}).then(() => epoch === searchEpoch ? call('chats.search', args) : null);
  const result = await searchQueue.catch(error => { if (epoch !== searchEpoch) return null; throw error; });
  if (!result || epoch !== searchEpoch || page !== 'picker-page' || document.hidden) return;
  searchBinding = binding; nextCursor = result.next_cursor;
  if (!more) rows = [];
  const seen = new Set(rows.map(row => row.chat_id));
  rows.push(...result.chats.filter(row => !seen.has(row.chat_id) && seen.add(row.chat_id)));
  renderResults();
  el('more').hidden = !nextCursor;
  el('search-status').textContent = rows.length + (rows.length === 1 ? ' result' : ' results') + (nextCursor ? ' · more available' : '') +
    (result.errors?.length ? '\n' + result.errors.map(error => error.name + ': ' + error.error).join('\n') : '') +
    (!rows.length && !nextCursor ? '. Try another name, number, or email.' : '');
}
function renderResults() {
  el('results').replaceChildren();
  for (const chat of rows) {
    const row = node('div', null, 'result-card');
    const approved = overview.approved.find(entry => entry.chat_id === chat.chat_id);
    const text = chatIdentity({ ...chat, nickname: approved?.nickname || chat.nickname });
    row.append(text);
    const activity = activityLabel(chat.last_activity);
    if (activity) row.append(node('p', activity, 'result-activity'));
    if (chat.reason) row.append(node('p', chat.reason, 'result-reason'));
    const controls = node('div', null, 'result-actions');
    if (approved) {
      row.classList.add('is-approved');
      controls.append(node('span', '✓ Approved', 'approval-status'));
    }
    const change = act(approved ? 'Remove' : 'Add chat', async () => {
      try {
        await call(approved ? 'remove' : 'approve', { chat_id: chat.chat_id, contact_key: chat.contact_key, display_name: chat.name });
        await refreshOverview();
      } finally { renderResults(); }
    }, approved ? 'link remove-approval' : 'secondary add-approval');
    change.disabled = !approved && !chat.can_send;
    change.setAttribute('aria-label', (approved ? 'Remove ' : 'Add ') + (chat.name || chat.room_id) + ' on ' + chat.connection_name + (approved ? ' from' : ' to') + ' Approved Chats');
    controls.append(change); row.append(controls);
    el('results').append(row);
  }
}

el('add-chats').onclick = target => run(target.currentTarget, openPicker);
el('chat-back').onclick = target => run(target.currentTarget, home);
el('connection-back').onclick = target => run(target.currentTarget, home);
el('picker-back').onclick = target => run(target.currentTarget, home);
el('search-form').onsubmit = event => { event.preventDefault(); run(event.submitter, () => search(false)); };
el('query').oninput = () => {
  el('clear-search').hidden = !el('query').value;
  searchEpoch++; el('more').hidden = true; clearTimeout(searchTimer);
  searchTimer = setTimeout(() => run(null, () => search(false)), 250);
};
el('clear-search').onclick = () => {
  el('query').value = ''; el('query').focus(); el('query').oninput();
};
el('refresh-chats').onclick = event => run(event.currentTarget, async () => {
  notice('Refreshing chats…');
  for (const connection of refreshableConnections()) {
    const state = await call('directory.start', { connection: connection.id, refresh: 'true' });
    directories.add(connection.id);
    if (connection.id === 'beeper-ios') refreshingBeeper = !state.directory_complete;
  }
  await search(false);
  notice(refreshingBeeper ? 'Refreshing chats…' : 'Chats refreshed.');
});
el('more').onclick = event => run(event.currentTarget, () => search(true));
el('manual-form').onsubmit = event => {
  event.preventDefault(); run(event.submitter, async () => {
    const connection = el('manual-account').value;
    const state = await call('status', { connection });
    const address = connection === 'imessage' ? normalizeRecipient(el('manual-address').value) : el('manual-address').value.trim();
    if (!address) throw Error('Enter an international phone number or email address.');
    const name = el('manual-name').value.trim();
let room = address;
    if (connection === 'imessage') {
      const contacts = (state.contacts || []).filter(contact => contact.address !== address).concat({ name, address });
      await call('imessage.saveContacts', { connection, account: state.account, contacts });
    } else {
      const result = await call('chats.resolve', { connection, account: state.account, address, name });
      room = result.room_id;
    }
    await call('approve', { chat_id: chatId(connection, state.account, room), display_name: name });
    el('manual-name').value = ''; el('manual-address').value = '';
    await refreshOverview(); await search(false); notice('Chat added.');
  });
};

function manualAccountChanged() {
  const connection = el('manual-account').value;
  el('manual-address-label').textContent = connection === 'telegram' ? 'Phone number or username' : ['whatsapp', 'sms-android'].includes(connection) ? 'Phone number' : 'Phone number or email';
  el('manual-address').placeholder = connection === 'telegram' ? '+14155550123 or @username' : ['whatsapp', 'sms-android'].includes(connection) ? '+14155550123' : '+14155550123 or name@example.com';
}
el('manual-account').onchange = manualAccountChanged;

async function poll() {
  if (polling || busy || document.hidden) return;
  polling = true;
  try {
    if (page === 'picker-page' && refreshingBeeper) {
      const state = await call('status', { connection: 'beeper-ios' });
      if (state.directory_complete || state.sync_progress?.error) {
        refreshingBeeper = false;
        await search(false);
        notice(state.sync_progress?.error || 'Chats refreshed.');
      }
    } else if (page === 'connection-page' && ['whatsapp', 'telegram'].includes(selectedConnection) && connectionState.login_phase === 'pairing') {
      const id = selectedConnection;
      const state = await call('status', { connection: id });
      if (page !== 'connection-page' || selectedConnection !== id) return;
      if (state.ready) {
        notice('Updating your chat list…');
        connectionState = state;
        try {
          await call('directory.start', { connection: id }); directories.add(id);
        } finally {
          await refreshConnection({ startDirectory: false });
        }
        notice('Connected. Your chat list is up to date.');
      } else if (state.login_phase !== connectionState.login_phase) await refreshConnection();
      else connectionActions?.showLogin?.(state);
    } else if (page === 'connection-page' && selectedConnection === 'beeper-ios' && connectionState.connected && !connectionState.verified) {
      const value = await call('verification.status', { connection: selectedConnection });
      if (page === 'connection-page' && selectedConnection === 'beeper-ios') {
        connectionActions?.showVerification?.(value);
        if (value.phase === 'complete') await refreshConnection();
      }
    } else if (page === 'connection-page' && selectedConnection === 'beeper-ios' && connectionState.connected && !connectionState.directory_complete) {
      await refreshConnection();
    }
  } catch (error) { refreshingBeeper = false; notice(String(error.message || error)); }
  finally { polling = false; }
}
async function maintainConnections() {
  try { await call('connections.maintain'); }
  catch (_) { /* Offline checks retry on a later app opening. */ }
}
async function releaseDirectories() {
  for (const connection of directories) {
    try { await call('directory.stop', { connection }); } catch (_) { /* Closing the page also releases the native session. */ }
  }
  directories.clear();
}
document.addEventListener('visibilitychange', () => {
  searchEpoch++;
  if (document.hidden) releaseDirectories();
  else run(null, async () => { await maintainConnections(); if (page === 'connection-page') await refreshConnection(); else { await refreshOverview(); await renderContactAccess(); await startDirectories(); if (page === 'picker-page') await search(false); } });
});
window.addEventListener('pagehide', releaseDirectories);
Pebble.addEventListener('ready', event => {
  if (event.target === 'plugin' && !started) {
    started = true;
    run(null, async () => {
      await home();
      await maintainConnections();
      if (page === 'home') await refreshOverview();
    });
  }
});
setInterval(poll, 2500);
