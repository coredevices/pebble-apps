# MET Norway Weather

Weather where the phone is, from the Norwegian Meteorological Institute (api.met.no). One location instance (the phone's current position) and the hours ahead of it.

No setup; uses the phone's location. Build: see the [repository README](../README.md#building).

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `weather/location`: name, temperature, feels_like, high, low, condition, condition_code, uv_index
- `weather/hour`: temperature, condition, condition_code
