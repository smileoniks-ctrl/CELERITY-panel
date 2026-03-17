/**
 * MCP Tools — Node management, SSH execution, SSH sessions
 * Tools: query (nodes), manage_node, execute_ssh, ssh_session
 */

const { z } = require('zod');
const { Client } = require('ssh2');
const HyNode = require('../../models/hyNodeModel');
const HyUser = require('../../models/hyUserModel');
const cache = require('../../services/cacheService');
const cryptoService = require('../../services/cryptoService');
const logger = require('../../utils/logger');

async function invalidateNodesCache() {
    await cache.invalidateNodes();
    await cache.invalidateAllSubscriptions();
    await cache.invalidateDashboardCounts();
}

function getSyncService() {
    return require('../../services/syncService');
}

// Active SSH sessions managed by ssh_session tool (sessionId -> {conn, buffer})
const sshSessions = new Map();

// Fields excluded from all node queries returned to MCP clients
const NODE_SAFE_SELECT = '-ssh.password -ssh.privateKey -xray.realityPrivateKey -statsSecret';

// ─── Schemas ────────────────────────────────────────────────────────────────

const queryNodesSchema = z.object({
    id: z.string().optional().describe('Node MongoDB _id to fetch'),
    filter: z.object({
        active: z.boolean().optional(),
        group: z.string().optional(),
        status: z.enum(['online', 'offline', 'error', 'syncing']).optional(),
    }).optional(),
    includeUsers: z.boolean().default(false).describe('Include users list for a single node'),
    includeConfig: z.boolean().default(false).describe('Include generated config for a single node'),
});

const manageNodeSchema = z.object({
    action: z.enum(['create', 'update', 'delete', 'sync', 'setup', 'reset_status', 'update_config']),
    id: z.string().optional().describe('Node MongoDB _id (required for all except create)'),
    data: z.object({
        name: z.string().optional(),
        ip: z.string().optional(),
        domain: z.string().optional(),
        sni: z.string().optional(),
        port: z.number().optional(),
        portRange: z.string().optional(),
        type: z.enum(['hysteria', 'xray']).optional(),
        groups: z.array(z.string()).optional(),
        active: z.boolean().optional(),
        country: z.string().optional(),
        cascadeRole: z.enum(['standalone', 'portal', 'bridge', 'relay']).optional(),
        ssh: z.object({
            host: z.string().optional(),
            port: z.number().optional(),
            username: z.string().optional(),
            password: z.string().optional(),
        }).optional(),
    }).optional(),
    setupOptions: z.object({
        installHysteria: z.boolean().default(true),
        setupPortHopping: z.boolean().default(true),
        restartService: z.boolean().default(true),
    }).optional(),
});

const executeSshSchema = z.object({
    nodeId: z.string().describe('Node MongoDB _id'),
    command: z.string().min(1).describe('Shell command to execute'),
    timeout: z.number().int().min(1000).max(120000).default(30000).describe('Timeout in ms'),
});

const sshSessionSchema = z.object({
    action: z.enum(['start', 'input', 'close']).describe('Session action'),
    nodeId: z.string().optional().describe('Required for start'),
    sessionId: z.string().optional().describe('Required for input/close'),
    data: z.string().optional().describe('Input data for action=input'),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function decryptKey(key) {
    try {
        const dec = cryptoService.decrypt(key);
        if (dec && dec.includes('-----BEGIN')) return dec;
    } catch (_) {}
    return key;
}

function buildSshConfig(node) {
    const cfg = {
        host: node.ip,
        port: node.ssh?.port || 22,
        username: node.ssh?.username || 'root',
        readyTimeout: 30000,
    };
    if (node.ssh?.privateKey) {
        cfg.privateKey = decryptKey(node.ssh.privateKey);
    } else if (node.ssh?.password) {
        cfg.password = cryptoService.decrypt(node.ssh.password);
    } else {
        throw new Error('SSH credentials not configured for this node');
    }
    return cfg;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function queryNodes(args) {
    const parsed = queryNodesSchema.parse(args);

    if (parsed.id) {
        const node = await HyNode.findById(parsed.id).select(NODE_SAFE_SELECT).populate('groups', 'name color');
        if (!node) return { error: `Node '${parsed.id}' not found`, code: 404 };

        const result = { ...node.toObject() };

        if (parsed.includeUsers) {
            result.users = await HyUser.find({ nodes: node._id, enabled: true })
                .select('userId username traffic');
        }

        if (parsed.includeConfig) {
            const configGenerator = require('../../services/configGenerator');
            const config = require('../../../config');
            const baseUrl = process.env.BASE_URL || `http://localhost:${config.PORT}`;
            result.config = configGenerator.generateNodeConfig(node, `${baseUrl}/api/auth`);
        }

        result.userCount = await HyUser.countDocuments({ nodes: node._id, enabled: true });
        return { node: result };
    }

    const filter = {};
    if (parsed.filter?.active !== undefined) filter.active = parsed.filter.active;
    if (parsed.filter?.group) filter.groups = parsed.filter.group;
    if (parsed.filter?.status) filter.status = parsed.filter.status;

    const nodes = await HyNode.find(filter).select(NODE_SAFE_SELECT).populate('groups', 'name color').sort({ name: 1 });
    return { nodes };
}

async function manageNode(args, emit) {
    const parsed = manageNodeSchema.parse(args);
    const { action, id, data = {}, setupOptions } = parsed;

    switch (action) {
        case 'create': {
            if (!data.name || !data.ip) throw new Error('name and ip are required for create');
            const existing = await HyNode.findOne({ ip: data.ip });
            if (existing) return { error: 'Node with this IP already exists', code: 409 };

            const statsSecret = cryptoService.generateNodeSecret();
            const node = new HyNode({
                name: data.name,
                ip: data.ip,
                type: data.type || 'hysteria',
                domain: data.domain || '',
                sni: data.sni || '',
                port: data.port || 443,
                portRange: data.portRange || '20000-50000',
                statsPort: 9999,
                statsSecret,
                groups: data.groups || [],
                ssh: data.ssh || {},
                active: true,
                status: 'offline',
                cascadeRole: data.cascadeRole || 'standalone',
                country: data.country || '',
            });
            await node.save();
            await invalidateNodesCache();
            logger.info(`[MCP] Created node ${data.name} (${data.ip})`);
            return { success: true, node };
        }

        case 'update': {
            if (!id) throw new Error('id is required for update');
            const allowed = ['name', 'domain', 'sni', 'port', 'portRange', 'groups', 'active', 'country', 'cascadeRole', 'type'];
            const updates = {};
            for (const k of allowed) {
                if (data[k] !== undefined) updates[k] = data[k];
            }
            const node = await HyNode.findByIdAndUpdate(id, { $set: updates }, { new: true })
                .populate('groups', 'name color');
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            await invalidateNodesCache();
            logger.info(`[MCP] Updated node ${node.name}`);
            return { success: true, node };
        }

        case 'delete': {
            if (!id) throw new Error('id is required for delete');
            const node = await HyNode.findByIdAndDelete(id);
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            await HyUser.updateMany({ nodes: node._id }, { $pull: { nodes: node._id } });
            await invalidateNodesCache();
            logger.info(`[MCP] Deleted node ${node.name}`);
            return { success: true, message: `Node '${node.name}' deleted` };
        }

        case 'sync': {
            if (!id) throw new Error('id is required for sync');
            const node = await HyNode.findByIdAndUpdate(id, { $set: { status: 'syncing' } }, { new: true });
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            emit('progress', { message: `Sync started for node '${node.name}'` });
            logger.info(`[MCP] Started sync for node ${node.name}`);
            return { success: true, message: `Sync started for '${node.name}'` };
        }

        case 'setup': {
            if (!id) throw new Error('id is required for setup');
            const node = await HyNode.findById(id);
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            if (!node.ssh?.password && !node.ssh?.privateKey) {
                return { error: 'SSH credentials not configured', code: 400 };
            }

            const opts = setupOptions || { installHysteria: true, setupPortHopping: true, restartService: true };
            const nodeSetup = require('../../services/nodeSetup');

            emit('progress', { step: 1, total: 3, message: `Connecting to ${node.name} via SSH...` });

            let result;
            if (node.type === 'xray') {
                result = await nodeSetup.setupXrayNode(node, { restartService: opts.restartService });
            } else {
                result = await nodeSetup.setupNode(node, opts);
            }

            if (result.success) {
                const updateFields = { status: 'online', lastSync: new Date(), lastError: '', healthFailures: 0 };
                if (node.type !== 'xray') updateFields.useTlsFiles = result.useTlsFiles;
                await HyNode.findByIdAndUpdate(id, { $set: updateFields });
                await invalidateNodesCache();
                logger.info(`[MCP] Setup completed for ${node.name}`);
                return { success: true, logs: result.logs };
            } else {
                await HyNode.findByIdAndUpdate(id, { $set: { status: 'error', lastError: result.error } });
                return { success: false, error: result.error, logs: result.logs };
            }
        }

        case 'reset_status': {
            if (!id) throw new Error('id is required for reset_status');
            const node = await HyNode.findByIdAndUpdate(
                id,
                { $set: { status: 'online', lastError: '', healthFailures: 0 } },
                { new: true }
            );
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            logger.info(`[MCP] Status reset for node ${node.name}`);
            return { success: true, message: `Status reset for '${node.name}'` };
        }

        case 'update_config': {
            if (!id) throw new Error('id is required for update_config');
            const node = await HyNode.findById(id);
            if (!node) return { error: `Node '${id}' not found`, code: 404 };
            emit('progress', { message: `Updating config on ${node.name}...` });
            const success = await getSyncService().updateNodeConfig(node);
            if (success) return { success: true, message: 'Config updated' };
            return { success: false, error: 'Failed to update config' };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

async function executeSsh(args, emit) {
    const parsed = executeSshSchema.parse(args);
    const { nodeId, command, timeout } = parsed;

    const node = await HyNode.findById(nodeId);
    if (!node) return { error: `Node '${nodeId}' not found`, code: 404 };

    emit('progress', { message: `Connecting to ${node.name} (${node.ip})...` });

    return new Promise((resolve) => {
        const conn = new Client();
        const sshCfg = buildSshConfig(node);
        let output = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            conn.end();
            resolve({ success: false, error: 'Command timed out', output });
        }, timeout);

        conn.on('ready', () => {
            emit('progress', { message: `Executing: ${command}` });
            conn.exec(command, (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    conn.end();
                    resolve({ success: false, error: err.message });
                    return;
                }

                stream.on('data', (chunk) => {
                    const text = chunk.toString('utf8');
                    output += text;
                    emit('log', { type: 'stdout', text });
                });

                stream.stderr.on('data', (chunk) => {
                    const text = chunk.toString('utf8');
                    output += text;
                    emit('log', { type: 'stderr', text });
                });

                stream.on('close', (code) => {
                    clearTimeout(timer);
                    conn.end();
                    if (!timedOut) {
                        resolve({ success: code === 0, exitCode: code, output });
                    }
                });
            });
        });

        conn.on('error', (err) => {
            clearTimeout(timer);
            resolve({ success: false, error: `SSH connection error: ${err.message}` });
        });

        conn.connect(sshCfg);
    });
}

async function sshSession(args, emit) {
    const parsed = sshSessionSchema.parse(args);
    const { action, nodeId, sessionId, data } = parsed;

    switch (action) {
        case 'start': {
            if (!nodeId) throw new Error('nodeId is required for start');
            const node = await HyNode.findById(nodeId);
            if (!node) return { error: `Node '${nodeId}' not found`, code: 404 };

            const sid = require('crypto').randomUUID();
            emit('progress', { message: `Connecting to ${node.name} (${node.ip})...` });

            return new Promise((resolve, reject) => {
                const conn = new Client();
                const sshCfg = buildSshConfig(node);

                conn.on('ready', () => {
                    conn.shell({ term: 'xterm-256color', cols: 200, rows: 50 }, (err, stream) => {
                        if (err) { conn.end(); return reject(err); }

                        const buf = [];
                        sshSessions.set(sid, { conn, stream, buffer: buf, node: node.name });

                        stream.on('data', (chunk) => {
                            emit('log', { type: 'stdout', sessionId: sid, text: chunk.toString('utf8') });
                        });
                        stream.stderr.on('data', (chunk) => {
                            emit('log', { type: 'stderr', sessionId: sid, text: chunk.toString('utf8') });
                        });
                        stream.on('close', () => {
                            sshSessions.delete(sid);
                            emit('log', { type: 'info', sessionId: sid, text: 'Session closed' });
                        });

                        resolve({ success: true, sessionId: sid, message: `SSH session started on ${node.name}` });
                    });
                });

                conn.on('error', (err) => {
                    reject(new Error(`SSH error: ${err.message}`));
                });

                conn.connect(sshCfg);
            });
        }

        case 'input': {
            if (!sessionId) throw new Error('sessionId is required for input');
            const session = sshSessions.get(sessionId);
            if (!session) return { error: `Session '${sessionId}' not found or expired`, code: 404 };
            session.stream.write(data || '');
            return { success: true };
        }

        case 'close': {
            if (!sessionId) throw new Error('sessionId is required for close');
            const session = sshSessions.get(sessionId);
            if (session) {
                session.stream.end();
                session.conn.end();
                sshSessions.delete(sessionId);
            }
            return { success: true, message: 'Session closed' };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

module.exports = {
    queryNodes,
    manageNode,
    executeSsh,
    sshSession,
    schemas: {
        queryNodes: queryNodesSchema,
        manageNode: manageNodeSchema,
        executeSsh: executeSshSchema,
        sshSession: sshSessionSchema,
    },
};
