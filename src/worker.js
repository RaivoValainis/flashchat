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

    // Slēptais Admin panelis
    if (path === "/admin" || path === "/admin/") {
      return env.ASSETS.fetch(new Request(new URL("/admin.html", request.url), request));
    }

    // Tiešā istabas saite saņēmējam (/room/:roomId)
    if (path.startsWith("/room/")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
    }

    // Visi pārējie statiskie faili (index.html, css, js, robots.txt)
    return env.ASSETS.fetch(request);
  },
};
