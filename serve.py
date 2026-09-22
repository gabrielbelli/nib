#!/usr/bin/env python3
"""Serve the N.I.B. web app to a phone on the LAN.

Web Bluetooth refuses to run outside a secure context, and a click-through
certificate warning does not reliably count as one, so the phone has to
actually trust the certificate. Two servers run side by side:

  http://<ip>:8088/   plain HTTP, only to hand the phone the CA certificate
  https://<ip>:9443/  the app itself

Nothing leaves this machine.
"""

import glob
import http.server
import json
import os
import re
import socket
import ssl
import sys
import threading
import zlib
from functools import partial

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
CERTS = os.path.join(HERE, "certs")
def newest_cert():
    """Pick the most recent mkcert pair, so regenerating for a new IP or
    hostname needs no edit here."""
    keys = sorted(glob.glob(os.path.join(CERTS, "*-key.pem")), key=os.path.getmtime)
    if not keys:
        raise SystemExit("no certificate in certs/ - run mkcert there first")
    key = keys[-1]
    return key.replace("-key.pem", ".pem"), key


CERT, KEY = newest_cert()

_version_cache = {"key": None, "value": "0"}
_version_lock = threading.Lock()


def web_version():
    """The build number the page and every asset carry as ?v=N.

    Derived from the CONTENT of web/, not from mtimes: two edits inside one
    second used to share a number (the second never pulled), and a touch with
    no change bumped it and reloaded every open page for nothing. Decimal
    digits so the ?v=N rewrite and the page's digits-only check keep working.
    Rehashed only when some (name, mtime_ns, size) changes."""
    entries = []
    for name in sorted(os.listdir(WEB)):
        path = os.path.join(WEB, name)
        if os.path.isfile(path):
            st = os.stat(path)
            entries.append((name, st.st_mtime_ns, st.st_size))
    key = tuple(entries)
    with _version_lock:
        if _version_cache["key"] == key:
            return _version_cache["value"]
    crc = 0
    for name, _, _ in entries:
        crc = zlib.crc32(name.encode("utf-8"), crc)
        with open(os.path.join(WEB, name), "rb") as fh:
            crc = zlib.crc32(fh.read(), crc)
    value = str(crc & 0xFFFFFFFF)
    with _version_lock:
        _version_cache["key"] = key
        _version_cache["value"] = value
    return value


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.168.1.1", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


LANDING = """<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>N.I.B. setup</title>
<style>body{{font:16px/1.5 system-ui;margin:0;padding:24px;background:#0f1115;color:#e6e9ef}}
a{{color:#4c8dff}} .step{{margin:18px 0}} code{{background:#1f242e;padding:2px 6px;border-radius:5px}}</style>
</head><body>
<h2>N.I.B. setup</h2>
<div class=step>1. <a href="/rootCA.pem">Download the certificate</a></div>
<div class=step>2. Install it. <b>iPhone:</b> Settings &rarr; Profile Downloaded &rarr; Install, then
Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings &rarr; turn the certificate on.
<b>Android:</b> Settings &rarr; Security &rarr; Install from storage &rarr; CA certificate.</div>
<div class=step>3. Open <a href="https://{ip}:9443/">https://{ip}:9443/</a>
or <a href="https://{host}:9443/">https://{host}:9443/</a></div>
<div class=step><b>Bluefy on iPhone:</b> Settings &rarr; Bluefy &rarr; turn on
<b>Local Network</b> and <b>Bluetooth</b>, or it cannot reach this machine at all.</div>
</body></html>"""


class CAHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/rootCA.pem":
            with open(os.path.join(CERTS, "rootCA.pem"), "rb") as fh:
                body = fh.read()
            self.send_response(200)
            # This content type is what makes iOS offer to install a profile.
            self.send_header("Content-Type", "application/x-x509-ca-cert")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            body = LANDING.format(ip=lan_ip(), host=socket.gethostname()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *args):
        pass


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """A phone that caches the app shows yesterday's bug and makes a fix look
    like it never landed. Nothing here is worth caching during development."""

    # Keep-alive. The reverse proxy reuses one upstream connection for the
    # dozen requests a page load makes; an HTTP/1.0 server closed each one
    # after the response, so every asset cost a fresh TLS handshake and the
    # reuse turned into a reset. Every path here sends Content-Length.
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        # Bluefy and other WKWebView browsers ignore Cache-Control and keep a
        # stale page until the user deletes site data. The page asks this
        # endpoint for the current version and reloads itself when it differs.
        if self.path.split("?")[0] == "/version.txt":
            body = web_version().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # index.html references every asset as name.js?v=N. Rewriting N to the
        # current version on the way out means a fresh page can only ever pull
        # matching assets, so a stale JS file can never pair with fresh CSS.
        path = self.path.split("?")[0]
        if path in ("/", "/index.html") or path.endswith(".js"):
            ver = web_version()
            name = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
            try:
                with open(os.path.join(WEB, name), "rb") as fh:
                    text = fh.read().decode("utf-8")
            except OSError:
                self.send_error(404)
                return
            text = re.sub(r"\?v=\d+", "?v=" + ver, text)
            body = text.encode("utf-8")
            ctype = "text/html; charset=utf-8" if name.endswith(".html") else "text/javascript; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            if name.endswith(".html"):
                # Belt and braces for engines that honour it (WebKit does, since
                # Safari 17.2): every fresh document also empties the origin's
                # HTTP cache, so nothing older can be paired with it later.
                self.send_header("Clear-Site-Data", '"cache"')
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_HEAD(self):
        # SimpleHTTPRequestHandler answers HEAD only for real files, so a
        # monitor probing /version.txt or / got a 404. Same headers as GET,
        # no body.
        real = self.wfile
        self.wfile = _HeadersOnly(real)
        try:
            self.do_GET()
        finally:
            self.wfile = real

    def do_POST(self):
        # Field telemetry, development only. The page posts what it measured
        # on a real device: viewport numbers, where each control is, and what a
        # tap at that spot would actually hit. One line of JSON per report.
        if self.path.split("?")[0] == "/probe":
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            # Playwright and every other driver set navigator.webdriver, and the
            # page reports it as "wd". Those lines go to their own file: the
            # field log is ground truth from a real phone and nothing else.
            name = "probe.log"
            try:
                if json.loads(body.decode("utf-8") or "{}").get("wd") is True:
                    name = "probe-emu.log"
            except (ValueError, AttributeError, UnicodeDecodeError):
                pass
            with open(os.path.join(HERE, name), "ab") as fh:
                fh.write(body.strip() + b"\n")
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404)

    def log_error(self, fmt, *args):
        # An idle keep-alive connection from the proxy hitting the 30s socket
        # timeout is the normal end of that connection, not an error.
        if fmt.startswith("Request timed out"):
            return
        super().log_error(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()
        if isinstance(self.wfile, _HeadersOnly):
            self.wfile.body = True      # a HEAD stops here


class _HeadersOnly:
    """Lets a HEAD run the GET path: the status line and headers go out, the
    body is dropped."""

    def __init__(self, real):
        self.real = real
        self.body = False

    def write(self, data):
        if not self.body:
            self.real.write(data)

    def flush(self):
        self.real.flush()


class QuietServer(http.server.ThreadingHTTPServer):
    """The reverse proxy in front of this keeps connections alive and then
    resets them; the stock server printed a 12-line traceback for each one and
    buried the real requests. Those are not errors here.

    TLS is negotiated per connection, in that connection's own thread, with a
    timeout. Wrapping the LISTENING socket put the handshake inside accept():
    one peer that connected and never sent a ClientHello (a browser
    preconnect, a half-open socket) froze the accept loop for everyone, and a
    page load's twelve parallel asset fetches queued behind each other on the
    default backlog of 5. The proxy saw resets and timeouts, answered 503,
    then marked this origin down for a while."""

    request_queue_size = 128
    tls = None                    # the SSLContext, set in serve_https

    def get_request(self):
        sock, addr = self.socket.accept()
        sock.settimeout(10)       # a ClientHello that never comes
        return sock, addr

    def finish_request(self, request, client_address):
        try:
            request = self.tls.wrap_socket(request, server_side=True)
        except (ssl.SSLError, OSError):
            request.close()
            return
        request.settimeout(30)    # an idle keep-alive connection
        super().finish_request(request, client_address)

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ssl.SSLError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def serve_https():
    handler = partial(NoCacheHandler, directory=WEB)
    httpd = QuietServer(("0.0.0.0", 9443), handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    httpd.tls = ctx
    httpd.serve_forever()


def main():
    ip = lan_ip()
    threading.Thread(target=serve_https, daemon=True).start()
    print(f"  setup   http://{ip}:8088/")
    print(f"  app     https://{ip}:9443/")
    http.server.ThreadingHTTPServer(("0.0.0.0", 8088), CAHandler).serve_forever()


if __name__ == "__main__":
    main()
