// Pulse Configuration
// Set your Supabase project URL and Publishable Anon Key below,
// or leave empty to enter them directly via the dashboard settings dialog.
window.PULSE_CONFIG = {
  supabaseUrl: window.localStorage.getItem('PULSE_SUPABASE_URL') || '',
  supabaseAnonKey: window.localStorage.getItem('PULSE_SUPABASE_ANON_KEY') || ''
};
