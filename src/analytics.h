#pragma once

#include <pebble.h>

// ANY CHANGES MUST BE UPDATED THE MAIN JS FILE
typedef enum Screens {
  SCREEN_FAVORITES,
  SCREEN_MLB,
  SCREEN_NHL,
  SCREEN_NFL,
  SCREEN_NBA,
  SCREEN_WNBA,
  SCREEN_NCAAF,
  SCREEN_NCAAM,
  SCREEN_NCAAW,
  SCREEN_LEAGUES,
  SCREEN_GAMECARD,
  SCREEN_NONE
} Screen;

void analytics_send_screen_analytics(uint8_t button_id);
void analytics_send_buzz_analytics(bool buzz_on);
void analytics_set_screen(Screen screen_id, uint8_t button_id);
void analytics_increment_screen_clicks(bool up);
Screen analytics_get_previous_screen();
Screen analytics_get_current_screen();
