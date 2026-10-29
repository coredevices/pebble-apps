// Stock prices from Yahoo Finance's chart endpoint: no key, no auth, one call per ticker.
//
// Which tickers is entirely the user's choice, made on the settings page, and each one becomes
// an instance of `finance/stock`. Its properties are the facets of one quote — price, the day's
// change in cash, and that change as a percentage — so a watchface shows whichever fits.

var STORE_KEY = 'stocks';
var BLOCKED_KEY = 'stocks.blocked.v1';
var REACH_HOSTS = ['query1.finance.yahoo.com'];
var QUOTE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
var REFRESH_MS = 60 * 1000;
var SOURCES = ['finance/stock'];

var CURRENCY = { USD: '$', GBP: '£', EUR: '€', JPY: '¥' };
// Shown until the user picks their own. Emptying the list keeps it empty.
var DEFAULT = [{ symbol: '^GSPC', name: 'S&P 500' }];

// Resolves to { ok, json } and never rejects: a blocked host, a dead network and a bad body are
// all the same thing to the caller — no quote.
async function http(url) {
  try {
    var response = await fetch(url);
    if (!response.ok) {
      console.error('Quote request failed: HTTP ' + response.status + ' from ' + url);
      return { ok: false, json: null };
    }
    return { ok: true, json: await response.json() };
  } catch (e) {
    console.error('Quote request to ' + url + ' failed: ' + e);
    return { ok: false, json: null, unreachable: true, denied: !!e && e.name === 'NotAllowedError' };
  }
}

// Apps without Pebble.permissions fail a request to a domain the user hasn't allowed the same way
// as a dead network, so there a failed request is all we know.
function unreachableHost() {
  return new Promise(function (resolve) {
    var answered = 0;
    REACH_HOSTS.forEach(function (host) {
      Promise.resolve()
        .then(function () { return fetch('https://' + host + '/'); })
        .then(function () { if (++answered === REACH_HOSTS.length) resolve(null); }, function () { resolve(host); });
    });
  });
}

// { host, sure }: the first domain not allowed (sure) or not reachable (not sure), or null.
async function blockedHost() {
  var permissions = typeof Pebble !== 'undefined' && Pebble.permissions;
  if (permissions) {
    for (var i = 0; i < REACH_HOSTS.length; i++) {
      if (await permissions.query('Internet/' + REACH_HOSTS[i]) !== 'granted') return { host: REACH_HOSTS[i], sure: true };
    }
    return null;
  }
  var host = await unreachableHost();
  return host ? { host: host, sure: false } : null;
}

async function checkReach() {
  var blocked = await blockedHost();
  try {
    if (blocked) localStorage.setItem(BLOCKED_KEY, JSON.stringify(blocked));
    else localStorage.removeItem(BLOCKED_KEY);
  } catch (e) {}
  return blocked;
}

function lastBlocked() {
  try {
    return JSON.parse(localStorage.getItem(BLOCKED_KEY)) || null;
  } catch (e) {
    return null;
  }
}

function blockedMessage(blocked) {
  return 'Stocks doesn\'t have permission to connect to ' + blocked.host + '. Turn on "Connect to ' + blocked.host +
    '" in Stocks\'s Permissions' + (blocked.sure ? '.' : ', or check your internet connection.');
}

// Probes have no deadline, so a failure answers from the last check and starts a new one.
function recheckReach() {
  var blocked = null;
  try {
    blocked = lastBlocked();
    checkReach().catch(function () {});
  } catch (e) {}
  return blocked;
}

/** The user's picks, in the order they added them: [{ symbol, name }]. */
function stocks() {
  var saved;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { saved = null; }
  return saved || DEFAULT;
}

function saveStocks(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
}

// ---------------------------------------------------------------- quotes

async function quote(symbol) {
  var response = await http(QUOTE_URL + encodeURIComponent(symbol) + '?interval=1d&range=1d');
  if (response.unreachable) return { unreachable: true, denied: response.denied };
  var result = response.json && response.json.chart && response.json.chart.result;
  var meta = result && result[0] && result[0].meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;

  var price = meta.regularMarketPrice;
  var previous = typeof meta.previousClose === 'number' ? meta.previousClose
    : (typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : price);
  return {
    symbol: meta.symbol || symbol,
    name: meta.shortName || meta.longName || symbol,
    currency: CURRENCY[meta.currency] || ((meta.currency || '') + ' '),
    price: price,
    change: price - previous,
    percent: previous ? ((price - previous) / previous) * 100 : 0,
  };
}

function signed(value, prefix) {
  return (value < 0 ? '-' : '+') + prefix + Math.abs(value).toFixed(2);
}

function propertiesOf(quoted) {
  var price = quoted.currency + quoted.price.toFixed(2);
  var change = signed(quoted.change, quoted.currency);
  var percent = signed(quoted.percent, '') + '%';
  function reading(text) {
    return { shortText: { text: text }, longText: { text: text } };
  }
  return {
    ticker: { shortText: { text: quoted.symbol } },
    name: { shortText: { text: quoted.name } },
    // A tile with room for a line gets price and change together.
    price: {
      shortText: { text: price },
      longText: { text: price + '  ' + percent },
    },
    day_change: reading(change),
    day_change_percent: reading(percent),
  };
}

Pebble.registerSourceHandler(async function (request, respond) {
  var quotes = await Promise.all(stocks().map(function (stock) { return quote(stock.symbol); }));
  if (quotes.some(function (quoted) { return quoted && quoted.unreachable; })) recheckReach();
  respond.data({
    validUntilMs: Date.now() + REFRESH_MS,
    // A ticker that failed to fetch drops out rather than taking the others with it.
    instances: quotes.filter(function (quoted) { return quoted && !quoted.unreachable; }).map(function (quoted) {
      return { instanceId: quoted.symbol, properties: propertiesOf(quoted) };
    }),
  });
});

// ---------------------------------------------------------------- config page

Pebble.registerConfigHandler(async function (message, respond) {
  switch (message && message.type) {
    case 'reach':
      respond({ blocked: await checkReach().catch(function () { return null; }) });
      return;
    case 'list':
      respond({ stocks: stocks() });
      return;
    case 'add': {
      var symbol = String(message.symbol || '').trim().toUpperCase();
      if (!symbol) {
        respond({ error: 'Enter a ticker symbol.' });
        return;
      }
      var already = stocks().filter(function (stock) { return stock.symbol === symbol; });
      if (already.length) {
        respond({ error: symbol + ' is already on the list.', stocks: stocks() });
        return;
      }
      var quoted = await quote(symbol);
      if (!quoted || quoted.unreachable) {
        var blocked = quoted && recheckReach();
        if (quoted && quoted.denied) blocked = { host: REACH_HOSTS[0], sure: true };
        respond({ error: blocked ? blockedMessage(blocked) : 'No quote for ' + symbol + '.', stocks: stocks() });
        return;
      }
      var added = stocks().concat([{ symbol: quoted.symbol, name: quoted.name }]);
      saveStocks(added);
      Pebble.refreshSources(SOURCES);
      respond({ stocks: added });
      return;
    }
    case 'remove': {
      var kept = stocks().filter(function (stock) { return stock.symbol !== message.symbol; });
      saveStocks(kept);
      Pebble.refreshSources(SOURCES);
      respond({ stocks: kept });
      return;
    }
    default:
      respond({ error: 'unknown message type' });
  }
});
