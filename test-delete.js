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
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function test() {
  console.log('🧪 Testing delete user endpoint...\n');

  try {
    // Get users first
    console.log('1️⃣  Getting users...');
    const { data: usersRes } = await makeRequest('GET', '/api/admin/users');
    if (!usersRes.users || usersRes.users.length === 0) {
      console.log('❌ No users found');
      process.exit(1);
    }
    const userToDelete = usersRes.users[0];
    console.log(`Found user: ${userToDelete.Email} (ID: ${userToDelete.ID})\n`);

    console.log('2️⃣  Deleting user...');
    const { status, data: deleteRes } = await makeRequest('POST', '/api/admin/users/delete', {
      ID1: userToDelete.ID
    });
    
    console.log(`Response status: ${status}`);
    console.log('Response:', JSON.stringify(deleteRes, null, 2));
    
    if (deleteRes.success) {
      console.log('✅ Delete succeeded');
    } else {
      console.log('❌ Delete failed:', deleteRes.error);
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  }

  process.exit(0);
}

test();
