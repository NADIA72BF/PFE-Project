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

async function testForm(base, formName, token) {
  const url = `${base}/form/${formName}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: {}, result: { message: true } })
    });
    const text = await res.text();
    return { url, status: res.status, body: text.slice(0, 300) };
  } catch (err) {
    return { url, status: 'ERR', body: err.message };
  }
}

async function run() {
  const env = loadEnv(path.join(__dirname, '.env'));
  const token = env.ZOHO_ACCESS_TOKEN;

  const bases = [
    'https://creator.zoho.com/api/v2/2demonexflow/gestion-immobili-re',
    'https://creatorapp.zoho.com/api/v2/2demonexflow/gestion-immobili-re'
  ];

  const forms = [
    'User',
    'Users',
    'All_Users',
    'Delete_User_Request',
    'Delete_User',
    'DeleteUserRequest',
    'delete_user_request',
    'Delete_Request',
    'User_Delete_Request'
  ];

  for (const base of bases) {
    console.log('\n=== BASE:', base, '===');
    for (const form of forms) {
      const r = await testForm(base, form, token);
      const okish = r.status !== 404;
      console.log(`${okish ? '[*]' : '[ ]'} ${form} -> ${r.status}`);
      if (okish) {
        console.log(`    ${r.body.replace(/\s+/g, ' ').slice(0, 180)}`);
      }
    }
  }
}

run().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
