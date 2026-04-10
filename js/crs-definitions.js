/**
 * Uganda-focused CRS list + proj4 strings (aligned with Survey Edge Function).
 */

export const CRS_OPTIONS = [
  { value: "EPSG:4326", label: "WGS 84 — geographic (longitude / latitude)" },
  { value: "EPSG:21095", label: "Arc 1960 / UTM zone 35N" },
  { value: "EPSG:21035", label: "Arc 1960 / UTM zone 35S" },
  { value: "EPSG:21096", label: "Arc 1960 / UTM zone 36N" },
  { value: "EPSG:21036", label: "Arc 1960 / UTM zone 36S" },
  { value: "EPSG:32635", label: "WGS 84 / UTM zone 35N" },
  { value: "EPSG:32735", label: "WGS 84 / UTM zone 35S" },
  { value: "EPSG:32636", label: "WGS 84 / UTM zone 36N" },
  { value: "EPSG:32736", label: "WGS 84 / UTM zone 36S" }
];

export const PROJ4_DEFS = {
  "EPSG:4326": "+proj=longlat +datum=WGS84 +no_defs",
  "EPSG:32635": "+proj=utm +zone=35 +datum=WGS84 +units=m +no_defs",
  "EPSG:32735": "+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs",
  "EPSG:32636": "+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs",
  "EPSG:32736": "+proj=utm +zone=36 +south +datum=WGS84 +units=m +no_defs",
  "EPSG:21035": "+proj=utm +zone=35 +south +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs",
  "EPSG:21036": "+proj=utm +zone=36 +south +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs",
  "EPSG:21095": "+proj=utm +zone=35 +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs",
  "EPSG:21096": "+proj=utm +zone=36 +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs"
};

let olProj4Hooked = false;

/**
 * Register proj4 with OpenLayers, then add Uganda CRS defs (idempotent per proj4 instance).
 * Hooking OL ensures map plotting matches Survey preview (GeoJSON 4326→3857 path).
 */
export function registerProj4Defs(proj4lib) {
  if (!proj4lib?.defs) return;
  if (typeof ol !== "undefined" && ol.proj?.proj4?.register && !olProj4Hooked) {
    ol.proj.proj4.register(proj4lib);
    olProj4Hooked = true;
  }
  for (const [code, def] of Object.entries(PROJ4_DEFS)) {
    try {
      proj4lib.defs(code, def);
    } catch {
      /* already defined */
    }
  }
}

/**
 * @returns {[lon, lat]} in WGS84 degrees (for validation / status text)
 */
export function toLonLatFromCrs(proj4lib, crs, easting, northing) {
  if (crs === "EPSG:4326") {
    return [Number(easting), Number(northing)];
  }
  if (!PROJ4_DEFS[crs]) {
    throw new Error(`Unknown CRS: ${crs}`);
  }
  const out = proj4lib(crs, "EPSG:4326", [Number(easting), Number(northing)]);
  return [out[0], out[1]];
}

/**
 * Map coordinate in EPSG:3857 for markers / view — same chain as ol.format.GeoJSON readFeature.
 * Call after registerProj4Defs(proj4lib).
 */
export function toMap3857FromCrs(crs, easting, northing) {
  if (typeof ol === "undefined" || !ol.proj?.transform) {
    throw new Error("OpenLayers is not loaded; cannot transform coordinates.");
  }
  const e = Number(easting);
  const n = Number(northing);
  if (crs === "EPSG:4326") {
    return ol.proj.transform([e, n], "EPSG:4326", "EPSG:3857");
  }
  if (!PROJ4_DEFS[crs]) {
    throw new Error(`Unknown CRS: ${crs}`);
  }
  return ol.proj.transform([e, n], crs, "EPSG:3857");
}

/**
 * @returns {[x, y]} easting/northing (or lon/lat degrees if crs is EPSG:4326)
 */
export function toProjectedFromWgs84(proj4lib, crs, lon, lat) {
  if (crs === "EPSG:4326") {
    return [Number(lon), Number(lat)];
  }
  if (!PROJ4_DEFS[crs]) {
    throw new Error(`Unknown CRS: ${crs}`);
  }
  const out = proj4lib("EPSG:4326", crs, [Number(lon), Number(lat)]);
  return [out[0], out[1]];
}
