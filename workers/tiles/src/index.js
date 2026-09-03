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
 *
 * Identity, CORS and object streaming live in ../../shared/auth.js, shared
 * with the field-media worker so there is exactly one copy of the token
 * check in this repository.
 *
 * Field photos and videos are NOT handled here. They are a different bucket
 * (vsl-farms-media) behind a different worker (workers/media) on its own
 * domain, because they are a different kind of thing with different rules:
 * imagery is written by ADMIN/SURVEYOR only, a field photo by anyone
 * signed in.
 */
import { requireUser, requireRole, cors, json, plain, serveObject } from "../../shared/auth.js";

const PREFIX = "orthos/";
const MARKER = "group.json";


const WRITE_ROLES = new Set(["ADMIN", "SURVEYOR"]);

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
    const gate = await requireUser(request, env);
    if (gate.error) return gate.error;
    return serveObject(decodeURIComponent(path.slice("/tiles/".length)), request, env.TILES, PREFIX);
  }

  // ── Listing what exists ────────────────────────────────────────────────
  if (path === "/api/groups" && method === "GET") {
    const gate = await requireUser(request, env);
    if (gate.error) return gate.error;
    return json(await listGroups(env), 200);
  }

  // Everything below changes the bucket, so it needs a writer.
  const writer = await requireRole(
    request, env, WRITE_ROLES, "Your account cannot change drone imagery"
  );
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

