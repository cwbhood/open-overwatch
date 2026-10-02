#!/usr/bin/env python3
"""Open Overwatch helper.

Serves this folder at http://127.0.0.1:8787/ and relays requests to a short list of data sources
that refuse browser (CORS) requests. The page comes from this same origin, so the relayed answers need no CORS
header, and only this helper's own pages may use the relay.
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
    "api.gdeltproject.org",                                                       # news (now sends CORS itself; kept for old pages)
    "firms.modaps.eosdis.nasa.gov",                                               # fires (key)
    "api.windy.com",                                                              # webcams (key)
    "www.submarinecablemap.com",                                                  # submarine cables (live TeleGeography data)
}  # keep in sync with NEEDS_RELAY in open-overwatch.html and ALLOWED_HOSTS in serve.js
FORWARD_HEADERS = {"x-windy-api-key", "accept"}
UA = "OpenOverwatch/1.0 (local helper; personal use)"
OWN_HOSTS = {"127.0.0.1:%d" % PORT, "localhost:%d" % PORT}


def allowed(url):
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return u.scheme == "https" and u.hostname in ALLOWED_HOSTS


class CheckedRedirect(urllib.request.HTTPRedirectHandler):
    """Every redirect hop must stay on the allowlist; the Windy key is not carried to another host."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed(newurl):
            msg = "upstream redirected outside the allowlist: %s" % urllib.parse.urlsplit(newurl).hostname
            raise urllib.error.HTTPError(newurl, 502, msg, {"Content-Type": "text/plain; charset=utf-8"}, io.BytesIO(msg.encode()))
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and urllib.parse.urlsplit(newurl).hostname != urllib.parse.urlsplit(req.full_url).hostname:
            for k in [k for k in new.headers if k.lower() == "x-windy-api-key"]:
                del new.headers[k]
        return new


OPENER = urllib.request.build_opener(CheckedRedirect)


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

    def do_OPTIONS(self):  # no CORS preflight approval: same-origin pages never need one
        self.send_response(204)
        self.end_headers()

    def own_request(self):
        """Only this helper's own pages: a foreign Host means DNS rebinding, a cross-site fetch carries Sec-Fetch-Site / Origin."""
        site = self.headers.get("Sec-Fetch-Site"); origin = self.headers.get("Origin")
        if site and site not in ("same-origin", "none"):
            return False
        return not origin or origin.replace("http://", "", 1) in OWN_HOSTS

    def do_HEAD(self):
        if self.headers.get("Host") not in OWN_HOSTS:
            return self.reply(421, "wrong host")
        return super().do_HEAD()

    def do_GET(self):
        if self.headers.get("Host") not in OWN_HOSTS:  # DNS rebinding guard
            return self.reply(421, "wrong host")
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/proxy":
            if not self.own_request():
                return self.reply(403, "the relay only serves pages from this helper")
            return self.proxy(urllib.parse.parse_qs(parsed.query))
        if parsed.path == "/":
            self.send_response(302); self.send_header("Location", "/" + PAGE); self.end_headers(); return
        return super().do_GET()

    def reply(self, code, body, ctype="text/plain; charset=utf-8"):
        # no Access-Control-Allow-Origin: the page is served from this same origin, and other sites must not use the relay
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
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
        if not allowed(url):
            return self.reply(403, "host not in the helper's allowlist: %s" % target.hostname)
        headers = {"User-Agent": UA, "Accept-Encoding": "gzip, deflate"}
        for k, v in self.headers.items():
            if k.lower() in FORWARD_HEADERS:
                headers[k] = v
        req = urllib.request.Request(url, headers=headers)
        try:
            with OPENER.open(req, timeout=60) as r:
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
    allow_reuse_address = sys.platform != "win32"  # on Windows SO_REUSEADDR binds over a running helper (no "port busy")
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
