#include <pebble.h>
#include <libs/pebble-assist.h>
#include <string.h>
#include "generated/keys.h"
#include "layers/progress_layer.h"
#include "win-pins.h"
#include "card.h"
#include "sports.h"
#include "config.h"
#include "analytics.h"

static void window_load(Window *window);
static void window_unload(Window *window);

static Window *s_window = NULL;
static Layer *s_main_layer = NULL;
static ProgressLayer *s_progress_layer = NULL;
static AppTimer *s_timeout = NULL;

static void back_click_handler(ClickRecognizerRef recognizer, void *context) {
  window_stack_remove(s_window, true);
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_BACK, back_click_handler);
}

static void window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  
  GRect bounds = layer_get_bounds(window_layer);

  s_main_layer = layer_create(bounds);
  layer_add_child(window_layer, s_main_layer);

#if defined(PBL_PLATFORM_EMERY)
  const GRect progress_rect = GRect(44, 109, 112, 8);
#elif defined(PBL_PLATFORM_GABBRO)
  const GRect progress_rect = GRect(bounds.size.w / 4, bounds.size.h / 2, bounds.size.w / 2, 8);
#elif defined(PBL_ROUND)
  const GRect progress_rect = GRect(bounds.size.w / 4, bounds.size.h / 2, bounds.size.w / 2, 6);
#else
  const GRect progress_rect = GRect(32, 80, 80, 6);
#endif

  s_progress_layer = progress_layer_create(progress_rect);
  progress_layer_set_progress(s_progress_layer, 20);
  progress_layer_set_corner_radius(s_progress_layer, 2);
  progress_layer_set_foreground_color(s_progress_layer, COLOR_FALLBACK(SPORTS_DEFAULT_COLOR,
                                                                       GColorWhite));
  progress_layer_set_background_color(s_progress_layer, COLOR_FALLBACK(GColorLightGray,
                                                                       GColorBlack));
  layer_add_child(window_layer, s_progress_layer);
}

static void window_unload(Window *window) {
  app_timer_cancel_safe(s_timeout);
  progress_layer_destroy(s_progress_layer);
  layer_destroy_safe(s_main_layer);
}

static void close_on_timeout(void *context) {
  s_timeout = NULL;
  win_pins_pop();
}

void win_pins_push(void) {
  window_stack_push(s_window, true);
  s_timeout = app_timer_register(30000, close_on_timeout, NULL);
}

void win_pins_pop(void) {
  window_stack_remove(s_window, true);
}

void win_pins_init(void) { 
  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
}

void win_pins_deinit(void) {
  window_destroy_safe(s_window);
}

void win_pins_mark_dirty(void) {
  if (!window_is_loaded(s_window)) return;
  layer_mark_dirty(window_get_root_layer(s_window));
}

bool win_pins_is_loaded(void) {
  return window_is_loaded(s_window);
}

void win_pins_increment_progress(int16_t progress) {
  progress_layer_increment_progress(s_progress_layer, progress);
}

void win_pins_set_progress(int16_t progress_percent) {
  progress_layer_set_progress(s_progress_layer, progress_percent);
}