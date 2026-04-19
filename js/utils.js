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

export function wgs84ToUTM(lon, lat) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const eSq = 2*f - f*f;
  
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lon0 = (zone - 1) * 6 - 180 + 3;
  
  const lonRad = toRadians(lon);
  const latRad = toRadians(lat);
  const lon0Rad = toRadians(lon0);
  
  const N = a / Math.sqrt(1 - eSq * Math.pow(Math.sin(latRad), 2));
  const T = Math.pow(Math.tan(latRad), 2);
  const C = eSq * Math.pow(Math.cos(latRad), 2) / (1 - eSq);
  const A = Math.cos(latRad) * (lonRad - lon0Rad);
  
  const M = a * (
    (1 - eSq/4 - 3*eSq*eSq/64 - 5*Math.pow(eSq,3)/256) * latRad
    - (3*eSq/8 + 3*eSq*eSq/32 + 45*Math.pow(eSq,3)/1024) * Math.sin(2*latRad)
    + (15*eSq*eSq/256 + 45*Math.pow(eSq,3)/1024) * Math.sin(4*latRad)
    - (35*Math.pow(eSq,3)/3072) * Math.sin(6*latRad)
  );
  
  const x = k0 * N * (
    A + (1-T+C)*Math.pow(A,3)/6
    + (5 - 18*T + T*T + 72*C - 58*eSq)*Math.pow(A,5)/120
  ) + 500000.0;
  
  let y = k0 * (
    M + N * Math.tan(latRad) * (
      Math.pow(A,2)/2
      + (5 - T + 9*C + 4*C*C)*Math.pow(A,4)/24
      + (61 - 58*T + T*T + 600*C - 330*eSq)*Math.pow(A,6)/720
    )
  );
  
  if (lat < 0) y += 10000000.0;
  
  return [x, y];
}

export function computeUtmCartesianAreaAcres(lonLats) {
  if (!lonLats || lonLats.length < 3) return 0;
  const utmCoords = lonLats.map(pt => wgs84ToUTM(pt[0], pt[1]));
  let area = 0;
  for (let i = 0; i < utmCoords.length - 1; i++) {
    area += utmCoords[i][0] * utmCoords[i+1][1] - utmCoords[i+1][0] * utmCoords[i][1];
  }
  return (Math.abs(area) / 2) * 0.000247105381;
}
