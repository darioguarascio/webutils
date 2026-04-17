import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { validate as validateEmailSyntax } from 'email-validator';
import { verifyMailboxSmtp } from '@utils/email-smtp-verify.ts';
import { resolveMailHostsCached, type MxRecord } from '@utils/mx-domain-cache.ts';

const require = createRequire(import.meta.url);
const disposablePath = require.resolve('disposable-email-domains');
const disposableDomains: string[] = JSON.parse(readFileSync(disposablePath, 'utf8')) as string[];
const disposableSet = new Set(disposableDomains.map((d) => d.toLowerCase()));

function isDisposableDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (disposableSet.has(d)) return true;
  const parts = d.split('.');
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('.');
    if (disposableSet.has(suffix)) return true;
  }
  return false;
}

/** Gmail-style plus subaddressing: `user+tag@domain` → same mailbox as `user@domain` on many hosts. */
function analyzePlusSubaddress(email: string): {
  detected: boolean;
  local_base: string | null;
  suffix: string | null;
  canonical_email: string | null;
  note: string | null;
} {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return { detected: false, local_base: null, suffix: null, canonical_email: null, note: null };
  }
  const local = email.slice(0, at);
  const domainPart = email.slice(at + 1);
  if (local.startsWith('"') && local.endsWith('"')) {
    return {
      detected: false,
      local_base: null,
      suffix: null,
      canonical_email: null,
      note: 'quoted local part; plus subaddress not analyzed',
    };
  }
  const plus = local.indexOf('+');
  if (plus <= 0) {
    return { detected: false, local_base: null, suffix: null, canonical_email: null, note: null };
  }
  const local_base = local.slice(0, plus);
  const suffix = local.slice(plus + 1);
  if (!local_base || suffix === '') {
    return { detected: false, local_base: null, suffix: null, canonical_email: null, note: null };
  }
  const canonical_email = `${local_base}@${domainPart.toLowerCase()}`;
  return {
    detected: true,
    local_base,
    suffix,
    canonical_email,
    note:
      'Plus subaddressing: the same mailbox often receives mail for the canonical address without the +suffix (e.g. Gmail, Google Workspace, Outlook.com, iCloud, Proton Mail; behavior is host-specific).',
  };
}

function summarizeDeliverability(input: {
  syntax_valid: boolean;
  mx_valid: boolean;
  disposable: boolean;
  null_mx: boolean;
  smtp_mailbox: boolean | null;
  catch_all: boolean | null;
  smtp_error: string | null;
  greylisted: boolean;
}): { verdict: string; notes: string[] } {
  const disposableNote = 'domain appears on a disposable-address blocklist';
  const withDisposable = (extra: string[]) => {
    const n = [...extra];
    if (input.disposable && !n.includes(disposableNote)) n.unshift(disposableNote);
    return n;
  };
  if (!input.syntax_valid) {
    return { verdict: 'invalid', notes: ['syntax does not conform to common e-mail rules'] };
  }
  if (input.null_mx) {
    return {
      verdict: 'undeliverable',
      notes: withDisposable(['domain has null MX (RFC 7505); mail not accepted']),
    };
  }
  if (!input.mx_valid) {
    return { verdict: 'undeliverable', notes: withDisposable(['no usable MX or A/AAAA mail host']) };
  }
  if (input.greylisted) {
    return {
      verdict: 'unknown',
      notes: withDisposable(['server returned a temporary RCPT code (possible greylisting)']),
    };
  }
  if (input.catch_all === true) {
    return {
      verdict: 'risky',
      notes: withDisposable([
        'domain accepts arbitrary recipients (catch-all); per-address existence cannot be confirmed',
      ]),
    };
  }
  if (input.smtp_mailbox === false) {
    return { verdict: 'likely_undeliverable', notes: withDisposable(['RCPT rejected for this address']) };
  }
  if (input.smtp_mailbox === true) {
    return { verdict: 'likely_deliverable', notes: withDisposable([]) };
  }
  if (input.smtp_error) {
    return {
      verdict: 'unknown',
      notes: withDisposable([`SMTP probe incomplete: ${input.smtp_error}`]),
    };
  }
  return {
    verdict: 'unknown',
    notes: withDisposable(['mailbox state could not be determined']),
  };
}

type ValidationDetails = {
  summary: string;
  syntax: string;
  mx: string;
  disposable: string;
  smtp: string;
  catch_all: string;
  plus_subaddress: string;
};

function buildValidationReport(input: {
  syntax_valid: boolean;
  domain: string;
  null_mx: boolean;
  mx_valid: boolean;
  mx_error: string | null;
  disposable: boolean;
  smtp_attempted: boolean;
  smtp_mailbox: boolean | null;
  smtp_error: string | null;
  smtp_greylisted: boolean;
  catch_all: boolean | null;
  plus_detected: boolean;
  verdict: string;
}): { valid: boolean; details: ValidationDetails } {
  const syn = input.syntax_valid
    ? 'Pass: local part and domain look well-formed.'
    : 'Fail: does not match common syntax rules (RFC-style checks).';

  let mx: string;
  if (!input.syntax_valid) {
    mx = 'Skipped: syntax invalid.';
  } else if (input.null_mx) {
    mx = 'Fail: domain uses null MX (RFC 7505); it does not accept mail.';
  } else if (!input.mx_valid) {
    mx = input.mx_error
      ? `Fail: ${input.mx_error}`
      : 'Fail: no MX records and no A/AAAA fallback for mail.';
  } else {
    mx = 'Pass: domain has mail routing (MX or A/AAAA).';
  }

  const disp = !input.syntax_valid
    ? 'Skipped: syntax invalid.'
    : input.disposable
      ? 'Fail: domain is on the disposable-address blocklist.'
      : 'Pass: not a known disposable domain.';

  let smtp: string;
  if (!input.syntax_valid || !input.mx_valid || input.null_mx) {
    smtp = 'Skipped: earlier checks failed.';
  } else if (!input.smtp_attempted) {
    smtp = 'Not run: no MX target.';
  } else if (input.smtp_greylisted) {
    smtp = 'Inconclusive: server returned a temporary RCPT code (e.g. greylisting).';
  } else if (input.smtp_error && input.smtp_mailbox !== true && input.smtp_mailbox !== false) {
    smtp = `Inconclusive: ${input.smtp_error}`;
  } else if (input.smtp_mailbox === true) {
    smtp = 'Pass: RCPT accepted for this address.';
  } else if (input.smtp_mailbox === false) {
    smtp = 'Fail: RCPT rejected; mailbox likely does not exist.';
  } else if (input.catch_all === true) {
    smtp = 'Inconclusive: domain is catch-all; RCPT alone cannot prove this mailbox exists.';
  } else {
    smtp = 'Inconclusive: mailbox state could not be determined.';
  }

  let ca: string;
  if (!input.syntax_valid || !input.mx_valid || input.null_mx) {
    ca = 'Skipped: earlier checks failed.';
  } else if (input.catch_all === true) {
    ca = 'Warning: domain accepts arbitrary local parts (catch-all).';
  } else if (input.catch_all === false) {
    ca = 'Pass: probe suggests the domain is not catch-all.';
  } else {
    ca = 'Unknown: catch-all could not be determined.';
  }

  const plus = input.plus_detected
    ? 'Info: plus subaddressing (+suffix); often aliases to the canonical mailbox on major providers.'
    : 'N/A: no +suffix in the local part (or quoted local part not analyzed).';

  const valid = input.verdict === 'likely_deliverable' && !input.disposable;

  let summary: string;
  if (valid) {
    summary = 'Accepted: format, routing, and SMTP checks indicate this address can receive mail.';
  } else if (input.verdict === 'likely_deliverable' && input.disposable) {
    summary = 'Rejected: disposable domain blocklist (same routing may still accept mail).';
  } else if (input.verdict === 'invalid') {
    summary = 'Rejected: invalid email format.';
  } else if (input.verdict === 'undeliverable') {
    summary = 'Rejected: domain cannot receive mail (MX/DNS).';
  } else if (input.verdict === 'likely_undeliverable') {
    summary = 'Rejected: mailbox likely does not exist.';
  } else if (input.verdict === 'risky') {
    summary = 'Rejected: disposable domain and/or catch-all; not treated as a verified address.';
  } else {
    summary = 'Not verified: inconclusive (greylisting, SMTP blocked, or ambiguous result).';
  }

  return {
    valid,
    details: {
      summary,
      syntax: syn,
      mx,
      disposable: disp,
      smtp,
      catch_all: ca,
      plus_subaddress: plus,
    },
  };
}

async function verifyEmail(emailRaw: string) {
  const email = emailRaw.trim();
  const plus_subaddress = analyzePlusSubaddress(email);
  const syntax_valid = validateEmailSyntax(email);
  const at = email.lastIndexOf('@');
  const domain = at > 0 ? email.slice(at + 1).toLowerCase() : '';

  if (!syntax_valid || !domain) {
    const deliverability = summarizeDeliverability({
      syntax_valid: false,
      mx_valid: false,
      disposable: false,
      null_mx: false,
      smtp_mailbox: null,
      catch_all: null,
      smtp_error: null,
      greylisted: false,
    });
    const validation = buildValidationReport({
      syntax_valid: false,
      domain,
      null_mx: false,
      mx_valid: false,
      mx_error: null,
      disposable: false,
      smtp_attempted: false,
      smtp_mailbox: null,
      smtp_error: null,
      smtp_greylisted: false,
      catch_all: null,
      plus_detected: plus_subaddress.detected,
      verdict: deliverability.verdict,
    });
    return {
      email,
      valid: validation.valid,
      details: validation.details,
      plus_subaddress,
      syntax: { valid: false, detail: 'failed syntax / format validation' },
      domain,
      disposable: { is_disposable: false },
      mx: { valid: false, cached: false, records: [] as MxRecord[], null_mx: false, error: null },
      smtp: null,
      catch_all: { detected: null as boolean | null, probe_address: null as string | null },
      deliverability: {
        verdict: deliverability.verdict,
        notes: deliverability.notes,
      },
    };
  }

  const disposable = isDisposableDomain(domain);
  const { result: mxResult, from_cache: mx_cached } = await resolveMailHostsCached(domain);
  const null_mx = mxResult.null_mx;
  const mx_valid = mxResult.records.length > 0 && !null_mx && !mxResult.error;

  let smtp: Awaited<ReturnType<typeof verifyMailboxSmtp>> | null = null;
  if (mx_valid && mxResult.records[0]) {
    const probeLocal = `zznull${randomBytes(8).toString('hex')}`;
    const firstMx = mxResult.records[0]!.exchange.replace(/\.$/, '');
    smtp = await verifyMailboxSmtp(firstMx, probeLocal, email, 12_000);
  }

  const smtp_mailbox = smtp?.mailbox_exists ?? null;
  const catch_all = smtp?.catch_all ?? null;
  const deliverability = summarizeDeliverability({
    syntax_valid: true,
    mx_valid,
    disposable,
    null_mx,
    smtp_mailbox,
    catch_all,
    smtp_error: smtp?.error ?? null,
    greylisted: smtp?.greylisted ?? false,
  });
  const validation = buildValidationReport({
    syntax_valid: true,
    domain,
    null_mx,
    mx_valid,
    mx_error: mxResult.error,
    disposable,
    smtp_attempted: !!smtp,
    smtp_mailbox,
    smtp_error: smtp?.error ?? null,
    smtp_greylisted: smtp?.greylisted ?? false,
    catch_all,
    plus_detected: plus_subaddress.detected,
    verdict: deliverability.verdict,
  });

  return {
    email,
    valid: validation.valid,
    details: validation.details,
    plus_subaddress,
    syntax: { valid: true, detail: 'passes validator used for RFC-style checks' },
    domain,
    disposable: { is_disposable: disposable },
    mx: {
      valid: mx_valid,
      cached: mx_cached,
      null_mx,
      records: mxResult.records.map((r) => ({
        exchange: r.exchange.replace(/\.$/, ''),
        priority: r.priority,
      })),
      error: mxResult.error,
    },
    smtp: smtp
      ? {
          attempted: true,
          host: smtp.host,
          connected: smtp.connected,
          mailbox_exists: smtp.mailbox_exists,
          response_code: smtp.mailbox_code,
          greylisted: smtp.greylisted,
          error: smtp.error,
        }
      : { attempted: false, reason: mx_valid ? 'skipped' : 'no MX target' },
    catch_all: {
      detected: catch_all,
      probe_address: smtp?.probe_address ?? null,
      probe_accepted: smtp?.probe_accepted ?? null,
    },
    deliverability: {
      verdict: deliverability.verdict,
      notes: deliverability.notes,
    },
  };
}

async function handler(req: Request, res: Response) {
  const qEmail = req.query['email'];
  const fromQuery = typeof qEmail === 'string' ? qEmail : '';
  const fromBody =
    req.body && typeof req.body === 'object' && typeof (req.body as { email?: unknown }).email === 'string'
      ? (req.body as { email: string }).email
      : '';
  const email = fromQuery || fromBody;
  if (!email) {
    res.status(400).json({ error: 'missing email (use ?email= or JSON body { "email": "..." })' });
    return;
  }
  try {
    const result = await verifyEmail(email);
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
}

export const get = [handler];
export const post = [handler];
