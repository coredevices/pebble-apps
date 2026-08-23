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

      msg.leadChange = 0;

      if ((msg.scoreHome > msg.scoreAway && opts.scoreHome <= opts.scoreAway) ||
          (msg.scoreAway > msg.scoreHome && opts.scoreAway <= opts.scoreHome)) {
        msg.leadChange = 1;
      }

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

      msg.leadChange = 0;

      if ((msg.scoreHome > msg.scoreAway && opts.scoreHome <= opts.scoreAway) ||
          (msg.scoreAway > msg.scoreHome && opts.scoreAway <= opts.scoreHome)) {
        msg.leadChange = 1;
      }

      appMessageQueue.send(msg);

    } catch (e) {
      console.log('error requesting card: ' + e);
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

Sports.sendUserData = function(callback) {
  var data = {};
  data.timelineToken = Sports.timelineToken;
  data.accountToken = Pebble.getAccountToken();
  data.swid = localStorage.getItem('SWID');
  var xhr = new XMLHttpRequest();
  xhr.open('PUT', PEBBLE_SPORTS_API_ROOT + '/user', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function() {
    try {
      var res = JSON.parse(xhr.responseText);
      if (!(res instanceof Array)) {
        return;
      }

      Sports.teams = res;
      localStorage.setItem('teams', JSON.stringify(Sports.teams));

      if (typeof callback === 'function') {
        callback();
      }
    } catch (e) {
      console.log('error sending user data: ' + e);
    }
  };
  xhr.send(JSON.stringify(data));
};

function updateTimelineToken() {
  Pebble.getTimelineToken(function(token) {
    Sports.timelineToken = token;
    localStorage.setItem('timelineToken', Sports.timelineToken);
    Sports.sendUserData();
  }, function(error) {
    console.log('ERROR: failed to get timeline token.', error);
  });
}

function updateTeamList() {
  Pebble.timelineSubscriptions(function(topics) {
    console.log('subscribed to ' + topics.join(', '));
    Sports.teams = topics;
    localStorage.setItem('teams', JSON.stringify(Sports.teams));
  }, function(err) {
    console.log('error getting subscriptions: ' + err);
    appMessageQueue.send({ type: TYPE.NOCONNECTION });
  });
}

Sports.onReady = function() {
  appMessageQueue.send({ type: TYPE.READY });

  TD.timeStart = getTimeInSeconds();

  updateTimelineToken();

  try {
    Sports.teams = JSON.parse(localStorage.getItem('teams')) || [];
  } catch (e) {
    Sports.teams = [];
  }

  updateTeamList();
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
      Pebble.timelineSubscribe(e.payload.title, function() {
        console.log('subscribed to ' + e.payload.title);
        updateTeamList();
        Sports.refreshAllLeagues();
      }, function(err) {
        console.log('error subscribing to topic: ' + err);
      });
      break;

    case METHOD.UNSUBSCRIBE:
      Pebble.timelineUnsubscribe(e.payload.title, function() {
        console.log('unsubscribed from ' + e.payload.title);
        updateTeamList();
        Sports.refreshAllLeagues();
      }, function(err) {
        console.log('error unsubscribing from topic: ' + err);
      });
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
