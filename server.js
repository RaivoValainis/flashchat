const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Atbalstām lielus foto failus līdz 25 MB tīkla buferī (klientam atļauts līdz 10 MB foto)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  maxHttpBufferSize: 25 * 1024 * 1024, // 25 MB
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'chat-data.json');

// Pārliecināmies par datu mapi
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Noklusējuma admin parole: raivojanis37
let appState = {
  adminPassword: 'raivojanis37',
  rooms: {}
};

// Saglabājam datus diskā (atomiski, lai nekas nepazustu Render restartos)
function saveStateToDisk() {
  try {
    const tempFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(appState, null, 2), 'utf-8');
    fs.renameSync(tempFile, DATA_FILE);
  } catch (err) {
    console.error('Kļūda saglabājot datus diskā:', err);
  }
}

// Ielādējam datus no diska startējoties
function loadStateFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        appState.adminPassword = parsed.adminPassword || 'raivojanis37';
        appState.rooms = parsed.rooms || {};
        console.log(`[FlashChat] Dati veiksmīgi ielādēti! Istabu skaits: ${Object.keys(appState.rooms).length}`);
      }
    } else {
      console.log('[FlashChat] chat-data.json netika atrasts, izveidojam jaunu stāvokli.');
      saveStateToDisk();
    }
  } catch (err) {
    console.error('Kļūda ielādējot datus no diska:', err);
  }
}

loadStateFromDisk();

// Palīgfunkcijas
function hashPassword(pass) {
  if (!pass) return '';
  return crypto.createHash('sha256').update(pass).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function sanitizeRoomId(name) {
  let clean = name.toLowerCase()
    .replace(/[^\p{L}\p{N}_-]/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!clean) clean = 'room-' + Math.random().toString(36).substring(2, 8);
  return clean;
}

// Aktīvās admin sesijas
const adminSessions = new Set();

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ error: 'Nav autorizēts vai sesija beigusies' });
  }
  next();
}

// Istabas dalībnieki reāllaikā (socket tracking)
// roomId -> Map(socketId -> { username, joinedAt })
const activeRoomUsers = new Map();

function getRoomUserList(roomId) {
  const map = activeRoomUsers.get(roomId);
  if (!map) return [];
  return Array.from(map.values());
}

// --- MARŠRUTI (ROUTES) ---

// Slēptais Admin Panelis (nav redzams lietotāju čata logā)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Tiešā saite uz istabu saņēmējam (piemēram: /room/draugi vai /room/darbs)
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Pārbauda istabas statusu pirms ieiešanas (vai eksistē, vai vajag paroli)
app.get('/api/room-check/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = appState.rooms[roomId];
  if (!room) {
    return res.status(404).json({ error: 'Istaba netika atrasta vai ir izdzēsta' });
  }
  res.json({
    id: room.id,
    name: room.name,
    hasPassword: !!room.passwordHash,
    createdAt: room.createdAt,
    onlineCount: getRoomUserList(roomId).length
  });
});

// Publisko istabu saraksts (tikai tām, kurām nav paroles vai ko admin atļauj)
app.get('/api/public-rooms', (req, res) => {
  const list = Object.values(appState.rooms).map(r => ({
    id: r.id,
    name: r.name,
    hasPassword: !!r.passwordHash,
    onlineCount: getRoomUserList(r.id).length
  }));
  res.json({ rooms: list });
});

// --- ADMIN API ---

// Admin pieslēgšanās
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === appState.adminPassword) {
    const token = generateToken();
    adminSessions.add(token);
    return res.json({ success: true, token });
  }
  return res.status(401).json({ error: 'Nepareiza administratora parole!' });
});

// Pārbauda admin sesiju
app.get('/api/admin/check', requireAdmin, (req, res) => {
  res.json({ valid: true });
});

// Admin paroles maiņa
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.trim().length < 4) {
    return res.status(400).json({ error: 'Jaunajai parolei jābūt vismaz 4 simbolus garai' });
  }
  appState.adminPassword = newPassword.trim();
  saveStateToDisk();
  res.json({ success: true, message: 'Admin parole veiksmīgi nomainīta!' });
});

// Iegūt visas istabas administrēšanai
app.get('/api/admin/rooms', requireAdmin, (req, res) => {
  const rooms = Object.values(appState.rooms).map(r => ({
    id: r.id,
    name: r.name,
    hasPassword: !!r.passwordHash,
    createdAt: r.createdAt,
    messageCount: r.messages ? r.messages.length : 0,
    onlineCount: getRoomUserList(r.id).length
  }));
  res.json({ rooms });
});

// Izveidot jaunu istabu no Admin paneļa
app.post('/api/admin/rooms', requireAdmin, (req, res) => {
  const { name, password, customId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Istabas nosaukums ir obligāts' });
  }

  let roomId = customId ? sanitizeRoomId(customId) : sanitizeRoomId(name);
  if (!roomId) roomId = 'istaba-' + Math.random().toString(36).substring(2, 7);

  // Ja tāds ID jau eksistē, pievienojam unikālu sufiksu
  if (appState.rooms[roomId]) {
    roomId = `${roomId}-${Math.random().toString(36).substring(2, 6)}`;
  }

  const newRoom = {
    id: roomId,
    name: name.trim(),
    passwordHash: password ? hashPassword(password.trim()) : '',
    createdAt: new Date().toISOString(),
    messages: []
  };

  appState.rooms[roomId] = newRoom;
  saveStateToDisk();

  res.json({
    success: true,
    room: {
      id: newRoom.id,
      name: newRoom.name,
      hasPassword: !!newRoom.passwordHash,
      createdAt: newRoom.createdAt
    }
  });
});

// Rediģēt istabu no Admin paneļa
app.put('/api/admin/rooms/:roomId', requireAdmin, (req, res) => {
  const { roomId } = req.params;
  const { name, password, removePassword } = req.body;

  const room = appState.rooms[roomId];
  if (!room) {
    return res.status(404).json({ error: 'Istaba netika atrasta' });
  }

  if (name && name.trim()) {
    room.name = name.trim();
  }

  if (removePassword) {
    room.passwordHash = '';
  } else if (password && password.trim()) {
    room.passwordHash = hashPassword(password.trim());
  }

  saveStateToDisk();

  // Paziņojam istabā esošajiem lietotājiem par izmaiņām
  io.to(roomId).emit('room_updated', {
    id: room.id,
    name: room.name,
    hasPassword: !!room.passwordHash
  });

  res.json({ success: true, room: { id: room.id, name: room.name, hasPassword: !!room.passwordHash } });
});

// Dzēst istabu no Admin paneļa
app.delete('/api/admin/rooms/:roomId', requireAdmin, (req, res) => {
  const { roomId } = req.params;
  const room = appState.rooms[roomId];
  if (!room) {
    return res.status(404).json({ error: 'Istaba netika atrasta' });
  }

  // Paziņojam visiem istabas lietotājiem un izmetam
  io.to(roomId).emit('room_deleted', { message: 'Administrators ir izdzēsis šo istabu.' });
  activeRoomUsers.delete(roomId);

  delete appState.rooms[roomId];
  saveStateToDisk();

  res.json({ success: true, message: 'Istaba veiksmīgi izdzēsta' });
});

// Skatīt istabas sarakstes žurnālu Admin panelī
app.get('/api/admin/rooms/:roomId/messages', requireAdmin, (req, res) => {
  const { roomId } = req.params;
  const room = appState.rooms[roomId];
  if (!room) {
    return res.status(404).json({ error: 'Istaba netika atrasta' });
  }
  res.json({ messages: room.messages || [] });
});

// Iztīrīt istabas ziņojumus
app.delete('/api/admin/rooms/:roomId/messages', requireAdmin, (req, res) => {
  const { roomId } = req.params;
  const room = appState.rooms[roomId];
  if (!room) {
    return res.status(404).json({ error: 'Istaba netika atrasta' });
  }
  room.messages = [];
  saveStateToDisk();
  io.to(roomId).emit('messages_cleared');
  res.json({ success: true, message: 'Ziņojumi iztīrīti' });
});

// --- SOCKET.IO REĀLLAIKA LOĢIKA ---

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentUsername = null;

  // Lietotājs pieslēdzas istabai
  socket.on('join_room', ({ roomId, username, password }) => {
    if (!roomId || !username || !username.trim()) {
      return socket.emit('error_msg', 'Nepieciešams istabas ID un lietotājvārds!');
    }

    const room = appState.rooms[roomId];
    if (!room) {
      return socket.emit('error_msg', 'Šāda istaba neeksistē vai ir izdzēsta.');
    }

    // Paroles pārbaude, ja istabai ir parole
    if (room.passwordHash) {
      if (!password || hashPassword(password) !== room.passwordHash) {
        return socket.emit('error_msg', 'Nepareiza istabas parole!');
      }
    }

    currentRoomId = roomId;
    currentUsername = username.trim().slice(0, 30);

    socket.join(roomId);

    // Reģistrējam aktīvo lietotāju
    if (!activeRoomUsers.has(roomId)) {
      activeRoomUsers.set(roomId, new Map());
    }
    activeRoomUsers.get(roomId).set(socket.id, {
      id: socket.id,
      username: currentUsername,
      joinedAt: new Date().toISOString()
    });

    // Nosūtām lietotājam istabas datus un iepriekšējo vēsturi (kas saglabāta no Render pamošanās)
    socket.emit('joined_successfully', {
      room: {
        id: room.id,
        name: room.name,
        createdAt: room.createdAt
      },
      messages: room.messages || [],
      users: getRoomUserList(roomId)
    });

    // Paziņojam pārējiem par jaunu lietotāju
    socket.to(roomId).emit('user_joined', {
      username: currentUsername,
      users: getRoomUserList(roomId)
    });
  });

  // Jauna ziņa (Teksts vai Foto līdz 10MB)
  socket.on('send_message', (data) => {
    if (!currentRoomId || !currentUsername) return;
    const room = appState.rooms[currentRoomId];
    if (!room) return;

    const { text, image, fileName, fileSize } = data;

    // Drošības pārbaude bildei: ne vairāk kā 11 MB base64
    if (image && typeof image === 'string' && image.length > 15 * 1024 * 1024) {
      return socket.emit('error_msg', 'Fotoattēla izmērs pārsniedz maksimālos 10 MB!');
    }

    if (!text && !image) return;

    const msgObj = {
      id: crypto.randomUUID(),
      sender: currentUsername,
      senderId: socket.id,
      text: text ? String(text).trim().slice(0, 2000) : '',
      image: image || null,
      fileName: fileName || null,
      fileSize: fileSize || null,
      timestamp: new Date().toISOString()
    };

    if (!room.messages) room.messages = [];
    room.messages.push(msgObj);

    // Ja ziņu par daudz, atstājam pēdējās 500 ziņas, lai atmiņa būtu stabila
    if (room.messages.length > 500) {
      room.messages = room.messages.slice(-500);
    }

    // Saglabājam diskā uzreiz, lai Render pamošanās gadījumā nekas nepazustu
    saveStateToDisk();

    // Nosūtam visiem istabas dalībniekiem
    io.to(currentRoomId).emit('new_message', msgObj);
  });

  // Rakstīšanas indikators ("lietotājs raksta...")
  socket.on('typing', ({ isTyping }) => {
    if (!currentRoomId || !currentUsername) return;
    socket.to(currentRoomId).emit('user_typing', {
      username: currentUsername,
      isTyping: !!isTyping
    });
  });

  // Atvienošanās
  socket.on('disconnect', () => {
    if (currentRoomId && activeRoomUsers.has(currentRoomId)) {
      const roomMap = activeRoomUsers.get(currentRoomId);
      roomMap.delete(socket.id);
      if (roomMap.size === 0) {
        activeRoomUsers.delete(currentRoomId);
      }
      io.to(currentRoomId).emit('user_left', {
        username: currentUsername,
        users: getRoomUserList(currentRoomId)
      });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`[FlashChat] Serveris aktīvs portā ${PORT}!`);
  console.log(`Publiskais čats: http://localhost:${PORT}`);
  console.log(`Slēptais Admin Panelis: http://localhost:${PORT}/admin`);
  console.log(`Admin noklusējuma parole: ${appState.adminPassword}`);
  console.log(`===============================================`);
});
