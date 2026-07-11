// ==UserScript==
// @name         BetterMetas
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  Displays crowdsourced metas and hints for Geoguessr locations.
// @author       Lukas Hzb
// @updateURL    https://raw.githubusercontent.com/lukas-hzb/better_metas/main_v4/geoguessr-meta.user.js
// @downloadURL  https://raw.githubusercontent.com/lukas-hzb/better_metas/main_v4/geoguessr-meta.user.js
// @match        https://www.geoguessr.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=geoguessr.com
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// ==/UserScript==

(function() {
    'use strict';


    const SHOW_LOCATION_HUD = false;
    const REPO_OWNER = 'lukas-hzb';
    const REPO_NAME = 'better_metas';
    const REPO_BRANCH = 'main_v4';
    
    // Data Sources
    const USER_LOCATIONS_FILE = 'data/user_locations.json';
    const USER_METAS_FILE = 'data/user_metas.json';
    const SYSTEM_METAS_FILE = 'data/plonkit_metas.json';
    const SYSTEM_LOCATIONS_FILE = 'data/plonkit_locations.json';
    
    const getRawFileUrl = (file) => `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${file}?t=${Date.now()}`;
    const getApiFileUrl = (file) => `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${file}`;
    const API_USER_LOCATIONS_URL = getApiFileUrl(USER_LOCATIONS_FILE);
    const API_USER_METAS_URL = getApiFileUrl(USER_METAS_FILE);
    const API_SYSTEM_LOCATIONS_URL = getApiFileUrl(SYSTEM_LOCATIONS_FILE);
    const API_SYSTEM_METAS_URL = getApiFileUrl(SYSTEM_METAS_FILE);
    const getApiUrlForBranch = (apiUrl) => `${apiUrl}?ref=${encodeURIComponent(REPO_BRANCH)}`;
    
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const HUD_SIZE_STORAGE_KEY = 'gg_hud_size';
    const PENDING_LOCAL_CHANGES_STORAGE_KEY = 'gg_pending_local_changes';
    const DATA_CACHE_STORAGE_KEY = 'gg_data_cache';
    const DATA_CACHE_VERSION = `${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}:1`;
    const ACTIVE_SCOPES_STORAGE_KEY = 'gg_active_scopes';
    const GITHUB_TOKEN_STORAGE_KEY = 'gg_gh_token';
    const DEFAULT_HUD_WIDTH = '320px';
    const DEFAULT_HUD_HEIGHT = '75.6vh';
    const HUD_MIN_WIDTH = 260;
    const HUD_MIN_HEIGHT = 220;
    const DATA_REFRESH_AFTER_SAVE_MS = 2500;
    const SAVE_COMPLETE_RESET_MS = 1000;
    const DATA_FETCH_TIMEOUT_MS = 8000;
    const GITHUB_API_TIMEOUT_MS = 45000;
    const GITHUB_API_WRITE_TIMEOUT_MS = 90000;
    const DATA_FETCH_MAX_ATTEMPTS = 3;
    const DATA_FETCH_RETRY_DELAY_MS = 400;
    const GITHUB_CONTENT_UPDATE_MAX_ATTEMPTS = 8;
    const GITHUB_CONTENT_UPDATE_RETRY_DELAY_MS = 500;
    const GITHUB_WRITE_LOCK_STORAGE_KEY = 'gg_github_write_lock';
    const GITHUB_WRITE_LOCK_TTL_MS = 60000;
    const GITHUB_WRITE_LOCK_MAX_WAIT_MS = 45000;
    const GITHUB_WRITE_LOCK_POLL_MS = 150;
    const GITHUB_WRITE_LOCK_OWNER = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const DATA_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
    const STREETVIEW_RETRY_DELAY_MS = 500;
    const RESULT_SCREEN_GRACE_MS = 500;
    const VISIBILITY_POLL_INTERVAL_MS = 200;
    const MISSING_PANOID_PLACEHOLDER = "YOUR_PANOID_HERE";
    const META_SAVE_BUTTON_LABEL = 'Save Meta';

    /** 
     * @typedef {Object} Meta
     * @property {string} id
     * @property {string} title
     * @property {string} description
     * @property {string} [country]
     * @property {string} [scope]
     * @property {string[]} [tags]
     * @property {number} [lat]
     * @property {number} [lng]
     */

    /** @type {Object.<string, string[]|{metas:string[]}>} Combined mapping of Panoid to Meta IDs */
    let locationMap = {};
    let userLocationMap = {};
    let systemLocationMap = {};
    
    /** @type {Meta[]} Loaded meta definitions */
    let metasData = [];
    let userMetaIds = new Set();
    let systemMetaIds = new Set();
    let dataLoadSequence = 0;
    let uiInitialized = false;

    function normalizeMetaIds(value) {
        return Array.isArray(value)
            ? value.filter(id => typeof id === 'string' && id.trim())
            : [];
    }

    function getLocationMetaIds(entry) {
        if (!entry) return [];
        if (Array.isArray(entry)) return normalizeMetaIds(entry);
        return normalizeMetaIds(entry.metas);
    }

    function normalizeCoordinate(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value !== 'number' && typeof value !== 'string') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function normalizeLocationEntry(entry) {
        if (!entry) return null;

        const normalized = Array.isArray(entry)
            ? { metas: getLocationMetaIds(entry) }
            : (typeof entry === 'object' ? { ...entry, metas: getLocationMetaIds(entry) } : null);
        if (!normalized) return null;

        normalized.lat = normalizeCoordinate(normalized.lat);
        normalized.lng = normalizeCoordinate(normalized.lng);
        ['country', 'nominatimCountry', 'region', 'city', 'road'].forEach(field => {
            if (!Object.prototype.hasOwnProperty.call(normalized, field)) {
                normalized[field] = null;
            }
        });
        return normalized;
    }

    function getCurrentLocationSnapshot() {
        return {
            lat: normalizeCoordinate(currentLocationData.lat),
            lng: normalizeCoordinate(currentLocationData.lng),
            country: currentLocationData.country || null,
            nominatimCountry: currentLocationData.nominatimCountry || null,
            region: currentLocationData.region || null,
            city: currentLocationData.city || null,
            road: currentLocationData.road || null
        };
    }

    function getNormalizedRoadNames(value) {
        const values = Array.isArray(value) ? value : [value];
        return values
            .map(road => String(road || '').toLowerCase().trim())
            .filter(Boolean);
    }

    function mergeLocationEntries(systemEntry, userEntry) {
        if (!systemEntry) return normalizeLocationEntry(userEntry);
        if (!userEntry) return normalizeLocationEntry(systemEntry);

        const systemEntryMetaIds = getLocationMetaIds(systemEntry);
        const userEntryMetaIds = getLocationMetaIds(userEntry);
        const mergedMetaIds = Array.from(new Set([...systemEntryMetaIds, ...userEntryMetaIds]));

        const systemData = Array.isArray(systemEntry) ? { metas: systemEntryMetaIds } : { ...systemEntry };
        const userData = Array.isArray(userEntry) ? { metas: userEntryMetaIds } : { ...userEntry };
        return normalizeLocationEntry({ ...systemData, ...userData, metas: mergedMetaIds });
    }

    function mergeLocationMaps(systemMap, userMap) {
        const merged = { ...(systemMap || {}) };
        Object.keys(userMap || {}).forEach(panoid => {
            merged[panoid] = mergeLocationEntries(merged[panoid], userMap[panoid]);
        });
        return merged;
    }

    function ensureLocationEntry(locations, panoid) {
        if (!locations[panoid]) {
            const locationSnapshot = getCurrentLocationSnapshot();
            locations[panoid] = {
                metas: [],
                ...locationSnapshot
            };
        } else if (Array.isArray(locations[panoid])) {
            const locationSnapshot = getCurrentLocationSnapshot();
            locations[panoid] = {
                metas: getLocationMetaIds(locations[panoid]),
                ...locationSnapshot
            };
        } else {
            locations[panoid] = normalizeLocationEntry(locations[panoid]) || {
                metas: [],
                ...getCurrentLocationSnapshot()
            };
        }

        return locations[panoid];
    }

    function addMetaIdsToLocationMap(locations, panoid, metaIds) {
        const entry = ensureLocationEntry(locations, panoid);
        metaIds.forEach(id => {
            if (!entry.metas.includes(id)) {
                entry.metas.push(id);
            }
        });
    }

    function removeMetaIdsFromLocationMap(locations, panoid, metaIds) {
        if (!locations || !locations[panoid]) return;

        const idsToRemove = new Set(metaIds);
        const entry = ensureLocationEntry(locations, panoid);
        entry.metas = entry.metas.filter(id => !idsToRemove.has(id));

        if (entry.metas.length === 0) {
            delete locations[panoid];
        }
    }

    function normalizeLocationMap(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

        const normalized = {};
        Object.entries(value).forEach(([panoid, entry]) => {
            const normalizedEntry = normalizeLocationEntry(entry);
            if (normalizedEntry) {
                normalized[panoid] = normalizedEntry;
            }
        });
        return normalized;
    }

    function normalizeMetaList(value) {
        return Array.isArray(value)
            ? value
                .filter(meta => meta && typeof meta.id === 'string' && meta.id.trim())
                .map(meta => ({
                    ...meta,
                    scope: normalizeScope(meta.scope),
                    tags: normalizeTags(meta.tags)
                }))
            : [];
    }

    function normalizeSystemMetas(value) {
        if (!Array.isArray(value)) return [];
        return value.flatMap(entry => {
            if (entry && entry.id) return [entry];
            if (Array.isArray(entry)) return normalizeMetaList(entry);
            if (entry && Array.isArray(entry.metas)) return normalizeMetaList(entry.metas);
            return [];
        });
    }

    function stringifyJsonContent(content) {
        return JSON.stringify(content, null, 2).replace(/[^\x00-\x7F]/g, (char) => {
            return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        });
    }

    function normalizeDataSnapshot(value) {
        if (!value || typeof value !== 'object') return null;
        return {
            userLocationMap: normalizeLocationMap(value.userLocationMap),
            systemLocationMap: normalizeLocationMap(value.systemLocationMap),
            userMetas: normalizeMetaList(value.userMetas),
            systemMetas: normalizeSystemMetas(value.systemMetas)
        };
    }

    function buildUniqueMetas(userMetas, systemMetas) {
        const combined = [...normalizeMetaList(userMetas), ...normalizeMetaList(systemMetas)];
        const seen = new Set();
        return combined.filter(meta => {
            if (!meta || !meta.id || seen.has(meta.id)) return false;
            seen.add(meta.id);
            return true;
        });
    }

    function applyDataSnapshot(snapshot, options = {}) {
        const normalized = normalizeDataSnapshot(snapshot);
        if (!normalized) return null;

        const tempUserMetas = normalized.userMetas.slice();
        const tempUserLocationMap = { ...normalized.userLocationMap };

        if (options.prunePending) {
            pruneConfirmedPendingLocalChanges(tempUserMetas, tempUserLocationMap);
        }

        const pending = mergePendingLocalChangesInto(tempUserMetas, tempUserLocationMap);

        userLocationMap = tempUserLocationMap;
        systemLocationMap = normalized.systemLocationMap;
        locationMap = mergeLocationMaps(systemLocationMap, userLocationMap);
        userMetaIds = new Set(tempUserMetas.map(meta => meta.id).filter(Boolean));
        systemMetaIds = new Set(normalized.systemMetas.map(meta => meta.id).filter(Boolean));
        metasData = buildUniqueMetas(tempUserMetas, normalized.systemMetas);

        return { pending, userMetas: tempUserMetas, userLocationMap: tempUserLocationMap };
    }

    function readStoredValue(key, defaultValue = null) {
        if (typeof GM_getValue === 'function') {
            return GM_getValue(key, defaultValue);
        }
        return localStorage.getItem(key) ?? defaultValue;
    }

    function writeStoredValue(key, value) {
        if (typeof GM_setValue === 'function') {
            GM_setValue(key, value);
            return;
        }
        localStorage.setItem(key, value);
    }

    function clearStoredValue(key) {
        if (typeof GM_setValue === 'function') {
            GM_setValue(key, null);
        }
        localStorage.removeItem(key);
    }

    function loadCachedDataSnapshot() {
        try {
            const cached = JSON.parse(readStoredValue(DATA_CACHE_STORAGE_KEY) || 'null');
            if (!cached || typeof cached !== 'object') return null;
            if (cached.version !== DATA_CACHE_VERSION) {
                clearStoredValue(DATA_CACHE_STORAGE_KEY);
                return null;
            }
            if (!cached.timestamp || Date.now() - cached.timestamp > DATA_CACHE_MAX_AGE_MS) {
                clearStoredValue(DATA_CACHE_STORAGE_KEY);
                return null;
            }
            return normalizeDataSnapshot(cached);
        } catch (err) {
            console.warn('[BetterMetas] Invalid cached data snapshot:', err);
            clearStoredValue(DATA_CACHE_STORAGE_KEY);
            return null;
        }
    }

    function saveDataSnapshotCache(snapshot) {
        const normalized = normalizeDataSnapshot(snapshot);
        if (!normalized) return;

        try {
            writeStoredValue(DATA_CACHE_STORAGE_KEY, JSON.stringify({
                version: DATA_CACHE_VERSION,
                timestamp: Date.now(),
                ...normalized
            }));
        } catch (err) {
            console.warn('[BetterMetas] Could not save data cache:', err);
        }
    }

    function applyCachedDataSnapshot() {
        const cached = loadCachedDataSnapshot();
        if (!cached) return false;

        applyDataSnapshot(cached);
        console.log(`[BetterMetas] Loaded cached DB: ${Object.keys(locationMap).length} locs, ${metasData.length} metas.`);
        if (currentPanoid) {
            updateStatus(`ID: ${currentPanoid.substring(0,12)}...`);
            refreshDisplay();
        } else {
            updateStatus(`Cached DB (${metasData.length} metas)`);
        }
        return true;
    }
    
    let currentPanoid = null;
    let selectedMetaIds = new Set();
    let selectedAdminMetaId = null;
    let selectedAdminTransferTargetId = null;
    let adminSortMode = 'country';
    let activeMutationCount = 0;
    let backgroundRefreshTimer = null;
    
    const ALL_SCOPES = ['countrywide', 'region', 'city', 'road', '1000km', '100km', '10km', '1km', 'unique'];
    const TAG_PRESETS = ['plants', 'landscape', 'bollards', 'poles', 'signs', 'plates', 'cars', 'soil', 'structures', 'road', 'camera', 'language', 'architecture'];
    let activeScopes = loadActiveScopes();
    let resizeModePreviousSize = null;
    
    // Locking & Visibility State
    let lastResultSeenTime = 0;
    let nextPanoid = null;
    let userDismissed = false;

    // Active StreetView Instance
    let svInstance = null;
    let hooksInstalled = false;
    let googleWatcherInstalled = false;
    let watchedGoogleObject = null;
    let watchedMapsObject = null;
    const hookedStreetViewInstances = new WeakSet();
    
    /** Current Location State */
    let currentLocationData = {
        address: null,
        country: null,          // Normalized (Google preferred)
        nominatimCountry: null, // Raw Nominatim result
        googleCountry: null,    // Raw Google result
        region: null,
        city: null,
        road: null,
        lat: null,
        lng: null
    };

    function getScopeLabel(scope) {
        if (!scope) return '';
        if (/^\d+km$/i.test(scope)) return scope;
        return scope.charAt(0).toUpperCase() + scope.slice(1);
    }

    function normalizeScope(scope, fallback = 'countrywide') {
        const normalized = String(scope || '').trim().toLowerCase();
        if (!normalized) return fallback;
        if (normalized === 'longitude') return 'region';
        return ALL_SCOPES.includes(normalized) ? normalized : fallback;
    }

    function normalizeTags(value) {
        const tags = Array.isArray(value)
            ? value
            : String(value || '').split(',');
        const seen = new Set();
        return tags
            .map(tag => String(tag || '').trim().toLowerCase())
            .filter(tag => TAG_PRESETS.includes(tag))
            .filter(tag => {
                if (seen.has(tag)) return false;
                seen.add(tag);
                return true;
            });
    }

    function renderScopePills(scopes, selectedScopes = null) {
        return scopes.map(scope => {
            const selectedClass = selectedScopes && selectedScopes.has(scope) ? ' gg-tag-selected' : '';
            return `<span class="gg-tag-pill${selectedClass}" data-value="${escapeHtml(scope)}">${escapeHtml(getScopeLabel(scope))}</span>`;
        }).join('');
    }

    function renderTagPills(tags) {
        return tags.map(tag => `<span class="gg-tag-pill">${escapeHtml(tag)}</span>`).join('');
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function getSafeImageUrl(value) {
        if (!value) return '';
        try {
            const url = new URL(String(value), window.location.href);
            return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
        } catch (err) {
            return '';
        }
    }

    function renderMetaImage(imageUrl) {
        const safeUrl = getSafeImageUrl(imageUrl);
        return safeUrl ? `<img src="${escapeHtml(safeUrl)}" class="gg-meta-image">` : '';
    }

    function renderStaticTags(tags) {
        return (Array.isArray(tags) ? tags : [])
            .map(tag => `<span class="gg-tag-static">${escapeHtml(tag)}</span>`)
            .join('');
    }

    function getEventElementTarget(event) {
        const target = event && event.target;
        if (!target) return null;
        if (target.nodeType === 1) return target;
        return target.parentElement || null;
    }

    function loadActiveScopes() {
        try {
            const storedScopes = JSON.parse(localStorage.getItem(ACTIVE_SCOPES_STORAGE_KEY) || 'null');
            if (Array.isArray(storedScopes)) {
                const knownScopes = storedScopes
                    .map(scope => normalizeScope(scope, null))
                    .filter(Boolean);
                if (knownScopes.length > 0) return new Set(knownScopes);
            }
        } catch (err) {
            console.warn('[BetterMetas] Invalid active scopes:', err);
        }
        return new Set(ALL_SCOPES);
    }



    // --- Styles ---
    const STYLES = `
        #gg-meta-hud {
            --gg-meta-divider-gap: 12px;
            --gg-meta-content-status-gap: 8px;

            position: fixed;
            top: 0.5rem; /* Below the top bar */
            left: 0.5rem; /* Aligned to left */
            right: auto;
            transform: none;

            width: ${DEFAULT_HUD_WIDTH};
            
            /* Window Dimensions */
            height: ${DEFAULT_HUD_HEIGHT};
            max-height: 80vh;
            display: flex;
            flex-direction: column;

            background: rgba(0, 0, 0, 0.8);
            color: #fff;
            padding: 12px 16px;
            border-radius: 16px;

            z-index: 99999;
            font-family: inherit !important;
            font-weight: 700;

            border: none;
            /* display: flex controlled via opacity now */
            display: flex; 
            flex-direction: column;
            
            /* Initial State: Hidden */
            opacity: 0;
            pointer-events: none;
            transform: translateY(10px); /* Slide up effect */
            transition: opacity 0.3s cubic-bezier(0.2, 0, 0, 1), transform 0.3s cubic-bezier(0.2, 0, 0, 1);
            
            box-shadow: none;
            text-shadow: 0 1px 4px rgba(0,0,0,0.9);

            /* Custom Scrollbar for sleek look */
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.3) transparent;
        }

        #gg-meta-hud.gg-visible {
            opacity: 1;
            pointer-events: auto;
            transform: translateY(0);
        }

        #gg-meta-hud.gg-resize-mode {
            opacity: 1;
            pointer-events: auto;
            transform: translateY(0);
            overflow: hidden;
            min-width: ${HUD_MIN_WIDTH}px;
            min-height: ${HUD_MIN_HEIGHT}px;
            max-width: calc(100vw - 1rem);
            max-height: calc(100vh - 1rem);
            box-sizing: border-box;
            background:
                radial-gradient(circle at 18% 0%, rgba(121, 80, 229, 0.24), transparent 42%),
                radial-gradient(circle at 85% 100%, rgba(0, 162, 254, 0.16), transparent 46%),
                rgba(16, 12, 38, 0.94);
            border: none;
            box-shadow: inset 0 0 38px rgba(121, 80, 229, 0.32), inset 0 0 86px rgba(0, 162, 254, 0.16);
        }

        #gg-meta-hud.gg-resize-mode::before {
            content: "";
            position: absolute;
            inset: 0;
            z-index: 4;
            box-sizing: border-box;
            border: 2px dashed rgba(121, 80, 229, 0.95);
            border-radius: inherit;
            pointer-events: none;
        }

        #gg-meta-hud.gg-resize-mode .gg-meta-content,
        #gg-meta-hud.gg-resize-mode #gg-location-info,
        #gg-meta-hud.gg-resize-mode #gg-status {
            opacity: 0.32;
            pointer-events: none;
            user-select: none;
        }

        .gg-resize-controls {
            display: none;
            align-items: center;
            gap: 10px;
        }

        .gg-normal-controls {
            display: flex;
            align-items: center;
        }

        .gg-resize-button-row {
            display: flex;
            position: relative;
            z-index: 1;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }

        .gg-resize-help-text {
            position: relative;
            z-index: 1;
            max-width: 220px;
            color: rgba(255,255,255,0.76);
            font-size: 0.72rem;
            font-weight: 600;
            line-height: 1.35;
            letter-spacing: 0;
            text-align: center;
        }

        .gg-resize-controls::before {
            content: "";
            display: none;
            position: absolute;
            inset: -180px -200px;
            z-index: 0;
            background: radial-gradient(
                    ellipse 38% 42% at 50% 54%,
                    rgba(4, 2, 15, 0.84) 0%,
                    rgba(4, 2, 15, 0.72) 16%,
                    rgba(4, 2, 15, 0.52) 30%,
                    rgba(4, 2, 15, 0.34) 44%,
                    rgba(4, 2, 15, 0.18) 56%,
                    rgba(4, 2, 15, 0.08) 66%,
                    rgba(4, 2, 15, 0.025) 76%,
                    transparent 88%,
                    transparent 100%
                );
            pointer-events: none;
        }

        .gg-resize-hitbox {
            display: none;
            position: absolute;
            right: 0;
            bottom: 0;
            z-index: 3;
            width: 34px;
            height: 34px;
            cursor: nwse-resize;
            background: transparent;
        }

        .gg-resize-mode-title {
            display: none;
            align-items: center;
            color: #fff;
            font-size: 0.95rem;
            font-weight: 800;
            line-height: 1;
            letter-spacing: 0.05em;
        }

        .gg-resize-mode-title::before {
            content: none;
        }

        #gg-meta-hud.gg-resize-mode .gg-resize-controls {
            display: flex;
            position: absolute;
            top: 50%;
            left: 50%;
            z-index: 2;
            transform: translate(-50%, -50%);
            flex-direction: column;
            isolation: isolate;
        }

        #gg-meta-hud.gg-resize-mode .gg-resize-controls::before {
            display: block;
        }

        #gg-meta-hud.gg-resize-mode .gg-resize-hitbox {
            display: block;
        }

        #gg-meta-hud.gg-resize-mode .gg-resize-mode-title {
            display: flex;
        }

        #gg-meta-hud.gg-resize-mode .gg-normal-title {
            display: none;
        }

        #gg-meta-hud.gg-resize-mode .gg-normal-controls {
            visibility: hidden;
        }

        #gg-meta-hud.gg-resize-mode .gg-meta-title {
            border-bottom-color: rgba(255,255,255,0.1);
        }

        .gg-resize-control-btn,
        #gg-meta-add-btn,
        #gg-meta-admin-btn,
        #gg-settings-btn {
            background: rgba(255, 255, 255, 0.2);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            cursor: pointer;
            font-size: 0.75rem;
            font-weight: 600;
            line-height: 1;
            padding: calc(4px - var(--gg-text-optical-shift)) 12px calc(4px + var(--gg-text-optical-shift));
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s, color 0.2s, border-color 0.2s;
        }

        #gg-meta-admin-btn,
        #gg-settings-btn {
            padding: 4px 8px;
        }

        #gg-meta-admin-btn svg,
        #gg-settings-btn svg,
        .gg-modal-back-btn svg {
            display: block;
            flex-shrink: 0;
        }

        .gg-resize-control-btn:hover,
        #gg-meta-add-btn:hover,
        #gg-meta-admin-btn:hover,
        #gg-settings-btn:hover {
            background: rgba(255, 255, 255, 0.4);
            color: #fff;
        }

        .gg-resize-control-btn.gg-save-size {
            background: #7950e5;
            border-color: #5f3dc4;
            color: #fff;
            box-shadow: 0 2px 8px rgba(121, 80, 229, 0.42);
        }

        .gg-resize-control-btn.gg-save-size:hover {
            background: #8f6bf2;
            border-color: #7950e5;
        }



        #gg-meta-hud * {
            font-family: inherit !important;
            font-weight: inherit;
        }
        /* Hover effect removed */
        .gg-meta-title {
            font-weight: 800;
            color: #fff; /* White title like compass directions */
            margin-bottom: var(--gg-meta-divider-gap);
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 0.95rem;
            /* text-transform: uppercase; Removed to allow BetterMetas mixed case */
            letter-spacing: 0.05em;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            padding-bottom: var(--gg-meta-divider-gap);
        }
        .gg-meta-content {
            font-size: 0.9rem;
            min-height: 40px;
            flex: 1;
            overflow-y: auto;
            margin-bottom: var(--gg-meta-content-status-gap); /* Spacing above status */
        }
        #gg-meta-container {
            scrollbar-width: none;
            -ms-overflow-style: none;
        }
        #gg-meta-container::-webkit-scrollbar {
            display: none;
            width: 0;
            height: 0;
        }
        .gg-meta-tag, .gg-tag-pill {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: rgba(255, 255, 255, 0.2);
            color: #fff;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 0.75rem;
            margin-right: 4px;
            margin-bottom: 4px;
            font-weight: 600;
            line-height: 1;
        }

        .gg-tag-pill {
            cursor: pointer;
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: background 0.2s;
        }

        .gg-tag-pill:hover {
            background: rgba(255, 255, 255, 0.4);
        }

        .gg-tag-pill.gg-tag-selected {
            background: var(--gg-primary-green); /* GeoGuessr Green */
            color: #fff;
            border-color: var(--gg-primary-border);
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }

        .gg-tag-static {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: rgba(255, 255, 255, 0.2);
            color: #fff;
            padding: 1px 6px;
            border-radius: 12px;
            font-size: 0.65rem;
            margin-right: 6px;
            font-weight: 600;
            border: 1px solid rgba(255, 255, 255, 0.1);
            cursor: default;
            white-space: nowrap;
            line-height: 1;
        }

        .gg-meta-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 0.65rem;
            border: 1px solid;
            padding: 1px 5px 0;
            border-radius: 4px;
            margin-left: 0;
            font-weight: 700;
            line-height: 1;
            transform: translateY(1px);
        }

        .gg-meta-badge-linked {
            background: rgba(140, 212, 90, 0.15);
            border-color: rgba(140, 212, 90, 0.4);
            color: var(--gg-primary-green);
        }

        .gg-meta-badge-predicted {
            background: rgba(255,255,255,0.15);
            border-color: rgba(255,255,255,0.2);
            color: rgba(255,255,255,0.7);
        }

        .gg-meta-tags {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 4px;
            margin-left: 1px;
        }

        .gg-meta-tags .gg-tag-static {
            margin-right: 0;
        }

        .gg-country-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: rgba(249, 115, 22, 0.15);
            color: #fb923c;
            border: 1px solid rgba(249, 115, 22, 0.4);
            padding: 2px 4px;
            border-radius: 4px;
            font-size: 0.65rem;
            font-weight: 800;
            text-transform: uppercase;
            margin-right: 4px;
            flex-shrink: 0;
            min-width: 24px;
            text-align: center;
            line-height: 1;
            box-shadow: 0 0 4px rgba(249, 115, 22, 0.2);
        }

        .gg-meta-row {
            margin-bottom: var(--gg-meta-divider-gap);
            padding-bottom: var(--gg-meta-divider-gap);
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }

        .gg-meta-row-predicted {
            border-left: 2px solid rgba(255,255,255,0.2);
            padding-left: 10px;
            margin-left: -12px;
        }

        .gg-meta-item-title {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            column-gap: 8px;
            row-gap: 4px;
            font-size: 1.1rem;
            font-weight: 800;
            color: #fff;
            margin-bottom: 6px;
            line-height: 1.3;
        }

        .gg-clickable-meta-title {
            cursor: pointer;
        }

        .gg-empty-state {
            color: #ccc;
            font-style: italic;
        }

        .gg-muted-empty-state {
            opacity: 0.6;
            font-style: italic;
        }

        #gg-meta-hud .gg-meta-description {
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.8);
            margin-bottom: 8px;
            line-height: 1.4;
            font-weight: 400 !important;
            font-family: inherit;
        }
        .gg-meta-image {
            max-width: 100%;
            height: auto;
            max-height: 25vh;
            border-radius: 8px;
            margin-bottom: 8px;
            display: block;
        }
        .gg-meta-row:last-child {
            border-bottom: none;
            margin-bottom: 0;
            padding-bottom: 0;
        }

        /* Location Info Box */
        #gg-location-info {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            padding: 8px;
            margin-bottom: 12px;
            font-size: 0.8rem;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .gg-loc-row {
            display: flex;
            align-items: flex-start;
            margin-bottom: 4px;
        }
        .gg-loc-row:last-child { margin-bottom: 0; }
        .gg-loc-label {
            color: rgba(255,255,255,0.5);
            width: 70px;
            flex-shrink: 0;
            font-weight: 600;
        }
        .gg-loc-val {
            color: #fff;
            font-weight: 500;
            word-break: break-word;
        }
        .gg-loc-val-country {
            color: var(--gg-primary-green);
        }
        .gg-loc-coords {
            font-family: monospace;
            color: #ffd700;
        }

        #gg-settings-btn,
        #gg-meta-admin-btn {
            margin-right: 8px;
        }
        .gg-status-msg {
            font-size: 0.75em;
            color: rgba(255, 255, 255, 0.5);
            margin-top: var(--gg-meta-content-status-gap);
            font-style: normal;
            text-align: right;
            cursor: pointer;
        }

        /* Modal Spacing System */
        :root {
            --modal-spacing-xs: 4px;
            --modal-spacing-sm: 8px;
            --modal-spacing-md: 12px;
            --modal-spacing-lg: 24px;
            --modal-related-gap: var(--modal-spacing-sm);
            --modal-section-gap: var(--modal-spacing-md);
            --gg-text-optical-shift: 0.25px;
            --modal-radius: 16px;
            --modal-window-width: 550px;
            --modal-btn-radius: 30px;
            --modal-btn-height: 42px;
            --modal-btn-font-size: 0.8rem;
            --modal-control-bg: rgba(0, 0, 0, 0.3);
            --modal-control-bg-active: rgba(0, 0, 0, 0.4);
            --modal-control-border: rgba(100, 90, 150, 0.4);
            --modal-control-radius: 8px;
            --gg-primary-green: #97e851;
            --gg-primary-border: #479440;
            --gg-primary-gradient: linear-gradient(#97e851, #479440);
            --gg-primary-shadow: 0 0.275rem 1.125rem rgba(0, 0, 0, 0.25),
                inset 0 0.0625rem 0 rgba(255, 255, 255, 0.2),
                inset 0 -0.125rem 0 rgba(0, 0, 0, 0.3);
        }

        /* Modal Base Styles - GeoGuessr Native Style */
        #gg-meta-modal,
        #gg-settings-modal .gg-modal-container,
        #gg-meta-admin-modal,
        #gg-dialog-modal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: linear-gradient(180deg, #252060 0%, #1a1a40 100%);
            border: 1px solid rgba(80, 70, 120, 0.5);
            border-radius: var(--modal-radius);
            color: white;
            font-family: inherit;
            font-weight: 700;
            max-height: 85vh;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.3) transparent;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            text-align: center;
            padding: var(--modal-spacing-lg);
        }

        #gg-meta-modal {
            z-index: 100000;
            width: min(var(--modal-window-width), calc(100vw - 32px));
            box-sizing: border-box;
            transition: all 0.3s ease-in-out;
        }

        #gg-meta-admin-modal {
            z-index: 100000;
            width: min(var(--modal-window-width), calc(100vw - 32px));
            box-sizing: border-box;
            text-align: left;
        }

        #gg-meta-admin-modal .gg-modal-header,
        #gg-meta-admin-modal .gg-form-label,
        #gg-meta-admin-modal .gg-form-hint {
            text-align: center;
        }

        #gg-dialog-modal {
            z-index: 100003;
            width: 360px;
            display: none;
            box-sizing: border-box;
        }

        .gg-dialog-message {
            color: rgba(255, 255, 255, 0.82);
            font-size: 0.86rem;
            font-weight: 500;
            line-height: 1.45;
            margin-bottom: var(--modal-section-gap);
            white-space: pre-wrap;
        }

        .gg-dialog-actions {
            display: flex;
            flex-wrap: wrap;
            gap: var(--modal-related-gap);
            margin-top: var(--modal-section-gap);
        }

        .gg-dialog-actions .gg-btn-primary,
        .gg-dialog-actions .gg-btn-secondary,
        .gg-dialog-actions .gg-btn-danger {
            margin-top: 0;
            flex: 1;
        }

        .gg-dialog-actions .gg-btn-primary:only-child,
        .gg-dialog-actions .gg-btn-secondary:only-child {
            flex: 0 0 100%;
        }

        .gg-dialog-actions #gg-dialog-edit {
            flex: 0 0 100%;
            min-width: 0;
            padding-left: 14px;
            padding-right: 14px;
            text-transform: none;
        }

        #gg-dialog-edit .gg-dialog-edit-label {
            display: block;
            max-width: 100%;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .gg-modal-subview {
            transition: opacity 0.3s ease-in-out, transform 0.3s ease-in-out;
            opacity: 1;
            transform: translateX(0);
        }

        .gg-modal-subview.gg-hidden {
            display: none;
            opacity: 0;
            transform: translateX(20px);
        }

        #gg-settings-modal .gg-modal-container {
            z-index: 100001;
            width: min(var(--modal-window-width), calc(100vw - 32px));
            box-sizing: border-box;
        }

        /* Modal Header */
        .gg-modal-header {
            font-size: 1.1rem;
            font-weight: 800;
            color: #fff;
            margin-bottom: var(--modal-spacing-lg);
            text-align: center;
            letter-spacing: 0.02em;
        }

        .gg-modal-section-title {
            font-size: 0.8rem;
            font-weight: 700;
            color: #d4af37; /* Muted Gold instead of Orange */
            text-transform: uppercase;
            letter-spacing: 0.06em;
            margin: var(--modal-spacing-lg) 0 var(--modal-section-gap) 0;
            text-align: center;
        }

        /* Form Elements */
        .gg-form-group {
            margin-bottom: var(--modal-section-gap);
        }

        .gg-form-group-lg {
            margin-bottom: var(--modal-section-gap);
        }

        .gg-form-label {
            display: block;
            margin-bottom: var(--modal-related-gap);
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.5);
            font-weight: 600;
            text-align: center;
        }

        .gg-form-input {
            width: 100%;
            padding: var(--modal-related-gap) var(--modal-section-gap);
            background: var(--modal-control-bg);
            border: 1px solid var(--modal-control-border);
            color: white;
            border-radius: var(--modal-control-radius);
            box-sizing: border-box;
            font-family: inherit;
            font-size: 0.95rem;
            font-weight: 400;
            text-align: center;
            transition: border-color 0.2s, background 0.2s;
        }

        .gg-form-input::placeholder {
            color: rgba(255, 255, 255, 0.4);
        }

        .gg-form-input:focus {
            outline: none;
            background: var(--modal-control-bg-active);
            border-color: rgba(150, 140, 200, 0.6);
        }

        textarea.gg-form-input {
            resize: vertical;
            min-height: 42px;
            text-align: center; /* Center horizontally like other inputs */
            /* Vertical centering handled by padding inherited from .gg-form-input */
        }

        #meta-desc,
        #gg-admin-meta-desc,
        #gg-admin-meta-note {
            text-align: left;
        }

        .gg-form-hint {
            font-size: 0.7rem;
            color: rgba(255, 255, 255, 0.4);
            margin-top: var(--modal-related-gap);
            font-weight: 400;
            text-align: center;
        }

        .gg-hidden-control {
            display: none;
        }

        .gg-pill-grid {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 4px;
            margin-top: var(--modal-related-gap);
            text-align: center;
        }

        .gg-pill-grid .gg-tag-pill {
            margin: 0;
        }

        /* Buttons - GeoGuessr Green Style */
        .gg-btn-primary {
            --gg-button-hover-scale: 1.02;
            --gg-button-active-scale: 0.99;
            background: var(--gg-primary-gradient);
            color: #fff;
            border: none;
            padding: var(--modal-related-gap) 0;
            padding-bottom: calc(var(--modal-related-gap) + 0.125rem);
            border-radius: var(--modal-btn-radius);
            cursor: pointer;
            width: 100%;
            font-weight: 800;
            font-size: var(--modal-btn-font-size);
            font-style: italic;
            line-height: 1;
            text-transform: uppercase;
            letter-spacing: 0.03em;
            margin-top: var(--modal-section-gap);
            transition: transform 0.15s, background 0.15s;
            box-shadow: var(--gg-primary-shadow);
            text-shadow: 0 0.0625rem 0.125rem #171235;
            will-change: transform;
            box-sizing: border-box;
            height: var(--modal-btn-height); /* Fixed height for consistency */
            display: flex;
            align-items: center;
            justify-content: center;
            user-select: none;
            -webkit-user-select: none;
            -webkit-tap-highlight-color: transparent;
            appearance: none;
            -webkit-appearance: none;
        }

        .gg-btn-primary:focus,
        .gg-btn-secondary:focus,
        .gg-btn-danger:focus {
            outline: none;
        }

        .gg-btn-primary:focus-visible {
            outline: none;
            box-shadow: 0 0 0 2px rgba(140, 212, 90, 0.35), 0 4px 12px rgba(0, 0, 0, 0.25);
        }

        .gg-btn-primary:hover {
            transform: scale(var(--gg-button-hover-scale));
        }

        .gg-btn-primary:active {
            transform: scale(var(--gg-button-active-scale));
        }

        .gg-btn-primary:disabled,
        .gg-btn-secondary:disabled,
        .gg-btn-danger:disabled,
        .gg-btn-link-meta:disabled,
        .gg-resize-control-btn:disabled,
        #gg-meta-add-btn:disabled,
        #gg-meta-admin-btn:disabled,
        #gg-settings-btn:disabled {
            opacity: 0.58;
            cursor: wait;
            transform: none;
            pointer-events: none;
        }

        .gg-operation-busy .gg-tag-pill,
        .gg-operation-busy .gg-admin-location-item,
        .gg-operation-busy .gg-meta-list-item {
            pointer-events: none;
        }

        .gg-btn-secondary {
            background: var(--modal-control-bg);
            color: rgba(255, 255, 255, 0.7);
            border: 1px solid var(--modal-control-border);
            padding: var(--modal-related-gap) 0;
            cursor: pointer;
            margin-top: var(--modal-section-gap);
            width: 100%;
            font-size: var(--modal-btn-font-size);
            font-weight: 700;
            line-height: 1;
            border-radius: var(--modal-btn-radius); /* Match primary button */
            transition: background 0.2s, color 0.2s;
            box-sizing: border-box;
            height: var(--modal-btn-height); /* Fixed height for consistency */
            display: flex;
            align-items: center;
            justify-content: center;
            text-transform: uppercase; /* Match layout style */
            letter-spacing: 0.03em;
            user-select: none;
            -webkit-user-select: none;
            -webkit-tap-highlight-color: transparent;
            appearance: none;
            -webkit-appearance: none;
        }

        .gg-btn-secondary:focus-visible {
            outline: none;
            box-shadow: 0 0 0 2px rgba(150, 140, 200, 0.35);
        }

        .gg-btn-secondary:hover {
            background: var(--modal-control-bg-active);
            color: #fff;
        }

        .gg-btn-danger {
            background: transparent;
            color: #f97316;
            border: none;
            padding: var(--modal-related-gap) 0;
            border-radius: var(--modal-btn-radius); /* Match primary button */
            cursor: pointer;
            width: 100%;
            font-size: var(--modal-btn-font-size);
            font-weight: 700;
            line-height: 1;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            transition: background 0.2s, color 0.2s;
            box-sizing: border-box;
            box-shadow: inset 0 0 0 2px #f97316;
            height: var(--modal-btn-height); /* Fixed height for consistency */
            display: flex;
            align-items: center;
            justify-content: center;
            user-select: none;
            -webkit-user-select: none;
            -webkit-tap-highlight-color: transparent;
            appearance: none;
            -webkit-appearance: none;
        }

        .gg-btn-danger:focus-visible {
            outline: none;
            box-shadow: inset 0 0 0 2px #f97316, inset 0 0 0 4px rgba(249, 115, 22, 0.35);
        }

        .gg-btn-danger:hover {
            background: rgba(249, 115, 22, 0.15);
            box-shadow: inset 0 0 0 2px #f97316;
        }

        #gg-resize-window {
            margin-top: 0;
        }

        #gg-save-settings {
            margin-top: 0;
        }

        #meta-details-btn {
            margin-top: 0;
        }

        /* Divider */
        .gg-modal-divider {
            border: 0;
            border-top: 1px solid rgba(100, 90, 150, 0.3);
            margin: var(--modal-section-gap) 0;
        }

        .gg-modal-divider + .gg-btn-primary,
        .gg-modal-divider + .gg-btn-secondary,
        .gg-modal-divider + .gg-btn-danger,
        .gg-modal-divider + .gg-selection-actions,
        .gg-modal-divider + .gg-admin-actions {
            margin-top: 0;
        }

        /* Existing Metas List */
        #gg-existing-metas {
            max-height: 150px;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.2) transparent;
            width: 100%;
            background: var(--modal-control-bg);
            border: 1px solid var(--modal-control-border);
            border-radius: var(--modal-control-radius);
            box-sizing: border-box;
            margin-top: var(--modal-related-gap);
        }

        .gg-meta-list-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: var(--modal-related-gap) var(--modal-section-gap);
            border-bottom: 1px solid rgba(255,255,255,0.06);
        }

        .gg-meta-list-main {
            display: flex;
            align-items: baseline;
            gap: 4px;
            flex: 1;
            overflow: hidden;
            min-height: 100%;
        }

        .gg-meta-list-item:last-child {
            border-bottom: none;
        }

        .gg-list-empty-state {
            padding: var(--modal-related-gap) 0;
        }

        .gg-meta-list-title {
            font-size: 0.8rem;
            font-weight: 600;
            color: #fff;
            white-space: nowrap;
            line-height: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            padding: 0 4px;
            flex-shrink: 0;
        }

        .gg-meta-list-tags {
            display: flex;
            align-items: baseline;
            gap: 4px;
            overflow-x: auto;
            scrollbar-width: none;
            height: 100%;
            flex: 1;
            font-size: 0.65rem;
            color: rgba(255,255,255,0.4);
            margin-top: 2px;
        }

        .gg-scope-static {
            border-color: rgba(212, 175, 55, 0.45);
            background: rgba(212, 175, 55, 0.14);
            color: #f5d574;
        }

        .gg-modal-header-with-back {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .gg-modal-back-btn {
            background: none;
            border: none;
            color: rgba(255,255,255,0.5);
            cursor: pointer;
            position: absolute;
            left: 0;
            display: flex;
            align-items: center;
            padding: 0;
        }

        .gg-admin-meta-list {
            max-height: 260px;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.2) transparent;
            width: 100%;
            background: var(--modal-control-bg);
            border: 1px solid var(--modal-control-border);
            border-radius: var(--modal-control-radius);
            box-sizing: border-box;
            margin-top: var(--modal-related-gap);
        }

        .gg-admin-meta-item {
            cursor: default;
            gap: var(--modal-related-gap);
            transition: background 0.2s;
        }

        .gg-admin-meta-item .gg-meta-list-main {
            min-width: 0;
            padding-right: var(--modal-related-gap);
        }

        .gg-admin-meta-item .gg-meta-list-title {
            flex: 0 1 auto;
            min-width: 0;
        }

        .gg-admin-meta-item .gg-meta-list-tags {
            flex: 0 1 auto;
            min-width: 0;
            max-width: none;
            overflow: hidden;
        }

        .gg-admin-meta-item .gg-tag-static {
            margin-right: 0;
        }

        .gg-admin-controls {
            margin-bottom: 8px;
        }

        .gg-admin-sort-control {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 2px;
            margin-top: 6px;
        }

        .gg-admin-sort-control .gg-form-label {
            margin: 0;
            color: rgba(255, 255, 255, 0.45);
            font-size: 0.72rem;
            letter-spacing: 0.02em;
            white-space: nowrap;
        }

        .gg-admin-sort-select-wrap {
            position: relative;
            display: inline-flex;
            align-items: center;
        }

        .gg-admin-sort-select-wrap::after {
            content: '';
            position: absolute;
            right: 10px;
            top: calc(50% - 5px);
            width: 6px;
            height: 6px;
            border-right: 1.5px solid rgba(255, 255, 255, 0.65);
            border-bottom: 1.5px solid rgba(255, 255, 255, 0.65);
            pointer-events: none;
            transform: rotate(45deg);
            transition: border-color 0.2s;
        }

        .gg-admin-sort-select {
            width: auto;
            padding: 3px 22px 3px 4px;
            background: transparent;
            border: 0;
            border-radius: var(--modal-control-radius);
            cursor: pointer;
            color: rgba(255, 255, 255, 0.9);
            font-size: 0.8rem;
            text-align: left;
            appearance: none;
            -webkit-appearance: none;
        }

        .gg-admin-sort-select:focus {
            background: transparent;
            border: 0;
        }

        .gg-admin-sort-select-wrap:focus-within::after {
            border-color: rgba(200, 190, 255, 0.95);
        }

        .gg-admin-details-grid {
            display: block;
        }

        .gg-admin-details-grid .gg-form-group {
            margin-bottom: var(--modal-section-gap);
        }

        .gg-admin-actions {
            display: flex;
            flex-direction: column;
            gap: var(--modal-related-gap);
            margin-top: var(--modal-section-gap);
        }

        .gg-admin-actions .gg-btn-primary,
        .gg-admin-actions .gg-btn-secondary,
        .gg-admin-actions .gg-btn-danger {
            margin-top: 0;
        }

        .gg-admin-linked-locations {
            width: 100%;
            box-sizing: border-box;
        }

        .gg-admin-location-item {
            width: 100%;
            display: flex;
            align-items: center;
            gap: var(--modal-related-gap);
            border: none;
            background: transparent;
            color: rgba(255,255,255,0.88);
            cursor: pointer;
            font: inherit;
            font-size: 0.75rem;
            font-weight: 600;
            line-height: 1.25;
            text-align: left;
            padding: var(--modal-related-gap) var(--modal-section-gap);
            border-radius: var(--modal-control-radius);
            transition: background 0.15s;
        }

        .gg-admin-location-item:hover,
        .gg-admin-location-item:focus-visible {
            background: rgba(255,255,255,0.05);
            outline: none;
        }

        .gg-admin-location-pin,
        .gg-admin-location-external {
            width: 14px;
            height: 14px;
            flex: 0 0 14px;
            opacity: 0.42;
            transition: opacity 0.15s;
        }

        .gg-admin-location-label {
            flex: 1;
            min-width: 0;
        }

        .gg-admin-location-external {
            opacity: 0.28;
        }

        .gg-admin-location-item:hover .gg-admin-location-pin,
        .gg-admin-location-item:hover .gg-admin-location-external,
        .gg-admin-location-item:focus-visible .gg-admin-location-pin,
        .gg-admin-location-item:focus-visible .gg-admin-location-external {
            opacity: 0.85;
        }

        .gg-selection-actions {
            display: flex;
            flex-direction: column;
            gap: var(--modal-related-gap);
            margin-top: 0;
        }

        #gg-link-selected-btn {
            width: 100%;
            margin-top: 0;
            margin-bottom: 0;
        }

        #gg-link-selected-btn:disabled {
            cursor: not-allowed;
            pointer-events: auto;
            box-shadow: none;
        }

        .gg-btn-link-meta {
            --gg-button-hover-scale: 1.05;
            --gg-button-active-scale: 0.975;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: var(--gg-primary-gradient);
            color: #fff;
            border: none;
            padding: 4px 10px calc(4px + 0.125rem);
            border-radius: 12px;
            cursor: pointer;
            font-size: 0.7rem;
            font-weight: 800;
            font-style: italic;
            line-height: 1;
            text-transform: uppercase;
            letter-spacing: 0.03em;
            transition: transform 0.15s, background 0.15s;
            box-shadow: var(--gg-primary-shadow);
            text-shadow: 0 0.0625rem 0.125rem #171235;
            will-change: transform;
            flex-shrink: 0;
            user-select: none;
            -webkit-user-select: none;
        }

        .gg-btn-link-meta:focus {
            outline: none;
        }

        .gg-btn-link-meta:focus-visible {
            outline: none;
            box-shadow: 0 0 0 2px rgba(140, 212, 90, 0.35), 0 2px 6px rgba(0, 0, 0, 0.25);
        }

        .gg-btn-link-meta:hover {
            transform: scale(var(--gg-button-hover-scale));
        }

        .gg-btn-link-meta:active {
            transform: scale(var(--gg-button-active-scale));
        }

        .gg-btn-link-meta.gg-tag-selected {
            background: var(--gg-primary-green);
            border-color: var(--gg-primary-border);
        }

        .gg-btn-link-meta.gg-btn-admin-edit {
            background: linear-gradient(180deg, #f4c542 0%, #d9a91f 100%);
            border-color: #a97912;
            color: #fff;
        }

        .gg-btn-link-meta.gg-btn-admin-edit:focus-visible {
            box-shadow: 0 0 0 2px rgba(244, 197, 66, 0.35), 0 2px 6px rgba(0, 0, 0, 0.25);
        }

        .gg-btn-link-meta.gg-btn-admin-edit:hover {
            background: linear-gradient(180deg, #ffd766 0%, #e8b733 100%);
        }

        .gg-btn-link-meta.gg-btn-transfer-meta {
            background: linear-gradient(180deg, #ff6b44 0%, #d94b28 100%);
            border-color: #9e2f16;
            color: #fff;
        }

        .gg-btn-link-meta.gg-btn-transfer-meta:focus-visible {
            box-shadow: 0 0 0 2px rgba(255, 107, 68, 0.35), 0 2px 6px rgba(0, 0, 0, 0.25);
        }

        .gg-btn-link-meta.gg-btn-transfer-meta:hover {
            background: linear-gradient(180deg, #ff7d59 0%, #e95a35 100%);
        }

        .gg-meta-linked-indicator {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 58px;
            padding: 4px 10px;
            border: 1px solid rgba(140, 212, 90, 0.5);
            border-radius: 12px;
            background: rgba(140, 212, 90, 0.16);
            color: #bdf29a;
            font-size: 0.7rem;
            font-weight: 800;
            font-style: italic;
            line-height: 1;
            text-transform: uppercase;
            letter-spacing: 0.03em;
            flex-shrink: 0;
            user-select: none;
            -webkit-user-select: none;
        }

        /* JSON Output */
        #gg-json-output {
            margin-top: var(--modal-section-gap);
            background: var(--modal-control-bg-active);
            padding: var(--modal-related-gap);
            border-radius: var(--modal-control-radius);
            font-family: monospace;
            font-size: 0.7rem;
            color: #6f6;
            white-space: pre-wrap;
            display: none;
            word-break: break-all;
        }

        /* Spinner */
        .gg-spinner {
            display: inline-block;
            width: 12px;
            height: 12px;
            border: 2px solid rgba(255,255,255,0.3);
            border-radius: 50%;
            border-top-color: #fff;
            animation: gg-spin 1s ease-in-out infinite;
            margin-right: 8px;
            flex-shrink: 0;
        }

        @keyframes gg-spin {
            to { transform: rotate(360deg); }
        }

        /* Hide reaction wheel when HUD is active */
        body.gg-hud-active button.styles_hudButton__kzfFK.styles_sizeSmall__O7Bw_.styles_roundBoth__hcuEN {
            display: none !important;
        }

        /* Backdrop */
        #gg-modal-backdrop {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.4);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            z-index: 99999;
            display: none;
            opacity: 0;
            transition: opacity 0.3s;
        }

        #gg-modal-backdrop.gg-visible {
            display: block;
            opacity: 1;
        }

        .gg-modal-background-blurred {
            filter: blur(4px);
            pointer-events: none;
        }

        /* Preview Popup */
        #gg-meta-preview-popup {
            position: fixed;
            width: 280px;
            background: rgba(0, 0, 0, 0.95);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 12px;
            padding: 12px;
            z-index: 100002; /* Above modal */
            pointer-events: none; /* Don't interfere with mouse */
            opacity: 0;
            transform: translateX(-10px);
            transition: opacity 0.2s, transform 0.2s;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
            color: #fff; /* Ensure text is white */
        }

        #gg-meta-preview-popup.gg-visible {
            opacity: 1;
            transform: translateX(0);
        }

        #gg-meta-preview-popup.gg-image-url-preview {
            padding: 6px;
        }

        #gg-meta-preview-popup .gg-meta-image {
            width: 100%;
            height: 140px; /* Fixed height */
            object-fit: cover;
            border-radius: 6px;
            margin-bottom: 8px;
            background: rgba(255,255,255,0.1); /* Placeholder bg */
        }

        #gg-meta-preview-popup.gg-image-url-preview .gg-meta-image {
            height: auto;
            max-height: min(420px, calc(100vh - 48px));
            object-fit: contain;
            margin-bottom: 0;
        }

        #gg-meta-preview-popup .gg-meta-item-title {
            font-size: 0.95rem;
            margin-bottom: 4px;
            font-weight: 800;
            color: #fff;
        }

        #gg-meta-preview-popup .gg-meta-description {
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.9); /* Explicit color */
            margin-bottom: 6px;
            line-height: 1.4;
            max-height: 80px;
            overflow: hidden;
            display: -webkit-box;
            -webkit-line-clamp: 4;
            -webkit-box-orient: vertical;
        }

        #gg-meta-preview-popup .gg-meta-tags {
            gap: 4px;
            margin-left: 0;
        }

        #gg-meta-preview-popup .gg-meta-tags .gg-tag-static {
            font-size: 0.6rem;
            padding: 1px 4px;
            margin: 0;
        }

        /* Triangle Pointer (Right side) - Rotated Square Method */
        #gg-meta-preview-popup::after {
            content: "";
            position: absolute;
            top: 50%;
            right: -7px; /* Half of width protrudes */
            margin-top: -6px;
            width: 12px;
            height: 12px;
            background: rgba(0, 0, 0, 0.95);
            border-top: 1px solid rgba(255, 255, 255, 0.2);
            border-right: 1px solid rgba(255, 255, 255, 0.2);
            transform: rotate(45deg);
        }
    `;

    function addStyles() {
        const style = document.createElement('style');
        style.innerText = STYLES;
        (document.head || document.documentElement).appendChild(style);
    }

    function getSavedHudSize() {
        try {
            const savedSize = JSON.parse(localStorage.getItem(HUD_SIZE_STORAGE_KEY) || 'null');
            if (
                savedSize &&
                Number.isFinite(savedSize.width) &&
                Number.isFinite(savedSize.height) &&
                savedSize.width >= HUD_MIN_WIDTH &&
                savedSize.height >= HUD_MIN_HEIGHT
            ) {
                return savedSize;
            }
        } catch (err) {
            console.warn('[Geoguessr Meta] Invalid saved HUD size:', err);
        }

        return null;
    }

    function applyHudSize(hud, size) {
        if (size) {
            hud.style.width = `${size.width}px`;
            hud.style.height = `${size.height}px`;
            hud.style.maxWidth = 'calc(100vw - 1rem)';
            hud.style.maxHeight = 'calc(100vh - 1rem)';
        } else {
            hud.style.width = '';
            hud.style.height = '';
            hud.style.maxWidth = '';
            hud.style.maxHeight = '';
        }
    }

    function getCurrentHudSize(hud) {
        const rect = hud.getBoundingClientRect();
        const computed = window.getComputedStyle(hud);
        return {
            width: Math.round(parseFloat(computed.width) || rect.width),
            height: Math.round(parseFloat(computed.height) || rect.height)
        };
    }

    function resetHudSize(hud) {
        localStorage.removeItem(HUD_SIZE_STORAGE_KEY);
        applyHudSize(hud, null);
    }

    function getSettingsTokenValue() {
        const tokenInput = document.getElementById('gg-gh-token');
        return ((tokenInput && tokenInput.value) || localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || '').trim();
    }

    function updateDeleteUserDataButtonVisibility() {
        const deleteButton = document.getElementById('gg-delete-user-data');
        if (!deleteButton) return;

        deleteButton.style.display = getSettingsTokenValue() ? 'flex' : 'none';
    }

    function hasSavedGitHubToken() {
        return Boolean((localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || '').trim());
    }

    function updateAdminButtonVisibility() {
        const adminButton = document.getElementById('gg-meta-admin-btn');
        if (!adminButton) return;

        adminButton.style.display = hasSavedGitHubToken() ? 'flex' : 'none';
    }

    function getAdminMetaSource(metaId) {
        const isUser = userMetaIds.has(metaId);
        const isSystem = systemMetaIds.has(metaId);
        if (isUser && isSystem) return 'both';
        if (isUser) return 'user';
        if (isSystem) return 'system';
        return 'unknown';
    }

    function getAdminMetaSourceLabel(source) {
        if (source === 'both') return 'User + Plonkit';
        if (source === 'user') return 'User';
        if (source === 'system') return 'Plonkit';
        return 'Unknown';
    }

    function getAdminMetaLocationCounts(metaId) {
        const userPanoids = new Set();
        const systemPanoids = new Set();

        Object.entries(userLocationMap || {}).forEach(([panoid, entry]) => {
            if (getLocationMetaIds(entry).includes(metaId)) userPanoids.add(panoid);
        });

        Object.entries(systemLocationMap || {}).forEach(([panoid, entry]) => {
            if (getLocationMetaIds(entry).includes(metaId)) systemPanoids.add(panoid);
        });

        const allPanoids = new Set([...userPanoids, ...systemPanoids]);
        return { user: userPanoids.size, system: systemPanoids.size, total: allPanoids.size };
    }

    function normalizeSystemMetaTree(value) {
        if (!Array.isArray(value)) return [];
        return value
            .filter(country => country && typeof country === 'object' && !Array.isArray(country))
            .map(country => ({
                ...country,
                metas: normalizeMetaList(country.metas)
            }));
    }

    function updateMetaInSystemTree(tree, metaId, updateMeta) {
        let found = false;
        const updatedTree = normalizeSystemMetaTree(tree).map(country => {
            const metas = (country.metas || []).map(meta => {
                if (meta.id !== metaId) return meta;
                found = true;
                return updateMeta(meta);
            });
            return { ...country, metas };
        });

        if (!found) throw new Error(`Meta not found in ${SYSTEM_METAS_FILE}: ${metaId}`);
        return updatedTree;
    }

    function removeMetaFromSystemTree(tree, metaId) {
        let found = false;
        const updatedTree = normalizeSystemMetaTree(tree).map(country => {
            const metas = (country.metas || []).filter(meta => {
                if (meta.id === metaId) {
                    found = true;
                    return false;
                }
                return true;
            });
            return { ...country, metas };
        });

        if (!found) throw new Error(`Meta not found in ${SYSTEM_METAS_FILE}: ${metaId}`);
        return updatedTree;
    }

    function removeMetaIdFromLocationEntries(locations, metaId) {
        let changed = false;
        Object.keys(locations || {}).forEach(panoid => {
            const entry = normalizeLocationEntry(locations[panoid]);
            if (!entry) return;
            const filteredMetaIds = entry.metas.filter(id => id !== metaId);
            if (filteredMetaIds.length === entry.metas.length) return;

            changed = true;
            if (filteredMetaIds.length === 0) {
                delete locations[panoid];
            } else {
                locations[panoid] = { ...entry, metas: filteredMetaIds };
            }
        });
        return changed;
    }

    function replaceMetaIdInLocationEntries(locations, fromMetaId, toMetaId) {
        let changed = false;
        Object.keys(locations || {}).forEach(panoid => {
            const entry = normalizeLocationEntry(locations[panoid]);
            if (!entry) return;
            const currentMetaIds = entry.metas;
            if (!currentMetaIds.includes(fromMetaId)) return;

            changed = true;
            const replacedMetaIds = [];
            currentMetaIds.forEach(id => {
                const nextId = id === fromMetaId ? toMetaId : id;
                if (!replacedMetaIds.includes(nextId)) replacedMetaIds.push(nextId);
            });
            locations[panoid] = { ...entry, metas: replacedMetaIds };
        });
        return changed;
    }

    function setAdminScopeSelection(scope) {
        const normalizedScope = normalizeScope(scope);
        const scopeContainer = document.getElementById('gg-admin-scope-presets');
        const scopeInput = document.getElementById('gg-admin-meta-scope');
        if (!scopeContainer || !scopeInput) return;

        scopeInput.value = normalizedScope;
        scopeContainer.querySelectorAll('.gg-tag-pill').forEach(pill => {
            pill.classList.toggle('gg-tag-selected', pill.dataset.value === normalizedScope);
        });
    }

    function setAdminTagSelection(tags) {
        const normalizedTags = normalizeTags(tags);
        const tagContainer = document.getElementById('gg-admin-tag-presets');
        const tagInput = document.getElementById('gg-admin-meta-tags');
        if (!tagContainer || !tagInput) return;

        tagInput.value = normalizedTags.join(', ');
        tagContainer.querySelectorAll('.gg-tag-pill').forEach(pill => {
            pill.classList.toggle('gg-tag-selected', normalizedTags.includes(pill.textContent.trim().toLowerCase()));
        });
    }

    function updateAdminImagePreview() {
        const preview = document.getElementById('gg-admin-image-preview');
        const imageInput = document.getElementById('gg-admin-meta-image');
        if (preview) {
            preview.removeAttribute('src');
            preview.style.display = 'none';
        }
        if (imageInput?.matches(':hover')) showAdminImageUrlPreview();
    }

    function showAdminImageUrlPreview() {
        const imageInput = document.getElementById('gg-admin-meta-image');
        const previewPopup = document.getElementById('gg-meta-preview-popup');
        const modal = document.getElementById('gg-meta-admin-modal');
        if (!imageInput || !previewPopup || !modal) return;

        const safeUrl = getSafeImageUrl(imageInput.value);
        if (!safeUrl) {
            hideAdminImageUrlPreview();
            return;
        }

        delete previewPopup.dataset.ggPreviewCleanupId;
        previewPopup.dataset.ggPreviewMode = 'image-url';
        previewPopup.classList.add('gg-image-url-preview');
        previewPopup.innerHTML = `<img src="${escapeHtml(safeUrl)}" class="gg-meta-image" alt="">`;
        previewPopup.querySelector('img')?.addEventListener('load', positionAdminImageUrlPreview, { once: true });
        previewPopup.querySelector('img')?.addEventListener('error', hideAdminImageUrlPreview, { once: true });
        positionAdminImageUrlPreview();
    }

    function positionAdminImageUrlPreview() {
        const imageInput = document.getElementById('gg-admin-meta-image');
        const previewPopup = document.getElementById('gg-meta-preview-popup');
        const modal = document.getElementById('gg-meta-admin-modal');
        if (!imageInput || !previewPopup || !modal) return;

        const modalRect = modal.getBoundingClientRect();
        const inputRect = imageInput.getBoundingClientRect();
        const leftPos = Math.max(8, modalRect.left - 290);

        previewPopup.style.left = `${leftPos}px`;
        previewPopup.classList.add('gg-visible');

        const height = previewPopup.offsetHeight;
        const adjustedTop = Math.min(
            Math.max(8, inputRect.top + (inputRect.height / 2) - (height / 2)),
            Math.max(8, window.innerHeight - height - 8)
        );
        previewPopup.style.top = `${adjustedTop}px`;
    }

    function hideAdminImageUrlPreview() {
        const previewPopup = document.getElementById('gg-meta-preview-popup');
        if (!previewPopup) return;

        previewPopup.classList.remove('gg-visible');
        if (previewPopup.dataset.ggPreviewMode !== 'image-url') return;

        const cleanupId = `${Date.now()}-${Math.random()}`;
        previewPopup.dataset.ggPreviewCleanupId = cleanupId;
        setTimeout(() => {
            if (
                previewPopup.dataset.ggPreviewCleanupId !== cleanupId ||
                previewPopup.dataset.ggPreviewMode !== 'image-url' ||
                previewPopup.classList.contains('gg-visible')
            ) {
                return;
            }

            previewPopup.classList.remove('gg-image-url-preview');
            previewPopup.innerHTML = '';
            delete previewPopup.dataset.ggPreviewMode;
            delete previewPopup.dataset.ggPreviewCleanupId;
        }, 220);
    }

    function formatLocationValue(value) {
        if (Array.isArray(value)) return value.filter(Boolean).join(', ');
        return value || '';
    }

    function getAdminMetaLinkedLocations(metaId) {
        return Object.entries(locationMap || {})
            .map(([panoid, entry]) => ({ panoid, entry: normalizeLocationEntry(entry) }))
            .filter(({ entry }) => entry && getLocationMetaIds(entry).includes(metaId))
            .map(({ panoid, entry }) => ({
                panoid,
                ...entry,
                displayCountry: entry.country || entry.nominatimCountry || ''
            }))
            .sort((a, b) => compareAdminText(formatAdminLocationLabel(a), formatAdminLocationLabel(b)));
    }

    function formatAdminLocationLabel(location) {
        const parts = [
            location.displayCountry || 'Unknown country',
            formatLocationValue(location.region),
            formatLocationValue(location.city),
            formatLocationValue(location.road)
        ].filter(Boolean);
        return parts.length ? parts.join(', ') : location.panoid;
    }

    function getGoogleMapsUrlForLocation(location) {
        const lat = normalizeCoordinate(location.lat);
        const lng = normalizeCoordinate(location.lng);
        if (lat !== null && lng !== null) {
            return `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`;
        }

        const query = formatAdminLocationLabel(location);
        return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    }

    function renderAdminLinkedLocations(metaId) {
        const container = document.getElementById('gg-admin-linked-locations');
        if (!container) return;

        const linkedLocations = getAdminMetaLinkedLocations(metaId);
        if (linkedLocations.length === 0) {
            container.innerHTML = '<div class="gg-form-hint gg-list-empty-state">No linked locations found.</div>';
            return;
        }

        container.innerHTML = linkedLocations.map(location => `
            <button type="button" class="gg-admin-location-item" data-map-url="${escapeHtml(getGoogleMapsUrlForLocation(location))}" title="Open in Google Maps">
                <svg class="gg-admin-location-pin" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"></path><circle cx="12" cy="10" r="2.5"></circle></svg>
                <span class="gg-admin-location-label">${escapeHtml(formatAdminLocationLabel(location))}</span>
                <svg class="gg-admin-location-external" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>
            </button>
        `).join('');

        container.querySelectorAll('.gg-admin-location-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const url = item.dataset.mapUrl;
                if (url) window.open(url, '_blank', 'noopener,noreferrer');
            });
        });
    }

    function getSelectedAdminMeta() {
        if (!selectedAdminMetaId) return null;
        return metasData.find(meta => meta.id === selectedAdminMetaId) || null;
    }

    function applyAdminMetaLocally(meta) {
        const normalizedMeta = normalizeMetaList([meta])[0];
        if (!normalizedMeta) return false;

        let found = false;
        metasData = metasData.map(existingMeta => {
            if (existingMeta.id !== normalizedMeta.id) return existingMeta;
            found = true;
            return { ...existingMeta, ...normalizedMeta };
        });

        if (!found) metasData.unshift(normalizedMeta);
        return true;
    }

    function applyAdminDeleteLocally(metaId, transferTargetId = null) {
        const normalizedTransferTargetId = (transferTargetId || '').trim();
        const updateLocations = normalizedTransferTargetId
            ? locations => replaceMetaIdInLocationEntries(locations, metaId, normalizedTransferTargetId)
            : locations => removeMetaIdFromLocationEntries(locations, metaId);

        updateLocations(userLocationMap);
        updateLocations(systemLocationMap);
        metasData = metasData.filter(meta => meta.id !== metaId);
        userMetaIds.delete(metaId);
        systemMetaIds.delete(metaId);
        selectedAdminMetaId = null;
        selectedAdminTransferTargetId = null;
        locationMap = mergeLocationMaps(systemLocationMap, userLocationMap);
        if (currentPanoid) refreshDisplay();
    }

    function cloneJson(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function createLocalDataSnapshot() {
        return {
            userLocationMap: cloneJson(userLocationMap || {}),
            systemLocationMap: cloneJson(systemLocationMap || {}),
            locationMap: cloneJson(locationMap || {}),
            metasData: cloneJson(metasData || []),
            userMetaIds: Array.from(userMetaIds),
            systemMetaIds: Array.from(systemMetaIds),
            pendingLocalChanges: cloneJson(loadPendingLocalChanges())
        };
    }

    function restoreLocalDataSnapshot(snapshot) {
        if (!snapshot) return;

        userLocationMap = normalizeLocationMap(snapshot.userLocationMap);
        systemLocationMap = normalizeLocationMap(snapshot.systemLocationMap);
        locationMap = normalizeLocationMap(snapshot.locationMap);
        metasData = normalizeMetaList(snapshot.metasData);
        userMetaIds = new Set(snapshot.userMetaIds || []);
        systemMetaIds = new Set(snapshot.systemMetaIds || []);
        savePendingLocalChanges(snapshot.pendingLocalChanges || getEmptyPendingLocalChanges());

        renderAdminMetas(document.getElementById('gg-admin-search')?.value || '');
        if (selectedAdminMetaId) openAdminMetaDetails(selectedAdminMetaId);
        if (currentPanoid) refreshDisplay();
    }

    function getAdminMetaFromForm(existingMeta) {
        const readValue = id => (document.getElementById(id)?.value || '').trim();
        const updatedMeta = {
            ...existingMeta,
            title: readValue('gg-admin-meta-title'),
            description: readValue('gg-admin-meta-desc'),
            note: readValue('gg-admin-meta-note'),
            imageUrl: getSafeImageUrl(readValue('gg-admin-meta-image')) || null,
            scope: normalizeScope(readValue('gg-admin-meta-scope')),
            tags: normalizeTags(readValue('gg-admin-meta-tags'))
        };

        return updatedMeta;
    }

    function getEmptyPendingLocalChanges() {
        return { metas: [], locations: {} };
    }

    function normalizePendingLocalChanges(value) {
        const normalized = getEmptyPendingLocalChanges();
        if (!value || typeof value !== 'object') return normalized;

        normalized.metas = normalizeMetaList(value.metas);

        normalized.locations = normalizeLocationMap(value.locations);

        return normalized;
    }

    function loadPendingLocalChanges() {
        try {
            return normalizePendingLocalChanges(JSON.parse(localStorage.getItem(PENDING_LOCAL_CHANGES_STORAGE_KEY) || 'null'));
        } catch (err) {
            console.warn('[BetterMetas] Invalid pending local changes:', err);
            return getEmptyPendingLocalChanges();
        }
    }

    function savePendingLocalChanges(pending) {
        const normalized = normalizePendingLocalChanges(pending);
        if (normalized.metas.length === 0 && Object.keys(normalized.locations).length === 0) {
            localStorage.removeItem(PENDING_LOCAL_CHANGES_STORAGE_KEY);
            return;
        }

        localStorage.setItem(PENDING_LOCAL_CHANGES_STORAGE_KEY, JSON.stringify(normalized));
    }

    function mergePendingLocalChangesInto(userMetas, userLocations) {
        const pending = loadPendingLocalChanges();
        const confirmedMetaIds = new Set((userMetas || []).map(meta => meta.id).filter(Boolean));

        pending.metas.forEach(meta => {
            if (!confirmedMetaIds.has(meta.id)) {
                userMetas.push(meta);
                confirmedMetaIds.add(meta.id);
            }
        });

        Object.keys(pending.locations).forEach(panoid => {
            userLocations[panoid] = mergeLocationEntries(userLocations[panoid], pending.locations[panoid]);
        });

        return pending;
    }

    function pruneConfirmedPendingLocalChanges(rawUserMetas, rawUserLocations) {
        const pending = loadPendingLocalChanges();
        const rawMetaIds = new Set((rawUserMetas || []).map(meta => meta.id).filter(Boolean));

        const pruned = getEmptyPendingLocalChanges();
        pruned.metas = pending.metas.filter(meta => !rawMetaIds.has(meta.id));

        Object.keys(pending.locations).forEach(panoid => {
            const rawMetaIdsForLocation = new Set(getLocationMetaIds(rawUserLocations[panoid]));
            const pendingMetaIds = getLocationMetaIds(pending.locations[panoid]).filter(id => !rawMetaIdsForLocation.has(id));

            if (pendingMetaIds.length > 0) {
                const pendingEntry = Array.isArray(pending.locations[panoid])
                    ? { metas: pendingMetaIds }
                    : { ...pending.locations[panoid], metas: pendingMetaIds };
                pruned.locations[panoid] = pendingEntry;
            }
        });

        savePendingLocalChanges(pruned);
    }

    function rememberLocalLocationLinks(panoid, metaIds) {
        const pending = loadPendingLocalChanges();
        addMetaIdsToLocationMap(pending.locations, panoid, metaIds);
        savePendingLocalChanges(pending);
    }

    function forgetLocalLocationLinks(panoid, metaIds) {
        const pending = loadPendingLocalChanges();
        removeMetaIdsFromLocationMap(pending.locations, panoid, metaIds);
        savePendingLocalChanges(pending);
    }

    function rememberLocalMeta(meta, panoid) {
        const pending = loadPendingLocalChanges();
        if (!pending.metas.some(existing => existing.id === meta.id)) {
            pending.metas.push(meta);
        }
        addMetaIdsToLocationMap(pending.locations, panoid, [meta.id]);
        savePendingLocalChanges(pending);
    }

    function applyLocalLocationLinks(panoid, metaIds) {
        currentPanoid = panoid;
        nextPanoid = null;
        updateStatus(`ID: ${panoid.substring(0,12)}...`);
        addMetaIdsToLocationMap(userLocationMap, panoid, metaIds);
        locationMap = mergeLocationMaps(systemLocationMap, userLocationMap);
        rememberLocalLocationLinks(panoid, metaIds);
        console.log('[BetterMetas] Applied local location links:', {
            panoid,
            metaIds,
            linkedMetaIds: getLocationMetaIds(userLocationMap[panoid])
        });
        refreshDisplay();
    }

    function applyLocalLocationUnlinks(panoid, metaIds) {
        currentPanoid = panoid;
        nextPanoid = null;
        updateStatus(`ID: ${panoid.substring(0,12)}...`);
        removeMetaIdsFromLocationMap(userLocationMap, panoid, metaIds);
        locationMap = mergeLocationMaps(systemLocationMap, userLocationMap);
        forgetLocalLocationLinks(panoid, metaIds);
        console.log('[BetterMetas] Applied local location unlinks:', {
            panoid,
            metaIds,
            linkedMetaIds: getLocationMetaIds(userLocationMap[panoid])
        });
        refreshDisplay();
    }

    function applyLocalSavedMeta(meta, panoid) {
        currentPanoid = panoid;
        nextPanoid = null;
        updateStatus(`ID: ${panoid.substring(0,12)}...`);

        if (!metasData.some(existing => existing.id === meta.id)) {
            metasData.unshift(meta);
        }

        userMetaIds.add(meta.id);
        addMetaIdsToLocationMap(userLocationMap, panoid, [meta.id]);
        locationMap = mergeLocationMaps(systemLocationMap, userLocationMap);
        rememberLocalMeta(meta, panoid);
        console.log('[BetterMetas] Applied local saved meta:', {
            panoid,
            metaId: meta.id,
            linkedMetaIds: getLocationMetaIds(userLocationMap[panoid])
        });
        refreshDisplay();
    }

    function setControlsDisabled(container, disabled) {
        if (!container) return;

        container.classList.toggle('gg-operation-busy', disabled);
        container.querySelectorAll('button, input, textarea, select').forEach(control => {
            if (disabled) {
                control.dataset.ggWasDisabled = control.disabled ? '1' : '0';
                control.disabled = true;
            } else {
                control.disabled = control.dataset.ggWasDisabled === '1';
                delete control.dataset.ggWasDisabled;
            }
        });
    }

    function setButtonBusy(button, busy, busyText = '') {
        if (!button) return;

        if (busy) {
            if (!button.dataset.ggOriginalHtml) button.dataset.ggOriginalHtml = button.innerHTML;
            button.disabled = true;
            if (busyText) button.innerHTML = `<span class="gg-spinner"></span>${escapeHtml(busyText)}`;
            return;
        }

        if (button.dataset.ggOriginalHtml) {
            button.innerHTML = button.dataset.ggOriginalHtml;
            delete button.dataset.ggOriginalHtml;
        }
    }

    function beginMutationUi({ scope = null, button = null, busyText = 'Saving...', statusText = '' } = {}) {
        if (activeMutationCount > 0) {
            updateStatus('Finishing previous change...');
            return null;
        }

        activeMutationCount += 1;
        if (statusText) updateStatus(statusText);
        if (scope) setControlsDisabled(scope, true);
        setButtonBusy(button, true, busyText);

        return ({ buttonText = null, restoreButton = true } = {}) => {
            if (buttonText && button) {
                button.textContent = buttonText;
                delete button.dataset.ggOriginalHtml;
            } else if (restoreButton) {
                setButtonBusy(button, false);
            }
            if (scope) setControlsDisabled(scope, false);
            activeMutationCount = Math.max(0, activeMutationCount - 1);
        };
    }

    function scheduleBackgroundDataRefresh(delay = DATA_REFRESH_AFTER_SAVE_MS) {
        clearTimeout(backgroundRefreshTimer);
        backgroundRefreshTimer = setTimeout(() => {
            backgroundRefreshTimer = null;
            fetchLocationData();
        }, delay);
    }

    function setElementDisplay(id, display) {
        const el = document.getElementById(id);
        if (el) el.style.display = display;
    }

    function showBackdrop() {
        const backdrop = document.getElementById('gg-modal-backdrop');
        if (backdrop) backdrop.classList.add('gg-visible');
    }

    function hideBackdrop() {
        const backdrop = document.getElementById('gg-modal-backdrop');
        if (backdrop) backdrop.classList.remove('gg-visible');
    }

    function showMetaModal() {
        setElementDisplay('gg-meta-modal', 'block');
        setElementDisplay('gg-settings-modal', 'none');
        setElementDisplay('gg-meta-admin-modal', 'none');
        showBackdrop();
    }

    function showSettingsModal() {
        setElementDisplay('gg-settings-modal', 'block');
        setElementDisplay('gg-meta-modal', 'none');
        setElementDisplay('gg-meta-admin-modal', 'none');
        showBackdrop();
    }

    function showAdminModal() {
        setElementDisplay('gg-meta-admin-modal', 'block');
        setElementDisplay('gg-settings-modal', 'none');
        setElementDisplay('gg-meta-modal', 'none');
        showBackdrop();
    }

    function hideMetaModal() {
        setElementDisplay('gg-meta-modal', 'none');
    }

    function hideSettingsModal() {
        setElementDisplay('gg-settings-modal', 'none');
    }

    function hideAdminModal() {
        setElementDisplay('gg-meta-admin-modal', 'none');
    }

    function hideAllModals({ hideBackdropOverlay = true } = {}) {
        hideMetaModal();
        hideSettingsModal();
        hideAdminModal();
        if (hideBackdropOverlay) hideBackdrop();
    }

    function hidePreviewPopup() {
        const previewPopup = document.getElementById('gg-meta-preview-popup');
        if (!previewPopup) return;
        if (previewPopup.dataset.ggPreviewMode === 'image-url') {
            hideAdminImageUrlPreview();
            return;
        }
        previewPopup.classList.remove('gg-visible');
    }

    function getVisibleModalElementsForDialogBlur() {
        return ['gg-meta-modal', 'gg-settings-modal', 'gg-meta-admin-modal']
            .map(id => document.getElementById(id))
            .filter(modal => modal && window.getComputedStyle(modal).display !== 'none');
    }

    function showToolDialog({
        title = 'BetterMetas',
        message = '',
        confirmText = 'OK',
        cancelText = '',
        danger = false
    } = {}) {
        const dialog = document.getElementById('gg-dialog-modal');
        const backdrop = document.getElementById('gg-modal-backdrop');
        if (!dialog) return Promise.resolve(false);

        const backdropWasVisible = Boolean(backdrop && backdrop.classList.contains('gg-visible'));
        const backgroundModals = getVisibleModalElementsForDialogBlur();
        dialog.innerHTML = `
            <div class="gg-modal-header">${escapeHtml(title)}</div>
            <div class="gg-dialog-message">${escapeHtml(message)}</div>
            <div class="gg-dialog-actions">
                ${cancelText ? `<button class="gg-btn-secondary" id="gg-dialog-cancel">${escapeHtml(cancelText)}</button>` : ''}
                <button class="${danger ? 'gg-btn-danger' : 'gg-btn-primary'}" id="gg-dialog-confirm">${escapeHtml(confirmText)}</button>
            </div>
        `;

        showBackdrop();
        backgroundModals.forEach(modal => modal.classList.add('gg-modal-background-blurred'));
        dialog.style.display = 'block';

        return new Promise(resolve => {
            const close = (result) => {
                dialog.style.display = 'none';
                dialog.innerHTML = '';
                backgroundModals.forEach(modal => modal.classList.remove('gg-modal-background-blurred'));
                if (!backdropWasVisible) hideBackdrop();
                resolve(result);
            };

            const confirmBtn = dialog.querySelector('#gg-dialog-confirm');
            const cancelBtn = dialog.querySelector('#gg-dialog-cancel');

            confirmBtn.addEventListener('click', () => close(true), { once: true });
            if (cancelBtn) cancelBtn.addEventListener('click', () => close(false), { once: true });

            requestAnimationFrame(() => confirmBtn.focus());
        });
    }

    function showToolAlert(title, message, confirmText = 'OK') {
        return showToolDialog({ title, message, confirmText });
    }

    function showToolConfirm(title, message, {
        confirmText = 'OK',
        cancelText = 'Cancel',
        danger = false
    } = {}) {
        return showToolDialog({ title, message, confirmText, cancelText, danger });
    }

    function showMetaTitleActionDialog({ title = '', action = '', canEdit = false } = {}) {
        const dialog = document.getElementById('gg-dialog-modal');
        const backdrop = document.getElementById('gg-modal-backdrop');
        if (!dialog) return Promise.resolve(null);

        const actionLabel = action === 'unlink' ? 'Remove' : 'Link';
        const actionClass = action === 'unlink' ? 'gg-btn-danger' : 'gg-btn-primary';
        const metaTitle = String(title || '').trim();
        const maxEditTitleLength = 46;
        const truncatedMetaTitle = metaTitle.length > maxEditTitleLength
            ? `${metaTitle.slice(0, maxEditTitleLength - 3).trimEnd()}...`
            : metaTitle;
        const editLabel = truncatedMetaTitle ? `Edit "${truncatedMetaTitle}"` : 'Edit Meta';
        const editTitle = metaTitle ? `Edit "${metaTitle}"` : 'Edit Meta';
        const backdropWasVisible = Boolean(backdrop && backdrop.classList.contains('gg-visible'));
        const backgroundModals = getVisibleModalElementsForDialogBlur();

        dialog.innerHTML = `
            <div class="gg-modal-header">Meta Actions</div>
            <div class="gg-dialog-actions">
                ${canEdit ? `<button class="gg-btn-secondary" id="gg-dialog-edit" title="${escapeHtml(editTitle)}"><span class="gg-dialog-edit-label">${escapeHtml(editLabel)}</span></button>` : ''}
                <button class="gg-btn-secondary" id="gg-dialog-cancel">Cancel</button>
                ${action ? `<button class="${actionClass}" id="gg-dialog-toggle">${escapeHtml(actionLabel)}</button>` : ''}
            </div>
        `;

        showBackdrop();
        backgroundModals.forEach(modal => modal.classList.add('gg-modal-background-blurred'));
        dialog.style.display = 'block';

        return new Promise(resolve => {
            const close = (result) => {
                dialog.style.display = 'none';
                dialog.innerHTML = '';
                backgroundModals.forEach(modal => modal.classList.remove('gg-modal-background-blurred'));
                if (!backdropWasVisible) hideBackdrop();
                resolve(result);
            };

            const cancelBtn = dialog.querySelector('#gg-dialog-cancel');
            const editBtn = dialog.querySelector('#gg-dialog-edit');
            const toggleBtn = dialog.querySelector('#gg-dialog-toggle');

            cancelBtn.addEventListener('click', () => close(null), { once: true });
            if (editBtn) editBtn.addEventListener('click', () => close('edit'), { once: true });
            if (toggleBtn) toggleBtn.addEventListener('click', () => close(action), { once: true });

            requestAnimationFrame(() => (toggleBtn || editBtn || cancelBtn).focus());
        });
    }

    // --- UI Construction ---
    function createHUD() {
        if (document.getElementById('gg-meta-hud')) return;

        // HUD
        const hud = document.createElement('div');
        hud.id = 'gg-meta-hud';
        applyHudSize(hud, getSavedHudSize());
        hud.innerHTML = `
            <div class="gg-meta-title">
                <span class="gg-normal-title">BetterMetas</span>
                <span class="gg-resize-mode-title">Resizing Window...</span>
                <div class="gg-normal-controls">
                    <button id="gg-meta-admin-btn" title="Manage Metas">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"></path><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"></path></svg>
                    </button>
                    <button id="gg-settings-btn" title="Settings">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                    </button>

                    <button id="gg-meta-add-btn">+ Add</button>
                </div>
                <div class="gg-resize-controls">
                    <div class="gg-resize-help-text">Drag the bottom-right corner to resize this window.</div>
                    <div class="gg-resize-button-row">
                        <button class="gg-resize-control-btn gg-save-size" id="gg-resize-save">Save</button>
                        <button class="gg-resize-control-btn" id="gg-resize-reset">Reset</button>
                        <button class="gg-resize-control-btn" id="gg-resize-close">Close</button>
                    </div>
                </div>
            </div>
            <div class="gg-resize-hitbox" id="gg-resize-hitbox" title="Drag to resize"></div>
            <div id="gg-location-info" class="gg-hidden-control">
                <!-- Filled by JS -->
            </div>

            <div id="gg-meta-container" class="gg-meta-content">
                <div class="gg-empty-state">Waiting for location...</div>
            </div>
            <div id="gg-status" class="gg-status-msg" title="Click to retry finding location">Waiting for location...</div>
        `;
        document.body.appendChild(hud);

        // Backdrop
        const backdrop = document.createElement('div');
        backdrop.id = 'gg-modal-backdrop';
        document.body.appendChild(backdrop);

        // Preview Popup
        const previewPopup = document.createElement('div');
        previewPopup.id = 'gg-meta-preview-popup';
        document.body.appendChild(previewPopup);

        const dialogModal = document.createElement('div');
        dialogModal.id = 'gg-dialog-modal';
        document.body.appendChild(dialogModal);

        // Close preview on outside click
        document.addEventListener('click', (e) => {
            if (previewPopup.classList.contains('gg-visible')) {
                hidePreviewPopup();
            }
        });

        // SETTINGS MODAL
        const settingsModal = document.createElement('div');
        settingsModal.id = 'gg-settings-modal';
        settingsModal.style.display = 'none';
        settingsModal.innerHTML = `
            <div class="gg-modal-container">
                <div class="gg-modal-header">Settings</div>
                
                <div class="gg-form-group gg-form-group-lg">
                    <label class="gg-form-label">Scope Filter</label>
                    <div id="gg-settings-scope-filter" class="gg-pill-grid">
                        <!-- Filled by JS -->
                    </div>
                </div>
                <hr class="gg-modal-divider">
                
                <div class="gg-form-group">
                    <label class="gg-form-label">GitHub Personal Access Token</label>
                    <input type="password" id="gg-gh-token" class="gg-form-input" placeholder="ghp_...">
                    <div class="gg-form-hint">Required to save new metas directly.</div>
                </div>

                <hr class="gg-modal-divider">

                <div class="gg-form-group">
                    <label class="gg-form-label">Saved User Data</label>
                    <button class="gg-btn-danger" id="gg-delete-user-data">Delete Saved User Data</button>
                    <div class="gg-form-hint">Deletes user_metas.json and user_locations.json. Plonkit data stays untouched.</div>
                </div>

                <hr class="gg-modal-divider">

                <div class="gg-form-group">
                    <label class="gg-form-label">Additional Settings</label>
                    <button class="gg-btn-secondary" id="gg-resize-window">Resize Window</button>
                </div>

                <hr class="gg-modal-divider">

                <button class="gg-btn-primary" id="gg-save-settings">Save Changes</button>
                
                <button class="gg-btn-secondary" id="gg-close-settings">Close</button>
            </div>
        `;
        document.body.appendChild(settingsModal);

        // Stop propagation for Settings inputs
        const settInputs = settingsModal.querySelectorAll('input');
        settInputs.forEach(input => {
            input.addEventListener('keydown', (e) => e.stopPropagation());
            input.addEventListener('keypress', (e) => e.stopPropagation());
            input.addEventListener('keyup', (e) => e.stopPropagation());
        });
        settingsModal.querySelector('#gg-gh-token').addEventListener('input', updateDeleteUserDataButtonVisibility);

        // ADMIN MODAL
        const adminModal = document.createElement('div');
        adminModal.id = 'gg-meta-admin-modal';
        adminModal.style.display = 'none';
        adminModal.innerHTML = `
            <div id="gg-admin-main-view" class="gg-modal-subview">
                <div class="gg-modal-header">Manage Metas</div>
                <div class="gg-form-group gg-admin-controls">
                    <input type="text" id="gg-admin-search" class="gg-form-input" placeholder="Filter by country, title or tags (e.g. Kenya; snorkel)">
                    <div class="gg-admin-sort-control">
                        <label class="gg-form-label" for="gg-admin-sort-options">Sort by</label>
                        <span class="gg-admin-sort-select-wrap">
                            <select id="gg-admin-sort-options" class="gg-form-input gg-admin-sort-select">
                                <option value="country">Country</option>
                                <option value="scope">Scope</option>
                                <option value="tags">Tags</option>
                                <option value="newest">Recently Added</option>
                            </select>
                        </span>
                    </div>
                </div>
                <div id="gg-admin-meta-list" class="gg-admin-meta-list"></div>
                <hr class="gg-modal-divider">
                <button class="gg-btn-secondary" id="gg-admin-close-btn">Close</button>
            </div>

            <div id="gg-admin-details-view" class="gg-modal-subview gg-hidden">
                <div class="gg-modal-header gg-modal-header-with-back">
                    <button id="gg-admin-back-btn" class="gg-modal-back-btn">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                    </button>
                    Meta Details
                </div>

                <div class="gg-admin-details-grid">
                    <div class="gg-form-group">
                        <label class="gg-form-label">Title</label>
                        <input type="text" id="gg-admin-meta-title" class="gg-form-input">
                    </div>
                    <div class="gg-form-group">
                        <label class="gg-form-label">Image URL (optional)</label>
                        <input type="text" id="gg-admin-meta-image" class="gg-form-input">
                    </div>
                    <div class="gg-form-group">
                        <label class="gg-form-label">Description</label>
                        <textarea id="gg-admin-meta-desc" class="gg-form-input" rows="4"></textarea>
                    </div>
                    <div class="gg-form-group">
                        <label class="gg-form-label">Note</label>
                        <textarea id="gg-admin-meta-note" class="gg-form-input" rows="3"></textarea>
                    </div>
                    <div class="gg-form-group">
                        <label class="gg-form-label">Scope</label>
                        <input type="text" id="gg-admin-meta-scope" class="gg-form-input gg-hidden-control">
                        <div id="gg-admin-scope-presets" class="gg-pill-grid">
                            ${renderScopePills(ALL_SCOPES)}
                        </div>
                    </div>
                    <div class="gg-form-group">
                        <label class="gg-form-label">Tags</label>
                        <input type="text" id="gg-admin-meta-tags" class="gg-form-input gg-hidden-control">
                        <div id="gg-admin-tag-presets" class="gg-pill-grid">
                            ${renderTagPills(TAG_PRESETS)}
                        </div>
                    </div>
                </div>

                <hr class="gg-modal-divider">

                <div class="gg-form-group">
                    <label class="gg-form-label">Linked Locations</label>
                    <div id="gg-admin-linked-locations" class="gg-admin-linked-locations"></div>
                </div>

                <hr class="gg-modal-divider">

                <div class="gg-admin-actions">
                    <button class="gg-btn-primary" id="gg-admin-save-btn">Save Meta</button>
                    <button class="gg-btn-danger" id="gg-admin-transfer-toggle-btn">Transfer Delete</button>
                    <button class="gg-btn-danger" id="gg-admin-delete-btn">Delete Meta</button>
                </div>
            </div>

            <div id="gg-admin-transfer-view" class="gg-modal-subview gg-hidden">
                <div class="gg-modal-header gg-modal-header-with-back">
                    <button id="gg-admin-transfer-back-btn" class="gg-modal-back-btn">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                    </button>
                    Transfer Delete
                </div>

                <div class="gg-form-group">
                    <input type="text" id="gg-admin-transfer-search" class="gg-form-input" placeholder="Filter by country, title or tags (e.g. Kenya; snorkel)">
                </div>
                <div id="gg-admin-transfer-metas" class="gg-admin-meta-list"></div>

                <hr class="gg-modal-divider">

                <button class="gg-btn-secondary" id="gg-admin-transfer-cancel-btn">Cancel</button>
            </div>
        `;
        document.body.appendChild(adminModal);

        adminModal.querySelectorAll('input, textarea').forEach(input => {
            input.addEventListener('keydown', (e) => e.stopPropagation());
            input.addEventListener('keypress', (e) => e.stopPropagation());
            input.addEventListener('keyup', (e) => e.stopPropagation());
        });

        adminModal.querySelector('#gg-admin-scope-presets').addEventListener('click', (e) => {
            const target = getEventElementTarget(e);
            if (!target || !target.classList.contains('gg-tag-pill')) return;

            adminModal.querySelectorAll('#gg-admin-scope-presets .gg-tag-pill').forEach(pill => {
                pill.classList.toggle('gg-tag-selected', pill === target);
            });
            document.getElementById('gg-admin-meta-scope').value = target.dataset.value || '';
        });

        adminModal.querySelector('#gg-admin-tag-presets').addEventListener('click', (e) => {
            const target = getEventElementTarget(e);
            if (!target || !target.classList.contains('gg-tag-pill')) return;

            target.classList.toggle('gg-tag-selected');
            const selectedTags = Array.from(adminModal.querySelectorAll('#gg-admin-tag-presets .gg-tag-pill.gg-tag-selected'))
                .map(pill => pill.textContent.trim());
            document.getElementById('gg-admin-meta-tags').value = normalizeTags(selectedTags).join(', ');
        });

        const adminImageInput = adminModal.querySelector('#gg-admin-meta-image');
        adminImageInput.addEventListener('input', updateAdminImagePreview);
        adminImageInput.addEventListener('mouseenter', showAdminImageUrlPreview);
        adminImageInput.addEventListener('mouseleave', hideAdminImageUrlPreview);

        // MODAL
        const modal = document.createElement('div');
        modal.id = 'gg-meta-modal';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div id="meta-main-view" class="gg-modal-subview">
                <div class="gg-modal-header">Add metas to location</div>
                
                <div class="gg-form-group">
                    <input type="text" id="meta-search" class="gg-form-input" placeholder="Filter by country, title or tags (e.g. Kenya; snorkel)">
                </div>
                <div id="gg-existing-metas"></div>

                <hr class="gg-modal-divider">

                <div id="gg-selection-actions" class="gg-selection-actions">
                    <button class="gg-btn-primary" id="gg-link-selected-btn">
                        Link Selected Metas (0)
                    </button>
                </div>

                <hr class="gg-modal-divider">

                <div>
                    <button class="gg-btn-primary" id="meta-details-btn">
                        Add another meta
                    </button>
                </div>

                <div id="gg-json-output"></div>

                <button class="gg-btn-secondary" id="meta-close-btn">Close</button>
            </div>

            <div id="meta-details-view" class="gg-modal-subview gg-hidden">
                <div class="gg-modal-header gg-modal-header-with-back">
                    <button id="meta-back-btn" class="gg-modal-back-btn">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                    </button>
                    Meta Details
                </div>

                <div class="gg-form-group">
                    <label class="gg-form-label">Title</label>
                    <input type="text" id="meta-title" class="gg-form-input" placeholder="e.g. Kenya Snorkel">
                </div>

                <div class="gg-form-group">
                    <label class="gg-form-label">Description</label>
                    <textarea id="meta-desc" class="gg-form-input" rows="3" placeholder="Describe the hint..."></textarea>
                </div>

                <div class="gg-form-group">
                    <label class="gg-form-label">Image URL (optional)</label>
                    <input type="text" id="meta-image" class="gg-form-input" placeholder="https://...">
                </div>

                <div class="gg-form-group">
                    <label class="gg-form-label">Scope</label>
                    <input type="text" id="meta-scope" class="gg-form-input gg-hidden-control">
                    <div id="meta-scope-presets" class="gg-pill-grid">
                        ${renderScopePills(ALL_SCOPES)}
                    </div>
                </div>

                <div class="gg-form-group">
                    <label class="gg-form-label">Tags</label>
                    <!-- Input hidden, using pills only -->
                    <input type="text" id="meta-tags" class="gg-form-input gg-hidden-control" placeholder="">
                    <div id="meta-tag-presets" class="gg-pill-grid">
                        ${renderTagPills(TAG_PRESETS)}
                    </div>
                </div>

                <hr class="gg-modal-divider">

                <button class="gg-btn-primary" id="meta-generate-btn">${META_SAVE_BUTTON_LABEL}</button>
            </div>
        `;

        // Presets Logic (Multi-select)
        const presetContainer = modal.querySelector('#meta-tag-presets');
        
        const updateHiddenInput = () => {
            const selected = Array.from(presetContainer.querySelectorAll('.gg-tag-selected'))
                                  .map(el => el.textContent.trim());
            document.getElementById('meta-tags').value = normalizeTags(selected).join(', ');
        };

        presetContainer.addEventListener('click', (e) => {
            const target = getEventElementTarget(e);
            if (target && target.classList.contains('gg-tag-pill')) {
                target.classList.toggle('gg-tag-selected');
                updateHiddenInput();
            }
        });

        // Scope Logic (Single-select)
        const scopeContainer = modal.querySelector('#meta-scope-presets');
        
        scopeContainer.addEventListener('click', (e) => {
            const target = getEventElementTarget(e);
            if (target && target.classList.contains('gg-tag-pill')) {
                // Deselect all others
                Array.from(scopeContainer.querySelectorAll('.gg-tag-pill')).forEach(el => {
                   if (el !== target) el.classList.remove('gg-tag-selected');
                });
                
                // Toggle clicked
                const wasSelected = target.classList.contains('gg-tag-selected');
                if (!wasSelected) {
                    target.classList.add('gg-tag-selected');
                } else {
                    target.classList.remove('gg-tag-selected');
                }

                // Update hidden input
                const selected = scopeContainer.querySelector('.gg-tag-selected');
                document.getElementById('meta-scope').value = selected ? selected.dataset.value : '';
            }
        });



        // Add Toggle logic
        const showDetails = () => {
            document.getElementById('meta-main-view').classList.add('gg-hidden');
            document.getElementById('meta-details-view').classList.remove('gg-hidden');
        };
        const hideDetails = () => {
            document.getElementById('meta-details-view').classList.add('gg-hidden');
            document.getElementById('meta-main-view').classList.remove('gg-hidden');
        };

        modal.querySelector('#meta-details-btn').addEventListener('click', showDetails);
        modal.querySelector('#meta-back-btn').addEventListener('click', hideDetails);

        // Stop propagation for inputs to prevent game shortcuts
        const inputs = modal.querySelectorAll('input, textarea');
        inputs.forEach(input => {
            input.addEventListener('keydown', (e) => e.stopPropagation());
            input.addEventListener('keypress', (e) => e.stopPropagation());
            input.addEventListener('keyup', (e) => e.stopPropagation());
        });

        document.body.appendChild(modal);

        // Event Listeners
        updateAdminButtonVisibility();

        document.getElementById('gg-meta-admin-btn').addEventListener('click', async () => {
            if (!hasSavedGitHubToken()) {
                updateAdminButtonVisibility();
                await showToolAlert('No Token Saved', 'Save a GitHub Personal Access Token in Settings to manage metas.');
                return;
            }

            selectedAdminMetaId = null;
            adminSortMode = 'country';
            const searchInput = document.getElementById('gg-admin-search');
            searchInput.value = '';
            updateAdminSortButtons();
            showAdminMainView();
            renderAdminMetas();
            hidePreviewPopup();
            showAdminModal();
            requestAnimationFrame(() => searchInput.focus());
        });

        document.getElementById('gg-meta-add-btn').addEventListener('click', async () => {
            syncPanoidForUserAction('open add modal');

            // Try to recover Panoid if missing (e.g. script loaded late on result screen)
            if (!currentPanoid) {
                updateStatus('Finding location...');
                await tryRecoverPanoid();
            }

            // Allow opening even without active location for testing, but warn
            if (!currentPanoid) {
                console.log('No active location found even after recovery attempt.');
                // Optional: Alert user?
            }
            showMetaModal();
            document.getElementById('meta-main-view').classList.remove('gg-hidden');
            document.getElementById('meta-details-view').classList.add('gg-hidden');
            const searchInput = document.getElementById('meta-search');
            searchInput.value = '';
            document.getElementById('gg-json-output').style.display = 'none';
            selectedMetaIds.clear();
            updateLinkSelectedBtn();
            renderExistingMetas(); // Populate existing metas list
            requestAnimationFrame(() => searchInput.focus());
        });

        document.getElementById('gg-settings-btn').addEventListener('click', () => {
            const token = localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || '';
            document.getElementById('gg-gh-token').value = token;
            updateDeleteUserDataButtonVisibility();
            
            // Render Scope Filter
            const scopeContainer = document.getElementById('gg-settings-scope-filter');
            scopeContainer.innerHTML = renderScopePills(ALL_SCOPES, activeScopes);

            // Add listeners
            scopeContainer.querySelectorAll('.gg-tag-pill').forEach(pill => {
                pill.addEventListener('click', (e) => {
                    const target = getEventElementTarget(e);
                    if (!target) return;
                    // Only toggle UI state, do NOT save yet
                    target.classList.toggle('gg-tag-selected');
                });
            });

            hidePreviewPopup();
            showSettingsModal();
        });

        document.getElementById('gg-save-settings').addEventListener('click', () => {
             const token = document.getElementById('gg-gh-token').value.trim();
             
             // Save Token
             if (token) {
                 localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, token);
             } else if (localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY)) {
                 // If field is empty but we had one, do we clear it? 
                 // Current logic implies empty field = no change if we don't want to clear.
                 // But typically empty input means user wants to clear if they deleted it.
                 // Let's stick to existing behavior or safest approach:
                 // If user explicitly clears it, maybe they want to clear it?
                 // For now, let's assume they might.
                 localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, '');
             }

             // Save Scopes from UI state
             const scopeContainer = document.getElementById('gg-settings-scope-filter');
             const selectedFromUI = Array.from(scopeContainer.querySelectorAll('.gg-tag-pill.gg-tag-selected'))
                                         .map(el => el.dataset.value);
             
             activeScopes = new Set(selectedFromUI);
             localStorage.setItem(ACTIVE_SCOPES_STORAGE_KEY, JSON.stringify(Array.from(activeScopes)));
             
             // Refresh HUD
             if (currentPanoid) refreshDisplay();

             updateAdminButtonVisibility();
             hideSettingsModal();
             hideBackdrop();
        });

        document.getElementById('gg-close-settings').addEventListener('click', () => {
            hideSettingsModal();
            hideBackdrop();
        });

        document.getElementById('gg-admin-search').addEventListener('input', (e) => {
            renderAdminMetas(e.target.value);
        });

        document.getElementById('gg-admin-sort-options').addEventListener('change', (e) => {
            adminSortMode = e.target.value || 'country';
            updateAdminSortButtons();
            renderAdminMetas(document.getElementById('gg-admin-search')?.value || '');
        });

        document.getElementById('gg-admin-close-btn').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            hideAdminModal();
            hideBackdrop();
            hidePreviewPopup();
        });

        document.getElementById('gg-admin-back-btn').addEventListener('click', () => {
            showAdminMainView();
            renderAdminMetas(document.getElementById('gg-admin-search')?.value || '');
        });

        document.getElementById('gg-admin-save-btn').addEventListener('click', saveAdminMeta);

        document.getElementById('gg-admin-transfer-toggle-btn').addEventListener('click', () => {
            showAdminTransferView();
        });

        document.getElementById('gg-admin-transfer-search').addEventListener('input', (e) => {
            renderAdminTransferMetas(e.target.value);
        });

        document.getElementById('gg-admin-transfer-back-btn').addEventListener('click', () => {
            showAdminDetailsView();
        });

        document.getElementById('gg-admin-transfer-cancel-btn').addEventListener('click', () => {
            showAdminDetailsView();
        });

        document.getElementById('gg-admin-delete-btn').addEventListener('click', () => deleteAdminMeta());

        function enterHudResizeMode() {
            const hud = document.getElementById('gg-meta-hud');
            if (!hud) return;

            resizeModePreviousSize = {
                width: hud.style.width,
                height: hud.style.height,
                maxWidth: hud.style.maxWidth,
                maxHeight: hud.style.maxHeight,
                wasVisible: hud.classList.contains('gg-visible')
            };

            hideAllModals();

            hidePreviewPopup();

            hud.classList.add('gg-visible', 'gg-resize-mode');
        }

        function exitHudResizeMode(restorePrevious = false) {
            const hud = document.getElementById('gg-meta-hud');
            if (!hud) return;

            hud.classList.remove('gg-resize-mode');

            if (restorePrevious && resizeModePreviousSize) {
                hud.style.width = resizeModePreviousSize.width;
                hud.style.height = resizeModePreviousSize.height;
                hud.style.maxWidth = resizeModePreviousSize.maxWidth;
                hud.style.maxHeight = resizeModePreviousSize.maxHeight;
            }

            if (resizeModePreviousSize && !resizeModePreviousSize.wasVisible) {
                hud.classList.remove('gg-visible');
            }

            resizeModePreviousSize = null;
        }

        function startHudCornerResize(e) {
            const hud = document.getElementById('gg-meta-hud');
            if (!hud || !hud.classList.contains('gg-resize-mode')) return;

            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startY = e.clientY;
            const startSize = getCurrentHudSize(hud);
            const previousUserSelect = document.body.style.userSelect;
            document.body.style.userSelect = 'none';

            const onPointerMove = (moveEvent) => {
                const maxWidth = window.innerWidth - 16;
                const maxHeight = window.innerHeight - 16;
                const width = Math.min(maxWidth, Math.max(HUD_MIN_WIDTH, startSize.width + moveEvent.clientX - startX));
                const height = Math.min(maxHeight, Math.max(HUD_MIN_HEIGHT, startSize.height + moveEvent.clientY - startY));

                hud.style.width = `${Math.round(width)}px`;
                hud.style.height = `${Math.round(height)}px`;
                hud.style.maxWidth = 'calc(100vw - 1rem)';
                hud.style.maxHeight = 'calc(100vh - 1rem)';
            };

            const onPointerUp = () => {
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
                document.body.style.userSelect = previousUserSelect;
            };

            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
        }

        document.getElementById('gg-resize-window').addEventListener('click', enterHudResizeMode);
        document.getElementById('gg-resize-hitbox').addEventListener('pointerdown', startHudCornerResize);

        document.getElementById('gg-resize-save').addEventListener('click', () => {
            const hud = document.getElementById('gg-meta-hud');
            if (!hud) return;

            const size = getCurrentHudSize(hud);
            localStorage.setItem(HUD_SIZE_STORAGE_KEY, JSON.stringify(size));
            applyHudSize(hud, size);
            exitHudResizeMode(false);
        });

        document.getElementById('gg-resize-reset').addEventListener('click', () => {
            const hud = document.getElementById('gg-meta-hud');
            if (!hud) return;

            resetHudSize(hud);
            exitHudResizeMode(false);
        });

        document.getElementById('gg-resize-close').addEventListener('click', () => {
            exitHudResizeMode(true);
        });

        document.getElementById('gg-delete-user-data').addEventListener('click', async () => {
            const confirmed = await showToolConfirm(
                'Delete Saved User Data',
                'This deletes your own BetterMetas entries from GitHub: user_metas.json and user_locations.json. Plonkit data stays untouched.',
                { confirmText: 'Continue', cancelText: 'Cancel', danger: true }
            );
            if (!confirmed) return;

            const reallyConfirmed = await showToolConfirm(
                'Delete Saved User Data?',
                'Your saved user metas and saved user location links will be lost.',
                { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
            );
            if (reallyConfirmed) await deleteSavedUserData();
        });

        document.getElementById('meta-close-btn').addEventListener('click', () => {
            hideMetaModal();
            hideBackdrop();
            hidePreviewPopup();
        });

        // Close when clicking backdrop
        document.getElementById('gg-link-selected-btn').addEventListener('click', () => {
            if (selectedMetaIds.size > 0) {
                linkMultipleMetas(Array.from(selectedMetaIds));
            }
        });

        backdrop.addEventListener('click', () => {
            const dialog = document.getElementById('gg-dialog-modal');
            if (dialog && window.getComputedStyle(dialog).display !== 'none') return;
            hideAllModals();
        });

        document.getElementById('meta-generate-btn').addEventListener('click', generateJSON);



        document.getElementById('gg-status').addEventListener('click', () => {
            syncPanoidForUserAction('manual refresh');
            updateStatus('Refreshing Data...');
            fetchLocationData();
        });

        // --- Existing Metas Browser ---
        document.getElementById('meta-search').addEventListener('input', (e) => {
            renderExistingMetas(e.target.value);
        });
    }

    /**
     * Maps country names to 2-letter ISO codes.
     * Handles normalizations and special Plonkit region cases.
     */
    function getCountryCode(countryName) {
        if (!countryName) return '??';
        const name = countryName.trim().toLowerCase();

        // Plonkit Region Mapping
        const mapping = {
            'alaska': 'US', 'albania': 'AL', 'american samoa': 'AS', 'andorra': 'AD', 'antarctica': 'AQ',
            'argentina': 'AR', 'australia': 'AU', 'austria': 'AT', 'azores': 'PT', 'bangladesh': 'BD',
            'belarus': 'BY', 'belgium': 'BE', 'bermuda': 'BM', 'bhutan': 'BT', 'bolivia': 'BO',
            'botswana': 'BW', 'brazil': 'BR', 'british indian ocean territory': 'IO', 'bulgaria': 'BG',
            'cambodia': 'KH', 'canada': 'CA', 'chile': 'CL', 'china': 'CN', 'christmas island': 'CX',
            'cocos islands': 'CC', 'colombia': 'CO', 'costa rica': 'CR', 'croatia': 'HR', 'curaçao': 'CW',
            'cyprus': 'CY', 'czechia': 'CZ', 'denmark': 'DK', 'dominican republic': 'DO', 'ecuador': 'EC',
            'egypt': 'EG', 'estonia': 'EE', 'eswatini': 'SZ', 'falkland islands': 'FK', 'faroe islands': 'FO',
            'finland': 'FI', 'france': 'FR', 'germany': 'DE', 'ghana': 'GH', 'gibraltar': 'GI',
            'greece': 'GR', 'greenland': 'GL', 'guam': 'GU', 'guatemala': 'GT', 'hawaii': 'US',
            'hong kong': 'HK', 'hungary': 'HU', 'iceland': 'IS', 'india': 'IN', 'indonesia': 'ID',
            'iraq': 'IQ', 'ireland': 'IE', 'isle of man': 'IM', 'israel & the west bank': 'IL', 'italy': 'IT',
            'japan': 'JP', 'jersey': 'JE', 'jordan': 'JO', 'kazakhstan': 'KZ', 'kenya': 'KE',
            'kyrgyzstan': 'KG', 'laos': 'LA', 'latvia': 'LV', 'lebanon': 'LB', 'lesotho': 'LS',
            'liechtenstein': 'LI', 'lithuania': 'LT', 'luxembourg': 'LU', 'macau': 'MO', 'madagascar': 'MG',
            'madeira': 'PT', 'malaysia': 'MY', 'mali': 'ML', 'malta': 'MT', 'martinique': 'MQ',
            'mexico': 'MX', 'monaco': 'MC', 'mongolia': 'MN', 'montenegro': 'ME', 'namibia': 'NA',
            'nepal': 'NP', 'netherlands': 'NL', 'new zealand': 'NZ', 'nigeria': 'NG', 'north macedonia': 'MK',
            'northern mariana islands': 'MP', 'norway': 'NO', 'oman': 'OM', 'pakistan': 'PK', 'panama': 'PA',
            'peru': 'PE', 'philippines': 'PH', 'pitcairn islands': 'PN', 'poland': 'PL', 'portugal': 'PT',
            'puerto rico': 'PR', 'qatar': 'QA', 'reunion': 'RE', 'romania': 'RO', 'russia': 'RU',
            'rwanda': 'RW', 'saint pierre and miquelon': 'PM', 'san marino': 'SM', 'senegal': 'SN',
            'serbia': 'RS', 'singapore': 'SG', 'slovakia': 'SK', 'slovenia': 'SI', 'south africa': 'ZA',
            'south georgia & sandwich islands': 'GS', 'south korea': 'KR', 'spain': 'ES', 'sri lanka': 'LK',
            'svalbard': 'SJ', 'sweden': 'SE', 'switzerland': 'CH', 'são tomé and príncipe': 'ST',
            'taiwan': 'TW', 'tanzania': 'TZ', 'thailand': 'TH', 'tunisia': 'TN', 'turkey': 'TR',
            'us minor outlying islands': 'UM', 'us virgin islands': 'VI', 'usa': 'US', 'uganda': 'UG', 'ukraine': 'UA',
            'uae': 'AE', 'united arab emirates': 'AE', 'uk': 'GB', 'united kingdom': 'GB', 'united states': 'US', 'united states of america': 'US',
            'uruguay': 'UY', 'vanuatu': 'VU', 'vietnam': 'VN'
        };

        const normalizedName = name.replace(/á/g, 'a').replace(/ó/g, 'o').replace(/é/g, 'e').replace(/ç/g, 'c');
        if (mapping[name]) return mapping[name];
        if (mapping[normalizedName]) return mapping[normalizedName];

        // Normalize São Tomé variants
        if (name.includes('sao tome') || name.includes('sdo tome')) return 'ST';

        // Fallback: Generate Initials (e.g. "Some Place" -> "SP")
        const words = name.split(' ');
        if (words.length > 1) {
            return (words[0][0] + words[1][0]).toUpperCase();
        }
        return name.substring(0, 2).toUpperCase();
    }

    function updateAdminSortButtons() {
        const sortSelect = document.getElementById('gg-admin-sort-options');
        if (!sortSelect) return;

        sortSelect.value = adminSortMode;
        const selectedOption = sortSelect.selectedOptions[0];
        if (!selectedOption) return;

        const context = document.createElement('canvas').getContext('2d');
        if (!context) return;

        const styles = getComputedStyle(sortSelect);
        context.font = `${styles.fontStyle} ${styles.fontVariant} ${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
        sortSelect.style.width = `${Math.ceil(context.measureText(selectedOption.text).width + 26)}px`;
    }

    function compareAdminText(a, b) {
        return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
    }

    function compareAdminCountry(metaA, metaB) {
        return compareAdminText(getCountryCode(metaA.country), getCountryCode(metaB.country))
            || compareAdminText(metaA.country, metaB.country)
            || compareAdminText(metaA.title, metaB.title);
    }

    function getAdminMetaCreatedSortValue(meta, originalIndex) {
        const addedAtTime = Date.parse(meta.addedAt || '');
        if (Number.isFinite(addedAtTime)) return addedAtTime;
        const timestampMatch = String(meta.id || '').match(/^meta_(\d{10,})_/);
        if (timestampMatch) return Number(timestampMatch[1]);
        return originalIndex;
    }

    function sortAdminMetaEntries(entries) {
        const scopeOrder = new Map(ALL_SCOPES.map((scope, index) => [scope, index]));
        return entries.sort((a, b) => {
            const metaA = a.meta;
            const metaB = b.meta;
            if (adminSortMode === 'scope') {
                const scopeA = scopeOrder.get(normalizeScope(metaA.scope)) ?? Number.MAX_SAFE_INTEGER;
                const scopeB = scopeOrder.get(normalizeScope(metaB.scope)) ?? Number.MAX_SAFE_INTEGER;
                return scopeA - scopeB
                    || compareAdminCountry(metaA, metaB);
            }

            if (adminSortMode === 'tags') {
                return compareAdminText((metaA.tags || []).join(', '), (metaB.tags || []).join(', '))
                    || compareAdminCountry(metaA, metaB);
            }

            if (adminSortMode === 'newest') {
                return getAdminMetaCreatedSortValue(metaB, b.index) - getAdminMetaCreatedSortValue(metaA, a.index)
                    || compareAdminCountry(metaA, metaB);
            }

            return compareAdminCountry(metaA, metaB);
        });
    }

    function getMetaSearchTerms(searchTerm) {
        return searchTerm.toLowerCase().split(/[;,]/).map(term => term.trim()).filter(Boolean);
    }

    function matchesMetaSearch(meta, terms, extraValues = []) {
        if (terms.length === 0) return true;
        const searchableContent = [
            ...extraValues,
            meta.country || '',
            meta.title || '',
            meta.description || '',
            (meta.tags || []).join(' ')
        ].join(' ').toLowerCase();
        return terms.every(term => searchableContent.includes(term));
    }

    function deduplicateMetasBySignature(metas, chooseMeta = group => group[0]) {
        const groups = new Map();
        metas.forEach(meta => {
            const tagsSignature = (meta.tags || []).slice().sort().join(',');
            const signature = `${meta.country}|${meta.title}|${meta.description}|${tagsSignature}`;
            if (!groups.has(signature)) groups.set(signature, []);
            groups.get(signature).push(meta);
        });
        return [...groups.values()].map(chooseMeta);
    }

    function renderMetaListItem(meta, options) {
        const title = options.titleFallback ? meta.title || meta.id : meta.title;
        return `
            <div class="gg-meta-list-item${options.itemClass || ''}" data-meta-id="${escapeHtml(meta.id)}">
                <div class="gg-meta-list-main">
                    <span class="gg-country-badge" title="${escapeHtml(meta.country || 'Unknown Country')}">${escapeHtml(getCountryCode(meta.country))}</span>
                    <div class="gg-meta-list-title">${escapeHtml(title)}</div>
                    <div class="gg-meta-list-tags">
                        ${options.showScope ? `<span class="gg-tag-static gg-scope-static">${escapeHtml(getScopeLabel(normalizeScope(meta.scope)))}</span>` : ''}
                        ${renderStaticTags(meta.tags)}
                    </div>
                </div>
                ${options.actionHtml}
            </div>
        `;
    }

    function attachMetaPreview(container, modalId, options = {}) {
        const previewPopup = document.getElementById('gg-meta-preview-popup');
        const modal = document.getElementById(modalId);

        container.querySelectorAll(options.itemSelector || '.gg-meta-list-item').forEach(item => {
            item.addEventListener('mouseenter', () => {
                const meta = metasData.find(candidate => candidate.id === item.dataset.metaId);
                if (!meta || !previewPopup || (options.requireModal && !modal)) return;

                delete previewPopup.dataset.ggPreviewCleanupId;
                previewPopup.dataset.ggPreviewMode = 'meta';
                previewPopup.classList.remove('gg-image-url-preview');
                previewPopup.innerHTML = `
                    <div class="gg-meta-item-title">${escapeHtml(options.titleFallback ? meta.title || meta.id : meta.title)}</div>
                    ${renderMetaImage(meta.imageUrl)}
                    <div class="gg-meta-description">${escapeHtml(options.descriptionFallback ? meta.description || '' : meta.description)}</div>
                    <div class="gg-meta-tags">
                        ${renderStaticTags(meta.tags)}
                    </div>
                `;

                if (!modal) return;
                const modalRect = modal.getBoundingClientRect();
                const itemRect = item.getBoundingClientRect();
                previewPopup.style.left = `${modalRect.left - 290}px`;
                previewPopup.classList.add('gg-visible');
                previewPopup.style.top = `${itemRect.top + (itemRect.height / 2) - (previewPopup.offsetHeight / 2)}px`;
            });
            item.addEventListener('mouseleave', hidePreviewPopup);
        });
    }

    function renderAdminMetas(searchTerm = '') {
        const container = document.getElementById('gg-admin-meta-list');
        if (!container) return;

        const terms = getMetaSearchTerms(searchTerm);

        const filtered = metasData.map((meta, index) => ({ meta, index })).filter(entry => {
            const meta = entry.meta;
            const source = getAdminMetaSourceLabel(getAdminMetaSource(meta.id));
            return matchesMetaSearch(meta, terms, [
                meta.id || '',
                source,
                meta.section || '',
                meta.note || '',
                meta.scope || '',
            ]);
        });

        const sorted = sortAdminMetaEntries(filtered);

        if (sorted.length === 0) {
            container.innerHTML = '<div class="gg-form-hint gg-list-empty-state">No metas found.</div>';
            return;
        }

        container.innerHTML = sorted.map(({ meta }) => renderMetaListItem(meta, {
            itemClass: ' gg-admin-meta-item',
            titleFallback: true,
            showScope: true,
            actionHtml: `<button class="gg-btn-link-meta gg-btn-admin-edit" data-meta-id="${escapeHtml(meta.id)}">Edit</button>`,
        })).join('');

        attachMetaPreview(container, 'gg-meta-admin-modal', { itemSelector: '.gg-admin-meta-item', requireModal: true, titleFallback: true, descriptionFallback: true });

        container.querySelectorAll('.gg-btn-admin-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openAdminMetaDetails(btn.dataset.metaId);
            });
        });
    }

    function showAdminMainView() {
        const mainView = document.getElementById('gg-admin-main-view');
        const detailsView = document.getElementById('gg-admin-details-view');
        const transferView = document.getElementById('gg-admin-transfer-view');
        if (mainView) mainView.classList.remove('gg-hidden');
        if (detailsView) detailsView.classList.add('gg-hidden');
        if (transferView) transferView.classList.add('gg-hidden');
        selectedAdminMetaId = null;
        selectedAdminTransferTargetId = null;
        hidePreviewPopup();
    }

    function showAdminDetailsView() {
        document.getElementById('gg-admin-main-view')?.classList.add('gg-hidden');
        document.getElementById('gg-admin-transfer-view')?.classList.add('gg-hidden');
        document.getElementById('gg-admin-details-view')?.classList.remove('gg-hidden');
        selectedAdminTransferTargetId = null;
        hidePreviewPopup();
    }

    function showAdminTransferView() {
        const selectedMeta = getSelectedAdminMeta();
        if (!selectedMeta) return;

        const searchInput = document.getElementById('gg-admin-transfer-search');
        if (searchInput) searchInput.value = '';
        selectedAdminTransferTargetId = null;
        document.getElementById('gg-admin-main-view')?.classList.add('gg-hidden');
        document.getElementById('gg-admin-details-view')?.classList.add('gg-hidden');
        document.getElementById('gg-admin-transfer-view')?.classList.remove('gg-hidden');
        renderAdminTransferMetas();
        hidePreviewPopup();
        requestAnimationFrame(() => searchInput?.focus());
    }

    function openAdminMetaDetails(metaId) {
        const meta = metasData.find(m => m.id === metaId);
        if (!meta) return;

        selectedAdminMetaId = metaId;
        const setValue = (id, value) => {
            const input = document.getElementById(id);
            if (input) input.value = value ?? '';
        };

        setValue('gg-admin-meta-image', meta.imageUrl || '');
        setValue('gg-admin-meta-title', meta.title || '');
        setValue('gg-admin-meta-desc', meta.description || '');
        setValue('gg-admin-meta-note', meta.note || '');
        setAdminScopeSelection(meta.scope);
        setAdminTagSelection(meta.tags);
        updateAdminImagePreview();
        renderAdminLinkedLocations(meta.id);

        selectedAdminTransferTargetId = null;

        document.getElementById('gg-admin-main-view')?.classList.add('gg-hidden');
        document.getElementById('gg-admin-transfer-view')?.classList.add('gg-hidden');
        document.getElementById('gg-admin-details-view')?.classList.remove('gg-hidden');
        hidePreviewPopup();
    }

    function renderAdminTransferMetas(searchTerm = '') {
        const container = document.getElementById('gg-admin-transfer-metas');
        if (!container) return;

        const sourceMeta = getSelectedAdminMeta();
        if (!sourceMeta) {
            container.innerHTML = '<div class="gg-form-hint gg-list-empty-state">No meta selected.</div>';
            return;
        }

        const terms = getMetaSearchTerms(searchTerm);
        const filtered = metasData.filter(meta => {
            if (!meta || meta.id === sourceMeta.id) return false;
            return matchesMetaSearch(meta, terms);
        });

        const uniqueFiltered = deduplicateMetasBySignature(filtered);

        if (uniqueFiltered.length === 0) {
            container.innerHTML = '<div class="gg-form-hint gg-list-empty-state">No metas found.</div>';
            return;
        }

        container.innerHTML = uniqueFiltered.map(meta => renderMetaListItem(meta, {
            titleFallback: true,
            actionHtml: `<button class="gg-btn-link-meta gg-btn-transfer-meta" data-meta-id="${escapeHtml(meta.id)}">Transfer</button>`,
        })).join('');

        attachMetaPreview(container, 'gg-meta-admin-modal', { requireModal: true, titleFallback: true, descriptionFallback: true });

        container.querySelectorAll('.gg-btn-transfer-meta').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                selectedAdminTransferTargetId = btn.dataset.metaId || null;
                hidePreviewPopup();
                deleteAdminMeta(selectedAdminTransferTargetId, btn);
            });
        });
    }

    function renderExistingMetas(searchTerm = '') {
        const container = document.getElementById('gg-existing-metas');
        if (!container) return;

        const panoid = currentPanoid || MISSING_PANOID_PLACEHOLDER;
        const linkedMetaIds = new Set(getLocationMetaIds(locationMap[panoid]));

        const terms = getMetaSearchTerms(searchTerm);

        const filtered = metasData.filter(meta => matchesMetaSearch(meta, terms));
        const uniqueFiltered = deduplicateMetasBySignature(filtered, group => {
            const linked = group.find(meta => linkedMetaIds.has(meta.id));
            const selected = group.find(meta => selectedMetaIds.has(meta.id));
            return linked || selected || group[0];
        });
        
        if (uniqueFiltered.length === 0) {
            container.innerHTML = '<div class="gg-form-hint gg-list-empty-state">No metas found.</div>';
            return;
        }

        container.innerHTML = uniqueFiltered.map(meta => {
            const isSelected = selectedMetaIds.has(meta.id);
            const isLinked = linkedMetaIds.has(meta.id);
            const actionHtml = isLinked
                        ? '<span class="gg-meta-linked-indicator" title="Already linked to this location">Linked</span>'
                        : `<button class="gg-btn-link-meta ${isSelected ? 'gg-tag-selected' : ''}" data-meta-id="${escapeHtml(meta.id)}">
                            ${isSelected ? 'Selected' : 'Link'}
                        </button>`;
            return renderMetaListItem(meta, { titleFallback: false, actionHtml });
        }).join('');

        attachMetaPreview(container, 'gg-meta-modal');

        // Add click handlers
        container.querySelectorAll('.gg-btn-link-meta').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const metaId = btn.dataset.metaId;
                if (selectedMetaIds.has(metaId)) {
                    selectedMetaIds.delete(metaId);
                } else {
                    selectedMetaIds.add(metaId);
                }
                updateLinkSelectedBtn();
                renderExistingMetas(searchTerm); // Re-render to update highlights
            });
        });
    }

    function updateLinkSelectedBtn() {
        const btn = document.getElementById('gg-link-selected-btn');
        if (!btn) return;

        const count = selectedMetaIds.size;
        btn.disabled = count === 0;
        btn.textContent = `Link Selected Metas (${count})`;
    }

    async function linkMultipleMetas(metaIds) {
        const panoid = syncPanoidForUserAction('link metas');
        if (!panoid || panoid === MISSING_PANOID_PLACEHOLDER) {
            await showToolAlert('No Location Detected', 'Please try on a game result screen.');
            return;
        }

        const token = localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY);
        if (!token) {
            // Mode: Community (No Token) - Submit via GitHub Issue
            const locationSnapshot = getCurrentLocationSnapshot();
            const submission = { 
                action: "link_metas",
                panoid: panoid, 
                metaIds: metaIds,
                targetFiles: {
                    userLocations: metaIds
                },
                ...locationSnapshot
            };
            const jsonStr = stringifyJsonContent(submission);
            const repo = `${REPO_OWNER}/${REPO_NAME}`;
            const issueTitle = encodeURIComponent(`[Meta Submission] ${panoid.substring(0,15)} (Multi-Link)`);
            const body = encodeURIComponent(`## Link Multiple Metas\n\n\`\`\`json\n${jsonStr}\n\`\`\`\n\n_(Automated submission via BetterMetas Script)_`);
            const issueUrl = `https://github.com/${repo}/issues/new?title=${issueTitle}&body=${body}`;
            window.open(issueUrl, '_blank');
            
            selectedMetaIds.clear();
            updateLinkSelectedBtn();
            renderExistingMetas(document.getElementById('meta-search')?.value || '');
            return;
        }

        // Mode: Admin (Token) - Direct API commit
        const linkBtn = document.getElementById('gg-link-selected-btn');
        const finishUi = beginMutationUi({
            scope: document.getElementById('gg-meta-modal'),
            button: linkBtn,
            busyText: 'Linking...',
            statusText: `Linking ${metaIds.length} metas...`
        });
        if (!finishUi) return;

        const snapshot = createLocalDataSnapshot();
        let linkedSuccessfully = false;
        
        try {
            const unknownMetaIds = metaIds.filter(id => !systemMetaIds.has(id) && !userMetaIds.has(id));

            if (unknownMetaIds.length > 0) {
                throw new Error(`Unknown meta IDs: ${unknownMetaIds.join(', ')}`);
            }

            applyLocalLocationLinks(panoid, metaIds);
            updateStatus('Linked. Syncing...');
            renderExistingMetas(document.getElementById('meta-search')?.value || '');

            await updateGitHubJsonFile(
                API_USER_LOCATIONS_URL,
                token,
                normalizeLocationMap,
                locations => {
                    addMetaIdsToLocationMap(locations, panoid, metaIds);
                    return locations;
                },
                `Link ${metaIds.length} metas to ${panoid} via BetterMetas`
            );

            updateStatus('Linked!');
            linkedSuccessfully = true;
            scheduleBackgroundDataRefresh();
        } catch (e) {
            console.error(e);
            restoreLocalDataSnapshot(snapshot);
            await showToolAlert('Link Failed', e.message);
            updateStatus('Link Failed');
        } finally {
            finishUi();
            if (linkedSuccessfully) {
                selectedMetaIds.clear();
                updateLinkSelectedBtn();
                renderExistingMetas(document.getElementById('meta-search')?.value || '');
            }
        }
    }

    async function unlinkMultipleMetas(metaIds) {
        const panoid = syncPanoidForUserAction('unlink metas');
        if (!panoid || panoid === MISSING_PANOID_PLACEHOLDER) {
            await showToolAlert('No Location Detected', 'Please try on a game result screen.');
            return;
        }

        const linkedUserMetaIds = new Set(getLocationMetaIds(userLocationMap[panoid]));
        const removableMetaIds = metaIds.filter(id => linkedUserMetaIds.has(id));
        if (removableMetaIds.length === 0) {
            await showToolAlert('Cannot Remove Meta', 'This meta is not linked through your BetterMetas data and cannot be removed here.');
            return;
        }

        const token = localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY);
        if (!token) {
            const locationSnapshot = getCurrentLocationSnapshot();
            const submission = {
                action: "unlink_metas",
                panoid: panoid,
                metaIds: removableMetaIds,
                targetFiles: {
                    userLocations: removableMetaIds
                },
                ...locationSnapshot
            };
            const jsonStr = stringifyJsonContent(submission);
            const repo = `${REPO_OWNER}/${REPO_NAME}`;
            const issueTitle = encodeURIComponent(`[Meta Submission] ${panoid.substring(0,15)} (Unlink)`);
            const body = encodeURIComponent(`## Unlink Metas\n\n\`\`\`json\n${jsonStr}\n\`\`\`\n\n_(Automated submission via BetterMetas Script)_`);
            const issueUrl = `https://github.com/${repo}/issues/new?title=${issueTitle}&body=${body}`;
            window.open(issueUrl, '_blank');
            return;
        }

        const finishUi = beginMutationUi({
            scope: document.getElementById('gg-meta-hud'),
            busyText: 'Removing...',
            statusText: `Removing ${removableMetaIds.length} meta${removableMetaIds.length === 1 ? '' : 's'}...`
        });
        if (!finishUi) return;

        const snapshot = createLocalDataSnapshot();

        try {
            applyLocalLocationUnlinks(panoid, removableMetaIds);
            updateStatus('Removed. Syncing...');

            await updateGitHubJsonFile(
                API_USER_LOCATIONS_URL,
                token,
                normalizeLocationMap,
                locations => {
                    removeMetaIdsFromLocationMap(locations, panoid, removableMetaIds);
                    return locations;
                },
                `Unlink ${removableMetaIds.length} metas from ${panoid} via BetterMetas`
            );

            updateStatus('Removed!');
            scheduleBackgroundDataRefresh();
        } catch (e) {
            console.error(e);
            restoreLocalDataSnapshot(snapshot);
            await showToolAlert('Remove Failed', e.message);
            updateStatus('Remove Failed');
        } finally {
            finishUi();
        }
    }

    async function generateJSON() {
        const title = document.getElementById('meta-title').value;
        const desc = document.getElementById('meta-desc').value;
        const tagsStr = document.getElementById('meta-tags').value;
        const tags = normalizeTags(tagsStr);
        const imageUrl = getSafeImageUrl(document.getElementById('meta-image').value) || null;
        const scope = normalizeScope(document.getElementById('meta-scope').value);
        
        if (!title || !desc) {
            await showToolAlert('Missing Details', 'Please fill in Title and Description.');
            return;
        }

        const panoid = syncPanoidForUserAction('save meta') || MISSING_PANOID_PLACEHOLDER;
        if (panoid === MISSING_PANOID_PLACEHOLDER) {
            await showToolAlert('No Location Detected', 'Please try again on a game result screen.');
            return;
        }

        // Generate unique meta ID
        const metaId = `meta_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const locationSnapshot = getCurrentLocationSnapshot();

        const newMeta = {
            id: metaId,
            ...locationSnapshot,
            country: locationSnapshot.country || "Unknown",
            section: "User Submitted",
            title: title,
            description: desc,
            note: "",
            imageUrl: imageUrl,
            scope: scope,
            tags: tags,
            addedAt: new Date().toISOString().slice(0, 10)
        };

        // For Issue submission, we send both the meta and the panoid to link
        const submission = {
            action: "add_meta",
            panoid: panoid,
            meta: newMeta
        };

        const btn = document.getElementById('meta-generate-btn');
        const output = document.getElementById('gg-json-output');
        
        // Save to GitHub
        const token = localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY);
        
        // Mode: Community (No Token)
        if (!token) {
            const jsonStr = stringifyJsonContent(submission);
            
            // Create Issue URL
            const repo = `${REPO_OWNER}/${REPO_NAME}`;
            const issueTitle = encodeURIComponent(`[Meta Submission] ${panoid.substring(0,15)}`);
            const body = encodeURIComponent(
                `## New Meta Submission\n\n` +
                `**Location:** ${panoid}\n\n` +
                `\`\`\`json\n${jsonStr}\n\`\`\`\n\n` +
                `_(Automated submission via BetterMetas Script)_`
            );
            
            const issueUrl = `https://github.com/${repo}/issues/new?title=${issueTitle}&body=${body}`;
            
            const submitIssue = await showToolConfirm(
                'Submit Community Contribution?',
                'No GitHub token was found. Submit this meta as a community contribution via GitHub Issues?',
                { confirmText: 'Submit', cancelText: 'Show JSON' }
            );

            if (submitIssue) {
                window.open(issueUrl, '_blank');
            } else {
                 // Fallback to copy-paste
                output.textContent = "Token missing. Copy this:\n" + jsonStr;
                output.style.display = 'block';
            }
            return;
        }

        // Mode: Admin (Token)
        const finishUi = beginMutationUi({
            scope: document.getElementById('gg-meta-modal'),
            button: btn,
            busyText: 'Saving...',
            statusText: 'Saving meta...'
        });
        if (!finishUi) return;

        output.style.display = 'none';
        const snapshot = createLocalDataSnapshot();

        try {
            applyLocalSavedMeta(newMeta, panoid);
            updateStatus('Saved. Syncing...');
            hideMetaModal();
            hideBackdrop();

            updateStatus('Saving user_metas.json...');
            await updateGitHubJsonFile(
                API_USER_METAS_URL,
                token,
                normalizeMetaList,
                metas => {
                    if (!metas.some(meta => meta.id === newMeta.id)) {
                        metas.push(newMeta);
                    }
                    return metas;
                },
                `Add meta ${newMeta.id} via BetterMetas`
            );

            updateStatus('Saving user_locations.json...');
            await updateGitHubJsonFile(
                API_USER_LOCATIONS_URL,
                token,
                normalizeLocationMap,
                locations => {
                    addMetaIdsToLocationMap(locations, panoid, [newMeta.id]);
                    return locations;
                },
                `Link ${panoid} to ${newMeta.id} via BetterMetas`
            );

            updateStatus('Saved!');
            scheduleBackgroundDataRefresh();
            setTimeout(() => finishUi({ buttonText: META_SAVE_BUTTON_LABEL }), SAVE_COMPLETE_RESET_MS);

        } catch (err) {
            console.error('Save error:', err);
            restoreLocalDataSnapshot(snapshot);
            showMetaModal();
            output.textContent = `Error saving to GitHub:\n${err.message}\n\nBackup JSON:\n${stringifyJsonContent(submission)}`;
            output.style.display = 'block';
            await showToolAlert('Save Failed', err.message);
            finishUi();
        }
    }

    async function refreshAfterAdminMutation({ optimisticMeta = null } = {}) {
        clearStoredValue(DATA_CACHE_STORAGE_KEY);
        if (optimisticMeta) applyAdminMetaLocally(optimisticMeta);
        await fetchLocationData();
        if (optimisticMeta) applyAdminMetaLocally(optimisticMeta);
        renderAdminMetas(document.getElementById('gg-admin-search')?.value || '');
        if (currentPanoid) refreshDisplay();
    }

    async function saveAdminMeta() {
        const token = localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY);
        if (!token) {
            await showToolAlert('No Token Saved', 'Cannot edit metas without a saved GitHub token.');
            updateAdminButtonVisibility();
            return;
        }

        const existingMeta = getSelectedAdminMeta();
        if (!existingMeta) {
            await showToolAlert('No Meta Selected', 'Select a meta first.');
            return;
        }

        const updatedMeta = getAdminMetaFromForm(existingMeta);
        if (!updatedMeta.title || !updatedMeta.description) {
            await showToolAlert('Missing Details', 'Please fill in Title and Description.');
            return;
        }

        const source = getAdminMetaSource(existingMeta.id);
        const saveBtn = document.getElementById('gg-admin-save-btn');
        const finishUi = beginMutationUi({
            scope: document.getElementById('gg-meta-admin-modal'),
            button: saveBtn,
            busyText: 'Saving...',
            statusText: `Saving meta ${existingMeta.id}...`
        });
        if (!finishUi) return;

        const snapshot = createLocalDataSnapshot();

        try {
            const savedMetaId = existingMeta.id;
            applyAdminMetaLocally(updatedMeta);
            renderAdminMetas(document.getElementById('gg-admin-search')?.value || '');
            openAdminMetaDetails(savedMetaId);
            if (currentPanoid) refreshDisplay();
            updateStatus('Meta saved. Syncing...');

            if (source === 'user' || source === 'both') {
                await updateGitHubJsonFileIfChanged(
                    API_USER_METAS_URL,
                    token,
                    normalizeMetaList,
                    metas => {
                        let found = false;
                        const updatedMetas = metas.map(meta => {
                            if (meta.id !== existingMeta.id) return meta;
                            found = true;
                            return updatedMeta;
                        });
                        if (!found) throw new Error(`Meta not found in ${USER_METAS_FILE}: ${existingMeta.id}`);
                        return updatedMetas;
                    },
                    `Edit meta ${existingMeta.id} via BetterMetas`
                );
            }

            if (source === 'system' || source === 'both') {
                await updateGitHubJsonFileIfChanged(
                    API_SYSTEM_METAS_URL,
                    token,
                    normalizeSystemMetaTree,
                    tree => updateMetaInSystemTree(tree, existingMeta.id, () => updatedMeta),
                    `Edit Plonkit meta ${existingMeta.id} via BetterMetas`
                );
            }

            if (source === 'unknown') {
                throw new Error(`Unknown meta source for ${existingMeta.id}`);
            }

            updateStatus('Meta saved!');
            refreshAfterAdminMutation({ optimisticMeta: updatedMeta }).catch(err => {
                console.warn('[BetterMetas] Admin data refresh after save failed:', err);
            });
            setTimeout(() => {
                finishUi({ buttonText: 'Save Meta' });
            }, SAVE_COMPLETE_RESET_MS);
        } catch (err) {
            console.error(err);
            restoreLocalDataSnapshot(snapshot);
            await showToolAlert('Save Failed', err.message || String(err));
            updateStatus('Save Failed');
            finishUi();
        }
    }

    async function deleteAdminMeta(transferTargetId = null, actionButton = null) {
        if (transferTargetId && typeof transferTargetId !== 'string') {
            transferTargetId = null;
        }

        const token = localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY);
        if (!token) {
            await showToolAlert('No Token Saved', 'Cannot delete metas without a saved GitHub token.');
            updateAdminButtonVisibility();
            return;
        }

        const existingMeta = getSelectedAdminMeta();
        if (!existingMeta) {
            await showToolAlert('No Meta Selected', 'Select a meta first.');
            return;
        }

        const normalizedTransferTargetId = (transferTargetId || selectedAdminTransferTargetId || '').trim();
        const transferTarget = normalizedTransferTargetId ? metasData.find(meta => meta.id === normalizedTransferTargetId) : null;
        if (normalizedTransferTargetId && !transferTarget) {
            await showToolAlert('Unknown Transfer Target', `No meta found with ID ${normalizedTransferTargetId}.`);
            return;
        }
        if (normalizedTransferTargetId === existingMeta.id) {
            await showToolAlert('Invalid Transfer Target', 'Transfer target must be a different meta.');
            return;
        }

        const counts = getAdminMetaLocationCounts(existingMeta.id);
        const actionLabel = normalizedTransferTargetId
            ? `delete "${existingMeta.title || existingMeta.id}" and transfer ${counts.total} locations to "${transferTarget.title || transferTarget.id}"?`
            : `delete "${existingMeta.title || existingMeta.id}" and remove it from ${counts.total} locations?`;
        const confirmed = await showToolConfirm(
            'Delete Meta',
            `This will ${actionLabel}`,
            { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
        );
        if (!confirmed) return;

        const source = getAdminMetaSource(existingMeta.id);
        const actionBtn = actionButton || document.getElementById('gg-admin-delete-btn');
        const finishUi = beginMutationUi({
            scope: document.getElementById('gg-meta-admin-modal'),
            button: actionBtn,
            busyText: normalizedTransferTargetId ? 'Transferring...' : 'Deleting...',
            statusText: normalizedTransferTargetId
                ? `Transferring ${existingMeta.id}...`
                : `Deleting meta ${existingMeta.id}...`
        });
        if (!finishUi) return;

        const snapshot = createLocalDataSnapshot();

        try {
            const deletedMetaId = existingMeta.id;
            applyAdminDeleteLocally(deletedMetaId, normalizedTransferTargetId);
            showAdminMainView();
            renderAdminMetas(document.getElementById('gg-admin-search')?.value || '');
            updateStatus(normalizedTransferTargetId ? 'Transferred. Syncing...' : 'Deleted. Syncing...');

            const updateLocations = normalizedTransferTargetId
                ? locations => {
                    replaceMetaIdInLocationEntries(locations, deletedMetaId, normalizedTransferTargetId);
                    return locations;
                }
                : locations => {
                    removeMetaIdFromLocationEntries(locations, deletedMetaId);
                    return locations;
                };

            await updateGitHubJsonFileIfChanged(
                API_USER_LOCATIONS_URL,
                token,
                normalizeLocationMap,
                updateLocations,
                `${normalizedTransferTargetId ? 'Transfer' : 'Remove'} user locations for ${deletedMetaId} via BetterMetas`
            );
            await updateGitHubJsonFileIfChanged(
                API_SYSTEM_LOCATIONS_URL,
                token,
                normalizeLocationMap,
                updateLocations,
                `${normalizedTransferTargetId ? 'Transfer' : 'Remove'} Plonkit locations for ${deletedMetaId} via BetterMetas`
            );

            if (source === 'user' || source === 'both') {
                await updateGitHubJsonFile(
                    API_USER_METAS_URL,
                    token,
                    normalizeMetaList,
                    metas => {
                        const updatedMetas = metas.filter(meta => meta.id !== deletedMetaId);
                        if (updatedMetas.length === metas.length) {
                            throw new Error(`Meta not found in ${USER_METAS_FILE}: ${deletedMetaId}`);
                        }
                        return updatedMetas;
                    },
                    `Delete meta ${deletedMetaId} via BetterMetas`
                );
            }

            if (source === 'system' || source === 'both') {
                await updateGitHubJsonFile(
                    API_SYSTEM_METAS_URL,
                    token,
                    normalizeSystemMetaTree,
                    tree => removeMetaFromSystemTree(tree, deletedMetaId),
                    `Delete Plonkit meta ${deletedMetaId} via BetterMetas`
                );
            }

            if (source === 'unknown') {
                throw new Error(`Unknown meta source for ${deletedMetaId}`);
            }

            refreshAfterAdminMutation().catch(err => {
                console.warn('[BetterMetas] Admin data refresh after delete failed:', err);
            });
            updateStatus(normalizedTransferTargetId ? 'Transfer complete!' : 'Meta deleted!');
        } catch (err) {
            console.error(err);
            restoreLocalDataSnapshot(snapshot);
            await showToolAlert('Delete Failed', err.message || String(err));
            updateStatus('Delete Failed');
        } finally {
            finishUi();
        }
    }

    async function deleteSavedUserData() {
        const token = getSettingsTokenValue();
        if (!token) {
            await showToolAlert('No Token Saved', 'Cannot delete saved user data without a saved GitHub token.');
            return;
        }

        updateStatus('Deleting saved user data...');
        const btn = document.getElementById('gg-delete-user-data');
        const origText = btn.innerText;
        btn.innerText = "Deleting Saved User Data...";
        btn.disabled = true;

        try {
            await updateGitHubJsonFile(
                API_USER_METAS_URL,
                token,
                normalizeMetaList,
                () => [],
                "Delete saved BetterMetas user metas"
            );
            await updateGitHubJsonFile(
                API_USER_LOCATIONS_URL,
                token,
                normalizeLocationMap,
                () => ({}),
                "Delete saved BetterMetas user location links"
            );

            await showToolAlert('User Data Deleted', 'Saved user metas and saved user location links deleted.');
            location.reload();

        } catch (e) {
            console.error(e);
            await showToolAlert('Clear Failed', e.message);
            updateStatus('Clear Failed');
        } finally {
            btn.innerText = origText;
            btn.disabled = false;
        }
    }

    function updateHUD(metas, predicted = []) {
        const container = document.getElementById('gg-meta-container');

        if ((!metas || metas.length === 0) && (!predicted || predicted.length === 0)) {
            container.innerHTML = '<div class="gg-muted-empty-state">No active hints for this location.</div>';
            return;
        }

        const canEditMetas = hasSavedGitHubToken();
        const renderMeta = (m, isPredicted = false) => {
             const userLinkedMetaIds = new Set(getLocationMetaIds(userLocationMap[currentPanoid]));
             const isUserLinked = userLinkedMetaIds.has(m.id);
             const titleAction = isPredicted ? 'link' : (isUserLinked ? 'unlink' : '');
             const titleText = m.title || m.id;
             const titleTooltip = canEditMetas
                 ? 'Click for Meta Actions'
                 : (titleAction === 'link' ? 'Click to Link to this Location' : 'Click to Remove from this Location');
             const titleAttr = (titleAction || canEditMetas)
                 ? `class="gg-clickable-meta-title" data-meta-id="${escapeHtml(m.id)}" data-meta-title="${escapeHtml(titleText)}" data-action="${escapeHtml(titleAction)}" title="${escapeHtml(titleTooltip)}"`
                 : '';
             
             // Badge logic
             let badge = '';
            if (isPredicted) {
                // Predicted badge - Styled EXACTLY like Linked but Grey
                 badge = '<span class="gg-meta-badge gg-meta-badge-predicted">PREDICTED</span>';
             } else {
                 // Linked badge - Styled with Green to match theme
                 badge = '<span class="gg-meta-badge gg-meta-badge-linked">LINKED</span>';
             }

             return `
            <div class="gg-meta-row ${isPredicted ? 'gg-meta-row-predicted' : ''}">
                <div class="gg-meta-item-title">
                    <span ${titleAttr}>${escapeHtml(titleText)}</span>
                    ${badge}
                </div>
                ${renderMetaImage(m.imageUrl)}
                <div class="gg-meta-description">${escapeHtml(m.description)}</div>
                <div class="gg-meta-tags">${renderStaticTags(m.tags)}</div>
            </div>
            `;
        };

        const exactHtml = (metas || []).map(m => renderMeta(m, false)).join('');
        const predictedHtml = (predicted || []).map(m => renderMeta(m, true)).join('');

        container.innerHTML = exactHtml + predictedHtml;

        container.querySelectorAll('.gg-clickable-meta-title').forEach(titleEl => {
            titleEl.addEventListener('click', () => {
                win.handleMetaTitleClick(titleEl.dataset.metaId, titleEl.dataset.metaTitle || '', titleEl.dataset.action || '');
            });
        });
    }


    function openMetaEditorFromTitle(metaId) {
        if (!hasSavedGitHubToken()) {
            updateAdminButtonVisibility();
            return showToolAlert('No Token Saved', 'Save a GitHub Personal Access Token in Settings to edit metas.');
        }

        const meta = metasData.find(m => m.id === metaId);
        if (!meta) {
            return showToolAlert('Meta Not Found', 'This meta could not be found in the loaded BetterMetas data.');
        }

        hidePreviewPopup();
        showAdminModal();
        openAdminMetaDetails(metaId);
        requestAnimationFrame(() => document.getElementById('gg-admin-meta-title')?.focus());
        return Promise.resolve();
    }

    win.handleMetaTitleClick = async function(metaId, title, action = '') {
        if (!hasSavedGitHubToken()) {
            if (action) await win.quickToggleMeta(metaId, title, action);
            return;
        }

        const selectedAction = await showMetaTitleActionDialog({
            title,
            action,
            canEdit: true
        });

        if (selectedAction === 'edit') {
            await openMetaEditorFromTitle(metaId);
            return;
        }

        if (selectedAction === 'unlink') {
            unlinkMultipleMetas([metaId]);
            return;
        }

        if (selectedAction === 'link') {
            linkMultipleMetas([metaId]);
        }
    };


    win.quickToggleMeta = async function(metaId, title, action = 'link') {
        if (action === 'unlink') {
            const confirmed = await showToolConfirm(
                'Remove Meta',
                `Remove "${title}" from this location?`,
                { confirmText: 'Remove', cancelText: 'Cancel', danger: true }
            );
            if (confirmed) {
                unlinkMultipleMetas([metaId]);
            }
            return;
        }

        const confirmed = await showToolConfirm(
            'Link Meta',
            `Link "${title}" to this location?`,
            { confirmText: 'Link', cancelText: 'Cancel' }
        );
        if (confirmed) {
            linkMultipleMetas([metaId]);
        }
    };

    function refreshDisplay() {
        if (!currentPanoid) return;

        // Ensure metasData is loaded
        if (!metasData || metasData.length === 0) {
            console.log('[BetterMetas] metasData not loaded yet, skipping display refresh');
            return;
        }

        console.log(`[BetterMetas] refreshDisplay for ID: "${currentPanoid}"`);

        // Check for exact match in locationMap (might be empty if no pins yet)
        const entry = locationMap[currentPanoid];
        const metaIds = getLocationMetaIds(entry);

        // Helper to check scope
        const isScopeActive = (m) => {
            return activeScopes.has(normalizeScope(m.scope));
        };

        // Get exact metas - BYPASS SCOPE FILTER
        const exactMetas = metaIds.map(id => {
            const found = metasData.find(m => m.id === id);
            if (!found) console.warn('[BetterMetas] Could not find exact meta data for ID:', id);
            return found;
        }).filter(Boolean); // Removed .filter(isScopeActive) to always show linked metas

        // Get predicted/nearby metas
        const predictedMetas = evaluateProximityMetas()
            .filter(pm => !metaIds.includes(pm.id))
            .filter(isScopeActive);
        
        console.log(`[BetterMetas] Found ${exactMetas.length} exact and ${predictedMetas.length} predicted metas (Filtered).`);

        if (exactMetas.length > 0 || predictedMetas.length > 0) {
            updateHUD(exactMetas, predictedMetas);
        } else {
            updateHUD(null);
        }
    }

    function updateStatus(msg) {
        const el = document.getElementById('gg-status');
        if (el) el.textContent = msg;
    }

    function showDebug(msg) {
        console.log('[GG Meta]', msg);
    }

    function isValidPanoid(panoid) {
        return !!(panoid && typeof panoid === 'string' && panoid.length > 5);
    }

    function getStreetViewPanoid() {
        try {
            if (svInstance && typeof svInstance.getPano === 'function') {
                const panoid = svInstance.getPano();
                if (isValidPanoid(panoid)) return panoid;
            }
        } catch (err) {
            console.warn('[BetterMetas] Could not read active StreetView panoid:', err);
        }

        return null;
    }

    function readPanoidFromStreetView(instance, reason = 'streetview sync') {
        try {
            if (!instance || typeof instance.getPano !== 'function') return null;
            const panoid = instance.getPano();
            if (!isValidPanoid(panoid)) return null;
            svInstance = instance;
            console.log(`[BetterMetas] StreetView panoid from ${reason}:`, panoid);
            checkLocation(panoid);
            return panoid;
        } catch (err) {
            console.warn(`[BetterMetas] Could not sync StreetView panoid from ${reason}:`, err);
            return null;
        }
    }

    function registerStreetViewInstance(instance, reason = 'StreetView instance') {
        if (!instance) return;

        svInstance = instance;

        if (!hookedStreetViewInstances.has(instance)) {
            hookedStreetViewInstances.add(instance);

            if (win.google && win.google.maps && win.google.maps.event) {
                win.google.maps.event.addListener(instance, 'pano_changed', () => {
                    readPanoidFromStreetView(instance, 'pano_changed');
                });

                win.google.maps.event.addListener(instance, 'status_changed', () => {
                    svInstance = instance;
                    extractLocationData();
                    setTimeout(() => readPanoidFromStreetView(instance, 'status_changed'), 0);
                });
            }
        }

        readPanoidFromStreetView(instance, reason);
        setTimeout(() => readPanoidFromStreetView(instance, `${reason} delayed`), 100);
        setTimeout(() => readPanoidFromStreetView(instance, `${reason} settled`), STREETVIEW_RETRY_DELAY_MS);
    }

    function syncPanoidForUserAction(reason = 'user action') {
        const visiblePanoid = getStreetViewPanoid();
        const queuedPanoid = isValidPanoid(nextPanoid) ? nextPanoid : null;
        const activePanoid = visiblePanoid || queuedPanoid || currentPanoid;

        if (!isValidPanoid(activePanoid)) return null;

        if (visiblePanoid && queuedPanoid && visiblePanoid !== queuedPanoid) {
            console.log(`[BetterMetas] Ignoring queued panoid for ${reason}; visible panoid wins: ${visiblePanoid} (queued ${queuedPanoid})`);
        }

        if (activePanoid !== currentPanoid) {
            console.log(`[BetterMetas] Syncing active panoid for ${reason}: ${activePanoid} (was ${currentPanoid || 'none'})`);
            currentPanoid = activePanoid;
            nextPanoid = null;
            updateStatus(`ID: ${currentPanoid.substring(0,12)}...`);
            extractLocationData();
            refreshDisplay();
        }

        return currentPanoid;
    }

    async function tryRecoverPanoid() {
        return syncPanoidForUserAction('panoid recovery');
    }

    // --- Logic ---
    function getHaversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function getDistanceForScope(scope) {
        const s = normalizeScope(scope);
        if (s === '1km') return 1;
        if (s === '10km') return 10;
        if (s === '100km') return 100;
        if (s === '1000km') return 1000;
        
        // Named scopes should match by NAME, not generic radius
        if (s === 'region') return 0;  
        if (s === 'city') return 0;    
        if (s === 'road') return 0; // Strict Name Match Only (User request: no radius for road/region)
        if (s === 'unique') return 0; // 0m tolerance
        
        if (s === 'countrywide') return 0; // Strict Country Check Only
        return 0;
    }

    const COUNTRY_ALIAS_MAP = {
        "france": (lat, lng) => {
            // Reunion Check
            if (lat < -19 && lat > -22 && lng > 54 && lng < 57) return "Reunion";
            return "France";
        },
        "china": (lat, lng) => {
            // Hong Kong / Macau Check
            if (lat > 22 && lat < 23 && lng > 113.8 && lng < 114.5) return "Hong Kong";
            if (lat > 22 && lat < 22.3 && lng > 113.5 && lng < 113.6) return "Macau";
            return "China";
        },
        "usa": "United States of America",
        "united states": "United States of America",
        "united states of america": "United States of America",
        "uk": "United Kingdom",
        "united kingdom": "United Kingdom",
        "uae": "United Arab Emirates",
        "united arab emirates": "United Arab Emirates",
        "virgin islands, u.s.": "US Virgin Islands",
        "u.s. virgin islands": "US Virgin Islands",
        "us virgin islands": "US Virgin Islands"
    };

    function normalizeCountry(name, lat, lng) {
        if (!name) return "Unknown";
        let target = name;
        const aliasKey = String(name).trim().toLowerCase();
        if (COUNTRY_ALIAS_MAP[aliasKey]) {
            const mapping = COUNTRY_ALIAS_MAP[aliasKey];
            if (typeof mapping === 'function') {
                target = mapping(parseFloat(lat), parseFloat(lng));
            } else {
                target = mapping;
            }
        }
        return target;
    }

    /**
     * Fuzzy matching for location names.
     * Ensures substrings align with word boundaries to avoid partial false positives
     * (e.g. "C19" vs "AC190"). Ignores generic terms like "Road" or "Region".
     */
    function isFuzzyNameMatch(a, b) {
        if (!a || !b) return false;
        a = String(a).toLowerCase().trim();
        b = String(b).toLowerCase().trim();
        
        // 1. Exact Match
        if (a === b) return true;

        // 2. Token Matching (Word Boundaries)
        const tokensA = a.split(/[\s,\.\-]+/);
        const tokensB = b.split(/[\s,\.\-]+/);
        
        const generics = ['region', 'province', 'district', 'county', 'state', 'prefecture', 'road', 'street', 'avenue', 'boulevard', 'way', 'dr', 'drive', 'ln', 'lane', 'hwy', 'highway', 'str', 'route'];
        
        const shortTokens = tokensA.length < tokensB.length ? tokensA : tokensB;
        const longTokens = tokensA.length < tokensB.length ? tokensB : tokensA;

        // Check if ALL tokens of the short string exist as EXACT tokens in the long string
        const allShortTokensMatch = shortTokens.every(st => {
            if (generics.includes(st)) return true; // Generics are ignored
            return longTokens.includes(st);
        });

        // Ensure at least one NON-GENERIC token matched
        const hasNonGenericMatch = shortTokens.some(st => !generics.includes(st) && longTokens.includes(st));

        return allShortTokensMatch && hasNonGenericMatch;
    }

    /**
     * Finds relevant metas for current location based on active scopes.
     * Checks both exact distance matches and fuzzy name matches (Region/Road).
     */
    function evaluateProximityMetas() {
        const curLat = normalizeCoordinate(currentLocationData.lat);
        const curLng = normalizeCoordinate(currentLocationData.lng);
        const curCountry = normalizeCountry(currentLocationData.country, curLat, curLng);
        const curNomCountry = normalizeCountry(currentLocationData.nominatimCountry, curLat, curLng);
        const curRegion = currentLocationData.region;
        const curCity = currentLocationData.city;
        
        const curRoads = getNormalizedRoadNames(currentLocationData.road);

        if (isNaN(curLat) || isNaN(curLng)) return [];

        const matchedMetaIds = new Set();
        const matches = [];

        // Helper: Check meta match against location
        const checkMatch = (scope, entryLat, entryLng, entryCountry, entryRegion, entryCity, entryRoads) => {
             scope = normalizeScope(scope);
             
             // 1. Distance Match
             const distLimit = getDistanceForScope(scope);
             if (distLimit > 0) {
                 if (entryLat !== null && entryLng !== null) {
                     const d = getHaversineDistance(curLat, curLng, entryLat, entryLng);
                     if (d <= distLimit) return true;
                 }
                 return false; 
             }

             // 2. Name Match (Region/City/Road)
             // Requires Country match to avoid ambiguity (except Countrywide)
             
             const countryMatch = (entryCountry === curCountry || entryCountry === curNomCountry);
             if (!countryMatch) return false;

             if (scope === 'countrywide') return true;
             
             if (scope === 'region') {
                 return isFuzzyNameMatch(entryRegion, curRegion);
             }
             
             if (scope === 'city') {
                 return isFuzzyNameMatch(entryCity, curCity);
             }
             
             if (scope === 'road') {
                 // Check if ANY entry road matches ANY current road
                 if (!entryRoads || entryRoads.length === 0) return false;
                 if (curRoads.length === 0) return false;
                 
                 return curRoads.some(cr => entryRoads.some(er => isFuzzyNameMatch(cr, er)));
             }

             return false;
        };

        // Phase 1: Check linked locations from plonkit_locations.json and user_locations.json
        // locationMap maps Panoid -> Data
        for (const panoId in locationMap) {
            const entry = locationMap[panoId];
            const metaIds = getLocationMetaIds(entry);
            
            // Normalize Entry Data
            const eLat = normalizeCoordinate(entry.lat);
            const eLng = normalizeCoordinate(entry.lng);
            const eCountry = normalizeCountry(entry.country, eLat, eLng); 
            // entry.nominatimCountry might exist
            const finalECountry = normalizeCountry(entry.nominatimCountry || eCountry, eLat, eLng);
            
            const eRegion = entry.region;
            const eCity = entry.city; // New field, might be undefined in old entries
            
            const eRoads = getNormalizedRoadNames(entry.road);

            metaIds.forEach(id => {
                 if (matchedMetaIds.has(id)) return; // Already matched
                 
                 const meta = metasData.find(m => m.id === id);
                 if (!meta) return;

                 if (checkMatch(meta.scope, eLat, eLng, finalECountry, eRegion, eCity, eRoads)) {
                     matchedMetaIds.add(id);
                     matches.push(meta);
                 }
            });
        }

        // Phase 2: Check Static Meta Locations (e.g. Plonkit data or Metas with defined coordinates)
        metasData.forEach(meta => {
             if (matchedMetaIds.has(meta.id)) return;

             // Meta Static Data
             const mLat = normalizeCoordinate(meta.lat);
             const mLng = normalizeCoordinate(meta.lng);
             const mCountry = normalizeCountry(meta.country, mLat, mLng);
             const mRegion = meta.region;
             const mCity = meta.city;
             const mRoads = getNormalizedRoadNames(meta.road);

             if (checkMatch(meta.scope, mLat, mLng, mCountry, mRegion, mCity, mRoads)) {
                 matchedMetaIds.add(meta.id);
                 matches.push(meta);
             }
        });

        return matches;
    }

    function isRanked() {
        const url = window.location.href;
        return url.includes('/duels') ||
               url.includes('/battle-royale') ||
               url.includes('/team-duels') ||
               url.includes('/competitive');
               // url.includes('/challenge'); // Removed to allow HUD in challenges
    }

    function isRoundResult() {
        // Check for common result screen elements
        const selector = 'div[class*="result-layout_root__"], div[class*="round-result_root__"]';
        const el = document.querySelector(selector);
        const visible = !!(el && el.offsetParent);
        
        if (visible) lastResultSeenTime = Date.now();
        
        // Sticky True: Return true if we saw it recently during the grace period.
        return visible || (Date.now() - lastResultSeenTime < RESULT_SCREEN_GRACE_MS);
    }

    function updateVisibility() {
        const hud = document.getElementById('gg-meta-hud');
        if (!hud) return;

        const resultActive = isRoundResult();
        if (resultActive) {
            syncPanoidForUserAction('result visibility');
        }

        // If we are completely out of the result window (including sticky), reset dismissal
        if (!resultActive) {
            userDismissed = false;
        }

        // Wrapper to check both active state AND dismissal
        const shouldShow = resultActive && !userDismissed;

        // Sync body class for element blocking
        document.body.classList.toggle('gg-hud-active', shouldShow);

        // In Ranked/Duels, ONLY show on result screen (Evaluation)
        if (isRanked()) {
             if (shouldShow) {
                 hud.classList.add('gg-visible');
             } else {
                 hud.classList.remove('gg-visible');
             }
             return;
        }

        // In Single Player / Challenge, show if result OR if mapped (optional, but requested to stick to result for now)
        if (shouldShow) {
             hud.classList.add('gg-visible');
        } else {
             hud.classList.remove('gg-visible');
        }
    }

    function checkLocation(panoid) {
        if (!panoid || typeof panoid !== 'string' || panoid.length <= 5) return;
        
        // Lock Mechanism:
        // If on result screen, queue updates instead of applying immediately
        // to prevent UI jitter when reviewing previous rounds.
        const onResultScreen = isRoundResult();
        if (currentPanoid && currentPanoid !== panoid && onResultScreen) {
            nextPanoid = panoid; // Queue it
            return;
        }

        const changed = (panoid !== currentPanoid);
        currentPanoid = panoid;
        nextPanoid = null; // Clear queue since we accepted a new one
        
        if (changed) {
            console.log('[BetterMetas] New Location detected:', panoid);
            updateStatus(`ID: ${panoid.substring(0,12)}...`);
            
            // Trigger Location Data Extraction Immediately
            extractLocationData();
        }

        // Trigger Display Refresh (this handles checking if data is loaded)
        refreshDisplay();
    }
    
    function extractLocationData(attempt = 0) {
        const maxAttempts = 10;
        
        if (!svInstance) {
            console.log(`[BetterMetas] extractLocationData: No svInstance available yet (Attempt ${attempt+1}/${maxAttempts}).`);
            if (attempt < maxAttempts) {
                setTimeout(() => extractLocationData(attempt + 1), STREETVIEW_RETRY_DELAY_MS);
            }
            return;
        }

        if (attempt === 0) console.log('[BetterMetas] extractLocationData: Triggered.');

        // Give it a moment for data to populate in the instance if it's fresh
        setTimeout(() => {
            try {
                // Check if we can get location data
                let loc = null;
                if (typeof svInstance.getLocation === 'function') {
                    loc = svInstance.getLocation();
                } 
                
                if (loc) {
                    const desc = loc.description || loc.shortDescription || "Unknown Location";
                    const latLng = loc.latLng;
                    const lat = latLng ? (typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat) : 0;
                    const lng = latLng ? (typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng) : 0;
                    
                    console.log(`[BetterMetas] Location Found: ${desc} (${lat}, ${lng})`);

                    // Simple heuristic for "Country" from address (last part after comma)
                    let country = "Unknown";
                    if (desc && desc.includes(',')) {
                        const parts = desc.split(',');
                        country = parts[parts.length - 1].trim();
                        // Filter out zip codes if mixed in (basic check)
                        if (/^\d+$/.test(country) && parts.length > 1) {
                            country = parts[parts.length - 2].trim();
                        }
                    } else {
                        country = desc; // Fallback
                    }

                    // Check if we already have this location data to prevent overwriting with nulls during race conditions
                    const newLatStr = lat.toFixed(5);
                    const newLngStr = lng.toFixed(5);
                    
                    if (currentLocationData && 
                        currentLocationData.lat === newLatStr && 
                        currentLocationData.lng === newLngStr) {
                         
                        // Location hasn't changed.
                        // If we already have a Road, don't wipe it out!
                        if (currentLocationData.road) {
                            console.log('[BetterMetas] Road already exists for this location, skipping reset/re-geocode.');
                            // Ensure HUD is refreshed just in case
                            if (currentPanoid) checkLocation(currentPanoid);
                            return; 
                        }
                        
                        // If we don't have a road, we might want to let it proceed to geocoding...
                        // But we should carry over existing country/region/address if valid
                        currentLocationData.address = currentLocationData.address || desc;
                        currentLocationData.country = currentLocationData.country || country;
                        // Region and Road are null, so let them be re-fetched below
                        
                    } else {
                        // New location, reset
                        currentLocationData = {
                            address: desc,
                            country: country,
                            region: null,
                            city: null,
                            road: null,
                            lat: newLatStr,
                            lng: newLngStr
                        };
                    }
                    
                    updateLocationUI();
                    
                    // Immediate trigger with basic info (Lat/Lng is enough for radius checks)
                    if (currentPanoid) checkLocation(currentPanoid);

                    // Dual Geocoding Strategy
                    const latVal = parseFloat(lat);
                    const lngVal = parseFloat(lng);
                    
                    // 1. Google Geocoding (Dominant for country)
                    const geocoder = new win.google.maps.Geocoder();
                    geocoder.geocode({ location: { lat: latVal, lng: lngVal } }, (results, status) => {
                        if (status === "OK" && results[0]) {
                            const res = results[0];
                            const addrComp = res.address_components;
                            
                            let gCountry = null;
                            let gRegion = null;
                            let gCity = null;
                            let gRoad = null;
                            
                            addrComp.forEach(comp => {
                                if (comp.types.includes("country")) gCountry = comp.long_name;
                                if (comp.types.includes("administrative_area_level_1")) gRegion = comp.long_name;
                                if (comp.types.includes("locality") || comp.types.includes("administrative_area_level_2")) {
                                    if (!gCity) gCity = comp.long_name; // Prefer locality
                                }
                                if (comp.types.includes("route")) gRoad = comp.long_name;
                            });
                            
                            if (currentLocationData.lat === newLatStr && currentLocationData.lng === newLngStr) {
                                currentLocationData.googleCountry = gCountry;
                                // Primary country selection (Google preferred)
                                if (gCountry) {
                                    currentLocationData.country = normalizeCountry(gCountry, lat, lng);
                                }
                                if (gRegion && !currentLocationData.region) currentLocationData.region = gRegion;
                                if (gCity && !currentLocationData.city) currentLocationData.city = gCity;
                                if (gRoad && !currentLocationData.road) currentLocationData.road = gRoad;
                                
                                updateLocationUI();
                                if (currentPanoid) checkLocation(currentPanoid);
                            }
                        } else {
                            console.warn('[BetterMetas] Google geocode failed:', status);
                        }
                    });

                            // 2. Nominatim Geocoding (Detail/Fallback)
                    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latVal}&lon=${lngVal}&accept-language=en`;
                    
                    fetch(nominatimUrl, {
                        headers: { 'User-Agent': 'GeoguessrBetterMetas/1.0' }
                    })
                    .then(response => response.json())
                    .then(data => {
                        if (data && data.address) {
                            const a = data.address;
                            const address = data.display_name;
                            let nCountry = a.country || country;
                            let realNomCountry = normalizeCountry(nCountry, lat, lng);
                            let region = a.state || a.region || a.province || a.county || a.district || null;
                            let city = a.city || a.town || a.village || a.hamlet || a.municipality || null;
                            
                            // Road Logic
                            let road = null;
                            const roadName = a.road || a.pedestrian || a.highway || a.street || a.suburb || a.hamlet || a.village || null;
                            if (roadName) {
                                if (roadName.includes(';')) {
                                    road = roadName.split(';').map(s => s.trim());
                                } else {
                                    road = roadName;
                                }
                            }

                            // Fallback: If still no road, use shortDescription if it looks like a road
                            if (!road && loc.shortDescription && loc.shortDescription !== loc.description && loc.shortDescription !== realNomCountry) {
                                if (loc.shortDescription !== region && loc.shortDescription !== city) {
                                    road = loc.shortDescription;
                                }
                            }

                            // Update Location Data (if still relevant)
                            if (currentLocationData.lat === newLatStr && currentLocationData.lng === newLngStr) {
                                currentLocationData.nominatimCountry = realNomCountry;
                                currentLocationData.address = address; // Prefer Nominatim address
                                
                                // Fallback for Country if Google failed
                                if (!currentLocationData.country) {
                                    currentLocationData.country = realNomCountry;
                                }
                                
                                if (region && !currentLocationData.region) currentLocationData.region = region;
                                if (city && !currentLocationData.city) currentLocationData.city = city;
                                if (road && !currentLocationData.road) currentLocationData.road = road;
                            }

                            updateLocationUI();
                            if (currentPanoid) checkLocation(currentPanoid);
                        }
                    })
                    .catch(error => {
                        console.error('[BetterMetas] Nominatim geocode failed:', error);
                    });
                } else {
                    console.log(`[BetterMetas] svInstance.getLocation() returned null/empty (Attempt ${attempt+1}/${maxAttempts}).`);
                    if (attempt < maxAttempts) {
                        extractLocationData(attempt + 1);
                    }
                }
            } catch (e) {
                console.warn('[BetterMetas] Error accessing location data:', e);
            }
        }, STREETVIEW_RETRY_DELAY_MS);
    }

    function updateLocationUI() {
        const box = document.getElementById('gg-location-info');
        console.log('[BetterMetas] updateLocationUI called. Box:', box, 'Data:', currentLocationData);
        if (!box) return;

        // Respect configuration
        if (!SHOW_LOCATION_HUD) {
            box.style.display = 'none';
            return;
        }

        const { address, country, region, road, lat, lng } = currentLocationData;
        const roadLabel = Array.isArray(road) ? road.join(', ') : road;
        
        if (!lat || !lng) {
            console.log('[BetterMetas] updateLocationUI: Missing lat/lng, hiding box.');
            box.style.display = 'none';
            return;
        }

        box.innerHTML = `
            <div class="gg-loc-row">
                <div class="gg-loc-label">Address:</div>
                <div class="gg-loc-val">${escapeHtml(address || 'N/A')}</div>
            </div>
             <div class="gg-loc-row">
                <div class="gg-loc-label">Country:</div>
                <div class="gg-loc-val gg-loc-val-country">${escapeHtml(country || 'N/A')}</div>
            </div>
            ${region ? `
            <div class="gg-loc-row">
                <div class="gg-loc-label">Region:</div>
                <div class="gg-loc-val">${escapeHtml(region)}</div>
            </div>` : ''}
            ${currentLocationData.city ? `
            <div class="gg-loc-row">
                <div class="gg-loc-label">City:</div>
                <div class="gg-loc-val">${escapeHtml(currentLocationData.city)}</div>
            </div>` : ''}
            ${roadLabel ? `
            <div class="gg-loc-row">
                <div class="gg-loc-label">Road:</div>
                <div class="gg-loc-val">${escapeHtml(roadLabel)}</div>
            </div>` : ''}
        `;
        box.style.display = 'block';
    }




    function decodeGitHubJsonContent(content) {
        const decoded = decodeURIComponent(escape(window.atob((content || '').replace(/\n/g, ""))));
        return parseGitHubJsonText(decoded);
    }

    function encodeGitHubJsonContent(content) {
        return window.btoa(unescape(encodeURIComponent(stringifyJsonContent(content))));
    }

    function parseGitHubJsonText(text) {
        const trimmed = (text || '').trim();
        if (!trimmed) return null;
        return JSON.parse(trimmed);
    }

    function addCacheBust(url) {
        return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    }

    async function fetchGitHubDownloadJson(downloadUrl, label) {
        const response = await requestRawText(addCacheBust(downloadUrl), label);
        if (response.status !== 200) {
            throw new Error(`${label} HTTP ${response.status}: ${response.statusText || 'unknown error'}`);
        }
        return parseGitHubJsonText(response.responseText);
    }

    async function fetchGitHubBlobJson(gitUrl, token, label) {
        const blob = await githubApiGetWithRetry(gitUrl, token, label);
        if (!blob || typeof blob !== 'object' || typeof blob.content !== 'string') {
            throw new Error(`GitHub returned no blob content for ${label}`);
        }
        return decodeGitHubJsonContent(blob.content);
    }

    function parseGitHubApiError(response) {
        let details = response.statusText;
        try {
            details = JSON.parse(response.responseText).message || details;
        } catch(e) {}
        const error = new Error(`GitHub API ${response.status}: ${details}`);
        error.status = response.status;
        error.details = details;
        return error;
    }

    function githubApiRequest(url, token, method = 'GET', body = null, options = {}) {
        const timeout = options.timeout || GITHUB_API_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache'
                },
                timeout,
                data: body ? JSON.stringify(body) : null,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            resolve(JSON.parse(response.responseText));
                        } catch(e) {
                            resolve(response.responseText);
                        }
                    } else {
                        reject(parseGitHubApiError(response));
                    }
                },
                onerror: () => reject(new Error(`GitHub API request failed: ${url}`)),
                ontimeout: () => reject(new Error(`GitHub API request timed out after ${Math.round(timeout / 1000)}s: ${url}`))
            });
        });
    }

    async function githubApiGetWithRetry(url, token, label = url) {
        let lastError = null;

        for (let attempt = 1; attempt <= DATA_FETCH_MAX_ATTEMPTS; attempt++) {
            try {
                return await githubApiRequest(url, token);
            } catch (err) {
                lastError = err;
                if (attempt >= DATA_FETCH_MAX_ATTEMPTS) break;
                const delay = DATA_FETCH_RETRY_DELAY_MS * attempt;
                console.warn(`[BetterMetas] GitHub API read failed for ${label} (attempt ${attempt}/${DATA_FETCH_MAX_ATTEMPTS}), retrying in ${delay}ms:`, err);
                await wait(delay);
            }
        }

        throw lastError || new Error(`GitHub API read failed for ${label}`);
    }

    async function getGitHubJsonFile(apiUrl, token) {
        const data = await githubApiGetWithRetry(getApiUrlForBranch(apiUrl), token, apiUrl);
        if (!data || typeof data !== 'object' || !('content' in data)) {
            throw new Error(`GitHub returned no file content for ${apiUrl}`);
        }

        const hasInlineContent = typeof data.content === 'string' && data.content.trim();
        if (hasInlineContent) {
            return { sha: data.sha, content: decodeGitHubJsonContent(data.content) };
        }

        if ((data.size || 0) > 0 && data.git_url) {
            const content = await fetchGitHubBlobJson(data.git_url, token, apiUrl);
            return { sha: data.sha, content };
        }

        if ((data.size || 0) > 0 && data.download_url) {
            const content = await fetchGitHubDownloadJson(data.download_url, apiUrl);
            return { sha: data.sha, content };
        }

        return { sha: data.sha, content: null };
    }

    async function putGitHubJsonFile(apiUrl, token, sha, content, message) {
        const body = {
            message,
            content: encodeGitHubJsonContent(content),
            branch: REPO_BRANCH
        };
        if (sha) body.sha = sha;
        return githubApiRequest(apiUrl, token, 'PUT', body, { timeout: GITHUB_API_WRITE_TIMEOUT_MS });
    }

    function isGitHubContentConflict(error) {
        return Boolean(error && (error.status === 409 || /^GitHub API 409:/.test(error.message || '')));
    }

    function readGitHubWriteLock() {
        try {
            const value = readStoredValue(GITHUB_WRITE_LOCK_STORAGE_KEY);
            return value ? JSON.parse(value) : null;
        } catch (error) {
            console.warn('[BetterMetas] Could not read GitHub write lock:', error);
            return null;
        }
    }

    function writeGitHubWriteLock(value) {
        writeStoredValue(GITHUB_WRITE_LOCK_STORAGE_KEY, JSON.stringify(value));
    }

    function clearGitHubWriteLock() {
        clearStoredValue(GITHUB_WRITE_LOCK_STORAGE_KEY);
    }

    async function acquireGitHubWriteLock(label) {
        const deadline = Date.now() + GITHUB_WRITE_LOCK_MAX_WAIT_MS;

        while (Date.now() < deadline) {
            const now = Date.now();
            const lock = readGitHubWriteLock();
            const lockExpired = !lock || !lock.expiresAt || lock.expiresAt <= now;
            const ownLock = lock && lock.owner === GITHUB_WRITE_LOCK_OWNER;

            if (lockExpired || ownLock) {
                writeGitHubWriteLock({
                    owner: GITHUB_WRITE_LOCK_OWNER,
                    label,
                    expiresAt: now + GITHUB_WRITE_LOCK_TTL_MS
                });

                await wait(25);
                const confirmed = readGitHubWriteLock();
                if (confirmed && confirmed.owner === GITHUB_WRITE_LOCK_OWNER) {
                    return () => {
                        const current = readGitHubWriteLock();
                        if (current && current.owner === GITHUB_WRITE_LOCK_OWNER) {
                            clearGitHubWriteLock();
                        }
                    };
                }
            }

            await wait(GITHUB_WRITE_LOCK_POLL_MS + Math.floor(Math.random() * GITHUB_WRITE_LOCK_POLL_MS));
        }

        throw new Error('Timed out waiting for another BetterMetas GitHub save to finish. Please try again.');
    }

    let githubWriteQueue = Promise.resolve();

    function withGitHubWriteLock(label, operation) {
        const run = githubWriteQueue.catch(() => {}).then(async () => {
            const releaseLock = await acquireGitHubWriteLock(label);
            try {
                return await operation();
            } finally {
                releaseLock();
            }
        });

        githubWriteQueue = run.catch(() => {});
        return run;
    }

    async function updateGitHubJsonFileWithOptions(apiUrl, token, normalizeContent, updateContent, message, skipUnchanged) {
        return withGitHubWriteLock(message, async () => {
            let lastError = null;

            for (let attempt = 1; attempt <= GITHUB_CONTENT_UPDATE_MAX_ATTEMPTS; attempt++) {
                const file = await getGitHubJsonFile(apiUrl, token);
                const content = normalizeContent(file.content);
                const before = skipUnchanged ? stringifyJsonContent(content) : null;
                const updatedContent = updateContent(content) || content;

                if (skipUnchanged && before === stringifyJsonContent(updatedContent)) {
                    return { skipped: true };
                }

                try {
                    return await putGitHubJsonFile(apiUrl, token, file.sha, updatedContent, message);
                } catch (error) {
                    lastError = error;
                    if (!isGitHubContentConflict(error) || attempt === GITHUB_CONTENT_UPDATE_MAX_ATTEMPTS) {
                        throw error;
                    }

                    const delay = GITHUB_CONTENT_UPDATE_RETRY_DELAY_MS * attempt + Math.floor(Math.random() * GITHUB_CONTENT_UPDATE_RETRY_DELAY_MS);
                    console.warn(`[BetterMetas] GitHub content conflict while saving ${apiUrl}; retrying with latest file (${attempt + 1}/${GITHUB_CONTENT_UPDATE_MAX_ATTEMPTS}) after ${delay}ms.`, error);
                    await wait(delay);
                }
            }

            throw lastError;
        });
    }

    function updateGitHubJsonFile(apiUrl, token, normalizeContent, updateContent, message) {
        return updateGitHubJsonFileWithOptions(apiUrl, token, normalizeContent, updateContent, message, false);
    }

    function updateGitHubJsonFileIfChanged(apiUrl, token, normalizeContent, updateContent, message) {
        return updateGitHubJsonFileWithOptions(apiUrl, token, normalizeContent, updateContent, message, true);
    }

    function fetchGitHubContentJson(apiUrl, token) {
        return getGitHubJsonFile(apiUrl, token).then(file => file.content);
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function requestRawText(url, label) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                timeout: DATA_FETCH_TIMEOUT_MS,
                onload: resolve,
                onerror: () => reject(new Error(`${label} request failed`)),
                ontimeout: () => reject(new Error(`${label} request timed out`))
            });
        });
    }

    async function fetchRawJsonWithRetry(urlFactory, label, normalize, defaultValue, options = {}) {
        let lastError = null;

        for (let attempt = 1; attempt <= DATA_FETCH_MAX_ATTEMPTS; attempt++) {
            try {
                const response = await requestRawText(urlFactory(), label);
                if (response.status === 200) {
                    return normalize(JSON.parse(response.responseText));
                }

                if (options.allowMissing && (response.status === 404 || response.status === 204)) {
                    return defaultValue;
                }

                throw new Error(`${label} HTTP ${response.status}: ${response.statusText || 'unknown error'}`);
            } catch (err) {
                lastError = err;
                if (attempt < DATA_FETCH_MAX_ATTEMPTS) {
                    console.warn(`[BetterMetas] ${label} load failed (attempt ${attempt}/${DATA_FETCH_MAX_ATTEMPTS}), retrying:`, err);
                    await wait(DATA_FETCH_RETRY_DELAY_MS * attempt);
                }
            }
        }

        if (options.allowMissing) {
            console.warn(`[BetterMetas] ${label} unavailable after retries, continuing with empty data:`, lastError);
            return defaultValue;
        }

        throw lastError || new Error(`${label} load failed`);
    }

    async function loadDataSource(token, options) {
        if (token) {
            try {
                const data = options.normalize(await fetchGitHubContentJson(options.apiUrl, token));
                console.log(`[BetterMetas] Loaded ${options.count(data)} ${options.description} from GitHub API.`);
                return data;
            } catch (err) {
                console.warn(`[BetterMetas] GitHub API ${options.apiLogName} fetch failed, falling back to raw:`, err);
            }
        }

        const data = await fetchRawJsonWithRetry(
            () => getRawFileUrl(options.file),
            options.logName,
            options.normalize,
            options.defaultValue,
            { allowMissing: options.allowMissing }
        );
        console.log(`[BetterMetas] Loaded ${options.count(data)} ${options.description} from raw.`);
        return data;
    }

    const locationCount = (data) => Object.keys(data).length;
    const metaCount = (data) => data.length;
    const DATA_SOURCES = {
        userLocations: { apiUrl: API_USER_LOCATIONS_URL, file: USER_LOCATIONS_FILE, apiLogName: 'user_locations', logName: 'user_locations.json', normalize: normalizeLocationMap, defaultValue: {}, allowMissing: true, count: locationCount, description: 'user location mappings' },
        userMetas: { apiUrl: API_USER_METAS_URL, file: USER_METAS_FILE, apiLogName: 'user_metas', logName: 'user_metas.json', normalize: normalizeMetaList, defaultValue: [], allowMissing: true, count: metaCount, description: 'user metas' },
        systemLocations: { apiUrl: API_SYSTEM_LOCATIONS_URL, file: SYSTEM_LOCATIONS_FILE, apiLogName: 'plonkit_locations', logName: 'plonkit_locations.json', normalize: normalizeLocationMap, defaultValue: {}, allowMissing: false, count: locationCount, description: 'system location mappings' },
        systemMetas: { apiUrl: API_SYSTEM_METAS_URL, file: SYSTEM_METAS_FILE, apiLogName: 'plonkit_metas', logName: 'plonkit_metas.json', normalize: normalizeSystemMetas, defaultValue: [], allowMissing: false, count: metaCount, description: 'system metas' },
    };

    // --- Data Fetching ---
    async function fetchLocationData() {
        console.log('[BetterMetas] Fetching data...');
        updateStatus(metasData.length > 0 ? 'Refreshing DB...' : 'Loading DB...');
        const token = getSettingsTokenValue();
        const loadId = ++dataLoadSequence;

        try {
            const [loadedUserLocationMap, loadedSystemLocationMap, loadedUserMetas, loadedSystemMetas] = await Promise.all([
                loadDataSource(token, DATA_SOURCES.userLocations),
                loadDataSource(token, DATA_SOURCES.systemLocations),
                loadDataSource(token, DATA_SOURCES.userMetas),
                loadDataSource(token, DATA_SOURCES.systemMetas)
            ]);

            if (loadId !== dataLoadSequence) {
                console.log('[BetterMetas] Ignoring stale DB load result.');
                return;
            }

            const snapshot = {
                userLocationMap: loadedUserLocationMap,
                systemLocationMap: loadedSystemLocationMap,
                userMetas: loadedUserMetas,
                systemMetas: loadedSystemMetas
            };
            const applied = applyDataSnapshot(snapshot, { prunePending: true });
            saveDataSnapshotCache(snapshot);

            const locCount = Object.keys(locationMap).length;
            const userLocCount = Object.keys(userLocationMap).length;
            const systemLocCount = Object.keys(systemLocationMap).length;
            const pendingLocCount = Object.keys(applied.pending.locations).length;
            console.log(`[BetterMetas] DB Ready: ${locCount} locs (${userLocCount} user, ${systemLocCount} system), ${metasData.length} unique metas (${userMetaIds.size} user, ${systemMetaIds.size} system). Pending local merge: ${applied.pending.metas.length} metas, ${pendingLocCount} locs.`);

            syncPanoidForUserAction('DB ready');

            if (currentPanoid) {
                 updateStatus(`ID: ${currentPanoid.substring(0,12)}...`);
                 refreshDisplay();
            } else {
                 updateStatus(`DB Ready (${metasData.length} metas)`);
            }
        } catch (err) {
            if (loadId !== dataLoadSequence) return;
            useFallback(err && err.message ? err.message : 'Data Load Error');
        }
    }

    function useFallback(reason) {
        console.warn(`[BetterMetas] Could not load data. Reason: ${reason}`);
        if (metasData.length > 0) {
            updateStatus(`Using cached DB (${metasData.length} metas)`);
            refreshDisplay();
            return;
        }

        updateStatus(`Offline (${reason})`);
    }



    // --- Google Maps Hooks ---
    function watchConfigurableProperty(target, prop, onSet) {
        if (!target) return false;

        const descriptor = Object.getOwnPropertyDescriptor(target, prop);
        if (descriptor && descriptor.configurable === false) return false;

        let currentValue = descriptor && descriptor.get ? descriptor.get.call(target) : target[prop];
        Object.defineProperty(target, prop, {
            configurable: true,
            enumerable: descriptor ? descriptor.enumerable : true,
            get() {
                return descriptor && descriptor.get ? descriptor.get.call(target) : currentValue;
            },
            set(value) {
                if (descriptor && descriptor.set) {
                    descriptor.set.call(target, value);
                } else {
                    currentValue = value;
                }
                onSet(value);
            }
        });

        if (currentValue) onSet(currentValue);
        return true;
    }

    function queueHookInstall(delay = 0) {
        setTimeout(() => {
            installNestedGoogleWatchers();
            installHooks();
        }, delay);
    }

    function installNestedGoogleWatchers() {
        const googleObject = win.google;
        if (!googleObject || typeof googleObject !== 'object') return;

        if (watchedGoogleObject !== googleObject) {
            watchedGoogleObject = googleObject;
            watchConfigurableProperty(googleObject, 'maps', () => {
                installNestedGoogleWatchers();
                queueHookInstall();
            });
        }

        const mapsObject = googleObject.maps;
        if (!mapsObject || typeof mapsObject !== 'object') return;

        if (watchedMapsObject !== mapsObject) {
            watchedMapsObject = mapsObject;
            watchConfigurableProperty(mapsObject, 'StreetViewPanorama', () => {
                queueHookInstall();
            });
        }
    }

    function installGoogleHookWatcher() {
        if (googleWatcherInstalled) return;
        googleWatcherInstalled = true;

        watchConfigurableProperty(win, 'google', () => {
            installNestedGoogleWatchers();
            queueHookInstall();
        });

        installNestedGoogleWatchers();
        queueHookInstall();
    }

    function installHooks() {
        if (hooksInstalled) return true;

        // Check for Maps API
        if (!win.google || !win.google.maps || !win.google.maps.StreetViewPanorama) {
            return false;
        }

        console.log('[BetterMetas] Google Maps API found. Installing hooks...');
        
        // 1. Hook StreetViewPanorama Constructor
        const OriginalStreetViewPanorama = win.google.maps.StreetViewPanorama;
        if (OriginalStreetViewPanorama.__betterMetasHooked) {
            hooksInstalled = true;
            return true;
        }
        
        win.google.maps.StreetViewPanorama = function(node, opts) {
            const instance = new OriginalStreetViewPanorama(node, opts);

            registerStreetViewInstance(instance, 'constructor');
            if (opts && isValidPanoid(opts.pano)) {
                checkLocation(opts.pano);
            }

            return instance;
        };
        win.google.maps.StreetViewPanorama.__betterMetasHooked = true;

        // Copy statics
        win.google.maps.StreetViewPanorama.prototype = OriginalStreetViewPanorama.prototype;
        for (let prop in OriginalStreetViewPanorama) {
            if (OriginalStreetViewPanorama.hasOwnProperty(prop)) {
                win.google.maps.StreetViewPanorama[prop] = OriginalStreetViewPanorama[prop];
            }
        }

        // 2. Hook setPano (for SPA updates)
        const originalSetPano = win.google.maps.StreetViewPanorama.prototype.setPano;
        if (typeof originalSetPano === 'function' && !originalSetPano.__betterMetasHooked) {
            win.google.maps.StreetViewPanorama.prototype.setPano = function(pano) {
                registerStreetViewInstance(this, 'setPano');
                const result = originalSetPano.apply(this, arguments);
                if (isValidPanoid(pano)) checkLocation(pano);
                setTimeout(() => readPanoidFromStreetView(this, 'setPano applied'), 0);
                return result;
            };
            win.google.maps.StreetViewPanorama.prototype.setPano.__betterMetasHooked = true;
        }

        const originalSetPosition = win.google.maps.StreetViewPanorama.prototype.setPosition;
        if (typeof originalSetPosition === 'function' && !originalSetPosition.__betterMetasHooked) {
            win.google.maps.StreetViewPanorama.prototype.setPosition = function() {
                registerStreetViewInstance(this, 'setPosition');
                const result = originalSetPosition.apply(this, arguments);
                setTimeout(() => readPanoidFromStreetView(this, 'setPosition applied'), 0);
                setTimeout(() => readPanoidFromStreetView(this, 'setPosition settled'), 300);
                return result;
            };
            win.google.maps.StreetViewPanorama.prototype.setPosition.__betterMetasHooked = true;
        }
        
        hooksInstalled = true;
        console.log('[BetterMetas] Hooks installed successfully.');
        return true;
    }



    function startObserver() {
         installGoogleHookWatcher();

         // UI Poller
         setInterval(() => {
             updateVisibility();
             
             // Process queued panoid if lock is released
             if (nextPanoid && !isRoundResult()) {
                 console.log('[BetterMetas] Applying queued panoid:', nextPanoid);
                 checkLocation(nextPanoid);
             }
         }, VISIBILITY_POLL_INTERVAL_MS);

         // Hook Poller - wait for Google Maps
         const timer = setInterval(() => {
            if (installHooks()) {
                clearInterval(timer);
            }
         }, 25);

         // Input Capture for Instant Hide
         document.addEventListener('keydown', (e) => {
             if (e.code === 'Space' || e.key === ' ') {
                 // Only hide if currently visible (on result screen)
                 // And ensure we aren't typing in an input
                 const activeTag = document.activeElement?.tagName?.toLowerCase() || '';
                 if (activeTag === 'input' || activeTag === 'textarea') return;

                 if (isRoundResult()) {
                     const hud = document.getElementById('gg-meta-hud');
                     if (hud) {
                         // Instant hide via class removal (transitions out)
                         hud.classList.remove('gg-visible');
                         userDismissed = true;
                     }
                 }
             }
         });

         // Next Button Click Capture (Heuristic)
         document.addEventListener('click', (e) => {
             // Look for buttons that might be "Next" or "Play Again"
             // This is a best-effort heuristic based on common button texts or classes
             const target = getEventElementTarget(e);
             const button = target ? target.closest('button') : null;
             if (!button) return;
             
             // Check if we are on result screen
             if (isRoundResult()) {
                  // If we click ANY button on result screen that isn't inside our HUD or modals, hide HUD
                  // Exclude: HUD and BetterMetas modals/dialogs
                  if (!button.closest('#gg-meta-hud') &&
                      !button.closest('#gg-settings-modal') &&
                      !button.closest('#gg-meta-modal') &&
                      !button.closest('#gg-meta-admin-modal') &&
                      !button.closest('#gg-dialog-modal')) {
                       
                       // Close HUD
                       const hud = document.getElementById('gg-meta-hud');
                       if (hud && hud.classList.contains('gg-visible')) {
                           hud.classList.remove('gg-visible');
                           userDismissed = true;
                       }

                       // Close Modals
                       hideAllModals();
                  }
             }
         }, true); // Capture phase to catch it early

         console.log('[BetterMetas] Observer started.');
    }

    // --- Initialization ---
    function initUI() {
        if (uiInitialized) return true;
        if (!document.body) return false;

        uiInitialized = true;
        console.log('[Geoguessr Meta] Initializing UI...');
        addStyles();
        createHUD();
        applyCachedDataSnapshot();
        fetchLocationData();
        return true;
    }

    function scheduleUIInit() {
        if (initUI()) return;

        const tryInit = () => {
            if (initUI()) {
                document.removeEventListener('DOMContentLoaded', tryInit);
            }
        };

        document.addEventListener('DOMContentLoaded', tryInit, { once: true });
        const timer = setInterval(() => {
            if (initUI()) clearInterval(timer);
        }, 25);
    }

    function init() {
        console.log('[Geoguessr Meta] Initializing...');
        startObserver();
        scheduleUIInit();
    }

    init();

})();
