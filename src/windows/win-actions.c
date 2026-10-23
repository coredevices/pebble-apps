#include <pebble.h>
#include <libs/pebble-assist.h>
#include "win-actions.h"
#include "card.h"
#include "sports.h"
#include "config.h"

#define NUM_ACTION_MENU_ITEMS 3
#define ACTION_LABEL_LENGTH_MAX 32

static ActionMenu *s_action_menu = NULL;
static ActionMenuLevel *s_root_level = NULL;
static char s_buzz_action[ACTION_LABEL_LENGTH_MAX];

static void result_window_load(Window *window);
static void result_window_unload(Window *window);

static Window *s_result_window = NULL;
static Layer *s_confirmation_layer = NULL;
static TextLayer *s_confirmation_text_layer = NULL;
static char s_confirmation_text[32];
#ifndef LOW_MEM
static GDrawCommandSequence *s_confirmation_sequence = NULL;
static uint32_t s_confirmation_distance_normalized = 0;
#else
static GDrawCommandImage *s_confirmation_image = NULL;
#endif

static void action_performed_callback(ActionMenu *action_menu,
                                      const ActionMenuItem *action, void *context) {
  const int current_action = (int)action_menu_item_get_action_data(action);

  static char topic[16];
  CardData *data = card_get_data();

  switch (current_action) {
    case 0:
      sports_set_buzz_on(!sports_get_buzz_on());
      snprintf(s_confirmation_text, sizeof(s_confirmation_text),
               "LEAD CHANGE BUZZ %s",
               sports_get_buzz_on() ? "ON" : "OFF");
      break;
    case 1:
      snprintf(topic, sizeof(topic), "%s:%s", data->league, data->nameAway);
      if (data->subscribedAway) {
        timeline_remove(topic, data->id);
      } else {
        timeline_add(topic, data->id);
      }
      data->subscribedAway = !data->subscribedAway;
      snprintf(s_confirmation_text, sizeof(s_confirmation_text),
               "GAMES %s %s TIMELINE",
               data->subscribedAway ? "ADDED" : "REMOVED",
               data->subscribedAway ? "TO" : "FROM");
      break;
    case 2:
      snprintf(topic, sizeof(topic), "%s:%s", data->league, data->nameHome);
      if (data->subscribedHome) {
        timeline_remove(topic, data->id);
      } else {
        timeline_add(topic, data->id);
      }
      data->subscribedHome = !data->subscribedHome;
      snprintf(s_confirmation_text, sizeof(s_confirmation_text),
               "GAMES %s %s TIMELINE",
               data->subscribedHome ? "ADDED" : "REMOVED",
               data->subscribedHome ? "TO" : "FROM");
      break;
  }

  action_menu_set_result_window(s_action_menu, s_result_window);
}

void win_actions_init(void) {
  s_root_level = action_menu_level_create(NUM_ACTION_MENU_ITEMS);

  s_result_window = window_create();
  window_set_background_color(s_result_window, PBL_IF_COLOR_ELSE(SPORTS_DEFAULT_COLOR, GColorWhite));
  window_set_window_handlers(s_result_window, (WindowHandlers) {
    .load = result_window_load,
    .unload = result_window_unload,
  });
}

void win_actions_push(void) {
  snprintf(s_buzz_action, sizeof(s_buzz_action), "%s buzz on lead change",
           sports_get_buzz_on() ? "Disable" : "Enable");
  action_menu_level_add_action(s_root_level, s_buzz_action, action_performed_callback, (void*)0);

  CardData *data = card_get_data();
  static char awayText[32];
  static char homeText[32];

  snprintf(awayText, sizeof(awayText),
           "%s %s %s timeline",
           data->subscribedAway ? "Remove" : "Add",
           data->nameAway,
           data->subscribedAway ? "from" : "to");
  snprintf(homeText, sizeof(homeText),
           "%s %s %s timeline",
           data->subscribedHome ? "Remove" : "Add",
           data->nameHome,
           data->subscribedHome ? "from" : "to");

  action_menu_level_add_action(s_root_level, awayText, action_performed_callback, (void*)1);
  action_menu_level_add_action(s_root_level, homeText, action_performed_callback, (void*)2);

  ActionMenuConfig config = {
    .root_level = s_root_level,
    .colors = {
      .background = SPORTS_DEFAULT_COLOR,
      .foreground = GColorBlack,
    },
    .align = ActionMenuAlignCenter
  };
  s_action_menu = action_menu_open(&config);
}

void win_actions_deinit(void) {
  action_menu_hierarchy_destroy(s_root_level, NULL, NULL);
}

#ifndef LOW_MEM
static inline int32_t distance_interpolate(const int32_t normalized, int32_t from, int32_t to) {
  return from + (((int64_t)normalized * (to - from)) / (int64_t)ANIMATION_NORMALIZED_MAX);
}
#endif

static void after_anim_pop_window(Animation *animation, bool finished, void *context) {
  window_stack_remove(s_result_window, true);
}

void property_animation_update_confirmation(PropertyAnimation *property_animation,
                                            const uint32_t distance_normalized) {
#ifndef LOW_MEM
  s_confirmation_distance_normalized = distance_normalized;
#endif
  layer_mark_dirty(s_confirmation_layer);
}

static const PropertyAnimationImplementation s_confirmation_implementation = {
  .base = {
    .update = (AnimationUpdateImplementation) property_animation_update_confirmation,
  },
};

static void confirmation_layer_update_proc(Layer *layer, GContext *ctx) {
#ifndef LOW_MEM
  if (s_confirmation_sequence == NULL) return;
  const uint32_t total_duration =
      gdraw_command_sequence_get_total_duration(s_confirmation_sequence);
  const uint32_t elapsed = distance_interpolate(s_confirmation_distance_normalized,
                                                0, total_duration);

  GDrawCommandFrame *frame = gdraw_command_sequence_get_frame_by_elapsed(s_confirmation_sequence,
                                                                         elapsed);
  if (frame) {
#if (PBL_DISPLAY_HEIGHT >= 200)
    GPoint p = GPoint(PBL_IF_RECT_ELSE(60, 90), PBL_IF_RECT_ELSE(74, 90));
    gdraw_command_frame_draw(ctx, s_confirmation_sequence, frame, p);
#else
    GPoint p = GPoint(PBL_IF_RECT_ELSE(32, 50), PBL_IF_RECT_ELSE(44, 40));
    gdraw_command_frame_draw(ctx, s_confirmation_sequence, frame, p);
#endif
  }
#else
  GPoint p = GPoint(32, 36);
  gdraw_command_image_draw(ctx, s_confirmation_image, p);
#endif
}

static void result_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(window_layer);

  s_confirmation_layer = layer_create(bounds);
  layer_set_update_proc(s_confirmation_layer, confirmation_layer_update_proc);
  layer_add_child(window_layer, s_confirmation_layer);

#ifndef LOW_MEM
  s_confirmation_distance_normalized = 0;
  s_confirmation_sequence =
      gdraw_command_sequence_create_with_resource(RESOURCE_ID_ICON_CONFIRMATION);
#else
  s_confirmation_image = gdraw_command_image_create_with_resource(RESOURCE_ID_ICON_CONFIRMATION);
#endif

  GRect text_bounds;
#if (PBL_DISPLAY_HEIGHT >= 200)
  text_bounds.origin.x = PBL_IF_RECT_ELSE(8, 16);
  text_bounds.origin.y = PBL_IF_RECT_ELSE(162, 172);
  text_bounds.size.w = bounds.size.w - (text_bounds.origin.x * 2);
  text_bounds.size.h = 64;
#else
  text_bounds.origin.x = PBL_IF_RECT_ELSE(8, 16);
  text_bounds.origin.y = PBL_IF_RECT_ELSE(120, 120);
  text_bounds.size.w = bounds.size.w - (text_bounds.origin.x * 2);
  text_bounds.size.h = 64;
#endif
  
  s_confirmation_text_layer = text_layer_create(text_bounds);
#if (PBL_DISPLAY_HEIGHT >= 200)
  text_layer_set_font(s_confirmation_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
#else
  text_layer_set_font(s_confirmation_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
#endif
  text_layer_set_text_color(s_confirmation_text_layer, PBL_IF_COLOR_ELSE(GColorWhite, GColorBlack));
  text_layer_set_background_color(s_confirmation_text_layer, GColorClear);
  text_layer_set_text_alignment(s_confirmation_text_layer, GTextAlignmentCenter);
  text_layer_set_text(s_confirmation_text_layer, s_confirmation_text);
  layer_add_child(window_layer, text_layer_get_layer(s_confirmation_text_layer));

  Animation *anim = (Animation *) property_animation_create(&s_confirmation_implementation,
                                                            NULL, NULL, NULL);
  animation_set_duration(anim, 1200);
  animation_set_handlers(anim, (AnimationHandlers) {
    .stopped = after_anim_pop_window,
  }, NULL);
  animation_schedule(anim);
}

static void result_window_unload(Window *window) {
  layer_destroy_safe(s_confirmation_layer);
  text_layer_destroy_safe(s_confirmation_text_layer);
#ifndef LOW_MEM
  gdraw_command_sequence_destroy(s_confirmation_sequence);
#else
  gdraw_command_image_destroy(s_confirmation_image);
#endif
}
