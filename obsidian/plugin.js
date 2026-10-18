var STORE_KEY = 'markdown_notes_config_v1';
var REFRESHED = ['notes/destination', 'reminders/list'];
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

function saveConfig(value) {
  var current = config();
  var next = {
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
  localStorage.setItem(STORE_KEY, JSON.stringify(next));
  return next;
}

function recordRecent(path, modifiedAtMs) {
  var current = config();
  current.recentFiles[path] = modifiedAtMs || Date.now();
  current.recentFiles = cleanRecent(current.recentFiles);
  localStorage.setItem(STORE_KEY, JSON.stringify(current));
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

function isNotFound(error) { return !!error && error.code === 'NOT_FOUND'; }
function fileError(error) { return error && error.message ? error.message : String(error || 'Unknown file error'); }

function serialized(work) {
  var operation = writeQueue.then(work, work);
  writeQueue = operation.then(function () {}, function () {});
  return operation;
}

async function readExisting(path) {
  return (await readSnapshot(path)).content;
}

async function readSnapshot(path) {
  var value = await Pebble.files.read(path);
  if (!value || typeof value.content !== 'string') throw new Error('The file could not be read as text.');
  return {
    content: value.content,
    revision: typeof value.revision === 'string' ? value.revision : null,
    modifiedAtMs: typeof value.modifiedAtMs === 'number' ? value.modifiedAtMs : null,
  };
}

async function verifyWritten(path, expected) {
  var value = await readExisting(path);
  if (value !== expected) throw new Error('The file changed while it was being saved; review it before retrying.');
}

async function rewriteExisting(path, transform) {
  for (var attempt = 0; attempt < 3; attempt++) {
    var snapshot;
    try { snapshot = await readSnapshot(path); }
    catch (error) {
      if (isNotFound(error)) throw new Error('The selected note no longer exists. Choose it again in plugin settings.');
      throw error;
    }
    var next = transform(snapshot.content);
    if (snapshot.revision && typeof Pebble.files.writeIfRevision === 'function') {
      try {
        await Pebble.files.writeIfRevision(path, next, snapshot.revision);
        recordRecent(path, Date.now());
        return;
      } catch (error) {
        if (error && error.code === 'CONFLICT' && attempt < 2) continue;
        if (error && error.code === 'CONFLICT') {
          throw new Error('The selected note kept changing. Nothing was overwritten; try again.');
        }
        if (isNotFound(error)) throw new Error('The selected note was moved or deleted before it could be saved.');
        throw error;
      }
    }
    var confirmed;
    try { confirmed = await readExisting(path); }
    catch (error) {
      if (isNotFound(error)) throw new Error('The selected note was moved or deleted before it could be saved.');
      throw error;
    }
    if (confirmed !== snapshot.content) throw new Error('The selected note changed while preparing the update. Nothing was written; try again.');
    await Pebble.files.write(path, next);
    await verifyWritten(path, next);
    recordRecent(path, Date.now());
    return;
  }
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

async function appendExisting(path, block, placement) {
  return rewriteExisting(path, function (content) { return insertBlock(content, block, placement); });
}

async function appendOrCreate(path, block) {
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      await readExisting(path);
      return rewriteExisting(path, function (content) { return insertBlock(content, block, 'bottom'); });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (typeof Pebble.files.writeIfAbsent === 'function') {
      try {
        await Pebble.files.writeIfAbsent(path, block);
        recordRecent(path, Date.now());
        return;
      } catch (error) {
        if (error && error.code === 'CONFLICT') continue;
        throw error;
      }
    }
    await Pebble.files.write(path, block);
    await verifyWritten(path, block);
    recordRecent(path, Date.now());
    return;
  }
  throw new Error('The reminder file kept appearing or moving. Nothing was overwritten; try again.');
}

async function createUniqueFile(folder, text, now, content) {
  var base = folder + '/' + timestamp(now) + '-' + slug(text.split('\n')[0]);
  for (var number = 1; number <= 1000; number++) {
    var path = base + (number === 1 ? '' : '-' + number) + '.md';
    if (typeof Pebble.files.writeIfAbsent === 'function') {
      try {
        await Pebble.files.writeIfAbsent(path, content);
        recordRecent(path, Date.now());
        return path;
      } catch (error) {
        if (error && error.code === 'CONFLICT') continue;
        throw error;
      }
    }
    try { await Pebble.files.read(path); }
    catch (error) {
      if (isNotFound(error)) {
        await Pebble.files.write(path, content);
        await verifyWritten(path, content);
        recordRecent(path, Date.now());
        return path;
      }
      throw error;
    }
  }
  throw new Error('Could not allocate a unique Markdown filename.');
}

async function requireRoot(respond) {
  var status = await Pebble.files.status();
  if (!status || !status.configured) {
    respond.error('AUTH_REQUIRED', 'Choose an Obsidian/Markdown folder in plugin settings first.');
    return null;
  }
  return status;
}

function shortText(text) { return { shortText: { text: String(text) } }; }
function longText(text) { return { longText: { text: String(text) } }; }
function boolText(value) {
  return { boolean: { value: !!value }, shortText: { text: value ? 'Connected' : 'Not connected' } };
}

Pebble.registerSourceHandler(async function (request, respond) {
  var status = await Pebble.files.status();
  var current = config();
  var configured = !!(status && status.configured);
  if (request.category === 'notes' && request.item === 'destination') {
    var path = current.noteMode === 'append' ? current.selectedNotePath : current.notesFolder;
    var noteReady = configured && (current.noteMode === 'create' || !!current.selectedNotePath);
    if (noteReady && current.noteMode === 'append') {
      try { await readExisting(current.selectedNotePath); }
      catch (error) { if (isNotFound(error)) noteReady = false; else throw error; }
    }
    respond.data({
      validUntilMs: Date.now() + 60000,
      instances: [{
        instanceId: 'markdown-notes',
        properties: {
          name: shortText('Obsidian/Markdown Notes'),
          configured: boolText(noteReady),
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
  var root = await requireRoot(respond); if (!root) return;
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
        path = await createUniqueFile(current.notesFolder, text, now, content);
      } else {
        await appendExisting(path, noteBlock(text, args, current, now), current.appendPlacement);
      }
    });
  } catch (error) {
    respond.error('PLUGIN_UNAVAILABLE', 'Could not save to ' + path + ': ' + fileError(error)); return;
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
  var root = await requireRoot(respond); if (!root) return;
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
  try { await serialized(function () { return appendOrCreate(current.remindersPath, block); }); }
  catch (error) {
    respond.error('PLUGIN_UNAVAILABLE', 'Could not write ' + current.remindersPath + ': ' + fileError(error)); return;
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

async function listRecentNotes(query) {
  var current = config();
  var result = typeof Pebble.files.listWithMetadata === 'function'
    ? await Pebble.files.listWithMetadata('', true)
    : await Pebble.files.list('', true);
  var entries = result && Array.isArray(result.files) ? result.files : [];
  entries = entries.map(function (entry) {
    if (typeof entry === 'string') return { path: cleanPath(entry, ''), modifiedAtMs: null };
    return {
      path: cleanPath(entry && entry.path, ''),
      modifiedAtMs: entry && typeof entry.modifiedAtMs === 'number' ? entry.modifiedAtMs : null,
    };
  }).filter(function (entry, index, all) {
    return entry.path && /\.md$/i.test(entry.path) && entry.path !== current.remindersPath &&
      all.findIndex(function (candidate) { return candidate.path === entry.path; }) === index;
  });
  var wanted = typeof query === 'string' ? query.trim().toLowerCase() : '';
  var candidates = [];
  for (var index = 0; index < entries.length; index++) {
    var path = entries[index].path;
    var title = filenameTitle(path);
    var snapshot;
    try {
      snapshot = await readSnapshot(path);
      title = firstHeading(snapshot.content, title);
    }
    catch (error) { if (isNotFound(error)) continue; throw error; }
    if (!wanted || path.toLowerCase().indexOf(wanted) !== -1 || title.toLowerCase().indexOf(wanted) !== -1) {
      candidates.push({
        path: path,
        title: title,
        modifiedAtMs: entries[index].modifiedAtMs || snapshot.modifiedAtMs ||
          current.recentFiles[path] || timestampHint(path) || null,
      });
    }
  }
  candidates.sort(function (left, right) {
    var leftTime = left.modifiedAtMs || 0;
    var rightTime = right.modifiedAtMs || 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return left.path.localeCompare(right.path);
  });
  var notes = candidates.slice(0, 10);
  var selected = null;
  if (current.selectedNotePath) {
    try {
      var selectedContent = await readExisting(current.selectedNotePath);
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
  respond.error('INVALID_REQUEST', 'Unsupported Obsidian/Markdown Notes action.');
});

Pebble.registerConfigHandler(async function (message, respond) {
  if (!message || message.type === 'status') {
    var root = await Pebble.files.status();
    var configured = !!(root && root.configured);
    var ready = configured;
    var current = config();
    if (configured && message && message.action === 'create_note' && current.noteMode === 'append') {
      if (!current.selectedNotePath) ready = false;
      else {
        try { await readExisting(current.selectedNotePath); }
        catch (error) { if (isNotFound(error)) ready = false; else throw error; }
      }
    }
    respond({ configured: configured, ready: ready, config: current });
    return;
  }
  if (message.type === 'listNotes') {
      try { respond(await listRecentNotes(message.query)); }
    catch (error) { respond({ error: 'Could not list Markdown notes: ' + fileError(error) }); }
    return;
  }
  if (message.type === 'save') {
    var candidate = message.config || {};
    if (candidate.noteMode === 'append') {
      var path = cleanPath(candidate.selectedNotePath || '', '');
      if (!path) { respond({ error: 'Choose an existing Markdown note to append to.' }); return; }
      try { await readExisting(path); }
      catch (error) {
        respond({ error: isNotFound(error) ? 'That note was moved or deleted. Refresh the list and choose it again.' : 'Could not verify the selected note: ' + fileError(error) });
        return;
      }
    }
    respond({ ok: true, config: saveConfig(candidate) }); return;
  }
  respond({ error: 'Unknown configuration message.' });
});
