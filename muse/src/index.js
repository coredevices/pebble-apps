import { MuseClient } from "../vendor/musemeow/client.js";
import { secureCache } from "./secure-cache.js";
import { KEY, createService, safeError } from "./service.js";
const service = createService(secureCache([KEY]), MuseClient);
Pebble.registerActionHandler(async (request, response) => {
  try {
    response.ok(await service.action(request));
  } catch (error) {
    const safe = safeError(error);
    response.error(safe.code, safe.message);
  }
});
Pebble.registerConfigHandler(async (message, respond) => {
  try {
    respond(await service.config(message));
  } catch (error) {
    respond({ error: safeError(error).message });
  }
});
