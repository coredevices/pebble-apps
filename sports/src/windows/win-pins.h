#pragma once

void win_pins_init(void);
void win_pins_push(void);
void win_pins_pop(void);
void win_pins_deinit(void);
void win_pins_mark_dirty(void);
bool win_pins_is_loaded(void);
void win_pins_increment_progress(int16_t progress);
void win_pins_set_progress(int16_t progress_percent);