#include <pebble.h>
#include "prompt.h"
#include "generated/keys.h"

static TextLayer *s_body_layer, *s_title_layer;
static BitmapLayer *s_icon_layer;
static GBitmap *s_icon_bitmap;

static char s_message_buffer[32];
static bool s_prompt_showing;

bool prompt_is_showing() {
  return s_prompt_showing;
}

void prompt_show(Layer *window_layer, const char *error_message, uint8_t key) {
  s_prompt_showing = true;
  static const int buf_size = sizeof(s_message_buffer);
  strncpy(s_message_buffer, error_message, buf_size);
  s_message_buffer[buf_size - 1] = '\0';
  const GRect bounds = layer_get_bounds(window_layer);
  s_title_layer = text_layer_create(GRect(0, 0, bounds.size.w, bounds.size.h));
  text_layer_set_text(s_title_layer, "Sports");
  text_layer_set_text_color(s_title_layer, GColorBlack);
  text_layer_set_background_color(s_title_layer, GColorWhite);
  text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter);
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  layer_add_child(window_layer, text_layer_get_layer(s_title_layer));

  switch (key) {
    case KEY_TYPE_NOCONNECTION:
      s_icon_bitmap = gbitmap_create_with_resource(RESOURCE_ID_NO_INTERNET_ICON);
      break;
    case KEY_TYPE_CHECKCONFIG:
      s_icon_bitmap = gbitmap_create_with_resource(RESOURCE_ID_ICON_CONFIG_REQUIRED);
      break;
  }

  GRect bitmap_bounds = gbitmap_get_bounds(s_icon_bitmap);

  uint16_t icon_y_offset = 10;
  s_icon_layer = bitmap_layer_create(GRect(
    (bounds.size.w - bitmap_bounds.size.w) / 2,
    ((bounds.size.h - bitmap_bounds.size.h) / 2) - icon_y_offset,
    bitmap_bounds.size.w, bitmap_bounds.size.h));

  bitmap_layer_set_bitmap(s_icon_layer, s_icon_bitmap);
  bitmap_layer_set_compositing_mode(s_icon_layer, GCompOpAssign);
  layer_add_child(window_layer, bitmap_layer_get_layer(s_icon_layer));

  s_body_layer = text_layer_create(GRect(20, 120, bounds.size.w - 40, 60));
  text_layer_set_text(s_body_layer, s_message_buffer);
  text_layer_set_text_color(s_body_layer, GColorBlack);
  text_layer_set_background_color(s_body_layer, GColorWhite);
  text_layer_set_font(s_body_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_body_layer, GTextAlignmentCenter);
  layer_add_child(window_layer, text_layer_get_layer(s_body_layer));
  s_prompt_showing = true;
}

void prompt_hide() {
  s_prompt_showing = false;
  layer_set_hidden(bitmap_layer_get_layer(s_icon_layer), true);
  layer_set_hidden(text_layer_get_layer(s_title_layer), true);
  layer_set_hidden(text_layer_get_layer(s_body_layer), true);
  bitmap_layer_destroy(s_icon_layer);
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_body_layer);
  gbitmap_destroy(s_icon_bitmap);
}
