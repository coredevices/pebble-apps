import { MuseError } from './errors.js';

// The web app treats linked messaging-provider chats as read-only here.
const LINKED_CHANNELS = new Set(['imessage', 'messenger', 'telegram', 'whatsapp']);

export function validateChatId(id) {
  if (typeof id !== 'string' || !id || id.length > 512 || /[\s\x00-\x1f\x7f]/u.test(id) || id === '.' || id === '..') {
    throw new MuseError('a nonempty chat session_id is required');
  }
  return id;
}

export function chatInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.session_id !== 'string' || typeof value.is_primary !== 'boolean' ||
      typeof value.is_thread !== 'boolean' || typeof value.status !== 'string') {
    throw new MuseError('invalid chat session response');
  }
  validateChatId(value.session_id);
  const linked = LINKED_CHANNELS.has(value.channel?.trim?.());
  return { ...value, can_send: !linked && (value.is_primary || value.is_thread) };
}

// Session routes use an application-level result envelope even with HTTP 200.
export function sessionResult(value) {
  if (value && typeof value.ok === 'boolean') {
    if (!value.ok) throw new MuseError('chat session request was rejected');
    return value.result;
  }
  return value;
}
