// Google Home watchapp: main list. Favorites first, then one section per room (the phone sends
// devices sorted by room). SELECT opens a device, long SELECT switches it on/off (or locks it).
#include "googlehome.h"

static Window *s_window;
static MenuLayer *s_menu;
static TextLayer *s_message;
static Layer *s_toast_layer;
static char s_toast[40];
static AppTimer *s_toast_timer;

static int s_fav[MAX_DEVICES], s_fav_count;
static int s_room_start[MAX_DEVICES], s_room_len[MAX_DEVICES], s_room_count;

static void rebuild_sections(void) {
  s_fav_count = 0;
  s_room_count = 0;
  for (int i = 0; i < g_count; i++) {
    if (g_devices[i].flags & FLAG_FAV) s_fav[s_fav_count++] = i;
    if (i == 0 || strcmp(g_devices[i].room, g_devices[i - 1].room) != 0) {
      s_room_start[s_room_count] = i;
      s_room_len[s_room_count++] = 0;
    }
    s_room_len[s_room_count - 1]++;
  }
}

// Section s in the menu -> room index, or -1 for Favorites.
static int room_of_section(int section) {
  return s_fav_count > 0 ? section - 1 : section;
}

static int device_at(MenuIndex *index) {
  int room = room_of_section(index->section);
  return room < 0 ? s_fav[index->row] : s_room_start[room] + index->row;
}

static uint16_t num_sections(MenuLayer *menu, void *ctx) {
  return (s_fav_count > 0 ? 1 : 0) + s_room_count;
}

static uint16_t num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  int room = room_of_section(section);
  if (room >= s_room_count) return 0;  // MenuLayer asks for section 0 even with no sections
  return room < 0 ? s_fav_count : s_room_len[room];
}

static int16_t header_height(MenuLayer *menu, uint16_t section, void *ctx) {
  return 22;
}

static int16_t cell_height(MenuLayer *menu, MenuIndex *index, void *ctx) {
#ifdef PBL_ROUND
  return menu_layer_is_index_selected(menu, index) ? 62 : 44;
#else
  return layer_get_bounds(menu_layer_get_layer(menu)).size.h >= 200 ? 52 : 44;
#endif
}

static void draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *data) {
  GRect b = layer_get_bounds(cell);
  int room = room_of_section(section);
  const char *title = room < 0 ? "FAVORITES" : g_devices[s_room_start[room]].room;
  graphics_context_set_text_color(ctx, room < 0 ? PBL_IF_COLOR_ELSE(GColorChromeYellow, GColorWhite) : DIM_COLOR);
  GRect r = GRect(PBL_IF_ROUND_ELSE(0, 8), 1, b.size.w - PBL_IF_ROUND_ELSE(0, 16), 20);
  graphics_draw_text(ctx, title, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), r,
                     GTextOverflowModeTrailingEllipsis, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft), NULL);
  if (room < 0) {
#ifndef PBL_ROUND
    draw_star(ctx, GPoint(b.size.w - 14, 11), 6, true, PBL_IF_COLOR_ELSE(GColorChromeYellow, GColorWhite));
#endif
  }
}

static void draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *data) {
  GRect b = layer_get_bounds(cell);
  const Device *d = &g_devices[device_at(index)];
  bool hi = menu_cell_layer_is_highlighted(cell);
  int inset = PBL_IF_ROUND_ELSE(hi ? 22 : 34, 6);
  int r = b.size.h >= 50 ? 16 : 14;
  draw_device_badge(ctx, GPoint(inset + r, b.size.h / 2), r, d, hi);

  int x = inset + 2 * r + 8;
  int w = b.size.w - x - PBL_IF_ROUND_ELSE(inset, 4);
  bool online = d->flags & FLAG_ONLINE;
  graphics_context_set_text_color(ctx, hi ? PBL_IF_COLOR_ELSE(GColorWhite, GColorBlack) : GColorWhite);
  bool status = d->status[0] && (PBL_IF_ROUND_ELSE(hi, true));
  int name_y = status ? b.size.h / 2 - 22 : b.size.h / 2 - 14;
  graphics_draw_text(ctx, d->name, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(x, name_y, w, 22),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  if (status) {
    GColor c = hi ? PBL_IF_COLOR_ELSE(GColorLightGray, GColorBlack) : online ? DIM_COLOR : PBL_IF_COLOR_ELSE(GColorDarkGray, GColorWhite);
#ifdef PBL_COLOR
    if (online && (d->flags & (FLAG_ON | FLAG_LOCKED))) c = kind_accent(d);
#endif
    graphics_context_set_text_color(ctx, c);
    graphics_draw_text(ctx, d->status, fonts_get_system_font(FONT_KEY_GOTHIC_14), GRect(x, name_y + 20, w, 18),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }
}

static void select_click(MenuLayer *menu, MenuIndex *index, void *ctx) {
  detail_window_push(device_at(index));
}

// Quick switch: optimistic, the phone puts the real state back if Google refuses.
static void select_long(MenuLayer *menu, MenuIndex *index, void *ctx) {
  int i = device_at(index);
  Device *d = &g_devices[i];
  if (d->flags & FLAG_CAN_POWER) {
    bool on = !(d->flags & FLAG_ON);
    d->flags ^= FLAG_ON;
    strncpy(d->status, on ? "On" : "Off", sizeof(d->status));
    send_action(d->key, OP_POWER, on);
    vibes_short_pulse();
  } else if ((d->flags & FLAG_CAN_LOCK) && !(d->flags & FLAG_LOCKED)) {
    d->flags |= FLAG_LOCKED;
    strncpy(d->status, "Locking…", sizeof(d->status));
    send_action(d->key, OP_LOCK, 1);
    vibes_short_pulse();
  } else {
    detail_window_push(i);
    return;
  }
  menu_layer_reload_data(s_menu);
}

static void toast_hide(void *data) {
  s_toast_timer = NULL;
  layer_set_hidden(s_toast_layer, true);
}

static void toast_draw(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorRed, GColorWhite));
  graphics_fill_rect(ctx, b, PBL_IF_ROUND_ELSE(0, 6), GCornersTop);
  graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorWhite, GColorBlack));
  graphics_draw_text(ctx, s_toast, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(PBL_IF_ROUND_ELSE(30, 4), 2, b.size.w - PBL_IF_ROUND_ELSE(60, 8), b.size.h - 4),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

void list_toast(const char *text) {
  if (!s_toast_layer) return;
  strncpy(s_toast, text, sizeof(s_toast) - 1);
  s_toast[sizeof(s_toast) - 1] = '\0';
  layer_remove_from_parent(s_toast_layer);
  Window *top = window_stack_get_top_window();
  layer_add_child(window_get_root_layer(top ? top : s_window), s_toast_layer);
  layer_set_hidden(s_toast_layer, false);
  layer_mark_dirty(s_toast_layer);
  if (s_toast_timer) app_timer_cancel(s_toast_timer);
  s_toast_timer = app_timer_register(2500, toast_hide, NULL);
  vibes_double_pulse();
}

void list_toast_detach(void) {
  if (!s_toast_layer) return;
  layer_remove_from_parent(s_toast_layer);
  layer_add_child(window_get_root_layer(s_window), s_toast_layer);
}

void list_reload(void) {
  if (!s_menu) return;
  rebuild_sections();
  bool empty = g_count <= 0;
  layer_set_hidden(menu_layer_get_layer(s_menu), empty);
  layer_set_hidden(text_layer_get_layer(s_message), !empty);
  text_layer_set_text(s_message, g_count < 0 ? "Loading…" : g_message);
  menu_layer_reload_data(s_menu);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  window_set_background_color(window, BG_COLOR);

  s_menu = menu_layer_create(b);
  menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks) {
    .get_num_sections = num_sections,
    .get_num_rows = num_rows,
    .get_header_height = header_height,
    .get_cell_height = cell_height,
    .draw_header = draw_header,
    .draw_row = draw_row,
    .select_click = select_click,
    .select_long_click = select_long,
  });
  menu_layer_set_normal_colors(s_menu, BG_COLOR, GColorWhite);
  menu_layer_set_highlight_colors(s_menu, HILITE_COLOR, PBL_IF_COLOR_ELSE(GColorWhite, GColorBlack));
#ifdef PBL_ROUND
  menu_layer_set_center_focused(s_menu, true);
#endif
  menu_layer_set_click_config_onto_window(s_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_menu));

  s_message = text_layer_create(GRect(16, b.size.h / 2 - 50, b.size.w - 32, 100));
  text_layer_set_background_color(s_message, GColorClear);
  text_layer_set_text_color(s_message, GColorWhite);
  text_layer_set_font(s_message, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_message, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_message));

  int th = PBL_IF_ROUND_ELSE(40, 28);
  s_toast_layer = layer_create(GRect(0, b.size.h - th, b.size.w, th));
  layer_set_update_proc(s_toast_layer, toast_draw);
  layer_set_hidden(s_toast_layer, true);
  layer_add_child(root, s_toast_layer);

  list_reload();
}

void list_window_push(void) {
  s_window = window_create();
  // No unload: the list lives until the app exits (see detail.c for why menus aren't destroyed).
  window_set_window_handlers(s_window, (WindowHandlers) { .load = window_load });
  window_stack_push(s_window, true);
}
