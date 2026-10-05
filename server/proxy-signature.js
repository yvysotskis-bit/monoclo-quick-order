import crypto from 'node:crypto';

// https://shopify.dev/docs/apps/build/online-store/display-dynamic-data#calculate-a-digital-signature
function buildMessage(searchParams) {
  const grouped = {};
  for (const [key, value] of searchParams) {
    if (key === 'signature') continue;
    (grouped[key] ||= []).push(value);
  }
  return Object.keys(grouped)
    .sort()
    .map((key) => `${key}=${grouped[key].join(',')}`)
    .join('');
}

export function signParams(searchParams, secret) {
  return crypto.createHmac('sha256', secret).update(buildMessage(searchParams)).digest('hex');
}

export function verifyProxySignature(searchParams, secret) {
  const signature = searchParams.get('signature');
  if (!signature || !secret) return false;
  const expected = Buffer.from(signParams(searchParams, secret), 'hex');
  let given;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
