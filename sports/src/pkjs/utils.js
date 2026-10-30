/* eslint no-unused-vars: 0 */

'use strict';

function getTimeInSeconds() {
  return Math.round(new Date().getTime() / 1000);
}

function timeSince(timeStart) {
  return getTimeInSeconds() - timeStart;
}

function serialize(obj) {
  var s = [];
  for (var p in obj) {
    if (obj.hasOwnProperty(p)) {
      s.push(encodeURIComponent(p) + '=' + encodeURIComponent(obj[p]));
    }
  }
  return s.join('&');
}

function inArray(array, obj) {
  for (var i in array) {
    if (array[i] === obj) {
      return true;
    }
  }
  return false;
}

function formatDate(date) {
  var d = new Date(date);
  var hours = d.getHours();
  var suffix = (hours >= 12) ? 'P' : 'A';
  hours = ((hours + 11) % 12 + 1);
  var prefix = isToday(d) ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ';
  return prefix + hours + ':' + ('0' + d.getMinutes()).slice(-2) + suffix;
}

function isToday(td) {
  var d = new Date();
  return td.getDate() === d.getDate() &&
        td.getMonth() === d.getMonth() &&
        td.getFullYear() === d.getFullYear();
}

function isAplite() {
  try {
    return !Pebble.getActiveWatchInfo ||
          Pebble.getActiveWatchInfo().platform === 'aplite';
  } catch (ex) {
    return false;
  }
}

module.exports = { inArray: inArray, formatDate: formatDate };