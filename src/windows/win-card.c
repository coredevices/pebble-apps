#include <pebble.h>
#include <pebble-assist.h>
#include "generated/keys.h"
#include "layers/progress_layer.h"
#include "win-card.h"
#include "card.h"
#include "espn.h"
#include "win-actions.h"
#include "config.h"
#include "analytics.h"

#define REFRESH_TIME 1000 * 30

static void handle_tick(struct tm *tick_time, TimeUnits units_changed);
static void click_config_provider(void *context);
static void window_load(Window *window);
static void window_unload(Window *window);
static void refresh_timer_callback(void *data);
#ifdef PBL_ROUND
static void tick_handler(struct tm *tick_time, TimeUnits units_changed);
#endif

static Window *s_window = NULL;
static Layer *s_main_layer = NULL;
static Layer *s_league_layer = NULL;
static Layer *s_game_layer = NULL;
static Layer *s_footer_layer = NULL;
static AppTimer *s_refresh_timer;
static GBitmap *s_buzz_icon;
static ProgressLayer *s_progress_layer = NULL;
static Animation *s_previous_animation;

static GFont s_font_leco_54_light;
static GFont s_font_leco_36_light;

#ifdef PBL_ROUND
static uint16_t time_increment = 0;
static bool time_showing = false;
static bool live_showing = true;
#endif
static uint16_t s_selected_card = 0;

typedef enum {
  ScrollDirectionDown,
  ScrollDirectionUp,
} ScrollDirection;

void win_card_init(void) {
  s_window = window_create();
  window_set_background_color(s_window, GColorWhite);
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });

  s_buzz_icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_BUZZSET);
  s_font_leco_54_light = fonts_load_custom_font(
      resource_get_handle(RESOURCE_ID_FONT_LECO_54_LIGHT));
  s_font_leco_36_light = fonts_load_custom_font(
      resource_get_handle(RESOURCE_ID_FONT_LECO_36_LIGHT));
}

void win_card_push(void) {
  window_stack_push(s_window, true);
  s_refresh_timer = app_timer_register(REFRESH_TIME, refresh_timer_callback, NULL);
}

void win_card_deinit(void) {
  app_timer_cancel(s_refresh_timer);
  fonts_unload_custom_font(s_font_leco_36_light);
  fonts_unload_custom_font(s_font_leco_54_light);
  gbitmap_destroy(s_buzz_icon);
  window_destroy_safe(s_window);
}

void win_card_mark_dirty(void) {
  if (!window_is_loaded(s_window)) return;
  layer_set_hidden(s_progress_layer, *card_get_data()->league);
  layer_mark_dirty(window_get_root_layer(s_window));
}

bool win_card_is_loaded(void) {
  return window_is_loaded(s_window);
}

void win_card_increment_progress(int16_t progress) {
  progress_layer_increment_progress(s_progress_layer, progress);
}

void win_card_set_progress(int16_t progress_percent) {
  if (progress_percent == 100) {
    analytics_set_screen(SCREEN_GAMECARD, BUTTON_ID_SELECT);
  }
  progress_layer_set_progress(s_progress_layer, progress_percent);
}

// - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - //

static inline GPoint gpoint_add(GPoint a, GPoint b) {
  return GPoint(a.x + b.x, a.y + b.y);
}

static void prv_draw_dotted_line(GContext* ctx, GPoint p0, uint16_t length, bool vertical) {
  // absolute coordinate
  GPoint abs_point = p0;
  // is first pixel even?
  bool even = (abs_point.x + abs_point.y) % 2 == 0;
  // direction to travel
  const GPoint delta = vertical ? GPoint(0, 1) : GPoint(1, 0);

  while (length >= 1) {
    if (even) {
      graphics_draw_pixel(ctx, abs_point);
    }
    even = !even;
    abs_point = gpoint_add(abs_point, delta);
    length--;
  }
}

static void after_scroll_swap_text(Animation *animation, bool finished, void *context) {
  espn_set_selected_card(s_selected_card);
}

static Animation *create_anim_scroll_out(Layer *layer, uint32_t duration, int16_t dy) {
  GPoint to_origin = GPoint(0, dy);
  Animation *result = (Animation *) property_animation_create_bounds_origin(layer, NULL,
                                                                            &to_origin);
  animation_set_duration(result, duration);
  animation_set_curve(result, AnimationCurveLinear);
  return result;
}

static Animation *create_anim_scroll_in(Layer *layer, uint32_t duration, int16_t dy) {
  GPoint from_origin = GPoint(0, dy);
  Animation *result = (Animation *) property_animation_create_bounds_origin(layer, &from_origin,
                                                                            &GPointZero);
  animation_set_duration(result, duration);
  animation_set_curve(result, AnimationCurveEaseOut);
  return result;
}

static const uint32_t SCROLL_DURATION = 100;
static const int16_t SCROLL_DIST_OUT = 20;
static const int16_t SCROLL_DIST_IN = 8;

static Animation *create_outbound_anim(ScrollDirection direction) {
  const int16_t to_dy = (direction == ScrollDirectionDown) ? -SCROLL_DIST_OUT : SCROLL_DIST_OUT;

  Animation *out_league = create_anim_scroll_out(s_league_layer, SCROLL_DURATION, to_dy);
  Animation *out_game = create_anim_scroll_out(s_game_layer, SCROLL_DURATION, to_dy);
  Animation *out_footer = create_anim_scroll_out(s_footer_layer, SCROLL_DURATION, to_dy);

  return animation_spawn_create(out_league, out_game, out_footer, NULL);
}

static Animation *create_inbound_anim(ScrollDirection direction) {
  const int16_t from_dy = (direction == ScrollDirectionDown) ? -SCROLL_DIST_IN : SCROLL_DIST_IN;

  Animation *in_league = create_anim_scroll_in(s_league_layer, SCROLL_DURATION, from_dy);
  Animation *in_game = create_anim_scroll_in(s_game_layer, SCROLL_DURATION, from_dy);
  Animation *in_footer = create_anim_scroll_in(s_footer_layer, SCROLL_DURATION, from_dy);

  return animation_spawn_create(in_league, in_game, in_footer, NULL);
}

static Animation *animation_for_scroll(ScrollDirection direction) {
  // sliding texts
  Animation *out_text = create_outbound_anim(direction);
  animation_set_handlers(out_text, (AnimationHandlers) {
    .stopped = after_scroll_swap_text,
  }, NULL);
  Animation *in_text = create_inbound_anim(direction);

  return animation_sequence_create(out_text, in_text, NULL);
}

static Animation *animation_for_bounce(ScrollDirection direction) {
  return create_inbound_anim(direction);
}

static void ask_for_scroll(ScrollDirection direction) {
  int delta = direction == ScrollDirectionUp ? -1 : +1;

  Animation *scroll_animation = NULL;

  if ((direction == ScrollDirectionUp && (espn_get_selected_card() == 0)) ||
      (direction == ScrollDirectionDown && (espn_get_selected_card() + 1 ==
                                            espn_get_num_cards()))) {
    scroll_animation = animation_for_bounce(direction);
  } else {
    s_selected_card = espn_get_selected_card() + delta;
    scroll_animation = animation_for_scroll(direction);
  }

  animation_unschedule(s_previous_animation);
  animation_schedule(scroll_animation);
  s_previous_animation = scroll_animation;
}

/////////////////////////////
//  DRAWING

static void set_compositing_mode(GContext *ctx) {
  graphics_context_set_compositing_mode(ctx, PBL_IF_COLOR_ELSE(GCompOpSet, GCompOpAssign));
}

static void draw_status_bar(GContext *ctx, GRect box) {
  const int16_t MARGIN = 6;

  const int16_t status_box_offset = PBL_IF_RECT_ELSE(-1, 4);
  GRect status_box = GRect(MARGIN, box.origin.y + status_box_offset, box.size.w - (MARGIN * 2),
                           box.size.h);

  graphics_context_set_text_color(ctx, GColorBlack);

  time_t now = time(NULL);
  struct tm *tick_time = localtime(&now);

  char time_text[] = "00:00";
  strftime(time_text, sizeof(time_text), clock_is_24h_style() ? "%R" : "%I:%M", tick_time);

  const bool should_draw = PBL_IF_RECT_ELSE(true, time_showing);
  if (should_draw) {
    graphics_draw_text(ctx, time_text, fonts_get_system_font(FONT_KEY_GOTHIC_14), status_box,
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }

  char pagination_text[6];

  if (espn_get_num_cards() > 0) {
    snprintf(pagination_text, sizeof(pagination_text), "%d/%d", espn_get_selected_card() + 1,
             espn_get_num_cards() ? espn_get_num_cards() : 1);
  }

#ifdef PBL_RECT
  graphics_draw_text(ctx, pagination_text, fonts_get_system_font(FONT_KEY_GOTHIC_14), status_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  prv_draw_dotted_line(ctx, GPoint(box.origin.y, box.size.h), box.size.w, false);

  if (card_get_data()->gameState == KEY_GAMESTATE_INGAME) {
    graphics_context_set_text_color(ctx, COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack));
    graphics_draw_text(ctx, "LIVE", fonts_get_system_font(FONT_KEY_GOTHIC_14), status_box,
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }
#elif PBL_ROUND
  if (!time_showing) {
    graphics_draw_text(ctx, pagination_text, fonts_get_system_font(FONT_KEY_GOTHIC_14), status_box,
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
#endif
}

static void draw_league(GContext *ctx, GRect box) {
  if (!*card_get_data()->league) {
    return;
  }

  GRect icon_box = box;
  icon_box.size = GSize(25, 25);

  GBitmap *icon = espn_get_selected_card_icon();

#ifdef PBL_RECT
  if (icon != NULL) {
    set_compositing_mode(ctx);
    graphics_draw_bitmap_in_rect(ctx, icon, icon_box);
  }

  if (espn_get_buzz_on()) {
    GRect buzz_box = box;
    buzz_box.origin.x = 101;
    buzz_box.size = GSize(25, 25);

    set_compositing_mode(ctx);
    graphics_draw_bitmap_in_rect(ctx, s_buzz_icon, buzz_box);
  }

  graphics_context_set_text_color(ctx, COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack));

  GRect league_box = box;
  league_box.origin.x += icon_box.size.w + 4;
  league_box.size.w -= league_box.origin.x;

  graphics_draw_text(ctx, card_get_data()->league,
                     fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     league_box,
                     GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentLeft,
                     NULL);

#elif PBL_ROUND
  const uint16_t icon_to_text = 4;
  const uint16_t text_to_buzz = 17;
  uint16_t text_width = 0;
  bool draw_icon = false;

  GRect league_box = box;

  GRect buzz_box = box;
  buzz_box.size = GSize(25, 25);

  if (icon != NULL) {
    text_width += icon_box.size.w + icon_to_text;
    draw_icon = true;
  }

  league_box.size.w = graphics_text_layout_get_content_size(card_get_data()->league,
                                                            fonts_get_system_font(
                                                                FONT_KEY_GOTHIC_18_BOLD),
                                                            league_box,
                                                            GTextOverflowModeTrailingEllipsis,
                                                            GTextAlignmentCenter).w;

  text_width += league_box.size.w;

  if (espn_get_buzz_on()) {
    text_width += text_to_buzz + (buzz_box.size.w - 9);
    buzz_box.origin.x = 90 + (text_width / 2) - (buzz_box.size.w - 9);
    set_compositing_mode(ctx);
    graphics_draw_bitmap_in_rect(ctx, s_buzz_icon, buzz_box);
  }

  if (draw_icon) {
    icon_box.origin.x = 90 - (text_width / 2);
    set_compositing_mode(ctx);
    graphics_draw_bitmap_in_rect(ctx, icon, icon_box);
  }

  league_box.origin.x = icon_box.origin.x + icon_box.size.w + icon_to_text;
  graphics_context_set_text_color(ctx, COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack));
  graphics_draw_text(ctx, card_get_data()->league, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     league_box, GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
#endif
}

static void draw_ingame(GContext *ctx, GRect box) {
  GFont score_font = s_font_leco_54_light;
  GFont name_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);

#ifdef PBL_RECT
  GRect score_away_box = box;
  score_away_box.origin.y -= 2;
  score_away_box.size.w = 72;
  score_away_box.size.h = 56;

  GRect score_home_box = score_away_box;
  score_home_box.origin.x = box.size.w / 2;



  GRect name_away_box = box;
  name_away_box.origin.y = box.origin.y + 51;
  name_away_box.size.w = (box.size.w / 2) - (name_away_box.origin.x * 2);
  name_away_box.size.h = 20;

  GRect name_home_box = name_away_box;
  name_home_box.origin.x = box.size.w / 2;

#elif PBL_ROUND
  GRect score_away_box = box;
  score_away_box.origin.y -= 2;
  score_away_box.origin.x = 18;
  score_away_box.size.w = 72;
  score_away_box.size.h = 56;

  GRect score_home_box = score_away_box;
  score_home_box.origin.x = 90;

  GRect name_away_box = box;
  name_away_box.origin.y = box.origin.y + 51;
  name_away_box.origin.x = 18;
  name_away_box.size.w = 72;
  name_away_box.size.h = 20;

  GRect name_home_box = name_away_box;
  name_home_box.origin.x = 90;
#endif

  if (strlen(card_get_data()->scoreAway) > 2 || strlen(card_get_data()->scoreHome) > 2) {
    score_font = s_font_leco_36_light;

    score_away_box.origin.y += 7;
    score_home_box.origin.y += 7;

    name_away_box.origin.y -= 5;
    name_home_box.origin.y -= 5;
  }

  graphics_context_set_text_color(ctx, GColorBlack);

  graphics_draw_text(ctx, card_get_data()->scoreAway, score_font, score_away_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, card_get_data()->scoreHome, score_font, score_home_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, card_get_data()->nameAway, name_font, name_away_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, card_get_data()->nameHome, name_font, name_home_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void draw_pregame(GContext *ctx, GRect box) {
  GFont name_font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);

  GRect name_away_box = box;
  name_away_box.origin.y += 12;
  name_away_box.origin.x += 5;
  name_away_box.size.w = (box.size.w / 2);
  name_away_box.size.h = 30;

  GRect name_home_box = name_away_box;
  name_home_box.origin.x = box.size.w / 2 - 5;

  GFont record_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);

  GRect record_away_box = box;
  record_away_box.origin.y += name_away_box.size.h + 10;
  record_away_box.origin.x += 5;
  record_away_box.size.w = (box.size.w / 2);
  record_away_box.size.h = 20;

  GRect record_home_box = record_away_box;
  record_home_box.origin.x = box.size.w / 2 - 5;

  graphics_context_set_text_color(ctx, GColorBlack);

  graphics_draw_text(ctx, card_get_data()->nameAway, name_font, name_away_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, card_get_data()->nameHome, name_font, name_home_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, card_get_data()->recordAway, record_font, record_away_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, card_get_data()->recordHome, record_font, record_home_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void main_layer_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);

  GRect status_box = bounds;
  status_box.size.h = 16;

  draw_status_bar(ctx, status_box);

  graphics_context_set_stroke_color(ctx, COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack));

  prv_draw_dotted_line(ctx, GPoint(0, bounds.size.h + PBL_IF_RECT_ELSE(-26, -48)), bounds.size.w,
                       false);
}

static void league_layer_update_proc(Layer *layer, GContext *ctx) {
  draw_league(ctx, layer_get_bounds(layer));
}

static void game_layer_update_proc(Layer *layer, GContext *ctx) {
  if (card_get_data()->gameState == KEY_GAMESTATE_PREGAME) {
    draw_pregame(ctx, layer_get_bounds(layer));
  } else {
    draw_ingame(ctx, layer_get_bounds(layer));
  }
}

static void footer_layer_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GRect subtitle_box = bounds;

#ifdef PBL_RECT
  GSize subtitle_size =
      graphics_text_layout_get_content_size(card_get_data()->subtitle, font, GRect(0, 0, 144, 20),
                                            GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);

  subtitle_box.origin.x += 9;
  subtitle_box.size = subtitle_size;

  graphics_context_set_text_color(ctx, COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack));

  graphics_draw_text(ctx, card_get_data()->subtitle, font, subtitle_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);

  if (*card_get_data()->broadcaster) {
    GPoint hor_line = bounds.origin;
    hor_line.x = subtitle_size.w + 17;

    graphics_context_set_stroke_color(ctx, COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack));
    prv_draw_dotted_line(ctx, hor_line, bounds.size.h, true);

    GRect broadcaster_box = bounds;
    broadcaster_box.origin.x += hor_line.x + 10;
    broadcaster_box.size.w -= broadcaster_box.origin.x + 10;

    graphics_draw_text(ctx, card_get_data()->broadcaster, font, broadcaster_box,
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }


#elif PBL_ROUND
  graphics_context_set_text_color(ctx, COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack));
  graphics_draw_text(ctx, card_get_data()->subtitle, font, subtitle_box,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

  if (card_get_data()->gameState == KEY_GAMESTATE_INGAME && (live_showing ||
      !*card_get_data()->broadcaster)) {
    GRect broadcaster_box = bounds;
    broadcaster_box.origin.y += 18;
    graphics_context_set_text_color(ctx, COLOR_FALLBACK(ESPN_DEFAULT_COLOR, GColorBlack));
    graphics_draw_text(ctx, "LIVE", font, broadcaster_box, GTextOverflowModeTrailingEllipsis,
                       GTextAlignmentCenter, NULL);
  }

  if (*card_get_data()->broadcaster && (!live_showing ||
      !card_get_data()->gameState == KEY_GAMESTATE_INGAME)) {
    GRect broadcaster_box = bounds;
    broadcaster_box.origin.y += 18;
    graphics_draw_text(ctx, card_get_data()->broadcaster, font, broadcaster_box,
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
#endif
}

#ifdef PBL_ROUND
static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  time_increment += 1;

  if (time_increment >= 3) {
    live_showing = !live_showing;
    time_increment = 0;
    layer_mark_dirty(s_footer_layer);
  }

  if (time_increment >= 2 && !time_showing) {
    time_showing = true;
    layer_mark_dirty(s_main_layer);
  }
}

static void reset_showing() {
  time_increment = 0;
  live_showing = true;
  time_showing = false;
}
#endif

static void handle_tick(struct tm *tick_time, TimeUnits units_changed) {
  layer_mark_dirty(s_main_layer);
}

static void down_up_click_handler(ClickRecognizerRef recognizer, void *context) {
  const bool is_up = (click_recognizer_get_button_id(recognizer) == BUTTON_ID_UP);
#ifdef PBL_ROUND
  reset_showing();
#endif
  if (is_up) {
    ask_for_scroll(ScrollDirectionUp);
  } else {
    ask_for_scroll(ScrollDirectionDown);
  }
  analytics_increment_screen_clicks(is_up);
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
// #ifdef LOW_MEM
//   espn_set_buzz_on(!espn_get_buzz_on());
//   win_card_mark_dirty();
//   vibes_short_pulse();
// #else
  win_actions_push();
// #endif
}

static void back_click_handler(ClickRecognizerRef recognizer, void *context) {
  analytics_set_screen(analytics_get_previous_screen(), BUTTON_ID_BACK);
  window_stack_remove(s_window, true);
}

static void click_config_provider(void *context) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 200, down_up_click_handler);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 200, down_up_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
  window_single_click_subscribe(BUTTON_ID_BACK, back_click_handler);
}

static void window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_main_layer = layer_create(bounds);
  layer_set_update_proc(s_main_layer, main_layer_update_proc);
  layer_add_child(window_layer, s_main_layer);

  s_league_layer = layer_create(GRect(PBL_IF_RECT_ELSE(9, 0), 27, PBL_IF_RECT_ELSE(126, 180), 25));

  layer_set_update_proc(s_league_layer, league_layer_update_proc);
  layer_add_child(window_layer, s_league_layer);

  s_game_layer = layer_create(GRect(0, 52, bounds.size.w, 84));
  layer_set_update_proc(s_game_layer, game_layer_update_proc);
  layer_add_child(window_layer, s_game_layer);

  const int16_t footer_offset = PBL_IF_RECT_ELSE(26, 47);
  s_footer_layer = layer_create(GRect(bounds.origin.x, bounds.size.h - footer_offset, bounds.size.w,
                                      footer_offset));

  layer_set_update_proc(s_footer_layer, footer_layer_update_proc);
  layer_add_child(window_layer, s_footer_layer);

  s_progress_layer = progress_layer_create(PBL_IF_RECT_ELSE(GRect(32, 80, 80, 6),
                                                            GRect(bounds.size.w / 4,
                                                                  bounds.size.h / 2,
                                                                  bounds.size.w / 2, 6)));
  progress_layer_set_progress(s_progress_layer, 20);
  progress_layer_set_corner_radius(s_progress_layer, 2);
  progress_layer_set_foreground_color(s_progress_layer, COLOR_FALLBACK(ESPN_DEFAULT_COLOR,
                                                                       GColorWhite));
  progress_layer_set_background_color(s_progress_layer, COLOR_FALLBACK(GColorLightGray,
                                                                       GColorBlack));
  layer_add_child(window_layer, s_progress_layer);
  layer_set_hidden(s_progress_layer, *card_get_data()->league);

  tick_timer_service_subscribe(MINUTE_UNIT, handle_tick);
#ifdef PBL_ROUND
  tick_timer_service_subscribe(SECOND_UNIT, tick_handler);
#endif
}

static void window_unload(Window *window) {
  tick_timer_service_unsubscribe();
  app_timer_cancel(s_refresh_timer);
  progress_layer_destroy(s_progress_layer);
  layer_destroy_safe(s_footer_layer);
  layer_destroy_safe(s_game_layer);
  layer_destroy_safe(s_league_layer);
  layer_destroy_safe(s_main_layer);
}

static void refresh_timer_callback(void *data) {
  if (!window_is_loaded(s_window)) return;

  if (launch_reason() == APP_LAUNCH_TIMELINE_ACTION) {
    espn_request_card();
  } else {
    espn_request_game();
  }

  s_refresh_timer = app_timer_register(REFRESH_TIME, refresh_timer_callback, NULL);
}
