const playwrightWorker = require('../execution/playwright_worker');
require('dotenv').config();

/**
 * The Central Brain of the Desktop App.
 * Receives the high-level intent, breaks it down, and delegates tools.
 */
class AutonomousOrchestrator {
    constructor() {
        this.apiKey = process.env.LLM_API_KEY;
    }

    /**
     * Executes the task by streaming logs back to the UI.
     * @param {string} intent "Scrape 10 emails from site X"
     * @param {function} onLog Callback to update the UI
     */
    async executeTask(intent, onLog) {
        onLog(`Initializing Task: ${intent}`);
        
        if (!this.apiKey || this.apiKey === 'YOUR_API_KEY') {
            onLog("WARNING: LLM_API_KEY not found in .env file.");
            onLog("Falling back to deterministic test mode.");
            return this._runDeterministicMock(intent, onLog);
        }

        try {
            onLog("Connecting to LLM reasoning engine...");
            // TODO: In a production app, this would use LangChain/Agent system to loop:
            // 1. LLM decides next step (e.g. "go_to_url")
            // 2. PlaywrightWorker executes "go_to_url"
            // 3. PlaywrightWorker returns page HTML to LLM.
            // 4. LLM decides next step...
            
            // For MVP, we will simulate the LLM deciding to use the browser tool directly.
            onLog("LLM Directive: 'Execute web search via Playwright'");
            
            // Start the headless browser
            await playwrightWorker.init(onLog);
            
            // Ask playwright to do a basic search & capture task
            // Ideally, the LLM provides these strict parameters
            const result = await playwrightWorker.performSearchTask(intent, onLog);
            
            // Shutdown safely
            await playwrightWorker.close(onLog);
            
            onLog("Task completed successfully.");
            return result;
            
        } catch (error) {
            onLog(`CRITICAL ERROR: ${error.message}`);
            throw error;
        }
    }

    async _runDeterministicMock(intent, onLog) {
        onLog("Simulating agent planning phase...");
        await new Promise(r => setTimeout(r, 2000));
        
        onLog("Booting isolated Playwright Sandbox...");
        await playwrightWorker.init(onLog);
        
        onLog("Executing fallback navigation script...");
        const result = await playwrightWorker.performDeterministicTask(intent, onLog);
        
        await playwrightWorker.close(onLog);
        
        return result;
    }
}

module.exports = new AutonomousOrchestrator();
