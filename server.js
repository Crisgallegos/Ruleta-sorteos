const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = 3000;

// Find local IPv4 address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const localIp = getLocalIp();

// Simple in-memory room subscriber map for real-time WebSocket sync
const rooms = new Map(); // roomCode -> Set of clients

// HTTP Server
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  // API to get server network info
  if (pathname === '/api/info') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      localIp: localIp,
      port: PORT,
      url: `http://${localIp}:${PORT}`
    }));
    return;
  }

  // Serve index.html or static files
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    filePath = path.join(__dirname, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };

  const contentType = mimeTypes[ext] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error cargando archivo');
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    }
  });
});

// Built-in Lightweight WebSocket Server (RFC 6455) with ZERO external npm dependencies
const crypto = require('crypto');

server.on('upgrade', (req, socket, head) => {
  if (req.headers['upgrade'] !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request');
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];

  socket.write(headers.join('\r\n') + '\r\n\r\n');

  let currentRoom = null;

  function sendWS(data) {
    if (socket.destroyed) return;
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
    const payload = Buffer.from(jsonStr);
    const length = payload.length;

    let header;
    if (length <= 125) {
      header = Buffer.from([0x81, length]);
    } else if (length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      socket.write(Buffer.concat([header, payload]));
    } catch (e) {}
  }

  socket.on('data', (buffer) => {
    try {
      if (buffer.length < 2) return;
      const firstByte = buffer[0];
      const opcode = firstByte & 0x0f;

      // Close frame
      if (opcode === 0x08) {
        socket.end();
        return;
      }
      // Ping
      if (opcode === 0x09) {
        socket.write(Buffer.from([0x8a, 0x00])); // Pong
        return;
      }

      // Text frame
      if (opcode === 0x01) {
        const isMasked = (buffer[1] & 0x80) !== 0;
        let payloadLen = buffer[1] & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }

        let maskingKey = null;
        if (isMasked) {
          maskingKey = buffer.slice(offset, offset + 4);
          offset += 4;
        }

        const rawData = buffer.slice(offset, offset + payloadLen);
        if (isMasked && maskingKey) {
          for (let i = 0; i < rawData.length; i++) {
            rawData[i] ^= maskingKey[i % 4];
          }
        }

        const msgStr = rawData.toString('utf8');
        const msg = JSON.parse(msgStr);

        if (msg.action === 'JOIN_ROOM') {
          currentRoom = String(msg.room);
          if (!rooms.has(currentRoom)) {
            rooms.set(currentRoom, new Set());
          }
          rooms.get(currentRoom).add(sendWS);
          sendWS({ action: 'JOINED_SUCCESS', room: currentRoom });
          return;
        }

        if (currentRoom && rooms.has(currentRoom)) {
          const subscribers = rooms.get(currentRoom);
          for (const sendFn of subscribers) {
            sendFn(msg);
          }
        }
      }
    } catch (err) {
      console.error('WS parse error:', err);
    }
  });

  socket.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(sendWS);
      if (rooms.get(currentRoom).size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });

  socket.on('error', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(sendWS);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n======================================================');
  console.log('       🎡 SERVIDOR DE RULETA DE SORTEOS PRO 🎡       ');
  console.log('======================================================');
  console.log(`\n💻 Computador (Anfitrión): http://localhost:${PORT}`);
  console.log(`📱 Celular (Participante/Control): http://${localIp}:${PORT}`);
  console.log('\n✓ WebSocket nativo activo para sincronización instantánea.');
  console.log('✓ Escanea el código QR desde tu celular conectado a la misma red Wi-Fi.\n');
  console.log('======================================================\n');
});
