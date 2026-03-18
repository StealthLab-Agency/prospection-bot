const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const LOG_FILE    = path.join(__dirname, 'data', 'emails.json');
const COSTS_FILE  = path.join(__dirname, 'data', 'costs.json');
const QUEUE_FILE  = path.join(__dirname, 'data', 'queue.json');

function loadConfig() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  if (process.env.ANTHROPIC_KEY)   config.anthropicKey  = process.env.ANTHROPIC_KEY;
  if (process.env.GMAIL_USER)      config.gmailUser     = process.env.GMAIL_USER;
  if (process.env.GMAIL_PASS)      config.gmailPass     = process.env.GMAIL_PASS;
  if (process.env.SENDER_NAME)     config.senderName    = process.env.SENDER_NAME;
  if (process.env.GOOGLE_MAPS_KEY) config.googleMapsKey = process.env.GOOGLE_MAPS_KEY;
  return config;
}
function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { return []; }
}
function saveLog(log) { fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }
function loadCosts() {
  try { return JSON.parse(fs.readFileSync(COSTS_FILE, 'utf8')); }
  catch { return { total_usd: 0, entries: [] }; }
}
function saveCosts(c) { fs.writeFileSync(COSTS_FILE, JSON.stringify(c, null, 2)); }
function loadQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); }
  catch { return { items: [], dailySent: 0, lastReset: new Date().toDateString(), active: false }; }
}
function saveQueue(q) { fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2)); }

function calcCost(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) * 3 / 1_000_000 + (usage.output_tokens || 0) * 15 / 1_000_000;
}
function trackCost(type, usage, detail) {
  const cost = calcCost(usage);
  const data = loadCosts();
  data.total_usd = (data.total_usd || 0) + cost;
  data.entries.unshift({ date: new Date().toISOString(), type, detail, input_tokens: usage?.input_tokens || 0, output_tokens: usage?.output_tokens || 0, cost_usd: cost });
  if (data.entries.length > 200) data.entries = data.entries.slice(0, 200);
  saveCosts(data);
  return cost;
}

function getTransporter(config) {
  return nodemailer.createTransport({ service: 'gmail', auth: { user: config.gmailUser, pass: config.gmailPass } });
}

// ── GOOGLE MAPS ───────────────────────────────────────────────────────────────
function googleMapsRequestNew(url, body, apiKey) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.id'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function searchGoogleMaps(type, city, count, apiKey) {
  const url = `https://places.googleapis.com/v1/places:searchText`;
  const body = { textQuery: `${type} ${city}`, languageCode: 'fr', maxResultCount: Math.min(count, 20) };
  const data = await googleMapsRequestNew(url, body, apiKey);
  if (data.error) throw new Error(`Google Maps erreur: ${data.error.status} - ${data.error.message}`);
  return (data.places || []).map(p => ({
    name: p.displayName?.text || '',
    phone: p.nationalPhoneNumber || '',
    email: '',
    address: p.formattedAddress || '',
    website: p.websiteUri || '',
    hasWebsite: !!p.websiteUri,
    source: 'Google Maps',
    rating: p.rating ? `${p.rating}/5` : '',
    note: p.rating ? `Note Google: ${p.rating}/5` : ''
  }));
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { type, city, count = 10 } = req.body;
  const config = loadConfig();
  if (!config.googleMapsKey) return res.status(400).json({ error: 'Clé Google Maps manquante.' });
  try {
    const prospects = await searchGoogleMaps(type, city, parseInt(count), config.googleMapsKey);
    res.json({ prospects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GENERATE EMAIL ────────────────────────────────────────────────────────────
app.post('/api/generate-email', async (req, res) => {
  const { clientName, service, tone } = req.body;
  const config = loadConfig();
  if (!config.anthropicKey) return res.status(400).json({ error: 'Clé API Anthropic manquante.' });
  const client = new Anthropic({ apiKey: config.anthropicKey });
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: `Email prospection français, agence web québécoise. Client: "${clientName}", service: "${service}". Services disponibles: création de site web professionnel ou plateforme automatisée de gestion. Ton: ${tone}. Max 180 mots, accrocheur, montre la valeur concrète. JSON: {"subject":"","body":""}` }]
    });
    const cost = trackCost('email_gen', response.usage, `${service} pour ${clientName}`);
    const text = response.content[0].text.trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { const m = text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { subject: '', body: text }; }
    res.json({ ...parsed, cost });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SEND EMAIL (manuel) ───────────────────────────────────────────────────────
app.post('/api/send-email', async (req, res) => {
  const { to, toName, subject, body, service } = req.body;
  const config = loadConfig();
  if (!config.gmailUser || !config.gmailPass) return res.status(400).json({ error: 'Gmail non configuré.' });
  try {
    await getTransporter(config).sendMail({
      from: `"${config.senderName || 'Mon Agence Web'}" <${config.gmailUser}>`,
      to: `${toName} <${to}>`, subject, text: body, html: body.replace(/\n/g, '<br>')
    });
    const log = loadLog();
    log.unshift({ id: Date.now(), to: toName || to, email: to, subject, body, service, date: new Date().toISOString(), status: 'sent', mode: 'manual' });
    saveLog(log);
    res.json({ success: true });
  } catch (e) {
    const log = loadLog();
    log.unshift({ id: Date.now(), to: toName || to, email: to, subject, body, service, date: new Date().toISOString(), status: 'error', error: e.message });
    saveLog(log);
    res.status(500).json({ error: e.message });
  }
});

// ── QUEUE ─────────────────────────────────────────────────────────────────────
app.get('/api/queue', (req, res) => res.json(loadQueue()));

app.post('/api/queue/add', (req, res) => {
  const { prospects, service, tone } = req.body;
  const q = loadQueue();
  const log = loadLog();
  const alreadySent = log.map(e => (e.email || '').toLowerCase());
  const inQueue = q.items.map(i => (i.email || '').toLowerCase());
  const blacklist = new Set([...alreadySent, ...inQueue]);
  let added = 0, skipped = 0;
  prospects.forEach(p => {
    if (!p.email || blacklist.has(p.email.toLowerCase())) { skipped++; return; }
    q.items.push({
      id: Date.now() + Math.random(),
      name: p.name, email: p.email, phone: p.phone,
      service: service || 'Création de site web professionnel',
      tone: tone || 'Professionnel',
      status: 'pending',
      addedAt: new Date().toISOString()
    });
    added++;
  });
  saveQueue(q);
  res.json({ success: true, added, skipped, total: q.items.filter(i => i.status === 'pending').length });
});

app.post('/api/queue/toggle', (req, res) => {
  const q = loadQueue();
  q.active = !q.active;
  saveQueue(q);
  res.json({ active: q.active });
});

app.delete('/api/queue/:id', (req, res) => {
  const q = loadQueue();
  q.items = q.items.filter(i => String(i.id) !== req.params.id);
  saveQueue(q);
  res.json({ success: true });
});

app.delete('/api/queue', (req, res) => {
  const q = loadQueue();
  q.items = q.items.filter(i => i.status !== 'pending');
  saveQueue(q);
  res.json({ success: true });
});

// ── AUTO-SEND WORKER (every 8 minutes) ───────────────────────────────────────
const DAILY_LIMIT = 40;
const SEND_INTERVAL_MS = 8 * 60 * 1000; // 8 minutes between emails

async function processQueue() {
  const config = loadConfig();
  if (!config.anthropicKey || !config.gmailUser || !config.gmailPass) return;

  const q = loadQueue();
  if (!q.active) return;

  // Reset daily counter at midnight
  if (q.lastReset !== new Date().toDateString()) {
    q.dailySent = 0;
    q.lastReset = new Date().toDateString();
  }

  // Check business hours (9h-17h EST)
  const now = new Date();
  const hour = now.toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false });
  const h = parseInt(hour);
  if (h < 9 || h >= 17) { saveQueue(q); return; }

  // Check daily limit
  if (q.dailySent >= DAILY_LIMIT) return;

  // Get next pending item with email
  const item = q.items.find(i => i.status === 'pending' && i.email);
  if (!item) return;

  // Mark as processing
  item.status = 'processing';
  saveQueue(q);

  try {
    // Generate personalized email with AI
    const client = new Anthropic({ apiKey: config.anthropicKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: `Email prospection français, agence web québécoise. Client: "${item.name}". Propose UN des deux services suivants (choisis celui qui correspond le mieux au type de business) : soit "Création de site web professionnel" soit "Plateforme automatisée de gestion (réservations, commandes, clients)". Ton: ${item.tone}. Max 180 mots, accrocheur, montre la valeur concrète pour leur business. JSON: {"subject":"","body":""}` }]
    });
    trackCost('auto_email', response.usage, item.name);

    const text = response.content[0].text.trim();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { const m = text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }

    if (!parsed) throw new Error('Email generation failed');

    // Send email
    await getTransporter(config).sendMail({
      from: `"${config.senderName || 'Mon Agence Web'}" <${config.gmailUser}>`,
      to: `${item.name} <${item.email}>`,
      subject: parsed.subject,
      text: parsed.body,
      html: parsed.body.replace(/\n/g, '<br>')
    });

    // Update queue item
    item.status = 'sent';
    item.sentAt = new Date().toISOString();
    item.subject = parsed.subject;
    q.dailySent++;

    // Log it
    const log = loadLog();
    log.unshift({ id: Date.now(), to: item.name, email: item.email, subject: parsed.subject, body: parsed.body, service: item.service, date: new Date().toISOString(), status: 'sent', mode: 'auto' });
    saveLog(log);

    console.log(`✅ Auto-sent to ${item.name} (${item.email}) — ${q.dailySent}/${DAILY_LIMIT} today`);
  } catch(e) {
    item.status = 'error';
    item.error = e.message;
    console.error(`❌ Auto-send failed for ${item.name}: ${e.message}`);
  }

  saveQueue(q);
}

// ── REPLY CHECKER (every 30 minutes) ─────────────────────────────────────────
const Imap = require('imap');
const { simpleParser } = require('mailparser');

async function checkReplies() {
  const config = loadConfig();
  if (!config.gmailUser || !config.gmailPass) return;

  const log = loadLog();
  const sentEmails = log.filter(e => e.status === 'sent').map(e => e.email.toLowerCase());
  if (!sentEmails.length) return;

  const imap = new Imap({
    user: config.gmailUser,
    password: config.gmailPass,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err, box) => {
      if (err) { imap.end(); return; }

      // Search unseen emails from last 24h
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      imap.search(['UNSEEN', ['SINCE', yesterday]], (err, results) => {
        if (err || !results.length) { imap.end(); return; }

        const fetch = imap.fetch(results, { bodies: '' });
        fetch.on('message', (msg) => {
          msg.on('body', (stream) => {
            simpleParser(stream, async (err, parsed) => {
              if (err) return;
              const from = (parsed.from?.value?.[0]?.address || '').toLowerCase();
              if (sentEmails.includes(from)) {
                // It's a reply from a prospect!
                console.log(`📬 Reply from prospect: ${from}`);
                // Send notification
                try {
                  await getTransporter(config).sendMail({
                    from: `"ProspectBot" <${config.gmailUser}>`,
                    to: config.gmailUser,
                    subject: `📬 Réponse de prospect : ${parsed.from?.value?.[0]?.name || from}`,
                    html: `
                      <h2>Un prospect a répondu !</h2>
                      <p><strong>De:</strong> ${parsed.from?.text}</p>
                      <p><strong>Objet:</strong> ${parsed.subject}</p>
                      <hr>
                      <p>${parsed.text || parsed.html || '(pas de contenu)'}</p>
                      <hr>
                      <p style="color:#888;font-size:12px;">ProspectBot — notification automatique</p>
                    `
                  });
                  console.log(`✅ Notification sent for reply from ${from}`);
                } catch(e) {
                  console.error('Notification error:', e.message);
                }
              }
            });
          });
        });
        fetch.once('end', () => imap.end());
      });
    });
  });

  imap.once('error', (err) => console.error('IMAP error:', err.message));
  imap.connect();
}

// ── AUTO PROSPECT EACH MORNING ───────────────────────────────────────────────
const BUSINESS_TARGETS = [
  // Création de site web
  { type: 'restaurant',            service: 'Création de site web professionnel' },
  { type: 'café',                  service: 'Création de site web professionnel' },
  { type: 'salon de coiffure',     service: 'Création de site web professionnel' },
  { type: 'boutique vêtements',    service: 'Création de site web professionnel' },
  { type: 'garage automobile',     service: 'Création de site web professionnel' },
  { type: 'photographe',           service: 'Création de site web professionnel' },
  { type: 'comptable',             service: 'Création de site web professionnel' },
  { type: 'notaire',               service: 'Création de site web professionnel' },
  // Plateforme automatisée
  { type: 'clinique médicale',     service: 'Plateforme automatisée de gestion' },
  { type: 'gym fitness',           service: 'Plateforme automatisée de gestion' },
  { type: 'studio yoga',           service: 'Plateforme automatisée de gestion' },
  { type: 'hôtel',                 service: 'Plateforme automatisée de gestion' },
  { type: 'restaurant livraison',  service: 'Plateforme automatisée de gestion' },
  { type: 'spa',                   service: 'Plateforme automatisée de gestion' },
];

// Cities to target
const TARGET_CITIES = ['Montréal', 'Québec', 'Laval', 'Longueuil', 'Sherbrooke'];

async function autoProspect() {
  const config = loadConfig();
  if (!config.googleMapsKey) return;

  // Only run at 8h EST (before sending starts at 9h)
  const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }));
  if (hour !== 8) return;

  const q = loadQueue();

  // Pick a random city and 3 random business types
  const city = TARGET_CITIES[Math.floor(Math.random() * TARGET_CITIES.length)];
  const targets = BUSINESS_TARGETS.sort(() => Math.random() - 0.5).slice(0, 3);

  console.log(`🌅 Auto-prospecting in ${city}...`);

  for (const target of targets) {
    try {
      const prospects = await searchGoogleMaps(target.type, city, 5, config.googleMapsKey);
      const withEmail = prospects.filter(p => p.email);
      const withoutEmail = prospects.filter(p => !p.email).slice(0, 2); // take some without email too
      const toAdd = [...withEmail, ...withoutEmail];

      // Avoid duplicates — check queue AND already sent emails
      const log = loadLog();
      const alreadySent = log.map(e => (e.email || '').toLowerCase());
      const inQueue = q.items.map(i => (i.email || '').toLowerCase());
      const blacklist = new Set([...alreadySent, ...inQueue]);
      const newProspects = toAdd.filter(p => p.email && !blacklist.has(p.email.toLowerCase()));

      newProspects.forEach(p => {
        q.items.push({
          id: Date.now() + Math.random(),
          name: p.name, email: p.email, phone: p.phone,
          service: target.service,
          tone: 'Professionnel',
          status: 'pending',
          addedAt: new Date().toISOString(),
          city, businessType: target.type
        });
      });

      console.log(`  ✅ ${target.type} à ${city}: ${newProspects.length} ajoutés`);
    } catch(e) {
      console.error(`  ❌ ${target.type}: ${e.message}`);
    }
  }

  saveQueue(q);
  console.log(`🌅 Auto-prospect done — ${q.items.filter(i=>i.status==='pending').length} en attente`);
}

// Start workers
setInterval(processQueue, SEND_INTERVAL_MS);
setInterval(autoProspect, 60 * 60 * 1000); // check every hour (runs only at 8h)
setInterval(checkReplies, 30 * 60 * 1000);
console.log('⏱ Auto-send worker: every 8 minutes (9h-17h EST)');
console.log('📬 Reply checker: every 30 minutes');

// ── LOG / COSTS ───────────────────────────────────────────────────────────────
app.get('/api/log', (req, res) => res.json(loadLog()));
app.delete('/api/log/:id', (req, res) => {
  saveLog(loadLog().filter(e => e.id !== parseInt(req.params.id)));
  res.json({ success: true });
});
app.get('/api/costs', (req, res) => res.json(loadCosts()));
app.delete('/api/costs', (req, res) => { saveCosts({ total_usd: 0, entries: [] }); res.json({ success: true }); });

// ── CONFIG ────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  const safe = { ...config };
  if (safe.gmailPass) safe.gmailPass = '••••••••';
  if (safe.googleMapsKey) safe.googleMapsKey = '••••••••';
  res.json(safe);
});
app.post('/api/config', (req, res) => {
  const existing = loadConfig();
  const updated = { ...existing, ...req.body };
  if (req.body.gmailPass === '••••••••') updated.gmailPass = existing.gmailPass;
  if (req.body.googleMapsKey === '••••••••') updated.googleMapsKey = existing.googleMapsKey;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ Bot Prospection lancé sur http://localhost:${PORT}\n`));
