(function() {
'use strict';

/* Proj4 defs — match crs-definitions.js */
const VSL_PROJ4_DEFS = {
  '4326':  '+proj=longlat +datum=WGS84 +no_defs',
  '32635': '+proj=utm +zone=35 +datum=WGS84 +units=m +no_defs',
  '32735': '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs',
  '32636': '+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs',
  '32736': '+proj=utm +zone=36 +south +datum=WGS84 +units=m +no_defs',
  '21035': '+proj=utm +zone=35 +south +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs',
  '21036': '+proj=utm +zone=36 +south +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs',
  '21095': '+proj=utm +zone=35 +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs',
  '21096': '+proj=utm +zone=36 +ellps=clrk80 +towgs84=-160,-6,-302,0,0,0,0 +units=m +no_defs'
};

function rvRegisterProj4() {
  if (typeof proj4 === 'undefined') return;
  for (const [code, def] of Object.entries(VSL_PROJ4_DEFS)) {
    try { proj4.defs('EPSG:'+code, def); } catch(_){}
  }
}

/* ================================================================
   STATE
================================================================ */
const RV = {
  open: false,
  watchId: null,
  pos: null,
  crs: '32736',
  crsLabel: 'UTM 36S',
  map: null,
  gpsLayer: null, gpsSource: null,
  stakeLayer: null, stakeSource: null,
  walkLayer: null, walkSource: null,
  walkCoords: [],
  recording: false,
  points: [],
  corners: [],
  stakeoutIdx: -1,
  stakeoutStart: null,
  averaging: false,
  avgReadings: [],
  avgTarget: 5,
  settings: { avgCount: 5, arrivalThresh: 2.0, proxDist: 5.0, wakeLock: true, vibrate: true },
  wakeLockSentinel: null,
  basemap: 'hybrid',
  baseLayers: {},
  selectMode: false,
  toastTimer: null,
  alertedPoints: new Set(),
  alertedEdges: new Set(),
  gnssMode: 'phone',
  serialPort: null,
  serialReader: null,
  serialReading: false,
  nmeaBuffer: '',
  fixQuality: 0,
  fixType: 'NO GPS',
  hdop: null,
  satCount: null,
  gnssLat: null, gnssLon: null, gnssAlt: null, gnssAcc: null,
  gnssSpeed: null, gnssHeading: null,
  compassMode: false,
  sessionStart: null, sessionId: null,
  clonedLayers: [],
};
window._vslRoverState = RV;

/* ================================================================
   HELPERS
================================================================ */
function rvToggleCompass() {
  RV.compassMode = !RV.compassMode;
  const btn = document.getElementById('rvCompassBtn');
  if (RV.compassMode) {
    btn.classList.add('active');
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(state => {
        if (state === 'granted') {
          window.addEventListener('deviceorientation', rvHandleDeviceOrientation, true);
        } else {
          rvToast("Compass permission denied.", 3000);
          RV.compassMode = false;
          btn.classList.remove('active');
        }
      }).catch(console.error);
    } else {
      window.addEventListener('deviceorientationabsolute', rvHandleDeviceOrientation, true);
      window.addEventListener('deviceorientation', rvHandleDeviceOrientation, true);
    }
    rvToast("Map rotation enabled.", 2000);
  } else {
    btn.classList.remove('active');
    window.removeEventListener('deviceorientationabsolute', rvHandleDeviceOrientation, true);
    window.removeEventListener('deviceorientation', rvHandleDeviceOrientation, true);
    if (RV.map) RV.map.getView().setRotation(0);
    rvToast("Map rotation disabled.", 2000);
  }
}
function rvHandleDeviceOrientation(event) {
  if (!RV.compassMode || !RV.map) return;
  let heading = null;
  if (event.webkitCompassHeading != null) heading = event.webkitCompassHeading;
  else if (event.alpha != null && event.absolute) heading = 360 - event.alpha;
  if (heading != null) RV.map.getView().setRotation(-(heading * Math.PI / 180));
}

function rvLoadPoints() { try { const d = localStorage.getItem('vslRoverPoints'); if (d) RV.points = JSON.parse(d); } catch(_) { RV.points = []; } }
function rvSavePoints() { try { localStorage.setItem('vslRoverPoints', JSON.stringify(RV.points)); } catch(_){} }
function rvLoadSettings() { try { const d = localStorage.getItem('vslRoverSettings'); if (d) Object.assign(RV.settings, JSON.parse(d)); } catch(_){} }
function rvSaveSettings() { try { localStorage.setItem('vslRoverSettings', JSON.stringify(RV.settings)); } catch(_){} }

function rvToast(msg, dur) {
  dur = dur || 3500;
  const t = document.getElementById('rvAlertToast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(RV.toastTimer);
  RV.toastTimer = setTimeout(function() { t.style.display = 'none'; }, dur);
}

function rvFormatCoord(lon, lat, crs) {
  if (crs === '4326') return { e: lon.toFixed(7) + '°E', n: lat.toFixed(7) + '°N' };
  try {
    rvRegisterProj4();
    const pt = proj4('EPSG:4326', 'EPSG:'+crs, [lon, lat]);
    return { e: pt[0].toFixed(3), n: pt[1].toFixed(3) };
  } catch(_) { return { e: '—', n: '—' }; }
}

function rvBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const y = Math.sin(dLon) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function rvHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function rvBearingLabel(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW','N'];
  return dirs[Math.round(deg/45)];
}

function rvPolyArea(coords) {
  const n = coords.length;
  if (n < 3) return 0;
  const proj = coords.map(c => ol.proj.fromLonLat(c));
  let area = 0;
  for (let i=0; i<n; i++) {
    const j = (i+1)%n;
    area += proj[i][0]*proj[j][1];
    area -= proj[j][0]*proj[i][1];
  }
  return Math.abs(area/2);
}

function rvDownload(filename, content, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], {type: mime}));
  a.download = filename;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 10000);
}

/* ================================================================
   WAKE LOCK
================================================================ */
async function rvAcquireWakeLock() {
  if (!RV.settings.wakeLock) return;
  try { if ('wakeLock' in navigator) RV.wakeLockSentinel = await navigator.wakeLock.request('screen'); }
  catch(e){ console.warn('WakeLock:', e.message); }
}
function rvReleaseWakeLock() {
  if (RV.wakeLockSentinel) { RV.wakeLockSentinel.release().catch(()=>{}); RV.wakeLockSentinel = null; }
}

/* ================================================================
   ROVER MAP INIT
================================================================ */
function rvInitMap() {
  if (RV.map) return;

  const satLayer = new ol.layer.Tile({
    source: new ol.source.XYZ({ url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', crossOrigin: 'anonymous', maxZoom: 21 })
  });
  const osmLayer2 = new ol.layer.Tile({ source: new ol.source.OSM({ crossOrigin: 'anonymous' }), visible: false });
  const topoLayer = new ol.layer.Tile({
    source: new ol.source.XYZ({ url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', crossOrigin: 'anonymous', maxZoom: 17 }),
    visible: false
  });
  const darkLayer = new ol.layer.Tile({
    source: new ol.source.XYZ({ url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}@2x.png', crossOrigin: 'anonymous', maxZoom: 20 }),
    visible: false
  });
  const noneLayer = new ol.layer.Tile({ visible: false });
  RV.baseLayers = { hybrid: satLayer, osm: osmLayer2, topo: topoLayer, dark: darkLayer, none: noneLayer };

  /* Clone vector layers from main map (share sources so data is always in sync) */
  const mainMapLayers = [];
  RV.clonedLayers = [];
  const mainMap = window._vslMap && window._vslMap();
  if (mainMap) {
    function cloneVectorLayer(lyr) {
      if (!(lyr instanceof ol.layer.Vector)) return;
      const src = lyr.getSource();
      if (!src) return;
      const clone = new ol.layer.Vector({
        source: src,
        style: lyr.getStyleFunction() || lyr.getStyle(),
        visible: lyr.getVisible(),
        zIndex: lyr.getZIndex() || 0,
        opacity: lyr.getOpacity(),
        maxResolution: lyr.getMaxResolution(),
        minResolution: lyr.getMinResolution()
      });
      lyr.on('change:visible', function() { clone.setVisible(lyr.getVisible()); });
      mainMapLayers.push(clone);
      RV.clonedLayers.push(clone);
    }
    mainMap.getLayers().forEach(function(lyr) {
      if (lyr instanceof ol.layer.Tile || lyr instanceof ol.layer.Image) return;
      if (lyr instanceof ol.layer.Group) {
        lyr.getLayers().forEach(function(sub) {
          if (sub instanceof ol.layer.Group) sub.getLayers().forEach(function(ss) { cloneVectorLayer(ss); });
          else cloneVectorLayer(sub);
        });
        return;
      }
      cloneVectorLayer(lyr);
    });
  }

  /* GPS layer */
  RV.gpsSource = new ol.source.Vector();
  RV.gpsLayer = new ol.layer.Vector({
    source: RV.gpsSource,
    style: function(feat) {
      if (feat.get('type') === 'accuracy') return new ol.style.Style({ fill: new ol.style.Fill({ color: 'rgba(59,130,246,0.12)' }), stroke: new ol.style.Stroke({ color: 'rgba(59,130,246,0.5)', width: 1 }) });
      return new ol.style.Style({ image: new ol.style.Circle({ radius: 8, fill: new ol.style.Fill({ color: '#3b82f6' }), stroke: new ol.style.Stroke({ color: '#fff', width: 2.5 }) }) });
    }, zIndex: 100
  });

  /* Stakeout layer */
  RV.stakeSource = new ol.source.Vector();
  RV.stakeLayer = new ol.layer.Vector({
    source: RV.stakeSource,
    style: new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#f59e0b', width: 2.5, lineDash: [8,5] }) }),
    zIndex: 90
  });

  /* Walk layer */
  RV.walkSource = new ol.source.Vector();
  RV.walkLayer = new ol.layer.Vector({
    source: RV.walkSource,
    style: function(feat) {
      if (feat.get('type') === 'walk') return new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#22c55e', width: 3 }) });
      return new ol.style.Style({ image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: '#22c55e' }), stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }) }) });
    }, zIndex: 80
  });

  /* Marked points layer */
  RV.ptSource = new ol.source.Vector();
  RV.ptLayer = new ol.layer.Vector({
    source: RV.ptSource,
    style: function(feat) {
      return [
        new ol.style.Style({ image: new ol.style.RegularShape({ points: 3, radius: 8, angle: Math.PI, fill: new ol.style.Fill({ color: '#f59e0b' }), stroke: new ol.style.Stroke({ color: '#000', width: 1 }) }) }),
        new ol.style.Style({ text: new ol.style.Text({ text: feat.get('name') || '', font: 'bold 10px sans-serif', fill: new ol.style.Fill({ color: '#fff' }), stroke: new ol.style.Stroke({ color: '#000', width: 3 }), offsetY: -18 }) })
      ];
    }, zIndex: 110
  });

  /* Corners layer */
  RV.cornerSource = new ol.source.Vector();
  RV.cornerLayer = new ol.layer.Vector({
    source: RV.cornerSource,
    style: function(feat) {
      const isActive = feat.get('active');
      return [
        new ol.style.Style({ image: new ol.style.Circle({ radius: 6, fill: new ol.style.Fill({ color: isActive ? '#f59e0b' : '#3b82f6' }), stroke: new ol.style.Stroke({ color: '#fff', width: 2 }) }) }),
        new ol.style.Style({ text: new ol.style.Text({ text: feat.get('label') || '', font: 'bold 10px sans-serif', fill: new ol.style.Fill({ color: '#fff' }), stroke: new ol.style.Stroke({ color: '#000', width: 3 }), offsetY: -16 }) })
      ];
    }, zIndex: 105
  });

  let initCenter = [32.5, 0.5];
  let initZoom = 12;
  try {
    const mv = (window._vslMap && window._vslMap()) ? window._vslMap().getView() : null;
    if (mv) { const c = ol.proj.toLonLat(mv.getCenter()); initCenter = c; initZoom = Math.min(mv.getZoom()+1, 21); }
  } catch(_){}

  RV.map = new ol.Map({
    target: 'rvMap',
    layers: [ satLayer, osmLayer2, topoLayer, darkLayer, noneLayer, ...mainMapLayers, RV.walkLayer, RV.stakeLayer, RV.cornerLayer, RV.ptLayer, RV.gpsLayer ],
    view: new ol.View({ center: ol.proj.fromLonLat(initCenter), zoom: initZoom, maxZoom: 22 }),
    controls: ol.control.defaults.defaults({ attribution: false, rotate: false, zoom: false })
  });

  RV.map.on('click', function(evt) { if (RV.selectMode) rvHandleMapClick(evt.coordinate); });
}

/* ================================================================
   BASEMAP SWITCHER
================================================================ */
window.rvSetBasemap = function(name) {
  RV.basemap = name;
  Object.entries(RV.baseLayers).forEach(([k,l]) => l.setVisible(k === name));
  document.querySelectorAll('.rv-bm-thumb').forEach(el => el.classList.toggle('active', el.dataset.bm === name));
};

/* ================================================================
   NMEA / EXTERNAL GNSS
================================================================ */
const GNSS_FIX_LABELS = { 0: {text:'✕ NO FIX',cls:'fix-bad'}, 1: {text:'◌ GPS',cls:'fix-warn'}, 2: {text:'◉ DGPS',cls:'fix-warn'}, 4: {text:'● RTK FIXED',cls:'fix-good'}, 5: {text:'◉ RTK FLOAT',cls:'fix-warn'} };
function nmeaLatToDeg(lat, ns) { if (!lat) return null; const d=parseInt(lat.substring(0,2),10),m=parseFloat(lat.substring(2)); return (ns==='S'?-1:1)*(d+m/60); }
function nmeaLonToDeg(lon, ew) { if (!lon) return null; const d=parseInt(lon.substring(0,3),10),m=parseFloat(lon.substring(3)); return (ew==='W'?-1:1)*(d+m/60); }
function rvParseNMEA(sentence) {
  if (!sentence || sentence.length < 6) return;
  const star = sentence.indexOf('*');
  const parts = (star>0?sentence.substring(0,star):sentence).split(',');
  const type = parts[0].substring(3);
  if (type === 'GGA') {
    const lat=nmeaLatToDeg(parts[2],parts[3]), lon=nmeaLonToDeg(parts[4],parts[5]);
    const fix=parseInt(parts[6],10)||0, sats=parseInt(parts[7],10)||0, hdop=parseFloat(parts[8])||null, alt=parseFloat(parts[9])||null;
    RV.fixQuality=fix; RV.satCount=sats; RV.hdop=hdop;
    if (lat!=null && lon!=null && fix>0) {
      RV.gnssLat=lat; RV.gnssLon=lon; RV.gnssAlt=alt;
      if (fix===4) RV.gnssAcc=hdop?hdop*0.02:0.015;
      else if (fix===5) RV.gnssAcc=hdop?hdop*0.15:0.05;
      else RV.gnssAcc=hdop?hdop*2.5:5.0;
      RV.fixType=(GNSS_FIX_LABELS[fix]||GNSS_FIX_LABELS[0]).text;
      rvOnGNSSPosition();
    }
  } else if (type==='RMC') {
    const spd=parseFloat(parts[7]), hdg=parseFloat(parts[8]);
    if (!isNaN(spd)) RV.gnssSpeed=spd*0.514444;
    if (!isNaN(hdg)) RV.gnssHeading=hdg;
  }
}
function rvOnGNSSPosition() {
  const lat=RV.gnssLat, lon=RV.gnssLon;
  if (lat==null||lon==null) return;
  const fakePos={coords:{latitude:lat,longitude:lon,accuracy:RV.gnssAcc||1.0,altitude:RV.gnssAlt,altitudeAccuracy:null,heading:RV.gnssHeading,speed:RV.gnssSpeed},timestamp:Date.now()};
  RV.pos=fakePos;
  const cv=rvFormatCoord(lon,lat,RV.crs);
  document.getElementById('rvCoordE').textContent=cv.e;
  document.getElementById('rvCoordN').textContent=cv.n;
  document.getElementById('rvAcc').textContent=RV.gnssAcc!=null?RV.gnssAcc.toFixed(3):'—';
  document.getElementById('rvAlt').textContent=RV.gnssAlt!=null?RV.gnssAlt.toFixed(1):'—';
  const lbl=GNSS_FIX_LABELS[RV.fixQuality]||GNSS_FIX_LABELS[0];
  const badge=document.getElementById('rvFixBadge');
  badge.textContent=lbl.text; badge.className=lbl.cls;
  document.getElementById('rvSats').textContent=RV.satCount!=null?RV.satCount:'—';
  if (RV.map) {
    RV.gpsSource.clear();
    const olCoord=ol.proj.fromLonLat([lon,lat]);
    RV.gpsSource.addFeatures([new ol.Feature({geometry:new ol.geom.Circle(olCoord,RV.gnssAcc||1.0),type:'accuracy'}), new ol.Feature({geometry:new ol.geom.Point(olCoord),type:'gps'})]);
  }
  if (RV.stakeoutIdx>=0 && RV.corners.length>0) rvUpdateStakeout(lat,lon);
  if (RV.recording) rvRecordTick(lon,lat);
  if (RV.averaging) rvAvgTick(fakePos);
  rvCheckProximity(lat,lon);
}
async function rvConnectGNSS() {
  if (!('serial' in navigator)) { rvToast('⚠ Web Serial not supported',5000); document.getElementById('rvSrcSel').value='phone'; RV.gnssMode='phone'; return false; }
  try {
    const port=await navigator.serial.requestPort({allowedBluetoothServiceClassIds:['00001101-0000-1000-8000-00805f9b34fb']});
    await port.open({baudRate:115200});
    RV.serialPort=port; RV.serialReading=true; RV.gnssMode='external';
    rvToast('✓ External GNSS connected',3000);
    rvStopGPS();
    rvSerialReadLoop(port);
    return true;
  } catch(err) {
    if (err.name!=='NotFoundError') rvToast('✕ GNSS failed: '+err.message,4000);
    document.getElementById('rvSrcSel').value='phone'; RV.gnssMode='phone'; return false;
  }
}
async function rvSerialReadLoop(port) {
  const decoder=new TextDecoderStream();
  const closed=port.readable.pipeTo(decoder.writable);
  RV.serialReader=decoder.readable.getReader();
  try {
    while (RV.serialReading) {
      const {value,done}=await RV.serialReader.read();
      if (done) break; if (!value) continue;
      RV.nmeaBuffer+=value;
      const lines=RV.nmeaBuffer.split(/\r?\n/);
      RV.nmeaBuffer=lines.pop();
      for (const line of lines) { const t=line.trim(); if (t.startsWith('$')) rvParseNMEA(t); }
    }
  } catch(err) { if (RV.serialReading) { rvToast('⚠ GNSS read error — using phone GPS',4000); rvDisconnectGNSS(); rvStartGPS(); } }
  finally { RV.serialReader.releaseLock(); closed.catch(()=>{}); }
}
async function rvDisconnectGNSS() {
  RV.serialReading=false; RV.gnssMode='phone';
  try { if (RV.serialReader) { await RV.serialReader.cancel(); RV.serialReader=null; } } catch(_){}
  try { if (RV.serialPort) { await RV.serialPort.close(); RV.serialPort=null; } } catch(_){}
  RV.fixQuality=0; RV.hdop=null; RV.satCount=null; RV.gnssLat=null; RV.gnssLon=null; RV.gnssAlt=null; RV.gnssAcc=null;
  rvToast('GNSS disconnected — using phone GPS',2500);
}

/* ================================================================
   SESSION REPORT
================================================================ */
function rvGenerateSessionReport() {
  const now=new Date(), start=RV.sessionStart||now;
  const dMs=now-start, dMin=Math.floor(dMs/60000), dSec=Math.floor((dMs%60000)/1000);
  const durStr=dMin+'m '+dSec+'s';
  let totalDist=0;
  if (RV.walkCoords.length>1) for (let i=1;i<RV.walkCoords.length;i++) totalDist+=rvHaversine(RV.walkCoords[i-1][1],RV.walkCoords[i-1][0],RV.walkCoords[i][1],RV.walkCoords[i][0]);
  let avgAcc='—';
  if (RV.points.length>0) { const accs=RV.points.filter(p=>p.acc!=null).map(p=>p.acc); if (accs.length>0) avgAcc=(accs.reduce((a,b)=>a+b,0)/accs.length).toFixed(2)+'m'; }
  let ptRows='';
  RV.points.forEach((p,i)=>{ const cv=rvFormatCoord(p.lon,p.lat,RV.crs); ptRows+=`<tr><td>${i+1}</td><td>${p.name||p.id}</td><td>${cv.e}</td><td>${cv.n}</td><td>${p.acc!=null?p.acc.toFixed(2)+'m':'—'}</td><td>${p.desc||''}</td></tr>`; });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VSL Rover Session Report — ${RV.sessionId||'Session'}</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b;padding:24px;}.header{background:linear-gradient(135deg,#0d1117,#1e293b);color:#f8fafc;padding:24px;border-radius:12px;margin-bottom:20px;}.header h1{font-size:22px;color:#f59e0b;margin-bottom:4px;}.badge{display:inline-block;background:#f59e0b;color:#0d1117;padding:2px 10px;border-radius:4px;font-weight:700;font-size:12px;margin-top:8px;}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px;}.stat-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;text-align:center;}.stat-card .value{font-size:28px;font-weight:800;color:#0d1117;}.stat-card .label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;}table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;margin-bottom:20px;}th{background:#1e293b;color:#f59e0b;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;text-align:left;}td{padding:8px 12px;font-size:13px;border-bottom:1px solid #e2e8f0;}.footer{text-align:center;color:#94a3b8;font-size:11px;padding:12px 0;border-top:1px solid #e2e8f0;margin-top:20px;}.disclaimer{background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px 16px;font-size:12px;color:#92400e;margin-bottom:20px;}</style></head><body>
<div class="header"><h1>🛰 ROVER — Session Report</h1><p>Victoria Sugar Limited | Session: ${RV.sessionId||'—'}</p><p>Date: ${start.toLocaleDateString()} ${start.toLocaleTimeString()} — ${now.toLocaleTimeString()}</p><span class="badge">CRS: ${RV.crsLabel}</span>${RV.gnssMode==='external'?'<span class="badge" style="margin-left:6px;">External GNSS</span>':''}</div>
<div class="stats"><div class="stat-card"><div class="value">${durStr}</div><div class="label">Duration</div></div><div class="stat-card"><div class="value">${RV.points.length}</div><div class="label">Points Captured</div></div><div class="stat-card"><div class="value">${totalDist>0?totalDist.toFixed(1)+'m':'—'}</div><div class="label">Distance Walked</div></div><div class="stat-card"><div class="value">${avgAcc}</div><div class="label">Avg Accuracy</div></div></div>
${RV.points.length>0?`<h3 style="margin-bottom:10px;font-size:15px;">Captured Points</h3><table><thead><tr><th>#</th><th>Name</th><th>Easting</th><th>Northing</th><th>Accuracy</th><th>Description</th></tr></thead><tbody>${ptRows}</tbody></table>`:'<p style="color:#64748b;margin-bottom:20px;">No points captured during this session.</p>'}
<div class="disclaimer">⚠ <strong>Disclaimer:</strong> Coordinates shown are from ${RV.gnssMode==='external'?'an external GNSS receiver':'device GPS'} and are for reference/reconnaissance purposes only. They do not constitute a professional survey.</div>
<div class="footer"><p>Generated by Victoria Sugar Rover — ${now.toISOString()}</p><p>© Victoria Sugar Limited</p></div></body></html>`;
}

function rvDownloadSessionReport() {
  const html=rvGenerateSessionReport();
  const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
  const a=document.createElement('a');
  a.href=url;
  const ts=new Date().toISOString().replace(/[:.]/g,'-').substring(0,19);
  a.download='VSL-ROVER-Report-'+ts+'.html';
  a.click();
  URL.revokeObjectURL(url);
  rvToast('📄 Session report downloaded',3000);
}

/* ================================================================
   GPS TRACKING
================================================================ */
function rvStartGPS() {
  if (!navigator.geolocation) { rvToast('Geolocation not supported!',4000); return; }
  const opts={enableHighAccuracy:true,timeout:30000,maximumAge:0};
  RV.watchId=navigator.geolocation.watchPosition(rvOnGPS,rvOnGPSErr,opts);
}
function rvStopGPS() { if (RV.watchId!==null) { navigator.geolocation.clearWatch(RV.watchId); RV.watchId=null; } }

function rvOnGPS(pos) {
  RV.pos=pos;
  const {latitude:lat,longitude:lon,accuracy,altitude}=pos.coords;
  const cv=rvFormatCoord(lon,lat,RV.crs);
  document.getElementById('rvCoordE').textContent=cv.e;
  document.getElementById('rvCoordN').textContent=cv.n;
  document.getElementById('rvAcc').textContent=accuracy!=null?accuracy.toFixed(1):'—';
  document.getElementById('rvAlt').textContent=altitude!=null?altitude.toFixed(1):'—';
  const badge=document.getElementById('rvFixBadge');
  if (accuracy<=1.5)       {badge.textContent='● RTK FIXED';badge.className='fix-good';}
  else if (accuracy<=5)    {badge.textContent='◉ DGPS';     badge.className='fix-warn';}
  else if (accuracy<=20)   {badge.textContent='◌ GPS';      badge.className='fix-warn';}
  else                     {badge.textContent='✕ POOR';     badge.className='fix-bad'; }
  document.getElementById('rvSats').textContent='—';
  if (RV.map) {
    RV.gpsSource.clear();
    const olCoord=ol.proj.fromLonLat([lon,lat]);
    RV.gpsSource.addFeatures([new ol.Feature({geometry:new ol.geom.Circle(olCoord,accuracy),type:'accuracy'}), new ol.Feature({geometry:new ol.geom.Point(olCoord),type:'gps'})]);
  }
  if (RV.stakeoutIdx>=0 && RV.corners.length>0) rvUpdateStakeout(lat,lon);
  if (RV.recording) rvRecordTick(lon,lat);
  if (RV.averaging) rvAvgTick(pos);
  rvCheckProximity(lat,lon);
}
function rvOnGPSErr() {
  document.getElementById('rvFixBadge').textContent='✕ ERROR';
  document.getElementById('rvFixBadge').className='fix-bad';
  document.getElementById('rvCoordE').textContent='—';
  document.getElementById('rvCoordN').textContent='—';
}

/* ================================================================
   MARK POINT
================================================================ */
function rvOpenMarkModal() {
  document.getElementById('rvMarkName').value='C'+(RV.points.length+1);
  document.getElementById('rvMarkDesc').value='';
  document.getElementById('rvMarkAvg').checked=true;
  document.getElementById('rvAvgProgress').style.display='none';
  document.getElementById('rvAvgStatus').textContent='';
  rvRefreshPtList();
  document.getElementById('rvMarkModal').classList.add('rv-modal-open');
}
function rvRefreshPtList() {
  const list=document.getElementById('rvPtList');
  const count=document.getElementById('rvPtCount');
  count.textContent=RV.points.length;
  list.innerHTML='';
  RV.points.forEach((p,idx)=>{
    const cv=rvFormatCoord(p.lon,p.lat,RV.crs);
    const row=document.createElement('div');
    row.className='rv-pt-row';
    row.innerHTML=`<b>${p.name}</b><span>${cv.e}, ${cv.n}</span><button class="rv-pt-del" data-idx="${idx}">🗑</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.rv-pt-del').forEach(btn=>{
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      RV.points.splice(parseInt(this.dataset.idx),1);
      rvSavePoints(); rvRefreshPtList(); rvRefreshPtLayer();
    });
  });
}
function rvRefreshPtLayer() {
  if (!RV.ptSource) return;
  RV.ptSource.clear();
  RV.points.forEach(p=>{
    RV.ptSource.addFeature(new ol.Feature({geometry:new ol.geom.Point(ol.proj.fromLonLat([p.lon,p.lat])),name:p.name}));
  });
}
function rvDoMarkPoint() {
  if (!RV.pos) { rvToast('No GPS fix yet!'); return; }
  const name=document.getElementById('rvMarkName').value.trim()||('C'+(RV.points.length+1));
  const desc=document.getElementById('rvMarkDesc').value.trim();
  if (document.getElementById('rvMarkAvg').checked) rvStartAveraging(name,desc);
  else rvSavePoint(name,desc,RV.pos.coords.longitude,RV.pos.coords.latitude,RV.pos.coords.accuracy,RV.pos.coords.altitude);
}
function rvStartAveraging(name,desc) {
  RV.avgReadings=[]; RV.avgTarget=RV.settings.avgCount; RV.averaging=true;
  document.getElementById('rvAvgProgress').style.display='block';
  document.getElementById('rvAvgProgressFill').style.width='0%';
  document.getElementById('rvAvgStatus').textContent='Reading 0 / '+RV.avgTarget+'…';
  document.getElementById('rvMarkSaveBtn').disabled=true;
  document.getElementById('rvMarkSaveBtn').textContent='Averaging…';
  RV._avgName=name; RV._avgDesc=desc;
}
function rvAvgTick(pos) {
  if (!RV.averaging) return;
  RV.avgReadings.push({lon:pos.coords.longitude,lat:pos.coords.latitude,acc:pos.coords.accuracy,alt:pos.coords.altitude});
  const pct=Math.round(RV.avgReadings.length/RV.avgTarget*100);
  document.getElementById('rvAvgProgressFill').style.width=pct+'%';
  document.getElementById('rvAvgStatus').textContent='Reading '+RV.avgReadings.length+' / '+RV.avgTarget+'…';
  if (RV.avgReadings.length>=RV.avgTarget) {
    RV.averaging=false;
    const avgLon=RV.avgReadings.reduce((s,r)=>s+r.lon,0)/RV.avgReadings.length;
    const avgLat=RV.avgReadings.reduce((s,r)=>s+r.lat,0)/RV.avgReadings.length;
    const avgAcc=RV.avgReadings.reduce((s,r)=>s+r.acc,0)/RV.avgReadings.length;
    const avgAlt=RV.avgReadings.reduce((s,r)=>s+(r.alt||0),0)/RV.avgReadings.length;
    rvSavePoint(RV._avgName,RV._avgDesc,avgLon,avgLat,avgAcc,avgAlt);
    document.getElementById('rvMarkSaveBtn').disabled=false;
    document.getElementById('rvMarkSaveBtn').textContent=' MARK';
  }
}
function rvSavePoint(name,desc,lon,lat,acc,alt) {
  const pt={id:Date.now(),name,desc,lon,lat,acc:acc||0,alt:alt||0,ts:new Date().toISOString()};
  RV.points.push(pt); rvSavePoints(); rvRefreshPtList(); rvRefreshPtLayer();
  rvToast('Point "'+name+'" saved!');
  if (RV.map) RV.map.getView().animate({center:ol.proj.fromLonLat([lon,lat]),zoom:18,duration:600});
}

/* ================================================================
   PARCEL / BLOCK SELECT MODE
================================================================ */
function rvToggleSelectMode() {
  RV.selectMode=!RV.selectMode;
  const btn=document.getElementById('rvSelectBtn');
  btn.classList.toggle('rv-active',RV.selectMode);
  btn.title=RV.selectMode?'Tap map to select block/parcel…':'Select Block/Parcel';
  document.getElementById('rvMap').style.cursor=RV.selectMode?'crosshair':'';
  if (RV.selectMode) rvToast('Tap a block or parcel on the map',3000);
}

function rvHandleMapClick(coord) {
  const lonLat=ol.proj.toLonLat(coord);
  let corners=null;

  /* Try main map vector sources (blocksLayer / parcelsLayer) */
  const mainMap=window._vslMap && window._vslMap();
  if (mainMap) {
    const pixel=mainMap.getPixelFromCoordinate(ol.proj.transform(coord,'EPSG:3857',mainMap.getView().getProjection()));
    if (pixel) {
      mainMap.forEachFeatureAtPixel(pixel,function(feature){
        if (corners) return;
        const geom=feature.getGeometry(); if (!geom) return;
        const type=geom.getType();
        if (type==='Polygon') {
          const ring=geom.getCoordinates()[0];
          corners=ring.map(c=>{ const ll=ol.proj.toLonLat(c,mainMap.getView().getProjection().getCode()); return {lon:ll[0],lat:ll[1]}; });
        } else if (type==='MultiPolygon') {
          const ring=geom.getCoordinates()[0][0];
          corners=ring.map(c=>{ const ll=ol.proj.toLonLat(c,mainMap.getView().getProjection().getCode()); return {lon:ll[0],lat:ll[1]}; });
        }
      });
    }
  }

  /* Fallback: rover map itself */
  if (!corners && RV.map) {
    RV.map.forEachFeatureAtPixel(RV.map.getPixelFromCoordinate(coord),function(feature){
      if (corners) return;
      const geom=feature.getGeometry(); if (!geom) return;
      const type=geom.getType();
      if (type==='Polygon') corners=geom.getCoordinates()[0].map(c=>{ const ll=ol.proj.toLonLat(c); return {lon:ll[0],lat:ll[1]}; });
    });
  }

  if (!corners || corners.length<2) {
    rvToast('No polygon found here. Zoom in and tap a block or parcel.',3000);
    RV.selectMode=false;
    document.getElementById('rvSelectBtn').classList.remove('rv-active');
    document.getElementById('rvMap').style.cursor='';
    return;
  }

  /* Remove duplicate closing vertex */
  if (corners.length>1) {
    const first=corners[0], last=corners[corners.length-1];
    if (Math.abs(first.lon-last.lon)<1e-9 && Math.abs(first.lat-last.lat)<1e-9) corners.pop();
  }

  RV.corners=corners;
  rvShowCorners();
  RV.selectMode=false;
  document.getElementById('rvSelectBtn').classList.remove('rv-active');
  document.getElementById('rvMap').style.cursor='';
  rvToast('Selected polygon: '+corners.length+' corners',2500);
}

function rvShowCorners() {
  if (!RV.cornerSource) return;
  RV.cornerSource.clear();
  RV.corners.forEach((c,i)=>{
    RV.cornerSource.addFeature(new ol.Feature({geometry:new ol.geom.Point(ol.proj.fromLonLat([c.lon,c.lat])),label:'C'+(i+1),active:i===RV.stakeoutIdx}));
  });
  const list=document.getElementById('rvCornerList');
  list.innerHTML='';
  RV.corners.forEach((c,i)=>{
    const cv=rvFormatCoord(c.lon,c.lat,RV.crs);
    const row=document.createElement('div');
    row.className='rv-corner-item'+(i===RV.stakeoutIdx?' rv-active-corner':'');
    row.innerHTML=`<span class="rv-corner-idx">C${i+1}</span><span class="rv-corner-coords">${cv.e} / ${cv.n}</span><button class="rv-corner-go" onclick="rvGoToCorner(${i})">GO→</button>`;
    list.appendChild(row);
  });
  document.getElementById('rvCornerPanel').classList.add('rv-cp-active');
}

/* ================================================================
   STAKEOUT
================================================================ */
window.rvGoToCorner=function(idx) {
  if (!RV.corners[idx]) return;
  RV.stakeoutIdx=idx; RV.stakeoutStart=null;
  document.getElementById('rvStakeoutPanel').classList.add('rv-so-active');
  document.getElementById('rvSoLabel').textContent='→ C'+(idx+1);
  rvShowCorners();
  if (RV.pos) rvUpdateStakeout(RV.pos.coords.latitude,RV.pos.coords.longitude);
  rvToast('Navigating to C'+(idx+1),2000);
};

function rvUpdateStakeout(userLat,userLon) {
  if (RV.stakeoutIdx<0||!RV.corners[RV.stakeoutIdx]) return;
  const tgt=RV.corners[RV.stakeoutIdx];
  const dist=rvHaversine(userLat,userLon,tgt.lat,tgt.lon);
  const bear=rvBearing(userLat,userLon,tgt.lat,tgt.lon);
  if (RV.stakeoutStart===null) RV.stakeoutStart=dist;
  document.getElementById('rvSoDist').textContent=dist<1000?dist.toFixed(1)+'m':(dist/1000).toFixed(3)+'km';
  document.getElementById('rvSoBearing').textContent=bear.toFixed(1)+'° '+rvBearingLabel(bear);
  const pct=RV.stakeoutStart>0?Math.min(100,(1-dist/RV.stakeoutStart)*100):0;
  document.getElementById('rvSoProgressFill').style.width=pct+'%';
  if (RV.stakeSource) {
    RV.stakeSource.clear();
    RV.stakeSource.addFeature(new ol.Feature({geometry:new ol.geom.LineString([ol.proj.fromLonLat([userLon,userLat]),ol.proj.fromLonLat([tgt.lon,tgt.lat])])}));
  }
  if (dist<=RV.settings.arrivalThresh) rvOnArrival();
}

function rvOnArrival() {
  if (RV.settings.vibrate&&navigator.vibrate) navigator.vibrate([200,100,200,100,400]);
  rvToast('🎯 Arrived at C'+(RV.stakeoutIdx+1)+'!',4000);
  const next=RV.stakeoutIdx+1;
  if (next<RV.corners.length) setTimeout(()=>window.rvGoToCorner(next),1500);
  else setTimeout(()=>{ document.getElementById('rvStakeoutPanel').classList.remove('rv-so-active'); RV.stakeoutIdx=-1; RV.stakeSource&&RV.stakeSource.clear(); rvToast('✅ All corners visited!',4000); },1500);
}

/* ================================================================
   BOUNDARY WALK RECORDING
================================================================ */
function rvStartRecording() {
  if (!RV.pos) { rvToast('No GPS fix yet!'); return; }
  RV.recording=true; RV.walkCoords=[];
  if (RV.walkSource) RV.walkSource.clear();
  document.getElementById('rvRecordBanner').classList.add('rv-recording');
  document.getElementById('rvRecordBtn').classList.add('rv-green-btn');
  rvToast('🔴 Recording boundary walk…',2000);
}
function rvStopRecording() {
  RV.recording=false;
  document.getElementById('rvRecordBanner').classList.remove('rv-recording');
  document.getElementById('rvRecordBtn').classList.remove('rv-green-btn');
  if (RV.walkCoords.length<3) { rvToast('Need at least 3 points for area',3000); return; }
  const area=rvPolyArea(RV.walkCoords);
  rvToast('Area: '+area.toFixed(0)+'m² | '+(area/10000).toFixed(3)+'ha | '+(area/4046.856).toFixed(3)+'ac',6000);
}
function rvRecordTick(lon,lat) {
  const coords=RV.walkCoords;
  if (coords.length>0) { const last=coords[coords.length-1]; if (rvHaversine(lat,lon,last[1],last[0])<1.0) return; }
  coords.push([lon,lat]);
  if (RV.walkSource&&coords.length>=2) {
    RV.walkSource.clear();
    RV.walkSource.addFeature(new ol.Feature({geometry:new ol.geom.LineString(coords.map(c=>ol.proj.fromLonLat(c))),type:'walk'}));
  }
  let totalDist=0;
  for (let i=1;i<coords.length;i++) totalDist+=rvHaversine(coords[i-1][1],coords[i-1][0],coords[i][1],coords[i][0]);
  document.getElementById('rvRecInfo').textContent='Recording… '+coords.length+' pts | '+totalDist.toFixed(1)+' m';
}

/* ================================================================
   AREA CALCULATOR
================================================================ */
function rvShowAreaModal() {
  let pts, src;
  if (RV.walkCoords.length>=3) { pts=RV.walkCoords; src='walked boundary'; }
  else if (RV.corners.length>=3) { pts=RV.corners.map(c=>[c.lon,c.lat]); src='selected polygon corners'; }
  else if (RV.points.length>=3) { pts=RV.points.map(p=>[p.lon,p.lat]); src='marked points'; }
  else { rvToast('Need ≥3 points (walk, corners, or marked)',3000); return; }
  document.getElementById('rvAreaPtSource').textContent=src;
  document.getElementById('rvAreaModal').classList.add('rv-modal-open');
  const area=rvPolyArea(pts);
  document.getElementById('rvAreaResult').textContent=area.toFixed(2)+' m²';
  document.getElementById('rvAreaResultSub').textContent=(area/10000).toFixed(4)+' ha  |  '+(area/4046.856).toFixed(4)+' acres  |  '+(area/0.09290304).toFixed(2)+' ft²';
}

/* ================================================================
   PROXIMITY ALERTS
================================================================ */
function rvCheckProximity(userLat,userLon) {
  const thresh=RV.settings.proxDist;
  RV.points.forEach(p=>{
    const d=rvHaversine(userLat,userLon,p.lat,p.lon), key='pt_'+p.id;
    if (d<=thresh&&!RV.alertedPoints.has(key)) { RV.alertedPoints.add(key); rvToast('⚠ Approaching "'+p.name+'" ('+d.toFixed(1)+'m)',4000); if (RV.settings.vibrate&&navigator.vibrate) navigator.vibrate([100,50,100]); }
    else if (d>thresh*2) RV.alertedPoints.delete(key);
  });
  if (RV.stakeoutIdx<0) {
    RV.corners.forEach((c,i)=>{
      const d=rvHaversine(userLat,userLon,c.lat,c.lon), key='co_'+i;
      if (d<=thresh&&!RV.alertedPoints.has(key)) { RV.alertedPoints.add(key); rvToast('⚠ Approaching corner C'+(i+1)+' ('+d.toFixed(1)+'m)',4000); if (RV.settings.vibrate&&navigator.vibrate) navigator.vibrate([100,50,100]); }
      else if (d>thresh*2) RV.alertedPoints.delete(key);
    });
  }
}

/* ================================================================
   EXPORTS
================================================================ */
function rvExportCSV() {
  if (RV.points.length===0) { rvToast('No points to export',2000); return; }
  const isLatLon=(RV.crs==='4326');
  let csv=(isLatLon?'Name,Description,Longitude,Latitude':'Name,Description,Easting,Northing')+',Accuracy_m,Altitude_m,CRS,Timestamp\n';
  RV.points.forEach(p=>{
    const cv=rvFormatCoord(p.lon,p.lat,RV.crs);
    const eVal=cv.e.replace('°E','').replace('°N',''), nVal=cv.n.replace('°E','').replace('°N','');
    csv+=`"${p.name}","${p.desc}",${eVal},${nVal},${p.acc},${p.alt},"EPSG:${RV.crs}","${p.ts}"\n`;
  });
  rvDownload('vsl_rover_points_'+Date.now()+'.csv',csv,'text/csv');
  rvToast('CSV downloaded!');
}
function rvExportKML() {
  let poly=null;
  if (RV.walkCoords.length>=3) poly=RV.walkCoords;
  else if (RV.corners.length>=3) poly=RV.corners.map(c=>[c.lon,c.lat]);
  else if (RV.points.length>=3) poly=RV.points.map(p=>[p.lon,p.lat]);
  let kml='<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n<name>VSL Rover Export</name>\n';
  RV.points.forEach(p=>{ kml+=`<Placemark><name>${p.name}</name><description>${p.desc}</description><Point><coordinates>${p.lon},${p.lat},${p.alt}</coordinates></Point></Placemark>\n`; });
  if (poly&&poly.length>=3) { const closed=[...poly,poly[0]]; kml+=`<Placemark><name>Boundary</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${closed.map(c=>`${c[0]},${c[1]},0`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>\n`; }
  kml+='</Document>\n</kml>';
  rvDownload('vsl_rover_'+Date.now()+'.kml',kml,'application/vnd.google-earth.kml+xml');
  rvToast('KML downloaded!');
}
function rvExportDXF() {
  const dxfCrs=(RV.crs==='4326')?'32736':RV.crs;
  function toXY(lon,lat) { try { rvRegisterProj4(); return proj4('EPSG:4326','EPSG:'+dxfCrs,[lon,lat]); } catch(_){ return [lon,lat]; } }
  let dxf='0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n3\n';
  dxf+='0\nLAYER\n2\nPOINTS\n70\n0\n62\n2\n6\nCONTINUOUS\n';
  dxf+='0\nLAYER\n2\nBOUNDARY\n70\n0\n62\n3\n6\nCONTINUOUS\n';
  dxf+='0\nLAYER\n2\nCORNERS\n70\n0\n62\n5\n6\nCONTINUOUS\n';
  dxf+='0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';
  RV.points.forEach(p=>{ const xy=toXY(p.lon,p.lat); dxf+=`0\nPOINT\n8\nPOINTS\n10\n${xy[0].toFixed(3)}\n20\n${xy[1].toFixed(3)}\n30\n${(p.alt||0).toFixed(3)}\n`; dxf+=`0\nTEXT\n8\nPOINTS\n10\n${xy[0].toFixed(3)}\n20\n${xy[1].toFixed(3)}\n30\n0.000\n40\n0.5\n1\n${p.name}\n`; });
  let polyPts=[];
  if (RV.walkCoords.length>=2) polyPts=RV.walkCoords;
  else if (RV.corners.length>=2) polyPts=RV.corners.map(c=>[c.lon,c.lat]);
  if (polyPts.length>=2) { dxf+='0\nPOLYLINE\n8\nBOUNDARY\n66\n1\n70\n1\n'; polyPts.forEach(p=>{ const xy=toXY(p[0],p[1]); dxf+=`0\nVERTEX\n8\nBOUNDARY\n10\n${xy[0].toFixed(3)}\n20\n${xy[1].toFixed(3)}\n30\n0.000\n`; }); dxf+='0\nSEQEND\n'; }
  RV.corners.forEach((c,i)=>{ const xy=toXY(c.lon,c.lat); dxf+=`0\nPOINT\n8\nCORNERS\n10\n${xy[0].toFixed(3)}\n20\n${xy[1].toFixed(3)}\n30\n0.000\n`; dxf+=`0\nTEXT\n8\nCORNERS\n10\n${xy[0].toFixed(3)}\n20\n${xy[1].toFixed(3)}\n30\n0.000\n40\n0.5\n1\nC${i+1}\n`; });
  dxf+='0\nENDSEC\n0\nEOF\n';
  rvDownload('vsl_rover_'+Date.now()+'.dxf',dxf,'application/dxf');
  rvToast('DXF downloaded!');
}

/* ================================================================
   OPEN / CLOSE ROVER
================================================================ */
function rvOpen() {
  if (RV.open) return;
  RV.open=true;
  rvLoadPoints(); rvLoadSettings();
  RV.sessionStart=new Date();
  const ts=RV.sessionStart.toISOString().replace(/[-:T]/g,'').substring(0,12);
  RV.sessionId='ROVER-'+ts;
  RV.gnssMode='phone';
  document.getElementById('rvSrcSel').value='phone';
  document.getElementById('vslRoverOverlay').classList.add('rv-open');
  rvRegisterProj4();
  rvInitMap();
  setTimeout(function(){ if (RV.map) RV.map.updateSize(); },100);
  rvStartGPS();
  rvAcquireWakeLock();
  rvRefreshPtLayer();
}

function rvClose() {
  if (!RV.open) return;
  const dur=RV.sessionStart?Math.round((Date.now()-RV.sessionStart.getTime())/60000):0;
  const hrs=Math.floor(dur/60), mins=dur%60;
  const durStr=hrs>0?hrs+'h '+mins+'m':mins+'m';
  const src=RV.gnssMode==='external'?'External GNSS':'Phone GPS';
  let html='<table style="width:100%;border-collapse:collapse;">';
  html+='<tr><td style="padding:3px 6px;">⏱ Duration</td><td style="padding:3px 6px;font-weight:600;">'+durStr+'</td></tr>';
  html+='<tr><td style="padding:3px 6px;">📌 Points Captured</td><td style="padding:3px 6px;font-weight:600;">'+RV.points.length+'</td></tr>';
  html+='<tr><td style="padding:3px 6px;">🚶 Walk Points</td><td style="padding:3px 6px;font-weight:600;">'+RV.walkCoords.length+'</td></tr>';
  html+='<tr><td style="padding:3px 6px;">📡 Source</td><td style="padding:3px 6px;font-weight:600;">'+src+'</td></tr>';
  html+='</table>';
  document.getElementById('rvExitSummary').innerHTML=html;
  document.getElementById('rvExitModal').classList.add('rv-modal-open');
}

function rvDoClose(downloadReport) {
  if (!RV.open) return;
  RV.open=false; RV.selectMode=false;
  if (RV.recording) rvStopRecording();
  rvStopGPS();
  if (RV.gnssMode==='external'||RV.serialPort) { try { rvDisconnectGNSS(); } catch(_){} }
  rvReleaseWakeLock();
  if (downloadReport) rvDownloadSessionReport();
  if (RV.map) { RV.map.setTarget(null); RV.map.dispose(); RV.map=null; }
  RV.gpsSource=null; RV.gpsLayer=null;
  RV.stakeSource=null; RV.stakeLayer=null;
  RV.walkSource=null; RV.walkLayer=null;
  RV.ptSource=null; RV.ptLayer=null;
  RV.cornerSource=null; RV.cornerLayer=null;
  RV.clonedLayers=[]; RV.baseLayers=null;
  document.getElementById('vslRoverOverlay').classList.remove('rv-open');
  ['rvMarkModal','rvCrsModal','rvExportModal','rvSettingsModal','rvAreaModal','rvExitModal'].forEach(id=>{
    document.getElementById(id).classList.remove('rv-modal-open');
  });
}

/* ================================================================
   WIRE UP UI
================================================================ */
document.addEventListener('DOMContentLoaded',function() {
  const openBtn=document.getElementById('vslRoverBtn');
  if (openBtn) openBtn.addEventListener('click',rvOpen);

  document.getElementById('rvExitBtn').addEventListener('click',rvClose);
  document.getElementById('rvCompassBtn').addEventListener('click',rvToggleCompass);

  document.getElementById('rvCrsBtn').addEventListener('click',function(){
    document.getElementById('rvCrsModal').classList.add('rv-modal-open');
  });
  document.getElementById('rvCrsApplyBtn').addEventListener('click',function(){
    const sel=document.getElementById('rvCrsSelect');
    RV.crs=sel.value;
    RV.crsLabel=sel.options[sel.selectedIndex].text.replace(' ★','');
    document.getElementById('rvCrsBtn').textContent=RV.crsLabel.substring(0,14)+' ▾';
    document.getElementById('rvCrsModal').classList.remove('rv-modal-open');
    if (RV.pos) rvOnGPS(RV.pos);
    rvRefreshPtList(); rvShowCorners();
  });
  document.getElementById('rvCrsCancelBtn').addEventListener('click',function(){
    document.getElementById('rvCrsModal').classList.remove('rv-modal-open');
  });

  document.getElementById('rvMarkBtn').addEventListener('click',rvOpenMarkModal);
  document.getElementById('rvMarkSaveBtn').addEventListener('click',rvDoMarkPoint);
  document.getElementById('rvMarkCancelBtn').addEventListener('click',function(){
    RV.averaging=false;
    document.getElementById('rvMarkModal').classList.remove('rv-modal-open');
  });
  document.getElementById('rvClearPtsBtn').addEventListener('click',function(){
    if (confirm('Clear ALL captured points? This cannot be undone.')) {
      RV.points=[]; rvSavePoints(); rvRefreshPtList(); rvRefreshPtLayer();
    }
  });

  document.getElementById('rvSelectBtn').addEventListener('click',rvToggleSelectMode);

  document.getElementById('rvRecordBtn').addEventListener('click',function(){
    if (RV.recording) rvStopRecording(); else rvStartRecording();
  });
  document.getElementById('rvRecStopBtn').addEventListener('click',rvStopRecording);

  document.getElementById('rvAreaBtn').addEventListener('click',rvShowAreaModal);
  document.getElementById('rvAreaCalcBtn').addEventListener('click',rvShowAreaModal);
  document.getElementById('rvAreaCloseBtn').addEventListener('click',function(){ document.getElementById('rvAreaModal').classList.remove('rv-modal-open'); });

  document.getElementById('rvExportBtn').addEventListener('click',function(){ document.getElementById('rvExportModal').classList.add('rv-modal-open'); });
  document.getElementById('rvExportCsvBtn').addEventListener('click',rvExportCSV);
  document.getElementById('rvExportKmlBtn').addEventListener('click',rvExportKML);
  document.getElementById('rvExportDxfBtn').addEventListener('click',rvExportDXF);
  document.getElementById('rvExportCloseBtn').addEventListener('click',function(){ document.getElementById('rvExportModal').classList.remove('rv-modal-open'); });

  document.getElementById('rvSrcSel').addEventListener('change',async function(){
    if (this.value==='external') { const ok=await rvConnectGNSS(); if (!ok) this.value='phone'; }
    else { if (RV.gnssMode==='external'||RV.serialPort) await rvDisconnectGNSS(); RV.gnssMode='phone'; rvStartGPS(); }
  });

  document.getElementById('rvExitReportBtn').addEventListener('click',function(){ rvDoClose(true); });
  document.getElementById('rvExitNoReportBtn').addEventListener('click',function(){ rvDoClose(false); });
  document.getElementById('rvExitCancelBtn').addEventListener('click',function(){ document.getElementById('rvExitModal').classList.remove('rv-modal-open'); });

  document.getElementById('rvBasemapBar').addEventListener('click',function(e){
    const thumb=e.target.closest('.rv-bm-thumb'); if (!thumb) return;
    const bm=thumb.dataset.bm; if (bm) window.rvSetBasemap(bm);
    document.getElementById('rvBasemapBar').classList.remove('rv-bm-open');
  });

  document.getElementById('rvActionToggle').addEventListener('click',function(){
    const btns=document.getElementById('rvActionBtns');
    const collapsed=btns.classList.toggle('rv-collapsed');
    this.innerHTML=collapsed?'▼ Tools':'▲ Tools';
  });

  document.getElementById('rvBasemapBtn').addEventListener('click',function(){
    document.getElementById('rvBasemapBar').classList.toggle('rv-bm-open');
  });

  document.getElementById('rvSettingsBtn').addEventListener('click',function(){
    document.getElementById('rvAvgCount').value=RV.settings.avgCount;
    document.getElementById('rvArrivalThresh').value=RV.settings.arrivalThresh;
    document.getElementById('rvProxDist').value=RV.settings.proxDist;
    document.getElementById('rvWakeLockChk').checked=RV.settings.wakeLock;
    document.getElementById('rvVibrateChk').checked=RV.settings.vibrate;
    document.getElementById('rvSettingsModal').classList.add('rv-modal-open');
  });
  document.getElementById('rvSettingsSaveBtn').addEventListener('click',function(){
    RV.settings.avgCount=parseInt(document.getElementById('rvAvgCount').value)||5;
    RV.settings.arrivalThresh=parseFloat(document.getElementById('rvArrivalThresh').value)||2.0;
    RV.settings.proxDist=parseFloat(document.getElementById('rvProxDist').value)||5.0;
    RV.settings.wakeLock=document.getElementById('rvWakeLockChk').checked;
    RV.settings.vibrate=document.getElementById('rvVibrateChk').checked;
    rvSaveSettings();
    document.getElementById('rvSettingsModal').classList.remove('rv-modal-open');
    rvToast('Settings saved!',2000);
  });
  document.getElementById('rvSettingsCancelBtn').addEventListener('click',function(){ document.getElementById('rvSettingsModal').classList.remove('rv-modal-open'); });

  document.getElementById('rvSoPrevBtn').addEventListener('click',function(){ const p=RV.stakeoutIdx-1; if (p>=0) window.rvGoToCorner(p); });
  document.getElementById('rvSoNextBtn').addEventListener('click',function(){ const n=RV.stakeoutIdx+1; if (n<RV.corners.length) window.rvGoToCorner(n); });
  document.getElementById('rvSoExitBtn').addEventListener('click',function(){
    RV.stakeoutIdx=-1;
    document.getElementById('rvStakeoutPanel').classList.remove('rv-so-active');
    if (RV.stakeSource) RV.stakeSource.clear();
    rvShowCorners();
  });

  document.getElementById('rvCornerCloseBtn').addEventListener('click',function(){
    document.getElementById('rvCornerPanel').classList.remove('rv-cp-active');
  });

  document.addEventListener('visibilitychange',async function(){
    if (document.visibilityState==='visible'&&RV.open&&RV.settings.wakeLock) rvAcquireWakeLock();
  });

  ['rvMarkModal','rvCrsModal','rvExportModal','rvSettingsModal','rvAreaModal'].forEach(id=>{
    document.getElementById(id).addEventListener('click',function(e){ if (e.target===this) this.classList.remove('rv-modal-open'); });
  });

  RV.nmeaBuffer='';
});

/* Also wire open button if DOM already ready */
if (document.readyState!=='loading') {
  const btn=document.getElementById('vslRoverBtn');
  if (btn&&!btn._rvWired) { btn._rvWired=true; btn.addEventListener('click',rvOpen); }
}

})(); // end IIFE

/* ---- Photo watermark (kept as a separate top-level IIFE — see original comment: camera input fires independently of the block above) ---- */
(function() {
'use strict';
function rvWirePhoto() {
  const photoBtn=document.getElementById('rvPhotoBtn');
  const cameraInput=document.getElementById('rvCameraInput');
  if (!photoBtn||!cameraInput||photoBtn._rvPhotoWired) return;
  photoBtn._rvPhotoWired=true;
  photoBtn.addEventListener('click',function(){
    const RV=window._vslRoverState;
    if (!RV||!RV.pos) { const t=document.getElementById('rvAlertToast'); if (t){t.textContent='⚠ No GPS fix — get a location first';t.style.display='block';setTimeout(()=>t.style.display='none',3000);} return; }
    cameraInput.click();
  });
  cameraInput.addEventListener('change',function(e){
    const file=e.target.files&&e.target.files[0]; if (!file) return;
    const RV=window._vslRoverState, pos=RV&&RV.pos;
    const reader=new FileReader();
    reader.onload=function(evt){
      const img=new Image();
      img.onload=function(){
        const canvas=document.createElement('canvas');
        const W=img.naturalWidth,H=img.naturalHeight;
        canvas.width=W;canvas.height=H;
        const ctx=canvas.getContext('2d');
        ctx.drawImage(img,0,0,W,H);
        const barH=Math.max(54,Math.round(H*0.06));
        ctx.fillStyle='rgba(13,17,23,0.82)';
        ctx.fillRect(0,H-barH,W,barH);
        const crsLabel=(RV&&RV.crsLabel)||'UTM 36S';
        let eStr='—',nStr='—';
        if (pos) {
          try {
            const epsg=(RV&&RV.crs)?'EPSG:'+RV.crs:'EPSG:32736';
            const lon=pos.coords?pos.coords.longitude:pos.lon;
            const lat=pos.coords?pos.coords.latitude:pos.lat;
            if (typeof proj4!=='undefined') {
              const projected=proj4('EPSG:4326',epsg,[lon,lat]);
              eStr=(epsg==='EPSG:4326')?lon.toFixed(7)+'°':projected[0].toFixed(3)+'m';
              nStr=(epsg==='EPSG:4326')?lat.toFixed(7)+'°':projected[1].toFixed(3)+'m';
            } else { eStr=lon.toFixed(7)+'°'; nStr=lat.toFixed(7)+'°'; }
          } catch(_){
            const lon=pos.coords?pos.coords.longitude:(pos.lon||0), lat=pos.coords?pos.coords.latitude:(pos.lat||0);
            eStr=lon.toFixed(7)+'°'; nStr=lat.toFixed(7)+'°';
          }
        }
        const acc=pos?(pos.coords?pos.coords.accuracy:pos.accuracy):null;
        const accStr=acc!=null?(acc<=9999?acc.toFixed(1)+'m':'>9999m'):'—';
        const fixStr=(RV&&RV.fixType)||'GPS';
        const now=new Date();
        const ts=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0')+' '+String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0')+':'+String(now.getSeconds()).padStart(2,'0');
        const fontSize=Math.max(12,Math.round(barH*0.30));
        ctx.font='bold '+fontSize+'px monospace';
        ctx.fillStyle='#f59e0b';
        ctx.textBaseline='top';
        ctx.fillText('🛰 ROVER  |  Victoria Sugar  |  '+ts,12,H-barH+5);
        ctx.fillStyle='#f8fafc';
        const fz2=Math.max(10,Math.round(barH*0.26));
        ctx.font=fz2+'px monospace';
        ctx.fillText(crsLabel+'  E: '+eStr+'  N: '+nStr+'  |  Acc: '+accStr+'  |  '+fixStr,12,H-barH+5+fontSize+3);
        const link=document.createElement('a');
        const dateTag=ts.replace(/[: ]/g,'-');
        link.download='VSL-ROVER-'+dateTag+'.jpg';
        link.href=canvas.toDataURL('image/jpeg',0.92);
        link.click();
        const toast=document.getElementById('rvAlertToast');
        if (toast){toast.textContent='📸 Photo saved with GPS watermark';toast.style.display='block';setTimeout(()=>toast.style.display='none',3000);}
      };
      img.src=evt.target.result;
    };
    reader.readAsDataURL(file);
    cameraInput.value='';
  });
}
if (document.readyState!=='loading') rvWirePhoto();
else document.addEventListener('DOMContentLoaded',rvWirePhoto);
})();
