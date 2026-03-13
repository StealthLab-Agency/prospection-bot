const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const LOG_FILE    = path.join(__dirname, 'data', 'emails.json');
const COSTS_FILE  = path.join(__dirname, 'data', 'costs.json');

function loadConfig() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  // Environment variables override config file (for Render.com hosting)
  if (process.env.ANTHROPIC_KEY) config.anthropicKey = process.env.ANTHROPIC_KEY;
  if (process.env.GMAIL_USER)    config.gmailUser    = process.env.GMAIL_USER;
  if (process.env.GMAIL_PASS)    config.gmailPass    = process.env.GMAIL_PASS;
  if (process.env.SENDER_NAME)   config.senderName   = process.env.SENDER_NAME;
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

// claude-sonnet-4: $3/1M input, $15/1M output
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

// ── SEARCH ────────────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { type, city, count = 6 } = req.body;
  const config = loadConfig();
  if (!config.anthropicKey) return res.status(400).json({ error: 'Clé API Anthropic manquante.' });
  const client = new Anthropic({ apiKey: config.anthropicKey });
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: `Trouve ${count} vrais "${type}" à ${city} Canada avec web_search. Pour chacun: nom, téléphone, email, adresse, site web. JSON uniquement sans markdown: {"prospects":[{"name":"","phone":"","email":"","address":"","website":"","source":"","hasWebsite":true,"note":""}]}` }]
    });
    const cost = trackCost('search', response.usage, `${type} à ${city}`);
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) return res.json({ prospects: [], cost });
    let parsed;
    try { parsed = JSON.parse(textBlock.text.trim()); }
    catch { const m = textBlock.text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { prospects: [] }; }
    res.json({ ...parsed, cost });
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
      messages: [{ role: 'user', content: `Email prospection français, agence web québécoise. Client: "${clientName}", service: "${service}", ton: ${tone}. Max 180 mots. JSON: {"subject":"","body":""}` }]
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

// ── SEND EMAIL ────────────────────────────────────────────────────────────────
app.post('/api/send-email', async (req, res) => {
  const { to, toName, subject, body, service } = req.body;
  const config = loadConfig();
  if (!config.gmailUser || !config.gmailPass) return res.status(400).json({ error: 'Gmail non configuré.' });
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: config.gmailUser, pass: config.gmailPass } });
  try {
    await transporter.sendMail({ from: `"${config.senderName || 'Mon Agence Web'}" <${config.gmailUser}>`, to: `${toName} <${to}>`, subject, text: body, html: body.replace(/\n/g, '<br>') });
    const log = loadLog();
    log.unshift({ id: Date.now(), to: toName || to, email: to, subject, body, service, date: new Date().toISOString(), status: 'sent' });
    saveLog(log);
    res.json({ success: true });
  } catch (e) {
    const log = loadLog();
    log.unshift({ id: Date.now(), to: toName || to, email: to, subject, body, service, date: new Date().toISOString(), status: 'error', error: e.message });
    saveLog(log);
    res.status(500).json({ error: e.message });
  }
});

// ── LOG ───────────────────────────────────────────────────────────────────────
app.get('/api/log', (req, res) => res.json(loadLog()));
app.delete('/api/log/:id', (req, res) => {
  saveLog(loadLog().filter(e => e.id !== parseInt(req.params.id)));
  res.json({ success: true });
});

// ── COSTS ─────────────────────────────────────────────────────────────────────
app.get('/api/costs', (req, res) => res.json(loadCosts()));
app.delete('/api/costs', (req, res) => { saveCosts({ total_usd: 0, entries: [] }); res.json({ success: true }); });

// ── CONFIG ────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  const safe = { ...config };
  if (safe.gmailPass) safe.gmailPass = '••••••••';
  res.json(safe);
});
app.post('/api/config', (req, res) => {
  const existing = loadConfig();
  const updated = { ...existing, ...req.body };
  if (req.body.gmailPass === '••••••••') updated.gmailPass = existing.gmailPass;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2));
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ Bot Prospection lancé sur http://localhost:${PORT}\n`));
