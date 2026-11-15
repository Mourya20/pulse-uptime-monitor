// Cloudflare Pages Function: /api/probe
// Executes server-side HTTP probes to check target endpoint reachability
// without client-side CORS restrictions or database pollution.

const FORBIDDEN_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
  'metadata.google.internal',
  'instance-data'
]);

function isPrivateOrRestrictedIP(hostname) {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  if (FORBIDDEN_HOSTNAMES.has(lower)) return true;
  if (lower.endsWith('.internal') || lower.endsWith('.local') || lower.endsWith('.onion')) return true;

  // IPv4 Private & Loopback checks
  const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const o1 = parseInt(ipv4Match[1], 10);
    const o2 = parseInt(ipv4Match[2], 10);
    if (o1 === 10) return true; // 10.0.0.0/8
    if (o1 === 127) return true; // 127.0.0.0/8 Loopback
    if (o1 === 169 && o2 === 254) return true; // 169.254.0.0/16 Link-local
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
    if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16
    if (o1 === 0) return true; // 0.0.0.0/8
  }

  return false;
}

export async function onRequestGet(context) {
  const { request } = context;
  const urlObj = new URL(request.url);
  const targetUrl = urlObj.searchParams.get('url');

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (!targetUrl) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing target url parameter' }), {
      status: 400,
      headers: corsHeaders
    });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid URL format' }), {
      status: 400,
      headers: corsHeaders
    });
  }

  if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
    return new Response(JSON.stringify({ ok: false, error: 'Only http and https protocols are supported' }), {
      status: 400,
      headers: corsHeaders
    });
  }

  if (isPrivateOrRestrictedIP(parsedTarget.hostname)) {
    return new Response(JSON.stringify({ ok: false, error: 'Target host is restricted (SSRF protection)' }), {
      status: 403,
      headers: corsHeaders
    });
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s probe timeout

  try {
    const response = await fetch(parsedTarget.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Pulse-KeepAlive-Monitor/1.0 (+https://github.com/Mourya20/pulse-uptime-monitor)'
      },
      redirect: 'follow',
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const latencyMs = Math.max(1, Date.now() - startTime);

    return new Response(JSON.stringify({
      ok: true,
      statusCode: response.status,
      statusText: response.statusText || (response.status >= 200 && response.status < 400 ? 'OK' : 'Error'),
      isHealthy: response.status >= 200 && response.status < 400,
      latencyMs
    }), {
      status: 200,
      headers: corsHeaders
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Math.max(1, Date.now() - startTime);
    const isTimeout = err.name === 'AbortError';

    return new Response(JSON.stringify({
      ok: true,
      statusCode: 0,
      statusText: isTimeout ? 'Timeout (>10s)' : (err.message || 'Connection failed'),
      isHealthy: false,
      latencyMs,
      error: err.message
    }), {
      status: 200,
      headers: corsHeaders
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
