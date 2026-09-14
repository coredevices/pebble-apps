'use strict';

var Sports = {};

Sports.supportedLeagues = [
  LEAGUE.NFL,
  LEAGUE.MLB,
  LEAGUE.NHL,
  LEAGUE.NBA,
  LEAGUE.WNBA,
  LEAGUE.NCAAF,
  LEAGUE.NCAAM,
  LEAGUE.NCAAW,
  LEAGUE.EPL
];

Sports.getLeagueName = function(league) {
  switch (league) {
    case LEAGUE.NFL:
      return 'nfl';
    case LEAGUE.MLB:
      return 'mlb';
    case LEAGUE.NHL:
      return 'nhl';
    case LEAGUE.NBA:
      return 'nba';
    case LEAGUE.WNBA:
      return 'wnba';
    case LEAGUE.NCAAF:
      return 'college-football';
    case LEAGUE.NCAAM:
      return 'mens-college-basketball';
    case LEAGUE.NCAAW:
      return 'womens-college-basketball';
    case LEAGUE.EPL:
      return 'english-premier-league';
    default:
      return '';
  }
};
