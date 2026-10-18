'use strict';

var recipient = require('../imessage/recipient');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var STORAGE_KEY = 'imessage-js.preferences.v1';
var MAX_CONTACTS = 50;
var MAX_SERIALIZED_BYTES = 64 * 1024;

function preferenceError(code, message, kind, cause) {
  return new RuntimeError(code, message, {
    kind: kind || ERROR_KINDS.INVALID_INPUT,
    cause: cause,
  });
}

function normalizeContactName(value) {
  if (typeof value !== 'string') return null;
  var normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 64 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function contactNameKey(name) {
  return name.toLowerCase();
}

function normalizeSenderHandles(handles) {
  if (!Array.isArray(handles) || handles.length > 32) return [];
  var seen = Object.create(null);
  var normalized = [];
  handles.forEach(function (value) {
    var handle = recipient.normalizeRecipient(value);
    if (handle && !seen[handle]) {
      seen[handle] = true;
      normalized.push(handle);
    }
  });
  return normalized;
}

function defaultSender(handles) {
  var normalized = normalizeSenderHandles(handles);
  return recipient.preferredSender(normalized);
}

function normalizeContacts(contacts) {
  if (!Array.isArray(contacts) || contacts.length > MAX_CONTACTS) {
    throw preferenceError('INVALID_CONTACTS', 'Contacts must be a list of at most ' + MAX_CONTACTS + ' entries.');
  }
  var names = Object.create(null);
  return contacts.map(function (value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw preferenceError('INVALID_CONTACTS', 'Each contact needs a name and one iMessage address.');
    }
    var name = normalizeContactName(value.name);
    var address = recipient.normalizeRecipient(value.address);
    if (!name || !address || recipient.normalizeRecipient(name)) {
      throw preferenceError('INVALID_CONTACTS', 'Each contact needs a name and a valid iMessage email or + phone number.');
    }
    var key = contactNameKey(name);
    if (names[key]) {
      throw preferenceError('INVALID_CONTACTS', 'Contact names must be unique.');
    }
    names[key] = true;
    return Object.freeze({ name: name, address: address });
  });
}

function emptyState() {
  return { version: 1, contacts: [], selectedSender: null };
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== 1 || !Array.isArray(value.contacts)
      || (value.selectedSender !== null && typeof value.selectedSender !== 'string')) {
    throw preferenceError(
      'INVALID_PREFERENCES_STATE',
      'Saved iMessage preferences are malformed.',
      ERROR_KINDS.STORAGE
    );
  }
  var contacts;
  try {
    contacts = normalizeContacts(value.contacts);
  } catch (error) {
    throw preferenceError(
      'INVALID_PREFERENCES_STATE',
      'Saved iMessage preferences are malformed.',
      ERROR_KINDS.STORAGE,
      error
    );
  }
  var selectedSender = value.selectedSender === null
    ? null
    : recipient.normalizeRecipient(value.selectedSender);
  if (value.selectedSender !== null && selectedSender === null) {
    throw preferenceError(
      'INVALID_PREFERENCES_STATE',
      'Saved iMessage sender preference is malformed.',
      ERROR_KINDS.STORAGE
    );
  }
  return { version: 1, contacts: contacts, selectedSender: selectedSender };
}

function UserPreferences(storage, options) {
  if (!storage || typeof storage.get !== 'function'
      || typeof storage.set !== 'function' || typeof storage.delete !== 'function') {
    throw new TypeError('iMessage preference storage is unavailable.');
  }
  options = options || {};
  this.storage = storage;
  this.storageKey = options.storageKey || STORAGE_KEY;
}

UserPreferences.prototype._load = function () {
  var raw;
  try {
    raw = this.storage.get(this.storageKey);
  } catch (error) {
    throw preferenceError('PREFERENCES_READ_FAILED', 'Unable to read iMessage preferences.', ERROR_KINDS.STORAGE, error);
  }
  if (raw === null || raw === undefined) return emptyState();
  if (typeof raw !== 'string' || raw.length > MAX_SERIALIZED_BYTES) {
    throw preferenceError('INVALID_PREFERENCES_STATE', 'Saved iMessage preferences are malformed.', ERROR_KINDS.STORAGE);
  }
  try {
    return validateState(JSON.parse(raw));
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw preferenceError('INVALID_PREFERENCES_STATE', 'Saved iMessage preferences are malformed.', ERROR_KINDS.STORAGE, error);
  }
};

UserPreferences.prototype._save = function (state) {
  var normalized = validateState(state);
  var serialized = JSON.stringify(normalized);
  if (serialized.length > MAX_SERIALIZED_BYTES) {
    throw preferenceError('INVALID_CONTACTS', 'The contact list is too large.');
  }
  try {
    this.storage.set(this.storageKey, serialized);
  } catch (error) {
    throw preferenceError('PREFERENCES_WRITE_FAILED', 'Unable to save iMessage preferences.', ERROR_KINDS.STORAGE, error);
  }
  return normalized;
};

UserPreferences.prototype.snapshot = function (handles) {
  var state = this._load();
  var validHandles = normalizeSenderHandles(handles);
  var selectedSender = validHandles.indexOf(state.selectedSender) !== -1
    ? state.selectedSender
    : defaultSender(validHandles);
  return Object.freeze({
    contacts: Object.freeze(state.contacts.slice()),
    selectedSender: selectedSender,
  });
};

UserPreferences.prototype.replaceContacts = function (contacts) {
  var state = this._load();
  state.contacts = normalizeContacts(contacts);
  return this._save(state);
};

UserPreferences.prototype.resolveRecipient = function (value) {
  var direct = recipient.normalizeRecipient(value);
  if (direct) return direct;
  var name = normalizeContactName(value);
  if (!name) return null;
  var key = contactNameKey(name);
  var contacts = this._load().contacts;
  for (var index = 0; index < contacts.length; index += 1) {
    if (contactNameKey(contacts[index].name) === key) return contacts[index].address;
  }
  return null;
};

UserPreferences.prototype.reconcileSelectedSender = function (handles) {
  var validHandles = normalizeSenderHandles(handles);
  var state = this._load();
  var selected = validHandles.indexOf(state.selectedSender) !== -1
    ? state.selectedSender
    : defaultSender(validHandles);
  if (state.selectedSender !== selected) {
    state.selectedSender = selected;
    this._save(state);
  }
  return selected;
};

UserPreferences.prototype.selectSender = function (sender, handles) {
  var validHandles = normalizeSenderHandles(handles);
  var selected = recipient.normalizeRecipient(sender);
  if (!selected || validHandles.indexOf(selected) === -1) {
    throw preferenceError('INVALID_SENDER', 'Choose one of the valid send-from addresses for this Apple ID.');
  }
  var state = this._load();
  state.selectedSender = selected;
  this._save(state);
  return selected;
};

UserPreferences.prototype.clearSelectedSender = function () {
  var state = this._load();
  if (state.selectedSender === null) return;
  state.selectedSender = null;
  this._save(state);
};

module.exports = {
  UserPreferences: UserPreferences,
  defaultSender: defaultSender,
  normalizeContactName: normalizeContactName,
  normalizeContacts: normalizeContacts,
  normalizeSenderHandles: normalizeSenderHandles,
};
