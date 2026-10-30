#pragma once

// LOW_MEM macros intorduced for convenience to encapsulate/omit code for the Aplite Platform.
// As there is less memory available on aplite, this is more readable than using the aplite macro.
#if defined(PBL_PLATFORM_APLITE)
#define LOW_MEM
#define IF_LOW_MEM_ELSE(low_mem, other) (low_mem)
#else
#define IF_LOW_MEM_ELSE(low_mem, other) (other)
#endif

typedef struct __attribute__((__packed__)) {
  int32_t id;
  char subtitle[16];
  char recordAway[12];
  char recordHome[12];
  char broadcaster[8];
#ifndef LOW_MEM
  char rankAway[8];
  char rankHome[8];
#endif
  char league[6];
  char nameAway[6];
  char nameHome[6];
  char scoreAway[4];
  char scoreHome[4];
  uint8_t gameState;
  bool subscribedAway;
  bool subscribedHome;
} CardData;

void card_init(void);
void card_deinit(void);
void card_in_received_handler(DictionaryIterator *iter);
CardData *card_get_data();
