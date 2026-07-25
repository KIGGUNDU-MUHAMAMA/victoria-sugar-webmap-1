// Sign In / Create Account tab switching and password visibility toggle
// for login.html. Pure UI wiring — auth.js handles the actual sign-in logic.

const tabSignIn = document.getElementById("tabSignIn");
const tabSignUp = document.getElementById("tabSignUp");
const panelSignIn = document.getElementById("panelSignIn");
const panelSignUp = document.getElementById("panelSignUp");
const statusElInline = document.getElementById("status");

function clearStatusInline() {
  if (statusElInline) {
    statusElInline.hidden = true;
    statusElInline.textContent = "";
    statusElInline.classList.remove("error");
  }
}

if (tabSignIn && tabSignUp) {
  tabSignIn.addEventListener("click", () => {
    tabSignIn.classList.add("active");
    tabSignUp.classList.remove("active");
    panelSignIn.hidden = false;
    panelSignUp.hidden = true;
    clearStatusInline();
  });
  tabSignUp.addEventListener("click", () => {
    tabSignUp.classList.add("active");
    tabSignIn.classList.remove("active");
    panelSignUp.hidden = false;
    panelSignIn.hidden = true;
    clearStatusInline();
  });
}

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
