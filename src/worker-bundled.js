import { DurableObject } from "cloudflare:workers";

// Palīgfunkcija SHA-256 paroles hešošanai Web Crypto API
async function hashPassword(pass) {
  if (!pass) return "";
  const msgBuffer = new TextEncoder().encode(pass);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sanitizeRoomId(name) {
  let clean = String(name || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!clean) clean = "room-" + Math.random().toString(36).substring(2, 8);
  return clean;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

// Durable Object ar SQLite datubāzi (100% pieejams Cloudflare Free plānā ar new_sqlite_classes)
export class ChatHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initDatabase();
  }

  initDatabase() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        has_image INTEGER NOT NULL DEFAULT 0,
        file_name TEXT,
        file_size INTEGER,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS image_chunks (
        message_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_data TEXT NOT NULL,
        PRIMARY KEY (message_id, chunk_index)
      );
    `);

    const existingPass = this.sql
      .exec("SELECT value FROM config WHERE key = 'adminPassword'")
      .toArray();
    if (existingPass.length === 0) {
      const defaultPass = this.env.ADMIN_PASSWORD || "raivojanis37";
      this.sql.exec(
        "INSERT INTO config (key, value) VALUES ('adminPassword', ?)",
        defaultPass
      );
    }
  }

  getAdminPassword() {
    const rows = this.sql
      .exec("SELECT value FROM config WHERE key = 'adminPassword'")
      .toArray();
    return rows.length > 0 ? rows[0].value : "raivojanis37";
  }

  isValidAdminToken(req) {
    const url = new URL(req.url);
    const token = req.headers.get("x-admin-token") || url.searchParams.get("token");
    if (!token) return false;
    const rows = this.sql
      .exec("SELECT token FROM admin_sessions WHERE token = ?", token)
      .toArray();
    return rows.length > 0;
  }

  // Aktīvie WebSocket lietotāji konkrētā istabā (izmantojot Hibernation API)
  getRoomUsers(roomId) {
    const sockets = this.ctx.getWebSockets(roomId);
    const users = [];
    for (const ws of sockets) {
      const meta = ws.deserializeAttachment();
      if (meta && meta.username) {
        users.push({
          id: meta.id,
          username: meta.username,
          joinedAt: meta.joinedAt,
        });
      }
    }
    return users;
  }

  broadcastToRoom(roomId, event, payload, excludeWs = null) {
    const sockets = this.ctx.getWebSockets(roomId);
    const msg = JSON.stringify({ event, data: payload });
    for (const ws of sockets) {
      if (ws !== excludeWs) {
        try {
          ws.send(msg);
        } catch (e) {
          // Ignorējam atvienotus socketus
        }
      }
    }
  }

  getRoomMessages(roomId) {
    const rows = this.sql
      .exec(
        "SELECT id, sender, text, has_image, file_name, file_size, timestamp FROM messages WHERE room_id = ? ORDER BY timestamp ASC LIMIT 500",
        roomId
      )
      .toArray();
    return rows.map((r) => ({
      id: r.id,
      sender: r.sender,
      text: r.text,
      image: r.has_image ? `/api/images/${r.id}` : null,
      fileName: r.file_name,
      fileSize: r.file_size,
      timestamp: r.timestamp,
    }));
  }

  saveImageChunks(messageId, dataUrl) {
    const chunkSize = 400 * 1024; // 400 KB gabalos (droši zem 2MB SQLite rindas limita)
    let index = 0;
    for (let i = 0; i < dataUrl.length; i += chunkSize) {
      const piece = dataUrl.slice(i, i + chunkSize);
      this.sql.exec(
        "INSERT INTO image_chunks (message_id, chunk_index, chunk_data) VALUES (?, ?, ?)",
        messageId,
        index,
        piece
      );
      index++;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1. WebSocket savienojums (/ws)
    if (path === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const roomId = url.searchParams.get("roomId") || "";
      const username = (url.searchParams.get("username") || "").trim().slice(0, 30);
      const password = url.searchParams.get("password") || "";

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const roomRows = this.sql
        .exec("SELECT id, name, password_hash, created_at FROM rooms WHERE id = ?", roomId)
        .toArray();

      if (roomRows.length === 0) {
        this.ctx.acceptWebSocket(server);
        server.send(
          JSON.stringify({
            event: "error_msg",
            data: "Šāda istaba neeksistē vai ir izdzēsta.",
          })
        );
        server.close(1008, "Room not found");
        return new Response(null, { status: 101, webSocket: client });
      }

      const room = roomRows[0];
      if (room.password_hash) {
        const passHash = await hashPassword(password);
        if (!password || passHash !== room.password_hash) {
          this.ctx.acceptWebSocket(server);
          server.send(
            JSON.stringify({
              event: "error_msg",
              data: "Nepareiza istabas parole!",
            })
          );
          server.close(1008, "Invalid password");
          return new Response(null, { status: 101, webSocket: client });
        }
      }

      const clientId = crypto.randomUUID();
      const joinedAt = new Date().toISOString();

      // Reģistrējam WebSocket ar tagu = roomId, lai Hibernation API to grupētu
      this.ctx.acceptWebSocket(server, [roomId]);
      server.serializeAttachment({
        id: clientId,
        roomId,
        username,
        joinedAt,
      });

      const users = this.getRoomUsers(roomId);
      const messages = this.getRoomMessages(roomId);

      server.send(
        JSON.stringify({
          event: "joined_successfully",
          data: {
            room: {
              id: room.id,
              name: room.name,
              createdAt: room.created_at,
            },
            messages,
            users,
          },
        })
      );

      this.broadcastToRoom(
        roomId,
        "user_joined",
        { username, users },
        server
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Fotoattēlu atdošana no SQLite gabaliem (līdz 10 MB)
    if (path.startsWith("/api/images/") && method === "GET") {
      const messageId = decodeURIComponent(path.substring("/api/images/".length));
      const chunks = this.sql
        .exec(
          "SELECT chunk_data FROM image_chunks WHERE message_id = ? ORDER BY chunk_index ASC",
          messageId
        )
        .toArray();
      if (chunks.length === 0) {
        return new Response("Attēls nav atrasts", { status: 404 });
      }
      const dataUrl = chunks.map((c) => c.chunk_data).join("");
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        return new Response("Nederīgs attēla formāts", { status: 400 });
      }
      const mimeType = match[1];
      const base64Data = match[2];
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Robots-Tag": "noindex",
        },
      });
    }

    // 3. Ziņas vai 10 MB foto nosūtīšana caur HTTP POST (/api/rooms/:roomId/messages)
    if (path.startsWith("/api/rooms/") && path.endsWith("/messages") && method === "POST") {
      const middle = path.slice("/api/rooms/".length, -"/messages".length);
      const roomId = decodeURIComponent(middle);
      const roomRows = this.sql
        .exec("SELECT id, password_hash FROM rooms WHERE id = ?", roomId)
        .toArray();
      if (roomRows.length === 0) {
        return jsonResponse({ error: "Istaba neeksistē" }, 404);
      }

      const body = await request.json();
      const { sender, text, image, fileName, fileSize } = body;
      if (!sender || (!text && !image)) {
        return jsonResponse({ error: "Tukša ziņa" }, 400);
      }

      if (image && typeof image === "string" && image.length > 15 * 1024 * 1024) {
        return jsonResponse({ error: "Fotoattēla izmērs pārsniedz 10 MB!" }, 413);
      }

      const msgId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const cleanSender = String(sender).trim().slice(0, 30);
      const cleanText = text ? String(text).trim().slice(0, 2000) : "";
      const hasImage = image ? 1 : 0;

      if (hasImage) {
        this.saveImageChunks(msgId, image);
      }

      this.sql.exec(
        "INSERT INTO messages (id, room_id, sender, text, has_image, file_name, file_size, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        msgId,
        roomId,
        cleanSender,
        cleanText,
        hasImage,
        fileName || null,
        fileSize || null,
        timestamp
      );

      const msgObj = {
        id: msgId,
        sender: cleanSender,
        text: cleanText,
        image: hasImage ? `/api/images/${msgId}` : null,
        fileName: fileName || null,
        fileSize: fileSize || null,
        timestamp,
      };

      this.broadcastToRoom(roomId, "new_message", msgObj);
      return jsonResponse({ success: true, message: msgObj });
    }

    // 4. Pārbaudīt istabu pirms pievienošanās (/api/room-check/:roomId)
    if (path.startsWith("/api/room-check/") && method === "GET") {
      const roomId = decodeURIComponent(path.substring("/api/room-check/".length));
      const rows = this.sql
        .exec("SELECT id, name, password_hash, created_at FROM rooms WHERE id = ?", roomId)
        .toArray();
      if (rows.length === 0) {
        return jsonResponse({ error: "Istaba netika atrasta vai ir izdzēsta" }, 404);
      }
      const r = rows[0];
      return jsonResponse({
        id: r.id,
        name: r.name,
        hasPassword: !!r.password_hash,
        createdAt: r.created_at,
        onlineCount: this.getRoomUsers(r.id).length,
      });
    }

    // 5. Publisko istabu saraksts (/api/public-rooms)
    if (path === "/api/public-rooms" && method === "GET") {
      const rows = this.sql
        .exec("SELECT id, name, password_hash FROM rooms ORDER BY created_at DESC")
        .toArray();
      const rooms = rows.map((r) => ({
        id: r.id,
        name: r.name,
        hasPassword: !!r.password_hash,
        onlineCount: this.getRoomUsers(r.id).length,
      }));
      return jsonResponse({ rooms });
    }

    // --- ADMIN API ---
    if (path === "/api/admin/login" && method === "POST") {
      const { password } = await request.json();
      if (password === this.getAdminPassword()) {
        const token = generateToken();
        this.sql.exec(
          "INSERT INTO admin_sessions (token, created_at) VALUES (?, ?)",
          token,
          new Date().toISOString()
        );
        return jsonResponse({ success: true, token });
      }
      return jsonResponse({ error: "Nepareiza administratora parole!" }, 401);
    }

    if (path === "/api/admin/check" && method === "GET") {
      if (!this.isValidAdminToken(request)) {
        return jsonResponse({ error: "Nav autorizēts" }, 401);
      }
      return jsonResponse({ valid: true });
    }

    if (path === "/api/admin/change-password" && method === "POST") {
      if (!this.isValidAdminToken(request)) {
        return jsonResponse({ error: "Nav autorizēts" }, 401);
      }
      const { newPassword } = await request.json();
      if (!newPassword || newPassword.trim().length < 4) {
        return jsonResponse(
          { error: "Jaunajai parolei jābūt vismaz 4 simbolus garai" },
          400
        );
      }
      this.sql.exec(
        "UPDATE config SET value = ? WHERE key = 'adminPassword'",
        newPassword.trim()
      );
      return jsonResponse({
        success: true,
        message: "Admin parole veiksmīgi nomainīta!",
      });
    }

    if (path === "/api/admin/rooms" && method === "GET") {
      if (!this.isValidAdminToken(request)) {
        return jsonResponse({ error: "Nav autorizēts" }, 401);
      }
      const rows = this.sql
        .exec("SELECT id, name, password_hash, created_at FROM rooms ORDER BY created_at DESC")
        .toArray();
      const rooms = rows.map((r) => {
        const countRes = this.sql
          .exec("SELECT COUNT(*) as cnt FROM messages WHERE room_id = ?", r.id)
          .toArray();
        return {
          id: r.id,
          name: r.name,
          hasPassword: !!r.password_hash,
          createdAt: r.created_at,
          messageCount: countRes[0]?.cnt || 0,
          onlineCount: this.getRoomUsers(r.id).length,
        };
      });
      return jsonResponse({ rooms });
    }

    if (path === "/api/admin/rooms" && method === "POST") {
      if (!this.isValidAdminToken(request)) {
        return jsonResponse({ error: "Nav autorizēts" }, 401);
      }
      const { name, password, customId } = await request.json();
      if (!name || !name.trim()) {
        return jsonResponse({ error: "Istabas nosaukums ir obligāts" }, 400);
      }

      let roomId = customId ? sanitizeRoomId(customId) : sanitizeRoomId(name);
      const exists = this.sql
        .exec("SELECT id FROM rooms WHERE id = ?", roomId)
        .toArray();
      if (exists.length > 0) {
        roomId = `${roomId}-${Math.random().toString(36).substring(2, 6)}`;
      }

      const passHash = password && password.trim() ? await hashPassword(password.trim()) : "";
      const createdAt = new Date().toISOString();

      this.sql.exec(
        "INSERT INTO rooms (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)",
        roomId,
        name.trim(),
        passHash,
        createdAt
      );

      return jsonResponse({
        success: true,
        room: {
          id: roomId,
          name: name.trim(),
          hasPassword: !!passHash,
          createdAt,
        },
      });
    }

    if (path.startsWith("/api/admin/rooms/") && path.endsWith("/messages")) {
      if (!this.isValidAdminToken(request)) {
        return jsonResponse({ error: "Nav autorizēts" }, 401);
      }
      const roomId = decodeURIComponent(
        path.slice("/api/admin/rooms/".length, -"/messages".length)
      );

      if (method === "GET") {
        return jsonResponse({ messages: this.getRoomMessages(roomId) });
      }

      if (method === "DELETE") {
        const msgRows = this.sql
          .exec("SELECT id FROM messages WHERE room_id = ?", roomId)
          .toArray();
        for (const m of msgRows) {
          this.sql.exec("DELETE FROM image_chunks WHERE message_id = ?", m.id);
        }
        this.sql.exec("DELETE FROM messages WHERE room_id = ?", roomId);
        this.broadcastToRoom(roomId, "messages_cleared", {});
        return jsonResponse({ success: true, message: "Ziņojumi iztīrīti" });
      }
    }

    if (path.startsWith("/api/admin/rooms/")) {
      if (!this.isValidAdminToken(request)) {
        return jsonResponse({ error: "Nav autorizēts" }, 401);
      }
      const roomId = decodeURIComponent(path.substring("/api/admin/rooms/".length));
      const existing = this.sql
        .exec("SELECT id, name, password_hash FROM rooms WHERE id = ?", roomId)
        .toArray();
      if (existing.length === 0) {
        return jsonResponse({ error: "Istaba netika atrasta" }, 404);
      }

      if (method === "PUT") {
        const { name, password, removePassword } = await request.json();
        const newName = name && name.trim() ? name.trim() : existing[0].name;
        let newPassHash = existing[0].password_hash;

        if (removePassword) {
          newPassHash = "";
        } else if (password && password.trim()) {
          newPassHash = await hashPassword(password.trim());
        }

        this.sql.exec(
          "UPDATE rooms SET name = ?, password_hash = ? WHERE id = ?",
          newName,
          newPassHash,
          roomId
        );

        this.broadcastToRoom(roomId, "room_updated", {
          id: roomId,
          name: newName,
          hasPassword: !!newPassHash,
        });

        return jsonResponse({
          success: true,
          room: { id: roomId, name: newName, hasPassword: !!newPassHash },
        });
      }

      if (method === "DELETE") {
        this.broadcastToRoom(roomId, "room_deleted", {
          message: "Administrators ir izdzēsis šo istabu.",
        });
        for (const ws of this.ctx.getWebSockets(roomId)) {
          try {
            ws.close(1000, "Room deleted");
          } catch (e) {}
        }
        const msgRows = this.sql
          .exec("SELECT id FROM messages WHERE room_id = ?", roomId)
          .toArray();
        for (const m of msgRows) {
          this.sql.exec("DELETE FROM image_chunks WHERE message_id = ?", m.id);
        }
        this.sql.exec("DELETE FROM messages WHERE room_id = ?", roomId);
        this.sql.exec("DELETE FROM rooms WHERE id = ?", roomId);

        return jsonResponse({ success: true, message: "Istaba veiksmīgi izdzēsta" });
      }
    }

    return jsonResponse({ error: "Maršruts nav atrasts" }, 404);
  }

  // WebSocket ziņu apstrāde (Hibernation API)
  async webSocketMessage(ws, message) {
    try {
      const meta = ws.deserializeAttachment();
      if (!meta || !meta.roomId || !meta.username) return;

      const parsed = JSON.parse(message);
      const { event, data } = parsed;

      if (event === "typing") {
        this.broadcastToRoom(
          meta.roomId,
          "user_typing",
          {
            username: meta.username,
            isTyping: !!(data && data.isTyping),
          },
          ws
        );
      } else if (event === "send_message" && data && data.text) {
        const msgId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const cleanText = String(data.text).trim().slice(0, 2000);
        if (!cleanText) return;

        this.sql.exec(
          "INSERT INTO messages (id, room_id, sender, text, has_image, timestamp) VALUES (?, ?, ?, ?, 0, ?)",
          msgId,
          meta.roomId,
          meta.username,
          cleanText,
          timestamp
        );

        const msgObj = {
          id: msgId,
          sender: meta.username,
          text: cleanText,
          image: null,
          timestamp,
        };

        this.broadcastToRoom(meta.roomId, "new_message", msgObj);
      }
    } catch (e) {
      // Ignorējam nekorektu JSON
    }
  }

  async webSocketClose(ws) {
    const meta = ws.deserializeAttachment();
    if (meta && meta.roomId && meta.username) {
      try {
        ws.close();
      } catch (e) {}
      const users = this.getRoomUsers(meta.roomId).filter((u) => u.id !== meta.id);
      this.broadcastToRoom(
        meta.roomId,
        "user_left",
        {
          username: meta.username,
          users,
        },
        ws
      );
    }
  }
}


const STATIC_FILES = {"/index.html":{"content":"<!DOCTYPE html>\n<html lang=\"lv\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">\n  <title>FlashChat</title>\n  <meta name=\"robots\" content=\"noindex, nofollow, noarchive\">\n  <link rel=\"stylesheet\" href=\"/css/style.css\">\n  <link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>\">\n</head>\n<body>\n\n  <!-- Galvenais čata konteiners -->\n  <div class=\"app-container\" id=\"chatApp\" style=\"display: none;\">\n    <!-- Augšējā josla -->\n    <header class=\"chat-header\">\n      <div class=\"chat-header-title\">\n        <div class=\"chat-logo-badge\">⚡</div>\n        <div class=\"room-meta\">\n          <h2 id=\"currentRoomName\">Istaba</h2>\n          <p id=\"onlineMeta\">Tiešsaistē: 1</p>\n        </div>\n      </div>\n      <div class=\"chat-header-actions\">\n        <button class=\"btn\" id=\"shareRoomBtn\" title=\"Kopīgot saiti uz šo istabu\">\n          🔗 Kopīgot\n        </button>\n        <button class=\"btn btn-danger\" id=\"leaveRoomBtn\" title=\"Iziet no istabas\">\n          Iziet\n        </button>\n      </div>\n    </header>\n\n    <!-- Ziņojumu saraksts -->\n    <main class=\"messages-container\" id=\"messagesContainer\">\n      <div class=\"system-message\">\n        Laipni lūgts čata istabā! Ziņas tiek sinhronizētas reāllaikā.\n      </div>\n    </main>\n\n    <!-- Rakstīšanas indikators -->\n    <div class=\"typing-bar\" id=\"typingIndicator\"></div>\n\n    <!-- Ievades josla -->\n    <footer class=\"chat-input-bar\">\n      <!-- Foto pievienošanas poga (līdz 10 MB) -->\n      <label class=\"input-file-btn\" title=\"Pievienot fotoattēlu (līdz 10 MB)\">\n        📷\n        <input type=\"file\" id=\"imageInput\" accept=\"image/*\">\n      </label>\n\n      <!-- Teksta ievade -->\n      <input \n        type=\"text\" \n        id=\"messageInput\" \n        class=\"chat-input-field\" \n        placeholder=\"Ieraksti ziņu...\" \n        autocomplete=\"off\"\n        maxlength=\"2000\"\n      >\n\n      <!-- Nosūtīšanas poga -->\n      <button class=\"btn-send\" id=\"sendMessageBtn\" title=\"Nosūtīt ziņu\">\n        ➤\n      </button>\n    </footer>\n  </div>\n\n  <!-- Sākuma ekrāns, ja nav norādīta istaba adresē -->\n  <div class=\"modal-overlay\" id=\"homeOverlay\" style=\"display: none;\">\n    <div class=\"modal-card\">\n      <div class=\"modal-header\">\n        <div style=\"font-size: 2.4rem; margin-bottom: 8px;\">⚡</div>\n        <h3>FlashChat</h3>\n        <p>Vienkārša un droša saziņa reāllaikā.</p>\n      </div>\n      <div id=\"publicRoomsList\" style=\"margin-bottom: 16px;\">\n        <p style=\"font-size: 0.85rem; color: #9ca3af; margin-bottom: 8px;\">Pieejamās istabas:</p>\n        <div id=\"roomsContainer\" style=\"display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow-y: auto;\">\n          <div style=\"font-size: 0.82rem; color: #6b7280; text-align: center; padding: 12px;\">Nav aktīvu istabu. Lūdz administratoram nosūtīt ielūguma saiti.</div>\n        </div>\n      </div>\n      <div class=\"form-group\" style=\"margin-top: 14px;\">\n        <label>Vai ievadi istabas kodu/nosaukumu:</label>\n        <input type=\"text\" id=\"manualRoomIdInput\" class=\"form-input\" placeholder=\"piem., draugi\">\n      </div>\n      <button class=\"btn btn-primary\" id=\"manualJoinBtn\" style=\"width: 100%; justify-content: center; padding: 11px;\">\n        Atvērt istabu\n      </button>\n    </div>\n  </div>\n\n  <!-- Pievienošanās logs saņēmējam (prasa tikai vārdu, un paroli ja istabai tāda ir) -->\n  <div class=\"modal-overlay\" id=\"joinModal\" style=\"display: none;\">\n    <div class=\"modal-card\">\n      <div class=\"modal-header\">\n        <div style=\"font-size: 2rem; margin-bottom: 6px;\">👋</div>\n        <h3 id=\"joinModalTitle\">Pievienoties istabai</h3>\n        <p id=\"joinModalSubtitle\">Ievadi savu vārdu, lai uzreiz sāktu čatot.</p>\n      </div>\n      <form id=\"joinForm\">\n        <div class=\"form-group\">\n          <label for=\"usernameInput\">Tavs vārds vai segvārds:</label>\n          <input \n            type=\"text\" \n            id=\"usernameInput\" \n            class=\"form-input\" \n            placeholder=\"Piemēram, Jānis\" \n            required \n            maxlength=\"25\"\n            autofocus\n          >\n        </div>\n        <div class=\"form-group\" id=\"passwordGroup\" style=\"display: none;\">\n          <label for=\"roomPasswordInput\">Istabas parole:</label>\n          <input \n            type=\"password\" \n            id=\"roomPasswordInput\" \n            class=\"form-input\" \n            placeholder=\"Ievadi istabas paroli\"\n          >\n        </div>\n        <div class=\"form-actions\">\n          <button type=\"submit\" class=\"btn btn-primary\" id=\"confirmJoinBtn\">\n            Pievienoties čatam\n          </button>\n        </div>\n      </form>\n    </div>\n  </div>\n\n  <!-- Fotoattēlu pilnekrāna skatītājs (Lightbox) -->\n  <div class=\"lightbox\" id=\"imageLightbox\" style=\"display: none;\">\n    <img id=\"lightboxImg\" src=\"\" alt=\"Pilns attēls\">\n  </div>\n\n  <!-- Čata klienta loģika -->\n  <script src=\"/js/chat.js\"></script>\n</body>\n</html>\n","type":"text/html; charset=utf-8"},"/admin.html":{"content":"<!DOCTYPE html>\n<html lang=\"lv\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n  <title>FlashChat - Administratora Panelis</title>\n  <meta name=\"robots\" content=\"noindex, nofollow, noarchive\">\n  <link rel=\"stylesheet\" href=\"/css/style.css\">\n  <link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🛡️</text></svg>\">\n</head>\n<body style=\"overflow-y: auto;\">\n\n  <!-- Autentifikācijas logs -->\n  <div class=\"modal-overlay\" id=\"adminLoginOverlay\" style=\"display: flex;\">\n    <div class=\"modal-card\">\n      <div class=\"modal-header\">\n        <div style=\"font-size: 2.2rem; margin-bottom: 6px;\">🛡️</div>\n        <h3>FlashChat Administrators</h3>\n        <p>Ievadi administratora paroli, lai piekļūtu vadībai.</p>\n      </div>\n      <form id=\"adminLoginForm\">\n        <div class=\"form-group\">\n          <label for=\"adminPasswordInput\">Admin parole:</label>\n          <input \n            type=\"password\" \n            id=\"adminPasswordInput\" \n            class=\"form-input\" \n            placeholder=\"Ievadi paroli (raivojanis37)\" \n            required \n            autofocus\n          >\n        </div>\n        <div class=\"form-actions\">\n          <button type=\"submit\" class=\"btn btn-primary\" id=\"loginBtn\">\n            Pieslēgties\n          </button>\n        </div>\n      </form>\n    </div>\n  </div>\n\n  <!-- Galvenais Admin Panelis -->\n  <div class=\"admin-container\" id=\"adminPanel\" style=\"display: none;\">\n    \n    <header class=\"admin-header\">\n      <div style=\"display: flex; align-items: center; gap: 14px;\">\n        <div class=\"chat-logo-badge\" style=\"background: linear-gradient(135deg, #10b981, #059669);\">🛡️</div>\n        <div>\n          <h1 style=\"font-size: 1.4rem; font-weight: 800; color: #fff;\">FlashChat Vadības Panelis</h1>\n          <p style=\"font-size: 0.85rem; color: #9ca3af;\">Pilna kontrole pār čata istabām un sarakstēm</p>\n        </div>\n      </div>\n      <div style=\"display: flex; gap: 10px; flex-wrap: wrap;\">\n        <button class=\"btn btn-primary\" id=\"openCreateRoomModalBtn\">\n          ➕ Jauna istaba\n        </button>\n        <button class=\"btn\" id=\"openChangePassModalBtn\">\n          🔑 Mainīt paroli\n        </button>\n        <button class=\"btn btn-danger\" id=\"adminLogoutBtn\">\n          Iziet\n        </button>\n      </div>\n    </header>\n\n    <!-- Kopsavilkums -->\n    <div style=\"display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap;\">\n      <div style=\"flex: 1; min-width: 200px; background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 12px; padding: 16px;\">\n        <div style=\"font-size: 0.8rem; color: #9ca3af;\">Aktīvās istabas</div>\n        <div id=\"statTotalRooms\" style=\"font-size: 1.8rem; font-weight: 800; color: #fff; margin-top: 4px;\">0</div>\n      </div>\n      <div style=\"flex: 1; min-width: 200px; background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 12px; padding: 16px;\">\n        <div style=\"font-size: 0.8rem; color: #9ca3af;\">Kopējie lietotāji tiešsaistē</div>\n        <div id=\"statTotalOnline\" style=\"font-size: 1.8rem; font-weight: 800; color: #34d399; margin-top: 4px;\">0</div>\n      </div>\n      <div style=\"flex: 1; min-width: 200px; background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 12px; padding: 16px;\">\n        <div style=\"font-size: 0.8rem; color: #9ca3af;\">Datu drošība</div>\n        <div style=\"font-size: 0.95rem; font-weight: 600; color: #a5b4fc; margin-top: 8px;\">✓ Cloudflare Durable Objects SQLite</div>\n      </div>\n    </div>\n\n    <!-- Istabu saraksts -->\n    <h2 style=\"font-size: 1.15rem; font-weight: 700; margin-bottom: 14px; color: #fff;\">Tavas izveidotās istabas</h2>\n    <div class=\"admin-rooms-grid\" id=\"adminRoomsGrid\">\n      <!-- Dinamiski ielādējas istabu kartītes -->\n    </div>\n\n  </div>\n\n  <!-- MODAL: Izveidot jaunu istabu -->\n  <div class=\"modal-overlay\" id=\"createRoomModal\" style=\"display: none;\">\n    <div class=\"modal-card\">\n      <div class=\"modal-header\">\n        <h3>➕ Izveidot čata istabu</h3>\n        <p>Istaba darbosies bez laika limita, līdz to izdzēsīsi.</p>\n      </div>\n      <form id=\"createRoomForm\">\n        <div class=\"form-group\">\n          <label for=\"newRoomName\">Istabas nosaukums:</label>\n          <input type=\"text\" id=\"newRoomName\" class=\"form-input\" placeholder=\"Piem., Draugi vai Darbs\" required>\n        </div>\n        <div class=\"form-group\">\n          <label for=\"newRoomPassword\">Parole pievienošanās brīdī (nav obligāta):</label>\n          <input type=\"password\" id=\"newRoomPassword\" class=\"form-input\" placeholder=\"Atstāj tukšu, ja brīva pieeja\">\n        </div>\n        <div class=\"form-group\">\n          <label for=\"newRoomCustomId\">Pielāgots saites kods (nav obligāts):</label>\n          <input type=\"text\" id=\"newRoomCustomId\" class=\"form-input\" placeholder=\"piem., slepenais-chats\">\n        </div>\n        <div class=\"form-actions\">\n          <button type=\"button\" class=\"btn\" onclick=\"document.getElementById('createRoomModal').style.display='none'\">Atcelt</button>\n          <button type=\"submit\" class=\"btn btn-primary\">Izveidot</button>\n        </div>\n      </form>\n    </div>\n  </div>\n\n  <!-- MODAL: Rediģēt istabu -->\n  <div class=\"modal-overlay\" id=\"editRoomModal\" style=\"display: none;\">\n    <div class=\"modal-card\">\n      <div class=\"modal-header\">\n        <h3>✏️ Rediģēt istabu</h3>\n        <p>Maini nosaukumu vai piekļuves paroli.</p>\n      </div>\n      <form id=\"editRoomForm\">\n        <input type=\"hidden\" id=\"editRoomId\">\n        <div class=\"form-group\">\n          <label for=\"editRoomName\">Istabas nosaukums:</label>\n          <input type=\"text\" id=\"editRoomName\" class=\"form-input\" required>\n        </div>\n        <div class=\"form-group\">\n          <label for=\"editRoomPassword\">Jauna parole (atstāj tukšu, lai nemainītu):</label>\n          <input type=\"password\" id=\"editRoomPassword\" class=\"form-input\" placeholder=\"Ieraksti jaunu paroli\">\n        </div>\n        <div class=\"form-group\" style=\"display: flex; align-items: center; gap: 8px;\">\n          <input type=\"checkbox\" id=\"editRemovePassword\" style=\"width: 16px; height: 16px; accent-color: var(--accent);\">\n          <label for=\"editRemovePassword\" style=\"margin: 0; cursor: pointer;\">Noņemt paroli (padarīt istabu atvērtu)</label>\n        </div>\n        <div class=\"form-actions\">\n          <button type=\"button\" class=\"btn\" onclick=\"document.getElementById('editRoomModal').style.display='none'\">Atcelt</button>\n          <button type=\"submit\" class=\"btn btn-primary\">Saglabāt izmaiņas</button>\n        </div>\n      </form>\n    </div>\n  </div>\n\n  <!-- MODAL: Sarakstes vēstures skatītājs -->\n  <div class=\"modal-overlay\" id=\"viewLogsModal\" style=\"display: none;\">\n    <div class=\"modal-card\" style=\"max-width: 650px; max-height: 85vh; display: flex; flex-direction: column;\">\n      <div class=\"modal-header\" style=\"display: flex; justify-content: space-between; align-items: center;\">\n        <div>\n          <h3 id=\"logsRoomTitle\">Istabas sarakste</h3>\n          <p id=\"logsRoomSubtitle\">Tiešais sarakstes žurnāls</p>\n        </div>\n        <button class=\"btn btn-danger\" id=\"clearLogsBtn\" style=\"padding: 6px 12px; font-size: 0.78rem;\">\n          🗑️ Iztīrīt ziņas\n        </button>\n      </div>\n      <div id=\"logsContainer\" style=\"flex: 1; overflow-y: auto; background: rgba(0,0,0,0.25); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; max-height: 400px; border: 1px solid rgba(255,255,255,0.06);\">\n        <!-- Ziņu saraksts -->\n      </div>\n      <div class=\"form-actions\" style=\"margin-top: 14px;\">\n        <button type=\"button\" class=\"btn\" style=\"width: 100%; justify-content: center;\" onclick=\"document.getElementById('viewLogsModal').style.display='none'\">Aizvērt</button>\n      </div>\n    </div>\n  </div>\n\n  <!-- MODAL: Mainīt admin paroli -->\n  <div class=\"modal-overlay\" id=\"changePassModal\" style=\"display: none;\">\n    <div class=\"modal-card\">\n      <div class=\"modal-header\">\n        <h3>🔑 Mainīt Administratora Paroli</h3>\n        <p>Iestati jaunu paroli piekļuvei šim panelim.</p>\n      </div>\n      <form id=\"changePassForm\">\n        <div class=\"form-group\">\n          <label for=\"newAdminPassInput\">Jaunā parole:</label>\n          <input type=\"password\" id=\"newAdminPassInput\" class=\"form-input\" placeholder=\"Vismaz 4 simboli\" required minlength=\"4\">\n        </div>\n        <div class=\"form-actions\">\n          <button type=\"button\" class=\"btn\" onclick=\"document.getElementById('changePassModal').style.display='none'\">Atcelt</button>\n          <button type=\"submit\" class=\"btn btn-primary\">Saglabāt paroli</button>\n        </div>\n      </form>\n    </div>\n  </div>\n\n  <!-- Klienta skripts admin panelim -->\n  <script src=\"/js/admin.js\"></script>\n</body>\n</html>\n","type":"text/html; charset=utf-8"},"/css/style.css":{"content":":root {\n  --bg-gradient: linear-gradient(135deg, #0b0f19 0%, #111827 50%, #1a102f 100%);\n  --panel-bg: rgba(22, 27, 44, 0.75);\n  --panel-border: rgba(255, 255, 255, 0.08);\n  --accent: #6366f1;\n  --accent-hover: #4f46e5;\n  --accent-glow: rgba(99, 102, 241, 0.35);\n  --text-main: #f3f4f6;\n  --text-muted: #9ca3af;\n  --bubble-me: linear-gradient(135deg, #6366f1, #8b5cf6);\n  --bubble-other: rgba(30, 41, 59, 0.85);\n  --danger: #ef4444;\n  --success: #10b981;\n  --radius: 14px;\n}\n\n* {\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;\n  -webkit-tap-highlight-color: transparent;\n}\n\nbody {\n  background: var(--bg-gradient);\n  color: var(--text-main);\n  min-height: 100vh;\n  display: flex;\n  flex-direction: column;\n}\n\n/* App Container */\n.app-container {\n  display: flex;\n  flex-direction: column;\n  height: 100vh;\n  max-width: 1100px;\n  margin: 0 auto;\n  width: 100%;\n  position: relative;\n  overflow: hidden;\n}\n\n/* Header */\n.chat-header {\n  padding: 14px 20px;\n  background: var(--panel-bg);\n  backdrop-filter: blur(16px);\n  border-bottom: 1px solid var(--panel-border);\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  z-index: 10;\n}\n\n.chat-header-title {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n}\n\n.chat-logo-badge {\n  width: 38px;\n  height: 38px;\n  border-radius: 10px;\n  background: linear-gradient(135deg, #6366f1, #a855f7);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-weight: 800;\n  font-size: 1.2rem;\n  box-shadow: 0 4px 14px var(--accent-glow);\n}\n\n.room-meta h2 {\n  font-size: 1.1rem;\n  font-weight: 700;\n  color: #fff;\n}\n\n.room-meta p {\n  font-size: 0.8rem;\n  color: var(--text-muted);\n}\n\n.chat-header-actions {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n}\n\n/* Buttons */\n.btn {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  background: rgba(255, 255, 255, 0.08);\n  color: #fff;\n  border: 1px solid var(--panel-border);\n  padding: 8px 14px;\n  border-radius: 8px;\n  font-size: 0.85rem;\n  font-weight: 500;\n  cursor: pointer;\n  transition: all 0.2s ease;\n}\n\n.btn:hover {\n  background: rgba(255, 255, 255, 0.15);\n  border-color: rgba(255, 255, 255, 0.2);\n}\n\n.btn-primary {\n  background: var(--accent);\n  border-color: var(--accent);\n}\n\n.btn-primary:hover {\n  background: var(--accent-hover);\n  box-shadow: 0 0 16px var(--accent-glow);\n}\n\n.btn-danger {\n  background: rgba(239, 68, 68, 0.15);\n  border-color: rgba(239, 68, 68, 0.3);\n  color: #f87171;\n}\n\n.btn-danger:hover {\n  background: #ef4444;\n  color: #fff;\n}\n\n.btn-success {\n  background: var(--success);\n  border-color: var(--success);\n  color: #fff;\n}\n\n/* Messages Area */\n.messages-container {\n  flex: 1;\n  overflow-y: auto;\n  padding: 20px;\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  scroll-behavior: smooth;\n}\n\n.system-message {\n  text-align: center;\n  font-size: 0.78rem;\n  color: var(--text-muted);\n  background: rgba(255, 255, 255, 0.04);\n  padding: 5px 12px;\n  border-radius: 20px;\n  align-self: center;\n  max-width: 80%;\n}\n\n.message-row {\n  display: flex;\n  flex-direction: column;\n  max-width: 75%;\n}\n\n.message-row.me {\n  align-self: flex-end;\n  align-items: flex-end;\n}\n\n.message-row.other {\n  align-self: flex-start;\n  align-items: flex-start;\n}\n\n.message-sender {\n  font-size: 0.75rem;\n  color: var(--text-muted);\n  margin-bottom: 4px;\n  padding: 0 4px;\n}\n\n.message-bubble {\n  padding: 10px 14px;\n  border-radius: var(--radius);\n  font-size: 0.95rem;\n  line-height: 1.45;\n  word-break: break-word;\n  position: relative;\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);\n}\n\n.message-row.me .message-bubble {\n  background: var(--bubble-me);\n  color: #fff;\n  border-bottom-right-radius: 4px;\n}\n\n.message-row.other .message-bubble {\n  background: var(--bubble-other);\n  color: var(--text-main);\n  border-bottom-left-radius: 4px;\n  border: 1px solid var(--panel-border);\n}\n\n.message-image {\n  margin-top: 6px;\n  border-radius: 8px;\n  max-width: 320px;\n  max-height: 320px;\n  object-fit: cover;\n  cursor: pointer;\n  display: block;\n  transition: transform 0.2s ease, opacity 0.2s ease;\n}\n\n.message-image:hover {\n  transform: scale(1.02);\n  opacity: 0.95;\n}\n\n.message-time {\n  font-size: 0.7rem;\n  opacity: 0.65;\n  margin-top: 4px;\n  text-align: right;\n}\n\n/* Typing Indicator */\n.typing-bar {\n  padding: 4px 20px;\n  font-size: 0.78rem;\n  color: var(--accent);\n  min-height: 22px;\n  font-style: italic;\n}\n\n/* Input Area */\n.chat-input-bar {\n  padding: 14px 20px;\n  background: var(--panel-bg);\n  backdrop-filter: blur(16px);\n  border-top: 1px solid var(--panel-border);\n  display: flex;\n  align-items: center;\n  gap: 10px;\n}\n\n.input-file-btn {\n  background: rgba(255, 255, 255, 0.08);\n  border: 1px solid var(--panel-border);\n  color: #fff;\n  border-radius: 10px;\n  width: 44px;\n  height: 44px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  cursor: pointer;\n  font-size: 1.2rem;\n  transition: all 0.2s ease;\n  position: relative;\n  flex-shrink: 0;\n}\n\n.input-file-btn:hover {\n  background: rgba(255, 255, 255, 0.16);\n  border-color: rgba(255, 255, 255, 0.3);\n}\n\n.input-file-btn input[type=\"file\"] {\n  position: absolute;\n  top: 0;\n  left: 0;\n  width: 100%;\n  height: 100%;\n  opacity: 0;\n  cursor: pointer;\n}\n\n.chat-input-field {\n  flex: 1;\n  background: rgba(255, 255, 255, 0.06);\n  border: 1px solid var(--panel-border);\n  border-radius: 10px;\n  padding: 11px 16px;\n  color: #fff;\n  font-size: 0.95rem;\n  outline: none;\n  transition: border-color 0.2s ease, box-shadow 0.2s ease;\n}\n\n.chat-input-field:focus {\n  border-color: var(--accent);\n  box-shadow: 0 0 0 3px var(--accent-glow);\n}\n\n.btn-send {\n  background: var(--accent);\n  border: none;\n  color: #fff;\n  width: 44px;\n  height: 44px;\n  border-radius: 10px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 1.1rem;\n  cursor: pointer;\n  transition: all 0.2s ease;\n  flex-shrink: 0;\n}\n\n.btn-send:hover {\n  background: var(--accent-hover);\n  box-shadow: 0 0 12px var(--accent-glow);\n  transform: translateY(-1px);\n}\n\n/* Modals */\n.modal-overlay {\n  position: fixed;\n  top: 0;\n  left: 0;\n  width: 100%;\n  height: 100%;\n  background: rgba(0, 0, 0, 0.75);\n  backdrop-filter: blur(8px);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: 1000;\n  padding: 20px;\n}\n\n.modal-card {\n  background: #151a2d;\n  border: 1px solid rgba(255, 255, 255, 0.12);\n  border-radius: 16px;\n  width: 100%;\n  max-width: 440px;\n  padding: 26px;\n  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);\n  animation: modalPop 0.25s cubic-bezier(0.16, 1, 0.3, 1);\n}\n\n@keyframes modalPop {\n  0% { transform: scale(0.92); opacity: 0; }\n  100% { transform: scale(1); opacity: 1; }\n}\n\n.modal-header h3 {\n  font-size: 1.25rem;\n  margin-bottom: 8px;\n  color: #fff;\n}\n\n.modal-header p {\n  color: var(--text-muted);\n  font-size: 0.88rem;\n  margin-bottom: 20px;\n}\n\n.form-group {\n  margin-bottom: 16px;\n}\n\n.form-group label {\n  display: block;\n  font-size: 0.82rem;\n  color: #d1d5db;\n  margin-bottom: 6px;\n  font-weight: 500;\n}\n\n.form-input {\n  width: 100%;\n  background: rgba(255, 255, 255, 0.05);\n  border: 1px solid var(--panel-border);\n  border-radius: 8px;\n  padding: 10px 14px;\n  color: #fff;\n  font-size: 0.95rem;\n  outline: none;\n  transition: all 0.2s ease;\n}\n\n.form-input:focus {\n  border-color: var(--accent);\n  box-shadow: 0 0 0 2px var(--accent-glow);\n}\n\n.form-actions {\n  display: flex;\n  gap: 10px;\n  margin-top: 22px;\n}\n\n.form-actions .btn {\n  flex: 1;\n  justify-content: center;\n  padding: 11px;\n}\n\n/* Lightbox Image Preview */\n.lightbox {\n  position: fixed;\n  top: 0;\n  left: 0;\n  width: 100vw;\n  height: 100vh;\n  background: rgba(0, 0, 0, 0.92);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: 2000;\n  cursor: zoom-out;\n  padding: 20px;\n}\n\n.lightbox img {\n  max-width: 90vw;\n  max-height: 90vh;\n  object-fit: contain;\n  border-radius: 8px;\n  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8);\n}\n\n/* Admin Dashboard Specific Styles */\n.admin-container {\n  max-width: 1000px;\n  margin: 30px auto;\n  padding: 20px;\n  width: 100%;\n}\n\n.admin-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 25px;\n  background: var(--panel-bg);\n  padding: 20px 24px;\n  border-radius: 16px;\n  border: 1px solid var(--panel-border);\n}\n\n.admin-rooms-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));\n  gap: 18px;\n}\n\n.room-card {\n  background: var(--panel-bg);\n  border: 1px solid var(--panel-border);\n  border-radius: 14px;\n  padding: 18px;\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  transition: transform 0.2s ease, border-color 0.2s ease;\n}\n\n.room-card:hover {\n  transform: translateY(-2px);\n  border-color: rgba(99, 102, 241, 0.4);\n}\n\n.room-card-head {\n  display: flex;\n  justify-content: space-between;\n  align-items: flex-start;\n}\n\n.room-card-title {\n  font-size: 1.1rem;\n  font-weight: 700;\n  color: #fff;\n  margin-bottom: 4px;\n}\n\n.badge {\n  font-size: 0.72rem;\n  padding: 3px 8px;\n  border-radius: 12px;\n  font-weight: 600;\n}\n\n.badge-open {\n  background: rgba(16, 185, 129, 0.2);\n  color: #34d399;\n}\n\n.badge-locked {\n  background: rgba(245, 158, 11, 0.2);\n  color: #fbbf24;\n}\n\n.room-card-stats {\n  font-size: 0.82rem;\n  color: var(--text-muted);\n  display: flex;\n  gap: 14px;\n}\n\n.room-card-actions {\n  display: flex;\n  gap: 8px;\n  margin-top: 6px;\n  flex-wrap: wrap;\n}\n\n.room-card-actions .btn {\n  flex: 1;\n  justify-content: center;\n  font-size: 0.8rem;\n  padding: 7px 10px;\n}\n\n/* Toast Notification */\n.toast-notice {\n  position: fixed;\n  bottom: 24px;\n  right: 24px;\n  background: #1f2937;\n  color: #fff;\n  border: 1px solid var(--accent);\n  padding: 12px 20px;\n  border-radius: 10px;\n  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);\n  font-size: 0.9rem;\n  z-index: 9999;\n  animation: slideIn 0.2s ease;\n}\n\n@keyframes slideIn {\n  from { transform: translateY(15px); opacity: 0; }\n  to { transform: translateY(0); opacity: 1; }\n}\n\n@media (max-width: 640px) {\n  .app-container {\n    height: 100vh;\n  }\n  .chat-header {\n    padding: 10px 14px;\n  }\n  .messages-container {\n    padding: 14px;\n  }\n  .message-row {\n    max-width: 88%;\n  }\n}\n","type":"text/css; charset=utf-8"},"/js/chat.js":{"content":"// FlashChat Klienta Loģika (Cloudflare Workers + Durable Objects WebSocket + 10MB Foto)\n(() => {\n  let ws = null;\n  let currentRoom = null;\n  let myUsername = '';\n  let myPassword = '';\n  let typingTimeout = null;\n  let renderedMessageIds = new Set();\n\n  // DOM elementi\n  const chatApp = document.getElementById('chatApp');\n  const homeOverlay = document.getElementById('homeOverlay');\n  const joinModal = document.getElementById('joinModal');\n  const joinForm = document.getElementById('joinForm');\n  const joinModalTitle = document.getElementById('joinModalTitle');\n  const usernameInput = document.getElementById('usernameInput');\n  const passwordGroup = document.getElementById('passwordGroup');\n  const roomPasswordInput = document.getElementById('roomPasswordInput');\n  const currentRoomName = document.getElementById('currentRoomName');\n  const onlineMeta = document.getElementById('onlineMeta');\n  const messagesContainer = document.getElementById('messagesContainer');\n  const typingIndicator = document.getElementById('typingIndicator');\n  const messageInput = document.getElementById('messageInput');\n  const sendMessageBtn = document.getElementById('sendMessageBtn');\n  const imageInput = document.getElementById('imageInput');\n  const shareRoomBtn = document.getElementById('shareRoomBtn');\n  const leaveRoomBtn = document.getElementById('leaveRoomBtn');\n  const imageLightbox = document.getElementById('imageLightbox');\n  const lightboxImg = document.getElementById('lightboxImg');\n  const roomsContainer = document.getElementById('roomsContainer');\n  const manualRoomIdInput = document.getElementById('manualRoomIdInput');\n  const manualJoinBtn = document.getElementById('manualJoinBtn');\n\n  // Web Audio paziņojuma skaņa\n  function playNotificationSound() {\n    try {\n      const AudioCtx = window.AudioContext || window.webkitAudioContext;\n      if (!AudioCtx) return;\n      const ctx = new AudioCtx();\n      const osc = ctx.createOscillator();\n      const gain = ctx.createGain();\n\n      osc.type = 'sine';\n      osc.frequency.setValueAtTime(587.33, ctx.currentTime);\n      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);\n\n      gain.gain.setValueAtTime(0.08, ctx.currentTime);\n      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);\n\n      osc.connect(gain);\n      gain.connect(ctx.destination);\n\n      osc.start();\n      osc.stop(ctx.currentTime + 0.25);\n    } catch (e) {}\n  }\n\n  function showToast(message, isError = false) {\n    const existing = document.querySelector('.toast-notice');\n    if (existing) existing.remove();\n\n    const toast = document.createElement('div');\n    toast.className = 'toast-notice';\n    if (isError) {\n      toast.style.borderColor = '#ef4444';\n      toast.style.color = '#fca5a5';\n    }\n    toast.textContent = message;\n    document.body.appendChild(toast);\n\n    setTimeout(() => {\n      toast.remove();\n    }, 3000);\n  }\n\n  function detectRoomIdFromUrl() {\n    const path = window.location.pathname;\n    const roomPrefix = '/room/';\n    if (path.startsWith(roomPrefix) && path.length > roomPrefix.length) {\n      return decodeURIComponent(path.substring(roomPrefix.length).replace(/\\/$/, ''));\n    }\n    const params = new URLSearchParams(window.location.search);\n    return params.get('room') || params.get('r') || null;\n  }\n\n  const targetRoomId = detectRoomIdFromUrl();\n\n  if (targetRoomId) {\n    prepareJoinModal(targetRoomId);\n  } else {\n    showHomeScreen();\n  }\n\n  async function prepareJoinModal(roomId) {\n    try {\n      const res = await fetch(`/api/room-check/${encodeURIComponent(roomId)}`);\n      if (!res.ok) {\n        showToast('Istaba netika atrasta vai ir izdzēsta!', true);\n        showHomeScreen();\n        return;\n      }\n      const room = await res.json();\n      currentRoom = room;\n\n      joinModalTitle.textContent = `Pievienoties: ${room.name}`;\n      if (room.hasPassword) {\n        passwordGroup.style.display = 'block';\n        roomPasswordInput.required = true;\n      } else {\n        passwordGroup.style.display = 'none';\n        roomPasswordInput.required = false;\n      }\n\n      homeOverlay.style.display = 'none';\n      joinModal.style.display = 'flex';\n      usernameInput.focus();\n    } catch (err) {\n      showToast('Savienojuma kļūda pārbaudot istabu', true);\n      showHomeScreen();\n    }\n  }\n\n  async function showHomeScreen() {\n    homeOverlay.style.display = 'flex';\n    joinModal.style.display = 'none';\n    chatApp.style.display = 'none';\n\n    try {\n      const res = await fetch('/api/public-rooms');\n      const data = await res.json();\n      if (data.rooms && data.rooms.length > 0) {\n        roomsContainer.innerHTML = '';\n        data.rooms.forEach(r => {\n          const item = document.createElement('div');\n          item.style.cssText = 'padding: 10px 14px; background: rgba(255,255,255,0.06); border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(255,255,255,0.08);';\n          item.innerHTML = `\n            <div>\n              <strong style=\"color: #fff; font-size: 0.95rem;\">${escapeHtml(r.name)}</strong>\n              <div style=\"font-size: 0.75rem; color: #9ca3af;\">${r.hasPassword ? '🔒 Ar paroli' : '🔓 Atvērta'}</div>\n            </div>\n            <span style=\"font-size: 0.8rem; color: #6366f1;\">Pievienoties →</span>\n          `;\n          item.onclick = () => {\n            window.location.href = `/room/${encodeURIComponent(r.id)}`;\n          };\n          roomsContainer.appendChild(item);\n        });\n      }\n    } catch (e) {}\n  }\n\n  manualJoinBtn.addEventListener('click', () => {\n    const val = manualRoomIdInput.value.trim();\n    if (val) {\n      window.location.href = `/room/${encodeURIComponent(val)}`;\n    }\n  });\n\n  joinForm.addEventListener('submit', (e) => {\n    e.preventDefault();\n    const username = usernameInput.value.trim();\n    const password = roomPasswordInput.value.trim();\n\n    if (!username) {\n      showToast('Lūdzu ievadi savu vārdu!', true);\n      return;\n    }\n\n    myUsername = username;\n    myPassword = password;\n    initWebSocketConnection(currentRoom.id, username, password);\n  });\n\n  function sendWsEvent(event, data) {\n    if (ws && ws.readyState === WebSocket.OPEN) {\n      ws.send(JSON.stringify({ event, data }));\n    }\n  }\n\n  function initWebSocketConnection(roomId, username, password) {\n    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';\n    const wsUrl = `${protocol}//${window.location.host}/ws?roomId=${encodeURIComponent(roomId)}&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password || '')}`;\n\n    ws = new WebSocket(wsUrl);\n\n    ws.onmessage = (evt) => {\n      try {\n        const msg = JSON.parse(evt.data);\n        const { event, data } = msg;\n\n        if (event === 'error_msg') {\n          showToast(data, true);\n        } else if (event === 'joined_successfully') {\n          joinModal.style.display = 'none';\n          chatApp.style.display = 'flex';\n\n          currentRoomName.textContent = data.room.name;\n          updateOnlineUsers(data.users);\n\n          messagesContainer.innerHTML = '';\n          renderedMessageIds.clear();\n          const introMsg = document.createElement('div');\n          introMsg.className = 'system-message';\n          introMsg.textContent = `Pievienojies istabai \"${data.room.name}\" kā ${myUsername}`;\n          messagesContainer.appendChild(introMsg);\n\n          if (data.messages && data.messages.length > 0) {\n            data.messages.forEach(m => appendMessage(m));\n          }\n          scrollToBottom();\n          messageInput.focus();\n        } else if (event === 'new_message') {\n          appendMessage(data);\n          scrollToBottom();\n          if (data.sender !== myUsername) {\n            playNotificationSound();\n          }\n        } else if (event === 'user_joined') {\n          updateOnlineUsers(data.users);\n          appendSystemNotice(`${data.username} pievienojās čatam`);\n        } else if (event === 'user_left') {\n          updateOnlineUsers(data.users);\n          appendSystemNotice(`${data.username} pameta čatu`);\n        } else if (event === 'user_typing') {\n          if (data.isTyping) {\n            typingIndicator.textContent = `${data.username} raksta...`;\n          } else {\n            typingIndicator.textContent = '';\n          }\n        } else if (event === 'room_updated') {\n          currentRoomName.textContent = data.name;\n          showToast(`Istabas nosaukums atjaunināts: ${data.name}`);\n        } else if (event === 'room_deleted') {\n          alert(data.message || 'Šī istaba tika izdzēsta.');\n          window.location.href = '/';\n        } else if (event === 'messages_cleared') {\n          messagesContainer.innerHTML = '';\n          renderedMessageIds.clear();\n          appendSystemNotice('Administrators iztīrīja visas sarunas.');\n        }\n      } catch (e) {}\n    };\n  }\n\n  function appendMessage(msg) {\n    if (msg.id && renderedMessageIds.has(msg.id)) return;\n    if (msg.id) renderedMessageIds.add(msg.id);\n\n    const isMe = msg.sender === myUsername;\n    const row = document.createElement('div');\n    row.className = `message-row ${isMe ? 'me' : 'other'}`;\n\n    const sender = document.createElement('div');\n    sender.className = 'message-sender';\n    sender.textContent = isMe ? 'Tu' : msg.sender;\n    row.appendChild(sender);\n\n    const bubble = document.createElement('div');\n    bubble.className = 'message-bubble';\n\n    if (msg.text) {\n      const textSpan = document.createElement('div');\n      textSpan.textContent = msg.text;\n      bubble.appendChild(textSpan);\n    }\n\n    if (msg.image) {\n      const img = document.createElement('img');\n      img.src = msg.image;\n      img.alt = msg.fileName || 'Foto';\n      img.className = 'message-image';\n      img.onload = () => scrollToBottom();\n      img.onclick = () => openLightbox(msg.image);\n      bubble.appendChild(img);\n    }\n\n    const time = document.createElement('div');\n    time.className = 'message-time';\n    const d = msg.timestamp ? new Date(msg.timestamp) : new Date();\n    time.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });\n    bubble.appendChild(time);\n\n    row.appendChild(bubble);\n    messagesContainer.appendChild(row);\n  }\n\n  function appendSystemNotice(text) {\n    const notice = document.createElement('div');\n    notice.className = 'system-message';\n    notice.textContent = text;\n    messagesContainer.appendChild(notice);\n    scrollToBottom();\n  }\n\n  function updateOnlineUsers(users) {\n    const count = users ? users.length : 1;\n    onlineMeta.textContent = `Tiešsaistē: ${count} ${count === 1 ? 'dalībnieks' : 'dalībnieki'}`;\n  }\n\n  function scrollToBottom() {\n    messagesContainer.scrollTop = messagesContainer.scrollHeight;\n  }\n\n  function handleSendMessage() {\n    const text = messageInput.value.trim();\n    if (!text) return;\n\n    sendWsEvent('send_message', { text });\n    messageInput.value = '';\n    sendWsEvent('typing', { isTyping: false });\n  }\n\n  sendMessageBtn.addEventListener('click', handleSendMessage);\n  messageInput.addEventListener('keydown', (e) => {\n    if (e.key === 'Enter' && !e.shiftKey) {\n      e.preventDefault();\n      handleSendMessage();\n    }\n  });\n\n  messageInput.addEventListener('input', () => {\n    sendWsEvent('typing', { isTyping: true });\n    clearTimeout(typingTimeout);\n    typingTimeout = setTimeout(() => {\n      sendWsEvent('typing', { isTyping: false });\n    }, 1500);\n  });\n\n  // Fotoattēla augšupielāde līdz 10 MB caur HTTP POST uz Durable Object SQLite\n  imageInput.addEventListener('change', (e) => {\n    const file = e.target.files[0];\n    if (!file) return;\n\n    const maxBytes = 10 * 1024 * 1024; // 10 MB\n    if (file.size > maxBytes) {\n      showToast('Attēla izmērs pārsniedz atļautos 10 MB!', true);\n      imageInput.value = '';\n      return;\n    }\n\n    showToast('Augšupielādē fotoattēlu...');\n    const reader = new FileReader();\n    reader.onload = async () => {\n      try {\n        const base64Data = reader.result;\n        const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoom.id)}/messages`, {\n          method: 'POST',\n          headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify({\n            sender: myUsername,\n            text: '',\n            image: base64Data,\n            fileName: file.name,\n            fileSize: file.size\n          })\n        });\n        const data = await res.json();\n        if (res.ok && data.message) {\n          appendMessage(data.message);\n          scrollToBottom();\n        } else {\n          showToast(data.error || 'Neizdevās nosūtīt fotoattēlu', true);\n        }\n      } catch (err) {\n        showToast('Kļūda augšupielādējot fotoattēlu', true);\n      }\n      imageInput.value = '';\n    };\n    reader.readAsDataURL(file);\n  });\n\n  function openLightbox(src) {\n    lightboxImg.src = src;\n    imageLightbox.style.display = 'flex';\n  }\n\n  imageLightbox.addEventListener('click', () => {\n    imageLightbox.style.display = 'none';\n    lightboxImg.src = '';\n  });\n\n  shareRoomBtn.addEventListener('click', () => {\n    const shareUrl = `${window.location.origin}/room/${encodeURIComponent(currentRoom.id)}`;\n    navigator.clipboard.writeText(shareUrl).then(() => {\n      showToast('📋 Istabas saite nokopēta starpliktuvē!');\n    }).catch(() => {\n      prompt('Kopē šo saiti:', shareUrl);\n    });\n  });\n\n  leaveRoomBtn.addEventListener('click', () => {\n    if (confirm('Vai tiešām vēlies iziet no šīs istabas?')) {\n      window.location.href = '/';\n    }\n  });\n\n  function escapeHtml(str) {\n    if (!str) return '';\n    return str.replace(/[&<>\"']/g, (m) => ({\n      '&': '&amp;',\n      '<': '&lt;',\n      '>': '&gt;',\n      '\"': '&quot;',\n      \"'\": '&#39;'\n    }[m]));\n  }\n})();\n","type":"application/javascript; charset=utf-8"},"/js/admin.js":{"content":"// FlashChat Vadības Paneļa Loģika\n(() => {\n  let adminToken = localStorage.getItem('flashchat_admin_token') || null;\n  let activeLogsRoomId = null;\n\n  // DOM elementi\n  const adminLoginOverlay = document.getElementById('adminLoginOverlay');\n  const adminLoginForm = document.getElementById('adminLoginForm');\n  const adminPasswordInput = document.getElementById('adminPasswordInput');\n  const adminPanel = document.getElementById('adminPanel');\n  const adminRoomsGrid = document.getElementById('adminRoomsGrid');\n  const statTotalRooms = document.getElementById('statTotalRooms');\n  const statTotalOnline = document.getElementById('statTotalOnline');\n  const openCreateRoomModalBtn = document.getElementById('openCreateRoomModalBtn');\n  const createRoomModal = document.getElementById('createRoomModal');\n  const createRoomForm = document.getElementById('createRoomForm');\n  const editRoomModal = document.getElementById('editRoomModal');\n  const editRoomForm = document.getElementById('editRoomForm');\n  const viewLogsModal = document.getElementById('viewLogsModal');\n  const logsContainer = document.getElementById('logsContainer');\n  const logsRoomTitle = document.getElementById('logsRoomTitle');\n  const clearLogsBtn = document.getElementById('clearLogsBtn');\n  const openChangePassModalBtn = document.getElementById('openChangePassModalBtn');\n  const changePassModal = document.getElementById('changePassModal');\n  const changePassForm = document.getElementById('changePassForm');\n  const adminLogoutBtn = document.getElementById('adminLogoutBtn');\n\n  // Paziņojuma lodziņš\n  function showToast(msg, isError = false) {\n    const existing = document.querySelector('.toast-notice');\n    if (existing) existing.remove();\n\n    const toast = document.createElement('div');\n    toast.className = 'toast-notice';\n    if (isError) {\n      toast.style.borderColor = '#ef4444';\n      toast.style.color = '#fca5a5';\n    }\n    toast.textContent = msg;\n    document.body.appendChild(toast);\n\n    setTimeout(() => {\n      toast.remove();\n    }, 3000);\n  }\n\n  // Pārbauda esošo sesijas tokenu\n  async function checkSession() {\n    if (!adminToken) {\n      showLogin();\n      return;\n    }\n\n    try {\n      const res = await fetch('/api/admin/check', {\n        headers: { 'x-admin-token': adminToken }\n      });\n      if (res.ok) {\n        showPanel();\n        loadRooms();\n      } else {\n        showLogin();\n      }\n    } catch (e) {\n      showLogin();\n    }\n  }\n\n  function showLogin() {\n    adminLoginOverlay.style.display = 'flex';\n    adminPanel.style.display = 'none';\n    adminPasswordInput.value = '';\n    adminPasswordInput.focus();\n  }\n\n  function showPanel() {\n    adminLoginOverlay.style.display = 'none';\n    adminPanel.style.display = 'block';\n  }\n\n  // Pieslēgšanās\n  adminLoginForm.addEventListener('submit', async (e) => {\n    e.preventDefault();\n    const pass = adminPasswordInput.value.trim();\n    if (!pass) return;\n\n    try {\n      const res = await fetch('/api/admin/login', {\n        method: 'POST',\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ password: pass })\n      });\n      const data = await res.json();\n      if (res.ok && data.token) {\n        adminToken = data.token;\n        localStorage.setItem('flashchat_admin_token', adminToken);\n        showPanel();\n        loadRooms();\n        showToast('Veiksmīgi pieslēdzies kā administrators!');\n      } else {\n        showToast(data.error || 'Nepareiza parole!', true);\n      }\n    } catch (err) {\n      showToast('Kļūda pieslēdzoties serverim', true);\n    }\n  });\n\n  // Iziet no vadības paneļa\n  adminLogoutBtn.addEventListener('click', () => {\n    adminToken = null;\n    localStorage.removeItem('flashchat_admin_token');\n    showLogin();\n    showToast('Izrakstījies no paneļa');\n  });\n\n  // Ielādē visas istabas\n  async function loadRooms() {\n    try {\n      const res = await fetch('/api/admin/rooms', {\n        headers: { 'x-admin-token': adminToken }\n      });\n      if (!res.ok) {\n        showLogin();\n        return;\n      }\n      const data = await res.json();\n      renderRooms(data.rooms || []);\n    } catch (err) {\n      console.error(err);\n      showToast('Kļūda ielādējot istabas', true);\n    }\n  }\n\n  // Istabu renderēšana\n  function renderRooms(rooms) {\n    adminRoomsGrid.innerHTML = '';\n    statTotalRooms.textContent = rooms.length;\n\n    let totalOnline = 0;\n    rooms.forEach(r => totalOnline += (r.onlineCount || 0));\n    statTotalOnline.textContent = totalOnline;\n\n    if (rooms.length === 0) {\n      adminRoomsGrid.innerHTML = `\n        <div style=\"grid-column: 1 / -1; text-align: center; padding: 40px; background: var(--panel-bg); border-radius: 14px; border: 1px dashed var(--panel-border);\">\n          <div style=\"font-size: 2.2rem; margin-bottom: 8px;\">📭</div>\n          <h3 style=\"color: #fff; margin-bottom: 6px;\">Nav izveidota neviena istaba</h3>\n          <p style=\"color: #9ca3af; font-size: 0.9rem; margin-bottom: 16px;\">Spied \"Jauna istaba\", lai izveidotu pirmo sarunu telpu!</p>\n          <button class=\"btn btn-primary\" onclick=\"document.getElementById('openCreateRoomModalBtn').click()\">➕ Izveidot istabu</button>\n        </div>\n      `;\n      return;\n    }\n\n    rooms.forEach(r => {\n      const card = document.createElement('div');\n      card.className = 'room-card';\n\n      const shareUrl = `${window.location.origin}/room/${encodeURIComponent(r.id)}`;\n      const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('lv-LV', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Nesen';\n\n      card.innerHTML = `\n        <div class=\"room-card-head\">\n          <div>\n            <div class=\"room-card-title\">${escapeHtml(r.name)}</div>\n            <div style=\"font-size: 0.78rem; color: #a5b4fc; font-family: monospace;\">/room/${escapeHtml(r.id)}</div>\n          </div>\n          <span class=\"badge ${r.hasPassword ? 'badge-locked' : 'badge-open'}\">\n            ${r.hasPassword ? '🔒 Ar paroli' : '🔓 Atvērta'}\n          </span>\n        </div>\n\n        <div class=\"room-card-stats\">\n          <span>👥 Tiešsaistē: <strong style=\"color: #fff;\">${r.onlineCount || 0}</strong></span>\n          <span>💬 Ziņas: <strong style=\"color: #fff;\">${r.messageCount || 0}</strong></span>\n        </div>\n\n        <div style=\"font-size: 0.75rem; color: #6b7280;\">Izveidota: ${dateStr}</div>\n\n        <div class=\"room-card-actions\">\n          <button class=\"btn btn-primary btn-share\" data-url=\"${shareUrl}\" title=\"Nokopēt saiti\">\n            🔗 Kopīgot\n          </button>\n          <button class=\"btn btn-edit\" data-id=\"${r.id}\" data-name=\"${escapeHtml(r.name)}\" data-haspass=\"${r.hasPassword}\" title=\"Rediģēt\">\n            ✏️ Rediģēt\n          </button>\n          <button class=\"btn btn-logs\" data-id=\"${r.id}\" data-name=\"${escapeHtml(r.name)}\" title=\"Skatīt saraksti\">\n            👁️ Vēsture\n          </button>\n          <button class=\"btn btn-danger btn-delete\" data-id=\"${r.id}\" data-name=\"${escapeHtml(r.name)}\" title=\"Dzēst istabu\">\n            🗑️\n          </button>\n        </div>\n      `;\n\n      // Notikumu piesaiste pogām\n      card.querySelector('.btn-share').onclick = () => {\n        navigator.clipboard.writeText(shareUrl).then(() => {\n          showToast(`📋 Saite nokopēta: ${shareUrl}`);\n        }).catch(() => {\n          prompt('Kopē šo istabas saiti:', shareUrl);\n        });\n      };\n\n      card.querySelector('.btn-edit').onclick = () => {\n        openEditRoomModal(r.id, r.name, r.hasPassword);\n      };\n\n      card.querySelector('.btn-logs').onclick = () => {\n        openLogsModal(r.id, r.name);\n      };\n\n      card.querySelector('.btn-delete').onclick = () => {\n        deleteRoom(r.id, r.name);\n      };\n\n      adminRoomsGrid.appendChild(card);\n    });\n  }\n\n  // Izveidot istabu\n  openCreateRoomModalBtn.onclick = () => {\n    document.getElementById('newRoomName').value = '';\n    document.getElementById('newRoomPassword').value = '';\n    document.getElementById('newRoomCustomId').value = '';\n    createRoomModal.style.display = 'flex';\n    document.getElementById('newRoomName').focus();\n  };\n\n  createRoomForm.onsubmit = async (e) => {\n    e.preventDefault();\n    const name = document.getElementById('newRoomName').value.trim();\n    const password = document.getElementById('newRoomPassword').value.trim();\n    const customId = document.getElementById('newRoomCustomId').value.trim();\n\n    if (!name) return;\n\n    try {\n      const res = await fetch('/api/admin/rooms', {\n        method: 'POST',\n        headers: {\n          'Content-Type': 'application/json',\n          'x-admin-token': adminToken\n        },\n        body: JSON.stringify({ name, password, customId })\n      });\n      const data = await res.json();\n      if (res.ok && data.success) {\n        createRoomModal.style.display = 'none';\n        showToast(`Istaba \"${name}\" veiksmīgi izveidota!`);\n        loadRooms();\n      } else {\n        showToast(data.error || 'Neizdevās izveidot istabu', true);\n      }\n    } catch (err) {\n      showToast('Kļūda nosūtot datus serverim', true);\n    }\n  };\n\n  // Rediģēt istabu\n  function openEditRoomModal(id, name, hasPassword) {\n    document.getElementById('editRoomId').value = id;\n    document.getElementById('editRoomName').value = name;\n    document.getElementById('editRoomPassword').value = '';\n    document.getElementById('editRemovePassword').checked = false;\n    editRoomModal.style.display = 'flex';\n  }\n\n  editRoomForm.onsubmit = async (e) => {\n    e.preventDefault();\n    const id = document.getElementById('editRoomId').value;\n    const name = document.getElementById('editRoomName').value.trim();\n    const password = document.getElementById('editRoomPassword').value.trim();\n    const removePassword = document.getElementById('editRemovePassword').checked;\n\n    try {\n      const res = await fetch(`/api/admin/rooms/${encodeURIComponent(id)}`, {\n        method: 'PUT',\n        headers: {\n          'Content-Type': 'application/json',\n          'x-admin-token': adminToken\n        },\n        body: JSON.stringify({ name, password, removePassword })\n      });\n      const data = await res.json();\n      if (res.ok && data.success) {\n        editRoomModal.style.display = 'none';\n        showToast('Istaba veiksmīgi atjaunināta!');\n        loadRooms();\n      } else {\n        showToast(data.error || 'Kļūda saglabājot izmaiņas', true);\n      }\n    } catch (err) {\n      showToast('Kļūda savienojumā', true);\n    }\n  };\n\n  // Dzēst istabu\n  async function deleteRoom(id, name) {\n    if (!confirm(`Vai tiešām vēlies izdzēst istabu \"${name}\"?\\nVisi dalībnieki tiks atvienoti un sarakste tiks dzēsta.`)) {\n      return;\n    }\n\n    try {\n      const res = await fetch(`/api/admin/rooms/${encodeURIComponent(id)}`, {\n        method: 'DELETE',\n        headers: { 'x-admin-token': adminToken }\n      });\n      const data = await res.json();\n      if (res.ok && data.success) {\n        showToast(`Istaba \"${name}\" izdzēsta!`);\n        loadRooms();\n      } else {\n        showToast(data.error || 'Neizdevās izdzēst', true);\n      }\n    } catch (err) {\n      showToast('Kļūda dzēšot istabu', true);\n    }\n  }\n\n  // Skatīt sarakstes vēsturi\n  async function openLogsModal(id, name) {\n    activeLogsRoomId = id;\n    logsRoomTitle.textContent = `Sarakste: ${name}`;\n    logsContainer.innerHTML = '<div style=\"color: #9ca3af; text-align: center; padding: 20px;\">Ielādē saraksti...</div>';\n    viewLogsModal.style.display = 'flex';\n\n    try {\n      const res = await fetch(`/api/admin/rooms/${encodeURIComponent(id)}/messages`, {\n        headers: { 'x-admin-token': adminToken }\n      });\n      const data = await res.json();\n      const messages = data.messages || [];\n\n      logsContainer.innerHTML = '';\n      if (messages.length === 0) {\n        logsContainer.innerHTML = '<div style=\"color: #6b7280; text-align: center; padding: 20px;\">Nav nevienas ziņas šajā istabā.</div>';\n        return;\n      }\n\n      messages.forEach(m => {\n        const item = document.createElement('div');\n        item.style.cssText = 'padding: 8px 12px; background: rgba(255,255,255,0.05); border-radius: 8px; font-size: 0.85rem; border-left: 3px solid #6366f1;';\n        const d = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';\n\n        let contentHtml = '';\n        if (m.text) {\n          contentHtml += `<div>${escapeHtml(m.text)}</div>`;\n        }\n        if (m.image) {\n          contentHtml += `<div style=\"margin-top: 4px;\"><img src=\"${m.image}\" style=\"max-height: 80px; border-radius: 6px; cursor: pointer;\" onclick=\"window.open('${m.image}')\" title=\"Klikšķini, lai atvērtu pilnā izmērā\"></div>`;\n        }\n\n        item.innerHTML = `\n          <div style=\"display: flex; justify-content: space-between; margin-bottom: 4px;\">\n            <strong style=\"color: #a5b4fc;\">${escapeHtml(m.sender)}</strong>\n            <span style=\"font-size: 0.72rem; color: #6b7280;\">${d}</span>\n          </div>\n          ${contentHtml}\n        `;\n        logsContainer.appendChild(item);\n      });\n      logsContainer.scrollTop = logsContainer.scrollHeight;\n    } catch (err) {\n      logsContainer.innerHTML = '<div style=\"color: #ef4444; text-align: center; padding: 20px;\">Neizdevās ielādēt ziņas</div>';\n    }\n  }\n\n  // Iztīrīt istabas ziņas\n  clearLogsBtn.onclick = async () => {\n    if (!activeLogsRoomId) return;\n    if (!confirm('Vai tiešām iztīrīt visus ziņojumus no šīs istabas?')) return;\n\n    try {\n      const res = await fetch(`/api/admin/rooms/${encodeURIComponent(activeLogsRoomId)}/messages`, {\n        method: 'DELETE',\n        headers: { 'x-admin-token': adminToken }\n      });\n      if (res.ok) {\n        logsContainer.innerHTML = '<div style=\"color: #6b7280; text-align: center; padding: 20px;\">Ziņojumi ir iztīrīti.</div>';\n        showToast('Ziņojumi iztīrīti!');\n        loadRooms();\n      }\n    } catch (err) {\n      showToast('Kļūda tīrot ziņas', true);\n    }\n  };\n\n  // Mainīt admin paroli\n  openChangePassModalBtn.onclick = () => {\n    document.getElementById('newAdminPassInput').value = '';\n    changePassModal.style.display = 'flex';\n    document.getElementById('newAdminPassInput').focus();\n  };\n\n  changePassForm.onsubmit = async (e) => {\n    e.preventDefault();\n    const newPassword = document.getElementById('newAdminPassInput').value.trim();\n    if (!newPassword || newPassword.length < 4) {\n      showToast('Parolei jābūt vismaz 4 simbolus garai!', true);\n      return;\n    }\n\n    try {\n      const res = await fetch('/api/admin/change-password', {\n        method: 'POST',\n        headers: {\n          'Content-Type': 'application/json',\n          'x-admin-token': adminToken\n        },\n        body: JSON.stringify({ newPassword })\n      });\n      const data = await res.json();\n      if (res.ok && data.success) {\n        changePassModal.style.display = 'none';\n        showToast('Administratora parole veiksmīgi nomainīta!');\n      } else {\n        showToast(data.error || 'Neizdevās nomainīt paroli', true);\n      }\n    } catch (err) {\n      showToast('Kļūda saziņā ar serveri', true);\n    }\n  };\n\n  function escapeHtml(str) {\n    if (!str) return '';\n    return str.replace(/[&<>\"']/g, (m) => ({\n      '&': '&amp;',\n      '<': '&lt;',\n      '>': '&gt;',\n      '\"': '&quot;',\n      \"'\": '&#39;'\n    }[m]));\n  }\n\n  // Sākam pārbaudi\n  checkSession();\n})();\n","type":"application/javascript; charset=utf-8"},"/robots.txt":{"content":"User-agent: *\nDisallow: /\n","type":"text/plain; charset=utf-8"}};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // API un WebSocket maršrutus apkalpo mūsu Durable Object
    if (path.startsWith("/api/") || path === "/ws") {
      const id = env.CHAT_HUB.idFromName("global-flashchat-hub");
      const stub = env.CHAT_HUB.get(id);
      return stub.fetch(request);
    }

    let assetKey = path;
    if (path === "/" || path === "/index.html" || path.startsWith("/room/")) {
      assetKey = "/index.html";
    } else if (path === "/admin" || path === "/admin/" || path === "/admin.html") {
      assetKey = "/admin.html";
    }

    if (STATIC_FILES[assetKey]) {
      return new Response(STATIC_FILES[assetKey].content, {
        status: 200,
        headers: {
          "Content-Type": STATIC_FILES[assetKey].type,
          "X-Robots-Tag": "noindex, nofollow, noarchive"
        }
      });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not Found", { status: 404 });
  },
};
