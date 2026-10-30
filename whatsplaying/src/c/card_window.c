/* SPDX-FileCopyrightText: 2026 Core Devices LLC */
/* SPDX-License-Identifier: Apache-2.0 */

#include "whatsplaying.h"

// One window, four looks:
//   Listening   "Listening…" + countdown (fed by SECONDS from the phone)
//   Identifying "Identifying…" while pkjs talks to the recognition service
//   Result      title / artist / album (from a fresh match or from history)
//   Message     "No match", errors and start-failure texts
//
// The content is three TextLayers stacked inside a ScrollLayer, laid out from
// layer_get_unobstructed_bounds() so the firmware's "Listening" banner never
// covers anything. Long titles scroll with UP/DOWN.

typedef enum CardMode {
  CardModeListening,
  CardModeIdentifying,
  CardModeResult,
  CardModeMessage,
} CardMode;

#define PADDING PBL_IF_ROUND_ELSE(14, 6)
#define LINE_GAP 4

static Window *s_window;
static ScrollLayer *s_scroll;
static TextLayer *s_lines[3];
static GFont s_fonts[3];
static char s_text[3][96];

static CardMode s_mode;
static bool s_session_active;   // a listen was started from this card and is not resolved yet
static bool s_streaming;        // between a successful start and stop/stopped
static bool s_stream_started;   // the phone accepted the stream (`started` fired)
static int s_elapsed_seconds;   // watch-side seconds since `started`
static AppTimer *s_tick_timer;

// ---------------------------------------------------------------------------
// Names for on-screen diagnostics
// ---------------------------------------------------------------------------

static const char *prv_start_result_name(MicStreamStartResult result) {
  switch (result) {
    case MicStreamStartOk: return "MicStreamStartOk";
    case MicStreamStartErrBusy: return "MicStreamStartErrBusy";
    case MicStreamStartErrNotForeground: return "MicStreamStartErrNotForeground";
    case MicStreamStartErrInvalidArgs: return "MicStreamStartErrInvalidArgs";
    case MicStreamStartErrNoMemory: return "MicStreamStartErrNoMemory";
    case MicStreamStartErrWatchface: return "MicStreamStartErrWatchface";
    case MicStreamStartErrUnavailable: return "MicStreamStartErrUnavailable";
  }
  return "MicStreamStartErr?";
}

static const char *prv_stop_reason_name(MicStreamStopReason reason) {
  switch (reason) {
    case MicStreamStopReasonStopped: return "Stopped";
    case MicStreamStopReasonFocusLost: return "FocusLost";
    case MicStreamStopReasonInterrupted: return "Interrupted";
    case MicStreamStopReasonError: return "Error";
    case MicStreamStopReasonPhone: return "Phone";
  }
  return "Unknown";
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

static void prv_layout(void) {
  if (!s_window) {
    return;
  }
  Layer *root = window_get_root_layer(s_window);
  const GRect bounds = layer_get_unobstructed_bounds(root);
  layer_set_frame(scroll_layer_get_layer(s_scroll), bounds);

  const int width = bounds.size.w - 2 * PADDING;
  int heights[3];
  int total = 0;
  for (int i = 0; i < 3; i++) {
    if (s_text[i][0] == '\0') {
      heights[i] = 0;
      continue;
    }
    const GSize size = graphics_text_layout_get_content_size(
        s_text[i], s_fonts[i], GRect(0, 0, width, 1000), GTextOverflowModeWordWrap,
        GTextAlignmentCenter);
    heights[i] = size.h + 4;  // descender slack
    total += heights[i] + (total > 0 ? LINE_GAP : 0);
  }

  // Centre vertically when everything fits, otherwise start at the top and scroll.
  int y = (bounds.size.h - total) / 2;
  if (y < PADDING) {
    y = PADDING;
  }
  const int top = y;
  for (int i = 0; i < 3; i++) {
    layer_set_hidden(text_layer_get_layer(s_lines[i]), heights[i] == 0);
    if (heights[i] == 0) {
      continue;
    }
    layer_set_frame(text_layer_get_layer(s_lines[i]), GRect(PADDING, y, width, heights[i]));
    y += heights[i] + LINE_GAP;
  }
  scroll_layer_set_content_size(s_scroll, GSize(bounds.size.w, top + total + PADDING));
  scroll_layer_set_content_offset(s_scroll, GPointZero, false);
}

static void prv_set_line(int i, const char *text, GFont font) {
  strncpy(s_text[i], text ? text : "", sizeof(s_text[i]) - 1);
  s_text[i][sizeof(s_text[i]) - 1] = '\0';
  s_fonts[i] = font;
  text_layer_set_font(s_lines[i], font);
  text_layer_set_text(s_lines[i], s_text[i]);
}

static void prv_show_message(const char *headline, const char *detail, GFont detail_font,
                             const char *hint) {
  s_mode = CardModeMessage;
  prv_set_line(0, headline, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  prv_set_line(1, detail, detail_font);
  prv_set_line(2, hint, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  prv_layout();
}

static void prv_show_result(const char *title, const char *artist, const char *album) {
  s_mode = CardModeResult;
  prv_set_line(0, title && title[0] ? title : "Unknown title",
               fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  prv_set_line(1, artist && artist[0] ? artist : "Unknown artist",
               fonts_get_system_font(FONT_KEY_GOTHIC_18));
  prv_set_line(2, album, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  prv_layout();
}

static void prv_update_countdown(int seconds_received) {
  int remaining = LISTEN_SECONDS - seconds_received;
  if (remaining < 0) {
    remaining = 0;
  }
  char buf[16];
  snprintf(buf, sizeof(buf), "%d", remaining);
  prv_set_line(1, buf, fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS));
}

static void prv_show_listening(void) {
  s_mode = CardModeListening;
  prv_set_line(0, "Listening…", fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  prv_update_countdown(0);
  prv_set_line(2, "Waiting for phone…", fonts_get_system_font(FONT_KEY_GOTHIC_14));
  prv_layout();
}

static void prv_show_identifying(void) {
  s_mode = CardModeIdentifying;
  prv_set_line(0, "Identifying…", fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  prv_set_line(1, "", fonts_get_system_font(FONT_KEY_GOTHIC_18));
  prv_set_line(2, "Asking the music service", fonts_get_system_font(FONT_KEY_GOTHIC_14));
  prv_layout();
}

// ---------------------------------------------------------------------------
// Microphone streaming
// ---------------------------------------------------------------------------

static void prv_cancel_tick(void) {
  if (s_tick_timer) {
    app_timer_cancel(s_tick_timer);
    s_tick_timer = NULL;
  }
}

// We asked for the stop ourselves: the phone will now identify what it got.
static void prv_stop_and_identify(void) {
  prv_cancel_tick();
  s_streaming = false;
  mic_stream_to_phone_stop();
  prv_show_identifying();
}

static void prv_tick(void *context) {
  s_tick_timer = NULL;
  if (!s_streaming) {
    return;
  }
  s_elapsed_seconds++;
  if (s_elapsed_seconds >= LISTEN_SECONDS) {
    prv_stop_and_identify();
    return;
  }
  if (s_mode == CardModeListening && s_elapsed_seconds == MIN_LISTEN_SECONDS) {
    prv_set_line(2, "SELECT to identify now", fonts_get_system_font(FONT_KEY_GOTHIC_14));
    prv_layout();
  }
  s_tick_timer = app_timer_register(1000, prv_tick, NULL);
}

static void prv_stream_started(void *context) {
  APP_LOG(APP_LOG_LEVEL_INFO, "Stream accepted by phone");
  s_stream_started = true;
  s_elapsed_seconds = 0;
  prv_cancel_tick();
  s_tick_timer = app_timer_register(1000, prv_tick, NULL);
  if (s_mode == CardModeListening) {
    prv_set_line(2, "", fonts_get_system_font(FONT_KEY_GOTHIC_14));
    prv_layout();
  }
}

// Every end of the stream that we did not ask for arrives here. The stream is
// already gone; we only update the screen. If enough audio reached the phone,
// pkjs will still identify and its messages will replace whatever we show.
static void prv_stream_stopped(MicStreamStopReason reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_INFO, "Stream stopped: %s", prv_stop_reason_name(reason));
  prv_cancel_tick();
  s_streaming = false;
  if (!s_window || !s_session_active) {
    return;
  }
  if (reason == MicStreamStopReasonStopped) {
    if (s_mode == CardModeListening) {
      prv_show_identifying();
    }
    return;
  }
  char detail[48];
  snprintf(detail, sizeof(detail), "MicStreamStopReason%s", prv_stop_reason_name(reason));
  const bool enough = s_stream_started && s_elapsed_seconds >= MIN_LISTEN_SECONDS;
  prv_show_message("Listen ended", detail, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                   enough ? "Identifying what was heard…" : "SELECT to try again");
}

static void prv_begin_listen(void) {
  s_session_active = true;
  s_streaming = false;
  s_stream_started = false;
  s_elapsed_seconds = 0;
  prv_cancel_tick();

  prv_show_listening();
  const MicStreamStartResult result = mic_stream_to_phone_start((MicStreamHandlers) {
    .started = prv_stream_started,
    .stopped = prv_stream_stopped,
  }, NULL);
  if (result != MicStreamStartOk) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "mic_stream_to_phone_start: %s", prv_start_result_name(result));
    prv_show_message("Can't listen", prv_start_result_name(result),
                     fonts_get_system_font(FONT_KEY_GOTHIC_14), "SELECT to try again");
    return;
  }
  s_streaming = true;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

static void prv_select_click(ClickRecognizerRef recognizer, void *context) {
  switch (s_mode) {
    case CardModeListening:
      if (s_streaming && s_stream_started && s_elapsed_seconds >= MIN_LISTEN_SECONDS) {
        prv_stop_and_identify();
      }
      break;
    case CardModeIdentifying:
      break;
    case CardModeResult:
    case CardModeMessage:
      prv_begin_listen();
      break;
  }
}

static void prv_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click);
}

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------

static void prv_unobstructed_did_change(void *context) {
  prv_layout();
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  const GRect bounds = layer_get_unobstructed_bounds(root);

  s_scroll = scroll_layer_create(bounds);
  scroll_layer_set_shadow_hidden(s_scroll, true);
  scroll_layer_set_callbacks(s_scroll, (ScrollLayerCallbacks) {
    .click_config_provider = prv_click_config,
  });
  scroll_layer_set_click_config_onto_window(s_scroll, window);
#if defined(PBL_ROUND)
  scroll_layer_set_paging(s_scroll, true);
#endif

  for (int i = 0; i < 3; i++) {
    s_lines[i] = text_layer_create(GRect(0, 0, bounds.size.w, 10));
    text_layer_set_background_color(s_lines[i], GColorClear);
    text_layer_set_text_alignment(s_lines[i], GTextAlignmentCenter);
    text_layer_set_overflow_mode(s_lines[i], GTextOverflowModeWordWrap);
    scroll_layer_add_child(s_scroll, text_layer_get_layer(s_lines[i]));
  }
  layer_add_child(root, scroll_layer_get_layer(s_scroll));

  unobstructed_area_service_subscribe((UnobstructedAreaHandlers) {
    .did_change = prv_unobstructed_did_change,
  }, NULL);
}

static void prv_window_unload(Window *window) {
  unobstructed_area_service_unsubscribe();
  prv_cancel_tick();
  if (s_streaming) {
    s_streaming = false;
    mic_stream_to_phone_stop();
  }
  s_session_active = false;
  for (int i = 0; i < 3; i++) {
    text_layer_destroy(s_lines[i]);
    s_lines[i] = NULL;
  }
  scroll_layer_destroy(s_scroll);
  s_scroll = NULL;
  window_destroy(s_window);
  s_window = NULL;
}

static void prv_push(void) {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

void card_window_push_listen(void) {
  prv_push();
  prv_begin_listen();
}

void card_window_push_entry(const HistoryEntry *entry) {
  prv_push();
  s_session_active = false;
  prv_show_result(entry->title, entry->artist, entry->album);
}

void card_window_on_progress(int seconds) {
  if (s_window && s_session_active && s_mode == CardModeListening) {
    prv_update_countdown(seconds);
    prv_layout();
  }
}

void card_window_on_identifying(void) {
  if (s_window && s_session_active && s_mode != CardModeResult) {
    prv_show_identifying();
  }
}

void card_window_on_result(const char *title, const char *artist, const char *album) {
  if (!s_window || !s_session_active) {
    return;
  }
  s_session_active = false;
  prv_show_result(title, artist, album);
  vibes_short_pulse();
  light_enable_interaction();
}

void card_window_on_no_match(void) {
  if (!s_window || !s_session_active) {
    return;
  }
  s_session_active = false;
  prv_show_message("No match", "Try again closer to the speaker",
                   fonts_get_system_font(FONT_KEY_GOTHIC_18), "SELECT to listen again");
}

void card_window_on_error(const char *text) {
  if (!s_window || !s_session_active) {
    return;
  }
  s_session_active = false;
  prv_show_message("Error", text, fonts_get_system_font(FONT_KEY_GOTHIC_18),
                   "SELECT to try again");
}
