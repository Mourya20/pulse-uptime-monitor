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
      default_interval_minutes: 15,
      default_timeout_seconds: 90,
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

  // Calculate Duration-Weighted Availability for a Monitor within a Time Window
  function calculateMonitorUptime(monitorId, windowMs) {
    const now = Date.now();
    const windowStart = now - windowMs;

    // Filter incidents for this monitor overlapping with [windowStart, now]
    const relevantIncidents = state.incidents.filter(inc => {
      if (inc.monitor_id !== monitorId) return false;
      const s = new Date(inc.started_at).getTime();
      const e = inc.resolved_at ? new Date(inc.resolved_at).getTime() : now;
      return e >= windowStart && s <= now;
    });

    // Check maintenance windows
    const relevantMaint = state.maintenance.filter(m => {
      if (m.monitor_id && m.monitor_id !== monitorId) return false;
      const s = new Date(m.start_time).getTime();
      const e = new Date(m.end_time).getTime();
      return e >= windowStart && s <= now;
    });

    // Sum maintenance duration within window
    let totalMaintMs = 0;
    relevantMaint.forEach(m => {
      const s = Math.max(windowStart, new Date(m.start_time).getTime());
      const e = Math.min(now, new Date(m.end_time).getTime());
      if (e > s) totalMaintMs += (e - s);
    });

    const effectiveMonitoredMs = Math.max(1, windowMs - totalMaintMs);

    // Sum outage duration within window (excluding maintenance periods)
    let totalDownMs = 0;
    relevantIncidents.forEach(inc => {
      const s = Math.max(windowStart, new Date(inc.started_at).getTime());
      const e = Math.min(now, inc.resolved_at ? new Date(inc.resolved_at).getTime() : now);
      if (e > s) {
        // Exclude maintenance overlap
        let overlapWithMaint = 0;
        relevantMaint.forEach(m => {
          const ms = Math.max(s, new Date(m.start_time).getTime());
          const me = Math.min(e, new Date(m.end_time).getTime());
          if (me > ms) overlapWithMaint += (me - ms);
        });
        totalDownMs += Math.max(0, (e - s) - overlapWithMaint);
      }
    });

    totalDownMs = Math.min(effectiveMonitoredMs, totalDownMs);
    const upMs = effectiveMonitoredMs - totalDownMs;
    const uptimePct = ((upMs / effectiveMonitoredMs) * 100);

    // Latency calculations from checks
    const monChecks = state.checks.filter(c => {
      if (c.monitor_id !== monitorId) return false;
      const t = new Date(c.checked_at).getTime();
      return t >= windowStart && t <= now && (c.status === 'UP' || c.status === 'DEGRADED');
    });

    const m = state.monitors.find(mon => mon.id === monitorId);
    const hasAnyChecks = state.checks.some(c => c.monitor_id === monitorId);
    const isPending = !m?.last_checked_at && !hasAnyChecks;

    if (isPending) {
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

    // All checks for this monitor within window
    const allChecksInWindow = state.checks.filter(c => {
      if (c.monitor_id !== monitorId) return false;
      const t = new Date(c.checked_at).getTime();
      return t >= windowStart && t <= now;
    });

    let calculatedUptime = uptimePct;
    if (relevantIncidents.length === 0 && allChecksInWindow.length > 0) {
      const successfulChecks = allChecksInWindow.filter(c => c.status === 'UP' || c.status === 'DEGRADED').length;
      calculatedUptime = (successfulChecks / allChecksInWindow.length) * 100;
    }

    let avgLat = 0, minLat = 0, maxLat = 0;
    if (monChecks.length > 0) {
      minLat = Infinity;
      let sum = 0;
      monChecks.forEach(c => {
        sum += c.response_time_ms;
        if (c.response_time_ms < minLat) minLat = c.response_time_ms;
        if (c.response_time_ms > maxLat) maxLat = c.response_time_ms;
      });
      avgLat = Math.round(sum / monChecks.length);
    } else {
      minLat = 0;
    }

    // MTBF
    let mtbfHours = -1;
    if (relevantIncidents.length > 0) {
      mtbfHours = (upMs / 3600000) / relevantIncidents.length;
    }

    return {
      uptimePct: parseFloat(calculatedUptime.toFixed(2)),
      downSec: Math.floor(totalDownMs / 1000),
      incidentCount: relevantIncidents.length,
      mtbfHours,
      avgLat,
      minLat,
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
    let supabaseUrl = window.PULSE_CONFIG?.supabaseUrl || localStorage.getItem('PULSE_SUPABASE_URL') || '';
    let supabaseKey = window.PULSE_CONFIG?.supabaseAnonKey || localStorage.getItem('PULSE_SUPABASE_ANON_KEY') || '';

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

  // Handle Login submission
  $('#auth-login').onclick = async () => {
    const errBanner = $('#auth-err');
    errBanner.classList.remove('on');

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

    try {
      const { data, error } = await state.client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      state.user = data.user;
      $('#auth-ov').classList.remove('on');
      $('#settings-user').textContent = state.user.email || 'Owner';
      showToast('Signed in successfully');
      await loadAllData();
      startPolling();
    } catch (err) {
      let msg = err.message || 'Invalid credentials.';
      if (msg.includes('Failed to fetch') || msg.includes('fetch')) {
        msg = 'Failed to fetch: Unable to reach Supabase. Check: 1) URL must be https://<id>.supabase.co (NOT the postgresql:// database string), 2) Check if project is paused in Supabase Dashboard, 3) Disable any ad-blockers.';
        $('#auth-config-fields').style.display = 'block';
      }
      errBanner.textContent = msg;
      errBanner.classList.add('on');
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
              intervalEl.textContent = `Checking soon… (every ${m.interval_minutes}m)`;
            }
          }
        }
      }

      // 2. Check if any monitor is due for an automated keep-alive probe from this dashboard
      const now = Date.now();
      state.monitors.forEach(mon => {
        if (!mon.is_paused && mon.next_check_at) {
          const dueTime = new Date(mon.next_check_at).getTime();
          // If due within 2s and hasn't been probed in the last 15s
          if (now >= dueTime && (!mon.last_checked_at || (now - new Date(mon.last_checked_at).getTime() > 15000))) {
            triggerManualPing(mon.id);
          }
        }
      });
    }, 1000);
  }

  // Load all application data from Supabase
  async function loadAllData(quiet = false) {
    if (!state.client) return;

    try {
      // 1. Fetch settings
      const { data: setts } = await state.client.from('app_settings').select('*').limit(1);
      if (setts && setts.length > 0) {
        state.settings = { ...state.settings, ...setts[0] };
        $('#set-interval').value = String(state.settings.default_interval_minutes || 15);
        $('#set-timeout').value = String(state.settings.default_timeout_seconds || 90);
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

      // 5. Fetch recent checks (last 1000)
      const { data: chks, error: chkErr } = await state.client
        .from('checks')
        .select('*')
        .order('checked_at', { ascending: false })
        .limit(1000);
      if (chkErr) throw chkErr;
      state.checks = chks || [];

      // Render all views
      renderOverview();
      renderMonitors();
      renderIncidents();
      renderMaintenance();

      // If viewing detail, refresh detail view
      if (state.currentMonitorId) {
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
    let upCount = 0, downCount = 0, degradedCount = 0;
    let totalUptime = 0;

    let validUptimeCount = 0;
    state.monitors.forEach(m => {
      const st = m.is_paused ? 'PAUSED' : (m.current_status || 'UNKNOWN');
      if (st === 'UP') upCount++;
      else if (st === 'DOWN') downCount++;
      else if (st === 'DEGRADED') degradedCount++;

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
        const stKey = m.is_paused ? 'PAUSED' : (m.current_status || 'UNKNOWN');
        const s = statusStyles[stKey] || statusStyles.UNKNOWN;
        const stats = calculateMonitorUptime(m.id, 86400000);
        const strip = generate24HourStrip(m.id);
        const host = formatHost(m.url);

        return `
          <tr class="clk" data-id="${m.id}">
            <td>
              <span class="dot ${s.bg}"></span><b>${escapeHtml(m.name || 'Unnamed')}</b>
              <span class="mono" style="color:var(--t3);margin-left:10px;font-size:13px">${escapeHtml(host)}</span>
            </td>
            <td class="${s.cls}">${s.text}</td>
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

  // Open Monitor Detail View
  function openMonitorDetail(monitorId) {
    state.currentMonitorId = monitorId;
    $('#overview').classList.add('det');
    renderMonitorDetail(monitorId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('#back').onclick = () => {
    state.currentMonitorId = null;
    $('#overview').classList.remove('det');
  };

  $('nav a[data-p=overview]').addEventListener('click', () => {
    state.currentMonitorId = null;
    $('#overview').classList.remove('det');
  });

  $('#ftb').onclick = e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openMonitorDetail(tr.dataset.id);
  };

  // Range Selector Click in Detail View
  $('#rng').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') return;
    [...$('#rng').children].forEach(b => b.classList.toggle('on', b === e.target));
    state.selectedRange = e.target.dataset.range || '24h';
    if (state.currentMonitorId) renderMonitorDetail(state.currentMonitorId);
  });

  // Render Monitor Detail
  function renderMonitorDetail(monitorId) {
    const m = state.monitors.find(mon => mon.id === monitorId);
    if (!m) return;

    $('#dname').textContent = m.name;
    $('#d-chartsub').textContent = `All probes · ${formatHost(m.url)}`;

    const stKey = m.is_paused ? 'PAUSED' : (m.current_status || 'UNKNOWN');
    const s = statusStyles[stKey] || statusStyles.UNKNOWN;

    // Status card
    const dStatus = $('#d-status');
    dStatus.className = 'v ' + s.cls;
    dStatus.innerHTML = `<span class="dot ${s.bg}"></span>${s.text}`;

    // Calculate duration in current state
    const sinceText = calculateStateDurationText(m);
    $('#d-since').textContent = sinceText;

    // Last check card
    $('#d-lastcheck').textContent = formatTimeAgo(m.last_checked_at);
    $('#d-interval').textContent = `Every ${m.interval_minutes}m`;

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
    if (!monitor.last_checked_at) return 'Not checked yet';
    const st = monitor.is_paused ? 'Paused' : monitor.current_status;
    const diffSec = Math.floor((Date.now() - new Date(monitor.last_checked_at).getTime()) / 1000);
    return `${st} for ${formatDuration(diffSec)}`;
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
        <text x="400" y="125" fill="#a1a1a1" text-anchor="middle" font-size="12">Click "⚡ Ping now" or "Generate 24h data" above to populate dynamic charts</text>
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

  // Trigger an immediate keep-alive probe from the browser
  async function triggerManualPing(monitorId, btnElement = null) {
    const m = state.monitors.find(mon => mon.id === monitorId);
    if (!m) return;

    const originalBtnText = btnElement ? btnElement.innerHTML : null;
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.innerHTML = '⚡ Pinging…';
    }

    const tStart = performance.now();
    let status = 'UP';
    let statusCode = 200;
    let errorMessage = null;

    try {
      try {
        const resp = await fetch(m.url, { method: 'GET', cache: 'no-store' });
        statusCode = resp.status;
        if (!resp.ok) {
          status = 'DOWN';
          errorMessage = `HTTP ${resp.status} ${resp.statusText || ''}`.trim();
        }
      } catch (corsOrNetErr) {
        // Fallback to no-cors mode to measure network roundtrip and wake target keep-alive
        await fetch(m.url, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
        statusCode = 200;
      }
    } catch (err) {
      status = 'DOWN';
      statusCode = 0;
      errorMessage = err.message || 'Service unreachable';
    }

    const durationMs = Math.max(1, Math.round(performance.now() - tStart));
    const threshold = m.degraded_threshold_ms || state.settings.degraded_threshold_ms || 1000;
    if (status === 'UP' && durationMs > threshold) {
      status = 'DEGRADED';
    }

    const checkedAt = new Date().toISOString();
    const checkRecord = {
      id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('chk-' + Date.now()),
      monitor_id: monitorId,
      user_id: state.user?.id,
      checked_at: checkedAt,
      status,
      status_code: statusCode,
      response_time_ms: durationMs,
      error_message: errorMessage,
      is_retry: false
    };

    // Prepend check to local state immediately for instant dynamic UI update
    state.checks.unshift(checkRecord);
    m.current_status = status;
    m.last_checked_at = checkedAt;

    // Persist to Supabase if connected
    if (state.client && state.user) {
      state.client.from('checks').insert({
        monitor_id: monitorId,
        user_id: state.user.id,
        checked_at: checkedAt,
        status,
        status_code: statusCode,
        response_time_ms: durationMs,
        error_message: errorMessage,
        is_retry: false
      }).then(({ error }) => {
        if (error) console.warn('Supabase check insert:', error.message);
      });

      await state.client.from('monitors').update({
        current_status: status,
        last_checked_at: checkedAt,
        next_check_at: new Date(Date.now() + m.interval_minutes * 60000).toISOString()
      }).eq('id', monitorId);
    }

    renderOverview();
    renderMonitors();
    if (state.currentMonitorId === monitorId) {
      renderMonitorDetail(monitorId);
    }

    if (btnElement) {
      btnElement.disabled = false;
      btnElement.innerHTML = originalBtnText;
    }

    if (status === 'UP') {
      showToast(`⚡ Probe succeeded: ${statusCode} OK in ${durationMs} ms`);
    } else if (status === 'DEGRADED') {
      showToast(`⚠️ Probe degraded: ${durationMs} ms (exceeds ${threshold} ms threshold)`);
    } else {
      showToast(`❌ Probe failed: ${errorMessage || 'Service unreachable'}`);
    }
  }

  // Generate 24 hours of simulated realistic checks for a monitor
  async function seedSampleHistory(monitorId, btnElement = null) {
    const m = state.monitors.find(mon => mon.id === monitorId);
    if (!m) return;

    const originalBtnText = btnElement ? btnElement.innerHTML : null;
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.innerHTML = '⏳ Generating…';
    }

    const now = Date.now();
    const rows = [];
    for (let i = 23; i >= 0; i--) {
      const t = new Date(now - i * 3600000);
      const baseLat = 150 + Math.floor(Math.sin(i / 3) * 35);
      const jitter = Math.floor(Math.random() * 55);
      const lat = Math.max(70, baseLat + jitter);

      rows.push({
        monitor_id: monitorId,
        user_id: state.user?.id,
        checked_at: t.toISOString(),
        status: 'UP',
        status_code: 200,
        response_time_ms: lat,
        error_message: null,
        is_retry: false
      });
    }

    state.checks = [...rows.slice().reverse(), ...state.checks.filter(c => c.monitor_id !== monitorId)];
    m.current_status = 'UP';
    m.last_checked_at = new Date().toISOString();

    if (state.client && state.user) {
      try {
        const { error } = await state.client.from('checks').insert(rows);
        if (error) console.warn('Supabase sample insert:', error.message);

        await state.client.from('monitors').update({
          current_status: 'UP',
          last_checked_at: m.last_checked_at,
          next_check_at: new Date(Date.now() + m.interval_minutes * 60000).toISOString()
        }).eq('id', monitorId);
      } catch (err) {
        console.warn('Sample checks persistence note:', err);
      }
    }

    renderOverview();
    renderMonitors();
    if (state.currentMonitorId === monitorId) {
      renderMonitorDetail(monitorId);
    }

    if (btnElement) {
      btnElement.disabled = false;
      btnElement.innerHTML = originalBtnText;
    }

    showToast('24 hours of dynamic check history generated!');
  }

  // Wire Detail Action Buttons
  const pingNowBtn = $('#btn-ping-now');
  if (pingNowBtn) {
    pingNowBtn.onclick = () => {
      if (state.currentMonitorId) triggerManualPing(state.currentMonitorId, pingNowBtn);
    };
  }

  const seedBtn = $('#btn-seed-sample');
  if (seedBtn) {
    seedBtn.onclick = () => {
      if (state.currentMonitorId) seedSampleHistory(state.currentMonitorId, seedBtn);
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
      const stKey = m.is_paused ? 'PAUSED' : (m.current_status || 'UNKNOWN');
      if (filter !== 'all' && stKey !== filter) return false;
      return true;
    });

    // Sorting
    list.sort((a, b) => {
      const stA = a.is_paused ? 'PAUSED' : (a.current_status || 'UNKNOWN');
      const stB = b.is_paused ? 'PAUSED' : (b.current_status || 'UNKNOWN');
      if (sort === 'down_first') {
        if (stA === 'DOWN' && stB !== 'DOWN') return -1;
        if (stB === 'DOWN' && stA !== 'DOWN') return 1;
        return a.name.localeCompare(b.name);
      }
      if (sort === 'name_asc') return a.name.localeCompare(b.name);
      if (sort === 'uptime_desc' || sort === 'uptime_asc') {
        const uA = calculateMonitorUptime(a.id, 86400000).uptimePct;
        const uB = calculateMonitorUptime(b.id, 86400000).uptimePct;
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
      const stKey = m.is_paused ? 'PAUSED' : (m.current_status || 'UNKNOWN');
      const s = statusStyles[stKey] || statusStyles.UNKNOWN;
      const stats = calculateMonitorUptime(m.id, 86400000);
      const strip = generate24HourStrip(m.id);
      const host = formatHost(m.url);

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
              <button class="btn sm p" data-ping="${m.id}" title="Send an immediate keep-alive probe">⚡ Ping</button>
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
    const pingBtn = e.target.closest('[data-ping]');
    if (pingBtn) {
      const id = pingBtn.dataset.ping;
      await triggerManualPing(id, pingBtn);
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
      $('#edit-interval').value = String(m.interval_minutes);
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

  // Create Monitor Modal Handlers
  $$('[data-open]').forEach(b => b.onclick = () => {
    $('#m-name').value = '';
    $('#m-url').value = '';
    $('#m-interval').value = String(state.settings.default_interval_minutes || 15);
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
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    const { error } = await state.client.from('monitors').insert({
      user_id: state.user.id,
      name,
      url,
      interval_minutes: interval,
      timeout_seconds: state.settings.default_timeout_seconds || 90,
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
