#pragma once

#define PROGRESS_LAYER_WINDOW_DELTA 33
#define PROGRESS_LAYER_WINDOW_WIDTH 80

void win_splash_init(void);
void win_splash_push(void);
void win_splash_pop(void);
void win_splash_deinit(void);
void win_splash_increment_progress(int16_t progress);
void win_splash_set_progress(int16_t progress_percent);
void win_splash_no_internet_prompt();
