import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const devDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const buildDir = path.join(devDir, '.build');
export const upstreamDir = path.join(devDir, '.cache', 'icloud-md');
