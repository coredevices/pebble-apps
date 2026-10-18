export const KEY = "muse.connection.v1";
const MAIN = "main";
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
  if (response.status !== 200) return null;
  const session = await response.json();
  return typeof session?.vm_id === "string" ? session.vm_id : null;
}
export function createService(storage, Client) {
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
  async function using(auth, fn, signal) {
    const client = new Client(auth);
    try {
      await client.connect({ signal });
      return await fn(client);
    } finally {
      client.close();
    }
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
          const chats = await using(auth, (c) => c.listChats());
          const previous = load();
          const selected =
            previous?.auth.vm_id === auth.vm_id ? previous.selected : MAIN;
          save({ auth, selected });
          return { configured: true, selected, chats: choices(chats) };
        }
        case "listChats": {
          const state = required();
          return {
            configured: true,
            selected: state.selected,
            chats: choices(await using(state.auth, (c) => c.listChats())),
          };
        }
        case "selectChat": {
          const state = required();
          const id = message.id;
          if (id !== MAIN) {
            const chats = choices(
              await using(state.auth, (c) => c.listChats()),
            );
            if (!chats.some((c) => c.id === id))
              throw new PluginError(
                "INVALID_ARGS",
                "That chat is no longer available. Refresh the list and choose a chat.",
              );
          }
          save({ ...state, selected: id });
          return { configured: true, selected: id };
        }
        case "disconnect":
          storage.removeItem(KEY);
          return { configured: false, selected: MAIN };
        default:
          throw new PluginError("INVALID_ARGS", "Unknown settings request.");
      }
    });
  }
  async function action(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 110000);
    try {
      return await serial(async () => {
        if (controller.signal.aborted)
          throw new PluginError(
            "PLUGIN_UNAVAILABLE",
            "Muse request expired before it could start.",
          );
        const options = { signal: controller.signal };
        if (request?.action !== "send_to_muse")
          throw new PluginError("INVALID_ARGS", "Unknown action.");
        const message = request.args?.message;
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
        await using(
          state.auth,
          async (client) => {
            if (state.selected === MAIN)
              await client.sendMain(message, options);
            else {
              const chats = choices(await client.listChats(options));
              if (!chats.some((c) => c.id === state.selected))
                throw new PluginError(
                  "INVALID_ARGS",
                  "The selected Muse chat is unavailable. Choose a chat in plugin settings.",
                );
              await client.sendToChat(state.selected, message, options);
            }
          },
          controller.signal,
        );
        return { text: "Message accepted by Muse." };
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return { config, action };
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
