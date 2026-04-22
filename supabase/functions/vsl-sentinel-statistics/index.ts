/**
 * NDVI + NDMI statistics (Sentinel-2) for one vsl_blocks polygon (EPSG:4326).
 * OAuth client credentials (Copernicus Data Space default):
 *   SENTINEL_HUB_CLIENT_ID, SENTINEL_HUB_CLIENT_SECRET
 * Optional:
 *   SENTINEL_HUB_TOKEN_URL — token endpoint (default: CDSE Keycloak)
 *   SENTINEL_HUB_STATISTICS_URL — POST target (default: CDSE Statistics API)
 * Legacy Planet/Sentinel Hub: set both URLs to services.sentinel-hub.com values.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Copernicus Data Space Ecosystem — Statistics API (same request shape as legacy SH). */
const DEFAULT_SH_STATISTICS_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics";
const DEFAULT_SH_TOKEN_URL =
  "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";

function getStatisticsUrl(): string {
  return (
    Deno.env.get("SENTINEL_HUB_STATISTICS_URL") ||
    Deno.env.get("SENTINEL_STATISTICS_URL") ||
    DEFAULT_SH_STATISTICS_URL
  );
}

/** SCL-based cloud/shadow/mask. CDSE Statistics API requires a dataMask output in setup() (see error COMMON_EXCEPTION). */
const EVAL_NDVI = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL"] }],
    output: [
      { id: "default", sampleType: "FLOAT32", bands: 1 },
      { id: "dataMask", sampleType: "UINT8", bands: 1 }
    ],
  };
}
function evaluatePixel(s) {
  var c = s.SCL;
  if (c == 0 || c == 1 || c == 3 || c == 8 || c == 9 || c == 10 || c == 11) {
    return { default: [NaN], dataMask: [0] };
  }
  var d = s.B08 + s.B04;
  if (d == 0) return { default: [NaN], dataMask: [0] };
  return { default: [(s.B08 - s.B04) / d], dataMask: [1] };
}`;

const EVAL_NDMI = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B8A", "B11", "SCL"] }],
    output: [
      { id: "default", sampleType: "FLOAT32", bands: 1 },
      { id: "dataMask", sampleType: "UINT8", bands: 1 }
    ],
  };
}
function evaluatePixel(s) {
  var c = s.SCL;
  if (c == 0 || c == 1 || c == 3 || c == 8 || c == 9 || c == 10 || c == 11) {
    return { default: [NaN], dataMask: [0] };
  }
  var d = s.B8A + s.B11;
  if (d == 0) return { default: [NaN], dataMask: [0] };
  return { default: [(s.B8A - s.B11) / d], dataMask: [1] };
}`;

/** Red-edge NDRE — (B8 − B5) / (B8 + B5), SCL mask. */
const EVAL_NDRE = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B05", "B08", "SCL"] }],
    output: [
      { id: "default", sampleType: "FLOAT32", bands: 1 },
      { id: "dataMask", sampleType: "UINT8", bands: 1 }
    ],
  };
}
function evaluatePixel(s) {
  var c = s.SCL;
  if (c == 0 || c == 1 || c == 3 || c == 8 || c == 9 || c == 10 || c == 11) {
    return { default: [NaN], dataMask: [0] };
  }
  var d = s.B08 + s.B05;
  if (d == 0) return { default: [NaN], dataMask: [0] };
  return { default: [(s.B08 - s.B05) / d], dataMask: [1] };
}`;

type IntervalRow = { from: string; to: string; mean: number | null; stDev?: number | null };

function fail(status: number, message: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ success: false, error: message, ...extra }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function ok(payload: Record<string, unknown>) {
  return new Response(JSON.stringify({ success: true, ...payload }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** Deep search for a numeric "mean" in SH statistics output (structure varies by version). */
function extractBandMean(node: unknown): number | null {
  if (node == null) return null;
  if (typeof node === "object" && !Array.isArray(node)) {
    const o = node as Record<string, unknown>;
    if (typeof o.mean === "number" && Number.isFinite(o.mean)) return o.mean;
    if (o.stats && typeof o.stats === "object") {
      const st = o.stats as { mean?: number };
      if (typeof st.mean === "number" && Number.isFinite(st.mean)) return st.mean;
    }
    for (const v of Object.values(o)) {
      const m = extractBandMean(v);
      if (m != null) return m;
    }
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      const m = extractBandMean(v);
      if (m != null) return m;
    }
  }
  return null;
}

function parseStatisticsIntervals(json: unknown): IntervalRow[] {
  const out: IntervalRow[] = [];
  const root = json as { data?: unknown[]; results?: unknown[]; aggregations?: unknown[] };
  const data = root?.data ?? root?.results ?? root?.aggregations;
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    const row = item as { interval?: { from?: string; to?: string }; outputs?: unknown };
    const from = String(row?.interval?.from ?? "");
    const to = String(row?.interval?.to ?? "");
    const mean = extractBandMean(row?.outputs) ?? null;
    out.push({ from, to, mean: mean != null && Number.isFinite(mean) ? mean : null });
  }
  return out;
}

function normalizeRing(coords: number[][]): number[][] {
  if (coords.length < 4) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return coords;
  return [...coords, [...first]];
}

function geoToPolygonGeometry(geo: unknown): { type: "Polygon"; coordinates: number[][][] } {
  if (!geo || typeof geo !== "object") throw new Error("Invalid geometry from database");
  const g = geo as { type?: string; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    const rings = (g.coordinates as number[][][]).map((r) => normalizeRing(r));
    return { type: "Polygon", coordinates: rings };
  }
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates) && (g.coordinates as number[][][][]).length > 0) {
    const first = (g.coordinates as number[][][][])[0];
    if (Array.isArray(first) && first.length) {
      const rings = (first as number[][][]).map((r) => normalizeRing(r as number[][]));
      return { type: "Polygon", coordinates: rings };
    }
  }
  throw new Error("Block geometry must be Polygon (or first part of MultiPolygon).");
}

async function getShAccessToken(
  clientId: string,
  clientSecret: string,
  tokenUrl: string
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Sentinel token ${res.status}: ${text.slice(0, 400)}`);
  }
  const j = JSON.parse(text) as { access_token?: string };
  if (!j.access_token) throw new Error("No access_token in Sentinel response");
  return j.access_token;
}

async function postStatistics(
  accessToken: string,
  geometry: { type: "Polygon"; coordinates: number[][][] },
  timeFrom: string,
  timeTo: string,
  evalscript: string,
  aggInterval: string
): Promise<unknown> {
  const body = {
    input: {
      bounds: {
        properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
        geometry: {
          type: "Polygon" as const,
          coordinates: geometry.coordinates,
        },
      },
      data: [
        {
          type: "sentinel-2-l2a",
          dataFilter: { maxCloudCoverage: 60 },
        },
      ],
    },
    aggregation: {
      timeRange: { from: timeFrom, to: timeTo },
      aggregationInterval: { of: aggInterval },
      width: 512,
      height: 512,
      evalscript: evalscript,
    },
  };
  // No "calculations" key: default statistics only (see CDSE Statistical API examples without calculations).
  const res = await fetch(getStatisticsUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Statistics ${res.status}: ${text.slice(0, 800)}`);
  }
  return JSON.parse(text) as unknown;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") {
    return fail(405, "Method not allowed");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !anonKey) {
    return fail(500, "Server missing Supabase env");
  }
  if (!authHeader) {
    return fail(401, "Missing Authorization");
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: uData, error: uErr } = await supabase.auth.getUser();
  if (uErr || !uData?.user) {
    return fail(401, "Invalid or expired session");
  }

  let payload: { block_id?: string; date_from?: string; date_to?: string; interval?: string };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return fail(400, "Invalid JSON");
  }
  const blockId = String(payload.block_id || "").trim();
  const dateFrom = String(payload.date_from || "").trim();
  const dateTo = String(payload.date_to || "").trim();
  const interval = (payload.interval || "P16D") as string;

  if (!blockId || !dateFrom || !dateTo) {
    return fail(400, "block_id, date_from, and date_to are required (ISO 8601 dates)");
  }

  const tFrom = dateFrom.includes("T") ? dateFrom : `${dateFrom}T00:00:00.000Z`;
  const tTo = dateTo.includes("T") ? dateTo : `${dateTo}T23:59:59.000Z`;

  const { data: meta, error: metaErr } = await supabase
    .from("vsl_blocks")
    .select("id, block_code, block_name")
    .eq("id", blockId)
    .maybeSingle();
  if (metaErr) {
    return fail(500, `Database: ${metaErr.message}`);
  }
  if (!meta) {
    return fail(400, "Block not found, or your account cannot read it (RLS). Sign in with a user that can read vsl_blocks.");
  }

  let rawGeom: unknown = null;

  const { data: geoRpc, error: rpcErr } = await supabase.rpc("vsl_block_geojson_for_stats", {
    p_block_id: blockId,
  });
  if (rpcErr) {
    if (String(rpcErr.message || "").includes("function") && String(rpcErr.message || "").includes("does not exist")) {
      return fail(
        500,
        "Run sql/010_vsl_block_geojson_for_stats.sql in the Supabase SQL editor (GeoJSON helper for block geometry)."
      );
    }
    return fail(500, `RPC vsl_block_geojson_for_stats: ${rpcErr.message}`);
  }
  if (geoRpc && typeof geoRpc === "object" && "type" in (geoRpc as object)) {
    rawGeom = geoRpc;
  }

  if (rawGeom == null) {
    const { data: rowG, error: gErr } = await supabase
      .from("vsl_blocks")
      .select("geom")
      .eq("id", blockId)
      .maybeSingle();
    if (gErr) {
      return fail(500, gErr.message);
    }
    const g = (rowG as { geom?: unknown })?.geom;
    if (g != null) {
      if (typeof g === "string") {
        try {
          rawGeom = JSON.parse(g);
        } catch {
          return fail(
            500,
            "Block geometry could not be read as GeoJSON. Apply sql/010_vsl_block_geojson_for_stats.sql and redeploy."
          );
        }
      } else {
        rawGeom = g;
      }
    }
  }

  if (rawGeom == null) {
    return fail(
      400,
      "This block has no saved polygon (geom is null). Draw the block boundary on the map and save before running the report."
    );
  }

  let geometry: { type: "Polygon"; coordinates: number[][][] };
  try {
    geometry = geoToPolygonGeometry(rawGeom);
  } catch (e) {
    return fail(400, (e as Error).message);
  }

  const clientId = Deno.env.get("SENTINEL_HUB_CLIENT_ID");
  const clientSecret = Deno.env.get("SENTINEL_HUB_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return fail(500, "SENTINEL_HUB_CLIENT_ID / SENTINEL_HUB_CLIENT_SECRET are not set on the function");
  }
  const tokenUrl = Deno.env.get("SENTINEL_HUB_TOKEN_URL") || DEFAULT_SH_TOKEN_URL;

  let accessToken: string;
  try {
    accessToken = await getShAccessToken(clientId, clientSecret, tokenUrl);
  } catch (e) {
    return fail(502, (e as Error).message);
  }

  let ndviJson: unknown;
  let ndmiJson: unknown;
  let ndreJson: unknown;
  try {
    [ndviJson, ndmiJson, ndreJson] = await Promise.all([
      postStatistics(accessToken, geometry, tFrom, tTo, EVAL_NDVI, interval),
      postStatistics(accessToken, geometry, tFrom, tTo, EVAL_NDMI, interval),
      postStatistics(accessToken, geometry, tFrom, tTo, EVAL_NDRE, interval),
    ]);
  } catch (e) {
    return fail(502, (e as Error).message);
  }

  const ndvi = parseStatisticsIntervals(ndviJson);
  const ndmi = parseStatisticsIntervals(ndmiJson);
  const ndre = parseStatisticsIntervals(ndreJson);

  return ok({
    block: {
      id: meta.id,
      block_code: meta.block_code,
      block_name: meta.block_name,
    },
    interval: interval,
    time_range: { from: tFrom, to: tTo },
    ndvi_intervals: ndvi,
    ndre_intervals: ndre,
    ndmi_intervals: ndmi,
  });
});
