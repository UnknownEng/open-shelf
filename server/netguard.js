'use strict';
/**
 * Outbound-request guard against SSRF. Webhook URLs chosen by tenant admins must
 * never reach loopback, private, link-local (cloud metadata) or other internal
 * addresses. Checked when a webhook is saved AND again at delivery time (after
 * DNS resolution) so DNS rebinding cannot slip through.
 */
const dns = require('node:dns').promises;
const net = require('node:net');
const { PRODUCTION } = require('./config');

// Private targets are allowed only in local development/tests, never in production.
const allowPrivate = () => !PRODUCTION && process.env.ALLOW_PRIVATE_WEBHOOKS !== '0';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

function isPrivateHostname(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(h)) return isPrivateIp(h);
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.');
}

/** Throws if the URL points somewhere internal. */
async function assertPublicUrl(url) {
  if (allowPrivate()) return;
  const { hostname } = new URL(url);
  if (isPrivateHostname(hostname)) throw new Error('Webhook URL must be a public internet address.');
  const addrs = await dns.lookup(hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Webhook URL resolves to a private or internal address.');
}

module.exports = { assertPublicUrl, isPrivateIp, isPrivateHostname, allowPrivate };
