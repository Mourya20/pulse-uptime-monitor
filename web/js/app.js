// Pulse Dashboard Application
(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  // Global State
  const state = {
    client: null,
    user: null,
    monitors: [],
    checks: [],
    incidents: [],
    maintenance: [],
    settings: {
      default_interval_minutes: 5,
      default_timeout_seconds: 15,
      degraded_threshold_ms: 1000,
      dashboard_timezone: 'UTC'
    },
    currentMonitorId: null,
    selectedRange: '24h',
    pollInterval: null
  };

  // Toast Notification
  function showToast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    setTimeout(() => t.classList.remove('on'), 2200);
  }

  // Routing
  const pageNames = {
    overview: 'Overview',
    monitors: 'Monitors',
    incidents: 'Incidents',
    maintenance: 'Maintenance',
    settings: 'Settings'
  };

  function route() {
    const hash = (location.hash || '#overview').slice(1);
    const pageId = pageNames[hash] ? hash : 'overview';

    $$('.page').forEach(el => el.classList.toggle('on', el.id === pageId));
    $$('nav a').forEach(a => a.classList.toggle('on', a.dataset.p === pageId));
    $('#crumb').textContent = pageNames[pageId];

    if (pageId === 'overview' && !state.currentMonitorId) {
      $('#overview').classList.remove('det');
    }
  }

  window.addEventListener('hashchange', route);

  // Time & Duration Formatting Helpers
  function formatTimestamp(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '—';

    if (state.settings.dashboard_timezone === 'LOCAL') {
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      });
    }
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  }

  function formatTimeAgo(isoStr) {
    if (!isoStr) return 'Never';
    const diffSec = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
    if (diffSec < 0) return 'Just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const min = Math.floor(diffSec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ${min % 60}m ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ${hr % 24}h ago`;
  }

  function formatDuration(sec) {
    if (sec == null || sec < 0) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;

    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // Helper: Merge overlapping intervals [startMs, endMs]
  function mergeIntervals(ranges) {
    if (!ranges || ranges.length === 0) return [];
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
    const merged = [sorted[0].slice()];

    for (let i = 1; i < sorted.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = sorted[i];
      if (curr[0] <= prev[1]) {
        if (curr[1] > prev[1]) {
          prev[1] = curr[1];
        }
      } else {
        merged.push(curr.slice());
      }
    }
    return merged;
  }

  // Helper: Sum total duration of intervals
  function sumIntervals(ranges) {
    if (!ranges) return 0;
    return ranges.reduce((acc, [s, e]) => acc + Math.max(0, e - s), 0);
  }

  // Helper: Subtract exclusion intervals from a list of intervals
  function subtractIntervals(ranges, exclusions) {
    let active = ranges.map(r => r.slice());

    exclusions.forEach(([exS, exE]) => {
      const nextActive = [];
      active.forEach(([s, e]) => {
        if (exE <= s || exS >= e) {
          nextActive.push([s, e]);
          return;
        }
        if (exS > s) {
          nextActive.push([s, exS]);
        }
        if (exE < e) {
          nextActive.push([exE, e]);
        }
      });
      active = nextActive;
    });

    return active;
  }

  // Calculate effective monitor status accounting for stale grace period
  // Grace period = interval * 2 + 10 minutes (matching Go checker IsStale)
  function getEffectiveStatus(m) {
    if (!m) return 'UNKNOWN';
    if (m.is_paused) return 'PAUSED';
    if (!m.last_checked_at) return 'UNKNOWN';

    const interval = m.interval_minutes || 5;
    const graceMinutes = interval * 2 + 10;
    const graceMs = graceMinutes * 60 * 1000;
    const elapsedMs = Date.now() - new Date(m.last_checked_at).getTime();

    if (elapsedMs > graceMs) {
      return 'UNKNOWN'; // Probe missed beyond grace period -> Stale
    }
    return m.current_status || 'UNKNOWN';
  }

  // Calculate Duration-Weighted Availability for a Monitor within a Time Window
  // Accurately accounts for maintenance windows (no double counting), outages,
  // and unobserved/unknown periods.
  function calculateMonitorUptime(monitorId, windowMs) {
    const m = state.monitors.find(mon => mon.id === monitorId);
    if (!m) {
      return {
        uptimePct: null,
        downSec: 0,
        incidentCount: 0,
        mtbfHours: -1,
        avgLat: 0,
        minLat: 0,
        maxLat: 0,
        hasData: false
      };
    }

    const now = Date.now();
    const rawWindowStart = now - windowMs;
    const createdAtMs = m.created_at ? new Date(m.created_at).getTime() : now;
    // Monitor did not exist before created_at
    const windowStart = Math.max(rawWindowStart, createdAtMs);
    const windowDuration = now - windowStart;

    if (windowDuration <= 0) {
      return {
        uptimePct: null,
        downSec: 0,
        incidentCount: 0,
        mtbfHours: -1,
        avgLat: 0,
        minLat: 0,
        maxLat: 0,
        hasData: false
      };
    }

    // 1. Maintenance intervals overlapping [windowStart, now]
    const rawMaint = state.maintenance
      .filter(mw => !mw.monitor_id || mw.monitor_id === monitorId)
      .map(mw => [
        Math.max(windowStart, new Date(mw.start_time).getTime()),
        Math.min(now, new Date(mw.end_time).getTime())
      ])
      .filter(([s, e]) => e > s);

    const mergedMaint = mergeIntervals(rawMaint);
    const totalMaintMs = sumIntervals(mergedMaint);

    // 2. Incident outage intervals overlapping [windowStart, now]
    const relevantIncidents = state.incidents.filter(inc => {
      if (inc.monitor_id !== monitorId) return false;
      const s = new Date(inc.started_at).getTime();
      const e = inc.resolved_at ? new Date(inc.resolved_at).getTime() : now;
      return e > windowStart && s < now;
    });

    const rawIncRanges = relevantIncidents.map(inc => [
      Math.max(windowStart, new Date(inc.started_at).getTime()),
      Math.min(now, inc.resolved_at ? new Date(inc.resolved_at).getTime() : now)
    ]).filter(([s, e]) => e > s);

    const mergedIncRanges = mergeIntervals(rawIncRanges);
    // Exclude maintenance overlap from downtime (planned maintenance is never outage downtime)
    const effectiveDownRanges = subtractIntervals(mergedIncRanges, mergedMaint);
    const totalDownMs = sumIntervals(effectiveDownRanges);

    // 3. Observed checks within the window
    const intervalMs = (m.interval_minutes || 5) * 60 * 1000;
    const graceMs = ((m.interval_minutes || 5) * 2 + 10) * 60 * 1000;

    const monChecks = state.checks
      .filter(c => c.monitor_id === monitorId && c.checked_at)
      .sort((a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime());

    // If no checks ever recorded and never checked
    if (monChecks.length === 0 && !m.last_checked_at) {
      return {
        uptimePct: null,
        downSec: 0,
        incidentCount: 0,
        mtbfHours: -1,
        avgLat: 0,
        minLat: 0,
        maxLat: 0,
        hasData: false
      };
    }

    // 4. Identify unobserved / unknown periods
    const unobservedRanges = [];

    if (monChecks.length === 0) {
      if (m.last_checked_at) {
        const lastT = new Date(m.last_checked_at).getTime();
        if (now - lastT > graceMs) {
          unobservedRanges.push([Math.max(windowStart, lastT + intervalMs), now]);
        }
      } else {
        unobservedRanges.push([windowStart, now]);
      }
    } else {
      // Gap from windowStart to first check
      const firstCheckT = new Date(monChecks[0].checked_at).getTime();
      if (firstCheckT - windowStart > graceMs) {
        unobservedRanges.push([windowStart, Math.min(now, firstCheckT)]);
      }

      // Gaps between consecutive checks
      for (let i = 0; i < monChecks.length - 1; i++) {
        const t1 = new Date(monChecks[i].checked_at).getTime();
        const t2 = new Date(monChecks[i + 1].checked_at).getTime();
        if (t2 - t1 > graceMs) {
          const gapStart = Math.max(windowStart, t1 + intervalMs);
          const gapEnd = Math.min(now, t2);
          if (gapEnd > gapStart) {
            unobservedRanges.push([gapStart, gapEnd]);
          }
        }
      }

      // Gap from last check to now
      const lastCheckT = new Date(monChecks[monChecks.length - 1].checked_at).getTime();
      if (now - lastCheckT > graceMs) {
        const gapStart = Math.max(windowStart, lastCheckT + intervalMs);
        if (now > gapStart) {
          unobservedRanges.push([gapStart, now]);
        }
      }
    }

    const mergedUnknown = mergeIntervals(unobservedRanges);
    const effectiveUnknown = subtractIntervals(mergedUnknown, mergedMaint);
    const totalUnknownMs = sumIntervals(effectiveUnknown);

    // Monitored duration excludes maintenance and unobserved periods
    const effectiveMonitoredMs = Math.max(0, windowDuration - totalMaintMs - totalUnknownMs);

    if (effectiveMonitoredMs <= 0) {
      return {
        uptimePct: null,
        downSec: Math.round(totalDownMs / 1000),
        incidentCount: relevantIncidents.length,
        mtbfHours: -1,
        avgLat: 0,
        minLat: 0,
        maxLat: 0,
        hasData: false
      };
    }

    const clampedDownMs = Math.min(effectiveMonitoredMs, totalDownMs);
    const upMs = Math.max(0, effectiveMonitoredMs - clampedDownMs);
    const uptimePct = Math.round(((upMs / effectiveMonitoredMs) * 100) * 100) / 100;

    // MTBF calculation
    let mtbfHours = -1;
    if (relevantIncidents.length > 0) {
      mtbfHours = (upMs / 3600000) / relevantIncidents.length;
      mtbfHours = Math.round(mtbfHours * 100) / 100;
    }

    // Latency calculation from successful checks in window
    const checksInWindow = monChecks.filter(c => {
      const t = new Date(c.checked_at).getTime();
      return t >= windowStart && t <= now && (c.status === 'UP' || c.status === 'DEGRADED');
    });

    let avgLat = 0, minLat = 0, maxLat = 0;
    if (checksInWindow.length > 0) {
      minLat = Infinity;
      let sum = 0;
      checksInWindow.forEach(c => {
        sum += c.response_time_ms;
        if (c.response_time_ms < minLat) minLat = c.response_time_ms;
        if (c.response_time_ms > maxLat) maxLat = c.response_time_ms;
      });
      avgLat = Math.round(sum / checksInWindow.length);
    } else {
      minLat = 0;
    }

    return {
      uptimePct,
      downSec: Math.round(clampedDownMs / 1000),
      incidentCount: relevantIncidents.length,
      mtbfHours,
      avgLat,
      minLat: minLat === Infinity ? 0 : minLat,
      maxLat,
      hasData: true
    };
  }

  // Generate 24 hourly availability bars for a monitor
  function generate24HourStrip(monitorId) {
    const now = Date.now();
    const oneHourMs = 3600000;
    const bars = [];

    for (let i = 23; i >= 0; i--) {
      const slotStart = now - (i + 1) * oneHourMs;
      const slotEnd = now - i * oneHourMs;

      // Check if an outage overlapped this slot
      const hasOutage = state.incidents.some(inc => {
        if (inc.monitor_id !== monitorId) return false;
        const s = new Date(inc.started_at).getTime();
        const e = inc.resolved_at ? new Date(inc.resolved_at).getTime() : now;
        return e > slotStart && s < slotEnd;
      });

      if (hasOutage) {
        bars.push({ color: 'bgr', label: `Down · ${i}h ago` });
        continue;
      }

      // Check checks in this slot
      const slotChecks = state.checks.filter(c => {
        if (c.monitor_id !== monitorId) return false;
        const t = new Date(c.checked_at).getTime();
        return t >= slotStart && t <= slotEnd;
      });

      if (slotChecks.length > 0) {
        const hasDegraded = slotChecks.some(c => c.status === 'DEGRADED');
        const hasDown = slotChecks.some(c => c.status === 'DOWN');
        if (hasDown) {
          bars.push({ color: 'bgr', label: `Down · ${i}h ago` });
        } else if (hasDegraded) {
          bars.push({ color: 'bgy', label: `Degraded · ${i}h ago` });
        } else {
          bars.push({ color: 'bgg', label: `Operational · ${i}h ago` });
        }
      } else {
        // No checks recorded in this hour slot
        bars.push({ color: 'bgm', label: `No checks · ${i}h ago` });
      }
    }

    return bars;
  }

  // Helper: Sanitize Supabase Project URL
  // Corrects common user input mistakes (pasting postgresql:// URI, db.host, missing https://, trailing slashes)
  function sanitizeSupabaseUrl(rawUrl) {
    if (!rawUrl) return '';
    let url = rawUrl.trim().replace(/^["']|["']$/g, '');

    // Extract project ref if user pasted database URI or direct host
    // e.g. postgresql://postgres:...@db.abcdefgh.supabase.co:5432/postgres or db.abcdefgh.supabase.co
    const match = url.match(/(?:db\.)?([a-z0-9-]+)\.supabase\.co/i);
    if (match && match[1]) {
      return `https://${match[1]}.supabase.co`;
    }

    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    return url.replace(/\/+$/, '');
  }

  // Supabase Auth and Client Initialization
  async function initAuth() {
    let supabaseUrl = (window.PULSE_CONFIG?.supabaseUrl || '').trim();
    let supabaseKey = (window.PULSE_CONFIG?.supabaseAnonKey || '').trim();

    // 1. If not in config.js, check localStorage
    if (!supabaseUrl || !supabaseKey) {
      supabaseUrl = (localStorage.getItem('PULSE_SUPABASE_URL') || '').trim();
      supabaseKey = (localStorage.getItem('PULSE_SUPABASE_ANON_KEY') || '').trim();
    }

    // 2. If still not configured, check Cloudflare Pages environment variables via /api/config
    if (!supabaseUrl || !supabaseKey) {
      try {
        const cfgRes = await fetch('/api/config');
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          if (cfg.configured && cfg.supabaseUrl && cfg.supabaseAnonKey) {
            supabaseUrl = cfg.supabaseUrl.trim();
            supabaseKey = cfg.supabaseAnonKey.trim();
            window.PULSE_CONFIG = window.PULSE_CONFIG || {};
            window.PULSE_CONFIG.supabaseUrl = supabaseUrl;
            window.PULSE_CONFIG.supabaseAnonKey = supabaseKey;
          }
        }
      } catch (e) {
        // Fallback silently if /api/config is unreachable (e.g. offline or local preview)
      }
    }

    // Pre-populate input fields
    const urlInput = $('#auth-supa-url');
    const keyInput = $('#auth-supa-key');
    if (urlInput) urlInput.value = supabaseUrl;
    if (keyInput) keyInput.value = supabaseKey;

    if (!supabaseUrl || !supabaseKey) {
      $('#auth-config-fields').style.display = 'block';
      $('#auth-ov').classList.add('on');
      return;
    }

    // Config is present: keep technical fields collapsed so any device directly gets the clean Email/Password modal
    $('#auth-config-fields').style.display = 'none';

    supabaseUrl = sanitizeSupabaseUrl(supabaseUrl);

    try {
      state.client = window.supabase.createClient(supabaseUrl, supabaseKey);
      const { data: { session }, error } = await state.client.auth.getSession();
      if (error) throw error;
      if (!session) {
        $('#auth-ov').classList.add('on');
        return;
      }
      state.user = session.user;
      $('#auth-ov').classList.remove('on');
      $('#settings-user').textContent = state.user.email || 'Owner';

      await loadAllData();
      startPolling();
    } catch (err) {
      console.error('Failed to initialize Supabase client:', err);
      let msg = err.message || 'Failed to connect to Supabase.';
      if (msg.includes('Failed to fetch') || msg.includes('fetch')) {
        msg = 'Failed to fetch: Cannot connect to Supabase. Check: 1) URL must be https://<id>.supabase.co (not the postgresql:// connection string), 2) Check if project is paused in Supabase, 3) Disable any ad-blockers.';
      }
      $('#auth-err').textContent = msg;
      $('#auth-err').classList.add('on');
      $('#auth-config-fields').style.display = 'block';
      $('#auth-ov').classList.add('on');
    }
  }

  // Brute-force protection tracking
  let loginFailures = 0;
  let loginLockoutUntil = 0;

  // Handle Login submission
  $('#auth-login').onclick = async () => {
    const errBanner = $('#auth-err');
    errBanner.classList.remove('on');

    const now = Date.now();
    if (now < loginLockoutUntil) {
      const remainingSec = Math.ceil((loginLockoutUntil - now) / 1000);
      errBanner.textContent = `Too many failed login attempts. Please wait ${remainingSec}s before retrying.`;
      errBanner.classList.add('on');
      return;
    }

    const configFields = $('#auth-config-fields');
    let url = ($('#auth-supa-url').value || '').trim();
    let key = ($('#auth-supa-key').value || '').trim();

    if (configFields.style.display !== 'none' || !state.client) {
      if (!url || !key) {
        errBanner.textContent = 'Please configure Supabase URL and Publishable Key.';
        errBanner.classList.add('on');
        $('#auth-config-fields').style.display = 'block';
        return;
      }
      url = sanitizeSupabaseUrl(url);
      $('#auth-supa-url').value = url;
      localStorage.setItem('PULSE_SUPABASE_URL', url);
      localStorage.setItem('PULSE_SUPABASE_ANON_KEY', key);
      window.PULSE_CONFIG = window.PULSE_CONFIG || {};
      window.PULSE_CONFIG.supabaseUrl = url;
      window.PULSE_CONFIG.supabaseAnonKey = key;
      state.client = window.supabase.createClient(url, key);
    }

    if (!state.client) {
      errBanner.textContent = 'Please configure Supabase URL and Publishable Key.';
      errBanner.classList.add('on');
      return;
    }

    const email = $('#auth-email').value.trim();
    const password = $('#auth-pwd').value;
    if (!email || !password) {
      errBanner.textContent = 'Please enter both email and password.';
      errBanner.classList.add('on');
      return;
    }

    const loginBtn = $('#auth-login');
    const originalBtnText = loginBtn.innerHTML;
    loginBtn.disabled = true;
    loginBtn.innerHTML = 'Signing in...';

    try {
      const { data, error } = await state.client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      loginFailures = 0;
      loginLockoutUntil = 0;
      state.user = data.user;
      $('#auth-ov').classList.remove('on');
      $('#settings-user').textContent = state.user.email || 'Owner';
      showToast('Signed in successfully');
      await loadAllData();
      startPolling();
    } catch (err) {
      loginFailures++;
      if (loginFailures >= 5) {
        loginLockoutUntil = Date.now() + 60000; // 60s cooldown
      }

      let msg = err.message || 'Invalid credentials.';
      if (msg.includes('Failed to fetch') || msg.includes('fetch')) {
        msg = 'Failed to fetch: Unable to reach Supabase. Check: 1) URL must be https://<id>.supabase.co (NOT postgresql://), 2) Check if project is paused in Supabase Dashboard, 3) Disable any ad-blockers.';
        $('#auth-config-fields').style.display = 'block';
      } else if (loginFailures >= 5) {
        msg += ' (Account locked for 60 seconds due to repeated failed attempts)';
      }
      errBanner.textContent = msg;
      errBanner.classList.add('on');
      $('#auth-pwd').value = '';
    } finally {
      loginBtn.disabled = false;
      loginBtn.innerHTML = originalBtnText;
    }
  };

  // Reset configuration button
  const resetBtn = $('#auth-reset-config');
  if (resetBtn) {
    resetBtn.onclick = () => {
      localStorage.removeItem('PULSE_SUPABASE_URL');
      localStorage.removeItem('PULSE_SUPABASE_ANON_KEY');
      $('#auth-supa-url').value = '';
      $('#auth-supa-key').value = '';
      state.client = null;
      $('#auth-err').classList.remove('on');
      showToast('Configuration cleared');
    };
  }

  $('#auth-setup-toggle').onclick = () => {
    const fields = $('#auth-config-fields');
    fields.style.display = fields.style.display === 'none' ? 'block' : 'none';
  };

  $('#btn-signout').onclick = async () => {
    if (state.client) {
      await state.client.auth.signOut();
      state.user = null;
      location.reload();
    }
  };

  // Periodic polling of the database to refresh dashboard
  function startPolling() {
    if (state.pollInterval) clearInterval(state.pollInterval);
    state.pollInterval = setInterval(async () => {
      if (state.client && state.user) {
        await loadAllData(true);
      }
    }, 15000); // Live poll every 15s

    // Real-time 1-second ticker for live moving timers & countdowns
    if (state.tickerInterval) clearInterval(state.tickerInterval);
    state.tickerInterval = setInterval(() => {
      // 1. If viewing detail page, tick the relative times and next-check countdown
      if (state.currentMonitorId) {
        const m = state.monitors.find(mon => mon.id === state.currentMonitorId);
        if (m) {
          if (m.last_checked_at) {
            const lcEl = $('#d-lastcheck');
            if (lcEl) lcEl.textContent = formatTimeAgo(m.last_checked_at);
            const sinceEl = $('#d-since');
            if (sinceEl) sinceEl.textContent = calculateStateDurationText(m);
          }

          // Countdown to next check
          const nextCheckStr = m.next_check_at;
          const intervalEl = $('#d-interval');
          if (intervalEl && nextCheckStr) {
            const diffSec = Math.floor((new Date(nextCheckStr).getTime() - Date.now()) / 1000);
            if (diffSec > 0) {
              const min = Math.floor(diffSec / 60);
              const sec = diffSec % 60;
              intervalEl.textContent = `Next in ${min}m ${sec < 10 ? '0' : ''}${sec}s (every ${m.interval_minutes}m)`;
            } else {
              const overdueSec = Math.abs(diffSec);
              if (overdueSec > 60) {
                const overMin = Math.floor(overdueSec / 60);
                intervalEl.textContent = `Awaiting runner · Overdue by ${overMin}m (every ${m.interval_minutes}m)`;
              } else {
                intervalEl.textContent = `Checking soon… (every ${m.interval_minutes}m)`;
              }
            }
          }
        }
      }
    }, 1000);
  }

  // Fetch complete paginated history for a monitor over its selected range
  async function loadMonitorHistory(monitorId, rangeMs) {
    if (!state.client) return;
    const sinceIso = new Date(Date.now() - rangeMs).toISOString();

    let allMonChecks = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore && page < 5) {
      const { data, error } = await state.client
        .from('checks')
        .select('*')
        .eq('monitor_id', monitorId)
        .gte('checked_at', sinceIso)
        .order('checked_at', { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error || !data || data.length === 0) break;
      allMonChecks = allMonChecks.concat(data);
      if (data.length < pageSize) {
        hasMore = false;
      } else {
        page++;
      }
    }

    const otherChecks = state.checks.filter(c => c.monitor_id !== monitorId);
    state.checks = [...allMonChecks, ...otherChecks];
  }

  // Load all application data from Supabase
  async function loadAllData(quiet = false) {
    if (!state.client) return;

    try {
      // 1. Fetch settings
      const { data: setts } = await state.client.from('app_settings').select('*').limit(1);
      if (setts && setts.length > 0) {
        state.settings = { ...state.settings, ...setts[0] };
        $('#set-interval').value = String(state.settings.default_interval_minutes || 5);
        $('#set-timeout').value = String(state.settings.default_timeout_seconds || 15);
        $('#set-degraded').value = String(state.settings.degraded_threshold_ms || 1000);
        $('#set-tz').value = state.settings.dashboard_timezone || 'UTC';
      }

      // 2. Fetch monitors
      const { data: mons, error: monErr } = await state.client
        .from('monitors')
        .select('*')
        .order('created_at', { ascending: false });
      if (monErr) throw monErr;
      state.monitors = mons || [];

      // 3. Fetch incidents
      const { data: incs, error: incErr } = await state.client
        .from('incidents')
        .select('*')
        .order('started_at', { ascending: false });
      if (incErr) throw incErr;
      state.incidents = incs || [];

      // 4. Fetch maintenance windows
      const { data: maints, error: maintErr } = await state.client
        .from('maintenance_windows')
        .select('*')
        .order('start_time', { ascending: false });
      if (maintErr) throw maintErr;
      state.maintenance = maints || [];

      // 5. Fetch recent checks (last 24 hours across fleet)
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600000).toISOString();
      const { data: chks, error: chkErr } = await state.client
        .from('checks')
        .select('*')
        .gte('checked_at', twentyFourHoursAgo)
        .order('checked_at', { ascending: false })
        .limit(5000);
      if (chkErr) throw chkErr;
      state.checks = chks || [];

      // Render all views
      renderOverview();
      renderMonitors();
      renderIncidents();
      renderMaintenance();

      // If viewing detail, refresh detail view with full monitor history
      if (state.currentMonitorId) {
        const rangeMs = state.selectedRange === '30d' ? 30 * 86400000 :
                        state.selectedRange === '7d' ? 7 * 86400000 : 86400000;
        await loadMonitorHistory(state.currentMonitorId, rangeMs);
        renderMonitorDetail(state.currentMonitorId);
      }
    } catch (err) {
      console.error('Error loading database records:', err);
      if (!quiet) showToast('Error loading data: ' + err.message);
    }
  }

  // Status Badge and Indicator Config
  const statusStyles = {
    UP: { cls: 'g', bg: 'bgg', text: 'Up' },
    DOWN: { cls: 'r', bg: 'bgr', text: 'Down' },
    DEGRADED: { cls: 'y', bg: 'bgy', text: 'Degraded' },
    PAUSED: { cls: '', bg: 'bgm', text: 'Paused' },
    MAINTENANCE: { cls: 'y', bg: 'bgy', text: 'Maintenance' },
    UNKNOWN: { cls: '', bg: 'bgm', text: 'Unknown' }
  };

  // Render Fleet Overview
  function renderOverview() {
    const total = state.monitors.length;
    let upCount = 0, downCount = 0, degradedCount = 0, unknownCount = 0;
    let totalUptime = 0;

    let validUptimeCount = 0;
    state.monitors.forEach(m => {
      const st = getEffectiveStatus(m);
      if (st === 'UP') upCount++;
      else if (st === 'DOWN') downCount++;
      else if (st === 'DEGRADED') degradedCount++;
      else if (st === 'UNKNOWN') unknownCount++;

      const stats = calculateMonitorUptime(m.id, 86400000);
      if (stats.uptimePct !== null) {
        totalUptime += stats.uptimePct;
        validUptimeCount++;
      }
    });

    const avgUptime = validUptimeCount > 0 ? (totalUptime / validUptimeCount).toFixed(2) + '%' : '—';

    $('#sm-total').textContent = total;
    $('#sm-up').textContent = upCount;
    $('#sm-down').textContent = downCount;
    $('#sm-degraded').textContent = degradedCount;
    $('#sm-uptime').textContent = avgUptime;

    // Fleet status indicator in footer
    const footDot = $('#fleet-dot');
    const footText = $('#fleet-status-text');
    if (downCount > 0) {
      footDot.className = 'dot bgr';
      footText.textContent = `${downCount} system${downCount > 1 ? 's' : ''} down`;
    } else if (degradedCount > 0) {
      footDot.className = 'dot bgy';
      footText.textContent = 'Degraded performance';
    } else if (unknownCount > 0) {
      footDot.className = 'dot bgm';
      footText.textContent = `${unknownCount} monitor${unknownCount > 1 ? 's' : ''} unknown/stale`;
    } else {
      footDot.className = 'dot bgg';
      footText.textContent = 'All systems operational';
    }

    // Overview Monitors Table
    const tb = $('#ftb');
    if (total === 0) {
      tb.innerHTML = '<tr><td colspan="6" class="sub" style="text-align:center;padding:32px">No monitors configured. Click "New monitor" to add one.</td></tr>';
    } else {
      tb.innerHTML = state.monitors.map((m, idx) => {
        const stKey = getEffectiveStatus(m);
        const s = statusStyles[stKey] || statusStyles.UNKNOWN;
        const stats = calculateMonitorUptime(m.id, 86400000);
        const strip = generate24HourStrip(m.id);
        const host = formatHost(m.url);
        const isStale = stKey === 'UNKNOWN' && m.last_checked_at;
        const statusLabel = isStale ? 'Unknown (stale)' : s.text;

        return `
          <tr class="clk" data-id="${m.id}">
            <td>
              <span class="dot ${s.bg}"></span><b>${escapeHtml(m.name || 'Unnamed')}</b>
              <span class="mono" style="color:var(--t3);margin-left:10px;font-size:13px">${escapeHtml(host)}</span>
            </td>
            <td class="${s.cls}">${statusLabel}</td>
            <td class="mono">${stats.uptimePct !== null ? stats.uptimePct + '%' : '—'}</td>
            <td>
              <span class="mini">
                ${strip.map(b => `<i class="${b.color}" title="${b.label}"></i>`).join('')}
              </span>
            </td>
            <td class="mono">${stats.avgLat > 0 ? stats.avgLat + ' ms' : '—'}</td>
            <td class="mono" style="color:var(--t2)">${formatTimeAgo(m.last_checked_at)}</td>
          </tr>
        `;
      }).join('');
    }

    // Recent Activity Feed
    const fact = $('#fact');
    const recentEvents = [];

    state.incidents.slice(0, 10).forEach(inc => {
      const mon = state.monitors.find(m => m.id === inc.monitor_id);
      const name = mon ? mon.name : 'Endpoint';

      if (inc.resolved_at) {
        recentEvents.push({
          time: new Date(inc.resolved_at),
          dot: 'bgg',
          text: `${name} · recovered after ${formatDuration(inc.duration_seconds)}`
        });
      }
      recentEvents.push({
        time: new Date(inc.started_at),
        dot: 'bgr',
        text: `${name} · ${inc.root_cause || 'Outage detected'}`
      });
    });

    recentEvents.sort((a, b) => b.time - a.time);

    if (recentEvents.length === 0) {
      fact.innerHTML = '<div class="sub" style="padding:16px;text-align:center">No recent incident activity recorded.</div>';
    } else {
      fact.innerHTML = recentEvents.slice(0, 6).map(e => `
        <div>
          <time class="mono">${formatTimestamp(e.time)}</time>
          <span><span class="dot ${e.dot}"></span>${escapeHtml(e.text)}</span>
        </div>
      `).join('');
    }
  }

  // Live Server-Side Probe
  // Executes via Cloudflare Pages Function (/api/probe) to avoid client-side CORS issues,
  // without modifying next_check_at or corrupting the checks table.
  async function executeLiveProbe(monitorId, btnElement) {
    const m = state.monitors.find(mon => mon.id === monitorId);
    if (!m) return;

    const originalText = btnElement ? btnElement.innerHTML : '';
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.innerHTML = 'Testing...';
    }

    const badge = $('#probe-result');
    if (badge && state.currentMonitorId === monitorId) {
      badge.style.display = 'inline-flex';
      badge.style.borderColor = 'var(--bd)';
      badge.style.color = 'var(--t2)';
      badge.textContent = 'Probing...';
    }

    try {
      const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(m.url)}`);

      if (!probeRes.ok && probeRes.status === 404) {
        showToast('⚡ Live probe API is active on Cloudflare Pages. (Scheduled checks run via GitHub Actions Go worker).', 5000);
        if (badge && state.currentMonitorId === monitorId) badge.style.display = 'none';
        return;
      }

      const data = await probeRes.json();
      if (!data.ok) {
        showToast(`Probe error: ${data.error || 'Request failed'}`);
        if (badge && state.currentMonitorId === monitorId) {
          badge.style.display = 'inline-flex';
          badge.style.color = 'var(--r)';
          badge.style.borderColor = 'rgba(255, 68, 68, 0.4)';
          badge.textContent = `Error: ${data.error || 'Failed'}`;
        }
        return;
      }

      const isUp = data.isHealthy;
      const statusText = data.statusCode ? `${data.statusCode} ${data.statusText}` : data.statusText;
      const message = `Server Probe: ${statusText} (${data.latencyMs}ms)`;

      showToast(isUp ? `⚡ ${message}` : `❌ ${message}`);

      if (badge && state.currentMonitorId === monitorId) {
        badge.style.display = 'inline-flex';
        badge.style.color = isUp ? 'var(--g)' : 'var(--r)';
        badge.style.borderColor = isUp ? 'rgba(0, 200, 83, 0.4)' : 'rgba(255, 68, 68, 0.4)';
        badge.textContent = `${statusText} (${data.latencyMs}ms)`;
      }
    } catch (err) {
      console.warn('Probe request note:', err);
      showToast('⚡ Live probe is available when hosted on Cloudflare. Scheduled checks run via GitHub Actions Go worker.', 5000);
      if (badge && state.currentMonitorId === monitorId) {
        badge.style.display = 'none';
      }
    } finally {
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.innerHTML = originalText;
      }
    }
  }

  // Open Monitor Detail View
  async function openMonitorDetail(monitorId) {
    state.currentMonitorId = monitorId;
    $('#overview').classList.add('det');
    const badge = $('#probe-result');
    if (badge) badge.style.display = 'none';
    renderMonitorDetail(monitorId);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Load full history for this monitor's selected window
    const rangeMs = state.selectedRange === '30d' ? 30 * 86400000 :
                    state.selectedRange === '7d' ? 7 * 86400000 : 86400000;
    await loadMonitorHistory(monitorId, rangeMs);
    renderMonitorDetail(monitorId);
  }

  $('#btn-probe')?.addEventListener('click', () => {
    if (state.currentMonitorId) {
      executeLiveProbe(state.currentMonitorId, $('#btn-probe'));
    }
  });

  $('#back').onclick = () => {
    state.currentMonitorId = null;
    $('#overview').classList.remove('det');
  };

  const goHome = e => {
    if (e) e.preventDefault();
    state.currentMonitorId = null;
    $('#overview').classList.remove('det');
    if (location.hash === '#overview') {
      route();
    } else {
      location.hash = '#overview';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  $('#logo-link')?.addEventListener('click', goHome);
  $('#crumb-home')?.addEventListener('click', goHome);

  $('nav a[data-p=overview]')?.addEventListener('click', () => {
    state.currentMonitorId = null;
    $('#overview').classList.remove('det');
  });

  $('#ftb').onclick = e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openMonitorDetail(tr.dataset.id);
  };

  // Range Selector Click in Detail View
  $('#rng').addEventListener('click', async e => {
    if (e.target.tagName !== 'BUTTON') return;
    [...$('#rng').children].forEach(b => b.classList.toggle('on', b === e.target));
    state.selectedRange = e.target.dataset.range || '24h';
    if (state.currentMonitorId) {
      renderMonitorDetail(state.currentMonitorId);
      const rangeMs = state.selectedRange === '30d' ? 30 * 86400000 :
                      state.selectedRange === '7d' ? 7 * 86400000 : 86400000;
      await loadMonitorHistory(state.currentMonitorId, rangeMs);
      renderMonitorDetail(state.currentMonitorId);
    }
  });

  // Render Monitor Detail
  function renderMonitorDetail(monitorId) {
    const m = state.monitors.find(mon => mon.id === monitorId);
    if (!m) return;

    $('#dname').textContent = m.name;
    $('#d-chartsub').textContent = `All probes · ${formatHost(m.url)}`;

    const stKey = getEffectiveStatus(m);
    const s = statusStyles[stKey] || statusStyles.UNKNOWN;

    // Status card
    const dStatus = $('#d-status');
    dStatus.className = 'v ' + s.cls;
    if (stKey === 'UNKNOWN' && m.last_checked_at) {
      dStatus.innerHTML = `<span class="dot ${s.bg}"></span>Unknown (Stale)`;
    } else {
      dStatus.innerHTML = `<span class="dot ${s.bg}"></span>${s.text}`;
    }

    // Calculate duration in current state
    const sinceText = calculateStateDurationText(m);
    $('#d-since').textContent = sinceText;

    // Last check card
    $('#d-lastcheck').textContent = formatTimeAgo(m.last_checked_at);
    const nextCheckStr = m.next_check_at;
    if (nextCheckStr) {
      const diffSec = Math.floor((new Date(nextCheckStr).getTime() - Date.now()) / 1000);
      if (diffSec > 0) {
        const min = Math.floor(diffSec / 60);
        const sec = diffSec % 60;
        $('#d-interval').textContent = `Next in ${min}m ${sec < 10 ? '0' : ''}${sec}s (every ${m.interval_minutes}m)`;
      } else {
        const overdueSec = Math.abs(diffSec);
        if (overdueSec > 60) {
          const overMin = Math.floor(overdueSec / 60);
          $('#d-interval').textContent = `Awaiting runner · Overdue by ${overMin}m (every ${m.interval_minutes}m)`;
        } else {
          $('#d-interval').textContent = `Checking soon… (every ${m.interval_minutes}m)`;
        }
      }
    } else {
      $('#d-interval').textContent = `Every ${m.interval_minutes}m`;
    }

    // Window ranges: 24h, 7d, 30d
    const rangeMs = state.selectedRange === '30d' ? 30 * 86400000 :
                    state.selectedRange === '7d' ? 7 * 86400000 : 86400000;

    const rangeStats = calculateMonitorUptime(m.id, rangeMs);
    const rangeTitle = state.selectedRange === '30d' ? 'Last 30 days' :
                       state.selectedRange === '7d' ? 'Last 7 days' : 'Last 24 hours';
    $('#d-rangetitle').textContent = rangeTitle;
    $('#d-rangeuptime').textContent = rangeStats.uptimePct !== null ? `${rangeStats.uptimePct}%` : '—';
    $('#d-incdowntime').textContent = rangeStats.hasData !== false
      ? `${rangeStats.incidentCount} incidents · ${formatDuration(rangeStats.downSec)} down`
      : 'Pending first check';

    // Hourly strip
    const stripBars = generate24HourStrip(m.id);
    $('#strip').innerHTML = stripBars.map(b => `<i class="${b.color}" title="${b.label}"></i>`).join('');

    // Historical metric cards
    const s7d = calculateMonitorUptime(m.id, 7 * 86400000);
    const s30d = calculateMonitorUptime(m.id, 30 * 86400000);
    const s365d = calculateMonitorUptime(m.id, 365 * 86400000);

    const setMetricCol = (el, pct) => {
      if (pct === null) {
        el.className = 'v mono';
        el.textContent = '—';
        return;
      }
      el.className = 'v mono ' + (pct < 95 ? 'r' : pct < 99.5 ? 'y' : 'g');
      el.textContent = `${pct}%`;
    };

    setMetricCol($('#d-7d'), s7d.uptimePct);
    $('#d-7d-inc').textContent = s7d.hasData !== false
      ? `${s7d.incidentCount} incident${s7d.incidentCount === 1 ? '' : 's'}`
      : 'No checks yet';

    setMetricCol($('#d-30d'), s30d.uptimePct);
    $('#d-30d-down').textContent = s30d.hasData !== false
      ? `${formatDuration(s30d.downSec)} down`
      : 'No checks yet';

    $('#d-365d').textContent = (s365d.hasData !== false && s365d.uptimePct !== null) ? `${s365d.uptimePct}%` : '—';

    $('#d-dtlabel').textContent = `Downtime (${state.selectedRange})`;
    $('#d-dtval').textContent = rangeStats.hasData !== false ? formatDuration(rangeStats.downSec) : '—';

    $('#d-mtbflabel').textContent = `MTBF (${state.selectedRange})`;
    const mtbfEl = $('#d-mtbf');
    if (rangeStats.mtbfHours < 0) {
      mtbfEl.className = 'v mono';
      mtbfEl.textContent = '—';
    } else {
      mtbfEl.className = 'v mono g';
      mtbfEl.textContent = rangeStats.mtbfHours >= 24 ?
        `${(rangeStats.mtbfHours / 24).toFixed(1)}d` : `${rangeStats.mtbfHours.toFixed(2)}h`;
    }

    // Response time latency chart
    renderLatencyChart(m.id, rangeMs);

    // Monitor Incidents Table
    const monIncidents = state.incidents.filter(inc => inc.monitor_id === m.id);
    const incTb = $('#d-inc-tb');
    if (monIncidents.length === 0) {
      incTb.innerHTML = '<tr><td colspan="5" class="sub" style="text-align:center;padding:24px">No incidents recorded for this monitor.</td></tr>';
    } else {
      incTb.innerHTML = monIncidents.map(inc => {
        const isResolved = !!inc.resolved_at;
        const dot = isResolved ? 'bgg' : 'bgr';
        const stText = isResolved ? 'Resolved' : 'Active outage';
        const stCls = isResolved ? 'g' : 'r';
        const badge = inc.http_status ? `<span class="badge ${isResolved ? 'resolved' : ''}">${inc.http_status}</span>` : '';

        return `
          <tr>
            <td class="${stCls}"><span class="dot ${dot}"></span>${stText}</td>
            <td>${badge}${escapeHtml(inc.root_cause)}</td>
            <td class="mono" style="color:var(--t2);font-size:13px">${formatTimestamp(inc.started_at)}</td>
            <td class="mono" style="color:var(--t2);font-size:13px">${formatTimestamp(inc.resolved_at)}</td>
            <td class="mono">${formatDuration(inc.duration_seconds)}</td>
          </tr>
        `;
      }).join('');
    }
  }

  function calculateStateDurationText(monitor) {
    const hasAnyChecks = state.checks.some(c => c.monitor_id === monitor.id);
    if (!monitor.last_checked_at && !hasAnyChecks) return 'Not checked yet';
    if (monitor.is_paused) return 'Paused';

    const st = getEffectiveStatus(monitor);

    // 1. If currently UNKNOWN / Stale
    if (st === 'UNKNOWN') {
      if (monitor.last_checked_at) {
        const elapsedSec = Math.max(0, Math.floor((Date.now() - new Date(monitor.last_checked_at).getTime()) / 1000));
        return `Awaiting runner · Last probe was ${formatDuration(elapsedSec)} ago`;
      }
      return 'Awaiting initial probe';
    }

    // 2. If currently DOWN, count duration since current outage started
    if (st === 'DOWN') {
      const activeInc = state.incidents.find(inc => inc.monitor_id === monitor.id && !inc.resolved_at);
      const startStr = activeInc ? activeInc.started_at : monitor.last_checked_at;
      const startTime = startStr ? new Date(startStr).getTime() : Date.now();
      const diffSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
      return `Down for ${formatDuration(diffSec)}`;
    }

    // 2. Currently UP (or DEGRADED): calculate continuous uptime since last downtime
    const monIncidents = state.incidents
      .filter(inc => inc.monitor_id === monitor.id)
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

    let continuousUpStart = 0;
    if (monIncidents.length > 0 && monIncidents[0].resolved_at) {
      continuousUpStart = new Date(monIncidents[0].resolved_at).getTime();
    }

    if (!continuousUpStart || isNaN(continuousUpStart)) {
      // No prior incident: calculate from monitor creation or earliest check
      const monChecks = state.checks.filter(c => c.monitor_id === monitor.id);
      const checkTimes = monChecks
        .map(c => new Date(c.checked_at).getTime())
        .filter(t => !isNaN(t) && t > 0);

      const createdTime = monitor.created_at ? new Date(monitor.created_at).getTime() : 0;

      if (createdTime > 0 && checkTimes.length > 0) {
        continuousUpStart = Math.min(createdTime, Math.min(...checkTimes));
      } else if (createdTime > 0) {
        continuousUpStart = createdTime;
      } else if (checkTimes.length > 0) {
        continuousUpStart = Math.min(...checkTimes);
      } else {
        continuousUpStart = monitor.last_checked_at ? new Date(monitor.last_checked_at).getTime() : Date.now();
      }
    }

    if (isNaN(continuousUpStart) || continuousUpStart <= 0) {
      continuousUpStart = Date.now();
    }

    const diffSec = Math.max(0, Math.floor((Date.now() - continuousUpStart) / 1000));
    return `Up for ${formatDuration(diffSec)}`;
  }

  // Draw SVG Latency Chart matching pulse-reference.html
  function renderLatencyChart(monitorId, windowMs) {
    const now = Date.now();
    const windowStart = now - windowMs;

    // Filter checks for this monitor in range
    const checksInRange = state.checks
      .filter(c => c.monitor_id === monitorId && new Date(c.checked_at).getTime() >= windowStart)
      .sort((a, b) => new Date(a.checked_at).getTime() - new Date(b.checked_at).getTime());

    const svg = $('#chart');
    const tip = $('#tip');

    if (checksInRange.length === 0) {
      svg.innerHTML = `
        <text x="400" y="95" fill="#707070" text-anchor="middle" font-size="14">No response time data recorded yet</text>
        <text x="400" y="125" fill="#a1a1a1" text-anchor="middle" font-size="12">Awaiting scheduled keep-alive probes from GitHub Actions</text>
      `;
      $('#ch-avg').textContent = '—';
      $('#ch-min').textContent = '—';
      $('#ch-max').textContent = '—';
      return;
    }

    const W = 800, H = 220;
    const latencies = checksInRange.map(c => Math.max(1, c.response_time_ms));
    const maxVal = Math.max(1000, ...latencies, state.settings.degraded_threshold_ms || 1000);
    const N = checksInRange.length;

    const x = i => N > 1 ? (i / (N - 1)) * W : W / 2;
    const y = v => H - 24 - (v / maxVal) * (H - 34);

    // Compute stats
    let sum = 0, minL = Infinity, maxL = 0;
    latencies.forEach(l => {
      sum += l;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    });
    const avgL = Math.round(sum / latencies.length);

    $('#ch-avg').textContent = `${avgL} ms`;
    $('#ch-min').textContent = `${minL} ms`;
    $('#ch-max').textContent = `${maxL} ms`;

    // Gridlines at 25%, 50%, 75%, 100% of maxVal
    let s = '';
    const gridSteps = [Math.round(maxVal * 0.25), Math.round(maxVal * 0.5), Math.round(maxVal * 0.75), maxVal];
    gridSteps.forEach(g => {
      s += `<line x1="0" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="#1a1a1a" vector-effect="non-scaling-stroke"/>`;
    });

    // Outage bands (regions where monitor was DOWN)
    for (let i = 0; i < N; i++) {
      if (checksInRange[i].status === 'DOWN') {
        const x1 = Math.max(0, x(i) - (W / Math.max(1, N)) / 2);
        const w = W / Math.max(1, N);
        s += `<rect x="${x1}" width="${w}" y="0" height="${H - 24}" fill="rgba(238,0,0,.14)"/>`;
      }
    }

    if (N === 1) {
      // Single check point
      s += `<line x1="0" x2="${W}" y1="${y(latencies[0])}" stroke="#00c853" stroke-width="1.5" stroke-dasharray="4" vector-effect="non-scaling-stroke"/>`;
      s += `<circle cx="${W / 2}" cy="${y(latencies[0])}" r="5" fill="#00c853"/>`;
    } else {
      // Polyline connecting points
      const points = checksInRange.map((c, i) => `${x(i)},${y(c.response_time_ms)}`).join(' ');
      s += `<polyline fill="none" stroke="#00c853" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${points}"/>`;
      checksInRange.forEach((c, i) => {
        const dotCol = c.status === 'DOWN' ? '#ee0000' : (c.status === 'DEGRADED' ? '#f5a623' : '#00c853');
        s += `<circle cx="${x(i)}" cy="${y(c.response_time_ms)}" r="2.5" fill="${dotCol}"/>`;
      });
    }

    s += `<line id="cx2" y1="0" y2="${H - 24}" stroke="#555" vector-effect="non-scaling-stroke" style="display:none"/>`;

    svg.innerHTML = s;

    // Interactive Hover
    svg.onmousemove = e => {
      const r = svg.getBoundingClientRect();
      const clickX = e.clientX - r.left;
      const idx = Math.min(N - 1, Math.max(0, Math.round((clickX / r.width) * (N - 1))));
      const c = checksInRange[idx];

      const l = $('#cx2');
      if (l) {
        l.setAttribute('x1', x(idx));
        l.setAttribute('x2', x(idx));
        l.style.display = '';
      }

      tip.style.display = 'block';
      tip.style.left = Math.min(clickX + 20, r.width - 160) + 'px';
      tip.style.top = '40px';

      const isDown = c.status === 'DOWN';
      const stColor = isDown ? 'r' : (c.status === 'DEGRADED' ? 'y' : 'g');
      tip.innerHTML = `
        ${formatTimestamp(c.checked_at)}<br>
        ${c.response_time_ms} ms · <span class="${stColor}">${c.status}</span>
        ${c.status_code ? ` (${c.status_code})` : ''}
      `;
    };

    svg.onmouseleave = () => {
      tip.style.display = 'none';
      const l = $('#cx2');
      if (l) l.style.display = 'none';
    };
  }

  // Render Monitors Page
  function renderMonitors() {
    const tb = $('#mon-tb');
    const search = ($('#mon-search').value || '').toLowerCase().trim();
    const filter = $('#mon-filter').value;
    const sort = $('#mon-sort').value;

    let list = state.monitors.filter(m => {
      if (search && !m.name.toLowerCase().includes(search) && !m.url.toLowerCase().includes(search)) {
        return false;
      }
      const stKey = getEffectiveStatus(m);
      if (filter !== 'all' && stKey !== filter) return false;
      return true;
    });

    // Sorting
    list.sort((a, b) => {
      const stA = getEffectiveStatus(a);
      const stB = getEffectiveStatus(b);
      if (sort === 'down_first') {
        if (stA === 'DOWN' && stB !== 'DOWN') return -1;
        if (stB === 'DOWN' && stA !== 'DOWN') return 1;
        return a.name.localeCompare(b.name);
      }
      if (sort === 'name_asc') return a.name.localeCompare(b.name);
      if (sort === 'uptime_desc' || sort === 'uptime_asc') {
        const uA = calculateMonitorUptime(a.id, 86400000).uptimePct ?? -1;
        const uB = calculateMonitorUptime(b.id, 86400000).uptimePct ?? -1;
        return sort === 'uptime_desc' ? uB - uA : uA - uB;
      }
      return 0;
    });

    $('#mon-count').textContent = `Using ${state.monitors.length} monitor${state.monitors.length === 1 ? '' : 's'}`;

    if (list.length === 0) {
      tb.innerHTML = '<tr><td colspan="5" class="sub" style="text-align:center;padding:32px">No monitors found.</td></tr>';
      return;
    }

    tb.innerHTML = list.map(m => {
      const stKey = getEffectiveStatus(m);
      const s = statusStyles[stKey] || statusStyles.UNKNOWN;
      const stats = calculateMonitorUptime(m.id, 86400000);
      const strip = generate24HourStrip(m.id);
      const host = formatHost(m.url);
      const isStale = stKey === 'UNKNOWN' && m.last_checked_at;
      const statusLabel = isStale ? 'Unknown (stale)' : s.text;

      return `
        <tr>
          <td class="clk" data-open-detail="${m.id}">
            <span class="dot ${s.bg}"></span><b>${escapeHtml(m.name || 'Unnamed')}</b>
            <div class="mono" style="display:inline;color:var(--t3);margin-left:10px;font-size:13px">${escapeHtml(host)}</div>
          </td>
          <td><span class="tag">HTTP</span></td>
          <td class="mono">${m.interval_minutes} min</td>
          <td>
            <span class="mini">
              ${strip.map(b => `<i class="${b.color}"></i>`).join('')}
            </span>
            <span class="mono">${stats.uptimePct !== null ? stats.uptimePct + '%' : '—'}</span>
          </td>
          <td style="text-align:right">
            <div class="actions-menu">
              <button class="btn sm" data-probe="${m.id}" title="Execute a live server-side reachability probe">⚡ Test</button>
              <button class="btn sm" data-pause="${m.id}">${m.is_paused ? 'Resume' : 'Pause'}</button>
              <button class="btn sm" data-edit="${m.id}">Edit</button>
              <button class="btn sm danger" data-delete="${m.id}">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Filter/Sort Listeners on Monitors Page
  $('#mon-search').oninput = renderMonitors;
  $('#mon-filter').onchange = renderMonitors;
  $('#mon-sort').onchange = renderMonitors;

  // Monitors Table Actions
  $('#mon-tb').onclick = async e => {
    const probeBtn = e.target.closest('[data-probe]');
    if (probeBtn) {
      const id = probeBtn.dataset.probe;
      await executeLiveProbe(id, probeBtn);
      return;
    }

    const detailTd = e.target.closest('[data-open-detail]');
    if (detailTd) {
      location.hash = '#overview';
      openMonitorDetail(detailTd.dataset.openDetail);
      return;
    }

    const pauseBtn = e.target.closest('[data-pause]');
    if (pauseBtn) {
      const id = pauseBtn.dataset.pause;
      const m = state.monitors.find(mon => mon.id === id);
      if (!m) return;
      const newPaused = !m.is_paused;
      const newStatus = newPaused ? 'PAUSED' : 'UNKNOWN';

      const { error } = await state.client
        .from('monitors')
        .update({
          is_paused: newPaused,
          current_status: newStatus,
          next_check_at: newPaused ? null : new Date().toISOString()
        })
        .eq('id', id);

      if (error) {
        showToast('Error: ' + error.message);
      } else {
        showToast(newPaused ? 'Monitor paused' : 'Monitor resumed');
        await loadAllData(true);
      }
      return;
    }

    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      const id = editBtn.dataset.edit;
      const m = state.monitors.find(mon => mon.id === id);
      if (!m) return;
      $('#edit-id').value = m.id;
      $('#edit-name').value = m.name;
      $('#edit-url').value = m.url;
      updateIntervalSelector('#edit-interval-seg', '#edit-interval', m.interval_minutes || 5);
      $('#edit-threshold').value = String(m.degraded_threshold_ms);
      $('#edit-ov').classList.add('on');
      return;
    }

    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) {
      const id = delBtn.dataset.delete;
      const m = state.monitors.find(mon => mon.id === id);
      if (!m) return;
      $('#del-mon-name').textContent = m.name;
      $('#del-confirm').dataset.id = m.id;
      $('#del-ov').classList.add('on');
      return;
    }
  };

  // Render Incidents Page
  function renderIncidents() {
    const search = ($('#inc-search').value || '').toLowerCase().trim();
    const filter = $('#inc-filter').value;
    const sort = $('#inc-sort').value;

    let list = state.incidents.filter(inc => {
      const mon = state.monitors.find(m => m.id === inc.monitor_id);
      const name = mon ? mon.name.toLowerCase() : '';
      const url = mon ? mon.url.toLowerCase() : '';
      const cause = (inc.root_cause || '').toLowerCase();

      if (search && !name.includes(search) && !url.includes(search) && !cause.includes(search)) {
        return false;
      }
      if (filter === 'active' && inc.resolved_at) return false;
      if (filter === 'resolved' && !inc.resolved_at) return false;
      return true;
    });

    list.sort((a, b) => {
      const tA = new Date(a.started_at).getTime();
      const tB = new Date(b.started_at).getTime();
      return sort === 'newest' ? tB - tA : tA - tB;
    });

    const tb = $('#inc');
    const tln = $('#tln');

    if (list.length === 0) {
      tb.innerHTML = '<tr><td colspan="6" class="sub" style="text-align:center;padding:32px">No incidents match the selected criteria.</td></tr>';
      tln.innerHTML = '<div class="sub" style="padding:24px;text-align:center">No incidents recorded.</div>';
      return;
    }

    // Table view
    tb.innerHTML = list.map(inc => {
      const mon = state.monitors.find(m => m.id === inc.monitor_id);
      const isResolved = !!inc.resolved_at;
      const dot = isResolved ? 'bgg' : 'bgr';
      const stText = isResolved ? 'Resolved' : 'Active outage';
      const stCls = isResolved ? 'g' : 'r';
      const badge = inc.http_status ? `<span class="badge ${isResolved ? 'resolved' : ''}">${inc.http_status}</span>` : '';
      const host = mon ? formatHost(mon.url) : '—';

      return `
        <tr>
          <td class="${stCls}"><span class="dot ${dot}"></span>${stText}</td>
          <td class="mono" style="font-size:13px">${escapeHtml(host)}</td>
          <td>${badge}${escapeHtml(inc.root_cause)}</td>
          <td class="mono" style="color:var(--t2);font-size:13px">${formatTimestamp(inc.started_at)}</td>
          <td class="mono" style="color:var(--t2);font-size:13px">${formatTimestamp(inc.resolved_at)}</td>
          <td class="mono">${formatDuration(inc.duration_seconds)}</td>
        </tr>
      `;
    }).join('');

    // Timeline view
    tln.innerHTML = list.map(inc => {
      const mon = state.monitors.find(m => m.id === inc.monitor_id);
      const name = mon ? mon.name : 'Service';
      const isResolved = !!inc.resolved_at;
      const badge = inc.http_status ? `<span class="badge ${isResolved ? 'resolved' : ''}">${inc.http_status}</span>` : '';

      return `
        <div>
          <time class="mono">${formatTimestamp(inc.started_at)}</time>
          <span>
            ${badge}<b>${escapeHtml(name)}</b> · ${escapeHtml(inc.root_cause)}
            ${isResolved ? ` · resolved after <span class="mono">${formatDuration(inc.duration_seconds)}</span>` : ' · <span class="r">ongoing</span>'}
          </span>
        </div>
      `;
    }).join('');
  }

  $('#inc-search').oninput = renderIncidents;
  $('#inc-filter').onchange = renderIncidents;
  $('#inc-sort').onchange = renderIncidents;

  // View toggle: Table vs Timeline
  $('#vw').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return;
    [...$('#vw').children].forEach(b => b.classList.toggle('on', b === e.target));
    const isTimeline = e.target.textContent === 'Timeline';
    $('#tbl').style.display = isTimeline ? 'none' : '';
    $('#tln').style.display = isTimeline ? '' : 'none';
  });

  // Export Incidents as CSV
  $('#exp').onclick = () => {
    showToast('Exporting logs…');
    if (state.incidents.length === 0) {
      showToast('No incidents to export');
      return;
    }

    const headers = ['id', 'monitor_name', 'monitor_url', 'status', 'root_cause', 'http_status', 'started_at', 'resolved_at', 'duration_seconds'];
    const rows = state.incidents.map(inc => {
      const mon = state.monitors.find(m => m.id === inc.monitor_id);
      return [
        inc.id,
        mon ? `"${mon.name.replace(/"/g, '""')}"` : 'Unknown',
        mon ? `"${mon.url.replace(/"/g, '""')}"` : 'Unknown',
        inc.resolved_at ? 'Resolved' : 'Active',
        `"${(inc.root_cause || '').replace(/"/g, '""')}"`,
        inc.http_status || '',
        inc.started_at,
        inc.resolved_at || '',
        inc.duration_seconds || ''
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pulse-incidents-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Render Maintenance Page
  function renderMaintenance() {
    const tb = $('#maint-tb');
    const emptyBox = $('#maint-empty');
    const tableBox = $('#maint-table-box');

    if (state.maintenance.length === 0) {
      emptyBox.style.display = 'block';
      tableBox.style.display = 'none';
      return;
    }

    emptyBox.style.display = 'none';
    tableBox.style.display = 'block';

    const now = Date.now();

    tb.innerHTML = state.maintenance.map(mw => {
      const mon = state.monitors.find(m => m.id === mw.monitor_id);
      const targetText = mon ? mon.name : 'All monitors (Fleet-wide)';

      const sTime = new Date(mw.start_time).getTime();
      const eTime = new Date(mw.end_time).getTime();

      let statusBadge = '<span class="tag">Upcoming</span>';
      if (now >= sTime && now <= eTime) {
        statusBadge = '<span class="badge maint">Active</span>';
      } else if (now > eTime) {
        statusBadge = '<span class="tag" style="opacity:.6">Completed</span>';
      }

      return `
        <tr>
          <td>
            <b>${escapeHtml(mw.name)}</b>
            ${mw.description ? `<div class="sub">${escapeHtml(mw.description)}</div>` : ''}
          </td>
          <td><span class="tag">${escapeHtml(targetText)}</span></td>
          <td class="mono" style="color:var(--t2);font-size:13px">${formatTimestamp(mw.start_time)}</td>
          <td class="mono" style="color:var(--t2);font-size:13px">${formatTimestamp(mw.end_time)}</td>
          <td>${statusBadge}</td>
          <td style="text-align:right">
            <button class="btn sm danger" data-del-maint="${mw.id}">Delete</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  $('#maint-tb').onclick = async e => {
    const delBtn = e.target.closest('[data-del-maint]');
    if (!delBtn) return;
    const id = delBtn.dataset.delMaint;
    const { error } = await state.client.from('maintenance_windows').delete().eq('id', id);
    if (error) {
      showToast('Error: ' + error.message);
    } else {
      showToast('Maintenance window deleted');
      await loadAllData(true);
    }
  };

  // Open Create Maintenance Modal
  function openMaintenanceModal() {
    const select = $('#mw-mon');
    select.innerHTML = '<option value="">All monitors (Fleet-wide)</option>' +
      state.monitors.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');

    const now = new Date();
    const plus1h = new Date(now.getTime() + 3600000);
    const toIsoLocal = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

    $('#mw-start').value = toIsoLocal(now);
    $('#mw-end').value = toIsoLocal(plus1h);
    $('#mw-name').value = '';
    $('#mw-desc').value = '';
    $('#maint-ov').classList.add('on');
  }

  $('#open-maint').onclick = openMaintenanceModal;
  $('#open-maint-2').onclick = openMaintenanceModal;
  $('#maint-cx').onclick = () => $('#maint-ov').classList.remove('on');

  $('#maint-save').onclick = async () => {
    const name = $('#mw-name').value.trim();
    const desc = $('#mw-desc').value.trim();
    const monId = $('#mw-mon').value || null;
    const startStr = $('#mw-start').value;
    const endStr = $('#mw-end').value;

    if (!name) {
      showToast('Please enter a maintenance name');
      return;
    }
    if (!startStr || !endStr) {
      showToast('Please select start and end dates');
      return;
    }

    const startDate = new Date(startStr);
    const endDate = new Date(endStr);
    if (endDate <= startDate) {
      showToast('End time must be after start time');
      return;
    }

    const { error } = await state.client.from('maintenance_windows').insert({
      user_id: state.user.id,
      name,
      description: desc || null,
      monitor_id: monId,
      start_time: startDate.toISOString(),
      end_time: endDate.toISOString()
    });

    if (error) {
      showToast('Error: ' + error.message);
    } else {
      $('#maint-ov').classList.remove('on');
      showToast('Maintenance window scheduled');
      await loadAllData(true);
    }
  };

  // Minimalist Line Style & Custom Numeric Input Interval Selector
  function setupIntervalSelector(segId, inputId) {
    const seg = $(segId);
    const input = $(inputId);
    if (!seg || !input) return;

    const syncButtons = val => {
      const num = parseInt(val, 10);
      $$('button', seg).forEach(b => {
        b.classList.toggle('on', parseInt(b.dataset.val, 10) === num);
      });
    };

    seg.onclick = e => {
      const btn = e.target.closest('button[data-val]');
      if (!btn) return;
      const val = btn.dataset.val;
      input.value = val;
      syncButtons(val);
    };

    input.oninput = () => {
      syncButtons(input.value);
    };
  }

  function updateIntervalSelector(segId, inputId, val) {
    const input = $(inputId);
    const seg = $(segId);
    const num = parseInt(val, 10) || 5;
    if (input) input.value = String(num);
    if (seg) {
      $$('button', seg).forEach(b => {
        b.classList.toggle('on', parseInt(b.dataset.val, 10) === num);
      });
    }
  }

  setupIntervalSelector('#m-interval-seg', '#m-interval');
  setupIntervalSelector('#edit-interval-seg', '#edit-interval');

  // Create Monitor Modal Handlers
  $$('[data-open]').forEach(b => b.onclick = () => {
    $('#m-name').value = '';
    $('#m-url').value = '';
    updateIntervalSelector('#m-interval-seg', '#m-interval', state.settings.default_interval_minutes || 5);
    $('#m-threshold').value = String(state.settings.degraded_threshold_ms || 1000);
    $('#ov').classList.add('on');
  });

  $('#cx').onclick = () => $('#ov').classList.remove('on');
  $('#ov').onclick = e => { if (e.target.id === 'ov') $('#ov').classList.remove('on'); };

  $('#cr').onclick = async () => {
    const name = $('#m-name').value.trim();
    let url = $('#m-url').value.trim();
    const interval = parseInt($('#m-interval').value, 10);
    const threshold = parseInt($('#m-threshold').value, 10) || 1000;

    if (!name) {
      showToast('Please enter a monitor name');
      return;
    }
    if (!url) {
      showToast('Please enter a target URL');
      return;
    }
    if (isNaN(interval) || interval < 5 || interval > 1440) {
      showToast('Minimum check interval is 5 minutes (5 to 1440 minutes)');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    const { error } = await state.client.from('monitors').insert({
      user_id: state.user.id,
      name,
      url,
      interval_minutes: interval,
      timeout_seconds: state.settings.default_timeout_seconds || 15,
      degraded_threshold_ms: threshold,
      next_check_at: new Date().toISOString()
    });

    if (error) {
      showToast('Error: ' + error.message);
    } else {
      $('#ov').classList.remove('on');
      showToast('Monitor created');
      await loadAllData(true);
    }
  };

  // Edit Monitor Modal Handlers
  $('#edit-cx').onclick = () => $('#edit-ov').classList.remove('on');
  $('#edit-ov').onclick = e => { if (e.target.id === 'edit-ov') $('#edit-ov').classList.remove('on'); };

  $('#edit-save').onclick = async () => {
    const id = $('#edit-id').value;
    const name = $('#edit-name').value.trim();
    let url = $('#edit-url').value.trim();
    const interval = parseInt($('#edit-interval').value, 10);
    const threshold = parseInt($('#edit-threshold').value, 10) || 1000;

    if (!name || !url) {
      showToast('Please fill all required fields');
      return;
    }
    if (isNaN(interval) || interval < 5 || interval > 1440) {
      showToast('Minimum check interval is 5 minutes (5 to 1440 minutes)');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    const { error } = await state.client
      .from('monitors')
      .update({
        name,
        url,
        interval_minutes: interval,
        degraded_threshold_ms: threshold,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) {
      showToast('Error: ' + error.message);
    } else {
      $('#edit-ov').classList.remove('on');
      showToast('Monitor updated');
      await loadAllData(true);
    }
  };

  // Delete Monitor Modal Handlers
  $('#del-cx').onclick = () => $('#del-ov').classList.remove('on');
  $('#del-ov').onclick = e => { if (e.target.id === 'del-ov') $('#del-ov').classList.remove('on'); };

  $('#del-confirm').onclick = async () => {
    const id = $('#del-confirm').dataset.id;
    const { error } = await state.client.from('monitors').delete().eq('id', id);
    if (error) {
      showToast('Error: ' + error.message);
    } else {
      $('#del-ov').classList.remove('on');
      showToast('Monitor deleted');
      if (state.currentMonitorId === id) {
        state.currentMonitorId = null;
        $('#overview').classList.remove('det');
      }
      await loadAllData(true);
    }
  };

  // Save Settings Handlers
  $('#save').onclick = async () => {
    const interval = parseInt($('#set-interval').value, 10);
    const timeout = parseInt($('#set-timeout').value, 10);
    const degraded = parseInt($('#set-degraded').value, 10);
    const tz = $('#set-tz').value;

    if (isNaN(interval) || interval < 5 || interval > 1440) {
      showToast('Default check interval must be between 5 and 1440 minutes');
      return;
    }
    if (isNaN(timeout) || timeout < 5 || timeout > 120) {
      showToast('Default timeout must be between 5 and 120 seconds');
      return;
    }
    if (isNaN(degraded) || degraded < 100 || degraded > 10000) {
      showToast('Degraded threshold must be between 100 and 10000 ms');
      return;
    }

    state.settings.default_interval_minutes = interval;
    state.settings.default_timeout_seconds = timeout;
    state.settings.degraded_threshold_ms = degraded;
    state.settings.dashboard_timezone = tz;

    const { error } = await state.client.from('app_settings').upsert({
      user_id: state.user.id,
      default_interval_minutes: interval,
      default_timeout_seconds: timeout,
      degraded_threshold_ms: degraded,
      dashboard_timezone: tz,
      updated_at: new Date().toISOString()
    });

    if (error) {
      showToast('Error: ' + error.message);
    } else {
      showToast('Settings saved');
      renderOverview();
      renderMonitors();
      renderIncidents();
    }
  };

  // Escape key closes modals
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $$('.ov').forEach(el => el.classList.remove('on'));
    }
    // Command+K quick focus search
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      location.hash = '#monitors';
      setTimeout(() => $('#mon-search')?.focus(), 100);
    }
  });

  $('#quick-search').onclick = () => {
    location.hash = '#monitors';
    setTimeout(() => $('#mon-search')?.focus(), 100);
  };

  // Helper: Format Hostname from URL
  function formatHost(rawUrl) {
    try {
      const u = new URL(rawUrl);
      return u.hostname;
    } catch {
      return rawUrl;
    }
  }

  // Helper: Escape HTML string
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initialize
  route();
  initAuth();
})();
