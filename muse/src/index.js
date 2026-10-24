import { MuseClient } from "../vendor/musemeow/client.js";
import { secureCache } from "./secure-cache.js";
import { KEY, createService, safeError } from "./service.js";
const service = createService(
  secureCache([KEY]),
  MuseClient,
  Date.now,
  globalThis.localStorage,
);
Pebble.registerActionHandler(async (request, response) => {
  try {
    response.ok(await service.action(request));
  } catch (error) {
    const safe = safeError(error);
    console.error(`Muse ${request?.action} failed: ${safe.code}`);
    response.error(safe.code, safe.message);
  }
});
Pebble.registerSourceHandler(async (request, response) => {
  try {
    response.data(await service.source(request));
  } catch (error) {
    const safe = safeError(error);
    console.error(`Muse source ${request?.item} failed: ${safe.code}`);
    response.error(safe.code, safe.message);
  }
});
Pebble.registerConfigHandler(async (message, respond) => {
  try {
    respond(await service.config(message));
  } catch (error) {
    console.error(`Muse settings ${message?.type} failed: ${safeError(error).code}`);
    respond({ error: safeError(error).message });
  }
});
