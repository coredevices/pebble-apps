'use strict';

const normalizeRecipient = require('../imessage/src/imessage/recipient').normalizeRecipient;
const APPROVALS = 'chat.imessage.approvals.v1';
const CREDENTIALS = 'chat.imessage.credentials.v1';
const MAC_KEY = 'chat.imessage.mac-key.v1';

function read(storage, key, fallback) {
  const raw = storage.getItem(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch (_) { throw Error('Saved Chat settings could not be restored.'); }
}

class IMessageAdapter {
  constructor({ controller, storage, fingerprint, operationId, contacts, activationKeys }) {
    this.controller = controller;
    this.storage = storage;
    this.fingerprint = fingerprint;
    this.operationId = operationId;
    this.contacts = contacts;
    this.activationKeys = activationKeys;
  }

  approvals() {
    const entries = read(this.storage, APPROVALS, []);
    if (!Array.isArray(entries) || entries.some(entry => !entry ||
      typeof entry.account !== 'string' || typeof entry.name !== 'string' ||
      typeof entry.nickname !== 'string' || normalizeRecipient(entry.roomId) !== entry.roomId)) {
      throw Error('Saved iMessage allow list is invalid.');
    }
    return entries;
  }

  save(entries) { this.storage.setItem(APPROVALS, JSON.stringify(entries)); }

  savedCredentials() {
    const saved = read(this.storage, CREDENTIALS, null);
    if (saved && ['appleId', 'macValidationData', 'password'].some(key => typeof saved[key] !== 'string')) {
      throw Error('Saved iMessage sign-in could not be restored.');
    }
    return saved;
  }

  rememberCredentials(args) {
    const saved = this.savedCredentials();
    const appleId = String(args.appleId || '').trim() || saved?.appleId || '';
    const sameAccount = saved && appleId.toLowerCase() === saved.appleId.toLowerCase();
    const token = String(args.macValidationData || '').trim();
    const macKeyOwner = token ? args.macKeyOwner : saved?.macKeyOwner;
    const credentials = {
      appleId,
      macValidationData: token || saved?.macValidationData || '',
      password: String(args.password || '') || (sameAccount ? saved.password : ''),
      ...(macKeyOwner ? { macKeyOwner } : {}),
    };
    if (!credentials.appleId || !credentials.macValidationData || !credentials.password) {
      throw Error('Enter your Mac activation token, Apple Account email, and password. A different account needs its own password.');
    }
    if (credentials.appleId.length > 320 || credentials.password.length > 4096 || credentials.macValidationData.length > 4 * 1024 * 1024) {
      throw Error('The iMessage sign-in details are too long.');
    }
    // Plugin localStorage is backed by Keychain on iOS and Keystore encryption on Android.
    this.storage.setItem(CREDENTIALS, JSON.stringify(credentials));
    return credentials;
  }

  async status() {
    const result = await this.controller.handleConfig({ type: 'status' });
    if (!result.ok) throw Error(result.message || 'iMessage settings are unavailable.');
    const native = this.controller.configuration.status();
    const account = native.accountId || '';
    const ready = result.status === 'ready';
    const saved = this.savedCredentials();
    return {
      backend: 'imessage', account, account_label: result.selectedSender || '',
      connected: ready, verified: ready, ready,
      status: ready ? 'Ready to send iMessages' : result.status === 'needsTwoFactor' ? 'Enter your Apple verification code' : 'Connect iMessage',
      imessage_phase: result.status, can_submit_two_factor: result.canSubmitTwoFactor === true,
      handles: result.handles || [], selected_sender: result.selectedSender,
      contacts: result.contacts || [], directory_complete: true,
      approved: this.approvals().filter(entry => entry.account === account),
      saved_sign_in: saved ? { apple_id: saved.appleId, activation_token: true, password: true } : null,
    };
  }

  async request(method, args = {}) {
    if (method === 'imessage.activationKeys') {
      const result = await this.activationKeys.request('activationKeys.list', {});
      const saved = read(this.storage, MAC_KEY, null);
      if (saved && (saved.account !== result.account || !result.keys.some(key => key.id === saved.id))) this.storage.removeItem(MAC_KEY);
      return result;
    }
    if (method === 'imessage.selectActivationKey') {
      const result = await this.activationKeys.request('activationKeys.read', { account: args.pebble_account, id: args.key_id });
      if (typeof result.macValidationData !== 'string' || !result.macValidationData.trim()) throw Error('This Mac key is empty. Save it again from the Pebble Mac app.');
      this.storage.setItem(MAC_KEY, JSON.stringify({ account: args.pebble_account, id: args.key_id, macValidationData: result.macValidationData }));
      return { loaded: true, key_id: args.key_id };
    }
    if (method === 'directory.stop' || method === 'directory.start') return { ok: true };
    if (method === 'imessage.forgetSignIn') {
      if (args.account !== undefined && args.account !== (this.controller.configuration.status().accountId || '')) throw Error('This account has changed. Choose the chat again.');
      this.storage.removeItem(CREDENTIALS);
      this.storage.removeItem(MAC_KEY);
      return this.status();
    }
    const state = await this.status();
    if (args.account !== undefined && args.account !== state.account) throw Error('This account has changed. Choose the chat again.');
    if (method === 'status') return state;
    if (method.startsWith('imessage.')) {
      const type = method.slice('imessage.'.length);
      if (!['refresh', 'configure', 'submitTwoFactorCode', 'saveContacts', 'selectSender', 'disconnect'].includes(type)) {
        throw Error('Unknown iMessage settings operation.');
      }
      if (type === 'disconnect') { this.storage.removeItem(CREDENTIALS); this.storage.removeItem(MAC_KEY); }
      if (type === 'configure') {
        const selected = read(this.storage, MAC_KEY, null);
        if (!String(args.macValidationData || '').trim() && args.key_id) {
          if (!selected || selected.id !== args.key_id || selected.account !== args.pebble_account) throw Error('Choose your saved Mac again.');
          args = { ...args, macValidationData: selected.macValidationData, macKeyOwner: selected.account };
        }
        const owner = args.macKeyOwner || (!String(args.macValidationData || '').trim() ? this.savedCredentials()?.macKeyOwner : null);
        if (owner && (await this.activationKeys.request('activationKeys.account', {})).account !== owner) throw Error('Your Pebble account changed. Choose your saved Mac again.');
      }
      const configArgs = type === 'configure' ? this.rememberCredentials(args) : args;
      const result = await this.controller.handleConfig({ ...configArgs, type });
      // An erased identity never retains an active allow list, even if later preference cleanup fails.
      const current = this.controller.configuration.status();
      if (type === 'disconnect' && !current.accountId) {
        this.save(this.approvals().filter(entry => entry.account !== state.account));
        const cleanup = await this.controller.handleConfig({ type: 'saveContacts', contacts: [] });
        if (!cleanup.ok) throw Error(cleanup.message || 'The account was disconnected, but its saved recipients could not be cleared. Try Disconnect again.');
      }
      if (!result.ok) throw Error(result.message || 'iMessage setup could not be completed.');
      if (type === 'saveContacts') {
        this.save(this.approvals().filter(entry => entry.account !== state.account ||
          result.contacts.some(contact => contact.address === entry.roomId)));
      }
      return this.status();
    }
    if (method === 'chats.search') return this.search(state, args);
    if (method === 'remove') {
      this.save(this.approvals().filter(entry => entry.account !== state.account || entry.roomId !== args.room_id));
      return { ok: true };
    }
    if (!state.ready || !state.account) throw Error('Connect iMessage before sending or allowing recipients.');
    if (method === 'approve') {
      let contact = state.contacts.find(contact => contact.address === args.room_id);
      if (!contact && this.contacts) {
        const result = await this.contacts.request('contacts.search', { query: String(args.room_id || '').replace(/^(tel:|mailto:)/, '') });
        if (result.error) throw Error(result.error);
        const matches = (result.contacts || []).filter(entry => normalizeRecipient(entry.address) === args.room_id &&
          (!args.contact_key || entry.key === args.contact_key));
        const names = [...new Set(matches.map(entry => entry.name))];
        if (names.length === 1) {
          contact = { name: names[0] || args.room_id, address: args.room_id };
          const saved = await this.controller.handleConfig({ type: 'saveContacts', contacts: state.contacts.concat(contact) });
          if (!saved.ok) throw Error(saved.message || 'This recipient could not be saved.');
        }
      }
      if (!contact) throw Error('This recipient is no longer available. Search again or add their address manually.');
      const nickname = String(args.nickname || '').trim();
      if (nickname.length > 64) throw Error('Use a nickname of up to 64 characters.');
      const entry = { account: state.account, roomId: contact.address, name: contact.name, nickname, network: 'iMessage', isGroup: false };
      this.save(this.approvals().filter(old => old.account !== state.account || old.roomId !== contact.address).concat(entry));
      return { ok: true };
    }
    if (method !== 'send') throw Error('This operation is unavailable for direct iMessage.');
    return this.send(state, args);
  }

  async search(state, args) {
    const query = String(args.query || '').trim().toLowerCase();
    const digits = value => String(value).replace(/[^0-9]/g, '');
    const phoneQuery = /^[+()\s.\d-]+$/.test(query) ? digits(query) : '';
    const manual = state.contacts.filter(contact => !query ||
      (contact.name + ' ' + contact.address).toLowerCase().includes(query) ||
      (phoneQuery && contact.address.startsWith('tel:') && digits(contact.address).includes(phoneQuery)));
    let position = { manual: 0, contacts: '' };
    if (args.cursor) {
      try { position = JSON.parse(args.cursor); } catch (_) { throw Error('Invalid iMessage search page.'); }
      if (!Number.isSafeInteger(position.manual) || position.manual < 0 || typeof position.contacts !== 'string') throw Error('Invalid iMessage search page.');
    }
    const row = contact => ({ room_id: contact.address, name: contact.name || contact.address, bridge_id: 'iMessage',
      can_send: state.ready && !!normalizeRecipient(contact.address), is_group: false, members: [], contact_key: contact.key,
      reason: !state.ready ? 'Connect iMessage first.' : !normalizeRecipient(contact.address) ? 'Add this number with its country code.' : '',
    });
    if (position.manual < manual.length) {
      const nextManual = position.manual + 25;
      return { chats: manual.slice(position.manual, nextManual).map(row),
        next_cursor: nextManual < manual.length || this.contacts ? JSON.stringify({ manual: nextManual, contacts: '' }) : '', directory_complete: true };
    }
    if (!this.contacts) return { chats: [], next_cursor: '', directory_complete: true };
    const result = await this.contacts.request('contacts.search', { query, cursor: position.contacts });
    if (result.error) throw Error(result.error);
    const existing = new Set(state.contacts.map(contact => contact.address));
    const seen = new Set();
    const chats = (result.contacts || []).map(contact => ({ ...contact, address: normalizeRecipient(contact.address) || contact.address }))
      .filter(contact => !existing.has(contact.address) && !seen.has(contact.address) && seen.add(contact.address)).map(row);
    return { chats, next_cursor: result.next_cursor ? JSON.stringify({ manual: Math.max(position.manual, manual.length), contacts: result.next_cursor }) : '', directory_complete: true };
  }

  async send(state, args) {
    const query = String(args.recipient || '').trim();
    if (!query) throw Error('Choose an approved iMessage recipient.');
    const address = normalizeRecipient(query);
    const exact = state.approved.filter(entry => entry.roomId === address ||
      entry.name.toLowerCase() === query.toLowerCase() || entry.nickname.toLowerCase() === query.toLowerCase());
    const matches = exact.length ? exact : state.approved.filter(entry =>
      entry.name.toLowerCase().includes(query.toLowerCase()) || entry.nickname.toLowerCase().includes(query.toLowerCase()));
    if (matches.length === 0) throw Error('No allowed iMessage recipient matches. Add one in Chat settings first.');
    if (matches.length !== 1) throw Error('Several allowed iMessage recipients match. Use an exact address or unique nickname.');
    const recipient = matches[0].roomId;
    const recipientName = matches[0].nickname || matches[0].name || recipient;
    const text = args.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw Error('Enter a message of up to 16,000 characters.');
    const operation = args.operation_id || this.operationId();
    if (typeof operation !== 'string' || operation.length > 256) throw Error('Invalid message operation ID.');
    const key = 'chat.imessage.send.v1.' + encodeURIComponent(state.account) + '.' + encodeURIComponent(operation);
    const fingerprint = this.fingerprint(JSON.stringify({ account: state.account, recipient, text }));
    const previous = read(this.storage, key, null);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Error('Operation ID was already used for a different message.');
      if (previous.status === 'accepted' && previous.result && previous.result.status === 'accepted_by_imessage') return { ...previous.result, recipient_name: recipientName };
      throw Error('iMessage acceptance is unconfirmed. Check iMessage before sending again.');
    }
    // Save before any send. A lost response or interrupted app must never cause a duplicate retry.
    this.storage.setItem(key, JSON.stringify({ fingerprint, status: 'pending' }));
    let outcome;
    await this.controller.handleAction({ action: 'send_message', args: { recipient, text } }, {
      ok: value => { outcome = { value }; },
      error: (code, message) => { outcome = { error: message }; },
    });
    if (!outcome || outcome.error || !outcome.value.data || !outcome.value.data.messageId) {
      throw Error(outcome && outcome.error || 'iMessage acceptance is unconfirmed. Check iMessage before sending again.');
    }
    const result = { status: 'accepted_by_imessage', event_id: outcome.value.data.messageId, recipient, recipient_name: recipientName, delivery_confirmed: false };
    this.storage.setItem(key, JSON.stringify({ fingerprint, status: 'accepted', result }));
    return result;
  }
}

module.exports = { IMessageAdapter };
