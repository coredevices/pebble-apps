// Google Home watchapp: shared constants and module interfaces.
// CMD, OP, KIND, FLAG and MODE values are mirrored in src/pkjs/index.js.
#pragma once
#include <pebble.h>

#define MAX_DEVICES 48

enum { CMD_HELLO = 1, CMD_DEVICE = 2, CMD_ACT = 3, CMD_TOAST = 4 };
enum { OP_POWER = 1, OP_BRIGHT, OP_CTEMP, OP_VOLUME, OP_SETPT, OP_MODE, OP_LOCK, OP_FAV };
enum { KIND_GENERIC, KIND_LIGHT, KIND_OUTLET, KIND_SWITCH, KIND_THERMOSTAT, KIND_LOCK, KIND_SPEAKER, KIND_TV, KIND_FAN };
enum {
  FLAG_ON = 1, FLAG_ONLINE = 2, FLAG_FAV = 4, FLAG_CAN_POWER = 8, FLAG_CAN_BRIGHT = 16,
  FLAG_CAN_CTEMP = 32, FLAG_CAN_VOLUME = 64, FLAG_CAN_LOCK = 128, FLAG_CAN_THERMO = 256,
  FLAG_LOCKED = 512, FLAG_FAHRENHEIT = 1024,
};
enum { MODE_UNKNOWN, MODE_OFF, MODE_HEAT, MODE_COOL, MODE_ECO, MODE_AUTO };

typedef struct {
  int32_t key;    // hash of the phone's device id; actions name it, not the row index
  char name[24];
  char room[20];
  char status[28];
  uint8_t kind;
  uint8_t mode;
  uint16_t flags;
  uint8_t bright;
  uint8_t volume;
  uint16_t ctemp;
  int16_t setpt;  // tenths of a degree, in the unit FLAG_FAHRENHEIT says
} Device;

// main.c
extern Device g_devices[MAX_DEVICES];
extern int g_count;           // -1 while loading
extern char g_message[64];    // shown when g_count <= 0
void send_action(int key, int op, int value);
int device_index_of_key(int key);  // -1 when the list no longer has it
const char *mode_label(int mode);
void format_degrees(char *buf, size_t size, int tenths, bool fahrenheit);

// theme
#define BG_COLOR PBL_IF_COLOR_ELSE(GColorBlack, GColorBlack)
#define HILITE_COLOR PBL_IF_COLOR_ELSE(GColorDarkGray, GColorWhite)
#define DIM_COLOR PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite)

// icons.c
GColor kind_accent(const Device *d);
void draw_device_badge(GContext *ctx, GPoint center, int radius, const Device *d, bool highlighted);
void draw_star(GContext *ctx, GPoint center, int radius, bool filled, GColor color);

// list.c
void list_window_push(void);
void list_reload(void);
void list_toast(const char *text);
void list_toast_detach(void);  // call before a window showing the toast is destroyed

// detail.c
void detail_window_push(int index);
void detail_reload(void);
