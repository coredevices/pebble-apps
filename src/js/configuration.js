'use strict';

Sports.onShowConfiguration = function() {
  console.log('showConfiguration');
  Pebble.openURL('http://assets.espn.go.com/prod/assets/pebble/newconfig.html');
};

Sports.onWebViewClosed = function(e) {
  appMessageQueue.send({ type: TYPE.CHECKCONFIG });

  console.log('webviewclosed: ' + JSON.stringify(e.response));
  if (!e.response || e.response === 'CANCELLED') {
    return;
  }

  var data = JSON.parse(decodeURIComponent(e.response));

  if (data.SWID) {
    localStorage.setItem('SWID', data.SWID);
    Sports.sendUserData(Sports.refreshAllLeagues);
  }

  if (data.clear) {
    localStorage.removeItem('SWID');
    removeUser();
  }
};

function removeUser() {
  var req = new XMLHttpRequest();
  req.open('DELETE', PEBBLE_SPORTS_API_ROOT + '/user/' + Sports.timelineToken, true);
  req.send(null);
}
