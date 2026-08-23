#include <pebble.h>
#include "espn.h"

int main(void) {
  espn_init();
  app_event_loop();
  espn_deinit();
}
