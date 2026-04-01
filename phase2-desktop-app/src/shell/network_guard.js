const { EventEmitter } = require('events');

/**
 * Network Guard for the Quantbrowse-ai Shell OS.
 * Pauses and resumes all outbound network logic when the Quantmail
 * biometric identity handshake fails or is re-verified.
 */
class NetworkGuard extends EventEmitter {
    constructor() {
        super();
        this._paused = false;
    }

    /**
     * Pause all network logic.
     * Called when the TLS handshake with Quantmail fails.
     * @param {function} [onLog] - Optional log callback
     */
    pause(onLog) {
        if (this._paused) return;
        this._paused = true;
        this.emit('network:paused');
        this._log(onLog, '[NetworkGuard] Network logic PAUSED – awaiting identity re-verification.');
    }

    /**
     * Resume network logic after successful re-verification.
     * @param {function} [onLog] - Optional log callback
     */
    resume(onLog) {
        if (!this._paused) return;
        this._paused = false;
        this.emit('network:resumed');
        this._log(onLog, '[NetworkGuard] Network logic RESUMED.');
    }

    /**
     * Check whether network logic is currently paused.
     * Other modules should call this before performing network requests.
     * @returns {boolean}
     */
    get isPaused() {
        return this._paused;
    }

    /** @private */
    _log(onLog, msg) {
        if (typeof onLog === 'function') onLog(msg);
    }
}

module.exports = new NetworkGuard();
