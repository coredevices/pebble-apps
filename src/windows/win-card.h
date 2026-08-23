#pragma once

void win_card_init(void);
void win_card_push(void);
void win_card_deinit(void);
void win_card_mark_dirty(void);
bool win_card_is_loaded(void);
void win_card_increment_progress(int16_t progress);
void win_card_set_progress(int16_t progress_percent);
