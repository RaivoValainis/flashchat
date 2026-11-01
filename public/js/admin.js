// FlashChat Vadības Paneļa Loģika
(() => {
  let adminToken = localStorage.getItem('flashchat_admin_token') || null;
  let activeLogsRoomId = null;

  // DOM elementi
  const adminLoginOverlay = document.getElementById('adminLoginOverlay');
  const adminLoginForm = document.getElementById('adminLoginForm');
  const adminPasswordInput = document.getElementById('adminPasswordInput');
  const adminPanel = document.getElementById('adminPanel');
  const adminRoomsGrid = document.getElementById('adminRoomsGrid');
  const statTotalRooms = document.getElementById('statTotalRooms');
  const statTotalOnline = document.getElementById('statTotalOnline');
  const openCreateRoomModalBtn = document.getElementById('openCreateRoomModalBtn');
  const createRoomModal = document.getElementById('createRoomModal');
  const createRoomForm = document.getElementById('createRoomForm');
  const editRoomModal = document.getElementById('editRoomModal');
  const editRoomForm = document.getElementById('editRoomForm');
  const viewLogsModal = document.getElementById('viewLogsModal');
  const logsContainer = document.getElementById('logsContainer');
  const logsRoomTitle = document.getElementById('logsRoomTitle');
  const clearLogsBtn = document.getElementById('clearLogsBtn');
  const openChangePassModalBtn = document.getElementById('openChangePassModalBtn');
  const changePassModal = document.getElementById('changePassModal');
  const changePassForm = document.getElementById('changePassForm');
  const adminLogoutBtn = document.getElementById('adminLogoutBtn');

  // Paziņojuma lodziņš
  function showToast(msg, isError = false) {
    const existing = document.querySelector('.toast-notice');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-notice';
    if (isError) {
      toast.style.borderColor = '#ef4444';
      toast.style.color = '#fca5a5';
    }
    toast.textContent = msg;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  // Pārbauda esošo sesijas tokenu
  async function checkSession() {
    if (!adminToken) {
      showLogin();
      return;
    }

    try {
      const res = await fetch('/api/admin/check', {
        headers: { 'x-admin-token': adminToken }
      });
      if (res.ok) {
        showPanel();
        loadRooms();
      } else {
        showLogin();
      }
    } catch (e) {
      showLogin();
    }
  }

  function showLogin() {
    adminLoginOverlay.style.display = 'flex';
    adminPanel.style.display = 'none';
    adminPasswordInput.value = '';
    adminPasswordInput.focus();
  }

  function showPanel() {
    adminLoginOverlay.style.display = 'none';
    adminPanel.style.display = 'block';
  }

  // Pieslēgšanās
  adminLoginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = adminPasswordInput.value.trim();
    if (!pass) return;

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass })
      });
      const data = await res.json();
      if (res.ok && data.token) {
        adminToken = data.token;
        localStorage.setItem('flashchat_admin_token', adminToken);
        showPanel();
        loadRooms();
        showToast('Veiksmīgi pieslēdzies kā administrators!');
      } else {
        showToast(data.error || 'Nepareiza parole!', true);
      }
    } catch (err) {
      showToast('Kļūda pieslēdzoties serverim', true);
    }
  });

  // Iziet no vadības paneļa
  adminLogoutBtn.addEventListener('click', () => {
    adminToken = null;
    localStorage.removeItem('flashchat_admin_token');
    showLogin();
    showToast('Izrakstījies no paneļa');
  });

  // Ielādē visas istabas
  async function loadRooms() {
    try {
      const res = await fetch('/api/admin/rooms', {
        headers: { 'x-admin-token': adminToken }
      });
      if (!res.ok) {
        showLogin();
        return;
      }
      const data = await res.json();
      renderRooms(data.rooms || []);
    } catch (err) {
      console.error(err);
      showToast('Kļūda ielādējot istabas', true);
    }
  }

  // Istabu renderēšana
  function renderRooms(rooms) {
    adminRoomsGrid.innerHTML = '';
    statTotalRooms.textContent = rooms.length;

    let totalOnline = 0;
    rooms.forEach(r => totalOnline += (r.onlineCount || 0));
    statTotalOnline.textContent = totalOnline;

    if (rooms.length === 0) {
      adminRoomsGrid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; background: var(--panel-bg); border-radius: 14px; border: 1px dashed var(--panel-border);">
          <div style="font-size: 2.2rem; margin-bottom: 8px;">📭</div>
          <h3 style="color: #fff; margin-bottom: 6px;">Nav izveidota neviena istaba</h3>
          <p style="color: #9ca3af; font-size: 0.9rem; margin-bottom: 16px;">Spied "Jauna istaba", lai izveidotu pirmo sarunu telpu!</p>
          <button class="btn btn-primary" onclick="document.getElementById('openCreateRoomModalBtn').click()">➕ Izveidot istabu</button>
        </div>
      `;
      return;
    }

    rooms.forEach(r => {
      const card = document.createElement('div');
      card.className = 'room-card';

      const shareUrl = `${window.location.origin}/room/${encodeURIComponent(r.id)}`;
      const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('lv-LV', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Nesen';

      card.innerHTML = `
        <div class="room-card-head">
          <div>
            <div class="room-card-title">${escapeHtml(r.name)}</div>
            <div style="font-size: 0.78rem; color: #a5b4fc; font-family: monospace;">/room/${escapeHtml(r.id)}</div>
          </div>
          <span class="badge ${r.hasPassword ? 'badge-locked' : 'badge-open'}">
            ${r.hasPassword ? '🔒 Ar paroli' : '🔓 Atvērta'}
          </span>
        </div>

        <div class="room-card-stats">
          <span>👥 Tiešsaistē: <strong style="color: #fff;">${r.onlineCount || 0}</strong></span>
          <span>💬 Ziņas: <strong style="color: #fff;">${r.messageCount || 0}</strong></span>
        </div>

        <div style="font-size: 0.75rem; color: #6b7280;">Izveidota: ${dateStr}</div>

        <div class="room-card-actions">
          <button class="btn btn-primary btn-share" data-url="${shareUrl}" title="Nokopēt saiti">
            🔗 Kopīgot
          </button>
          <button class="btn btn-edit" data-id="${r.id}" data-name="${escapeHtml(r.name)}" data-haspass="${r.hasPassword}" title="Rediģēt">
            ✏️ Rediģēt
          </button>
          <button class="btn btn-logs" data-id="${r.id}" data-name="${escapeHtml(r.name)}" title="Skatīt saraksti">
            👁️ Vēsture
          </button>
          <button class="btn btn-danger btn-delete" data-id="${r.id}" data-name="${escapeHtml(r.name)}" title="Dzēst istabu">
            🗑️
          </button>
        </div>
      `;

      // Notikumu piesaiste pogām
      card.querySelector('.btn-share').onclick = () => {
        navigator.clipboard.writeText(shareUrl).then(() => {
          showToast(`📋 Saite nokopēta: ${shareUrl}`);
        }).catch(() => {
          prompt('Kopē šo istabas saiti:', shareUrl);
        });
      };

      card.querySelector('.btn-edit').onclick = () => {
        openEditRoomModal(r.id, r.name, r.hasPassword);
      };

      card.querySelector('.btn-logs').onclick = () => {
        openLogsModal(r.id, r.name);
      };

      card.querySelector('.btn-delete').onclick = () => {
        deleteRoom(r.id, r.name);
      };

      adminRoomsGrid.appendChild(card);
    });
  }

  // Izveidot istabu
  openCreateRoomModalBtn.onclick = () => {
    document.getElementById('newRoomName').value = '';
    document.getElementById('newRoomPassword').value = '';
    document.getElementById('newRoomCustomId').value = '';
    createRoomModal.style.display = 'flex';
    document.getElementById('newRoomName').focus();
  };

  createRoomForm.onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('newRoomName').value.trim();
    const password = document.getElementById('newRoomPassword').value.trim();
    const customId = document.getElementById('newRoomCustomId').value.trim();

    if (!name) return;

    try {
      const res = await fetch('/api/admin/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': adminToken
        },
        body: JSON.stringify({ name, password, customId })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        createRoomModal.style.display = 'none';
        showToast(`Istaba "${name}" veiksmīgi izveidota!`);
        loadRooms();
      } else {
        showToast(data.error || 'Neizdevās izveidot istabu', true);
      }
    } catch (err) {
      showToast('Kļūda nosūtot datus serverim', true);
    }
  };

  // Rediģēt istabu
  function openEditRoomModal(id, name, hasPassword) {
    document.getElementById('editRoomId').value = id;
    document.getElementById('editRoomName').value = name;
    document.getElementById('editRoomPassword').value = '';
    document.getElementById('editRemovePassword').checked = false;
    editRoomModal.style.display = 'flex';
  }

  editRoomForm.onsubmit = async (e) => {
    e.preventDefault();
    const id = document.getElementById('editRoomId').value;
    const name = document.getElementById('editRoomName').value.trim();
    const password = document.getElementById('editRoomPassword').value.trim();
    const removePassword = document.getElementById('editRemovePassword').checked;

    try {
      const res = await fetch(`/api/admin/rooms/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': adminToken
        },
        body: JSON.stringify({ name, password, removePassword })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        editRoomModal.style.display = 'none';
        showToast('Istaba veiksmīgi atjaunināta!');
        loadRooms();
      } else {
        showToast(data.error || 'Kļūda saglabājot izmaiņas', true);
      }
    } catch (err) {
      showToast('Kļūda savienojumā', true);
    }
  };

  // Dzēst istabu
  async function deleteRoom(id, name) {
    if (!confirm(`Vai tiešām vēlies izdzēst istabu "${name}"?\nVisi dalībnieki tiks atvienoti un sarakste tiks dzēsta.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/rooms/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': adminToken }
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`Istaba "${name}" izdzēsta!`);
        loadRooms();
      } else {
        showToast(data.error || 'Neizdevās izdzēst', true);
      }
    } catch (err) {
      showToast('Kļūda dzēšot istabu', true);
    }
  }

  // Skatīt sarakstes vēsturi
  async function openLogsModal(id, name) {
    activeLogsRoomId = id;
    logsRoomTitle.textContent = `Sarakste: ${name}`;
    logsContainer.innerHTML = '<div style="color: #9ca3af; text-align: center; padding: 20px;">Ielādē saraksti...</div>';
    viewLogsModal.style.display = 'flex';

    try {
      const res = await fetch(`/api/admin/rooms/${encodeURIComponent(id)}/messages`, {
        headers: { 'x-admin-token': adminToken }
      });
      const data = await res.json();
      const messages = data.messages || [];

      logsContainer.innerHTML = '';
      if (messages.length === 0) {
        logsContainer.innerHTML = '<div style="color: #6b7280; text-align: center; padding: 20px;">Nav nevienas ziņas šajā istabā.</div>';
        return;
      }

      messages.forEach(m => {
        const item = document.createElement('div');
        item.style.cssText = 'padding: 8px 12px; background: rgba(255,255,255,0.05); border-radius: 8px; font-size: 0.85rem; border-left: 3px solid #6366f1;';
        const d = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';

        let contentHtml = '';
        if (m.text) {
          contentHtml += `<div>${escapeHtml(m.text)}</div>`;
        }
        if (m.image) {
          contentHtml += `<div style="margin-top: 4px;"><img src="${m.image}" style="max-height: 80px; border-radius: 6px; cursor: pointer;" onclick="window.open('${m.image}')" title="Klikšķini, lai atvērtu pilnā izmērā"></div>`;
        }

        item.innerHTML = `
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <strong style="color: #a5b4fc;">${escapeHtml(m.sender)}</strong>
            <span style="font-size: 0.72rem; color: #6b7280;">${d}</span>
          </div>
          ${contentHtml}
        `;
        logsContainer.appendChild(item);
      });
      logsContainer.scrollTop = logsContainer.scrollHeight;
    } catch (err) {
      logsContainer.innerHTML = '<div style="color: #ef4444; text-align: center; padding: 20px;">Neizdevās ielādēt ziņas</div>';
    }
  }

  // Iztīrīt istabas ziņas
  clearLogsBtn.onclick = async () => {
    if (!activeLogsRoomId) return;
    if (!confirm('Vai tiešām iztīrīt visus ziņojumus no šīs istabas?')) return;

    try {
      const res = await fetch(`/api/admin/rooms/${encodeURIComponent(activeLogsRoomId)}/messages`, {
        method: 'DELETE',
        headers: { 'x-admin-token': adminToken }
      });
      if (res.ok) {
        logsContainer.innerHTML = '<div style="color: #6b7280; text-align: center; padding: 20px;">Ziņojumi ir iztīrīti.</div>';
        showToast('Ziņojumi iztīrīti!');
        loadRooms();
      }
    } catch (err) {
      showToast('Kļūda tīrot ziņas', true);
    }
  };

  // Mainīt admin paroli
  openChangePassModalBtn.onclick = () => {
    document.getElementById('newAdminPassInput').value = '';
    changePassModal.style.display = 'flex';
    document.getElementById('newAdminPassInput').focus();
  };

  changePassForm.onsubmit = async (e) => {
    e.preventDefault();
    const newPassword = document.getElementById('newAdminPassInput').value.trim();
    if (!newPassword || newPassword.length < 4) {
      showToast('Parolei jābūt vismaz 4 simbolus garai!', true);
      return;
    }

    try {
      const res = await fetch('/api/admin/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': adminToken
        },
        body: JSON.stringify({ newPassword })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        changePassModal.style.display = 'none';
        showToast('Administratora parole veiksmīgi nomainīta!');
      } else {
        showToast(data.error || 'Neizdevās nomainīt paroli', true);
      }
    } catch (err) {
      showToast('Kļūda saziņā ar serveri', true);
    }
  };

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

  // Sākam pārbaudi
  checkSession();
})();
