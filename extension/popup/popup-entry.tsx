/**
 * popup-entry.tsx - Bundled entry for the popup dashboard.
 *
 * Mounts the React Dashboard component into a host page (the side panel
 * or a dashboard popup HTML). The legacy `popup.html` keeps using the
 * vanilla `popup.js` for the simple prompt UI; this bundle is reserved
 * for the richer `dashboard.html` (added in a follow-up).
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './Dashboard';

const ROOT_ID = 'qb-dashboard-root';

function mount(): void {
  const container =
    document.getElementById(ROOT_ID) ?? (() => {
      const el = document.createElement('div');
      el.id = ROOT_ID;
      document.body.appendChild(el);
      return el;
    })();
  createRoot(container).render(
    <StrictMode>
      <Dashboard />
    </StrictMode>
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
