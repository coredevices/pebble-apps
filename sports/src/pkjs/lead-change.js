'use strict';

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
var LEAD_SEEN_MAX = 64;

// Returns computeLeadChange bound to one API root and one storage.
module.exports = function(apiRoot, localStorage) {
  // Each backend has its own cache history. A newly seeded server's timestamps
  // must not look like a lead change when an existing installation changes hosts.
  var LEAD_SEEN_KEY = 'leadSeen:' + apiRoot;

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

  return computeLeadChange;
};
