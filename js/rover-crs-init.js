/**
 * Populates the Rover "Coordinate System" listbox (#rvCrsSelect) from the
 * single shared CRS_OPTIONS list in crs-definitions.js instead of a
 * hardcoded <option> list in webmap.html.
 *
 * Kept as its own tiny module rather than folded into js/rover.js because
 * rover.js is a plain classic script (not type="module"), so it can't use
 * `import`. This runs once at load and does not touch Rover's own CRS
 * logic — js/rover.js still reads rvCrsSelect.value as a bare numeric EPSG
 * code (e.g. "32736", not "EPSG:32736"), so the values written here are
 * deliberately stripped of the "EPSG:" prefix to match.
 */
import { CRS_OPTIONS } from "./crs-definitions.js";

// Order + defaults specific to this listbox (it's a multi-row picker, not a
// single-choice dropdown like the survey/drone/export selects): geographic
// first, then the Arc 1960 zones, then the WGS 84 zones — matching the
// field habit of picking "Arc 1960 or WGS 84" before "36N or 36S". The ★
// marks Uganda's most commonly used zone for each datum; rover.js strips it
// back off the button label via `.replace(' ★', '')`.
const RV_CRS_ORDER = [
  "EPSG:4326",
  "EPSG:21095",
  "EPSG:21035",
  "EPSG:21096",
  "EPSG:21036",
  "EPSG:32635",
  "EPSG:32735",
  "EPSG:32636",
  "EPSG:32736",
];
const RV_CRS_STARRED = new Set(["EPSG:21036", "EPSG:32736"]);
const RV_CRS_DEFAULT = "EPSG:32736"; // matches RV.crs's default in rover.js

const rvCrsSelect = document.getElementById("rvCrsSelect");
if (rvCrsSelect) {
  const byCode = new Map(CRS_OPTIONS.map((opt) => [opt.value, opt]));
  rvCrsSelect.innerHTML = "";
  RV_CRS_ORDER.forEach((code) => {
    const opt = byCode.get(code);
    if (!opt) return;
    const el = document.createElement("option");
    el.value = code.replace("EPSG:", "");
    el.textContent = RV_CRS_STARRED.has(code) ? `${opt.label} ★` : opt.label;
    if (code === RV_CRS_DEFAULT) el.selected = true;
    rvCrsSelect.appendChild(el);
  });
}
