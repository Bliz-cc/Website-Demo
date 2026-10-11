/**
 * blizid.script.js — Bliz First-Party Attribution Tracker
 *
 * Attribution is driven by a server-set first-party cookie (_fpc_*_sid) placed
 * during the short link redirect. This cookie is ITP/ETP-immune (1-year MaxAge)
 * because it is set via a Set-Cookie HTTP response header, not JavaScript.
 *
 * Flow:
 *   1. User clicks Bliz short link → server sets _fpc_*_sid cookie (JWE token)
 *   2. Script reads token from cookie (getCookieToken)
 *   3. Events sent via fetch with credentials:'include' → browser attaches cookie
 *   4. Next.js proxy extracts cookie → forwards as x-bliz-sid header to NestJS
 *   5. NestJS guard verifies JWE → resolves session + link for attribution
 *
 * Public API (window.BlizTracker):
 *   getSidToken()    → current session token (from cookie)
 *   getBlizsid()     → alias for getSidToken()
 *   isActive()       → true if token is present
 *   trackPageView()  → manually fire a page view (e.g. after SPA navigation)
 *   trackRevenue(data, customerOpt) → fire a purchase/revenue event
 *   trackConversion(data, customerOpt) → fire a conversion event
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var currentSidToken = null;
  var BLIZ_CLIENT_SIDE_XMLK_SECRET = "bliz_secret_2024";

  // Batch queue: events are buffered and flushed as a single request after 1 second
  var batchQueue = [];
  var batchTimer = null;
  var BATCH_DELAY_MS = 1000;

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  var CONFIG = {
    revenueOrderKey: "bliz_revenue_orders", // localStorage key for revenue dedup
    stages: {
      VIEW: "VIEW",
      ENGAGE: "ENGAGE",
      SUBMITS: "SUBMITS",
      CONVERSION: "CONVERSION",
      CONVERT: "CONVERT",
    },
    categories: {
      PAGE: "page",
      LINK: "link",
      BUTTON: "button",
      FORM: "form",
      PURCHASE: "purchase",
      CONVERSION: "conversion"
    }
  };

  // ---------------------------------------------------------------------------
  // Cookie Reader
  // Reads the first-party _fpc_*_sid cookie set server-side during redirect.
  // Cookie pattern: _fpc_{brand}_sid (e.g. _fpc_supta_sid, _fpc_blizcc_sid)
  // ---------------------------------------------------------------------------

  function getCookieToken() {
    if (!document.cookie) return null;
    var cookies = document.cookie.split(';');
    for (var i = 0; i < cookies.length; i++) {
      var cookie = cookies[i].trim();
      var eqPos = cookie.indexOf('=');
      if (eqPos > -1) {
        var name = cookie.substring(0, eqPos);
        if (name.indexOf('_fpc_') === 0 && name.slice(-4) === '_sid') {
          return cookie.substring(eqPos + 1);
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Revenue Order Deduplication (localStorage)
  // Prevents double-firing revenue events for the same order_id.
  // Stores the last 50 order IDs in localStorage — synchronous, no async init.
  // ---------------------------------------------------------------------------

  function isRevenueOrderDuplicate(orderId) {
    if (!orderId) return false;
    try {
      var raw = localStorage.getItem(CONFIG.revenueOrderKey);
      var orders = raw ? JSON.parse(raw) : [];
      if (orders.indexOf(orderId) !== -1) return true;
      orders.push(orderId);
      if (orders.length > 50) orders.shift();
      localStorage.setItem(CONFIG.revenueOrderKey, JSON.stringify(orders));
      return false;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // PII Scrubbing
  // Sanitizes text before sending to analytics to prevent leaking emails,
  // phone numbers, or credit card numbers via click/form text capture.
  // ---------------------------------------------------------------------------

  function scrubPII(text) {
    if (!text) return "";
    var scrubbed = text;

    // Emails
    scrubbed = scrubbed.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL]");

    // Phone numbers (international and local formats)
    scrubbed = scrubbed.replace(/(?:\+?[\d\-\(\)\s]{7,20}\d)/g, "[PHONE]");

    // Credit card numbers / SSNs (long digit sequences)
    scrubbed = scrubbed.replace(/\b\d{13,19}\b/g, "[NUMBER]");

    return scrubbed.trim();
  }

  // ---------------------------------------------------------------------------
  // API Endpoint Resolution
  // Derives the proxy endpoint from the script tag's src origin so this script
  // works on any white-label domain without hardcoding.
  //
  // Priority:
  //   1. data-url attribute on <script id="bliz-snippet"> (explicit override)
  //   2. Origin of the script src URL + /api/v1/external-analytics/web
  //   3. Fallback: https://api.bliz.cc/api/v1/external-analytics/web
  // ---------------------------------------------------------------------------

  function getApiEndpoint() {
    var script = document.getElementById("bliz-snippet");
    if (script) {
      var dataUrl = script.getAttribute("data-url");
      if (dataUrl) return dataUrl;

      if (script.src) {
        try {
          var scriptUrl = new URL(script.src);
          return scriptUrl.origin + "/api/v1/external-analytics/web";
        } catch (e) {}
      }
    }
    return "https://api.bliz.cc/api/v1/external-analytics/web";
  }

  function getApiKeyFromScript() {
    var script = document.getElementById("bliz-snippet");
    return script ? script.getAttribute("data-key") : null;
  }

  var API_ENDPOINT = getApiEndpoint();

  // ---------------------------------------------------------------------------
  // Payload Obfuscation
  // XOR-cipher + Base64 encoding. Minifies keys to reduce payload size.
  // The token (tk) is included for backend reference alongside the cookie.
  // ---------------------------------------------------------------------------

  function obfuscate(payload, apiKey, sidToken) {
    var minified = {
      s:   payload.stage,
      es:  payload.event_source,
      src: payload.source,
      si:  payload.source_identifier,
      sl:  payload.source_location,
      ref: payload.referrer_url,
      ts:  payload.timestamp,
      r:   payload.revenue,
      c:   payload.currency,
      e:   payload.event,
      cu:  payload.customer,
      m:   payload.metadata,
      tk:  sidToken,
      ak:  apiKey
    };

    // Strip undefined / null keys to minimise payload size
    for (var key in minified) {
      if (minified.hasOwnProperty(key) && (minified[key] === undefined || minified[key] === null)) {
        delete minified[key];
      }
    }

    var jsonStr = JSON.stringify(minified);
    var utf8Str = unescape(encodeURIComponent(jsonStr));
    var maskKey = BLIZ_CLIENT_SIDE_XMLK_SECRET;
    var xorStr = "";
    for (var i = 0; i < utf8Str.length; i++) {
      xorStr += String.fromCharCode(utf8Str.charCodeAt(i) ^ maskKey.charCodeAt(i % maskKey.length));
    }
    return btoa(xorStr);
  }

  // ---------------------------------------------------------------------------
  // Event Transmission
  // Reads token fresh from cookie on every call.
  // If cookie is absent (e.g. blocked, cleared), the request is silently dropped.
  // credentials:'include' causes the browser to attach the _fpc_*_sid cookie
  // automatically on cross-origin requests to the proxy domain.
  // keepalive:true ensures the request is not aborted on page unload/navigation.
  // ---------------------------------------------------------------------------

  function sendRaw(obfuscatedData) {
    try {
      fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        credentials: 'include',
        keepalive: true,
        body: obfuscatedData,
      });
    } catch (e) {}
  }

  // Flush all queued events as a single batched request.
  function flushQueue() {
    batchTimer = null;
    if (batchQueue.length === 0) return;

    var apiKey = getApiKeyFromScript();
    var sidToken = getCookieToken() || "";
    var batch = batchQueue.splice(0, batchQueue.length);

    // Wrap batch: { b: [events], ak, tk }
    var wrapper = { b: batch, ak: apiKey, tk: sidToken };
    var jsonStr = JSON.stringify(wrapper);
    var utf8Str = unescape(encodeURIComponent(jsonStr));
    var maskKey = BLIZ_CLIENT_SIDE_XMLK_SECRET;
    var xorStr = "";
    for (var i = 0; i < utf8Str.length; i++) {
      xorStr += String.fromCharCode(utf8Str.charCodeAt(i) ^ maskKey.charCodeAt(i % maskKey.length));
    }
    sendRaw(btoa(xorStr));
  }

  // Queue a standard telemetry event for deferred batch send.
  function sendEventToAPI(payload) {
    var sidToken = getCookieToken() || "";

    // If no cookie, only allow VIEW events for resurrection.
    if (!sidToken && payload.stage !== CONFIG.stages.VIEW) {
      return;
    }

    batchQueue.push(payload);

    if (!batchTimer) {
      batchTimer = setTimeout(flushQueue, BATCH_DELAY_MS);
    }
  }

  // Send a single critical event immediately (revenue, conversion) — bypasses queue.
  function sendImmediateEvent(payload) {
    var apiKey = getApiKeyFromScript();
    var sidToken = getCookieToken() || "";

    if (!sidToken && payload.stage !== CONFIG.stages.VIEW) {
      return;
    }

    var obfuscatedData = obfuscate(payload, apiKey, sidToken);
    sendRaw(obfuscatedData);
  }

  function createEvent(stage, sourceCategory, sourceIdentifier, eventName, customer) {
    return {
      stage: stage,
      event_source: "WEB",
      source: sourceCategory,
      source_identifier: sourceIdentifier,
      source_location: window.location.protocol + "//" + window.location.host + window.location.pathname,
      referrer_url: document.referrer || null,
      timestamp: new Date().toISOString(),
      event: eventName || null,
      customer: customer || null,
    };
  }

  // ---------------------------------------------------------------------------
  // Public Tracking Methods
  // ---------------------------------------------------------------------------

  /**
   * Fire a purchase/revenue event.
   * Deduplicates by order_id using localStorage (synchronous, no async init).
   *
   * @param {object} data - { value, currency, order_id, event, customer, metadata }
   * @param {object} [customerOpt] - optional customer override
   */
  function trackRevenue(data, customerOpt) {
    var value = parseFloat(data && data.value);
    if (isNaN(value) || value <= 0) return false;

    if (isRevenueOrderDuplicate(data.order_id)) return false;

    var event = createEvent(
      CONFIG.stages.CONVERT,
      CONFIG.categories.PURCHASE,
      data.order_id ? "Order: " + data.order_id : "Purchase",
      data.event,
      (data && data.customer) || customerOpt
    );
    event.revenue = value;
    event.currency = (data.currency || "USD").toUpperCase().trim();
    if (data.metadata) event.metadata = data.metadata;
    // Revenue is critical — send immediately, do not batch
    sendImmediateEvent(event);
    return true;
  }

  /**
   * Fire a conversion event (non-revenue: signup, lead, install, etc.)
   *
   * @param {object} data - { name, event, customer, metadata }
   * @param {object} [customerOpt] - optional customer override
   */
  function trackConversion(data, customerOpt) {
    var event = createEvent(
      CONFIG.stages.CONVERSION,
      CONFIG.categories.CONVERSION,
      data.name || "Conversion",
      data.event,
      (data && data.customer) || customerOpt
    );
    if (data.metadata) event.metadata = data.metadata;
    // Conversion is critical — send immediately, do not batch
    sendImmediateEvent(event);
    return true;
  }

  // Dedup map: prevents duplicate PAGE_VIEW per URL within the same page session
  var trackedUrls = {};

  function trackPageView() {
    var currentUrl = window.location.href;
    if (trackedUrls[currentUrl]) return;
    trackedUrls[currentUrl] = true;
    sendEventToAPI(createEvent(CONFIG.stages.VIEW, CONFIG.categories.PAGE, "page_view"));
  }

  // ---------------------------------------------------------------------------
  // Auto-Tracking Listeners
  // ---------------------------------------------------------------------------

  function setupListeners() {
    // Page View — SPA-aware (patches pushState / replaceState / popstate)
    var patch = function(m) {
      var orig = window.history[m];
      window.history[m] = function() {
        orig.apply(this, arguments);
        setTimeout(trackPageView, 0);
      };
    };
    patch("pushState");
    patch("replaceState");
    window.addEventListener("popstate", function() { setTimeout(trackPageView, 100); });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", trackPageView);
    } else {
      trackPageView();
    }

    // Click Tracking — links and buttons
    document.addEventListener("click", function (e) {
      var target = e.target.closest("a, button");
      if (!target) return;

      var tag = target.tagName.toLowerCase();
      var isLink = tag === "a";
      var cat = isLink ? CONFIG.categories.LINK : CONFIG.categories.BUTTON;
      var baseFallback = isLink ? "Link" : "Button";

      var identifier = target.id ||
                       target.getAttribute("name") ||
                       target.getAttribute("data-testid") ||
                       target.getAttribute("data-track") ||
                       baseFallback;

      var href = isLink ? (target.getAttribute("href") || "").toLowerCase() : "";
      var finalActionText = "";

      if (href.indexOf("tel:") === 0) {
        finalActionText = "Phone Link Clicked";
      } else if (href.indexOf("mailto:") === 0) {
        finalActionText = "Email Link Clicked";
      } else {
        var rawText = target.getAttribute("aria-label") ||
                      target.title ||
                      target.innerText ||
                      "";
        finalActionText = scrubPII(rawText).substring(0, 50).trim();
      }

      if (!finalActionText) finalActionText = baseFallback;

      var label = "[" + identifier + "] " + finalActionText;
      sendEventToAPI(createEvent(CONFIG.stages.ENGAGE, cat, label));
    });

    // Form Submit Tracking
    document.addEventListener("submit", function (e) {
      var target = e.target;

      var identifier = target.id ||
                       target.getAttribute("name") ||
                       target.getAttribute("data-testid") ||
                       "Form";

      var label = "[" + identifier + "] submit";
      sendEventToAPI(createEvent(CONFIG.stages.SUBMITS, CONFIG.categories.FORM, label));
    });

    // Custom Event Hooks (dispatched by merchant page code)
    window.addEventListener("bliz:revenue", function (e) { trackRevenue(e.detail || {}); });
    window.addEventListener("bliz:conversion", function (e) { trackConversion(e.detail || {}); });
  }

  // ---------------------------------------------------------------------------
  // Startup — Synchronous
  // Token is read from the first-party cookie set during the short link redirect.
  // No IndexedDB or async init required.
  // ---------------------------------------------------------------------------

  currentSidToken = getCookieToken();
  setupListeners();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var BlizTracker = {
    /**
     * Returns the current session token (JWE) read from the _fpc_*_sid cookie.
     * Use this to attach the session to server-side conversion events.
     * Example: BlizTracker.getSidToken() -> "eyJhbGci..."
     */
    getSidToken: function() { return currentSidToken; },
    getBlizsid: function() { return currentSidToken; },  // alias

    /** Returns true if a valid session token is present. */
    isActive: function() { return !!currentSidToken; },

    /** Manually fire a page view (e.g. after a client-side route change). */
    trackPageView: function() { delete trackedUrls[window.location.href]; trackPageView(); },

    /** Fire a revenue/purchase event. See trackRevenue() for params. */
    trackRevenue: trackRevenue,

    /** Fire a non-revenue conversion event. See trackConversion() for params. */
    trackConversion: trackConversion
  };

  Object.freeze(BlizTracker);
  window.BlizTracker = BlizTracker;

})();