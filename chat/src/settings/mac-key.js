'use strict';

const { node, input } = require('./dom');

function renderMacKeyPicker(parent, state, { invoke }) {
  const status = node('p', 'Looking for your saved Mac…', 'subtle');
  const choices = node('div');
  const advanced = node('details');
  advanced.append(node('summary', 'Advanced'));
  const manual = input(advanced, 'Mac setup key', { multiline: true, spellcheck: false, placeholder: 'Paste a different setup key' });
  parent.append(status, choices, advanced);
  let selected = null, error = '', pending;
  const select = async (account, key) => {
    selected = null;
    status.textContent = 'Loading your Mac key…';
    const result = await invoke('imessage.selectActivationKey', { pebble_account: account, key_id: key.id });
    if (!result.loaded) throw Error('Your Mac key could not be loaded. Try again.');
    selected = { pebble_account: account, key_id: key.id };
    const date = new Date(key.created_at);
    status.textContent = '✓ ' + key.computer_name + ' · Key ready' + (Number.isFinite(date.getTime()) ? ' · Saved ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
  };
  const attempt = operation => {
    pending = operation().catch(failure => {
      selected = null; error = String(failure.message || failure); status.textContent = error;
    });
    return pending;
  };
  const refresh = () => attempt(async () => {
    error = ''; selected = null; choices.replaceChildren();
    status.textContent = 'Looking for your saved Mac…';
    const result = await invoke('imessage.activationKeys');
    if (!result.signed_in) { status.textContent = 'Sign in to your Pebble account in app Settings to find your saved Mac.'; return; }
    if (!result.keys.length) {
      status.textContent = 'Open Pebble on your Mac, sign in with the same Pebble account, and turn on “Set up iMessage” in Settings. Then reopen iMessage setup here.';
      if (state.saved_sign_in) status.textContent += ' You can also reuse the key already saved on this phone.';
      return;
    }
    if (result.keys.length === 1) { await select(result.account, result.keys[0]); return; }
    status.textContent = 'Choose a Mac for iMessage.';
    const label = node('label', 'Saved Mac'); label.htmlFor = 'saved-mac';
    const picker = node('select'); picker.id = 'saved-mac';
    const prompt = node('option', 'Choose a Mac'); prompt.value = ''; picker.append(prompt);
    for (const key of result.keys) {
      const date = new Date(key.created_at);
      const option = node('option', key.computer_name + (Number.isFinite(date.getTime()) ? ' · ' + date.toLocaleDateString() : ''));
      option.value = key.id; picker.append(option);
    }
    picker.onchange = () => attempt(async () => {
      error = ''; selected = null;
      const key = result.keys.find(key => key.id === picker.value);
      if (key) await select(result.account, key);
    });
    choices.append(label, picker);
  });
  refresh();
  return {
    async args() {
      await pending;
      if (manual.value.trim()) return { macValidationData: manual.value.trim() };
      if (selected) return selected;
      if (state.saved_sign_in) return {};
      throw Error(error || 'Choose a saved Mac or enter a setup key in Advanced.');
    },
    clear() { manual.value = ''; },
  };
}

module.exports = { renderMacKeyPicker };
