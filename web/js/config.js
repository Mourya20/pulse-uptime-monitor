// Pulse Client Configuration
//
// Configuration Priority:
// 1. Cloudflare Pages Environment Variables (via /api/config: SUPABASE_URL & SUPABASE_ANON_KEY)
// 2. Values defined below (for private/single-tenant self-hosted deployments)
// 3. User localStorage override (via the in-dashboard setup modal)
//
// SECURITY ADVISORY:
// The 'anon' public key is safe for client-side use when PostgreSQL Row Level Security (RLS) is active.
// NEVER commit your backend 'service_role' secret key or 'DATABASE_URL' connection string here.

window.PULSE_CONFIG = {
  // Option B (Private Single-Tenant Dashboard):
  // You can set your Supabase project URL and anon public key below, OR configure
  // SUPABASE_URL and SUPABASE_ANON_KEY in your Cloudflare Pages dashboard environment variables.
  supabaseUrl: 'https://hsvudvpwmygahhxnilnt.supabase.co',
  supabaseAnonKey: ''
};

