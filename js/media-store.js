/**
 * media-store.js — field photos and videos for logged activities and alerts.
 *
 * Files live in the Cloudflare R2 bucket `vsl-farms-media`, behind their own
 * Worker at farmsmedia.victoriasugar.ug (workers/media/src/index.js) —
 * separate from the drone imagery, which is a different bucket, worker and
 * domain. Nothing here is public: every read carries the signed-in user's
 * Supabase token and the Worker refuses anonymous requests, so there is no
 * public bucket URL to leak.
 *
 * The whole domain is media, so the object key IS the URL path.
 *
 * Bucket layout — the Worker validates this shape on every write:
 *
 *     photos/<entity>/<entityId>/<uuid>.<ext>
 *     videos/<entity>/<entityId>/<uuid>.<ext>
 *
 * The database side stays vsl_media, which already carries
 * entity_type/entity_id and is what the dashboard's Documents & Media tab
 * lists. `file_url` holds the full Worker URL, so the column keeps meaning
 * "a URL" — the same as the older rows pointing at public Supabase Storage.
 * isPrivateMediaUrl() is what tells the two apart at display time, so those
 * older rows keep rendering exactly as they always did.
 *
 * ── Why one upload but several rows ──
 * Logging an activity on a BLOCK writes one vsl_activities row per plot in
 * that block (see saveLogActivityForm in js/map-app.js), and an alert does
 * the same. A photo of that work belongs to all of them. Uploading it once
 * and inserting one vsl_media row per record keeps a single copy of the
 * bytes while still letting every record show its own evidence.
 */

import { getConfig } from "./supabase-client.js";

const cfg = getConfig();

/** Matches the Worker's own MEDIA_CONTENT_TYPES — keep the two in step. */
const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  "video/mp4", "video/quicktime", "video/webm"
]);

/** Matches the Worker's MEDIA_MAX_BYTES. Checked here too so an oversized
 *  file is rejected before it is sent, rather than after the upload. */
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/** What the file input should offer. */
export const MEDIA_ACCEPT = ".jpg,.jpeg,.png,.webp,.heic,.heif,.mp4,.mov,.webm,image/*,video/*";

function mediaBase() {
  return String(cfg.MEDIA_API_BASE || "").replace(/\/$/, "");
}

/** Every private media URL starts with this. The whole domain is media, so
 *  the key IS the path — there is no /media/ segment to add or strip. */
function mediaUrlPrefix() {
  return `${mediaBase()}/`;
}

/**
 * True for a URL this module has to fetch WITH a token.
 *
 * Old rows in vsl_media point at public Supabase Storage and must keep
 * working untouched, so display code asks this rather than assuming.
 */
export function isPrivateMediaUrl(url) {
  const base = mediaBase();
  // An unset MEDIA_API_BASE would make the prefix a bare "/", which must
  // not be allowed to match anything — so the base is checked first.
  if (!base || !url) return false;
  return String(url).startsWith(`${base}/`);
}

/** "photos" or "videos" — decides the top-level folder. */
function folderFor(file) {
  return String(file?.type || "").startsWith("video/") ? "videos" : "photos";
}

/** vsl_media.media_type, matching what the dashboard already stores. */
function mediaTypeFor(file) {
  return String(file?.type || "").startsWith("video/") ? "video" : "photo";
}

/**
 * File extension, normalised and always present.
 *
 * Taken from the NAME rather than the MIME type because a phone can report
 * image/jpeg for a .heic, and the extension is what a person downloading the
 * file later will rely on. Falls back to a type-derived default when the
 * name has no usable extension at all.
 */
function extensionFor(file) {
  const fromName = String(file?.name || "").split(".").pop() || "";
  const clean = fromName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (clean && clean.length <= 8) return clean;
  return String(file?.type || "").startsWith("video/") ? "mp4" : "jpg";
}

/** Rejects a file before any network call. Returns an error string or "". */
export function mediaFileError(file) {
  if (!file) return "No file chosen.";
  if (!file.size) return `${file.name || "That file"} is empty.`;
  if (file.size > MEDIA_MAX_BYTES) {
    return `${file.name || "That file"} is larger than ${Math.round(MEDIA_MAX_BYTES / 1048576)}MB.`;
  }
  // Some browsers report an empty type for HEIC; fall back to the extension
  // so a valid phone photo isn't rejected over a missing MIME string.
  const type = String(file.type || "").toLowerCase();
  if (type && !ALLOWED_TYPES.has(type)) {
    return `${file.name || "That file"} is not a supported photo or video.`;
  }
  if (!type) {
    const ext = extensionFor(file);
    if (!["jpg", "jpeg", "png", "webp", "heic", "heif", "mp4", "mov", "webm"].includes(ext)) {
      return `${file.name || "That file"} is not a supported photo or video.`;
    }
  }
  return "";
}

/** The caller's Supabase access token, or "" when signed out. */
async function accessToken(supabase) {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || "";
}

/**
 * Uploads one file and returns { key, url, mediaType, sizeBytes }.
 *
 * Does NOT touch the database — attachMediaToRecords() below does that, so
 * an upload can be reused across several records.
 */
export async function uploadMediaFile(supabase, file, { entityType, entityId }) {
  const base = mediaBase();
  if (!base) throw new Error("MEDIA_API_BASE is not set in config/app-config.js");

  const problem = mediaFileError(file);
  if (problem) throw new Error(problem);

  const key = `${folderFor(file)}/${entityType}/${entityId}/${crypto.randomUUID()}.${extensionFor(file)}`;
  const token = await accessToken(supabase);
  if (!token) throw new Error("Sign in to attach photos.");

  const response = await fetch(`${base}/api/upload?key=${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      // The Worker checks this against its own whitelist, so send a usable
      // default when the browser couldn't work one out.
      "Content-Type": file.type || "image/jpeg"
    },
    body: file
  });
  if (!response.ok) {
    throw new Error((await response.text()) || `Upload failed (${response.status})`);
  }

  return {
    key,
    url: `${base}/${key}`,
    mediaType: mediaTypeFor(file),
    sizeBytes: file.size
  };
}

/** Best-effort removal of an object that was uploaded but never referenced. */
async function deleteMediaObject(supabase, key) {
  try {
    const token = await accessToken(supabase);
    await fetch(`${mediaBase()}/api/upload?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (error) {
    console.warn("[Victoria Media] Could not clean up", key, error);
  }
}

/**
 * Uploads each file once, then links it to every record id given.
 *
 * `recordIds` is a list because one logged activity or alert can span many
 * plots (one row each) — see the note at the top of this file.
 *
 * If the vsl_media insert fails, the objects just uploaded are deleted
 * again: a file in the bucket that nothing references is invisible to the
 * app and would never be cleaned up otherwise.
 *
 * Returns { attached, failures[] }. Never throws — attaching a photo must
 * not lose an activity that has already been written.
 */
export async function attachMediaToRecords(supabase, files, { entityType, recordIds, capturedBy }) {
  const list = Array.from(files || []);
  const ids = (recordIds || []).map(String).filter(Boolean);
  if (!list.length || !ids.length) return { attached: 0, failures: [] };

  const failures = [];
  const uploaded = [];

  for (const file of list) {
    try {
      // Keyed by the FIRST record id. The bytes are shared by every row, so
      // the folder is just where the file lives, not a claim of ownership —
      // vsl_media rows are what actually link a file to a record.
      uploaded.push(await uploadMediaFile(supabase, file, { entityType, entityId: ids[0] }));
    } catch (error) {
      failures.push(`${file.name || "A file"}: ${error.message}`);
    }
  }
  if (!uploaded.length) return { attached: 0, failures };

  const rows = [];
  for (const id of ids) {
    for (const item of uploaded) {
      rows.push({
        entity_type: entityType,
        entity_id: id,
        media_type: item.mediaType,
        file_url: item.url,
        captured_at: new Date().toISOString(),
        captured_by: capturedBy || null
      });
    }
  }

  const { error } = await supabase.from("vsl_media").insert(rows);
  if (error) {
    await Promise.all(uploaded.map((item) => deleteMediaObject(supabase, item.key)));
    failures.push(`Could not save the attachment record: ${error.message}`);
    return { attached: 0, failures };
  }

  return { attached: uploaded.length, failures };
}

/**
 * Turns a stored file_url into something an <img>/<video> can use.
 *
 * A public (legacy Supabase Storage) URL is returned unchanged. A private
 * Worker URL is fetched with the caller's token and handed back as a blob
 * URL — which the caller MUST release with releaseMediaUrl() once the
 * element is gone, or the bytes stay in memory for the life of the page.
 */
export async function resolveMediaUrl(supabase, fileUrl) {
  if (!isPrivateMediaUrl(fileUrl)) return { url: fileUrl, revoke: false };

  const token = await accessToken(supabase);
  const response = await fetch(fileUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) throw new Error(`Could not load media (${response.status})`);
  return { url: URL.createObjectURL(await response.blob()), revoke: true };
}

/** Counterpart to resolveMediaUrl — safe to call with either kind. */
export function releaseMediaUrl(resolved) {
  if (resolved?.revoke && resolved.url) URL.revokeObjectURL(resolved.url);
}
