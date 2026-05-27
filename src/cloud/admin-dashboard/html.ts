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

        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }

        .spinner {
            width: 24px;
            height: 24px;
            border: 3px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 8px;
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

        .qr-countdown {
            color: var(--warning);
            font-size: 0.8rem;
            font-weight: 500;
            margin-top: 8px;
        }

        .connected-check {
            color: var(--success);
            font-size: 3rem;
            text-align: center;
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
        .table-wrapper { overflow-x: auto; }

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

        /* Upload Zone */
        .upload-zone {
            border: 2px dashed var(--border);
            border-radius: var(--radius);
            padding: 32px;
            text-align: center;
            cursor: pointer;
            transition: all 0.2s;
            position: relative;
        }

        .upload-zone:hover, .upload-zone.dragover {
            border-color: var(--accent);
            background: rgba(59, 130, 246, 0.05);
        }

        .upload-zone .upload-icon { font-size: 2rem; margin-bottom: 8px; }
        .upload-zone .upload-text { color: var(--text-secondary); font-size: 0.85rem; }
        .upload-zone .upload-hint { color: var(--text-muted); font-size: 0.75rem; margin-top: 4px; }

        .upload-zone input[type="file"] {
            position: absolute;
            inset: 0;
            opacity: 0;
            cursor: pointer;
        }

        .upload-list {
            margin-top: 16px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .upload-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 12px;
            background: var(--bg-primary);
            border-radius: 6px;
            font-size: 0.8rem;
        }

        .upload-item-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .upload-item-status {
            font-size: 0.75rem;
            font-weight: 500;
        }

        .upload-item-status.processing { color: var(--warning); }
        .upload-item-status.completed { color: var(--success); }
        .upload-item-status.failed { color: var(--danger); }
        .upload-item-status.uploading { color: var(--accent); }

        .progress-bar {
            width: 100%;
            height: 4px;
            background: var(--border);
            border-radius: 2px;
            overflow: hidden;
            margin-top: 6px;
        }

        .progress-bar-fill {
            height: 100%;
            background: var(--accent);
            border-radius: 2px;
            transition: width 0.3s;
        }

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

        /* Tab Navigation */
        .tab-nav {
            display: flex;
            gap: 0;
            margin-bottom: 24px;
            border-bottom: 1px solid var(--border);
        }

        .tab-btn {
            padding: 10px 20px;
            background: none;
            border: none;
            border-bottom: 2px solid transparent;
            color: var(--text-secondary);
            font-size: 0.85rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }

        .tab-btn:hover {
            color: var(--text-primary);
            background: var(--bg-card);
        }

        .tab-btn.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
        }

        .tab-panel {
            display: none;
        }

        .tab-panel.active {
            display: block;
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

        <nav class="tab-nav" id="tab-nav">
            <button class="tab-btn active" data-tab="overview" onclick="switchTab('overview')">Overview</button>
            <button class="tab-btn" data-tab="settings" onclick="switchTab('settings')">Settings</button>
        </nav>

        <div class="tab-panel active" id="tab-overview">
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
                        <div class="qr-countdown" id="wa-countdown"></div>
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
                        <div class="action-icon">&#x1f504;</div>
                        <div class="action-label">Reconnect WhatsApp</div>
                        <div class="action-desc">Generate new QR code</div>
                    </button>
                    <button class="action-btn" onclick="doAction('disconnect')">
                        <div class="action-icon">&#x26d4;</div>
                        <div class="action-label">Force Disconnect</div>
                        <div class="action-desc">Kill WhatsApp session</div>
                    </button>
                    <button class="action-btn" onclick="doAction('clear-limits')">
                        <div class="action-icon">&#x1f9f9;</div>
                        <div class="action-label">Clear Rate Limits</div>
                        <div class="action-desc">Reset all user counters</div>
                    </button>
                    <button class="action-btn" onclick="doAction('refresh')">
                        <div class="action-icon">&#x1f4ca;</div>
                        <div class="action-label">Force Refresh</div>
                        <div class="action-desc">Reload all data now</div>
                    </button>
                </div>
            </div>

            <!-- Document Upload -->
            <div class="card card-full">
                <div class="card-header">
                    <span class="card-title">Document Upload</span>
                    <span id="upload-count" style="color: var(--text-muted); font-size: 0.8rem;"></span>
                </div>
                <div class="upload-zone" id="upload-zone">
                    <input type="file" id="file-input" multiple
                        accept=".pdf,.docx,.csv,.txt,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/csv,text/plain,image/png,image/jpeg">
                    <div class="upload-icon">&#x1f4c1;</div>
                    <div class="upload-text">Drag &amp; drop files here, or click to select</div>
                    <div class="upload-hint">PDF, DOCX, CSV, TXT, PNG, JPG — Max 50MB per file</div>
                </div>
                <div class="upload-list" id="upload-list"></div>
            </div>
        </div>
        </div><!-- /tab-overview -->

        <div class="tab-panel" id="tab-settings">
            <!-- Settings panel content injected server-side -->
        </div>
    </div>

    <div class="toast" id="toast"></div>

    <script>
        // ── State ──
        let eventSource = null;
        let qrState = null;
        let qrCountdownInterval = null;

        // Expose eventSource on window for cross-panel SSE listeners (e.g. settings panel)
        Object.defineProperty(window, 'eventSource', {
            get() { return eventSource; },
            set(v) { eventSource = v; },
            configurable: true,
        });

        // ── Tab Navigation ──
        function switchTab(tabId) {
            // Update tab buttons
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === tabId);
            });
            // Update tab panels
            document.querySelectorAll('.tab-panel').forEach(panel => {
                panel.classList.toggle('active', panel.id === 'tab-' + tabId);
            });
        }

        // ── SSE Connection ──
        function connectSSE() {
            eventSource = new EventSource('/admin/sse');

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
            el.textContent = data.overallStatus || 'unknown';
            el.className = 'badge badge-' + (data.overallStatus || 'unknown');

            const list = document.getElementById('services-list');
            if (!data.services || data.services.length === 0) {
                list.innerHTML = '<div class="empty-state">No services reporting</div>';
                return;
            }
            list.innerHTML = data.services.map(s => \`
                <div class="service-item">
                    <span class="service-name">\${esc(s.name)}</span>
                    <div class="service-status">
                        \${s.latencyMs != null ? '<span>' + s.latencyMs + 'ms</span>' : ''}
                        <span class="badge badge-\${s.status}">\${s.status}</span>
                    </div>
                </div>
            \`).join('');
        }

        function updateWhatsApp(data) {
            const qrBox = document.getElementById('qr-box');
            const statusEl = document.getElementById('wa-status');
            const phoneEl = document.getElementById('wa-phone');
            const uptimeEl = document.getElementById('wa-uptime');
            const countdownEl = document.getElementById('wa-countdown');

            if (data.connected || data.state === 'connected') {
                qrBox.innerHTML = '<div class="connected-check">&#x2705;</div>';
                statusEl.textContent = 'Connected';
                statusEl.style.color = 'var(--success)';
                phoneEl.textContent = data.phoneNumber ? 'Phone: ' + data.phoneNumber : '';
                uptimeEl.textContent = data.uptime ? 'Uptime: ' + formatUptime(data.uptime) : '';
                countdownEl.textContent = '';
            } else if (data.qr && data.qr.available && data.qr.qrDataUrl) {
                qrBox.innerHTML = '<img src="' + data.qr.qrDataUrl + '" alt="WhatsApp QR Code">';
                statusEl.textContent = 'Scan QR Code';
                statusEl.style.color = 'var(--warning)';
                phoneEl.textContent = '';
                uptimeEl.textContent = '';
                // QR countdown (refreshes every ~20s)
                if (data.qr.qrGeneratedAt) {
                    startQrCountdown(data.qr.qrGeneratedAt);
                }
            } else {
                qrBox.innerHTML = '<span style="color: var(--text-muted); font-size: 0.8rem;">Disconnected</span>';
                statusEl.textContent = data.state || 'Disconnected';
                statusEl.style.color = 'var(--danger)';
                phoneEl.textContent = '';
                uptimeEl.textContent = '';
                countdownEl.textContent = '';
            }
        }

        function startQrCountdown(generatedAt) {
            if (qrCountdownInterval) clearInterval(qrCountdownInterval);
            const countdownEl = document.getElementById('wa-countdown');
            qrCountdownInterval = setInterval(() => {
                const elapsed = Math.floor((Date.now() - generatedAt) / 1000);
                const remaining = Math.max(0, 20 - elapsed);
                if (remaining > 0) {
                    countdownEl.textContent = 'QR refreshes in ' + remaining + 's';
                } else {
                    countdownEl.textContent = 'Waiting for new QR...';
                }
            }, 1000);
        }

        function updateContainers(data) {
            const body = document.getElementById('containers-body');
            const count = document.getElementById('container-count');
            count.textContent = (data.total || 0) + ' running';

            if (!data.containers || data.containers.length === 0) {
                body.innerHTML = '<tr><td colspan="7" class="empty-state">No containers running</td></tr>';
                return;
            }
            body.innerHTML = data.containers.map(c => \`
                <tr>
                    <td>\${esc(c.userHash || c.userId || '—')}</td>
                    <td><code>\${esc((c.containerId || '').slice(0, 12))}</code></td>
                    <td><span class="badge badge-\${c.status === 'running' ? 'healthy' : 'unhealthy'}">\${c.status}</span></td>
                    <td>\${formatUptime(c.uptime)}</td>
                    <td>\${c.memoryUsageMb ? c.memoryUsageMb.toFixed(1) + ' MB' : '—'}</td>
                    <td>\${c.cpuPercent != null ? c.cpuPercent.toFixed(1) + '%' : '—'}</td>
                    <td>\${c.lastActivity ? timeAgo(c.lastActivity) : '—'}</td>
                </tr>
            \`).join('');
        }

        function updateStats(data) {
            document.getElementById('stat-rpm').textContent = data.globalMessagesPerMinute || 0;
            document.getElementById('stat-rph').textContent = data.globalMessagesPerHour || 0;
            document.getElementById('stat-users').textContent = data.activeUsers || 0;
            document.getElementById('stat-hits').textContent = data.rateLimitHits24h || 0;
        }

        // ── WhatsApp Actions ──
        async function reconnectWhatsApp() {
            try {
                const res = await fetch('/admin/api/whatsapp/reconnect', { method: 'POST' });
                const data = await res.json();
                showToast(data.message || 'Reconnecting...', data.success ? 'success' : 'error');
            } catch (e) {
                showToast('Failed to reconnect', 'error');
            }
        }

        async function disconnectWhatsApp() {
            try {
                const res = await fetch('/admin/api/whatsapp/disconnect', { method: 'POST' });
                const data = await res.json();
                showToast(data.message || 'Disconnected', data.success ? 'success' : 'error');
            } catch (e) {
                showToast('Failed to disconnect', 'error');
            }
        }

        // ── Quick Actions ──
        async function doAction(action) {
            if (action === 'reconnect') return reconnectWhatsApp();
            if (action === 'disconnect') return disconnectWhatsApp();
            if (action === 'refresh') {
                showToast('Refreshing...', 'success');
                return;
            }
            if (action === 'clear-limits') {
                try {
                    const res = await fetch('/admin/api/actions/clear-rate-limits', { method: 'POST' });
                    const data = await res.json();
                    showToast(data.message || 'Done', 'success');
                } catch (e) {
                    showToast('Failed', 'error');
                }
            }
        }

        // ── File Upload ──
        const uploadZone = document.getElementById('upload-zone');
        const fileInput = document.getElementById('file-input');
        const uploadList = document.getElementById('upload-list');

        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.classList.add('dragover');
        });

        uploadZone.addEventListener('dragleave', () => {
            uploadZone.classList.remove('dragover');
        });

        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                handleFiles(e.dataTransfer.files);
            }
        });

        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                handleFiles(fileInput.files);
            }
        });

        function handleFiles(files) {
            for (const file of files) {
                uploadFile(file);
            }
            fileInput.value = '';
        }

        async function uploadFile(file) {
            const id = Math.random().toString(36).slice(2, 10);
            const item = document.createElement('div');
            item.className = 'upload-item';
            item.id = 'upload-' + id;
            item.innerHTML = \`
                <span class="upload-item-name">\${esc(file.name)}</span>
                <span class="upload-item-status uploading">Uploading...</span>
                <div class="progress-bar"><div class="progress-bar-fill" style="width: 0%"></div></div>
            \`;
            uploadList.prepend(item);

            try {
                const formData = new FormData();
                formData.append('file', file);

                const xhr = new XMLHttpRequest();
                xhr.open('POST', '/admin/api/upload');

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        const fill = item.querySelector('.progress-bar-fill');
                        if (fill) fill.style.width = pct + '%';
                    }
                };

                xhr.onload = () => {
                    const statusEl = item.querySelector('.upload-item-status');
                    const progressBar = item.querySelector('.progress-bar');
                    if (xhr.status === 200) {
                        statusEl.textContent = 'Processing';
                        statusEl.className = 'upload-item-status processing';
                        if (progressBar) progressBar.remove();
                        // Poll for completion
                        pollUploadStatus(id, item);
                    } else {
                        statusEl.textContent = 'Failed';
                        statusEl.className = 'upload-item-status failed';
                        if (progressBar) progressBar.remove();
                    }
                };

                xhr.onerror = () => {
                    const statusEl = item.querySelector('.upload-item-status');
                    statusEl.textContent = 'Failed';
                    statusEl.className = 'upload-item-status failed';
                    const progressBar = item.querySelector('.progress-bar');
                    if (progressBar) progressBar.remove();
                };

                xhr.send(formData);
            } catch (e) {
                const statusEl = item.querySelector('.upload-item-status');
                statusEl.textContent = 'Failed';
                statusEl.className = 'upload-item-status failed';
            }

            updateUploadCount();
        }

        function pollUploadStatus(id, item) {
            let attempts = 0;
            const interval = setInterval(async () => {
                attempts++;
                if (attempts > 30) {
                    clearInterval(interval);
                    return;
                }
                try {
                    const res = await fetch('/admin/api/uploads');
                    const data = await res.json();
                    const upload = data.uploads && data.uploads.find(u => u.status === 'completed' || u.status === 'failed');
                    if (upload) {
                        const statusEl = item.querySelector('.upload-item-status');
                        if (upload.status === 'completed') {
                            statusEl.textContent = 'Indexed';
                            statusEl.className = 'upload-item-status completed';
                        } else if (upload.status === 'failed') {
                            statusEl.textContent = 'Failed';
                            statusEl.className = 'upload-item-status failed';
                        }
                        clearInterval(interval);
                    }
                } catch { /* ignore */ }
            }, 2000);
        }

        function updateUploadCount() {
            const items = uploadList.querySelectorAll('.upload-item');
            document.getElementById('upload-count').textContent = items.length > 0 ? items.length + ' file(s)' : '';
        }

        // ── Utilities ──
        function formatUptime(seconds) {
            if (!seconds || seconds < 0) return '—';
            if (seconds < 60) return seconds + 's';
            if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
            if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
            return Math.floor(seconds / 86400) + 'd ' + Math.floor((seconds % 86400) / 3600) + 'h';
        }

        function timeAgo(isoStr) {
            const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
            if (diff < 60) return diff + 's ago';
            if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
            if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
            return Math.floor(diff / 86400) + 'd ago';
        }

        function esc(str) {
            if (!str) return '';
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function showToast(message, type) {
            const toast = document.getElementById('toast');
            toast.textContent = message;
            toast.className = 'toast show ' + (type || '');
            setTimeout(() => { toast.className = 'toast'; }, 3000);
        }

        // ── Init ──
        connectSSE();

        // Load recent uploads on page load
        fetch('/admin/api/uploads').then(r => r.json()).then(data => {
            if (data.uploads && data.uploads.length > 0) {
                for (const u of data.uploads.slice(0, 10)) {
                    const item = document.createElement('div');
                    item.className = 'upload-item';
                    item.innerHTML = \`
                        <span class="upload-item-name">\${esc(u.filename)}</span>
                        <span class="upload-item-status \${u.status}">\${u.status === 'completed' ? 'Indexed' : u.status}</span>
                    \`;
                    uploadList.appendChild(item);
                }
                updateUploadCount();
            }
        }).catch(() => {});
    </script>
</body>
</html>`;
}
