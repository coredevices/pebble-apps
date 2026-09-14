#include <pebble.h>
#include <libs/pebble-assist.h>
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
#ifdef PBL_PLATFORM_EMERY
  const GFont font_gothic_28_bold = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
#endif
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
#ifdef PBL_PLATFORM_EMERY
    const uint16_t y_offset = (bounds.size.h - title_height) / 2 - 7;
    graphics_draw_text(ctx, title, font_gothic_28_bold, GRect(0, y_offset, bounds.size.w,
                                                              bounds.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
#else
    const uint16_t y_offset = (bounds.size.h - title_height) / 2 + PBL_IF_COLOR_ELSE(10, -25);
    graphics_draw_text(ctx, title, font_gothic_24_bold, GRect(0, y_offset, bounds.size.w,
                                                              bounds.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
#endif

  } else {
    graphics_context_set_fill_color(ctx, menu_cell_layer_is_highlighted(cell_layer) ?
                                         COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack) :
                                         GColorWhite);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    graphics_context_set_text_color(ctx, menu_cell_layer_is_highlighted(cell_layer) ? GColorWhite :
                                                                                      GColorBlack);

    const CardData *data = espn_get_card_data(row);
    const bool is_pregame = data->gameState == KEY_GAMESTATE_PREGAME;

#ifdef PBL_PLATFORM_EMERY
    // The y values are box origins, not glyph positions: GOTHIC_28_BOLD lays
    // its ink 10px below the box top and runs 18px, so -4 puts the first row's
    // caps 6px into the cell and 19 leaves a 5px gap under them — the same
    // 6/5/5/6 rhythm the 144px layout below gets from -4/15/39 in a 59px cell.
    // The 30 is ink (28) + 2 slack; at 26 the box cut the last pixel row off
    // every name and score.
    graphics_draw_text(ctx, data->nameAway, font_gothic_28_bold, GRect(9, -2, 182, 30),
                    GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    graphics_draw_text(ctx, data->nameHome, font_gothic_28_bold, GRect(9, 22, 182, 30),
                    GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

    graphics_draw_text(ctx, is_pregame ? data->recordAway : data->scoreAway,
                    font_gothic_28_bold, GRect(9, -2, 182, 30),
                    GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
    graphics_draw_text(ctx, is_pregame ? data->recordHome : data->scoreHome,
                    font_gothic_28_bold, GRect(9, 22, 182, 30),
                    GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);

    graphics_draw_text(ctx, data->subtitle, fonts_get_system_font(FONT_KEY_GOTHIC_18),
                    GRect(9, bounds.size.h - 26, 182, 20), GTextOverflowModeTrailingEllipsis,
                    GTextAlignmentRight, NULL);
    graphics_draw_text(ctx, data->league, fonts_get_system_font(FONT_KEY_GOTHIC_18),
                    GRect(9, bounds.size.h - 26, 182, 20), GTextOverflowModeTrailingEllipsis,
                    GTextAlignmentLeft, NULL);
#else
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
#endif
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
  
#ifdef PBL_PLATFORM_GABBRO
  const GFont font_gothic_28_bold = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
#endif
  const GFont font_gothic_24_bold = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
  
  set_compositing_mode(ctx);
  if (espn_get_num_cards() == 0) {
    char *title = get_title_status();
    graphics_context_set_text_color(ctx, COLOR_FALLBACK(GColorLightGray, GColorBlack));
    
#ifdef PBL_PLATFORM_GABBRO
    const uint16_t title_height =
        graphics_text_layout_get_content_size(title, font_gothic_28_bold, bounds,
                                            GTextOverflowModeTrailingEllipsis,
                                            GTextAlignmentCenter).h;
    const uint16_t y_offset = (bounds.size.h / 2) - (title_height / 2);

    graphics_draw_text(ctx, title, font_gothic_28_bold, GRect(0, y_offset, bounds.size.w,
                                                              bounds.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
#else
    const uint16_t title_height =
        graphics_text_layout_get_content_size(title, font_gothic_24_bold, bounds,
                                            GTextOverflowModeTrailingEllipsis,
                                            GTextAlignmentCenter).h;
    const uint16_t y_offset = (bounds.size.h / 2) - (title_height / 2);

    graphics_draw_text(ctx, title, font_gothic_24_bold, GRect(0, y_offset, bounds.size.w,
                                                              bounds.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    
#endif
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

#ifdef PBL_PLATFORM_GABBRO
    graphics_draw_text(ctx, "@", font_gothic_24_bold, GRect(0, 0, 260, 26),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

    if (menu_layer_cell_is_selected(cell_index)) {
      bool is_pregame = data->gameState == KEY_GAMESTATE_PREGAME;
      graphics_draw_text(ctx, data->nameAway, font_gothic_28_bold, GRect(0, 0, 94, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
      graphics_draw_text(ctx, data->nameHome, font_gothic_28_bold, GRect(166, 0, 94, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

      graphics_draw_text(ctx, is_pregame ? data->recordAway : data->scoreAway,
                         font_gothic_28_bold, GRect(0, 29, 94, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
      graphics_draw_text(ctx, is_pregame ? data->recordHome : data->scoreHome,
                         font_gothic_28_bold, GRect(166, 29, 94, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

      // Anchored to the cell bottom rather than a fixed y, so it tracks any
      // change to the gabbro cell height instead of silently drifting.
      snprintf(text, sizeof(text), "%s - %s", data->league, data->subtitle);
      graphics_draw_text(ctx, text, fonts_get_system_font(FONT_KEY_GOTHIC_24),
                         GRect(0, bounds.size.h - 38, 260, 20),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    } else {
      graphics_draw_text(ctx, data->nameAway, font_gothic_28_bold, GRect(0, 0, 108, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
      graphics_draw_text(ctx, data->nameHome, font_gothic_28_bold, GRect(152, 0, 108, 26),
                         GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    }
#else
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
#endif
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
      
#if PBL_PLATFORM_GABBRO
    return menu_layer_cell_is_selected(cell_index) ? 100 : 50;
#elif PBL_PLATFORM_EMERY
    return 75;
#else
    return PBL_IF_RECT_ELSE(59, menu_layer_cell_is_selected(cell_index) ? 70 : 35);
 #endif

  } else {
      
#if PBL_PLATFORM_EMERY
    return PBL_DISPLAY_HEIGHT - STATUS_BAR_LAYER_HEIGHT;
#elif PBL_PLATFORM_GABBRO
    // Round viewport is inset at top and bottom, so the full-bleed cell is
    // shorter than on the rect platforms by one more header height.
    return PBL_DISPLAY_HEIGHT - (STATUS_BAR_LAYER_HEIGHT * 2);
#else
    return PBL_IF_COLOR_ELSE(115, 180);
#endif

  }
}

static void window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);
  window_set_background_color(window, GColorWhite);

  // Top and height both come from STATUS_BAR_LAYER_HEIGHT (16 / 20 emery+gabbro
  // / 24 chalk) so the cell the draw callbacks measure against is exactly the
  // area below the header. The literal 15 this replaced disagreed with
  // menu_get_cell_height_callback, which already used the constant, and left
  // the rect menu a full header-height too tall.
#if PBL_ROUND
  // Symmetric inset on round: with center_focused the MenuLayer centres the
  // focused cell in the viewport, so the viewport itself has to stay centred on
  // the screen or every row sits low. win-leagues insets the same way.
  s_menu_layer = menu_layer_create(GRect(bounds.origin.x,
                                         STATUS_BAR_LAYER_HEIGHT,
                                         bounds.size.w,
                                         bounds.size.h - (STATUS_BAR_LAYER_HEIGHT * 2)));
  menu_layer_set_center_focused(s_menu_layer, true);
#else
  s_menu_layer = menu_layer_create(GRect(bounds.origin.x,
                                         STATUS_BAR_LAYER_HEIGHT,
                                         bounds.size.w,
                                         bounds.size.h - STATUS_BAR_LAYER_HEIGHT));
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

  // One create, not three: the previous version built a TextLayer, configured
  // it, then overwrote the pointer inside the #if — leaking a layer per push
  // and losing the GColorClear background with it. STATUS_TEXT_OFFSET is the
  // same nudge win-card's status bar uses.
  s_header_text = text_layer_create(GRect(bounds.origin.x,
                                          bounds.origin.y + STATUS_TEXT_OFFSET,
                                          bounds.size.w, STATUS_BAR_LAYER_HEIGHT + 4));
  text_layer_set_background_color(s_header_text, GColorClear);
#if (PBL_DISPLAY_WIDTH >= 200)
  text_layer_set_font(s_header_text, fonts_get_system_font(FONT_KEY_GOTHIC_18));
#else
  text_layer_set_font(s_header_text, fonts_get_system_font(FONT_KEY_GOTHIC_14));
#endif
  text_layer_set_text_alignment(s_header_text, GTextAlignmentCenter);
  layer_add_child(window_layer, text_layer_get_layer(s_header_text));
}

static void window_unload(Window *window) {
  text_layer_destroy(s_header_text);
  menu_layer_destroy_safe(s_menu_layer);
}
