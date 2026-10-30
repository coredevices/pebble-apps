/* SPDX-FileCopyrightText: 2026 Core Devices LLC */
/* SPDX-License-Identifier: Apache-2.0 */

#include "whatsplaying.h"

// Launch screen: "Identify" followed by one row per remembered match.

static Window *s_window;
static MenuLayer *s_menu;

static uint16_t prv_get_num_rows(MenuLayer *menu, uint16_t section, void *context) {
  return 1 + history_count();
}

static int16_t prv_get_header_height(MenuLayer *menu, uint16_t section, void *context) {
  return MENU_CELL_BASIC_HEADER_HEIGHT;
}

static void prv_draw_header(GContext *ctx, const Layer *cell_layer, uint16_t section,
                            void *context) {
  menu_cell_basic_header_draw(ctx, cell_layer, "What's Playing");
}

static void prv_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *index,
                         void *context) {
  if (index->row == 0) {
    menu_cell_basic_draw(ctx, cell_layer, "Identify", "Listen for 10 s", NULL);
    return;
  }
  const HistoryEntry *entry = history_get(index->row - 1);
  if (!entry) {
    return;
  }
  menu_cell_basic_draw(ctx, cell_layer, entry->title[0] ? entry->title : "Unknown title",
                       entry->artist[0] ? entry->artist : "Unknown artist", NULL);
}

static void prv_select_click(MenuLayer *menu, MenuIndex *index, void *context) {
  if (index->row == 0) {
    card_window_push_listen();
    return;
  }
  const HistoryEntry *entry = history_get(index->row - 1);
  if (entry) {
    card_window_push_entry(entry);
  }
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(root);

  s_menu = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks) {
    .get_num_rows = prv_get_num_rows,
    .get_header_height = prv_get_header_height,
    .draw_header = prv_draw_header,
    .draw_row = prv_draw_row,
    .select_click = prv_select_click,
  });
#if defined(PBL_COLOR)
  menu_layer_set_highlight_colors(s_menu, GColorVividCerulean, GColorWhite);
#endif
  menu_layer_set_click_config_onto_window(s_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_menu));
}

static void prv_window_unload(Window *window) {
  menu_layer_destroy(s_menu);
  s_menu = NULL;
  window_destroy(s_window);
  s_window = NULL;
}

void menu_window_push(void) {
  if (s_window) {
    return;
  }
  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);
}

void menu_window_refresh(void) {
  if (s_menu) {
    menu_layer_reload_data(s_menu);
  }
}
