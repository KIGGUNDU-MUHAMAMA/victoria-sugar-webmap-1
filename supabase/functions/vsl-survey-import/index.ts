/**
 * Survey CSV preview + commit (Supabase Edge).
 *
 * COLUMN MAPPING — one format, identical for BLOCKS and PLOTS:
 *
 *   id         grouping key. Marks where one polygon's ring starts and ends.
 *              Deliberately generic: the same file shape describes block
 *              corners or plot corners, and nothing downstream needs to know
 *              which. Never stored — the database generates its own codes.
 *   eastings   \ projected coordinates, reprojected to WGS84 here and used
 *   northings  / for the geometry, area and edge lengths.
 *   name       the feature NAME -> vsl_parcels.parcel_name / vsl_blocks.block_name.
 *
 * Legacy headers are still accepted so older files keep importing:
 *   parcel_id / block_id / feature_id  ->  id
 *   description                        ->  name
 *   point_number                       ->  ignored (see rowsToParcels)
 *
 * Codes are generated in Postgres by `vsl_survey_batch_upsert`: block codes
 * 1,2,3… per estate and parcel codes 1,2,3… per parent block. See
 * sql/019_vsl_survey_import_column_mapping.sql and sql/020_vsl_survey_name_column.sql.
 *
 * ⚠ DEPLOYS AS `quick-api`, NOT `vsl-survey-import`.
 * The client calls whatever cfg.SURVEY_FUNCTION_NAME says, which defaults to
 * "quick-api" (see surveyFunctionUrl() in js/survey-import.js). The directory
 * name here does not match the deployed slug, so:
 *
 *     supabase functions deploy quick-api
 *
 * That mismatch already caused one silent drift — the estate-name title-casing
 * below existed only in the deployed copy and was missing from this file. If
 * you edit this file, deploy it, or the change does nothing.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import proj4 from "https://esm.sh/proj4@2.11.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-vsl-survey-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Uganda-focused CRS: Arc 1960 / WGS84 UTM 35–36 N+S, plus WGS84 geographic. */
const PROJ4_DEFS: Record<string, string> = {
  "EPSG:4326": "+proj=longlat +datum=WGS84 +no_defs",
  "EPSG:32635": "+proj=utm +zone=35 +datum=WGS84 +units=m +no_defs",
  "EPSG:32735": "+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs",
  "EPSG:32636": "+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs",
  "EPSG:32736": "+proj=utm +zone=36 +south +datum=WGS84 +units=m +no_defs",
  "EPSG:21035": "+proj=utm +zone=35 +south +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs",
  "EPSG:21036": "+proj=utm +zone=36 +south +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs",
  "EPSG:21095": "+proj=utm +zone=35 +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs",
  "EPSG:21096": "+proj=utm +zone=36 +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs",
};

let proj4Initialized = false;
function ensureProj4() {
  if (proj4Initialized) return;
  for (const [code, def] of Object.entries(PROJ4_DEFS)) {
    try {
      proj4.defs(code, def);
    } catch {
      /* may already exist */
    }
  }
  proj4Initialized = true;
}

// No point_number: vertex order comes from CSV row order (see rowsToParcels).
type InputPoint = { x: number; y: number; name?: string };
type FeatureInput = { featureId: string; points: InputPoint[] };
type FeaturePreview = {
  // Grouping key from the CSV's `id` column. Transient: used for previewing,
  // the review table and error messages. Never written to the database.
  featureId: string;
  // Mirror of featureId under the old key, so a browser still running a
  // cached copy of the previous client keeps working. Remove once clients
  // have rolled over.
  parcelId: string;
  success: boolean;
  geometry?: { type: "Polygon"; coordinates: number[][][] };
  area_hectares?: number;
  num_vertices?: number;
  edge_distances?: Array<{ meters: number; label: string }>;
  // The feature NAME, from the `name` column.
  name?: string;
  errors?: string[];
  // Set by the client only on the "Automatically Choose Block" import path
  // (Survey > Import > #surveyAutoSelectCb): the block this individual plot
  // was resolved into by vsl_resolve_parcel_blocks, possibly overridden by
  // the user in the review table before saving. Never produced by
  // preview_batch — it is passed straight through to the commit RPC, which
  // prefers it over p_parent_block_code. See
  // sql/017_vsl_survey_batch_per_item_block.sql.
  block_id?: string | null;
};

function fail(status: number, message: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ success: false, error: message, ...extra }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ok(payload: Record<string, unknown>) {
  return new Response(JSON.stringify({ success: true, ...payload }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

function vincentyDistanceMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
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

function areaHectares(coords: number[][]): number {
  const avgLat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(toRadians(avgLat));
  let area = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[i + 1];
    const X1 = x1 * mPerDegLon;
    const Y1 = y1 * mPerDegLat;
    const X2 = x2 * mPerDegLon;
    const Y2 = y2 * mPerDegLat;
    area += X1 * Y2 - X2 * Y1;
  }
  return Math.abs(area) / 2 / 10000;
}

function isValidLonLat(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

function segmentsIntersect(a1: number[], a2: number[], b1: number[], b2: number[]): boolean {
  const orient = (p: number[], q: number[], r: number[]) =>
    Math.sign((q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]));
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);
  return o1 !== o2 && o3 !== o4;
}

function hasSelfIntersection(ring: number[][]): boolean {
  for (let i = 0; i < ring.length - 1; i++) {
    const a1 = ring[i];
    const a2 = ring[i + 1];
    for (let j = i + 1; j < ring.length - 1; j++) {
      if (Math.abs(i - j) <= 1) continue;
      if (i === 0 && j === ring.length - 2) continue;
      const b1 = ring[j];
      const b2 = ring[j + 1];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function processFeature(
  featureId: string,
  points: InputPoint[],
  skipSelfIntersectionCheck: boolean,
): FeaturePreview {
  const errors: string[] = [];
  if (!featureId) errors.push("Missing id");
  if (!Array.isArray(points) || points.length < 3) errors.push("At least 3 points are required");
  if (errors.length > 0) return { featureId, parcelId: featureId, success: false, errors };

  const ring: number[][] = [];
  for (const p of points) {
    const lon = Number(p.x);
    const lat = Number(p.y);
    if (!isValidLonLat(lon, lat)) {
      errors.push(`Invalid WGS84 coordinate: (${p.x}, ${p.y})`);
      continue;
    }
    ring.push([lon, lat]);
  }
  if (errors.length > 0) return { featureId, parcelId: featureId, success: false, errors };
  if (ring.length < 3) {
    return { featureId, parcelId: featureId, success: false, errors: ["Not enough valid points"] };
  }

  // Drop a repeated closing vertex if the file already carries one, so the
  // closing step below cannot leave a zero-length edge behind. Survey exports
  // routinely repeat the first point as the last row of a ring.
  while (
    ring.length > 3 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  ) {
    ring.pop();
  }
  if (ring.length < 3) {
    return { featureId, parcelId: featureId, success: false, errors: ["Not enough distinct points"] };
  }

  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  if (!skipSelfIntersectionCheck && hasSelfIntersection(ring)) {
    return { featureId, parcelId: featureId, success: false, errors: ["Polygon has self-intersections"] };
  }
  const edge_distances: Array<{ meters: number; label: string }> = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    const meters = vincentyDistanceMeters(lon1, lat1, lon2, lat2);
    edge_distances.push({ meters, label: `${meters.toFixed(2)}m` });
  }
  const area = areaHectares(ring);
  // The NAME, from the `name` column. First non-empty value in the group
  // wins — the column is expected to repeat the same name on every row of a
  // feature, so this reads it back exactly. (It also degrades sensibly on
  // older files where the column held per-point labels: you get one stable
  // label rather than every label concatenated.)
  const name = points.map((p) => String(p.name ?? "").trim()).find(Boolean) ?? "";
  return {
    featureId,
    parcelId: featureId,
    success: true,
    geometry: { type: "Polygon", coordinates: [ring] },
    area_hectares: area,
    num_vertices: ring.length - 1,
    edge_distances,
    name: name || undefined,
  };
}

function transformToWgs84(crs: string, easting: number, northing: number): [number, number] {
  ensureProj4();
  if (!PROJ4_DEFS[crs]) {
    throw new Error(`Unsupported CRS: ${crs}`);
  }
  if (crs === "EPSG:4326") {
    return [easting, northing];
  }
  const out = proj4(crs, "EPSG:4326", [easting, northing]) as [number, number];
  return out;
}

type CsvRow = Record<string, unknown>;

/**
 * Reads one CSV row into { id, eastings, northings, name }.
 *
 * `point_number` is deliberately ignored. It used to order the vertices, but
 * in real exports it is a file-wide running counter rather than a per-feature
 * one, and rings are often written with their first point repeated at the end
 * to close them. Sorting on it therefore moved that duplicate next to its twin
 * and produced a zero-length edge. CSV row order is the authoritative vertex
 * order — which is how the surveyor's file is written in the first place.
 * A consequence worth knowing: re-sorting the CSV before importing will
 * scramble the polygons.
 */
function normalizeCsvRow(row: CsvRow): {
  id: string;
  eastings: number;
  northings: number;
  name: string;
} | null {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    // Strip a leading UTF-8 BOM. Files exported from Excel begin with one, so
    // the first header arrives as "﻿id" and would never match.
    lower[String(k).replace(/^﻿/, "").toLowerCase().trim()] = v;
  }
  // `id` is the current column; the rest are legacy headers kept working.
  const id = String(
    lower["id"] ?? lower["feature_id"] ?? lower["parcel_id"] ?? lower["block_id"] ?? "",
  ).trim();
  const eastings = Number(lower["eastings"] ?? lower["easting"]);
  const northings = Number(lower["northings"] ?? lower["northing"]);
  const name = String(lower["name"] ?? lower["description"] ?? "");
  if (!id || !Number.isFinite(eastings) || !Number.isFinite(northings)) {
    return null;
  }
  return { id, eastings, northings, name };
}

function rowsToFeatures(
  rows: CsvRow[],
  crs: string,
): { features: FeatureInput[]; skipped: number; pointCount: number } {
  // Map preserves insertion order, and rows are pushed in file order, so both
  // the features and the vertices within each feature keep the CSV's ordering.
  const groups = new Map<string, Array<{ east: number; north: number; name: string }>>();
  let skipped = 0;
  for (const row of rows) {
    const n = normalizeCsvRow(row);
    if (!n) {
      skipped++;
      continue;
    }
    if (!groups.has(n.id)) groups.set(n.id, []);
    groups.get(n.id)!.push({ east: n.eastings, north: n.northings, name: n.name });
  }
  let pointCount = 0;
  const features: FeatureInput[] = [];
  for (const [featureId, pts] of groups) {
    pointCount += pts.length;
    const points: InputPoint[] = pts.map((p) => {
      const [lon, lat] = transformToWgs84(crs, p.east, p.north);
      return { x: lon, y: lat, name: p.name };
    });
    features.push({ featureId, points });
  }
  return { features, skipped, pointCount };
}

function checkSurveySecret(req: Request): boolean {
  const secret = Deno.env.get("SURVEY_IMPORT_SECRET");
  if (!secret) return true;
  const hdr = req.headers.get("x-vsl-survey-secret");
  return hdr === secret;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail(405, "Method not allowed");
  if (!checkSurveySecret(req)) return fail(403, "Invalid or missing survey import secret");

  try {
    const body = await req.json();
    const action = String(body?.action || "");

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRole) return fail(500, "Missing Supabase environment variables");

    if (action === "preview_batch") {
      const crs = String(body?.crs || "");
      if (!PROJ4_DEFS[crs]) {
        return fail(400, `Invalid crs. Allowed: ${Object.keys(PROJ4_DEFS).join(", ")}`);
      }
      const rows: CsvRow[] = Array.isArray(body?.rows) ? body.rows : [];
      if (rows.length === 0) return fail(400, "No CSV rows supplied");
      const skip = !!body?.skipSelfIntersectionCheck;
      const { features, skipped, pointCount } = rowsToFeatures(rows, crs);
      const results: FeaturePreview[] = features.map((f) =>
        processFeature(f.featureId, f.points, skip)
      );
      const validCount = results.filter((r) => r.success).length;
      return ok({
        crs,
        summary: {
          totalParcels: results.length,
          validParcels: validCount,
          failedParcels: results.length - validCount,
          totalPoints: pointCount,
          skippedRows: skipped,
        },
        results,
      });
    }

    if (action === "commit_batch") {
      const admin = createClient(supabaseUrl, serviceRole);
      const layerType = String(body?.layerType || "").toUpperCase();
      if (layerType !== "BLOCKS" && layerType !== "PARCELS") {
        return fail(400, "layerType must be BLOCKS or PARCELS");
      }
      const parentBlockCode = body?.parentBlockCode != null ? String(body.parentBlockCode) : "";

      // Estate name, title-cased. Accepts either key: the client sends
      // `projectName`, but `estate_name` is honoured first so a caller using
      // the schema's own vocabulary works too.
      const rawEstate = body?.estate_name != null
        ? String(body.estate_name)
        : (body?.projectName != null ? String(body.projectName) : "");
      const estateName = rawEstate.trim()
        ? rawEstate.trim().replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        : null;

      const coordinateSystem = body?.coordinateSystem != null ? String(body.coordinateSystem) : "";
      const additionalInfo = body?.additionalInfo != null ? String(body.additionalInfo) : "";
      const results: FeaturePreview[] = Array.isArray(body?.results) ? body.results : [];
      const valid = results.filter((r: FeaturePreview) => r.success && r.geometry);
      if (valid.length === 0) return fail(400, "No valid features to commit");

      const p_items = valid.map((r: FeaturePreview) => {
        // Tolerate either key from the client: a cached copy of the previous
        // build still sends parcelId/descriptions.
        const featureId = r.featureId ?? r.parcelId ?? "";
        const name = r.name ?? (r as { descriptions?: string }).descriptions ?? "";
        return {
          // Grouping key only — the RPC uses it to label errors, never stores it.
          feature_id: featureId,
          csv_parcel_id: featureId,
          geometry: r.geometry,
          area_hectares: r.area_hectares,
          num_vertices: r.num_vertices,
          edge_distances: r.edge_distances,
          // The NAME -> parcel_name / block_name.
          name,
          // Same value under the old key, for a database that has not yet had
          // sql/020 applied.
          descriptions: name,
          // Per-plot parent block, when the client resolved one. Omitted (null)
          // for the ordinary "pick one block for the whole batch" path, where
          // p_parent_block_code below still does the work.
          block_id: typeof r.block_id === "string" && r.block_id.trim() !== ""
            ? r.block_id.trim()
            : null,
        };
      });

      // Only one of the two is required. The RPC rejects PARCELS with neither
      // a parent block code nor any per-item block_id, so let it decide
      // rather than blocking here — a batch may legitimately arrive with an
      // empty parentBlockCode when every item carries its own block.
      const hasItemBlocks = p_items.some((it) => it.block_id !== null);
      if (layerType === "PARCELS" && !hasItemBlocks && parentBlockCode.trim() === "") {
        return fail(400, "Select a parent block, or enable automatic block selection.");
      }

      const { data, error } = await admin.rpc("vsl_survey_batch_upsert", {
        p_layer_type: layerType,
        p_parent_block_code: layerType === "PARCELS" ? parentBlockCode : null,
        p_project_name: estateName,
        p_coordinate_system: coordinateSystem || null,
        p_additional_info: additionalInfo || null,
        p_items,
      });

      if (error) return fail(500, `Database error: ${error.message}`);
      if (data && typeof data === "object" && (data as { success?: boolean }).success === false) {
        return fail(400, String((data as { error?: string }).error || "Batch upsert failed"));
      }
      return ok({ db: data });
    }

    return fail(400, `Unsupported action: ${action}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    return fail(500, message);
  }
});
