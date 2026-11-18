// Google Home watchapp: one device. A header with its badge, name and state, then a row per
// control its capabilities allow, and Favorite. Level rows (brightness, warmth, volume, target
// temperature) open a level window: UP/DOWN change it, and it is sent 700 ms after the last press
// (or on SELECT / BACK), so a run of presses is one Google request. On touch watches a drag
// changes it and a tap sends it. Unlocking takes two presses (or taps) within 3 s.
#include "googlehome.h"

enum { ROW_POWER, ROW_BRIGHT, ROW_CTEMP, ROW_VOLUME, ROW_SETPT, ROW_MODE, ROW_LOCK, ROW_FAV };

static Window *s_window;
static MenuLayer *s_menu;
static bool s_shown;  // between appear and unload
static int s_index;  // row of the device shown; follows s_key when the list changes
static int s_key;
static int s_rows[8], s_row_count;
// Unlocking takes a second press within 3 s, so a stray press or tap can't open a door.
static AppTimer *s_unlock_timer;
static int s_unlock_key;
static char s_value[8][24];

// --- debounced send ---------------------------------------------------------------------------

static AppTimer *s_send_timer;
static int s_pending_key, s_pending_op, s_pending_value;

static void flush_send(void *data) {
  s_send_timer = NULL;
  send_action(s_pending_key, s_pending_op, s_pending_value);
}

static void schedule_send(int key, int op, int value) {
  if (s_send_timer) {
    app_timer_cancel(s_send_timer);
    s_send_timer = NULL;
    if (s_pending_key != key || s_pending_op != op) flush_send(NULL);
  }
  s_pending_key = key;
  s_pending_op = op;
  s_pending_value = value;
  s_send_timer = app_timer_register(700, flush_send, NULL);
}

static void flush_now(void) {
  if (s_send_timer) {
    app_timer_cancel(s_send_timer);
    flush_send(NULL);
  }
}

// --- level window ------------------------------------------------------------------------------

static Window *s_level_window;
static Layer *s_level_layer;
static int s_level_op, s_level_value, s_level_min, s_level_max, s_level_step;

static Device *dev(void) { return &g_devices[s_index]; }

static void level_text(char *buf, size_t size, int op, int value) {
  switch (op) {
    case OP_SETPT: format_degrees(buf, size, value, dev()->flags & FLAG_FAHRENHEIT); break;
    case OP_CTEMP: snprintf(buf, size, "%dK", value); break;
    default: snprintf(buf, size, "%d%%", value); break;
  }
}

static const char *level_title(int op) {
  switch (op) {
    case OP_BRIGHT: return "Brightness";
    case OP_CTEMP: return "Warmth";
    case OP_VOLUME: return "Volume";
    default: return "Target";
  }
}

static void level_draw(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  int cy = b.size.h / 2;
  GColor accent = PBL_IF_COLOR_ELSE(kind_accent(dev()), GColorWhite);
  int pct = (s_level_value - s_level_min) * 100 / (s_level_max - s_level_min);

#ifdef PBL_ROUND
  GRect ring = grect_inset(b, GEdgeInsets(10));
  graphics_context_set_fill_color(ctx, GColorDarkGray);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, 10, DEG_TO_TRIGANGLE(-135), DEG_TO_TRIGANGLE(135));
  graphics_context_set_fill_color(ctx, accent);
  graphics_fill_radial(ctx, ring, GOvalScaleModeFitCircle, 10, DEG_TO_TRIGANGLE(-135),
                       DEG_TO_TRIGANGLE(-135 + 270 * pct / 100));
#else
  int bw = b.size.w - 40, by = cy + 40;
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
  graphics_fill_rect(ctx, GRect(20, by, bw, 8), 4, GCornersAll);
  graphics_context_set_stroke_color(ctx, GColorWhite);
  graphics_draw_round_rect(ctx, GRect(20, by, bw, 8), 4);
  graphics_context_set_fill_color(ctx, accent);
  if (pct > 0) graphics_fill_rect(ctx, GRect(20, by, bw * pct / 100, 8), 4, GCornersAll);
#endif

  char buf[16];
  level_text(buf, sizeof(buf), s_level_op, s_level_value);
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, level_title(s_level_op), fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
                     GRect(0, cy - 58, b.size.w, 22), GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  graphics_draw_text(ctx, buf, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD), GRect(0, cy - 32, b.size.w, 50),
                     GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  graphics_context_set_text_color(ctx, DIM_COLOR);
  graphics_draw_text(ctx, dev()->name, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(20, cy + PBL_IF_ROUND_ELSE(30, 52), b.size.w - 40, 18), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentCenter, NULL);

  // UP / DOWN hints by the buttons.
  graphics_context_set_fill_color(ctx, GColorWhite);
  int ax = b.size.w - PBL_IF_ROUND_ELSE(30, 8);
  GPoint up[3] = { { ax - 5, cy - 50 }, { ax + 5, cy - 50 }, { ax, cy - 56 } };
  GPoint dn[3] = { { ax - 5, cy + 50 }, { ax + 5, cy + 50 }, { ax, cy + 56 } };
  GPathInfo ui = { 3, up }, di = { 3, dn };
  GPath *p = gpath_create(&ui);
  gpath_draw_filled(ctx, p);
  gpath_destroy(p);
  p = gpath_create(&di);
  gpath_draw_filled(ctx, p);
  gpath_destroy(p);
}

static void apply_level(void) {
  Device *d = dev();
  switch (s_level_op) {
    case OP_BRIGHT:
      d->bright = s_level_value;
      if (s_level_value > 0) d->flags |= FLAG_ON;
      break;
    case OP_CTEMP: d->ctemp = s_level_value; break;
    case OP_VOLUME: d->volume = s_level_value; break;
    case OP_SETPT: d->setpt = s_level_value; break;
  }
  schedule_send(s_key, s_level_op, s_level_value);
  layer_mark_dirty(s_level_layer);
}

static void level_step(int dir) {
  int v = s_level_value + dir * s_level_step;
  if (v < s_level_min) v = s_level_min;
  if (v > s_level_max) v = s_level_max;
  if (v == s_level_value) return;
  s_level_value = v;
  apply_level();
}

static void level_up(ClickRecognizerRef r, void *ctx) { level_step(1); }
static void level_down(ClickRecognizerRef r, void *ctx) { level_step(-1); }

static void level_done(ClickRecognizerRef r, void *ctx) {
  flush_now();
  window_stack_remove(s_level_window, true);
}

static void level_clicks(void *ctx) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 120, level_up);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 120, level_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, level_done);
}

#ifdef PBL_TOUCH
// Touch: drag up/down changes the level (a step per 12 px), a tap sends it and closes, swiping
// right goes back. The system bridge would turn a drag up into DOWN, so it's off for this window.
static int s_pan_base;
static bool s_panning;  // the phone's updates wait until the finger lifts

static void level_pan(const Recognizer *r, RecognizerEvent e) {
  if (e == RecognizerEvent_Started) s_pan_base = s_level_value;
  s_panning = e == RecognizerEvent_Started || e == RecognizerEvent_Updated;
  if (e != RecognizerEvent_Updated && e != RecognizerEvent_Completed) return;
  int v = s_pan_base - pan_recognizer_get_delta_since_start(r).y / 12 * s_level_step;
  if (v < s_level_min) v = s_level_min;
  if (v > s_level_max) v = s_level_max;
  if (v == s_level_value) return;
  s_level_value = v;
  apply_level();
}

static void level_close_now(void *data) { level_done(NULL, NULL); }

// Popped from a timer: unloading the window frees the recognizer whose callback this is.
static void level_close(const Recognizer *r, RecognizerEvent e) {
  if (e == RecognizerEvent_Completed) app_timer_register(0, level_close_now, NULL);
}
#endif

static void level_load(Window *w) {
  Layer *root = window_get_root_layer(w);
  window_set_background_color(w, BG_COLOR);
  s_level_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_level_layer, level_draw);
  layer_add_child(root, s_level_layer);
}

static void level_unload(Window *w) {
#ifdef PBL_TOUCH
  s_panning = false;  // a pan cut short by the pop gets no Cancelled callback
#endif
  flush_now();
  list_toast_detach();
  layer_destroy(s_level_layer);
  s_level_layer = NULL;
}

// Range and value for `op` from the device's current state (and unit).
static void level_init(int op) {
  Device *d = dev();
  bool f = d->flags & FLAG_FAHRENHEIT;
  s_level_op = op;
  switch (op) {
    case OP_BRIGHT: s_level_min = 0; s_level_max = 100; s_level_step = 10; s_level_value = d->bright; break;
    case OP_CTEMP: s_level_min = 2000; s_level_max = 6500; s_level_step = 100; s_level_value = d->ctemp ? d->ctemp : 2700; break;
    case OP_VOLUME: s_level_min = 0; s_level_max = 100; s_level_step = 5; s_level_value = d->volume; break;
    default:
      s_level_min = f ? 500 : 100;
      s_level_max = f ? 900 : 320;
      s_level_step = f ? 10 : 5;
      s_level_value = d->setpt ? d->setpt : (f ? 700 : 210);
      break;
  }
  // Snap onto the step grid so the first press lands on a round value.
  s_level_value = s_level_min + (s_level_value - s_level_min + s_level_step / 2) / s_level_step * s_level_step;
  if (s_level_value > s_level_max) s_level_value = s_level_max;
  if (s_level_value < s_level_min) s_level_value = s_level_min;
}

static void level_push(int op) {
  level_init(op);
  // Windows are created once and reused: destroying one in its own unload faulted when BACK popped it.
  if (!s_level_window) {
    s_level_window = window_create();
    window_set_click_config_provider(s_level_window, level_clicks);
    window_set_window_handlers(s_level_window, (WindowHandlers) { .load = level_load, .unload = level_unload });
#ifdef PBL_TOUCH
    // Attached once, like the window itself: they live on its root layer, which unload keeps.
    window_set_touch_bridge_disabled(s_level_window, true);
    window_attach_recognizer(s_level_window, pan_recognizer_create(level_pan, NULL, PanAxis_Vertical));
    window_attach_recognizer(s_level_window, tap_recognizer_create(level_close, NULL));
    window_attach_recognizer(s_level_window, swipe_recognizer_create(level_close, NULL, SwipeDirection_Right));
#endif
  }
  window_stack_push(s_level_window, true);
}

// --- detail menu -------------------------------------------------------------------------------

static void rebuild_rows(void) {
  uint16_t f = dev()->flags;
  s_row_count = 0;
  if (f & FLAG_CAN_POWER) s_rows[s_row_count++] = ROW_POWER;
  if (f & FLAG_CAN_BRIGHT) s_rows[s_row_count++] = ROW_BRIGHT;
  if (f & FLAG_CAN_CTEMP) s_rows[s_row_count++] = ROW_CTEMP;
  if (f & FLAG_CAN_VOLUME) s_rows[s_row_count++] = ROW_VOLUME;
  if (f & FLAG_CAN_THERMO) {
    s_rows[s_row_count++] = ROW_SETPT;
    s_rows[s_row_count++] = ROW_MODE;
  }
  if (f & FLAG_CAN_LOCK) s_rows[s_row_count++] = ROW_LOCK;
  s_rows[s_row_count++] = ROW_FAV;
}

static uint16_t num_rows(MenuLayer *m, uint16_t section, void *ctx) {
  return s_row_count;
}

static int16_t header_height(MenuLayer *m, uint16_t section, void *ctx) {
  return PBL_IF_ROUND_ELSE(112, 76);
}

static int16_t cell_height(MenuLayer *m, MenuIndex *index, void *ctx) {
  return PBL_IF_ROUND_ELSE(menu_layer_is_index_selected(m, index) ? 60 : 40, 46);
}

static void draw_header(GContext *ctx, const Layer *cell, uint16_t section, void *data) {
  GRect b = layer_get_bounds(cell);
  Device *d = dev();
#ifdef PBL_ROUND
  draw_device_badge(ctx, GPoint(b.size.w / 2, 34), 22, d, false);
  GRect name = GRect(30, 58, b.size.w - 60, 24), status = GRect(30, 82, b.size.w - 60, 20);
  GTextAlignment align = GTextAlignmentCenter;
#else
  draw_device_badge(ctx, GPoint(30, 38), 22, d, false);
  GRect name = GRect(60, 10, b.size.w - 64, 24), status = GRect(60, 34, b.size.w - 64, 36);
  GTextAlignment align = GTextAlignmentLeft;
#endif
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, d->name, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), name,
                     GTextOverflowModeTrailingEllipsis, align, NULL);
  char line[52];
  snprintf(line, sizeof(line), "%s%s%s", d->room, d->status[0] ? " · " : "", d->status);
  graphics_context_set_text_color(ctx, DIM_COLOR);
  graphics_draw_text(ctx, line, fonts_get_system_font(FONT_KEY_GOTHIC_14), status,
                     GTextOverflowModeTrailingEllipsis, align, NULL);
}

static bool unlock_armed(void) { return s_unlock_timer && s_unlock_key == s_key; }

static void unlock_disarm(void *data) {
  s_unlock_timer = NULL;
  if (s_shown) menu_layer_reload_data(s_menu);
}

static void draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *data) {
  Device *d = dev();
  int row = s_rows[index->row];
  char *v = s_value[row];
  const char *title = "";
  switch (row) {
    case ROW_POWER: title = "Power"; strcpy(v, d->flags & FLAG_ON ? "On" : "Off"); break;
    case ROW_BRIGHT: title = "Brightness"; level_text(v, 24, OP_BRIGHT, d->bright); break;
    case ROW_CTEMP: title = "Warmth"; level_text(v, 24, OP_CTEMP, d->ctemp); break;
    case ROW_VOLUME: title = "Volume"; level_text(v, 24, OP_VOLUME, d->volume); break;
    case ROW_SETPT: title = "Target"; level_text(v, 24, OP_SETPT, d->setpt); break;
    case ROW_MODE: title = "Mode"; strcpy(v, d->mode ? mode_label(d->mode) : "–"); break;
    case ROW_LOCK: title = d->flags & FLAG_LOCKED ? "Locked" : "Lock now";
      strcpy(v, !(d->flags & FLAG_LOCKED) ? "Unlocked" : unlock_armed() ? "Press again to unlock" : "Press twice to unlock");
      break;
    case ROW_FAV: title = d->flags & FLAG_FAV ? "Favorite" : "Add to favorites"; strcpy(v, d->flags & FLAG_FAV ? "Remove" : "Show on top"); break;
  }
  menu_cell_basic_draw(ctx, cell, title, v, NULL);
#ifndef PBL_ROUND
  if (row == ROW_FAV) {
    GRect b = layer_get_bounds(cell);
#ifdef PBL_COLOR
    GColor star = GColorChromeYellow;
#else
    GColor star = menu_cell_layer_is_highlighted(cell) ? GColorBlack : GColorWhite;
#endif
    draw_star(ctx, GPoint(b.size.w - 18, b.size.h / 2), 8, d->flags & FLAG_FAV, star);
  }
#endif
}

static const uint8_t NEXT_MODE[] = { MODE_HEAT, MODE_HEAT, MODE_COOL, MODE_ECO, MODE_OFF, MODE_OFF };

static void select_click(MenuLayer *m, MenuIndex *index, void *ctx) {
  Device *d = dev();
  switch (s_rows[index->row]) {
    case ROW_POWER: {
      bool on = !(d->flags & FLAG_ON);
      d->flags ^= FLAG_ON;
      strncpy(d->status, on ? "On" : "Off", sizeof(d->status));
      send_action(s_key, OP_POWER, on);
      break;
    }
    case ROW_BRIGHT: level_push(OP_BRIGHT); return;
    case ROW_CTEMP: level_push(OP_CTEMP); return;
    case ROW_VOLUME: level_push(OP_VOLUME); return;
    case ROW_SETPT: level_push(OP_SETPT); return;
    case ROW_MODE:
      d->mode = NEXT_MODE[d->mode < ARRAY_LENGTH(NEXT_MODE) ? d->mode : 0];
      schedule_send(s_key, OP_MODE, d->mode);
      break;
    case ROW_LOCK:
      if (d->flags & FLAG_LOCKED) {
        if (unlock_armed()) {
          app_timer_cancel(s_unlock_timer);
          s_unlock_timer = NULL;
          d->flags &= ~FLAG_LOCKED;
          strncpy(d->status, "Unlocking…", sizeof(d->status));
          send_action(s_key, OP_LOCK, 0);
        } else {
          if (s_unlock_timer) app_timer_cancel(s_unlock_timer);
          s_unlock_key = s_key;
          s_unlock_timer = app_timer_register(3000, unlock_disarm, NULL);
        }
        break;
      }
      d->flags |= FLAG_LOCKED;
      strncpy(d->status, "Locking…", sizeof(d->status));
      send_action(s_key, OP_LOCK, 1);
      break;
    case ROW_FAV:
      d->flags ^= FLAG_FAV;
      send_action(s_key, OP_FAV, (d->flags & FLAG_FAV) != 0);
      list_reload();
      break;
  }
  menu_layer_reload_data(s_menu);
}

void detail_reload(void) {
  if (!s_shown) return;
  s_index = device_index_of_key(s_key);
  if (s_index < 0) {
    s_index = 0;
    if (s_level_window) window_stack_remove(s_level_window, false);
    window_stack_remove(s_window, false);
    return;
  }
  rebuild_rows();
  menu_layer_reload_data(s_menu);
  if (s_level_layer) {
    // The phone's word wins (a refused change, another unit) unless a press is still to be sent.
#ifdef PBL_TOUCH
    if (!s_send_timer && !s_panning) level_init(s_level_op);
#else
    if (!s_send_timer) level_init(s_level_op);
#endif
    layer_mark_dirty(s_level_layer);
  }
}

static void window_appear(Window *window) { s_shown = true; }

static void window_unload(Window *window) {
  s_shown = false;
  if (s_unlock_timer) app_timer_cancel(s_unlock_timer);
  s_unlock_timer = NULL;  // leaving the device abandons a half-done unlock
  flush_now();
  list_toast_detach();
}

// ponytail: the window and its MenuLayer are created once and never destroyed. The firmware's
// menu_layer_destroy() faults when text scrolling is on (menu_text_scroll_layer_deinit reads a
// kernel static from the app task); app exit frees them. Destroy them again once that is fixed.
void detail_window_push(int index) {
  if (index < 0 || index >= g_count) return;
  s_index = index;
  s_key = g_devices[index].key;
  if (!s_window) {
    s_window = window_create();
    window_set_background_color(s_window, BG_COLOR);
    window_set_window_handlers(s_window, (WindowHandlers) { .appear = window_appear, .unload = window_unload });
    Layer *root = window_get_root_layer(s_window);
    s_menu = menu_layer_create(layer_get_bounds(root));
    menu_layer_set_callbacks(s_menu, NULL, (MenuLayerCallbacks) {
      .get_num_rows = num_rows,
      .get_header_height = header_height,
      .get_cell_height = cell_height,
      .draw_header = draw_header,
      .draw_row = draw_row,
      .select_click = select_click,
    });
    menu_layer_set_normal_colors(s_menu, BG_COLOR, GColorWhite);
    menu_layer_set_highlight_colors(s_menu, HILITE_COLOR, PBL_IF_COLOR_ELSE(GColorWhite, GColorBlack));
#ifdef PBL_ROUND
    menu_layer_set_center_focused(s_menu, true);
#endif
    layer_add_child(root, menu_layer_get_layer(s_menu));
  }
  // Click config is reset whenever a window is pushed, so set it every time.
  menu_layer_set_click_config_onto_window(s_menu, s_window);
  rebuild_rows();
  menu_layer_reload_data(s_menu);
  menu_layer_set_selected_index(s_menu, (MenuIndex) { 0, 0 }, MenuRowAlignTop, false);
  window_stack_push(s_window, true);
}
