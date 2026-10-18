'use strict';

var runtimeErrors = require('./runtime/errors');
var RuntimeError = runtimeErrors.RuntimeError;
var ERROR_KINDS = runtimeErrors.ERROR_KINDS;
var normalizeRecipient = require('./imessage/recipient').normalizeRecipient;

function pageStatus(status) {
  if (status && status.ready === true && status.phase === 'ready') return 'ready';
  if (status && status.phase === 'needs-two-factor') return 'needsTwoFactor';
  return 'disconnected';
}

function configReply(status, preferences) {
  preferences = preferences || { contacts: [], selectedSender: null };
  var handles = status && status.ready === true && Array.isArray(status.handles)
    ? status.handles.slice()
    : [];
  var reply = {
    ok: true,
    status: pageStatus(status),
    handles: handles,
    contacts: Array.isArray(preferences.contacts) ? preferences.contacts.map(function (contact) {
      return { name: contact.name, address: contact.address };
    }) : [],
    selectedSender: typeof preferences.selectedSender === 'string'
      ? preferences.selectedSender
      : null,
  };
  if (status && status.phase === 'needs-two-factor') {
    reply.canSubmitTwoFactor = status.canSubmitTwoFactor === true;
  }
  return Object.freeze(reply);
}

function safeFailure(error, operation) {
  if (error instanceof RuntimeError) {
    if (operation === 'configure' && error.code === 'APS_ACTIVATION_INVALID_INPUT') {
      return { code: 'INVALID_ARGS', message: 'The Mac + RustPush token cannot be used for Apple Push setup.' };
    }
    if (operation === 'configure' && error.code === 'APS_ACTIVATION_REJECTED'
        && error.retryable !== true) {
      return {
        code: 'PLUGIN_UNAVAILABLE',
        message: 'Apple rejected Apple Push setup. This build cannot continue with the current activation material.',
      };
    }
    if (operation === 'configure' && (error.code === 'APS_ACTIVATION_NETWORK_ERROR'
        || error.code === 'APS_ACTIVATION_REJECTED'
        || error.code === 'APS_HTTP_INVALID'
        || error.code === 'APS_HTTP_FAILED'
        || error.code === 'APS_CONNECT_FAILED'
        || error.code === 'APS_CONNECT_TIMEOUT'
        || error.code === 'APS_TLS_ERROR'
        || error.code === 'APS_TLS_CLOSED'
        || error.code === 'APS_TLS_WRITE_FAILED'
        || error.code === 'APS_PROTOCOL_FAILED')) {
      return { code: 'PLUGIN_UNAVAILABLE', message: 'Apple Push setup could not connect. Check your connection and try again.' };
    }
    if (operation === 'configure' && (error.code === 'APS_ACTIVATION_CRYPTO_ERROR'
        || error.code === 'APS_ACTIVATION_RESPONSE_INVALID'
        || error.code === 'APS_ACTIVATION_FAILED'
        || error.code === 'APS_ACTIVATION_UNAVAILABLE'
        || error.code === 'APS_BOOTSTRAP_REQUIRED')) {
      return { code: 'PLUGIN_UNAVAILABLE', message: 'Apple Push setup could not be completed.' };
    }
    if (error.kind === ERROR_KINDS.INVALID_INPUT) {
      if (error.code === 'INVALID_CONTACTS' || error.code === 'INVALID_SENDER') {
        return { code: 'INVALID_ARGS', message: error.message };
      }
      if (error.code === 'INVALID_TWO_FACTOR_CODE') {
        return { code: 'AUTH_REQUIRED', message: 'That verification code was not accepted.' };
      }
      if (error.code === 'CREDENTIALS_REQUIRED' || error.code === 'MAC_AUTHORIZATION_REQUIRED') {
        return { code: 'AUTH_REQUIRED', message: 'Complete iMessage setup first.' };
      }
      if (error.code === 'MAC_VALIDATION_REQUIRED') {
        return {
          code: 'AUTH_REQUIRED',
          message: 'Fresh Mac validation data is unavailable in this session. Start iMessage setup again.',
        };
      }
      if (error.code === 'APS_BOOTSTRAP_INVALID'
          || error.code === 'APS_BOOTSTRAP_NOT_YET_VALID'
          || error.code === 'APS_BOOTSTRAP_EXPIRED') {
        return { code: 'INVALID_ARGS', message: 'The APS bootstrap in the Mac + RustPush token is invalid or expired.' };
      }
      if (error.code === 'INVALID_MAC_TOKEN') {
        return { code: 'INVALID_ARGS', message: 'The Mac + RustPush token is invalid.' };
      }
      if (error.code === 'MAC_TOKEN_PORTABLE_NAC_UNSUPPORTED') {
        return {
          code: 'INVALID_ARGS',
          message: 'This ExtractKey activation is incomplete. Export the full encrypted Mac hardware activation and try again.',
        };
      }
    }
    if (error.kind === ERROR_KINDS.STORAGE) {
      if (error.code === 'INVALID_PREFERENCES_STATE'
          || error.code === 'PREFERENCES_READ_FAILED'
          || error.code === 'PREFERENCES_WRITE_FAILED') {
        return { code: 'PLUGIN_UNAVAILABLE', message: 'Saved iMessage contacts and sender preference could not be restored.' };
      }
      return { code: 'PLUGIN_UNAVAILABLE', message: 'Saved iMessage setup could not be restored.' };
    }
  }
  return operation === 'configure'
    ? { code: 'PLUGIN_UNAVAILABLE', message: 'iMessage setup could not be completed.' }
    : { code: 'PLUGIN_UNAVAILABLE', message: 'The iMessage could not be sent.' };
}

function PluginController(options) {
  if (!options || typeof options !== 'object'
      || !options.configuration || typeof options.configuration.status !== 'function'
      || typeof options.configuration.configure !== 'function'
      || typeof options.configuration.submitTwoFactor !== 'function'
      || typeof options.configuration.disconnect !== 'function'
      || typeof options.prepareConfiguration !== 'function'
      || typeof options.createSender !== 'function'
      || !options.preferences || typeof options.preferences.snapshot !== 'function'
      || typeof options.preferences.resolveRecipient !== 'function'
      || typeof options.preferences.replaceContacts !== 'function'
      || typeof options.preferences.reconcileSelectedSender !== 'function'
      || typeof options.preferences.selectSender !== 'function'
      || typeof options.preferences.clearSelectedSender !== 'function') {
    throw new TypeError('Plugin controller dependencies are unavailable.');
  }
  this.configuration = options.configuration;
  this.prepareConfiguration = options.prepareConfiguration;
  this.createSender = options.createSender;
  this.preferences = options.preferences;
  this.sending = false;
}

PluginController.prototype._configReply = function (status) {
  var handles = status && status.ready === true && Array.isArray(status.handles) ? status.handles : [];
  if (status && status.ready === true) this.preferences.reconcileSelectedSender(handles);
  return configReply(status, this.preferences.snapshot(handles));
};

PluginController.prototype.handleAction = async function (request, respond) {
  if (!request || request.action !== 'send_message') {
    respond.error('PLUGIN_UNAVAILABLE', 'Unknown iMessage action.');
    return;
  }
  var args = request.args || {};
  var recipient;
  try {
    recipient = this.preferences.resolveRecipient(args.recipient);
  } catch (error) {
    var lookupFailure = safeFailure(error, 'send');
    respond.error(lookupFailure.code, lookupFailure.message);
    return;
  }
  var text = typeof args.text === 'string' ? args.text : '';
  if (!recipient) {
    respond.error('INVALID_ARGS', 'Use a saved contact name, one iMessage email address, or an international phone number beginning with +.');
    return;
  }
  if (text.length === 0) {
    respond.error('INVALID_ARGS', 'The iMessage text cannot be empty.');
    return;
  }
  var configurationStatus = this.configuration.status();
  if (configurationStatus.ready !== true) {
    respond.error('AUTH_REQUIRED', 'Configure iMessage first.');
    return;
  }
  if (this.sending) {
    respond.error('PLUGIN_UNAVAILABLE', 'An iMessage send is already in progress.');
    return;
  }

  this.sending = true;
  var sender;
  try {
    var selectedSender = this.preferences.reconcileSelectedSender(configurationStatus.handles);
    if (!selectedSender) {
      respond.error('PLUGIN_UNAVAILABLE', 'No valid send-from address is registered for this Apple ID.');
      return;
    }
    sender = await this.createSender({ sender: selectedSender });
    var sent = await sender.send({ recipient: recipient, text: text });
    text = null;
    respond.ok({
      text: 'Sent iMessage to ' + recipient.replace(/^(mailto:|tel:)/, '') + '.',
      data: { messageId: sent.messageId, recipient: sent.recipient },
    });
  } catch (error) {
    text = null;
    var publicError = safeFailure(error, 'send');
    respond.error(publicError.code, publicError.message);
  } finally {
    if (sender && typeof sender.close === 'function') {
      try { sender.close(); } catch (_) { /* send result remains authoritative */ }
    }
    this.sending = false;
  }
};

PluginController.prototype.handleConfig = async function (message) {
  try {
    switch (message && message.type) {
      case 'status':
        return this._configReply(this.configuration.status());
      case 'refresh': {
        if (this.sending) throw Error('An iMessage operation is already in progress.');
        var current = this._configReply(this.configuration.status());
        if (current.status !== 'ready') throw Error('Connect iMessage before refreshing.');
        this.sending = true;
        try {
          var connection = await this.createSender({ sender: current.selectedSender });
          await connection.refresh();
          return this._configReply(this.configuration.status());
        } finally { this.sending = false; }
      }
      case 'configure': {
        var macValidationData = String(message.macValidationData || '').trim();
        var username = String(message.appleId || '').trim();
        var password = String(message.password || '');
        if (!macValidationData || !username || !password) {
          return { ok: false, code: 'INVALID_ARGS', message: 'Mac + RustPush token, Apple ID, and password are required.' };
        }
        var credentials = {
          macValidationData: macValidationData,
          username: username,
          password: password,
        };
        try {
          if (typeof this.configuration.validateConfigurationInput === 'function') {
            this.configuration.validateConfigurationInput(credentials);
          }
          await this.prepareConfiguration();
          var status = await this.configuration.configure(credentials);
          return this._configReply(status);
        } finally {
          credentials = null;
          password = null;
          macValidationData = null;
        }
      }
      case 'submitTwoFactorCode': {
        var code = String(message.code || '').trim();
        if (!/^[0-9]{6}$/.test(code)) {
          return { ok: false, code: 'INVALID_ARGS', message: 'Enter the six-digit verification code.' };
        }
        var verified = await this.configuration.submitTwoFactor(code);
        code = null;
        return this._configReply(verified);
      }
      case 'saveContacts':
        this.preferences.replaceContacts(message.contacts);
        return this._configReply(this.configuration.status());
      case 'selectSender':
        this.preferences.selectSender(message.sender, this.configuration.status().handles);
        return this._configReply(this.configuration.status());
      case 'disconnect': {
        var disconnected = await this.configuration.disconnect();
        this.preferences.clearSelectedSender();
        return this._configReply(disconnected);
      }
      default:
        return { ok: false, code: 'INVALID_REQUEST', message: 'Unknown settings request.' };
    }
  } catch (error) {
    var publicError = safeFailure(error, 'configure');
    return { ok: false, code: publicError.code, message: publicError.message,
      status: pageStatus(this.configuration.status()) };
  }
};

module.exports = {
  PluginController: PluginController,
  configReply: configReply,
  normalizeRecipient: normalizeRecipient,
  pageStatus: pageStatus,
  safeFailure: safeFailure,
};
