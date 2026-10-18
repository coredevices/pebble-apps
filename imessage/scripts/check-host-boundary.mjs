import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = path.resolve(pluginDirectory, '../..');
const roots = [
  'libpebble3/HOST_CRYPTO_BRIDGE.md',
  'libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/plugin/BundledPlugins.kt',
  'libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/plugin/HostCryptoBridge.kt',
  'libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/plugin/HostTlsSocketBridge.kt',
  'libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/plugin/HostTimerBridge.kt',
  'libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/plugin/HostJsWorkerBridge.kt',
  'libpebble3/src/iosMain/kotlin/io/rebble/libpebblecommon/plugin/HostJsWorkerBridge.ios.kt',
  'libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/plugin/HostWebSocketBridge.kt',
  'libpebble3/src/jvmAndAndroidMain',
  'libpebble3/src/iosMain/kotlin/io/rebble/libpebblecommon/plugin/HostCryptoBridge.ios.kt',
  'libpebble3/src/iosMain/kotlin/io/rebble/libpebblecommon/plugin/HostTlsSocketBridge.ios.kt',
  'x86executor-native/src',
].map((entry) => path.join(publicDirectory, entry));

const applePolicyRule = /(?:^|[^A-Za-z])Apple(?:[^A-Za-z]|$)/;
const forbidden = [
  /\biMessage\b/,
  /\bAnisette\b/,
  /\bMadrid\b/,
  /\bAPNs\b/,
  /\bIDS\b/,
  applePolicyRule,
  /(?:apple\.com|push\.apple|ess\.apple)/i,
  /com\.apple\./,
];

function filesAt(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    if (entry.isDirectory() && entry.name === 'third_party') return [];
    return entry.isDirectory() ? filesAt(child) : entry.isFile() ? [child] : [];
  });
}

const violations = [];
for (const file of roots.flatMap(filesAt)) {
  const text = fs.readFileSync(file, 'utf8');
  // The aggregate host also routes unrelated, explicitly permissioned Apple platform plugins
  // (Reminders and Shortcuts). Keep those loader labels from weakening the iMessage-specific
  // boundary check applied to the generic host implementations themselves.
  const rules = file.endsWith('BundledPlugins.kt')
    ? forbidden.filter((candidate) => candidate !== applePolicyRule)
    : forbidden;
  text.split(/\r?\n/).forEach((line, index) => {
    const rule = rules.find((candidate) => candidate.test(line));
    if (rule) violations.push(`${path.relative(publicDirectory, file)}:${index + 1}: ${line.trim()}`);
  });
}

if (violations.length) {
  process.stderr.write(`Protocol-specific content crossed into the generic host:\n${violations.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('Generic host boundary check passed.\n');
