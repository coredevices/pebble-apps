// Google Home watchapp: device mirror and AppMessage in/out.
#include "googlehome.h"

Device g_devices[MAX_DEVICES];
int g_count = -1;
char g_message[64] = "Loading…";
static int s_total = -1;

static const char *MODE_LABELS[] = { "", "Off", "Heat", "Cool", "Eco", "Auto" };

const char *mode_label(int mode) {
  return mode >= 0 && mode < (int)ARRAY_LENGTH(MODE_LABELS) ? MODE_LABELS[mode] : "";
}

void format_degrees(char *buf, size_t size, int tenths, bool fahrenheit) {
  if (fahrenheit || tenths % 10 == 0) {
    snprintf(buf, size, "%d°", (tenths + (tenths >= 0 ? 5 : -5)) / 10);
  } else {
    snprintf(buf, size, "%d.%d°", tenths / 10, abs(tenths % 10));
  }
}

static void copy_string(char *dst, size_t size, DictionaryIterator *iter, uint32_t key) {
  Tuple *t = dict_find(iter, key);
  if (!t) return;
  strncpy(dst, t->value->cstring, size - 1);
  dst[size - 1] = '\0';
  // If that cut a UTF-8 character, drop its leading bytes.
  size_t len = strlen(dst);
  if (len == size - 1 && (dst[len - 1] & 0x80)) {
    size_t start = len - 1;
    while (start > 0 && (dst[start] & 0xC0) == 0x80) start--;
    uint8_t lead = dst[start];
    size_t need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
    if (len - start < need) dst[start] = '\0';
  }
}

static int32_t int_of(DictionaryIterator *iter, uint32_t key, int32_t fallback) {
  Tuple *t = dict_find(iter, key);
  return t ? t->value->int32 : fallback;
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  int cmd = int_of(iter, MESSAGE_KEY_CMD, 0);
  if (cmd == CMD_TOAST) {
    Tuple *t = dict_find(iter, MESSAGE_KEY_STATUS);
    if (t) list_toast(t->value->cstring);
    return;
  }
  if (cmd != CMD_DEVICE) return;

  int total = int_of(iter, MESSAGE_KEY_TOTAL, 0);
  if (total <= 0) {
    g_count = 0;
    s_total = 0;
    copy_string(g_message, sizeof(g_message), iter, MESSAGE_KEY_STATUS);
    list_reload();
    detail_reload();
    return;
  }
  int index = int_of(iter, MESSAGE_KEY_INDEX, -1);
  if (total > MAX_DEVICES) total = MAX_DEVICES;
  if (index < 0 || index >= total) return;

  Device *d = &g_devices[index];
  d->key = int_of(iter, MESSAGE_KEY_KEY, 0);
  copy_string(d->name, sizeof(d->name), iter, MESSAGE_KEY_NAME);
  copy_string(d->room, sizeof(d->room), iter, MESSAGE_KEY_ROOM);
  copy_string(d->status, sizeof(d->status), iter, MESSAGE_KEY_STATUS);
  d->kind = int_of(iter, MESSAGE_KEY_KIND, KIND_GENERIC);
  d->flags = int_of(iter, MESSAGE_KEY_FLAGS, 0);
  d->bright = int_of(iter, MESSAGE_KEY_BRIGHT, 0);
  d->ctemp = int_of(iter, MESSAGE_KEY_CTEMP, 0);
  d->volume = int_of(iter, MESSAGE_KEY_VOLUME, 0);
  d->setpt = int_of(iter, MESSAGE_KEY_SETPT, 0);
  d->mode = int_of(iter, MESSAGE_KEY_MODE, MODE_UNKNOWN);

  // The phone resends every row, in order, whenever the total changes; until then only the rows
  // received so far are shown.
  if (total != s_total) {
    s_total = total;
    g_count = index + 1;
  } else if (index >= g_count) {
    g_count = index + 1;
  }
  list_reload();
  detail_reload();
}

int device_index_of_key(int key) {
  for (int i = 0; i < g_count; i++) {
    if (g_devices[i].key == key) return i;
  }
  return -1;
}

static AppTimer *s_hello_timer;
static int s_hello_tries;

static void send_hello(void *data);

static void hello_in(uint32_t ms) {
  if (s_hello_timer) app_timer_cancel(s_hello_timer);
  s_hello_timer = app_timer_register(ms, send_hello, NULL);
}

// A hello that didn't go out is tried again after 1, 2, 4, 8 and 16 s.
static void hello_failed(void) {
  if (s_hello_tries < 5) hello_in(1000u << s_hello_tries++);
}

static void send_hello(void *data) {
  s_hello_timer = NULL;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    hello_failed();
    return;
  }
  dict_write_int32(out, MESSAGE_KEY_CMD, CMD_HELLO);
  if (app_message_outbox_send() != APP_MSG_OK) hello_failed();
}

// The phone never saw the action, so the screen's optimistic change must go: a hello makes it
// resend every row.
static void resync_soon(void) {
  list_toast("Couldn't reach phone");
  s_hello_tries = 0;
  hello_in(1000);
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  Tuple *cmd = dict_find(iter, MESSAGE_KEY_CMD);
  if (!cmd) return;
  if (cmd->value->int32 == CMD_ACT) resync_soon();
  else if (cmd->value->int32 == CMD_HELLO) hello_failed();
}

void send_action(int key, int op, int value) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    resync_soon();
    return;
  }
  dict_write_int32(out, MESSAGE_KEY_CMD, CMD_ACT);
  dict_write_int32(out, MESSAGE_KEY_KEY, key);
  dict_write_int32(out, MESSAGE_KEY_OP, op);
  dict_write_int32(out, MESSAGE_KEY_VALUE, value);
  if (app_message_outbox_send() != APP_MSG_OK) resync_soon();
}

int main(void) {
  app_message_register_inbox_received(inbox_received);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(512, 64);
#ifdef PBL_TOUCH
  // Third-party apps get no touch until they opt in: lists then scroll by drag, a tap selects a row
  // (tap it again to open it), swiping right goes back.
  app_touch_navigation_enable(true);
#endif
  list_window_push();
  hello_in(300);
  app_event_loop();
}
