// ══════════════════════════════════════
//  SHARED QR CODE / MAPS-LINK HELPER
//  Centralizes "build a Google Maps link" + "render a QR code for it" so
//  every detail view (Estate / Block / Plot) can call the same two
//  functions instead of re-implementing this. If the underlying QR
//  library ever changes, this is the only file that needs to change.
//
//  Requires the qrcodejs CDN <script> (loaded in index.html, exposes a
//  global `QRCode` constructor) to be loaded before this file runs its
//  render call — but since renderQRCode() is only invoked at call time
//  (never at parse time), script order relative to this file doesn't
//  matter as long as both are present in the page before first use.
// ══════════════════════════════════════

/**
 * Builds a Google Maps "pin" link from a lat/lng pair (e.g. a captured
 * GPS centroid). Returns null if either coordinate is missing.
 */
function buildGoogleMapsLink(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  const latN = Number(lat), lngN = Number(lng);
  if (!isFinite(latN) || !isFinite(lngN)) return null;
  return `https://maps.google.com/?q=${latN},${lngN}`;
}

/**
 * Builds a Google Maps text-search link from a free-text address/place
 * name — used as a fallback for records that don't have captured
 * coordinates yet. Returns null for empty/placeholder input.
 */
function buildGoogleMapsSearchLink(query) {
  if (!query || query === '—') return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Renders a QR code for `text` into the DOM element with id `containerId`.
 * Safe to call repeatedly (clears any previous content first). Falls back
 * to a small message if there's no link to encode or the QR library
 * failed to load.
 *
 * @param {string} containerId - id of an (ideally empty) container element
 * @param {string|null|undefined} text - the URL/text to encode
 * @param {object} [opts]
 * @param {number} [opts.size=112] - width & height in px
 * @param {string} [opts.colorDark='#1a3d2b']
 * @param {string} [opts.colorLight='#ffffff']
 */
function renderQRCode(containerId, text, opts) {
  opts = opts || {};
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';

  if (!text) {
    el.innerHTML = '<span style="font-size:10px;color:var(--gray-500);text-align:center;padding:0 6px">No location captured yet</span>';
    return;
  }
  if (typeof QRCode === 'undefined') {
    console.error('qrcodejs library not loaded — cannot render QR code');
    el.innerHTML = '<span style="font-size:10px;color:var(--gray-500);text-align:center;padding:0 6px">QR unavailable</span>';
    return;
  }

  const size = opts.size || 112;
  try {
    new QRCode(el, {
      text,
      width: size,
      height: size,
      colorDark: opts.colorDark || '#1a3d2b',
      colorLight: opts.colorLight || '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch (err) {
    console.error('Failed to render QR code:', err);
    el.innerHTML = '<span style="font-size:10px;color:var(--gray-500);text-align:center;padding:0 6px">QR failed to render</span>';
  }
}

/**
 * Convenience: builds the small "Location" card markup shared by the
 * Estate / Block / Plot detail views (QR box + Open-in-Maps link) and
 * schedules the QR render for right after the returned HTML is inserted
 * into the DOM (the caller assigns this string to some element's
 * innerHTML synchronously, and this setTimeout(...,0) runs on the next
 * tick — after that assignment has happened).
 *
 * @param {string} qrContainerId - unique id for the QR container (caller must not reuse across simultaneously-visible views)
 * @param {string|null} mapsLink
 */
function locationCardHTML(qrContainerId, mapsLink) {
  setTimeout(() => renderQRCode(qrContainerId, mapsLink), 0);
  return `
  <div class="card" style="margin-bottom:20px">
    <div class="card-header"><div class="card-title">Location</div></div>
    <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:center;padding:4px 0">
      <div id="${qrContainerId}" style="width:112px;height:112px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1px solid var(--gray-100);border-radius:var(--radius-sm);background:#fff"></div>
      <div style="flex:1;min-width:200px">
        ${mapsLink
          ? `<a href="${mapsLink}" target="_blank" rel="noopener" class="btn btn-outline btn-sm">📍 Open in Google Maps ↗</a>
             <div style="font-size:11px;color:var(--gray-500);margin-top:8px;word-break:break-all">${mapsLink}</div>`
          : `<div style="font-size:13px;color:var(--gray-500)">No coordinates or address captured for this record yet.</div>`}
      </div>
    </div>
  </div>`;
}
