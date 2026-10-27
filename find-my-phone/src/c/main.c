#include <pebble.h>

#define TIMEOUT_MS 15000
#define RING_SECONDS 60

static Window *s_window;
static TextLayer *s_text_layer;
static AppTimer *s_timeout;

static void prv_show(const char *text) {
  text_layer_set_text(s_text_layer, text);
}

#if PBL_API_EXISTS(app_glance_reload)
static void prv_ringing_glance(AppGlanceReloadSession *session, size_t limit, void *context) {
  if (limit < 1) {
    return;
  }
  const AppGlanceSlice slice = {
    .layout = {
      .subtitle_template_string = "Ringing · open to stop",
    },
    .expiration_time = time(NULL) + RING_SECONDS,
  };
  app_glance_add_slice(session, slice);
}

static void prv_clear_glance(AppGlanceReloadSession *session, size_t limit, void *context) {
}
#endif

static void prv_finish(bool ok, bool ringing, const char *message) {
  if (s_timeout) {
    app_timer_cancel(s_timeout);
    s_timeout = NULL;
  }
  if (!ok) {
    vibes_double_pulse();
    prv_show(message);
    return;
  }
  vibes_short_pulse();
#if PBL_API_EXISTS(app_glance_reload)
  app_glance_reload(ringing ? prv_ringing_glance : prv_clear_glance, NULL);
#endif
  exit_reason_set(APP_EXIT_ACTION_PERFORMED_SUCCESSFULLY);
  window_stack_remove(s_window, false);
}

static void prv_timed_out(void *context) {
  s_timeout = NULL;
  prv_finish(false, false, "Can't reach\nyour phone");
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *result = dict_find(iter, MESSAGE_KEY_RESULT);
  if (!result) {
    return;
  }
  Tuple *ringing = dict_find(iter, MESSAGE_KEY_RINGING);
  Tuple *message = dict_find(iter, MESSAGE_KEY_MESSAGE);
  prv_finish(result->value->int32 == 1, ringing && ringing->value->int32 == 1,
             message ? message->value->cstring : "Couldn't ring\nyour phone");
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_text_layer = text_layer_create(GRect(8, bounds.size.h / 4, bounds.size.w - 16, bounds.size.h / 2));
  text_layer_set_text_alignment(s_text_layer, GTextAlignmentCenter);
  text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_overflow_mode(s_text_layer, GTextOverflowModeWordWrap);
  layer_add_child(root, text_layer_get_layer(s_text_layer));
  prv_show("Find My\nPhone");
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_text_layer);
}

static void prv_init(void) {
  app_message_register_inbox_received(prv_inbox_received);
  app_message_open(128, 64);
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, false);
  s_timeout = app_timer_register(TIMEOUT_MS, prv_timed_out, NULL);
}

static void prv_deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
