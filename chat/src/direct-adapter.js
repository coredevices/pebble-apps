'use strict';

const { searchDirectory } = require('./directory');

class DirectAdapter {
  constructor(native, network) { this.native = native; this.network = network; }
  async call(operation, input = {}) {
    const result = await this.native.request('direct.request', { network: this.network, operation, input });
    const name = this.network === 'whatsapp' ? 'WhatsApp' : 'Telegram';
    if (result.chats) result.chats = result.chats.map(chat => ({ ...chat, bridge_id: name }));
    if (result.approved) result.approved = result.approved.map(chat => ({ ...chat, network: name }));
    return result;
  }
  async request(method, args = {}) {
    if (method === 'chats.search' && this.network === 'whatsapp') {
      const state = await this.call('status');
      const sources = [{ id: 'directory', name: 'WhatsApp', account: state.account }, { id: 'contacts', name: 'Contacts', account: state.account }];
      const result = await searchDirectory(sources, args, async (source, query) => {
        if (source === 'directory') return this.call('chats.search', { ...query, account: args.account });
        const result = await this.native.request('contacts.search', query);
        if (result.granted === false) return { chats: [], next_cursor: '' };
        if (result.error) throw Error(result.error);
        const seen = new Set();
        return { next_cursor: result.next_cursor, chats: (result.contacts || []).filter(contact => contact.type === 'phone')
          .map(contact => ({ ...contact, phone: internationalPhone(contact.address) }))
          .filter(contact => contact.phone && !seen.has(contact.phone) && seen.add(contact.phone))
          .map(contact => ({ room_id: contact.phone.slice(1) + '@s.whatsapp.net', name: contact.name || contact.phone,
            phone: contact.phone, bridge_id: 'WhatsApp', is_group: false, can_send: true, contact_key: contact.key })) };
      });
      const seen = new Set();
      return { ...result, chats: result.chats.filter(chat => !seen.has(chat.room_id) && seen.add(chat.room_id)),
        error: result.errors.map(error => error.error).join('\n') };
    }
    if (method === 'approve' && args.contact_key && this.network === 'whatsapp') {
      const number = '+' + String(args.room_id).split('@')[0];
      const result = await this.native.request('contacts.search', { query: number });
      if (result.error) throw Error(result.error);
      const contact = (result.contacts || []).find(contact => contact.key === args.contact_key && internationalPhone(contact.address) === number);
      if (!contact) throw Error('This contact changed. Search again.');
      const resolved = await this.call('chats.resolve', { account: args.account, address: number, name: contact.name });
      if (resolved.room_id !== args.room_id) throw Error('This number changed. Search for it again.');
    }
    return this.call(method, args);
  }
}
function internationalPhone(value) {
  const number = String(value || '').replace(/^tel:/, '').replace(/[\s().-]/g, '');
  return /^\+[1-9][0-9]{6,14}$/.test(number) ? number : null;
}
module.exports = { DirectAdapter };
