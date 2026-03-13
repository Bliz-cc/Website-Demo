/**
 * Bliz Tracking Script v1.9
 *
 * Changes over v1.8:
 * - sessionStartKey added — set once in init(), never reset, tracks full session duration
 * - pageStartKey now resets on every PAGE_VIEW (SPA navigation resets per-page timer)
 * - PAGE_EXIT payload carries time_on_site (numeric, seconds) as dedicated field
 * - label still carries time_on_page:Xs for human-readable context
 */

(function () {
    "use strict";
  
    var CONFIG = {
      sessionIdParam:   "bliz_sid",
      storageKey:       "bliz_session_id",
      linkIdKey:        "bliz_link_id",
      orderKey:         "bliz_event_order",
      pageStartKey:     "bliz_page_start",
      sessionStartKey:  "bliz_session_start",
      revenueOrderKey:  "bliz_revenue_orders",
      events: {
        PAGE_VIEW:      "PAGE_VIEW",
        PAGE_EXIT:      "PAGE_EXIT",
        LINK_CLICK:     "LINK_CLICK",
        BUTTON_CLICK:   "BUTTON_CLICK",
        FORM_SUBMIT:    "FORM_SUBMIT",
        REVENUE_SUBMIT: "REVENUE_SUBMIT",
      },
    };
  
    // ---------------------------------------------------------------------------
    // Session ID parsing — base64url decode, then split on '&'
    // ---------------------------------------------------------------------------
  
    function parseSessionParam(raw) {
      if (!raw) return { sessionId: null, linkId: null };
      try {
        var decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
        var parts   = decoded.split("&");
        return {
          sessionId: parts[0] || null,
          linkId:    parts[1] || null,
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
      try { return window.sessionStorage && window.sessionStorage.getItem(CONFIG.storageKey); } catch (e) {}
      return null;
    }
  
    function getStoredLinkId() {
      try { return window.sessionStorage && window.sessionStorage.getItem(CONFIG.linkIdKey); } catch (e) {}
      return null;
    }
  
    // ---------------------------------------------------------------------------
    // Event order — scoped per session to prevent tab counter collisions
    // ---------------------------------------------------------------------------
  
    function getSessionOrderKey(sessionId) {
      return CONFIG.orderKey + "_" + (sessionId || "unknown");
    }
  
    function resetEventOrder(sessionId) {
      try {
        if (window.sessionStorage) {
          window.sessionStorage.setItem(getSessionOrderKey(sessionId), "0");
        }
      } catch (e) {}
    }
  
    function getAndIncrementOrder(sessionId) {
      var order = 1;
      try {
        if (window.sessionStorage) {
          var key     = getSessionOrderKey(sessionId);
          var current = parseInt(window.sessionStorage.getItem(key) || "0", 10);
          order       = current + 1;
          window.sessionStorage.setItem(key, order.toString());
        }
      } catch (e) {}
      return order;
    }
  
    // ---------------------------------------------------------------------------
    // Revenue order_id deduplication
    // ---------------------------------------------------------------------------
  
    function isRevenueOrderDuplicate(orderId) {
      if (!orderId) return false;
      try {
        if (window.sessionStorage) {
          var raw    = window.sessionStorage.getItem(CONFIG.revenueOrderKey);
          var orders = raw ? JSON.parse(raw) : [];
          if (orders.indexOf(orderId) !== -1) return true;
          orders.push(orderId);
          window.sessionStorage.setItem(CONFIG.revenueOrderKey, JSON.stringify(orders));
        }
      } catch (e) {}
      return false;
    }
  
    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
  
    function init() {
      var rawParam      = getQueryParam(CONFIG.sessionIdParam);
      var parsed        = parseSessionParam(rawParam);
      var urlSessionId  = parsed.sessionId;
      var urlLinkId     = parsed.linkId;
      var storedSession = getStoredSessionId();
  
      if (urlSessionId) {
        if (urlSessionId !== storedSession) {
          resetEventOrder(urlSessionId);
        }
        storeSession(urlSessionId, urlLinkId);
        window.blizSessionId = urlSessionId;
        window.blizLinkId    = urlLinkId;
      } else {
        window.blizSessionId = storedSession;
        window.blizLinkId    = getStoredLinkId();
        if (!storedSession) resetEventOrder(null);
      }
  
      try {
        var now = Date.now().toString();
        // pageStartKey resets on every page load and SPA navigation
        window.sessionStorage.setItem(CONFIG.pageStartKey, now);
        // sessionStartKey is set once per session — never overwritten
        if (!window.sessionStorage.getItem(CONFIG.sessionStartKey)) {
          window.sessionStorage.setItem(CONFIG.sessionStartKey, now);
        }
      } catch (e) {}
    }
  
    // ---------------------------------------------------------------------------
    // API — XHR, fire-and-forget
    // ---------------------------------------------------------------------------
  
    var API_ENDPOINT = "http://localhost:3000/api/v1/page-events";
  
    function getApiKeyFromScript() {
      var script = document.getElementById("bliz-snippet");
      return script ? script.getAttribute("data-key") : null;
    }
  
    function sendEventToAPI(payload) {
      var apiKey = getApiKeyFromScript();
      var xhr    = new XMLHttpRequest();
      xhr.onerror   = function () {};
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
  
    function createEvent(action, label, pathname) {
      return {
        action:    action   || "N/A",
        label:     label    || "N/A",
        pathname:  pathname || getPathname(),
        url:       window.location.origin + window.location.pathname,
        timestamp: getTimestamp(),
      };
    }
  
    function buildBasePayload(event, sessionId) {
      return {
        session_id: sessionId,
        link_id:    window.blizLinkId || getStoredLinkId() || undefined,
        order:      getAndIncrementOrder(sessionId),
        action:     event.action,
        label:      event.label,
        pathname:   event.pathname,
        url:        event.url,
        timestamp:  event.timestamp,
      };
    }
  
    function processEvent(event) {
      var sessionId = window.blizSessionId || getStoredSessionId();
      if (!sessionId) return;
      sendEventToAPI(buildBasePayload(event, sessionId));
    }
  
    // ---------------------------------------------------------------------------
    // REVENUE_SUBMIT
    // ---------------------------------------------------------------------------
  
    function trackRevenue(data) {
      var sessionId = window.blizSessionId || getStoredSessionId();
      if (!sessionId) {
        console.warn("[Bliz] trackRevenue called but no active session.");
        return false;
      }
  
      var value = parseFloat(data && data.value);
      if (isNaN(value) || value <= 0) {
        console.warn("[Bliz] trackRevenue: value must be a positive float. Got:", data && data.value);
        return false;
      }
  
      var currency = data.currency && typeof data.currency === "string"
        ? data.currency.toUpperCase().trim()
        : null;
      if (currency && currency.length !== 3) {
        console.warn("[Bliz] trackRevenue: currency must be a 3-letter ISO code. Got:", data.currency);
        return false;
      }
  
      if (data.order_id && isRevenueOrderDuplicate(data.order_id)) {
        console.warn("[Bliz] trackRevenue: order_id already tracked, ignoring duplicate:", data.order_id);
        return false;
      }
  
      var event   = createEvent(CONFIG.events.REVENUE_SUBMIT, "revenue");
      var payload = buildBasePayload(event, sessionId);
  
      payload.revenue       = value;
      payload.currency      = currency           || undefined;
      payload.order_id      = data.order_id      || undefined;
      payload.product_title = data.product_title || undefined;
  
      sendEventToAPI(payload);
      return true;
    }
  
    // GTM CustomEvent: window.dispatchEvent(new CustomEvent('bliz:revenue', { detail: { value: 49.99, currency: 'USD' } }))
    window.addEventListener("bliz:revenue", function (e) {
      trackRevenue(e.detail || {});
    });
  
    // ---------------------------------------------------------------------------
    // Click tracking — closest() handles clicks on child elements
    // ---------------------------------------------------------------------------
  
    function setupClickListener() {
      document.addEventListener("click", function (e) {
        var target = e.target.closest("a, button");
        if (!target) return;
  
        var tagName = target.tagName.toLowerCase();
        var action  = tagName === "button" ? CONFIG.events.BUTTON_CLICK : CONFIG.events.LINK_CLICK;
        var label   = (target.innerText || "").substring(0, 100).trim()
                        || (tagName === "a" ? target.href : "button")
                        || "N/A";
  
        processEvent(createEvent(action, label));
      });
    }
  
    // ---------------------------------------------------------------------------
    // Form tracking
    // ---------------------------------------------------------------------------
  
    function setupFormListener() {
      document.addEventListener("submit", function () {
        processEvent(createEvent(CONFIG.events.FORM_SUBMIT, "form_submit"));
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
  
      // Reset per-page timer on every new pathname
      try { window.sessionStorage.setItem(CONFIG.pageStartKey, Date.now().toString()); } catch (e) {}
  
      var label = pathname.replace(/\//g, "").substring(0, 100) || "home";
      processEvent(createEvent(CONFIG.events.PAGE_VIEW, label));
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
    // PAGE_EXIT — visibilitychange:hidden + pagehide, deduped via exitFired flag
    //
    // Sends two time values:
    //   label:        "time_on_page:42s"  — seconds on the current pathname
    //   time_on_site: 187                 — total seconds since session start
    // ---------------------------------------------------------------------------
  
    var exitFired = false;
  
    function fireExitEvent() {
      if (exitFired) return;
      exitFired = true;
  
      var sessionId = window.blizSessionId || getStoredSessionId();
      if (!sessionId) return;
  
      var timeOnPage = 0;
      var timeOnSite = 0;
  
      try {
        var now          = Date.now();
        var pageStart    = parseInt(window.sessionStorage.getItem(CONFIG.pageStartKey)    || "0", 10);
        var sessionStart = parseInt(window.sessionStorage.getItem(CONFIG.sessionStartKey) || "0", 10);
        if (pageStart)    timeOnPage = Math.round((now - pageStart)    / 1000);
        if (sessionStart) timeOnSite = Math.round((now - sessionStart) / 1000);
      } catch (e) {}
  
      var event   = createEvent(CONFIG.events.PAGE_EXIT, "time_on_page:" + timeOnPage + "s");
      var payload = buildBasePayload(event, sessionId);
      payload.time_on_site = timeOnSite;
  
      sendEventToAPI(payload);
    }
  
    function setupExitListener() {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") fireExitEvent();
      });
  
      window.addEventListener("pagehide", fireExitEvent);
    }
  
    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------
  
    var BlizTracker = {
      getSessionId:  function () { return window.blizSessionId || getStoredSessionId(); },
      getLinkId:     function () { return window.blizLinkId    || getStoredLinkId();    },
      isActive:      function () { return !!(window.blizSessionId || getStoredSessionId()); },
      getApiKey:     function () { return getApiKeyFromScript(); },
      trackPageView: function () {
        delete trackedPathnames[getPathname()];
        trackPageView();
      },
      trackRevenue:  trackRevenue,
    };
  
    init();
    setupPageViewListener();
    setupClickListener();
    setupFormListener();
    setupExitListener();
    window.BlizTracker = BlizTracker;
  
  })();