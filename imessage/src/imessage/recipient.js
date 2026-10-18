'use strict';

/** Normalize a direct one-to-one iMessage destination into its IDS URI form. */
function normalizeRecipient(value) {
  var original = typeof value === 'string' ? value.trim() : '';
  if (!original || original.length > 320 || /[,;]/.test(original)) return null;
  var email = original.replace(/^mailto:/i, '').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'mailto:' + email;
  var phone = original.replace(/^tel:/i, '').replace(/[\s().-]/g, '');
  if (/^\+[1-9][0-9]{6,14}$/.test(phone)) return 'tel:' + phone;
  return null;
}

/** Choose the preferred local iMessage identity while preserving Apple's registration order. */
function preferredSender(handles) {
  if (!Array.isArray(handles)) return null;
  for (var index = 0; index < handles.length; index += 1) {
    if (typeof handles[index] === 'string' && handles[index].indexOf('tel:') === 0) {
      return handles[index];
    }
  }
  return handles.length > 0 && typeof handles[0] === 'string' ? handles[0] : null;
}

module.exports = {
  normalizeRecipient: normalizeRecipient,
  preferredSender: preferredSender,
};
