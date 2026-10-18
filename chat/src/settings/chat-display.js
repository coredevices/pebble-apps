'use strict';

function chatAddress(chat) {
  if (chat.is_group || chat.isGroup) return '';
  const room = chat.room_id || chat.roomId || '';
  const recipient = (chat.members || []).find(member => member.user_id === chat.recipient);
  const candidates = [chat.phone, room.startsWith('tel:') ? room : '',
    /^\d+@s\.whatsapp\.net$/.test(room) ? '+' + room.split('@')[0] : '',
    ...(chat.aliases || []), ...(recipient?.identifiers || [])];
  for (const value of candidates) {
    const number = String(value || '').replace(/^tel:/, '').replace(/[\s().-]/g, '');
    if (/^\+[1-9]\d{6,14}$/.test(number)) return number;
  }
  return room.startsWith('mailto:') ? room.slice(7) : '';
}

function displayAddress(address) {
  return /^\+1\d{10}$/.test(address) ? address.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 ($1) $2-$3') : address;
}

function chatPresentation(chat) {
  const address = chatAddress(chat);
  const name = String(chat.name || '').trim();
  const nickname = String(chat.nickname || '').trim();
  const title = nickname || name || displayAddress(address) || 'Unnamed chat';
  const originalName = nickname && name && nickname !== name ? name : '';
  const initials = (name || nickname).split(/\s+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join('').toLocaleUpperCase();
  return { title, originalName, address: displayAddress(address), initials: /\p{L}/u.test(initials) ? initials : '', group: !!(chat.is_group || chat.isGroup) };
}

module.exports = { chatAddress, displayAddress, chatPresentation };
