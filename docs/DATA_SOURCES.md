# Data sources

Everything shown comes from public, open or free-tier sources. This page lists what each one is, how it's fetched,
how fresh it is and how accurate it is. "Relay" means the optional local helper (`serve.js` / `serve.py`) forwards the
request, because the source sends no CORS headers; on the website those layers are off. "Key" means a free key the
user enters in the 2D map's Setup tab (stored only in their browser).

## Space

| What | Source | How | Freshness · accuracy | Licence / terms |
|---|---|---|---|---|
| Satellite orbits (TLE) | [CelesTrak](https://celestrak.org) GP groups | site copy refreshed every 6 h by the build; CelesTrak direct as fallback; 2 h browser cache | TLE epochs are hours old; SGP4 error grows ~1–3 km/day | free, at most one download per group per 2 h |
| Planets | JPL [approximate positions](https://ssd.jpl.nasa.gov/planets/approx_pos.html) (Standish) | computed in the browser | arcminutes, 1800–2050 (tested against Horizons) | public domain (NASA) |
| Moon | [Schlyter](https://stjarnhimlen.se/comp/ppcomp.html) elements + perturbations | computed in the browser | < 0.2° (tested) | published method |
| Planet rotation | IAU WGCCRE models; Earth: IERS Earth Rotation Angle | computed | < 0.01° for Earth (tested) | — |
| 1.57M asteroids, 1,795 comets | JPL [Small-Body Database](https://ssd.jpl.nasa.gov/tools/sbdb_query.html) | `brand/tools/make_small_bodies.py` → `data/solar/` | two-body from each orbit's epoch: main belt ~3×10⁻⁴ AU; poorly observed or old orbits worse (Bennu 0.04 AU) | public domain (NASA) |
| Spacecraft trajectories (10) | JPL [Horizons](https://ssd.jpl.nasa.gov/horizons/) | `make_spacecraft.py` → 2–5-day samples | exact at samples, linear between (cuts corners at flybys) | public domain (NASA) |
| 109,400 nearby stars | [HYG v4.1](https://github.com/astronexus/HYG-Database) | `make_stars.py` | catalogue parallaxes | CC BY-SA 4.0 |
| Star background | NASA SVS [Deep Star Maps 2020](https://svs.gsfc.nasa.gov/4851) | `make_skybox.py` (EXR decoded in Blender) | Hipparcos-2, Tycho-2, Gaia DR2 | NASA; credit NASA/GSFC SVS, ESA/Gaia/DPAC |
| Milky Way | NASA/JPL-Caltech/R. Hurt (SSC/Caltech) [ssc2008-10a1](https://www.spitzer.caltech.edu/image/ssc2008-10a1-the-milky-way-galaxy) | texture | artist's concept | NASA image use policy |
| Planet maps | [Solar System Scope](https://www.solarsystemscope.com/textures/) | `make_planet_textures.py` | based on NASA mission data | CC BY 4.0 |
| Space weather (Kp, aurora oval) | NOAA [SWPC](https://www.swpc.noaa.gov) | direct | minutes | public domain |

## Air and sea

| What | Source | How | Notes |
|---|---|---|---|
| Aircraft (2D map) | [adsb.lol](https://adsb.lol), [adsb.fi](https://adsb.fi), adsb.one, [airplanes.live](https://airplanes.live) (only when picked) | relay; the visible area swept in 250 nm tiles | community ADS-B feeders; coverage varies by region |
| Global civil snapshot | [OpenSky Network](https://opensky-network.org) | relay; every 15 min (anonymous: 400 credits/day) | dead-reckoned between snapshots for up to 15 min |
| Military aircraft, emergencies | adsb.lol `/mil` and squawk 7500/7600/7700 endpoints | relay | |
| Aircraft photos | [Planespotters](https://www.planespotters.net) | direct | photographer credited |
| Ships (Baltic) | Finnish Transport Agency [Digitraffic](https://www.digitraffic.fi) | direct | open data (CC BY 4.0) |
| Ships (worldwide) | [aisstream.io](https://aisstream.io) | key, WebSocket | |
| Radiosondes | [SondeHub](https://sondehub.org) | direct | amateur network |

## Earth and weather

| What | Source | How | Notes |
|---|---|---|---|
| Earthquakes | [USGS](https://earthquake.usgs.gov) real-time feeds | direct | M2.5+ day / significant |
| Natural events | NASA [EONET](https://eonet.gsfc.nasa.gov) | direct | |
| Disaster alerts | [GDACS](https://www.gdacs.org) (EU/UN) | direct, paged | up to 1000 events |
| Tropical cyclones | EONET; NOAA [NHC](https://www.nhc.noaa.gov) advisories | NHC via relay | |
| US weather warnings | NWS [api.weather.gov](https://api.weather.gov) | direct | |
| Radar | [RainViewer](https://www.rainviewer.com) | tiles | native to zoom 7 |
| IR clouds | NASA [GIBS](https://gibs.earthdata.nasa.gov) GOES-East/West + Himawari band 13 | tiles | no Meteosat: no Europe/Africa |
| Day / night imagery (3D) | GIBS Blue Marble NG and VIIRS Black Marble (EPSG:4326, pole to pole) | tiles | |
| Base maps | Esri World Imagery / Canvas; [OpenStreetMap](https://www.openstreetmap.org) | tiles | attribution shown |
| Fires | NASA [FIRMS](https://firms.modaps.eosdis.nasa.gov) | key, relay | VIIRS/MODIS hotspots |
| Point forecasts | [Open-Meteo](https://open-meteo.com) | direct | |
| Submarine cables | [TeleGeography](https://www.submarinecablemap.com) | relay; GitHub copy as fallback | |
| News | [GDELT](https://www.gdeltproject.org) DOC API | direct | rate-limited; failures reported as such |
| Traffic cameras | TfL, NYC DOT, Caltrans, Singapore LTA, Digitraffic, Windy (key) | mixed | images stay at the source |
| Places, geocoding | [Photon](https://photon.komoot.io), [Nominatim](https://nominatim.openstreetmap.org), [Overpass](https://overpass-api.de) | direct | OSM data (ODbL) |
| Approximate location | [ipapi.co](https://ipapi.co) (only if the browser location is unavailable) | direct | city-level |
| Radio | [radio-browser.info](https://www.radio-browser.info) | direct | community directory |

The 2D map's Setup tab can run a live check of every endpoint. `notes/review-2026-10-01.json` holds the last full
liveness review.
