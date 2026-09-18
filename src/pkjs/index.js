'use strict';

Sports.timelineToken = localStorage.getItem('timelineToken') || '';
Sports.teams = [];
Sports.favs = [];

var parseCardData = function(evnt) {
  var msg = {};

  msg.id = parseInt(evnt.id, 10);
  msg.league = evnt.league;
  msg.subtitle = evnt.subtitle;
  msg.nameAway = evnt.nameAway;
  msg.nameHome = evnt.nameHome;
  msg.rankAway = evnt.rankAway;
  msg.rankHome = evnt.rankHome;
  msg.recordAway = evnt.recordAway;
  msg.recordHome = evnt.recordHome;
  msg.scoreAway = evnt.scoreAway;
  msg.scoreHome = evnt.scoreHome;
  msg.subscribedAway = inArray(Sports.teams,
                               msg.league + ':' + msg.nameAway) ? 1 : 0;
  msg.subscribedHome = inArray(Sports.teams,
                               msg.league + ':' + msg.nameHome) ? 1 : 0;

  msg.gameState = GAMESTATE.PREGAME;
  if (evnt.gameState === 'in') {
    msg.gameState = GAMESTATE.INGAME;
  } else if (evnt.gameState === 'post') {
    msg.gameState = GAMESTATE.POSTGAME;
  }

  if (evnt.subtitle && msg.gameState === GAMESTATE.PREGAME) {
    try {
      msg.subtitle = evnt.subtitle === 'TBD' ? evnt.subtitle :
                                               formatDate(evnt.subtitle);
    } catch (e) {}
  }

  msg.broadcaster = evnt.broadcaster;

  if (evnt.gameState === 'post') {
    msg.broadcaster = '';
  }

  return msg;
};

/*
 * leadChange decision.
 *
 * Preferred path: the API publishes `leadChangedAt`, an ISO timestamp that only
 * advances when the leader actually changes. We remember the last value seen
 * per game, so re-polling an unchanged card is a no-op no matter how often the
 * refresh timer fires.
 *
 * Fallback for an API that predates the field: compare the scores numerically.
 * The original compared `msg.score*` (strings, straight from the API) against
 * `opts.score*` (parseInt'd numbers), so "6" > "17" was true; since that half of
 * the test depends only on the current score it stayed true and re-fired the
 * buzz on every single refresh.
 */
// Each backend has its own cache history. A newly seeded server's timestamps
// must not look like a lead change when an existing installation changes hosts.
var LEAD_SEEN_KEY = 'leadSeen:' + PEBBLE_SPORTS_API_ROOT;
var LEAD_SEEN_MAX = 64;

function loadLeadSeen() {
  try {
    return JSON.parse(localStorage.getItem(LEAD_SEEN_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveLeadSeen(seen) {
  try {
    localStorage.setItem(LEAD_SEEN_KEY, JSON.stringify(seen));
  } catch (e) {}
}

function computeLeadChange(res, opts) {
  if (res.leadChangedAt) {
    var seen = loadLeadSeen();
    var key = String(opts.id);
    var was = seen[key];

    // Bounded: a season of ids would otherwise accumulate forever. Dropping
    // history only ever costs a re-seed, which is silent.
    if (Object.keys(seen).length > LEAD_SEEN_MAX) {
      seen = {};
    }
    seen[key] = res.leadChangedAt;
    saveLeadSeen(seen);

    // ISO-8601 UTC strings are fixed width, so > is a valid ordering. First
    // sighting seeds silently; only an advance is a real change.
    return (was && res.leadChangedAt > was) ? 1 : 0;
  }

  var newAway = parseInt(res.scoreAway, 10);
  var newHome = parseInt(res.scoreHome, 10);

  if (isNaN(newAway) || isNaN(newHome) ||
      isNaN(opts.scoreAway) || isNaN(opts.scoreHome)) {
    return 0;
  }

  return ((newHome > newAway && opts.scoreHome <= opts.scoreAway) ||
          (newAway > newHome && opts.scoreAway <= opts.scoreHome)) ? 1 : 0;
}

function requestCard(opts) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', PEBBLE_SPORTS_API_ROOT + '/card/' + opts.id, true);
  xhr.onload = function() {
    try {
      var res = JSON.parse(xhr.responseText);

      if (!res.league) return;

      var msg = parseCardData(res);

      msg.type = TYPE.CARD;
      msg.method = METHOD.DATA;

      msg.leadChange = computeLeadChange(res, opts);

      appMessageQueue.send(msg);

    } catch (e) {
      console.log('error requesting card: ' + e);
    }
  };
  xhr.send(null);
}

function requestGame(opts) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', PEBBLE_SPORTS_API_ROOT + '/card/' + opts.id, true);
  xhr.onload = function() {
    try {
      var res = JSON.parse(xhr.responseText);

      if (!res.league) return;

      var msg = parseCardData(res);

      msg.type = TYPE.LEAGUE;
      msg.method = METHOD.DATA;
      msg.leagueIndex = opts.leagueIndex;
      msg.index = opts.gameIndex;

      msg.leadChange = computeLeadChange(res, opts);

      console.log('Sending LEAGUE');

      appMessageQueue.send(msg);

    } catch (e) {
      console.log('error requesting card: ' + e);
    }
  };
  xhr.send(null);
}

/*
 * Pins inserted from this phone, as pin id -> { teams: [away, home], time }
 * with teams in the `LEAGUE:ABBR` form Sports.teams uses and time the game's
 * start. The timeline has no API to list local pins, so this is the only
 * record of what there is to delete.
 *
 * An entry is forgotten 4 days after its game starts, by which point the pin
 * has left the timeline. Pruning by age rather than by count: dropping the
 * entry of a pin still on the timeline would strand it there for good.
 */
var PINS_KEY = 'pins';
var PINS_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

function loadPins() {
  try {
    return JSON.parse(localStorage.getItem(PINS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function savePins(pins) {
  var cutoff = Date.now() - PINS_MAX_AGE_MS;
  Object.keys(pins).forEach(function(pinId) {
    if (Date.parse(pins[pinId].time) < cutoff) {
      delete pins[pinId];
    }
  });

  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch (e) {}
}

// Deletes every pin whose teams are both unfollowed. A game with one team
// still followed keeps its pin.
function removeOrphanedPins() {
  var pins = loadPins();
  Object.keys(pins).forEach(function(pinId) {
    var followed = pins[pinId].teams.some(function(team) {
      return inArray(Sports.teams, team);
    });
    if (!followed) {
      Pebble.deleteTimelinePin(pinId);
      delete pins[pinId];
      console.log('pin deleted: ' + pinId);
    }
  });
  savePins(pins);
}

function requestPin(opts) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', PEBBLE_SPORTS_API_ROOT + '/card/' + opts.id, true);
  xhr.onload = function() {
    try {
      var res = JSON.parse(xhr.responseText);

      if (!res.league) return;

      var event = parseCardData(res);
      var pin = {
        "id": `sports-${opts.id}`,
        "time": new Date(res.startTime).toISOString(),
        // The watch launches the parent app itself for an openWatchApp action,
        // with launchCode in launch_get_args() - which is where espn.c's
        // APP_LAUNCH_TIMELINE_ACTION path reads the game id from. The phone
        // always appends its own 'Remove' action, so this is the only one to
        // send; other action types are dropped before they reach the watch.
        "actions": [{
          "title": "Open Game",
          "type": "openWatchApp",
          "launchCode": parseInt(opts.id, 10)
        }],
        "layout": {
          "type": "sportsPin",
          "title": `${res.nameAwayFull} at ${res.nameHomeFull}`,
          "subtitle": event.subtitle,
          "tinyIcon": "system://images/NOTIFICATION_FLAG",
          "largeIcon": "system://images/NOTIFICATION_FLAG",
          "lastUpdated": new Date().toISOString(),
          // Empty for every team outside the college leagues, and sent anyway:
          // the layout wants strings, not missing keys. In a playoff or
          // tournament game ESPN's rank is the seed.
          "rankAway": event.rankAway || '',
          "rankHome": event.rankHome || '',
          "nameAway": event.nameAway,
          "nameHome": event.nameHome,
          "recordAway": event.recordAway,
          "recordHome": event.recordHome,
          "scoreAway": event.scoreAway,
          "scoreHome": event.scoreHome,
          "sportsGameState": "pre-game"
        }
      };

      // Keyed on the display name the API puts on a card, which is ESPN's own
      // abbreviation (NCAAF, NCAAM, NCAAW, WNBA) except for the Premier League,
      // shortened to EPL in the API's alternateLeagueNames. A league with no
      // case keeps the NOTIFICATION_FLAG set on the layout above.
      var icon = '';

      switch (event.league) {
        case "NFL":
        case "NCAAF": {
          icon = 'system://images/AMERICAN_FOOTBALL';
          break;
        }
        case "MLB": {
          icon = 'system://images/TIMELINE_BASEBALL';
          break;
        }
        case "NHL": {
          icon = 'system://images/HOCKEY_GAME';
          break;
        }
        case "NBA":
        case "WNBA":
        case "NCAAM":
        case "NCAAW": {
          icon = 'system://images/BASKETBALL';
          break;
        }
        case "EPL": {
          icon = 'system://images/SOCCER_GAME';
          break;
        }
        default: {
          break;
        }
      }

      if (icon) {
        pin["layout"]["tinyIcon"] = icon;
        pin["layout"]["largeIcon"] = icon;
      }

      if (event.gameState != GAMESTATE.PREGAME) {
        pin["layout"]["sportsGameState"] = "in-game";
      }

      Pebble.insertTimelinePin(pin);

      // Remembered with the two teams that justify it, so unfollowing can
      // find every pin a team owns without asking the API again.
      var pins = loadPins();
      pins[pin.id] = {
        teams: [event.league + ':' + event.nameAway,
                event.league + ':' + event.nameHome],
        time: pin.time
      };
      savePins(pins);

      console.log('pin inserted for id: ' + opts.id);
    } catch (e) {
      console.log('error requesting data for pin: ' + e);
    }
  };
  xhr.send(null);
}

Sports.sendEvents = function(league, callback) {
  var url = PEBBLE_SPORTS_API_ROOT + '/events/' + Sports.getLeagueName(league);
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.onload = function() {
    try {
      var res = JSON.parse(xhr.responseText);
      if (!(res instanceof Array)) {
        return;
      }
      appMessageQueue.send({
        type: TYPE.LEAGUE,
        method: METHOD.SIZE,
        index: league,
        count: res.length
      });
      var i = 0;
      res.forEach(function(evnt) {
        var msg = parseCardData(evnt);
        msg.type = TYPE.LEAGUE;
        msg.method = METHOD.DATA;
        msg.leagueIndex = league;
        msg.index = i++;
        appMessageQueue.send(msg);

        if (msg.subscribedAway || msg.subscribedHome) {
        // if (inArray(Sports.teams, evnt.uidHome) ||
        //     inArray(Sports.teams, evnt.uidAway)) {
          Sports.favs.push(evnt);
        }
      });

      appMessageQueue.send({
        type: TYPE.LEAGUE,
        method: METHOD.END,
        index: league
      });

      callback();

    } catch (e) {
      console.log('error requesting event: ' + e);
      callback();
    }
  };
  xhr.send();
};

Sports.sendFavs = function() {
  var favs = [];

  var i = 0;
  Sports.favs.forEach(function(evnt) {
    var msg = parseCardData(evnt);

    msg.type = TYPE.LEAGUE;
    msg.method = METHOD.DATA;
    msg.leagueIndex = LEAGUE.FAVS;
    msg.index = i++;

    favs.push(msg);
  });

  favs.sort(function(a, b) { return a.gameState - b.gameState; });

  appMessageQueue.send({
    type: TYPE.LEAGUE,
    method: METHOD.SIZE,
    index: LEAGUE.FAVS,
    count: favs.length
  });

  favs.forEach(function(fav) {
    appMessageQueue.send(fav);
  });
};

Sports.loadFavs = function(callback) {
  // A wakeup starts a fresh JS instance. onReady loads teams, but do not rely
  // on that ordering: with no teams, every event looks unsubscribed.
  if (!Sports.teams || Sports.teams.length === 0) {
    try {
      Sports.teams = JSON.parse(localStorage.getItem('teams')) || [];
    } catch (e) {
      Sports.teams = [];
    }
  }

  // Collected locally and assigned once at the end. refreshAllLeagues fills
  // Sports.favs too, so sharing the array mid-flight would interleave the two
  // and push some games twice - duplicate rows in the TIMELINE list.
  var collected = [];

  async.eachSeries(Sports.supportedLeagues, function(league, next) {
    var url = PEBBLE_SPORTS_API_ROOT + '/events/' + Sports.getLeagueName(league);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);

    // next() on every path, including the failures sendEvents drops on the
    // floor: one dead league must not strand the series and leave favs partial.
    xhr.onload = function() {
      try {
        var res = JSON.parse(xhr.responseText);
        if (res instanceof Array) {
          res.forEach(function(evnt) {
            var msg = parseCardData(evnt);
            if (msg.subscribedAway || msg.subscribedHome) {
              collected.push(evnt);
            }
          });
        }
      } catch (e) {
        console.log('error loading favs for league ' + league + ': ' + e);
      }
      next();
    };
    xhr.onerror = function() {
      console.log('error loading favs for league ' + league + ': request failed');
      next();
    };
    xhr.ontimeout = function() {
      console.log('error loading favs for league ' + league + ': timed out');
      next();
    };

    xhr.send();
  }, function() {
    Sports.favs = collected;
    console.log('loaded ' + Sports.favs.length + ' favorite games');
    if (typeof callback === 'function') {
      callback();
    }
  });
};

Sports.refreshAllLeagues = function(callback) {
  Sports.favs = [];
  async.eachSeries(Sports.supportedLeagues, Sports.sendEvents, function() {
    Sports.sendFavs();
    appMessageQueue.send({ type: TYPE.MARKDIRTY });
    if (typeof callback === 'function') {
      callback();
    }
  });
};

Sports.refreshAllPins = function() {
  var insertAll = function() {
    Sports.favs.forEach(function(evnt) {
      requestPin({ id: evnt.id });
    });
  };

  if (Sports.favs.length === 0) {
    Sports.loadFavs(insertAll);
  } else {
    insertAll();
  }
};

// Sports.sendUserData = function(callback) {
//   var data = {};
//   data.timelineToken = Sports.timelineToken;
//   data.accountToken = Pebble.getAccountToken();
//   data.swid = localStorage.getItem('SWID');
//   var xhr = new XMLHttpRequest();
//   xhr.open('PUT', PEBBLE_SPORTS_API_ROOT + '/user', true);
//   xhr.setRequestHeader('Content-Type', 'application/json');
//   xhr.onload = function() {
//     try {
//       var res = JSON.parse(xhr.responseText);
//       if (!(res instanceof Array)) {
//         return;
//       }

//       Sports.teams = res;
//       localStorage.setItem('teams', JSON.stringify(Sports.teams));

//       if (typeof callback === 'function') {
//         callback();
//       }
//     } catch (e) {
//       console.log('error sending user data: ' + e);
//     }
//   };
//   xhr.send(JSON.stringify(data));
// };

// function updateTimelineToken() {
//   Pebble.getTimelineToken(function(token) {
//     Sports.timelineToken = token;
//     localStorage.setItem('timelineToken', Sports.timelineToken);
//     Sports.sendUserData();
//   }, function(error) {
//     console.log('ERROR: failed to get timeline token.', error);
//   });
// }

function addFavoriteTeam(team) {
  try {
    Sports.teams = JSON.parse(localStorage.getItem('teams')) || [];
  } catch (e) {
    Sports.teams = [];
  }
  if (Sports.teams.indexOf(team) === -1) { Sports.teams.push(team); }
  localStorage.setItem('teams', JSON.stringify(Sports.teams));
}

function removeFavoriteTeam(team) {
  try {
    Sports.teams = JSON.parse(localStorage.getItem('teams')) || [];
  } catch (e) {
    Sports.teams = [];
  }
  Sports.teams = Sports.teams.filter(function(t) { return t !== team; });
  localStorage.setItem('teams', JSON.stringify(Sports.teams));
}

// function updateTeamList() {
//   Sports.teams = []
//   localStorage.setItem('teams', JSON.stringify(Sports.teams));
//   Pebble.timelineSubscriptions(function(topics) {
//     console.log('subscribed to ' + topics.join(', '));
//     Sports.teams = topics;
//     localStorage.setItem('teams', JSON.stringify(Sports.teams));
//   }, function(err) {
//     console.log('error getting subscriptions: ' + err);
//     appMessageQueue.send({ type: TYPE.NOCONNECTION });
//   });
// }

Sports.onReady = function() {
  appMessageQueue.send({ type: TYPE.READY });

  TD.timeStart = getTimeInSeconds();

  // updateTimelineToken();

  try {
    Sports.teams = JSON.parse(localStorage.getItem('teams')) || [];
  } catch (e) {
    Sports.teams = [];
  }

  Sports.refreshAllPins();
  // updateTeamList();
};

// ANY CHANGES MUST BE UPDATED THE ANALYTICS H FILE
var SCREENS = [
  'FAVORITES',
  'MLB',
  'NHL',
  'NFL',
  'NBA',
  'WNBA',
  'NCAAF',
  'NCAAM',
  'NCAAW',
  'LEAGUES',
  'GAMECARD',
  'NONE'
];

var BUTTONS = [
  'BACK',
  'UP',
  'SELECT',
  'DOWN'
];

Sports.onAppMessage = function(e) {
  console.log('AppMessage received: ' + JSON.stringify(e.payload));
  if (!e.payload.method) return;

  switch (e.payload.method) {
    case METHOD.REQUESTCARDS:
      Sports.refreshAllLeagues(function() {
        appMessageQueue.send({ type: TYPE.LOADED });
      });
      break;

    case METHOD.REQUESTCARD:
      requestCard({
        id: e.payload.id,
        scoreAway: parseInt(e.payload.scoreAway, 10),
        scoreHome: parseInt(e.payload.scoreHome, 10)
      });
      break;

    case METHOD.REQUESTGAME:
      requestGame({
        id: e.payload.id,
        leagueIndex: e.payload.leagueIndex,
        gameIndex: e.payload.index,
        scoreAway: parseInt(e.payload.scoreAway, 10),
        scoreHome: parseInt(e.payload.scoreHome, 10)
      });
      break;

    case METHOD.SUBSCRIBE:
      console.log('added ' + e.payload.title + ' to favorites');
      addFavoriteTeam(e.payload.title);
      // Pins every game of the new team, not just the card it was added from.
      // refreshAllLeagues rebuilds Sports.favs first, so the pins see it.
      Sports.refreshAllLeagues(Sports.refreshAllPins);
      break;

    case METHOD.UNSUBSCRIBE:
      console.log('removed ' + e.payload.title + ' from favorites');
      removeFavoriteTeam(e.payload.title);
      removeOrphanedPins();
      Sports.refreshAllLeagues();
      break;

    case METHOD.SCREEN_CHANGE:
      TD.addEvent('screen_change',
                  { current_screen: SCREENS[e.payload.currentScreen],
                    previous_screen: SCREENS[e.payload.previousScreen],
                    previous_screen_time_sec: timeSince(TD.timeStart),
                    button_pressed: BUTTONS[e.payload.eventButton],
                    previous_screen_up_clicks: e.payload.screenUpClicks,
                    previous_screen_down_clicks: e.payload.screenDownClicks });
      TD.timeStart = getTimeInSeconds();
      break;

    case METHOD.BUZZ_CHANGE:
      var buzz = (e.payload.buzzChange) ? 'true' : 'false';
      TD.addEvent('buzz_change', { buzz_enabled: buzz });
      break;
  }
};

Pebble.addEventListener('ready', Sports.onReady);
Pebble.addEventListener('appmessage', Sports.onAppMessage);
Pebble.addEventListener('showConfiguration', Sports.onShowConfiguration);
Pebble.addEventListener('webviewclosed', Sports.onWebViewClosed);
