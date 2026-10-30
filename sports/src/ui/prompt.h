#pragma once

bool prompt_is_showing();
void prompt_show(Layer *window_layer, const char *error_message, uint8_t key);
void prompt_hide();
