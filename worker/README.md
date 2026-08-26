# vsl-tiles Worker

Serves and receives the drone orthomosaic archives (`.pmtiles`) held in
Cloudflare R2.

## There are no secrets in here

R2 is reached through a **binding**, not an access key. Cloudflare grants this
Worker access to the bucket internally, so:

- nothing sensitive is in `wrangler.toml`
- nothing sensitive is in the source
- there is no key to leak, and none to rotate

The two Supabase values in `[vars]` are public by design. The **publishable**
key is meant to be shipped in browsers — row level security protects the data.
The `service_role` key is not used here and must never be added.

## Deploy

```bash
cd worker
npx wrangler login          # opens a browser; this has to be you
npx wrangler deploy
```

Before the first deploy, check `bucket_name` in `wrangler.toml` matches the
bucket exactly as it appears in the R2 dashboard. **R2 bucket names allow
lowercase letters, numbers and hyphens only** — an underscore will not deploy.

To try it on the throwaway `*.workers.dev` URL first, comment out the
`[[routes]]` block at the bottom, deploy, and test against the URL wrangler
prints. Put the block back when you're ready to move to
`tiles.victoriasugar.ug`.

## Bucket layout

```
orthos/<folder>/group.json        survey title + description
orthos/<folder>/<Site>.pmtiles    one sealed archive per site
```

`group.json` is what makes an empty survey exist — R2 has no real folders, a
prefix only exists because an object uses it. It also keeps the bucket
self-describing: if the database were ever lost, every survey's name and
description could be read back out of the bucket.

A folder created by hand in the R2 dashboard still appears in the app, using
its folder name as the title.

## Endpoints

Every route needs a Supabase access token as `Authorization: Bearer <token>`.
Anything that changes the bucket also requires the `ADMIN` or `SURVEYOR` role.

| Route | Purpose |
|---|---|
| `GET /tiles/orthos/<folder>/<Site>.pmtiles` | archive bytes, honours `Range` |
| `GET /api/groups` | every survey and the archives inside it |
| `POST /api/groups` | create a survey folder (`folder`, `title`, `description`) |
| `DELETE /api/groups/<folder>` | delete a survey and everything in it |
| `DELETE /api/objects?key=…` | delete one archive |
| `POST /api/uploads` | begin a multipart upload |
| `PUT /api/uploads/part?key=…&uploadId=…&part=N` | send one chunk |
| `POST /api/uploads/complete` | finish it |
| `POST /api/uploads/abort` | discard a half-finished upload |

Uploads are chunked rather than sent in one request, so an archive can be any
size without running into a request body limit, and a dropped chunk can be
retried without restarting.

## How callers are identified

The Worker asks Supabase whether the token is valid, then reads the caller's
role from `vsl_profiles` **using that same token** — so it stays inside your
row level security rather than bypassing it. Verified tokens are remembered
for five minutes, because PMTiles reads are chatty and re-checking on every
range request would put a round trip in front of every few kilobytes.
