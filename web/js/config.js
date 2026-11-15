// Pulse Configuration
// Configure your Supabase project URL and anon public key.
// In production, these can be configured via localStorage or entered in the in-dashboard setup modal.
window.PULSE_CONFIG = {
  supabaseUrl: window.localStorage.getItem('PULSE_SUPABASE_URL') || '',
  supabaseAnonKey: window.localStorage.getItem('PULSE_SUPABASE_ANON_KEY') || ''
};
