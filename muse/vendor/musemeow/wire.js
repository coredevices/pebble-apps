import protobuf from 'protobufjs/light.js';
import schema from './schema.json';
const root = protobuf.Root.fromJSON(schema);
export function encode(name,value) { const t=root.lookupType('hatch.noise.'+name); return Buffer.from(t.encode(t.fromObject(value)).finish()); }
export function decode(name,bytes) { return root.lookupType('hatch.noise.'+name).decode(bytes); }
