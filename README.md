# C³ CELERITY

⚡ **Fast. Simple. Long-lasting.**

**[English](README.md)** | [Русский](README.ru.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/clickdevtech/hysteria-panel)](https://hub.docker.com/r/clickdevtech/hysteria-panel)
[![Docker Image Size](https://img.shields.io/docker/image-size/clickdevtech/hysteria-panel/latest)](https://hub.docker.com/r/clickdevtech/hysteria-panel)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](package.json)
[![Hysteria](https://img.shields.io/badge/Hysteria-2.x-9B59B6)](https://v2.hysteria.network/)

**C³ CELERITY** by Click Connect — modern web panel for managing [Hysteria 2](https://v2.hysteria.network/) proxy servers with centralized HTTP authentication, one-click node setup, and flexible user-to-server group mapping.

<p align="center">
  <img src="https://github.com/user-attachments/assets/bc04b654-aad1-4dc7-96fb-3f35df114eaf" alt="C³ CELERITY Dashboard" width="800">
  <br>
  <em>Dashboard — real-time server monitoring and statistics</em>
</p>

## ⚡ Quick Start

> Updating an existing installation? See [Safe Production Updates](safe-update.md).

**1. Install Docker** (if not installed):
```bash
curl -fsSL https://get.docker.com | sh
```

**2. Deploy panel (Docker Hub - recommended):**
```bash
mkdir hysteria-panel && cd hysteria-panel

# Download required files
curl -O https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/docker-compose.hub.yml
curl -O https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/docker.env.example

# Create Greenlock SSL config (required for HTTPS)
mkdir -p greenlock.d
curl -o greenlock.d/config.json https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/greenlock.d/config.json

cp docker.env.example .env
nano .env  # Set your domain, email, and secrets
docker compose -f docker-compose.hub.yml up -d
```

**Alternative: Build from source** (for development or customization)
```bash
git clone https://github.com/ClickDevTech/hysteria-panel.git
cd hysteria-panel
cp docker.env.example .env
nano .env  # Set your domain, email, and secrets
docker compose up -d
```

**3. Open** `https://your-domain/panel`

**Required `.env` variables:**
```env
PANEL_DOMAIN=panel.example.com
ACME_EMAIL=admin@example.com
ENCRYPTION_KEY=your32characterkey  # openssl rand -hex 16
SESSION_SECRET=yoursessionsecret   # openssl rand -hex 32
MONGO_PASSWORD=yourmongopassword   # openssl rand -hex 16
```

---

## ✨ Features

- 🖥 **Web Panel** — Full UI for managing nodes and users
- 🔐 **HTTP Auth** — Centralized client verification via API
- 🚀 **Auto Node Setup** — Install Hysteria, certs, port hopping in one click
- 👥 **Server Groups** — Flexible user-to-node mapping
- ⚖️ **Load Balancing** — Distribute users by server load
- 🚫 **Traffic Filtering (ACL)** — Block ads, domains, IPs; route through custom proxies
- 📊 **Statistics** — Online users, traffic, server status
- 📱 **Subscriptions** — Auto-format for Clash, Sing-box, Shadowrocket
- 🔄 **Backup/Restore** — Automatic database backups
- 💻 **SSH Terminal** — Direct node access from browser
- 🔑 **API Keys** — Secure external access with scopes, IP allowlist, rate limiting
- 🪝 **Webhooks** — Real-time event notifications with HMAC-SHA256 signing

---

## 🏗 Architecture

```
                              ┌─────────────────┐
                              │     CLIENTS     │
                              │ Clash, Sing-box │
                              │   Shadowrocket  │
                              └────────┬────────┘
                                       │
                          hysteria2://user:pass@host
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
     ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
     │   Node          │      │      Node CH    │      │      Node DE    │
     │   Hysteria 2    │      │   Hysteria 2    │      │   Hysteria 2    │
     │   :443 + hop    │      │   :443 + hop    │      │   :443 + hop    │
     └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
              │                        │                        │
              │    POST /api/auth      │                        │
              │    GET /online         │                        │
              └────────────────────────┼────────────────────────┘
                                       ▼
                          ┌────────────────────────┐
                          │    HYSTERIA PANEL      │
                          │                        │
                          │  • Web UI (/panel)     │
                          │  • HTTP Auth API       │
                          │  • Subscriptions       │
                          │  • SSH Terminal        │
                          │  • Stats Collector     │
                          └───────────┬────────────┘
                                      │
                                      ▼
                          ┌────────────────────────┐
                          │       MongoDB          │
                          └────────────────────────┘
```

### How Authentication Works

1. Client connects to Hysteria node with `userId:password`
2. Node sends `POST /api/auth` to the panel
3. Panel checks: user exists, enabled, device/traffic limits
4. Returns `{ "ok": true, "id": "userId" }` or `{ "ok": false }`

### Server Groups

Instead of rigid "plans", use flexible groups:
- Create group (e.g., "Europe", "Premium")
- Assign nodes to group
- Assign users to group
- User gets only nodes from their groups in subscription

---

## 📖 API Reference

### API Key Authentication

All `/api/*` endpoints (except `/api/auth` and `/api/files`) require authentication via either an API key or an admin session cookie.

**Create a key:** Settings → Security → API Keys → Create Key

**Usage:**
```http
# Option 1 — header
X-API-Key: ck_your_key_here

# Option 2 — Bearer token
Authorization: Bearer ck_your_key_here
```

#### Scopes

| Scope | Access |
|-------|--------|
| `users:read` | Read users |
| `users:write` | Create / update / delete users |
| `nodes:read` | Read nodes |
| `nodes:write` | Create / update / delete / sync nodes |
| `stats:read` | Read stats and groups |
| `sync:write` | Trigger sync, kick users |

#### Rate Limiting

Each key has a configurable rate limit (default: 60 req/min).  
Exceeded requests return `429` with `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers.

#### Error Responses

| Code | Reason |
|------|--------|
| `401` | Invalid, expired, or missing key |
| `403` | Key valid but missing required scope / IP not in allowlist |
| `429` | Rate limit exceeded |

---

### Authentication (for nodes)

#### POST `/api/auth`

Validates user on node connection.

```json
// Request
{ "addr": "1.2.3.4:12345", "auth": "userId:password" }

// Response (success)
{ "ok": true, "id": "userId" }

// Response (error)
{ "ok": false }
```

### Subscriptions

#### GET `/api/files/:token`

Universal subscription endpoint. Auto-detects format by User-Agent.

| User-Agent | Format |
|------------|--------|
| `shadowrocket` | Base64 URI list |
| `clash`, `stash`, `surge` | Clash YAML |
| `hiddify`, `sing-box` | Sing-box JSON |
| Browser | HTML page |
| Other | Plain URI list |

**Query params:** `?format=clash`, `?format=singbox`, `?format=uri`

### Users

Required scope: `users:read` (GET) / `users:write` (POST, PUT, DELETE)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List users (pagination, filtering, sorting) |
| GET | `/api/users/:userId` | Get user |
| POST | `/api/users` | Create user |
| PUT | `/api/users/:userId` | Update user |
| DELETE | `/api/users/:userId` | Delete user |
| POST | `/api/users/:userId/enable` | Enable user |
| POST | `/api/users/:userId/disable` | Disable user |
| POST | `/api/users/:userId/groups` | Add user to groups |
| DELETE | `/api/users/:userId/groups/:groupId` | Remove user from group |

### Nodes

Required scope: `nodes:read` (GET) / `nodes:write` (POST, PUT, DELETE)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/nodes` | List nodes |
| GET | `/api/nodes/:id` | Get node |
| POST | `/api/nodes` | Create node |
| PUT | `/api/nodes/:id` | Update node |
| DELETE | `/api/nodes/:id` | Delete node |
| GET | `/api/nodes/:id/config` | Get node config (YAML) |
| POST | `/api/nodes/:id/sync` | Sync specific node |
| POST | `/api/nodes/:id/update-config` | Push config via SSH |
| POST | `/api/nodes/:id/setup` | **Auto-setup** node via SSH (long-running, ~1–2 min) |

### Stats & Sync

Required scope: `stats:read` / `sync:write`

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| GET | `/api/stats` | `stats:read` | Panel statistics |
| GET | `/api/groups` | `stats:read` | List server groups |
| POST | `/api/sync` | `sync:write` | Sync all nodes |
| POST | `/api/kick/:userId` | `sync:write` | Kick user from all nodes |

---

## 🪝 Webhooks

Send real-time event notifications to any HTTP endpoint.

**Configure:** Settings → Security → Webhooks

### Request Format

```http
POST https://your-endpoint.com/webhook
Content-Type: application/json
X-Webhook-Event: user.created
X-Webhook-Timestamp: 1700000000
X-Webhook-Signature: sha256=<hmac>
User-Agent: C3-Celerity-Webhook/1.0

{
  "event": "user.created",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": { ... }
}
```

### Signature Verification

```js
const crypto = require('crypto');
const expected = 'sha256=' + crypto
  .createHmac('sha256', YOUR_SECRET)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');
// compare with X-Webhook-Signature header
```

### Events

| Event | Trigger |
|-------|---------|
| `user.created` | User created |
| `user.updated` | User updated |
| `user.deleted` | User deleted |
| `user.enabled` | User enabled |
| `user.disabled` | User disabled |
| `user.traffic_exceeded` | User traffic limit reached |
| `user.expired` | User subscription expired |
| `node.online` | Node came online |
| `node.offline` | Node went offline |
| `node.error` | Node sync/config error |
| `sync.completed` | Full sync cycle finished |

Leave the events list empty to receive **all** events.

---

## 🔧 Node Setup

### Understanding Node Configuration

Before adding a node, understand these key concepts:

#### Ports
- **Main port (443)** — The port Hysteria listens on. Use 443 for best compatibility (often allowed through firewalls)
- **Port hopping range (20000-50000)** — Additional UDP ports that redirect to the main port. Helps bypass QoS/throttling
- **Stats port (9999)** — Internal port for collecting traffic statistics from the node

#### Domain vs SNI

| Field | Purpose | Example |
|-------|---------|---------|
| **Domain** | Used for ACME/Let's Encrypt certificates. Must point to the node's IP | `de1.example.com` → `1.2.3.4` |
| **SNI** | What clients show during TLS handshake (for domain fronting). Can be any domain | `www.google.com` or `bing.com` |

**Common scenarios:**
1. **Simple setup**: Set `domain` to a subdomain pointing to your node (e.g., `node1.example.com`). Leave `SNI` empty.
2. **Domain fronting**: Set `domain` for certificates, set `SNI` to a popular domain (e.g., `www.bing.com`) to disguise traffic.
3. **Same VPS for panel and node**: Use different subdomains (e.g., `panel.example.com` for panel, `node.example.com` for node).

> **Note:** The panel domain and node domain(s) should be different subdomains, but can point to the same IP if running on the same VPS.

### Automatic Setup (Recommended)

1. Add node in panel (IP, SSH credentials)
2. Click "⚙️ Auto Setup"
3. Panel will automatically:
   - Install Hysteria 2
   - Configure ACME certificates
   - Set up port hopping
   - Open firewall ports
   - Start service

### Manual Setup

```bash
# Install Hysteria
bash <(curl -fsSL https://get.hy2.sh/)

# Create config /etc/hysteria/config.yaml
listen: :443

acme:
  domains: [node1.example.com]
  email: admin@example.com

auth:
  type: http
  http:
    url: https://panel.example.com/api/auth
    insecure: false

trafficStats:
  listen: :9999
  secret: your_secret

masquerade:
  type: proxy
  proxy:
    url: https://www.google.com
    rewriteHost: true
```

```bash
# Start
systemctl enable --now hysteria-server

# Port hopping (redirect 20000-50000 to 443)
iptables -t nat -A PREROUTING -p udp --dport 20000:50000 -j REDIRECT --to-port 443
```

### Single VPS Setup (Panel + Node)

You can run both the panel and a Hysteria node on the same VPS. Panel uses TCP, node uses UDP on port 443 — they don't conflict.

**Option 1: Use panel domain (recommended)**

Set the node's domain to the same as the panel domain. Auto-setup will automatically copy the panel's SSL certificates to the node.

1. DNS: `panel.example.com` → Your VPS IP
2. Add node with:
   - IP: Your VPS IP
   - Domain: `panel.example.com` (same as panel!)
   - Port: 443
3. Click "Auto Setup" — certificates will be copied automatically

**Option 2: No domain (self-signed)**

Leave the domain field empty. A self-signed certificate will be generated.

1. Add node with:
   - IP: Your VPS IP
   - Domain: *(leave empty)*
   - Port: 443
2. Click "Auto Setup"

**Why not use a different domain?**

If you use a different domain (e.g., `node.example.com`), ACME/Let's Encrypt will fail because port 80 is already used by the panel for its own certificate renewal. The auto-setup will warn you about this.

---

## 📊 Data Models

### User

| Field | Type | Description |
|-------|------|-------------|
| `userId` | String | Unique ID (e.g., Telegram ID) |
| `subscriptionToken` | String | URL token for subscription |
| `enabled` | Boolean | User active status |
| `groups` | [ObjectId] | Server groups |
| `trafficLimit` | Number | Traffic limit in bytes (0 = unlimited) |
| `maxDevices` | Number | Device limit (0 = group limit, -1 = unlimited) |
| `expireAt` | Date | Expiration date |

### Node

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Display name |
| `ip` | String | IP address |
| `domain` | String | Domain for SNI/ACME |
| `port` | Number | Main port (443) |
| `portRange` | String | Port hopping range |
| `groups` | [ObjectId] | Server groups |
| `maxOnlineUsers` | Number | Max online for load balancing |
| `status` | String | online/offline/error |

### ServerGroup

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Group name |
| `color` | String | UI color (#hex) |
| `maxDevices` | Number | Device limit for group |

---

## 🚫 Traffic Filtering (ACL)

Control how traffic is routed on each node. Access via **Panel → Node → Traffic Filtering**.

### Built-in Actions

| Action | Description |
|--------|-------------|
| `reject(...)` | Block connection |
| `direct(...)` | Allow through server |

### Rule Examples

```
reject(suffix:doubleclick.net)     # Block ads
reject(suffix:googlesyndication.com)
reject(geoip:cn)                   # Block Chinese IPs
reject(geoip:private)              # Block private IPs
direct(all)                        # Allow everything else
```

### Presets

One-click presets available:
- **Block Ads** — doubleclick, googlesyndication, etc.
- **Block CN/Private** — Chinese and private IP ranges
- **RU Direct** — Russian sites go through server directly
- **All Direct** — No restrictions

### Custom Proxy Routing

Route specific traffic through your own SOCKS5/HTTP proxy:

1. Add proxy in "Proxy Servers" section (e.g., `my-proxy`, SOCKS5, `1.2.3.4:1080`)
2. Use in rules: `my-proxy(geoip:ru)` or `my-proxy(suffix:example.com)`

---

## ⚖️ Load Balancing

Configure in Settings:

- **Enable balancing** — Sort nodes by current load
- **Hide overloaded** — Exclude nodes at capacity

Algorithm:
1. Get user's nodes from groups
2. Sort by load % (online/max)
3. Filter overloaded if enabled
4. Fall back to `rankingCoefficient`

---

## 🔒 Device Limits

Limit simultaneous connections per user.

**Priority:**
1. User's personal limit (`maxDevices > 0`)
2. Minimum limit from user's groups
3. `-1` = unlimited

On each `POST /api/auth`:
1. Query `/online` from all nodes
2. Count sessions for userId
3. Reject if `>= maxDevices`

---

## 💾 Backups

- **Auto backups** — Configure in Settings
- **Manual backup** — Dashboard button, auto-downloads
- **Restore** — Upload `.tar.gz` archive

---

## 🐳 Docker Compose

```yaml
version: '3.8'

services:
  mongo:
    image: mongo:7
    restart: always
    volumes:
      - mongo_data:/data/db
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${MONGO_USER:-hysteria}
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_PASSWORD}

  backend:
    image: clickdevtech/hysteria-panel:latest  # or build: . for development
    restart: always
    depends_on:
      - mongo
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./logs:/app/logs
      - ./greenlock.d:/app/greenlock.d
      - ./backups:/app/backups
    env_file:
      - .env

volumes:
  mongo_data:
```

---

## 📝 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PANEL_DOMAIN` | ✅ | Panel domain |
| `ACME_EMAIL` | ✅ | Let's Encrypt email |
| `ENCRYPTION_KEY` | ✅ | SSH encryption key (32 chars) |
| `SESSION_SECRET` | ✅ | Session secret |
| `MONGO_PASSWORD` | ✅ | MongoDB password |
| `MONGO_USER` | ❌ | MongoDB user (default: hysteria) |
| `PANEL_IP_WHITELIST` | ❌ | IP whitelist for panel |
| `SYNC_INTERVAL` | ❌ | Sync interval in minutes (default: 2) |
| `API_DOCS_ENABLED` | ❌ | Enable interactive API docs at `/api/docs` (default: false) |

---

## 🤝 Contributing

Pull requests welcome!

---

## 📄 License

MIT
