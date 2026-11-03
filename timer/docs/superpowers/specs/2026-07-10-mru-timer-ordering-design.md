# Most-recently-used timer floats to the top

**Date:** 2026-07-10

## Goal

In the timer list, show the most recently used timer at the top, so the timer
the user keeps reaching for is always easy to find.

## Order

Two tiers:

1. **Running timers**, most recently used first.
2. **Paused timers**, most recently used first.

So an active timer always sits above every paused one, and within each group the
one you touched most recently is on top.

## Definition of "used"

A timer is "used" whenever its `last_update` timestamp changes. `last_update`
is already maintained by `countdown_timer.c` and is set on:

- **start / restart** (`countdown_timer_start`)
- **pause / stop** (`countdown_timer_stop`)
- **edit / duration change** (`countdown_timer_update`)

We deliberately reuse the existing field rather than adding a dedicated
"last started" field. Consequence, accepted by the user: pausing or editing a
timer also floats it to the top, not just starting it.

## Approach

Keep the in-memory timer array `s_countdown_timers[]` sorted by `last_update`
descending. The menu already draws timers in array order and gets each one
through the `get_timer` callback, so a sorted array is all that's needed — no
changes to the menu, the click handler, or the persisted data layout.

Rejected alternative: adding a new `last_started` struct field. This would grow
`sizeof(CountdownTimer)`, and the persistence loader rejects any blob whose size
does not match (`countdown_timer.c` size check), so every user would lose their
saved timers on upgrade.

## Changes

All in `src/main.c`:

1. **New static helper `prv_sort_timers_by_recency(void)`** — an insertion sort
   over the (at most 8) pointers in `s_countdown_timers[]`, ordering by
   `countdown_timer_get_last_update()` descending. Uses the existing public
   accessor, so the `CountdownTimer` struct stays opaque.

2. **Sort after loading** — call it in `initialize()` right after
   `countdown_timer_list_load(...)`, so the restored list opens in MRU order.

3. **Sort after each mutation** — call it at the end of the callbacks that
   change a timer's state:
   - `setting_window_complete_callback` (new timer create, and edit)
   - `detail_window_playpause_timer_callback` (start and pause)
   - `popup_window_snooze_timer_callback` (snooze restart)

   Delete needs no sort: removing a timer does not change the relative order of
   the rest.

## Why no extra menu reload is needed

Starts/edits/snoozes all happen from the detail, setting, or popup screens —
never while the menu is the top window. When the user backs out to the menu, it
is re-rendered and `menu_draw_row_callback` reads the now-sorted array, so the
new order appears on return. The create and delete paths already call
`menu_window_reload_data`.

## Out of scope

- Merely *opening* a timer to view it (without starting) does not reorder it —
  viewing does not touch `last_update`.
- No change to persistence format, wakeup scheduling, app glance, or timeline
  pins; those iterate the whole array and are order-independent.

## Testing

- Build for basalt and run in the emulator.
- Create three timers A, B, C. Confirm newest is on top.
- Open and start the bottom timer; back out — it is now on top.
- Pause it; it drops below the still-running timers but stays above any other
  paused timer.
- Kill and relaunch the app; confirm the list reopens with running timers on top
  (most recent first), then paused timers (most recent first).
