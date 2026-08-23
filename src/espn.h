#pragma once

#include <pebble.h>
#include "card.h"

typedef struct {
  char title[12];
  CardData *cards;
  uint16_t num_cards;
  GBitmap *icon;
  GBitmap *card_icon;
} LeagueData;

void espn_init(void);
void espn_deinit(void);

void espn_request_cards();
void espn_request_card();
void espn_request_game();

void espn_subscribe(const char *topic);
void espn_unsubscribe(const char *topic);

uint16_t espn_get_num_leagues();
uint16_t espn_get_selected_league();
void espn_set_selected_league(const uint16_t idx);

const char* espn_get_league_title(const uint16_t idx);
const char* espn_get_league_subtitle(const uint16_t idx);

GBitmap* espn_get_selected_card_icon();
GBitmap* espn_get_league_icon(const uint16_t idx);

CardData* espn_get_card_data(const uint16_t idx);
uint16_t espn_get_num_cards();

uint16_t espn_get_selected_card();
void espn_set_selected_card(const uint16_t idx);

bool espn_get_buzz_on();
void espn_set_buzz_on(bool on);
bool espn_get_has_teams();
