/**
 * Victoria Sugar — field media Worker.
 *
 * Sits between the webmap and the R2 bucket `vsl-farms-media`, holding the
 * photos and videos attached to logged activities and alerts.
 *
 * Served from farmsmedia.victoriasugar.ug. Entirely separate from the drone
 * imagery worker (workers/tiles → tiles.victoriasugar.ug → vsl-tiles): a
 * different bucket, a different domain, a different deploy, and different
 * rules about who may write.
 *
 * There are NO SECRETS here.
 *
 *   - R2 is reached through a binding (env.MEDIA) that Cloudflare wires up
 *     internally. No access key, nothing to leak or rotate.
 *   - Callers are identified by the Supabase access token the browser
 *     already holds — see ../../shared/auth.js, shared with the tiles
 *     worker so there is one copy of that check in the repository.
 *
 * ── Who may do what ──
 *   READ    any signed-in user. A photo is part of the record it hangs off,
 *           and everyone who can see the record can see its evidence.
 *   UPLOAD  any signed-in user. Anyone working a plot can photograph what
 *           they find; the database's own RLS decides whether the row
 *           linking it to a record is allowed.
 *   DELETE  ADMIN or SURVEYOR for anything; everyone else only for files
 *           they uploaded themselves (customMetadata.uploaded_by). Removing
 *           evidence is not the same act as adding it — but the webmap has
 *           to be able to roll back its own failed upload, whoever made it.
 *
 * Bucket layout — enforced by mediaKeyError() on every write:
 *     photos/<entity>/<entityId>/<uuid>.<ext>
 *     videos/<entity>/<entityId>/<uuid>.<ext>
 */

import { requireUser, cors, json, plain, serveObject } from "../../shared/auth.js";

/** Top-level folders. Also the two prefixes reads are allowed to touch. */
const MEDIA_FOLDERS = new Set(["photos", "videos"]);

/** What a media key may hang off. Anything else is rejected outright, so a
 *  caller cannot invent a folder tree inside the bucket. */
const MEDIA_ENTITIES = new Set(["activity", "alert", "parcel", "block", "feature"]);

/** Per-file ceiling. Generous for a phone photo, low enough that a mistaken
 *  full-length video fails fast rather than after several minutes. */
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

const MEDIA_CONTENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  "video/mp4", "video/quicktime", "video/webm"
]);

/** Deleting is destructive and irreversible; adding is not. */
const DELETE_ROLES = new Set(["ADMIN", "SURVEYOR"]);

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
      return json({ error: String((error && error.message) || error) }, 500, origin, env);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  // ── Reading ────────────────────────────────────────────────────────────
  // GET /photos/activity/<id>/<uuid>.jpg
  //
  // The key is the path, so the bucket layout and the URL are the same
  // thing — no /media/ prefix to strip, since this whole domain is media.
  if (method === "GET" || method === "HEAD") {
    const key = decodeURIComponent(path.slice(1));
    if (mediaKeyError(key)) return plain("Not found", 404);

    const gate = await requireUser(request, env);
    if (gate.error) return gate.error;

    // A key contains a uuid and the bytes never change under it, so this
    // can be cached hard. `private` keeps it in the browser only — a shared
    // cache must never hold something that required a token to fetch.
    return serveObject(key, request, env.MEDIA, null, "private, max-age=86400, immutable");
  }

  // ── Uploading ──────────────────────────────────────────────────────────
  // PUT /api/upload?key=photos/activity/<id>/<uuid>.jpg   raw body = file
  //
  // Single-shot rather than the multipart flow the .pmtiles archives use: a
  // phone photo fits comfortably in one request, and multipart bookkeeping
  // only earns its keep on hundred-megabyte files.
  if (path === "/api/upload" && method === "PUT") {
    const gate = await requireUser(request, env);
    if (gate.error) return gate.error;

    const key = url.searchParams.get("key") || "";
    const problem = mediaKeyError(key);
    if (problem) return plain(problem, 400);

    const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!MEDIA_CONTENT_TYPES.has(contentType)) {
      return plain(`Unsupported file type: ${contentType || "unknown"}`, 415);
    }

    // Content-Length is advisory — a caller can lie or omit it — so the real
    // ceiling is enforced on the buffered bytes below. Checking the header
    // first only avoids reading 200MB before rejecting it.
    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared && declared > MEDIA_MAX_BYTES) {
      return plain(`File is larger than ${Math.round(MEDIA_MAX_BYTES / 1048576)}MB`, 413);
    }

    const body = await request.arrayBuffer();
    if (body.byteLength > MEDIA_MAX_BYTES) {
      return plain(`File is larger than ${Math.round(MEDIA_MAX_BYTES / 1048576)}MB`, 413);
    }
    if (!body.byteLength) return plain("Empty file", 400);

    // Refuse to overwrite. Keys carry a uuid so a collision means something
    // has gone wrong, and silently replacing evidence would be the worst
    // possible response to it.
    if (await env.MEDIA.head(key)) return plain("That file already exists", 409);

    await env.MEDIA.put(key, body, {
      httpMetadata: { contentType },
      // Who uploaded it, for auditing straight from the bucket without
      // needing to join back to vsl_media.
      customMetadata: { uploaded_by: gate.identity.userId }
    });
    return json({ key, size_bytes: body.byteLength });
  }

  // ── Deleting ───────────────────────────────────────────────────────────
  // DELETE /api/upload?key=…
  //
  // Also used by the webmap to clean up after itself: if the vsl_media row
  // insert fails, the object just uploaded is removed again so the bucket
  // never accumulates files nothing references.
  if (path === "/api/upload" && method === "DELETE") {
    const gate = await requireUser(request, env);
    if (gate.error) return gate.error;

    const key = url.searchParams.get("key") || "";
    if (mediaKeyError(key)) return plain("Not found", 404);

    const object = await env.MEDIA.head(key);
    if (!object) return json({ ok: true });   // already gone; nothing to do

    // ADMIN/SURVEYOR may remove anyone's media. Everyone else may remove
    // only what they uploaded themselves — which is what makes the webmap's
    // own rollback work: when the vsl_media insert fails after an upload,
    // the browser deletes the object it just wrote so the bucket never
    // accumulates files nothing references. Without this the rollback would
    // 403 for a MANAGMENT user and leave an orphan behind every time.
    const owner = object.customMetadata?.uploaded_by;
    const privileged = DELETE_ROLES.has(gate.identity.role);
    if (!privileged && owner !== gate.identity.userId) {
      return plain("Your account cannot delete this file", 403);
    }

    await env.MEDIA.delete(key);
    return json({ ok: true });
  }

  return plain("Not found", 404);
}

/**
 * Validates a media object key, returning an error string or "" if fine.
 *
 * The key comes straight from the browser, so this is the only thing
 * standing between a caller and writing wherever it likes in the bucket.
 * Required shape:
 *
 *     <photos|videos>/<entity>/<entityId>/<name>.<ext>
 *
 * Rejecting "..", backslashes, leading and doubled slashes matters more
 * than the folder whitelist does: R2 keys are opaque strings, so "../" is
 * not special to R2 itself — but a key containing one would still let one
 * entity's media masquerade as another's once the key is parsed.
 */
function mediaKeyError(key) {
  if (!key || typeof key !== "string") return "A key is required";
  if (key.length > 400) return "Key is too long";
  if (key.includes("\\") || key.includes("//") || key.startsWith("/")) return "Malformed key";
  if (key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return "Malformed key";
  }
  const parts = key.split("/");
  if (parts.length !== 4) return "Malformed key";
  const [folder, entity, entityId, name] = parts;
  if (!MEDIA_FOLDERS.has(folder)) return "Unknown media folder";
  if (!MEDIA_ENTITIES.has(entity)) return "Unknown entity type";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(entityId)) return "Malformed entity id";
  if (!/^[A-Za-z0-9._-]{1,120}\.[A-Za-z0-9]{1,8}$/.test(name)) return "Malformed file name";
  return "";
}
