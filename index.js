'use strict';
// 𝐁𝐀𝐑𝐁𝐈𝐄 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 — merged WhatsApp runtime
require('dotenv').config();
const ANTILINK = require('./lib/antilink');
const express = require('express');
const path = require('path');
const { FollowChannelJids, unfollowJids } = require('./lib/newsletters');
const fs = require('fs');
const fse = require('fs-extra');
const bodyParser = require('body-parser');
const { MongoClient } = require('mongodb');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, getContentType, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, jidDecode, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { downloadMediaMessage } = require('./lib/msg');
const { AntiDelete } = require('./lib/antidel');
const { saveMessage, getGroupAdmins, getRandom } = require('./lib');
const { commands } = require('./command');
const GroupEvents = require('./lib/groupevents');
const config = require('./config');
const axios = require('axios');

async function followNewsletter(sock) { for (const njid of FollowChannelJids) { try { if (njid) await sock.newsletterFollow(njid); } catch {} } }
async function UnfollowNewsletter(sock) { for (const jid of unfollowJids) { try { if (jid) await sock.newsletterUnfollow(jid); } catch {} } }

const PLUGINS_DIR = path.join(__dirname, 'plugins');
const SESSION_DIR = path.join(__dirname, 'session');
const PORT = Number(process.env.PORT || 20048);
const EXTRA_SUDO = [];
const activeSessions = new Map();
const pendingSessions = new Map();
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS_PER_SERVER || config.MAX_RETRIES || 50);
const NEWSLETTER_EMOJIS = ['❤️', '👍', '😮', '😎', '💀'];
const CROWN_EMOJI = '👑';
const ALLOWED_OWNERS = [String(config.OWNER_NUMBER).replace(/\D/g, '')];
const REACT_EMOJIS = config.REACT_EMOJIS || ['❤️','👍','🔥','🎉','💯','😎'];
const HEART_EMOJIS = config.HEART_EMOJIS || ['❤️','💖','💝','💗','💓','💞','💕'];

let mongoClient = null;
let db = null;
async function connectMongo() {
  if (!config.MONGODB_URL) return;
  try {
    mongoClient = new MongoClient(config.MONGODB_URL, { serverSelectionTimeoutMS: 8000 });
    await mongoClient.connect();
    db = mongoClient.db(config.DB_NAME);
    await db.collection(config.COLLECTIONS.SESSIONS).createIndex({ number: 1 }, { unique: true });
    await db.collection(config.COLLECTIONS.NUMBERS).createIndex({ number: 1 }, { unique: true });
    console.log('✅ MongoDB Connected');
  } catch (err) { console.warn('⚠️ MongoDB unavailable; continuing with local sessions:', err.message); db = null; }
}
async function saveSession(number, sessionData) { if (!db) return; try { const base64 = Buffer.from(JSON.stringify(sessionData)).toString('base64'); await db.collection(config.COLLECTIONS.SESSIONS).updateOne({ number }, { $set: { number, sessionData: base64, lastUpdated: new Date(), createdAt: new Date() } }, { upsert: true }); } catch (err) { console.error('❌ Error saving session:', err.message); } }
async function loadSession(number) { if (!db) return null; try { const doc = await db.collection(config.COLLECTIONS.SESSIONS).findOne({ number }); return doc?.sessionData ? JSON.parse(Buffer.from(doc.sessionData, 'base64').toString()) : null; } catch { return null; } }
async function restoreMongoSession(number) { const session = await loadSession(number); if (!session) return false; const sessionPath = path.join(SESSION_DIR, `session_${number}`); fse.ensureDirSync(sessionPath); fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(session, null, 2)); return true; }
async function deleteSession(number) { if (db) try { await db.collection(config.COLLECTIONS.SESSIONS).deleteOne({ number }); } catch {} }
async function loadConfig(number) { if (!db) return { ...config.DEFAULT_SETTINGS }; try { const doc = await db.collection(config.COLLECTIONS.CONFIGS).findOne({ number }); if (!doc?.config || Object.keys(doc.config).length === 0) { const cfg = { ...config.DEFAULT_SETTINGS }; await db.collection(config.COLLECTIONS.CONFIGS).updateOne({ number }, { $set: { number, config: cfg, lastUpdated: new Date() } }, { upsert: true }); return cfg; } return doc.config; } catch { return { ...config.DEFAULT_SETTINGS }; } }
async function saveConfig(number, cfg) { if (db) try { await db.collection(config.COLLECTIONS.CONFIGS).updateOne({ number }, { $set: { number, config: cfg, lastUpdated: new Date() } }, { upsert: true }); } catch {} }
async function deleteConfig(number) { if (db) try { await db.collection(config.COLLECTIONS.CONFIGS).deleteOne({ number }); } catch {} }
async function isFirstActivation(number) { if (!db) return true; try { const doc = await db.collection(config.COLLECTIONS.CONFIGS).findOne({ number }); return !doc?.activated; } catch { return true; } }
async function markActivated(number) { if (db) try { await db.collection(config.COLLECTIONS.CONFIGS).updateOne({ number }, { $set: { activated: true, activatedAt: new Date() } }, { upsert: true }); } catch {} }
async function addActiveNumber(number) { if (db) try { await db.collection(config.COLLECTIONS.NUMBERS).updateOne({ number }, { $set: { number, addedAt: new Date(), lastActive: new Date() } }, { upsert: true }); } catch {} }
async function getActiveNumbers() { if (!db) return []; try { return (await db.collection(config.COLLECTIONS.NUMBERS).find().toArray()).map(d => d.number); } catch { return []; } }
async function removeActiveNumber(number) { if (db) try { await db.collection(config.COLLECTIONS.NUMBERS).deleteOne({ number }); } catch {} }

async function loadPluginFiles() {
  fse.ensureDirSync(PLUGINS_DIR);
  const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js')).sort();
  console.log(`📦 Loading ${files.length} plugins from local folder...`);
  for (const file of files) { try { const pluginPath = path.join(PLUGINS_DIR, file); delete require.cache[require.resolve(pluginPath)]; require(pluginPath); } catch (err) { console.error(`❌ Error loading plugin ${file}:`, err.message); } }
}
async function cleanupSession(number, reason = 'Session expired') { try { const sessionPath = path.join(SESSION_DIR, `session_${number}`); if (fs.existsSync(sessionPath)) fse.removeSync(sessionPath); const sock = activeSessions.get(number); try { sock?.ws?.close(); } catch {} activeSessions.delete(number); await deleteSession(number); await deleteConfig(number); await removeActiveNumber(number); console.log(`🧹 Cleanup ${number}: ${reason}`); } catch (err) { console.error('Cleanup error:', err.message); } }

function attachBotHandlers(sock, number, userConfig, saveCreds) {
  sock.ev.on('creds.update', async () => { try { await saveCreds(); const credsPath = path.join(SESSION_DIR, `session_${number}`, 'creds.json'); if (fs.existsSync(credsPath)) { const raw = fs.readFileSync(credsPath, 'utf8'); if (raw.trim()) await saveSession(number, JSON.parse(raw)); } } catch {} });
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') { pendingSessions.delete(number); activeSessions.set(number, sock); await addActiveNumber(number); sock.userConfig = userConfig; await followNewsletter(sock); await UnfollowNewsletter(sock); const first = await isFirstActivation(number); if (first) await markActivated(number); console.log(`🟢 Barbie connected: ${number}`); }
    else if (connection === 'close') { const statusCode = lastDisconnect?.error?.output?.statusCode; activeSessions.delete(number); pendingSessions.delete(number); if (statusCode !== DisconnectReason.loggedOut) setTimeout(() => startBot(number).catch(e => console.error(`Reconnect ${number}:`, e.message)), 3000); else await cleanupSession(number, 'loggedOut'); }
  });
  sock.ev.on('group-participants.update', async update => { try { await GroupEvents(sock, update); } catch {} });
  sock.ev.on('call', async calls => { try { const fresh = await loadConfig(number); Object.assign(userConfig, fresh); } catch {} if (userConfig.ANTI_CALL !== 'true') return; for (const call of calls) if (call.status === 'offer') try { await sock.rejectCall(call.id, call.from); await sock.sendMessage(call.from, { text: userConfig.REJECT_MSG || 'Calls not allowed' }); } catch {} });
  sock.ev.on('messages.upsert', async ({ messages, type }) => { if (type !== 'notify') return; try { const fresh = await loadConfig(number); Object.assign(userConfig, fresh); sock.userConfig = userConfig; } catch {} for (const msg of messages) { if (!msg.message) continue; try { if (msg.key.remoteJid === 'status@broadcast') { await handleStatus(sock, msg, userConfig); continue; } if (msg.key?.id?.length < 16) continue; await handleMessage(sock, msg, userConfig, number); await ANTILINK(sock, msg, userConfig); } catch (err) { console.error('❌ Message error:', err.message); } } });
  sock.ev.on('messages.update', async updates => { try { await AntiDelete(sock, updates); } catch {} });
}
async function handleStatus(sock, msg, userConfig) { const sender = msg.key.participantAlt || msg.key.remoteJidAlt || msg.key.participant || ''; if (!sender) return; if (userConfig.AUTO_VIEW_STATUS === 'true') { try { await sock.sendReceipt('status@broadcast', sender, [msg.key.id], 'read'); } catch {} } if (userConfig.AUTO_STATUS_REACT === 'true') { try { const list = userConfig.STATUS_EMOJIS || ['❤️','🔥','😍','😎','💯']; await sock.sendMessage('status@broadcast', { react: { text: list[Math.floor(Math.random()*list.length)], key: msg.key } }, { statusJidList: [sender] }); } catch {} } if (userConfig.AUTO_STATUS_REPLY === 'true') { try { await sock.sendMessage(sender, { text: userConfig.AUTO_STATUS_MSG || userConfig.STATUS_REPLY_MSG || '' }, { quoted: msg }); } catch {} } }
async function startBot(number) { if (activeSessions.has(number)) return activeSessions.get(number); if (activeSessions.size >= MAX_SESSIONS) return null; const sessionPath = path.join(SESSION_DIR, `session_${number}`); fse.ensureDirSync(sessionPath); if (!fs.existsSync(path.join(sessionPath, 'creds.json'))) await restoreMongoSession(number); const { state, saveCreds } = await useMultiFileAuthState(sessionPath); const { version } = await fetchLatestBaileysVersion(); const userConfig = await loadConfig(number); const sock = makeWASocket({ version, auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })) }, printQRInTerminal: false, logger: pino({ level: 'fatal' }), syncFullHistory: false, browser: Browsers.windows('Chrome'), generateHighQualityLinkPreview: true, markOnlineOnConnect: true }); attachBotHandlers(sock, number, userConfig, saveCreds); return sock; }

async function handleMessage(sock, msg, userConfig, botNumber) {
  const jid = msg.key?.remoteJid || ''; if (!jid) return; const isGroup = jid.endsWith('@g.us'); const botJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : ''; const sender = msg.key.fromMe ? botJid : (isGroup ? (msg.key.participantAlt || msg.key.participant || '') : (msg.key.remoteJidAlt || msg.key.participant || jid)); if (!sender) return; const senderNumber = String(sender).split('@')[0]; const isAllowedOwner = ALLOWED_OWNERS.includes(senderNumber); const isOwner = userConfig?.SUDO?.includes(sender) || config?.SUDO?.includes(sender) || EXTRA_SUDO.includes(sender) || isAllowedOwner || msg.key.fromMe;
  if (jid.includes('@newsletter')) return;
  if (userConfig.AUTO_REACT === 'true' && !msg.key.fromMe && !msg.message?.protocolMessage) try { await sock.sendMessage(jid, { react: { text: REACT_EMOJIS[Math.floor(Math.random()*REACT_EMOJIS.length)], key: msg.key } }); } catch {}
  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || ''; const prefix = userConfig.PREFIX || config.PREFIX || '.'; if (!body.startsWith(prefix)) return; const isCmd = true; const parts = body.slice(prefix.length).trim().split(/\s+/); const command = (parts.shift() || '').toLowerCase(); const args = parts; const q = args.join(' '); const isSudo = isOwner; const BANNED = userConfig.BANNED || config.BANNED || []; if (BANNED.some(b => b === senderNumber || b === sender)) return; if ((userConfig.MODE || config.MODE) === 'private' && !isSudo) return;
  const reply = text => sock.sendMessage(jid, { text: String(text) }, { quoted: msg }); const react = emoji => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }); const groupMetadata = isGroup ? await sock.groupMetadata(jid).catch(() => null) : null; const participants = groupMetadata?.participants || []; const groupAdmins = participants.filter(p => p.admin).map(p => p.id); const isAdmins = groupAdmins.includes(sender); const isBotAdmins = groupAdmins.includes(botJid); const contextInfo = msg.message?.extendedTextMessage?.contextInfo || {}; const quotedMsg = contextInfo.quotedMessage; const quotedParticipant = contextInfo.participant; const quoted = quotedMsg ? { message: quotedMsg, key: { remoteJid: jid, fromMe: false, id: contextInfo.stanzaId, participant: quotedParticipant }, sender: quotedParticipant, mtype: getContentType(quotedMsg), download: async () => { const type = getContentType(quotedMsg); const media = quotedMsg[type]; const stream = await downloadContentFromMessage(media, type.replace('Message','')); const chunks=[]; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks); } } : null; const mentionedJid = contextInfo.mentionedJid || []; const target = mentionedJid[0] || quotedParticipant || null;
  const processedM = { key: msg.key, message: msg.message, messageTimestamp: msg.messageTimestamp, pushName: msg.pushName, from: jid, sender, senderNumber, fromMe: !!msg.key.fromMe, body, mtype: getContentType(msg.message), isGroup, quoted, mentionedJid, pushname: msg.pushName || 'Unknown', react, target, chat: jid }; const ctx = { from: jid, body, isCmd, command, args, q, text:q, prefix, isGroup, sender, senderNumber, senderNum:senderNumber, sanitizedNumber:botNumber, botNumber, botNumber2:botNumber, pushname:msg.pushName || 'Unknown', isMe:!!msg.key.fromMe, isOwner:isSudo, isCreator:isOwner, isDev:isAllowedOwner, isAdmins, isBotAdmins, groupMetadata, groupName:groupMetadata?.subject || '', participants, groupAdmins, quoted, mentionedJid, l:sock, reply, react, userConfig, config, target, updateUserConfig:async(num,cfg)=>{ await saveConfig(num||botNumber,cfg); Object.assign(userConfig,cfg); sock.userConfig=userConfig; } };
  for (const c of commands) if (c.on === 'body' && typeof c.function === 'function') try { await c.function(sock, processedM, processedM, ctx); } catch (err) { console.error('Body listener:', err.message); }
  const matched = commands.find(c => { if (c.pattern instanceof RegExp) return c.pattern.test(command); if (c.pattern && String(c.pattern).toLowerCase() === command) return true; return Array.isArray(c.alias) && c.alias.map(x=>String(x).toLowerCase()).includes(command); }); if (!matched) return; if (matched.react) try { await react(matched.react); } catch {} try { await matched.function(sock, processedM, processedM, ctx); } catch (err) { console.error(`Command failed [${command}]:`, err.message); try { await reply(`⚠️ Error: ${err.message}`); } catch {} }
}

const app = express(); app.use(bodyParser.json()); app.use(bodyParser.urlencoded({ extended:true })); app.use('/lib', express.static(path.join(__dirname,'lib')));
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'lib','main.html')));
app.get('/api/code', async (req,res)=>{ const number=String(req.query.number||''); if(!/^\d{8,15}$/.test(number)) return res.json({error:'Invalid number format. Use digits only.'}); if(activeSessions.has(number)) return res.json({error:'already_connected',message:'This number is already connected'}); if(activeSessions.size>=MAX_SESSIONS) return res.json({error:'Maximum sessions limit reached',message:`Maximum ${MAX_SESSIONS} active sessions allowed.`}); if(pendingSessions.has(number)) { try { pendingSessions.get(number)?.ws?.close(); } catch {} pendingSessions.delete(number); } const userConfig=await loadConfig(number); try { const sessionPath=path.join(SESSION_DIR,`session_${number}`); fse.ensureDirSync(sessionPath); const {state,saveCreds}=await useMultiFileAuthState(sessionPath); const {version}=await fetchLatestBaileysVersion(); const sock=makeWASocket({version,auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,pino({level:'fatal'}))},printQRInTerminal:false,logger:pino({level:'fatal'}),syncFullHistory:false,browser:Browsers.windows('Chrome'),generateHighQualityLinkPreview:true,markOnlineOnConnect:true}); attachBotHandlers(sock,number,userConfig,saveCreds); if(!state.creds.registered){ pendingSessions.set(number,sock); await delay(1500); const code=await sock.requestPairingCode(number); return res.json({code}); } return res.json({message:'already_connected'}); } catch(err) { pendingSessions.delete(number); console.error('Pairing error:',err.message); return res.json({error:'Failed to generate pairing code',message:'Please try again or check your number format'}); } });
app.get('/api/chreact', async (req,res)=>{ const {newsletter,message,emojis}=req.query; if(!newsletter||!message||!emojis) return res.json({success:false,message:'newsletterjid, messageid and emojis are required'}); let jid=String(newsletter); if(!jid.endsWith('@newsletter')) jid+='@newsletter'; const allowed=config.SMD||[]; if(allowed.length&&!allowed.includes(jid)) return res.json({success:false,message:'Newsletter not in configured list'}); const emojiList=String(emojis).split(',').map(x=>x.trim()).filter(Boolean); const socks=[...activeSessions.values()]; if(!socks.length) return res.json({success:false,message:'No active sessions'}); let reacted=0; for(const sock of socks){ try{await sock.newsletterReactMessage(jid,String(message),emojiList[Math.floor(Math.random()*emojiList.length)]);reacted++;}catch{} } return res.json({success:true,newsletterJid:jid,messageId:String(message),emojis:emojiList,reacted,failed:socks.length-reacted,total:socks.length}); });
app.get('/api/active',(req,res)=>res.json({count:activeSessions.size,limit:MAX_SESSIONS}));
app.get('/api/restart',(req,res)=>{res.json({success:true,message:'Restarting server...'});setTimeout(()=>process.exit(0),1000);});
async function main(){ await connectMongo(); await loadPluginFiles(); for(const number of await getActiveNumbers()) try{await startBot(number);}catch(e){console.error('Restore error:',e.message);} app.listen(PORT,'0.0.0.0',()=>console.log(`🚀 𝐁𝐀𝐑𝐁𝐈𝐄 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 server running on ${PORT}`)); }
main().catch(err=>console.error('❌ Startup error:',err.message));
