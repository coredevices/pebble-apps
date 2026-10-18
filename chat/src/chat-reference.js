'use strict';

function chatId(connection, account, room) {
  return 'chat:' + [connection, account, room].map(encodeURIComponent).join(':');
}

function parseChatId(value) {
  if (typeof value !== 'string' || !value.startsWith('chat:')) return null;
  try {
    const parts = value.slice(5).split(':').map(decodeURIComponent);
    if (parts.length !== 3 || parts.some(part => !part)) throw Error();
    return { connection: parts[0], account: parts[1], room: parts[2] };
  } catch (_) { throw Error('Invalid chat reference. Choose the chat again.'); }
}

function compareChats(a, b) {
  return Number(!!a.is_group) - Number(!!b.is_group) ||
    (Number(b.last_activity) || 0) - (Number(a.last_activity) || 0) ||
    String(a.name || '').localeCompare(String(b.name || '')) || a.chat_id.localeCompare(b.chat_id);
}

function approvedChat(connection, state, entry) {
  return { ...entry, connection: connection.id, connection_name: connection.name,
    chat_id: chatId(connection.id, state.account, entry.roomId) };
}

function resolveChat(chats, recipient, exactId) {
  if (exactId) {
    const selected = chats.find(chat => chat.chat_id === exactId);
    if (!selected) throw Error('This chat is no longer allowed. Choose an allowed chat in Chat settings.');
    if (recipient && recipient !== exactId) {
      try { resolveChat([selected], recipient); }
      catch (_) { throw Error('The recipient and chat reference do not match. Choose the chat again.'); }
    }
    return selected;
  }
  const query = String(recipient || '').trim().toLowerCase();
  if (!query) throw Error('Choose an allowed chat.');
  const values = chat => [chat.roomId, chat.name, chat.nickname, ...(chat.aliases || [])].filter(Boolean).map(value => value.toLowerCase());
  const phone = value => value.replace(/^tel:/, '').replace(/[\s().-]/g, '');
  const exact = chats.filter(chat => values(chat).some(value => value === query || (query.match(/^\+?[\d\s().-]+$/) && phone(value) === phone(query))));
  const matches = exact.length ? exact : chats.filter(chat => values(chat).some(value => value.includes(query)));
  if (!matches.length) throw Error('No allowed chat matches. Add it in Chat settings first.');
  if (matches.length !== 1) throw Error('Several allowed chats match. Ask which chat to use: ' + matches.map(chat =>
    (chat.nickname || chat.name) + ' (' + chat.connection_name + ', ' + chat.network + '; ' + chat.chat_id + ')').join('; '));
  return matches[0];
}

module.exports = { chatId, parseChatId, compareChats, approvedChat, resolveChat };
