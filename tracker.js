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
 *   trackOrderCreate(data, customerOpt) → fire an ORDER_CREATED cart order event
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var isInitializing = false;
  var eventQueue = [];
  var BLIZ_CLIENT_SIDE_XMLK_SECRET = "bliz_secret_2024";

  // ---------------------------------------------------------------------------
  // Init No-Match Guard (sessionStorage)
  // Remembers within the same browser tab that /attribution/init already ran
  // and the server returned { resurrected: false }.
  // This prevents hammering the server on every page load/pushState for
  // organic visitors who have no Bliz attribution cookie.
  //
  // sessionStorage is already browser-origin-scoped (scheme+host+port), so a
  // single static key per origin is sufficient. The hostname is appended only
  // for readability in browser DevTools — it adds no isolation value.
  // Cleared automatically when the tab is closed.
  // ---------------------------------------------------------------------------

  var INIT_NO_MATCH_KEY = '_init_nm:' + window.location.hostname;

  function markInitNoMatch() {
    try { sessionStorage.setItem(INIT_NO_MATCH_KEY, '1'); } catch (e) {}
  }

  function isInitAlreadyFailed() {
    try { return sessionStorage.getItem(INIT_NO_MATCH_KEY) === '1'; } catch (e) { return false; }
  }

  function clearInitNoMatch() {
    try { sessionStorage.removeItem(INIT_NO_MATCH_KEY); } catch (e) {}
  }

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

  function resolveBackendOrigin() {
    var script = document.getElementById("bliz-snippet");
    if (script) {
      var dataUrl = script.getAttribute("data-url");
      if (dataUrl) {
        try { return new URL(dataUrl).origin; } catch (e) {}
      }
      if (script.src) {
        try {
          var scriptUrl = new URL(script.src);
          // If script is loaded from a separate origin (e.g. api.bliz.cc or custom proxy), use that origin
          if (scriptUrl.origin !== window.location.origin) {
            return scriptUrl.origin;
          }
        } catch (e) {}
      }
    }
    // If testing on localhost with static server (e.g. Live Server on port 5501), route to client-front dev port
    if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
      return "http://localhost:3003";
    }
    return "https://api.bliz.cc";
  }

  function getApiEndpoint() {
    var script = document.getElementById("bliz-snippet");
    if (script) {
      var dataUrl = script.getAttribute("data-url");
      if (dataUrl) return dataUrl;
    }
    return resolveBackendOrigin() + "/api/v1/external-analytics/web";
  }

  function getApiKeyFromScript() {
    var script = document.getElementById("bliz-snippet");
    return script ? script.getAttribute("data-key") : null;
  }

  function getInitEndpoint() {
    var script = document.getElementById("bliz-snippet");
    if (script) {
      var initUrl = script.getAttribute("data-init-url");
      if (initUrl) return initUrl;
    }
    return resolveBackendOrigin() + "/api/v1/attribution/init";
  }

  var API_ENDPOINT = getApiEndpoint();
  var INIT_ENDPOINT = getInitEndpoint();

  // ---------------------------------------------------------------------------
  // Payload Obfuscation
  // XOR-cipher + Base64 encoding. Minifies keys to reduce payload size.
  // The token (tk) is included for backend reference alongside the cookie.
  // ---------------------------------------------------------------------------

  function collectTelemetry() {
    try {
      return {
        sw: window.screen ? window.screen.width : null,
        sh: window.screen ? window.screen.height : null,
        sc: window.devicePixelRatio || 1,
        cd: window.screen ? window.screen.colorDepth : null,
        hc: navigator.hardwareConcurrency || null,
        dm: navigator.deviceMemory || null,
        mtp: (navigator.maxTouchPoints !== undefined) ? navigator.maxTouchPoints : 0,
        gpu: 'N/A',
        tz: (Intl && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
        tzo: new Date().getTimezoneOffset(),
        lang: navigator.language || null,
        langs: navigator.languages ? navigator.languages.join(',') : (navigator.language || null),
        dm_pref: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 1 : 0,
        rm_pref: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0
      };
    } catch (e) {
      return null;
    }
  }

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
      tel: collectTelemetry(),
      tk:  sidToken,
      ak:  apiKey
    };

    // Strip undefined / null keys to minimise payload size
    for (var key in minified) {
      if (minified.hasOwnProperty(key) && (minified[key] === undefined || minified[key] === null)) {
        delete minified[key];
      }
    }

    return xorEncode(minified);
  }

  function xorEncode(data) {
    var jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
    var utf8Str = unescape(encodeURIComponent(jsonStr));
    var maskKey = BLIZ_CLIENT_SIDE_XMLK_SECRET;
    var xorStr = "";
    for (var i = 0; i < utf8Str.length; i++) {
      xorStr += String.fromCharCode(utf8Str.charCodeAt(i) ^ maskKey.charCodeAt(i % maskKey.length));
    }
    return btoa(xorStr);
  }

  // ---------------------------------------------------------------------------
  // Attribution Init Handshake
  // Resolves missing cookie / cross-browser session from /api/v1/attribution/init.
  // ---------------------------------------------------------------------------

  function initAttribution(apiKey) {
    if (!apiKey) {
      isInitializing = false;
      eventQueue = [];
      return;
    }

    // Skip the network round-trip if /init already returned { resurrected: false }
    // for this origin in the current browser tab session.
    if (isInitAlreadyFailed()) {
      isInitializing = false;
      eventQueue = [];
      return;
    }

    try {
      var initPayload = {
        apiKey: apiKey,
        url: window.location.href,
        referrer: document.referrer || '',
        telemetry: collectTelemetry()
      };
      var obfuscatedBody = xorEncode(initPayload);
      fetch(INIT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        credentials: 'include',
        body: obfuscatedBody
      })
      .then(function(res) {
        if (!res.ok) throw new Error('Init request failed');
        return res.json();
      })
      .then(function(data) {
        isInitializing = false;
        if (data && data.resurrected) {
          // Cookie has been set by the server-side Set-Cookie header.
          // Clear any stale no-match flag (defensive: shouldn't exist but guard it).
          clearInitNoMatch();
          while (eventQueue.length > 0) {
            var queuedPayload = eventQueue.shift();
            sendEventToAPI(queuedPayload);
          }
        } else {
          // Organic visitor — no candidate found. Record the outcome so we
          // don't retry /init on every subsequent page load within this tab.
          markInitNoMatch();
          eventQueue = [];
        }
      })
      .catch(function() {
        // Network/server error — do NOT mark as failed; let the next page load retry.
        isInitializing = false;
        eventQueue = [];
      });
    } catch (err) {
      isInitializing = false;
      eventQueue = [];
    }
  }

  // ---------------------------------------------------------------------------
  // Event Transmission
  // Reads token reactively from cookie on every call.
  // If cookie is absent and /init is running, event is queued.
  // If cookie remains absent after /init, the event is silently dropped.
  // ---------------------------------------------------------------------------

  function sendEventToAPI(payload) {
    var sidToken = getCookieToken() || "";

    if (!sidToken) {
      if (isInitializing) {
        eventQueue.push(payload);
      }
      return;
    }

    var apiKey = getApiKeyFromScript();
    var obfuscatedData = obfuscate(payload, apiKey, sidToken);

    try {
      fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        credentials: 'include', // browser attaches _fpc_*_sid cookie cross-origin
        keepalive: true,        // survives page navigation/unload
        body: obfuscatedData,
      });
    } catch (e) {}
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
    sendEventToAPI(event);
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
    sendEventToAPI(event);
    return true;
  }

  /**
   * Fire an ORDER_CREATED conversion event with cart items and order metadata.
   *
   * @param {object} data - { order_id, items: [ { sku, name, price, qty, product_id } ], currency, customer, metadata }
   * @param {object} [customerOpt] - optional customer override
   */
  function trackOrderCreate(data, customerOpt) {
    if (!data) return false;
    var orderId = data.order_id || (data.metadata && data.metadata.order_id) || "";
    var items = data.items || (data.metadata && data.metadata.items) || [];
    var meta = {};
    if (data.metadata && typeof data.metadata === 'object') {
      for (var k in data.metadata) {
        if (data.metadata.hasOwnProperty(k)) {
          meta[k] = data.metadata[k];
        }
      }
    }
    meta.order_id = orderId;
    meta.items = items;
    if (data.currency) meta.currency = data.currency;
    if (data.customer_email) meta.customer_email = data.customer_email;
    if (data.customer_phone) meta.customer_phone = data.customer_phone;

    var event = createEvent(
      CONFIG.stages.CONVERSION,
      CONFIG.categories.PURCHASE,
      orderId ? "Order: " + orderId : "ORDER_CREATED",
      "ORDER_CREATED",
      (data && data.customer) || customerOpt
    );
    event.metadata = meta;
    if (data.currency) event.currency = (data.currency || "USD").toUpperCase().trim();
    sendEventToAPI(event);
    return true;
  }

  // Dedup map: prevents duplicate PAGE_VIEW per URL within the same page session
  var trackedUrls = {};
  var routeDebounceTimer = null;
  var recentClicks = {};
  var recentSubmits = {};

  function trackPageView() {
    var currentUrl = window.location.href;
    if (trackedUrls[currentUrl]) return;
    trackedUrls[currentUrl] = true;
    sendEventToAPI(createEvent(CONFIG.stages.VIEW, CONFIG.categories.PAGE, "page_view"));
  }

  function debouncedTrackPageView(delay) {
    if (routeDebounceTimer) {
      clearTimeout(routeDebounceTimer);
    }
    routeDebounceTimer = setTimeout(function () {
      trackPageView();
    }, typeof delay === "number" ? delay : 250);
  }

  // ---------------------------------------------------------------------------
  // Auto-Tracking Listeners
  // ---------------------------------------------------------------------------

  function setupListeners() {
    // Page View — SPA-aware (patches pushState / replaceState / popstate with settling window)
    var patch = function(m) {
      var orig = window.history[m];
      window.history[m] = function() {
        orig.apply(this, arguments);
        debouncedTrackPageView(250);
      };
    };
    patch("pushState");
    patch("replaceState");
    window.addEventListener("popstate", function() { debouncedTrackPageView(250); });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", trackPageView);
    } else {
      trackPageView();
    }

    // Click Tracking — links and buttons with 400ms throttling per element/label
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
      var clickKey = cat + ":" + label + ":" + window.location.pathname;
      var now = Date.now();

      // Drop rapid duplicate clicks within 400ms
      if (recentClicks[clickKey] && (now - recentClicks[clickKey] < 400)) {
        return;
      }
      recentClicks[clickKey] = now;

      sendEventToAPI(createEvent(CONFIG.stages.ENGAGE, cat, label));
    });

    // Form Submit Tracking with 1000ms cooldown
    document.addEventListener("submit", function (e) {
      var target = e.target;

      var identifier = target.id ||
                       target.getAttribute("name") ||
                       target.getAttribute("data-testid") ||
                       "Form";

      var submitKey = identifier + ":" + window.location.pathname;
      var now = Date.now();

      // Drop duplicate submit triggers within 1000ms
      if (recentSubmits[submitKey] && (now - recentSubmits[submitKey] < 1000)) {
        return;
      }
      recentSubmits[submitKey] = now;

      var label = "[" + identifier + "] submit";
      sendEventToAPI(createEvent(CONFIG.stages.SUBMITS, CONFIG.categories.FORM, label));
    });

    // Custom Event Hooks (dispatched by merchant page code)
    window.addEventListener("bliz:revenue", function (e) { trackRevenue(e.detail || {}); });
    window.addEventListener("bliz:conversion", function (e) { trackConversion(e.detail || {}); });
    window.addEventListener("bliz:order_create", function (e) { trackOrderCreate(e.detail || {}); });
  }

  // ---------------------------------------------------------------------------
  // Startup — Synchronous
  // Token is read from the first-party cookie set during the short link redirect.
  // No IndexedDB or async init required.
  // ---------------------------------------------------------------------------

  if (!getCookieToken()) {
    var apiKey = getApiKeyFromScript();
    if (apiKey) {
      isInitializing = true;
      initAttribution(apiKey);
    }
  }
  setupListeners();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var BlizTracker = {
    /**
     * Returns the current session token (JWE) read reactively from the _fpc_*_sid cookie.
     * Use this to attach the session to server-side conversion events.
     * Example: BlizTracker.getSidToken() -> "eyJhbGci..."
     */
    getSidToken: function() { return getCookieToken(); },
    getBlizsid: function() { return getCookieToken(); },  // alias

    /** Returns true if a valid session token is present. */
    isActive: function() { return !!getCookieToken(); },

    /** Manually fire a page view (e.g. after a client-side route change). */
    trackPageView: function() { delete trackedUrls[window.location.href]; trackPageView(); },

    /** Fire a revenue/purchase event. See trackRevenue() for params. */
    trackRevenue: trackRevenue,

    /** Fire a non-revenue conversion event. See trackConversion() for params. */
    trackConversion: trackConversion,

    /** Fire an ORDER_CREATED cart order event. */
    trackOrderCreate: trackOrderCreate
  };

  Object.freeze(BlizTracker);
  window.BlizTracker = BlizTracker;

})();