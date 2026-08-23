#include <pebble.h>
#include <pebble-assist.h>
#include "generated/keys.h"
#include "win-leagues.h"
#include "win-games.h"
#include "win-card.h"
#include "card.h"
#include "espn.h"
#include "config.h"
#include "ui/prompt.h"
#include "analytics.h"

static void click_config_provider(void *context);
static uint16_t menu_get_num_sections_callback(struct MenuLayer *menu_layer, void *context);
static uint16_t menu_get_num_rows_callback(struct MenuLayer *menu_layer, uint16_t section_index,
                                           void *context);
static int16_t menu_get_cell_height_callback(struct MenuLayer *menu_layer, MenuIndex *cell_index,
                                             void *context);
static void menu_draw_row_callback(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index,
                                   void *context);
static void window_load(Window *window);
static void window_unload(Window *window);

static Window *s_window = NULL;
static MenuLayer *s_menu_layer = NULL;

void win_leagues_init(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
}

void win_leagues_push(void) {
  window_stack_push(s_window, true);
}

void win_leagues_deinit(void) {
  window_destroy_safe(s_window);
}

void win_leagues_mark_dirty(void) {
  if (!window_is_loaded(s_window)) {
    return;
  }
  menu_layer_reload_data(s_menu_layer);
  layer_mark_dirty(menu_layer_get_layer(s_menu_layer));
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - //

static void down_up_click_handler(ClickRecognizerRef recognizer, void *context) {
  const bool is_up = (click_recognizer_get_button_id(recognizer) == BUTTON_ID_UP);
  if (!prompt_is_showing()) {
    menu_layer_set_selected_next(s_menu_layer, is_up, MenuRowAlignCenter, true);
  }
  analytics_increment_screen_clicks(is_up);
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (prompt_is_showing()) {
    prompt_hide();
    persist_write_bool(KEY_PERSIST_CONFIG_STATUS, true);
  } else {
    const MenuIndex cell_index = menu_layer_get_selected_index(s_menu_layer);
    espn_set_selected_league(cell_index.section);
    win_games_push();
  }
}

static void back_click_handler(ClickRecognizerRef recognizer, void *context) {
  analytics_set_screen(SCREEN_NONE, BUTTON_ID_BACK);
  window_stack_pop_all(true);
}

static void click_config_provider(void *context) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 200, down_up_click_handler);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 200, down_up_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_single_click_subscribe(BUTTON_ID_BACK, back_click_handler);
}

static void set_compositing_mode(GContext *ctx) {
  graphics_context_set_compositing_mode(ctx, PBL_IF_COLOR_ELSE(GCompOpSet, GCompOpAssign));
}

static void draw_leagues_row(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index) {
  const uint16_t section = cell_index->section;
  const uint16_t row = cell_index->row;
  const GRect bounds = layer_get_bounds(cell_layer);
  if (row != 0) {
    return;
  }
  set_compositing_mode(ctx);
  graphics_context_set_fill_color(ctx, menu_cell_layer_is_highlighted(cell_layer) ?
                                       PBL_IF_BW_ELSE(GColorBlack, ESPN_DEFAULT_COLOR) :
                                       PBL_IF_BW_ELSE(GColorWhite, GColorBlack));
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);
#if defined(PBL_BW)
  if (menu_cell_layer_is_highlighted(cell_layer) == true) {
    graphics_context_set_compositing_mode(ctx, GCompOpAssignInverted);
  }
  graphics_context_set_text_color(ctx, menu_cell_layer_is_highlighted(cell_layer) ? GColorWhite :
                                                                                    GColorBlack);
#else
  graphics_context_set_text_color(ctx, PBL_IF_BW_ELSE(GColorBlack, GColorWhite));
#endif
  graphics_draw_text(ctx, espn_get_league_title(section),
                     fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     PBL_IF_RECT_ELSE(GRect(34, 5, 100, 20), GRect(40, 5, 90, 20)),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_draw_text(ctx, espn_get_league_subtitle(section),
                     fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     PBL_IF_RECT_ELSE(GRect(34, 23, 90, 20), GRect(40, 23, 90, 20)),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_draw_bitmap_in_rect(ctx, espn_get_league_icon(section),
                               PBL_IF_RECT_ELSE(GRect(6, 9, 25, 25),
                                                GRect(125, 11, 25, 25)));
}

static void menu_draw_row_callback(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index,
                                   void *context) {
  draw_leagues_row(ctx, cell_layer, cell_index);
}

static uint16_t menu_get_num_sections_callback(struct MenuLayer *menu_layer, void *context) {
  return espn_get_num_leagues();
}

static uint16_t menu_get_num_rows_callback(struct MenuLayer *menu_layer, uint16_t section_index,
                                           void *context) {
  return 1;
}

static int16_t menu_get_cell_height_callback(struct MenuLayer *menu_layer, MenuIndex *cell_index,
                                             void *context) {
  return 50;
}

static void window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  window_set_background_color(window, GColorBlack);

#ifdef PBL_RECT
  const GRect bounds = layer_get_bounds(window_layer);
  s_menu_layer = menu_layer_create(bounds);
#elif PBL_ROUND
  s_menu_layer = menu_layer_create(GRect(0, 15, 180, 150));
  menu_layer_set_center_focused(s_menu_layer, true);
#endif
  menu_layer_set_normal_colors(s_menu_layer, GColorBlack, GColorWhite);
  menu_layer_set_highlight_colors(s_menu_layer, GColorBlack, GColorWhite);
  menu_layer_pad_bottom_enable(s_menu_layer, false);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks) {
    .get_num_sections = menu_get_num_sections_callback,
    .get_num_rows = menu_get_num_rows_callback,
    .get_cell_height = menu_get_cell_height_callback,
    .draw_row = menu_draw_row_callback,
  });
  layer_add_child(window_layer, menu_layer_get_layer(s_menu_layer));

#if !defined(IN_APP_CONFIG)
  // if (!persist_read_bool(KEY_PERSIST_CONFIG_STATUS)) {
  //   static const char *prompt = "Set up in the Pebble app";
  //   prompt_show(window_layer, prompt, KEY_TYPE_CHECKCONFIG);
  // }
#endif
}

static void window_unload(Window *window) {
  menu_layer_destroy_safe(s_menu_layer);
}
