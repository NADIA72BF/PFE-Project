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
  return (
    (Array.isArray(payload.error) ? payload.error[0] : payload.error) ||
    payload.details ||
    payload.message ||
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
    Email: email,
    Password: user.Password || user.password || '',
    Phone_Number: user.Phone_Number || user.phone_number || '',
    full_name: user.full_name || user.fullName || ''
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

function createUserSession(req, res, user, extraPayload = {}) {
  const userId = user.ID || user.id;
  const userEmail = user.Email || user.email;
  const userName = extractDisplayNameFromUser(user);
  const userPhone = user.Phone_Number || user.phone_number || '';

  req.session.regenerate((err) => {
    if (err) {
      console.error('Erreur regenerate session:', err);
      return res.status(500).json({ error: 'Erreur session' });
    }

    req.session.userId = userId;
    req.session.userEmail = userEmail;
    req.session.userName = userName || userEmail || 'User';
    req.session.userPhone = userPhone;

    return res.json({
      success: true,
      message: 'Connexion réussie',
      user: {
        id: req.session.userId,
        email: req.session.userEmail,
        name: req.session.userName
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
  safeParseJsonFile
};
