// ══════════════════════════════════════════════════════════════════════════
//  auth-gate.js — who is allowed to open the dashboard at all
//
//  The dashboard used to boot for anyone with a session. The map hid its
//  Dashboard button from non-admins, but the button was the only thing
//  stopping them: typing /dashboard/ into the address bar loaded the whole
//  admin UI for a manager or a surveyor. This closes that.
//
//  Runs before app.js does anything: app.js's DOMContentLoaded handler
//  awaits window.VSL_DASHBOARD_ACCESS and boots nothing — no window
//  fragments, no Supabase data load, no render — until this says ADMIN.
//
//  ── Why the role is fetched, not read from the cache ──
//  The webmap keeps the signed-in role in localStorage (js/role-store.js) to
//  avoid a round trip before its first paint. That cache is fine for
//  deciding which BUTTONS to draw, because localStorage is writable by
//  whoever is sitting at the browser: the worst a tampered value does there
//  is reveal a button that errors when pressed. A gate is different — it is
//  the thing being tampered with — so the role here always comes from
//  vsl_profiles, read under the user's own token.
//
//  ── What this is and isn't ──
//  This stops the admin UI from loading for people who shouldn't see it. It
//  is NOT what protects the data: that is Postgres row-level security, which
//  checks vsl_is_role() on the authority of the user's token and has no idea
//  this file exists. Both matter. The gate means a manager never reaches a
//  screen full of controls they can't use; RLS means it wouldn't matter if
//  they did.
// ══════════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  /** Only this role may open the dashboard. Everything else — SURVEYOR and
   *  MANAGMENT (spelling matches vsl_profiles.role) — goes back to the map. */
  const ALLOWED_ROLE = "ADMIN";

  const LOGIN_URL = "../login.html";
  const MAP_URL = "../webmap.html";

  /** Replaces the page with a single explanatory panel. Used for every
   *  denial, so there is no path where part of the dashboard is left on
   *  screen with the rest withheld. */
  function showBlockedScreen(title, message, actionLabel, actionUrl) {
    document.title = title + " — Victoria Sugar";
    document.body.innerHTML = `
      <div style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;
                  justify-content:center;background:#0f2e1b;padding:24px;
                  font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
        <div style="max-width:420px;width:100%;background:#fff;border-radius:14px;
                    padding:28px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.35)">
          <div style="font-size:40px;line-height:1;margin-bottom:14px">&#128274;</div>
          <h1 style="margin:0 0 10px;font-size:19px;color:#16301f">${title}</h1>
          <p style="margin:0 0 22px;font-size:14px;line-height:1.55;color:#4a5750">${message}</p>
          <a href="${actionUrl}" style="display:inline-block;background:#285f28;color:#fff;
                 text-decoration:none;font-weight:700;font-size:14px;
                 padding:11px 22px;border-radius:8px">${actionLabel}</a>
        </div>
      </div>`;
  }

  /** The signed-in user's role straight from the database, or null if it
   *  can't be read. Null is treated as a denial by the caller — an
   *  unverifiable session is not an admin session. */
  async function fetchRole(client, userId) {
    try {
      const { data, error } = await client
        .from("vsl_profiles")
        .select("role")
        .eq("id", userId)
        .single();
      if (error) throw error;
      return data?.role || null;
    } catch (err) {
      console.error("[VSL gate] Could not read the signed-in user's role:", err);
      return null;
    }
  }

  /**
   * Resolves to true only for a signed-in ADMIN. Every other outcome —
   * no session, a non-admin role, a role that can't be read — resolves to
   * false AFTER replacing the page, so app.js simply stops.
   */
  window.VSL_DASHBOARD_ACCESS = (async function () {
    if (typeof getSbClient !== "function") {
      // supabase-client.js didn't load. Nothing can be verified, so nothing
      // is allowed — a gate that fails open isn't a gate.
      console.error("[VSL gate] getSbClient() unavailable — denying access.");
      showBlockedScreen(
        "Dashboard unavailable",
        "The dashboard couldn't start up properly, so access can't be verified. Please reload, or go back to the map.",
        "Back to the map", MAP_URL
      );
      return false;
    }

    const client = getSbClient();

    let session = null;
    try {
      const { data } = await client.auth.getSession();
      session = data?.session || null;
    } catch (err) {
      console.error("[VSL gate] Session lookup failed:", err);
    }

    if (!session?.user) {
      // Not signed in at all — straight to login, no explanatory screen
      // needed. replace() rather than href so the back button doesn't walk
      // them into a page that will only bounce them out again.
      window.location.replace(LOGIN_URL);
      return false;
    }

    const role = await fetchRole(client, session.user.id);

    if (!role) {
      showBlockedScreen(
        "Couldn't verify your access",
        "We couldn't confirm your permissions just now. Check your connection and reload, or go back to the map.",
        "Back to the map", MAP_URL
      );
      return false;
    }

    if (role !== ALLOWED_ROLE) {
      showBlockedScreen(
        "Administrators only",
        "The dashboard is limited to administrator accounts. Everything you have access to is on the map.",
        "Back to the map", MAP_URL
      );
      return false;
    }

    // Signing out in another tab, or a session expiring, must not leave the
    // admin UI sitting open on a shared machine.
    client.auth.onAuthStateChange((event, newSession) => {
      if (event === "SIGNED_OUT" || !newSession) {
        window.location.replace(LOGIN_URL);
      }
    });

    return true;
  })();
})();
