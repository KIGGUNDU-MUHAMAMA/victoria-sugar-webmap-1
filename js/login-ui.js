// Password visibility toggle for login.html.
// Sign-up UI has been removed — accounts are created by an admin from the Dashboard.
// Pure UI wiring — auth.js handles the actual sign-in logic.

function togglePwd(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "Hide";
  } else {
    input.type = "password";
    btn.textContent = "Show";
  }
}
