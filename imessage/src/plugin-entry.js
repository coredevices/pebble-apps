'use strict';

var createProductionController = require('./production-controller').createProductionController;

var controller = createProductionController(globalThis);

Pebble.registerActionHandler(function (request, respond) {
  return controller.handleAction(request, respond);
});

Pebble.registerConfigHandler(function (message, respond) {
  return controller.handleConfig(message).then(respond);
});

module.exports = { createProductionController: createProductionController };
