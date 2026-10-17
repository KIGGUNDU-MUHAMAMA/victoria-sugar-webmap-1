import { showToast, hideToast } from "../toast/toast.js";

// setStatus()/clearStatus() are called from ~120 places across the app.
// Elements using the .toast class (see toast/toast.css) get the full toast
// treatment (auto-hide after a few seconds); anything else keeps the old
// plain behavior (e.g. login.html's inline, non-floating form message,
// which should stay up until the next status change, not vanish on its
// own).
export function setStatus(el, message, isError = false) {
  if (!el) return;
  if (el.classList.contains("toast")) {
    showToast(el, message, { isError });
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle("error", Boolean(isError));
}

export function clearStatus(el) {
  if (!el) return;
  if (el.classList.contains("toast")) {
    hideToast(el);
    return;
  }
  el.hidden = true;
  el.textContent = "";
  el.classList.remove("error");
}

export function assertRole(role) {
  return ["ADMIN", "SURVEYOR", "MANAGMENT"].includes(role);
}

export function parseNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

export function vincentyDistanceMeters(lon1, lat1, lon2, lat2) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const b = (1 - f) * a;
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const L = toRadians(lon2 - lon1);
  const U1 = Math.atan((1 - f) * Math.tan(phi1));
  const U2 = Math.atan((1 - f) * Math.tan(phi2));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);
  let lambda = L;
  let lambdaPrev = 0;
  let iter = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let sinAlpha = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;
  while (Math.abs(lambda - lambdaPrev) > 1e-12 && iter < 200) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    const t1 = cosU2 * sinLambda;
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
    sinSigma = Math.sqrt(t1 * t1 + t2 * t2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    if (cosSqAlpha !== 0) {
      cos2SigmaM = cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    } else {
      cos2SigmaM = 0;
    }
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    lambdaPrev = lambda;
    lambda =
      L +
      (1 - C) * f * sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    iter++;
  }
  if (iter >= 200) {
    const R = 6371008.8;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B * sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return b * A * (sigma - deltaSigma);
}

export function wgs84ToUTM(lon, lat) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const eSq = 2*f - f*f;
  
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lon0 = (zone - 1) * 6 - 180 + 3;
  
  const lonRad = toRadians(lon);
  const latRad = toRadians(lat);
  const lon0Rad = toRadians(lon0);
  
  const N = a / Math.sqrt(1 - eSq * Math.pow(Math.sin(latRad), 2));
  const T = Math.pow(Math.tan(latRad), 2);
  const C = eSq * Math.pow(Math.cos(latRad), 2) / (1 - eSq);
  const A = Math.cos(latRad) * (lonRad - lon0Rad);
  
  const M = a * (
    (1 - eSq/4 - 3*eSq*eSq/64 - 5*Math.pow(eSq,3)/256) * latRad
    - (3*eSq/8 + 3*eSq*eSq/32 + 45*Math.pow(eSq,3)/1024) * Math.sin(2*latRad)
    + (15*eSq*eSq/256 + 45*Math.pow(eSq,3)/1024) * Math.sin(4*latRad)
    - (35*Math.pow(eSq,3)/3072) * Math.sin(6*latRad)
  );
  
  const x = k0 * N * (
    A + (1-T+C)*Math.pow(A,3)/6
    + (5 - 18*T + T*T + 72*C - 58*eSq)*Math.pow(A,5)/120
  ) + 500000.0;
  
  let y = k0 * (
    M + N * Math.tan(latRad) * (
      Math.pow(A,2)/2
      + (5 - T + 9*C + 4*C*C)*Math.pow(A,4)/24
      + (61 - 58*T + T*T + 600*C - 330*eSq)*Math.pow(A,6)/720
    )
  );
  
  if (lat < 0) y += 10000000.0;
  
  return [x, y];
}

export function computeUtmCartesianAreaAcres(lonLats) {
  if (!lonLats || lonLats.length < 3) return 0;
  const utmCoords = lonLats.map(pt => wgs84ToUTM(pt[0], pt[1]));
  let area = 0;
  for (let i = 0; i < utmCoords.length - 1; i++) {
    area += utmCoords[i][0] * utmCoords[i+1][1] - utmCoords[i+1][0] * utmCoords[i][1];
  }
  return (Math.abs(area) / 2) * 0.000247105381;
}

// ===========================================================================
// MAP ZOOM LADDER — what appears at which zoom
// ---------------------------------------------------------------------------
// One place to tune every zoom-dependent show/hide on the map. Values are
// OpenLayers view zoom levels, and each entry is the zoom at which that
// thing STARTS being drawn; below it, it isn't drawn at all.
//
// The order of the values below IS the intended reveal order as you zoom in,
// and assertZoomLadder() at the bottom of this block enforces that — so a
// careless edit that puts plot labels before the plots themselves fails
// loudly at load rather than looking subtly wrong on the map.
//
//      zoomed OUT                                        zoomed IN
//      │                                                         │
//      ├─ ESTATE ─────────────────────────────── always visible
//      ├─ BLOCK ──────────────── 11    block outlines
//      ├─ BLOCK_LABEL ───────── 12.5   block names
//      ├─ PLOT ──────────────── 13     plot outlines + status fills
//      ├─ PLOT_LABEL ────────── 13.5   plot name + area
//      ├─ FEATURE ───────────── 14.5   trees, roads, walls …
//      ├─ FEATURE_LABEL ─────── 14.5   …and their names
//      └─ PLOT_DISTANCE ─────── 16.5   per-edge metre labels
//
// Rough scale reference (EPSG:3857, near the equator): z11 ≈ 76 m/px,
// z13 ≈ 19 m/px, z15 ≈ 4.8 m/px, z17 ≈ 1.2 m/px.
// ===========================================================================
export const MAP_ZOOM = Object.freeze({
  /** Estates are the coarsest thing on the map and the only orientation cue
   *  when zoomed right out, so they are never hidden. */
  ESTATE: 0,
  ESTATE_LABEL: 0,

  BLOCK: 11,
  BLOCK_LABEL: 12.5,

  PLOT: 13,
  PLOT_LABEL: 13.5,

  /** Features and their labels appear together: a tree icon with no name is
   *  not much use, and they declutter against each other anyway. */
  FEATURE: 14.5,
  FEATURE_LABEL: 14.5,

  /** Per-edge distances are survey detail — they only make sense once a
   *  single plot fills a good part of the screen, and at any lower zoom they
   *  turn the map into a wall of numbers. */
  PLOT_DISTANCE: 16.5
});

/** Resolution (m/px) at zoom 0 for EPSG:3857 — the fallback below, for the
 *  rare moment a style function runs before the view can be consulted. */
const WEB_MERCATOR_ZOOM0_RESOLUTION = 156543.03392804097;

/**
 * View zoom for a resolution, as handed to an OpenLayers style function.
 *
 * Style functions receive a resolution, but thresholds are far easier to
 * reason about (and for anyone to retune) as zoom levels — hence this.
 * Prefers the view's own conversion, which respects a custom resolution set
 * or projection, and falls back to the standard Web Mercator formula.
 */
export function zoomFromResolution(view, resolution) {
  if (!Number.isFinite(resolution) || resolution <= 0) return 0;
  const z = view?.getZoomForResolution?.(resolution);
  if (Number.isFinite(z)) return z;
  return Math.log2(WEB_MERCATOR_ZOOM0_RESOLUTION / resolution);
}

/**
 * OpenLayers treats `minZoom` on a layer as EXCLUSIVE — the layer shows when
 * view zoom is strictly greater. Thresholds here are meant inclusively ("at
 * z13 the plots are on"), so this nudges the value just below.
 */
export function layerMinZoom(threshold) {
  return threshold - 1e-6;
}

/** Fails loudly if the ladder is ever edited out of order. Called once at
 *  module load, so a bad edit surfaces immediately instead of as a map that
 *  draws labels for shapes it isn't drawing. */
function assertZoomLadder() {
  const order = [
    ["ESTATE", MAP_ZOOM.ESTATE],
    ["ESTATE_LABEL", MAP_ZOOM.ESTATE_LABEL],
    ["BLOCK", MAP_ZOOM.BLOCK],
    ["BLOCK_LABEL", MAP_ZOOM.BLOCK_LABEL],
    ["PLOT", MAP_ZOOM.PLOT],
    ["PLOT_LABEL", MAP_ZOOM.PLOT_LABEL],
    ["FEATURE", MAP_ZOOM.FEATURE],
    ["FEATURE_LABEL", MAP_ZOOM.FEATURE_LABEL],
    ["PLOT_DISTANCE", MAP_ZOOM.PLOT_DISTANCE]
  ];
  for (let i = 1; i < order.length; i++) {
    if (order[i][1] < order[i - 1][1]) {
      console.error(
        `[Victoria map] MAP_ZOOM is out of order: ${order[i][0]} (${order[i][1]}) ` +
        `appears before ${order[i - 1][0]} (${order[i - 1][1]}). ` +
        "A label would be drawn at a zoom where its own layer is hidden."
      );
      return false;
    }
  }
  return true;
}
assertZoomLadder();
