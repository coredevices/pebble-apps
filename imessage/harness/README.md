# iMessage JavaScript differential harness

This directory is Apple-protocol-free test infrastructure. It gives the JavaScript port and the
pinned Rust oracle one versioned, deterministic operation model:

```text
start(operation, persistedState, deterministicInputs) -> Effect[]
step(inputEvent) -> Effect[]
snapshot() -> JSON
```

`JavaScriptRunner` validates and defensively clones that boundary. `LockstepController` accepts any
two objects with the same three async-compatible methods, including an adapter around a
line-delimited Rust subprocess. It compares each observable effect, asks one resolver for the input
event, then gives an identical copy of that event to both runners. Consequently there is one network
writer, even when two implementations are under test.

## Schema conventions

- Every effect/event has `version: 1` and a dotted `kind`.
- Blocking effects have a unique `requestId`; their input event repeats it.
- Binary data is `{ "$bytes": "canonical-base64" }`. This lets exact comparison report a byte
  offset rather than a base64-character offset.
- HTTP and WebSocket headers are ordered `[name, value]` tuples. Duplicate names remain distinct.
- A batch may contain state transitions followed by exactly one blocking or terminal effect.
- Effects and events are JSON only. Host objects, private keys, and ambient functions cannot cross
  this boundary.

See `schema.js` for the complete effect/event vocabulary. Receive operations are explicit
(`tls.read` and `websocket.receive`) so fake peers can split a frame at every byte boundary.

## Minimal use

```js
const {
  DeterministicResolver,
  JavaScriptRunner,
  LockstepController,
} = require('./harness');

const resolver = new DeterministicResolver({ seed: 7, nowMs: 1700000000000 });
const controller = new LockstepController({
  left: new JavaScriptRunner(leftImplementation),
  right: new JavaScriptRunner(rightImplementation),
  resolveEffect: resolver.resolveEffect,
});

const result = await controller.run('synthetic-operation', null, { fixture: 'example-v1' });
```

Non-clock/random/timer effects require ordered scripted responses in `DeterministicResolver`; there
is intentionally no real-network fallback. A semantic comparator can be installed by effect kind
for randomized signatures or other values whose decoded meaning, rather than encoding, must match.

## Rust adapter boundary

The controller does not prescribe process transport. An LDJSON adapter should correlate its own
process requests, translate its binary fields to/from `$bytes`, and implement `start`, `step`, and
`snapshot`. Process crashes, invalid JSON, and mismatched response IDs should fail in the adapter;
only schema-valid effects enter the controller.
