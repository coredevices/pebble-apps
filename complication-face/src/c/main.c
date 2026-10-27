#include <pebble.h>

// Complication face for the plugin API: the time and date, and two slots filled from the user's
// preferred readings — a number (with a gauge when it has a range) and a bitmap. PKJS decides
// what goes in each; this only draws what it is sent. The number is kept in persistent storage,
// so a face opened away from the phone shows the last reading rather than nothing.

#define TEXT_MAX 16
#define LABEL_MAX 24
// 4-bpp, so a square of this side is IMAGE_SIZE_MAX * IMAGE_SIZE_MAX / 2 bytes on the wire.
#define IMAGE_SIZE_MAX 64
#define NO_FILL -1
#define PERSIST_NUMBER 1

typedef struct {
  char text[TEXT_MAX];
  char label[LABEL_MAX];
  int fill;
} Number;

_Static_assert(sizeof(Number) <= PERSIST_DATA_MAX_LENGTH, "the number must fit a persist");

static Window *s_window;
static Layer *s_canvas;
static Number s_number = { .fill = NO_FILL };
static char s_image_label[LABEL_MAX];
static GBitmap *s_image;
static char s_time[8];
static char s_date[16];

#define INK GColorWhite
#define MUTED PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite)
#define ACCENT PBL_IF_COLOR_ELSE(GColorChromeYellow, GColorWhite)

// ---------------------------------------------------------------- layout

typedef struct {
  GRect time;
  GRect date;
  GRect number;
  GRect image;
  int label_h;
} Layout;

/** Both slots are circles side by side under the date; everything is a fraction of the screen. */
static Layout layout_for(GRect bounds) {
  int w = bounds.size.w;
  int h = bounds.size.h;
  Layout out;
  int top = bounds.origin.y + PBL_IF_ROUND_ELSE(h / 8, h / 24);
  out.time = GRect(bounds.origin.x, top, w, h * 11 / 50);
  out.date = GRect(bounds.origin.x, out.time.origin.y + out.time.size.h, w, h / 10);
  out.label_h = h / 12;
  int slots_top = out.date.origin.y + out.date.size.h + h / 24;
  int disc = h - slots_top - out.label_h - PBL_IF_ROUND_ELSE(h / 8, h / 24);
  int max_disc = PBL_IF_ROUND_ELSE(w / 3, w * 2 / 5);
  if (disc > max_disc) disc = max_disc;
  int gap = w / 12;
  int left = bounds.origin.x + (w - disc * 2 - gap) / 2;
  out.number = GRect(left, slots_top, disc, disc);
  out.image = GRect(left + disc + gap, slots_top, disc, disc);
  return out;
}

/** The bitmap sits inside the ring, so it is a little smaller than the disc. */
static int image_size_for(Layout layout) {
  int size = layout.image.size.w * 2 / 3;
  return size > IMAGE_SIZE_MAX ? IMAGE_SIZE_MAX : size;
}

// ---------------------------------------------------------------- drawing

static void draw_label(GContext *ctx, GRect slot, int h, const char *label) {
  graphics_context_set_text_color(ctx, MUTED);
  graphics_draw_text(ctx, label, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                     GRect(slot.origin.x - 10, slot.origin.y + slot.size.h, slot.size.w + 20, h),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void draw_ring(GContext *ctx, GRect slot) {
  graphics_context_set_stroke_color(ctx, MUTED);
  graphics_draw_circle(ctx, grect_center_point(&slot), slot.size.w / 2 - 1);
}

static void draw_number(GContext *ctx, GRect slot, int label_h) {
  int thickness = slot.size.w / 10 + 1;
  if (s_number.fill >= 0) {
    graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorDarkGray, GColorBlack));
    graphics_fill_radial(ctx, slot, GOvalScaleModeFitCircle, thickness, 0, TRIG_MAX_ANGLE);
    graphics_context_set_fill_color(ctx, ACCENT);
    graphics_fill_radial(ctx, slot, GOvalScaleModeFitCircle, thickness, 0,
                         TRIG_MAX_ANGLE * s_number.fill / 100);
  } else {
    draw_ring(ctx, slot);
  }
  GFont font = fonts_get_system_font(slot.size.w >= 56 ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD);
  int text_h = slot.size.w >= 56 ? 28 : 22;
  graphics_context_set_text_color(ctx, INK);
  graphics_draw_text(ctx, s_number.text[0] ? s_number.text : "--", font,
                     GRect(slot.origin.x + thickness, slot.origin.y + (slot.size.h - text_h) / 2 - 3,
                           slot.size.w - thickness * 2, text_h),
                     GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  draw_label(ctx, slot, label_h, s_number.label);
}

static void draw_image(GContext *ctx, GRect slot, int label_h) {
  draw_ring(ctx, slot);
  if (s_image) {
    GSize size = gbitmap_get_bounds(s_image).size;
    GRect frame = GRect(slot.origin.x + (slot.size.w - size.w) / 2,
                        slot.origin.y + (slot.size.h - size.h) / 2, size.w, size.h);
    // GCompOpAssign would paint the bitmap's transparent ground as black.
    graphics_context_set_compositing_mode(ctx, GCompOpSet);
    graphics_draw_bitmap_in_rect(ctx, s_image, frame);
    graphics_context_set_compositing_mode(ctx, GCompOpAssign);
  }
  draw_label(ctx, slot, label_h, s_image_label);
}

static void update_face(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  Layout layout = layout_for(bounds);
  graphics_context_set_antialiased(ctx, true);

  graphics_context_set_text_color(ctx, INK);
  graphics_draw_text(ctx, s_time,
                     fonts_get_system_font(layout.time.size.h >= 48 ? FONT_KEY_ROBOTO_BOLD_SUBSET_49
                                           : layout.time.size.h >= 42 ? FONT_KEY_BITHAM_42_BOLD
                                                                      : FONT_KEY_BITHAM_30_BLACK),
                     layout.time, GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  graphics_context_set_text_color(ctx, MUTED);
  graphics_draw_text(ctx, s_date, fonts_get_system_font(FONT_KEY_GOTHIC_18), layout.date,
                     GTextOverflowModeFill, GTextAlignmentCenter, NULL);

  draw_number(ctx, layout.number, layout.label_h);
  draw_image(ctx, layout.image, layout.label_h);
}

// ---------------------------------------------------------------- messages

/** 4-bpp palettised, exactly as the plugin API hands it over. */
static void set_image(const Tuple *width, const Tuple *height, const Tuple *palette,
                      const Tuple *pixels) {
  GSize size = GSize(width->value->int32, height->value->int32);
  if (size.w <= 0 || size.h <= 0 || size.w > IMAGE_SIZE_MAX || size.h > IMAGE_SIZE_MAX) return;
  if (s_image) {
    gbitmap_destroy(s_image);
    s_image = NULL;
  }
  // The palette outlives the call, so the bitmap owns a copy of it.
  uint8_t *owned_palette = malloc(palette->length);
  if (!owned_palette) return;
  memcpy(owned_palette, palette->value->data, palette->length);
  GBitmap *bitmap = gbitmap_create_blank_with_palette(size, GBitmapFormat4BitPalette,
                                                      (GColor *)owned_palette, true);
  if (!bitmap) {
    free(owned_palette);
    return;
  }
  // Rows are padded to ceil(width / 2) on the wire, but to whatever the watch wants in memory.
  uint16_t wire_stride = (size.w + 1) / 2;
  uint16_t stride = gbitmap_get_bytes_per_row(bitmap);
  uint8_t *data = gbitmap_get_data(bitmap);
  for (int row = 0; row < size.h; row++) {
    uint32_t offset = row * wire_stride;
    if (offset + wire_stride > pixels->length) break;
    memcpy(data + row * stride, pixels->value->data + offset, wire_stride);
  }
  s_image = bitmap;
}

static void send_image_size(void) {
  int size = image_size_for(layout_for(layer_get_bounds(s_canvas)));
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_int(out, MESSAGE_KEY_imageSize, &size, sizeof(int), true);
  app_message_outbox_send();
}

static void copy_field(DictionaryIterator *iter, uint32_t key, char *out, size_t size) {
  Tuple *tuple = dict_find(iter, key);
  if (tuple) snprintf(out, size, "%s", tuple->value->cstring);
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  // PKJS is restarted whenever the phone reconnects, and comes back not knowing the slot size.
  if (dict_find(iter, MESSAGE_KEY_hello)) {
    send_image_size();
    return;
  }
  Tuple *pixels = dict_find(iter, MESSAGE_KEY_iconPixels);
  if (pixels) {
    Tuple *width = dict_find(iter, MESSAGE_KEY_iconWidth);
    Tuple *height = dict_find(iter, MESSAGE_KEY_iconHeight);
    Tuple *palette = dict_find(iter, MESSAGE_KEY_iconPalette);
    if (width && height && palette) set_image(width, height, palette, pixels);
    copy_field(iter, MESSAGE_KEY_imgLabel, s_image_label, sizeof(s_image_label));
    layer_mark_dirty(s_canvas);
    return;
  }
  Tuple *fill = dict_find(iter, MESSAGE_KEY_numFill);
  if (fill) s_number.fill = fill->value->int32;
  copy_field(iter, MESSAGE_KEY_numText, s_number.text, sizeof(s_number.text));
  copy_field(iter, MESSAGE_KEY_numLabel, s_number.label, sizeof(s_number.label));
  persist_write_data(PERSIST_NUMBER, &s_number, sizeof(s_number));
  layer_mark_dirty(s_canvas);
}

// ---------------------------------------------------------------- app

static void set_time(struct tm *now) {
  strftime(s_time, sizeof(s_time), clock_is_24h_style() ? "%H:%M" : "%I:%M", now);
  strftime(s_date, sizeof(s_date), "%a %d %b", now);
}

static void tick(struct tm *now, TimeUnits units_changed) {
  set_time(now);
  layer_mark_dirty(s_canvas);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_canvas = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_canvas, update_face);
  layer_add_child(root, s_canvas);
  send_image_size();
}

static void window_unload(Window *window) {
  layer_destroy(s_canvas);
  if (s_image) {
    gbitmap_destroy(s_image);
    s_image = NULL;
  }
}

static void init(void) {
  if (persist_exists(PERSIST_NUMBER) && persist_get_size(PERSIST_NUMBER) == (int)sizeof(s_number)) {
    persist_read_data(PERSIST_NUMBER, &s_number, sizeof(s_number));
  }
  s_window = window_create();
  window_set_background_color(s_window, GColorBlack);
  window_set_window_handlers(s_window, (WindowHandlers){
      .load = window_load,
      .unload = window_unload,
  });
  app_message_register_inbox_received(inbox_received);
  // A 64px bitmap is 2KB of pixels.
  app_message_open(app_message_inbox_size_maximum(), 64);
  tick_timer_service_subscribe(MINUTE_UNIT, tick);
  time_t now = time(NULL);
  set_time(localtime(&now));
  window_stack_push(s_window, true);
}

static void deinit(void) {
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
