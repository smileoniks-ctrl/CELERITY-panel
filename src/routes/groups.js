/**
 * Server groups REST API
 *
 * Read is open to `stats:read`; writes require `nodes:write` (same scope the
 * MCP `manage_group` tool uses). Write handlers delegate to the shared MCP
 * tool handler so REST, MCP and the panel stay behaviourally identical.
 */

const express = require('express');
const router = express.Router();
const { requireScope } = require('../middleware/auth');
const { getActiveGroups } = require('../utils/helpers');
const groupsTool = require('../mcp/tools/groups');
const logger = require('../utils/logger');

/** Map a shared-handler result ({error, code} | {success}) onto the HTTP response. */
function sendToolResult(res, result, successStatus = 200) {
    if (result && result.error) {
        return res.status(result.code || 400).json({ error: result.error });
    }
    return res.status(successStatus).json(result);
}

// GET /api/groups — lightweight list (id + name) of active groups.
router.get('/', requireScope('stats:read'), async (req, res) => {
    try {
        const groups = await getActiveGroups();
        res.json(groups.map(g => ({ _id: g._id, name: g.name })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/groups — create a group.
router.post('/', requireScope('nodes:write'), async (req, res) => {
    try {
        const result = await groupsTool.manageGroup({ action: 'create', data: req.body || {} });
        sendToolResult(res, result, 201);
    } catch (error) {
        logger.error(`[Groups API] Create error: ${error.message}`);
        res.status(400).json({ error: error.message });
    }
});

// PUT /api/groups/:id — update a group.
router.put('/:id', requireScope('nodes:write'), async (req, res) => {
    try {
        const result = await groupsTool.manageGroup({ action: 'update', id: req.params.id, data: req.body || {} });
        sendToolResult(res, result);
    } catch (error) {
        logger.error(`[Groups API] Update error: ${error.message}`);
        res.status(400).json({ error: error.message });
    }
});

// DELETE /api/groups/:id — delete a group and detach it from nodes/users.
router.delete('/:id', requireScope('nodes:write'), async (req, res) => {
    try {
        const result = await groupsTool.manageGroup({ action: 'delete', id: req.params.id });
        sendToolResult(res, result);
    } catch (error) {
        logger.error(`[Groups API] Delete error: ${error.message}`);
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
