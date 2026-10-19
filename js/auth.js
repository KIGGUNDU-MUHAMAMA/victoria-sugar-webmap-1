import { createSupabaseClient } from "./supabase-client.js";
import { clearStatus, setStatus } from "./utils.js";
import { cacheProfile } from "./role-store.js";

const supabase = createSupabaseClient();
const statusEl = document.getElementById("status");

const email = document.getElementById("email");
const password = document.getElementById("password");
const signInBtn = document.getElementById("signInBtn");
const forgotBtn = document.getElementById("forgotBtn");

// Account creation is admin-only now (Dashboard → Users), not available from this page.
async function handleSignIn() {
  clearStatus(statusEl);
  signInBtn.textContent = "Signing In...";
  signInBtn.disabled = true;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.value.trim(),
      password: password.value
    });
    if (error) {
      setStatus(statusEl, error.message, true);
      return;
    }

    // Selects the whole display profile, not just role/is_active: this is
    // the one fetch the map then reads back out of the cache instead of
    // repeating on every load (see role-store.js and initUser in map-app.js).
    const { data: profile, error: profileError } = await supabase
      .from("vsl_profiles")
      .select("id, email, role, full_name, phone, title, avatar_url, is_active")
      .eq("id", data.user.id)
      .single();

    if (profileError || !profile?.role) {
      setStatus(statusEl, "No role profile found. Contact admin.", true);
      await supabase.auth.signOut();
      return;
    }
    if (profile.is_active === false) {
      setStatus(statusEl, "This account has been deactivated. Contact an administrator.", true);
      await supabase.auth.signOut();
      return;
    }

    sessionStorage.setItem("vsl_role", profile.role);
    // The map reads this on boot instead of refetching vsl_profiles, so the
    // tool buttons are right on the first paint. Purely a UI optimisation —
    // RLS and the workers still decide what anyone can actually do.
    cacheProfile(profile);
    // Best-effort — don't block login if this fails (e.g. RLS not yet caught up).
    supabase.from("vsl_profiles").update({ last_login_at: new Date().toISOString() }).eq("id", data.user.id).then(() => {});
    window.location.href = "./webmap.html";
  } catch (err) {
    setStatus(statusEl, "An unexpected error occurred.", true);
    console.error("Sign In Error:", err);
  } finally {
    signInBtn.textContent = "Sign In";
    signInBtn.disabled = false;
  }
}

async function handleForgotPassword() {
  clearStatus(statusEl);
  const target = email.value.trim();
  if (!target) {
    setStatus(statusEl, "Enter an email first.", true);
    return;
  }
  // Lands on set-password.html, where the person actually chooses the new
  // password (this used to send them back to login.html, which just signed
  // them in without ever asking for a new password).
  const { error } = await supabase.auth.resetPasswordForEmail(target, {
    redirectTo: new URL("./set-password.html", window.location.href).href
  });
  if (error) {
    setStatus(statusEl, error.message, true);
    return;
  }
  setStatus(statusEl, "Reset link sent. Check your email.");
}

signInBtn.addEventListener("click", handleSignIn);
forgotBtn.addEventListener("click", handleForgotPassword);

async function init() {
  // Coming back from set-password.html — prefill the email.
  const prefill = new URLSearchParams(window.location.search).get("email");
  if (prefill) {
    email.value = prefill;
    password.focus();
    setStatus(statusEl, "Password saved. Sign in with your new password.");
  }
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    window.location.href = "./webmap.html";
    return;
  }
}

init().catch((err) => setStatus(statusEl, err.message, true));
