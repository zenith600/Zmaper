'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const qrcode = require('qrcode-generator');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

// Only these subtrees of src/renderer are reachable over the network.
const SERVABLE = ['mobile/', 'core/'];

/**
 * Serves the phone remote on the LAN.
 *
 * State flows out over Server-Sent Events and commands come back as POSTs -
 * no WebSocket dependency, and SSE reconnects on its own when a phone's screen
 * sleeps or it roams between access points, which it will.
 */
class RemoteServer {
  /** @param {string} rendererDir absolute path to src/renderer */
  constructor(rendererDir) {
    this.root = rendererDir;
    this.server = null;
    this.port = 0;
    this.token = null;
    /** @type {Set<import('http').ServerResponse>} */
    this.clients = new Set();
    this.lastState = null;
    /** The address the OS would actually route from; the best QR candidate. */
    this.preferred = null;

    this.onCommand = () => {};
    this.onClientsChanged = () => {};
  }

  get running() {
    return !!this.server;
  }

  async start(requestedPort = 7777) {
    if (this.server) return this.info();

    this.token = crypto.randomBytes(9).toString('base64url');
    this.preferred = await preferredLocalAddress();
    const server = http.createServer((req, res) => this._handle(req, res));
    server.on('clientError', (_err, socket) => socket.destroy());

    this.port = await listenOnFreePort(server, requestedPort);
    this.server = server;
    return this.info();
  }

  async stop() {
    if (!this.server) return this.info();
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.port = 0;
    this.token = null;
    this.lastState = null;
    this.onClientsChanged(0);
    return this.info();
  }

  /** Issues a fresh token, which invalidates every link already handed out. */
  rotateToken() {
    if (!this.server) return this.info();
    this.token = crypto.randomBytes(9).toString('base64url');
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    this.onClientsChanged(0);
    return this.info();
  }

  info() {
    const addresses = lanAddresses(this.preferred);
    const primary = addresses[0] || null;
    const urlFor = (ip) => `http://${ip}:${this.port}/?k=${this.token}`;
    return {
      running: this.running,
      port: this.port,
      token: this.token,
      clients: this.clients.size,
      addresses: addresses.map((a) => ({ ...a, url: this.running ? urlFor(a.address) : null })),
      url: this.running && primary ? urlFor(primary.address) : null
    };
  }

  /** Pushes a message to every connected phone. */
  broadcast(message) {
    if (!this.server || !this.clients.size) return;
    if (message.type === 'state') this.lastState = message;
    const frame = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of [...this.clients]) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  // -- request handling ---------------------------------------------------

  _handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    // The control channel is token-gated. Static assets are not: they contain
    // nothing sensitive, and ES module imports cannot carry the query string.
    if (url.pathname === '/events' || url.pathname === '/cmd') {
      const key = url.searchParams.get('k') || req.headers['x-zmaper-key'];
      if (!this.token || key !== this.token) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden - reopen the link from the QR code');
        return;
      }
    }

    if (url.pathname === '/events') return this._stream(req, res);
    if (url.pathname === '/cmd') return this._command(req, res);
    return this._static(url.pathname, res);
  }

  _stream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    this.onClientsChanged(this.clients.size);

    if (this.lastState) {
      try {
        res.write(`data: ${JSON.stringify(this.lastState)}\n\n`);
      } catch {
        /* client vanished mid-handshake */
      }
    }

    // Proxies and phone radios drop idle connections; a comment keeps it warm.
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* cleaned up by the close handler */
      }
    }, 15000);

    const done = () => {
      clearInterval(ping);
      if (this.clients.delete(res)) this.onClientsChanged(this.clients.size);
    };
    req.on('close', done);
    req.on('error', done);
  }

  _command(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        this.onCommand(JSON.parse(body));
        res.writeHead(204).end();
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad command');
      }
    });
    req.on('error', () => {});
  }

  _static(pathname, res) {
    let rel = pathname === '/' ? 'mobile/index.html' : pathname.replace(/^\/+/, '');
    rel = decodeURIComponent(rel);

    if (!SERVABLE.some((prefix) => rel.startsWith(prefix))) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }

    const file = path.join(this.root, rel);
    // Defence in depth against traversal, on top of the prefix check.
    if (!file.startsWith(this.root)) {
      res.writeHead(403).end();
      return;
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache'
      });
      res.end(data);
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listenOnFreePort(server, first) {
  for (let port = first; port < first + 10; port++) {
    const ok = await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') resolve(false);
        else reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
    if (ok) return port;
  }
  throw new Error(`No free port between ${first} and ${first + 9}`);
}

/**
 * Asks the OS which local address it would use to reach the outside world.
 * A UDP "connect" only sets the socket's peer - nothing is transmitted - but
 * it makes the kernel run its routing table, which is the only reliable way
 * to tell a real LAN adapter from a virtual one.
 */
function preferredLocalAddress() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const sock = dgram.createSocket('udp4');
      sock.once('error', () => {
        try {
          sock.close();
        } catch {
          /* already closed */
        }
        done(null);
      });
      sock.connect(53, '8.8.8.8', () => {
        let addr = null;
        try {
          addr = sock.address().address;
        } catch {
          /* socket closed under us */
        }
        try {
          sock.close();
        } catch {
          /* already closed */
        }
        done(addr && addr !== '0.0.0.0' ? addr : null);
      });
      setTimeout(() => done(null), 400);
    } catch {
      done(null);
    }
  });
}

/** Usable IPv4 addresses, best candidate first. */
function lanAddresses(preferred) {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address, score: scoreAddress(a.address, name, preferred) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function scoreAddress(ip, name, preferred) {
  // The routable address beats every heuristic below it.
  if (preferred && ip === preferred) return 1000;

  // Virtual adapters (Hyper-V, VirtualBox, WSL, VPNs, Docker) hand out
  // addresses a phone on the real network cannot reach.
  const virtualName = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|tailscale|zerotier|docker|npcap/i.test(name);
  // Well-known virtual subnets, which adapter names alone will not reveal:
  // VirtualBox host-only sits on 192.168.56.x and is named plain "Ethernet N".
  const virtualSubnet =
    ip.startsWith('192.168.56.') ||
    ip.startsWith('192.168.99.') ||
    ip.startsWith('172.17.') ||
    ip.startsWith('172.18.');

  let score;
  if (ip.startsWith('192.168.')) score = 30;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 20;
  else if (ip.startsWith('10.')) score = 20;
  else if (ip.startsWith('169.254.')) score = -10; // link-local: no DHCP
  else score = 5;

  if (/wi-?fi|wlan|wireless/i.test(name)) score += 6; // the phone is probably here
  if (virtualName) score -= 40;
  if (virtualSubnet) score -= 60;
  return score;
}

/** QR module matrix for the renderer to draw. */
function qrMatrix(text) {
  const qr = qrcode(0, 'M'); // 0 = pick the smallest version that fits
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < size; r++) {
    let bits = '';
    for (let c = 0; c < size; c++) bits += qr.isDark(r, c) ? '1' : '0';
    rows.push(bits);
  }
  return { size, rows };
}

module.exports = { RemoteServer, qrMatrix };
