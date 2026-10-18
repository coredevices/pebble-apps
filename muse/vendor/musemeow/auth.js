import { MuseError } from './errors.js';
export function authValues(auth) {
  const value = auth;
  if (!value || typeof value.cookie !== 'string' || !value.cookie || /[\r\n]/.test(value.cookie) ||
      typeof value.vm_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(value.vm_id)) {
    throw new MuseError('cookie and valid vm_id required');
  }
  const pin = value.server_public_key ? Buffer.from(value.server_public_key, 'base64') : null;
  if (pin && pin.length !== 32) throw new MuseError('server public key must be 32 bytes');
  if (value.node_id !== undefined && typeof value.node_id !== 'string') throw new MuseError('invalid node_id');
  return { cookie: value.cookie, vm_id: value.vm_id, node_id: value.node_id, pin };
}
