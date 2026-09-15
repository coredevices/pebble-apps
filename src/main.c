#include <pebble.h>
#include "espn.h"

int main(void) {
#ifdef PBL_TOUCH
  // Third-party apps are opted out of touch navigation by default, and the
  // firmware only routes touches to window recognizers through it.
  app_touch_navigation_enable(true);
#endif
  espn_init();
  app_event_loop();
  espn_deinit();
}
