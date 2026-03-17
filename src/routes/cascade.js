/**
 * Cascade API routes — CRUD for cascade links, deploy/undeploy, topology.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const CascadeLink = require('../models/cascadeLinkModel');
const HyNode = require('../models/hyNodeModel');
const cascadeService = require('../services/cascadeService');
const cache = require('../services/cacheService');
const logger = require('../utils/logger');
const { requireScope } = require('../middleware/auth');

async function invalidateCascadeCache() {
    await cache.invalidateAllSubscriptions();
}

const deployLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
});

function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

function generateUuid() {
    return require('crypto').randomUUID();
}

// ==================== LINKS CRUD ====================

/**
 * GET /cascade/links — list all cascade links
 */
router.get('/links', requireScope('nodes:read'), async (req, res) => {
    try {
        const filter = {};
        if (req.query.active !== undefined) filter.active = req.query.active === 'true';
        if (req.query.status) filter.status = req.query.status;
        if (req.query.nodeId) {
            filter.$or = [{ portalNode: req.query.nodeId }, { bridgeNode: req.query.nodeId }];
        }

        const links = await CascadeLink.find(filter)
            .populate('portalNode', 'name ip flag status')
            .populate('bridgeNode', 'name ip flag status')
            .sort({ createdAt: -1 });

        res.json(links);
    } catch (error) {
        logger.error(`[Cascade API] List error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /cascade/links/:id — get single link
 */
router.get('/links/:id', requireScope('nodes:read'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const link = await CascadeLink.findById(req.params.id)
            .populate('portalNode', 'name ip flag status')
            .populate('bridgeNode', 'name ip flag status');

        if (!link) return res.status(404).json({ error: 'Cascade link not found' });
        res.json(link);
    } catch (error) {
        logger.error(`[Cascade API] Get error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /cascade/links — create a new cascade link
 */
router.post('/links', requireScope('nodes:write'), async (req, res) => {
    try {
        const { name, mode, portalNodeId, bridgeNodeId, tunnelPort, tunnelProtocol,
            tunnelSecurity, tunnelTransport, tunnelDomain, tunnelUuid,
            tcpFastOpen, tcpKeepAlive, tcpNoDelay,
            wsPath, wsHost, grpcServiceName,
            xhttpPath, xhttpHost, xhttpMode,
            realityDest, realitySni, realityPrivateKey, realityPublicKey,
            realityShortIds, realityFingerprint,
            muxEnabled, muxConcurrency, muxXudpConcurrency, muxXudpProxyUDP443,
            fallbackTag } = req.body;

        if (!name || !portalNodeId || !bridgeNodeId) {
            return res.status(400).json({ error: 'name, portalNodeId and bridgeNodeId are required' });
        }

        if (!isValidObjectId(portalNodeId) || !isValidObjectId(bridgeNodeId)) {
            return res.status(400).json({ error: 'Invalid node ID format' });
        }

        if (portalNodeId === bridgeNodeId) {
            return res.status(400).json({ error: 'Portal and Bridge must be different nodes' });
        }

        const port = parseInt(tunnelPort) || 10086;
        if (port < 1 || port > 65535) {
            return res.status(400).json({ error: 'tunnelPort must be between 1 and 65535' });
        }

        const [portalNode, bridgeNode] = await Promise.all([
            HyNode.findById(portalNodeId),
            HyNode.findById(bridgeNodeId),
        ]);

        if (!portalNode) return res.status(404).json({ error: 'Portal node not found' });
        if (!bridgeNode) return res.status(404).json({ error: 'Bridge node not found' });

        // Check if port is already used on this portal node
        const existingLink = await CascadeLink.findOne({
            portalNode: portalNodeId,
            tunnelPort: port,
            active: true,
        });
        if (existingLink) {
            return res.status(400).json({
                error: `Port ${port} is already used by link "${existingLink.name}" on this node`,
            });
        }

        const linkData = {
            name,
            mode: mode || 'reverse',
            portalNode: portalNodeId,
            bridgeNode: bridgeNodeId,
            tunnelUuid: tunnelUuid || generateUuid(),
            tunnelPort: port,
            tunnelDomain: tunnelDomain || 'reverse.tunnel.internal',
            tunnelProtocol: tunnelProtocol || 'vless',
            tunnelSecurity: tunnelSecurity || 'none',
            tunnelTransport: tunnelTransport || 'tcp',
            tcpFastOpen: tcpFastOpen !== false,
            tcpKeepAlive: parseInt(tcpKeepAlive) || 100,
            tcpNoDelay: tcpNoDelay !== false,
            wsPath: wsPath || '/cascade',
            wsHost: wsHost || '',
            grpcServiceName: grpcServiceName || 'cascade',
            xhttpPath: xhttpPath || '/cascade',
            xhttpHost: xhttpHost || '',
            xhttpMode: xhttpMode || 'auto',
            fallbackTag: fallbackTag || 'direct',
        };

        // REALITY settings (for tunnelSecurity === 'reality')
        if (tunnelSecurity === 'reality') {
            linkData.realityDest = realityDest || 'www.google.com:443';
            linkData.realitySni = Array.isArray(realitySni) ? realitySni : ['www.google.com'];
            linkData.realityPrivateKey = realityPrivateKey || '';
            linkData.realityPublicKey = realityPublicKey || '';
            linkData.realityShortIds = Array.isArray(realityShortIds) ? realityShortIds : [''];
            linkData.realityFingerprint = realityFingerprint || 'chrome';
        }

        // MUX settings
        if (muxEnabled) {
            linkData.muxEnabled = true;
            linkData.muxConcurrency = parseInt(muxConcurrency) || 8;
            linkData.muxXudpConcurrency = parseInt(muxXudpConcurrency) || 16;
            linkData.muxXudpProxyUDP443 = muxXudpProxyUDP443 || 'reject';
        }

        const link = await CascadeLink.create(linkData);

        const populated = await CascadeLink.findById(link._id)
            .populate('portalNode', 'name ip flag status')
            .populate('bridgeNode', 'name ip flag status');

        logger.info(`[Cascade API] Created link ${name}: ${portalNode.name} -> ${bridgeNode.name}`);

        // Invalidate subscription cache (cascade affects node roles)
        await invalidateCascadeCache();

        // Auto-deploy chain if requested
        if (req.body.autoDeploy) {
            cascadeService.deployChain(portalNodeId).catch(err => {
                logger.warn(`[Cascade API] Auto-deploy failed: ${err.message}`);
            });
        }

        res.status(201).json(populated);
    } catch (error) {
        logger.error(`[Cascade API] Create error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /cascade/links/:id — update link settings (non-topology fields)
 */
router.put('/links/:id', requireScope('nodes:write'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const allowedFields = [
            'name', 'mode', 'tunnelPort', 'tunnelDomain', 'tunnelProtocol',
            'tunnelSecurity', 'tunnelTransport', 'tunnelUuid',
            'tcpFastOpen', 'tcpKeepAlive', 'tcpNoDelay', 'active', 'priority',
            'wsPath', 'wsHost', 'grpcServiceName',
            'xhttpPath', 'xhttpHost', 'xhttpMode',
            'realityDest', 'realitySni', 'realityPrivateKey', 'realityPublicKey',
            'realityShortIds', 'realityFingerprint',
            'muxEnabled', 'muxConcurrency', 'muxXudpConcurrency', 'muxXudpProxyUDP443',
            'fallbackTag',
        ];

        const updates = {};
        for (const key of allowedFields) {
            if (req.body[key] !== undefined) {
                updates[key] = req.body[key];
            }
        }

        if (updates.tunnelPort !== undefined) {
            const port = parseInt(updates.tunnelPort);
            if (port < 1 || port > 65535) {
                return res.status(400).json({ error: 'tunnelPort must be between 1 and 65535' });
            }
            updates.tunnelPort = port;

            // Check if port is already used by another link on the same portal
            const currentLink = await CascadeLink.findById(req.params.id);
            if (currentLink) {
                const conflictingLink = await CascadeLink.findOne({
                    portalNode: currentLink.portalNode,
                    tunnelPort: port,
                    active: true,
                    _id: { $ne: req.params.id },
                });
                if (conflictingLink) {
                    return res.status(400).json({
                        error: `Port ${port} is already used by link "${conflictingLink.name}" on this node`,
                    });
                }
            }
        }

        // Geo-routing settings
        if (req.body.geoRouting !== undefined) {
            const gr = req.body.geoRouting;
            updates['geoRouting.enabled'] = !!gr.enabled;
            if (Array.isArray(gr.domains)) updates['geoRouting.domains'] = gr.domains.map(String);
            if (Array.isArray(gr.geoip))   updates['geoRouting.geoip']   = gr.geoip.map(String);
        }

        const link = await CascadeLink.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true }
        ).populate('portalNode', 'name ip flag status')
         .populate('bridgeNode', 'name ip flag status');

        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        logger.info(`[Cascade API] Updated link ${link.name}`);

        // Invalidate subscription cache
        await invalidateCascadeCache();

        // Auto-redeploy chain if link was deployed and settings changed
        if (req.body.autoRedeploy && ['deployed', 'online', 'offline'].includes(link.status)) {
            cascadeService.deployChain(link.portalNode._id || link.portalNode).catch(err => {
                logger.warn(`[Cascade API] Auto-redeploy failed: ${err.message}`);
            });
        }

        res.json(link);
    } catch (error) {
        logger.error(`[Cascade API] Update error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PATCH /cascade/links/:id/reconnect — change portal or bridge node of an existing link.
 * Undeploys the link first, updates the topology, resets status to pending.
 */
router.patch('/links/:id/reconnect', requireScope('nodes:write'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const { portalNodeId, bridgeNodeId } = req.body;
        if (!portalNodeId && !bridgeNodeId) {
            return res.status(400).json({ error: 'portalNodeId or bridgeNodeId is required' });
        }

        if (portalNodeId && !isValidObjectId(portalNodeId)) {
            return res.status(400).json({ error: 'Invalid portalNodeId' });
        }
        if (bridgeNodeId && !isValidObjectId(bridgeNodeId)) {
            return res.status(400).json({ error: 'Invalid bridgeNodeId' });
        }

        const link = await CascadeLink.findById(req.params.id);
        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        // Validate new nodes exist
        const [newPortal, newBridge] = await Promise.all([
            portalNodeId ? HyNode.findById(portalNodeId) : Promise.resolve(null),
            bridgeNodeId ? HyNode.findById(bridgeNodeId) : Promise.resolve(null),
        ]);

        if (portalNodeId && !newPortal) return res.status(404).json({ error: 'Portal node not found' });
        if (bridgeNodeId && !newBridge) return res.status(404).json({ error: 'Bridge node not found' });

        const effectivePortalId = portalNodeId || String(link.portalNode);
        const effectiveBridgeId = bridgeNodeId || String(link.bridgeNode);
        if (effectivePortalId === effectiveBridgeId) {
            return res.status(400).json({ error: 'Portal and Bridge must be different nodes' });
        }

        // Undeploy before changing topology
        if (['deployed', 'online', 'offline'].includes(link.status)) {
            try { await cascadeService.undeployLink(link); } catch (_) {}
        }

        const updates = { status: 'pending', lastError: '' };
        if (portalNodeId) updates.portalNode = portalNodeId;
        if (bridgeNodeId) updates.bridgeNode = bridgeNodeId;

        const updated = await CascadeLink.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true }
        ).populate('portalNode', 'name ip flag status')
         .populate('bridgeNode', 'name ip flag status');

        logger.info(`[Cascade API] Reconnected link ${updated.name}`);

        // Invalidate subscription cache
        await invalidateCascadeCache();

        res.json(updated);
    } catch (error) {
        logger.error(`[Cascade API] Reconnect error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /cascade/links/:id — delete with optional undeploy
 */
router.delete('/links/:id', requireScope('nodes:write'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const link = await CascadeLink.findById(req.params.id);
        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        if (['deployed', 'online', 'offline'].includes(link.status)) {
            await cascadeService.undeployLink(link);
        }

        await CascadeLink.findByIdAndDelete(req.params.id);

        // Invalidate subscription cache
        await invalidateCascadeCache();
        logger.info(`[Cascade API] Deleted link ${link.name}`);
        res.json({ success: true, message: 'Cascade link deleted' });
    } catch (error) {
        logger.error(`[Cascade API] Delete error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ==================== DEPLOY / UNDEPLOY ====================

/**
 * POST /cascade/links/:id/deploy — deploy configs to both nodes
 */
router.post('/links/:id/deploy', requireScope('nodes:write'), deployLimiter, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const link = await CascadeLink.findById(req.params.id)
            .populate('portalNode')
            .populate('bridgeNode');

        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        const result = await cascadeService.deployLink(link);

        // Invalidate subscription cache after deploy
        await invalidateCascadeCache();

        if (result.success) {
            res.json({ success: true, message: 'Cascade link deployed' });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        logger.error(`[Cascade API] Deploy error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /cascade/links/:id/undeploy — remove cascade config from nodes
 */
router.post('/links/:id/undeploy', requireScope('nodes:write'), deployLimiter, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const link = await CascadeLink.findById(req.params.id);
        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        await cascadeService.undeployLink(link);

        // Invalidate subscription cache after undeploy
        await invalidateCascadeCache();

        res.json({ success: true, message: 'Cascade link undeployed' });
    } catch (error) {
        logger.error(`[Cascade API] Undeploy error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ==================== CHAIN DEPLOY ====================

/**
 * POST /cascade/chain/deploy — deploy entire cascade chain in correct order
 * Accepts either nodeId or linkId to identify the chain
 */
router.post('/chain/deploy', requireScope('nodes:write'), deployLimiter, async (req, res) => {
    try {
        const { nodeId, linkId } = req.body;

        let startNodeId;
        if (nodeId) {
            if (!isValidObjectId(nodeId)) {
                return res.status(400).json({ error: 'Invalid nodeId' });
            }
            startNodeId = nodeId;
        } else if (linkId) {
            if (!isValidObjectId(linkId)) {
                return res.status(400).json({ error: 'Invalid linkId' });
            }
            const link = await CascadeLink.findById(linkId);
            if (!link) return res.status(404).json({ error: 'Link not found' });
            startNodeId = link.portalNode;
        } else {
            return res.status(400).json({ error: 'nodeId or linkId is required' });
        }

        const result = await cascadeService.deployChain(startNodeId);

        // Invalidate subscription cache after chain deploy
        await invalidateCascadeCache();

        if (result.success) {
            res.json({
                success: true,
                message: `Chain deployed: ${result.deployed} nodes`,
                deployed: result.deployed,
            });
        } else {
            res.status(500).json({
                success: false,
                deployed: result.deployed,
                errors: result.errors,
            });
        }
    } catch (error) {
        logger.error(`[Cascade API] Chain deploy error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ==================== HEALTH ====================

/**
 * GET /cascade/links/:id/health — health-check a single link
 */
router.get('/links/:id/health', requireScope('nodes:read'), async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid link ID' });
        }

        const link = await CascadeLink.findById(req.params.id);
        if (!link) return res.status(404).json({ error: 'Cascade link not found' });

        const healthy = await cascadeService.healthCheckLink(link);
        const updated = await CascadeLink.findById(req.params.id);

        res.json({
            healthy,
            status: updated.status,
            lastHealthCheck: updated.lastHealthCheck,
            latencyMs: updated.latencyMs,
        });
    } catch (error) {
        logger.error(`[Cascade API] Health error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// ==================== TOPOLOGY ====================

/**
 * GET /cascade/topology — full network graph for the visual map
 */
router.get('/topology', requireScope('nodes:read'), async (req, res) => {
    try {
        const topology = await cascadeService.getTopology();
        res.json(topology);
    } catch (error) {
        logger.error(`[Cascade API] Topology error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /cascade/topology/positions — save node positions from the map editor
 */
router.post('/topology/positions', requireScope('nodes:write'), async (req, res) => {
    try {
        const { positions } = req.body;
        if (!Array.isArray(positions)) {
            return res.status(400).json({ error: 'positions must be an array' });
        }

        await cascadeService.savePositions(positions);
        res.json({ success: true });
    } catch (error) {
        logger.error(`[Cascade API] Positions error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
