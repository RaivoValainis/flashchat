// FlashChat Klienta Loģika (Cloudflare Workers + Durable Objects WebSocket + 10MB Foto)
(() => {
  let ws = null;
  let currentRoom = null;
  let myUsername = '';
  let myPassword = '';
  let typingTimeout = null;
  let renderedMessageIds = new Set();

  // DOM elementi
  const chatApp = document.getElementById('chatApp');
  const homeOverlay = document.getElementById('homeOverlay');
  const joinModal = document.getElementById('joinModal');
  const joinForm = document.getElementById('joinForm');
  const joinModalTitle = document.getElementById('joinModalTitle');
  const usernameInput = document.getElementById('usernameInput');
  const passwordGroup = document.getElementById('passwordGroup');
  const roomPasswordInput = document.getElementById('roomPasswordInput');
  const currentRoomName = document.getElementById('currentRoomName');
  const onlineMeta = document.getElementById('onlineMeta');
  const messagesContainer = document.getElementById('messagesContainer');
  const typingIndicator = document.getElementById('typingIndicator');
  const messageInput = document.getElementById('messageInput');
  const sendMessageBtn = document.getElementById('sendMessageBtn');
  const imageInput = document.getElementById('imageInput');
  const shareRoomBtn = document.getElementById('shareRoomBtn');
  const leaveRoomBtn = document.getElementById('leaveRoomBtn');
  const imageLightbox = document.getElementById('imageLightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const roomsContainer = document.getElementById('roomsContainer');
  const manualRoomIdInput = document.getElementById('manualRoomIdInput');
  const manualJoinBtn = document.getElementById('manualJoinBtn');

  // Web Audio paziņojuma skaņa
  function playNotificationSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);

      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {}
  }

  function showToast(message, isError = false) {
    const existing = document.querySelector('.toast-notice');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-notice';
    if (isError) {
      toast.style.borderColor = '#ef4444';
      toast.style.color = '#fca5a5';
    }
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  function detectRoomIdFromUrl() {
    const path = window.location.pathname;
    const roomPrefix = '/room/';
    if (path.startsWith(roomPrefix) && path.length > roomPrefix.length) {
      return decodeURIComponent(path.substring(roomPrefix.length).replace(/\/$/, ''));
    }
    const params = new URLSearchParams(window.location.search);
    return params.get('room') || params.get('r') || null;
  }

  const targetRoomId = detectRoomIdFromUrl();

  if (targetRoomId) {
    prepareJoinModal(targetRoomId);
  } else {
    showHomeScreen();
  }

  async function prepareJoinModal(roomId) {
    try {
      const res = await fetch(`/api/room-check/${encodeURIComponent(roomId)}`);
      if (!res.ok) {
        showToast('Istaba netika atrasta vai ir izdzēsta!', true);
        showHomeScreen();
        return;
      }
      const room = await res.json();
      currentRoom = room;

      joinModalTitle.textContent = `Pievienoties: ${room.name}`;
      if (room.hasPassword) {
        passwordGroup.style.display = 'block';
        roomPasswordInput.required = true;
      } else {
        passwordGroup.style.display = 'none';
        roomPasswordInput.required = false;
      }

      homeOverlay.style.display = 'none';
      joinModal.style.display = 'flex';
      usernameInput.focus();
    } catch (err) {
      showToast('Savienojuma kļūda pārbaudot istabu', true);
      showHomeScreen();
    }
  }

  async function showHomeScreen() {
    homeOverlay.style.display = 'flex';
    joinModal.style.display = 'none';
    chatApp.style.display = 'none';

    try {
      const res = await fetch('/api/public-rooms');
      const data = await res.json();
      if (data.rooms && data.rooms.length > 0) {
        roomsContainer.innerHTML = '';
        data.rooms.forEach(r => {
          const item = document.createElement('div');
          item.style.cssText = 'padding: 10px 14px; background: rgba(255,255,255,0.06); border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; border: 1px solid rgba(255,255,255,0.08);';
          item.innerHTML = `
            <div>
              <strong style="color: #fff; font-size: 0.95rem;">${escapeHtml(r.name)}</strong>
              <div style="font-size: 0.75rem; color: #9ca3af;">${r.hasPassword ? '🔒 Ar paroli' : '🔓 Atvērta'}</div>
            </div>
            <span style="font-size: 0.8rem; color: #6366f1;">Pievienoties →</span>
          `;
          item.onclick = () => {
            window.location.href = `/room/${encodeURIComponent(r.id)}`;
          };
          roomsContainer.appendChild(item);
        });
      }
    } catch (e) {}
  }

  manualJoinBtn.addEventListener('click', () => {
    const val = manualRoomIdInput.value.trim();
    if (val) {
      window.location.href = `/room/${encodeURIComponent(val)}`;
    }
  });

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    const password = roomPasswordInput.value.trim();

    if (!username) {
      showToast('Lūdzu ievadi savu vārdu!', true);
      return;
    }

    myUsername = username;
    myPassword = password;
    initWebSocketConnection(currentRoom.id, username, password);
  });

  function sendWsEvent(event, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }

  function initWebSocketConnection(roomId, username, password) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?roomId=${encodeURIComponent(roomId)}&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password || '')}`;

    ws = new WebSocket(wsUrl);

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        const { event, data } = msg;

        if (event === 'error_msg') {
          showToast(data, true);
        } else if (event === 'joined_successfully') {
          joinModal.style.display = 'none';
          chatApp.style.display = 'flex';

          currentRoomName.textContent = data.room.name;
          updateOnlineUsers(data.users);

          messagesContainer.innerHTML = '';
          renderedMessageIds.clear();
          const introMsg = document.createElement('div');
          introMsg.className = 'system-message';
          introMsg.textContent = `Pievienojies istabai "${data.room.name}" kā ${myUsername}`;
          messagesContainer.appendChild(introMsg);

          if (data.messages && data.messages.length > 0) {
            data.messages.forEach(m => appendMessage(m));
          }
          scrollToBottom();
          messageInput.focus();
        } else if (event === 'new_message') {
          appendMessage(data);
          scrollToBottom();
          if (data.sender !== myUsername) {
            playNotificationSound();
          }
        } else if (event === 'user_joined') {
          updateOnlineUsers(data.users);
          appendSystemNotice(`${data.username} pievienojās čatam`);
        } else if (event === 'user_left') {
          updateOnlineUsers(data.users);
          appendSystemNotice(`${data.username} pameta čatu`);
        } else if (event === 'user_typing') {
          if (data.isTyping) {
            typingIndicator.textContent = `${data.username} raksta...`;
          } else {
            typingIndicator.textContent = '';
          }
        } else if (event === 'room_updated') {
          currentRoomName.textContent = data.name;
          showToast(`Istabas nosaukums atjaunināts: ${data.name}`);
        } else if (event === 'room_deleted') {
          alert(data.message || 'Šī istaba tika izdzēsta.');
          window.location.href = '/';
        } else if (event === 'messages_cleared') {
          messagesContainer.innerHTML = '';
          renderedMessageIds.clear();
          appendSystemNotice('Administrators iztīrīja visas sarunas.');
        }
      } catch (e) {}
    };
  }

  function appendMessage(msg) {
    if (msg.id && renderedMessageIds.has(msg.id)) return;
    if (msg.id) renderedMessageIds.add(msg.id);

    const isMe = msg.sender === myUsername;
    const row = document.createElement('div');
    row.className = `message-row ${isMe ? 'me' : 'other'}`;

    const sender = document.createElement('div');
    sender.className = 'message-sender';
    sender.textContent = isMe ? 'Tu' : msg.sender;
    row.appendChild(sender);

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (msg.text) {
      const textSpan = document.createElement('div');
      textSpan.textContent = msg.text;
      bubble.appendChild(textSpan);
    }

    if (msg.image) {
      const img = document.createElement('img');
      img.src = msg.image;
      img.alt = msg.fileName || 'Foto';
      img.className = 'message-image';
      img.onload = () => scrollToBottom();
      img.onclick = () => openLightbox(msg.image);
      bubble.appendChild(img);
    }

    const time = document.createElement('div');
    time.className = 'message-time';
    const d = msg.timestamp ? new Date(msg.timestamp) : new Date();
    time.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    bubble.appendChild(time);

    row.appendChild(bubble);
    messagesContainer.appendChild(row);
  }

  function appendSystemNotice(text) {
    const notice = document.createElement('div');
    notice.className = 'system-message';
    notice.textContent = text;
    messagesContainer.appendChild(notice);
    scrollToBottom();
  }

  function updateOnlineUsers(users) {
    const count = users ? users.length : 1;
    onlineMeta.textContent = `Tiešsaistē: ${count} ${count === 1 ? 'dalībnieks' : 'dalībnieki'}`;
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function handleSendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    sendWsEvent('send_message', { text });
    messageInput.value = '';
    sendWsEvent('typing', { isTyping: false });
  }

  sendMessageBtn.addEventListener('click', handleSendMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });

  messageInput.addEventListener('input', () => {
    sendWsEvent('typing', { isTyping: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      sendWsEvent('typing', { isTyping: false });
    }, 1500);
  });

  // Fotoattēla augšupielāde līdz 10 MB caur HTTP POST uz Durable Object SQLite
  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const maxBytes = 10 * 1024 * 1024; // 10 MB
    if (file.size > maxBytes) {
      showToast('Attēla izmērs pārsniedz atļautos 10 MB!', true);
      imageInput.value = '';
      return;
    }

    showToast('Augšupielādē fotoattēlu...');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64Data = reader.result;
        const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoom.id)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: myUsername,
            text: '',
            image: base64Data,
            fileName: file.name,
            fileSize: file.size
          })
        });
        const data = await res.json();
        if (res.ok && data.message) {
          appendMessage(data.message);
          scrollToBottom();
        } else {
          showToast(data.error || 'Neizdevās nosūtīt fotoattēlu', true);
        }
      } catch (err) {
        showToast('Kļūda augšupielādējot fotoattēlu', true);
      }
      imageInput.value = '';
    };
    reader.readAsDataURL(file);
  });

  function openLightbox(src) {
    lightboxImg.src = src;
    imageLightbox.style.display = 'flex';
  }

  imageLightbox.addEventListener('click', () => {
    imageLightbox.style.display = 'none';
    lightboxImg.src = '';
  });

  shareRoomBtn.addEventListener('click', () => {
    const shareUrl = `${window.location.origin}/room/${encodeURIComponent(currentRoom.id)}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      showToast('📋 Istabas saite nokopēta starpliktuvē!');
    }).catch(() => {
      prompt('Kopē šo saiti:', shareUrl);
    });
  });

  leaveRoomBtn.addEventListener('click', () => {
    if (confirm('Vai tiešām vēlies iziet no šīs istabas?')) {
      window.location.href = '/';
    }
  });

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }
})();
