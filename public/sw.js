/**
 * public/sw.js — Oscar's service worker
 * ----------------------------------------------------------------------------
 * The part of Oscar that runs when the page is closed.
 *
 * A service worker is the only way a website may show a notification while
 * nobody is looking at it. The browser wakes this file, hands it the decrypted
 * payload, and gives it a few seconds to display something.
 *
 * THREE RULES THIS FILE FOLLOWS, ALL LEARNED THE HARD WAY
 *
 *   1. `showNotification` MUST be awaited inside `event.waitUntil`. Return
 *      before the promise settles and the browser assumes you had nothing to
 *      say — Chrome then punishes you with its own "This site has been updated
 *      in the background" notice.
 *
 *   2. There is deliberately NO caching here. A service worker that caches is a
 *      service worker that serves you a stale login page after a deploy, and
 *      Oscar is useless offline anyway — every answer needs the network. This
 *      one exists solely for notifications.
 *
 *   3. It must survive a malformed payload. The push event is the one entry
 *      point that isn't driven by your own page, so it assumes nothing about
 *      what arrives.
 */

const DEFAULT_TITLE = 'Oscar';

/**
 * Take over immediately rather than waiting for every tab to close.
 *
 * Without these two, a newly deployed worker sits in "waiting" until the last
 * tab is gone — which on a phone can be days, and looks exactly like push being
 * broken.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Whatever arrived, turn it into something displayable. */
function readPayload(event) {
  if (!event.data) return { title: DEFAULT_TITLE, body: 'Something happened.' };
  try {
    const data = event.data.json();
    return {
      title: data.title || DEFAULT_TITLE,
      body: data.body || '',
      tag: data.tag,
      url: data.url,
      requireInteraction: Boolean(data.requireInteraction),
    };
  } catch {
    // Not JSON. Showing the raw text beats showing nothing.
    return { title: DEFAULT_TITLE, body: event.data.text() };
  }
}

self.addEventListener('push', (event) => {
  const payload = readPayload(event);

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // Same tag replaces an earlier notification instead of stacking. Useful
      // for progress on one long job; wrong for unrelated messages, so the
      // sender decides rather than this file.
      tag: payload.tag,
      // A question needs answering, so it stays until touched. Anything else
      // can auto-dismiss like a normal notification.
      requireInteraction: payload.requireInteraction,
      // Carried through to the click handler below.
      data: { url: payload.url || '/' },
      icon: './icon-192.png',
      badge: './icon-192.png',
    })
  );
});

/**
 * Bring Oscar to the front when a notification is tapped.
 *
 * Focuses an existing tab if there is one rather than opening a duplicate —
 * tapping four notifications should not leave four tabs behind.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) {
          if (target !== '/' && 'navigate' in client) await client.navigate(target);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })()
  );
});

/**
 * Push services expire subscriptions on their own schedule.
 *
 * When that happens the browser fires this event, and the old endpoint is
 * already dead. Re-subscribing here would need the public key, which this file
 * does not have — so it tells any open page to redo it. If nothing is open, the
 * next visit re-subscribes anyway, because the page always checks on load.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) client.postMessage({ type: 'resubscribe' });
    })()
  );
});
