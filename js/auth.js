import { createSupabaseClient } from "./supabase-client.js";
import { clearStatus, setStatus } from "./utils.js";

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

    const { data: profile, error: profileError } = await supabase
      .from("vsl_profiles")
      .select("role, is_active")
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
  const { error } = await supabase.auth.resetPasswordForEmail(target, {
    redirectTo: `${window.location.origin}/login.html`
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
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    window.location.href = "./webmap.html";
    return;
  }
}

init().catch((err) => setStatus(statusEl, err.message, true));
