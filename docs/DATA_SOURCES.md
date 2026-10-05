# Data sources

Everything shown comes from public, open or free-tier sources. This page lists what each one is, how it's fetched,
how fresh it is and how accurate it is. "Relay" means the optional local helper (`serve.js` / `serve.py`) forwards the
request, because the source sends no CORS headers; on the website those layers are off. "Key" means a free key the
user enters in the 2D map's Setup tab (stored only in their browser).

## Space

| What | Source | How | Freshness · accuracy | Licence / terms |
|---|---|---|---|---|
| Satellite orbits (TLE) | [CelesTrak](https://celestrak.org) GP groups | site copy refreshed every 6 h by the build; CelesTrak direct as fallback; 2 h browser cache | TLE epochs are hours old; SGP4 error grows ~1–3 km/day | free, at most one download per group per 2 h |
| Close approaches | CelesTrak [SOCRATES](https://celestrak.org/SOCRATES/) (`sort-minRange.csv`) | site build keeps the 300 closest upcoming → `data/socrates.json`, every 6 h | conjunctions under 5 km over the next 7 days, from the same public element sets (SGP4 error: km) | free, credit CelesTrak |
| Planets | JPL [approximate positions](https://ssd.jpl.nasa.gov/planets/approx_pos.html) (Standish) | computed in the browser | arcminutes, 1800–2050 (tested against Horizons) | public domain (NASA) |
| Moon | [Schlyter](https://stjarnhimlen.se/comp/ppcomp.html) elements + perturbations | computed in the browser | < 0.2° (tested) | published method |
| 20 major moons | JPL [Horizons](https://ssd.jpl.nasa.gov/horizons/) osculating elements, 5 dates over 2026 | `make_moons.py` fits linear node / periapsis / mean-longitude rates → `data/solar/moons.json` | < 0.4° in 2026 (tested) | public domain (NASA) |
| 6,339 exoplanets in 4,745 systems | [NASA Exoplanet Archive](https://exoplanetarchive.ipac.caltech.edu) `pscomppars` (TAP) | `make_exoplanets.py` → `data/solar/exoplanets.json`; habitable zones from Kopparapu et al. 2014 | archive best values; transiting planets placed from their transit times (circular orbits, sky orientation of the orbit unknown), others at an arbitrary phase | public domain (NASA); acknowledge the archive |
| Solar eclipses 2027–2030 (10) | JPL [Horizons](https://ssd.jpl.nasa.gov/horizons/) geocentric apparent Sun and Moon, ICRF, every minute | `make_eclipses.py` → `data/eclipses.json`; shadow geometry in `src/core/eclipse.js`, ICRF→Earth-fixed by Cesium | greatest-eclipse points within ~0.1° and durations within ~5 s of NASA's predictions | public domain (NASA) |
| Planet rotation | IAU WGCCRE models; Earth: IERS Earth Rotation Angle | computed | < 0.01° for Earth (tested) | — |
| 1.57M asteroids, 1,795 comets | JPL [Small-Body Database](https://ssd.jpl.nasa.gov/tools/sbdb_query.html) | `brand/tools/make_small_bodies.py` → `data/solar/` | two-body from each orbit's epoch: main belt ~3×10⁻⁴ AU; poorly observed or old orbits worse (Bennu 0.04 AU) | public domain (NASA) |
| Spacecraft trajectories (10) | JPL [Horizons](https://ssd.jpl.nasa.gov/horizons/) | `make_spacecraft.py` → 2–5-day samples | exact at samples, linear between (cuts corners at flybys) | public domain (NASA) |
| 109,400 nearby stars | [HYG v4.1](https://github.com/astronexus/HYG-Database) | `make_stars.py` | catalogue parallaxes | CC BY-SA 4.0 |
| Star background | NASA SVS [Deep Star Maps 2020](https://svs.gsfc.nasa.gov/4851) | `make_skybox.py` (EXR decoded in Blender) | Hipparcos-2, Tycho-2, Gaia DR2 | NASA; credit NASA/GSFC SVS, ESA/Gaia/DPAC |
| Milky Way | NASA/JPL-Caltech/R. Hurt (SSC/Caltech) [ssc2008-10a1](https://www.spitzer.caltech.edu/image/ssc2008-10a1-the-milky-way-galaxy) | texture | artist's concept | NASA image use policy |
| Planet maps | [Solar System Scope](https://www.solarsystemscope.com/textures/) | `make_planet_textures.py` | based on NASA mission data | CC BY 4.0 |
| Moon surface maps (15 of 20) | USGS Astrogeology [planetary WMS](https://planetarymaps.usgs.gov) global mosaics: Galileo/Voyager (Io, Europa, Ganymede, Callisto), Cassini ISS ± Voyager fill (Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus; NASA/JPL/SSI), Voyager 2 (Triton, colour by P. Schenk/LPI), New Horizons (Charon; NASA/JHUAPL/SwRI/LPI), Viking (Deimos, map by P. Stooke); Phobos: Mars Express HRSC-SRC mosaic (ESA/DLR/FU Berlin) | `make_moon_textures.py` → `brand/textures/moons/` (2048 + 1024 px, `maps.json`: per-map source, credit, longitude convention) | Triton and Charon are ~35–40% unseen (filled with a smooth average); Miranda, Ariel, Umbriel, Titania, Oberon have no global map (Voyager 2 saw only their southern hemispheres) | public domain (NASA/USGS); Phobos: ESA/DLR/FU Berlin, credit required (CC BY-SA 3.0 IGO) |
| 43,480 galaxies (cosmic web) | [2MASS Redshift Survey](https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/ApJS/199/26) (Huchra et al. 2012, ApJS 199, 26) via VizieR | `make_galaxies.py` → `data/solar/galaxies.bin` (Float32 x, y, z Mpc equatorial J2000 + M_K) | distance = cz_CMB / 70 km/s/Mpc, no peculiar-velocity model (clusters stretch along the line of sight); Ks ≤ 11.75, empty within ~5–8° of the Galactic plane | free use with citation (CDS VizieR) |
| Space weather (Kp, aurora oval) | NOAA [SWPC](https://www.swpc.noaa.gov) | direct | minutes | public domain |

## Air and sea

| What | Source | How | Notes |
|---|---|---|---|
| Aircraft (2D map) | [adsb.lol](https://adsb.lol), [adsb.fi](https://adsb.fi), adsb.one, [airplanes.live](https://airplanes.live) (only when picked) | relay; the visible area swept in 250 nm tiles | community ADS-B feeders; coverage varies by region |
| Global civil snapshot | [OpenSky Network](https://opensky-network.org) | relay; every 15 min (anonymous: 400 credits/day) | dead-reckoned between snapshots for up to 15 min |
| Military aircraft, emergencies | adsb.lol `/mil` and squawk 7500/7600/7700 endpoints | relay | |
| Find a flight (3D globe) | adsb.lol `/v2/callsign`, `/v2/hex`, `/v2/reg` (same network as above) | relay (download version); the website searches the planes it already has and links to globe.adsb.lol | refreshed every 15 s while you follow it |
| Aircraft photos | [Planespotters](https://www.planespotters.net) | direct | photographer credited |
| Ships (Baltic) | Finnish Transport Agency [Digitraffic](https://www.digitraffic.fi) | direct | open data (CC BY 4.0) |
| Ships (worldwide) | [aisstream.io](https://aisstream.io) | key, WebSocket | |
| Radiosondes | [SondeHub](https://sondehub.org) | direct | amateur network |

## Earth and weather

| What | Source | How | Notes |
|---|---|---|---|
| Earthquakes | [USGS](https://earthquake.usgs.gov) real-time feeds | direct | M2.5+ day / significant |
| Lighthouses (3D globe) | [OpenStreetMap](https://www.openstreetmap.org) `man_made=lighthouse` via Overpass, built by `brand/tools/make_lighthouses.py` | static `data/lighthouses.json` | ODbL: credit "© OpenStreetMap contributors" (shown on every lighthouse card). Heights, light patterns and ranges are only as complete as mappers made them; many have a name and position only. Refresh by deleting `brand/source/lighthouses/` and re-running the script |
| Country dossier: facts and borders (3D globe) | Wikidata (CC0: capital, region, languages, currency); World Bank (CC BY 4.0: population, GDP, GDP per person, life expectancy); Natural Earth 50 m borders (public domain, simplified), built by `brand/tools/make_countries.py` | static `data/countries.json`, `data/borders.json` | Latest value per indicator (usually the year before last). Names are the short names the 2D map uses. 195 countries have borders; a few micro-states have facts but nothing to click. Refresh: delete `brand/source/countries/`, re-run |
| Country dossier: headlines | [GDELT](https://www.gdeltproject.org) DOC API, English-language outlets of each country, last 24 h | copied by the site build into `data/news.json` (70 biggest economies, one request per 7 s as GDELT asks); the browser falls back to asking GDELT itself, which allows one request every few seconds | Open data; headline text and link only, each opens its publisher. A country with nothing in the copy tries GDELT live and says so if refused |
| Big employers as towers (3D globe) | Wikidata (CC0): companies with an industry, a headquarters with coordinates, an English Wikipedia article and 20,000+ employees, `brand/tools/make_companies.py` | static `data/companies.json` (~1,000 rows) | Tower height = employees (the latest dated figure; no currency to get wrong). **Not** market value: Wikidata's market caps are stale and in mixed currencies (only 48 had a recent USD one). Volunteer-edited: a few typos are blocked by name in the script; expect others |
| Volcanoes (3D globe) | Wikidata (CC0): every item that is a kind of volcano with coordinates, `brand/tools/make_volcanoes.py` | static `data/volcanoes.json` (~2,500) | Says what a volcano is (type, height), not whether it is erupting |
| Aurora forecast (3D globe) | NOAA SWPC OVATION model (`ovation_aurora_latest.json`, public domain) | direct, CORS; refreshed every 10 min while the layer is on | 1-degree grid of the chance of aurora, painted as one imagery layer; "Tonight" reads the cell you're under and up to 9° poleward (aurora ~110 km up shows low on the horizon from ~1,000 km) |
| Flybys (3D globe) | NASA/JPL CNEOS close-approach API (public domain), the next 60 days inside ~20 lunar distances | copied by the site build into `data/flybys.json` (the API sends no CORS headers) | Sizes are estimated from brightness H (albedo 0.14) when no diameter is known |
| Sun overhead and time zones (3D globe) | computed (Cesium's Sun position), no data | none | Marker where the Sun is overhead, its meridian, 24 time-zone meridians |
| 3D buildings (3D globe) | OpenStreetMap building outlines (ODbL) through the public Overpass API, no account: below 2.5 km, the 0.01-degree squares around the view, one request per 6 s, stood up as blocks (mapped height, floors x 3.2 m, or 9 m). With a Cesium ion token (optional), Cesium's streamed "OSM Buildings" instead | live Overpass requests from the browser; or streamed 3D Tiles with **the publisher's free ion token** (`src/globe/config.js` or `OO3D.setIonToken`) | The token bundled with CesiumJS is for evaluation: the code uses it only on localhost with `?ion=dev`. Without terrain, buildings can float or sink a little in hilly places |
| Weather: infrared clouds (3D globe) | NASA [GIBS](https://nasa-gibs.github.io/gibs-api-docs/) tiles of NOAA GOES-East, GOES-West and JMA Himawari, band 13 "clean infrared" | direct, WMTS tiles with CORS | 10-minute images, about 40-50 min old. Covers the Americas, the Pacific and Asia-Australia; **not** Europe, Africa or the Indian Ocean (Meteosat has no free tile service). The newest frame is found by probing back from now |
| Weather: rain radar (3D globe) | [RainViewer](https://www.rainviewer.com/api.html) public radar composite (`api.rainviewer.com/public/weather-maps.json`) | direct, tiles with CORS | 10-minute frames, last 2 h, zoom 7. Only where national radars exist. Credit "Radar © RainViewer.com" is shown. Their free terms can change; if they do the layer reports "Radar unreachable" and everything else keeps working |
| Weather: rain from space (3D globe) | NASA GIBS `IMERG_Precipitation_Rate_30min` | direct, WMTS tiles | Global 60 N to 60 S, but about 7 hours old (a still, not animated) |
| Weather: wind and temperature (3D globe) | [Open-Meteo](https://open-meteo.com) forecast API, `current` 10 m wind and 2 m temperature on a 10-degree grid (612 points, two requests) | mirrored by the site build into `data/wind.json` every 6 h (`build_site.py`); the browser reads that first and asks Open-Meteo directly only if the copy is missing or older than 7 h | **CC BY 4.0, free for non-commercial use** (a commercial deployment needs their paid plan); credit "Open-Meteo.com" is shown. Open-Meteo limits each IP per hour, which is why visitors read the copy. A coarse snapshot: the big flow, not local gusts |
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
