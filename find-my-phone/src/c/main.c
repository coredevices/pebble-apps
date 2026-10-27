#include <pebble.h>

static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_hint_layer;

static void prv_show(const char *title, const char *hint) {
  text_layer_set_text(s_title_layer, title);
  text_layer_set_text(s_hint_layer, hint);
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *error = dict_find(iter, MESSAGE_KEY_ERROR);
  if (error) {
    prv_show("Can't ring\nyour phone", error->value->cstring);
    return;
  }
  Tuple *ringing = dict_find(iter, MESSAGE_KEY_RINGING);
  if (!ringing) {
    return;
  }
  if (ringing->value->int32) {
    prv_show("Ringing\nyour phone", "Back to stop");
  } else {
    prv_show("Stopped\nringing", "Select to ring again");
  }
}

static void prv_select_click(ClickRecognizerRef recognizer, void *context) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) {
    return;
  }
  dict_write_uint8(out, MESSAGE_KEY_RING, 1);
  app_message_outbox_send();
}

static void prv_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_title_layer = text_layer_create(GRect(8, bounds.size.h / 4, bounds.size.w - 16, 64));
  text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter);
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  layer_add_child(root, text_layer_get_layer(s_title_layer));

  s_hint_layer = text_layer_create(GRect(8, bounds.size.h / 4 + 68, bounds.size.w - 16, 60));
  text_layer_set_text_alignment(s_hint_layer, GTextAlignmentCenter);
  text_layer_set_font(s_hint_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_overflow_mode(s_hint_layer, GTextOverflowModeWordWrap);
  layer_add_child(root, text_layer_get_layer(s_hint_layer));

  prv_show("Find My\nPhone", "Connecting…");
}

static void prv_window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_hint_layer);
}

static void prv_init(void) {
  app_message_register_inbox_received(prv_inbox_received);
  app_message_open(128, 32);
  s_window = window_create();
  window_set_click_config_provider(s_window, prv_click_config);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);
}

static void prv_deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
