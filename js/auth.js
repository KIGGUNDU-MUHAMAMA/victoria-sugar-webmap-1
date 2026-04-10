import { createSupabaseClient } from "./supabase-client.js";
import { assertRole, clearStatus, setStatus } from "./utils.js";

const supabase = createSupabaseClient();
const statusEl = document.getElementById("status");

const email = document.getElementById("email");
const password = document.getElementById("password");
const signInBtn = document.getElementById("signInBtn");

const newEmail = document.getElementById("newEmail");
const newPassword = document.getElementById("newPassword");
const role = document.getElementById("role");
const signUpBtn = document.getElementById("signUpBtn");
const forgotBtn = document.getElementById("forgotBtn");

async function handleSignIn() {
  clearStatus(statusEl);
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
    .select("role")
    .eq("id", data.user.id)
    .single();

  if (profileError || !profile?.role) {
    setStatus(statusEl, "No role profile found. Contact admin.", true);
    await supabase.auth.signOut();
    return;
  }
  sessionStorage.setItem("vsl_role", profile.role);
  window.location.href = "./webmap.html";
}

async function handleSignUp() {
  clearStatus(statusEl);
  const selectedRole = role.value;
  if (!assertRole(selectedRole)) {
    setStatus(statusEl, "Pick a valid role.", true);
    return;
  }
  const { data, error } = await supabase.auth.signUp({
    email: newEmail.value.trim(),
    password: newPassword.value,
    options: {
      data: { role: selectedRole },
      emailRedirectTo: `${window.location.origin}/login.html`
    }
  });
  if (error) {
    setStatus(statusEl, error.message, true);
    return;
  }
  if (data.user) {
    const payload = { id: data.user.id, email: data.user.email, role: selectedRole };
    await supabase.from("vsl_profiles").upsert(payload);
  }
  setStatus(statusEl, "User created. If email confirmation is enabled, verify inbox.");
}

async function handleForgotPassword() {
  clearStatus(statusEl);
  const target = email.value.trim() || newEmail.value.trim();
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

async function init() {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    window.location.href = "./webmap.html";
    return;
  }

  signInBtn.addEventListener("click", handleSignIn);
  signUpBtn.addEventListener("click", handleSignUp);
  forgotBtn.addEventListener("click", handleForgotPassword);
}

init().catch((err) => setStatus(statusEl, err.message, true));
