#include <pebble.h>
#include <pebble-assist.h>
#include "generated/keys.h"
#include "win-games.h"
#include "win-card.h"
#include "card.h"
#include "espn.h"
#include "config.h"
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
static TextLayer *s_header_text = NULL;

void win_games_init(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
}

void win_games_push(void) {
  window_stack_push(s_window, true);
}

void win_games_deinit(void) {
  window_destroy_safe(s_window);
}

void win_games_mark_dirty(void) {
  if (!window_is_loaded(s_window)) {
    return;
  }
  menu_layer_reload_data(s_menu_layer);
  layer_mark_dirty(menu_layer_get_layer(s_menu_layer));
}

void win_games_set_selected_card(uint16_t row) {
  if (!window_is_loaded(s_window)) {
    return;
  }
  menu_layer_set_selected_index(s_menu_layer, (MenuIndex) { .section = espn_get_selected_league(),
                                                            .row = row },
                                MenuRowAlignCenter, false);
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - //

static char* get_title_status() {
  return ((espn_get_selected_league() == 0 && !espn_get_has_teams()) ?
      (IN_APP_CONFIG ? "FOLLOW TEAMS\nFROM GAME\nCARDS"
                     : "SET UP\nFAVORITES IN\nPEBBLE APP") :
      "NO GAMES\nTODAY");
}

static void down_up_click_handler(ClickRecognizerRef recognizer, void *context) {
  const bool is_up = (click_recognizer_get_button_id(recognizer) == BUTTON_ID_UP);
  if (espn_get_num_cards() != 0) {
    menu_layer_set_selected_next(s_menu_layer, is_up, MenuRowAlignCenter, true);
    return;
  }
  analytics_increment_screen_clicks(is_up);
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  const MenuIndex cell_index = menu_layer_get_selected_index(s_menu_layer);
  if (espn_get_num_cards() > 0) {
    espn_set_selected_card(cell_index.row);
    analytics_set_screen(SCREEN_GAMECARD, BUTTON_ID_SELECT);
    win_card_push();
  }
  menu_layer_reload_data(s_menu_layer);
}

static void back_click_handler(ClickRecognizerRef recognizer, void *context) {
  window_stack_remove(s_window, true);
  analytics_set_screen(SCREEN_LEAGUES, BUTTON_ID_BACK);
  menu_layer_reload_data(s_menu_layer);
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

#ifdef PBL_RECT
static void draw_games_row_rect(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index) {
  const uint16_t row = cell_index->row;
  const GRect bounds = layer_get_bounds(cell_layer);
  const GFont font_gothic_24_bold = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  set_compositing_mode(ctx);
  if (espn_get_num_cards() == 0) {
    char *title = get_title_status();
#ifdef PBL_BW
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
#endif
    graphics_context_set_text_color(ctx, COLOR_FALLBACK(GColorLightGray, GColorBlack));
    const uint16_t title_height =
        graphics_text_layout_get_content_size(title, font_gothic_24_bold, bounds,
                                              GTextOverflowModeTrailingEllipsis,
                                              GTextAlignmentCenter).h;
    const uint16_t y_offset = (bounds.size.h - title_height) / 2 + PBL_IF_COLOR_ELSE(10, -25);

    graphics_draw_text(ctx, title, font_gothic_24_bold, GRect(0, y_offset, bounds.size.w,
                                                              bounds.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  } else {
    graphics_context_set_fill_color(ctx, menu_cell_layer_is_highlighted(cell_layer) ?
                                         COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack) :
                                         GColorWhite);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    graphics_context_set_text_color(ctx, menu_cell_layer_is_highlighted(cell_layer) ? GColorWhite :
                                                                                      GColorBlack);

    const CardData *data = espn_get_card_data(row);
    const bool is_pregame = data->gameState == KEY_GAMESTATE_PREGAME;

    graphics_draw_text(ctx, data->nameAway, font_gothic_24_bold, GRect(9, -4, 126, 26),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    graphics_draw_text(ctx, data->nameHome, font_gothic_24_bold, GRect(9, 15, 126, 26),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

    graphics_draw_text(ctx, is_pregame ? data->recordAway : data->scoreAway,
                       font_gothic_24_bold, GRect(9, -4, 126, 26),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
    graphics_draw_text(ctx, is_pregame ? data->recordHome : data->scoreHome,
                       font_gothic_24_bold, GRect(9, 15, 126, 26),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);

    graphics_draw_text(ctx, data->subtitle, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                      GRect(9, 39, 126, 20), GTextOverflowModeTrailingEllipsis,
                      GTextAlignmentRight, NULL);
    graphics_draw_text(ctx, data->league, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                       GRect(9, 39, 126, 20), GTextOverflowModeTrailingEllipsis,
                       GTextAlignmentLeft, NULL);
  }
}

#else
static bool menu_layer_cell_is_selected(MenuIndex *cell_index) {
  const MenuIndex selected = menu_layer_get_selected_index(s_menu_layer);
  return (selected.section == cell_index->section && selected.row == cell_index->row);
}

static void draw_games_row_round(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index) {
  const uint16_t row = cell_index->row;
  const GRect bounds = layer_get_bounds(cell_layer);
  const GFont font_gothic_24_bold = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  set_compositing_mode(ctx);
  if (espn_get_num_cards() == 0) {
    char *title = get_title_status();
    graphics_context_set_text_color(ctx, COLOR_FALLBACK(GColorLightGray, GColorBlack));
    const uint16_t title_height =
        graphics_text_layout_get_content_size(title, font_gothic_24_bold, bounds,
                                              GTextOverflowModeTrailingEllipsis,
                                              GTextAlignmentCenter).h;
    const uint16_t y_offset = (bounds.size.h / 2) - (title_height / 2);

    graphics_draw_text(ctx, title, font_gothic_24_bold, GRect(0, y_offset, bounds.size.w,
                                                              bounds.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  } else {
    graphics_context_set_fill_color(ctx, menu_cell_layer_is_highlighted(cell_layer) ?
                                         COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack) :
                                         GColorWhite);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    graphics_context_set_text_color(ctx, menu_cell_layer_is_highlighted(cell_layer) ? GColorWhite :
                                                                                      GColorBlack);

    const CardData *data = espn_get_card_data(row);
    const int16_t text_buffer_length = 64;
    char text[text_buffer_length];
    graphics_draw_text(ctx, "@", font_gothic_24_bold, GRect(0, 0, 180, 26),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

    if (menu_layer_cell_is_selected(cell_index)) {
      bool is_pregame = data->gameState == KEY_GAMESTATE_PREGAME;
      graphics_draw_text(ctx, data->nameAway, font_gothic_24_bold, GRect(0, 0, 65, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
      graphics_draw_text(ctx, data->nameHome, font_gothic_24_bold, GRect(115, 0, 65, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

      graphics_draw_text(ctx, is_pregame ? data->recordAway : data->scoreAway,
                         font_gothic_24_bold, GRect(0, 20, 65, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
      graphics_draw_text(ctx, is_pregame ? data->recordHome : data->scoreHome,
                         font_gothic_24_bold, GRect(115, 20, 65, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

      snprintf(text, sizeof(text), "%s - %s", data->league, data->subtitle);
      graphics_draw_text(ctx, text, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                         GRect(0, 45, 180, 20), GTextOverflowModeTrailingEllipsis,
                         GTextAlignmentCenter, NULL);
    } else {
      graphics_draw_text(ctx, data->nameAway, font_gothic_24_bold, GRect(0, 0, 75, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
      graphics_draw_text(ctx, data->nameHome, font_gothic_24_bold, GRect(105, 0, 75, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    }
  }
}
#endif

static void menu_draw_row_callback(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index,
                                   void *context) {
  PBL_IF_RECT_ELSE(draw_games_row_rect(ctx, cell_layer, cell_index),
                   draw_games_row_round(ctx, cell_layer, cell_index));
  text_layer_set_text(s_header_text, espn_get_league_title(espn_get_selected_league()));
}

static uint16_t menu_get_num_sections_callback(struct MenuLayer *menu_layer, void *context) {
  return 1;
}

static uint16_t menu_get_num_rows_callback(struct MenuLayer *menu_layer, uint16_t section_index,
                                           void *context) {
  const uint16_t cards = espn_get_num_cards();
  return (cards == 0 ? 1 : cards);
}

static int16_t menu_get_cell_height_callback(struct MenuLayer *menu_layer, MenuIndex *cell_index,
                                             void *context) {
  if (espn_get_num_cards() > 0) {
    return PBL_IF_RECT_ELSE(59, menu_layer_cell_is_selected(cell_index) ? 70 : 35);
  } else {
    return PBL_IF_COLOR_ELSE(115, 180);
  }
}

static void window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  window_set_background_color(window, GColorWhite);
#ifdef PBL_RECT
  const GRect bounds = layer_get_bounds(window_layer);
  s_menu_layer = menu_layer_create(GRect(bounds.origin.x, 15, bounds.size.w, bounds.size.h));
#elif PBL_ROUND
  s_menu_layer = menu_layer_create(GRect(0, 15, 180, 150));
  menu_layer_set_center_focused(s_menu_layer, true);
#endif
  menu_layer_set_normal_colors(s_menu_layer, GColorWhite, GColorBlack);
  menu_layer_set_highlight_colors(s_menu_layer, GColorWhite, GColorBlack);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks) {
    .get_num_sections = menu_get_num_sections_callback,
    .get_num_rows = menu_get_num_rows_callback,
    .get_cell_height = menu_get_cell_height_callback,
    .draw_row = menu_draw_row_callback,
  });
  layer_add_child(window_layer, menu_layer_get_layer(s_menu_layer));

  s_header_text = text_layer_create(PBL_IF_RECT_ELSE(GRect(0, -2, bounds.size.w, 15),
                                                     GRect(0, 4, 180, 20)));
  text_layer_set_background_color(s_header_text, GColorClear);
  text_layer_set_font(s_header_text, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_header_text, GTextAlignmentCenter);
  layer_add_child(window_layer, text_layer_get_layer(s_header_text));
}

static void window_unload(Window *window) {
  text_layer_destroy(s_header_text);
  menu_layer_destroy_safe(s_menu_layer);
}
