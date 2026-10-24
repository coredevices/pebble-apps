var STORE_KEY = 'markdown_notes_config_v1';
var REFRESHED = ['notes/destination', 'notes/configured', 'reminders/list', 'reminders/configured'];
var MAX_SCANNED_FILES = 2000;
var MAX_READ_FILES = 200;
var writeQueue = Promise.resolve();

function cleanPath(raw, fallback) {
  var parts = String(raw || '').replace(/\\/g, '/').split('/').map(function (part) {
    return part.trim();
  }).filter(function (part) {
    return part && part !== '.' && part !== '..';
  }).map(function (part) {
    return part.replace(/[\u0000-\u001f:*?"<>|]/g, '-').trim();
  }).filter(Boolean);
  return parts.length ? parts.join('/') : fallback;
}

function segments(path) { return cleanPath(path, '').split('/').filter(Boolean); }

function cleanTag(raw) {
  return String(raw || '').trim().replace(/^#+/, '').replace(/[^A-Za-z0-9_\/-]+/g, '-');
}

function cleanRecent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  var entries = Object.keys(raw).map(function (path) {
    return { path: cleanPath(path, ''), modifiedAtMs: Number(raw[path]) };
  }).filter(function (entry) {
    return entry.path && isFinite(entry.modifiedAtMs) && entry.modifiedAtMs > 0;
  }).sort(function (left, right) { return right.modifiedAtMs - left.modifiedAtMs; }).slice(0, 50);
  var recent = {};
  entries.forEach(function (entry) { recent[entry.path] = entry.modifiedAtMs; });
  return recent;
}

function storedValue() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
}

function config() {
  var value = storedValue();
  var legacyMode = value.mode === 'timestamped' || value.mode === 'named' ? 'create' : 'append';
  var noteMode = value.noteMode === 'create' || value.noteMode === 'append' ? value.noteMode : legacyMode;
  var legacyPath = cleanPath(value.notesPath || 'Index Notes.md', 'Index Notes.md');
  return {
    // The id of the directory grant the settings page picked (Pebble.showDirectoryPicker).
    folderId: typeof value.folderId === 'string' ? value.folderId : '',
    folderName: typeof value.folderName === 'string' ? value.folderName : '',
    noteMode: noteMode,
    selectedNotePath: cleanPath(value.selectedNotePath || (noteMode === 'append' ? legacyPath : ''), ''),
    appendPlacement: value.appendPlacement === 'top' ? 'top' : 'bottom',
    notesFolder: cleanPath(value.notesFolder || 'Index Notes', 'Index Notes'),
    remindersPath: cleanPath(value.remindersPath || 'Index Reminders.md', 'Index Reminders.md'),
    tag: cleanTag(value.tag || ''),
    includeLocation: value.includeLocation !== false,
    openObsidianLinks: value.openObsidianLinks === true,
    recentFiles: cleanRecent(value.recentFiles),
  };
}

function store(value) { localStorage.setItem(STORE_KEY, JSON.stringify(value)); }

function saveConfig(value) {
  var current = config();
  var next = {
    folderId: current.folderId,
    folderName: current.folderName,
    noteMode: value.noteMode === 'append' ? 'append' : 'create',
    selectedNotePath: cleanPath(value.selectedNotePath || '', ''),
    appendPlacement: value.appendPlacement === 'top' ? 'top' : 'bottom',
    notesFolder: cleanPath(value.notesFolder || 'Index Notes', 'Index Notes'),
    remindersPath: cleanPath(value.remindersPath || 'Index Reminders.md', 'Index Reminders.md'),
    tag: cleanTag(value.tag || ''),
    includeLocation: value.includeLocation !== false,
    openObsidianLinks: value.openObsidianLinks === true,
    recentFiles: current.recentFiles,
  };
  store(next);
  return next;
}

// Paths are relative to the picked folder, so a different folder invalidates them.
function setFolder(id, name) {
  var current = config();
  var changed = current.folderId !== id;
  current.folderId = id;
  current.folderName = name;
  if (changed) {
    current.selectedNotePath = '';
    current.recentFiles = {};
  }
  store(current);
  return current;
}

function clearFolder() {
  var current = config();
  current.folderId = '';
  current.folderName = '';
  current.selectedNotePath = '';
  current.recentFiles = {};
  store(current);
  return current;
}

function recordRecent(path, modifiedAtMs) {
  var current = config();
  current.recentFiles[path] = modifiedAtMs || Date.now();
  current.recentFiles = cleanRecent(current.recentFiles);
  store(current);
}

function slug(text) {
  var value = String(text || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]+/g, '-');
  value = value.replace(/^-+|-+$/g, '').substring(0, 54);
  return value || 'note';
}

function pad(number, length) { return String(number).padStart(length || 2, '0'); }

function timestamp(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds()) +
    '-' + pad(date.getMilliseconds(), 3);
}

function displayTimestamp(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function markdownEscape(text) { return String(text).replace(/\r\n?/g, '\n').trim(); }

function yamlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ') + '"';
}

function validLocation(location, enabled) {
  return enabled && location && typeof location.latitude === 'number' &&
    isFinite(location.latitude) && location.latitude >= -90 && location.latitude <= 90 &&
    typeof location.longitude === 'number' && isFinite(location.longitude) &&
    location.longitude >= -180 && location.longitude <= 180;
}

function locationError(location) {
  if (location === undefined) return null;
  if (!location || typeof location !== 'object' || !validLocation(location, true)) {
    return 'location must contain finite latitude (-90 to 90) and longitude (-180 to 180).';
  }
  if (location.label !== undefined && typeof location.label !== 'string') {
    return 'location.label must be a string.';
  }
  return null;
}

function parseRfc3339(value) {
  if (typeof value !== 'string') return null;
  var match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([zZ]|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var hour = Number(match[4]);
  var minute = Number(match[5]);
  var second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      hour > 23 || minute > 59 || second > 59) return null;
  var offsetMinutes = 0;
  if (match[8].toUpperCase() !== 'Z') {
    var offsetHour = Number(match[8].slice(1, 3));
    var offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (match[8][0] === '-' ? -1 : 1);
  }
  var milliseconds = Number(((match[7] || '') + '000').slice(0, 3));
  var instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) - offsetMinutes * 60000);
  return isNaN(instant.getTime()) ? null : instant;
}

function validateTimeZone(value) {
  if (value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string' || !value.trim()) return { ok: false };
  var timeZone = value.trim();
  try {
    if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return { ok: false };
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone }).format(new Date(0));
  } catch (error) { return { ok: false }; }
  return { ok: true, value: timeZone };
}

function dueParts(date, timeZone) {
  if (!timeZone) {
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() };
  }
  var formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  var values = {};
  formatter.formatToParts(date).forEach(function (part) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  });
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute };
}

function locationYamlLines(location, enabled) {
  if (!validLocation(location, enabled)) return [];
  var lines = ['location: ' + yamlString('geo:' + location.latitude + ',' + location.longitude)];
  if (typeof location.label === 'string' && location.label.trim()) {
    lines.push('location_label: ' + yamlString(location.label.trim()));
  }
  return lines;
}

function inlinePropertyValue(value) {
  return String(value).replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\')
    .replace(/[\[\]]/g, function (character) { return '\\' + character; });
}

function locationInlineLines(location, enabled) {
  if (!validLocation(location, enabled)) return [];
  var lines = ['[location:: geo:' + location.latitude + ',' + location.longitude + ']'];
  if (typeof location.label === 'string' && location.label.trim()) {
    lines.push('[location_label:: ' + inlinePropertyValue(location.label.trim()) + ']');
  }
  return lines;
}

function obsidianUrl(rootName, path) {
  var url = 'obsidian://open?file=' + encodeURIComponent(path);
  if (rootName) url += '&vault=' + encodeURIComponent(rootName);
  return url;
}

function resultWithOptionalUrl(result, current, root, path) {
  if (current.openObsidianLinks) result.url = obsidianUrl(root.name, path);
  return result;
}

// ------------------------------------------------------------------ file access
//
// The settings page has the user pick a folder (Pebble.showDirectoryPicker, mode 'readwrite') and
// sends its grant id here; Pebble.fileSystem.getHandle(id) then gives a FileSystemDirectoryHandle
// that every path in the configuration is resolved under. Errors carry DOMException names.

function isNotFound(error) { return !!error && (error.name === 'NotFoundError' || error.code === 'NOT_FOUND'); }
function isNotAllowed(error) { return !!error && (error.name === 'NotAllowedError' || error.code === 'PERMISSION_DENIED'); }
function fileError(error) { return error && error.message ? error.message : String(error || 'Unknown file error'); }

function serialized(work) {
  var operation = writeQueue.then(work, work);
  writeQueue = operation.then(function () {}, function () {});
  return operation;
}

/** The picked folder and what the user currently allows on it. `handle` is only set when readable. */
async function rootStatus() {
  var current = config();
  var status = { configured: false, writable: false, withdrawn: false, id: current.folderId, name: current.folderName, handle: null };
  if (!current.folderId) return status;
  var handle;
  try { handle = await Pebble.fileSystem.getHandle(current.folderId); }
  catch (error) {
    // The grant was revoked (settings page, the app's permissions page, or the platform).
    if (isNotAllowed(error) || isNotFound(error)) { status.withdrawn = true; return status; }
    throw error;
  }
  if (handle.kind !== 'directory') { status.withdrawn = true; return status; }
  var readable = (await handle.queryPermission({ mode: 'read' })) === 'granted';
  var writable = readable && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  status.name = handle.name || current.folderName;
  status.configured = readable;
  status.withdrawn = !readable;
  status.writable = writable;
  status.handle = readable ? handle : null;
  return status;
}

async function directoryAt(root, parts, create) {
  var dir = root;
  for (var index = 0; index < parts.length; index++) {
    dir = await dir.getDirectoryHandle(parts[index], { create: !!create });
  }
  return dir;
}

async function fileAt(root, path, create) {
  var parts = segments(path);
  if (!parts.length) throw new Error('A file path is required.');
  var name = parts.pop();
  var dir = await directoryAt(root, parts, create);
  return dir.getFileHandle(name, { create: !!create });
}

async function fileExists(root, path) {
  try { await fileAt(root, path, false); return true; }
  catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function readSnapshot(root, path) {
  var file = await (await fileAt(root, path, false)).getFile();
  var content = await file.text();
  if (typeof content !== 'string') throw new Error('The file could not be read as text.');
  return {
    content: content,
    modifiedAtMs: typeof file.lastModified === 'number' && file.lastModified > 0 ? file.lastModified : null,
  };
}

async function readExisting(root, path) {
  return (await readSnapshot(root, path)).content;
}

async function writeFile(root, path, content) {
  var file = await fileAt(root, path, true);
  var writable = await file.createWritable();
  try { await writable.write(content); }
  catch (error) {
    try { await writable.abort(); } catch (ignored) {}
    throw error;
  }
  await writable.close();
}

async function verifyWritten(root, path, expected) {
  var value = await readExisting(root, path);
  if (value !== expected) throw new Error('The file changed while it was being saved; review it before retrying.');
}

async function rewriteExisting(root, path, transform) {
  var snapshot;
  try { snapshot = await readSnapshot(root, path); }
  catch (error) {
    if (isNotFound(error)) throw new Error('The selected note no longer exists. Choose it again in plugin settings.');
    throw error;
  }
  var next = transform(snapshot.content);
  var confirmed;
  try { confirmed = await readExisting(root, path); }
  catch (error) {
    if (isNotFound(error)) throw new Error('The selected note was moved or deleted before it could be saved.');
    throw error;
  }
  if (confirmed !== snapshot.content) throw new Error('The selected note changed while preparing the update. Nothing was written; try again.');
  await writeFile(root, path, next);
  await verifyWritten(root, path, next);
  recordRecent(path, Date.now());
}

function insertionOffset(content) {
  var offset = 0;
  if (/^---(?:\r?\n)/.test(content)) {
    var frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (frontmatter) offset = frontmatter[0].length;
  }
  var rest = content.slice(offset);
  var heading = rest.match(/^(?:\s*\r?\n)*#\s+[^\r\n]+(?:\r?\n|$)/);
  if (heading) offset += heading[0].length;
  return offset;
}

function insertBlock(content, block, placement) {
  if (placement === 'top') {
    var offset = insertionOffset(content);
    var prefix = content.slice(0, offset);
    var suffix = content.slice(offset).replace(/^\r?\n+/, '');
    if (prefix && !/\n$/.test(prefix)) prefix += '\n';
    return prefix + (prefix ? '\n' : '') + block.replace(/\n+$/, '\n') + (suffix ? '\n' + suffix : '');
  }
  var base = content.replace(/\s*$/, '');
  return (base ? base + '\n\n' : '') + block.replace(/\n+$/, '\n');
}

async function appendExisting(root, path, block, placement) {
  return rewriteExisting(root, path, function (content) { return insertBlock(content, block, placement); });
}

async function appendOrCreate(root, path, block) {
  if (await fileExists(root, path)) {
    return rewriteExisting(root, path, function (content) { return insertBlock(content, block, 'bottom'); });
  }
  await writeFile(root, path, block);
  await verifyWritten(root, path, block);
  recordRecent(path, Date.now());
}

async function createUniqueFile(root, folder, text, now, content) {
  var base = folder + '/' + timestamp(now) + '-' + slug(text.split('\n')[0]);
  for (var number = 1; number <= 1000; number++) {
    var path = base + (number === 1 ? '' : '-' + number) + '.md';
    if (await fileExists(root, path)) continue;
    await writeFile(root, path, content);
    await verifyWritten(root, path, content);
    recordRecent(path, Date.now());
    return path;
  }
  throw new Error('Could not allocate a unique Markdown filename.');
}

/** Every Markdown file under `dir`, skipping dot-directories (.obsidian, .trash, .git). */
async function collectMarkdown(dir, prefix, out) {
  for await (var pair of dir.entries()) {
    if (out.length >= MAX_SCANNED_FILES) return;
    var name = pair[0];
    var entry = pair[1];
    if (entry.kind === 'directory') {
      if (name.charAt(0) !== '.') await collectMarkdown(entry, prefix + name + '/', out);
    } else if (/\.md$/i.test(name)) {
      out.push({ path: prefix + name, handle: entry });
    }
  }
}

async function requireRoot(respond, write) {
  var status = await rootStatus();
  if (!status.configured) {
    console.error('Folder unavailable: ' + (status.withdrawn ? 'access withdrawn' : 'not chosen'));
    respond.error('AUTH_REQUIRED', status.withdrawn
      ? 'Access to the Obsidian/Markdown folder was withdrawn. Choose it again in plugin settings.'
      : 'Choose an Obsidian/Markdown folder in plugin settings first.');
    return null;
  }
  if (write && !status.writable) {
    console.error('Folder is read-only');
    respond.error('PERMISSION_DENIED', 'The Obsidian/Markdown folder is read-only. Allow this plugin to change files, or choose the folder again in plugin settings.');
    return null;
  }
  return status;
}

function failWrite(respond, where, error) {
  // Not `where` or the message: both can carry vault file names.
  console.error('Saving the note failed: ' + (error && error.name));
  if (isNotAllowed(error)) {
    respond.error('PERMISSION_DENIED', 'Could not save to ' + where + ': access to the folder was withdrawn.');
    return;
  }
  respond.error('PLUGIN_UNAVAILABLE', 'Could not save to ' + where + ': ' + fileError(error));
}

function shortText(text) { return { shortText: { text: String(text) } }; }
function longText(text) { return { longText: { text: String(text) } }; }
function boolText(value) {
  return { boolean: { value: !!value }, shortText: { text: value ? 'Connected' : 'Not connected' } };
}

/** True once create_note can run: a writable folder, and in append mode a note that still exists. */
async function noteReady(root, current) {
  if (!root.configured || !root.writable) return false;
  if (current.noteMode === 'create') return true;
  if (!current.selectedNotePath) return false;
  try { await readExisting(root.handle, current.selectedNotePath); return true; }
  catch (error) {
    if (isNotFound(error) || isNotAllowed(error) || error.name === 'TypeMismatchError') return false;
    throw error;
  }
}

function reminderReady(root) { return root.configured && root.writable; }

function configuredInstance(instanceId, ready) {
  return {
    validUntilMs: Date.now() + 60000,
    instances: [{
      instanceId: instanceId,
      properties: { name: shortText('Obsidian/Markdown Notes'), configured: boolText(ready) },
    }],
  };
}

Pebble.registerSourceHandler(async function (request, respond) {
  var root = await rootStatus();
  var current = config();
  var configured = root.configured;
  if (request.category === 'notes' && request.item === 'configured') {
    respond.data(configuredInstance('markdown-notes', await noteReady(root, current)));
    return;
  }
  if (request.category === 'reminders' && request.item === 'configured') {
    respond.data(configuredInstance('markdown-reminders', reminderReady(root)));
    return;
  }
  if (request.category === 'notes' && request.item === 'destination') {
    var path = current.noteMode === 'append' ? current.selectedNotePath : current.notesFolder;
    respond.data({
      validUntilMs: Date.now() + 60000,
      instances: [{
        instanceId: 'markdown-notes',
        properties: {
          name: shortText('Obsidian/Markdown Notes'),
          configured: boolText(await noteReady(root, current)),
          path: longText(path || 'Choose an existing note'),
        },
      }],
    });
    return;
  }
  if (request.category === 'reminders' && request.item === 'list') {
    respond.data({
      validUntilMs: Date.now() + 60000,
      instances: configured ? [{
        instanceId: 'markdown-reminders',
        properties: {
          name: shortText('Obsidian/Markdown Notes'),
          destination: shortText('Obsidian-compatible task file'),
          path: longText(current.remindersPath),
        },
      }] : [],
    });
    return;
  }
  console.error('Unsupported source: ' + request.category + '/' + request.item);
  respond.error('INVALID_REQUEST', 'Unsupported Obsidian/Markdown Notes source.');
});

function noteBlock(text, args, current, now) {
  var tag = current.tag ? ' #' + current.tag : '';
  var metadata = locationInlineLines(args.location, current.includeLocation);
  var block = '## ' + displayTimestamp(now) + '\n\n' + text + tag + '\n';
  if (metadata.length) block += '\n' + metadata.join('\n') + '\n';
  return block;
}

function newNoteContent(text, args, current, now) {
  var metadata = locationYamlLines(args.location, current.includeLocation);
  var lines = text.split('\n');
  var title = lines.shift().trim();
  var body = lines.join('\n').replace(/^\n+|\n+$/g, '');
  var tag = current.tag ? ' #' + current.tag : '';
  var content = '---\ncreated: ' + yamlString(now.toISOString()) + '\nmodified: ' + yamlString(now.toISOString()) + '\n' +
    (metadata.length ? metadata.join('\n') + '\n' : '') + '---\n\n# ' + title + '\n';
  if (body) content += '\n' + body + tag + '\n';
  else if (tag) content += '\n#' + current.tag + '\n';
  return content;
}

async function createNote(args, respond) {
  if (args.instanceId !== undefined && args.instanceId !== 'markdown-notes') {
    respond.error('INVALID_ARGS', 'Unknown Obsidian/Markdown note destination.'); return;
  }
  var text = typeof args.text === 'string' ? markdownEscape(args.text) : '';
  if (!text) { respond.error('INVALID_ARGS', 'The note text cannot be empty.'); return; }
  var invalidLocation = locationError(args.location);
  if (invalidLocation) { respond.error('INVALID_ARGS', invalidLocation); return; }
  var root = await requireRoot(respond, true); if (!root) return;
  var current = config();
  if (current.noteMode === 'append' && !current.selectedNotePath) {
    respond.error('AUTH_REQUIRED', 'Choose an existing Markdown note in plugin settings first.'); return;
  }
  var now = new Date();
  var path = current.selectedNotePath;
  try {
    await serialized(async function () {
      if (current.noteMode === 'create') {
        var content = newNoteContent(text, args, current, now);
        path = await createUniqueFile(root.handle, current.notesFolder, text, now, content);
      } else {
        await appendExisting(root.handle, path, noteBlock(text, args, current, now), current.appendPlacement);
      }
    });
  } catch (error) {
    failWrite(respond, path, error); return;
  }
  var excerpt = text.replace(/\s+/g, ' '); if (excerpt.length > 42) excerpt = excerpt.substring(0, 39) + '...';
  respond.ok(resultWithOptionalUrl({
    text: (current.noteMode === 'create' ? 'Created' : 'Added') + ' “' + excerpt + '” in Obsidian/Markdown Notes.',
    refreshed: REFRESHED,
  }, current, root, path));
}

async function createReminder(args, respond) {
  if (args.instanceId !== undefined && args.instanceId !== 'markdown-reminders') {
    respond.error('INVALID_ARGS', 'Unknown Obsidian/Markdown Notes destination.'); return;
  }
  var title = typeof args.title === 'string' ? markdownEscape(args.title) : '';
  if (!title) { respond.error('INVALID_ARGS', 'The reminder title cannot be empty.'); return; }
  var due = null;
  if (args.due_iso !== undefined) {
    due = parseRfc3339(args.due_iso);
    if (!due) {
      respond.error('INVALID_ARGS', 'due_iso must be an absolute ISO-8601 date-time.'); return;
    }
  }
  var timeZone = validateTimeZone(args.timezone);
  if (!timeZone.ok) { respond.error('INVALID_ARGS', 'timezone must be a valid IANA time-zone name.'); return; }
  if (args.notify_before_ms !== undefined &&
      (typeof args.notify_before_ms !== 'number' || !isFinite(args.notify_before_ms) ||
       Math.floor(args.notify_before_ms) !== args.notify_before_ms || args.notify_before_ms < 0 ||
       args.notify_before_ms > 9007199254740991)) {
    respond.error('INVALID_ARGS', 'notify_before_ms must be an integer greater than or equal to zero.'); return;
  }
  var reminderLocationError = locationError(args.location);
  if (reminderLocationError) { respond.error('INVALID_ARGS', reminderLocationError); return; }
  var root = await requireRoot(respond, true); if (!root) return;
  var current = config();
  var id = 'index-' + Date.now().toString(36);
  var block = '- [ ] ' + title;
  if (due) {
    var calendar = dueParts(due, timeZone.value);
    block += ' 📅 ' + calendar.year + '-' + pad(calendar.month) + '-' + pad(calendar.day);
    block += ' ⏰ ' + pad(calendar.hour) + ':' + pad(calendar.minute);
  }
  if (typeof args.notify_before_ms === 'number' && args.notify_before_ms > 0) {
    block += ' 🔔 ' + Math.round(args.notify_before_ms / 60000) + 'm';
  }
  if (current.tag) block += ' #' + current.tag;
  block += ' ^' + id + '\n';
  var metadata = locationInlineLines(args.location, current.includeLocation);
  if (metadata.length) block += '  ' + metadata.join('\n  ') + '\n';
  try { await serialized(function () { return appendOrCreate(root.handle, current.remindersPath, block); }); }
  catch (error) {
    failWrite(respond, current.remindersPath, error); return;
  }
  respond.ok(resultWithOptionalUrl({
    text: 'Created “' + title.replace(/\s+/g, ' ') + '” in Obsidian/Markdown Notes.',
    refreshed: REFRESHED,
  }, current, root, current.remindersPath));
}

function filenameTitle(path) {
  var name = String(path).split('/').pop().replace(/\.md$/i, '');
  return name.replace(/[-_]+/g, ' ').trim() || name;
}

function timestampHint(path) {
  var match = String(path).match(/(20\d\d)-(\d\d)-(\d\d)[-_](\d\d)(\d\d)(\d\d)(?:[-_](\d{3}))?/);
  if (!match) return 0;
  var value = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7] || 0)).getTime();
  return isFinite(value) ? value : 0;
}

function firstHeading(content, fallback) {
  var match = String(content || '').match(/^#\s+(.+)$/m);
  return match && match[1].trim() ? match[1].trim().substring(0, 100) : fallback;
}

async function listRecentNotes(root, query) {
  var current = config();
  var found = [];
  await collectMarkdown(root, '', found);
  var entries = [];
  for (var index = 0; index < found.length; index++) {
    var path = cleanPath(found[index].path, '');
    if (!path || path === current.remindersPath) continue;
    var modifiedAtMs = null;
    try {
      var file = await found[index].handle.getFile();
      if (typeof file.lastModified === 'number' && file.lastModified > 0) modifiedAtMs = file.lastModified;
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    entries.push({
      path: path,
      handle: found[index].handle,
      modifiedAtMs: modifiedAtMs || current.recentFiles[path] || timestampHint(path) || null,
    });
  }
  entries.sort(function (left, right) {
    var leftTime = left.modifiedAtMs || 0;
    var rightTime = right.modifiedAtMs || 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return left.path.localeCompare(right.path);
  });
  // Titles need the content, so newest first and only as far as the list needs.
  var wanted = typeof query === 'string' ? query.trim().toLowerCase() : '';
  var notes = [];
  for (var position = 0; position < entries.length && position < MAX_READ_FILES && notes.length < 10; position++) {
    var entry = entries[position];
    var title = filenameTitle(entry.path);
    try { title = firstHeading(await (await entry.handle.getFile()).text(), title); }
    catch (error) { if (isNotFound(error)) continue; throw error; }
    if (!wanted || entry.path.toLowerCase().indexOf(wanted) !== -1 || title.toLowerCase().indexOf(wanted) !== -1) {
      notes.push({ path: entry.path, title: title, modifiedAtMs: entry.modifiedAtMs });
    }
  }
  var selected = null;
  if (current.selectedNotePath) {
    try {
      var selectedContent = await readExisting(root, current.selectedNotePath);
      selected = { path: current.selectedNotePath, title: firstHeading(selectedContent, filenameTitle(current.selectedNotePath)) };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return { notes: notes, selected: selected, selectedMissing: !!current.selectedNotePath && !selected, ordering: 'modified-time' };
}

Pebble.registerActionHandler(async function (request, respond) {
  var args = request.args || {};
  if (request.action === 'create_note') return createNote(args, respond);
  if (request.action === 'create_reminder') return createReminder(args, respond);
  console.error('Unsupported action: ' + request.action);
  respond.error('INVALID_REQUEST', 'Unsupported Obsidian/Markdown Notes action.');
});

function publicRoot(root) {
  return { configured: root.configured, writable: root.writable, withdrawn: root.withdrawn, id: root.id, name: root.name };
}

Pebble.registerConfigHandler(async function (message, respond) {
  if (!message || message.type === 'status') {
    var root = await rootStatus();
    var current = config();
    var ready = message && message.action === 'create_reminder' ? reminderReady(root) : await noteReady(root, current);
    respond({ configured: root.configured, ready: ready, root: publicRoot(root), config: current });
    return;
  }
  if (message.type === 'setFolder') {
    // The page picked a directory with Pebble.showDirectoryPicker and hands us its grant id.
    var id = typeof message.id === 'string' ? message.id : '';
    if (!id) { respond({ error: 'No folder was chosen.' }); return; }
    var handle;
    try { handle = await Pebble.fileSystem.getHandle(id); }
    catch (error) {
      console.error('Opening the chosen folder failed: ' + (error && error.name));
      respond({ error: 'Could not open the chosen folder: ' + fileError(error) }); return;
    }
    if (handle.kind !== 'directory') { respond({ error: 'Choose a folder, not a file.' }); return; }
    var previousId = config().folderId;
    setFolder(id, handle.name || (typeof message.name === 'string' ? message.name : ''));
    respond({ ok: true, previousId: previousId !== id ? previousId : '', root: publicRoot(await rootStatus()), config: config() });
    return;
  }
  if (message.type === 'clearFolder') {
    var clearedId = config().folderId;
    clearFolder();
    respond({ ok: true, previousId: clearedId, config: config() });
    return;
  }
  if (message.type === 'listNotes') {
    try {
      var listRoot = await rootStatus();
      if (!listRoot.configured) { respond({ error: 'Choose a folder first.' }); return; }
      respond(await listRecentNotes(listRoot.handle, message.query));
    }
    catch (error) {
      console.error('Listing Markdown notes failed: ' + (error && error.name));
      respond({ error: 'Could not list Markdown notes: ' + fileError(error) });
    }
    return;
  }
  if (message.type === 'save') {
    var candidate = message.config || {};
    if (candidate.noteMode === 'append') {
      var path = cleanPath(candidate.selectedNotePath || '', '');
      if (!path) { respond({ error: 'Choose an existing Markdown note to append to.' }); return; }
      var saveRoot = await rootStatus();
      if (!saveRoot.configured) { respond({ error: 'Choose a folder first.' }); return; }
      try { await readExisting(saveRoot.handle, path); }
      catch (error) {
        console.error('Verifying the selected note failed: ' + (error && error.name));
        respond({ error: isNotFound(error) ? 'That note was moved or deleted. Refresh the list and choose it again.' : 'Could not verify the selected note: ' + fileError(error) });
        return;
      }
    }
    respond({ ok: true, config: saveConfig(candidate) }); return;
  }
  respond({ error: 'Unknown configuration message.' });
});
