// set-password.html — where invitation and "forgot password" emails land.
//
// The email link sends the person here with a one-time token in the URL.
// The Supabase client (detectSessionInUrl) swaps that token for a short
// session, and the person then chooses their own password with
// auth.updateUser(). The admin who invited them never sees or sets it,
// and opening the link proves the email address is real.
import { clearStatus, setStatus } from "./utils.js";

// Read the link details BEFORE the Supabase client loads — it clears them
// from the address bar once it has used them.
const linkParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
const queryParams = new URLSearchParams(window.location.search);
const linkType = linkParams.get("type") || queryParams.get("type") || "invite"; // "invite" | "recovery"
const linkError = linkParams.get("error_description") || queryParams.get("error_description");

const { createSupabaseClient } = await import("./supabase-client.js");
const supabase = createSupabaseClient();

const el = (id) => document.getElementById(id);
const statusEl = el("status");
const panels = ["spLoading", "spInvalid", "spForm", "spDone"];
function show(id) {
  panels.forEach((p) => { el(p).hidden = p !== id; });
}

const pwd = el("spPassword");
const confirmPwd = el("spConfirm");
const submitBtn = el("spSubmit");

function checkRules() {
  const v = pwd.value;
  const rules = {
    len: v.length >= 8,
    letter: /[A-Za-z]/.test(v),
    number: /\d/.test(v),
    match: v.length > 0 && v === confirmPwd.value,
  };
  document.querySelectorAll("#spRules li").forEach((li) => {
    li.classList.toggle("ok", !!rules[li.dataset.rule]);
  });
  const allOk = Object.values(rules).every(Boolean);
  submitBtn.disabled = !allOk;
  return allOk;
}
pwd.addEventListener("input", checkRules);
confirmPwd.addEventListener("input", checkRules);

el("spForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus(statusEl);
  if (!checkRules()) return;
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";
  try {
    const { data, error } = await supabase.auth.updateUser({ password: pwd.value });
    if (error) throw error;
    const email = data?.user?.email || "";
    // Make them sign in properly — login.html runs the role / active checks.
    await supabase.auth.signOut();
    el("spDoneTitle").textContent = linkType === "recovery" ? "Password updated" : "Your account is ready";
    el("spDoneLink").href = "./login.html" + (email ? "?email=" + encodeURIComponent(email) : "");
    show("spDone");
  } catch (err) {
    console.error("Set password error:", err);
    setStatus(statusEl, err.message || "Could not save your password. Please try again.", true);
    submitBtn.textContent = "Save Password";
    checkRules();
  }
});

function showInvalid(message) {
  if (message) el("spInvalidMsg").textContent = message;
  show("spInvalid");
}

async function init() {
  if (linkError) {
    showInvalid(linkError.replace(/\+/g, " ") + ". Ask your administrator to send you a new link.");
    return;
  }
  // getSession() waits for the client to finish reading the link.
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session) {
    showInvalid();
    return;
  }
  el("spEmail").textContent = data.session.user?.email || "—";
  if (linkType === "recovery") {
    el("spTitle").textContent = "Choose a new password";
    el("spSub").textContent = "Enter a new password for your account.";
  } else {
    el("spTitle").textContent = "Welcome — create your password";
    el("spSub").textContent = "You've been invited to Victoria Sugar. Choose the password you'll use to sign in. Only you will know it.";
  }
  show("spForm");
  pwd.focus();
}

init().catch((err) => {
  console.error(err);
  showInvalid();
});
