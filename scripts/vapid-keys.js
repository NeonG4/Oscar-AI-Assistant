/**
 * scripts/vapid-keys.js
 * ----------------------------------------------------------------------------
 * Generates the keypair that proves notifications came from your Oscar.
 *
 *   npm run vapid
 *
 * Run it once. The public key is embedded in the web page and handed to the
 * browser when it subscribes; the private key signs each send and never leaves
 * the server. A push service checks that the two match, which is what stops
 * anyone else pushing to your devices using an endpoint they scraped.
 *
 * Losing the private key is survivable — generate a new pair, and every device
 * simply has to subscribe again. Leaking it means someone else can send you
 * notifications, so treat it like any other secret.
 */

import crypto from 'node:crypto';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/**
 * Via JWK rather than by slicing DER.
 *
 * Both work today, but the DER offsets are only stable because the encoding
 * happens to be fixed-length for P-256 — a brittle thing to rely on. JWK gives
 * the coordinates by name, and the raw formats everything in the web push
 * ecosystem expects are just those coordinates concatenated.
 */
const jwk = privateKey.export({ format: 'jwk' });
const x = Buffer.from(jwk.x, 'base64url');
const y = Buffer.from(jwk.y, 'base64url');
const d = Buffer.from(jwk.d, 'base64url');

// 0x04 is the "uncompressed point" tag: the full X and Y follow, not just X.
const rawPublic = Buffer.concat([Buffer.from([0x04]), x, y]);

// A sanity check on our own output, so a bad pair is caught here rather than
// as a silent 401 from a push service three steps later.
const check = crypto.verify(
  'sha256',
  Buffer.from('oscar'),
  { key: publicKey, dsaEncoding: 'ieee-p1363' },
  crypto.sign('sha256', Buffer.from('oscar'), { key: privateKey, dsaEncoding: 'ieee-p1363' })
);
if (!check || rawPublic.length !== 65 || d.length !== 32) {
  console.error('Generated a keypair that failed its own check. Try again.');
  process.exit(1);
}

console.log(`
VAPID keys — generated once, then kept.

Add BOTH to Vercel (Settings -> Environment Variables, all three environments),
then redeploy with \`vercel --prod\`. The public one is safe to be seen; the
private one must never reach public/ or git.

  VAPID_PUBLIC_KEY=${b64url(rawPublic)}

  VAPID_PRIVATE_KEY=${b64url(d)}

Optionally set VAPID_SUBJECT to a mailto: or https: contact. Without it, Oscar
uses OSCAR_OWNER_EMAIL, which is almost always what you want anyway.
`);
