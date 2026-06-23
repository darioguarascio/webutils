import { Request, Response } from 'express';

const validators: any[] = [];

function getClientIp(req: Request): string {
  const cfHeader: any = req.headers['cf-connecting-ip'];
  const xffHeader: any = req.headers['x-forwarded-for'];

  if (typeof cfHeader === 'string' && cfHeader) {
    return cfHeader;
  }

  if (typeof xffHeader === 'string' && xffHeader) {
    return xffHeader.split(',')[0].trim();
  }

  return (req.ip ?? '') as string;
}

function ipv4ToDecimal(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = parts.map(p => {
    const n = Number(p);
    return Number.isFinite(n) && n >= 0 && n <= 255 ? n : NaN;
  });
  if (nums.some(n => Number.isNaN(n))) return null;
  return ((nums[0]! * 256 + nums[1]!) * 256 + nums[2]!) * 256 + nums[3]!;
}

function parseUserAgent(ua: string | undefined) {
  if (!ua) return null;
  const firstToken = ua.split(' ')[0] || ua;
  const [product, version] = firstToken.split('/');
  return {
    product,
    version: version || null,
    raw_value: ua,
  };
}

const handler = async function(req: Request, res: Response) {
  const ip = getClientIp(req);

  let geo: any = null;
  try {
    const resp = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
    if (resp.ok) {
      geo = await resp.json();
    }
  } catch {
    // ignore external lookup errors
  }

  const ipDecimal = ipv4ToDecimal(ip);
  const ua = parseUserAgent(req.headers['user-agent'] as string | undefined);

  const body = {
    ip,
    ip_decimal: ipDecimal,
    country: geo?.country_name ?? null,
    country_iso: geo?.country ?? null,
    country_eu: geo?.in_eu ?? null,
    region_name: geo?.region ?? null,
    region_code: geo?.region_code ?? null,
    zip_code: geo?.postal ?? null,
    city: geo?.city ?? null,
    latitude: geo?.latitude ?? null,
    longitude: geo?.longitude ?? null,
    time_zone: geo?.timezone ?? null,
    asn: geo?.asn ?? null,
    asn_org: geo?.org ?? null,
    hostname: geo?.hostname ?? req.hostname ?? null,
    user_agent: ua,
  };

  res.json(body);
};

export const get = [
  ...validators,
  handler,
];