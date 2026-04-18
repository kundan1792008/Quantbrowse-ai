# Quantbrowse AI

AI-powered Chrome extension that reads the active webpage and responds to natural language commands — powered by OpenAI GPT.

## Architecture

```
Quantbrowse-ai/
├── app/
│   └── api/
│       └── browse/
│           └── route.ts      # Next.js AI processing endpoint
├── extension/
│   ├── manifest.json         # Chrome Extension Manifest V3
│   ├── background.js         # Service worker (orchestrates API calls)
│   ├── content.js            # DOM extractor (injected into web pages)
│   ├── popup.html            # Extension popup UI
│   └── popup.js              # Popup interaction logic
├── .env.example              # Environment variable template
├── next.config.js
├── package.json
└── tsconfig.json
```

## Backend Setup (Next.js API)

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
# Edit .env.local and set your OPENAI_API_KEY
```

### 3. Run the development server

```bash
npm run dev
```

The API will be available at `http://localhost:3000/api/browse`.

### API Reference

**POST** `/api/browse`

| Field        | Type   | Description                              |
|--------------|--------|------------------------------------------|
| `prompt`     | string | The user's natural language command      |
| `domContent` | string | Extracted visible text from the webpage  |

**Response:**

```json
{ "result": "AI-generated response text" }
```

---

## Extension Setup

### 1. (Development) Point the extension to your local server

The extension's `background.js` defaults to `http://localhost:3000`. For production, update `API_BASE_URL` to your deployed Next.js URL.

### 2. Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `extension/` folder
4. The **Quantbrowse AI** icon will appear in your toolbar

### 3. Use the extension

1. Navigate to any webpage
2. Click the **Quantbrowse AI** icon
3. Type a command (e.g. _"Summarize this article"_, _"Extract all prices"_)
4. Press **Run AI Command** or `Ctrl+Enter`

---

## Security

- The `OPENAI_API_KEY` is stored exclusively in `.env.local` on the server. It is **never** included in the extension code.
- All AI processing happens server-side via the `/api/browse` endpoint.
- DOM content is truncated to 12 000 characters before being sent to the API to limit token usage and prevent unintentional data exfiltration.
- The optional declarativeNetRequest ruleset at `extension/rules/csp_bypass.json` is disabled by default and scoped to Quantbrowse domains; enable it only for internal debugging when you need to relax CSP headers.
