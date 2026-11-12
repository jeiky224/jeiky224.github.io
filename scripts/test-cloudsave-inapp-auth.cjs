'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'cloud/auth.html'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'cloud/auth.js'), 'utf8');

assert.doesNotMatch(html, /<script[^>]+accounts\.google\.com\/gsi\/client/i,
  'Google Identity must not be embedded by default in the in-app WebView');
assert.match(auth, /transportMode === 'native-webview'/);
assert.match(auth, /window\.WaywardAuthHost/);
assert.match(auth, /nativeHost\.onmessage = handleNativeHostMessage/);
assert.match(auth, /type: 'auth-request'/);
assert.match(auth, /type: 'revoke-request'/);
assert.match(auth, /pendingNativeRevokeRequestId = requestId/);
assert.match(auth, /sendResponse\(requestId, true, \{ revoked: true \}\)/);
assert.match(auth, /applyNativeAuthResult/);
assert.match(auth, /window\.WaywardCloudSaveDrive\.setAccessToken\(accessToken, expiresIn\)/);
assert.match(auth, /nativeWebViewTransportRequested &&/);
assert.match(auth, /!nativeWebViewTransportRequested && !\/\^\[\^@/,
  'native AuthorizationClient flow must not depend on a web OAuth client ID');
assert.match(auth, /accounts\.google\.com\/gsi\/client/);
assert.match(auth, /https:\/\/www\.googleapis\.com\/auth\/drive\.appdata/);
assert.ok(auth.includes(".split(/\\s+/)"), 'scope parsing must split on whitespace');

const nativeStart = auth.indexOf("if (nativeWebViewTransportRequested) {", auth.indexOf("function beginConnection"));
const gisGuard = auth.indexOf("if (!nativeWebViewTransportRequested &&", auth.indexOf("function beginConnection"));
assert.ok(nativeStart > 0 && gisGuard > 0 && gisGuard < nativeStart,
  'native transport must bypass the GIS popup guard before dispatching native authorization');

assert.doesNotMatch(auth, /workers\.dev|vercel\.app|render\.com|supabase\.co/i);
console.log('Static CloudSave in-app auth transport contract passed');
