'use strict';

const { approvedChat, parseChatId, resolveChat } = require('./chat-reference');
const { searchDirectory } = require('./directory');
const { DirectAdapter } = require('./direct-adapter');
const CONNECTIONS = 'chat.connections.v2';
const METHODS = ['status', 'login.start', 'login.finish', 'login.cancel', 'logout',
  'verification.start', 'verification.status', 'verification.confirm_sas', 'verification.mismatch',
  'verification.cancel', 'verification.retry_secrets', 'directory.start', 'directory.stop',
  'chats.search', 'chats.resolve', 'approve', 'remove', 'send', 'connection.delete',
  'imessage.activationKeys', 'imessage.selectActivationKey',
  'imessage.refresh', 'imessage.configure', 'imessage.submitTwoFactorCode', 'imessage.saveContacts',
  'imessage.selectSender', 'imessage.disconnect', 'imessage.forgetSignIn'];

class ChatController {
  constructor({ native, storage, createIMessage, fingerprint, operationId }) {
    this.native = native;
    this.storage = storage;
    this.createIMessage = createIMessage;
    this.fingerprint = fingerprint;
    this.operationId = operationId;
    this.imessage = null;
    this.direct = new Map();
    this.capabilityPromise = null;
    this.locks = new Set();
  }

  async connections() {
    if (!this.capabilityPromise) this.capabilityPromise = this.native.request('capabilities', {}).catch(error => {
      this.capabilityPromise = null;
      throw error;
    });
    const capabilities = await this.capabilityPromise;
    const options = [
      { id: 'beeper-android', name: 'Beeper', detail: 'Connect through the Beeper app', available: capabilities.beeper_connection === 'beeper-android' },
      { id: 'beeper-ios', name: 'Beeper', detail: 'Sign in to your Beeper account', available: capabilities.beeper_connection === 'beeper-ios' },
      { id: 'whatsapp', name: 'WhatsApp', detail: 'Link your WhatsApp account', available: capabilities.whatsapp_available === true },
      { id: 'telegram', name: 'Telegram', detail: 'Sign in to Telegram', available: capabilities.telegram_available === true },
      ...(capabilities.sms_available === true ? [{ id: 'sms-android', name: 'SMS', detail: 'Send text messages from this phone', available: true }] : []),
      { id: 'imessage', name: 'iMessage', detail: 'Connect directly with your Apple Account', available: capabilities.imessage_available === true },
    ];
    let enabled, configured;
    const saved = this.storage.getItem(CONNECTIONS);
    if (saved == null) {
      const legacy = this.storage.getItem('chat.connection.v1') || capabilities.beeper_connection;
      enabled = options.filter(option => option.available && option.id === legacy).map(option => option.id);
      configured = enabled.slice();
      this.storage.setItem(CONNECTIONS, JSON.stringify({ enabled, configured }));
    } else {
      ({ enabled, configured } = this.preferences());
    }
    return { connections: options.map(option => ({ ...option, enabled: enabled.includes(option.id), configured: configured.includes(option.id) })) };
  }

  preferences() {
    let data;
    try { data = JSON.parse(this.storage.getItem(CONNECTIONS)); }
    catch (_) { throw Error('Saved Chat connections could not be restored.'); }
    const enabled = Array.isArray(data) ? data : data?.enabled;
    const configured = Array.isArray(data) ? data : data?.configured;
    if (!Array.isArray(enabled) || !Array.isArray(configured) || enabled.concat(configured).some(id => typeof id !== 'string')) throw Error('Saved Chat connections are invalid.');
    return { enabled, configured };
  }

  updateConnection(id, enabled, configured) {
    const saved = this.preferences();
    const toggle = (values, active) => active ? [...new Set(values.concat(id))] : values.filter(value => value !== id);
    this.storage.setItem(CONNECTIONS, JSON.stringify({
      enabled: toggle(saved.enabled, enabled),
      configured: toggle(saved.configured, configured ?? (enabled || saved.configured.includes(id))),
    }));
  }

  async exclusive(id, fn) {
    if (this.locks.has(id)) throw Error('Another operation is in progress for this connection. Try again when it finishes.');
    this.locks.add(id);
    try { return await fn(); } finally { this.locks.delete(id); }
  }

  adapter(id) {
    if (id === 'sms-android') return { request: (operation, input = {}) => this.native.request('sms.request', { operation, input }) };
    if (['whatsapp', 'telegram'].includes(id)) {
      if (!this.direct.has(id)) this.direct.set(id, new DirectAdapter(this.native, id));
      return this.direct.get(id);
    }
    if (id !== 'imessage') return this.native;
    if (!this.imessage) this.imessage = this.createIMessage();
    return this.imessage;
  }

  async connection(id, { enabled = true } = {}) {
    const info = await this.connections();
    const connection = info.connections.find(option => option.id === id && option.available);
    if (!connection) throw Error('This connection is unavailable on this device.');
    if (enabled && !connection.enabled) throw Error('Enable this connection in Chat settings first.');
    return connection;
  }

  async scoped(id, method, args = {}) {
    await this.connection(id, { enabled: method !== 'status' });
    return this.exclusive(id, async () => {
      const adapter = this.adapter(id);
      if (args.account) {
        const state = await adapter.request('status', {});
        if (state.account !== args.account) throw Error('This account has changed. Choose the chat again.');
      }
      return adapter.request(method, args);
    });
  }

  async states() {
    const info = await this.connections();
    return Promise.all(info.connections.map(async connection => {
      if (!connection.available || !connection.enabled) return connection;
      try { return { ...connection, state: await this.scoped(connection.id, 'status') }; }
      catch (error) { return { ...connection, error: String(error.message || error) }; }
    }));
  }

  async overview() {
    const connections = await this.states();
    return { connections, approved: connections.flatMap(connection => (connection.state?.approved || [])
      .map(entry => approvedChat(connection, connection.state, entry))) };
  }

  async maintainConnections() {
    const info = await this.connections();
    const connection = info.connections.find(value => value.id === 'whatsapp' && value.available && value.enabled);
    if (!connection || this.locks.has('whatsapp')) return { ok: true };
    return this.exclusive('whatsapp', () => this.adapter('whatsapp').request('maintenance'));
  }

  async setEnabled(id, enabled) {
    await this.connection(id, { enabled: false });
    return this.exclusive(id, async () => {
      if (!enabled) {
        if (id.startsWith('beeper-')) await this.native.request('session.release', {});
        else await this.adapter(id).request('directory.stop', {});
      }
      this.updateConnection(id, enabled);
      return this.connections();
    });
  }

  async request(method, args = {}) {
    if (method === 'connections') return this.connections();
    if (method === 'connections.maintain') return this.maintainConnections();
    if (method === 'connections.enable' || method === 'connections.disable') return this.setEnabled(args.connection, method.endsWith('.enable'));
    if (method === 'connections.delete') {
      await this.connection(args.connection, { enabled: false });
      return this.exclusive(args.connection, async () => {
        const adapter = this.adapter(args.connection);
        if (args.account !== undefined && (await adapter.request('status', {})).account !== args.account) throw Error('This account has changed. Review the connection before deleting it.');
        if (args.connection === 'imessage') await adapter.request('imessage.disconnect', { account: args.account });
        else if (args.connection === 'beeper-android') {
          await adapter.request('connection.delete', { account: args.account });
          await adapter.request('session.release', {});
        }
        else {
          const result = await adapter.request('logout', { account: args.account });
          if (!result.session_removed) throw Error('The connection could not be removed. Try again.');
        }
        this.updateConnection(args.connection, false, false);
        return { ok: true };
      });
    }
    if (method === 'contacts.status' || method === 'contacts.search') return this.native.request(method, args);
    if (method === 'status' && !args.connection) return this.overview();
    if (method === 'approved.list') {
      const overview = await this.overview();
      return { chats: overview.approved, errors: overview.connections.filter(connection => connection.error).map(connection => ({ connection: connection.id, error: connection.error })) };
    }
    if (method === 'chats.search' && !args.connection) {
      const states = await this.states();
      const selected = states.filter(connection => connection.available && connection.enabled &&
        (!args.connections || args.connections.includes(connection.id)));
      const connected = selected.filter(connection => connection.state?.connected && connection.state?.account)
        .map(connection => ({ ...connection, account: connection.state.account }));
      const result = await searchDirectory(connected, args, (id, query) => this.scoped(id, 'chats.search', { ...query, account: connected.find(connection => connection.id === id).account }));
      result.errors.push(...selected.filter(connection => connection.error).map(connection => ({ connection: connection.id, name: connection.name, error: connection.error })));
      return result;
    }
    if (method === 'send') return this.exclusive('send', () => this.send(args));
    if (!METHODS.includes(method)) throw Error('Unknown Chat operation');
    const reference = parseChatId(args.chat_id);
    if (args.chat_id != null && !reference) throw Error('Invalid chat reference. Choose the chat again.');
    if (reference && args.connection && args.connection !== reference.connection) throw Error('The chat and connection do not match. Choose the chat again.');
    const connection = reference?.connection || args.connection;
    if (!connection) throw Error('Choose a connection.');
    return this.scoped(connection, method, reference ? { ...args, account: reference.account, room_id: reference.room } : args);
  }

  async send(args) {
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000) throw Error('Enter a message of up to 16,000 characters.');
    const overview = await this.overview();
    const exactId = args.chat_id || (parseChatId(args.recipient) ? args.recipient : undefined);
    const reference = parseChatId(exactId);
    if (args.chat_id != null && !reference) throw Error('Invalid chat reference. Choose the chat again.');
    if (reference && args.connection && args.connection !== reference.connection) throw Error('The chat and connection do not match. Choose the chat again.');
    const connectionId = reference?.connection || args.connection;
    const failures = overview.connections.filter(connection => connection.error && (!connectionId || connection.id === connectionId));
    if (failures.length) throw Error('Could not check allowed chats for ' + failures.map(connection => connection.name).join(', ') + '. Try again before sending.');
    const chat = resolveChat(overview.approved.filter(chat => !connectionId || chat.connection === connectionId), args.recipient, exactId);
    const operation = args.operation_id || this.operationId();
    if (typeof operation !== 'string' || operation.length > 256) throw Error('Invalid message operation ID.');
    const key = 'chat.send-route.v1.' + encodeURIComponent(operation);
    const fingerprint = this.fingerprint(JSON.stringify({ chat: chat.chat_id, text: args.text }));
    const raw = this.storage.getItem(key);
    if (raw) {
      let previous;
      try { previous = JSON.parse(raw); } catch (_) { throw Error('The previous send could not be restored. Check the chat before sending again.'); }
      if (previous.fingerprint !== fingerprint) throw Error('Operation ID was already used for a different chat or message.');
      if (previous.result) return previous.result;
      throw Error('Message acceptance is unconfirmed. Check your messages before sending again.');
    }
    return this.exclusive(chat.connection, async () => {
      await this.connection(chat.connection);
      const adapter = this.adapter(chat.connection);
      const state = await adapter.request('status', {});
      if (state.account !== chat.account || !state.ready) throw Error('This connection changed or needs attention. Check Chat settings.');
      if (!(state.approved || []).some(entry => entry.roomId === chat.roomId)) throw Error('This chat is no longer allowed.');
      this.storage.setItem(key, JSON.stringify({ fingerprint }));
      const result = await adapter.request('send', { account: chat.account, recipient: chat.roomId, text: args.text, operation_id: operation });
      if (!['accepted_by_beeper', 'accepted_by_imessage', 'accepted_by_whatsapp', 'accepted_by_telegram', 'accepted_by_sms'].includes(result.status)) throw Error('Message acceptance is unconfirmed. Check your messages before sending again.');
      const response = { ...result, chat_id: chat.chat_id, connection: chat.connection,
        recipient_name: result.recipient_name || chat.nickname || chat.name };
      this.storage.setItem(key, JSON.stringify({ fingerprint, result: response }));
      return response;
    });
  }

  async handleAction(request, respond) {
    try {
      if (request.action === 'list_chats') {
        const result = await this.request('approved.list');
        return respond.ok({ text: result.chats.length + ' allowed chats', data: result });
      }
      if (request.action !== 'send_message') return respond.error('INVALID_ACTION', 'Unknown Chat action');
      const result = await this.request('send', request.args || {});
      respond.ok({ text: 'Sent to ' + result.recipient_name, data: result });
    } catch (error) { respond.error('CHAT_SEND_FAILED', String(error.message || error)); }
  }

  async handleConfig(message, respond) {
    try { respond(await this.request(message && message.operation, message && message.args || {})); }
    catch (error) { respond({ error: String(error.message || error) }); }
  }
}

module.exports = { ChatController };
