// scripts/llm_api.js - AI Reasoning API Layer (Built by Backend API Specialist)

/**
 * Sends the parsed Accessibility Tree and User Intent to the LLM
 * to determine the exact action to execute on the webpage.
 */
async function callPlannerAgentAPI(intent, pageSnapshot) {
    console.log("[API Specialist] Preparing payload for LLM Reasoning...");
    
    // In a production environment, this key MUST be stored in an encrypted backend 
    // or provided by the user via extension options. 
    // For this MVP, we will structure it to accept a standard Gemini / Claude API endpoint.
    const API_KEY = "YOUR_LLM_API_KEY_HERE"; // Placeholder
    
    // If no key is set, we fallback to a smart offline mock for demonstration
    if (API_KEY === "YOUR_LLM_API_KEY_HERE") {
        console.warn("[API Specialist] No valid API Key found. Falling back to rule-based mock engine.");
        return fallbackRuleBasedEngine(intent, pageSnapshot);
    }

    const systemPrompt = `
You are the brains of an autonomous Web Agent. 
You will be provided with:
1. USER INTENT: What the user wants to achieve.
2. PAGE STATE: A JSON array of interactive elements currently visible on the screen.

Your job is to find the single most appropriate element to interact with to fulfill the user's intent.

Respond strictly in JSON format:
{
  "action": "click" | "type" | "NONE",
  "elementId": "the agent-id of the chosen element",
  "value": "string to type if action is type, else null",
  "reasoning": "Brief explanation of why you chose this"
}`;

    const userPrompt = `
USER INTENT: "${intent}"

PAGE STATE:
${JSON.stringify(pageSnapshot.elements, null, 2)}
    `;

    try {
        // Example: Fetching from Google Gemini API
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }],
                generationConfig: { response_mime_type: "application/json" }
            })
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const data = await response.json();
        const llmResponseText = data.candidates[0].content.parts[0].text;
        
        // 🛡️ JSON EXTRACTION GUARDRAIL
        // LLMs often hallucinate by wrapping JSON in markdown blocks (```json ... ```).
        // This regex ensures we cleanly strip everything outside the JSON object.
        const jsonMatch = llmResponseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
             throw new Error("LLM did not return a valid JSON object.");
        }
        
        return JSON.parse(jsonMatch[0]);

    } catch (error) {
        console.error("[API Specialist] LLM API Call Failed:", error);
        return { action: "NONE", reason: "API Connection Failed" };
    }
}

// A slightly smarter mock engine for when the API key isn't set
function fallbackRuleBasedEngine(intent, pageSnapshot) {
    return new Promise((resolve) => {
        setTimeout(() => {
            if (!pageSnapshot || !pageSnapshot.elements || pageSnapshot.elements.length === 0) {
                return resolve({ action: 'NONE', reason: 'No interactive elements found.' });
            }

            const intentWords = intent.toLowerCase().split(' ');
            let bestMatch = null;
            let highestScore = 0;

            // Simple scoring algorithm to find the right element
            pageSnapshot.elements.forEach(el => {
                let score = 0;
                const elText = el.text.toLowerCase();
                
                intentWords.forEach(word => {
                    if (word.length > 2 && elText.includes(word)) {
                        score += 3; // Word match
                    }
                });

                if (intentWords.includes('click') && el.role === 'button') score += 1;
                if (intentWords.includes('type') && el.role === 'input') score += 2;

                if (score > highestScore) {
                    highestScore = score;
                    bestMatch = el;
                }
            });

            if (bestMatch && highestScore > 0) {
                 if (intentWords.includes('type') || bestMatch.role === 'input' || bestMatch.type === 'text') {
                     // Extract what to type (everything after 'type')
                     let textToType = intent;
                     if(intent.toLowerCase().includes('type')) {
                         textToType = intent.split(/type/i)[1].trim();
                     }
                     resolve({ action: 'type', elementId: bestMatch.id, value: textToType, reasoning: "Matched via fallback engine" });
                 } else {
                     resolve({ action: 'click', elementId: bestMatch.id, reasoning: "Matched via fallback engine" });
                 }
            } else {
                 resolve({ action: 'NONE', reason: 'No confident match found.' });
            }

        }, 500); // 500ms processing delay
    });
}
