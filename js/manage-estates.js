/**
 * Estates tab (windows/survey-panel.html #uamTabEstates) — CRUD over
 * vsl_estate's name, list + add/rename/delete. Used to be a separate
 * "Manage Estates" modal (windows/manage-estates-panel.html, no longer
 * loaded — see app-boot.js); now lives directly in the Survey window like
 * every other tab. Opened via the "Manage" pencil buttons next to the
 * Import tab's Block/Plot Estate dropdowns (js/survey-import.js), which
 * now just switch to this tab instead of opening a modal.
 */

import { promptText, confirmDanger } from "../popups/popup.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function initManageEstates({ cfg, supabase, setStatus, statusEl }) {
  const tabPanel = document.getElementById("uamTabEstates");
  const listEl = document.getElementById("meList");
  const addBtn = document.getElementById("meAddBtn");
  const errorEl = document.getElementById("meError");

  if (!tabPanel || !listEl) return null;

  let rows = [];
  let blockCounts = new Map(); // estate_id -> block count

  function restHeaders() {
    return {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
      Accept: "application/json"
    };
  }

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  }

  async function fetchRows() {
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_estate?select=id,estate_name&order=estate_name.asc`;
      const res = await fetch(url, { headers: restHeaders() });
      if (!res.ok) throw new Error("Failed to load estates");
      rows = await res.json();
    } catch (e) {
      console.error("[Victoria Survey] Error fetching estates:", e);
      rows = [];
    }
  }

  // vsl_blocks.estate_id, tallied client-side — one lightweight query
  // instead of a per-estate count, same pattern this app already uses
  // elsewhere (e.g. refreshParentBlockOptions).
  async function fetchBlockCounts() {
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_blocks?select=estate_id`;
      const res = await fetch(url, { headers: restHeaders() });
      if (!res.ok) throw new Error("Failed to load block counts");
      const data = await res.json();
      const map = new Map();
      for (const row of data) {
        if (row.estate_id == null) continue;
        map.set(row.estate_id, (map.get(row.estate_id) || 0) + 1);
      }
      blockCounts = map;
    } catch (e) {
      console.error("[Victoria Survey] Error fetching block counts:", e);
      blockCounts = new Map();
    }
  }

  function renderList() {
    if (!rows.length) {
      listEl.innerHTML = '<p class="me-list-empty">No estates yet.</p>';
      return;
    }
    listEl.innerHTML = rows.map((r) => {
      const count = blockCounts.get(r.id) || 0;
      return `
      <div class="me-row" data-id="${r.id}">
        <div class="me-row__info">
          <span class="me-row__name">${escapeHtml(r.estate_name)}</span>
          <span class="me-block_count">${count} block${count === 1 ? "" : "s"}</span>
        </div>
        <div class="me-row__actions">
          <button type="button" class="me-row__btn" data-edit="${r.id}" aria-label="Rename ${escapeHtml(r.estate_name)}">
            <i class="fas fa-pen" aria-hidden="true"></i>
          </button>
          <button type="button" class="me-row__btn me-row__btn--danger" data-delete="${r.id}" aria-label="Delete ${escapeHtml(r.estate_name)}">
            <i class="fas fa-trash" aria-hidden="true"></i>
          </button>
        </div>
      </div>`;
    }).join("");
  }

  async function refresh() {
    showError("");
    await Promise.all([fetchRows(), fetchBlockCounts()]);
    renderList();
  }

  addBtn?.addEventListener("click", async () => {
    const name = await promptText({ title: "New Estate", message: "Estate name", placeholder: "e.g. Lugazi" });
    if (!name) return;
    showError("");
    try {
      const { error } = await supabase.from("vsl_estate").insert({ estate_name: name });
      if (error) throw error;
      await refresh();
      window.dispatchEvent(new CustomEvent("vsl-estates-changed"));
      setStatus?.(statusEl, `Estate "${name}" created.`);
    } catch (e) {
      console.error("[Victoria Survey] Failed to create estate:", e);
      showError(e.message);
    }
  });

  listEl.addEventListener("click", async (e) => {
    const editBtn = e.target.closest("[data-edit]");
    const deleteBtn = e.target.closest("[data-delete]");

    if (editBtn) {
      const row = rows.find((r) => String(r.id) === editBtn.dataset.edit);
      if (!row) return;
      const name = await promptText({ title: "Rename Estate", message: "Estate name", value: row.estate_name });
      if (!name || name === row.estate_name) return;
      showError("");
      try {
        const { error } = await supabase.from("vsl_estate").update({ estate_name: name }).eq("id", row.id);
        if (error) throw error;
        await refresh();
        window.dispatchEvent(new CustomEvent("vsl-estates-changed"));
        setStatus?.(statusEl, `Estate renamed to "${name}".`);
      } catch (err) {
        console.error("[Victoria Survey] Failed to rename estate:", err);
        showError(err.message);
      }
      return;
    }

    if (deleteBtn) {
      const row = rows.find((r) => String(r.id) === deleteBtn.dataset.delete);
      if (!row) return;

      const count = blockCounts.get(row.id) || 0;
      if (count > 0) {
        await confirmDanger({
          title: "Can't Delete Estate",
          message: "You can not delete an estate with linked Blocks, manually delete the linked blocks first."
        });
        return;
      }

      const confirmed = await confirmDanger({
        title: "Delete Estate",
        message: `Delete estate "${row.estate_name}"? This can't be undone.`,
        confirmLabel: "Delete"
      });
      if (!confirmed) return;

      showError("");
      try {
        const { error } = await supabase.from("vsl_estate").delete().eq("id", row.id);
        if (error) throw error;
        await refresh();
        window.dispatchEvent(new CustomEvent("vsl-estates-changed"));
        setStatus?.(statusEl, `Estate "${row.estate_name}" deleted.`);
      } catch (err) {
        console.error("[Victoria Survey] Failed to delete estate:", err);
        // A stale block count (added concurrently, after this tab last
        // refreshed) hits the same FK constraint server-side — same
        // message either way, since the cause is identical.
        showError(
          /foreign key|violates/i.test(err.message)
            ? "You can not delete an estate with linked Blocks, manually delete the linked blocks first."
            : err.message
        );
      }
    }
  });

  // Refresh whenever the tab becomes visible (switchTab in unified-menu.js
  // just toggles [hidden] — same "watch for the tab showing" pattern
  // survey-edit.js uses to reset itself when the Edit tab is left).
  const observer = new MutationObserver(() => {
    if (!tabPanel.hidden) refresh();
  });
  observer.observe(tabPanel, { attributes: true, attributeFilter: ["hidden"] });

  return { refresh };
}
