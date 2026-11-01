# ⚡ FlashChat - Privātais Čats ar Slēpto Administratora Paneli

Vienkāršs, ātrs un uzticams reāllaika čats bez lietotāju reģistrācijas, ar fotoattēlu nosūtīšanu līdz **10 MB**, pastāvīgu datu saglabāšanu un slēptu administratora paneli.

---

## 🛡️ Slēptais Administratora Panelis
Administratora panelis **nav redzams** parastajiem čata apmeklētājiem čata logā.
* **Adrese:** `https://tava-vietne.onrender.com/admin` (vai lokāli `http://localhost:3000/admin`)
* **Noklusējuma parole:** `raivojanis37`

### No paneļa administrators var:
1. **Izveidot čata istabas** (ar vai bez pieejas paroles).
2. **Bez laika limita** — istabas darbojas pastāvīgi, kamēr tās neizdzēš.
3. **Kopīgot istabu saites** — viens klikšķis, lai nokopētu tiešo saiti (piem., `/room/draugi`).
4. **Rediģēt istabas** — mainīt nosaukumu vai pieejas paroli jebkurā brīdī.
5. **Pārskatīt sarakstes vēsturi** un pēc vēlēšanās iztīrīt ziņas.
6. **Dzēst istabas** — tūlītēja izdzēšana un dalībnieku atvienošana.
7. **Mainīt admin paroli** tieši no vadības paneļa.

---

## 👥 Kā saņēmējs piekļūst čatam?
1. Saņēmējs saņem saiti (piemēram: `https://tava-vietne.onrender.com/room/draugi`).
2. Atverot saiti, viņam parādās tikai viens lodziņš: **"Ievadi savu vārdu"** (un parole, ja istabai to uzliki).
3. Tiklīdz vārds ievadīts, viņš **uzreiz tiek iekšā istabā** un var brīvi sarakstīties!
4. Parastie lietotāji **nevar paši veidot istabas** — to kontrolē tikai administrators.

---

## 📷 Fotoattēli līdz 10 MB
* Lietotāji var sūtīt gan tekstu, gan fotoattēlus (līdz **10 MB**).
* Klikšķinot uz attēla čatā, atveras ērts pilnekrāna skatītājs.

---

## 💾 Datu saglabāšana (Render atmošanās)
* Visi dati (istabas, paroles, vēsture un admin iestatījumi) automātiski tiek saglabāti failā `data/chat-data.json`.
* Kad Render pamostas pēc neaktivitātes vai serveris tiek pārstartēts, **nekas nepazūd** — visas istabas un ziņas paliek vietā.

---

## 🚀 Kā palaist uz Render.com (24/7 bez datora)

### 1. Ieliec kodu GitHub
1. Izveido jaunu repozitoriju savā GitHub (piemēram, `flashchat`).
2. Augšupielādē šīs mapes failus.

### 2. Pieslēdz Render.com
1. Ieej [render.com](https://render.com) un izveido **New Web Service**.
2. Izvēlies savu `flashchat` GitHub repozitoriju.
3. Render automātiski nolasīs `render.yaml` vai ievadi:
   * **Runtime:** Node
   * **Build Command:** `npm install`
   * **Start Command:** `npm start`
4. Spied **Deploy Web Service**!

### 3. Lai Render NEKAD neaizmigtu (Triks ar UptimeRobot)
1. Reģistrējies bez maksas [uptimerobot.com](https://uptimerobot.com).
2. Pievieno jaunu monitoru:
   * **Monitor Type:** HTTP(s)
   * **URL:** `https://tavs-render-nosaukums.onrender.com/api/public-rooms`
   * **Monitoring Interval:** 5 minutes
3. UptimeRobot ik pēc 5 minūtēm automātiski pārbaudīs vietni, tāpēc **Render nekad neies gulēt un darbosies 24/7**!
