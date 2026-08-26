/**
 * Victoria Sugar — drone tile Worker.
 *
 * Sits between the webmap and the R2 bucket holding drone orthomosaic
 * archives. It does two jobs:
 *
 *   1. Serves .pmtiles bytes to signed-in users. PMTiles is read with HTTP
 *      range requests, so most calls here ask for a few kilobytes out of the
 *      middle of a large file.
 *   2. Accepts uploads from surveyors and admins, and lists/creates/deletes
 *      the survey folders.
 *
 * There are NO SECRETS in this Worker.
 *
 *   - R2 is reached through a binding (env.TILES), which Cloudflare wires up
 *     internally. No access key, nothing to leak or rotate.
 *   - Callers are identified by the Supabase access token the browser already
 *     holds. We verify it by asking Supabase, using the publishable key, which
 *     is public by design. The service_role key is never used here.
 *
 * Bucket layout:
 *     orthos/<folder>/group.json      marker + description for one survey
 *     orthos/<folder>/<Site>.pmtiles  one sealed archive per site
 */

const PREFIX = "orthos/";
const MARKER = "group.json";

// How long a verified token is trusted before we re-check it with Supabase.
// Tile reads are chatty, and re-validating every range request would put a
// round trip in front of every few kilobytes of imagery.
const TOKEN_TTL_MS = 5 * 60 * 1000;

const WRITE_ROLES = new Set(["ADMIN", "SURVEYOR"]);

// Verified tokens, kept per isolate. Cleared whenever the isolate recycles,
// which is the failure mode we want: forget too often, never too rarely.
const tokenCache = new Map();

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin, env) });
    }

    try {
      const response = await route(request, env, ctx);
      for (const [key, value] of Object.entries(cors(origin, env))) {
        response.headers.set(key, value);
      }
      return response;
    } catch (error) {
      return json({ error: String(error && error.message || error) }, 500, origin, env);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  // ── Reading tiles ──────────────────────────────────────────────────────
  // GET /tiles/orthos/<folder>/<Site>.pmtiles  (Range honoured)
  if (path.startsWith("/tiles/")) {
    if (method !== "GET" && method !== "HEAD") return plain("Method not allowed", 405);
    const identity = await authenticate(request, env, ctx);
    if (!identity) return plain("Sign in required", 401);
    return serveObject(decodeURIComponent(path.slice("/tiles/".length)), request, env);
  }

  // ── Listing what exists ────────────────────────────────────────────────
  if (path === "/api/groups" && method === "GET") {
    const identity = await authenticate(request, env, ctx);
    if (!identity) return plain("Sign in required", 401);
    return json(await listGroups(env), 200);
  }

  // Everything below changes the bucket, so it needs a writer.
  const writer = await requireWriter(request, env, ctx);
  if (writer.error) return writer.error;

  // POST /api/groups            { folder, title, description }
  if (path === "/api/groups" && method === "POST") {
    const body = await readJson(request);
    const folder = cleanFolder(body.folder);
    if (!folder) return plain("A folder name is required", 400);

    const key = `${PREFIX}${folder}/${MARKER}`;
    if (await env.TILES.head(key)) return plain("That survey already exists", 409);

    // R2 has no real folders — a prefix exists only because an object uses
    // it. This marker is what makes an empty survey exist at all, and it
    // keeps the bucket self-describing: title and description live beside
    // the imagery rather than only in the database.
    const marker = {
      folder,
      title: String(body.title || folder).slice(0, 200),
      description: String(body.description || "").slice(0, 2000),
      created_at: new Date().toISOString(),
      created_by: writer.identity.userId,
    };
    await env.TILES.put(key, JSON.stringify(marker, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    return json(marker, 201);
  }

  // DELETE /api/groups/<folder>  — removes the folder and everything in it
  if (path.startsWith("/api/groups/") && method === "DELETE") {
    const folder = cleanFolder(decodeURIComponent(path.slice("/api/groups/".length)));
    if (!folder) return plain("Bad folder name", 400);

    const keys = [];
    let cursor;
    do {
      const page = await env.TILES.list({ prefix: `${PREFIX}${folder}/`, cursor });
      page.objects.forEach((object) => keys.push(object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    if (!keys.length) return plain("No such survey", 404);
    // delete() takes at most 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      await env.TILES.delete(keys.slice(i, i + 1000));
    }
    return json({ folder, deleted: keys.length });
  }

  // DELETE /api/objects?key=orthos/<folder>/<Site>.pmtiles  — one archive
  if (path === "/api/objects" && method === "DELETE") {
    const key = url.searchParams.get("key") || "";
    if (!isArchiveKey(key)) return plain("Bad key", 400);
    await env.TILES.delete(key);
    return json({ key, deleted: true });
  }

  // ── Uploading ──────────────────────────────────────────────────────────
  // Uploads run as multipart: the browser slices the file and sends each
  // part as its own short request. That keeps every request well inside the
  // Worker's body limit however large the archive grows, and lets a failed
  // part be retried without restarting the whole upload.

  // POST /api/uploads            { key }            -> { uploadId }
  if (path === "/api/uploads" && method === "POST") {
    const body = await readJson(request);
    const key = body.key || "";
    if (!isArchiveKey(key)) return plain("Bad key", 400);
    const upload = await env.TILES.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    return json({ key, uploadId: upload.uploadId });
  }

  // PUT /api/uploads/part?key=..&uploadId=..&part=N  body = chunk
  if (path === "/api/uploads/part" && method === "PUT") {
    const key = url.searchParams.get("key") || "";
    const uploadId = url.searchParams.get("uploadId") || "";
    const partNumber = Number(url.searchParams.get("part"));
    if (!isArchiveKey(key) || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
      return plain("Bad part request", 400);
    }
    const upload = env.TILES.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  }

  // POST /api/uploads/complete   { key, uploadId, parts:[{partNumber,etag}] }
  if (path === "/api/uploads/complete" && method === "POST") {
    const body = await readJson(request);
    const { key, uploadId, parts } = body;
    if (!isArchiveKey(key) || !uploadId || !Array.isArray(parts) || !parts.length) {
      return plain("Bad completion request", 400);
    }
    const upload = env.TILES.resumeMultipartUpload(key, uploadId);
    const object = await upload.complete(
      parts
        .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
        .sort((a, b) => a.partNumber - b.partNumber)
    );
    return json({ key, size: object.size, etag: object.etag });
  }

  // POST /api/uploads/abort      { key, uploadId }
  if (path === "/api/uploads/abort" && method === "POST") {
    const body = await readJson(request);
    if (!isArchiveKey(body.key) || !body.uploadId) return plain("Bad abort request", 400);
    await env.TILES.resumeMultipartUpload(body.key, body.uploadId).abort();
    return json({ aborted: true });
  }

  return plain("Not found", 404);
}

// ----------------------------------------------------------------------
// Bucket reads
// ----------------------------------------------------------------------

async function listGroups(env) {
  const groups = new Map();

  let cursor;
  do {
    const page = await env.TILES.list({ prefix: PREFIX, cursor, include: ["httpMetadata"] });
    for (const object of page.objects) {
      const rest = object.key.slice(PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash < 1) continue;

      const folder = rest.slice(0, slash);
      const name = rest.slice(slash + 1);
      if (!groups.has(folder)) {
        groups.set(folder, { folder, title: folder, description: "", layers: [] });
      }
      if (name === MARKER) continue;          // read separately below
      if (!name.toLowerCase().endsWith(".pmtiles")) continue;

      groups.get(folder).layers.push({
        key: object.key,
        file_name: name,
        site_name: name.replace(/\.pmtiles$/i, ""),
        size_bytes: object.size,
        uploaded_at: object.uploaded,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Fold in each marker's title/description. Done after the listing so a
  // survey with no marker (a folder created by hand in the dashboard) still
  // shows up, just using its folder name as the title.
  await Promise.all(
    [...groups.values()].map(async (group) => {
      const object = await env.TILES.get(`${PREFIX}${group.folder}/${MARKER}`);
      if (!object) return;
      try {
        const marker = JSON.parse(await object.text());
        group.title = marker.title || group.folder;
        group.description = marker.description || "";
        group.created_at = marker.created_at;
      } catch {
        /* a corrupt marker should never hide the imagery beside it */
      }
    })
  );

  const list = [...groups.values()];
  list.forEach((g) => g.layers.sort((a, b) => a.site_name.localeCompare(b.site_name)));
  list.sort((a, b) => b.folder.localeCompare(a.folder));
  return { groups: list };
}

async function serveObject(key, request, env) {
  if (!key.startsWith(PREFIX)) return plain("Not found", 404);

  const range = request.headers.get("Range");
  const object = await env.TILES.get(key, range ? { range: request.headers } : undefined);
  if (!object) return plain("Not found", 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  // Archives are immutable once published, but a site can be replaced under
  // the same name, so this is a short cache rather than a permanent one.
  headers.set("Cache-Control", "private, max-age=300");

  if (object.range && typeof object.range.offset === "number") {
    const start = object.range.offset;
    const end = start + object.range.length - 1;
    headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
    return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

// ----------------------------------------------------------------------
// Who is calling
// ----------------------------------------------------------------------

/**
 * Verify the caller's Supabase access token and read their role.
 *
 * Supabase is asked directly rather than the JWT being verified locally.
 * That costs a round trip on a cache miss, but it needs no signing secret
 * and works the same whether the project issues symmetric or asymmetric
 * tokens. Results are cached for TOKEN_TTL_MS.
 */
async function authenticate(request, env, ctx) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;

  const cached = tokenCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.identity;

  const base = env.SUPABASE_URL;
  const apikey = env.SUPABASE_ANON_KEY;
  if (!base || !apikey) throw new Error("Worker is missing SUPABASE_URL / SUPABASE_ANON_KEY");

  const auth = { apikey, Authorization: `Bearer ${token}` };

  const userResponse = await fetch(`${base}/auth/v1/user`, { headers: auth });
  if (!userResponse.ok) {
    tokenCache.set(token, { identity: null, expires: Date.now() + 30_000 });
    return null;
  }
  const user = await userResponse.json();

  // Role lives in vsl_profiles. Read with the caller's own token, so this
  // stays inside their row-level security rather than bypassing it.
  let role = null;
  const profileResponse = await fetch(
    `${base}/rest/v1/vsl_profiles?id=eq.${encodeURIComponent(user.id)}&select=role`,
    { headers: auth }
  );
  if (profileResponse.ok) {
    const rows = await profileResponse.json();
    role = rows && rows[0] ? rows[0].role : null;
  }

  const identity = { userId: user.id, email: user.email || "", role };
  tokenCache.set(token, { identity, expires: Date.now() + TOKEN_TTL_MS });

  // Keep the cache from growing without bound in a long-lived isolate.
  if (tokenCache.size > 500) {
    for (const [key, value] of tokenCache) {
      if (value.expires <= Date.now()) tokenCache.delete(key);
    }
  }
  return identity;
}

async function requireWriter(request, env, ctx) {
  const identity = await authenticate(request, env, ctx);
  if (!identity) return { error: plain("Sign in required", 401) };
  if (!WRITE_ROLES.has(identity.role)) {
    return { error: plain("Your account cannot change drone imagery", 403) };
  }
  return { identity };
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

/** Folder names are used as bucket keys, so keep them boring and flat. */
function cleanFolder(value) {
  const folder = String(value || "").trim();
  if (!folder || folder.length > 100) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(folder)) return "";
  if (folder.includes("..")) return "";
  return folder;
}

function isArchiveKey(value) {
  const key = String(value || "");
  if (!key.startsWith(PREFIX) || key.includes("..")) return false;
  const rest = key.slice(PREFIX.length).split("/");
  if (rest.length !== 2) return false;
  return cleanFolder(rest[0]) === rest[0] && /^[A-Za-z0-9][A-Za-z0-9 _.-]*\.pmtiles$/i.test(rest[1]);
}

async function readJson(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

function cors(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allow = allowed.includes(origin) ? origin : allowed[0] || "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,HEAD,PUT,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Range",
    "Access-Control-Expose-Headers": "Content-Range,Content-Length,ETag,Accept-Ranges",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status = 200, origin, env) {
  const headers = { "Content-Type": "application/json" };
  if (origin !== undefined) Object.assign(headers, cors(origin, env));
  return new Response(JSON.stringify(body), { status, headers });
}

function plain(message, status) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain" } });
}
