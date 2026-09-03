/**
 * Drone tab (windows/survey-panel.html #uamTabDrone) + the DRONE IMAGES
 * layer group.
 *
 * Drone orthomosaics are tiled offline by the Raster Image Tiler and arrive
 * here as .pmtiles archives — one sealed file per site. A SURVEY (a folder in
 * the R2 bucket, named by date) holds one archive per site flown in that
 * campaign. Sites are kilometres apart and never overlap, so a survey is just
 * several unrelated patches of imagery that happen to share a date.
 *
 * The layer switcher shows one radio row per survey, so switching between
 * years swaps every site at once.
 *
 * Nothing here talks to R2 directly. The Worker in worker/ holds the bucket
 * binding and checks the caller's Supabase token on every request, so no
 * storage credential ever reaches the browser.
 */

import { promptFields, confirmDanger } from "../popups/popup.js";

// A tile that isn't in the archive. Handed to OpenLayers instead of leaving
// the <img> unset, which would otherwise log a network error per miss.
const BLANK_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Upload chunk size. Each part is its own short request to the Worker, so an
// archive can be any size without meeting a request-body limit, and a part
// that fails can be retried on its own.
const PART_SIZE = 8 * 1024 * 1024;

// PMTiles tile-type enum -> what the tiles actually are.
const TILE_TYPES = { 1: "mvt", 2: "png", 3: "jpeg", 4: "webp", 5: "avif" };

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Today as DAY-MONTH-YY, the default name for a new survey. */
function todayFolder() {
  const now = new Date();
  return `${now.getDate()}-${now.getMonth() + 1}-${String(now.getFullYear()).slice(2)}`;
}

/** Site name from the archive's own filename: "Kaaya.pmtiles" -> "Kaaya". */
function siteNameFrom(fileName) {
  return String(fileName).replace(/\.pmtiles$/i, "").trim() || "Site";
}

// ----------------------------------------------------------------------
// Reading a .pmtiles archive
// ----------------------------------------------------------------------

/**
 * Reads byte ranges out of a File the user picked, so the archive's header
 * can be checked before a single byte is uploaded. The whole file is never
 * read — only the few kilobytes the header and directories occupy.
 */
class LocalFileSource {
  constructor(file) {
    this.file = file;
  }
  getKey() {
    return this.file.name;
  }
  async getBytes(offset, length) {
    const slice = this.file.slice(offset, offset + length);
    return { data: await slice.arrayBuffer() };
  }
}

/**
 * Reads byte ranges from the Worker, attaching the caller's Supabase token.
 *
 * PMTiles is read with HTTP range requests, so this is called many times per
 * archive — once for the header, a few times for the directories, then once
 * per tile. The bytes come back as an ArrayBuffer and are turned into a blob
 * URL, which is same-origin, so the print and export tools can still
 * rasterise the map without tainting the canvas.
 */
class WorkerSource {
  constructor(url, getToken) {
    this.url = url;
    this.getToken = getToken;
  }
  getKey() {
    return this.url;
  }
  async getBytes(offset, length, signal) {
    const token = await this.getToken();
    const response = await fetch(this.url, {
      signal,
      headers: {
        Range: `bytes=${offset}-${offset + length - 1}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("Not allowed to read this imagery");
    }
    if (!response.ok && response.status !== 206) {
      throw new Error(`Tile server returned ${response.status}`);
    }
    return {
      data: await response.arrayBuffer(),
      etag: response.headers.get("ETag") || undefined,
      cacheControl: response.headers.get("Cache-Control") || undefined,
      expires: response.headers.get("Expires") || undefined
    };
  }
}

/** Header + metadata of a PMTiles archive, normalised. */
async function describeArchive(archive) {
  const header = await archive.getHeader();
  let metadata = {};
  try {
    metadata = (await archive.getMetadata()) || {};
  } catch {
    /* metadata is optional — bounds and zooms live in the header */
  }
  return {
    minZoom: header.minZoom ?? 0,
    maxZoom: header.maxZoom ?? 22,
    minLon: header.minLon,
    minLat: header.minLat,
    maxLon: header.maxLon,
    maxLat: header.maxLat,
    tileFormat: TILE_TYPES[header.tileType] || "",
    // PMTiles has no tile-size field. The tiler records it in the metadata
    // when it isn't the assumed 256.
    tileSize: Number(metadata.tilesize) || 256
  };
}

// ----------------------------------------------------------------------
// Worker API
// ----------------------------------------------------------------------

function createApi({ cfg, supabase }) {
  const base = String(cfg.TILES_API_BASE || "").replace(/\/$/, "");

  async function token() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function call(path, { method = "GET", body, raw } = {}) {
    if (!base) throw new Error("TILES_API_BASE is not set in config/app-config.js");
    const headers = { Authorization: `Bearer ${await token()}` };
    if (body !== undefined && !raw) headers["Content-Type"] = "application/json";

    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      throw new Error((await response.text()) || `Request failed (${response.status})`);
    }
    const type = response.headers.get("Content-Type") || "";
    return type.includes("json") ? response.json() : response.text();
  }

  return {
    base,
    token,
    listGroups: () => call("/api/groups"),
    createGroup: (folder, title, description) =>
      call("/api/groups", { method: "POST", body: { folder, title, description } }),
    deleteGroup: (folder) =>
      call(`/api/groups/${encodeURIComponent(folder)}`, { method: "DELETE" }),
    deleteObject: (key) =>
      call(`/api/objects?key=${encodeURIComponent(key)}`, { method: "DELETE" }),
    tileUrl: (key) => `${base}/tiles/${key.split("/").map(encodeURIComponent).join("/")}`,

    /** Chunked upload. Reports 0..1 progress. Returns the object's size. */
    async upload(file, key, onProgress) {
      const { uploadId } = await call("/api/uploads", { method: "POST", body: { key } });
      const parts = [];
      try {
        const total = Math.max(1, Math.ceil(file.size / PART_SIZE));
        for (let index = 0; index < total; index++) {
          const chunk = file.slice(index * PART_SIZE, (index + 1) * PART_SIZE);
          const part = await call(
            `/api/uploads/part?key=${encodeURIComponent(key)}` +
              `&uploadId=${encodeURIComponent(uploadId)}&part=${index + 1}`,
            { method: "PUT", body: chunk, raw: true }
          );
          parts.push(part);
          if (onProgress) onProgress((index + 1) / total);
        }
        return await call("/api/uploads/complete", {
          method: "POST",
          body: { key, uploadId, parts }
        });
      } catch (error) {
        // Leave no half-written object behind for the next listing to find.
        try {
          await call("/api/uploads/abort", { method: "POST", body: { key, uploadId } });
        } catch {
          /* the upload is already lost; the original error is what matters */
        }
        throw error;
      }
    }
  };
}

// ----------------------------------------------------------------------
// Building map layers
// ----------------------------------------------------------------------

/**
 * One OpenLayers layer for one archive.
 *
 * `extent` is what keeps the other sites quiet: OpenLayers will not request a
 * single tile from a layer whose box does not overlap the screen, so panning
 * around Kaaya never touches Kaleile's archive.
 */
function buildArchiveLayer({ title, archive, info, opacity }) {
  const extent = ol.proj.transformExtent(
    [info.minLon, info.minLat, info.maxLon, info.maxLat],
    "EPSG:4326",
    "EPSG:3857"
  );

  const source = new ol.source.XYZ({
    // Never fetched — tileLoadFunction below replaces the URL entirely — but
    // ol.source.XYZ insists on a url template being present.
    url: "pmtiles://{z}/{x}/{y}",
    minZoom: info.minZoom,
    maxZoom: info.maxZoom,
    tileSize: info.tileSize,
    crossOrigin: "anonymous",
    tileLoadFunction: async (tile) => {
      const image = tile.getImage();
      const [z, x, y] = tile.getTileCoord();
      try {
        const result = await archive.getZxy(z, x, y);
        if (!result || !result.data) {
          image.src = BLANK_TILE;
          return;
        }
        const url = URL.createObjectURL(new Blob([result.data]));
        image.onload = image.onerror = () => URL.revokeObjectURL(url);
        image.src = url;
      } catch (error) {
        console.warn("[Victoria Drone] tile failed", z, x, y, error);
        image.src = BLANK_TILE;
      }
    }
  });

  return new ol.layer.Tile({
    title,
    extent,
    source,
    opacity: opacity ?? 1,
    visible: true
  });
}

// ----------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------

export function initDroneTiles({ cfg, supabase, map, droneGroup, setStatus, statusEl, refreshSwitcher }) {
  /**
   * setStatus() from utils.js takes the target element first, not the
   * message — and its `if (!el) return` guard does not catch a string being
   * passed in its place, so getting this wrong throws rather than quietly
   * doing nothing. Everything here goes through this one helper, and a
   * failure to show a status message never breaks the action behind it.
   */
  function say(message, isError = false) {
    try {
      setStatus?.(statusEl, message, isError);
    } catch (error) {
      console.warn("[Victoria Drone]", message, error);
    }
  }

  const groupSelect = document.getElementById("droneGroupSelect");
  const addGroupBtn = document.getElementById("droneGroupAddBtn");
  const descEl = document.getElementById("droneGroupDesc");
  const fileInput = document.getElementById("droneFileInput");
  const fileNameEl = document.getElementById("droneFileName");
  const fileLabel = document.getElementById("droneFileLabel");
  const queueEl = document.getElementById("droneQueue");
  const errorEl = document.getElementById("droneError");
  const existingEl = document.getElementById("droneExisting");
  const uploadBtn = document.getElementById("droneUploadBtn");
  const clearBtn = document.getElementById("droneClearBtn");
  // Add / Manage sub-tabs and the two bodies + two footer sets they swap.
  const modeTabs = document.getElementById("droneModeTabs");
  const deleteGroupBtn = document.getElementById("droneDeleteGroupBtn");
  const modePanels = document.querySelectorAll("[data-drone-panel]");
  const modeActionSets = document.querySelectorAll("[data-drone-actions]");

  if (!groupSelect || !fileInput) return null;

  /** "add" (choose files, upload) or "manage" (prune what's already there). */
  let mode = "add";

  const api = createApi({ cfg, supabase });
  let groups = [];
  let queued = [];
  let busy = false;

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message || "";
    errorEl.hidden = !message;
  }

  function setBusy(state) {
    busy = state;
    [groupSelect, addGroupBtn, fileInput, uploadBtn, clearBtn, deleteGroupBtn].forEach((el) => {
      if (el) el.disabled = state;
    });
    if (!state) syncButtons();
  }

  function syncButtons() {
    if (busy) return;
    const ready = queued.length > 0 && !!groupSelect.value;
    if (uploadBtn) uploadBtn.disabled = !ready;
    if (clearBtn) clearBtn.disabled = queued.length === 0;
    // Manage's only action needs a group selected to act on.
    if (deleteGroupBtn) deleteGroupBtn.disabled = !groupSelect.value;
  }

  /** Shows one mode's body and footer buttons, hiding the other's. */
  function syncDroneMode() {
    modeTabs?.querySelectorAll("[data-drone-mode]").forEach((btn) => {
      btn.setAttribute("aria-selected", String(btn.dataset.droneMode === mode));
    });
    modePanels.forEach((el) => {
      el.hidden = el.dataset.dronePanel !== mode;
    });
    modeActionSets.forEach((el) => {
      el.hidden = el.dataset.droneActions !== mode;
    });
    syncButtons();
  }

  modeTabs?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-drone-mode]");
    if (!btn || btn.dataset.droneMode === mode) return;
    mode = btn.dataset.droneMode;
    syncDroneMode();
  });

  deleteGroupBtn?.addEventListener("click", () => {
    if (groupSelect.value) onDeleteGroup(groupSelect.value);
  });

  // ── Survey list ──────────────────────────────────────────────────────

  function renderGroupOptions() {
    const previous = groupSelect.value;
    groupSelect.innerHTML = '<option value="">— Select group —</option>';
    for (const group of groups) {
      const option = document.createElement("option");
      option.value = group.folder;
      option.textContent =
        group.title === group.folder
          ? `${group.folder} (${group.layers.length})`
          : `${group.title} — ${group.folder} (${group.layers.length})`;
      groupSelect.appendChild(option);
    }
    if (previous && groups.some((g) => g.folder === previous)) groupSelect.value = previous;
    renderSelectedGroup();
  }

  function renderSelectedGroup() {
    const group = groups.find((g) => g.folder === groupSelect.value);

    if (descEl) {
      descEl.textContent = group?.description || "";
      descEl.hidden = !group?.description;
    }
    if (!existingEl) return;

    if (!group) {
      existingEl.innerHTML = '<p class="uam-hint">Select a group to see what it holds.</p>';
      return;
    }
    if (!group.layers.length) {
      existingEl.innerHTML = '<p class="uam-hint">No tiles in this group yet.</p>';
      return;
    }
    existingEl.innerHTML = `
      <p class="uam-hint"><strong>${escapeHtml(group.title)}</strong> holds:</p>
      <div class="drone-site-list">
        ${group.layers
          .map(
            (layer) => `
          <div class="drone-site-row">
            <span class="drone-site-row__name">${escapeHtml(layer.site_name)}</span>
            <span class="drone-site-row__size">${formatBytes(layer.size_bytes)}</span>
            <button type="button" class="uam-icon-btn uam-icon-btn--danger"
                    data-drone-delete="${escapeHtml(layer.key)}"
                    title="Delete ${escapeHtml(layer.site_name)}">
              <i class="fas fa-trash" aria-hidden="true"></i>
            </button>
          </div>`
          )
          .join("")}
      </div>`;
  }

  async function refreshGroups({ rebuildMap = true } = {}) {
    try {
      const result = await api.listGroups();
      groups = result.groups || [];
      showError("");
    } catch (error) {
      groups = [];
      // Logged as well as shown: showError() writes into #droneError, which
      // is only on screen when the Survey window is open on the Drone tab.
      // The symptom people actually notice is the DRONE IMAGES group sitting
      // empty in the Layers panel, and nothing explained that until now.
      console.error("[Victoria Drone] GET /api/groups failed:", error);
      showError(`Could not reach the tile server: ${error.message}`);
    }
    renderGroupOptions();
    if (rebuildMap) await rebuildLayers();
  }

  // ── Creating a survey ────────────────────────────────────────────────

  async function onCreateGroup() {
    const suggested = todayFolder();
    const values = await promptFields({
      title: "New drone survey",
      message: "Creates a folder in the tile bucket. Sites are uploaded into it.",
      icon: "fa-helicopter",
      confirmLabel: "Create",
      fields: [
        { key: "folder", label: "Survey name", type: "text", value: suggested, required: true },
        { key: "description", label: "Description", type: "textarea", value: "" }
      ]
    });
    if (!values) return;

    const folder = String(values.folder || "").trim();
    if (!folder) return;

    // setBusy(true) and the try/finally that clears it must not be separated
    // by anything that can throw, or a failure leaves the tab's controls
    // disabled with no way back short of a reload.
    setBusy(true);
    try {
      say(`Creating survey ${folder}…`);
      await api.createGroup(folder, folder, values.description || "");

      // Mirror it into the database, which is what the map reads on load so
      // it does not have to open every archive's header. The bucket stays
      // the durable record — this row is an index over it.
      const { data: session } = await supabase.auth.getUser();
      await supabase.from("vsl_tile_groups").upsert(
        {
          folder,
          title: folder,
          description: values.description || null,
          created_by: session?.user?.id || null
        },
        { onConflict: "folder" }
      );

      await refreshGroups({ rebuildMap: false });
      groupSelect.value = folder;
      renderSelectedGroup();
      syncButtons();
      say(`Survey ${folder} created.`);
    } catch (error) {
      showError(error.message);
      say("Could not create the survey.");
    } finally {
      setBusy(false);
    }
  }

  // ── Choosing files ───────────────────────────────────────────────────

  async function acceptFiles(fileList) {
    const files = [...fileList].filter((f) => /\.pmtiles$/i.test(f.name));
    const rejected = [...fileList].length - files.length;

    queued = [];
    for (const file of files) {
      try {
        const archive = new pmtiles.PMTiles(new LocalFileSource(file));
        const info = await describeArchive(archive);
        queued.push({ file, info, site: siteNameFrom(file.name), state: "ready" });
      } catch (error) {
        queued.push({ file, error: error.message, site: siteNameFrom(file.name), state: "bad" });
      }
    }

    showError(rejected ? `${rejected} file(s) ignored — only .pmtiles is accepted.` : "");
    renderQueue();
    syncButtons();
  }

  function renderQueue() {
    if (fileNameEl) {
      fileNameEl.textContent = queued.length
        ? `${queued.length} file(s) selected`
        : "Choose .pmtiles files or drop them here…";
    }
    if (!queueEl) return;

    if (!queued.length) {
      queueEl.hidden = true;
      queueEl.innerHTML = "";
      return;
    }

    const sending = queued.filter((item) => item.state === "uploading").length;
    const finished = queued.filter((item) => item.state === "done").length;
    const total = queued.filter((item) => item.state !== "bad").length;

    queueEl.hidden = false;
    queueEl.innerHTML =
      (sending
        ? `<div class="drone-queue-head">
             <span class="drone-spinner" aria-hidden="true"></span>
             <span>Uploading ${Math.min(finished + 1, total)} of ${total}…</span>
           </div>`
        : "") +
      queued
        .map((item, index) => {
          if (item.state === "bad") {
            return `<div class="drone-queue-row drone-queue-row--bad">
                      <div class="drone-queue-row__head">
                        <i class="fas fa-circle-exclamation" aria-hidden="true"></i>
                        <strong>${escapeHtml(item.file.name)}</strong>
                      </div>
                      <div class="drone-queue-row__meta">${escapeHtml(
                        item.error || "not a readable PMTiles archive"
                      )}</div>
                    </div>`;
          }

          const percent = Math.round((item.progress || 0) * 100);
          const done = item.state === "done";
          const busy = item.state === "uploading";

          // The bar is rendered for uploading and finished rows alike, so a
          // row does not change height the moment it completes.
          const bar =
            busy || done
              ? `<div class="drone-queue-row__bar">
                   <div class="drone-queue-row__fill${done ? " is-done" : ""}"
                        style="width:${done ? 100 : percent}%"></div>
                 </div>`
              : "";

          const badge = done
            ? '<i class="fas fa-circle-check drone-queue-row__ok" aria-hidden="true"></i>'
            : busy
              ? `<span class="drone-queue-row__pct">${percent}%</span>`
              : "";

          return `<div class="drone-queue-row${busy ? " is-busy" : ""}${
            done ? " is-done" : ""
          }" data-drone-row="${index}">
                    <div class="drone-queue-row__head">
                      ${busy ? '<span class="drone-spinner" aria-hidden="true"></span>' : ""}
                      <strong>${escapeHtml(item.site)}</strong>
                      ${badge}
                    </div>
                    <div class="drone-queue-row__meta">
                      ${formatBytes(item.file.size)} · z${item.info.minZoom}–${item.info.maxZoom} · ${escapeHtml(
                        item.info.tileFormat
                      )}
                    </div>
                    ${bar}
                  </div>`;
        })
        .join("");
  }

  /**
   * Move one row's bar without rebuilding the list.
   *
   * renderQueue() replaces the whole innerHTML, which would drop and recreate
   * the bar on every chunk and kill its CSS transition. Progress fires once
   * per 8 MB, so nudging the existing nodes keeps the bar gliding instead of
   * jumping. Falls back to a full render if the row is not on screen.
   */
  function updateRowProgress(index, fraction) {
    const row = queueEl?.querySelector(`[data-drone-row="${index}"]`);
    if (!row) {
      renderQueue();
      return;
    }
    const percent = Math.round(fraction * 100);
    const fill = row.querySelector(".drone-queue-row__fill");
    const pct = row.querySelector(".drone-queue-row__pct");
    if (fill) fill.style.width = `${percent}%`;
    if (pct) pct.textContent = `${percent}%`;
  }

  function clearQueue() {
    queued = [];
    if (fileInput) fileInput.value = "";
    renderQueue();
    showError("");
    syncButtons();
  }

  // ── Uploading ────────────────────────────────────────────────────────

  async function onUpload() {
    const folder = groupSelect.value;
    if (!folder || !queued.length) return;

    const usable = queued.filter((item) => item.state !== "bad");
    if (!usable.length) {
      showError("None of the selected files are readable PMTiles archives.");
      return;
    }

    setBusy(true);
    showError("");
    let failed = 0;
    try {
      await runUploads(usable, folder, (n) => { failed = n; });
    } catch (error) {
      failed = usable.length;
      showError(error.message);
    } finally {
      setBusy(false);
    }

    say(
      failed ? `Uploaded with ${failed} failure(s).` : `Uploaded ${usable.length} site(s).`,
      Boolean(failed)
    );
    if (!failed) clearQueue();
    await refreshGroups();
  }

  /** The upload loop itself. Split out so onUpload's finally always runs. */
  async function runUploads(usable, folder, reportFailures) {
    const { data: session } = await supabase.auth.getUser();
    const userId = session?.user?.id || null;

    let failed = 0;
    for (const item of usable) {
      const key = `orthos/${folder}/${item.file.name}`;
      item.state = "uploading";
      item.progress = 0;
      renderQueue();
      say(`Uploading ${item.site}…`);

      try {
        // The row goes in first, marked "uploading", so a half-sent archive
        // is never picked up by the map as if it were finished.
        const groupRow = await ensureGroupRow(folder);
        await supabase.from("vsl_tile_layers").upsert(
          {
            group_id: groupRow.id,
            site_name: item.site,
            file_name: item.file.name,
            object_key: key,
            tile_format: item.info.tileFormat || null,
            tile_size: item.info.tileSize,
            min_zoom: item.info.minZoom,
            max_zoom: item.info.maxZoom,
            min_lon: item.info.minLon,
            min_lat: item.info.minLat,
            max_lon: item.info.maxLon,
            max_lat: item.info.maxLat,
            size_bytes: item.file.size,
            status: "uploading",
            uploaded_by: userId
          },
          { onConflict: "object_key" }
        );

        const rowIndex = queued.indexOf(item);
        await api.upload(item.file, key, (fraction) => {
          item.progress = fraction;
          updateRowProgress(rowIndex, fraction);
        });

        await supabase
          .from("vsl_tile_layers")
          .update({ status: "ready", size_bytes: item.file.size })
          .eq("object_key", key);

        item.state = "done";
      } catch (error) {
        failed++;
        item.state = "bad";
        item.error = error.message;
        await supabase.from("vsl_tile_layers").update({ status: "failed" }).eq("object_key", key);
        showError(`${item.site}: ${error.message}`);
      }
      renderQueue();
    }
    reportFailures(failed);
  }

  /** The group's database row, created on demand if the folder predates it. */
  async function ensureGroupRow(folder) {
    const existing = await supabase
      .from("vsl_tile_groups")
      .select("id, folder")
      .eq("folder", folder)
      .maybeSingle();
    if (existing.data) return existing.data;

    const meta = groups.find((g) => g.folder === folder);
    const inserted = await supabase
      .from("vsl_tile_groups")
      .insert({ folder, title: meta?.title || folder, description: meta?.description || null })
      .select("id, folder")
      .single();
    if (inserted.error) throw new Error(inserted.error.message);
    return inserted.data;
  }

  // ── Deleting ─────────────────────────────────────────────────────────

  async function onDeleteArchive(key) {
    const name = siteNameFrom(key.split("/").pop());
    const ok = await confirmDanger({
      title: "Delete this site?",
      message: `${name} will be removed from the bucket. This cannot be undone.`,
      confirmLabel: "Delete",
      icon: "fa-trash"
    });
    if (!ok) return;

    setBusy(true);
    try {
      await api.deleteObject(key);
      await supabase.from("vsl_tile_layers").delete().eq("object_key", key);
      say(`${name} deleted.`);
      await refreshGroups();
    } catch (error) {
      showError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteGroup(folder) {
    const group = groups.find((g) => g.folder === folder);
    const count = group?.layers.length || 0;
    const ok = await confirmDanger({
      title: "Delete this group?",
      message: `${folder} and its ${count} site(s) will be removed from the bucket. This cannot be undone.`,
      confirmLabel: "Delete group",
      icon: "fa-trash"
    });
    if (!ok) return;

    setBusy(true);
    try {
      await api.deleteGroup(folder);
      await supabase.from("vsl_tile_groups").delete().eq("folder", folder);
      groupSelect.value = "";
      say(`Group ${folder} deleted.`);
      await refreshGroups();
    } catch (error) {
      showError(error.message);
    } finally {
      setBusy(false);
    }
  }

  // ── The map layers ───────────────────────────────────────────────────

  async function rebuildLayers() {
    if (!droneGroup) return;
    droneGroup.getLayers().clear();

    const usable = groups.filter((group) => group.layers.length);
    if (!usable.length) {
      // Distinguishes "the server told us there is nothing" from "we never
      // reached the server" (logged above) and from "archives failed to
      // open" (warned per-key below) — all three leave the group empty.
      console.info("[Victoria Drone] No surveys with imagery returned; DRONE IMAGES will be empty.");
      return;
    }

    // Newest first in the array; ol-layerswitcher renders children in reverse,
    // so this puts the most recent survey at the top of the panel.
    const built = [];
    for (const group of usable.slice().reverse()) {
      const layers = [];
      for (const layer of group.layers) {
        try {
          const archive = new pmtiles.PMTiles(
            new WorkerSource(api.tileUrl(layer.key), api.token)
          );
          const info = await describeArchive(archive);
          layers.push(buildArchiveLayer({ title: layer.site_name, archive, info }));
        } catch (error) {
          console.warn("[Victoria Drone] could not open", layer.key, error);
        }
      }
      if (!layers.length) continue;

      built.push(
        new ol.layer.Group({
          title: group.title,
          // Deliberately NO `combine: true` — that collapses a group into one
          // row and hides its children, which is what stopped the sites being
          // listed. Without it the group is foldable and each site shows
          // underneath as its own tick box.
          //
          // Also deliberately NO `type: "base"`. It would not make the survey
          // render as a radio anyway — ol-layerswitcher's radio branch only
          // handles leaf layers, and a group is always drawn with a checkbox
          // regardless of its type. Worse, the library's setVisible_ hides
          // every other type:"base" layer "regardless of grouping", and the
          // basemaps are type:"base" — so switching a survey on would switch
          // Google Satellite off. Only-one-survey is enforced below instead,
          // scoped to this group.
          fold: "close",
          visible: false,
          layers
        })
      );
    }

    built.forEach((layer) => droneGroup.getLayers().push(layer));

    // Start with the newest survey on and every other one fully off, sites
    // included — a hidden group whose sites were left visible would be turned
    // back on by the switcher's first render. Groups stay folded: with several
    // surveys of several sites each, auto-expanding them floods the panel.
    built.forEach((surveyGroup, index) =>
      setSurveyVisible(surveyGroup, index === built.length - 1)
    );

    // Watchers attach after the initial state is settled, so setting it up
    // does not set the exclusivity cascade running.
    built.forEach((surveyGroup) => watchSurveyVisibility(surveyGroup, built));

    // Safe to redraw here: the rebuild is finished and no cascade is running.
    refreshSwitcher?.();
  }

  /**
   * Only one survey may be showing at a time: checking one unchecks the rest.
   *
   * The sites inside a survey have to be switched off too, not just the group.
   * ol-layerswitcher recomputes every group's checkbox from its descendants on
   * each render (setGroupVisibility): a group whose sites are all still
   * visible is turned straight back on, so setting the group alone is undone
   * before the panel finishes drawing.
   *
   * Turning a survey ON deliberately leaves its own sites alone — the library
   * already switches them on when the group's box is ticked, and forcing them
   * here would wipe out a site the user had chosen to hide.
   *
   * They stay ordinary checkboxes. The library's own single-select
   * (`type: "base"`) is unusable here: it hides every other base layer on the
   * map, and the basemaps are type:"base", so a survey would switch Google
   * Satellite off. Switching a survey off is still allowed — that just means
   * "no drone imagery", which a strict radio set could not express.
   */
  let swappingSurvey = false;

  function setSurveyVisible(surveyGroup, visible) {
    surveyGroup.getLayers().forEach((site) => site.setVisible(visible));
    surveyGroup.setVisible(visible);
  }

  function watchSurveyVisibility(surveyGroup, siblings) {
    surveyGroup.on("change:visible", () => {
      if (swappingSurvey || !surveyGroup.getVisible()) return;
      swappingSurvey = true;
      siblings.forEach((other) => {
        if (other !== surveyGroup) setSurveyVisible(other, false);
      });
      swappingSurvey = false;
      // Deliberately NOT redrawing the panel here. This runs part-way through
      // the switcher's own setVisible_ cascade: the group has been set visible
      // but its sites have not been switched on yet. A render at this moment
      // makes setGroupVisibility read all-sites-off and turn THIS group back
      // off — and setVisible_ then re-reads getVisible() for the children and
      // switches them off too, leaving every box unchecked and unclickable.
      // The switcher already redraws itself after the cascade finishes.
    });
  }

  // ── Wiring ───────────────────────────────────────────────────────────

  groupSelect.addEventListener("change", () => {
    renderSelectedGroup();
    syncButtons();
  });
  addGroupBtn?.addEventListener("click", onCreateGroup);
  uploadBtn?.addEventListener("click", onUpload);
  clearBtn?.addEventListener("click", clearQueue);
  fileInput.addEventListener("change", (event) => acceptFiles(event.target.files));

  // Drag and drop onto the file label, same as the Import tab.
  if (fileLabel) {
    ["dragenter", "dragover"].forEach((name) =>
      fileLabel.addEventListener(name, (event) => {
        event.preventDefault();
        fileLabel.classList.add("is-dragover");
      })
    );
    ["dragleave", "drop"].forEach((name) =>
      fileLabel.addEventListener(name, (event) => {
        event.preventDefault();
        fileLabel.classList.remove("is-dragover");
      })
    );
    fileLabel.addEventListener("drop", (event) => {
      if (busy) return;
      const files = event.dataTransfer?.files;
      if (files?.length) acceptFiles(files);
    });
  }

  // Only per-file deletes are delegated from the list now — deleting the
  // whole group moved to the Manage footer button (#droneDeleteGroupBtn),
  // so the [data-drone-delete-group] branch that used to live here is gone
  // along with the in-body button it listened for.
  existingEl?.addEventListener("click", (event) => {
    const archiveBtn = event.target.closest("[data-drone-delete]");
    if (archiveBtn) return onDeleteArchive(archiveBtn.getAttribute("data-drone-delete"));
  });

  syncDroneMode();
  refreshGroups();

  return { refresh: refreshGroups, rebuildLayers };
}
