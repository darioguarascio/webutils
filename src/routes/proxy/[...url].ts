import { Request, Response } from 'express';

const hopByHopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade'
]);


const handler = async function(req: Request, res: Response) {
  console.log(req.params[0])
  try {
    // Rebuild target URL from path segments after /proxy/
    let targetUrl = req.params[0]; // everything after /proxy/

    // Construct URL object
    const urlObj = new URL(targetUrl);

    // Append all query parameters from original request to target URL
    for (const [key, value] of Object.entries(req.query)) {
      urlObj.searchParams.set(key, value);
    }

    // Prepare headers for forwarding
    const forwardHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!hopByHopHeaders.has(key.toLowerCase()) && key.toLowerCase() !== 'host') {
        forwardHeaders[key] = value;
      }
    }

    // Override Host header to match target host
    forwardHeaders['Host'] = urlObj.host;

    if (!forwardHeaders['User-Agent'] && !forwardHeaders['user-agent']) {
      forwardHeaders['User-Agent'] = 'Node.js Proxy';
    }

    // Fetch target URL with forwarded headers
    const response = await fetch(urlObj.toString(), {
      headers: forwardHeaders,
    });

    res.set('Content-Type', response.headers.get('content-type') || 'text/plain');

    const body = await response.text();
    res.send(body);

  } catch (err) {
    res.status(400).send(`Invalid URL or error: ${err.message}`);
  }
}

export const get = [
  handler
]