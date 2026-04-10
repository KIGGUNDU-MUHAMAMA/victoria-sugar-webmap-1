/**
 * Survey CSV preview + commit (Supabase Edge). Numbering is enforced in Postgres:
 * run `sql/006_vsl_survey_auto_numbering.sql` so `vsl_survey_batch_upsert` assigns
 * block codes 1,2,3… globally and parcel numbers 1,2,3… per parent block.
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

type InputPoint = { x: number; y: number; point_number?: string | number; description?: string };
type ParcelInput = { parcelId: string; points: InputPoint[] };
type ParcelPreview = {
  parcelId: string;
  success: boolean;
  geometry?: { type: "Polygon"; coordinates: number[][][] };
  area_hectares?: number;
  num_vertices?: number;
  edge_distances?: Array<{ meters: number; label: string }>;
  descriptions?: string;
  errors?: string[];
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

function processParcel(
  parcelId: string,
  points: InputPoint[],
  skipSelfIntersectionCheck: boolean,
): ParcelPreview {
  const errors: string[] = [];
  if (!parcelId) errors.push("Missing parcelId");
  if (!Array.isArray(points) || points.length < 3) errors.push("At least 3 points are required");
  if (errors.length > 0) return { parcelId, success: false, errors };

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
  if (errors.length > 0) return { parcelId, success: false, errors };
  if (ring.length < 3) return { parcelId, success: false, errors: ["Not enough valid points"] };
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  if (!skipSelfIntersectionCheck && hasSelfIntersection(ring)) {
    return { parcelId, success: false, errors: ["Polygon has self-intersections"] };
  }
  const edge_distances: Array<{ meters: number; label: string }> = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    const meters = vincentyDistanceMeters(lon1, lat1, lon2, lat2);
    edge_distances.push({ meters, label: `${meters.toFixed(2)}m` });
  }
  const area = areaHectares(ring);
  const descriptions = points
    .map((p) => String(p.description ?? "").trim())
    .filter(Boolean)
    .join(" | ");
  return {
    parcelId,
    success: true,
    geometry: { type: "Polygon", coordinates: [ring] },
    area_hectares: area,
    num_vertices: ring.length - 1,
    edge_distances,
    descriptions: descriptions || undefined,
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

function normalizeCsvRow(row: CsvRow): {
  parcel_id: string;
  point_number: number;
  eastings: number;
  northings: number;
  description: string;
} | null {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    lower[String(k).toLowerCase().trim()] = v;
  }
  const parcel_id = String(lower["parcel_id"] ?? "").trim();
  const pn = Number(lower["point_number"]);
  const eastings = Number(lower["eastings"] ?? lower["easting"]);
  const northings = Number(lower["northings"] ?? lower["northing"]);
  const description = String(lower["description"] ?? "");
  if (!parcel_id || !Number.isFinite(pn) || !Number.isFinite(eastings) || !Number.isFinite(northings)) {
    return null;
  }
  return { parcel_id, point_number: pn, eastings, northings, description };
}

function rowsToParcels(
  rows: CsvRow[],
  crs: string,
): { parcels: ParcelInput[]; skipped: number; pointCount: number } {
  const groups = new Map<string, Array<{ pn: number; east: number; north: number; desc: string }>>();
  let skipped = 0;
  for (const row of rows) {
    const n = normalizeCsvRow(row);
    if (!n) {
      skipped++;
      continue;
    }
    if (!groups.has(n.parcel_id)) groups.set(n.parcel_id, []);
    groups.get(n.parcel_id)!.push({
      pn: n.point_number,
      east: n.eastings,
      north: n.northings,
      desc: n.description,
    });
  }
  let pointCount = 0;
  const parcels: ParcelInput[] = [];
  for (const [parcelId, pts] of groups) {
    pts.sort((a, b) => a.pn - b.pn);
    pointCount += pts.length;
    const points: InputPoint[] = pts.map((p) => {
      const [lon, lat] = transformToWgs84(crs, p.east, p.north);
      return { x: lon, y: lat, point_number: p.pn, description: p.desc };
    });
    parcels.push({ parcelId, points });
  }
  return { parcels, skipped, pointCount };
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
      const { parcels, skipped, pointCount } = rowsToParcels(rows, crs);
      const results: ParcelPreview[] = parcels.map((p) =>
        processParcel(p.parcelId, p.points, skip)
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
      const projectName = body?.projectName != null ? String(body.projectName) : "";
      const coordinateSystem = body?.coordinateSystem != null ? String(body.coordinateSystem) : "";
      const additionalInfo = body?.additionalInfo != null ? String(body.additionalInfo) : "";
      const results: ParcelPreview[] = Array.isArray(body?.results) ? body.results : [];
      const valid = results.filter((r: ParcelPreview) => r.success && r.geometry);
      if (valid.length === 0) return fail(400, "No valid parcels to commit");

      const p_items = valid.map((r: ParcelPreview) => ({
        csv_parcel_id: r.parcelId,
        geometry: r.geometry,
        area_hectares: r.area_hectares,
        num_vertices: r.num_vertices,
        edge_distances: r.edge_distances,
        descriptions: r.descriptions || "",
      }));

      const { data, error } = await admin.rpc("vsl_survey_batch_upsert", {
        p_layer_type: layerType,
        p_parent_block_code: layerType === "PARCELS" ? parentBlockCode : null,
        p_project_name: projectName || null,
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
