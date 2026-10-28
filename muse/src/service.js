export const KEY = "muse.connection.v1";
const CHATS_KEY = "muse.chats.v1";
const MAIN = "main";
const MAIN_TITLE = "Main chat";
// The host stops an action after 20s and gives plugins no timers, so sends run on a clock budget.
const SEND_BUDGET_MS = 18000;
// Below this much time left, a send is refused rather than risk an unknown delivery.
const SEND_MIN_LEFT_MS = 8000;
const CHATS_TTL_MS = 5 * 60000;
export class PluginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
// The signed-in page reports the account's VM; ask it the same way with the captured cookie.
async function accountVm(cookie) {
  if (typeof cookie !== "string" || !cookie || /[\r\n]/.test(cookie)) return null;
  const response = await fetch("https://muse.ai/api/session", { headers: { Cookie: cookie } });
  if (response.status !== 200) {
    console.error(`Muse GET /api/session failed: HTTP ${response.status}`);
    return null;
  }
  const session = await response.json();
  return typeof session?.vm_id === "string" ? session.vm_id : null;
}
// chatStore holds the agent/chats cache (chat titles, no credentials) apart from the credential
// store, so a failed cache write can never change a result.
export function createService(
  storage,
  Client,
  now = Date.now,
  chatStore = null,
) {
  let tail = Promise.resolve();
  function serial(fn) {
    const task = tail.then(fn);
    tail = task.catch(() => {});
    return task;
  }
  function load() {
    const raw = storage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  }
  function save(value) {
    storage.setItem(KEY, JSON.stringify(value));
  }
  function required() {
    const value = load();
    if (!value)
      throw new PluginError(
        "AUTH_REQUIRED",
        "Sign in to Muse in plugin settings.",
      );
    return value;
  }
  async function using(auth, fn, deadline = now() + SEND_BUDGET_MS) {
    const client = new Client(auth);
    try {
      await client.connect({ deadline });
      return await fn(client);
    } finally {
      client.close();
    }
  }
  function cachedChats(auth) {
    try {
      const cache = JSON.parse(chatStore.getItem(CHATS_KEY));
      return cache?.vm_id === auth.vm_id ? cache : null;
    } catch {
      return null;
    }
  }
  // Cache a list only while the sign-in it was fetched with is current, and never over a newer one.
  function remember(auth, fetchedAt, chats) {
    const state = load();
    if (state?.auth.cookie !== auth.cookie || state.auth.vm_id !== auth.vm_id)
      return;
    if (cachedChats(auth)?.fetchedAt > fetchedAt) return;
    try {
      chatStore.setItem(
        CHATS_KEY,
        JSON.stringify({ vm_id: auth.vm_id, fetchedAt, chats }),
      );
    } catch {}
  }
  async function listChats(client, auth, options) {
    const fetchedAt = now();
    const chats = choices(await client.listChats(options));
    remember(auth, fetchedAt, chats);
    return chats;
  }
  function choices(chats) {
    return chats
      .filter(
        (c) =>
          c.can_send &&
          !c.is_primary &&
          !c.archived &&
          !c.is_archived &&
          c.status !== "archived",
      )
      .map((c) => ({ id: c.session_id, title: c.title || "Untitled chat" }));
  }
  async function config(message) {
    return serial(async () => {
      switch (message?.type) {
        case "status": {
          const state = load();
          return { configured: !!state, selected: state?.selected ?? MAIN };
        }
        case "connect": {
          const session = message.session;
          if (session && typeof session.vm_id !== "string")
            session.vm_id = await accountVm(session.cookie);
          if (
            !session ||
            typeof session.cookie !== "string" ||
            session.cookie.length > 32768 ||
            /[\r\n]/.test(session.cookie) ||
            typeof session.vm_id !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(session.vm_id)
          )
            throw new PluginError(
              "AUTH_REQUIRED",
              "Muse sign-in returned an invalid session. Please try again.",
            );
          const auth = { cookie: session.cookie, vm_id: session.vm_id };
          const fetchedAt = now();
          const chats = choices(await using(auth, (c) => c.listChats()));
          const previous = load();
          const same = previous?.auth.vm_id === auth.vm_id;
          const selected = same ? previous.selected : MAIN;
          save({ auth, selected, title: same ? previous.title : MAIN_TITLE });
          remember(auth, fetchedAt, chats);
          return { configured: true, selected, chats };
        }
        case "listChats": {
          const state = required();
          return {
            configured: true,
            selected: state.selected,
            chats: await using(state.auth, (c) => listChats(c, state.auth)),
          };
        }
        case "selectChat": {
          const state = required();
          const id = message.id;
          let title = MAIN_TITLE;
          if (id !== MAIN) {
            const chats = await using(state.auth, (c) =>
              listChats(c, state.auth),
            );
            const chat = chats.find((c) => c.id === id);
            if (!chat)
              throw new PluginError(
                "INVALID_ARGS",
                "That chat is no longer available. Refresh the list and choose a chat.",
              );
            title = chat.title;
          }
          save({ ...state, selected: id, title });
          return { configured: true, selected: id };
        }
        case "disconnect":
          storage.removeItem(KEY);
          try {
            chatStore.removeItem(CHATS_KEY);
          } catch {}
          return { configured: false, selected: MAIN };
        default:
          throw new PluginError("INVALID_ARGS", "Unknown settings request.");
      }
    });
  }
  // chat_id is an agent/chats instanceId or a chat name; with none, the chat chosen in settings.
  async function target(client, state, chatId, options) {
    const query = (chatId || "").trim();
    const q = query.toLowerCase();
    const main = query
      ? q === MAIN || q === MAIN_TITLE.toLowerCase()
      : state.selected === MAIN;
    if (main) return MAIN;
    const chats = await listChats(client, state.auth, options);
    if (!query) {
      if (!chats.some((c) => c.id === state.selected))
        throw new PluginError(
          "INVALID_ARGS",
          "The selected Muse chat is unavailable. Choose a chat in plugin settings.",
        );
      return state.selected;
    }
    if (chats.some((c) => c.id === query)) return query;
    const exact = chats.filter((c) => c.title.toLowerCase() === q);
    const found = exact.length
      ? exact
      : chats.filter((c) => c.title.toLowerCase().includes(q));
    if (found.length === 1) return found[0].id;
    throw new PluginError(
      "INVALID_ARGS",
      found.length
        ? "Multiple Muse chats match. Use the exact chat name or id."
        : "No Muse chat matches that name. Choose one from agent/chats or in settings.",
    );
  }
  async function source(request) {
    if (request?.category !== "agent")
      throw new PluginError("INVALID_ARGS", "Unsupported Muse source.");
    if (request.item === "configured") {
      const state = load();
      return {
        validUntilMs: now() + 60000,
        instances: [
          {
            instanceId: "muse",
            properties: {
              name: {
                shortText: {
                  text: state
                    ? (state.title ??
                      (state.selected === MAIN ? MAIN_TITLE : ""))
                    : "",
                },
              },
              configured: {
                boolean: { value: !!state },
                shortText: {
                  text: state ? "Connected" : "Sign in in settings",
                },
              },
            },
          },
        ],
      };
    }
    if (request.item !== "chats")
      throw new PluginError("INVALID_ARGS", "Unsupported Muse source.");
    // Listed on its own connection, outside the queue, so a stall never holds up sends or settings.
    const { auth } = required();
    const cached = cachedChats(auth);
    if (cached && now() - cached.fetchedAt < CHATS_TTL_MS)
      return instances(cached.chats);
    try {
      return instances(await using(auth, (c) => listChats(c, auth)));
    } catch {
      return instances(cached?.chats ?? []);
    }
  }
  function instances(chats) {
    return {
      validUntilMs: now() + 900000,
      instances: [{ id: MAIN, title: MAIN_TITLE }, ...chats].map((c) => ({
        instanceId: c.id,
        properties: { name: { shortText: { text: c.title } } },
      })),
    };
  }
  function slow(deadline) {
    if (deadline - now() < SEND_MIN_LEFT_MS)
      throw new PluginError(
        "PLUGIN_UNAVAILABLE",
        "Muse is responding slowly, so the message was not sent. Try again shortly.",
      );
  }
  async function action(request) {
    const deadline = now() + SEND_BUDGET_MS;
    return serial(async () => {
      if (request?.action !== "send_to_agent")
        throw new PluginError("INVALID_ARGS", "Unknown action.");
      const message = request.args?.message;
      const chatId = request.args?.chat_id;
      if (chatId != null && typeof chatId !== "string")
        throw new PluginError("INVALID_ARGS", "Name a Muse chat.");
      if (
        typeof message !== "string" ||
        !message.trim() ||
        message.length > 16000
      )
        throw new PluginError(
          "INVALID_ARGS",
          "Provide a message between 1 and 16,000 characters.",
        );
      const state = required();
      slow(deadline);
      let late = false;
      // Runs immediately before the message POST, after any chat lookup.
      const beforeSend = () => {
        late = deadline - now() < SEND_MIN_LEFT_MS;
        if (late) throw new Error("send budget exhausted");
      };
      await using(state.auth, async (client) => {
        const id = await target(client, state, chatId);
        try {
          if (id === MAIN) await client.sendMain(message, { beforeSend });
          else await client.sendToChat(id, message, { beforeSend });
        } catch (error) {
          if (late) slow(deadline);
          throw error;
        }
      }, deadline - SEND_MIN_LEFT_MS);
      return { text: "Message accepted by Muse." };
    });
  }
  return { config, action, source };
}
// Never forward server responses, cookies, gateway URLs or native exception strings.
export function safeError(error) {
  if (error instanceof PluginError)
    return { code: error.code, message: error.message };
  if (error?.status === 401 || error?.status === 403)
    return {
      code: "AUTH_REQUIRED",
      message: "Muse sign-in expired. Sign in again in plugin settings.",
    };
  return {
    code: "PLUGIN_UNAVAILABLE",
    message:
      "Could not complete the Muse request. If sending, delivery may be uncertain; check Muse before trying again.",
  };
}
