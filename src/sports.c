#include <pebble.h>
#include <libs/pebble-assist.h>
// #include "generated/appinfo.h"
#include "generated/keys.h"
#include "sports.h"
#include "card.h"
#include "windows/win-splash.h"
#include "windows/win-leagues.h"
#include "windows/win-games.h"
#include "windows/win-card.h"
#include "windows/win-actions.h"
#include "windows/win-pins.h"
#include "ui/prompt.h"
#include "analytics.h"

static LeagueData s_leagues[] = {
  { .title = "TIMELINE"},
  { .title = "NFL"},
  { .title = "MLB"},
  { .title = "NHL"},
  { .title = "NBA"},
  { .title = "WNBA"},
  { .title = "NCAAF"},
  { .title = "NCAAM"},
  { .title = "NCAAW"},
  { .title = "Premier League"},
};

static void in_received_handler(DictionaryIterator *iter, void *context);
static void out_failed_handler(DictionaryIterator *failed, AppMessageResult reason, void *context);

static void schedule_timeline_refresh();

// Heap kept free after a league's games are allocated. On aplite that happens
// with the games list already open, so this covers the game card and action
// menu opened on top of it: about 1.6 KB, measured in the emulator.
#define HEAP_RESERVE_BYTES 2048

static uint16_t s_selected_league = 0;

#ifdef LOW_MEM
// Aplite cannot hold every league's games at once: a busy week overran its
// heap and crashed the leagues window. The phone sends only each league's
// count at launch, and a league's games are requested when it is opened and
// freed when another one is. s_loaded_league is the one whose games are held,
// NO_LEAGUE until the first is opened.
#define NO_LEAGUE UINT16_MAX
static uint16_t s_loaded_league = NO_LEAGUE;
#define LEAGUE_REQUEST_RETRY_MS 100
static void send_league_request(void *context);
#endif
static bool s_loading = false;
static uint16_t s_selected_card = 0;

static bool s_buzz_on = true;
static bool s_has_teams = false;

void sports_init(void) {
  app_message_register_inbox_received(in_received_handler);
  app_message_register_outbox_failed(out_failed_handler);
  app_message_open(512, 256);
  win_splash_init();
  win_pins_init();

  s_leagues[KEY_LEAGUE_FAVS].icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_FAVS);
  s_leagues[KEY_LEAGUE_MLB].icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_BASEBALL);
  s_leagues[KEY_LEAGUE_NHL].icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_HOCKEY);
  s_leagues[KEY_LEAGUE_NFL].icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_FOOTBALL);
  s_leagues[KEY_LEAGUE_NBA].icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_BASKETBALL);
  s_leagues[KEY_LEAGUE_EPL].icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_SOCCER);

#ifdef PBL_COLOR
  s_leagues[KEY_LEAGUE_FAVS].card_icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_FAVS_RED);
  s_leagues[KEY_LEAGUE_MLB].card_icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_BASEBALL_RED);
  s_leagues[KEY_LEAGUE_NHL].card_icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_HOCKEY_RED);
  s_leagues[KEY_LEAGUE_NFL].card_icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_FOOTBALL_RED);
  s_leagues[KEY_LEAGUE_NBA].card_icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_BASKETBALL_RED);
  s_leagues[KEY_LEAGUE_EPL].card_icon = gbitmap_create_with_resource(RESOURCE_ID_ICON_SOCCER_RED);
#endif

  if (persist_exists(KEY_PERSIST_BUZZON)) {
    s_buzz_on = persist_read_bool(KEY_PERSIST_BUZZON);
  }

  if (persist_exists(KEY_PERSIST_HASTEAMS)) {
    s_has_teams = persist_read_bool(KEY_PERSIST_HASTEAMS);
  }

  win_leagues_init();
  win_games_init();
  card_init();
// #ifndef LOW_MEM
  win_actions_init();
// #endif

  switch (launch_reason()) {
    case APP_LAUNCH_WAKEUP:
      win_pins_push();
      break;
    case APP_LAUNCH_TIMELINE_ACTION:
      win_card_push();
      break;

    default:
      win_splash_push();
      break;
  }
}

void sports_deinit(void) {
  persist_write_bool(KEY_PERSIST_BUZZON, s_buzz_on);
  persist_write_bool(KEY_PERSIST_HASTEAMS, s_has_teams);
// #ifndef LOW_MEM
  win_actions_deinit();
// #endif
  win_splash_deinit();
  win_pins_deinit();
  card_deinit();
  win_leagues_deinit();
  win_games_deinit();
  for (int i = 0; i < sports_get_num_leagues(); i++) {
    gbitmap_destroy_safe(s_leagues[i].icon);
    gbitmap_destroy_safe(s_leagues[i].card_icon);
  }
  for (int i = 0; i < sports_get_num_leagues(); i++) {
    free_safe(s_leagues[i].cards);
  }
}

static void in_received_handler(DictionaryIterator *iter, void *context) {
  Tuple *tuple = dict_find(iter, MESSAGE_KEY_type);
  if (!tuple) return;
  switch (tuple->value->uint8) {
    case KEY_TYPE_CHECKCONFIG:
      if (!persist_read_bool(KEY_PERSIST_CONFIG_STATUS)) {
        prompt_hide();
      }
      persist_write_bool(KEY_PERSIST_CONFIG_STATUS, true);
      break;

    case KEY_TYPE_MARKDIRTY:
      win_games_mark_dirty();
      win_leagues_mark_dirty();
      break;

    case KEY_TYPE_NOCONNECTION:
      win_splash_no_internet_prompt();
      break;

    case KEY_TYPE_READY: {
      if (launch_reason() == APP_LAUNCH_WAKEUP) {
        timeline_refresh();
      } else if (launch_reason() == APP_LAUNCH_TIMELINE_ACTION) {
        sports_request_card();
        win_card_increment_progress(60);
      } else {
        app_comm_set_sniff_interval(SNIFF_INTERVAL_REDUCED);
        sports_request_cards();
        win_splash_increment_progress(20);
      }
      break;
    }

    case KEY_TYPE_LOADED:
      app_comm_set_sniff_interval(SNIFF_INTERVAL_NORMAL);
      if (sports_get_num_cards() > 0) {
        win_games_set_selected_card(1);
      }
      win_splash_set_progress(100);
      win_leagues_push();
      win_splash_pop();
      win_splash_deinit();
      timeline_refresh();
      analytics_set_screen(SCREEN_LEAGUES, BUTTON_ID_SELECT);
      break;

    case KEY_TYPE_CARD:
      card_in_received_handler(iter);
      break;

    case KEY_TYPE_PIN:
      tuple = dict_find(iter, MESSAGE_KEY_method);
      if (!tuple) break;
      switch (tuple->value->uint8) {
        case KEY_METHOD_SIZE: {
          if (win_pins_is_loaded()) {
            tuple = dict_find(iter, MESSAGE_KEY_index);
            if (!tuple) break;
            // uint16_t idx = tuple->value->uint16;
            tuple = dict_find(iter, MESSAGE_KEY_count);
            if (!tuple) break;
            uint16_t count = tuple->value->uint16;
            win_pins_increment_progress(100 / count);
            break;
          }
          break;
        };
        case KEY_METHOD_END: {
          if (win_pins_is_loaded()) {
            win_pins_set_progress(100);
            win_pins_pop();
            break;
          }
          break;
        }
        break;
      }
      break;

    case KEY_TYPE_LEAGUE: {
      tuple = dict_find(iter, MESSAGE_KEY_method);
      if (!tuple) break;
      switch (tuple->value->uint8) {
        case KEY_METHOD_SIZE: {
          tuple = dict_find(iter, MESSAGE_KEY_index);
          if (!tuple) break;
          uint16_t idx = tuple->value->uint16;
          tuple = dict_find(iter, MESSAGE_KEY_count);
          if (!tuple) break;
          if (idx >= sports_get_num_leagues()) break;
          free_safe(s_leagues[idx].cards);
          s_leagues[idx].num_cards = 0;
          s_leagues[idx].num_games = tuple->value->uint16;
#ifdef LOW_MEM
          if (idx != s_loaded_league) break;
#endif
          // Backstop: keep only as many games as fit while leaving
          // HEAP_RESERVE_BYTES for the windows, so no slate can exhaust the
          // heap and fail a window's create. Games past that are dropped; DATA
          // messages for them are ignored below. Zeroed so a row drawn before
          // its DATA arrives shows blanks rather than garbage.
          uint16_t count = tuple->value->uint16;
          const size_t heap_free = heap_bytes_free();
          const size_t fit = heap_free > HEAP_RESERVE_BYTES ?
                             (heap_free - HEAP_RESERVE_BYTES) / sizeof(CardData) : 0;
          if (count > fit) count = fit;
          s_leagues[idx].cards = count ? calloc(count, sizeof(CardData)) : NULL;
          s_leagues[idx].num_cards = s_leagues[idx].cards ? count : 0;
          break;
        }
        case KEY_METHOD_DATA: {
          tuple = dict_find(iter, MESSAGE_KEY_leagueIndex);
          if (!tuple) break;
          uint16_t league = tuple->value->uint16;

          if (league == KEY_LEAGUE_FAVS && !s_has_teams) {
            s_has_teams = true;
          }

          tuple = dict_find(iter, MESSAGE_KEY_index);
          if (!tuple) break;
          uint16_t idx = tuple->value->uint16;

          // Also covers a league whose SIZE was capped or failed to allocate.
          if (league >= sports_get_num_leagues() || idx >= s_leagues[league].num_cards) {
            break;
          }
          CardData *data = &s_leagues[league].cards[idx];

          tuple = dict_find(iter, MESSAGE_KEY_id);
          if (tuple) {
            data->id = tuple->value->int32;
          }

          tuple = dict_find(iter, MESSAGE_KEY_league);
          if (tuple) {
            strncpy(data->league, tuple->value->cstring, sizeof(data->league) - 1);
          }

          tuple = dict_find(iter, MESSAGE_KEY_subtitle);
          if (tuple) {
            strncpy(data->subtitle, tuple->value->cstring, sizeof(data->subtitle) - 1);
          }

          tuple = dict_find(iter, MESSAGE_KEY_broadcaster);
          if (tuple) {
            strncpy(data->broadcaster, tuple->value->cstring, sizeof(data->broadcaster) - 1);
          }

          tuple = dict_find(iter, MESSAGE_KEY_nameAway);
          if (tuple) {
            strncpy(data->nameAway, tuple->value->cstring, sizeof(data->nameAway) - 1);
          }

          tuple = dict_find(iter, MESSAGE_KEY_nameHome);
          if (tuple) {
            strncpy(data->nameHome, tuple->value->cstring, sizeof(data->nameHome) - 1);
          }
#ifndef LOW_MEM
          tuple = dict_find(iter, MESSAGE_KEY_rankAway);
          if (tuple) {
            strncpy(data->rankAway, tuple->value->cstring, sizeof(data->rankAway) - 1);
          }

          tuple = dict_find(iter, MESSAGE_KEY_rankHome);
          if (tuple) {
            strncpy(data->rankHome, tuple->value->cstring, sizeof(data->rankHome) - 1);
          }
#endif
          tuple = dict_find(iter, MESSAGE_KEY_recordAway);
          if (tuple) {
            strncpy(data->recordAway, tuple->value->cstring, sizeof(data->recordAway) - 1);
          }

          tuple = dict_find(iter, MESSAGE_KEY_recordHome);
          if (tuple) {
            strncpy(data->recordHome, tuple->value->cstring, sizeof(data->recordHome) - 1);
          }

          tuple = dict_find(iter, MESSAGE_KEY_scoreAway);
          if (tuple) {
            strncpy(data->scoreAway, tuple->value->cstring, sizeof(data->scoreAway) - 1);
          }

          tuple = dict_find(iter, MESSAGE_KEY_scoreHome);
          if (tuple) {
            strncpy(data->scoreHome, tuple->value->cstring, sizeof(data->scoreHome) - 1);
          }

          tuple = dict_find(iter, MESSAGE_KEY_gameState);
          if (tuple) {
            data->gameState = tuple->value->uint8;
          }

          tuple = dict_find(iter, MESSAGE_KEY_subscribedAway);
          if (tuple) {
            data->subscribedAway = tuple->value->uint8;
          }

          tuple = dict_find(iter, MESSAGE_KEY_subscribedHome);
          if (tuple) {
            data->subscribedHome = tuple->value->uint8;
          }

          tuple = dict_find(iter, MESSAGE_KEY_leadChange);
          if (tuple && tuple->value->uint8 && s_buzz_on && win_card_is_loaded()) {
            vibes_short_pulse();
          }

          win_leagues_mark_dirty();
          win_card_mark_dirty();
          break;
        }
        case KEY_METHOD_END: {
          win_splash_increment_progress(80 / sports_get_num_leagues());
          tuple = dict_find(iter, MESSAGE_KEY_index);
          if (s_loading && tuple && tuple->value->uint16 == s_selected_league) {
            s_loading = false;
            win_games_mark_dirty();
          }
          break;
        }
      }
      break;
    }
  }
}

static void out_failed_handler(DictionaryIterator *failed, AppMessageResult reason, void *context) {
  LOG("outbox_failed: %d", reason);
#ifdef LOW_MEM
  Tuple *method = dict_find(failed, MESSAGE_KEY_method);
  if (method && method->value->uint8 == KEY_METHOD_REQUESTLEAGUE) {
    app_timer_register(LEAGUE_REQUEST_RETRY_MS, send_league_request, NULL);
  }
#endif
}

void sports_request_cards() {
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  dict_write_uint8(iter, MESSAGE_KEY_method, KEY_METHOD_REQUESTCARDS);
#ifdef LOW_MEM
  dict_write_uint8(iter, MESSAGE_KEY_lazy, 1);
#endif
  dict_write_end(iter);
  app_message_outbox_send();
}

#ifdef LOW_MEM
// Opening a league also sends a screen-change analytics message, so the outbox
// is usually still busy when the request is made. Retry until it goes out, and
// again if it fails to deliver (out_failed_handler); a dropped request would
// leave the games list on LOADING.
static void send_league_request(void *context) {
  if (!s_loading) {
    return;
  }
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    app_timer_register(LEAGUE_REQUEST_RETRY_MS, send_league_request, NULL);
    return;
  }
  dict_write_uint8(iter, MESSAGE_KEY_method, KEY_METHOD_REQUESTLEAGUE);
  dict_write_uint16(iter, MESSAGE_KEY_index, s_loaded_league);
  dict_write_end(iter);
  if (app_message_outbox_send() != APP_MSG_OK) {
    app_timer_register(LEAGUE_REQUEST_RETRY_MS, send_league_request, NULL);
  }
}
#endif

void sports_request_card() {
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  dict_write_uint8(iter, MESSAGE_KEY_method, KEY_METHOD_REQUESTCARD);
  dict_write_uint32(iter, MESSAGE_KEY_id, launch_get_args());
  if (card_get_data() != NULL) {
    dict_write_cstring(iter, MESSAGE_KEY_scoreAway, card_get_data()->scoreAway);
    dict_write_cstring(iter, MESSAGE_KEY_scoreHome, card_get_data()->scoreHome);
  }
  dict_write_end(iter);
  app_message_outbox_send();
}

void sports_request_game() {
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  dict_write_uint8(iter, MESSAGE_KEY_method, KEY_METHOD_REQUESTGAME);
  dict_write_uint32(iter, MESSAGE_KEY_id, card_get_data()->id);
  dict_write_uint16(iter, MESSAGE_KEY_leagueIndex, s_selected_league);
  dict_write_uint16(iter, MESSAGE_KEY_index, s_selected_card);
  dict_write_cstring(iter, MESSAGE_KEY_scoreAway, card_get_data()->scoreAway);
  dict_write_cstring(iter, MESSAGE_KEY_scoreHome, card_get_data()->scoreHome);
  dict_write_end(iter);
  app_message_outbox_send();
}

#ifdef PBL_RECT
static bool sports_is_NCAA(uint16_t section) {
  return (section == KEY_LEAGUE_NCAAF ||
          section == KEY_LEAGUE_NCAAM ||
          section == KEY_LEAGUE_NCAAW);
}
#endif

void timeline_refresh() {
  // This can be called while another message is still going out, and iter is
  // unset unless outbox_begin succeeds.
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
  dict_write_uint8(iter, MESSAGE_KEY_method, KEY_METHOD_REQUESTPINS);
  dict_write_end(iter);
  app_message_outbox_send();
}

void timeline_add(const char *team, uint32_t id) {
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  dict_write_uint8(iter, MESSAGE_KEY_method, KEY_METHOD_SUBSCRIBE);
  dict_write_cstring(iter, MESSAGE_KEY_title, team);
  dict_write_uint32(iter, MESSAGE_KEY_id, id);
  dict_write_end(iter);
  app_message_outbox_send();
}

void timeline_remove(const char *team, uint32_t id) {
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  dict_write_uint8(iter, MESSAGE_KEY_method, KEY_METHOD_UNSUBSCRIBE);
  dict_write_cstring(iter, MESSAGE_KEY_title, team);
  dict_write_uint32(iter, MESSAGE_KEY_gameState, id);
  dict_write_end(iter);
  app_message_outbox_send();
}

uint16_t sports_get_num_leagues() {
  return ARRAY_LENGTH(s_leagues);
}

uint16_t sports_get_selected_league() {
  return s_selected_league;
}

void sports_set_selected_league(const uint16_t idx) {
  analytics_set_screen(idx, BUTTON_ID_SELECT);
  s_selected_league = idx;
#ifdef LOW_MEM
  if (idx != s_loaded_league && idx < sports_get_num_leagues()) {
    if (s_loaded_league < sports_get_num_leagues()) {
      free_safe(s_leagues[s_loaded_league].cards);
      s_leagues[s_loaded_league].num_cards = 0;
    }
    s_loaded_league = idx;
    s_loading = true;
    send_league_request(NULL);
  }
#endif
}

const char* sports_get_league_title(const uint16_t idx) {
#ifdef PBL_RECT
  static char title[16];
  if (sports_is_NCAA(idx)) {
    snprintf(title, sizeof(title) / sizeof(char), "%s Top 25", s_leagues[idx].title);
    return title;
  }
#endif
  return idx < sports_get_num_leagues() ? s_leagues[idx].title : "";
}

const char* sports_get_league_subtitle(const uint16_t idx) {
  if (idx >= sports_get_num_leagues()) {
    return "";
  }
  static char subtitle[16];
  snprintf(subtitle, sizeof(subtitle), "%d %s", s_leagues[idx].num_games,
      (s_leagues[idx].num_games == 1 ? "Game" : "Games"));
  return subtitle;
}

int get_icon_index(const int idx) {
  if (idx == KEY_LEAGUE_NCAAF) {
    return KEY_LEAGUE_NFL;
  } else if (idx == KEY_LEAGUE_WNBA || idx == KEY_LEAGUE_NCAAM || idx == KEY_LEAGUE_NCAAW) {
    return KEY_LEAGUE_NBA;
  } else {
    return idx;
  }
}

GBitmap* sports_get_selected_card_icon() {
  return PBL_IF_BW_ELSE(s_leagues[get_icon_index(s_selected_league)].icon,
                        s_leagues[get_icon_index(s_selected_league)].card_icon);
}

GBitmap* sports_get_league_icon(const uint16_t idx) {
  return s_leagues[get_icon_index(idx)].icon;
}

CardData* sports_get_card_data(const uint16_t idx) {
  return idx < sports_get_num_cards() ? &s_leagues[s_selected_league].cards[idx] : NULL;
}

uint16_t sports_get_num_cards() {
  // None until the league's END, so the games list never draws a row whose
  // DATA has not arrived yet.
  return s_loading ? 0 : s_leagues[s_selected_league].num_cards;
}

// True between opening a league on aplite and the phone finishing its games.
bool sports_is_loading() {
  return s_loading;
}

uint16_t sports_get_selected_card() {
  return s_selected_card;
}

void sports_set_selected_card(const uint16_t idx) {
  if (idx < sports_get_num_cards()) {
    s_selected_card = idx;
    win_games_set_selected_card(idx);
  }
}

bool sports_get_buzz_on() {
  return s_buzz_on;
}

void sports_set_buzz_on(bool on) {
  s_buzz_on = on;
  analytics_send_buzz_analytics(s_buzz_on);
}

bool sports_get_has_teams() {
  return s_has_teams;
}
