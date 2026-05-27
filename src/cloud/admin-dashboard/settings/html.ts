/**
 * Settings Panel HTML — renders the settings UI as an inline HTML template.
 *
 * Generates a self-contained settings panel with:
 * - Settings grouped by category with collapsible sections
 * - Appropriate input controls per type (toggle, number, select, text)
 * - Default value hints alongside each input
 * - Client-side validation mirroring server-side rules
 * - Save prevention when validation errors exist
 * - Restart-required warnings for container settings
 * - Change history view showing past settings modifications
 *
 * Requirements: 1.1, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.2, 7.1, 7.2, 7.3
 */

import type { CategoryGroup } from './settings-manager.js';

/**
 * Category display labels for the UI.
 */
const CATEGORY_LABELS: Record<string, string> = {
    channels: 'Channels',
    chat: 'Chat',
    container: 'Container',
    ingestion: 'Ingestion',
    knowledge_base: 'Knowledge Base',
    notifications: 'Notifications',
    scheduling: 'Scheduling',
};

/**
 * Generate the settings panel HTML content.
 *
 * @param categories - Settings grouped by category from SettingsManager.getAllSettings()
 * @returns Complete HTML string for the settings panel (to be embedded in the dashboard)
 */
export function getSettingsHtml(categories: CategoryGroup[]): string {
    return `
<div class="settings-panel" id="settings-panel">
    ${getSettingsStyles()}
    <div class="settings-header">
        <h2 class="settings-title">Settings</h2>
        <div class="settings-actions">
            <button class="btn btn-primary" id="settings-save-btn" onclick="saveSettings()">Save</button>
            <button class="btn btn-danger" id="settings-apply-btn" onclick="applyAndRestart()">Apply &amp; Restart</button>
        </div>
    </div>
    <div class="settings-body">
        ${renderCategories(categories)}
    </div>
    ${renderChangeHistory()}
    <div class="settings-toast" id="settings-toast"></div>
</div>
${getSettingsScript(categories)}
`;
}

// ── Render Helpers ──

function renderCategories(categories: CategoryGroup[]): string {
    return categories
        .map(
            (group) => `
        <div class="settings-category" data-category="${esc(group.category)}">
            <div class="category-header" onclick="toggleCategory(this)">
                <span class="category-icon">&#x25BC;</span>
                <span class="category-label">${esc(CATEGORY_LABELS[group.category] ?? group.category)}</span>
                <span class="category-count">${group.settings.length} setting${group.settings.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="category-body">
                ${group.settings.map((s) => renderSetting(s)).join('')}
            </div>
        </div>`,
        )
        .join('');
}

function renderChangeHistory(): string {
    return `
        <div class="settings-category history-section" id="history-section">
            <div class="category-header" onclick="toggleCategory(this)">
                <span class="category-icon">&#x25BC;</span>
                <span class="category-label">Change History</span>
                <span class="category-count">
                    <button class="btn-history-load" id="history-load-btn" onclick="event.stopPropagation(); loadHistory()">Load History</button>
                </span>
            </div>
            <div class="category-body">
                <div class="history-container" id="history-container">
                    <div class="history-empty" id="history-empty">Click "Load History" to view past changes</div>
                    <div class="history-loading hidden" id="history-loading">Loading history...</div>
                    <div class="history-error hidden" id="history-error"></div>
                    <div class="history-entries" id="history-entries"></div>
                </div>
            </div>
        </div>`;
}

function renderSetting(s: CategoryGroup['settings'][number]): string {
    const def = s.definition;
    const restartBadge = def.requires_restart
        ? '<span class="restart-badge" title="Requires restart to take effect">&#x26A0; Restart required</span>'
        : '';
    const sourceLabel =
        s.source === 'database' ? 'DB override' : s.source === 'env' ? 'Env fallback' : 'Default';

    return `
        <div class="setting-row" data-key="${esc(def.key)}" data-type="${esc(def.type)}">
            <div class="setting-info">
                <div class="setting-label-row">
                    <label class="setting-label" for="setting-${esc(def.key)}">${esc(def.label)}</label>
                    ${restartBadge}
                </div>
                <div class="setting-description">${esc(def.description)}</div>
                <div class="setting-meta">
                    <span class="setting-default">Default: <code>${esc(def.default_value)}</code></span>
                    <span class="setting-source badge-source badge-source-${esc(s.source)}">${esc(sourceLabel)}</span>
                </div>
            </div>
            <div class="setting-control">
                ${renderInput(s)}
                <div class="setting-error" id="error-${esc(def.key)}"></div>
            </div>
        </div>`;
}

function renderInput(s: CategoryGroup['settings'][number]): string {
    const def = s.definition;
    const id = `setting-${def.key}`;

    switch (def.type) {
        case 'boolean':
            return `
                <label class="toggle-switch">
                    <input type="checkbox" id="${esc(id)}" data-key="${esc(def.key)}"
                        ${s.value === 'true' ? 'checked' : ''}
                        onchange="onSettingChange('${esc(def.key)}', this.checked ? 'true' : 'false')">
                    <span class="toggle-slider"></span>
                </label>`;

        case 'number':
            return `
                <input type="number" id="${esc(id)}" class="setting-input"
                    data-key="${esc(def.key)}"
                    value="${esc(s.value)}"
                    ${def.min !== null ? `min="${def.min}"` : ''}
                    ${def.max !== null ? `max="${def.max}"` : ''}
                    step="${getNumberStep(def)}"
                    oninput="onSettingChange('${esc(def.key)}', this.value)">`;

        case 'enum':
            return `
                <select id="${esc(id)}" class="setting-input setting-select"
                    data-key="${esc(def.key)}"
                    onchange="onSettingChange('${esc(def.key)}', this.value)">
                    ${(def.options ?? []).map((opt) => `<option value="${esc(opt)}" ${s.value === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
                </select>`;

        case 'cron':
            return `
                <input type="text" id="${esc(id)}" class="setting-input"
                    data-key="${esc(def.key)}"
                    value="${esc(s.value)}"
                    placeholder="M H DOM MON DOW"
                    oninput="onSettingChange('${esc(def.key)}', this.value)">
                <div class="setting-hint">Format: minute hour day-of-month month day-of-week</div>`;

        case 'string':
        default:
            return `
                <input type="text" id="${esc(id)}" class="setting-input"
                    data-key="${esc(def.key)}"
                    value="${esc(s.value)}"
                    ${def.validation_pattern ? `pattern="${esc(def.validation_pattern)}"` : ''}
                    oninput="onSettingChange('${esc(def.key)}', this.value)">`;
    }
}

function getNumberStep(def: CategoryGroup['settings'][number]['definition']): string {
    // Use 0.1 step for decimal ranges (e.g., 0.0–1.0 threshold)
    if (def.min !== null && def.max !== null && def.max <= 1) return '0.01';
    if (def.default_value.includes('.')) return '0.1';
    return '1';
}

// ── Styles ──

function getSettingsStyles(): string {
    return `<style>
    .settings-panel {
        position: relative;
    }
    .settings-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--border);
    }
    .settings-title {
        font-size: 1.25rem;
        font-weight: 600;
    }
    .settings-actions {
        display: flex;
        gap: 8px;
    }
    .settings-body {
        display: flex;
        flex-direction: column;
        gap: 16px;
    }
    .settings-category {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        overflow: hidden;
    }
    .category-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 20px;
        cursor: pointer;
        user-select: none;
        transition: background 0.15s;
    }
    .category-header:hover {
        background: var(--bg-card-hover);
    }
    .category-icon {
        font-size: 0.7rem;
        color: var(--text-muted);
        transition: transform 0.2s;
    }
    .category-header.collapsed .category-icon {
        transform: rotate(-90deg);
    }
    .category-label {
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--text-primary);
    }
    .category-count {
        margin-left: auto;
        font-size: 0.75rem;
        color: var(--text-muted);
    }
    .category-body {
        border-top: 1px solid var(--border);
    }
    .category-body.hidden {
        display: none;
    }
    .setting-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 24px;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border);
    }
    .setting-row:last-child {
        border-bottom: none;
    }
    .setting-row.has-error {
        background: rgba(239, 68, 68, 0.05);
    }
    .setting-info {
        flex: 1;
        min-width: 0;
    }
    .setting-label-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
    }
    .setting-label {
        font-size: 0.85rem;
        font-weight: 500;
        color: var(--text-primary);
    }
    .setting-description {
        font-size: 0.78rem;
        color: var(--text-secondary);
        margin-bottom: 6px;
    }
    .setting-meta {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .setting-default {
        font-size: 0.72rem;
        color: var(--text-muted);
    }
    .setting-default code {
        background: var(--bg-primary);
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 0.7rem;
    }
    .badge-source {
        font-size: 0.65rem;
        padding: 1px 6px;
        border-radius: 3px;
        font-weight: 500;
        text-transform: uppercase;
    }
    .badge-source-database { background: rgba(59, 130, 246, 0.15); color: var(--accent); }
    .badge-source-env { background: rgba(234, 179, 8, 0.15); color: var(--warning); }
    .badge-source-default { background: rgba(100, 116, 139, 0.15); color: var(--text-muted); }
    .restart-badge {
        font-size: 0.7rem;
        color: var(--warning);
        font-weight: 500;
    }
    .setting-control {
        flex-shrink: 0;
        width: 240px;
    }
    .setting-input {
        width: 100%;
        padding: 8px 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text-primary);
        font-size: 0.82rem;
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s;
    }
    .setting-input:focus {
        border-color: var(--accent);
    }
    .setting-input.invalid {
        border-color: var(--danger);
    }
    .setting-select {
        cursor: pointer;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 10px center;
        padding-right: 28px;
    }
    .setting-hint {
        font-size: 0.7rem;
        color: var(--text-muted);
        margin-top: 4px;
    }
    .setting-error {
        font-size: 0.72rem;
        color: var(--danger);
        margin-top: 4px;
        min-height: 0;
    }
    .setting-error:empty {
        display: none;
    }

    /* Toggle Switch */
    .toggle-switch {
        position: relative;
        display: inline-block;
        width: 44px;
        height: 24px;
    }
    .toggle-switch input {
        opacity: 0;
        width: 0;
        height: 0;
    }
    .toggle-slider {
        position: absolute;
        cursor: pointer;
        inset: 0;
        background: var(--border);
        border-radius: 24px;
        transition: background 0.2s;
    }
    .toggle-slider::before {
        content: '';
        position: absolute;
        width: 18px;
        height: 18px;
        left: 3px;
        bottom: 3px;
        background: var(--text-primary);
        border-radius: 50%;
        transition: transform 0.2s;
    }
    .toggle-switch input:checked + .toggle-slider {
        background: var(--accent);
    }
    .toggle-switch input:checked + .toggle-slider::before {
        transform: translateX(20px);
    }
    /* Restart Warning Banner */
    .restart-warning {
        display: none;
        padding: 10px 16px;
        margin-bottom: 16px;
        background: rgba(234, 179, 8, 0.1);
        border: 1px solid var(--warning);
        border-radius: 6px;
        font-size: 0.8rem;
        color: var(--warning);
        align-items: center;
        gap: 8px;
    }
    .restart-warning.visible {
        display: flex;
    }

    /* Settings Toast */
    .settings-toast {
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
    .settings-toast.show { opacity: 1; transform: translateY(0); }
    .settings-toast.success { border-color: var(--success); color: var(--success); }
    .settings-toast.error { border-color: var(--danger); color: var(--danger); }

    /* SSE Update Indicator */
    .setting-sse-badge {
        display: inline-block;
        font-size: 0.65rem;
        color: var(--accent);
        background: rgba(59, 130, 246, 0.1);
        padding: 2px 6px;
        border-radius: 3px;
        margin-left: 8px;
        opacity: 0;
        transition: opacity 0.3s;
    }
    .setting-sse-badge.visible {
        opacity: 1;
    }

    /* Change History */
    .history-section {
        margin-top: 16px;
    }
    .btn-history-load {
        background: var(--accent);
        color: #fff;
        border: none;
        padding: 4px 12px;
        border-radius: 4px;
        font-size: 0.72rem;
        cursor: pointer;
        font-weight: 500;
        transition: opacity 0.15s;
    }
    .btn-history-load:hover {
        opacity: 0.85;
    }
    .btn-history-load:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    .history-container {
        padding: 16px 20px;
    }
    .history-empty,
    .history-loading {
        font-size: 0.82rem;
        color: var(--text-muted);
        text-align: center;
        padding: 20px 0;
    }
    .history-error {
        font-size: 0.82rem;
        color: var(--danger);
        text-align: center;
        padding: 12px 0;
    }
    .history-entries {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    .history-entry {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 12px 16px;
    }
    .history-entry-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
    }
    .history-entry-user {
        font-size: 0.82rem;
        font-weight: 500;
        color: var(--text-primary);
    }
    .history-entry-time {
        font-size: 0.72rem;
        color: var(--text-muted);
    }
    .history-entry-changes {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .history-change-row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        font-size: 0.78rem;
    }
    .history-change-key {
        font-weight: 500;
        color: var(--text-secondary);
        min-width: 0;
        word-break: break-all;
    }
    .history-change-values {
        color: var(--text-muted);
        display: flex;
        align-items: baseline;
        gap: 4px;
        flex-wrap: wrap;
    }
    .history-change-old {
        color: var(--danger);
        text-decoration: line-through;
        font-family: monospace;
        font-size: 0.72rem;
    }
    .history-change-arrow {
        color: var(--text-muted);
        font-size: 0.7rem;
    }
    .history-change-new {
        color: var(--success);
        font-family: monospace;
        font-size: 0.72rem;
    }
    .hidden {
        display: none;
    }

    @media (max-width: 768px) {
        .setting-row { flex-direction: column; gap: 12px; }
        .setting-control { width: 100%; }
    }
</style>`;
}

// ── Client-Side Script ──

function getSettingsScript(categories: CategoryGroup[]): string {
    // Build a JSON-serializable schema map for client-side validation
    const schemaMap: Record<
        string,
        {
            type: string;
            min: number | null;
            max: number | null;
            options: string[] | null;
            validation_pattern: string | null;
            requires_restart: boolean;
            default_value: string;
        }
    > = {};

    for (const group of categories) {
        for (const s of group.settings) {
            schemaMap[s.definition.key] = {
                type: s.definition.type,
                min: s.definition.min,
                max: s.definition.max,
                options: s.definition.options,
                validation_pattern: s.definition.validation_pattern,
                requires_restart: s.definition.requires_restart,
                default_value: s.definition.default_value,
            };
        }
    }

    return `<script>
(function() {
    // Schema definitions for client-side validation
    const SCHEMA = ${JSON.stringify(schemaMap)};

    // Track pending changes and validation errors
    const pendingChanges = {};
    const validationErrors = {};

    // ── Validation ──

    function validateSetting(key, value) {
        const def = SCHEMA[key];
        if (!def) return '';

        switch (def.type) {
            case 'boolean':
                if (value !== 'true' && value !== 'false') {
                    return "Must be 'true' or 'false'";
                }
                break;

            case 'number': {
                const num = parseFloat(value);
                if (isNaN(num)) return 'Must be a valid number';
                if (def.min !== null && num < def.min) return 'Must be >= ' + def.min;
                if (def.max !== null && num > def.max) return 'Must be <= ' + def.max;
                break;
            }

            case 'enum':
                if (!def.options || !def.options.includes(value)) {
                    return 'Must be one of: ' + (def.options || []).join(', ');
                }
                break;

            case 'cron':
                if (!isValidCron(value)) {
                    return 'Must be a valid cron expression (M H DOM MON DOW)';
                }
                break;

            case 'string':
                if (def.validation_pattern) {
                    const re = new RegExp(def.validation_pattern);
                    if (!re.test(value)) return 'Does not match required pattern';
                }
                break;
        }
        return '';
    }

    function isValidCron(value) {
        const parts = value.trim().split(/\\s+/);
        if (parts.length !== 5) return false;
        const ranges = [[0,59],[0,23],[1,31],[1,12],[0,7]];
        for (let i = 0; i < 5; i++) {
            if (!isValidCronField(parts[i], ranges[i][0], ranges[i][1])) return false;
        }
        return true;
    }

    function isValidCronField(field, min, max) {
        const listParts = field.split(',');
        for (const part of listParts) {
            if (!isValidCronPart(part, min, max)) return false;
        }
        return true;
    }

    function isValidCronPart(part, min, max) {
        if (part === '*') return true;
        if (part.includes('/')) {
            const [rangePart, stepStr] = part.split('/');
            const step = parseInt(stepStr, 10);
            if (isNaN(step) || step < 1) return false;
            if (rangePart === '*') return true;
            return isValidCronRange(rangePart, min, max);
        }
        if (part.includes('-')) return isValidCronRange(part, min, max);
        const num = parseInt(part, 10);
        return !isNaN(num) && num >= min && num <= max;
    }

    function isValidCronRange(range, min, max) {
        const [startStr, endStr] = range.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (isNaN(start) || isNaN(end)) return false;
        return start >= min && end <= max && start <= end;
    }

    // ── Event Handlers ──

    window.onSettingChange = function(key, value) {
        const error = validateSetting(key, value);
        const errorEl = document.getElementById('error-' + key);
        const row = document.querySelector('[data-key="' + key + '"].setting-row');
        const input = document.getElementById('setting-' + key);

        if (error) {
            validationErrors[key] = error;
            if (errorEl) errorEl.textContent = error;
            if (row) row.classList.add('has-error');
            if (input && input.classList) input.classList.add('invalid');
        } else {
            delete validationErrors[key];
            if (errorEl) errorEl.textContent = '';
            if (row) row.classList.remove('has-error');
            if (input && input.classList) input.classList.remove('invalid');
            pendingChanges[key] = value;
        }

        updateSaveButtonState();
        updateRestartWarning();
    };

    function updateSaveButtonState() {
        const hasErrors = Object.keys(validationErrors).length > 0;
        const saveBtn = document.getElementById('settings-save-btn');
        const applyBtn = document.getElementById('settings-apply-btn');
        if (saveBtn) saveBtn.disabled = hasErrors;
        if (applyBtn) applyBtn.disabled = hasErrors;
    }

    function updateRestartWarning() {
        let needsRestart = false;
        for (const key of Object.keys(pendingChanges)) {
            if (SCHEMA[key] && SCHEMA[key].requires_restart) {
                needsRestart = true;
                break;
            }
        }
        const warning = document.getElementById('restart-warning');
        if (warning) {
            warning.classList.toggle('visible', needsRestart);
        }
    }

    window.toggleCategory = function(headerEl) {
        headerEl.classList.toggle('collapsed');
        const body = headerEl.nextElementSibling;
        if (body) body.classList.toggle('hidden');
    };

    // ── Save / Apply ──

    window.saveSettings = async function() {
        if (Object.keys(validationErrors).length > 0) {
            showSettingsToast('Fix validation errors before saving', 'error');
            return;
        }
        if (Object.keys(pendingChanges).length === 0) {
            showSettingsToast('No changes to save', 'error');
            return;
        }

        const saveBtn = document.getElementById('settings-save-btn');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

        try {
            const res = await fetch('/admin/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pendingChanges),
            });
            const data = await res.json();
            if (res.ok) {
                showSettingsToast('Settings saved successfully', 'success');
                // Clear pending changes
                for (const key of Object.keys(pendingChanges)) delete pendingChanges[key];
            } else {
                const msg = data.errors
                    ? data.errors.map(function(e) { return e.key + ': ' + e.message; }).join(', ')
                    : (data.error || 'Save failed');
                showSettingsToast(msg, 'error');
            }
        } catch (err) {
            showSettingsToast('Network error: ' + err.message, 'error');
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
            updateSaveButtonState();
        }
    };

    window.applyAndRestart = async function() {
        if (Object.keys(validationErrors).length > 0) {
            showSettingsToast('Fix validation errors before applying', 'error');
            return;
        }

        const applyBtn = document.getElementById('settings-apply-btn');
        if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying...'; }

        try {
            const body = Object.keys(pendingChanges).length > 0 ? pendingChanges : undefined;
            const res = await fetch('/admin/api/settings/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined,
            });
            const data = await res.json();
            if (res.ok) {
                showSettingsToast(data.message || 'Applied. Restarting...', 'success');
                for (const key of Object.keys(pendingChanges)) delete pendingChanges[key];
            } else {
                showSettingsToast(data.error || 'Apply failed', 'error');
            }
        } catch (err) {
            showSettingsToast('Network error: ' + err.message, 'error');
        } finally {
            if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply & Restart'; }
            updateSaveButtonState();
        }
    };

    // ── Toast ──

    function showSettingsToast(message, type) {
        const toast = document.getElementById('settings-toast');
        if (!toast) return;
        toast.textContent = message;
        toast.className = 'settings-toast show ' + (type || '');
        setTimeout(function() { toast.className = 'settings-toast'; }, 4000);
    }

    // ── Change History ──
    // Fetches and renders audit log entries from the settings history API.
    // Displays entries in reverse chronological order with admin username,
    // timestamp, changed fields, and old → new values.
    // Requirements: 7.1, 7.2, 7.3

    window.loadHistory = async function() {
        var loadBtn = document.getElementById('history-load-btn');
        var emptyEl = document.getElementById('history-empty');
        var loadingEl = document.getElementById('history-loading');
        var errorEl = document.getElementById('history-error');
        var entriesEl = document.getElementById('history-entries');

        if (loadBtn) { loadBtn.disabled = true; loadBtn.textContent = 'Loading...'; }
        if (emptyEl) emptyEl.classList.add('hidden');
        if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }
        if (loadingEl) loadingEl.classList.remove('hidden');
        if (entriesEl) entriesEl.innerHTML = '';

        try {
            var res = await fetch('/admin/api/settings/history');
            if (!res.ok) {
                throw new Error('Server returned ' + res.status);
            }
            var data = await res.json();
            var history = data.history || [];

            if (loadingEl) loadingEl.classList.add('hidden');

            if (history.length === 0) {
                if (emptyEl) {
                    emptyEl.textContent = 'No changes recorded yet';
                    emptyEl.classList.remove('hidden');
                }
            } else {
                renderHistoryEntries(history, entriesEl);
            }
        } catch (err) {
            if (loadingEl) loadingEl.classList.add('hidden');
            if (errorEl) {
                errorEl.textContent = 'Failed to load history: ' + err.message;
                errorEl.classList.remove('hidden');
            }
        } finally {
            if (loadBtn) { loadBtn.disabled = false; loadBtn.textContent = 'Load History'; }
        }
    };

    function renderHistoryEntries(entries, container) {
        if (!container) return;
        var html = '';
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            html += renderHistoryEntry(entry);
        }
        container.innerHTML = html;
    }

    function renderHistoryEntry(entry) {
        var timestamp = formatHistoryTimestamp(entry.timestamp);
        var changesHtml = '';

        var fields = entry.changedFields || [];
        for (var i = 0; i < fields.length; i++) {
            var field = fields[i];
            var oldVal = (entry.oldValues && entry.oldValues[field]) || '(none)';
            var newVal = (entry.newValues && entry.newValues[field]) || '(none)';
            changesHtml += '<div class="history-change-row">' +
                '<span class="history-change-key">' + escHtml(field) + ':</span>' +
                '<span class="history-change-values">' +
                    '<span class="history-change-old">' + escHtml(oldVal) + '</span>' +
                    '<span class="history-change-arrow">&#x2192;</span>' +
                    '<span class="history-change-new">' + escHtml(newVal) + '</span>' +
                '</span>' +
            '</div>';
        }

        return '<div class="history-entry">' +
            '<div class="history-entry-header">' +
                '<span class="history-entry-user">' + escHtml(entry.username || 'unknown') + '</span>' +
                '<span class="history-entry-time">' + escHtml(timestamp) + '</span>' +
            '</div>' +
            '<div class="history-entry-changes">' + changesHtml + '</div>' +
        '</div>';
    }

    function formatHistoryTimestamp(isoStr) {
        try {
            var d = new Date(isoStr);
            if (isNaN(d.getTime())) return isoStr || '';
            var year = d.getFullYear();
            var month = String(d.getMonth() + 1).padStart(2, '0');
            var day = String(d.getDate()).padStart(2, '0');
            var hours = String(d.getHours()).padStart(2, '0');
            var minutes = String(d.getMinutes()).padStart(2, '0');
            var seconds = String(d.getSeconds()).padStart(2, '0');
            return year + '-' + month + '-' + day + ' ' + hours + ':' + minutes + ':' + seconds;
        } catch (e) {
            return isoStr || '';
        }
    }

    function escHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── SSE Listener for Real-Time Settings Sync ──
    // Listens for 'settings_changed' events broadcast by the server when any
    // tab/client updates a setting. Updates the corresponding input field and
    // shows a brief "Updated remotely" indicator. This keeps multiple open
    // tabs in sync without requiring a page reload.
    // Requirements: 3.4

    function attachSettingsSseListener() {
        // The main dashboard creates an EventSource at /admin/sse.
        // We access it via the global 'eventSource' variable exposed by the dashboard.
        if (typeof eventSource !== 'undefined' && eventSource) {
            eventSource.addEventListener('settings_changed', handleSettingsChangedEvent);
            return true;
        }
        return false;
    }

    function handleSettingsChangedEvent(e) {
        try {
            var data = JSON.parse(e.data);
        } catch (err) {
            return; // Ignore malformed SSE data
        }

        if (!data || !data.key) return;

        var key = data.key;
        var newValue = data.value;
        var inputEl = document.getElementById('setting-' + key);

        if (!inputEl) return;

        // Update the input value based on input type
        if (inputEl.type === 'checkbox') {
            inputEl.checked = (newValue === 'true');
        } else {
            inputEl.value = newValue;
        }

        // Clear any pending change for this key since it's now synced
        delete pendingChanges[key];
        delete validationErrors[key];

        // Clear any validation error display for this field
        var errorEl = document.getElementById('error-' + key);
        if (errorEl) errorEl.textContent = '';
        var row = document.querySelector('.setting-row[data-key="' + key + '"]');
        if (row) row.classList.remove('has-error');
        if (inputEl.classList) inputEl.classList.remove('invalid');

        // Show "Updated remotely" indicator
        showSseUpdateBadge(key);
    }

    function showSseUpdateBadge(key) {
        var row = document.querySelector('.setting-row[data-key="' + key + '"]');
        if (!row) return;

        // Create or find the badge element
        var badge = row.querySelector('.setting-sse-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'setting-sse-badge';
            badge.textContent = 'Updated by another tab';
            var labelRow = row.querySelector('.setting-label-row');
            if (labelRow) {
                labelRow.appendChild(badge);
            }
        }

        // Show the badge briefly
        badge.classList.add('visible');
        setTimeout(function() {
            badge.classList.remove('visible');
        }, 3000);
    }

    // Attach the SSE listener. If eventSource isn't ready yet, poll until it is.
    if (!attachSettingsSseListener()) {
        var sseRetryInterval = setInterval(function() {
            if (attachSettingsSseListener()) {
                clearInterval(sseRetryInterval);
            }
        }, 250);
        // Stop polling after 10 seconds (safety net)
        setTimeout(function() { clearInterval(sseRetryInterval); }, 10000);
    }
})();
<\/script>`;
}

// ── Utility ──

function esc(str: string): string {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
