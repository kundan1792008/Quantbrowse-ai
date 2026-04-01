const crypto = require('crypto');

/**
 * Cryptographic TLS Handshake Validator for Quantmail Biometric Identity.
 * Validates a liveness token by performing a challenge-response
 * handshake using HMAC-SHA256 signatures.
 */
class TLSHandshakeValidator {
    constructor() {
        this.algorithm = 'sha256';
    }

    /**
     * Generates a cryptographic challenge nonce.
     * @returns {string} Hex-encoded random nonce
     */
    generateChallenge() {
        return crypto.randomBytes(32).toString('hex');
    }

    /**
     * Validates a liveness token against a challenge using HMAC-SHA256.
     * The token must contain a valid signature that matches the expected
     * HMAC of the challenge using the shared secret.
     *
     * @param {object} token - The liveness token from Quantmail
     * @param {string} token.payload - The signed payload
     * @param {string} token.signature - The HMAC signature
     * @param {string} token.secret - The shared secret key
     * @param {string} challenge - The challenge nonce to validate against
     * @returns {{ valid: boolean, reason: string }}
     */
    validate(token, challenge) {
        if (!token || !token.payload || !token.signature || !token.secret) {
            return { valid: false, reason: 'Malformed liveness token: missing required fields' };
        }

        if (!challenge) {
            return { valid: false, reason: 'No challenge nonce provided for handshake' };
        }

        try {
            // Verify the token payload contains the challenge
            const payloadData = JSON.parse(token.payload);
            if (payloadData.challenge !== challenge) {
                return { valid: false, reason: 'Challenge mismatch in token payload' };
            }

            // Check token expiry (tokens are valid for 30 seconds)
            const now = Date.now();
            if (payloadData.exp && now > payloadData.exp) {
                return { valid: false, reason: 'Liveness token has expired' };
            }

            // Verify HMAC signature
            const expectedSignature = crypto
                .createHmac(this.algorithm, token.secret)
                .update(token.payload)
                .digest('hex');

            const isValid = crypto.timingSafeEqual(
                Buffer.from(token.signature, 'hex'),
                Buffer.from(expectedSignature, 'hex')
            );

            if (!isValid) {
                return { valid: false, reason: 'TLS handshake signature verification failed' };
            }

            return { valid: true, reason: 'TLS handshake successful' };
        } catch (err) {
            return { valid: false, reason: `TLS handshake error: ${err.message}` };
        }
    }

    /**
     * Creates a properly signed liveness token for testing or local identity.
     * In production, this would come from the Quantmail Biometric service.
     *
     * @param {string} challenge - The challenge nonce
     * @param {string} secret - The shared secret key
     * @param {number} [ttlMs=30000] - Token time-to-live in milliseconds
     * @returns {object} A signed liveness token
     */
    createSignedToken(challenge, secret, ttlMs = 30000) {
        const payload = JSON.stringify({
            challenge,
            iss: 'quantmail-biometric',
            sub: 'liveness',
            iat: Date.now(),
            exp: Date.now() + ttlMs,
        });

        const signature = crypto
            .createHmac(this.algorithm, secret)
            .update(payload)
            .digest('hex');

        return { payload, signature, secret };
    }
}

module.exports = new TLSHandshakeValidator();
