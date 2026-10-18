'use strict';

var appleTrust = require('../apple/server-trust');

module.exports = { courierTrustAnchors: appleTrust.appleServerTrustAnchors };
