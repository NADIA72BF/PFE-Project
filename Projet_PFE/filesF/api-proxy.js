const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const crypto = require('crypto');
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

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ✅ Session management
app.use(session({
  secret: 'your-secret-key-change-in-production', // Change this!
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // Set to true if using HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

app.use(express.static(path.join(__dirname)));

// ✅ Configuration OAuth Zoho
let ZOHO_ACCESS_TOKEN = process.env.ZOHO_ACCESS_TOKEN || "1000.a73f68ca66bc3baecca47a99f36f0cba.7f9de4d1e13f227f45d4038ef9b478c2";
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || "1000.YGKX0RFVW7M3KVM1EY1RNISPEDCKUW";
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || "1000.dea854cbb68afd6071fe50db4b42b249.6947e755f2d9ff51796621369c35f519";
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "49275494d0c447afe11658b1564ffd5b1f6c599eef";
const ZOHO_REPORT_LINK_NAME = process.env.ZOHO_REPORT_LINK_NAME || "All_Properties";
const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || process.env.ZOHO_DC_DOMAIN || 'www.zohoapis.com';
const ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'accounts.zoho.com';
const ZOHO_V2_REPORT_URL = `https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/report/${ZOHO_REPORT_LINK_NAME}`;
const ZOHO_V2_APP_REPORT_URL = `https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re/report/${ZOHO_REPORT_LINK_NAME}`;
const ZOHO_V21_REPORT_URL = `https://${ZOHO_API_DOMAIN}/creator/v2.1/data/2demonexflow/gestion-immobili-re/report/${ZOHO_REPORT_LINK_NAME}`;
const ZOHO_V21_FIELDS_URL = `https://${ZOHO_API_DOMAIN}/creator/v2.1/meta/2demonexflow/gestion-immobili-re/form/Property/fields`;
const ZOHO_OAUTH_URL = `https://${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token`;
const ZOHO_REPORT_PRIVATELINK = process.env.ZOHO_REPORT_PRIVATELINK || '';
const ZOHO_MEDIA_HOSTS = ['creator.zoho.com', 'creatorapp.zoho.com', ZOHO_API_DOMAIN];
const LOCAL_UPLOADS_DIR = path.join(__dirname, 'uploads');
const PROPERTIES_CACHE_PATH = path.join(__dirname, 'zoho_properties_sample.json');
const PROPERTIES_CACHE_FALLBACK_PATH = path.join(__dirname, 'api_properties_include.json');
const PROPERTIES_CACHE_BULK_PATH = path.join(__dirname, 'api_test_include_image.json');
const USERS_CACHE_PATH = path.join(__dirname, 'users_cache.json');
const ALLOW_OFFLINE_LOGIN = process.env.ALLOW_OFFLINE_LOGIN !== 'false';
const FALLBACK_USER_ID = process.env.FALLBACK_USER_ID || '';
const PROPERTIES_TTL_MS = Math.max(1000, Number(process.env.PROPERTIES_CACHE_TTL_MS || 120000));
const PROPERTY_DETAIL_TTL_MS = Math.max(1000, Number(process.env.PROPERTY_DETAIL_CACHE_TTL_MS || 300000));
const USERS_CACHE_TTL_MS = Math.max(1000, Number(process.env.USERS_CACHE_TTL_MS || 600000));
const IMAGE_FIELDS_TTL_MS = Math.max(1000, Number(process.env.IMAGE_FIELDS_TTL_MS || 3600000));

const IMAGE_FIELD_CANDIDATES = [
  'image',
  'Image',
  'photo',
  'Photo',
  'property_image',
  'Property_Image',
  'featured_image'
];

let detectedImageCustomFields = null;
let preferredImageUploadField = null;
let metadataImageFieldCandidates = null;
let refreshInFlight = null;
let lastSuccessfulRefreshAt = 0;
let oauthCooldownUntil = 0;
const propertiesResponseCache = new Map();
const propertyDetailCache = new Map();
const imageFieldMapCache = new Map();
let detectedImageCustomFieldsAt = 0;
let metadataImageFieldCandidatesAt = 0;

// Start with a short optimistic TTL to avoid refresh storms at startup.
let tokenExpiresAt = new Date(Date.now() + (30 * 60 * 1000));

function buildZohoV21ReportUrl({ fieldConfig = 'all', maxRecords = 200, criteria = null } = {}) {
  const params = new URLSearchParams({
    field_config: fieldConfig,
    max_records: String([200, 500, 1000].includes(maxRecords) ? maxRecords : 200)
  });

  if (criteria) {
    params.set('criteria', criteria);
  }

  return `${ZOHO_V21_REPORT_URL}?${params.toString()}`;
}

function buildZohoPublishRecordUrl(recordId) {
  if (!ZOHO_REPORT_PRIVATELINK) {
    return null;
  }

  const params = new URLSearchParams({
    privatelink: ZOHO_REPORT_PRIVATELINK,
    field_config: 'detail_view'
  });

  return `https://${ZOHO_API_DOMAIN}/creator/v2.1/publish/2demonexflow/gestion-immobili-re/report/${encodeURIComponent(ZOHO_REPORT_LINK_NAME)}/${encodeURIComponent(recordId)}?${params.toString()}`;
}

function buildPropertiesCacheKey({ limit, includeImages }) {
  return JSON.stringify({
    limit: Number.isInteger(limit) && limit > 0 ? limit : null,
    includeImages: Boolean(includeImages)
  });
}

function getCachedPropertiesResponse(cacheKey) {
  const entry = propertiesResponseCache.get(cacheKey);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > PROPERTIES_TTL_MS) {
    propertiesResponseCache.delete(cacheKey);
    return null;
  }

  return entry.payload;
}

function setCachedPropertiesResponse(cacheKey, payload) {
  if (!cacheKey || !payload) return;
  propertiesResponseCache.set(cacheKey, {
    createdAt: Date.now(),
    payload
  });
}

function clearPropertiesResponseCache() {
  propertiesResponseCache.clear();
}

function getTimedCacheEntry(cacheMap, key, ttlMs) {
  const entry = cacheMap.get(key);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > ttlMs) {
    cacheMap.delete(key);
    return null;
  }

  return entry.payload;
}

function setTimedCacheEntry(cacheMap, key, payload) {
  if (!key || payload === undefined) return;
  cacheMap.set(key, {
    createdAt: Date.now(),
    payload
  });
}

function getCachedPropertyDetail(recordId) {
  return getTimedCacheEntry(propertyDetailCache, String(recordId || '').trim(), PROPERTY_DETAIL_TTL_MS);
}

function setCachedPropertyDetail(recordId, payload) {
  const key = String(recordId || '').trim();
  if (!key) return;
  setTimedCacheEntry(propertyDetailCache, key, payload);
}

function isUsersCacheFresh() {
  try {
    if (!fs.existsSync(USERS_CACHE_PATH)) return false;
    const stats = fs.statSync(USERS_CACHE_PATH);
    return (Date.now() - stats.mtimeMs) <= USERS_CACHE_TTL_MS;
  } catch (_) {
    return false;
  }
}

function isImageMetadataFresh(lastLoadedAt) {
  return Number(lastLoadedAt) > 0 && (Date.now() - lastLoadedAt) <= IMAGE_FIELDS_TTL_MS;
}

function isZohoLimitPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return Number(payload.code) === 4000 || /developer api limit has been reached/i.test(String(payload.message || ''));
}

function shouldRetryAfterZohoFailure(error) {
  return !isZohoLimitError(error) && !isZohoValidationError(error);
}

function buildUsersReportUrl() {
  return "https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/report/All_Users";
}

function getZohoAuthHeader(authType = 'bearer') {
  if (authType === 'oauthtoken') {
    return `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`;
  }
  if (authType === 'bearer') {
    return `Bearer ${ZOHO_ACCESS_TOKEN}`;
  }
  return null;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

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

  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const authHeader = getZohoAuthHeader(authType);
      const headers = {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
        ...(authHeader ? { Authorization: authHeader } : {})
      };

      const response = await fetchJsonWithTimeout(url, {
        method,
        headers,
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
      }, timeoutMs);

      if ((response.status === 401 || response.status === 403) && attempt < retries) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          continue;
        }
      }

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(`${fallbackMessage}: ${response.statusText} (${response.status})`);
      }

      if (requireSuccessCode && (payload?.error || (payload?.code && Number(payload.code) !== 3000))) {
        throw new Error(extractZohoErrorMessage(payload, fallbackMessage));
      }

      return { response, payload };
    } catch (error) {
      lastError = error;
      if (attempt < retries && shouldRetryAfterZohoFailure(error)) {
        await delay(Math.pow(2, attempt - 1) * 1000);
        continue;
      }
      break;
    }
  }

  throw lastError || new Error(fallbackMessage);
}

function loadCachedProperties() {
  const candidates = [PROPERTIES_CACHE_PATH, PROPERTIES_CACHE_BULK_PATH, PROPERTIES_CACHE_FALLBACK_PATH];
  const merged = [];
  const seenIds = new Set();

  const pushUnique = (record) => {
    if (!record || typeof record !== 'object') return;
    const id = record.ID || record.ID1 || record.id;
    const key = id ? String(id) : JSON.stringify(record);
    if (seenIds.has(key)) return;
    seenIds.add(key);
    merged.push(record);
  };

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = safeParseJsonFile(fs, filePath);
      const records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
      if (records.length > 0) {
        for (const record of records) {
          pushUnique(record);
        }
        console.log(`📦 Cache propriétés chargé depuis ${path.basename(filePath)} (${records.length} éléments)`);
      }
    } catch (err) {
      console.warn(`⚠️ Impossible de lire le cache propriétés ${path.basename(filePath)}: ${err.message}`);
    }
  }

  if (merged.length > 0) {
    console.log(`📦 Cache propriétés fusionné (${merged.length} éléments uniques)`);
  }
  return merged;
}

function persistPropertiesCache(properties) {
  if (!Array.isArray(properties) || properties.length === 0) return;
  try {
    const existing = loadCachedProperties();
    const combined = [];
    const seenIds = new Set();

    const pushUnique = (record) => {
      if (!record || typeof record !== 'object') return;
      const id = record.ID || record.ID1 || record.id;
      const key = id ? String(id) : JSON.stringify(record);
      if (seenIds.has(key)) return;
      seenIds.add(key);
      combined.push(record);
    };

    for (const record of existing) {
      pushUnique(record);
    }
    for (const record of properties) {
      pushUnique(record);
    }

    fs.writeFileSync(PROPERTIES_CACHE_PATH, JSON.stringify(combined, null, 2), 'utf8');
  } catch (err) {
    console.warn(`⚠️ Échec écriture cache propriétés: ${err.message}`);
  }
}

function appendPropertyToCache(property) {
  if (!property || typeof property !== 'object') return;
  try {
    const existing = loadCachedProperties();
    const id = property.ID || property.ID1 || property.id;
    const key = id ? String(id) : null;

    const filtered = existing.filter((item) => {
      const itemId = item?.ID || item?.ID1 || item?.id;
      return key ? String(itemId) !== key : true;
    });

    const merged = [property, ...filtered];
    fs.writeFileSync(PROPERTIES_CACHE_PATH, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn(`⚠️ Échec mise à jour cache propriété créée: ${err.message}`);
  }
}

function loadCachedUsers() {
  try {
    if (!fs.existsSync(USERS_CACHE_PATH)) return [];
    const parsed = safeParseJsonFile(fs, USERS_CACHE_PATH);
    const users = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
    return users
      .map(normalizeUserRecord)
      .filter(Boolean);
  } catch (err) {
    console.warn(`⚠️ Impossible de lire le cache utilisateurs: ${err.message}`);
    return [];
  }
}

function persistUsersCache(users) {
  if (!Array.isArray(users)) return;

  const existing = loadCachedUsers();
  const merged = [];
  const seenEmails = new Set();

  const pushUnique = (user) => {
    const normalized = normalizeUserRecord(user);
    if (!normalized) return;
    const key = normalized.Email.toLowerCase();
    if (seenEmails.has(key)) return;
    seenEmails.add(key);
    merged.push(normalized);
  };

  for (const user of users) {
    pushUnique(user);
  }
  for (const user of existing) {
    pushUnique(user);
  }

  try {
    fs.writeFileSync(USERS_CACHE_PATH, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn(`⚠️ Échec écriture cache utilisateurs: ${err.message}`);
  }
}

function inferFallbackUserIdFromCache() {
  if (FALLBACK_USER_ID) return FALLBACK_USER_ID;

  const cachedProperties = loadCachedProperties();
  for (const property of cachedProperties) {
    const userId = property?.User?.ID || property?.User?.id || null;
    if (userId) return String(userId);
  }

  return `offline-${Date.now()}`;
}

function isZohoLimitError(error) {
  const msg = String(error?.message || error || '');
  return /developer api limit has been reached/i.test(msg) || /limite api/i.test(msg);
}

function isZohoValidationError(error) {
  const msg = String(error?.message || error || '');
  return /invalid column value/i.test(msg) || /invalid value/i.test(msg) || /required value missing/i.test(msg);
}

function isDnsResolutionError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '');
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo\s+(ENOTFOUND|EAI_AGAIN)/i.test(message);
}

function isOfflineZohoError(error) {
  if (!error) return false;

  const code = String(error?.code || '').toUpperCase();
  const type = String(error?.type || '').toLowerCase();
  const message = String(error?.message || '');

  return (
    isDnsResolutionError(error) ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    type === 'request-timeout' ||
    /network timeout/i.test(message) ||
    type === 'system'
  );
}

function findCachedPropertyById(recordId) {
  const target = String(recordId || '').trim();
  if (!target) return null;

  const cached = loadCachedProperties();
  for (const property of cached) {
    const id = String(property?.ID || '').trim();
    const id1 = String(property?.ID1 || '').trim();
    if (id === target || id1 === target) {
      return enrichPropertyWithImage(property);
    }
  }

  return null;
}

// 🔄 Fonction pour renouveler le token avec retry
async function refreshAccessToken() {
  if (Date.now() < oauthCooldownUntil) {
    return false;
  }

  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    // Avoid hammering OAuth endpoint when many requests arrive together.
    if (Date.now() - lastSuccessfulRefreshAt < 10000) {
      return true;
    }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🔄 Renouvellement du token - Tentative ${attempt}/3...`);
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30 secondes de timeout

      const response = await fetch(ZOHO_OAUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
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
        const errorText = await response.text();
        if (response.status === 400 && /too many requests continuously/i.test(errorText)) {
          // Back off when Zoho throttles refresh calls.
          oauthCooldownUntil = Date.now() + (2 * 60 * 1000);
        }
        throw new Error(`Erreur OAuth: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      
      if (data.access_token) {
        ZOHO_ACCESS_TOKEN = data.access_token;
        const expiresIn = Number(data.expires_in || data.expires_in_sec || 3600);
        tokenExpiresAt = new Date(Date.now() + (expiresIn * 1000));
        lastSuccessfulRefreshAt = Date.now();
        console.log(`✅ Token renouvelé ! Expire à: ${tokenExpiresAt.toLocaleTimeString()}`);
        return true;
      } else {
        throw new Error('Pas de token dans la réponse Zoho');
      }
    } catch (error) {
      lastError = error;
      if (!shouldRetryAfterZohoFailure(error)) {
        break;
      }
      console.error(`❌ Tentative ${attempt}/3 échouée:`, error.message);
      if (Date.now() < oauthCooldownUntil) {
        break;
      }
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 secondes avant retry
      }
    }
  }
  console.error("❌ Impossible de renouveler le token après 3 tentatives:", lastError);
  return false;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

// ✅ Vérifier et renouveler le token si nécessaire
async function ensureValidToken() {
  const now = new Date();
  const timeUntilExpire = tokenExpiresAt - now;

  // Refresh only when needed, otherwise keep requests fast.
  if (timeUntilExpire < 2 * 60 * 1000) {
    console.log("⏰ Token expire bientôt, renouvellement...");
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      // Do not fail hard here; requests can still succeed if token is still accepted.
      console.warn('⚠️ Renouvellement token indisponible temporairement, on continue avec le token actuel.');
    }
  }
}
function extractImageUrlFromValue(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractImageUrlFromValue(item);
      if (candidate) return candidate;
    }
    return null;
  }

  if (typeof value === 'object') {
    const direct = value.download_url || value.url || value.content || value.display_value || value.zc_display_value;
    if (typeof direct === 'string' && direct.trim()) {
      return direct;
    }

    for (const [key, nested] of Object.entries(value)) {
      if (/(image|photo|file|pic)/i.test(key)) {
        const candidate = extractImageUrlFromValue(nested);
        if (candidate) return candidate;
      }
    }
  }

  return null;
}

function extractImageUrlFromProperty(property) {
  if (!property || typeof property !== 'object') return null;

  for (const key of IMAGE_FIELD_CANDIDATES) {
    if (Object.prototype.hasOwnProperty.call(property, key)) {
      const candidate = extractImageUrlFromValue(property[key]);
      if (candidate) return candidate;
    }
  }

  for (const [key, value] of Object.entries(property)) {
    if (/(image|photo|file|pic)/i.test(key)) {
      const candidate = extractImageUrlFromValue(value);
      if (candidate) return candidate;
    }
  }

  return null;
}

function normalizeZohoMediaUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  if (rawUrl.startsWith('data:image/')) {
    return rawUrl;
  }

  const isLocalImageApi = rawUrl.startsWith('/api/property-image/') || rawUrl.startsWith('/api/media?');

  if (rawUrl.startsWith('/uploads/') || isLocalImageApi) {
    return rawUrl;
  }

  if (rawUrl.startsWith('/')) {
    return `https://creator.zoho.com${rawUrl}`;
  }

  try {
    const parsed = new URL(rawUrl);
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function buildImageProxyUrl(rawUrl) {
  const normalized = normalizeZohoMediaUrl(rawUrl);
  if (!normalized) return null;

  const isLocalImageApi = normalized.startsWith('/api/property-image/') || normalized.startsWith('/api/media?');

  if (normalized.startsWith('data:image/') || normalized.startsWith('/uploads/') || isLocalImageApi) {
    return normalized;
  }

  try {
    const parsed = new URL(normalized);
    const isZohoHost = ZOHO_MEDIA_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));

    if (!isZohoHost) {
      return normalized;
    }

    return `/api/media?url=${encodeURIComponent(parsed.toString())}`;
  } catch (_) {
    return null;
  }
}

function enrichPropertyWithImage(property) {
  if (!property || typeof property !== 'object') return property;

  const imageUrl = extractImageUrlFromProperty(property) || resolveLocalImageForProperty(property);
  if (imageUrl) {
    const imageProxyUrl = buildImageProxyUrl(imageUrl);
    return {
      ...property,
      image_url: imageUrl,
      image_proxy_url: imageProxyUrl || imageUrl
    };
  }

  // No local image — point to Zoho download proxy (lazy fetch + cache)
  const recordId = property?.ID;
  if (recordId) {
    const zohoProxy = `/api/property-image/${recordId}`;
    return {
      ...property,
      image_url: zohoProxy,
      image_proxy_url: zohoProxy
    };
  }

  return property;
}

function resolveLocalImageForProperty(property) {
  const recordId = property?.ID || property?.ID1;
  if (!recordId) return null;

  const extensions = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
  for (const ext of extensions) {
    const fileName = `property-${recordId}.${ext}`;
    const filePath = path.join(LOCAL_UPLOADS_DIR, fileName);
    if (fs.existsSync(filePath)) {
      return `/uploads/${fileName}`;
    }
  }

  return null;
}

function saveLocalPropertyImage(recordId, imageDataUrl, imageIndex = null) {
  const parsedImage = parseDataUrlImage(imageDataUrl);
  if (!parsedImage || !recordId) {
    return null;
  }

  fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
  const suffix = (typeof imageIndex === 'number' && imageIndex > 1) ? `-${imageIndex}` : '';
  const fileName = `property-${recordId}${suffix}.${parsedImage.extension}`;
  const targetPath = path.join(LOCAL_UPLOADS_DIR, fileName);
  fs.writeFileSync(targetPath, parsedImage.buffer);
  return `/uploads/${fileName}`;
}

function parseDataUrlImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;

  const mimeType = match[1].toLowerCase();
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');

  const extensionByMime = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp'
  };

  const extension = extensionByMime[mimeType] || 'jpg';
  return { buffer, mimeType, extension };
}

function extractCreatedRecordId(createData) {
  if (!createData) return null;

  const candidateObjects = [];
  if (createData.data) candidateObjects.push(createData.data);
  if (Array.isArray(createData.result)) candidateObjects.push(...createData.result);

  for (const obj of candidateObjects) {
    if (!obj) continue;
    if (typeof obj === 'string') continue;

    if (Array.isArray(obj) && obj.length > 0) {
      const first = obj[0];
      if (first?.ID) return first.ID;
      if (first?.id) return first.id;
      if (first?.data?.ID) return first.data.ID;
    }

    if (obj.ID) return obj.ID;
    if (obj.id) return obj.id;
    if (obj.data?.ID) return obj.data.ID;
    if (obj.result?.ID) return obj.result.ID;
  }

  return null;
}

function normalizePropertyType(type) {
  if (!type || typeof type !== 'string') return type;

  const normalized = type.trim().toLowerCase();
  if (normalized === 'location') return 'To Rent';
  if (normalized === 'vente') return 'For Sale';
  return type;
}

async function uploadPropertyImageToZoho(recordId, imageDataUrl) {
  const parsedImage = parseDataUrlImage(imageDataUrl);
  if (!parsedImage) {
    return { uploaded: false, reason: 'Le format image n\'est pas un data URL supporté' };
  }

  // Use the confirmed field directly if already known; otherwise probe only 2 candidates.
  let fieldCandidates;
  if (preferredImageUploadField) {
    fieldCandidates = [preferredImageUploadField];
  } else if (Array.isArray(detectedImageCustomFields) && detectedImageCustomFields.length > 0) {
    fieldCandidates = [detectedImageCustomFields[0], 'Image'].filter((v, i, a) => a.indexOf(v) === i);
  } else {
    fieldCandidates = ['Image', 'image'];
  }

  for (const fieldName of fieldCandidates) {
    const uploadUrl = `${ZOHO_V21_REPORT_URL}/${encodeURIComponent(recordId)}/${encodeURIComponent(fieldName)}/upload`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const formData = new FormData();
      formData.append('file', parsedImage.buffer, {
        filename: `property-${recordId}.${parsedImage.extension}`,
        contentType: parsedImage.mimeType
      });

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`,
          ...formData.getHeaders()
        },
        body: formData
      });

      const responseText = await response.text();
      let parsedBody = null;
      try {
        parsedBody = responseText ? JSON.parse(responseText) : null;
      } catch (_) {
        parsedBody = null;
      }

      if ((response.status === 401 || response.status === 403) && attempt < 2) {
        await refreshAccessToken();
        continue;
      }

      if (response.ok) {
        if (parsedBody && parsedBody.code && parsedBody.code !== 3000) {
          if (parsedBody.code === 3710 || /no field named/i.test(parsedBody.message || '')) {
            break;
          }

          return {
            uploaded: false,
            reason: `Upload échoué (${parsedBody.code})`,
            details: responseText
          };
        }

        preferredImageUploadField = fieldName;
        if (!Array.isArray(detectedImageCustomFields)) {
          detectedImageCustomFields = [];
        }
        if (!detectedImageCustomFields.includes(fieldName)) {
          detectedImageCustomFields.unshift(fieldName);
        }
        console.log(`🔒 Champ image Zoho verrouillé sur: ${fieldName}`);

        return {
          uploaded: true,
          fieldName,
          response: parsedBody
        };
      }

      // 400/404 are expected for wrong field link names, so we continue probing.
      if (response.status !== 400 && response.status !== 404) {
        return {
          uploaded: false,
          reason: `Upload échoué (${response.status})`,
          details: responseText
        };
      }
    }
  }

  return {
    uploaded: false,
    reason: 'Aucun champ image compatible trouvé pour upload API'
  };
}

async function fetchZohoV21CustomRecords({ fields, maxRecords = 200, criteria = null }) {
  const clampedMaxRecords = [200, 500, 1000].includes(maxRecords) ? maxRecords : 200;
  const fieldHeaderValue = Array.isArray(fields) ? fields.join(',') : String(fields || '').trim();
  const params = new URLSearchParams({
    field_config: 'custom',
    max_records: String(clampedMaxRecords)
  });

  if (!fieldHeaderValue) {
    return [];
  }

  params.set('fields', fieldHeaderValue);

  if (criteria) {
    params.set('criteria', criteria);
  }

  const url = `${ZOHO_V21_REPORT_URL}?${params.toString()}`;

  await ensureValidToken();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`,
          'accept': 'application/json'
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if ((response.status === 401 || response.status === 403) && attempt < 2) {
      await refreshAccessToken();
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Zoho v2.1 custom fields error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    if (isZohoLimitPayload(data)) {
      throw new Error('Developer API limit has been reached');
    }
    return data.data || [];
  }

  return [];
}

async function detectImageCustomFields(sampleRecordId) {
  if (detectedImageCustomFields !== null && isImageMetadataFresh(detectedImageCustomFieldsAt)) {
    return detectedImageCustomFields;
  }

  if (!sampleRecordId) {
    detectedImageCustomFields = [];
    detectedImageCustomFieldsAt = Date.now();
    return detectedImageCustomFields;
  }

  const detected = [];
  const probeCandidates = IMAGE_FIELD_CANDIDATES.slice(0, 6);

  for (const fieldName of probeCandidates) {
    try {
      const records = await fetchZohoV21CustomRecords({
        fields: ['ID', fieldName],
        maxRecords: 200,
        criteria: `ID==${sampleRecordId}`
      });

      const record = records[0];
      if (record && Object.prototype.hasOwnProperty.call(record, fieldName)) {
        detected.push(fieldName);
        if (detected.length >= 2) {
          break;
        }
      }
    } catch (_) {
      // Ignore invalid field names and keep probing others.
    }
  }

  detectedImageCustomFields = detected;
  detectedImageCustomFieldsAt = Date.now();
  if (!preferredImageUploadField && detectedImageCustomFields.length > 0) {
    preferredImageUploadField = detectedImageCustomFields[0];
    console.log(`🔒 Champ image Zoho détecté et verrouillé: ${preferredImageUploadField}`);
  }
  return detectedImageCustomFields;
}

async function fetchImageFieldMap(maxRecords, sampleRecordId) {
  const cacheKey = JSON.stringify({ maxRecords, sampleRecordId: sampleRecordId || null });
  const cachedMapEntries = getTimedCacheEntry(imageFieldMapCache, cacheKey, IMAGE_FIELDS_TTL_MS);
  if (cachedMapEntries) {
    return new Map(cachedMapEntries);
  }

  const validImageFields = await detectImageCustomFields(sampleRecordId);
  if (!validImageFields.length) {
    return new Map();
  }

  const records = await fetchZohoV21CustomRecords({
    fields: ['ID', ...validImageFields],
    maxRecords
  });

  const byId = new Map();
  for (const record of records) {
    const id = record.ID;
    if (!id) continue;
    byId.set(id, record);
  }

  setTimedCacheEntry(imageFieldMapCache, cacheKey, Array.from(byId.entries()));

  return byId;
}

async function fetchMetadataImageFieldCandidates() {
  if (Array.isArray(metadataImageFieldCandidates) && isImageMetadataFresh(metadataImageFieldCandidatesAt)) {
    return metadataImageFieldCandidates;
  }

  await ensureValidToken();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(ZOHO_V21_FIELDS_URL, {
        method: 'GET',
        headers: {
          'Authorization': `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`,
          'accept': 'application/json'
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if ((response.status === 401 || response.status === 403) && attempt < 2) {
      await refreshAccessToken();
      continue;
    }

    if (!response.ok) {
      metadataImageFieldCandidates = [];
      metadataImageFieldCandidatesAt = Date.now();
      return metadataImageFieldCandidates;
    }

    const data = await response.json();
    const fields = Array.isArray(data.fields) ? data.fields : [];
    const candidates = fields
      .filter((f) => /(image|photo|file|pic)/i.test(String(f?.link_name || '')) || /(image|photo|file|pic)/i.test(String(f?.display_name || '')))
      .map((f) => f.link_name)
      .filter(Boolean);

    metadataImageFieldCandidates = [...new Set(candidates)];
    metadataImageFieldCandidatesAt = Date.now();
    return metadataImageFieldCandidates;
  }

  metadataImageFieldCandidates = [];
  metadataImageFieldCandidatesAt = Date.now();
  return metadataImageFieldCandidates;
}

async function fetchPublishedImageValue(recordId) {
  const publishUrl = buildZohoPublishRecordUrl(recordId);
  if (!publishUrl) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(publishUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const data = payload?.data;
    if (!data || typeof data !== 'object') {
      return null;
    }

    for (const key of IMAGE_FIELD_CANDIDATES) {
      if (Object.prototype.hasOwnProperty.call(data, key) && data[key]) {
        return data[key];
      }
    }

    for (const [key, value] of Object.entries(data)) {
      if (/(image|photo|file|pic)/i.test(key) && value) {
        return value;
      }
    }
  } catch (error) {
    console.warn(`⚠️ Publish API image fallback indisponible pour ${recordId}: ${error.message}`);
  }

  return null;
}

// ✅ Fetch a single Zoho Creator Property record by ID
async function fetchZohoPropertyRecord(recordId) {
  await ensureValidToken();

  const endpoints = [
    `${ZOHO_V21_REPORT_URL}/${encodeURIComponent(recordId)}?field_config=all`,
    `${ZOHO_V2_REPORT_URL}/${encodeURIComponent(recordId)}`,
    `${ZOHO_V2_APP_REPORT_URL}/${encodeURIComponent(recordId)}`
  ];

  let lastError;

  for (const recordUrl of endpoints) {
    try {
      console.log(`📡 Tentative de récupération du détail de la propriété ${recordId} via ${recordUrl}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const isV21 = recordUrl.includes('/v2.1/');
      const response = await fetch(recordUrl, {
        method: 'GET',
        headers: {
          'Authorization': isV21 ? `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}` : `Bearer ${ZOHO_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (response.status === 404) {
        console.warn(`⚠️ Endpoint non trouvé: ${recordUrl}`);
        continue;
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.log("⚠️ Token invalide, tentative de renouvellement...");
          await refreshAccessToken();
          lastError = new Error(`Erreur Zoho: ${response.statusText} (${response.status})`);
          continue;
        }
        throw new Error(`Erreur Zoho: ${response.statusText} (${response.status})`);
      }

      const data = await response.json();
      if (isZohoLimitPayload(data)) {
        throw new Error('Developer API limit has been reached');
      }
      const record = data.data?.[0] || data.data || null;
      const enrichedRecord = enrichPropertyWithImage(record);
      setCachedPropertyDetail(recordId, enrichedRecord);
      return enrichedRecord;
    } catch (error) {
      lastError = error;
      console.error(`❌ Échec sur ${recordUrl}:`, error.message);
      if (!shouldRetryAfterZohoFailure(error)) {
        break;
      }
    }
  }

  throw new Error(`Impossible de récupérer le détail de la propriété ${recordId}: ${lastError?.message || 'Erreur inconnue'}`);
}

app.get('/api/media', async (req, res) => {
  try {
    const requestedUrl = req.query.url;
    if (!requestedUrl || typeof requestedUrl !== 'string') {
      return res.status(400).json({ error: 'URL manquante' });
    }

    const normalized = normalizeZohoMediaUrl(requestedUrl);
    if (!normalized || normalized.startsWith('data:image/')) {
      return res.status(400).json({ error: 'URL media invalide' });
    }

    const parsed = new URL(normalized);
    const isZohoHost = ZOHO_MEDIA_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    if (!isZohoHost) {
      return res.status(400).json({ error: 'Host media non autorisé' });
    }

    await ensureValidToken();

    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetch(parsed.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${ZOHO_ACCESS_TOKEN}`
        }
      });

      if ((response.status === 401 || response.status === 403) && attempt < 2) {
        await refreshAccessToken();
        continue;
      }

      if (!response.ok) {
        return res.status(response.status).json({
          error: `Impossible de charger le media (${response.status})`
        });
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const cacheControl = response.headers.get('cache-control') || 'public, max-age=300';
      const fileBuffer = await response.buffer();

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', cacheControl);
      return res.send(fileBuffer);
    }

    return res.status(500).json({ error: 'Erreur inconnue de récupération media' });
  } catch (error) {
    console.error('Erreur /api/media:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ✅ Zoho property image proxy (with local cache)
app.get('/api/property-image/:recordId', async (req, res) => {
  try {
    const { recordId } = req.params;
    if (!recordId || !/^[0-9]+$/.test(recordId)) {
      return res.status(400).json({ error: 'Record ID invalide' });
    }

    // 1. Check local cache first
    const extensions = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
    for (const ext of extensions) {
      const fileName = `property-${recordId}.${ext}`;
      const filePath = path.join(LOCAL_UPLOADS_DIR, fileName);
      if (fs.existsSync(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(filePath);
      }
    }

    // 2. Try Zoho download API with multiple field candidates (Image/image/Photo...)
    await ensureValidToken();
    const publishedImageValue = await fetchPublishedImageValue(recordId);
    const publishedFilepaths = [];
    if (publishedImageValue && typeof publishedImageValue === 'object') {
      const valueList = Array.isArray(publishedImageValue) ? publishedImageValue : [publishedImageValue];
      for (const item of valueList) {
        if (item && typeof item === 'object' && typeof item.filepath === 'string' && item.filepath.trim()) {
          publishedFilepaths.push(item.filepath.trim());
        }
      }
    }

    const metadataCandidates = await fetchMetadataImageFieldCandidates();
    const candidateFields = [
      preferredImageUploadField,
      ...(Array.isArray(detectedImageCustomFields) ? detectedImageCustomFields : []),
      ...(Array.isArray(metadataCandidates) ? metadataCandidates : []),
      ...IMAGE_FIELD_CANDIDATES
    ].filter(Boolean);
    const uniqueFields = [...new Set(candidateFields)];

    for (const fieldName of uniqueFields) {
      const filepathCandidates = publishedFilepaths.length ? publishedFilepaths : [''];

      for (const filepathValue of filepathCandidates) {
        const downloadUrl = new URL(`${ZOHO_V21_REPORT_URL}/${encodeURIComponent(recordId)}/${encodeURIComponent(fieldName)}/download`);
        if (filepathValue) {
          downloadUrl.searchParams.set('filepath', filepathValue);
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
          const response = await fetch(downloadUrl.toString(), {
          method: 'GET',
          headers: {
            'Authorization': `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`,
            'accept': 'application/json'
          }
        });

        if ((response.status === 401 || response.status === 403) && attempt < 2) {
          await refreshAccessToken();
          continue;
        }

          if (!response.ok) {
            // Wrong field link names are expected here, keep trying.
            break;
          }

          const contentType = response.headers.get('content-type') || 'image/jpeg';
          // Only cache if it's actually an image.
          if (!contentType.startsWith('image/')) {
            const asText = await response.text();
            if (/filepath is mandatory/i.test(asText) && !filepathValue) {
              break;
            }
            break;
          }

          const buffer = await response.buffer();

          // Save locally for future requests
          try {
            const extMatch = contentType.match(/image\/([a-z0-9]+)/i);
            let ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
            if (ext === 'jpeg') ext = 'jpg';
            fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
            const fileName = `property-${recordId}.${ext}`;
            fs.writeFileSync(path.join(LOCAL_UPLOADS_DIR, fileName), buffer);
            console.log(`[image-cache] Saved Zoho image (${fieldName}): ${fileName}`);
          } catch (saveErr) {
            console.warn('[image-cache] Could not save locally:', saveErr.message);
          }

          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.send(buffer);
        }
      }
    }

    return res.status(404).end();
  } catch (error) {
    console.error('Erreur /api/property-image:', error);
    return res.status(500).end();
  }
});

// ✅ Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const normalizedEmail = String(email).trim();
    const cachedUser = findUserByEmail(loadCachedUsers(), normalizedEmail);
    if (cachedUser && cachedUser.Password === password && isUsersCacheFresh()) {
      console.log(`Login servi depuis le cache utilisateurs pour ${normalizedEmail}`);
      return createUserSession(req, res, cachedUser, { source: 'cache' });
    }

    try {
      const { payload } = await fetchZohoJson(buildUsersReportUrl(), {
        authType: 'bearer',
        timeoutMs: 30000,
        retries: 3,
        fallbackMessage: 'Erreur Zoho utilisateurs'
      });

      const users = payload.data || [];
      const sourceUsers = (isZohoLimitPayload(payload) || users.length === 0) ? loadCachedUsers() : users;
      if (users.length > 0) {
        persistUsersCache(users);
      }

      const user = findUserByEmail(sourceUsers, normalizedEmail);
      if (!user || user.Password !== password) {
        return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      }

      return createUserSession(req, res, user, {
        source: sourceUsers === users ? 'zoho' : 'cache'
      });
    } catch (error) {
      console.error('❌ Login Zoho indisponible:', error.message);

      if (!ALLOW_OFFLINE_LOGIN) {
        return res.status(503).json({
          error: `Service temporairement indisponible: ${error.message}`,
          details: 'Vérifiez votre connexion internet ou réessayez dans quelques instants'
        });
      }

      const fallbackUser = cachedUser || {
        ID: inferFallbackUserIdFromCache(),
        Email: normalizedEmail,
        Password: String(password),
        Phone_Number: '',
        full_name: normalizedEmail
      };

      if (fallbackUser.Password !== password) {
        return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      }

      persistUsersCache([fallbackUser]);
      return createUserSession(req, res, fallbackUser, {
        source: 'cache',
        warning: 'Connexion en mode secours local (API Zoho limitée).'
      });
    }
  } catch (error) {
    console.error('Erreur login:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Logout endpoint (POST)
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Erreur lors de la déconnexion' });
    }
    res.json({ success: true, message: 'Déconnexion réussie' });
  });
});

// ✅ Logout GET endpoint - for browser redirects
app.get('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Erreur logout:', err);
      return res.redirect('index.html');
    }
    console.log('✅ Utilisateur déconnecté');
    res.redirect('index.html');
  });
});

// ✅ Vérifier l'état de connexion
app.get('/api/auth-status', (req, res) => {
  if (req.session.userId) {
    res.json({
      loggedIn: true,
      user: {
        id: req.session.userId,
        email: req.session.userEmail,
        name: req.session.userName,
        role: req.session.userRole
      }
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// ✅ Signup endpoint
app.post('/api/signup', async (req, res) => {
  try {
    const { first_name, last_name, email, phone_number, password, confirm_password } = req.body;

    // Validation
    if (!first_name || !last_name || !email || !phone_number || !password || !confirm_password) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }

    const normalizedEmail = String(email).trim();
    if (isUsersCacheFresh()) {
      const cachedExistingUser = findUserByEmail(loadCachedUsers(), normalizedEmail);
      if (cachedExistingUser) {
        return res.status(409).json({ error: 'Cet email est déjà utilisé' });
      }
    }

    const { payload: checkData } = await fetchZohoJson(buildUsersReportUrl(), {
      authType: 'bearer',
      timeoutMs: 30000,
      retries: 3,
      fallbackMessage: 'Erreur lors de la vérification des utilisateurs'
    });

    const checkDataUsers = checkData.data || [];
    const checkLimitReached = isZohoLimitPayload(checkData);
    if (!checkLimitReached && checkDataUsers.length > 0) {
      persistUsersCache(checkDataUsers);
    }

    const existingUser = findUserByEmail(
      checkLimitReached ? loadCachedUsers() : checkDataUsers,
      normalizedEmail
    );

    if (existingUser) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }

    // Créer le nouvel utilisateur dans Zoho avec retry
    const formUrl = "https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/form/User";
    
    console.log("📝 Tentative de création d'utilisateur avec:", {
      first_name,
      last_name,
      email,
      phone_number
    });

    const requestBody = {
      data: {
        full_name: {
          first_name: first_name,
          last_name: last_name
        },
        Email: normalizedEmail,
        Phone_Number: phone_number,
        Password: password,
        Confirm_password: confirm_password
      }
    };

    console.log("📤 Corps de la requête:", JSON.stringify(requestBody, null, 2));

    const { response: createResponse, payload: createData } = await fetchZohoJson(formUrl, {
      method: 'POST',
      authType: 'bearer',
      body: requestBody,
      timeoutMs: 30000,
      retries: 3,
      requireSuccessCode: true,
      fallbackMessage: 'Erreur lors de la création du compte'
    });

    console.log("📌 Statut réponse:", createResponse.status);
    console.log("📌 Réponse Zoho création complète:", JSON.stringify(createData, null, 2));

    console.log(`✅ Nouvel utilisateur créé: ${normalizedEmail}`);
    
    // Créer une session pour l'utilisateur nouvellement inscrit
    req.session.userId = createData.data?.ID || createData.data?.id || Date.now().toString();
    req.session.userEmail = normalizedEmail;
    req.session.userName = `${first_name} ${last_name}`;

    persistUsersCache([
      {
        ID: req.session.userId,
        Email: normalizedEmail,
        Password: password,
        Phone_Number: phone_number,
        full_name: {
          first_name,
          last_name
        }
      }
    ]);
    
    res.json({ 
      success: true, 
      message: 'Compte créé avec succès! Redirection en cours...',
      user: {
        email: normalizedEmail,
        name: req.session.userName
      }
    });
  } catch (error) {
    console.error('Erreur signup:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Créer une propriété (protégé - requiert authentification)
app.post('/api/properties/create', requireAuth, async (req, res) => {
  try {
    const { title, description, price, location, address_line_1, address_line_2, city_district, type, floor, surface, bedrooms, bathrooms, year_built, status, image, images } = req.body;
    const hasDataUrlImage = typeof image === 'string' && image.startsWith('data:image/');
    const hasHttpImageUrl = typeof image === 'string' && /^https?:\/\//i.test(image);
    const dataUrlImages = [];
    const seenDataUrls = new Set();

    if (Array.isArray(images)) {
      for (const candidate of images) {
        if (typeof candidate === 'string' && candidate.startsWith('data:image/') && !seenDataUrls.has(candidate)) {
          seenDataUrls.add(candidate);
          dataUrlImages.push(candidate);
        }
      }
    }

    if (hasDataUrlImage && !seenDataUrls.has(image)) {
      seenDataUrls.add(image);
      dataUrlImages.push(image);
    }

    const normalizedType = normalizePropertyType(type);
    const formUrl = "https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/form/Property";
    const locationPayload = buildPropertyLocationPayload({ location, address_line_1, address_line_2, city_district });

    const requestBody = {
      data: {
        title: title,
        description: description || "",
        Price1: parseFloat(price),
        type_field: normalizedType,
        Rooms1: bedrooms ? parseInt(bedrooms) : null,
        Bathrooms1: bathrooms ? parseInt(bathrooms) : null,
        Surface1: surface ? parseInt(surface) : null,
        Floor: floor ? parseInt(floor) : null,
        Year_Built: year_built ? convertDateToZoho(year_built) : null,
        status: status,
        User: req.session.userId
      }
    };

    if (locationPayload) {
      requestBody.data.location = locationPayload;
    }

    if (hasHttpImageUrl) {
      requestBody.data.image = image;
      requestBody.data.Image = image;
    }

    console.log("📝 Tentative de création de propriété:", {
      title,
      location: locationPayload,
      price,
      type: normalizedType,
      hasImage: dataUrlImages.length > 0 || !!image,
      imageCount: dataUrlImages.length,
      imageMode: dataUrlImages.length > 0 ? 'upload-after-create' : (hasHttpImageUrl ? 'url' : 'none')
    });

    let createData;
    let creationError;
    try {
      console.log("🏠 Creating property...");
      const { response: createResponse, payload } = await fetchZohoJson(formUrl, {
        method: 'POST',
        authType: 'bearer',
        body: requestBody,
        timeoutMs: 30000,
        retries: 3,
        requireSuccessCode: true,
        fallbackMessage: 'Erreur lors de la création de la propriété'
      });
      createData = payload;
      console.log("📌 Statut réponse:", createResponse.status);
      console.log("📌 Réponse Zoho création COMPLÈTE:", JSON.stringify(createData, null, 2));
    } catch (error) {
      creationError = error;
      console.error(`❌ Property creation failed:`, error.message);
    }

    if (!createData) {
      if (isZohoLimitError(creationError)) {
        const localRecordId = `local-${Date.now()}`;

        const localImageUrls = [];
        for (let i = 0; i < dataUrlImages.length; i++) {
          const localUrl = saveLocalPropertyImage(localRecordId, dataUrlImages[i], i + 1);
          if (localUrl) localImageUrls.push(localUrl);
        }

        const localProperty = enrichPropertyWithImage({
          ID: localRecordId,
          ID1: localRecordId,
          title: title || 'Sans titre',
          description: description || '',
          Price1: price ? String(price) : '',
          status: status || 'Disponible',
          type_field: normalizedType || '',
          Rooms1: bedrooms ? String(bedrooms) : '',
          Bathrooms1: bathrooms ? String(bathrooms) : '',
          Surface1: surface ? String(surface) : '',
          Floor: floor ? String(floor) : '',
          Year_Built: year_built ? convertDateToZoho(year_built) : '',
          location: locationPayload || { address_line_1: '', address_line_2: '', district_city: '', display_value: '' },
          User: {
            ID: req.session.userId || inferFallbackUserIdFromCache(),
            display_value: req.session.userEmail || req.session.userName || 'offline-user'
          },
          Image: localImageUrls
        });

      appendPropertyToCache(localProperty);
      clearPropertiesResponseCache();
      setCachedPropertyDetail(localRecordId, localProperty);

      return res.status(201).json({
          success: true,
          localOnly: true,
          warning: 'Propriété enregistrée localement (limite API Zoho atteinte).',
          message: 'Propriété créée en mode local de secours.',
          data: { code: 3000, data: [localProperty] },
          imageUploads: localImageUrls.map((url, index) => ({ uploaded: true, imageIndex: index + 1, localImageUrl: url }))
        });
      }

      return res.status(503).json({ 
        error: `Property creation failed: ${creationError.message}`,
        details: 'Please check your connection and try again'
      });
    }

    let imageUploadResult = null;
    let imageUploads = [];
    if (dataUrlImages.length > 0) {
      const createdRecordId = extractCreatedRecordId(createData);
      if (createdRecordId) {
        for (let i = 0; i < dataUrlImages.length; i++) {
          const imageDataUrl = dataUrlImages[i];
          const imageIndex = i + 1;
          const localImageUrl = saveLocalPropertyImage(createdRecordId, imageDataUrl, imageIndex);
          const uploadResult = await uploadPropertyImageToZoho(createdRecordId, imageDataUrl);
          const resultWithMetadata = {
            ...(uploadResult || {}),
            imageIndex
          };

          if (localImageUrl) {
            resultWithMetadata.localImageUrl = localImageUrl;
          }

          imageUploads.push(resultWithMetadata);

          if (!uploadResult.uploaded) {
            console.warn(`⚠️ Propriété créée mais image ${imageIndex} non uploadée: ${uploadResult.reason || 'raison inconnue'}`);
          } else {
            console.log(`✅ Image ${imageIndex} uploadée avec succès sur le champ ${uploadResult.fieldName}`);
          }
        }

        imageUploadResult = imageUploads[0] || null;
      } else {
        imageUploadResult = {
          uploaded: false,
          reason: 'Impossible de trouver l\'ID du record créé pour uploader l\'image'
        };
        imageUploads = [imageUploadResult];
        console.warn('⚠️ Propriété créée sans image: ID record introuvable dans la réponse Zoho');
      }
    }

    console.log(`✅ Propriété créée: ${title}`);

    const createdRecordId = extractCreatedRecordId(createData);
    if (createdRecordId) {
      const createdPropertyForCache = enrichPropertyWithImage({
        ID: String(createdRecordId),
        ID1: String(createdRecordId),
        title: title || 'Sans titre',
        description: description || '',
        Price1: price ? String(price) : '',
        status: status || 'Disponible',
        type_field: normalizedType || '',
        Rooms1: bedrooms ? String(bedrooms) : '',
        Bathrooms1: bathrooms ? String(bathrooms) : '',
        Surface1: surface ? String(surface) : '',
        Floor: floor ? String(floor) : '',
        Year_Built: year_built ? convertDateToZoho(year_built) : '',
        location: locationPayload || { address_line_1: '', address_line_2: '', district_city: '', display_value: '' },
        Image: (Array.isArray(imageUploads) && imageUploads.length > 0)
          ? imageUploads
              .map((item) => item?.localImageUrl)
              .filter(Boolean)
          : []
      });

      appendPropertyToCache(createdPropertyForCache);
      clearPropertiesResponseCache();
      setCachedPropertyDetail(createdRecordId, createdPropertyForCache);
    }

    res.json({ 
      success: true, 
      message: 'Propriété créée avec succès!',
      data: createData,
      imageUpload: imageUploadResult,
      imageUploads
    });
  } catch (error) {
    console.error('Erreur création propriété:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/properties', async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] GET /api/properties called`);
    const limit = parseInt(req.query.limit, 10);
    const hasLimit = !Number.isNaN(limit) && limit > 0;
    const requestedRecords = hasLimit ? Math.min(Math.max(limit, 1), 200) : 200;
    const includeImages = req.query.includeImages === 'true';
    const cacheKey = buildPropertiesCacheKey({ limit: hasLimit ? limit : null, includeImages });
    const cachedResponse = getCachedPropertiesResponse(cacheKey);

    if (cachedResponse) {
      console.log(`📦 Réponse /api/properties servie depuis le cache mémoire (${cacheKey})`);
      return res.json(cachedResponse);
    }

    await ensureValidToken();

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`📡 Récupération des propriétés - Tentative ${attempt}/2...`);
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000); // 15 secondes

        const zohoListUrl = buildZohoV21ReportUrl({ fieldConfig: 'all', maxRecords: requestedRecords });

        const response = await fetch(zohoListUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Zoho-oauthtoken ${ZOHO_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            console.log("⚠️ Token invalide, tentative de renouvellement...");
            const refreshed = await refreshAccessToken();
            if (!refreshed) {
              throw new Error('Token Zoho invalide et renouvellement temporairement bloqué. Réessayez dans 2 minutes.');
            }
            lastError = new Error(`Zoho a refusé le token (${response.status})`);
            continue; // Retry with new token
          }
          throw new Error(`Erreur Zoho: ${response.statusText} (${response.status})`);
        }

        const data = await response.json();
        let properties = (data.data || []).map(enrichPropertyWithImage);

        const zohoLimitReached =
          Number(data?.code) === 4000 ||
          /developer api limit has been reached/i.test(String(data?.message || ''));

        if (zohoLimitReached && properties.length === 0) {
          const cachedProperties = loadCachedProperties().map(enrichPropertyWithImage);
          if (cachedProperties.length > 0) {
            const limitedCached = hasLimit ? cachedProperties.slice(0, limit) : cachedProperties;
            console.warn(`⚠️ Zoho limit atteinte, fallback cache utilisé (${limitedCached.length} éléments)`);
            return res.json({
              code: 3000,
              source: 'cache',
              warning: 'Zoho API limit reached - serving cached properties',
              data: limitedCached
            });
          }
        }

        if (includeImages && properties.length > 0) {
          try {
            const sampleRecordId = properties[0]?.ID || properties[0]?.ID1;
            const imageFieldMap = await fetchImageFieldMap(requestedRecords, sampleRecordId);
            if (imageFieldMap.size > 0) {
              properties = properties.map((property) => {
                const id = property.ID || property.ID1;
                const imageFieldsRecord = imageFieldMap.get(id);
                if (!imageFieldsRecord) return property;
                return enrichPropertyWithImage({ ...property, ...imageFieldsRecord });
              });
            }
          } catch (imgErr) {
            console.warn(`⚠️ Enrichissement image custom ignoré: ${imgErr.message}`);
          }
        }

        if (hasLimit) {
          properties = properties.slice(0, limit);
        }

        if (properties.length > 0) {
          persistPropertiesCache(properties);
          for (const property of properties) {
            const propertyId = property?.ID || property?.ID1;
            if (propertyId) {
              setCachedPropertyDetail(propertyId, property);
            }
          }
        }

        const result = { ...data, data: properties };
        setCachedPropertiesResponse(cacheKey, result);
        console.log(`✅ Propriétés chargées: ${(result.data || []).length} éléments`);
        return res.json(result);

      } catch (error) {
        lastError = error;
        console.error(`❌ Tentative ${attempt}/2 échouée:`, error.message);
        
        if (attempt < 2 && shouldRetryAfterZohoFailure(error)) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    // Aucune tentative n'a réussi
    console.error("❌ Impossible de récupérer les propriétés après 2 tentatives:", lastError);
    if (isOfflineZohoError(lastError)) {
      const cachedProperties = loadCachedProperties().map(enrichPropertyWithImage);
      if (cachedProperties.length > 0) {
        const limit = parseInt(req.query.limit, 10);
        const hasLimit = !Number.isNaN(limit) && limit > 0;
        const fallbackProperties = hasLimit ? cachedProperties.slice(0, limit) : cachedProperties;

        console.warn(`⚠️ Zoho indisponible (${ZOHO_API_DOMAIN}), fallback cache utilisé (${fallbackProperties.length} éléments)`);
        return res.status(200).json({
          code: 3000,
          source: 'cache',
          warning: `Zoho indisponible via ${ZOHO_API_DOMAIN}; données servies depuis le cache local`,
          data: fallbackProperties
        });
      }
    }

    const errorMessage = lastError?.message || 'Réponse Zoho invalide après renouvellement du token';
    const dnsHint = isDnsResolutionError(lastError)
      ? ` Le domaine Zoho configuré est ${ZOHO_API_DOMAIN}. Si votre compte Zoho est sur une autre région, ajoutez ZOHO_API_DOMAIN dans .env.`
      : '';
    return res.status(503).json({ 
      error: `Erreur serveur Zoho: ${errorMessage}`,
      details: `Vérifiez votre connexion internet, votre DNS local, ou la région Zoho configurée.${dnsHint}`
    });

  } catch (error) {
    console.error('Erreur récupération propriétés:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Fetch a single property details including images
app.get('/api/properties/:id', async (req, res) => {
  try {
    const propertyId = req.params.id;
    if (!propertyId) {
      return res.status(400).json({ error: 'Property ID is required' });
    }

    const cachedProperty = getCachedPropertyDetail(propertyId);
    if (cachedProperty) {
      return res.json({ code: 3000, source: 'memory-cache', data: [cachedProperty] });
    }

    let property = null;
    try {
      property = await fetchZohoPropertyRecord(propertyId);
    } catch (fetchError) {
      console.warn(`⚠️ Détail Zoho indisponible pour ${propertyId}, fallback cache: ${fetchError.message}`);
    }

    if (!property) {
      property = findCachedPropertyById(propertyId);
    }

    if (!property) {
      return res.status(404).json({ error: `Property not found (${propertyId})` });
    }

    setCachedPropertyDetail(propertyId, property);
    return res.json({ code: 3000, data: [property] });
  } catch (error) {
    console.error(`Erreur récupération propriété ${req.params.id}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ✅ Créer une réservation (protégé - requiert authentification)
app.post('/api/reservations/create', requireAuth, async (req, res) => {
  try {
    const { property_id, property_title, start_date, end_date } = req.body;

    // Validation
    if (!property_id || !property_title || !start_date || !end_date) {
      return res.status(400).json({ error: 'Property ID, title et dates sont requis' });
    }

    // ✅ All business logic validation (date conflicts, etc.) handled by Zoho Creator workflows

    // Vérifier le token
    await ensureValidToken();

    const formUrl = "https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re/form/Reservation";

    const requestBody = {
      data: {
        Start_Date: convertDateToZoho(start_date),
        End_Date: convertDateToZoho(end_date),
        Duration_Text: `${Math.ceil((new Date(end_date) - new Date(start_date)) / (1000*60*60*24)) + 1} jours`,
        Status: "En attente",
        User: req.session.userId,
        Property1: property_id.toString()
      }
    };

    console.log("📝 Tentative de création de réservation:", {
      property_id,
      property_title,
      start_date,
      end_date,
      user: req.session.userId
    });

    console.log("📤 Corps de la requête Zoho:", JSON.stringify(requestBody, null, 2));

    // Create reservation with retry
    let createData;
    let creationError;
    let reservationSucceeded = false;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`📅 Creating reservation - Attempt ${attempt}/3...`);
        console.log(`🔗 URL: ${formUrl}`);
        console.log(`🔑 Token exists: ${!!ZOHO_ACCESS_TOKEN}`);
        console.log("📨 Sending request body:", JSON.stringify(requestBody, null, 2));
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const createResponse = await fetch(formUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ZOHO_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });

        clearTimeout(timeout);

        console.log(`📊 Response status: ${createResponse.status}`);
        console.log(`📊 Content-Type: ${createResponse.headers.get('content-type')}`);
        console.log("📊 All headers:", Array.from(createResponse.headers.entries()));

        const contentType = createResponse.headers.get('content-type');
        
        if (contentType && contentType.includes('application/json')) {
          createData = await createResponse.json();
          console.log("✅ Got JSON response");
        } else {
          const textResponse = await createResponse.text();
          console.error("❌ Non-JSON response from Zoho (Status: " + createResponse.status + ")");
          console.error("📄 Response text:", textResponse.substring(0, 1000));
          throw new Error(`Zoho returned non-JSON response. Status: ${createResponse.status}. Content-Type: ${contentType}. First 1000 chars: ${textResponse.substring(0, 1000)}`);
        }

        console.log("📌 Réponse Zoho réservation complète:", JSON.stringify(createData, null, 2));

        // Vérifier pour les erreurs
        // Code 3001 = form validation error from Zoho workflows
        if (!createResponse.ok || createData.error || (createData.code && createData.code !== 3000)) {
          
          if (createResponse.status === 401 || createResponse.status === 403) {
            console.log("⚠️ Token invalid, refreshing...");
            await refreshAccessToken();
            continue;
          }

          // Extract error message from nested Zoho error structure
          let errorMessage = 'Erreur lors de la création de la réservation';
          
          if (Array.isArray(createData.error) && createData.error.length > 0) {
            const errorObj = createData.error[0];
            if (errorObj.alert_message && Array.isArray(errorObj.alert_message)) {
              errorMessage = errorObj.alert_message[0]; // Get the alert message
            } else if (typeof errorObj === 'string') {
              errorMessage = errorObj;
            } else if (errorObj.message) {
              errorMessage = errorObj.message;
            }
          } else if (typeof createData.error === 'string') {
            errorMessage = createData.error;
          } else if (createData.details) {
            errorMessage = createData.details;
          } else if (createData.message) {
            errorMessage = createData.message;
          }

          throw new Error(errorMessage);
        }

        reservationSucceeded = true;
        break; // Success

      } catch (error) {
        creationError = error;
        console.error(`❌ Attempt ${attempt}/3 failed:`, error.message);
        
        if (attempt < 3 && shouldRetryAfterZohoFailure(error)) {
          const delayMs = Math.pow(2, attempt - 1) * 1000;
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    if (!reservationSucceeded) {
      return res.status(503).json({ 
        error: creationError.message,
        details: 'Please try again'
      });
    }

    console.log(`✅ Réservation créée pour la propriété: ${property_id}`);
    res.json({ 
      success: true, 
      message: 'Réservation créée avec succès!',
      data: createData
    });
  } catch (error) {
    console.error('Erreur création réservation:', error);
    res.status(500).json({ error: error.message });
  }
});

const DEFAULT_PORT = Number(process.env.PORT || 3000);

function startServer(port, retriesLeft = 5) {
  const server = app.listen(port, () => {
    console.log(`✅ Serveur lancé sur http://localhost:${port}`);
    console.log(`📍 Accédez à http://localhost:${port} pour voir vos propriétés immobilières`);
    console.log('🔐 Gestion automatique du token OAuth activée');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && retriesLeft > 0) {
      const nextPort = port + 1;
      console.warn(`⚠️ Port ${port} déjà utilisé, tentative sur le port ${nextPort}...`);
      return startServer(nextPort, retriesLeft - 1);
    }

    console.error('❌ Erreur serveur Node:', error);
  });

  return server;
}

startServer(DEFAULT_PORT);

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesse non gérée:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Exception non interceptée:', error);
});
