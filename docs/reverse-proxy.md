# HTTPS reverse proxies

The dashboard uses the page's origin by default. An HTTPS page connects using
WSS and HTTPS; an HTTP page uses WS and HTTP. A missing port means the protocol's
default port, not 9000. Direct access to http://localhost:9000 still uses port 9000.

For Nginx Proxy Manager, forward the public host to http://<bridge-address>:9000,
enable Websockets Support, and configure HTTPS for the public host. Leave Bridge
Host and Connection Port empty in the dashboard. The browser should connect to
wss://<public-host>/ (101 Switching Protocols) and fetch /api/network-info over
HTTPS. Cloudflare's WebSockets setting must be enabled.

An explicit Bridge Host or Connection Port overrides that part of the page's
address. The protocol still follows the page, so an explicit target used from
HTTPS must support TLS. Use a hostname/IP, not a complete URL; bracket IPv6
addresses. Connection Port accepts 1–65535; empty means auto. A host override
without a port inherits the page's port, including the default HTTPS port.

Connection Port / Apply & Reload saves browser settings and reloads the page;
it does not restart the bridge. Bridge Server / New Internal Port changes the
server's listening port (1024–65535) and restarts it. Behind a reverse proxy,
update the proxy's upstream port afterward and reload the existing public URL.

For direct access, select "Open this dashboard at the new port" before changing
the server port. This option is available only when the dashboard and bridge
use the same origin. It resets the connection port to auto and opens the new
port after 1.5 seconds. Leave this option off behind a reverse proxy: same-origin
access alone cannot reliably tell whether a proxy is present.

The dashboard is embedded in the bridge executable. Build dashboard/dist first,
then rebuild the bridge; changing dashboard sources does not update an existing
EXE. The Windows test workflow produces a standalone EXE, SHA256SUMS.txt and
BUILD-INFO.txt. It does not publish a release or build an installer.

Validation from dashboard/:

    npm ci
    node --test tests/*.test.mjs
    npm run build

Manual checks: test HTTPS/WSS through the proxy, direct HTTP access, explicit
connection settings, and an intentional internal port change. The automated
handler tests mock network/browser calls and do not replace this live test.
