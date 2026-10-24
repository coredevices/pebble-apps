// The Pebble plugin entrypoint: serves Google Home homes, devices and automations as sources and
// device control as actions, on top of the same Foyer client and tools as the MCP server.
//
// Secrets (master_token, android_id, lock_pin, oauth_token, account_email) live in
// Pebble.secureStorage, through the coreHost interface the shared code reads them with.

import { FoyerAuth, FoyerClient } from './foyer-client';
import { effectiveType } from './foyer-codec';
import { GpsOAuth } from './gpsoauth';
import { callServerTool, normalizePasscode, PasscodeStore } from './server';

const KEY_MASTER_TOKEN = 'master_token';
const KEY_ANDROID_ID = 'android_id';
const KEY_LOCK_PIN = 'lock_pin';
// Captured by the settings page with Pebble.webSignIn on Google's EmbeddedSetup page.
const KEY_OAUTH_TOKEN = 'oauth_token';
const KEY_ACCOUNT_EMAIL = 'account_email';
const SOURCES = ['home/home', 'home/device', 'home/automation'];

globalThis.coreHost = {
  async secretGet(key) {
    return Pebble.secureStorage.getItem(key);
  },
  async secretSet(key, value) {
    return value === '' ? Pebble.secureStorage.removeItem(key) : Pebble.secureStorage.setItem(key, value);
  },
};

const passcodeStore: PasscodeStore = {
  async get() {
    return notBlank(await globalThis.coreHost.secretGet(KEY_LOCK_PIN));
  },
  async set(pin: string) {
    await globalThis.coreHost.secretSet(KEY_LOCK_PIN, pin);
  },
};

function notBlank(value: string | null | undefined): string | null {
  return value != null && value.trim() !== '' ? value : null;
}

function newAndroidId(): string {
  let id = '';
  for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

function clientFor(masterToken: string, androidId: string): FoyerClient {
  return new FoyerClient(new FoyerAuth(masterToken, androidId, new GpsOAuth()));
}

/** The signed-in client, exchanging the captured oauth_token for a master token the first time. */
async function client(): Promise<FoyerClient> {
  const host = globalThis.coreHost;
  const masterToken = notBlank(await host.secretGet(KEY_MASTER_TOKEN));
  let androidId = notBlank(await host.secretGet(KEY_ANDROID_ID));
  if (masterToken != null) return clientFor(masterToken, androidId ?? '0123456789abcdef');
  const oauthToken = notBlank(await host.secretGet(KEY_OAUTH_TOKEN));
  if (oauthToken == null) throw new Error('Not signed in. Sign in with Google in Google Home settings.');
  if (androidId == null) {
    androidId = newAndroidId();
    await host.secretSet(KEY_ANDROID_ID, androidId);
  }
  const exchanged = await new GpsOAuth().exchangeOAuthToken(oauthToken, androidId);
  await host.secretSet(KEY_MASTER_TOKEN, exchanged.masterToken);
  return clientFor(exchanged.masterToken, androidId);
}

function redact(text: string): string {
  return text
    .replace(/aas_et\/[\w./+=-]+/g, '<redacted>')
    .replace(/ya29\.[\w./+=-]+/g, '<redacted>')
    .replace(/bearer\s+[\w./+=-]+/gi, 'Bearer <redacted>')
    .replace(/(EncryptedPasswd|oauth_token|Token|ACCESS_TOKEN|Authorization|Auth)=[^&\s"]+/gi, '$1=<redacted>');
}

function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

function pluginError(error: unknown): { code: string; message: string } {
  const message = errorText(error);
  if (/not signed in|oauth|master.token|auth|HTTP 40[13]/i.test(message)) return { code: 'AUTH_REQUIRED', message };
  if (/provide at least|missing|required|no devices matched|needs at least|passcode|command/i.test(message)) {
    return { code: 'INVALID_ARGS', message };
  }
  if (/HTTP 429|rate limit/i.test(message)) return { code: 'RATE_LIMITED', message };
  return { code: 'PLUGIN_UNAVAILABLE', message };
}

function shortText(value: unknown) {
  return { shortText: { text: String(value) } };
}

function longText(value: unknown) {
  return { longText: { text: typeof value === 'string' ? value : JSON.stringify(value) } };
}

function booleanReading(value: boolean) {
  return { boolean: { value }, shortText: { text: value ? 'Yes' : 'No' } };
}

function numberReading(value: number, unit?: string, min?: number, max?: number) {
  const numeric: { value: number; unit?: string; min?: number; max?: number } = { value };
  if (unit != null) numeric.unit = unit;
  if (min != null && max != null) {
    numeric.min = min;
    numeric.max = max;
  }
  return { numericValue: numeric, shortText: { text: unit == null ? String(value) : `${Math.round(value * 10) / 10}${unit}` } };
}

async function homeInstances(foyer: FoyerClient) {
  return (await foyer.getHomeGraph()).homes.map((home) => ({
    instanceId: home.id,
    properties: { name: shortText(home.name), id: longText(home.id) },
  }));
}

async function deviceInstances(foyer: FoyerClient) {
  const graph = await foyer.getHomeGraph();
  let states: Awaited<ReturnType<FoyerClient['getTraits']>> = [];
  if (graph.devices.length > 0) {
    try {
      states = await foyer.getTraits(graph.devices.map((device) => device.id));
    } catch {
      // Devices still list without their live state.
    }
  }
  const byId = new Map(states.map((state) => [state.id, state]));
  return graph.devices.map((device) => {
    const state = byId.get(device.id);
    const properties: Record<string, unknown> = {
      name: shortText(device.name),
      room: shortText(device.roomName ?? 'Unassigned'),
      type: shortText(effectiveType(device)),
      capabilities: longText(Array.from(device.capabilities).join(', ')),
    };
    if (typeof state?.online === 'boolean') properties.online = booleanReading(state.online);
    if (typeof state?.onOff === 'boolean') properties.on = booleanReading(state.onOff);
    if (typeof state?.brightnessPct === 'number') properties.brightness = numberReading(state.brightnessPct, '%', 0, 100);
    if (typeof state?.colorTemperatureK === 'number') properties.color_temperature = numberReading(state.colorTemperatureK, 'K');
    if (typeof state?.volumePct === 'number') properties.volume = numberReading(state.volumePct, '%', 0, 100);
    if (typeof state?.muted === 'boolean') properties.muted = booleanReading(state.muted);
    if (typeof state?.locked === 'boolean') properties.locked = booleanReading(state.locked);
    if (state?.thermostatMode != null) properties.thermostat_mode = shortText(state.thermostatMode);
    if (typeof state?.setpointC === 'number') properties.setpoint = numberReading(state.setpointC, '°C');
    if (typeof state?.ambientC === 'number') properties.ambient_temperature = numberReading(state.ambientC, '°C');
    return { instanceId: device.id, properties };
  });
}

async function automationInstances(foyer: FoyerClient) {
  return (await foyer.listAutomations()).map((automation) => ({
    instanceId: automation.id,
    properties: {
      name: shortText(automation.name),
      manually_runnable: booleanReading(automation.manuallyRunnable),
      starters: longText(automation.starters),
      actions: longText(automation.actions),
    },
  }));
}

Pebble.registerSourceHandler(async function (request: any, respond: any) {
  try {
    if (request.category !== 'home') {
      console.error(`Unsupported source: ${request.category}/${request.item}`);
      respond.error('PLUGIN_UNAVAILABLE', `Unknown category ${request.category}.`);
      return;
    }
    const foyer = await client();
    let instances;
    switch (request.item) {
      case 'home':
        instances = await homeInstances(foyer);
        break;
      case 'device':
        instances = await deviceInstances(foyer);
        break;
      case 'automation':
        instances = await automationInstances(foyer);
        break;
      default:
        console.error(`Unsupported source: home/${request.item}`);
        respond.error('PLUGIN_UNAVAILABLE', `Unknown item ${request.item}.`);
        return;
    }
    respond.data({ validUntilMs: Date.now() + 60 * 1000, instances });
  } catch (error) {
    const failure = pluginError(error);
    // Messages can name the user's devices and automations.
    console.error(`Reading home/${request?.item} failed: ${failure.code}`);
    respond.error(failure.code, failure.message);
  }
});

const ACTIONS = new Set([
  'turn_on', 'turn_off', 'set_brightness', 'set_color_temperature', 'set_volume', 'set_muted',
  'lock', 'unlock', 'set_thermostat', 'media_control', 'run_automation',
]);
const DEVICE_ACTIONS = new Set([
  'turn_on', 'turn_off', 'set_brightness', 'set_color_temperature', 'set_volume', 'set_muted',
  'lock', 'unlock', 'set_thermostat', 'media_control',
]);

function hasSelector(args: Record<string, unknown>): boolean {
  return ['name', 'room', 'type'].some((key) => typeof args?.[key] === 'string' && (args[key] as string).trim() !== '');
}

function failureList(failures: any[]): string {
  const parts = failures.slice(0, 3).map((failure) =>
    `${notBlank(String(failure?.name ?? '')) ?? notBlank(String(failure?.id ?? '')) ?? 'target'}: ${String(failure?.error ?? 'operation failed')}`);
  return parts.length === 0 ? '' : ` ${parts.join('; ')}`;
}

function actionResult(action: string, result: any): { ok: true; text: string } | { ok: false; code: string; message: string } {
  if (action === 'run_automation') {
    return result?.ok !== true ?
      { ok: false, code: 'PLUGIN_UNAVAILABLE', message: `Google Home did not start automation ${String(result?.name ?? '')}.`.trim() } :
      { ok: true, text: `Started automation ${String(result.name)}.` };
  }
  if (!Array.isArray(result) || result.length === 0) {
    return { ok: false, code: 'PLUGIN_UNAVAILABLE', message: `${action} performed no operations.` };
  }
  const succeeded = result.filter((op) => op?.ok === true);
  const failed = result.filter((op) => op?.ok !== true);
  if (succeeded.length === 0) {
    return { ok: false, code: 'PLUGIN_UNAVAILABLE', message: redact(`${action} failed for all ${failed.length} targets.${failureList(failed)}`) };
  }
  if (failed.length > 0) {
    return { ok: true, text: redact(`${action}: ${succeeded.length} succeeded, ${failed.length} failed.${failureList(failed)}`) };
  }
  return { ok: true, text: `${action}: ${succeeded.length} succeeded.` };
}

Pebble.registerActionHandler(async function (request: any, respond: any) {
  try {
    if (!ACTIONS.has(request.action)) {
      console.error(`Unsupported action: ${request.action}`);
      throw new Error(`Unknown action: ${request.action}`);
    }
    const args = request.args ?? {};
    if (DEVICE_ACTIONS.has(request.action) && !hasSelector(args)) {
      throw new Error('Provide at least one device selector: name, room, or type.');
    }
    const result = await callServerTool(await client(), passcodeStore, request.action, args);
    const outcome = actionResult(request.action, result);
    if (!outcome.ok) {
      console.error(`${request.action} failed: ${outcome.code}`);
      respond.error(outcome.code, outcome.message);
      return;
    }
    respond.ok({ text: outcome.text, refreshed: SOURCES });
  } catch (error) {
    const failure = pluginError(error);
    console.error(`${request?.action} failed: ${failure.code}`);
    respond.error(failure.code, failure.message);
  }
});

Pebble.registerConfigHandler(async function (message: any, respond: any) {
  const host = globalThis.coreHost;
  try {
    switch (message && message.type) {
      case 'status':
        respond({
          configured: notBlank(await host.secretGet(KEY_MASTER_TOKEN)) != null || notBlank(await host.secretGet(KEY_OAUTH_TOKEN)) != null,
          hasMasterToken: notBlank(await host.secretGet(KEY_MASTER_TOKEN)) != null,
          pinConfigured: notBlank(await host.secretGet(KEY_LOCK_PIN)) != null,
          email: notBlank(await host.secretGet(KEY_ACCOUNT_EMAIL)),
        });
        return;
      case 'connectWithOAuthToken': {
        const oauthToken = notBlank(String(message.oauthToken ?? ''));
        if (oauthToken == null) {
          respond({ error: 'Google sign-in returned no oauth_token.' });
          return;
        }
        const androidId = notBlank(await host.secretGet(KEY_ANDROID_ID)) ?? newAndroidId();
        const exchanged = await new GpsOAuth().exchangeOAuthToken(oauthToken, androidId);
        const graph = await clientFor(exchanged.masterToken, androidId).getHomeGraph();
        await host.secretSet(KEY_ANDROID_ID, androidId);
        await host.secretSet(KEY_MASTER_TOKEN, exchanged.masterToken);
        await host.secretSet(KEY_OAUTH_TOKEN, '');
        await host.secretSet(KEY_ACCOUNT_EMAIL, exchanged.email ?? '');
        Pebble.refreshSources(SOURCES);
        respond({ ok: true, configured: true, hasMasterToken: true, email: exchanged.email, homes: graph.homes.length, devices: graph.devices.length });
        return;
      }
      case 'setPin': {
        const pin = normalizePasscode(String(message.pin ?? ''));
        await passcodeStore.set(pin);
        respond({ pinConfigured: true, length: pin.length });
        return;
      }
      case 'clearPin':
        await host.secretSet(KEY_LOCK_PIN, '');
        respond({ pinConfigured: false });
        return;
      case 'testConnection': {
        const graph = await (await client()).getHomeGraph();
        respond({ ok: true, homes: graph.homes.length, devices: graph.devices.length });
        return;
      }
      case 'disconnect':
        await host.secretSet(KEY_MASTER_TOKEN, '');
        await host.secretSet(KEY_ACCOUNT_EMAIL, '');
        await host.secretSet(KEY_ANDROID_ID, '');
        await host.secretSet(KEY_LOCK_PIN, '');
        await host.secretSet(KEY_OAUTH_TOKEN, '');
        Pebble.refreshSources(SOURCES);
        respond({ configured: false, pinConfigured: false });
        return;
      default:
        respond({ error: 'Unknown message type.' });
    }
  } catch (error) {
    respond({ error: errorText(error) });
  }
});
