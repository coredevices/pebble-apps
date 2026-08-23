#include <pebble.h>
#include <libs/pebble-assist.h>
// #include "generated/appinfo.h"
#include "generated/keys.h"
#include "analytics.h"

static uint16_t s_screen_up_clicks = 0;
static uint16_t s_screen_down_clicks = 0;

static Screen s_current_screen = SCREEN_NONE;
static Screen s_previous_screen = SCREEN_NONE;

void analytics_send_screen_analytics(uint8_t button_id) {
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  dict_write_uint8(iter, MESSAGE_KEY_method, KEY_METHOD_SCREEN_CHANGE);
  dict_write_uint8(iter, MESSAGE_KEY_currentScreen, s_current_screen);
  dict_write_uint8(iter, MESSAGE_KEY_previousScreen, s_previous_screen);
  dict_write_uint8(iter, MESSAGE_KEY_eventButton, button_id);
  dict_write_uint16(iter, MESSAGE_KEY_screenUpClicks, s_screen_up_clicks);
  dict_write_uint16(iter, MESSAGE_KEY_screenDownClicks, s_screen_down_clicks);
  dict_write_end(iter);
  app_message_outbox_send();
  s_screen_up_clicks = 0;
  s_screen_down_clicks = 0;
}

void analytics_send_buzz_analytics(bool buzz_on) {
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  dict_write_uint8(iter, MESSAGE_KEY_method, KEY_METHOD_BUZZ_CHANGE);
  dict_write_uint8(iter, MESSAGE_KEY_buzzChange, buzz_on);
  dict_write_end(iter);
  app_message_outbox_send();
}

void analytics_set_screen(Screen screen_id, uint8_t button_id) {
  s_previous_screen = s_current_screen;
  s_current_screen = screen_id;
  analytics_send_screen_analytics(button_id);
}

void analytics_increment_screen_clicks(bool up) {
  if (up) {
    s_screen_up_clicks++;
  } else {
    s_screen_down_clicks++;
  }
}

Screen analytics_get_previous_screen() {
  return s_previous_screen;
}

Screen analytics_get_current_screen() {
  return s_current_screen;
}
