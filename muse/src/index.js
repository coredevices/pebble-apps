import { MuseClient } from "../vendor/musemeow/client.js";
import { MuseError } from "../vendor/musemeow/errors.js";
import { secureCache } from "./secure-cache.js";
import { KEY, createService, safeError } from "./service.js";
// MuseError messages are fixed strings, never server responses or credentials.
const detail = (error) => (error instanceof MuseError ? ` (${error.message})` : "");
const service = createService(
  secureCache([KEY]),
  MuseClient,
  Date.now,
  globalThis.localStorage,
);
Pebble.registerActionHandler(async (request, response) => {
  try {
    const result = await service.action(request);
    console.log(`Muse ${request?.action} ok`);
    response.ok(result);
  } catch (error) {
    const safe = safeError(error);
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
  try {
    const result = await service.config(message);
    console.log(`Muse settings ${message?.type} ok`);
    respond(result);
  } catch (error) {
    console.error(`Muse settings ${message?.type} failed: ${safeError(error).code}${detail(error)}`);
    respond({ error: safeError(error).message });
  }
});
