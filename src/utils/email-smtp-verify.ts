import net from 'node:net';

function parseFirstSmtpReply(buffer: string): { code: number; complete: boolean; consumed: number } | null {
  const lines = buffer.split(/\r\n/);
  let consumed = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    consumed += line.length + 2;
    const m = /^(\d{3})([- ])/.exec(line);
    if (!m) continue;
    const code = Number(m[1]);
    if (m[2] === ' ') {
      return { code, complete: true, consumed };
    }
  }
  return null;
}

async function readUntilReply(socket: net.Socket, initial = ''): Promise<{ code: number; raw: string }> {
  let buffer = initial;
  for (;;) {
    const parsed = parseFirstSmtpReply(buffer);
    if (parsed?.complete) {
      return { code: parsed.code, raw: buffer.slice(0, parsed.consumed) };
    }
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      const onData = (d: Buffer) => {
        cleanup();
        resolve(d);
      };
      const onErr = (e: Error) => {
        cleanup();
        reject(e);
      };
      const onEnd = () => {
        cleanup();
        reject(new Error('connection closed before SMTP reply'));
      };
      const cleanup = () => {
        socket.off('data', onData);
        socket.off('error', onErr);
        socket.off('end', onEnd);
      };
      socket.once('data', onData);
      socket.once('error', onErr);
      socket.once('end', onEnd);
    });
    buffer += chunk.toString('binary');
  }
}

export type SmtpMailboxResult = {
  connected: boolean;
  host: string;
  mailbox_exists: boolean | null;
  mailbox_code: number | null;
  catch_all: boolean | null;
  probe_address: string | null;
  probe_accepted: boolean | null;
  probe_code: number | null;
  greylisted: boolean;
  error: string | null;
};

export async function verifyMailboxSmtp(
  mxHost: string,
  probeLocal: string,
  rcptEmail: string,
  timeoutMs: number,
): Promise<SmtpMailboxResult> {
  const base: Omit<SmtpMailboxResult, 'connected'> = {
    host: mxHost,
    mailbox_exists: null,
    mailbox_code: null,
    catch_all: null,
    probe_address: null,
    probe_accepted: null,
    probe_code: null,
    greylisted: false,
    error: null,
  };

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: mxHost, port: 25 });
    const fail = (msg: string) => {
      socket.destroy();
      resolve({ ...base, connected: false, error: msg });
    };

    const timer = setTimeout(() => fail('connection or SMTP timeout'), timeoutMs);

    const done = (r: SmtpMailboxResult) => {
      clearTimeout(timer);
      try {
        socket.write('QUIT\r\n');
      } catch {
        /* ignore */
      }
      socket.destroy();
      resolve(r);
    };

    socket.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        ...base,
        connected: false,
        error: e.message || 'socket error',
      });
    });

    socket.setTimeout(timeoutMs, () => fail('socket idle timeout'));

    socket.once('connect', async () => {
      try {
        const greet = await readUntilReply(socket);
        if (greet.code !== 220) {
          return done({ ...base, connected: true, error: `unexpected greeting: ${greet.code}` });
        }

        socket.write('EHLO webutils-verify.local\r\n');
        const ehlo = await readUntilReply(socket);
        if (ehlo.code !== 250) {
          socket.write('HELO webutils-verify.local\r\n');
          const helo = await readUntilReply(socket);
          if (helo.code !== 250) {
            return done({ ...base, connected: true, error: `EHLO/HELO failed: ${helo.code}` });
          }
        }

        socket.write('MAIL FROM:<>\r\n');
        const mailFrom = await readUntilReply(socket);
        if (mailFrom.code !== 250 && mailFrom.code !== 251) {
          return done({
            ...base,
            connected: true,
            error: `MAIL FROM rejected: ${mailFrom.code}`,
          });
        }

        socket.write(`RCPT TO:<${rcptEmail}>\r\n`);
        const rcpt = await readUntilReply(socket);
        const rcptCode = rcpt.code;
        const greylisted = rcptCode === 450 || rcptCode === 451 || rcptCode === 452;
        const accepted = rcptCode === 250 || rcptCode === 251;

        const domain = rcptEmail.split('@')[1] ?? '';
        const probeAddress = `${probeLocal}@${domain}`;
        socket.write(`RSET\r\n`);
        const rset = await readUntilReply(socket);
        if (rset.code !== 250) {
          return done({
            ...base,
            connected: true,
            mailbox_exists: greylisted ? null : accepted,
            mailbox_code: rcptCode,
            greylisted,
            error: greylisted ? 'greylisted or temporary RCPT failure' : null,
          });
        }

        socket.write('MAIL FROM:<>\r\n');
        const mailFrom2 = await readUntilReply(socket);
        if (mailFrom2.code !== 250 && mailFrom2.code !== 251) {
          return done({
            ...base,
            connected: true,
            mailbox_exists: greylisted ? null : accepted,
            mailbox_code: rcptCode,
            greylisted,
            error: null,
          });
        }

        socket.write(`RCPT TO:<${probeAddress}>\r\n`);
        const probe = await readUntilReply(socket);
        const probeCode = probe.code;
        const probeAccepted = probeCode === 250 || probeCode === 251;
        const probeGrey = probeCode === 450 || probeCode === 451 || probeCode === 452;

        let catchAll: boolean | null = null;
        if (!greylisted && !probeGrey) {
          catchAll = probeAccepted;
        }

        let mailboxExists: boolean | null = null;
        if (!greylisted) {
          if (catchAll === true) {
            mailboxExists = null;
          } else {
            mailboxExists = accepted;
          }
        }

        return done({
          ...base,
          connected: true,
          mailbox_exists: mailboxExists,
          mailbox_code: rcptCode,
          catch_all: catchAll,
          probe_address: probeAddress,
          probe_accepted: probeGrey ? null : probeAccepted,
          probe_code: probeCode,
          greylisted: greylisted || probeGrey,
          error: greylisted || probeGrey ? 'greylisted or temporary RCPT failure' : null,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return done({ ...base, connected: true, error: msg });
      }
    });
  });
}
