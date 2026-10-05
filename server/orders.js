// Захист від дублів: повторна відправка (подвійний клік, ретрай) не створює друге повідомлення.
export class RecentOrders {
  constructor({ ttlMs = 5 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.byClientId = new Map();
    this.byFingerprint = new Map();
  }

  find({ clientId, fingerprint }, now = Date.now()) {
    this.prune(now);
    return (clientId && this.byClientId.get(clientId)?.order)
      || this.byFingerprint.get(fingerprint)?.order
      || null;
  }

  save({ clientId, fingerprint }, order, now = Date.now()) {
    const entry = { order, at: now };
    if (clientId) this.byClientId.set(clientId, entry);
    this.byFingerprint.set(fingerprint, entry);
  }

  prune(now) {
    for (const map of [this.byClientId, this.byFingerprint]) {
      for (const [key, { at }] of map) if (now - at > this.ttlMs) map.delete(key);
    }
  }
}

export const fingerprintOf = ({ phone, variantId, quantity }) => `${phone}|${variantId}|${quantity}`;
