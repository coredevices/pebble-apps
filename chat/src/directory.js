'use strict';

const { chatId, compareChats } = require('./chat-reference');

async function searchDirectory(connections, args, search) {
  const query = String(args.query || '').trim();
  const binding = JSON.stringify([query, connections.map(connection => [connection.id, connection.account])]);
  let previous = {};
  if (args.cursor) {
    try {
      const decoded = JSON.parse(args.cursor);
      if (decoded.binding !== binding) throw Error();
      previous = decoded.pages;
      if (!previous || typeof previous !== 'object') throw Error();
    } catch (_) { throw Error('The search has changed. Start from the first page.'); }
  }
  const pages = await Promise.all(connections.map(async connection => {
    const position = previous[connection.id] || { cursor: '', skip: 0, done: false };
    if (!Number.isSafeInteger(position.skip) || position.skip < 0 || position.skip > 100 || typeof position.cursor !== 'string') {
      throw Error('Invalid search page. Start from the first page.');
    }
    if (position.done) return { connection, position, chats: [], next: '' };
    try {
      const result = await search(connection.id, { query, cursor: position.cursor });
      return { connection, position, next: result.next_cursor || '', chats: (result.chats || []).map(chat => ({ ...chat,
        connection: connection.id, connection_name: connection.name, account: connection.account,
        chat_id: chatId(connection.id, connection.account, chat.room_id),
      })).slice(position.skip), error: result.error || '' };
    } catch (error) { return { connection, position, chats: [], next: '', error: String(error.message || error) }; }
  }));
  const selected = [];
  const consumedByPage = new Map(pages.map(page => [page, 0]));
  while (selected.length < 25) {
    // Fetch the next page before ranking other connections against unseen chats.
    if (pages.some(page => page.next && consumedByPage.get(page) === page.chats.length)) break;
    const candidates = pages.filter(page => consumedByPage.get(page) < page.chats.length);
    if (!candidates.length) break;
    candidates.sort((a, b) => compareChats(a.chats[consumedByPage.get(a)], b.chats[consumedByPage.get(b)]));
    const page = candidates[0];
    selected.push(page.chats[consumedByPage.get(page)]);
    consumedByPage.set(page, consumedByPage.get(page) + 1);
  }
  const positions = {};
  for (const page of pages) {
    const consumed = consumedByPage.get(page);
    positions[page.connection.id] = page.error ? page.position : consumed === page.chats.length
      ? { cursor: page.next, skip: 0, done: !page.next }
      : { cursor: page.position.cursor, skip: page.position.skip + consumed, done: false };
  }
  return { chats: selected, next_cursor: Object.values(positions).some(position => !position.done)
    ? JSON.stringify({ binding, pages: positions }) : '',
    errors: pages.filter(page => page.error).map(page => ({ connection: page.connection.id, name: page.connection.name, error: page.error })) };
}

module.exports = { searchDirectory };
