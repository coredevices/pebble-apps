#include <pebble.h>
#include <pebble-assist.h>
#include "layers/progress_layer.h"
#include "win-splash.h"
#include "config.h"
#include "ui/prompt.h"
#include "generated/keys.h"

static void window_load(Window *window);
static void window_unload(Window *window);

static Window *s_window = NULL;
static ProgressLayer *s_progress_layer = NULL;
static bool s_no_internet = false;

void win_splash_init(void) {
  s_window = window_create();
  window_set_background_color(s_window, COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack));
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
}

void win_splash_push(void) {
  window_stack_push(s_window, true);
}

void win_splash_pop(void) {
  window_stack_remove(s_window, true);
}

void win_splash_deinit(void) {
  if (!s_window) {
    return;
  }
  window_destroy_safe(s_window);
  s_window = NULL;
  s_progress_layer = NULL;
}

void win_splash_increment_progress(int16_t progress) {
  if (!s_progress_layer) {
    return;
  }
  progress_layer_increment_progress(s_progress_layer, progress);
}

void win_splash_set_progress(int16_t progress_percent) {
  if (!s_progress_layer) {
    return;
  }
  progress_layer_set_progress(s_progress_layer, progress_percent);
}

void win_splash_no_internet_prompt() {
  static const char *prompt = "No Internet Connection";
  prompt_show(window_get_root_layer(s_window), prompt, KEY_TYPE_NOCONNECTION);
  s_no_internet = true;
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - //

static void window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_progress_layer = progress_layer_create(PBL_IF_RECT_ELSE(GRect(32, bounds.size.h / 2, 80, 6),
                                                            GRect(bounds.size.w / 4,
                                                                  bounds.size.h / 2,
                                                                  bounds.size.w / 2, 6)));
  progress_layer_set_progress(s_progress_layer, 10);
  progress_layer_set_corner_radius(s_progress_layer, 2);
  progress_layer_set_foreground_color(s_progress_layer, GColorWhite);
  progress_layer_set_background_color(s_progress_layer, COLOR_FALLBACK(GColorDarkGray,
                                                                       GColorBlack));
  layer_add_child(window_layer, s_progress_layer);
}

static void window_unload(Window *window) {
  if (s_no_internet) {
    prompt_hide();
  }
  progress_layer_destroy(s_progress_layer);
}
