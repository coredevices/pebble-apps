export class MuseError extends Error {
  constructor(message) { super(`musemeow: ${message}`); this.name = 'MuseError'; }
}
export class HTTPError extends MuseError {
  constructor(operation, status) {
    super(`${operation} returned HTTP ${status}`);
    this.name = 'HTTPError'; this.operation = operation; this.status = status;
  }
}
