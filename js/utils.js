export function setStatus(el, message, isError = false) {
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle("error", Boolean(isError));
}

export function clearStatus(el) {
  el.hidden = true;
  el.textContent = "";
  el.classList.remove("error");
}

export function assertRole(role) {
  return ["ADMIN", "SURVEYOR", "MANAGMENT"].includes(role);
}

export function parseNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
