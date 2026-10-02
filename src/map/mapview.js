// The Leaflet map, base maps (incl. dated NASA GIBS imagery) and the Sun/terminator maths.
import { $, Store, debounce, deg, rad } from './util.js';

/* ============================================================ map */
export const savedView = (v => v && [v.lat, v.lon, v.z].every(Number.isFinite) && Math.abs(v.lat) <= 85 ? v : { lat: 34, lon: -20, z: 3 })(Store.get('view', null));
export const map = L.map('map', { zoomControl: true, worldCopyJump: true, preferCanvas: true, minZoom: 2, maxZoom: 19, zoomSnap: 0.5, wheelPxPerZoomLevel: 90 })
  .setView([savedView.lat, savedView.lon], savedView.z);
L.control.scale({ imperial: true, metric: true, position: 'bottomleft' }).addTo(map);
map.on('moveend', debounce(() => { const c = map.getCenter(); Store.set('view', { lat: c.lat, lon: c.lng, z: map.getZoom() }); }, 400));
export const vecRenderer = L.canvas({ padding: 0.3 });

export const gibsDate = () => new Date(Date.now() - 36 * 3600e3).toISOString().slice(0, 10); // newest complete GIBS day
export let imgDate = gibsDate();
export const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
export const gibsBasemaps = d => ({ // dated NASA layers; rebuilt when the day rolls over (see below) so a long-open tab stays current
  viirs: { name: `NASA VIIRS true color · ${d}`, layers: [[`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${d}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, { maxNativeZoom: 9, maxZoom: 13, attribution: 'NASA GIBS / Worldview (VIIRS SNPP)' }], [ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13, opacity: .7 }]] },
  night: { name: `NASA night lights · ${d}`, layers: [[`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_DayNightBand_At_Sensor_Radiance/default/${d}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`, { maxNativeZoom: 8, maxZoom: 13, attribution: 'NASA GIBS / Worldview (VIIRS DNB)' }], [ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13, opacity: .6 }]] },
});
export const BASEMAPS = { // no API keys anywhere (CARTO's free tiles started demanding one)
  esridark: { name: 'Dark gray (Esri)', layers: [[ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19, attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors' }], [ESRI + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 16, maxZoom: 19, opacity: .8 }]] },
  osmdark: { name: 'Dark streets (OSM, inverted)', layers: [['https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'tiles-invert', attribution: '&copy; OpenStreetMap contributors' }]] },
  sat: { name: 'Satellite imagery (Esri)', layers: [[ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics, GIS community' }], [ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, opacity: .85 }]] },
  osm: { name: 'Streets (OpenStreetMap)', layers: [['https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }]] },
  topo: { name: 'Terrain (OpenTopoMap)', layers: [['https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { subdomains: 'abc', maxZoom: 17, attribution: '&copy; OpenStreetMap contributors, SRTM · OpenTopoMap (CC-BY-SA)' }]] },
  esritopo: { name: 'Topographic (Esri)', layers: [[ESRI + 'World_Topo_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri, HERE, Garmin, USGS, NGA, &copy; OpenStreetMap contributors' }]] },
  ...gibsBasemaps(imgDate),
};
export let baseLayer = null;
export function setBasemap(id) {
  const b = BASEMAPS[id] || BASEMAPS.esridark; if (!BASEMAPS[id]) id = 'esridark';
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.layerGroup(b.layers.map(([url, o], i) => L.tileLayer(url, { ...o, crossOrigin: false, detectRetina: false, zIndex: i, updateWhenIdle: true, keepBuffer: 3 }))).addTo(map);
  Store.set('basemap', id); $('#basemap').value = id;
}
(function initBasemapSelect() { const s = $('#basemap'); for (const [id, b] of Object.entries(BASEMAPS)) { const o = document.createElement('option'); o.value = id; o.textContent = b.name; s.appendChild(o); } s.addEventListener('change', () => setBasemap(s.value)); setBasemap(Store.get('basemap', 'esridark')); })();
setInterval(() => { // day rollover: re-date the NASA layers, their menu labels and, if one is showing, the tiles
  const d = gibsDate(); if (d === imgDate) return; imgDate = d; Object.assign(BASEMAPS, gibsBasemaps(d));
  for (const o of $('#basemap').options) if (BASEMAPS[o.value]) o.textContent = BASEMAPS[o.value].name;
  if (['viirs', 'night'].includes($('#basemap').value)) setBasemap($('#basemap').value);
}, 3600e3);

/* ============================================================ sun + terminator */
export function sunPosition(date) {
  const jd = date / 86400000 + 2440587.5, n = jd - 2451545.0;
  const L0 = (280.460 + 0.9856474 * n) % 360, g = rad((357.528 + 0.9856003 * n) % 360);
  const lambda = rad(L0 + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)), eps = rad(23.439 - 0.0000004 * n);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const T = n / 36525; let gmst = (280.46061837 + 360.98564736629 * n + 0.000387933 * T * T) % 360; if (gmst < 0) gmst += 360;
  let lon = deg(ra) - gmst; lon = ((lon % 360) + 540) % 360 - 180;
  return { lat: deg(dec), lon };
}
export function sunElevation(lat, lon, date) { const s = sunPosition(date); const ha = rad(lon - s.lon); const el = Math.asin(Math.sin(rad(lat)) * Math.sin(rad(s.lat)) + Math.cos(rad(lat)) * Math.cos(rad(s.lat)) * Math.cos(ha)); return deg(el); }
export function terminatorRing(date) {
  const s = sunPosition(date), dec = rad(s.lat), pts = [];
  for (let lon = -180; lon <= 180; lon += 2) { const ha = rad(lon - s.lon); pts.push([deg(Math.atan(-Math.cos(ha) / Math.tan(dec))), lon]); }
  const pole = s.lat > 0 ? -90 : 90; pts.push([pole, 180]); pts.push([pole, -180]);
  return pts;
}
