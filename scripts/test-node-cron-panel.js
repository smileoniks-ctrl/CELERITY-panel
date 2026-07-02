const assert = require('assert');
const express = require('express');
const Module = require('module');

const originalLoad = Module._load;

const db = new Map();
const serviceCalls = [];
const rendered = [];
const warnings = [];
const errors = [];

let cronResult = { content: '* * * * * echo ok\n', hash: 'hash-1', user: 'root' };
let statusResult = { service: 'cron', active: true };
let saveResult = { success: true, hash: 'hash-2', backupPath: '/tmp/backup' };
let runResult = { code: 0, stdout: 'ok', stderr: '' };
let reloadResult = { success: true, action: 'reload', service: 'cron' };
let restartResult = { success: true, action: 'restart', service: 'cron' };
let serviceError = null;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeServiceError(message, statusCode) {
  const error = new Error(message);
  if (statusCode) error.statusCode = statusCode;
  return error;
}

const HyNode = {
  findById: async (id) => clone(db.get(id) || null),
};

const remoteCronService = {
  validateCronUser: (user) => {
    serviceCalls.push({ method: 'validateCronUser', user });
    if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(String(user || ''))) {
      throw new Error('Invalid cron user');
    }
    return true;
  },
  validateCronContent: (content) => {
    serviceCalls.push({ method: 'validateCronContent', content });
    if (typeof content !== 'string') {
      throw new Error('Cron content must be a string');
    }
    const normalized = content.endsWith('\n') ? content : `${content}\n`;
    const lines = normalized.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(line)) {
        continue;
      }
      const fields = line.split(/\s+/);
      if (fields.length < 6) {
        throw new Error(`Invalid cron line ${i + 1}`);
      }
    }
    return true;
  },
  getCron: async (node, user) => {
    serviceCalls.push({ method: 'getCron', nodeId: String(node._id), user });
    if (serviceError) throw serviceError;
    return clone(cronResult);
  },
  saveCron: async (node, user, content, baseHash) => {
    serviceCalls.push({ method: 'saveCron', nodeId: String(node._id), user, content, baseHash });
    if (serviceError) throw serviceError;
    return clone(saveResult);
  },
  runCommandNow: async (node, user, command) => {
    serviceCalls.push({ method: 'runCommandNow', nodeId: String(node._id), user, command });
    if (serviceError) throw serviceError;
    return clone(runResult);
  },
  getCronServiceStatus: async (node) => {
    serviceCalls.push({ method: 'getCronServiceStatus', nodeId: String(node._id) });
    if (serviceError) throw serviceError;
    return clone(statusResult);
  },
  reloadCronService: async (node) => {
    serviceCalls.push({ method: 'reloadCronService', nodeId: String(node._id) });
    if (serviceError) throw serviceError;
    return clone(reloadResult);
  },
  restartCronService: async (node) => {
    serviceCalls.push({ method: 'restartCronService', nodeId: String(node._id) });
    if (serviceError) throw serviceError;
    return clone(restartResult);
  },
};

const stubs = {
  '../../models/hyNodeModel': HyNode,
  '../../services/remoteCronService': remoteCronService,
  '../../utils/logger': {
    warn: (...args) => warnings.push(args),
    error: (...args) => errors.push(args),
  },
  './helpers': {
    render: (res, template, data) => {
      rendered.push({ template, data: clone(data) });
      res.rendered = { template, data };
      return res;
    },
    checkIpWhitelist: (_req, _res, next) => next(),
    requireAuth: (_req, _res, next) => next(),
    requireOnboarding: (_req, _res, next) => next(),
  },
  './auth': express.Router(),
  './wizard': express.Router(),
  './nodes': express.Router(),
  './users': express.Router(),
  './settings': express.Router(),
  './system': express.Router(),
  './migration': express.Router(),
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) {
    return stubs[request];
  }
  return originalLoad.call(this, request, parent, isMain);
};

const nodeCronRouter = require('../src/routes/panel/nodeCron');
const panelRouter = require('../src/routes/panel');
Module._load = originalLoad;

function reset() {
  db.clear();
  serviceCalls.length = 0;
  rendered.length = 0;
  warnings.length = 0;
  errors.length = 0;
  cronResult = { content: '* * * * * echo ok\n', hash: 'hash-1', user: 'root' };
  statusResult = { service: 'cron', active: true };
  saveResult = { success: true, hash: 'hash-2', backupPath: '/tmp/backup' };
  runResult = { code: 0, stdout: 'ok', stderr: '' };
  reloadResult = { success: true, action: 'reload', service: 'cron' };
  restartResult = { success: true, action: 'restart', service: 'cron' };
  serviceError = null;
}

function findRoute(router, method, path) {
  const layer = router.stack.find(item => item.route?.path === path && item.route?.methods?.[method]);
  assert(layer, `${method.toUpperCase()} ${path} route exists`);
  return layer.route.stack.map(item => item.handle);
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    redirectedTo: null,
    rendered: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    redirect(target) {
      this.redirectedTo = target;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
  };
}

async function runRoute(method, path, { id = 'node-1', query = {}, body = {} } = {}) {
  const handlers = findRoute(nodeCronRouter, method, path);
  const handler = handlers[handlers.length - 1];
  const req = {
    params: { id },
    query,
    body,
    ip: '127.0.0.1',
    get: () => undefined,
  };
  const res = makeRes();
  await handler(req, res, () => {});
  return res;
}

(async () => {
  assert(findRoute(nodeCronRouter, 'get', '/nodes/:id/cron'));
  assert(findRoute(nodeCronRouter, 'get', '/nodes/:id/cron/data'));
  assert(findRoute(nodeCronRouter, 'post', '/nodes/:id/cron/save').length > 1, 'save route has local rate limiter');
  assert(findRoute(nodeCronRouter, 'post', '/nodes/:id/cron/run').length > 1, 'run route has local rate limiter');
  assert(findRoute(nodeCronRouter, 'post', '/nodes/:id/cron/service').length > 1, 'service route has local rate limiter');
  assert(panelRouter.stack.some(layer => layer.name === 'router' && layer.handle === nodeCronRouter), 'panel index mounts nodeCron router');

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { username: 'admin', password: 'secret' } });
  let res = await runRoute('get', '/nodes/:id/cron');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rendered[0].template, 'node-cron');
  assert.strictEqual(rendered[0].data.title, 'Cron: Alpha');
  assert.strictEqual(rendered[0].data.page, 'nodes');
  assert.strictEqual(rendered[0].data.defaultCronUser, 'admin');
  assert.strictEqual(rendered[0].data.error, null);

  reset();
  res = await runRoute('get', '/nodes/:id/cron', { id: 'missing' });
  assert.strictEqual(res.redirectedTo, '/panel/nodes');

  reset();
  db.set('virtual-1', { _id: 'virtual-1', name: 'Virtual', type: 'virtual', ssh: { password: 'secret' } });
  res = await runRoute('get', '/nodes/:id/cron', { id: 'virtual-1' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rendered[0].template, 'cron-empty');
  assert.strictEqual(rendered[0].data.reason, 'virtual');
  assert.strictEqual(rendered[0].data.node._id, 'virtual-1');

  reset();
  db.set('no-ssh', { _id: 'no-ssh', name: 'No SSH', type: 'xray', ssh: { username: 'root' } });
  res = await runRoute('get', '/nodes/:id/cron', { id: 'no-ssh' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rendered[0].template, 'cron-empty');
  assert.strictEqual(rendered[0].data.reason, 'no-ssh');
  assert.strictEqual(rendered[0].data.node._id, 'no-ssh');

  reset();
  db.set('no-creds', { _id: 'no-creds', name: 'No creds', type: 'hysteria' });
  res = await runRoute('get', '/nodes/:id/cron', { id: 'no-creds' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rendered[0].template, 'cron-empty');
  assert.strictEqual(rendered[0].data.reason, 'no-ssh');

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'hysteria', ssh: { privateKey: 'key' } });
  res = await runRoute('get', '/nodes/:id/cron/data', { query: { user: 'www-data' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { success: true, cron: cronResult, service: statusResult });
  assert.deepStrictEqual(serviceCalls.map(call => call.method), ['validateCronUser', 'getCron', 'getCronServiceStatus']);

  reset();
  res = await runRoute('get', '/nodes/:id/cron/data', { id: 'missing', query: { user: 'root' } });
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(res.body, { success: false, error: 'Node not found' });

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('get', '/nodes/:id/cron/data', { query: { user: 'bad user' } });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Invalid cron user' });

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  serviceError = makeServiceError('Remote read failed', 502);
  res = await runRoute('get', '/nodes/:id/cron/data', { query: { user: 'root' } });
  assert.strictEqual(res.statusCode, 502);
  assert.deepStrictEqual(res.body, { success: false, error: 'Remote cron operation failed' });

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('post', '/nodes/:id/cron/save', { body: { user: 'root', content: 'MAILTO=\n', baseHash: 'hash-1' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, saveResult);
  assert.deepStrictEqual(serviceCalls.find(call => call.method === 'saveCron'), {
    method: 'saveCron',
    nodeId: 'node-1',
    user: 'root',
    content: 'MAILTO=\n',
    baseHash: 'hash-1',
  });

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('post', '/nodes/:id/cron/save', { body: { user: 'root', content: 'MAILTO=\n' } });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Base hash is required' });
  assert(!serviceCalls.some(call => call.method === 'saveCron'), 'missing base hash is rejected before remote save');

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('post', '/nodes/:id/cron/save', { body: { user: 'root', content: '* * echo broken', baseHash: 'hash-1' } });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Invalid cron line 1' });
  assert(!serviceCalls.some(call => call.method === 'saveCron'), 'invalid cron content is rejected before remote save');

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  serviceError = makeServiceError('Cron changed since it was loaded', 409);
  res = await runRoute('post', '/nodes/:id/cron/save', { body: { user: 'root', content: 'MAILTO=\n', baseHash: 'old' } });
  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(res.body, { success: false, error: 'Cron changed since it was loaded' });
  assert.strictEqual(warnings.length, 1);
  assert(!JSON.stringify(warnings).includes('MAILTO'), 'cron content is not logged');

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  serviceError = makeServiceError('ssh failed: stderr includes root password hunter2', 502);
  res = await runRoute('post', '/nodes/:id/cron/save', { body: { user: 'root', content: 'MAILTO=\n', baseHash: 'hash-1' } });
  assert.strictEqual(res.statusCode, 502);
  assert.deepStrictEqual(res.body, { success: false, error: 'Remote cron operation failed' });

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('post', '/nodes/:id/cron/run', { body: { user: 'app', command: 'uptime' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, runResult);
  assert.deepStrictEqual(serviceCalls.map(call => call.method), ['validateCronUser', 'runCommandNow']);
  assert.deepStrictEqual(serviceCalls.find(call => call.method === 'runCommandNow'), {
    method: 'runCommandNow',
    nodeId: 'node-1',
    user: 'app',
    command: 'uptime',
  });

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('post', '/nodes/:id/cron/run', { body: { user: 'bad user', command: 'uptime' } });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Invalid cron user' });
  assert(!serviceCalls.some(call => call.method === 'runCommandNow'), 'invalid run user is rejected before remote run');

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('post', '/nodes/:id/cron/run', { body: { command: '   ' } });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Command is required' });
  assert(!serviceCalls.some(call => call.method === 'runCommandNow'), 'empty run command is rejected before remote run');

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  serviceError = makeServiceError('Command failed with stdout token=secret and stderr password=hunter2');
  res = await runRoute('post', '/nodes/:id/cron/run', { body: { command: 'secret command' } });
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { success: false, error: 'Remote cron operation failed' });
  assert.strictEqual(errors.length, 1);
  assert(!JSON.stringify(errors).includes('secret command'), 'command is not logged');

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('post', '/nodes/:id/cron/service', { body: { action: 'status' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, statusResult);
  assert.deepStrictEqual(serviceCalls.map(call => call.method), ['getCronServiceStatus']);

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('post', '/nodes/:id/cron/service', { body: { action: 'reload' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, reloadResult);

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('post', '/nodes/:id/cron/service', { body: { action: 'restart' } });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, restartResult);

  reset();
  db.set('node-1', { _id: 'node-1', name: 'Alpha', type: 'xray', ssh: { password: 'secret' } });
  res = await runRoute('post', '/nodes/:id/cron/service', { body: { action: 'stop' } });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { success: false, error: 'Invalid service action' });

  console.log('node cron panel route tests passed');
})().catch(error => {
  Module._load = originalLoad;
  console.error(error);
  process.exit(1);
});
