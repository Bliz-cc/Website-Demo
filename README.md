# Website Demo — Bliz Tracking Integration Guide

This repository contains a demo e-commerce website (FashionHub) that demonstrates how to integrate the **Bliz tracking snippet** into any website to capture user behavior, navigation flows, and revenue events.

---

## What This Demo Includes

| File | Description |
|---|---|
| `index.html` | Homepage with hero, product grid, newsletter form |
| `checkout.html` | Checkout page with order form and purchase button |
| `bliz-tracker.js` | The Bliz client-side tracking script |

The demo simulates a real e-commerce funnel: landing page → product browsing → checkout → purchase. Every step fires tracking events that appear in your Bliz dashboard analytics.

---

## How to Get Your Credential Key

Before integrating the snippet, you need an API key from your Bliz dashboard.

1. Log in to your account at [bliz.cc](https://bliz.cc)
2. Navigate to **Settings → Credentials**
3. Click **Generate New Key**
4. Copy your `secret_key` — this is your `data-key` for the snippet

> ⚠️ Keep your credential key private. Do not commit it to public repositories. Use environment variables or a build-time injection step for production deployments.

---

## Installing the Snippet

Paste the following loader **as the very first script in `<head>`**, before any other scripts:

```html
<script>
  (function() {
    var script = document.createElement('script');
    script.id = "bliz-snippet";
    script.setAttribute("data-key", "YOUR_CREDENTIAL_KEY_FROM_BLIZ_DASHBOARD");
    script.src = "https://cdn.bliz.cc/tracker/bliz-tracker.js";
    script.async = true;
    document.head.appendChild(script);
  })();
</script>
```

Replace `YOUR_CREDENTIAL_KEY_FROM_BLIZ_DASHBOARD` with the key you copied from the Credentials page.

### Important: allowed origins

In your Bliz dashboard under **Credentials → Allowed Origins**, add the domain(s) where the snippet is installed, for example:

```
https://yourstore.com
https://www.yourstore.com
```

Requests from unlisted origins will be rejected.

---

## How It Works

Once installed, the tracker automatically handles the following without any additional code:

### Automatic Events

| Event | Trigger |
|---|---|
| `PAGE_VIEW` | Fires once per unique pathname per session. Works with SPAs — patches `pushState` / `replaceState` and listens to `popstate`. |
| `PAGE_EXIT` | Fires when the user leaves (tab hidden, tab closed, page unloaded). Includes time on page and total session duration. |
| `LINK_CLICK` | Any `<a>` click, captures the link text or href as label. |
| `BUTTON_CLICK` | Any `<button>` click, captures the button text as label. |
| `FORM_SUBMIT` | Any `<form>` submission. |

### Session Tracking

The tracker reads the `bliz_sid` query parameter appended by Bliz's redirect system when a user arrives from a Bliz short link. The parameter is a base64url-encoded string containing the session ID and link ID.

If `bliz_sid` is present, the tracker stores the session in `sessionStorage` and associates all subsequent events with that session and link. If the user arrives without a `bliz_sid` (direct visit), events are still collected but will not be attributed to a specific Bliz link.

---

## Revenue Tracking

For purchase events, call `BlizTracker.trackRevenue()` manually after a successful transaction:

```javascript
BlizTracker.trackRevenue({
  value: 34.99,           // required — positive float
  currency: "USD",        // required — 3-letter ISO 4217 code
  order_id: "ORD-00123",  // recommended — used for deduplication
  product_title: "Classic White Tee + Shipping"  // optional
});
```

### In the Checkout Demo

The checkout page fires `trackRevenue` when the "Place Order" button is clicked and the form is valid:

```javascript
document.querySelector('.btn').addEventListener('click', function(e) {
  e.preventDefault();
  // ... your order processing logic ...

  BlizTracker.trackRevenue({
    value: 34.99,
    currency: "USD",
    order_id: "ORD-" + Date.now(),
    product_title: "Classic White Tee"
  });
});
```

### Deduplication

If the same `order_id` is passed more than once in a session, the second call is silently ignored. This prevents double-counting on page refreshes or accidental double-clicks.

---

## GTM Integration

If you manage tracking via Google Tag Manager, fire revenue events using a CustomEvent from a GTM Custom HTML tag:

```javascript
// Inside a GTM Custom HTML tag
window.dispatchEvent(new CustomEvent('bliz:revenue', {
  detail: {
    value: 34.99,
    currency: "USD",
    order_id: "ORD-00123",
    product_title: "Classic White Tee"
  }
}));
```

The tracker listens for `bliz:revenue` on `window` automatically.

---

## Time on Site

The `PAGE_EXIT` event automatically includes two time measurements:

- **`time_on_page`** — seconds the user spent on the current pathname since the last page view. Resets on every SPA navigation.
- **`time_on_site`** — total seconds elapsed since the session started. Never resets within the same session.

These appear in your Bliz dashboard under **Page Events → Session Analytics**.

---

## Public API

After the script loads, `window.BlizTracker` exposes the following methods:

```javascript
BlizTracker.getSessionId()   // returns current session ID or null
BlizTracker.getLinkId()      // returns the Bliz link ID or null
BlizTracker.isActive()       // returns true if a session is active
BlizTracker.getApiKey()      // returns the data-key from the script tag
BlizTracker.trackPageView()  // manually force a page view for current pathname
BlizTracker.trackRevenue(data) // manually fire a REVENUE_SUBMIT event
```

---

## Verifying the Integration

1. Open your site in a browser with DevTools open
2. Go to the **Network** tab and filter by `page-events`
3. Navigate between pages, click links, and submit a form
4. You should see `POST /api/v1/page-events` requests with `201 Created` responses

Alternatively, open the **Bliz Dashboard → Link → Analytics → Page Events** tab to see live data flowing in within a few seconds of events firing.

---

## Running the Demo Locally

No build step required — the demo is plain HTML.

```bash
# Using Python
python3 -m http.server 8080

# Using Node
npx serve .

# Using VS Code
# Install the "Live Server" extension and click "Go Live"
```

Then open `http://localhost:8080` in your browser.

> The snippet's `API_ENDPOINT` in `bliz-tracker.js` defaults to `http://localhost:3000/api/v1/page-events` for local development. Point it to your production API URL before deploying.

---

## File Structure

```
website-demo/
├── index.html          # Homepage
├── checkout.html       # Checkout page
├── bliz-tracker.js     # Tracking script (v1.9)
└── README.md           # This file
```

---

## Support

If you have questions about your credential key, allowed origins, or dashboard analytics, visit the [Bliz Help Center](https://bliz.cc) or contact support from within your dashboard.