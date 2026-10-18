'use strict';

const { node, button, input } = require('./dom');
const { renderDirectSetup } = require('./direct');
const { renderMacKeyPicker } = require('./mac-key');

async function withSetupProgress(parent, message, operation) {
  const controls = Array.from(parent.querySelectorAll('button, input, select'));
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  const progress = node('div', null, 'setup-progress');
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  const spinner = node('span', null, 'setup-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const text = node('div');
  text.append(node('strong', message), node('p', 'This may take a minute. Keep Pebble open.', 'subtle'));
  progress.append(spinner, text);
  parent.append(progress);
  parent.setAttribute('aria-busy', 'true');
  try { return await operation(); }
  finally {
    progress.remove();
    parent.setAttribute('aria-busy', 'false');
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
  }
}

function renderConnection(parent, connection, state, actions) {
  parent.replaceChildren();
  const { run, call, reload, permission, notice } = actions;
  const invoke = (method, args) => call(method, { ...args, connection: connection.id });
  const act = (label, fn, kind) => button(label, target => run(target, fn), kind);
  const card = title => { const element = node('section', null, 'card'); if (title) element.append(node('h2', title)); parent.append(element); return element; };
  if (!connection.enabled && !state.connected) {
    parent.append(act('Connect ' + connection.name, async () => {
      await call('connections.enable', { connection: connection.id }); await reload();
    }, 'wide'));
    return;
  }
  if (connection.id === 'sms-android' && !state.ready && connection.enabled) {
    parent.append(act('Connect SMS', async () => { await permission('sms'); await reload(); }, 'wide'));
    return;
  }
  if (['whatsapp', 'telegram'].includes(connection.id) && !state.connected) {
    renderDirectSetup(connection, state, { card, act, reload, notice, actions, invoke: async (method, args) => {
      if (!connection.enabled) await call('connections.enable', { connection: connection.id });
      return invoke(method, args);
    } });
    return;
  }
  const summary = card();
  summary.append(node('strong', !connection.enabled ? 'Paused' : state.ready ? 'Connected' : state.connected ? 'Finish setup' : 'Not connected'));
  const account = state.account_label || state.saved_sign_in?.apple_id || state.account;
  if (connection.id !== 'sms-android' && account && account !== 'beeper-android') summary.append(node('p', account, 'subtle'));
  if (state.connection_warning) summary.append(node('p', state.connection_warning, 'subtle'));
  if (state.sync_progress?.error) summary.append(node('p', state.sync_progress.error, 'subtle'));
  if (state.connected && !state.directory_complete && connection.id === 'beeper-ios') summary.append(node('p', 'Updating your chat list…', 'subtle'));

  if (connection.enabled && connection.id === 'beeper-android') {
    if (!state.ready) {
      const setup = card('Connect Beeper');
      setup.append(node('p', state.installed ? 'Allow Pebble to read your Beeper chat list and send messages to the chats you choose.' : 'Install the Beeper Android app and sign in, then return here.', 'subtle'));
      if (state.installed) setup.append(act('Allow Beeper access', async () => { await permission('beeper'); await reload(); }));
      const help = node('details'); help.append(node('summary', 'Permission help'));
      help.append(node('p', 'On your home screen, press and hold Pebble, tap ⓘ App info, then Permissions → Additional permissions. Allow access to Beeper. If access is still unavailable, open Beeper and sign in. You can also check Beeper’s App info → Permissions.', 'subtle'));
      setup.append(help, act('Check again', reload));
    }
  } else if (connection.enabled && connection.id === 'beeper-ios') {
    if (!state.connected) {
      const setup = card('Sign in to Beeper');
      const email = input(setup, 'Beeper email', { type: 'email', autocomplete: 'email' });
      const codeForm = node('div'); codeForm.hidden = true;
      const code = input(codeForm, 'Code from your email', { autocomplete: 'one-time-code' });
      let flow = '';
      setup.append(act('Send sign-in code', async () => {
        const result = await invoke('login.start', { email: email.value.trim() });
        flow = result.flow; codeForm.hidden = false; code.focus(); notice(result.status || 'Check your email.');
      }));
      codeForm.append(act('Sign in', async () => {
        try { await invoke('login.finish', { flow, code: code.value.trim() }); }
        finally { code.value = ''; }
        await invoke('directory.start'); await reload();
      }), act('Cancel sign-in', async () => { await invoke('login.cancel'); code.value = ''; codeForm.hidden = true; }));
      setup.append(codeForm);
    } else if (!state.verified) {
      const verify = card('Verify this device');
      verify.append(node('p', 'Open Beeper on another device and compare the emojis.', 'subtle'));
      const view = node('div'); verify.append(view);
      actions.verificationView = view;
      actions.showVerification = value => renderVerification(view, value, { invoke, act, reload });
      verify.append(act('Verify with emojis', async () => actions.showVerification(await invoke('verification.start', { method: 'sas' }))));
    }
  } else if (connection.enabled && connection.id === 'imessage') {
    if (state.imessage_phase === 'needsTwoFactor') {
      const verify = card('Apple verification');
      const code = input(verify, 'Six-digit verification code', { inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6 });
      const submit = act('Verify code', async () => {
        try { await withSetupProgress(verify, 'Finishing iMessage setup…', () => invoke('imessage.submitTwoFactorCode', { code: code.value.trim() })); }
        finally { code.value = ''; await reload(); }
      });
      submit.disabled = !state.can_submit_two_factor;
      verify.append(submit);
      if (!state.can_submit_two_factor) verify.append(node('p', 'This sign-in expired. Start again.', 'subtle'));
      verify.append(act(state.can_submit_two_factor ? 'Cancel sign-in' : 'Start again', async () => {
        await invoke('imessage.disconnect', { account: state.account }); await reload();
      }));
    } else if (!state.ready) {
      const setup = card('Sign in to iMessage');
      const macKey = renderMacKeyPicker(setup, state, { invoke, act });
      const email = input(setup, 'Apple Account email', { type: 'email', autocomplete: 'username', value: state.saved_sign_in?.apple_id || '' });
      const password = input(setup, 'Apple Account password', { type: 'password', autocomplete: 'current-password', placeholder: state.saved_sign_in ? 'Saved securely · leave blank to reuse' : '' });

      setup.append(act('Sign in', async () => {
        notice('Signing in to Apple…');
        try { await withSetupProgress(setup, 'Signing in to iMessage…', async () => invoke('imessage.configure', { ...await macKey.args(), appleId: email.value.trim(), password: password.value })); }
        finally { macKey.clear(); password.value = ''; await reload(); }
      }));
    } else {
      renderMacKeyPicker(card('Mac setup key'), state, { invoke, act });
      const settings = card('Send messages');
      const label = node('label', 'Send from'); label.htmlFor = 'sender';
      const sender = node('select'); sender.id = 'sender';
      (state.handles || []).forEach(handle => { const option = node('option', handle.replace(/^(tel:|mailto:)/, '')); option.value = handle; sender.append(option); });
      sender.value = state.selected_sender || '';
      settings.append(label, sender, act('Save', async () => { await invoke('imessage.selectSender', { sender: sender.value }); await reload(); notice('Sending address saved.'); }));
    }
  }
  if (connection.enabled && ['whatsapp', 'telegram'].includes(connection.id)) renderDirectSetup(connection, state, { card, act, invoke, reload, notice, actions });
  if (!state.connected) return;
  const manage = state.ready || !connection.enabled ? node('div', null, 'connection-actions') : card();
  if (state.ready || !connection.enabled) summary.append(manage);
  manage.append(act(connection.enabled ? 'Pause' : 'Resume', async () => {
    await call(connection.enabled ? 'connections.disable' : 'connections.enable', { connection: connection.id }); await reload();
  }));
  const confirm = node('div'); confirm.hidden = true;
  confirm.append(node('p', connection.id === 'sms-android' ? 'Disconnect SMS? Its approved chats will be removed from Pebble.' : 'Disconnect this account? Its chats and saved sign-in will be removed from Pebble.'));
  confirm.append(act('Disconnect', async () => {
    await call('connections.delete', { connection: connection.id, account: state.account }); await actions.home(); notice('Account disconnected.');
  }, 'danger'), act('Cancel', async () => { confirm.hidden = true; }));
  manage.append(act('Disconnect…', async () => { confirm.hidden = false; }, 'danger'), confirm);
}

function renderVerification(parent, value, { invoke, act, reload }) {
  parent.replaceChildren();
  const messages = { connecting: 'Open Beeper on another device and accept the verification request.', requested: 'Accept the verification request in Beeper.',
    ready: 'Preparing emojis…', sas: 'Do these emojis match the ones in Beeper?', waiting_other_device: 'Confirm the match in Beeper too.',
    secrets: 'Finishing setup…', complete: 'Device verified.', cancelled: 'Verification cancelled.', expired: 'Verification expired. Start again.' };
  parent.append(node('p', value.error || messages[value.phase] || 'Follow the verification prompt in Beeper.'));
  const args = { flow_id: value.flow_id || '', transaction_id: value.transaction_id || '' };
  const next = method => async () => {
    const result = await invoke(method, args);
    renderVerification(parent, result, { invoke, act, reload });
    if (result.phase === 'complete') await reload();
  };
  if (value.emojis?.length) parent.append(node('p', value.emojis.join(' '), 'emoji'), node('p', (value.descriptions || []).join(' · '), 'subtle'));
  if (value.phase === 'sas') parent.append(act('They match', next('verification.confirm_sas')), act('They don’t match', next('verification.mismatch'), 'danger'));
  if (value.phase === 'secrets_error') parent.append(act('Retry verification', next('verification.retry_secrets')));
  if (!['idle', 'complete', 'cancelled', 'expired', 'error'].includes(value.phase)) parent.append(act('Cancel verification', next('verification.cancel')));
}

module.exports = { withSetupProgress, renderConnection };
