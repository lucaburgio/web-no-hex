const { WebSocketServer } = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('web-strategic relay');
});
const wss = new WebSocketServer({ server });
const rooms = new Map(); // code → { host: WebSocket, guest: WebSocket | null }

function generateCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

wss.on('connection', (ws) => {
  let roomCode = null;
  let role = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'host') {
      do { roomCode = generateCode(); } while (rooms.has(roomCode));
      rooms.set(roomCode, { host: ws, guest: null });
      role = 'host';
      ws.send(JSON.stringify({ type: 'room-created', code: roomCode }));
    } else if (msg.type === 'join') {
      const code = (msg.code ?? '').toUpperCase();
      const room = rooms.get(code);
      if (!room || room.guest) {
        ws.send(JSON.stringify({ type: 'error', message: room ? 'Room is full.' : 'Room not found.' }));
        return;
      }
      roomCode = code;
      room.guest = ws;
      role = 'guest';
      ws.send(JSON.stringify({ type: 'joined' }));
      room.host.send(JSON.stringify({ type: 'guest-joined' }));
    } else {
      const room = rooms.get(roomCode);
      if (!room) return;
      const other = role === 'host' ? room.guest : room.host;
      if (other && other.readyState === 1) other.send(data.toString());
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const other = role === 'host' ? room.guest : room.host;
    if (other && other.readyState === 1) {
      other.send(JSON.stringify({ type: 'opponent-disconnected' }));
    }
    rooms.delete(roomCode);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Relay server listening on :${PORT}`));
