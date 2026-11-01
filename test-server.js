const http = require('http');
const fs = require('fs');
const path = require('path');

// Palaidīsim testus pret serveri
async function runTests() {
  console.log('--- FlashChat Automātiskie Testi Sākas ---');

  // Ielādējam serveri programmātiski
  const server = require('./server.js');
  await new Promise(r => setTimeout(r, 1000));

  function request(method, pathUrl, data = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = data ? JSON.stringify(data) : null;
      const opts = {
        hostname: '127.0.0.1',
        port: 3000,
        path: pathUrl,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      };

      const req = http.request(opts, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ status: res.statusCode, raw: body });
          }
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  let adminToken = '';

  // Tests 1: Nepareiza admin parole
  const t1 = await request('POST', '/api/admin/login', { password: 'nepareiza-parole' });
  if (t1.status === 401) {
    console.log('✓ 1. Nepareiza admin parole tiek noraidīta ar 401');
  } else {
    throw new Error(`Test 1 Failed: status ${t1.status}`);
  }

  // Tests 2: Pareiza admin parole (raivojanis37)
  const t2 = await request('POST', '/api/admin/login', { password: 'raivojanis37' });
  if (t2.status === 200 && t2.data.token) {
    adminToken = t2.data.token;
    console.log('✓ 2. Admin veiksmīgi autorizēts ar paroli "raivojanis37"');
  } else {
    throw new Error(`Test 2 Failed: status ${t2.status}`);
  }

  // Tests 3: Izveidot istabu no Admin paneļa (bez laika limita)
  const t3 = await request('POST', '/api/admin/rooms', {
    name: 'Slepenā Saruna',
    password: '',
    customId: 'saruna-1'
  }, { 'x-admin-token': adminToken });
  if (t3.status === 200 && t3.data.room && t3.data.room.id === 'saruna-1') {
    console.log('✓ 3. Admin izveidoja istabu "saruna-1" bez laika limita');
  } else {
    throw new Error(`Test 3 Failed: ${JSON.stringify(t3)}`);
  }

  // Tests 4: Saņēmēja pārbaude pirms ieiešanas (GET /api/room-check/saruna-1)
  const t4 = await request('GET', '/api/room-check/saruna-1');
  if (t4.status === 200 && t4.data.name === 'Slepenā Saruna' && t4.data.hasPassword === false) {
    console.log('✓ 4. Saņēmējs atver saiti un uzreiz redz istabas datus bez liekām reģistrācijām');
  } else {
    throw new Error(`Test 4 Failed: ${JSON.stringify(t4)}`);
  }

  // Tests 5: Rediģēt istabu no Admin paneļa
  const t5 = await request('PUT', '/api/admin/rooms/saruna-1', {
    name: 'Slepenā Saruna - Atjaunināta',
    password: 'drošaparole123'
  }, { 'x-admin-token': adminToken });
  if (t5.status === 200 && t5.data.room.name === 'Slepenā Saruna - Atjaunināta' && t5.data.room.hasPassword === true) {
    console.log('✓ 5. Admin rediģēja istabas nosaukumu un uzlika paroli');
  } else {
    throw new Error(`Test 5 Failed: ${JSON.stringify(t5)}`);
  }

  // Tests 6: Pārbaudām diska saglabāšanu (Render wake-up drošība)
  const dataFilePath = path.join(__dirname, 'data', 'chat-data.json');
  if (fs.existsSync(dataFilePath)) {
    const rawData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
    if (rawData.rooms['saruna-1'] && rawData.adminPassword === 'raivojanis37') {
      console.log('✓ 6. Diska failā chat-data.json dati ir saglabāti un nepazudīs pēc Render pamošanās');
    } else {
      throw new Error('Test 6 Failed: chat-data.json satur nepareizus datus');
    }
  } else {
    throw new Error('Test 6 Failed: chat-data.json fails neeksistē');
  }

  // Tests 7: Dzēst istabu no Admin paneļa
  const t7 = await request('DELETE', '/api/admin/rooms/saruna-1', null, { 'x-admin-token': adminToken });
  if (t7.status === 200 && t7.data.success) {
    console.log('✓ 7. Admin veiksmīgi izdzēsa istabu');
  } else {
    throw new Error(`Test 7 Failed: ${JSON.stringify(t7)}`);
  }

  // Tests 8: Pārbaude, ka istaba vairs neeksistē
  const t8 = await request('GET', '/api/room-check/saruna-1');
  if (t8.status === 404) {
    console.log('✓ 8. Pēc dzēšanas istaba vairs nav pieejama');
  } else {
    throw new Error(`Test 8 Failed: status ${t8.status}`);
  }

  console.log('\n======================================================');
  console.log('🎉 VISI TESTI VEIKSMĪGI NOKĀRTOTI AR ATZĪMI 10/10!');
  console.log('======================================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('KĻŪDA TESTOS:', err);
  process.exit(1);
});
