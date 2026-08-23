#include <pebble.h>
#include <pebble-assist.h>
#include "generated/appinfo.h"
#include "generated/keys.h"
#include "card.h"
#include "windows/win-card.h"
#include "espn.h"

static CardData *s_data = NULL;

void card_init(void) {
  s_data = malloc(sizeof(CardData));

  strncpy(s_data->league, "", sizeof(s_data->league));
  strncpy(s_data->subtitle, "", sizeof(s_data->subtitle));
  strncpy(s_data->broadcaster, "", sizeof(s_data->broadcaster));
  strncpy(s_data->nameAway, "", sizeof(s_data->nameAway));
  strncpy(s_data->nameHome, "", sizeof(s_data->nameHome));
#ifndef LOW_MEM
  strncpy(s_data->rankAway, "", sizeof(s_data->rankAway));
  strncpy(s_data->rankHome, "", sizeof(s_data->rankHome));
#endif
  strncpy(s_data->recordAway, "", sizeof(s_data->recordAway));
  strncpy(s_data->recordHome, "", sizeof(s_data->recordHome));
  strncpy(s_data->scoreAway, "", sizeof(s_data->scoreAway));
  strncpy(s_data->scoreHome, "", sizeof(s_data->scoreHome));

  win_card_init();
}

void card_deinit(void) {
  win_card_deinit();
  free_safe(s_data);
}

void card_in_received_handler(DictionaryIterator *iter) {
  Tuple *tuple = dict_find(iter, APP_KEY_METHOD);
  if (!tuple) return;
  switch (tuple->value->uint8) {
    case KEY_METHOD_DATA: {
      tuple = dict_find(iter, APP_KEY_LEAGUE);
      if (tuple) {
        strncpy(s_data->league, tuple->value->cstring, sizeof(s_data->league) - 1);
      }

      tuple = dict_find(iter, APP_KEY_SUBTITLE);
      if (tuple) {
        strncpy(s_data->subtitle, tuple->value->cstring, sizeof(s_data->subtitle) - 1);
      }

      tuple = dict_find(iter, APP_KEY_BROADCASTER);
      if (tuple) {
        strncpy(s_data->broadcaster, tuple->value->cstring, sizeof(s_data->broadcaster) - 1);
      }

      tuple = dict_find(iter, APP_KEY_NAMEAWAY);
      if (tuple) {
        strncpy(s_data->nameAway, tuple->value->cstring, sizeof(s_data->nameAway) - 1);
      }

      tuple = dict_find(iter, APP_KEY_NAMEHOME);
      if (tuple) {
        strncpy(s_data->nameHome, tuple->value->cstring, sizeof(s_data->nameHome) - 1);
      }
#ifndef LOW_MEM
      tuple = dict_find(iter, APP_KEY_RANKAWAY);
      if (tuple) {
        strncpy(s_data->rankAway, tuple->value->cstring, sizeof(s_data->rankAway) - 1);
      }

      tuple = dict_find(iter, APP_KEY_RANKHOME);
      if (tuple) {
        strncpy(s_data->rankHome, tuple->value->cstring, sizeof(s_data->rankHome) - 1);
      }
#endif
      tuple = dict_find(iter, APP_KEY_RECORDAWAY);
      if (tuple) {
        strncpy(s_data->recordAway, tuple->value->cstring, sizeof(s_data->recordAway) - 1);
      }

      tuple = dict_find(iter, APP_KEY_RECORDHOME);
      if (tuple) {
        strncpy(s_data->recordHome, tuple->value->cstring, sizeof(s_data->recordHome) - 1);
      }

      tuple = dict_find(iter, APP_KEY_SCOREAWAY);
      if (tuple) {
        strncpy(s_data->scoreAway, tuple->value->cstring, sizeof(s_data->scoreAway) - 1);
      }

      tuple = dict_find(iter, APP_KEY_SCOREHOME);
      if (tuple) {
        strncpy(s_data->scoreHome, tuple->value->cstring, sizeof(s_data->scoreHome) - 1);
      }

      tuple = dict_find(iter, APP_KEY_GAMESTATE);
      if (tuple) {
        s_data->gameState = tuple->value->uint8;
      }

      tuple = dict_find(iter, APP_KEY_SUBSCRIBEDAWAY);
      if (tuple) {
        s_data->subscribedAway = tuple->value->uint8;
      }

      tuple = dict_find(iter, APP_KEY_SUBSCRIBEDHOME);
      if (tuple) {
        s_data->subscribedHome = tuple->value->uint8;
      }

      tuple = dict_find(iter, APP_KEY_LEADCHANGE);
      if (tuple && tuple->value->uint8 && espn_get_buzz_on() && win_card_is_loaded()) {
        vibes_short_pulse();
      }

      win_card_set_progress(100);

      win_card_mark_dirty();
      break;
    }
  }
}

CardData *card_get_data() {
  CardData *data = espn_get_card_data(espn_get_selected_card());
  return data != NULL ? data : s_data;
}
