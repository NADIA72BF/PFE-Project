// Quick test for admin endpoints
const http = require('http');

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };

    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function test() {
  console.log('🧪 Testing admin endpoints...\n');

  try {
    console.log('1️⃣  GET /api/admin/users');
    const users = await makeRequest('GET', '/api/admin/users');
    console.log(`✅ Users endpoint: ${users.success ? 'OK' : 'FAILED'} - ${users.users ? users.users.length : 0} users\n`);

    console.log('2️⃣  POST /api/admin/users/add');
    const newUser = await makeRequest('POST', '/api/admin/users/add', {
      first_name: 'Test',
      last_name: 'User',
      email: 'test.user@example.com',
      phone_number: '+21655000000',
      password: 'TestPass123!',
      confirm_password: 'TestPass123!',
      role: 'User'
    });
    console.log('Response:', JSON.stringify(newUser, null, 2));
    console.log(`✅ Create user: ${newUser.success ? 'OK' : (newUser.error ? 'ERROR: ' + newUser.error : 'UNKNOWN')}\n`);
  } catch (err) {
    console.error('❌ Error:', err.message);
  }

  process.exit(0);
}

test();
