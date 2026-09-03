/**
 * Shared Worker helpers — Supabase identity, CORS and response shaping.
 *
 * Imported by BOTH workers in this folder:
 *
 *     workers/tiles/src/index.js   → tiles.victoriasugar.ug      (vsl-tiles)
 *     workers/media/src/index.js   → farmsmedia.victoriasugar.ug (vsl-farms-media)
 *
 * Wrangler bundles this file into each worker at deploy time, so there is
 * one copy of the token check in the repository and two copies at the edge.
 * That is the point: a security check that exists twice in source drifts
 * apart eventually, and the half that gets forgotten is the hole.
 *
 * There are NO SECRETS here. Callers are identified by the Supabase access
 * token the browser already holds, verified by asking Supabase using the
 * publishable key, which is public by design. The service_role key is never
 * used by either worker.
 *
 * NOTE ON AUTHORISATION: this module answers "who is this?", never "may
 * they?". Each worker decides that for itself, because the answers differ —
 * changing drone imagery is ADMIN/SURVEYOR only, while attaching a photo to
 * a logged activity is open to any signed-in user. Keeping the policy out of
 * here is what stops one worker's rules quietly becoming the other's.
 */

/** How long a verified token is trusted before it is re-checked with
 *  Supabase. Reads can be chatty — a PMTiles range request fetches a few
 *  kilobytes — and re-validating each one would put a round trip in front
 *  of every fetch. */
export const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Verified tokens, per isolate. Cleared whenever the isolate recycles,
 *  which is the failure mode we want: forget too often, never too rarely. */
const tokenCache = new Map();

/**
 * Resolves the caller to { userId, email, role }, or null when the token is
 * missing or rejected.
 *
 * Supabase is asked directly rather than the JWT being verified locally.
 * That costs a round trip on a cache miss, but it needs no signing secret
 * and works the same whether the project issues symmetric or asymmetric
 * tokens.
 */
export async function authenticate(request, env) {
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
    // Cached briefly too, so a page looping on an expired token doesn't
    // hammer Supabase with the same rejection.
    tokenCache.set(token, { identity: null, expires: Date.now() + 30_000 });
    return null;
  }
  const user = await userResponse.json();

  // Role lives in vsl_profiles. Read with the caller's OWN token, so this
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

/**
 * Any signed-in user. Returns { identity } or { error }.
 *
 * The caller writes `if (gate.error) return gate.error;` — a shape that
 * makes forgetting the check look wrong at a glance, unlike a boolean.
 */
export async function requireUser(request, env) {
  const identity = await authenticate(request, env);
  if (!identity) return { error: plain("Sign in required", 401) };
  return { identity };
}

/**
 * A signed-in user holding one of `roles`.
 *
 * `roles` is passed in rather than baked in because the two workers guard
 * different things — see the note at the top of this file.
 */
export async function requireRole(request, env, roles, message = "Your account cannot do that") {
  const identity = await authenticate(request, env);
  if (!identity) return { error: plain("Sign in required", 401) };
  if (!roles.has(identity.role)) return { error: plain(message, 403) };
  return { identity };
}

/**
 * CORS headers for a request's Origin.
 *
 * Falls back to the FIRST entry of ALLOWED_ORIGINS for an unlisted origin,
 * rather than echoing whatever arrived — echoing would make the allowlist
 * decorative.
 */
export function cors(origin, env) {
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

export function json(body, status = 200, origin, env) {
  const headers = { "Content-Type": "application/json" };
  if (origin !== undefined) Object.assign(headers, cors(origin, env));
  return new Response(JSON.stringify(body), { status, headers });
}

export function plain(message, status) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain" } });
}

/**
 * Streams one R2 object, honouring Range.
 *
 * The bucket is a parameter because both workers serve bytes identically —
 * the only differences are which binding holds them and which keys are
 * allowed, and letting a caller read outside its own prefix is exactly what
 * `allowedPrefix` prevents. Pass null when the caller has already validated
 * the key some other way.
 */
export async function serveObject(key, request, bucket, allowedPrefix, cacheControl = "private, max-age=300") {
  if (allowedPrefix && !key.startsWith(allowedPrefix)) return plain("Not found", 404);

  const range = request.headers.get("Range");
  const object = await bucket.get(key, range ? { range: request.headers } : undefined);
  if (!object) return plain("Not found", 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", cacheControl);

  if (object.range && typeof object.range.offset === "number") {
    const start = object.range.offset;
    const end = start + object.range.length - 1;
    headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
    return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}
