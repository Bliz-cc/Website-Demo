/**
 * Bliz Tracking Script v3.0 (Simplified Funnel Analytics)
 *
 * Changes over v2.1:
 * - Simplified to map events to 5-stage funnel (VIEW, ENGAGE, SUBMITS, CONVERT)
 * - Removed legacy duration/bounce metric tracking (visibility / exit listeners)
 * - Keeps session parsing, SPA navigation, scrolls, clicks, and form submissions
 */

(function () {
  "use strict";

  var CONFIG = {
    sessionIdParam: "bliz_sid",
    storageKey: "bliz_session_id",
    linkIdKey: "bliz_link_id",
    revenueOrderKey: "bliz_revenue_orders",
    stages: {
      VIEW: "VIEW",
      ENGAGE: "ENGAGE",
      SUBMITS: "SUBMITS",
      CONVERSION: "CONVERSION",
      CONVERT: "CONVERT",
    },
  };

  // ---------------------------------------------------------------------------
  // Session ID parsing — base64url decode, then split on '&'
  // ---------------------------------------------------------------------------

  function parseSessionParam(raw) {
    if (!raw) return { sessionId: null, linkId: null };
    try {
      var decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
      var parts = decoded.split("&");
      return {
        sessionId: parts[0] || null,
        linkId: parts[1] || null,
      };
    } catch (e) {
      console.warn("[Bliz] Failed to decode bliz_sid:", e);
      return { sessionId: null, linkId: null };
    }
  }

  function getQueryParam(param) {
    try {
      return new URLSearchParams(window.location.search).get(param) || null;
    } catch (e) {
      return getQueryParamLegacy(param);
    }
  }

  function getQueryParamLegacy(param) {
    var search = window.location.search.substring(1);
    var params = search.split("&");
    for (var i = 0; i < params.length; i++) {
      var pair = params[i].split("=");
      if (decodeURIComponent(pair[0]) === param) {
        return decodeURIComponent(pair[1] || "");
      }
    }
    return null;
  }

  function storeSession(sessionId, linkId) {
    try {
      if (window.sessionStorage) {
        window.sessionStorage.setItem(CONFIG.storageKey, sessionId);
        if (linkId) window.sessionStorage.setItem(CONFIG.linkIdKey, linkId);
        return true;
      }
    } catch (e) {}
    return false;
  }

  function getStoredSessionId() {
    try {
      return (
        window.sessionStorage &&
        window.sessionStorage.getItem(CONFIG.storageKey)
      );
    } catch (e) {}
    return null;
  }

  function getStoredLinkId() {
    try {
      return (
        window.sessionStorage && window.sessionStorage.getItem(CONFIG.linkIdKey)
      );
    } catch (e) {}
    return null;
  }

  // ---------------------------------------------------------------------------
  // Revenue order_id deduplication
  // ---------------------------------------------------------------------------

  function isRevenueOrderDuplicate(orderId) {
    if (!orderId) return false;
    try {
      if (window.sessionStorage) {
        var raw = window.sessionStorage.getItem(CONFIG.revenueOrderKey);
        var orders = raw ? JSON.parse(raw) : [];
        if (orders.indexOf(orderId) !== -1) return true;
        orders.push(orderId);
        window.sessionStorage.setItem(
          CONFIG.revenueOrderKey,
          JSON.stringify(orders),
        );
      }
    } catch (e) {}
    return false;
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function init() {
    var rawParam = getQueryParam(CONFIG.sessionIdParam);
    var parsed = parseSessionParam(rawParam);
    var urlSessionId = parsed.sessionId;
    var urlLinkId = parsed.linkId;
    var storedSession = getStoredSessionId();

    if (urlSessionId) {
      storeSession(urlSessionId, urlLinkId);
      window.blizSessionId = urlSessionId;
      window.blizLinkId = urlLinkId;
    } else {
      window.blizSessionId = storedSession;
      window.blizLinkId = getStoredLinkId();
    }
  }

  // ---------------------------------------------------------------------------
  // API — XHR, fire-and-forget
  // ---------------------------------------------------------------------------

  // var API_ENDPOINT = "http://localhost:3000/api/v1/analytics";
  var API_ENDPOINT = "https://api.bliz.cc/api/v1/analytics";

  function getApiKeyFromScript() {
    var script = document.getElementById("bliz-snippet");
    return script ? script.getAttribute("data-key") : null;
  }

  function sendEventToAPI(payload) {
    var apiKey = getApiKeyFromScript();
    var xhr = new XMLHttpRequest();
    xhr.onerror = function () {};
    xhr.ontimeout = function () {};
    try {
      xhr.open("POST", API_ENDPOINT, true);
      xhr.setRequestHeader("accept", "*/*");
      xhr.setRequestHeader("Content-Type", "application/json");
      if (apiKey) xhr.setRequestHeader("Authorization", "Bearer " + apiKey);
      xhr.timeout = 5000;
      xhr.send(JSON.stringify(payload));
    } catch (e) {}
  }

  function getPathname() {
    return window.location.pathname;
  }

  function getTimestamp() {
    return new Date().toISOString();
  }

  function createEvent(stage, source, sourceIdentifier) {
    return {
      stage: stage,
      event_source: "WEB",
      source: source,
      source_identifier: sourceIdentifier,
      source_location: getPathname(),
      timestamp: getTimestamp(),
    };
  }

  function buildBasePayload(event, sessionId) {
    var payload = {
      session_id: sessionId,
      link_id: window.blizLinkId || getStoredLinkId() || undefined,
      stage: event.stage,
      event_source: event.event_source,
      source: event.source,
      source_identifier: event.source_identifier,
      source_location: event.source_location,
      timestamp: event.timestamp,
    };
    return payload;
  }

  function processEvent(event) {
    var sessionId = window.blizSessionId || getStoredSessionId();
    if (!sessionId) return;
    sendEventToAPI(buildBasePayload(event, sessionId));
  }

  // ---------------------------------------------------------------------------
  // REVENUE (CONVERT)
  // ---------------------------------------------------------------------------

  function trackRevenue(data) {
    var sessionId = window.blizSessionId || getStoredSessionId();
    if (!sessionId) {
      console.warn("[Bliz] trackRevenue called but no active session.");
      return false;
    }

    var value = parseFloat(data && data.value);
    if (isNaN(value) || value <= 0) {
      console.warn(
        "[Bliz] trackRevenue: value must be a positive float. Got:",
        data && data.value,
      );
      return false;
    }

    var currency =
      data.currency && typeof data.currency === "string"
        ? data.currency.toUpperCase().trim()
        : null;
    if (currency && currency.length !== 3) {
      console.warn(
        "[Bliz] trackRevenue: currency must be a 3-letter ISO code. Got:",
        data.currency,
      );
      return false;
    }

    if (data.order_id && isRevenueOrderDuplicate(data.order_id)) {
      console.warn(
        "[Bliz] trackRevenue: order_id already tracked, ignoring duplicate:",
        data.order_id,
      );
      return false;
    }

    var event = createEvent(
      CONFIG.stages.CONVERT,
      "purchase",
      data.order_id || getPathname(),
    );
    var payload = buildBasePayload(event, sessionId);

    payload.revenue = value;
    payload.currency = currency || "USD";

    sendEventToAPI(payload);
    return true;
  }

  function trackConversion(data) {
    var sessionId = window.blizSessionId || getStoredSessionId();
    if (!sessionId) {
      console.warn("[Bliz] trackConversion called but no active session.");
      return false;
    }

    var eventName =
      data && data.event && typeof data.event === "string"
        ? data.event.toUpperCase().trim()
        : null;
    var metadata =
      data && data.metadata && typeof data.metadata === "object"
        ? data.metadata
        : null;

    var event = createEvent(
      CONFIG.stages.CONVERSION,
      (data && data.name) || "conversion",
      getPathname(),
    );
    var payload = buildBasePayload(event, sessionId);

    if (eventName) {
      payload.event = eventName;
    }
    if (metadata) {
      payload.metadata = metadata;
    }

    sendEventToAPI(payload);
    return true;
  }

  // GTM CustomEvent: window.dispatchEvent(new CustomEvent('bliz:revenue', { detail: { value: 49.99, currency: 'USD' } }))
  window.addEventListener("bliz:revenue", function (e) {
    trackRevenue(e.detail || {});
  });

  // GTM CustomEvent: window.dispatchEvent(new CustomEvent('bliz:conversion', { detail: { event: 'LEAD', metadata: { source: 'button' } } }))
  window.addEventListener("bliz:conversion", function (e) {
    trackConversion(e.detail || {});
  });

  // ---------------------------------------------------------------------------
  // Click tracking — closest() handles clicks on child elements
  // ---------------------------------------------------------------------------

  function setupClickListener() {
    document.addEventListener("click", function (e) {
      var target = e.target.closest("a, button");
      if (!target) return;

      var tagName = target.tagName.toLowerCase();
      var source = target.id || target.className.split(" ")[0] || tagName;

      var sourceIdentifier =
        (target.innerText || "").substring(0, 100).trim() ||
        (tagName === "a" ? target.href : "button") ||
        "N/A";

      processEvent(createEvent(CONFIG.stages.ENGAGE, source, sourceIdentifier));
    });
  }

  // ---------------------------------------------------------------------------
  // Form tracking
  // ---------------------------------------------------------------------------

  function setupFormListener() {
    document.addEventListener("submit", function (e) {
      var form = e.target;
      var source = form.id || form.className.split(" ")[0] || "form";
      processEvent(createEvent(CONFIG.stages.SUBMITS, source, "form_submit"));
    });
  }

  // ---------------------------------------------------------------------------
  // Page view + SPA navigation
  // ---------------------------------------------------------------------------

  var trackedPathnames = {};

  function trackPageView() {
    var pathname = getPathname();
    if (trackedPathnames[pathname]) return;
    trackedPathnames[pathname] = true;

    processEvent(
      createEvent(CONFIG.stages.VIEW, "page_view", pathname || "home"),
    );
  }

  function patchHistoryMethod(method) {
    var original = window.history[method];
    window.history[method] = function () {
      var prevPathname = getPathname();
      original.apply(this, arguments);
      var nextPathname = getPathname();
      if (nextPathname !== prevPathname) {
        setTimeout(trackPageView, 0);
      }
    };
  }

  function setupPageViewListener() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", trackPageView);
    } else {
      trackPageView();
    }

    window.addEventListener("popstate", function () {
      setTimeout(trackPageView, 100);
    });

    document.addEventListener("shopify:section:load", trackPageView);
    document.addEventListener("page:loaded", trackPageView);

    patchHistoryMethod("pushState");
    patchHistoryMethod("replaceState");
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var BlizTracker = {
    getSessionId: function () {
      return window.blizSessionId || getStoredSessionId();
    },
    getLinkId: function () {
      return window.blizLinkId || getStoredLinkId();
    },
    isActive: function () {
      return !!(window.blizSessionId || getStoredSessionId());
    },
    getApiKey: function () {
      return getApiKeyFromScript();
    },
    trackPageView: function () {
      delete trackedPathnames[getPathname()];
      trackPageView();
    },
    trackRevenue: trackRevenue,
    trackConversion: trackConversion,
  };

  init();
  setupPageViewListener();
  setupClickListener();
  setupFormListener();
  window.BlizTracker = BlizTracker;
})();
