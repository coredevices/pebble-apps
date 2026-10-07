'use strict';

module.exports = {
  "TYPE": {
    "ERROR": 0,
    "CARD": 1,
    "LEAGUE": 2,
    "LOADED": 3,
    "READY": 4,
    "CHECKCONFIG": 5,
    "MARKDIRTY": 6,
    "NOCONNECTION": 7
  },
  "METHOD": {
    "ERROR": 0,
    "SIZE": 1,
    "DATA": 2,
    "END": 3,
    "REQUESTCARDS": 4,
    "REQUESTCARD": 5,
    "REQUESTGAME": 6,
    "REQUESTPINS": 7,
    "SUBSCRIBE": 8,
    "UNSUBSCRIBE": 9,
    "TD": 10,
    "READY": 11,
    "SCREEN_CHANGE": 12,
    "BUZZ_CHANGE": 13,
    "REQUESTLEAGUE": 14
  },
  "LEAGUE": {
    "FAVS": 0,
    "NFL": 1,
    "MLB": 2,
    "NHL": 3,
    "NBA": 4,
    "WNBA": 5,
    "NCAAF": 6,
    "NCAAM": 7,
    "NCAAW": 8,
    "EPL": 9
  },
  "GAMESTATE": {
    "INGAME": 0,
    "PREGAME": 1,
    "POSTGAME": 2
  },
  "PERSIST": {
    "BUZZON": 0,
    "HASTEAMS": 1,
    "CONFIG_STATUS": 2
  },
  "TD": {
    "APP_OPEN": 0,
    "CARD_OPEN": 1,
    "READY": 2
  }
};
