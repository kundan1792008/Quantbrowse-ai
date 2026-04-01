const { EventEmitter } = require('events');
const crypto = require('crypto');
const tlsHandshake = require('./tls_handshake');

const VALIDATION_INTERVAL_MS = 15000; // 15-second validation cycle

/**
 * Quantmail Biometric Identity Service.
 * Manages the liveness token lifecycle and continuously validates
 * identity via cryptographic TLS handshake every 15 seconds.
 *
 * Events:
 *  - 'identity:verified'   : Handshake passed
 *  - 'identity:failed'     : Handshake failed (tabs must be isolated)
 *  - 'identity:reverified' : User re-verified after a failure
 */
class QuantmailBiometricService extends EventEmitter {
    constructor() {
        super();
        this._intervalHandle = null;
        this._sharedSecret = null;
        this._verified = false;
        this._running = false;
    }

    /**
     * Initialise the biometric identity service and begin the
     * 15-second validation loop.
     * @param {function} [onLog] - Optional log callback
     */
    start(onLog) {
        if (this._running) return;
        this._running = true;

        // Generate a shared secret for this session
        this._sharedSecret = crypto.randomBytes(64).toString('hex');
        this._verified = false;

        this._log(onLog, '[Quantmail] Biometric Identity Service started.');
        this._log(onLog, '[Quantmail] Liveness validation interval: 15 s');

        // Run first validation immediately
        this._performValidation(onLog);

        // Schedule recurring validation every 15 seconds
        this._intervalHandle = setInterval(() => {
            this._performValidation(onLog);
        }, VALIDATION_INTERVAL_MS);
    }

    /**
     * Stops the validation loop.
     * @param {function} [onLog] - Optional log callback
     */
    stop(onLog) {
        if (this._intervalHandle) {
            clearInterval(this._intervalHandle);
            this._intervalHandle = null;
        }
        this._running = false;
        this._log(onLog, '[Quantmail] Biometric Identity Service stopped.');
    }

    /**
     * Simulate a user re-verification (e.g. biometric scan completed).
     * Resets the shared secret and restarts the validation loop.
     * @param {function} [onLog] - Optional log callback
     */
    reverify(onLog) {
        this._log(onLog, '[Quantmail] Re-verification initiated by user.');

        // Rotate the shared secret on re-verification
        this._sharedSecret = crypto.randomBytes(64).toString('hex');
        this._verified = true;

        this.emit('identity:reverified');
        this._log(onLog, '[Quantmail] Identity re-verified successfully.');

        // Restart the interval so the next check is a full 15 s away
        if (this._intervalHandle) {
            clearInterval(this._intervalHandle);
        }
        this._intervalHandle = setInterval(() => {
            this._performValidation(onLog);
        }, VALIDATION_INTERVAL_MS);
    }

    /** @returns {boolean} Whether identity is currently verified */
    get isVerified() {
        return this._verified;
    }

    // ----------------------------------------------------------
    // Internal
    // ----------------------------------------------------------

    /**
     * Perform one validation cycle:
     *  1. Generate a challenge nonce
     *  2. Request a signed liveness token from Quantmail (simulated)
     *  3. Validate the token via TLS handshake
     *
     * @param {function} [onLog] - Optional log callback
     * @private
     */
    _performValidation(onLog) {
        const challenge = tlsHandshake.generateChallenge();

        // In production the token would come from the Quantmail service
        // over a real TLS channel. Here we simulate the round-trip.
        const token = this._requestLivenessToken(challenge);

        const result = tlsHandshake.validate(token, challenge);

        if (result.valid) {
            this._verified = true;
            this.emit('identity:verified');
            this._log(onLog, `[Quantmail] Liveness check PASSED – ${result.reason}`);
        } else {
            this._verified = false;
            this.emit('identity:failed', result.reason);
            this._log(onLog, `[Quantmail] Liveness check FAILED – ${result.reason}`);
        }
    }

    /**
     * Simulate requesting a liveness token from Quantmail.
     * Returns a correctly signed token when the service is healthy.
     *
     * @param {string} challenge
     * @returns {object} liveness token
     * @private
     */
    _requestLivenessToken(challenge) {
        return tlsHandshake.createSignedToken(challenge, this._sharedSecret);
    }

    /** @private */
    _log(onLog, msg) {
        if (typeof onLog === 'function') onLog(msg);
    }
}

module.exports = new QuantmailBiometricService();
