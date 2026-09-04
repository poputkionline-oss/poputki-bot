/**
 * utils/signedBackendClient.js
 *
 * Phase P.1G.3: HMAC-SHA256 Signed Backend Client for Telegram Bot
 *
 * Securely calls internal backend endpoints with replay protection
 * (timestamp + cryptographic nonce).
 */

import crypto from 'crypto';

/**
 * Returns the configured internal secret for bot -> backend HMAC calls.
 *
 * Phase P.1G.3A: no fallback to CLAIM_BOT_SHARED_SECRET or BOT_TOKEN — those
 * are separate secrets for separate concerns (the ticket-claim flow's
 * X-Claim-Bot-Secret header, and the raw Telegram bot token). Reusing either
 * here would mean a leak of one secret compromises both mechanisms. If
 * INTERNAL_SERVICE_SECRET is not set, signing fails closed (see
 * createSignedHeaders below).
 *
 * @returns {string|null}
 */
export function getBotSharedSecret() {
    return process.env.INTERNAL_SERVICE_SECRET || null;
}

/**
 * Creates HMAC-SHA256 authentication headers for internal backend calls.
 *
 * @param {Object} params
 * @param {string} params.method HTTP method (e.g. POST)
 * @param {string} params.path URL path (e.g. /api/internal/acquisition/consume-telegram-session)
 * @param {any} params.body Request body
 * @param {string} [params.secret] Shared secret override
 * @returns {Record<string, string>} Signed headers
 */
export function createSignedHeaders({ method = 'POST', path, body, secret = null }) {
    const sharedSecret = secret || getBotSharedSecret();
    if (!sharedSecret) {
        throw new Error('BOT_SHARED_SECRET_NOT_CONFIGURED');
    }

    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const bodyString = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex');

    const normalizedPath = (path || '').split('?')[0];
    const stringToSign = `${method.toUpperCase()}:${normalizedPath}:${timestamp}:${nonce}:${bodyHash}`;
    const signature = crypto.createHmac('sha256', sharedSecret).update(stringToSign).digest('hex');

    return {
        'Content-Type': 'application/json',
        'x-internal-timestamp': timestamp,
        'x-internal-nonce': nonce,
        'x-internal-signature': signature
    };
}

/**
 * Makes an authenticated, signed POST request to the backend.
 *
 * @param {string} path Endpoint path (e.g. /api/internal/acquisition/consume-telegram-session)
 * @param {any} body JSON-serializable body
 * @returns {Promise<any>} Parsed response data
 */
export async function signedBackendPost(path, body) {
    const backendApiUrl = (process.env.BACKEND_API_URL || 'https://poputki-backend-9dv6.onrender.com/api').replace(/\/$/, '');
    const headers = createSignedHeaders({
        method: 'POST',
        path,
        body
    });

    const fullUrl = `${backendApiUrl}${path.startsWith('/api') ? path.replace(/^\/api/, '') : path}`;
    const response = await fetch(fullUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || data.message || `BACKEND_${response.status}`);
        error.code = data.error || data.message || `BACKEND_${response.status}`;
        error.status = response.status;
        throw error;
    }

    return data;
}
