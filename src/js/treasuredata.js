/* eslint no-unused-vars: 0 */
/* eslint no-undef: 0 */

'use strict';

var TD = {
  timeStart: 0,

  addEvent: function(event, data) {
    data = data || {};
    data.event = event;
    data.timestamp = new Date();
    data.app_name = AppInfo.shortName;
    data.app_version = AppInfo.versionLabel;
    data.app_uuid = AppInfo.uuid;
    data.user_account_token = Pebble.getAccountToken();
    if (AppInfo.debug) {
      return console.log('[TD]', JSON.stringify(data));
    }
    var req = new XMLHttpRequest();
    req.open('POST', 'https://td.getpebble.com/td.pebble.app_analytics', true);
    req.setRequestHeader('Content-Type', 'application/json');
    req.send(JSON.stringify(data));
  }
};
