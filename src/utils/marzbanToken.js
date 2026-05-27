/**
 * Marzban subscription-token decoder.
 *
 * Pure JS port of `app/utils/jwt.py::get_subscription_payload` from Marzban.
 * Two formats coexist in the wild:
 *
 *   1. JWT  HS256 — header is the well-known `{"alg":"HS256","typ":"JWT"}`,
 *      payload carries {sub, iat, access:"subscription"}. Older Marzban builds
 *      and the FastAPI router still accept these.
 *
 *   2. Compact custom — `base64url(username,unix_ts)` followed by a 10-char
 *      truncation of the sha256(body + secret) digest, base64-encoded with
 *      the `-_` altchars. This is the active default since Marzban 0.6+.
 *
 * The decoder is allocation-light and constant-time on signature compare so
 * it is safe to put behind a single shared HTTP middleware. Returns `null`
 * for anything malformed — caller maps `null` to HTTP 404.
 */

const crypto = require('crypto');

// `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9` is the URL-safe base64 of
// `{"alg":"HS256","typ":"JWT"}` — Marzban hard-codes this exact header, so a
// prefix check is enough to distinguish the JWT branch from the custom one.
const JWT_HEADER_PREFIX = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.';

// Minimum token length we even bother parsing. Mirrors Marzban behaviour
// (15 in Python) — anything shorter cannot carry a useful payload + signature.
const MIN_TOKEN_LENGTH = 15;

// Custom-format signature is exactly the first 10 chars of a base64-encoded
// sha256 digest. Anything else means we are not looking at a Marzban token.
const CUSTOM_SIG_LENGTH = 10;

/**
 * Constant-time compare of two ASCII strings of identical length.
 * Returns false instead of throwing when lengths differ.
 */
function _safeStringEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Marzban-style JWT and extract the subscription payload.
 * Returns { username, createdAt } on success or null on any failure.
 *
 * We do not import `jsonwebtoken` — Marzban only ever signs with HS256 and
 * we already need `crypto` for the custom branch. Keeping it inline avoids
 * pulling another transitive dependency for ~15 lines of logic.
 */
function _decodeJwt(token, secret) {
    const dot1 = token.indexOf('.');
    if (dot1 < 0) return null;
    const dot2 = token.indexOf('.', dot1 + 1);
    if (dot2 < 0) return null;
    if (token.indexOf('.', dot2 + 1) >= 0) return null;

    const signingInput = token.slice(0, dot2);
    const providedSig = token.slice(dot2 + 1);
    if (!providedSig) return null;

    const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(signingInput)
        .digest('base64url');

    if (!_safeStringEqual(providedSig, expectedSig)) return null;

    let payload;
    try {
        const payloadJson = Buffer.from(token.slice(dot1 + 1, dot2), 'base64url').toString('utf8');
        payload = JSON.parse(payloadJson);
    } catch (_) {
        return null;
    }

    if (!payload || typeof payload !== 'object') return null;
    if (payload.access !== 'subscription') return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;

    const iat = Number(payload.iat);
    if (!Number.isFinite(iat) || iat <= 0) return null;

    return { username: payload.sub, createdAt: new Date(iat * 1000) };
}

/**
 * Decode the compact custom Marzban token. The body is `base64url(username,ts)`
 * (padding stripped) and the trailing 10 chars are the truncated b64 of
 * sha256(body + secret).
 *
 * Notable detail: Marzban signs the body string *as ASCII* (not the decoded
 * bytes) and concatenates it with the raw secret hex. We mirror that exactly.
 */
function _decodeCustom(token, secret) {
    if (token.length <= CUSTOM_SIG_LENGTH) return null;

    const body = token.slice(0, -CUSTOM_SIG_LENGTH);
    const providedSig = token.slice(-CUSTOM_SIG_LENGTH);

    // Reject obvious garbage early — the body must be valid base64url.
    if (!/^[A-Za-z0-9_\-]+$/.test(body)) return null;

    // Marzban uses Python's b64encode(..., altchars=b'-_') and slices the first
    // 10 chars. Node's `base64url` is the same alphabet with padding stripped;
    // since sha256 → 32 bytes → 43-char unpadded output, the first 10 chars
    // are identical in both encodings, so `base64url` is the right pick.
    const expectedSig = crypto
        .createHash('sha256')
        .update(body + secret)
        .digest('base64url')
        .slice(0, CUSTOM_SIG_LENGTH);

    if (!_safeStringEqual(providedSig, expectedSig)) return null;

    let decoded;
    try {
        decoded = Buffer.from(body, 'base64url').toString('utf8');
    } catch (_) {
        return null;
    }

    const commaIdx = decoded.indexOf(',');
    if (commaIdx <= 0) return null;

    const username = decoded.slice(0, commaIdx);
    const tsStr = decoded.slice(commaIdx + 1);
    if (!username) return null;

    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || ts <= 0) return null;

    return { username, createdAt: new Date(ts * 1000) };
}

/**
 * Public entry point. Distinguishes JWT vs custom by the JWT header prefix.
 *
 * @param {string} token  Raw token from the URL.
 * @param {string} secret Marzban JWT secret (the value of `jwt.secret_key` row).
 * @returns {{username: string, createdAt: Date} | null}
 */
function decodeMarzbanToken(token, secret) {
    if (typeof token !== 'string' || typeof secret !== 'string') return null;
    if (token.length < MIN_TOKEN_LENGTH || !secret) return null;

    if (token.startsWith(JWT_HEADER_PREFIX)) {
        return _decodeJwt(token, secret);
    }
    return _decodeCustom(token, secret);
}

module.exports = { decodeMarzbanToken };
