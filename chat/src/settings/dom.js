'use strict';

const { chatPresentation } = require('./chat-display');

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(text, action, kind = 'secondary') {
  const element = node('button', text, kind);
  element.type = 'button';
  element.onclick = () => action(element);
  return element;
}
function input(parent, label, options = {}) {
  const id = options.id || label.toLowerCase().replace(/\W+/g, '-');
  const caption = node('label', label); caption.htmlFor = id;
  const { multiline = false, type = 'text', ...attributes } = options;
  const element = node(multiline ? 'textarea' : 'input');
  Object.assign(element, { id, autocomplete: 'off', ...attributes });
  if (!multiline) element.type = type;
  parent.append(caption, element);
  return element;
}
function activityLabel(value) {
  if (!value) return '';
  const date = new Date(Number(value) < 1e12 ? Number(value) * 1000 : Number(value));
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return 'Today, ' + time;
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday, ' + time;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }) + ', ' + time;
}
function badges(connection, network, group = false) {
  const row = node('div', null, 'badges');
  row.append(node('span', [...new Set([group ? 'Group' : '', network, connection].filter(Boolean))].join(' · '), 'badge'));
  return row;
}

function chatIdentity(chat) {
  const display = chatPresentation(chat);
  const identity = node('div', null, 'chat-identity');
  const avatar = node('span', display.initials || (display.group ? '#' : '•'), 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  const details = node('div', null, 'chat-copy');
  details.append(node('strong', display.title, 'chat-name'));
  if (display.originalName) details.append(node('span', display.originalName, 'chat-original-name'));
  if (display.address) details.append(node('span', display.address, 'chat-address'));
  details.append(badges(chat.connection_name, chat.network || chat.bridge_id, display.group));
  identity.append(avatar, details);
  return identity;
}

module.exports = { node, button, input, activityLabel, badges, chatIdentity };
