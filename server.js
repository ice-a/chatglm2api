'use strict';
/*
 * chatglm-panel —— 智谱清言(chatglm.cn) 多账号池面板 + OpenAI 兼容网关
 *
 * 特点：
 *   - 零依赖：只用 Node 内置模块（http / fs / crypto / child_process）。
 *   - 单文件后端，可打包成独立 exe（Node 24 SEA），也可通过 Docker 容器化部署。
 *   - 多账号池：round_robin 轮询 / least_used 最少使用 / failover 顺序故障转移；
 *     连接异常、401/403/429、5xx 自动换号重试。
 *   - 自动续期：定时检查各账号 JWT，过期前用 refresh_token 续期。
 *   - 自动签到：每日定时批量调用 chatglm 签到接口，启动时补签当天。
 *   - 用量统计：每账号请求数/失败数/最近调用/积分余额/积分明细。
 *   - OAuth2 授权码：/oauth/authorize（登录回调）→ /oauth/token → /oauth/userinfo，
 *     供外部客户端做第三方登录。
 *   - OpenAI 兼容：/v1/models、/v1/chat/completions（流式 & 非流式）。
 *
 * 安全：账号 token 只落盘在本地 data/ 目录，面板接口只回传掩码，永不回传明文。
 *       （网关 API Key 属于用户主动要在设置里查看/复制的凭据，按需明文显示。）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let SEA = null;
try { SEA = require('node:sea'); } catch (_) { /* 非 SEA 环境 */ }
const IS_SEA = !!(SEA && SEA.isSea && SEA.isSea());

// 轻量 .env 支持（零依赖，仅用内置模块）；已存在的 process.env 不被覆盖
function loadDotEnv() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch (_) {
    return;
  }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : path.join(ROOT, 'data');
loadDotEnv();
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ACCOUNTS_PATH = path.join(DATA_DIR, 'accounts.json');
const LOG_PATH = path.join(DATA_DIR, 'requests.log');

const BASE = 'https://chatglm.cn';
const STREAM_URL = BASE + '/chatglm/backend-api/assistant/stream';
const REFRESH_URL = BASE + '/chatglm/user-api/user/refresh';
const USER_INFO_URL = BASE + '/chatglm/user-api/user/info';
const CHECKIN_URL = BASE + '/chatglm/member-api/member/daily_login_score';
const SCORE_RECORD_URL = BASE + '/chatglm/member-api/member/score_record';

// x-sign 盐（逆向自 main.*.js 模块 86129 的 o0()）
const SIGN_SALT = '8a1317a7468aa3ad86e997d08f3f31cb';
const DEFAULT_ASSISTANT = '65940acff94777010aa6b796';
const DEFAULT_DEVICE = '944d27bb345e4229a24928072837dac1';
const DEFAULT_EXP_GROUPS =
  'na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,' +
  'na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,' +
  'desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,' +
  'app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,' +
  'chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,' +
  'assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,mainchat_moe:exp:300,' +
  'assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,' +
  'assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

const MODELS = [
  { id: 'glm-5.3', object: 'model', created: 0, owned_by: 'zhipu' },
  { id: 'glm-5.3-flash', object: 'model', created: 0, owned_by: 'zhipu' },
];

/* ----------------------------------------------------------------------- */
/* 通用工具                                                                 */
/* ----------------------------------------------------------------------- */

const sysLogs = []; // 系统日志（内存，上限 500 条）
function log(...a) {
  const line = '[' + new Date().toISOString() + '] ' + a.map(String).join(' ');
  console.log(line);
  sysLogs.unshift(line);
  if (sysLogs.length > 500) sysLogs.length = 500;
}

function uuid32() {
  return crypto.randomUUID().replace(/-/g, '');
}

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function nowSec() { return Math.floor(Date.now() / 1000); }

// 掩码：只显示首尾各 4 位 + 长度
function mask(s) {
  s = String(s || '');
  if (!s) return '';
  if (s.length <= 12) return '****(len=' + s.length + ')';
  return s.slice(0, 4) + '****' + s.slice(-4) + '(len=' + s.length + ')';
}

function randomKey(bytes) {
  return crypto.randomBytes(bytes || 24).toString('hex');
}

/* ----------------------------------------------------------------------- */
/* 配置与账号存储                                                           */
/* ----------------------------------------------------------------------- */

const CONFIG_TEMPLATE = {
  port: 8788,
  host: '127.0.0.1',
  api_key: '',
  default_model: 'glm-5.3-flash',
  assistant_id: DEFAULT_ASSISTANT,
  rotation: 'round_robin',      // round_robin | least_used | failover
  max_failover: 3,              // 单请求最大换号次数
  checkin_enabled: true,
  checkin_time: '08:05',        // 每日签到时间（本地时区 HH:MM）
  refresh_enabled: true,        // 自动续期
  oauth_clients: [],            // [{client_id, client_secret, name, redirect_uris:[]}]
};

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}

function readJSON(p, fallback) {
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function loadConfig() {
  ensureDir(DATA_DIR);
  let c = readJSON(CONFIG_PATH, null);
  if (!c) {
    c = JSON.parse(JSON.stringify(CONFIG_TEMPLATE));
    if (!c.api_key) c.api_key = 'sk-' + randomKey(16);
    writeJSON(CONFIG_PATH, c);
    log('[config] 已生成默认配置：' + CONFIG_PATH);
  }
  // 归一化
  const out = Object.assign({}, CONFIG_TEMPLATE, c);
  out.port = Number(out.port) || 8788;
  out.host = String(out.host || '127.0.0.1');
  out.api_key = String(out.api_key || '');
  out.rotation = ['round_robin', 'least_used', 'failover'].includes(out.rotation)
    ? out.rotation : 'round_robin';
  out.max_failover = Math.max(1, Math.min(10, Number(out.max_failover) || 3));
  out.checkin_enabled = out.checkin_enabled !== false;
  out.checkin_time = /^\d{1,2}:\d{2}$/.test(out.checkin_time) ? out.checkin_time : '08:05';
  out.refresh_enabled = out.refresh_enabled !== false;
  out.oauth_clients = Array.isArray(out.oauth_clients) ? out.oauth_clients : [];
  if (!out.api_key) { out.api_key = 'sk-' + randomKey(16); }
  if (process.env.API_KEY) out.api_key = String(process.env.API_KEY);
  return out;
}

let cfg = loadConfig();

function saveConfig() {
  writeJSON(CONFIG_PATH, cfg);
}

function loadAccounts() {
  const db = readJSON(ACCOUNTS_PATH, null);
  if (!db || !Array.isArray(db.accounts)) return { accounts: [] };
  for (const a of db.accounts) {
    a.stats = Object.assign(
      { requests: 0, errors: 0, last_used: 0, last_checkin: 0, last_refresh: 0, last_error: '' },
      a.stats || {}
    );
    a.enabled = a.enabled !== false;
  }
  return db;
}

let db = loadAccounts();

function saveAccounts() {
  writeJSON(ACCOUNTS_PATH, db);
}

function findAccount(id) {
  return db.accounts.find((a) => a.id === id);
}

// 账号对外表示（token 掩码）
function publicAccount(a) {
  return {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    token_masked: mask(a.token),
    has_refresh: !!a.refresh_token,
    refresh_masked: a.refresh_token ? mask(a.refresh_token) : '',
    device_id: a.device_id || '',
    assistant_id: a.assistant_id || DEFAULT_ASSISTANT,
    token_exp: a.token ? jwtExp(a.token) : 0,
    token_valid: a.token ? jwtExp(a.token) > Date.now() : false,
    score: a.score || '',
    nickname: a.nickname || '',
    phone: a.phone || '',
    stats: {
      requests: a.stats.requests,
      errors: a.stats.errors,
      last_used: a.stats.last_used,
      last_checkin: a.stats.last_checkin,
      last_refresh: a.stats.last_refresh,
      last_error: a.stats.last_error || '',
    },
  };
}

/* ----------------------------------------------------------------------- */
/* 签名与请求头                                                             */
/* ----------------------------------------------------------------------- */

// 逆向自 o0()：13 位时间戳倒数第 2 位是校验位 = 其余位数字之和 mod 10
function makeSign() {
  const raw = String(Date.now());
  const L = raw.length;
  let sum = 0;
  for (let i = 0; i < L; i++) sum += raw.charCodeAt(i) - 48;
  sum -= raw.charCodeAt(L - 2) - 48;
  const timestamp = raw.slice(0, L - 2) + (sum % 10) + raw.slice(L - 1);
  const nonce = uuid32();
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SALT}`);
  return { timestamp, nonce, sign };
}

function baseHeaders(acc, token) {
  const s = makeSign();
  const h = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
    'app-name': 'chatglm',
    'user-agent': UA,
    'x-app-fr': 'default',
    'x-app-platform': 'pc',
    'x-app-version': '0.0.1',
    'x-device-id': (acc && acc.device_id) || DEFAULT_DEVICE,
    'x-exp-groups': DEFAULT_EXP_GROUPS,
    'x-lang': 'zh',
    'x-timestamp': s.timestamp,
    'x-nonce': s.nonce,
    'x-sign': s.sign,
    'x-request-id': uuid32(),
  };
  if (token) h.authorization = 'Bearer ' + token;
  return h;
}

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return (payload.exp || 0) * 1000;
  } catch (_) {
    return 0;
  }
}

/* ----------------------------------------------------------------------- */
/* token 续期                                                               */
/* ----------------------------------------------------------------------- */

async function refreshAccount(acc) {
  if (!acc.refresh_token) return { ok: false, reason: '无 refresh_token' };
  try {
    const headers = Object.assign(baseHeaders(acc, acc.refresh_token), {
      origin: BASE,
      referer: BASE + '/',
      'content-type': 'application/json;charset=UTF-8',
    });
    const r = await fetch(REFRESH_URL, { method: 'POST', headers, body: '{}' });
    const txt = await r.text();
    let j = {};
    try { j = JSON.parse(txt); } catch (_) {}
    const result = j.result || j.data || {};
    const nt = result.access_token || result.token || result.accessToken;
    if (nt && typeof nt === 'string') {
      acc.token = nt;
      const nr = result.refresh_token || result.refreshToken;
      if (nr) acc.refresh_token = nr;
      acc.stats.last_refresh = Date.now();
      saveAccounts();
      return { ok: true };
    }
    return { ok: false, reason: (j.message || txt.slice(0, 200)) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function ensureAccountToken(acc) {
  if (!acc.refresh_token) return false;
  const exp = jwtExp(acc.token);
  if (exp && exp - Date.now() > 5 * 60 * 1000) return false;
  const r = await refreshAccount(acc);
  if (r.ok) log(`[refresh] ${acc.name} access_token 已续期`);
  else log(`[refresh] ${acc.name} 续期失败：${r.reason}`);
  return r.ok;
}

/* ----------------------------------------------------------------------- */
/* 账号池选择与故障转移                                                     */
/* ----------------------------------------------------------------------- */

let rrCursor = 0;

function usableAccounts() {
  const now = Date.now();
  return db.accounts.filter((a) => a.enabled && a.token && !(a.cooldown_until > now));
}

function pickAccount(exclude) {
  const pool = usableAccounts().filter((a) => !exclude.includes(a.id));
  if (!pool.length) return null;
  if (cfg.rotation === 'failover') return pool[0];
  if (cfg.rotation === 'least_used') {
    return pool.slice().sort((x, y) => (x.stats.requests || 0) - (y.stats.requests || 0))[0];
  }
  // round_robin
  const pick = pool[rrCursor % pool.length];
  rrCursor = (rrCursor + 1) % 100000;
  return pick;
}

function markCooldown(acc, ms) {
  acc.cooldown_until = Date.now() + (ms || 60 * 1000);
}

/* ----------------------------------------------------------------------- */
/* 上游对话                                                                 */
/* ----------------------------------------------------------------------- */

async function upstreamStream(acc, prompt, opts) {
  const payload = {
    assistant_id: (acc && acc.assistant_id) || cfg.assistant_id || DEFAULT_ASSISTANT,
    conversation_id: opts.conversation_id || '',
    project_id: '',
    chat_type: 'userChat',
    meta_data: {
      platform: 'pc',
      chat_mode: '',
      is_test: false,
      input_question_type: '',
      channel: '',
      reasoning_effort: opts.reasoning_effort || '',
      is_networking: false,
    },
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  const headers = Object.assign(baseHeaders(acc, acc.token), {
    'content-type': 'application/json;charset=UTF-8',
    origin: BASE,
    referer: BASE + '/',
  });
  return fetch(STREAM_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
}

function eventText(ev) {
  if (!ev || !Array.isArray(ev.parts)) return '';
  let s = '';
  for (const p of ev.parts) {
    if (Array.isArray(p && p.content)) {
      for (const c of p.content) {
        if (c && c.type === 'text' && typeof c.text === 'string') s += c.text;
      }
    }
  }
  return s;
}

async function pumpSSE(res, onDelta, onMeta) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let acc = '';
  let conversationId = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch (_) { continue; }
      if (!conversationId && ev.conversation_id) {
        conversationId = ev.conversation_id;
        if (onMeta) onMeta({ conversationId });
      }
      const t = eventText(ev);
      if (!t) continue;
      let delta;
      if (t.startsWith(acc)) { delta = t.slice(acc.length); acc = t; }
      else { delta = t; acc += t; }
      if (delta) onDelta(delta);
    }
  }
  return { text: acc, conversationId };
}

/* ----------------------------------------------------------------------- */
/* messages → 单条 prompt（chatglm stream 只吃最后一条 user + content 数组） */
/* ----------------------------------------------------------------------- */

function textOf(m) {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    let s = '';
    for (const p of c) {
      if (p && typeof p.text === 'string') s += p.text;
      else if (typeof p === 'string') s += p;
    }
    return s;
  }
  return '';
}

function buildPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sys = list.filter((m) => m && m.role === 'system').map(textOf).filter(Boolean).join('\n\n');
  const turns = list.filter((m) => m && m.role !== 'system');
  if (!turns.length) return sys;
  const last = turns[turns.length - 1];
  const prior = turns.slice(0, -1);
  let p = '';
  if (sys) p += sys + '\n\n';
  if (prior.length) {
    p += '以下是此前的对话记录：\n';
    for (const m of prior) {
      const who = m.role === 'user' ? '用户' : '助手';
      p += `${who}：${textOf(m)}\n`;
    }
    p += '\n请基于以上对话继续回答用户的最新问题。\n\n';
  }
  p += textOf(last);
  return p;
}

/* ----------------------------------------------------------------------- */
/* 请求日志（用量统计）                                                     */
/* ----------------------------------------------------------------------- */

const recentLog = [];

function recordRequest(entry) {
  if (entry && entry.account && db && db.accounts) {
    const acc = db.accounts.find((a) => a.name === entry.account);
    if (acc) entry.account_id = acc.id;
  }
  entry.time = Date.now();
  recentLog.unshift(entry);
  if (recentLog.length > 300) recentLog.length = 300;
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
}

/* ----------------------------------------------------------------------- */
/* 签到                                                                     */
/* ----------------------------------------------------------------------- */

async function checkinAccount(acc) {
  try {
    const headers = Object.assign(baseHeaders(acc, acc.token), {
      'content-type': 'application/json;charset=UTF-8',
      origin: BASE,
      referer: BASE + '/',
    });
    const r = await fetch(CHECKIN_URL, { method: 'POST', headers, body: '{}' });
    const txt = await r.text();
    let j = {};
    try { j = JSON.parse(txt); } catch (_) {}
    const st = j.status;
    let state, msg;
    if (st === 0) { state = 'ok'; msg = j.result && j.result.score ? ('+' + j.result.score) : '签到成功'; }
    else if (st === 10001) { state = 'already'; msg = '今日已领取'; }
    else { state = 'fail'; msg = j.message || ('HTTP ' + r.status); }
    acc.stats.last_checkin = Date.now();
    acc.stats.last_checkin_state = state;
    acc.stats.last_checkin_msg = msg;
    // 顺带刷新积分余额
    await refreshAccountInfo(acc).catch(() => {});
    saveAccounts();
    return { state, msg };
  } catch (e) {
    acc.stats.last_checkin_state = 'error';
    acc.stats.last_checkin_msg = e.message;
    saveAccounts();
    return { state: 'error', msg: e.message };
  }
}

async function checkinAll() {
  const list = db.accounts.filter((a) => a.enabled && a.token);
  const results = [];
  for (const a of list) {
    const r = await checkinAccount(a);
    results.push({ id: a.id, name: a.name, state: r.state, msg: r.msg });
    log(`[checkin] ${a.name} -> ${r.state} ${r.msg}`);
    await new Promise((res) => setTimeout(res, 800));
  }
  return results;
}

/* ----------------------------------------------------------------------- */
/* 账号信息 / 用量                                                          */
/* ----------------------------------------------------------------------- */

async function refreshAccountInfo(acc) {
  const r = await fetch(USER_INFO_URL, { headers: baseHeaders(acc, acc.token) });
  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (_) {}
  if (j.status === 0 && j.result) {
    const mi = j.result.member_info || {};
    acc.score = mi.left_score || acc.score || '';
    acc.nickname = j.result.nickname || acc.nickname || '';
    acc.phone = j.result.phone || acc.phone || '';
    saveAccounts();
    return j.result;
  }
  return null;
}

async function fetchScoreRecord(acc, pageSize) {
  const url = SCORE_RECORD_URL + `?page=1&page_size=${pageSize || 20}`;
  const r = await fetch(url, { headers: baseHeaders(acc, acc.token) });
  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (_) {}
  if (j.status === 0 && j.result) return j.result.list || [];
  return [];
}

/* ----------------------------------------------------------------------- */
/* OAuth2 授权码流程（内存态）                                              */
/* ----------------------------------------------------------------------- */

const authCodes = new Map();
const loginSessions = new Map(); // 手机号登录会话：id -> {state,rid}   // code -> {account_id, client_id, redirect_uri, exp, scope}
const accessTokens = new Map(); // token -> {account_id, client_id, exp, scope}
const CODE_TTL = 5 * 60 * 1000;
const TOKEN_TTL = 24 * 60 * 60 * 1000;

function gcOauth() {
  const now = Date.now();
  for (const [k, v] of authCodes) if (v.exp < now) authCodes.delete(k);
  for (const [k, v] of accessTokens) if (v.exp < now) accessTokens.delete(k);
}
setInterval(gcOauth, 60 * 1000);

function findClient(client_id) {
  return (cfg.oauth_clients || []).find((c) => c.client_id === client_id);
}

/* ----------------------------------------------------------------------- */
/* HTTP 工具                                                                */
/* ----------------------------------------------------------------------- */

function sendJSON(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'content-type': 'application/json;charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  }, extra || {}));
  res.end(body);
}

function sendText(res, code, body, ctype) {
  res.writeHead(code, {
    'content-type': ctype || 'text/html;charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function sendError(res, code, message, type) {
  sendJSON(res, code, {
    error: { message, type: type || 'invalid_request_error', code: null, param: null },
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 20 * 1024 * 1024)) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function parseForm(s) {
  const o = {};
  for (const kv of String(s || '').split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
    const v = decodeURIComponent(i < 0 ? '' : kv.slice(i + 1).replace(/\+/g, ' '));
    o[k] = v;
  }
  return o;
}

function checkGatewayAuth(req) {
  if (!cfg.api_key) return true;
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return !!m && m[1] === cfg.api_key;
}

/* ----------------------------------------------------------------------- */
/* 面板静态资源                                                             */
/* ----------------------------------------------------------------------- */

function asset(name) {
  if (IS_SEA) {
    try { return SEA.getAsset(name, 'utf8'); } catch (_) { return null; }
  }
  try { return fs.readFileSync(path.join(ROOT, 'public', name), 'utf8'); } catch (_) { return null; }
}

/* ----------------------------------------------------------------------- */
/* 路由                                                                     */
/* ----------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': '*',
    });
    return res.end();
  }

  try {
    // ---- 静态面板 ----
    if (p === '/' || p === '/index.html') {
      const html = asset('index.html');
      if (html == null) return sendText(res, 500, '面板资源缺失（public/index.html）');
      return sendText(res, 200, html, 'text/html;charset=utf-8');
    }

    // ---- 健康检查 ----
    if (p === '/health') {
      return sendJSON(res, 200, {
        status: 'ok',
        accounts: db.accounts.length,
        enabled: db.accounts.filter((a) => a.enabled).length,
        version: '1.0.0',
      });
    }

    // ---- 面板 API ----
    if (p.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    // ---- OAuth2 ----
    if (p.startsWith('/oauth/') || p === '/.well-known/oauth-authorization-server') {
      return await handleOAuth(req, res, url);
    }

    // ---- OpenAI 网关 ----
    if (p.startsWith('/v1/')) {
      if (!checkGatewayAuth(req)) {
        return sendError(res, 401, '无效的 API key（Authorization: Bearer <api_key>）', 'authentication_error');
      }
      if (p === '/v1/models' && req.method === 'GET') {
        return sendJSON(res, 200, { object: 'list', data: MODELS });
      }
      if (p === '/v1/chat/completions' && req.method === 'POST') {
        return await handleCompletions(req, res);
      }
      return sendError(res, 404, '未找到 ' + p);
    }

    return sendError(res, 404, '未找到 ' + p);
  } catch (e) {
    log('处理失败：' + (e && e.stack ? e.stack : e));
    if (!res.headersSent) return sendError(res, 500, String(e && e.message ? e.message : e));
    try { res.end(); } catch (_) {}
  }
});

/* ---- 面板 API 实现 ---- */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/state' && method === 'GET') {
    return sendJSON(res, 200, {
      config: {
        port: cfg.port,
        host: cfg.host,
        rotation: cfg.rotation,
        max_failover: cfg.max_failover,
        checkin_enabled: cfg.checkin_enabled,
        checkin_time: cfg.checkin_time,
        refresh_enabled: cfg.refresh_enabled,
        default_model: cfg.default_model,
        assistant_id: cfg.assistant_id,
        has_api_key: !!cfg.api_key,
        api_key_masked: mask(cfg.api_key),
        oauth_clients: (cfg.oauth_clients || []).map((c) => ({
          client_id: c.client_id,
          name: c.name,
          redirect_uris: c.redirect_uris || [],
          client_secret_masked: mask(c.client_secret),
        })),
      },
      accounts: db.accounts.map(publicAccount),
      models: MODELS,
      recent: recentLog.slice(0, 50),
      totals: {
        requests: db.accounts.reduce((s, a) => s + (a.stats.requests || 0), 0),
        errors: db.accounts.reduce((s, a) => s + (a.stats.errors || 0), 0),
        checkins_today: db.accounts.filter((a) => a.stats.last_checkin &&
          new Date(a.stats.last_checkin).toDateString() === new Date().toDateString()).length,
      },
      base_urls: {
        gateway: `http://127.0.0.1:${cfg.port}/v1`,
      },
    });
  }

  // 完整 API Key（仅本地面板主动查询时返回）
  if (p === '/api/config/api-key' && method === 'GET') {
    return sendJSON(res, 200, { api_key: cfg.api_key });
  }
  if (p === '/api/config/api-key' && method === 'POST') {
    cfg.api_key = 'sk-' + randomKey(16);
    saveConfig();
    return sendJSON(res, 200, { api_key: cfg.api_key });
  }

  // 系统日志与请求日志
  if (p === '/api/logs' && method === 'GET') {
    return sendJSON(res, 200, { sys: sysLogs.slice(0, 200), requests: recentLog.slice(0, 300) });
  }

  // 更新配置
  if (p === '/api/config' && method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (body.rotation && ['round_robin', 'least_used', 'failover'].includes(body.rotation)) cfg.rotation = body.rotation;
    if (body.max_failover != null) cfg.max_failover = Math.max(1, Math.min(10, Number(body.max_failover) || 3));
    if (body.checkin_enabled != null) cfg.checkin_enabled = !!body.checkin_enabled;
    if (body.checkin_time && /^\d{1,2}:\d{2}$/.test(body.checkin_time)) cfg.checkin_time = body.checkin_time;
    if (body.refresh_enabled != null) cfg.refresh_enabled = !!body.refresh_enabled;
    if (body.default_model) cfg.default_model = String(body.default_model);
    if (body.assistant_id) cfg.assistant_id = String(body.assistant_id);
    if (body.port != null) cfg.port = Number(body.port) || cfg.port;
    saveConfig();
    return sendJSON(res, 200, { ok: true, note: '端口变更需重启服务生效', config: { port: cfg.port } });
  }

  // 账号列表 / 新增
  if (p === '/api/accounts' && method === 'GET') {
    return sendJSON(res, 200, { accounts: db.accounts.map(publicAccount) });
  }
  if (p === '/api/accounts' && method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const token = String(body.token || '').trim();
    if (!token) return sendError(res, 400, 'token 不能为空');
    const acc = {
      id: uuid32().slice(0, 16),
      name: String(body.name || '').trim() || ('账号-' + (db.accounts.length + 1)),
      token,
      refresh_token: String(body.refresh_token || '').trim(),
      device_id: String(body.device_id || DEFAULT_DEVICE).trim(),
      assistant_id: String(body.assistant_id || cfg.assistant_id || DEFAULT_ASSISTANT).trim(),
      enabled: body.enabled !== false,
      created_at: Date.now(),
      stats: { requests: 0, errors: 0, last_used: 0, last_checkin: 0, last_refresh: 0, last_error: '' },
    };
    db.accounts.push(acc);
    saveAccounts();
    await refreshAccountInfo(acc).catch(() => {});
    return sendJSON(res, 200, { ok: true, account: publicAccount(acc) });
  }

  // 单账号操作：/api/accounts/:id[/action]
  const m = /^\/api\/accounts\/([^/]+)(?:\/(\w[\w-]*))?$/.exec(p);
  if (m) {
    const acc = findAccount(m[1]);
    if (!acc) return sendError(res, 404, '账号不存在');
    const action = m[2];
    if (!action && method === 'DELETE') {
      db.accounts = db.accounts.filter((a) => a.id !== acc.id);
      saveAccounts();
      return sendJSON(res, 200, { ok: true });
    }
    if (!action && method === 'PUT') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.name != null) acc.name = String(body.name).trim() || acc.name;
      if (body.token) acc.token = String(body.token).trim();
      if (body.refresh_token != null) acc.refresh_token = String(body.refresh_token).trim();
      if (body.device_id) acc.device_id = String(body.device_id).trim();
      if (body.assistant_id) acc.assistant_id = String(body.assistant_id).trim();
      if (body.enabled != null) acc.enabled = !!body.enabled;
      saveAccounts();
      return sendJSON(res, 200, { ok: true, account: publicAccount(acc) });
    }
    if (action === 'toggle' && method === 'POST') {
      acc.enabled = !acc.enabled;
      saveAccounts();
      return sendJSON(res, 200, { ok: true, enabled: acc.enabled });
    }
    if (action === 'test' && method === 'POST') {
      const info = await refreshAccountInfo(acc).catch(() => null);
      if (info) {
        return sendJSON(res, 200, { ok: true, nickname: info.nickname, phone: info.phone,
          score: (info.member_info || {}).left_score, token_valid: jwtExp(acc.token) > Date.now() });
      }
      return sendJSON(res, 200, { ok: false, message: '信息获取失败（token 可能已失效）' });
    }
    if (action === 'checkin' && method === 'POST') {
      const r = await checkinAccount(acc);
      return sendJSON(res, 200, Object.assign({ ok: r.state === 'ok' || r.state === 'already' }, r));
    }
    if (action === 'refresh' && method === 'POST') {
      const r = await refreshAccount(acc);
      return sendJSON(res, 200, r);
    }
    if (action === 'usage' && method === 'POST') {
      const list = await fetchScoreRecord(acc, 20).catch(() => []);
      const info = await refreshAccountInfo(acc).catch(() => null);
      return sendJSON(res, 200, {
        ok: true,
        score: (info && info.member_info && info.member_info.left_score) || acc.score || '',
        score_rule: (info && info.member_info && info.member_info.score_rule) || '',
        records: list,
        stats: acc.stats,
      });
    }
    return sendError(res, 404, '未知操作');
  }

  if (p === '/api/checkin-all' && method === 'POST') {
    const results = await checkinAll();
    return sendJSON(res, 200, { ok: true, results });
  }

  if (p === '/api/refresh-all' && method === 'POST') {
    const results = [];
    for (const a of db.accounts.filter((x) => x.enabled && x.refresh_token)) {
      const r = await refreshAccount(a);
      results.push({ id: a.id, name: a.name, ok: r.ok, reason: r.reason || '' });
    }
    return sendJSON(res, 200, { ok: true, results });
  }

  // OAuth 客户端管理
  if (p === '/api/oauth/clients' && method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const client = {
      client_id: 'cid-' + randomKey(8),
      client_secret: 'csec-' + randomKey(16),
      name: String(body.name || 'OAuth 客户端'),
      redirect_uris: String(body.redirect_uris || '').split(/[\s,]+/).filter(Boolean),
    };
    cfg.oauth_clients.push(client);
    saveConfig();
    return sendJSON(res, 200, { ok: true, client }); // 新建时回传完整 secret 一次
  }
  const cm = /^\/api\/oauth\/clients\/([^/]+)$/.exec(p);
  if (cm && method === 'DELETE') {
    cfg.oauth_clients = cfg.oauth_clients.filter((c) => c.client_id !== cm[1]);
    saveConfig();
    return sendJSON(res, 200, { ok: true });
  }


  /* ---- 手机号登录（数美滑块由前端内嵌页面承载） ---- */
  if (p === '/api/login/captcha-page' && method === 'GET') {
    // 本地承载页：加载数美官方 SDK，滑块通过后把 rid 报给面板
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>人机验证</title>
<style>body{font-family:system-ui,sans-serif;background:#16181d;color:#e8eaed;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:92vh;margin:0}
h3{font-weight:600;margin:0 0 4px}.tip{color:#9aa0a6;font-size:13px;margin-bottom:18px}#box{width:300px;min-height:200px;background:#1f2229;border-radius:12px;padding:16px;box-sizing:border-box}
#done{margin-top:14px;color:#7ee787;font-size:14px;display:none}.err{color:#ff7b72;font-size:13px;margin-top:10px}</style></head><body>
<h3>拖动滑块完成验证</h3><div class="tip">通过后本窗口会自动关闭并通知面板</div>
<div id="box"><div id="shumei_form_captcha_wrapper">验证组件加载中…</div></div>
<div id="done">✓ 验证通过，正在通知面板…</div><div id="err" class="err"></div>
<script src="https://chatglm.cn/smcp/smcp.min.js"><\/script>
<script>
(function(){
  var ORG='599zinRadlRxTLrOkTR9';
  function report(rid){
    document.getElementById('done').style.display='block';
    fetch('/api/login/slider-result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rid:rid})})
      .then(function(){setTimeout(function(){window.close()},400)})
      .catch(function(e){document.getElementById('err').textContent='通知面板失败：'+e});
  }
  function boot(fn){
    if(typeof window.initSMCaptcha==='function')return fn();
    var t=setInterval(function(){if(typeof window.initSMCaptcha==='function'){clearInterval(t);fn()}},200);
    setTimeout(function(){clearInterval(t);document.getElementById('err').textContent='SDK 加载超时，请刷新重试'},8000);
  }
  boot(function(){
    window.initSMCaptcha({organization:ORG,appendTo:'shumei_form_captcha_wrapper',product:'embed',width:'100%',hideRefreshOnImage:false,lang:'zh-CN'},
      function(captcha){
        captcha.onSuccess(function(r){ if(r&&r.pass) report(r.rid); });
        captcha.onReady(function(){});
      });
  });
})();
<\/script></body></html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(page);
  }
  if (p === '/api/login/slider-result' && method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const rid = String(body.rid || '').trim();
    if (!rid) return sendError(res, 400, '缺少 rid');
    loginSessions.forEach((s) => { if (s.state === 'wait_slider') { s.rid = rid; s.state = 'wait_code'; s.updated_at = Date.now(); } });
    return sendJSON(res, 200, { ok: true });
  }
  if (p === '/api/login/state' && method === 'GET') {
    const sess = loginSessions.get(String(url.searchParams.get('session') || ''));
    if (!sess) return sendJSON(res, 200, { ready: false, expired: true });
    return sendJSON(res, 200, { ready: sess.state === 'wait_code', state: sess.state });
  }
  if (p === '/api/login/start' && method === 'POST') {
    // 创建一次登录会话（前端打开 /api/login/captcha-page 前先调用）
    const sess = { id: uuid32().slice(0, 12), state: 'wait_slider', rid: '', created_at: Date.now() };
    loginSessions.set(sess.id, sess);
    return sendJSON(res, 200, { ok: true, session: sess.id, captcha_url: 'http://127.0.0.1:' + cfg.port + '/api/login/captcha-page?sess=' + sess.id });
  }
  if (p === '/api/login/send-code' && method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const phone = String(body.phone || '').replace(/\D/g, '');
    if (!/^1\d{10}$/.test(phone)) return sendError(res, 400, '手机号格式不正确');
    const sess = loginSessions.get(String(body.session || ''));
    if (!sess) return sendError(res, 400, '登录会话不存在或已过期，请重新开始');
    if (!sess.rid) return sendError(res, 400, '滑块尚未通过，请先完成滑块验证');
    const headers = Object.assign(baseHeaders(null, ''), {
      origin: BASE, referer: BASE + '/', 'content-type': 'application/json;charset=UTF-8',
    });
    const r = await fetch(BASE + '/chatglm/user-api/user/login_captcha', {
      method: 'POST', headers,
      body: JSON.stringify({ phone, pic_captcha_id: sess.rid, phone_code: '+86', distinct_id: '', tm: 'pc', fr: 'default' }),
    });
    const txt = await r.text();
    let j = {}; try { j = JSON.parse(txt); } catch (_) {}
    if (j.status === 0) return sendJSON(res, 200, { ok: true, message: j.message || '验证码已发送' });
    if (j.status === 1) return sendJSON(res, 200, { ok: false, message: j.message || '发送失败', field: 'phone' });
    return sendJSON(res, r.status === 200 ? 200 : r.status, { ok: false, message: j.message || ('HTTP ' + r.status) });
  }
  if (p === '/api/login/verify' && method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const phone = String(body.phone || '').replace(/\D/g, '');
    const code = String(body.code || '').replace(/\D/g, '');
    if (!/^1\d{10}$/.test(phone) || !code) return sendError(res, 400, '手机号或验证码格式不正确');
    const sess = loginSessions.get(String(body.session || ''));
    if (!sess || !sess.rid) return sendError(res, 400, '登录会话无效，请重新开始');
    const headers = Object.assign(baseHeaders(null, ''), {
      origin: BASE, referer: BASE + '/', 'content-type': 'application/json;charset=UTF-8',
    });
    const r = await fetch(BASE + '/chatglm/user-api/user/phone_login', {
      method: 'POST', headers,
      body: JSON.stringify({ phone, captcha: code, pic_captcha_id: sess.rid, phone_code: '+86', tm: 'pc', fr: 'default', sensors_id: '' }),
    });
    const txt = await r.text();
    let j = {}; try { j = JSON.parse(txt); } catch (_) {}
    const result = j.result || j.data || {};
    const token = result.access_token || result.token;
    if (!token) {
      loginSessions.delete(sess.id);
      return sendJSON(res, 200, { ok: false, message: j.message || ('登录失败 HTTP ' + r.status) });
    }
    loginSessions.delete(sess.id);
    const acc = {
      id: uuid32().slice(0, 16),
      name: '手机号-' + phone.slice(-4),
      token,
      refresh_token: String(result.refresh_token || '').trim(),
      device_id: DEFAULT_DEVICE,
      assistant_id: cfg.assistant_id || DEFAULT_ASSISTANT,
      enabled: true,
      created_at: Date.now(),
      stats: { requests: 0, errors: 0, last_used: 0, last_checkin: 0, last_refresh: 0, last_error: '' },
    };
    db.accounts.push(acc);
    saveAccounts();
    await refreshAccountInfo(acc).catch(() => {});
    return sendJSON(res, 200, { ok: true, account: publicAccount(acc) });
  }

  return sendError(res, 404, '未找到 ' + p);
}

/* ---- OAuth2 实现 ---- */

async function handleOAuth(req, res, url) {
  const p = url.pathname;

  if (p === '/.well-known/oauth-authorization-server') {
    const b = `http://127.0.0.1:${cfg.port}`;
    return sendJSON(res, 200, {
      issuer: b,
      authorization_endpoint: b + '/oauth/authorize',
      token_endpoint: b + '/oauth/token',
      userinfo_endpoint: b + '/oauth/userinfo',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      scopes_supported: ['profile', 'chat'],
    });
  }

  // 授权端点：GET 展示同意页，POST 提交选择账号
  if (p === '/oauth/authorize') {
    const q = url.searchParams;
    const client_id = q.get('client_id') || '';
    const redirect_uri = q.get('redirect_uri') || '';
    const state = q.get('state') || '';
    const response_type = q.get('response_type') || 'code';
    const client = findClient(client_id);
    if (!client) return sendText(res, 400, oauthErrorPage('未知的 client_id：' + client_id));
    if (!client.redirect_uris.includes(redirect_uri)) {
      return sendText(res, 400, oauthErrorPage('redirect_uri 未在该客户端登记：' + redirect_uri));
    }
    if (response_type !== 'code') return sendText(res, 400, oauthErrorPage('仅支持 response_type=code'));

    if (req.method === 'GET') {
      return sendText(res, 200, oauthConsentPage(client, redirect_uri, state));
    }
    if (req.method === 'POST') {
      const body = parseForm(await readBody(req));
      const account_id = body.account_id || '';
      const acc = findAccount(account_id);
      if (!acc) return sendText(res, 400, oauthErrorPage('未选择有效账号'));
      const code = randomKey(24);
      authCodes.set(code, {
        account_id: acc.id, client_id, redirect_uri, exp: Date.now() + CODE_TTL, scope: 'profile chat',
      });
      const sep = redirect_uri.includes('?') ? '&' : '?';
      const loc = redirect_uri + sep + 'code=' + encodeURIComponent(code) + (state ? '&state=' + encodeURIComponent(state) : '');
      res.writeHead(302, { location: loc });
      return res.end();
    }
  }

  // 令牌端点
  if (p === '/oauth/token' && req.method === 'POST') {
    const raw = await readBody(req);
    let body;
    if ((req.headers['content-type'] || '').includes('json')) {
      try { body = JSON.parse(raw); } catch (_) { body = {}; }
    } else {
      body = parseForm(raw);
    }
    if (body.grant_type !== 'authorization_code') {
      return sendJSON(res, 400, { error: 'unsupported_grant_type' });
    }
    const rec = authCodes.get(body.code);
    if (!rec || rec.exp < Date.now()) return sendJSON(res, 400, { error: 'invalid_grant' });
    const client = findClient(body.client_id);
    if (!client || client.client_secret !== body.client_secret) {
      return sendJSON(res, 401, { error: 'invalid_client' });
    }
    if (rec.client_id !== body.client_id) return sendJSON(res, 400, { error: 'invalid_grant' });
    authCodes.delete(body.code);
    const token = 'at-' + randomKey(24);
    accessTokens.set(token, {
      account_id: rec.account_id, client_id: rec.client_id,
      exp: Date.now() + TOKEN_TTL, scope: rec.scope,
    });
    return sendJSON(res, 200, {
      access_token: token, token_type: 'Bearer', expires_in: Math.floor(TOKEN_TTL / 1000),
      scope: rec.scope,
    });
  }

  // 用户信息端点
  if (p === '/oauth/userinfo' && req.method === 'GET') {
    const h = req.headers['authorization'] || '';
    const mm = /^Bearer\s+(.+)$/i.exec(h.trim());
    const rec = mm && accessTokens.get(mm[1]);
    if (!rec || rec.exp < Date.now()) return sendJSON(res, 401, { error: 'invalid_token' });
    const acc = findAccount(rec.account_id);
    if (!acc) return sendJSON(res, 404, { error: 'account_removed' });
    return sendJSON(res, 200, {
      sub: acc.id, name: acc.name, nickname: acc.nickname || '', phone: acc.phone || '',
      preferred_username: acc.name,
    });
  }

  return sendJSON(res, 404, { error: 'not_found' });
}

function oauthErrorPage(msg) {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>授权失败</title>
<body style="font-family:system-ui;padding:40px;background:#0f172a;color:#e2e8f0">
<h2>授权失败</h2><p>${escapeHtml(msg)}</p></body></html>`;
}

function oauthConsentPage(client, redirect_uri, state) {
  const rows = db.accounts.filter((a) => a.enabled).map((a) =>
    `<label style="display:block;padding:12px;margin:8px 0;border:1px solid #334155;border-radius:8px;cursor:pointer">
       <input type="radio" name="account_id" value="${a.id}" required>
       <b>${escapeHtml(a.name)}</b>
       <span style="color:#94a3b8"> ${escapeHtml(a.phone || '')} ${escapeHtml(a.nickname || '')}</span>
     </label>`).join('');
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>授权登录</title>
<body style="font-family:system-ui;padding:40px;background:#0f172a;color:#e2e8f0;max-width:640px">
<h2>${escapeHtml(client.name)} 请求登录</h2>
<p style="color:#94a3b8">回调地址：<code>${escapeHtml(redirect_uri)}</code></p>
<form method="post" action="/oauth/authorize?client_id=${encodeURIComponent(client.client_id)}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${encodeURIComponent(state)}&response_type=code">
${rows || '<p>没有可用账号</p>'}
<button style="margin-top:16px;padding:10px 20px;border:0;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer">授权并返回</button>
</form></body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---- OpenAI 兼容对话（多账号 + 故障转移） ---- */

async function handleCompletions(req, res) {
  let reqBody;
  try {
    reqBody = JSON.parse(await readBody(req));
  } catch (e) {
    return sendError(res, 400, '请求体不是合法 JSON：' + e.message);
  }
  const messages = reqBody.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return sendError(res, 400, 'messages 不能为空');
  }
  const model = reqBody.model || cfg.default_model;
  const wantStream = !!reqBody.stream;
  const reasoning = typeof reqBody.reasoning_effort === 'string' ? reqBody.reasoning_effort : '';
  const prompt = buildPrompt(messages);
  const id = 'chatcmpl-' + uuid32().slice(0, 24);
  const created = nowSec();

  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.on('close', onClose);

  const maxTry = Math.max(1, cfg.max_failover);
  const exclude = [];
  let lastErr = '没有可用账号（请先在面板添加并启用账号）';
  let lastStatus = 503;

  for (let attempt = 0; attempt < maxTry; attempt++) {
    const acc = pickAccount(exclude);
    if (!acc) break;
    if (cfg.refresh_enabled) { try { await ensureAccountToken(acc); } catch (_) {} }

    let up;
    try {
      up = await upstreamStream(acc, prompt, {
        reasoning_effort: reasoning,
        conversation_id: typeof reqBody.conversation_id === 'string' ? reqBody.conversation_id : '',
        signal: ac.signal,
      });
    } catch (e) {
      acc.stats.errors++;
      acc.stats.last_error = '连接失败：' + e.message;
      markCooldown(acc, 30 * 1000);
      saveAccounts();
      recordRequest({ account: acc.name, model, status: 'error', msg: e.message });
      lastErr = '连接 chatglm 失败：' + e.message;
      lastStatus = 502;
      exclude.push(acc.id);
      continue;
    }

    const ctype = up.headers.get('content-type') || '';
    if (!up.ok || !ctype.includes('text/event-stream')) {
      const txt = await up.text().catch(() => '');
      acc.stats.errors++;
      acc.stats.last_error = `HTTP ${up.status}：` + txt.slice(0, 200);
      saveAccounts();
      recordRequest({ account: acc.name, model, status: 'fail', code: up.status, msg: txt.slice(0, 200) });
      // 需要换号的错误
      if ([401, 403, 429, 500, 502, 503, 504].includes(up.status)) {
        markCooldown(acc, up.status === 429 ? 5 * 60 * 1000 : 60 * 1000);
        exclude.push(acc.id);
        lastErr = `chatglm 返回 ${up.status}：${txt.slice(0, 300)}`;
        lastStatus = up.status === 401 ? 401 : 502;
        continue;
      }
      req.off('close', onClose);
      return sendError(res, 502, `chatglm 返回 ${up.status}：${txt.slice(0, 500)}`, 'upstream_error');
    }

    // 成功拿到流
    acc.stats.requests++;
    acc.stats.last_used = Date.now();
    saveAccounts();

    if (!wantStream) {
      let full = '';
      let convId = '';
      try {
        const r = await pumpSSE(up, (d) => { full += d; }, (mm) => { convId = mm.conversationId; });
        full = r.text || full;
        convId = r.conversationId || convId;
      } catch (e) {
        acc.stats.errors++;
        acc.stats.last_error = '读取流失败：' + e.message;
        saveAccounts();
        recordRequest({ account: acc.name, model, status: 'error', msg: e.message });
        req.off('close', onClose);
        return sendError(res, 502, '读取上游流失败：' + e.message, 'upstream_error');
      }
      req.off('close', onClose);
      recordRequest({ account: acc.name, model, status: 'ok', stream: false, chars: full.length });
      if (convId) res.setHeader('x-conversation-id', convId);
      return sendJSON(res, 200, {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // 流式
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    const writeChunk = (delta, finish) => {
      res.write('data: ' + JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish || null }],
      }) + '\n\n');
    };
    writeChunk({ role: 'assistant', content: '' }, null);
    let convId = '';
    let chars = 0;
    try {
      const r = await pumpSSE(up, (d) => { chars += d.length; writeChunk({ content: d }, null); },
        (mm) => { convId = mm.conversationId; writeChunk({ content: '', conversation_id: convId }, null); });
      convId = r.conversationId || convId;
    } catch (e) {
      log('流式转发中断：' + e.message);
    }
    writeChunk({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
    req.off('close', onClose);
    recordRequest({ account: acc.name, model, status: 'ok', stream: true, chars });
    return;
  }

  req.off('close', onClose);
  if (!res.headersSent) return sendError(res, lastStatus, lastErr, 'upstream_error');
  try { res.end(); } catch (_) {}
}

/* ----------------------------------------------------------------------- */
/* 调度：自动签到 + 自动续期                                                */
/* ----------------------------------------------------------------------- */

let lastCheckinDay = '';

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function checkinDue() {
  const [hh, mm] = (cfg.checkin_time || '08:05').split(':').map(Number);
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= hh * 60 + (mm || 0);
}

setInterval(async () => {
  // 自动签到：到点且当天未跑过
  if (cfg.checkin_enabled && checkinDue() && lastCheckinDay !== todayStr()) {
    lastCheckinDay = todayStr();
    log('[scheduler] 触发每日签到');
    try { await checkinAll(); } catch (e) { log('[scheduler] 签到异常：' + e.message); }
  }
  // 自动续期：每轮扫描
  if (cfg.refresh_enabled) {
    for (const a of db.accounts.filter((x) => x.enabled && x.refresh_token)) {
      try { await ensureAccountToken(a); } catch (_) {}
    }
  }
}, 60 * 1000);

// 启动后延迟补签（当天漏签）
setTimeout(async () => {
  if (cfg.checkin_enabled && checkinDue() && lastCheckinDay !== todayStr()) {
    lastCheckinDay = todayStr();
    log('[scheduler] 启动补签');
    try { await checkinAll(); } catch (_) {}
  }
  // 启动时刷新一次账号信息
  for (const a of db.accounts.filter((x) => x.enabled && x.token)) {
    try { await refreshAccountInfo(a); } catch (_) {}
  }
  saveAccounts();
}, 3000);

/* ----------------------------------------------------------------------- */
/* 启动                                                                     */
/* ----------------------------------------------------------------------- */

// 允许通过环境变量覆盖监听地址/端口（Docker / 容器化部署场景）
const PORT = process.env.PORT ? Number(process.env.PORT) : (Number(cfg.port) || 8788);
const HOST = process.env.HOST || cfg.host || '0.0.0.0';
const PANEL_URL = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/`;

server.listen(PORT, HOST, () => {
  log('chatglm-panel 已启动  ' + PANEL_URL);
  log('  账号数：' + db.accounts.length + '（启用 ' + db.accounts.filter((a) => a.enabled).length + '）');
  log('  轮询策略：' + cfg.rotation);
  log('  自动签到：' + (cfg.checkin_enabled ? cfg.checkin_time : '关闭'));
  log('  自动续期：' + (cfg.refresh_enabled ? '开启' : '关闭'));
  log('  网关鉴权：' + (cfg.api_key ? '已开启' : '关闭'));
  // 双击 bat 启动时自动打开浏览器
  if (process.env.PANEL_OPEN_BROWSER === '1') {
    try {
      const cmd = 'start "" "' + PANEL_URL + '"';
      require('child_process').exec(cmd, { shell: 'cmd.exe' });
    } catch (_) {}
  }
});
