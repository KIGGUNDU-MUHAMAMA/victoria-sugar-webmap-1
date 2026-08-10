// app-boot.js
//
// webmap.html used to have every popup/panel's markup typed out inline.
// This file fetches each one as its own HTML file (see /windows) and inserts
// it back into the exact DOM parent it used to live in, so the flex/child-
// combinator CSS in styles.css (e.g. ".map-left-stack > .search-panel")
// keeps working unchanged.
//
// map-app.js (and everything it imports) reads these elements with plain
// document.getElementById() calls at the top of each module, so it must not
// run until the fragments below are actually in the page. Because this file
// is a <script type="module">, it — and map-app.js, imported dynamically at
// the bottom — only start executing after the static HTML has fully parsed,
// and the top-level `await` here holds map-app.js back until every fragment
// has been fetched and inserted.

const WINDOW_FRAGMENTS = [
  // Left-hand tool stack (order matters — mirrors original DOM order).
  { parent: "mapLeftStack", url: "./windows/parcel-status-panel.html" },
  { parent: "mapLeftStack", url: "./windows/sentinel-analytics-panel.html" },
  { parent: "mapLeftStack", url: "./windows/search-panel.html" },
  { parent: "mapLeftStack", url: "./windows/info-help-popover.html" },

  // Right-hand tool stack.
  { parent: "mapRightStack", url: "./windows/measure-panel.html" },
  // Opened from the Legend button next to the Layers control (#mapRightBtnStack).
  { parent: "mapRightStack", url: "./windows/legend-panel.html" },

  // Body-level overlays/modals (position: fixed, so sibling order doesn't matter).
  { parent: "body", url: "./windows/unified-action-menu.html" },
  { parent: "body", url: "./windows/edit-details-modal.html" },
  { parent: "body", url: "./windows/log-activity-modal.html" },
  { parent: "body", url: "./windows/log-alert-modal.html" },
  // Moved out of mapLeftStack (see comment in the file) so the phone-width
  // rule that hides .map-left-stack contents can't swallow it.
  { parent: "body", url: "./windows/feature-info-panel.html" },
  // Drill-down "full record" view opened from links inside the info panel
  // above — sibling overlay, so it can sit on top of it.
  { parent: "body", url: "./windows/record-detail-modal.html" },
  // Opened by clicking a plot's "Alerts(n)" chip directly on the map.
  { parent: "body", url: "./windows/alerts-list-modal.html" },
  // Opened from the "Resolve" action on an unresolved row in the Alerts List modal above.
  { parent: "body", url: "./windows/resolve-alert-modal.html" },
  // Opened by clicking the account button in the top controls (was a direct Sign Out button).
  { parent: "body", url: "./windows/profile-modal.html" },
];

async function loadWindowFragments() {
  const htmls = await Promise.all(
    WINDOW_FRAGMENTS.map(async (f) => {
      const res = await fetch(f.url);
      if (!res.ok) {
        throw new Error(`app-boot: failed to load ${f.url} (${res.status})`);
      }
      return res.text();
    })
  );

  WINDOW_FRAGMENTS.forEach((f, i) => {
    const parent = f.parent === "body" ? document.body : document.getElementById(f.parent);
    if (!parent) {
      console.error(`app-boot: mount point #${f.parent} not found for ${f.url}`);
      return;
    }
    parent.insertAdjacentHTML("beforeend", htmls[i]);
  });
}

await loadWindowFragments();
await import("./map-app.js?v=2.1.3");
