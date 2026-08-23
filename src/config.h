#pragma once

#define ESPN_DEFAULT_COLOR GColorVividCerulean

#define IN_APP_CONFIG 0

// Vertical nudge for the status/header strip, shared by win-card's hand-drawn
// status bar and win-games' header TextLayer so the two agree. Both APIs place
// the text *box*, not the ink, so this cancels the font's internal leading
// (GOTHIC_18 leads 7px, GOTHIC_14 leads 5px). Round platforms take a positive
// inset instead, to clear the curved top edge.
//
// Requires pebble.h; include this header after it.
#if (PBL_DISPLAY_HEIGHT >= 200)
#define STATUS_TEXT_OFFSET PBL_IF_RECT_ELSE(-2, 4)
#else
#define STATUS_TEXT_OFFSET PBL_IF_RECT_ELSE(-1, 4)
#endif
