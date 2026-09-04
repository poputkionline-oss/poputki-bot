/**
 * utils/deepLinkParser.js
 *
 * Phase P.1G.3: Telegram Deep Link Parser with Strict Allowlist
 *
 * Supported payload prefixes:
 * - w_<token>     — Web -> Telegram acquisition handshake (single-use, 15 min TTL)
 * - claim_<token> — Passenger ticket claim session
 * - s_<token>     — Ticket handoff claim session (compatibility alias)
 * - ref_<code>    — Passenger recommendation referral code
 * - ride_<id>     — Carpool ride deep link
 * - bus_<id>      — Bus ticket deep link
 *
 * Invariants:
 * - Max length: 64 characters
 * - Character set: [a-zA-Z0-9_-]
 * - Fails safely on malformed or unexpected strings
 * - Never logs or exposes raw tokens
 */

const MAX_PAYLOAD_LENGTH = 64;
const ALLOWED_PAYLOAD_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Parses /start command payload into structured descriptor.
 *
 * @param {string|null|undefined} text Full message text (e.g. "/start w_1234abcd...")
 * @returns {{ type: string, token?: string, code?: string, id?: string, raw?: boolean, valid: boolean }}
 */
export function parseDeepLink(text) {
    if (!text || typeof text !== 'string') {
        return { type: 'empty', valid: true };
    }

    const trimmed = text.trim();
    const parts = trimmed.split(/\s+/);

    if (parts[0].toLowerCase() !== '/start') {
        return { type: 'non_start', valid: false };
    }

    const payload = parts[1];
    if (!payload) {
        return { type: 'empty', valid: true };
    }

    // Security constraints: length limit and character whitelist
    if (payload.length > MAX_PAYLOAD_LENGTH || !ALLOWED_PAYLOAD_REGEX.test(payload)) {
        return { type: 'invalid', valid: false };
    }

    // 1. Web -> Telegram acquisition handshake: w_<token>
    const wMatch = payload.match(/^w_([a-f0-9]{24,64})$/i);
    if (wMatch) {
        return { type: 'w', token: wMatch[1], valid: true };
    }

    // 2. Ticket claim payload: claim_<token>
    const claimMatch = payload.match(/^claim_([a-f0-9]{32})$/i);
    if (claimMatch) {
        return { type: 'claim', token: claimMatch[1], valid: true };
    }

    // 3. Ticket handoff compatibility payload: s_<token>
    const sMatch = payload.match(/^s_([a-f0-9]{24,64})$/i);
    if (sMatch) {
        return { type: 's', token: sMatch[1], valid: true };
    }

    // 4. Passenger referral code: ref_<code>
    const refMatch = payload.match(/^ref_([a-zA-Z0-9_-]{3,32})$/i);
    if (refMatch) {
        return { type: 'ref', code: refMatch[1], valid: true };
    }

    // 5. Ride deep link: ride_<id>
    const rideMatch = payload.match(/^ride_([0-9]+)$/i);
    if (rideMatch) {
        return { type: 'ride', id: rideMatch[1], valid: true };
    }

    // 6. Bus deep link: bus_<id>
    const busMatch = payload.match(/^bus_([0-9]+(?:_c[0-9]+)?)$/i);
    if (busMatch) {
        return { type: 'bus', id: busMatch[1], valid: true };
    }

    // Unrecognized prefix or format
    return { type: 'unrecognized', valid: false };
}
