/**
 * Admin Dashboard HTML — single-page app served as a template literal.
 * No build step required. Uses embedded CSS and vanilla JS with SSE for real-time updates.
 *
 * Requirements: REQ-6.1 (monitoring and observability)
 */

export function getDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NanoClaw Admin</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg-primary: #0f172a;
            --bg-card: #1e293b;
            --bg-card-hover: #334155;
            --border: #334155;
            --text-primary: #f1f5f9;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            --accent: #3b82f6;
            --accent-hover: #2563eb;
            --success: #22c55e;
            --warning: #eab308;
            --danger: #ef4444;
            --radius: 8px;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.6;
            min-height: 100vh;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 24px;
        }

        header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 32px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border);
        }

        header h1 {
            font-size: 1.5rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        header h1 .logo {
            width: 28px;
            height: 28px;
            background: var(--accent);
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
        }

        .connection-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 500;
            background: var(--bg-card);
            border: 1px solid var(--border);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            animation: pulse 2s infinite;
        }

        .status-dot.connected { background: var(--success); }
        .status-dot.disconnected { background: var(--danger); }
        .status-dot.connecting { background: var(--warning); }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
            gap: 20px;
        }

        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 20px;
        }

        .card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
        }

        .card-title {
            font-size: 0.9rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--text-secondary);
        }

        .card-full { grid-column: 1 / -1; }

        /* WhatsApp Section */
        .qr-container {
            display: flex;
            align-items: center;
            gap: 24px;
            flex-wrap: wrap;
        }

        .qr-image {
            width: 200px;
            height: 200px;
            background: white;
            border-radius: var(--radius);
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }

        .qr-image img {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }

        .qr-info {
            flex: 1;
            min-width: 200px;
        }

        .qr-status {
            font-size: 1.1rem;
            font-weight: 600;
            margin-bottom: 8px;
        }

        .qr-detail {
            color: var(--text-secondary);
            font-size: 0.85rem;
            margin-bottom: 4px;
        }

        /* Health Services */
        .service-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .service-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 12px;
            background: var(--bg-primary);
            border-radius: 6px;
        }

        .service-name {
            font-size: 0.85rem;
            font-weight: 500;
        }

        .service-status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.8rem;
        }

        .badge {
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }

        .badge-healthy { background: rgba(34, 197, 94, 0.15); color: var(--success); }
        .badge-unhealthy { background: rgba(239, 68, 68, 0.15); color: var(--danger); }
        .badge-degraded { background: rgba(234, 179, 8, 0.15); color: var(--warning); }
        .badge-unknown { background: rgba(100, 116, 139, 0.15); color: var(--text-muted); }

        /* Containers Table */
        .table-wrapper {
            overflow-x: auto;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.85rem;
        }

        th {
            text-align: left;
            padding: 8px 12px;
            color: var(--text-muted);
            font-weight: 500;
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border-bottom: 1px solid var(--border);
        }

        td {
            padding: 10px 12px;
            border-bottom: 1px solid var(--border);
        }

        tr:last-child td { border-bottom: none; }

        /* Stats */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 12px;
        }

        .stat-item {
            text-align: center;
            padding: 12px;
            background: var(--bg-primary);
            border-radius: 6px;
        }

        .stat-value {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--accent);
        }

        .stat-label {
            font-size: 0.75rem;
            color: var(--text-muted);
            margin-top: 4px;
        }

        /* Buttons */
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            font-size: 0.8rem;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
        }

        .btn-primary { background: var(--accent); color: white; }
        .btn-primary:hover { background: var(--accent-hover); }
        .btn-danger { background: var(--danger); color: white; }
        .btn-danger:hover { background: #dc2626; }
        .btn-outline {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-secondary);
        }
        .btn-outline:hover { background: var(--bg-card-hover); }

        .btn-group {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }

        /* Actions */
        .actions-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 10px;
        }

        .action-btn {
            padding: 12px 16px;
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text-primary);
            font-size: 0.8rem;
            cursor: pointer;
            transition: all 0.2s;
            text-align: left;
        }

        .action-btn:hover {
            background: var(--bg-card-hover);
            border-color: var(--accent);
        }

        .action-btn .action-icon { font-size: 1.2rem; margin-bottom: 4px; }
        .action-btn .action-label { font-weight: 500; }
        .action-btn .action-desc { color: var(--text-muted); font-size: 0.7rem; margin-top: 2px; }

        /* Toast */
        .toast {
            position: fixed;
            bottom: 24px;
            right: 24px;
            padding: 12px 20px;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            font-size: 0.85rem;
            opacity: 0;
            transform: translateY(10px);
            transition: all 0.3s;
            z-index: 1000;
        }

        .toast.show { opacity: 1; transform: translateY(0); }
        .toast.success { border-color: var(--success); }
        .toast.error { border-color: var(--danger); }

        .empty-state {
            text-align: center;
            padding: 24px;
            color: var(--text-muted);
            font-size: 0.85rem;
        }

        @media (max-width: 768px) {
            .grid { grid-template-columns: 1fr; }
            .container { padding: 16px; }
            .qr-container { flex-direction: column; align-items: flex-start; }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>
                <span class="logo">N</span>
                NanoClaw Admin
            </h1>
            <div class="connection-badge" id="sse-badge">
                <span class="status-dot connecting" id="sse-dot"></span>
                <span id="sse-label">Connecting...</span>
            </div>
        </header>

        <div class="grid">
            <!-- WhatsApp QR Code / Status -->
            <div class="card">
                <div class="card-header">
                    <span class="card-title">WhatsApp Connection</span>
                    <div class="btn-group">
                        <button class="btn btn-outline" onclick="reconnectWhatsApp()">Reconnect</button>
                        <button class="btn btn-danger" onclick="disconnectWhatsApp()">Disconnect</button>
                    </div>
                </div>
                <div class="qr-container" id="whatsapp-section">
                    <div class="qr-image" id="qr-box">
                        <span style="color: var(--text-muted); font-size: 0.8rem;">Loading...</span>
                    </div>
                    <div class="qr-info">
                        <div class="qr-status" id="wa-status">—</div>
                        <div class="qr-detail" id="wa-phone"></div>
                        <div class="qr-detail" id="wa-uptime"></div>
                        <div class="qr-detail" id="wa-activity"></div>
                    </div>
                </div>
            </div>

            <!-- System Health -->
            <div class="card">
                <div class="card-header">
                    <span class="card-title">System Health</span>
                    <span class="badge badge-unknown" id="overall-status">—</span>
                </div>
                <div class="service-list" id="services-list">
                    <div class="empty-state">Loading services...</div>
                </div>
            </div>

            <!-- Active Containers -->
            <div class="card card-full">
                <div class="card-header">
                    <span class="card-title">Active Containers</span>
                    <span id="container-count" style="color: var(--text-muted); font-size: 0.8rem;">0 running</span>
                </div>
                <div class="table-wrapper">
                    <table>
                        <thead>
                            <tr>
                                <th>User</th>
                                <th>Container ID</th>
                                <th>Status</th>
                                <th>Uptime</th>
                                <th>Memory</th>
                                <th>CPU</th>
                                <th>Last Activity</th>
                            </tr>
                        </thead>
                        <tbody id="containers-body">
                            <tr><td colspan="7" class="empty-state">No containers running</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Rate Limiting Stats -->
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Rate Limiting</span>
                </div>
                <div class="stats-grid" id="stats-grid">
                    <div class="stat-item">
                        <div class="stat-value" id="stat-rpm">—</div>
                        <div class="stat-label">msgs/min</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value" id="stat-rph">—</div>
                        <div class="stat-label">msgs/hour</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value" id="stat-users">—</div>
                        <div class="stat-label">active users</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value" id="stat-hits">—</div>
                        <div class="stat-label">limit hits/24h</div>
                    </div>
                </div>
            </div>

            <!-- Quick Actions -->
            <div class="card">
                <div class="card-header">
                    <span class="card-title">Quick Actions</span>
                </div>
                <div class="actions-grid">
                    <button class="action-btn" onclick="doAction('reconnect')">
                        <div class="action-icon">🔄</div>
                        <div class="action-label">Reconnect WhatsApp</div>
                        <div class="action-desc">Generate new QR code</div>
                    </button>
                    <button class="action-btn" onclick="doAction('disconnect')">
                        <div class="action-icon">⛔</div>
                        <div class="action-label">Force Disconnect</div>
                        <div class="action-desc">Kill WhatsApp session</div>
                    </button>
                    <button class="action-btn" onclick="doAction('clear-limits')">
                        <div class="action-icon">🧹</div>
                        <div class="action-label">Clear Rate Limits</div>
                        <div class="action-desc">Reset all user counters</div>
                    </button>
                    <button class="action-btn" onclick="doAction('refresh')">
                        <div class="action-icon">📊</div>
                        <div class="action-label">Force Refresh</div>
                        <div class="action-desc">Reload all data now</div>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <div class="toast" id="toast"></div>

    <script>
        // ── State ──
        let eventSource = null;
        const token = new URLSearchParams(window.location.search).get('token') || '';

        // ── SSE Connection ──
        function connectSSE() {
            const url = '/admin/sse' + (token ? '?token=' + encodeURIComponent(token) : '');

            eventSource = new EventSource(url);

            eventSource.addEventListener('connected', () => {
                setSseBadge('connected', 'Live');
            });

            eventSource.addEventListener('health', (e) => {
                updateHealth(JSON.parse(e.data));
            });

            eventSource.addEventListener('whatsapp', (e) => {
                updateWhatsApp(JSON.parse(e.data));
            });

            eventSource.addEventListener('containers', (e) => {
                updateContainers(JSON.parse(e.data));
            });

            eventSource.addEventListener('stats', (e) => {
                updateStats(JSON.parse(e.data));
            });

            eventSource.onerror = () => {
                setSseBadge('disconnected', 'Disconnected');
                eventSource.close();
                setTimeout(connectSSE, 3000);
            };
        }

        function setSseBadge(status, label) {
            document.getElementById('sse-dot').className = 'status-dot ' + status;
            document.getElementById('sse-label').textContent = label;
        }

        // ── Update Functions ──
        function updateHealth(data) {
            const el = document.getElementById('overall-status');
            el.textContent = data.overallStatus;
            el.className = 'badge badge-' + data.overallStatus;

            const list = document.getElementById('services-list');
            if (data.services && data.services.length > 0) {
                list.innerHTML = data.services.map(s => \`
                    <div class="service-item">
                        <span class="service-name">\${s.name}</span>
                        <div class="service-status">
                            \${s.latencyMs ? '<span style="color:var(--text-muted)">' + s.latencyMs + 'ms</span>' : ''}
                            <span class="badge badge-\${s.status}">\${s.status}</span>
                        </div>
                    </div>
                \`).join('');
            }
        }

        function updateWhatsApp(data) {
            const statusEl = document.getElementById('wa-status');
            const phoneEl = document.getElementById('wa-phone');
            const uptimeEl = document.getElementById('wa-uptime');
            const activityEl = document.getElementById('wa-activity');
            const qrBox = document.getElementById('qr-box');

            const stateLabels = {
                connected: '✅ Connected',
                disconnected: '❌ Disconnected',
                connecting: '🔄 Connecting...',
                qr_pending: '📱 Scan QR Code'
            };

            statusEl.textContent = stateLabels[data.state] || data.state;

            if (data.phoneNumber) {
                phoneEl.textContent = 'Phone: ' + data.phoneNumber;
            } else {
                phoneEl.textContent = '';
            }

            if (data.uptime) {
                uptimeEl.textContent = 'Uptime: ' + formatDuration(data.uptime);
            } else {
                uptimeEl.textContent = '';
            }

            if (data.lastActivity) {
                activityEl.textContent = 'Last activity: ' + new Date(data.lastActivity).toLocaleTimeString();
            } else {
                activityEl.textContent = '';
            }

            // QR Code display
            if (data.qr && data.qr.available && data.qr.qrDataUrl) {
                qrBox.innerHTML = '<img src="' + data.qr.qrDataUrl + '" alt="WhatsApp QR Code">';
            } else if (data.state === 'connected') {
                qrBox.innerHTML = '<span style="color:var(--success);font-size:2rem;">✓</span>';
            } else if (data.state === 'qr_pending') {
                qrBox.innerHTML = '<span style="color:var(--text-muted);font-size:0.8rem;">Waiting for QR...</span>';
            } else {
                qrBox.innerHTML = '<span style="color:var(--text-muted);font-size:0.8rem;">No session</span>';
            }
        }

        function updateContainers(data) {
            document.getElementById('container-count').textContent = data.total + ' running';

            const tbody = document.getElementById('containers-body');
            if (!data.containers || data.containers.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No containers running</td></tr>';
                return;
            }

            tbody.innerHTML = data.containers.map(c => \`
                <tr>
                    <td>\${c.userId.slice(0, 12)}...</td>
                    <td style="font-family:monospace;font-size:0.75rem;">\${c.containerId.slice(0, 12)}</td>
                    <td><span class="badge badge-\${c.status === 'running' ? 'healthy' : 'unhealthy'}">\${c.status}</span></td>
                    <td>\${formatDuration(c.uptime)}</td>
                    <td>\${c.memoryUsageMb.toFixed(1)} MB</td>
                    <td>\${c.cpuPercent.toFixed(1)}%</td>
                    <td>\${new Date(c.lastActivity).toLocaleTimeString()}</td>
                </tr>
            \`).join('');
        }

        function updateStats(data) {
            document.getElementById('stat-rpm').textContent = data.globalMessagesPerMinute;
            document.getElementById('stat-rph').textContent = data.globalMessagesPerHour;
            document.getElementById('stat-users').textContent = data.activeUsers;
            document.getElementById('stat-hits').textContent = data.rateLimitHits24h;
        }

        // ── Actions ──
        function getHeaders() {
            const h = { 'Content-Type': 'application/json' };
            if (token) h['Authorization'] = 'Bearer ' + token;
            return h;
        }

        async function doAction(action) {
            try {
                let url, method = 'POST';
                switch (action) {
                    case 'reconnect':
                        url = '/admin/api/whatsapp/reconnect';
                        break;
                    case 'disconnect':
                        url = '/admin/api/whatsapp/disconnect';
                        break;
                    case 'clear-limits':
                        url = '/admin/api/actions/clear-rate-limits';
                        break;
                    case 'refresh':
                        loadInitialData();
                        showToast('Data refreshed', 'success');
                        return;
                    default:
                        return;
                }

                const res = await fetch(url, { method, headers: getHeaders() });
                const data = await res.json();

                if (data.success !== false) {
                    showToast(data.message || 'Action completed', 'success');
                } else {
                    showToast(data.message || 'Action failed', 'error');
                }
            } catch (err) {
                showToast('Request failed: ' + err.message, 'error');
            }
        }

        async function disconnectWhatsApp() { await doAction('disconnect'); }
        async function reconnectWhatsApp() { await doAction('reconnect'); }

        // ── Initial Data Load ──
        async function loadInitialData() {
            try {
                const headers = getHeaders();
                const [health, wa, containers, stats] = await Promise.all([
                    fetch('/admin/api/health', { headers }).then(r => r.json()),
                    fetch('/admin/api/whatsapp/status', { headers }).then(r => r.json()),
                    fetch('/admin/api/containers', { headers }).then(r => r.json()),
                    fetch('/admin/api/stats', { headers }).then(r => r.json()),
                ]);

                updateHealth(health);
                updateWhatsApp(wa);
                updateContainers(containers);
                updateStats(stats);
            } catch (err) {
                console.error('Failed to load initial data:', err);
            }
        }

        // ── Utilities ──
        function formatDuration(seconds) {
            if (seconds < 60) return seconds + 's';
            if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            return h + 'h ' + m + 'm';
        }

        function showToast(message, type) {
            const toast = document.getElementById('toast');
            toast.textContent = message;
            toast.className = 'toast show ' + type;
            setTimeout(() => { toast.className = 'toast'; }, 3000);
        }

        // ── Init ──
        loadInitialData();
        connectSSE();
    </script>
</body>
</html>`;
}
