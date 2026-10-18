'use strict';
function HostJsWorker(nativeInterface, timer, globalObject) {
  this.native = nativeInterface;
  this.timer = timer;
  this.workers = new Map();
  var self = this;
  globalObject.__hostJsWorkerDispatch = function (id, raw) {
    var worker = self.workers.get(id);
    if (worker) worker.receive(raw);
  };
}
HostJsWorker.prototype.open = function (source) {
  var self = this, id = this.native.open(source), pending = null, closed = false, sequence = 0;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Worker could not start.');
  function close() {
    if (closed) return;
    closed = true;
    self.workers.delete(id);
    self.native.close(id);
    if (pending) {
      self.timer.cancel(pending.timer);
      pending.reject(new Error('Validation worker stopped.'));
      pending = null;
    }
  }
  var worker = {
    receive: function (raw) {
      if (closed) return;
      if (raw === null) { close(); return; }
      if (!pending) return;
      var value;
      try { value = JSON.parse(raw); } catch (_) { close(); return; }
      if (!value || value.id !== pending.id) { close(); return; }
      var p = pending; pending = null;
      self.timer.cancel(p.timer);
      if (value.ok === true) p.resolve(value.result);
      else {
        var error = new Error('iMessage validation could not be completed.');
        error.code = typeof value.code === 'string' && /^[A-Z_]{1,64}$/.test(value.code) ? value.code : 'NAC_WORKER_FAILED';
        p.reject(error);
      }
    },
    request: function (method, payload) {
      if (closed || pending) return Promise.reject(new Error('Validation worker is unavailable.'));
      return new Promise(function (resolve, reject) {
        var requestId = ++sequence;
        pending = { id: requestId, resolve: resolve, reject: reject,
          timer: self.timer.after(210000, function () { close(); }) };
        try { self.native.send(id, JSON.stringify({id:requestId,method:method,payload:payload})); }
        catch (e) { close(); }
      });
    },
    close: close,
  };
  this.workers.set(id, worker);
  return worker;
};
module.exports = { HostJsWorker: HostJsWorker };
