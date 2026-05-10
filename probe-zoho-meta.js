const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

function loadEnv(filePath) {
  const env = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return env;
}

async function probe() {
  const env = loadEnv(path.join(__dirname, '.env'));
  const token = env.ZOHO_ACCESS_TOKEN;
  if (!token) throw new Error('ZOHO_ACCESS_TOKEN missing');

  const urls = [
    'https://www.zohoapis.com/creator/v2/data/2demonexflow/gestion-immobili-re/meta',
    'https://www.zohoapis.com/creator/v2.1/data/2demonexflow/gestion-immobili-re/meta',
    'https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re/meta',
    'https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re/meta',
    'https://www.zohoapis.com/creator/v2/data/2demonexflow/gestion-immobili-re/form',
    'https://www.zohoapis.com/creator/v2/data/2demonexflow/gestion-immobili-re/report'
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` }
      });
      const text = await res.text();
      console.log('\nURL:', url);
      console.log('STATUS:', res.status);
      console.log(text.slice(0, 800));
    } catch (err) {
      console.log('\nURL:', url);
      console.log('ERROR:', err.message);
    }
  }
}

probe().catch((e) => {
  console.error('Probe failed:', e.message);
  process.exit(1);
});
