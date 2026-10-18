'use strict';
const { node, input } = require('./dom');

function renderDirectSetup(connection, state, { card, act, invoke, reload, notice, actions }) {
  if (state.ready) return;
  const setup = card();
  const phase = state.login_phase;
  if (state.needs_reconnect && !phase) {
    setup.append(node('p', 'WhatsApp disconnected Pebble. Link it again to send messages.', 'subtle'));
    setup.append(act('Reconnect WhatsApp', async () => {
      setup.replaceChildren();
      renderDirectSetup(connection, { ...state, needs_reconnect: false, login_error: '' },
        { card: () => setup, act, invoke, reload, notice, actions });
    }, 'wide'));
    return;
  }
  if (state.login_error) setup.append(node('p', state.login_error, 'subtle'));
  if (connection.id === 'whatsapp' && phase === 'pairing') {
    const view = node('div'); setup.append(view);
    actions.showLogin = value => {
      view.replaceChildren();
      if (value.pairing_code) {
        view.append(node('p', 'In WhatsApp, open Settings → Linked devices → Link a device → Link with phone number. Enter this code:', 'subtle'));
        view.append(node('strong', value.pairing_code, 'pairing-code'));
      } else if (value.qr_image) {
        view.append(node('p', 'In WhatsApp, open Settings → Linked devices → Link a device, then scan this code.', 'subtle'));
        const image = node('img'); image.src = value.qr_image; image.alt = 'WhatsApp linking code'; image.width = 256; image.height = 256; view.append(image);
      }
    };
    actions.showLogin(state);
    setup.append(act('Cancel', async () => { await invoke('login.cancel'); await reload(); }));
    return;
  }
  if (connection.id === 'telegram' && ['code', 'password'].includes(phase)) {
    const password = phase === 'password';
    setup.append(node('p', password ? 'Enter your Telegram two-step verification password.' : 'Enter the code Telegram sent to you.', 'subtle'));
    const value = input(setup, password ? 'Password' : 'Sign-in code', { type: password ? 'password' : 'text', autocomplete: password ? 'current-password' : 'one-time-code', inputMode: password ? 'text' : 'numeric' });
    setup.append(act('Continue', async () => {
      let result;
      try { result = await invoke('login.finish', { [password ? 'password' : 'code']: value.value }); }
      finally { value.value = ''; }
      if (result.ready) {
        notice('Updating your chat list…');
        try { await invoke('directory.start'); }
        finally { await reload({ startDirectory: false }); }
        notice('Connected. Your chat list is up to date.');
      } else await reload();
    }), act('Cancel', async () => { await invoke('login.cancel'); await reload(); }));
    return;
  }
  const phone = input(setup, 'Your phone number', { type: 'tel', autocomplete: 'tel', placeholder: '+1 415 555 0123' });
  const start = async useQR => {
    await invoke('login.start', { phone: useQR ? '' : phone.value.trim() });
    await reload();
  };
  setup.append(act(connection.id === 'whatsapp' ? 'Get linking code' : 'Send sign-in code', () => start(false), 'wide'));
  if (connection.id === 'whatsapp') setup.append(act('Use a QR code instead', () => start(true), 'link'));
}
module.exports = { renderDirectSetup };
