#pragma once

#include <pebble.h>
#include "card.h"

typedef struct {
  char title[16];
  CardData *cards;
  // num_cards is what `cards` holds; num_games is the league's full count for
  // the leagues list. They differ on aplite, which holds one league at a time.
  uint16_t num_cards;
  uint16_t num_games;
  GBitmap *icon;
  GBitmap *card_icon;
} LeagueData;

void sports_init(void);
void sports_deinit(void);

void sports_request_cards();
void sports_request_card();
void sports_request_game();

void timeline_refresh();
void timeline_add(const char *team, uint32_t id);
void timeline_remove(const char *team, uint32_t id);

uint16_t sports_get_num_leagues();
uint16_t sports_get_selected_league();
void sports_set_selected_league(const uint16_t idx);

const char* sports_get_league_title(const uint16_t idx);
const char* sports_get_league_subtitle(const uint16_t idx);

GBitmap* sports_get_selected_card_icon();
GBitmap* sports_get_league_icon(const uint16_t idx);

CardData* sports_get_card_data(const uint16_t idx);
uint16_t sports_get_num_cards();
bool sports_is_loading();

uint16_t sports_get_selected_card();
void sports_set_selected_card(const uint16_t idx);

bool sports_get_buzz_on();
void sports_set_buzz_on(bool on);
bool sports_get_has_teams();
