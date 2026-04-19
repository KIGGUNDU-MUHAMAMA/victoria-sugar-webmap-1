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

export function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

export function vincentyDistanceMeters(lon1, lat1, lon2, lat2) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const b = (1 - f) * a;
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const L = toRadians(lon2 - lon1);
  const U1 = Math.atan((1 - f) * Math.tan(phi1));
  const U2 = Math.atan((1 - f) * Math.tan(phi2));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);
  let lambda = L;
  let lambdaPrev = 0;
  let iter = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let sinAlpha = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;
  while (Math.abs(lambda - lambdaPrev) > 1e-12 && iter < 200) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    const t1 = cosU2 * sinLambda;
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
    sinSigma = Math.sqrt(t1 * t1 + t2 * t2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    if (cosSqAlpha !== 0) {
      cos2SigmaM = cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    } else {
      cos2SigmaM = 0;
    }
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    lambdaPrev = lambda;
    lambda =
      L +
      (1 - C) * f * sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    iter++;
  }
  if (iter >= 200) {
    const R = 6371008.8;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B * sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return b * A * (sigma - deltaSigma);
}
