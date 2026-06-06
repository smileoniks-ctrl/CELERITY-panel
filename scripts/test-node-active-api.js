const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
let lastUpdate = null;
let invalidateCount = 0;
const requestedScopes = [];
let nextNode = null;

const stubs = {
    '../models/hyNodeModel': {
        findByIdAndUpdate: async (id, update, options) => {
            lastUpdate = { id, update, options };
            return nextNode;
        },
    },
    '../models/hyUserModel': {},
    '../models/serverGroupModel': {},
    '../services/cryptoService': {},
    '../services/syncService': {
        schedulePush: () => {
            throw new Error('schedulePush must not be called by active toggles');
        },
    },
    '../utils/logger': {
        info: () => {},
        error: () => {},
    },
    '../middleware/auth': {
        requireScope: (scope) => {
            requestedScopes.push(scope);
            return (_req, _res, next) => next();
        },
    },
    '../utils/helpers': {
        invalidateNodesCache: async () => {
            invalidateCount += 1;
        },
    },
};

Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) {
        return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
};

const router = require('../src/routes/nodes');
Module._load = originalLoad;

function findRoute(path) {
    const layer = router.stack.find(item => item.route?.path === path && item.route?.methods?.post);
    assert(layer, `POST ${path} route exists`);
    return layer.route.stack.map(item => item.handle);
}

async function runRoute(path, id) {
    const handlers = findRoute(path);
    const req = { params: { id } };
    const res = {
        statusCode: 200,
        body: undefined,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };

    let index = 0;
    const next = async () => {
        const handler = handlers[index++];
        if (handler) {
            await handler(req, res, next);
        }
    };
    await next();
    return res;
}

(async () => {
    assert(findRoute('/:id/enable'));
    assert(findRoute('/:id/disable'));
    assert(requestedScopes.includes('nodes:write'), 'enable/disable require nodes:write');

    nextNode = { _id: 'node-1', name: 'Alpha', active: true, status: 'error' };
    invalidateCount = 0;
    let res = await runRoute('/:id/enable', 'node-1');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(lastUpdate, {
        id: 'node-1',
        update: { $set: { active: true } },
        options: { new: true },
    });
    assert.strictEqual(res.body.node.status, 'error');
    assert.strictEqual(invalidateCount, 1);

    nextNode = { _id: 'node-1', name: 'Alpha', active: false, status: 'online' };
    invalidateCount = 0;
    res = await runRoute('/:id/disable', 'node-1');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(lastUpdate, {
        id: 'node-1',
        update: { $set: { active: false } },
        options: { new: true },
    });
    assert.strictEqual(res.body.node.status, 'online');
    assert.strictEqual(invalidateCount, 1);

    nextNode = null;
    invalidateCount = 0;
    res = await runRoute('/:id/enable', 'missing-node');
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Node not found' });
    assert.strictEqual(invalidateCount, 0);

    console.log('node active API tests passed');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
