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
    const { data: usersRes1 } = await makeRequest('GET', '/api/admin/users');
    if (!usersRes1.users || usersRes1.users.length === 0) {
      console.log('❌ No users found');
      process.exit(1);
    }
    const userToDelete = usersRes1.users[0];
    console.log(`Found user: ${userToDelete.Email} (ID: ${userToDelete.ID})`);
    console.log(`Initial user count: ${usersRes1.users.length}\n`);

    console.log('2️⃣  Deleting user...');
    const { status, data: deleteRes } = await makeRequest('POST', '/api/admin/users/delete', {
      ID1: userToDelete.ID
    });
    
    console.log(`Response status: ${status}`);
    console.log('Response:', JSON.stringify(deleteRes, null, 2));
    
    if (!deleteRes.success) {
      console.log('❌ Delete failed:', deleteRes.error);
      process.exit(1);
    }
    console.log('✅ Delete API returned success\n');

    console.log('3️⃣  Fetching users again to verify deletion...');
    const { data: usersRes2 } = await makeRequest('GET', '/api/admin/users');
    console.log(`Users after deletion: ${usersRes2.users.length}`);
    
    const stillExists = usersRes2.users.find(u => u.ID === userToDelete.ID);
    if (stillExists) {
      console.log(`❌ FAILED: User still exists! Email: ${stillExists.Email}`);
    } else {
      console.log(`✅ SUCCESS: User deleted and not found in list!`);
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  }

  process.exit(0);
}

test();
