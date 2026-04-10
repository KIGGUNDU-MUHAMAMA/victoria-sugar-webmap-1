# Victoria Sugar Webmap

OpenLayers + Supabase web mapping application for Victoria Sugar Limited.

## Features

- Isolated authentication and data model for Victoria Sugar.
- Role-aware login for `ADMIN`, `SURVEYOR`, and `MANAGMENT`.
- `BLOCKS` and `PARCELS` layers loaded from Supabase RPC.
- Basemap switcher (multiple basemaps).
- Coordinate extractor, coordinate search, parcel/block search.
- Locate me, fullscreen, print, info popup, flags.
- Drawing and measuring tools for survey workflows.
- CSV attribute import flow (no geometry in CSV) with pending-geometry lifecycle.

## Project Structure

- `index.html` - session-aware entry redirect.
- `login.html` - branded sign-in page.
- `webmap.html` - map application shell.
- `js/` - auth, map, importer, and Supabase modules.
- `css/` - shared theme and UI styling.
- `sql/` - Supabase schema, RLS, and RPC definitions.
- `docs/` - deployment and CSV template docs.

## Local Setup

1. Copy `config/app-config.example.js` to `config/app-config.js`.
2. Set Victoria Sugar Supabase project values.
3. Serve this folder using any static server.
4. Open `login.html`.

## Supabase Setup

1. Create a new Supabase project for Victoria Sugar.
2. Run SQL in `sql/001_vsl_schema.sql`.
3. Configure Auth redirect URLs:
   - `https://victoriasugarltd.xyz/login.html`
   - `https://victoriasugarltd.xyz/webmap.html`
4. Create users and assign roles in `vsl_profiles`.

## Cloudflare Deployment

See `docs/DEPLOYMENT.md`.
