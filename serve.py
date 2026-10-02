#!/usr/bin/env python3
"""Open Overwatch helper.

Serves this folder at http://127.0.0.1:8787/ and relays requests to a short list of data sources
that refuse browser (CORS) requests, adding the missing Access-Control-Allow-Origin header.
Standard library only. Run:  python serve.py   (or double-click "Start Open Overwatch.bat")
"""
import http.server, socketserver, urllib.request, urllib.parse, urllib.error, os, sys, webbrowser, threading, gzip, zlib, io

PORT = int(os.environ.get("OW_PORT", "8787"))
PAGE = "open-overwatch.html"
ALLOWED_HOSTS = {
    "api.adsb.lol", "api.airplanes.live", "opendata.adsb.fi", "api.adsb.one",   # aircraft
    "opensky-network.org",                                                        # aircraft snapshot
    "www.nhc.noaa.gov",                                                           # hurricane advisories
    "webcams.nyctmc.org",                                                         # NYC cameras
    "api.gdeltproject.org",                                                       # news
    "firms.modaps.eosdis.nasa.gov",                                               # fires (key)
    "api.windy.com",                                                              # webcams (key)
    "celestrak.org", "tle.ivanstanojevic.me",                                     # orbital data fallbacks
}
FORWARD_HEADERS = {"x-windy-api-key", "accept"}
UA = "OpenOverwatch/1.0 (local helper; personal use)"


class Handler(http.server.SimpleHTTPRequestHandler):
    # brand/ assets and the 3D globe (keep in sync with MIME in serve.js)
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mjs': 'text/javascript'}
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.dirname(os.path.abspath(__file__)), **kw)

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/proxy" in msg:
            msg = msg.split("url=")[0] + "url=…" if "url=" in msg else msg
        sys.stdout.write("%s %s\n" % (self.log_date_time_string(), msg)); sys.stdout.flush()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/proxy":
            return self.proxy(urllib.parse.parse_qs(parsed.query))
        if parsed.path == "/":
            self.send_response(302); self.send_header("Location", "/" + PAGE); self.end_headers(); return
        return super().do_GET()

    def reply(self, code, body, ctype="text/plain; charset=utf-8"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def proxy(self, q):
        if "ping" in q:
            return self.reply(200, "ok")
        url = (q.get("url") or [""])[0]
        try:
            target = urllib.parse.urlsplit(url)
        except ValueError:
            return self.reply(400, "bad url")
        if target.scheme != "https" or target.hostname not in ALLOWED_HOSTS:
            return self.reply(403, "host not in the helper's allowlist: %s" % target.hostname)
        headers = {"User-Agent": UA, "Accept-Encoding": "gzip, deflate"}
        for k, v in self.headers.items():
            if k.lower() in FORWARD_HEADERS:
                headers[k] = v
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read(); code = r.status; ctype = r.headers.get("Content-Type", "application/octet-stream"); enc = (r.headers.get("Content-Encoding") or "").lower()
        except urllib.error.HTTPError as e:
            data = e.read(); code = e.code; ctype = e.headers.get("Content-Type", "text/plain"); enc = (e.headers.get("Content-Encoding") or "").lower()
        except Exception as e:  # DNS, timeout, TLS …
            return self.reply(502, "upstream error: %s" % e)
        try:
            if enc == "gzip":
                data = gzip.decompress(data)
            elif enc == "deflate":
                data = zlib.decompress(data, -zlib.MAX_WBITS) if data[:1] != b"\x78" else zlib.decompress(data)
        except Exception:
            pass
        return self.reply(code, data, ctype)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    if not os.path.exists(PAGE):
        print("Put serve.py in the same folder as %s" % PAGE); sys.exit(1)
    url = "http://127.0.0.1:%d/%s" % (PORT, PAGE)
    try:
        httpd = Server(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print("Port %d is busy (%s). Is the helper already running? Open %s" % (PORT, e, url)); sys.exit(1)
    print("Open Overwatch helper on %s  (Ctrl+C to stop)" % url)
    print("Relaying: " + ", ".join(sorted(ALLOWED_HOSTS)))
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
