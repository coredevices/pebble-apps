import { MuseClient } from "../vendor/musemeow/client.js";
import { MuseError } from "../vendor/musemeow/errors.js";
import { secureCache } from "./secure-cache.js";
import { KEY, createService, safeError } from "./service.js";
import { blockedMessage, checkReach, lastBlocked } from "./reach.js";
// MuseError messages are fixed strings, never server responses or credentials.
const detail = (error) => (error instanceof MuseError ? ` (${error.message})` : "");
const service = createService(
  secureCache([KEY]),
  MuseClient,
  Date.now,
  globalThis.localStorage,
);
// Probes have no deadline, so a failed action answers from the last check and starts a new one.
function withBlockedHost(safe) {
  if (safe.code !== "PLUGIN_UNAVAILABLE") return safe;
  let host = null;
  try {
    host = lastBlocked(globalThis.localStorage);
    checkReach(globalThis.localStorage).catch(() => {});
  } catch {}
  return host ? { code: safe.code, message: `${blockedMessage(host)} If sending, delivery may be uncertain; check Muse before trying again.` } : safe;
}
Pebble.registerActionHandler(async (request, response) => {
  try {
    const result = await service.action(request);
    console.log(`Muse ${request?.action} ok`);
    response.ok(result);
  } catch (error) {
    const safe = withBlockedHost(safeError(error));
    console.error(`Muse ${request?.action} failed: ${safe.code}${detail(error)}`);
    response.error(safe.code, safe.message);
  }
});
Pebble.registerSourceHandler(async (request, response) => {
  try {
    response.data(await service.source(request));
  } catch (error) {
    const safe = safeError(error);
    console.error(`Muse source ${request?.item} failed: ${safe.code}${detail(error)}`);
    response.error(safe.code, safe.message);
  }
});
Pebble.registerConfigHandler(async (message, respond) => {
  if (message?.type === "reach") {
    respond({ blocked: await checkReach(globalThis.localStorage).catch(() => null) });
    return;
  }
  try {
    const result = await service.config(message);
    console.log(`Muse settings ${message?.type} ok`);
    respond(result);
  } catch (error) {
    console.error(`Muse settings ${message?.type} failed: ${safeError(error).code}${detail(error)}`);
    respond({ error: safeError(error).message });
  }
});
