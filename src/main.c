#include <pebble.h>
#include "sports.h"

int main(void) {
#ifdef PBL_TOUCH
  // Third-party apps are opted out of touch navigation by default, and the
  // firmware only routes touches to window recognizers through it.
  app_touch_navigation_enable(true);
#endif
  sports_init();
  app_event_loop();
  sports_deinit();
}
