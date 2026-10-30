/* SPDX-FileCopyrightText: 2026 Core Devices LLC */
/* SPDX-License-Identifier: Apache-2.0 */

#pragma once

#include <pebble.h>

// Shared definitions for the What's Playing watchapp.
//
// The C side is deliberately small: main.c owns AppMessage and the history
// mirror, menu_window.c is the launch screen, card_window.c does the listen /
// identify / result flow and is the only file that touches the microphone API.

#define HISTORY_MAX 10
#define TITLE_LEN 64
#define ARTIST_LEN 48
#define ALBUM_LEN 48

#define LISTEN_SECONDS 10
#define MIN_LISTEN_SECONDS 3

typedef struct HistoryEntry {
  char title[TITLE_LEN];
  char artist[ARTIST_LEN];
  char album[ALBUM_LEN];
} HistoryEntry;

// Values of the CMD message key. Keep in sync with src/pkjs/index.js.
typedef enum Cmd {
  CmdHello = 1,        // watch -> phone: please (re)send the history
  CmdHistory = 2,      // phone -> watch: one history row (INDEX, TOTAL, TITLE, ARTIST, ALBUM)
  CmdProgress = 3,     // phone -> watch: SECONDS of audio received so far
  CmdIdentifying = 4,  // phone -> watch: the HTTP request is in flight
  CmdResult = 5,       // phone -> watch: TITLE, ARTIST, ALBUM of a match
  CmdNoMatch = 6,      // phone -> watch: the service returned result = null
  CmdError = 7,        // phone -> watch: ERROR text to show
} Cmd;

// History mirror (main.c). Newest entry first.
int history_count(void);
const HistoryEntry *history_get(int index);

// Menu window (menu_window.c)
void menu_window_push(void);
void menu_window_refresh(void);

// Card window (card_window.c)
void card_window_push_listen(void);
void card_window_push_entry(const HistoryEntry *entry);
void card_window_on_progress(int seconds);
void card_window_on_identifying(void);
void card_window_on_result(const char *title, const char *artist, const char *album);
void card_window_on_no_match(void);
void card_window_on_error(const char *text);
