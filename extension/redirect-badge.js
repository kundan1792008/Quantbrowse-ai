/**
 * redirect-badge.js — Quantbrowse AI Ecosystem Redirect Content Script
 *
 * Injected into competitor sites listed in ecosystem-redirect.js.
 * Shows a subtle, dismissible badge inviting users to switch to the
 * equivalent Quant application.
 *
 * Visual design:
 *  - Floating badge in the bottom-right corner, 320 px wide.
 *  - Renders inside a closed Shadow DOM to avoid CSS conflicts.
 *  - Slide-in animation on arrival; slide-out on dismiss.
 *  - Disappears automatically after 12 seconds if not interacted with.
 *
 * Message protocol (to background.js):
 *  GET_REDIRECT_RULE    — fetch the applicable rule for this page
 *  REDIRECT_ACCEPTED    — user clicked the CTA button
 *  REDIRECT_DISMISSED   — user closed the badge
 */

// ─── Guard: only run once per page ────────────────────────────────────────
if (window.__qbaRedirectBadgeLoaded__) {
  // Already injected — do nothing
} else {
  window.__qbaRedirectBadgeLoaded__ = true;

  // ─── Shadow DOM host ───────────────────────────────────────────────────
  const HOST_ID = "__qba-redirect-host__";
  const AUTO_DISMISS_MS = 12000;

  /**
   * Creates and injects the redirect badge for the given rule.
   * @param {{ competitor: string, quantApp: string, quantUrl: string,
   *            feature: string, badgeLabel: string }} rule
   */
  function injectBadge(rule) {
    if (document.getElementById(HOST_ID)) return; // already shown

    const host = document.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "2147483647",
      fontFamily: "system-ui, -apple-system, sans-serif",
    });
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "closed" });

    // ── Styles ─────────────────────────────────────────────────────────
    const style = document.createElement("style");
    style.textContent = `
      @keyframes qba-slide-in {
        from { transform: translateX(120%); opacity: 0; }
        to   { transform: translateX(0);    opacity: 1; }
      }
      @keyframes qba-slide-out {
        from { transform: translateX(0);    opacity: 1; }
        to   { transform: translateX(120%); opacity: 0; }
      }

      .badge {
        width: 320px;
        background: #0f172a;
        border: 1px solid #334155;
        border-radius: 12px;
        padding: 14px 16px;
        color: #f1f5f9;
        box-shadow: 0 8px 32px rgba(0,0,0,.45);
        animation: qba-slide-in 0.35s cubic-bezier(.22,.68,0,1.2) forwards;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-sizing: border-box;
      }
      .badge.hiding {
        animation: qba-slide-out 0.28s ease-in forwards;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .logo {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .logo-icon {
        width: 22px;
        height: 22px;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 700;
        color: #fff;
        flex-shrink: 0;
      }
      .logo-name {
        font-size: 12px;
        font-weight: 600;
        color: #94a3b8;
        letter-spacing: .04em;
        text-transform: uppercase;
      }
      .close-btn {
        background: none;
        border: none;
        color: #64748b;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 4px;
        transition: color .15s;
      }
      .close-btn:hover { color: #f1f5f9; }

      .body {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .app-name {
        font-size: 14px;
        font-weight: 700;
        color: #e2e8f0;
      }
      .feature {
        font-size: 12px;
        color: #94a3b8;
        line-height: 1.4;
      }

      .cta {
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        color: #fff;
        border: none;
        border-radius: 8px;
        padding: 9px 14px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity .15s, transform .1s;
        text-align: center;
      }
      .cta:hover  { opacity: .88; transform: scale(1.02); }
      .cta:active { opacity: .78; transform: scale(.98); }

      .footer {
        font-size: 10px;
        color: #475569;
        text-align: center;
      }
    `;
    shadow.appendChild(style);

    // ── Markup ─────────────────────────────────────────────────────────
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.innerHTML = `
      <div class="header">
        <div class="logo">
          <div class="logo-icon">Q</div>
          <span class="logo-name">Quantbrowse</span>
        </div>
        <button class="close-btn" title="Dismiss">✕</button>
      </div>
      <div class="body">
        <div class="app-name">${escapeHtml(rule.quantApp)}</div>
        <div class="feature">${escapeHtml(rule.feature)}</div>
      </div>
      <button class="cta">${escapeHtml(rule.badgeLabel)}</button>
      <div class="footer">Powered by Quantbrowse AI • Click ✕ to hide for 4h</div>
    `;
    shadow.appendChild(badge);

    // ── Auto-dismiss timer ─────────────────────────────────────────────
    let autoDismissTimer = setTimeout(() => dismiss(false), AUTO_DISMISS_MS);

    // ── Event handlers ─────────────────────────────────────────────────
    function dismiss(accepted) {
      clearTimeout(autoDismissTimer);
      badge.classList.add("hiding");
      setTimeout(() => {
        host.remove();
      }, 300);
      chrome.runtime.sendMessage({
        type: accepted ? "REDIRECT_ACCEPTED" : "REDIRECT_DISMISSED",
      }).catch(() => {});
    }

    badge.querySelector(".close-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      dismiss(false);
    });

    badge.querySelector(".cta").addEventListener("click", () => {
      dismiss(true);
      // Navigate to the Quant app
      const dest = encodeURI(rule.quantUrl);
      window.open(dest, "_blank", "noopener,noreferrer");
    });

    // Pause auto-dismiss on hover
    badge.addEventListener("mouseenter", () => clearTimeout(autoDismissTimer));
    badge.addEventListener("mouseleave", () => {
      autoDismissTimer = setTimeout(() => dismiss(false), AUTO_DISMISS_MS);
    });
  }

  /**
   * Minimal HTML entity escaper to prevent XSS from rule strings.
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ─── Bootstrap ──────────────────────────────────────────────────────────

  /**
   * Asks the background worker for the applicable redirect rule and, if
   * one exists, injects the badge.  Waits for DOM ready.
   */
  async function bootstrap() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_REDIRECT_RULE" });
      if (response?.rule) {
        injectBadge(response.rule);
      }
    } catch {
      // Background service worker may be sleeping on first load; retry once
      setTimeout(async () => {
        try {
          const response = await chrome.runtime.sendMessage({ type: "GET_REDIRECT_RULE" });
          if (response?.rule) injectBadge(response.rule);
        } catch {
          // Give up silently
        }
      }, 1500);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }

  // Re-check on SPA navigation (pushState / hashchange)
  let lastUrl = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Remove existing badge (if any) before re-evaluating
      document.getElementById(HOST_ID)?.remove();
      bootstrap();
    }
  });
  navObserver.observe(document.documentElement, { subtree: true, childList: true });
}
