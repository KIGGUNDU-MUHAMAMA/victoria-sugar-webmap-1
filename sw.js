self.addEventListener('install', event => {
    console.log('Service Worker Installed');
});

// Only same-origin requests are handled here. The previous version called
// respondWith(fetch(...)) for EVERY request, including cross-origin ones to
// the tile worker. That gained nothing (there is no cache) and actively hurt:
// re-issuing a cross-origin request through the worker turns a clear CORS
// message into "FetchEvent resulted in a network error response" plus an
// unhandled rejection from this file, hiding the real cause.
//
// Not calling respondWith leaves the request to the browser, untouched.
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    event.respondWith(fetch(event.request));
});
