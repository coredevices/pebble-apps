'use strict';

var util = require('./util');
var codexHeaders = require('./codex-auth').codexHeaders;
var PluginError = util.PluginError;

var API = 'https://chatgpt.com/backend-api/wham';

function prompt(text) {
  return [{ type: 'message', role: 'user', content: [{ content_type: 'text', text: text }] }];
}

function checkText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 16000) {
    throw PluginError('INVALID_ARGS', 'Provide a message between 1 and 16,000 characters.');
  }
}

/** The environment's first repo's default branch: the cloud has no local checkout to take one from. */
function defaultBranch(env) {
  var repos = env.repo_map ? Object.keys(env.repo_map).map(function (key) { return env.repo_map[key]; }) : [];
  var branch = repos.length && repos[0] && repos[0].default_branch;
  return typeof branch === 'string' && branch ? branch : 'main';
}

function createCodexCloud(fetch, auth) {
  async function call(method, path, body) {
    var account = await auth.current();
    var response = await fetch(API + path, {
      method: method,
      headers: codexHeaders(account),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status < 200 || response.status >= 300) {
      console.error('Codex Cloud ' + method + ' ' + path.split('?')[0].replace(/\/tasks\/(?!list$)[^/]+/, '/tasks/:id') + ': HTTP ' + response.status);
    }
    if (response.status === 401) throw PluginError('AUTH_REQUIRED', 'Codex sign-in expired. Sign in to Codex again in plugin settings.');
    if (response.status === 403) throw PluginError('PERMISSION_DENIED', 'Codex Cloud is not enabled for this ChatGPT account or workspace.');
    if (response.status === 404) throw PluginError('INVALID_ARGS', 'Codex Cloud could not find that task.');
    if (response.status === 429) throw PluginError('RATE_LIMITED', 'Codex Cloud usage limit reached. Try again later.');
    if (response.status < 200 || response.status >= 300) {
      throw PluginError('PLUGIN_UNAVAILABLE', 'Codex Cloud returned an error (HTTP ' + response.status + ').');
    }
    return response.json();
  }

  /** Only ids, labels and branches: environment objects also carry the user's environment secrets. */
  async function environments() {
    var list = await call('GET', '/environments');
    return (Array.isArray(list) ? list : []).map(function (env) {
      return { id: env.id, label: env.label || env.id, pinned: !!env.is_pinned, branch: defaultBranch(env) };
    }).sort(function (a, b) { return Number(b.pinned) - Number(a.pinned); });
  }

  async function tasks() {
    var body = await call('GET', '/tasks/list?limit=20&task_filter=current');
    return (body && body.items || []).filter(function (task) { return task && task.id && !task.archived; }).map(function (task) {
      var display = task.task_status_display || {};
      return {
        id: task.id,
        title: task.title || task.id,
        environment: display.environment_label || '',
        turnId: display.latest_turn_status_display && display.latest_turn_status_display.turn_id,
        updatedAt: util.toMillis(task.updated_at || task.created_at),
      };
    });
  }

  async function create(args) {
    checkText(args && args.prompt);
    var env = util.pick(await environments(), args.environment, function (e) { return e.label; }, 'Codex Cloud environment');
    var body = await call('POST', '/tasks', {
      new_task: { environment_id: env.id, branch: env.branch, run_environment_in_qa_mode: false },
      input_items: prompt(args.prompt),
    });
    var id = body && ((body.task && body.task.id) || body.id);
    if (!id) throw PluginError('PLUGIN_UNAVAILABLE', 'Codex Cloud did not confirm the task; check chatgpt.com/codex before trying again.');
    return { text: 'Started a Codex Cloud task in ' + env.label + '.' };
  }

  async function followUp(args) {
    checkText(args && args.message);
    var task = util.pick(await tasks(), args.task, function (t) { return t.title; }, 'Codex Cloud task');
    var turnId = task.turnId;
    if (!turnId) {
      var detail = await call('GET', '/tasks/' + encodeURIComponent(task.id));
      turnId = detail && detail.task && detail.task.current_turn_id;
    }
    if (!turnId) throw PluginError('PLUGIN_UNAVAILABLE', 'That Codex Cloud task has no turn to follow up on yet.');
    var body = await call('POST', '/tasks', {
      follow_up: { task_id: task.id, turn_id: turnId, run_environment_in_qa_mode: false },
      input_items: prompt(args.message),
    });
    if (!body) throw PluginError('PLUGIN_UNAVAILABLE', 'Codex Cloud did not confirm the follow-up; check the task before sending again.');
    return { text: 'Sent a follow-up to Codex Cloud task "' + task.title.slice(0, 60) + '".' };
  }

  return { environments: environments, tasks: tasks, create: create, followUp: followUp };
}

module.exports = { createCodexCloud: createCodexCloud };
