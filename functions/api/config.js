// Cloudflare Pages Function: /api/config
// Securely distributes public client configuration (Supabase project URL & anon public key)
// from Cloudflare Pages environment variables across all user devices.
//
// NOTE: This endpoint ONLY exposes public client parameters (URL + anon public key).
// It NEVER exposes the database connection string, postgres passwords, or service_role keys.

export async function onRequestGet(context) {
  const env = context.env || {};
  const supabaseUrl = (env.SUPABASE_URL || '').trim();
  const supabaseAnonKey = (env.SUPABASE_ANON_KEY || '').trim();

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60'
  };

  if (supabaseUrl && supabaseAnonKey) {
    const cleanUrl = supabaseUrl.replace(/\/+$/, '');
    return new Response(JSON.stringify({
      configured: true,
      supabaseUrl: cleanUrl,
      supabaseAnonKey: supabaseAnonKey
    }), {
      status: 200,
      headers: corsHeaders
    });
  }

  return new Response(JSON.stringify({
    configured: false
  }), {
    status: 200,
    headers: corsHeaders
  });
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
