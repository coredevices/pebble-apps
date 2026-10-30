/* SPDX-FileCopyrightText: 2026 Core Devices LLC */
/* SPDX-License-Identifier: Apache-2.0 */

#include "whatsplaying.h"

// ---------------------------------------------------------------------------
// History mirror
// ---------------------------------------------------------------------------

static HistoryEntry s_history[HISTORY_MAX];
static int s_history_count;

int history_count(void) {
  return s_history_count;
}

const HistoryEntry *history_get(int index) {
  if (index < 0 || index >= s_history_count) {
    return NULL;
  }
  return &s_history[index];
}

// ---------------------------------------------------------------------------
// AppMessage
// ---------------------------------------------------------------------------

static void prv_copy_string(char *dst, size_t dst_len, const DictionaryIterator *iter,
                            uint32_t key) {
  const Tuple *tuple = dict_find(iter, key);
  if (tuple && tuple->type == TUPLE_CSTRING && tuple->length > 0) {
    strncpy(dst, tuple->value->cstring, dst_len - 1);
    dst[dst_len - 1] = '\0';
  } else {
    dst[0] = '\0';
  }
}

static int prv_get_int(const DictionaryIterator *iter, uint32_t key, int fallback) {
  const Tuple *tuple = dict_find(iter, key);
  return tuple ? (int)tuple->value->int32 : fallback;
}

static void prv_handle_history_row(const DictionaryIterator *iter) {
  const int index = prv_get_int(iter, MESSAGE_KEY_INDEX, -1);
  int total = prv_get_int(iter, MESSAGE_KEY_TOTAL, 0);
  if (total > HISTORY_MAX) {
    total = HISTORY_MAX;
  }
  if (total <= 0) {
    s_history_count = 0;
  } else if (index >= 0 && index < HISTORY_MAX) {
    HistoryEntry *entry = &s_history[index];
    prv_copy_string(entry->title, sizeof(entry->title), iter, MESSAGE_KEY_TITLE);
    prv_copy_string(entry->artist, sizeof(entry->artist), iter, MESSAGE_KEY_ARTIST);
    prv_copy_string(entry->album, sizeof(entry->album), iter, MESSAGE_KEY_ALBUM);
    s_history_count = total;
  }
  menu_window_refresh();
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  const int cmd = prv_get_int(iter, MESSAGE_KEY_CMD, 0);
  switch (cmd) {
    case CmdHistory:
      prv_handle_history_row(iter);
      break;
    case CmdProgress:
      card_window_on_progress(prv_get_int(iter, MESSAGE_KEY_SECONDS, 0));
      break;
    case CmdIdentifying:
      card_window_on_identifying();
      break;
    case CmdResult: {
      char title[TITLE_LEN], artist[ARTIST_LEN], album[ALBUM_LEN];
      prv_copy_string(title, sizeof(title), iter, MESSAGE_KEY_TITLE);
      prv_copy_string(artist, sizeof(artist), iter, MESSAGE_KEY_ARTIST);
      prv_copy_string(album, sizeof(album), iter, MESSAGE_KEY_ALBUM);
      card_window_on_result(title, artist, album);
      break;
    }
    case CmdNoMatch:
      card_window_on_no_match();
      break;
    case CmdError: {
      char text[64];
      prv_copy_string(text, sizeof(text), iter, MESSAGE_KEY_ERROR);
      card_window_on_error(text[0] ? text : "Unknown error");
      break;
    }
    default:
      APP_LOG(APP_LOG_LEVEL_WARNING, "Unknown CMD %d", cmd);
      break;
  }
}

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Inbox dropped: %d", reason);
}

// The watch only ever sends one message: a hello asking pkjs for the history.
// pkjs also sends the history on its own `ready`, so this just covers the case
// where JS came up before the watch app opened AppMessage.

#define HELLO_MAX_ATTEMPTS 5

static int s_hello_attempts;
static AppTimer *s_hello_timer;

static void prv_send_hello(void *context) {
  s_hello_timer = NULL;
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    return;
  }
  dict_write_int32(iter, MESSAGE_KEY_CMD, CmdHello);
  s_hello_attempts++;
  app_message_outbox_send();
}

static void prv_outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Outbox failed: %d", reason);
  if (s_hello_attempts < HELLO_MAX_ATTEMPTS && !s_hello_timer) {
    s_hello_timer = app_timer_register(1000 * s_hello_attempts, prv_send_hello, NULL);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

static void prv_init(void) {
  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  app_message_register_outbox_failed(prv_outbox_failed);
  app_message_open(1024, 64);

  menu_window_push();
  prv_send_hello(NULL);
}

static void prv_deinit(void) {
  if (s_hello_timer) {
    app_timer_cancel(s_hello_timer);
  }
  app_message_deregister_callbacks();
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
