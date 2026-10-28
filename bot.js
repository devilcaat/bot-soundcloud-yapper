import { Bot, Embed, Row, Button } from './yapper.js';
import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import * as rtc from '@livekit/rtc-node';

// TES CLES
const YAPPER_TOKEN = 'yb_35159841.HV8pvVteBHvqJFsBjsIIii7LLPv_kW4pmD9qts54'; 
const KLIPY_API_KEY = 'Z3MQ4jnhOlEeQbqhRqdCJ8sDBcJ5vPhAMqvQsXDnmOVqKg42mQANk0O9xMl38TKy'; 

const bot = new Bot(YAPPER_TOKEN);

// ---------- BASE DE DONNEES ----------
const db = new Database('bot.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS welcome_config (server_id TEXT PRIMARY KEY, channel_id TEXT, enabled INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS permissions (server_id TEXT, command_name TEXT, role_ids TEXT, PRIMARY KEY (server_id, command_name));
  CREATE TABLE IF NOT EXISTS auto_roles (server_id TEXT PRIMARY KEY, role_ids TEXT);
  CREATE TABLE IF NOT EXISTS lights (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, username TEXT, content TEXT, created_at TEXT);
`);

// Fonctions DB
function getWelcomeConfig(s) {
  let r = db.prepare('SELECT * FROM welcome_config WHERE server_id = ?').get(s);
  if (!r) { db.prepare('INSERT INTO welcome_config (server_id, enabled) VALUES (?, 1)').run(s); r = { channel_id: null, enabled: 1 }; }
  return r;
}
function updateWelcomeChannel(s, c) { db.prepare('INSERT INTO welcome_config (server_id, channel_id) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET channel_id = excluded.channel_id').run(s, c); }
function updateWelcomeToggle(s, e) { db.prepare('INSERT INTO welcome_config (server_id, enabled) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET enabled = excluded.enabled').run(s, e ? 1 : 0); }
function getPermission(s, c) { const r = db.prepare('SELECT role_ids FROM permissions WHERE server_id = ? AND command_name = ?').get(s, c); return !r ? null : r.role_ids === 'everyone' ? ['everyone'] : r.role_ids.split(','); }
function setPermission(s, c, a) { const v = a[0] === 'everyone' ? 'everyone' : a.join(','); db.prepare('INSERT INTO permissions (server_id, command_name, role_ids) VALUES (?, ?, ?) ON CONFLICT(server_id, command_name) DO UPDATE SET role_ids = excluded.role_ids').run(s, c, v); }
function getAutoRoles(s) { const r = db.prepare('SELECT role_ids FROM auto_roles WHERE server_id = ?').get(s); return r && r.role_ids ? r.role_ids.split(',') : []; }
function setAutoRoles(s, a) { db.prepare('INSERT INTO auto_roles (server_id, role_ids) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET role_ids = excluded.role_ids').run(s, a.join(',')); }

// ---------- PERMISSIONS ----------
async function canRunCommand(msg, cmd) {
  try {
    const server = await bot.server(msg.server_id);
    if (server.owner_id === msg.author_id) return true;
    const allowed = getPermission(msg.server_id, cmd);
    if (allowed) {
      if (allowed.includes('everyone')) return true;
      const m = await bot.member(msg.server_id, msg.author_id);
      return m.roles.some(r => allowed.includes(r));
    }
    const funCmds = ['random-gif', 'gif', 'poll', 'userinfo', 'serverinfo', 'help', 'search', 'info', 'light', 'status'];
    if (funCmds.includes(cmd)) return true;
    const roles = await bot.roles(msg.server_id);
    if (!roles || !roles.length) return false;
    const highest = roles.sort((a, b) => (b.position || 0) - (a.position || 0)).find(r => r.name !== '@everyone');
    if (!highest) return false;
    const m = await bot.member(msg.server_id, msg.author_id);
    return m.roles.includes(highest.id);
  } catch { return false; }
}

// ---------- SOUNDCLOUD CLIENT ----------
const SC_API = 'https://api-v2.soundcloud.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

class SoundCloudClient {
  constructor() { this.cid = null; }
  async getCid() {
    if (this.cid) return this.cid;
    const res = await fetch('https://soundcloud.com', { headers: HEADERS });
    const html = await res.text();
    const match = html.match(/"client_id":"([a-zA-Z0-9]{32})"/);
    if (match) { this.cid = match[1]; return this.cid; }
    throw new Error('Client ID not found');
  }
  async _get(endpoint, params = {}) {
    const cid = await this.getCid();
    const url = new URL(SC_API + endpoint);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('client_id', cid);
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async searchTracks(q, limit = 1) { return (await this._get('/search/tracks', { q, limit })).collection || []; }
  async searchPlaylists(q, limit = 1) { return (await this._get('/search/playlists', { q, limit })).collection || []; }
  async resolve(url) { return this._get('/resolve', { url }); }
  async getStream(track) {
    const transcodings = track.media?.transcodings || [];
    const tc = transcodings.find(t => t.format.protocol === 'progressive') || transcodings[0];
    if (!tc) return null;
    const cid = await this.getCid();
    const res = await fetch(`${tc.url}?client_id=${cid}`, { headers: HEADERS });
    const data = await res.json();
    return data.url;
  }
}
const sc = new SoundCloudClient();

// ---------- MUSIC PLAYER (LIVEKIT) ----------
const queues = new Map();

class MusicQueue {
  constructor(serverId, call) {
    this.serverId = serverId;
    this.call = call;
    this.tracks = [];
    this.playing = false;
    this.ffmpeg = null;
  }

  async playNext() {
    if (this.playing || this.tracks.length === 0) return;
    this.playing = true;
    const track = this.tracks.shift();

    try {
      const streamUrl = await sc.getStream(track);
      if (!streamUrl) throw new Error('No stream URL');

      // Lancement de FFmpeg pour convertir en PCM 48kHz Stéréo 16-bit
      this.ffmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-reconnect', '1', '-reconnect_streamed', '1',
        '-i', streamUrl, '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
      ]);

      // Lecture du flux et envoi à LiveKit par paquets de 10ms (1920 octets)
      let buffer = Buffer.alloc(0);
      this.ffmpeg.stdout.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 1920) {
          const frameData = buffer.subarray(0, 1920);
          buffer = buffer.subarray(1920);
          try {
            // Création d'une frame audio (480 samples = 10ms)
            const frame = new rtc.AudioFrame(frameData, 48000, 2, 480);
            await this.call.source.captureFrame(frame);
          } catch (e) { console.error('Frame error:', e); }
        }
      });

      this.ffmpeg.on('close', () => {
        this.playing = false;
        this.playNext();
      });

      bot.send(this.channelId, `▶️ En lecture : **${track.title}** — *${track.user?.username}*`).catch(()=>{});
    } catch (e) {
      console.error('Play error:', e);
      this.playing = false;
      this.playNext();
    }
  }

  skip() {
    if (this.ffmpeg) {
      this.ffmpeg.kill('SIGKILL');
      this.playing = false;
      this.playNext();
      return true;
    }
    return false;
  }
}

// ---------- COMMANDES ----------

bot.command('search', 'Search tracks on SoundCloud', async (msg) => {
  if (!(await canRunCommand(msg, 'search'))) return msg.reply('You do not have permission to use this command.');
  const query = msg.args?.trim();
  if (!query) return msg.reply('Usage: `/search [query]`');

  try {
    const tracks = await sc.searchTracks(query, 5);
    if (!tracks.length) return msg.reply('No results found.');
    
    const embed = new Embed().title(`Search: ${query}`).color('#ff5500');
    tracks.forEach((t, i) => embed.field(`${i+1}. ${t.title}`, `By: ${t.user.username} | [Link](${t.permalink_url})`));
    await msg.reply('', { embeds: [embed] });
  } catch (e) { await msg.reply(`Error: ${e.message}`); }
});

bot.command('play', 'Play a track from SoundCloud', async (msg) => {
  if (!(await canRunCommand(msg, 'play'))) return msg.reply('You do not have permission to use this command.');
  
  // Vérifier si l'utilisateur est dans un salon vocal
  const voiceState = await bot.voice(msg.server_id);
  const userVc = voiceState.find(v => v.user_ids.includes(msg.author_id));
  if (!userVc) return msg.reply('❌ You must be in a voice channel to play music.');

  const query = msg.args?.trim();
  if (!query) return msg.reply('Usage: `/play [query]`');

  let queue = queues.get(msg.server_id);
  if (!queue) {
    try {
      await msg.reply('Connecting to voice...');
      const call = await bot.connectVoice(rtc, msg.server_id, userVc.channel_id);
      queue = new MusicQueue(msg.server_id, call);
      queue.channelId = msg.channel_id;
      queues.set(msg.server_id, queue);
    } catch (e) {
      return msg.reply(`❌ Voice connection failed: ${e.message}`);
    }
  }

  try {
    // Résolution du morceau
    let tracks = [];
    if (query.startsWith('http')) {
      const res = await sc.resolve(query);
      if (res.kind === 'track') tracks = [res];
      else if (res.kind === 'playlist') tracks = res.tracks;
    } else {
      tracks = await sc.searchTracks(query, 1);
    }

    if (!tracks.length) return msg.reply('❌ No track found.');

    queue.tracks.push(...tracks);
    await msg.reply(`✅ Added **${tracks[0].title}** to the queue.`);
    queue.playNext();
  } catch (e) {
    await msg.reply(`❌ Error: ${e.message}`);
  }
});

bot.command('skip', 'Skip the current track', async (msg) => {
  if (!(await canRunCommand(msg, 'skip'))) return msg.reply('You do not have permission to use this command.');
  const queue = queues.get(msg.server_id);
  if (!queue) return msg.reply('❌ Nothing is playing.');
  
  if (queue.skip()) await msg.reply('⏭️ Skipped.');
  else await msg.reply('❌ Nothing to skip.');
});

bot.command('light', 'Propose an idea for the bot', async (msg) => {
  if (!(await canRunCommand(msg, 'light'))) return msg.reply('You do not have permission to use this command.');

  // Commande !light list
  if (msg.argv[0]?.toLowerCase() === 'list') {
    const lights = db.prepare('SELECT * FROM lights ORDER BY id DESC LIMIT 10').all();
    if (!lights.length) return msg.reply('💡 No ideas yet.');
    const embed = new Embed().title('💡 Latest Ideas').color('#ff5500');
    lights.forEach(l => embed.field(`#${l.id} by ${l.username}`, l.content));
    return msg.reply('', { embeds: [embed] });
  }

  const idea = msg.args?.trim();
  if (!idea || idea.length < 5) return msg.reply('❌ Your idea is too short (min 5 chars).');

  db.prepare('INSERT INTO lights (user_id, username, content, created_at) VALUES (?, ?, ?, ?)')
    .run(msg.author_id, msg.author?.username || 'Unknown', idea, new Date().toISOString());
  
  const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
  await msg.reply(`✅ Idea **#${id}** saved!`);
});

bot.command('status', 'Show bot status', async (msg) => {
  if (!(await canRunCommand(msg, 'status'))) return msg.reply('You do not have permission to use this command.');
  
  const mem = process.memoryUsage().rss / 1024 / 1024;
  const queue = queues.get(msg.server_id);
  
  const embed = new Embed()
    .title('📊 Bot Status')
    .color('#00AE86')
    .field('Memory', `${mem.toFixed(0)} MB`, true)
    .field('Active Voice Queues', `${queues.size}`, true)
    .field('Queue in this server', queue ? `${queue.tracks.length} tracks` : 'Idle', true);
    
  await msg.reply('', { embeds: [embed] });
});

// ... (Je garde les commandes de base : help, rules, welcome, setup, etc. du code précédent) ...

// ---------- DEMARRAGE ----------
bot.on('ready', () => console.log('✅ Music & Community Bot is online.'));
bot.on('error', (e) => console.error('[Error]', e?.message || e));
bot.start();
