function loadEnvFile(fs, envPath) {
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function safeParseJsonFile(fs, filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const sanitized = raw.replace(/^\uFEFF/, '').replace(/^[\u0000-\u001F]+/, '').trim();
  return JSON.parse(sanitized);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractZohoErrorMessage(payload, fallbackMessage) {
  if (!payload || typeof payload !== 'object') return fallbackMessage;

  const toText = (value) => {
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const t = toText(item);
        if (t) return t;
      }
      return '';
    }
    if (value && typeof value === 'object') {
      if (Array.isArray(value.alert_message) && value.alert_message.length > 0) {
        const t = toText(value.alert_message[0]);
        if (t) return t;
      }
      if (value.message) {
        const t = toText(value.message);
        if (t) return t;
      }
      if (value.details) {
        const t = toText(value.details);
        if (t) return t;
      }
      if (value.error) {
        const t = toText(value.error);
        if (t) return t;
      }
    }
    return '';
  };

  return (
    toText(payload.error) ||
    toText(payload.details) ||
    toText(payload.message) ||
    fallbackMessage
  );
}

function buildPropertyLocationPayload({ location, address_line_1, address_line_2, city_district }) {
  const normalizedAddressLine1 = typeof address_line_1 === 'string' ? address_line_1.trim() : '';
  const normalizedAddressLine2 = typeof address_line_2 === 'string' ? address_line_2.trim() : '';
  const normalizedCityDistrict = typeof city_district === 'string' ? city_district.trim() : '';
  const normalizedLocationText = typeof location === 'string' ? location.trim() : '';
  const locationParts = [normalizedAddressLine1, normalizedAddressLine2, normalizedCityDistrict || normalizedLocationText].filter(Boolean);

  if (locationParts.length === 0) {
    return null;
  }

  return {
    address_line_1: normalizedAddressLine1,
    address_line_2: normalizedAddressLine2,
    district_city: normalizedCityDistrict || normalizedLocationText,
    display_value: locationParts.join(', ')
  };
}

function normalizeUserRecord(user) {
  if (!user || typeof user !== 'object') return null;
  const email = String(user.Email || user.email || '').trim();
  if (!email) return null;

  return {
    ID: user.ID || user.id || '',
    ID1: user.ID1 || user.id1 || user.User_ID || user.user_id || '',
    Email: email,
    Password: user.Password || user.password || '',
    Phone_Number: user.Phone_Number || user.phone_number || '',
    full_name: user.full_name || user.fullName || '',
    Role: user.Role || user.role || user.User_Role || ''
  };
}

function findUserByEmail(users, email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  return (users || []).find((user) => String(user?.Email || '').trim().toLowerCase() === target) || null;
}

function extractDisplayNameFromUser(user) {
  if (user?.full_name) {
    if (typeof user.full_name === 'object' && user.full_name.first_name) {
      return `${user.full_name.first_name} ${user.full_name.last_name || ''}`.trim();
    }
    if (typeof user.full_name === 'string') {
      return user.full_name;
    }
  }

  return user?.Email || user?.email || 'User';
}

function extractRoleFromUser(user) {
  const raw = user?.Role || user?.role || user?.User_Role || '';
  const value = typeof raw === 'object'
    ? String(raw.display_value || raw.zc_display_value || '').trim()
    : String(raw || '').trim();
  const lower = value.toLowerCase();

  if (lower === 'agent') return 'Agent';
  if (lower === 'administrator' || lower === 'admin') return 'Administrator';
  return 'User';
}

function createUserSession(req, res, user, extraPayload = {}) {
  const userId = user.ID || user.id;
  const userId1 = user.ID1 || user.id1 || user.User_ID || user.user_id || '';
  const userEmail = user.Email || user.email;
  const userName = extractDisplayNameFromUser(user);
  const userPhone = user.Phone_Number || user.phone_number || '';
  const userRole = extractRoleFromUser(user);

  req.session.regenerate((err) => {
    if (err) {
      console.error('Erreur regenerate session:', err);
      return res.status(500).json({ error: 'Erreur session' });
    }

    req.session.userId = userId;
    req.session.userId1 = userId1;
    req.session.userEmail = userEmail;
    req.session.userName = userName || userEmail || 'User';
    req.session.userPhone = userPhone;
    req.session.userRole = userRole;

    return res.json({
      success: true,
      message: 'Connexion réussie',
      user: {
        id: req.session.userId,
        id1: req.session.userId1,
        email: req.session.userEmail,
        name: req.session.userName,
        role: req.session.userRole
      },
      ...extraPayload
    });
  });
}

function convertDateToZoho(dateString) {
  if (!dateString) return null;

  const date = new Date(dateString);
  const day = String(date.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const year = date.getFullYear();

  return `${day}-${month}-${year}`;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentification requise', loggedIn: false });
  }
  next();
}

module.exports = {
  buildPropertyLocationPayload,
  convertDateToZoho,
  createUserSession,
  delay,
  extractDisplayNameFromUser,
  extractZohoErrorMessage,
  findUserByEmail,
  loadEnvFile,
  normalizeUserRecord,
  requireAuth,
  safeParseJsonFile,
  extractRoleFromUser
};
