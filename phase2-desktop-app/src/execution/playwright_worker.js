const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

class PlaywrightWorker {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
    }

    async init(onLog) {
        onLog("Launching Chromium (Headless)...");
        // Launch completely invisible to the user
        this.browser = await chromium.launch({ headless: true });
        
        // Setup an isolated incognito context
        this.context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        this.page = await this.context.newPage();
        onLog("Sandbox Browser Ready.");
    }

    /**
     * Executes an AI-directed web task.
     */
    async performSearchTask(intent, onLog) {
        // This is a stub for the LLM-driven execution loop
        // In reality, this function receives `page` and evaluates actions sequentially
        onLog(`Navigating to DuckDuckGo to process: "${intent}"`);
        await this.page.goto('https://duckduckgo.com/');
        
        onLog("Typing search query...");
        await this.page.fill('input[name="q"]', intent);
        await this.page.press('input[name="q"]', 'Enter');
        
        onLog("Waiting for search results...");
        await this.page.waitForSelector('.result__title');
        
        onLog("Extracting raw DOM data...");
        const titles = await this.page.$$eval('.result__title a', links => {
             return links.slice(0, 5).map(a => a.innerText);
        });

        // Write the findings to the local filesystem (Command Center specific feature)
        this._saveDataToFile(titles, onLog);

        return `Scraped ${titles.length} results: \n- ` + titles.join('\n- ');
    }
    
    async performDeterministicTask(intent, onLog) {
        onLog(`Navigating to Wikipedia...`);
        await this.page.goto('https://en.wikipedia.org/wiki/Special:Random');
        const title = await this.page.title();
        
        onLog(`Landed on: ${title}`);
        
        const firstParagraph = await this.page.$eval('p:not(.mw-empty-elt)', p => p.innerText);
        
        this._saveDataToFile([firstParagraph], onLog);
        
        return `Read article: ${title}\nData saved to disk.`;
    }

    _saveDataToFile(data, onLog) {
        const outputDir = path.join(process.cwd(), 'output');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        
        const filePath = path.join(outputDir, `agent_dump_${Date.now()}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        onLog(`Saved scraped data locally to -> ${filePath}`);
    }

    async close(onLog) {
        if (this.browser) {
            onLog("Shutting down Chromium instances...");
            await this.browser.close();
        }
    }
}

module.exports = new PlaywrightWorker();
