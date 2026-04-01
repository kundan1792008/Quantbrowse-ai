const { EventEmitter } = require('events');

/**
 * Tab Manager for the Quantbrowse-ai Shell OS.
 * Manages the three core tabs (Quantchat, Quantchill, Quanttube)
 * and provides isolation/resume capabilities triggered by the
 * Quantmail Biometric Identity service.
 */
class TabManager extends EventEmitter {
    constructor() {
        super();
        this._tabs = {
            quantchat:  { id: 'quantchat',  label: 'Quantchat',  active: true, isolated: false },
            quantchill: { id: 'quantchill', label: 'Quantchill', active: true, isolated: false },
            quanttube:  { id: 'quanttube',  label: 'Quanttube',  active: true, isolated: false },
        };
    }

    /**
     * Returns the current state of all tabs.
     * @returns {object[]}
     */
    getTabStates() {
        return Object.values(this._tabs);
    }

    /**
     * Immediately isolate ALL active tabs.
     * Called when the TLS handshake with Quantmail fails.
     * @param {function} [onLog] - Optional log callback
     */
    isolateAll(onLog) {
        for (const key of Object.keys(this._tabs)) {
            this._tabs[key].isolated = true;
            this._tabs[key].active = false;
        }
        this.emit('tabs:isolated', this.getTabStates());
        this._log(onLog, '[TabManager] ALL tabs isolated (Quantchat, Quantchill, Quanttube).');
    }

    /**
     * Resume ALL tabs after successful re-verification.
     * @param {function} [onLog] - Optional log callback
     */
    resumeAll(onLog) {
        for (const key of Object.keys(this._tabs)) {
            this._tabs[key].isolated = false;
            this._tabs[key].active = true;
        }
        this.emit('tabs:resumed', this.getTabStates());
        this._log(onLog, '[TabManager] ALL tabs resumed after identity re-verification.');
    }

    /**
     * @returns {boolean} True if any tab is currently isolated
     */
    get isIsolated() {
        return Object.values(this._tabs).some(t => t.isolated);
    }

    /** @private */
    _log(onLog, msg) {
        if (typeof onLog === 'function') onLog(msg);
    }
}

module.exports = new TabManager();
