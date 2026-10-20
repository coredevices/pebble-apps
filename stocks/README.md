# Stocks

*Uses Yahoo Finance's undocumented quote endpoint.*

Share prices for the tickers the user picked in settings. Each ticker is an instance carrying its price, the day's change in cash and the same change as a percentage.

Choose tickers in plugin settings. Build: see the [repository README](../README.md#building).

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `finance/stock`: ticker, name, price, day_change, day_change_percent
