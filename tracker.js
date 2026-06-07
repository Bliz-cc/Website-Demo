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

  var currentSidToken = null;
  var BLIZ_CLIENT_SIDE_XMLK_SECRET = "bliz_secret_2024";

  var CONFIG = {
    sessionIdParam: "blizid",
    storageKey: "blizid",
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
  // Session ID parsing — directly use JWE token
  // ---------------------------------------------------------------------------

  // Helper to find script element by either its new name or old name
  function getApiKeyFromScript() {
    var script = document.getElementById("bliz-snippet");
    return script ? script.getAttribute("data-key") : null;
  }

  function parseSessionParam(raw) {
    return raw || null;
  }

  // ---------------------------------------------------------------------------
  // Session / Storage helpers
  // ---------------------------------------------------------------------------

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

  function storeSidToken(sidToken) {
    try {
      if (window.sessionStorage && sidToken) {
        window.sessionStorage.setItem(CONFIG.storageKey, sidToken);
        return true;
      }
    } catch (e) {}
    return false;
  }

  function getStoredSidToken() {
    try {
      return (
        window.sessionStorage &&
        window.sessionStorage.getItem(CONFIG.storageKey)
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
    var urlSidToken = parseSessionParam(rawParam);
    var storedSidToken = getStoredSidToken();

    if (urlSidToken) {
      storeSidToken(urlSidToken);
      currentSidToken = urlSidToken;
    } else {
      currentSidToken = storedSidToken;
    }
  }

  // ---------------------------------------------------------------------------
  // API — XHR, fire-and-forget
  // ---------------------------------------------------------------------------

  // var API_ENDPOINT = "http://localhost:3000/api/v1/external-analytics/web";
  var API_ENDPOINT = "https://api.bliz.cc/api/v1/external-analytics/web";

  function obfuscate(payload, apiKey, sidToken) {
    var authToken = sidToken || apiKey;
    var minified = {
      s: payload.stage,
      es: payload.event_source,
      src: payload.source,
      si: payload.source_identifier,
      sl: payload.source_location,
      ts: payload.timestamp,
      r: payload.revenue,
      c: payload.currency,
      e: payload.event,
      cu: payload.customer,
      m: payload.metadata,
      s_id: payload.session_id,
      l_id: payload.link_id,
      tk: authToken,
      ak: apiKey
    };

    // Remove undefined or null keys to reduce payload size
    for (var key in minified) {
      if (minified.hasOwnProperty(key)) {
        if (minified[key] === undefined || minified[key] === null) {
          delete minified[key];
        }
      }
    }

    var jsonStr = JSON.stringify(minified);
    var utf8Str = unescape(encodeURIComponent(jsonStr));
    var maskKey = BLIZ_CLIENT_SIDE_XMLK_SECRET;
    var xorStr = "";
    for (var i = 0; i < utf8Str.length; i++) {
      xorStr += String.fromCharCode(
        utf8Str.charCodeAt(i) ^ maskKey.charCodeAt(i % maskKey.length)
      );
    }
    return btoa(xorStr);
  }

  function sendEventToAPI(payload) {
    var apiKey = getApiKeyFromScript();
    var sidToken = currentSidToken || getStoredSidToken();
    var obfuscatedData = obfuscate(payload, apiKey, sidToken);

    var xhr = new XMLHttpRequest();
    xhr.onerror = function () {};
    xhr.ontimeout = function () {};
    try {
      xhr.open("POST", API_ENDPOINT, true);
      xhr.setRequestHeader("accept", "*/*");
      xhr.setRequestHeader("Content-Type", "text/plain");
      xhr.timeout = 5000;
      xhr.send(obfuscatedData);
    } catch (e) {}
  }

  function getPathname() {
    return window.location.pathname;
  }

  function getTimestamp() {
    return new Date().toISOString();
  }

  function createEvent(stage, source, sourceIdentifier, eventName, customer) {
    return {
      stage: stage,
      event_source: "WEB",
      source: source,
      source_identifier: sourceIdentifier,
      source_location: getPathname(),
      timestamp: getTimestamp(),
      event: eventName || null,
      customer: customer || null,
    };
  }

  function buildBasePayload(event) {
    var payload = {
      stage: event.stage,
      event_source: event.event_source,
      source: event.source,
      source_identifier: event.source_identifier,
      source_location: event.source_location,
      timestamp: event.timestamp,
    };
    if (event.event) {
      payload.event = event.event;
    }
    if (event.customer) {
      payload.customer = event.customer;
    }
    return payload;
  }

  function processEvent(event) {
    var sidToken = currentSidToken || getStoredSidToken();
    if (!sidToken) return;
    sendEventToAPI(buildBasePayload(event));
  }

  // ---------------------------------------------------------------------------
  // REVENUE (CONVERT)
  // ---------------------------------------------------------------------------

  function trackRevenue(data, customerOpt) {
    var sidToken = currentSidToken || getStoredSidToken();
    if (!sidToken) {
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

    var eventName = data.event;
    var customer = (data && data.customer) || customerOpt || null;
    var metadata =
      data && data.metadata && typeof data.metadata === "object"
        ? data.metadata
        : null;
    var event = createEvent(
      CONFIG.stages.CONVERT,
      "purchase",
      data.order_id || getPathname(),
      eventName,
      customer,
    );
    var payload = buildBasePayload(event);

    payload.revenue = value;
    payload.currency = currency || "USD";
    if (metadata) {
      payload.metadata = metadata;
    }

    sendEventToAPI(payload);
    return true;
  }

  function trackConversion(data, customerOpt) {
    var sidToken = currentSidToken || getStoredSidToken();
    if (!sidToken) {
      console.warn("[Bliz] trackConversion called but no active session.");
      return false;
    }

    var eventName = data.event;
    var metadata = data.metadata;
    var customer = (data && data.customer) || customerOpt || null;

    var event = createEvent(
      CONFIG.stages.CONVERSION,
      (data && data.name) || "conversion",
      getPathname(),
      eventName,
      customer,
    );
    var payload = buildBasePayload(event);

    if (metadata) {
      payload.metadata = metadata;
    }

    sendEventToAPI(payload);
    return true;
  }

  // GTM CustomEvent: window.dispatchEvent(new CustomEvent('bliz:revenue', { detail: { value: 49.99, currency: 'USD' } }))
  window.addEventListener("bliz:revenue", function (e) {
    trackRevenue(e.detail || {}, (e.detail && e.detail.customer) || null);
  });

  // GTM CustomEvent: window.dispatchEvent(new CustomEvent('bliz:conversion', { detail: { event: 'LEAD', metadata: { source: 'button' } } }))
  window.addEventListener("bliz:conversion", function (e) {
    trackConversion(e.detail || {}, (e.detail && e.detail.customer) || null);
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
    getSidToken: function () {
      return currentSidToken || getStoredSidToken();
    },
    isActive: function () {
      return !!(currentSidToken || getStoredSidToken());
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
  Object.freeze(BlizTracker);
  Object.defineProperty(window, "BlizTracker", {
    value: BlizTracker,
    writable: false,
    configurable: false,
  });
})();
