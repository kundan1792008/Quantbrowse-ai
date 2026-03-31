// Quantbrowse-ai — Agent Swarm Config
// Initialized by Llama-3; extended for the Master Super-App Shell architecture.
//
// Shell topology:
//   Quantbrowse-ai (this repo) — unified OS shell
//     ├── Quanttube   — decentralised video MFE
//     ├── Quantchat   — AI-powered encrypted messaging MFE
//     └── Quantsink   — data aggregation / analytics MFE
//
// Deployment targets:
//   Desktop — Tauri 2 (src-tauri/)
//   Mobile  — Capacitor 6 (capacitor.config.json)
//   Web     — Vite + React (src/)
//
// Cross-cutting concerns:
//   BCI Telemetry — src/bci/BCITelemetry.js + src/bci/BCIProvider.jsx

export const SHELL_CONFIG = {
  version: "0.1.0",
  microFrontends: {
    quanttube: {
      description: "Decentralised video streaming",
      devUrl: "http://localhost:5001",
      prodPath: "/mfe/quanttube/",
    },
    quantchat: {
      description: "AI-powered encrypted messaging",
      devUrl: "http://localhost:5002",
      prodPath: "/mfe/quantchat/",
    },
    quantsink: {
      description: "Decentralised data aggregation & analytics",
      devUrl: "http://localhost:5003",
      prodPath: "/mfe/quantsink/",
    },
  },
  bci: {
    enabled: true,
    intentNavigationThreshold: 30, // frames of sustained 'navigate' intent to auto-switch apps
    supportedDevices: ["OpenBCI", "Emotiv", "Muse", "NeuraLink-adapter"],
  },
  platforms: {
    desktop: { framework: "Tauri", version: "2" },
    mobile: { framework: "Capacitor", version: "6" },
    web: { framework: "Vite+React", version: "5+18" },
  },
};
