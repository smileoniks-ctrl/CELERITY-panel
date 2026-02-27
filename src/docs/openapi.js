/**
 * OpenAPI 3.0 specification for C³ CELERITY API
 *
 * buildSpec(lang) applies optional i18n translations on top of the base English spec.
 * Supported langs: 'en' (default), 'ru'
 */

const { version } = require('../../package.json');
const i18n = require('./i18n');

const spec = {
    openapi: '3.0.3',
    info: {
        title: 'C³ CELERITY API',
        version,
        description: `
Management API for [C³ CELERITY](https://github.com/ClickDevTech/hysteria-panel) — Hysteria 2 panel by Click Connect.

## Authentication

All \`/api/*\` endpoints (except \`/api/auth\` and \`/api/files\`) require authentication via an **API key**.

Create keys in: **Panel → Settings → Security → API Keys**

\`\`\`
X-API-Key: ck_your_key_here
\`\`\`
or
\`\`\`
Authorization: Bearer ck_your_key_here
\`\`\`

## Scopes

| Scope | Access |
|-------|--------|
| \`users:read\` | Read users |
| \`users:write\` | Create / update / delete users |
| \`nodes:read\` | Read nodes |
| \`nodes:write\` | Create / update / delete / sync nodes |
| \`stats:read\` | Stats and groups |
| \`sync:write\` | Trigger sync, kick users |

Admin sessions (cookie) bypass scope checks entirely.
        `.trim(),
        contact: {
            name: 'Click Connect',
            url: 'https://github.com/ClickDevTech/hysteria-panel',
        },
        license: {
            name: 'MIT',
            url: 'https://github.com/ClickDevTech/hysteria-panel/blob/main/LICENSE',
        },
    },

    servers: [
        { url: '/api', description: 'Current server' },
    ],

    components: {
        securitySchemes: {
            ApiKeyHeader: {
                type: 'apiKey',
                in: 'header',
                name: 'X-API-Key',
                description: 'API key in `X-API-Key` header',
            },
            BearerToken: {
                type: 'http',
                scheme: 'bearer',
                description: 'API key as Bearer token',
            },
        },

        schemas: {
            Error: {
                type: 'object',
                properties: {
                    error: { type: 'string', example: 'Authentication required' },
                },
            },
            ScopeError: {
                type: 'object',
                properties: {
                    error: { type: 'string', example: 'Insufficient permissions' },
                    required: { type: 'string', example: 'users:write' },
                },
            },
            Pagination: {
                type: 'object',
                properties: {
                    page:  { type: 'integer', example: 1 },
                    limit: { type: 'integer', example: 50 },
                    total: { type: 'integer', example: 1234 },
                    pages: { type: 'integer', example: 25 },
                },
            },
            User: {
                type: 'object',
                properties: {
                    _id:               { type: 'string', example: '64a1b2c3d4e5f6a7b8c9d0e1' },
                    userId:            { type: 'string', example: '123456789' },
                    username:          { type: 'string', example: 'JohnDoe' },
                    enabled:           { type: 'boolean', example: true },
                    groups:            { type: 'array', items: { $ref: '#/components/schemas/GroupRef' } },
                    nodes:             { type: 'array', items: { $ref: '#/components/schemas/NodeRef' } },
                    trafficLimit:      { type: 'integer', example: 10737418240, description: 'Bytes, 0 = unlimited' },
                    maxDevices:        { type: 'integer', example: 3, description: '0 = from group, -1 = unlimited' },
                    expireAt:          { type: 'string', format: 'date-time', nullable: true },
                    subscriptionToken: { type: 'string', example: 'abc123def456' },
                    traffic: {
                        type: 'object',
                        properties: {
                            tx: { type: 'integer', description: 'Bytes uploaded' },
                            rx: { type: 'integer', description: 'Bytes downloaded' },
                        },
                    },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                },
            },
            UserCreate: {
                type: 'object',
                required: ['userId'],
                properties: {
                    userId:       { type: 'string', example: '123456789', description: 'Unique user ID (e.g. Telegram ID)' },
                    username:     { type: 'string', example: 'JohnDoe' },
                    enabled:      { type: 'boolean', default: false },
                    groups:       { type: 'array', items: { type: 'string' }, example: [] },
                    trafficLimit: { type: 'integer', example: 0, description: 'Bytes, 0 = unlimited' },
                    expireAt:     { type: 'string', format: 'date-time', nullable: true },
                },
            },
            UserUpdate: {
                type: 'object',
                properties: {
                    username:     { type: 'string' },
                    enabled:      { type: 'boolean' },
                    groups:       { type: 'array', items: { type: 'string' } },
                    trafficLimit: { type: 'integer' },
                    expireAt:     { type: 'string', format: 'date-time', nullable: true },
                },
            },
            Node: {
                type: 'object',
                properties: {
                    _id:           { type: 'string', example: '64a1b2c3d4e5f6a7b8c9d0e1' },
                    name:          { type: 'string', example: 'Germany' },
                    ip:            { type: 'string', example: '1.2.3.4' },
                    domain:        { type: 'string', example: 'de.example.com' },
                    port:          { type: 'integer', example: 443 },
                    portRange:     { type: 'string', example: '20000-50000' },
                    status:        { type: 'string', enum: ['online', 'offline', 'error', 'syncing'], example: 'online' },
                    active:        { type: 'boolean', example: true },
                    onlineUsers:   { type: 'integer', example: 42 },
                    maxOnlineUsers: { type: 'integer', example: 200, description: '0 = unlimited' },
                    groups:        { type: 'array', items: { $ref: '#/components/schemas/GroupRef' } },
                    lastSync:      { type: 'string', format: 'date-time', nullable: true },
                    lastError:     { type: 'string', example: '' },
                    traffic: {
                        type: 'object',
                        properties: {
                            tx: { type: 'integer' },
                            rx: { type: 'integer' },
                        },
                    },
                },
            },
            GroupRef: {
                type: 'object',
                properties: {
                    _id:   { type: 'string' },
                    name:  { type: 'string', example: 'Europe' },
                    color: { type: 'string', example: '#6366f1' },
                },
            },
            NodeRef: {
                type: 'object',
                properties: {
                    _id:  { type: 'string' },
                    name: { type: 'string', example: 'Germany' },
                    ip:   { type: 'string', example: '1.2.3.4' },
                },
            },
            Stats: {
                type: 'object',
                properties: {
                    users: {
                        type: 'object',
                        properties: {
                            total:   { type: 'integer', example: 1234 },
                            enabled: { type: 'integer', example: 987 },
                        },
                    },
                    nodes: {
                        type: 'object',
                        properties: {
                            total:  { type: 'integer', example: 9 },
                            online: { type: 'integer', example: 9 },
                        },
                    },
                    onlineUsers: { type: 'integer', example: 639 },
                    nodesList: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name:   { type: 'string' },
                                online: { type: 'integer' },
                            },
                        },
                    },
                    lastSync: { type: 'string', format: 'date-time', nullable: true },
                },
            },
        },

        responses: {
            Unauthorized: {
                description: 'Invalid or missing API key',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            Forbidden: {
                description: 'Missing required scope or IP not in allowlist',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/ScopeError' } } },
            },
            NotFound: {
                description: 'Resource not found',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            RateLimited: {
                description: 'Rate limit exceeded',
                headers: {
                    'X-RateLimit-Limit':     { schema: { type: 'integer' } },
                    'X-RateLimit-Remaining': { schema: { type: 'integer' } },
                },
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
        },

        parameters: {
            userId: {
                name: 'userId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                example: '123456789',
            },
            nodeId: {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                description: 'Node ObjectId',
            },
        },
    },

    security: [
        { ApiKeyHeader: [] },
        { BearerToken: [] },
    ],

    tags: [
        { name: 'Stats',  description: 'Panel statistics and server groups' },
        { name: 'Users',  description: 'User management — scope: `users:read` / `users:write`' },
        { name: 'Nodes',  description: 'Node management — scope: `nodes:read` / `nodes:write`' },
        { name: 'Sync',   description: 'Synchronization and user kicking — scope: `sync:write`' },
        { name: 'Public', description: 'Public endpoints — no authentication required' },
    ],

    paths: {

        // ── Public ─────────────────────────────────────────────────────────────

        '/auth': {
            post: {
                tags: ['Public'],
                summary: 'Validate user on node connection',
                description: 'Called by Hysteria nodes to authenticate clients. No API key required.',
                security: [],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['auth'],
                                properties: {
                                    addr: { type: 'string', example: '1.2.3.4:12345', description: 'Client IP:port' },
                                    auth: { type: 'string', example: 'userId:password' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Auth result',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        ok: { type: 'boolean', example: true },
                                        id: { type: 'string', example: '123456789', description: 'userId (only when ok=true)' },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },

        '/files/{token}': {
            get: {
                tags: ['Public'],
                summary: 'Get subscription config',
                description: 'Auto-detects format from User-Agent. Returns Clash YAML, Sing-box JSON, or URI list.',
                security: [],
                parameters: [
                    {
                        name: 'token',
                        in: 'path',
                        required: true,
                        schema: { type: 'string' },
                        description: 'User subscription token',
                    },
                    {
                        name: 'format',
                        in: 'query',
                        schema: { type: 'string', enum: ['clash', 'singbox', 'uri'] },
                        description: 'Force output format (overrides User-Agent detection)',
                    },
                ],
                responses: {
                    200: { description: 'Subscription config (Clash YAML / Sing-box JSON / URI list)' },
                    404: { description: 'Token not found' },
                },
            },
        },

        '/info/{token}': {
            get: {
                tags: ['Public'],
                summary: 'Get subscription info',
                description: 'Returns traffic usage and expiry for the subscription.',
                security: [],
                parameters: [
                    {
                        name: 'token',
                        in: 'path',
                        required: true,
                        schema: { type: 'string' },
                    },
                ],
                responses: {
                    200: {
                        description: 'Subscription info',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        userId:       { type: 'string' },
                                        username:     { type: 'string' },
                                        enabled:      { type: 'boolean' },
                                        trafficLimit: { type: 'integer', description: 'Bytes, 0 = unlimited' },
                                        trafficUsed:  { type: 'integer', description: 'Bytes used' },
                                        expireAt:     { type: 'string', format: 'date-time', nullable: true },
                                    },
                                },
                            },
                        },
                    },
                    404: { description: 'Token not found' },
                },
            },
        },

        // ── Stats ──────────────────────────────────────────────────────────────

        '/stats': {
            get: {
                tags: ['Stats'],
                summary: 'Get panel statistics',
                description: 'Returns totals for users, nodes, and online connections.',
                responses: {
                    200: {
                        description: 'Statistics',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Stats' },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/groups': {
            get: {
                tags: ['Stats'],
                summary: 'List server groups',
                responses: {
                    200: {
                        description: 'Array of groups',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'array',
                                    items: { $ref: '#/components/schemas/GroupRef' },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        // ── Users ──────────────────────────────────────────────────────────────

        '/users': {
            get: {
                tags: ['Users'],
                summary: 'List users',
                description: 'Supports pagination, filtering, and sorting.',
                parameters: [
                    { name: 'page',      in: 'query', schema: { type: 'integer', default: 1 } },
                    { name: 'limit',     in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
                    { name: 'sortBy',    in: 'query', schema: { type: 'string', enum: ['createdAt', 'userId', 'username', 'enabled', 'traffic'], default: 'createdAt' } },
                    { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
                    { name: 'enabled',   in: 'query', schema: { type: 'boolean' }, description: 'Filter by enabled status' },
                    { name: 'group',     in: 'query', schema: { type: 'string' }, description: 'Filter by group ObjectId' },
                ],
                responses: {
                    200: {
                        description: 'Paginated user list',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        users:      { type: 'array', items: { $ref: '#/components/schemas/User' } },
                                        pagination: { $ref: '#/components/schemas/Pagination' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    429: { $ref: '#/components/responses/RateLimited' },
                },
            },

            post: {
                tags: ['Users'],
                summary: 'Create user',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/UserCreate' },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Created user',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
                    },
                    400: { description: 'userId is required' },
                    409: { description: 'User already exists' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/users/{userId}': {
            parameters: [{ $ref: '#/components/parameters/userId' }],

            get: {
                tags: ['Users'],
                summary: 'Get user by ID',
                responses: {
                    200: { description: 'User', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },

            put: {
                tags: ['Users'],
                summary: 'Update user',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/UserUpdate' } } },
                },
                responses: {
                    200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },

            delete: {
                tags: ['Users'],
                summary: 'Delete user',
                responses: {
                    200: { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/enable': {
            parameters: [{ $ref: '#/components/parameters/userId' }],
            post: {
                tags: ['Users'],
                summary: 'Enable user',
                responses: {
                    200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/disable': {
            parameters: [{ $ref: '#/components/parameters/userId' }],
            post: {
                tags: ['Users'],
                summary: 'Disable user',
                responses: {
                    200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/groups': {
            parameters: [{ $ref: '#/components/parameters/userId' }],
            post: {
                tags: ['Users'],
                summary: 'Add user to groups',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['groups'],
                                properties: {
                                    groups: { type: 'array', items: { type: 'string' }, example: ['64a1b2c3d4e5f6a7b8c9d0e1'] },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/groups/{groupId}': {
            parameters: [
                { $ref: '#/components/parameters/userId' },
                { name: 'groupId', in: 'path', required: true, schema: { type: 'string' }, description: 'Group ObjectId' },
            ],
            delete: {
                tags: ['Users'],
                summary: 'Remove user from group',
                responses: {
                    200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        // ── Nodes ──────────────────────────────────────────────────────────────

        '/nodes': {
            get: {
                tags: ['Nodes'],
                summary: 'List nodes',
                parameters: [
                    { name: 'active', in: 'query', schema: { type: 'boolean' }, description: 'Filter by active status' },
                    { name: 'status', in: 'query', schema: { type: 'string', enum: ['online', 'offline', 'error'] } },
                    { name: 'group',  in: 'query', schema: { type: 'string' }, description: 'Filter by group ObjectId' },
                ],
                responses: {
                    200: { description: 'Node list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
            post: {
                tags: ['Nodes'],
                summary: 'Create node',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['name', 'ip'],
                                properties: {
                                    name:          { type: 'string', example: 'Germany' },
                                    ip:            { type: 'string', example: '1.2.3.4' },
                                    domain:        { type: 'string', example: 'de.example.com' },
                                    port:          { type: 'integer', example: 443 },
                                    portRange:     { type: 'string', example: '20000-50000' },
                                    statsPort:     { type: 'integer', example: 9999 },
                                    statsSecret:   { type: 'string', example: 'secret' },
                                    groups:        { type: 'array', items: { type: 'string' } },
                                    maxOnlineUsers: { type: 'integer', example: 0 },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: { description: 'Created node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/nodes/{id}': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],

            get: {
                tags: ['Nodes'],
                summary: 'Get node by ID',
                responses: {
                    200: { description: 'Node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },

            put: {
                tags: ['Nodes'],
                summary: 'Update node',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { type: 'object' } } },
                },
                responses: {
                    200: { description: 'Updated node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },

            delete: {
                tags: ['Nodes'],
                summary: 'Delete node',
                responses: {
                    200: { description: 'Deleted' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/status': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            get: {
                tags: ['Nodes'],
                summary: 'Get node live status',
                description: 'Queries the node Stats API directly for current online count.',
                responses: {
                    200: {
                        description: 'Node status',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        status:      { type: 'string', enum: ['online', 'offline', 'error'] },
                                        onlineUsers: { type: 'integer' },
                                        lastError:   { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/sync': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            post: {
                tags: ['Nodes'],
                summary: 'Sync specific node',
                description: 'Pushes the current config to this node via SSH.',
                responses: {
                    200: { description: 'Sync started/completed' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/config': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            get: {
                tags: ['Nodes'],
                summary: 'Get generated node config',
                description: 'Returns the YAML config that would be applied to this node.',
                responses: {
                    200: { description: 'Hysteria 2 config YAML', content: { 'text/plain': { schema: { type: 'string' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/users': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            get: {
                tags: ['Nodes'],
                summary: 'List users assigned to node',
                responses: {
                    200: { description: 'User list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        // ── Sync ───────────────────────────────────────────────────────────────

        '/sync': {
            post: {
                tags: ['Sync'],
                summary: 'Sync all nodes',
                description: 'Pushes config to all active nodes in parallel. Returns immediately; sync runs in background.',
                responses: {
                    200: { description: 'Sync started', content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string', example: 'Sync started' } } } } } },
                    409: { description: 'Sync already in progress' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/kick/{userId}': {
            parameters: [{ $ref: '#/components/parameters/userId' }],
            post: {
                tags: ['Sync'],
                summary: 'Kick user from all nodes',
                description: 'Forcibly disconnects the user from all Hysteria nodes they are connected to.',
                responses: {
                    200: { description: 'Kicked', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },
    },
};

/**
 * Apply i18n translations to the spec.
 * Overrides: info.description, tags descriptions, and per-operation summary/description.
 */
function buildSpec(lang = 'en') {
    const t = i18n[lang];
    if (!t) return spec;

    // Deep clone to avoid mutating the base spec
    const out = JSON.parse(JSON.stringify(spec));

    if (t.info?.description) {
        out.info.description = t.info.description;
    }

    if (t.tags) {
        out.tags = t.tags;
    }

    if (t.operations) {
        for (const [pathMethod, override] of Object.entries(t.operations)) {
            // Key format: "METHOD /path" e.g. "GET /users/{userId}"
            const spaceIdx = pathMethod.indexOf(' ');
            const method = pathMethod.slice(0, spaceIdx).toLowerCase();
            const path = pathMethod.slice(spaceIdx + 1);

            if (out.paths[path]?.[method]) {
                if (override.summary !== undefined) out.paths[path][method].summary = override.summary;
                if (override.description !== undefined) out.paths[path][method].description = override.description;
            }
        }
    }

    return out;
}

module.exports = { buildSpec };
