import axios from 'axios';
import logger from './logger';

// Cloudflare API details should be set in environment variables
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID) {
  logger.warn('Cloudflare API token or zone ID not set. DNS management will not work.');
}

export class CloudflareDNS {
  static async upsertDNSRecord(subdomain: string, domain: string, target: string, type: 'A' | 'CNAME' = 'CNAME') {
    if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID) {
      throw new Error('Cloudflare API token or zone ID not set');
    }
    if (!target) {
      logger.error(`CloudflareDNS: Target for DNS record is undefined or empty. Skipping DNS step for ${subdomain}.${domain}`);
      return null;
    }
    const name = `${subdomain}.${domain}`;
    logger.debug(`[CloudflareDNS] Upsert DNS: name=${name}, target=${target}, type=${type}`);
    try {
      // 1. Check if record exists
      const existing = await CloudflareDNS.getDNSRecord(name, type);
      if (existing) {
        // Update
        await CloudflareDNS.updateDNSRecord(existing.id, name, target, type);
        logger.info(`Updated DNS record for ${name} -> ${target}`);
      } else {
        // Create
        await CloudflareDNS.createDNSRecord(name, target, type);
        logger.info(`Created DNS record for ${name} -> ${target}`);
      }
      return name;
    } catch (err) {
      const errorMsg = (err instanceof Error) ? err.message : JSON.stringify(err);
      logger.error(`[CloudflareDNS] Failed to upsert DNS record for ${name}: ${errorMsg}`);
      if (typeof err === 'object' && err !== null && (err as any).response && (err as any).response.data) {
        logger.error(`[CloudflareDNS] Cloudflare error response: ${JSON.stringify((err as any).response.data)}`);
      }
      throw err;
    }
  }

  static async getDNSRecord(name: string, type: string) {
    const url = `${CLOUDFLARE_API_BASE}/zones/${CLOUDFLARE_ZONE_ID}/dns_records`;
    logger.debug(`[CloudflareDNS] GET ${url} params: ${JSON.stringify({ type, name })}`);
    try {
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
        params: { type, name },
      });
      logger.debug(`[CloudflareDNS] GET response: ${JSON.stringify(res.data)}`);
      return res.data.result && res.data.result.length > 0 ? res.data.result[0] : null;
    } catch (err) {
      const errorMsg = (err instanceof Error) ? err.message : JSON.stringify(err);
      logger.error(`[CloudflareDNS] GET failed: ${errorMsg}`);
      if (typeof err === 'object' && err !== null && (err as any).response && (err as any).response.data) {
        logger.error(`[CloudflareDNS] Cloudflare error response: ${JSON.stringify((err as any).response.data)}`);
      }
      throw err;
    }
  }

  static async createDNSRecord(name: string, content: string, type: string) {
    const url = `${CLOUDFLARE_API_BASE}/zones/${CLOUDFLARE_ZONE_ID}/dns_records`;
    const payload = { type, name, content, ttl: 120, proxied: false };
    logger.debug(`[CloudflareDNS] POST ${url} payload: ${JSON.stringify(payload)}`);
    try {
      const res = await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
      });
      logger.debug(`[CloudflareDNS] POST response: ${JSON.stringify(res.data)}`);
      return res.data;
    } catch (err) {
      const errorMsg = (err instanceof Error) ? err.message : JSON.stringify(err);
      logger.error(`[CloudflareDNS] POST failed: ${errorMsg}`);
      if (typeof err === 'object' && err !== null && (err as any).response && (err as any).response.data) {
        logger.error(`[CloudflareDNS] Cloudflare error response: ${JSON.stringify((err as any).response.data)}`);
      }
      throw err;
    }
  }

  static async updateDNSRecord(id: string, name: string, content: string, type: string) {
    const url = `${CLOUDFLARE_API_BASE}/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${id}`;
    const payload = { type, name, content, ttl: 120, proxied: false };
    logger.debug(`[CloudflareDNS] PUT ${url} payload: ${JSON.stringify(payload)}`);
    try {
      const res = await axios.put(url, payload, {
        headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` },
      });
      logger.debug(`[CloudflareDNS] PUT response: ${JSON.stringify(res.data)}`);
      return res.data;
    } catch (err) {
      const errorMsg = (err instanceof Error) ? err.message : JSON.stringify(err);
      logger.error(`[CloudflareDNS] PUT failed: ${errorMsg}`);
      if (typeof err === 'object' && err !== null && (err as any).response && (err as any).response.data) {
        logger.error(`[CloudflareDNS] Cloudflare error response: ${JSON.stringify((err as any).response.data)}`);
      }
      throw err;
    }
  }
}
