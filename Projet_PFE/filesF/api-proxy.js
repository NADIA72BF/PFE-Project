/**
 * api-proxy.js — Zoho-First Architecture
 *
 * Responsibilities of this file (MINIMAL):
 *   - HTTP session management (login/logout/auth-status)
 *   - OAuth token refresh
 *   - Image proxy (CORS workaround)
 *   - Data transmission to/from Zoho Creator
 *
 * Responsibilities moved to Zoho Creator workflows (Deluge):
 *   - Password validation          → workflow "Add_User"
 *   - Email uniqueness check       → workflow "Add_User"
 *   - Default role assignment      → workflow "Add_User"
 *   - Reservation status + duration → workflow "status&calcul"
 *   - Purchase status + date + seller → workflow "auto_set_fields"
 *   - Property availability check  → workflow "Check_Property_Availability"
 *   - Contract generation          → workflow on Contract
 *   - Payment generation           → workflow on Payment
 *   - Property → Sold transition   → workflow on Payment
 */

'use strict';

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const {
  buildPropertyLocationPayload,
  convertDateToZoho,
  createUserSession,
  delay,
  extractZohoErrorMessage,
  findUserByEmail,
  loadEnvFile,
  normalizeUserRecord,
  requireAuth,
  safeParseJsonFile
} = require('./backend-utils');

loadEnvFile(fs, path.join(__dirname, '.env'));

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname)));

// ─── Zoho OAuth config ────────────────────────────────────────────────────────
let ZOHO_ACCESS_TOKEN        = process.env.ZOHO_ACCESS_TOKEN        || '';
const ZOHO_CLIENT_ID         = process.env.ZOHO_CLIENT_ID           || '';
const ZOHO_REFRESH_TOKEN     = process.env.ZOHO_REFRESH_TOKEN       || '';
const ZOHO_CLIENT_SECRET     = process.env.ZOHO_CLIENT_SECRET       || '';
const ZOHO_REPORT_LINK_NAME  = process.env.ZOHO_REPORT_LINK_NAME    || 'All_Properties';
const ZOHO_API_DOMAIN        = process.env.ZOHO_API_DOMAIN          || 'www.zohoapis.com';
const ZOHO_ACCOUNTS_DOMAIN   = process.env.ZOHO_ACCOUNTS_DOMAIN     || 'accounts.zoho.com';
const ZOHO_OAUTH_URL         = `https://${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token`;
const ZOHO_MEDIA_HOSTS       = ['creator.zoho.com', 'creatorapp.zoho.com', ZOHO_API_DOMAIN];
const ALLOW_OFFLINE_LOGIN    = process.env.ALLOW_OFFLINE_LOGIN !== 'false';
const FALLBACK_USER_ID       = process.env.FALLBACK_USER_ID || '';

// Zoho Creator base URLs
const BASE_CREATOR    = 'https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re';
const BASE_CREATORAPP = 'https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re';
const BASE_V21        = `https://${ZOHO_API_DOMAIN}/creator/v2.1/data/2demonexflow/gestion-immobili-re`;

// ─── Cache / timing constants ─────────────────────────────────────────────────
const PROPERTIES_TTL_MS      = Math.max(1000, Number(process.env.PROPERTIES_CACHE_TTL_MS    || 120000));
const PROPERTY_DETAIL_TTL_MS = Math.max(1000, Number(process.env.PROPERTY_DETAIL_CACHE_TTL_MS || 300000));
const USERS_CACHE_TTL_MS     = Math.max(1000, Number(process.env.USERS_CACHE_TTL_MS          || 600000));
const IMAGE_FIELDS_TTL_MS    = Math.max(1000, Number(process.env.IMAGE_FIELDS_TTL_MS          || 3600000));

const LOCAL_UPLOADS_DIR           = path.join(__dirname, 'uploads');
const PROPERTIES_CACHE_PATH       = path.join(__dirname, 'zoho_properties_sample.json');
const PROPERTIES_CACHE_FALLBACK   = path.join(__dirname, 'api_properties_include.json');
const PROPERTIES_CACHE_BULK       = path.join(__dirname, 'api_test_include_image.json');
const USERS_CACHE_PATH            = path.join(__dirname, 'users_cache.json');

const IMAGE_FIELD_CANDIDATES = ['image','Image','photo','Photo','property_image','Property_Image','featured_image'];

// ─── In-memory state ──────────────────────────────────────────────────────────
let tokenExpiresAt              = new Date(Date.now() + 30 * 60 * 1000);
let refreshInFlight             = null;
let lastSuccessfulRefreshAt     = 0;
let oauthCooldownUntil          = 0;
let detectedImageCustomFields   = null;
let detectedImageCustomFieldsAt = 0;
let preferredImageUploadField   = null;
let metadataImageFieldCandidates    = null;
let metadataImageFieldCandidatesAt  = 0;

const propertiesResponseCache = new Map();
const propertyDetailCache     = new Map();
const imageFieldMapCache      = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// OAUTH TOKEN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

async function refreshAccessToken() {
  if (Date.now() < oauthCooldownUntil) return false;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    if (Date.now() - lastSuccessfulRefreshAt < 10000) return true;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🔄 Token refresh — attempt ${attempt}/3`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const response = await fetch(ZOHO_OAUTH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: ZOHO_CLIENT_ID,
            client_secret: ZOHO_CLIENT_SECRET,
            refresh_token: ZOHO_REFRESH_TOKEN
          }),
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const text = await response.text();
          if (response.status === 400 && /too many requests/i.test(text)) {
            oauthCooldownUntil = Date.now() + 2 * 60 * 1000;
          }
          throw new Error(`OAuth ${response.status}: ${text}`);
        }

        const data = await response.json();
        if (!data.access_token) throw new Error('No access_token in response');

        ZOHO_ACCESS_TOKEN = data.access_token;
        const expiresIn = Number(data.expires_in || 3600);
        tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
        lastSuccessfulRefreshAt = Date.now();
        console.log(`✅ Token refreshed — expires ${tokenExpiresAt.toLocaleTimeString()}`);
        return true;
      } catch (err) {
        console.error(`❌ Refresh attempt ${attempt}/3:`, err.message);
        if (attempt < 3) await delay(2000);
      }
    }
    return false;
  })();

  try { return await refreshInFlight; } finally { refreshInFlight = null; }
}

async function ensureValidToken() {
  if (tokenExpiresAt - Date.now() < 2 * 60 * 1000) {
    await refreshAccessToken();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZOHO HTTP HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getAuthHeader(type = 'bearer') {
  return type === 'oauthtoken'
    ? `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`
    : `Bearer ${ZOHO_ACCESS_TOKEN}`;
}

function isZohoLimitPayload(p) {
  return Number(p?.code) === 4000 || /developer api limit/i.test(String(p?.message || ''));
}

function isOfflineError(err) {
  const code = String(err?.code || '').toUpperCase();
  return ['ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT'].includes(code)
      || /getaddrinfo/i.test(err?.message || '');
}

/**
 * Generic Zoho fetch with retry + auto token refresh.
 * Returns { response, payload }.
 */
async function fetchZohoJson(url, {
  method = 'GET',
  authType = 'bearer',
  body,
  timeoutMs = 30000,
  retries = 3,
  extraHeaders = {},
  requireSuccessCode = false,
  fallbackMessage = 'Erreur Zoho'
} = {}) {
  await ensureValidToken();
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const headers = {
        'Authorization': getAuthHeader(authType),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders
      };

      const response = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if ((response.status === 401 || response.status === 403) && attempt < retries) {
        await refreshAccessToken();
        continue;
      }

      const payload = await response.json();

      if (!response.ok) throw new Error(`${fallbackMessage}: ${response.statusText} (${response.status})`);
      if (requireSuccessCode && (payload?.error || (payload?.code && Number(payload.code) !== 3000))) {
        throw new Error(extractZohoErrorMessage(payload, fallbackMessage));
      }

      return { response, payload };
    } catch (err) {
      lastError = err;
      if (attempt < retries && !isOfflineError(err)) {
        await delay(Math.pow(2, attempt - 1) * 1000);
        continue;
      }
      break;
    }
  }
  throw lastError || new Error(fallbackMessage);
}

// ─────────────────────────────────────────────────────────────────────────────
// ERROR EXTRACTION FROM ZOHO WORKFLOW ALERTS
// Zoho Creator workflows return alert messages inside error[].alert_message[]
// ─────────────────────────────────────────────────────────────────────────────

function extractWorkflowAlertMessage(payload, fallback = 'Une erreur est survenue') {
  if (!payload) return fallback;

  // Zoho workflow alert structure: { error: [{ alert_message: ["msg"] }] }
  if (Array.isArray(payload.error) && payload.error.length > 0) {
    const first = payload.error[0];
    if (Array.isArray(first?.alert_message) && first.alert_message.length > 0) {
      return first.alert_message[0];
    }
    if (typeof first === 'string') return first;
    if (first?.message) return first.message;
  }

  if (typeof payload.error === 'string') return payload.error;
  if (payload.message) return payload.message;
  if (payload.details) return payload.details;

  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// USER CACHE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function loadCachedUsers() {
  try {
    if (!fs.existsSync(USERS_CACHE_PATH)) return [];
    const parsed = safeParseJsonFile(fs, USERS_CACHE_PATH);
    const users = Array.isArray(parsed) ? parsed : (parsed?.data || []);
    return users.map(normalizeUserRecord).filter(Boolean);
  } catch { return []; }
}

function persistUsersCache(users) {
  if (!Array.isArray(users)) return;
  try {
    const existing = loadCachedUsers();
    const merged = [];
    const seen = new Set();
    const push = (u) => {
      const n = normalizeUserRecord(u);
      if (!n) return;
      const key = n.Email.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(n);
    };
    users.forEach(push);
    existing.forEach(push);
    fs.writeFileSync(USERS_CACHE_PATH, JSON.stringify(merged, null, 2));
  } catch (err) { console.warn('⚠️ Users cache write failed:', err.message); }
}

function isUsersCacheFresh() {
  try {
    if (!fs.existsSync(USERS_CACHE_PATH)) return false;
    return Date.now() - fs.statSync(USERS_CACHE_PATH).mtimeMs <= USERS_CACHE_TTL_MS;
  } catch { return false; }
}

function buildUsersReportUrl() {
  return `${BASE_CREATOR}/report/All_Users`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTY CACHE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function loadCachedProperties() {
  const files = [PROPERTIES_CACHE_PATH, PROPERTIES_CACHE_BULK, PROPERTIES_CACHE_FALLBACK];
  const merged = [];
  const seen = new Set();
  for (const f of files) {
    try {
      if (!fs.existsSync(f)) continue;
      const parsed = safeParseJsonFile(fs, f);
      const records = Array.isArray(parsed) ? parsed : (parsed?.data || []);
      for (const r of records) {
        const id = r?.ID || r?.ID1 || r?.id;
        const key = id ? String(id) : JSON.stringify(r);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
    } catch { continue; }
  }
  return merged;
}

function persistPropertiesCache(properties) {
  if (!Array.isArray(properties) || !properties.length) return;
  try {
    const existing = loadCachedProperties();
    const merged = [];
    const seen = new Set();
    const push = (r) => {
      const id = r?.ID || r?.ID1 || r?.id;
      const key = id ? String(id) : JSON.stringify(r);
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(r);
    };
    properties.forEach(push);
    existing.forEach(push);
    fs.writeFileSync(PROPERTIES_CACHE_PATH, JSON.stringify(merged, null, 2));
  } catch (err) { console.warn('⚠️ Properties cache write failed:', err.message); }
}

function appendPropertyToCache(property) {
  if (!property) return;
  try {
    const existing = loadCachedProperties();
    const id = property.ID || property.ID1 || property.id;
    const filtered = id ? existing.filter(p => String(p?.ID || p?.ID1) !== String(id)) : existing;
    fs.writeFileSync(PROPERTIES_CACHE_PATH, JSON.stringify([property, ...filtered], null, 2));
  } catch { }
}

function findCachedPropertyById(id) {
  const target = String(id || '').trim();
  if (!target) return null;
  for (const p of loadCachedProperties()) {
    if (String(p?.ID).trim() === target || String(p?.ID1).trim() === target) {
      return enrichPropertyWithImage(p);
    }
  }
  return null;
}

function getCachedPropertyDetail(id) {
  const e = propertyDetailCache.get(String(id));
  if (!e) return null;
  if (Date.now() - e.at > PROPERTY_DETAIL_TTL_MS) { propertyDetailCache.delete(String(id)); return null; }
  return e.data;
}

function setCachedPropertyDetail(id, data) {
  if (!id || !data) return;
  propertyDetailCache.set(String(id), { at: Date.now(), data });
}

function getCachedPropertiesResponse(key) {
  const e = propertiesResponseCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > PROPERTIES_TTL_MS) { propertiesResponseCache.delete(key); return null; }
  return e.data;
}

function setCachedPropertiesResponse(key, data) {
  propertiesResponseCache.set(key, { at: Date.now(), data });
}

function clearPropertiesResponseCache() { propertiesResponseCache.clear(); }

function inferFallbackUserId() {
  if (FALLBACK_USER_ID) return FALLBACK_USER_ID;
  for (const p of loadCachedProperties()) {
    const id = p?.User?.ID || p?.User?.id;
    if (id) return String(id);
  }
  return `offline-${Date.now()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function extractImageUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) { for (const v of value) { const c = extractImageUrl(v); if (c) return c; } return null; }
  if (typeof value === 'object') {
    const d = value.download_url || value.url || value.content || value.display_value;
    if (typeof d === 'string' && d.trim()) return d;
    for (const [k, v] of Object.entries(value)) {
      if (/(image|photo|file|pic)/i.test(k)) { const c = extractImageUrl(v); if (c) return c; }
    }
  }
  return null;
}

function extractImageUrlFromProperty(p) {
  if (!p) return null;
  for (const k of IMAGE_FIELD_CANDIDATES) {
    if (Object.prototype.hasOwnProperty.call(p, k)) { const c = extractImageUrl(p[k]); if (c) return c; }
  }
  for (const [k, v] of Object.entries(p)) {
    if (/(image|photo|file|pic)/i.test(k)) { const c = extractImageUrl(v); if (c) return c; }
  }
  return null;
}

function resolveLocalImage(property) {
  const id = property?.ID || property?.ID1;
  if (!id) return null;
  for (const ext of ['jpg','jpeg','png','webp','gif','bmp']) {
    const f = path.join(LOCAL_UPLOADS_DIR, `property-${id}.${ext}`);
    if (fs.existsSync(f)) return `/uploads/property-${id}.${ext}`;
  }
  return null;
}

function normalizeZohoMediaUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.startsWith('data:image/') || raw.startsWith('/uploads/') || raw.startsWith('/api/')) return raw;
  if (raw.startsWith('/')) return `https://creator.zoho.com${raw}`;
  try { return new URL(raw).toString(); } catch { return null; }
}

function buildImageProxyUrl(rawUrl) {
  const n = normalizeZohoMediaUrl(rawUrl);
  if (!n) return null;
  if (n.startsWith('data:image/') || n.startsWith('/uploads/') || n.startsWith('/api/')) return n;
  try {
    const parsed = new URL(n);
    const isZoho = ZOHO_MEDIA_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
    return isZoho ? `/api/media?url=${encodeURIComponent(n)}` : n;
  } catch { return null; }
}

function enrichPropertyWithImage(property) {
  if (!property || typeof property !== 'object') return property;
  const imageUrl = extractImageUrlFromProperty(property) || resolveLocalImage(property);
  if (imageUrl) {
    return { ...property, image_url: imageUrl, image_proxy_url: buildImageProxyUrl(imageUrl) || imageUrl };
  }
  const id = property?.ID;
  if (id) {
    const proxy = `/api/property-image/${id}`;
    return { ...property, image_url: proxy, image_proxy_url: proxy };
  }
  return property;
}

function parseDataUrlImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  const mimeType = m[1].toLowerCase();
  const buffer = Buffer.from(m[2], 'base64');
  const ext = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/bmp':'bmp' }[mimeType] || 'jpg';
  return { buffer, mimeType, extension: ext };
}

function saveLocalPropertyImage(recordId, imageDataUrl, index = null) {
  const parsed = parseDataUrlImage(imageDataUrl);
  if (!parsed || !recordId) return null;
  fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
  const suffix = typeof index === 'number' && index > 1 ? `-${index}` : '';
  const fileName = `property-${recordId}${suffix}.${parsed.extension}`;
  fs.writeFileSync(path.join(LOCAL_UPLOADS_DIR, fileName), parsed.buffer);
  return `/uploads/${fileName}`;
}

function extractCreatedRecordId(createData) {
  if (!createData) return null;
  const candidates = [createData.data, ...(Array.isArray(createData.result) ? createData.result : [])];
  for (const obj of candidates) {
    if (!obj) continue;
    if (Array.isArray(obj) && obj[0]?.ID) return obj[0].ID;
    if (obj.ID) return obj.ID;
    if (obj.id) return obj.id;
    if (obj.data?.ID) return obj.data.ID;
  }
  return null;
}

function normalizePropertyType(type) {
  if (!type) return type;
  const t = type.trim().toLowerCase();
  if (t === 'location') return 'To Rent';
  if (t === 'vente') return 'For Sale';
  return type;
}

async function uploadPropertyImageToZoho(recordId, imageDataUrl) {
  const parsed = parseDataUrlImage(imageDataUrl);
  if (!parsed) return { uploaded: false, reason: 'Invalid image format' };

  const candidates = preferredImageUploadField
    ? [preferredImageUploadField]
    : [...(detectedImageCustomFields || []), 'Image', 'image'].filter((v,i,a) => a.indexOf(v) === i);

  for (const field of candidates) {
    const uploadUrl = `${BASE_V21}/report/${ZOHO_REPORT_LINK_NAME}/${encodeURIComponent(recordId)}/${encodeURIComponent(field)}/upload`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const fd = new FormData();
      fd.append('file', parsed.buffer, { filename: `property-${recordId}.${parsed.extension}`, contentType: parsed.mimeType });
      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Authorization': `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`, ...fd.getHeaders() },
        body: fd
      });
      if ((response.status === 401 || response.status === 403) && attempt < 2) { await refreshAccessToken(); continue; }
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.code && body.code !== 3000) { if (body.code === 3710) break; return { uploaded: false, reason: `Upload error (${body.code})` }; }
        preferredImageUploadField = field;
        return { uploaded: true, fieldName: field };
      }
      if (response.status !== 400 && response.status !== 404) return { uploaded: false, reason: `Upload failed (${response.status})` };
      break;
    }
  }
  return { uploaded: false, reason: 'No compatible image field found' };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTY FETCH (single record)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchZohoPropertyRecord(recordId) {
  await ensureValidToken();
  const urls = [
    `${BASE_V21}/report/${ZOHO_REPORT_LINK_NAME}/${encodeURIComponent(recordId)}?field_config=all`,
    `${BASE_CREATOR}/report/${ZOHO_REPORT_LINK_NAME}/${encodeURIComponent(recordId)}`,
    `${BASE_CREATORAPP}/report/${ZOHO_REPORT_LINK_NAME}/${encodeURIComponent(recordId)}`
  ];

  for (const url of urls) {
    try {
      const isV21 = url.includes('/v2.1/');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, {
        headers: { 'Authorization': isV21 ? `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` : `Bearer ${ZOHO_ACCESS_TOKEN}` },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.status === 404) continue;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { await refreshAccessToken(); continue; }
        throw new Error(`Zoho ${response.status}`);
      }
      const data = await response.json();
      const record = data.data?.[0] || data.data || null;
      const enriched = enrichPropertyWithImage(record);
      setCachedPropertyDetail(recordId, enriched);
      return enriched;
    } catch (err) {
      console.warn(`⚠️ fetchZohoPropertyRecord (${url}):`, err.message);
    }
  }
  throw new Error(`Property ${recordId} not found`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — IMAGE PROXY
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/media', async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: 'URL manquante' });
    const normalized = normalizeZohoMediaUrl(rawUrl);
    if (!normalized || normalized.startsWith('data:image/')) return res.status(400).json({ error: 'URL invalide' });
    const parsed = new URL(normalized);
    const isZoho = ZOHO_MEDIA_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
    if (!isZoho) return res.status(400).json({ error: 'Host non autorisé' });

    await ensureValidToken();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetch(parsed.toString(), { headers: { 'Authorization': `Bearer ${ZOHO_ACCESS_TOKEN}` } });
      if ((response.status === 401 || response.status === 403) && attempt < 2) { await refreshAccessToken(); continue; }
      if (!response.ok) return res.status(response.status).json({ error: `Media error (${response.status})` });
      res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(await response.buffer());
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/property-image/:recordId', async (req, res) => {
  try {
    const { recordId } = req.params;
    if (!/^\d+$/.test(recordId)) return res.status(400).json({ error: 'Invalid ID' });

    for (const ext of ['jpg','jpeg','png','webp','gif','bmp']) {
      const f = path.join(LOCAL_UPLOADS_DIR, `property-${recordId}.${ext}`);
      if (fs.existsSync(f)) { res.setHeader('Cache-Control', 'public, max-age=86400'); return res.sendFile(f); }
    }

    await ensureValidToken();
    const candidates = [...(preferredImageUploadField ? [preferredImageUploadField] : []),
      ...(detectedImageCustomFields || []), ...IMAGE_FIELD_CANDIDATES].filter((v,i,a) => a.indexOf(v)===i);

    for (const field of candidates) {
      const url = `${BASE_V21}/report/${ZOHO_REPORT_LINK_NAME}/${encodeURIComponent(recordId)}/${encodeURIComponent(field)}/download`;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await fetch(url, { headers: { 'Authorization': `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` } });
        if ((response.status === 401 || response.status === 403) && attempt < 2) { await refreshAccessToken(); continue; }
        if (!response.ok) break;
        const ct = response.headers.get('content-type') || '';
        if (!ct.startsWith('image/')) break;
        const buffer = await response.buffer();
        try {
          const ext = ct.match(/image\/([a-z0-9]+)/i)?.[1]?.replace('jpeg','jpg') || 'jpg';
          fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
          fs.writeFileSync(path.join(LOCAL_UPLOADS_DIR, `property-${recordId}.${ext}`), buffer);
        } catch {}
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      }
    }
    return res.status(404).end();
  } catch (err) { res.status(500).end(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — AUTH
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/auth-status', (req, res) => {
  if (req.session.userId) {
    return res.json({ loggedIn: true, user: {
      id: req.session.userId,
      email: req.session.userEmail,
      name: req.session.userName,
      role: req.session.userRole
    }});
  }
  res.json({ loggedIn: false });
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const normalizedEmail = String(email).trim();

    // Try cache first
    if (isUsersCacheFresh()) {
      const cached = findUserByEmail(loadCachedUsers(), normalizedEmail);
      if (cached && cached.Password === password) {
        return createUserSession(req, res, cached, { source: 'cache' });
      }
    }

    // Fetch from Zoho
    try {
      const { payload } = await fetchZohoJson(buildUsersReportUrl(), { retries: 3, fallbackMessage: 'Erreur Zoho users' });
      const users = payload.data || [];
      if (users.length > 0) persistUsersCache(users);

      const user = findUserByEmail(users.length > 0 ? users : loadCachedUsers(), normalizedEmail);
      if (!user || user.Password !== password) {
        return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      }

      req.session.userId = user.ID || user.id;
      return createUserSession(req, res, user, { source: 'zoho' });
    } catch (err) {
      console.error('❌ Login Zoho error:', err.message);
      if (!ALLOW_OFFLINE_LOGIN) return res.status(503).json({ error: err.message });

      const fallback = findUserByEmail(loadCachedUsers(), normalizedEmail);
      if (!fallback || fallback.Password !== password) {
        return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      }
      return createUserSession(req, res, fallback, { source: 'cache', warning: 'Mode hors-ligne' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Erreur déconnexion' });
    res.json({ success: true });
  });
});

app.get('/api/logout', (req, res) => {
  req.session.destroy(() => res.redirect('index.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — SIGNUP
//
// ✅ Zoho workflow "Add_User" handles:
//    - Password confirmation match
//    - Password strength (length, uppercase, digit, special char)
//    - Email uniqueness check
//    - Default role assignment
//    - Record insertion
//
// Node.js only:
//    - Basic presence check (empty fields)
//    - Forward data to Zoho
//    - Surface Zoho workflow alert messages to the frontend
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/signup', async (req, res) => {
  try {
    const { first_name, last_name, email, phone_number, password, confirm_password } = req.body;

    // Only basic presence check — all other validation is in Zoho workflow "Add_User"
    if (!first_name || !last_name || !email || !phone_number || !password || !confirm_password) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }

    const normalizedEmail = String(email).trim();

    const formUrl = `${BASE_CREATOR}/form/User`;
    const requestBody = {
      data: {
        full_name: { first_name, last_name },
        Email: normalizedEmail,
        Phone_Number: phone_number,
        Password: password,
        Confirm_password: confirm_password
        // Role and uniqueness check → handled by Zoho workflow "Add_User"
      }
    };

    console.log('📝 Signup — forwarding to Zoho Creator (workflow Add_User will validate)');

    let createData;
    try {
      const { payload } = await fetchZohoJson(formUrl, {
        method: 'POST',
        authType: 'bearer',
        body: requestBody,
        retries: 3,
        fallbackMessage: 'Erreur création compte'
      });
      createData = payload;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Surface Zoho workflow alert messages (password rules, email exists, etc.)
    if (createData?.error || (createData?.code && Number(createData.code) !== 3000)) {
      const msg = extractWorkflowAlertMessage(createData, 'Erreur lors de la création du compte');
      return res.status(400).json({ error: msg });
    }

    console.log(`✅ Signup OK: ${normalizedEmail}`);
    req.session.userId = createData.data?.ID || `new-${Date.now()}`;
    req.session.userEmail = normalizedEmail;
    req.session.userName = `${first_name} ${last_name}`;

    persistUsersCache([{
      ID: req.session.userId,
      Email: normalizedEmail,
      Password: password,
      Phone_Number: phone_number,
      full_name: { first_name, last_name }
    }]);

    res.json({ success: true, message: 'Compte créé avec succès!', user: { email: normalizedEmail, name: req.session.userName } });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — PROPERTIES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/properties', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10);
    const hasLimit = !Number.isNaN(limit) && limit > 0;
    const maxRecords = hasLimit ? Math.min(limit, 200) : 200;
    const cacheKey = JSON.stringify({ limit: hasLimit ? limit : null });

    const cached = getCachedPropertiesResponse(cacheKey);
    if (cached) return res.json(cached);

    await ensureValidToken();

    const zohoUrl = `${BASE_V21}/report/${ZOHO_REPORT_LINK_NAME}?field_config=all&max_records=${maxRecords}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(zohoUrl, {
          headers: { 'Authorization': `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` },
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) { await refreshAccessToken(); continue; }
          throw new Error(`Zoho ${response.status}`);
        }

        const data = await response.json();
        if (isZohoLimitPayload(data) && !data.data?.length) {
          const fallback = loadCachedProperties().map(enrichPropertyWithImage);
          return res.json({ code: 3000, source: 'cache', data: hasLimit ? fallback.slice(0, limit) : fallback });
        }

        let properties = (data.data || []).map(enrichPropertyWithImage);
        if (hasLimit) properties = properties.slice(0, limit);

        if (properties.length) {
          persistPropertiesCache(properties);
          for (const p of properties) {
            const id = p?.ID || p?.ID1;
            if (id) setCachedPropertyDetail(id, p);
          }
        }

        const result = { ...data, data: properties };
        setCachedPropertiesResponse(cacheKey, result);
        return res.json(result);
      } catch (err) {
        if (attempt >= 2 || isOfflineError(err)) {
          const fallback = loadCachedProperties().map(enrichPropertyWithImage);
          if (fallback.length) {
            return res.json({ code: 3000, source: 'cache', warning: err.message, data: hasLimit ? fallback.slice(0, limit) : fallback });
          }
          return res.status(503).json({ error: err.message });
        }
        await delay(1000);
      }
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'ID requis' });

    const cached = getCachedPropertyDetail(id);
    if (cached) return res.json({ code: 3000, source: 'cache', data: [cached] });

    let property;
    try { property = await fetchZohoPropertyRecord(id); }
    catch { property = findCachedPropertyById(id); }

    if (!property) return res.status(404).json({ error: `Property ${id} not found` });
    setCachedPropertyDetail(id, property);
    res.json({ code: 3000, data: [property] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/properties/create', requireAuth, async (req, res) => {
  try {
    const { title, description, price, location, address_line_1, address_line_2, city_district,
            type, floor, surface, bedrooms, bathrooms, year_built, status, image, images } = req.body;

    const normalizedType = normalizePropertyType(type);
    const locationPayload = buildPropertyLocationPayload({ location, address_line_1, address_line_2, city_district });
    const dataUrlImages = [];
    const seen = new Set();

    const collect = (img) => {
      if (typeof img === 'string' && img.startsWith('data:image/') && !seen.has(img)) {
        seen.add(img); dataUrlImages.push(img);
      }
    };
    if (Array.isArray(images)) images.forEach(collect);
    collect(image);

    const requestBody = {
      data: {
        title,
        description: description || '',
        Price1: parseFloat(price),
        type_field: normalizedType,
        Rooms1: bedrooms ? parseInt(bedrooms) : null,
        Bathrooms1: bathrooms ? parseInt(bathrooms) : null,
        Surface1: surface ? parseInt(surface) : null,
        Floor: floor ? parseInt(floor) : null,
        Year_Built: year_built ? convertDateToZoho(year_built) : null,
        status,
        User: req.session.userId,
        ...(locationPayload ? { location: locationPayload } : {}),
        ...(typeof image === 'string' && /^https?:\/\//i.test(image) ? { image, Image: image } : {})
      }
    };

    let createData;
    try {
      const { payload } = await fetchZohoJson(`${BASE_CREATOR}/form/Property`, {
        method: 'POST',
        authType: 'bearer',
        body: requestBody,
        retries: 3,
        requireSuccessCode: true,
        fallbackMessage: 'Erreur création propriété'
      });
      createData = payload;
    } catch (err) {
      return res.status(503).json({ error: err.message });
    }

    const createdId = extractCreatedRecordId(createData);
    const imageUploads = [];

    if (createdId && dataUrlImages.length) {
      for (let i = 0; i < dataUrlImages.length; i++) {
        const localUrl = saveLocalPropertyImage(createdId, dataUrlImages[i], i + 1);
        const zohoResult = await uploadPropertyImageToZoho(createdId, dataUrlImages[i]);
        imageUploads.push({ ...zohoResult, imageIndex: i + 1, localImageUrl: localUrl });
      }
    }

    if (createdId) {
      const cached = enrichPropertyWithImage({
        ID: String(createdId), title, description, Price1: String(price), status,
        type_field: normalizedType, location: locationPayload,
        User: { ID: req.session.userId },
        Image: imageUploads.map(u => u.localImageUrl).filter(Boolean)
      });
      appendPropertyToCache(cached);
      clearPropertiesResponseCache();
      setCachedPropertyDetail(createdId, cached);
    }

    res.json({ success: true, message: 'Propriété créée avec succès!', data: createData, imageUploads });
  } catch (err) {
    console.error('Property create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — RESERVATIONS
//
// ✅ Zoho workflow "Check_Property_Availability" handles:
//    - Date conflict detection
//    - Alert and cancel submit on conflict
//
// ✅ Zoho workflow "status&calcul" handles:
//    - Status = "En attente" (auto)
//    - Duration_Text calculation (auto)
//
// Node.js only:
//    - Add User (session) and Property ID to the payload
//    - Forward to Zoho
//    - Surface Zoho workflow alert messages
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/reservations/create', requireAuth, async (req, res) => {
  try {
    const { property_id, start_date, end_date } = req.body;

    if (!property_id || !start_date || !end_date) {
      return res.status(400).json({ error: 'property_id, start_date et end_date sont requis' });
    }

    // Status, Duration_Text → set by Zoho workflow "status&calcul"
    // Availability check     → done by Zoho workflow "Check_Property_Availability"
    const requestBody = {
      data: {
        Start_Date: convertDateToZoho(start_date),
        End_Date: convertDateToZoho(end_date),
        User: req.session.userId,
        Property1: property_id.toString()
        // Status and Duration_Text are set automatically by Zoho workflow
      }
    };

    console.log('📅 Reservation — forwarding to Zoho (workflows will set Status + Duration + check availability)');

    let createData;
    try {
      const { payload } = await fetchZohoJson(`${BASE_CREATORAPP}/form/Reservation`, {
        method: 'POST',
        authType: 'bearer',
        body: requestBody,
        retries: 3,
        fallbackMessage: 'Erreur création réservation'
      });
      createData = payload;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Surface Zoho workflow alerts (e.g. "property already booked")
    if (createData?.error || (createData?.code && Number(createData.code) !== 3000)) {
      const msg = extractWorkflowAlertMessage(createData, 'Erreur lors de la réservation');
      return res.status(400).json({ error: msg });
    }

    console.log(`✅ Réservation créée — property: ${property_id}, user: ${req.session.userId}`);
    res.json({ success: true, message: 'Réservation créée avec succès!', data: createData });
  } catch (err) {
    console.error('Reservation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — PURCHASES
//
// ✅ Zoho workflow "auto_set_fields" handles:
//    - Statut = "En attente" (auto)
//    - Request_Date = today (auto)
//    - Seller = Property.User (auto, from property lookup)
//
// Node.js only:
//    - Add Buyer (session) and Property ID
//    - Forward to Zoho
//    - Surface Zoho workflow alerts
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/purchases/create', requireAuth, async (req, res) => {
  try {
    const { property_id, preference_de_contact, message } = req.body;

    if (!property_id) {
      return res.status(400).json({ error: 'property_id est requis' });
    }

    // Statut, Request_Date, Seller → all set by Zoho workflow "auto_set_fields"
    const requestBody = {
      data: {
        Buyer: req.session.userId,
        Property: property_id.toString(),
        Preference_de_contact: preference_de_contact || 'Email',
        Message: message || ''
        // Statut      → set by Zoho workflow "auto_set_fields"
        // Request_Date → set by Zoho workflow "auto_set_fields"
        // Seller      → set by Zoho workflow "auto_set_fields" (from Property.User)
      }
    };

    console.log(`🛒 Purchase — forwarding to Zoho (workflow auto_set_fields will set Statut, Request_Date, Seller)`);

    let payload;
    try {
      const result = await fetchZohoJson(`${BASE_CREATORAPP}/form/Purchase`, {
        method: 'POST',
        body: requestBody,
        retries: 3,
        fallbackMessage: "Erreur création demande d'achat"
      });
      payload = result.payload;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Surface Zoho workflow alerts
    if (payload?.error || (payload?.code && Number(payload.code) !== 3000)) {
      const msg = extractWorkflowAlertMessage(payload, "Erreur lors de la demande d'achat");
      return res.status(400).json({ error: msg });
    }

    console.log(`✅ Demande d'achat créée — property: ${property_id}, buyer: ${req.session.userId}`);
    res.json({ success: true, message: "Demande d'achat soumise avec succès!", data: payload });
  } catch (err) {
    console.error("Purchase error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/purchases/user', requireAuth, async (req, res) => {
  try {
    const criteria = encodeURIComponent(`Buyer == "${req.session.userId}"`);
    const { payload } = await fetchZohoJson(`${BASE_CREATORAPP}/report/All_Purchases?criteria=${criteria}`, {
      fallbackMessage: "Erreur récupération achats"
    });
    res.json({ success: true, data: payload.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — CONTRACTS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/contracts/user', requireAuth, async (req, res) => {
  try {
    const criteria = encodeURIComponent(`Buyer == "${req.session.userId}"`);
    const { payload } = await fetchZohoJson(`${BASE_CREATORAPP}/report/All_Contracts?criteria=${criteria}`, {
      fallbackMessage: "Erreur récupération contrats"
    });
    res.json({ success: true, data: payload.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — PAYMENTS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/payments/user', requireAuth, async (req, res) => {
  try {
    const criteria = encodeURIComponent(`Contract.Buyer == "${req.session.userId}"`);
    const { payload } = await fetchZohoJson(`${BASE_CREATORAPP}/report/All_Payments?criteria=${criteria}`, {
      fallbackMessage: "Erreur récupération paiements"
    });
    res.json({ success: true, data: payload.data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────────────────────────────────────────

function startServer(port, retries = 5) {
  const server = app.listen(port, () => {
    console.log(`✅ Server running on http://localhost:${port}`);
    console.log('🔐 OAuth auto-refresh active');
    console.log('🏗️  Zoho-first architecture — business logic in Zoho Creator workflows');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.warn(`⚠️ Port ${port} in use, trying ${port + 1}...`);
      return startServer(port + 1, retries - 1);
    }
    console.error('❌ Server error:', err);
  });

  return server;
}

startServer(Number(process.env.PORT || 3000));

process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled rejection:', reason); });
process.on('uncaughtException', (err)    => { console.error('❌ Uncaught exception:', err); });