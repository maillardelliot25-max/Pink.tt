'use strict';
const https = require('https');
const fs = require('fs');

const apiToken = process.env.TURSO_API_TOKEN;

if (!apiToken) {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('ACTION NEEDED: Set TURSO_API_TOKEN first');
  console.log('Run: $env:TURSO_API_TOKEN="your_token_here"');
  console.log('Then: node turso-setup.js');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.exit(1);
}

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.turso.tech',
      path,
      method,
      headers: {
        'Authorization': 'Bearer ' + apiToken,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  try {
    const me = await apiCall('GET', '/v1/user');
    const username = me.username;
    if (!username) { console.error('Auth failed:', JSON.stringify(me)); process.exit(1); }
    console.log('Logged in as:', username);

    const dbName = 'pinktt-' + Date.now();
    console.log('Creating database:', dbName);
    const db = await apiCall('POST', '/v1/organizations/' + username + '/databases', {
      name: dbName,
      group: 'default'
    });
    if (db.error) { console.error('DB create error:', db.error); process.exit(1); }
    console.log('Database created:', dbName);

    console.log('Creating auth token...');
    const tok = await apiCall('POST', '/v1/organizations/' + username + '/databases/' + dbName + '/auth/tokens', {
      expiration: 'never',
      authorization: 'full-access'
    });

    const url = 'libsql://' + dbName + '-' + username + '.turso.io';
    const token = tok.jwt;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('TURSO SETUP COMPLETE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('TURSO_DATABASE_URL=' + url);
    console.log('TURSO_AUTH_TOKEN=' + token);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    fs.writeFileSync('.env.production',
      'TURSO_DATABASE_URL=' + url + '\n' +
      'TURSO_AUTH_TOKEN=' + token + '\n'
    );
    console.log('Saved to .env.production');
  } catch (e) {
    console.error('Error:', e.message || e);
  }
}
main();
