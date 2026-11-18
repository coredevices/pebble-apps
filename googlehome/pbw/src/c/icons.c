// Google Home watchapp: device badges drawn with primitives (no bitmaps, so they scale and work
// in black and white). A badge is a disc, filled with the kind's accent colour while the device
// is on, with the kind's glyph on top. Glyph coordinates are for a radius-14 badge and scaled.
#include "googlehome.h"

static GPoint s_c;
static int s_r;

static GPoint P(int x, int y) {
  return GPoint(s_c.x + x * s_r / 14, s_c.y + y * s_r / 14);
}

static int S(int v) {
  int scaled = v * s_r / 14;
  return scaled < 1 ? 1 : scaled;
}

static void line(GContext *ctx, int x0, int y0, int x1, int y1) {
  graphics_draw_line(ctx, P(x0, y0), P(x1, y1));
}

static void rect(GContext *ctx, int x0, int y0, int x1, int y1, bool fill) {
  GPoint a = P(x0, y0), b = P(x1, y1);
  GRect r = GRect(a.x, a.y, b.x - a.x, b.y - a.y);
  if (fill) graphics_fill_rect(ctx, r, S(2), GCornersAll);
  else graphics_draw_round_rect(ctx, r, S(2));
}

static bool is_active(const Device *d) {
  if (!(d->flags & FLAG_ONLINE)) return false;
  if (d->flags & FLAG_CAN_THERMO) return d->mode == MODE_HEAT || d->mode == MODE_COOL || d->mode == MODE_AUTO || d->mode == MODE_ECO;
  if (d->flags & FLAG_CAN_LOCK) return d->flags & FLAG_LOCKED;
  return d->flags & FLAG_ON;
}

GColor kind_accent(const Device *d) {
#ifdef PBL_COLOR
  switch (d->kind) {
    case KIND_LIGHT: return GColorChromeYellow;
    case KIND_OUTLET: case KIND_SWITCH: return GColorMediumAquamarine;
    case KIND_SPEAKER: case KIND_TV: return GColorVividCerulean;
    case KIND_LOCK: return GColorMalachite;
    case KIND_FAN: return GColorCeleste;
    case KIND_THERMOSTAT:
      return d->mode == MODE_COOL ? GColorPictonBlue : d->mode == MODE_ECO ? GColorMalachite : GColorOrange;
    default: return GColorMelon;
  }
#else
  return GColorWhite;
#endif
}

static void draw_glyph(GContext *ctx, int kind, bool active) {
  switch (kind) {
    case KIND_LIGHT:
      graphics_draw_circle(ctx, P(0, -2), S(5));
      if (active) graphics_fill_circle(ctx, P(0, -2), S(3));
      line(ctx, -3, 5, 3, 5);
      line(ctx, -2, 7, 2, 7);
      break;
    case KIND_OUTLET:
      rect(ctx, -7, -7, 7, 7, false);
      line(ctx, -3, -3, -3, 0);
      line(ctx, 3, -3, 3, 0);
      graphics_fill_circle(ctx, P(0, 4), S(1));
      break;
    case KIND_SWITCH:
      rect(ctx, -5, -8, 5, 8, false);
      rect(ctx, -2, active ? -5 : 0, 2, active ? 0 : 5, true);
      break;
    case KIND_THERMOSTAT:
      line(ctx, 0, -7, 0, 2);
      graphics_draw_circle(ctx, P(0, -7), S(1));
      graphics_fill_circle(ctx, P(0, 5), S(3));
      break;
    case KIND_LOCK: {
      GPoint a = P(-4, -8), b = P(4, 2);
      graphics_draw_arc(ctx, GRect(a.x, a.y, b.x - a.x, b.y - a.y), GOvalScaleModeFitCircle,
                        DEG_TO_TRIGANGLE(270), DEG_TO_TRIGANGLE(active ? 450 : 400));
      rect(ctx, -6, -1, 6, 8, true);
      break;
    }
    case KIND_SPEAKER:
      rect(ctx, -6, -8, 6, 8, false);
      graphics_draw_circle(ctx, P(0, 2), S(3));
      graphics_fill_circle(ctx, P(0, -4), S(1));
      break;
    case KIND_TV:
      rect(ctx, -8, -6, 8, 4, false);
      line(ctx, -4, 7, 4, 7);
      break;
    case KIND_FAN:
      graphics_fill_circle(ctx, s_c, S(2));
      line(ctx, 0, 0, 0, -7);
      line(ctx, 0, 0, 6, 4);
      line(ctx, 0, 0, -6, 4);
      break;
    default:
      line(ctx, -7, 0, 0, -7);
      line(ctx, 0, -7, 7, 0);
      rect(ctx, -5, 0, 5, 7, false);
      break;
  }
}

void draw_device_badge(GContext *ctx, GPoint center, int radius, const Device *d, bool highlighted) {
  s_c = center;
  s_r = radius;
  bool active = is_active(d);
  GColor glyph;
#ifdef PBL_COLOR
  graphics_context_set_fill_color(ctx, active ? kind_accent(d) : highlighted ? GColorBlack : GColorDarkGray);
  graphics_fill_circle(ctx, center, radius);
  glyph = active ? GColorBlack : (d->flags & FLAG_ONLINE) ? GColorWhite : GColorLightGray;
#else
  GColor fg = highlighted ? GColorBlack : GColorWhite;
  graphics_context_set_fill_color(ctx, fg);
  graphics_context_set_stroke_color(ctx, fg);
  if (active) {
    graphics_fill_circle(ctx, center, radius);
  } else {
    graphics_context_set_stroke_width(ctx, 1);
    graphics_draw_circle(ctx, center, radius);
  }
  glyph = active ? (highlighted ? GColorWhite : GColorBlack) : fg;
#endif
  graphics_context_set_stroke_color(ctx, glyph);
  graphics_context_set_fill_color(ctx, glyph);
  graphics_context_set_stroke_width(ctx, S(2) | 1);
  draw_glyph(ctx, d->kind, active);
  graphics_context_set_stroke_width(ctx, 1);
}

void draw_star(GContext *ctx, GPoint center, int radius, bool filled, GColor color) {
  GPoint pts[10];
  // Unit star scaled to radius: outer points at radius, inner at ~0.45 radius.
  static const int8_t X[10] = { 0, 26, 95, 42, 59, 0, -59, -42, -95, -26 };
  static const int8_t Y[10] = { -100, -36, -31, 14, 81, 45, 81, 14, -31, -36 };
  for (int i = 0; i < 10; i++) {
    pts[i] = GPoint(center.x + X[i] * radius / 100, center.y + Y[i] * radius / 100);
  }
  GPathInfo info = { .num_points = 10, .points = pts };
  GPath *path = gpath_create(&info);
  graphics_context_set_fill_color(ctx, color);
  graphics_context_set_stroke_color(ctx, color);
  if (filled) gpath_draw_filled(ctx, path);
  gpath_draw_outline(ctx, path);
  gpath_destroy(path);
}
