'use strict';
const {Accessory, Bridge, Service, Characteristic: C, Categories, HAPStorage, uuid} = require('@homebridge/hap-nodejs');
const fs = require('node:fs');
const path = require('node:path');
const onDevice = process.argv.includes('--device');
if (onDevice && !process.env.HAP_BIND) throw new Error('Set HAP_BIND to the local network interface for device testing');
const directory = path.join(__dirname, '.state', onDevice ? 'device' : '');
const namespace = onDevice ? 'coreapp:apple-home:device:' : 'coreapp:apple-home:qa:';
fs.mkdirSync(directory, {recursive: true});
HAPStorage.setCustomStoragePath(path.join(directory, 'pairings'));
const state = {};
function event(event, data) {
  const row = {time: new Date().toISOString(), event, ...data};
  fs.appendFileSync(path.join(directory, 'audit.jsonl'), JSON.stringify(row) + '\n');
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify(row));
}
const bridge = new Bridge('QA CoreApp Bridge', uuid.generate(namespace + 'bridge'));
bridge.getService(Service.AccessoryInformation)
  .setCharacteristic(C.Manufacturer, 'CoreApp Simulator Fixtures')
  .setCharacteristic(C.Model, 'Virtual Bridge').setCharacteristic(C.SerialNumber, 'QA-BRIDGE-01');
function accessory(name, type, characteristics, external = false) {
  const item = new Accessory(name, uuid.generate(namespace + name));
  item.getService(Service.AccessoryInformation).setCharacteristic(C.Manufacturer, 'CoreApp Simulator Fixtures')
    .setCharacteristic(C.Model, 'Virtual Accessory').setCharacteristic(C.SerialNumber, name.replaceAll(' ', '-'));
  const service = item.addService(type, name);
  wire(service, name, characteristics);
  if (!external) bridge.addBridgedAccessory(item);
  return item;
}
function wire(service, name, characteristics) {
  state[name] = {};
  for (const [characteristic, initial] of characteristics) {
    const value = service.getCharacteristic(characteristic);
    const key = value.displayName;
    state[name][key] = initial;
    value.updateValue(initial).onGet(() => { event('read', {accessory: name, key}); return state[name][key]; });
    if (value.props.perms.includes('pw')) value.onSet(next => {
      state[name][key] = next;
      const current = characteristic === C.LockTargetState ? C.LockCurrentState
        : characteristic === C.TargetMediaState ? C.CurrentMediaState : null;
      if (current && service.testCharacteristic(current)) {
        const reading = service.getCharacteristic(current);
        state[name][reading.displayName] = next;
        reading.updateValue(next);
      }
      event('write', {accessory: name, key, value: next});
    });
  }
}
accessory('QA Color Lamp', Service.Lightbulb, [[C.On, false], [C.Brightness, 45], [C.Hue, 120], [C.Saturation, 50]]);
accessory('QA White Lamp', Service.Lightbulb, [[C.On, false], [C.Brightness, 80], [C.ColorTemperature, 250]]);
accessory('QA Outlet', Service.Outlet, [[C.On, false], [C.OutletInUse, true]]);
accessory('QA Fan', Service.Fan, [[C.On, false], [C.RotationSpeed, 25]]);
accessory('QA Thermostat', Service.Thermostat, [
  [C.CurrentHeatingCoolingState, 0], [C.TargetHeatingCoolingState, 0],
  [C.CurrentTemperature, 21], [C.TargetTemperature, 20], [C.TemperatureDisplayUnits, 0],
  [C.HeatingThresholdTemperature, 18], [C.CoolingThresholdTemperature, 25],
]);
accessory('QA Sensor', Service.TemperatureSensor, [[C.CurrentTemperature, 23.5]]);
accessory('QA Lock', Service.LockMechanism, [[C.LockCurrentState, 1], [C.LockTargetState, 1]]);
const television = accessory('QA Television', Service.Television, [
  [C.Active, 1], [C.ActiveIdentifier, 1], [C.ConfiguredName, 'QA TV Playback'],
  [C.SleepDiscoveryMode, 1], [C.CurrentMediaState, 0], [C.TargetMediaState, 0],
], true);
television.getService(Service.Television).setCharacteristic(C.Name, 'QA TV Playback');
const speaker = television.addService(Service.TelevisionSpeaker, 'QA TV Speaker');
wire(speaker, 'QA TV Speaker', [[C.Mute, false], [C.Volume, 40]]);
television.getService(Service.Television).addLinkedService(speaker);
bridge.on('paired', () => event('paired', {}));
bridge.on('unpaired', () => event('unpaired', {}));
bridge.publish({username: onDevice ? 'CE:91:A0:09:16:36' : 'CE:91:A0:09:16:26',
  pincode: '482-61-937', setupID: onDevice ? 'HD7D' : 'HD7B', port: onDevice ? 51837 : 51827,
  category: Categories.BRIDGE, bind: process.env.HAP_BIND || 'lo0'}).then(() => {
    event('ready', {setupURI: bridge.setupURI(), pin: '482-61-937', bind: process.env.HAP_BIND || 'lo0'});
  }).catch(error => { console.error(error); process.exitCode = 1; });
television.publish({username: onDevice ? 'CE:91:A0:09:16:37' : 'CE:91:A0:09:16:27',
  pincode: '482-61-937', setupID: onDevice ? 'TV02' : 'TV01', port: onDevice ? 51838 : 51828,
  category: Categories.TELEVISION, bind: process.env.HAP_BIND || 'lo0'}).then(() => {
    event('television-ready', {setupURI: television.setupURI()});
  }).catch(error => { console.error(error); process.exitCode = 1; });
async function stop() { await Promise.all([bridge.unpublish(), television.unpublish()]); process.exit(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
