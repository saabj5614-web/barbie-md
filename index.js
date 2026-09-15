'use strict';
require('dotenv').config();

const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const pino = require('pino');
const ytSearch = require('yt-search');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, delay, jidDecode } = require('@whiskeysockets/baileys');
const config = require('./config');

const PORT = Number(process.env.PORT || 20048);
const SESSION_DIR = path.join(__dirname, 'session');
const MAX_SESSIONS = 50;
const sessions = new Map();
const pending = new Map();
const startedAt = Date.now();
const logger = pino({ level: 'silent' });
fs.mkdirSync(SESSION_DIR, { recursive: true });

const channelLinks = String(process.env.WHATSAPP_CHANNELS || '').split(',').map(x => x.trim());
while (channelLinks.length < 6) channelLinks.push('');
const channelJids = String(process.env.WHATSAPP_CHANNEL_JIDS || '').split(',').map(x => x.trim()).filter(Boolean);

let mongo = null;
let db = null;
async function connectMongo() {
  const uri = process.env.MONGODB_URI || process.env.MONGODB_URL || '';
  if (!uri) return;
  try {
    mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await mongo.connect();
    db = mongo.db(process.env.DB_NAME || 'barbie_md');
    await db.collection('active_numbers').createIndex({ number: 1 }, { unique: true });
    console.log('✅ MongoDB connected');
  } catch (e) {
    console.warn('⚠️ MongoDB unavailable; continuing with local session state:', e.message);
    db = null;
  }
}
async function saveNumber(number) { if (db) try { await db.collection('active_numbers').updateOne({ number }, { $set: { number, updatedAt: new Date() } }, { upsert: true }); } catch {} }
async function removeNumber(number) { if (db) try { await db.collection('active_numbers').deleteOne({ number }); } catch {} }
async function getSavedNumbers() { if (!db) return []; try { return (await db.collection('active_numbers').find({}).toArray()).map(x => x.number); } catch { return []; } }
function cleanNumber(value) { return String(value || '').replace(/\D/g, ''); }
function uptime() { const s = Math.floor((Date.now() - startedAt) / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return `${d}d ${h}h ${m}m ${s % 60}s`; }
function botJid(sock) { const id = sock.user?.id || '', d = jidDecode(id); return d?.user ? `${d.user}@s.whatsapp.net` : (id.split(':')[0] || ''); }
function textOf(m) { return m?.message?.conversation || m?.message?.extendedTextMessage?.text || m?.message?.imageMessage?.caption || m?.message?.videoMessage?.caption || ''; }
function senderOf(m) { return m.key?.participant || m.key?.remoteJid || ''; }
function isAdmin(meta, jid) { return meta?.participants?.some(p => p.id === jid && !!p.admin); }
function mentionText(ids) { return ids.map(x => `@${String(x).split('@')[0]}`).join(' '); }

async function followConfiguredChannels(sock) { for (const jid of channelJids) { try { await sock.newsletterFollow(jid); } catch {} } }

async function startSession(number, needCode = false) {
  const key = cleanNumber(number);
  if (!/^\d{8,15}$/.test(key)) throw new Error('Invalid WhatsApp number. Use country code without +.');
  if (sessions.get(key)?.connected) return { connected: true };
  if (sessions.size >= MAX_SESSIONS && !sessions.has(key)) throw new Error(`This server is full (${MAX_SESSIONS} sessions).`);
  const dir = path.join(SESSION_DIR, `session_${key}`); fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const entry = sessions.get(key) || { connected: false, number: key, reconnecting: false, pairingCode: null };
  sessions.set(key, entry);
  const sock = makeWASocket({ auth: state, logger, browser: Browsers.windows('Chrome'), markOnlineOnConnect: false, syncFullHistory: false, generateHighQualityLinkPreview: true });
  entry.sock = sock; sock.ev.on('creds.update', saveCreds);
  let codeRequested = false;
  sock.ev.on('messages.upsert', async ({ messages }) => { for (const m of messages) { try { await handleMessage(sock, m); } catch (e) { console.error('[MSG]', e.message); } } });
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'connecting' && needCode && !state.creds.registered && !codeRequested) {
      codeRequested = true; try { entry.pairingCode = await sock.requestPairingCode(key); pending.set(key, entry); } catch (e) { codeRequested = false; console.error(`[PAIR ${key}]`, e.message); }
    }
    if (connection === 'open') { entry.connected = true; entry.reconnecting = false; pending.delete(key); await saveNumber(key); await followConfiguredChannels(sock); console.log(`🟢 WhatsApp connected: ${key}`); }
    if (connection === 'close') {
      entry.connected = false; const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { sessions.delete(key); pending.delete(key); await removeNumber(key); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} return; }
      if (!entry.reconnecting) { entry.reconnecting = true; setTimeout(() => startSession(key, false).catch(e => console.error(`[RECONNECT ${key}]`, e.message)), 3000); }
    }
  });
  if (needCode) { for (let i = 0; i < 40 && !entry.pairingCode; i++) await delay(250); if (!entry.pairingCode) throw new Error('Pairing code generate nahi hua. Dobara try karein.'); }
  return { code: entry.pairingCode || null, connected: entry.connected };
}
async function removeSession(number) { const key = cleanNumber(number), s = sessions.get(key); try { await s?.sock?.logout(); } catch {} try { s?.sock?.end?.(); } catch {} sessions.delete(key); pending.delete(key); await removeNumber(key); try { fs.rmSync(path.join(SESSION_DIR, `session_${key}`), { recursive: true, force: true }); } catch {} return true; }

const AI = {
  ai: ['https://api.hanggts.xyz/ai/chatgpt4o?text=', 'result.data'], gpt: ['https://api.hanggts.xyz/ai/chatgpt4o?text=', 'result.data'],
  chatgpt: ['https://jawad-tech.vercel.app/ai/gpt?q=', 'result'], gemini: ['https://api.xyro.site/ai/gemini?prompt=', 'result.parts.0.text'],
  copilot: ['https://api.xyro.site/ai/copilot?text=', 'data.text'], deepseek: ['https://api.xyro.site/ai/copilot?text=', 'data.text'],
  felo: ['https://api.xyro.site/ai/felo?text=', 'result.answer'], bard: ['https://api.xyro.site/ai/bard?text=', 'result'],
  brainai: ['https://api.xyro.site/ai/powerbrain?query=', 'result'], claudeai: ['https://apis.sandarux.sbs/api/ai/claude?text=', 'response'],
  metai: ['https://jawad-tech.vercel.app/ai/metai?q=', 'result'], perplexity: ['https://zelapioffciall.koyeb.app/ai/perplexity?text=', 'message']
};
function deepGet(obj, path) { return path.split('.').reduce((v, k) => v == null ? undefined : v[k], obj); }
async function askAI(command, prompt) { const item = AI[command]; let url = item[0] + encodeURIComponent(prompt); if (command === 'deepseek') url += '&model=think-deeper'; if (command === 'copilot') url += '&model=default'; const { data } = await axios.get(url, { timeout: 30000 }); const out = deepGet(data, item[1]); if (!out) throw new Error('AI provider did not return a response.'); return String(out); }

function menuText() {
  const links = channelLinks.filter(Boolean);
  return `╭━━━〔 🌟 ${config.BOT_NAME} 🌟 〕━━━┈⊷\n┃ 👤 Owner: ${config.OWNER_NAME}\n┃ ⚙️ Prefix: ${config.PREFIX}\n┃ ⏱️ Uptime: ${uptime()}\n┃ 📊 Sessions: ${sessions.size}/${MAX_SESSIONS}\n┃ 🛡️ Mode: Multi User\n╰━━━━━━━━━━━━━━━━━━━━┈⊷\n\n╭─〔 🤖 AI 〕─╮\n│ .ai / .gpt / .chatgpt\n│ .gemini / .copilot / .deepseek\n│ .felo / .bard / .brainai\n│ .claudeai / .metai / .perplexity\n╰────────────╯\n\n╭─〔 🎬 YouTube 〕─╮\n│ .play <song/video>\n│ .yt <query> / .ytsearch <query>\n╰────────────────╯\n\n╭─〔 👥 Group 〕─╮\n│ .ginfo / .groupinfo / .tagall\n│ .add / .promote / .demote / .kick\n╰────────────────╯\n\n╭─〔 ⚙️ Main 〕─╮\n│ .ping / .alive / .uptime\n│ .owner / .status / .link\n╰────────────────╯\n\n${links.length ? `📢 Channel: ${links[0]}` : '📢 Channel: Not configured'}\n\n> Powered by ${config.OWNER_NAME}`;
}

async function handleMessage(sock, m) {
  if (!m.message || m.key.fromMe) return; const body = textOf(m).trim(); if (!body.startsWith(config.PREFIX)) return;
  const parts = body.slice(config.PREFIX.length).trim().split(/\s+/), command = (parts.shift() || '').toLowerCase(), q = parts.join(' '), from = m.key.remoteJid; if (!from || from === 'status@broadcast') return;
  const reply = text => sock.sendMessage(from, { text: String(text) }, { quoted: m });
  if (command === 'menu' || command === 'help') return reply(menuText());
  if (command === 'ping' || command === 'ping2') return reply(`🏓 *𝐁𝐀𝐑𝐁𝐈𝐄 𝐌𝐃 SPEED*\n\n🟢 Online\n⏱️ Uptime: ${uptime()}\n\n> Powered by ${config.OWNER_NAME}`);
  if (command === 'alive') return reply(`🟢 ${config.BOT_NAME} is online.\nUptime: ${uptime()}\nSessions: ${sessions.size}/${MAX_SESSIONS}`);
  if (command === 'uptime' || command === 'up') return reply(`⏱️ Uptime: ${uptime()}`);
  if (command === 'owner') return reply(`👑 Owner: ${config.OWNER_NAME}\n📞 ${config.OWNER_NUMBER}`);
  if (command === 'status') return reply(`📊 ${config.BOT_NAME}\n\n🟢 Active sessions: ${sessions.size}/${MAX_SESSIONS}\n💾 Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB\n🖥️ CPU: ${os.cpus()[0]?.model || 'Node.js'}\n⏱️ Uptime: ${uptime()}`);
  if (command === 'link') { const links = channelLinks.filter(Boolean); return reply(`📢 ${config.BOT_NAME} Channel\n\n${links.length ? links.map((x,i)=>`${i+1}. ${x}`).join('\n') : 'No channel configured yet.'}`); }
  if (AI[command]) { if (!q) return reply(`Use: ${config.PREFIX}${command} <message>`); try { await reply('⏳ Barbie AI is thinking...'); return reply(await askAI(command, q)); } catch (e) { return reply(`❌ AI error: ${e.message}`); } }
  if (['play','yt','ytsearch','yts'].includes(command)) { if (!q) return reply(`Use: ${config.PREFIX}${command} <song or video name>`); try { const r = await ytSearch(q), v = r.videos?.[0]; if (!v) return reply('❌ No YouTube result found.'); return reply(`🎬 *YouTube Result*\n\n🎵 Title: ${v.title}\n👤 Channel: ${v.author?.name || 'Unknown'}\n⏱️ Duration: ${v.timestamp || 'N/A'}\n👁️ Views: ${v.views || 'N/A'}\n\n🔗 ${v.url}\n\n> Powered by ${config.OWNER_NAME}`); } catch (e) { return reply(`❌ YouTube error: ${e.message}`); } }
  if (!from.endsWith('@g.us')) { if (['ginfo','groupinfo','tagall','hidetag','add','promote','demote','kick'].includes(command)) return reply('⚠️ Ye command sirf group mein use hoti hai.'); return; }
  const meta = await sock.groupMetadata(from), sender = senderOf(m), admin = isAdmin(meta, sender), bot = botJid(sock), botAdmin = isAdmin(meta, bot);
  if (command === 'ginfo' || command === 'groupinfo') return reply(`👥 *${meta.subject}*\n\nMembers: ${meta.participants.length}\nAdmins: ${meta.participants.filter(p=>p.admin).length}`);
  if (command === 'tagall' || command === 'hidetag') { const ids = meta.participants.map(p=>p.id); return sock.sendMessage(from, { text: `📣 ${mentionText(ids)}`, mentions: ids }, { quoted: m }); }
  if (['add','promote','demote','kick'].includes(command)) { if (!admin) return reply('⚠️ Sirf group admin ye command use kar sakta hai.'); if (!botAdmin) return reply('⚠️ Pehle Barbie bot ko group admin banayein.'); const target = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (parts[0] ? `${cleanNumber(parts[0])}@s.whatsapp.net` : null); if (!target) return reply(`Use: ${config.PREFIX}${command} @user`); const action = command === 'add' ? 'add' : command === 'promote' ? 'promote' : command === 'demote' ? 'demote' : 'remove'; try { await sock.groupParticipantsUpdate(from, [target], action); return reply(`✅ ${command} done.`); } catch (e) { return reply(`❌ ${command} failed: ${e.message}`); } }
}

async function restore() { const saved = await getSavedNumbers(); for (const number of saved.slice(0, MAX_SESSIONS)) { try { await startSession(number, false); } catch {} } for (const d of fs.readdirSync(SESSION_DIR, { withFileTypes: true }).filter(x => x.isDirectory())) { const number = d.name.replace(/^session_/, ''); if (/^\d{8,15}$/.test(number) && !sessions.has(number) && sessions.size < MAX_SESSIONS) { try { await startSession(number, false); } catch {} } } }

const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: true }));
app.get('/', (req,res)=>res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${config.BOT_NAME}</title><style>body{margin:0;background:#09090b;color:#fff;font-family:Arial,sans-serif;min-height:100vh;display:grid;place-items:center}main{width:min(92%,520px);padding:28px;border:1px solid #27272a;border-radius:24px;background:#111113;box-shadow:0 20px 60px #0008}h1{margin:0 0 8px;font-size:30px}p{color:#a1a1aa}input,button{width:100%;box-sizing:border-box;padding:14px;margin-top:10px;border-radius:14px;border:1px solid #3f3f46;background:#18181b;color:#fff}button{cursor:pointer;font-weight:700;background:#fff;color:#111}.code{margin-top:18px;font-size:26px;letter-spacing:4px;text-align:center}.muted{font-size:13px}</style></head><body><main><h1>🌸 ${config.BOT_NAME}</h1><p>Premium WhatsApp pairing server · ${MAX_SESSIONS} sessions per server</p><input id="n" inputmode="numeric" placeholder="923xxxxxxxxx"><button onclick="pair()">Generate Pairing Code</button><div id="out" class="code"></div><p class="muted">Number country code ke saath, + ke baghair.</p></main><script>async function pair(){const n=document.getElementById('n').value;const o=document.getElementById('out');o.textContent='Generating…';try{const r=await fetch('/api/code?number='+encodeURIComponent(n));const d=await r.json();o.textContent=d.code||d.message||d.error||'Try again';}catch(e){o.textContent='Server error';}}</script></body></html>`));
app.get('/api/code', async (req,res)=>{ const number=cleanNumber(req.query.number); if(!/^\d{8,15}$/.test(number)) return res.status(400).json({error:'invalid_number'}); if(sessions.get(number)?.connected) return res.json({error:'already_connected',message:'This number is already connected.'}); if(sessions.size>=MAX_SESSIONS&&!sessions.has(number)) return res.status(429).json({error:'server_full',message:`Maximum ${MAX_SESSIONS} sessions reached.`}); try{return res.json({code:(await startSession(number,true)).code});}catch(e){return res.status(500).json({error:'pairing_failed',message:e.message});} });
app.get('/api/active',(req,res)=>res.json({count:sessions.size,limit:MAX_SESSIONS,uptime:uptime()}));
app.get('/api/health',(req,res)=>res.json({ok:true,bot:config.BOT_NAME,sessions:sessions.size,limit:MAX_SESSIONS}));
app.post('/api/restart',(req,res)=>{res.json({success:true});setTimeout(()=>process.exit(0),500);});

(async()=>{ await connectMongo(); await restore(); app.listen(PORT,'0.0.0.0',()=>console.log(`🚀 ${config.BOT_NAME} server running on port ${PORT} | ${sessions.size}/${MAX_SESSIONS} sessions`)); })();
EOF
