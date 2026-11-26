import { createServer, type Server, type Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Local stand-ins for where notices go, so a developer sees them arrive without any real server: a mail server that
 * accepts every message over SMTP and keeps it in memory, and a webhook receiver that keeps every call. Both forget
 * everything when the emulators stop. Nothing here is a real mail server: it speaks only the part of SMTP a mail
 * client uses to hand over a message, with no sign-in and no TLS.
 */

export interface ReceivedMail {
  from: string;
  to: string[];
  /** The message as sent: headers, a blank line, the text. */
  data: string;
  receivedAt: string;
}
export interface ReceivedCall {
  path: string;
  headers: Record<string, string>;
  body: string;
  /** The status the receiver answered. */
  status: number;
  receivedAt: string;
}

const KEPT = 200;

/** What the stand-ins received, newest last, at most 200 of each. */
export class NoticeInbox {
  mail: ReceivedMail[] = [];
  calls: ReceivedCall[] = [];
  addMail(mail: ReceivedMail): void {
    this.mail = [...this.mail, mail].slice(-KEPT);
  }
  addCall(call: ReceivedCall): void {
    this.calls = [...this.calls, call].slice(-KEPT);
  }
  clear(): void {
    this.mail = [];
    this.calls = [];
  }
}

/** A recipient at this domain is refused, so a developer or a test can see a failing mail server. */
export const REFUSED_MAIL_DOMAIN = 'refused.example';

/** The SMTP stand-in: EHLO, MAIL, RCPT, DATA, RSET, NOOP and QUIT. */
export function createSmtpStandIn(inbox: NoticeInbox): Server {
  return createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let from = '';
    let to: string[] = [];
    let reading = false;
    let data = '';
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 ledger-notices.local ESMTP stand-in (fictional)');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        reply('552 Message too large for the stand-in');
        socket.end();
        return;
      }
      for (;;) {
        if (reading) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0 && !buffer.startsWith('.\r\n')) return;
          const body = buffer.startsWith('.\r\n') ? '' : buffer.slice(0, end);
          buffer = buffer.startsWith('.\r\n') ? buffer.slice(3) : buffer.slice(end + 5);
          data += body;
          reading = false;
          inbox.addMail({
            from,
            to,
            data: data.replace(/^\.\./gm, '.'),
            receivedAt: new Date().toISOString(),
          });
          from = '';
          to = [];
          data = '';
          reply('250 Kept by the stand-in');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO') {
          socket.write('250-ledger-notices.local\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
        } else if (command === 'HELO') reply('250 ledger-notices.local');
        else if (command === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          reply('250 OK');
        } else if (command === 'RCPT') {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (address.toLowerCase().endsWith(`@${REFUSED_MAIL_DOMAIN}`)) reply('550 Mailbox unavailable');
          else {
            to.push(address);
            reply('250 OK');
          }
        } else if (command === 'DATA') {
          if (!to.length) reply('503 No recipients');
          else {
            reading = true;
            reply('354 End data with <CR><LF>.<CR><LF>');
          }
        } else if (command === 'RSET') {
          from = '';
          to = [];
          reply('250 OK');
        } else if (command === 'NOOP') reply('250 OK');
        else if (command === 'QUIT') {
          reply('221 Bye');
          socket.end();
          return;
        } else reply('502 Not offered by the stand-in');
      }
    });
    socket.on('error', () => socket.destroy());
  });
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);

function page(inbox: NoticeInbox): string {
  const mail = [...inbox.mail]
    .reverse()
    .map(
      (item) =>
        `<article><h3>${escape(item.to.join(', '))}</h3><p>${escape(item.receivedAt)}</p><pre>${escape(item.data)}</pre></article>`,
    )
    .join('');
  const calls = [...inbox.calls]
    .reverse()
    .map(
      (item) =>
        `<article><h3>${escape(item.path)} answered ${item.status}</h3><p>${escape(item.receivedAt)}</p><pre>${escape(
          JSON.stringify(item.headers, null, 2),
        )}\n\n${escape(item.body)}</pre></article>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notices received</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}pre{white-space:pre-wrap;background:#f4f4f4;padding:1rem}</style>
</head><body><h1>Notices received by the local stand-ins</h1>
<p>Fictional: nothing here left this computer. The newest is first; restarting the emulators forgets them.</p>
<h2>Email (${inbox.mail.length})</h2>${mail || '<p>None yet.</p>'}
<h2>Webhook calls (${inbox.calls.length})</h2>${calls || '<p>None yet.</p>'}</body></html>`;
}

/**
 * The HTTP side: POST /_notices/webhook receives a call (?status=500 answers that status instead, to see a failing
 * receiver), GET /_notices shows what arrived, GET /_notices/mail and /_notices/calls return it as JSON, and
 * DELETE /_notices forgets it. Returns false for any other path.
 */
export async function handleNoticeRequest(
  inbox: NoticeInbox,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  readBody: () => Promise<Uint8Array>,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/_notices' && !path.startsWith('/_notices/')) return false;
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  if (path === '/_notices/webhook' && request.method === 'POST') {
    const requested = Number(url.searchParams.get('status') ?? 200);
    const status = Number.isInteger(requested) && requested >= 200 && requested <= 599 ? requested : 200;
    const headers = Object.fromEntries(
      Object.entries(request.headers).flatMap(([name, value]) =>
        typeof value === 'string' && name !== 'authorization' && name !== 'cookie' ? [[name, value]] : [],
      ),
    );
    inbox.addCall({
      path: `${path}${url.search}`,
      headers,
      body: Buffer.from(await readBody()).toString('utf8'),
      status,
      receivedAt: new Date().toISOString(),
    });
    json(status, { received: status < 300 });
    return true;
  }
  if (path === '/_notices' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(page(inbox));
    return true;
  }
  if (path === '/_notices' && request.method === 'DELETE') {
    inbox.clear();
    json(200, { cleared: true });
    return true;
  }
  if (path === '/_notices/mail' && request.method === 'GET') {
    json(200, { mail: inbox.mail });
    return true;
  }
  if (path === '/_notices/calls' && request.method === 'GET') {
    json(200, { calls: inbox.calls });
    return true;
  }
  json(404, { error: 'Unknown notices path' });
  return true;
}
