# Cloudflare Workers

Two workers, each in front of its own R2 bucket, sharing one copy of the
Supabase token check.

```
workers/
├── shared/auth.js      authenticate(), requireUser(), requireRole(),
│                       cors(), json(), plain(), serveObject()
│                       — bundled into BOTH workers at deploy time
├── tiles/              vsl-tiles          → tiles.victoriasugar.ug
│   ├── wrangler.toml       drone orthomosaic .pmtiles archives
│   └── src/index.js
└── media/              vsl-farms-media    → farmsmedia.victoriasugar.ug
    ├── wrangler.toml       field photos/videos on activities and alerts
    └── src/index.js
```

## Why two workers, not one

They are different kinds of data with different rules:

| | Drone imagery | Field media |
|---|---|---|
| Bucket | `vsl-tiles` | `vsl-farms-media` |
| Domain | tiles.victoriasugar.ug | farmsmedia.victoriasugar.ug |
| Written by | ADMIN / SURVEYOR | any signed-in user |
| Read as | HTTP range requests into a large archive | a whole small file |
| Size | 50–500MB per archive | under 25MB per file |

Separate workers mean a change to one can never take the other down, the two
authorisation models never get mixed up in one file, and each deploys on its
own. `shared/auth.js` is what stops the duplication that would otherwise come
with that split — a security check that exists twice in source drifts apart
eventually, and the half that gets forgotten is the hole.

## There are no secrets in here

* R2 is reached through a **binding** (`env.TILES`, `env.MEDIA`) that
  Cloudflare wires up internally. No access key exists anywhere in this
  project — nothing to commit by accident, nothing to rotate.
* Callers are identified by the Supabase access token the browser already
  holds, verified by asking Supabase using the **publishable** key, which is
  public by design.
* The `service_role` key is not used by either worker and must never be
  added to a `wrangler.toml`.

Neither `src/index.js` is ever sent to a browser. They run on Cloudflare's
edge; the browser only sends a request and receives a response. Editing a
local copy changes nothing until someone with your Cloudflare login deploys
it.

## Deploying

```bash
cd workers/tiles && npx wrangler deploy     # drone imagery
cd workers/media && npx wrangler deploy     # field photos and videos
```

Each reads its own `wrangler.toml`, bundles `src/index.js` **plus the shared
module it imports**, and replaces that worker atomically — no downtime, and
the other worker is untouched.

Bindings are resolved *before* anything is uploaded, so if a bucket named in
`wrangler.toml` doesn't exist yet the deploy fails and the currently running
version keeps serving.

`npx wrangler rollback` returns a worker to its previous version.

## Bucket layouts

```
vsl-tiles
└── orthos/<folder>/group.json          marker: title + description
    orthos/<folder>/<Site>.pmtiles      one sealed archive per site

vsl-farms-media
├── photos/<entity>/<entityId>/<uuid>.<ext>
└── videos/<entity>/<entityId>/<uuid>.<ext>
        entity ∈ activity | alert | parcel | block | feature
```

`mediaKeyError()` in `media/src/index.js` validates that shape on every
write. It is the only thing standing between a caller and writing wherever
it likes in the bucket, so it rejects `..`, backslashes, leading and doubled
slashes, and anything that isn't exactly four segments deep.

## Routes

**tiles.victoriasugar.ug**

| Route | Who |
|---|---|
| `GET /tiles/<key>` | any signed-in user |
| `GET /api/groups` | any signed-in user |
| `POST /api/groups`, `DELETE /api/groups/<folder>` | ADMIN / SURVEYOR |
| `POST /api/uploads*`, `DELETE /api/objects` | ADMIN / SURVEYOR |

**farmsmedia.victoriasugar.ug**

| Route | Who |
|---|---|
| `GET /<key>` | any signed-in user |
| `PUT /api/upload?key=` | any signed-in user |
| `DELETE /api/upload?key=` | ADMIN / SURVEYOR, or the uploader of that file |

The delete rule is deliberate: the webmap rolls back its own failed uploads
(if the `vsl_media` row insert fails, the object it just wrote is removed),
and that has to work for whoever made the upload — otherwise every failure
would leave an orphan in the bucket.
