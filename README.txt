OPEN OVERWATCH
==============
A single-page situation map fed by open data: aircraft (ADS-B), satellites (CelesTrak + SGP4),
public cameras, ships (AIS), weather balloons, earthquakes, natural events, disaster alerts,
tropical cyclones, severe-weather alerts, radar, aurora, world news, submarine cables —
with a soundtrack generated live in the browser (or underground radio via SomaFM).

QUICK START (Windows)
  1. Unzip everything into one folder.
  2. Double-click "Start Open Overwatch.bat". It starts a tiny local helper and opens the map at
     http://127.0.0.1:8787/open-overwatch.html
     (needs Python 3 or Node.js; the .bat finds whichever you have)
  Mac / Linux:  python3 serve.py   or   node serve.js

WHY THE HELPER
  Most sources allow requests straight from a web page. A few do not (they send no CORS header):
  the ADS-B aggregators (adsb.lol, airplanes.live, adsb.fi), OpenSky, NYC DOT cameras, NOAA NHC
  and GDELT. The helper serves the page from localhost and relays only those hosts, adding the
  missing header. It has no dependencies and talks to nothing else. Every public CORS proxy we
  tried is dead or paywalled, which is why it is bundled.

  You can also open open-overwatch.html directly as a file: everything except those feeds works,
  and each blocked layer says so in the Layers rail.

FILES
  open-overwatch.html        the map (self-contained; libraries load from cdnjs/jsdelivr)
  serve.py                   helper, Python 3 standard library
  serve.js                   helper, Node 18+ / Bun
  Start Open Overwatch.bat   Windows launcher (console window stays open)
  Start Open Overwatch (minimized).vbs   same, with the console minimized to the taskbar

AUDIO
  Press "Enter with audio" on the boot screen, or the audio button in the header. Generated mode
  synthesizes an original soundtrack (Underground / Drift / Pulse) that reacts to the map; Radio mode
  plays stations from the open radio-browser.info directory by tag (dark ambient, techno, dnb, …).

OPTIONAL KEYS (Setup tab in the map)
  Windy webcams (webcams anywhere), aisstream.io (global ships), NASA FIRMS (active fires).

CHECKING FEEDS
  Sources tab -> "Test all feeds" lists every source with ok / blocked / error and the response time.
  The Log tab shows each feed's errors as they happen. The Brief tab (default) summarises what is notable now.

FAIR USE
  These are volunteer and public-agency services. The page rate-limits itself (1 ADS-B request/s,
  orbital data cached 2 h, GDELT once per 15 min, feeds back off on errors, polling drops to a third when
  the tab is hidden). Check each provider's terms before any commercial use.
