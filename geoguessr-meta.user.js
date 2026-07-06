// ==UserScript==
// @name         BetterMetas
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  Displays crowdsourced metas and hints for Geoguessr locations.
// @author       Lukas Hzb
// @updateURL    https://raw.githubusercontent.com/lukas-hzb/better_metas/main_v3/geoguessr-meta.user.js
// @downloadURL  https://raw.githubusercontent.com/lukas-hzb/better_metas/main_v3/geoguessr-meta.user.js
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
    const REPO_BRANCH = 'main_v3';
    
    // Data Sources
    const USER_LOCATIONS_FILE = 'data/user_locations.json';
    const USER_METAS_FILE = 'data/user_metas.json';
    const SYSTEM_METAS_FILE = 'data/plonkit_metas.json';
    const SYSTEM_LOCATIONS_FILE = 'data/plonkit_locations.json';
    
    const getRawUserLocationsUrl = () => `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${USER_LOCATIONS_FILE}?t=${Date.now()}`;
    const getRawUserMetasUrl = () => `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${USER_METAS_FILE}?t=${Date.now()}`;
    const getRawSystemMetasUrl = () => `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${SYSTEM_METAS_FILE}?t=${Date.now()}`;
    const getRawSystemLocationsUrl = () => `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${SYSTEM_LOCATIONS_FILE}?t=${Date.now()}`;
    
    const API_USER_LOCATIONS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${USER_LOCATIONS_FILE}`;
    const API_USER_METAS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${USER_METAS_FILE}`;
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
    const DATA_FETCH_MAX_ATTEMPTS = 3;
    const DATA_FETCH_RETRY_DELAY_MS = 400;
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
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string') {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
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

    function normalizeUserMetas(value) {
        return normalizeMetaList(value);
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
            userMetas: normalizeUserMetas(value.userMetas),
            systemMetas: normalizeSystemMetas(value.systemMetas)
        };
    }

    function buildUniqueMetas(userMetas, systemMetas) {
        const combined = [...normalizeUserMetas(userMetas), ...normalizeUserMetas(systemMetas)];
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

    function readDataCache() {
        if (typeof GM_getValue === 'function') {
            return GM_getValue(DATA_CACHE_STORAGE_KEY, null);
        }

        return localStorage.getItem(DATA_CACHE_STORAGE_KEY);
    }

    function writeDataCache(value) {
        if (typeof GM_setValue === 'function') {
            GM_setValue(DATA_CACHE_STORAGE_KEY, value);
            return;
        }

        localStorage.setItem(DATA_CACHE_STORAGE_KEY, value);
    }

    function clearDataCache() {
        if (typeof GM_setValue === 'function') {
            GM_setValue(DATA_CACHE_STORAGE_KEY, null);
        }

        localStorage.removeItem(DATA_CACHE_STORAGE_KEY);
    }

    function loadCachedDataSnapshot() {
        try {
            const cached = JSON.parse(readDataCache() || 'null');
            if (!cached || typeof cached !== 'object') return null;
            if (cached.version !== DATA_CACHE_VERSION) {
                clearDataCache();
                return null;
            }
            if (!cached.timestamp || Date.now() - cached.timestamp > DATA_CACHE_MAX_AGE_MS) {
                clearDataCache();
                return null;
            }
            return normalizeDataSnapshot(cached);
        } catch (err) {
            console.warn('[BetterMetas] Invalid cached data snapshot:', err);
            clearDataCache();
            return null;
        }
    }

    function saveDataSnapshotCache(snapshot) {
        const normalized = normalizeDataSnapshot(snapshot);
        if (!normalized) return;

        try {
            writeDataCache(JSON.stringify({
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
    
    const ALL_SCOPES = ['countrywide', 'region', 'city', 'road', '1000km', '100km', '10km', '1km', 'unique'];
    const TAG_PRESETS = ['plants', 'bollards', 'poles', 'signs', 'plates', 'cars', 'soil', 'structures', 'road', 'camera', 'language', 'architecture'];
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
            return `<span class="gg-tag-pill${selectedClass}" data-value="${escapeAttribute(scope)}">${escapeHtml(getScopeLabel(scope))}</span>`;
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

    function escapeAttribute(value) {
        return escapeHtml(value);
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
        return safeUrl ? `<img src="${escapeAttribute(safeUrl)}" class="gg-meta-image">` : '';
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
        #gg-settings-btn {
            background: rgba(255, 255, 255, 0.2);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            cursor: pointer;
            font-size: 0.75rem;
            font-weight: 600;
            line-height: 1;
            padding: 4px 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s, color 0.2s, border-color 0.2s;
        }

        .gg-resize-control-btn:hover,
        #gg-meta-add-btn:hover,
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
            display: inline-block;
            background: rgba(255, 255, 255, 0.2);
            color: #fff;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 0.75rem;
            margin-right: 4px;
            margin-bottom: 4px;
            font-weight: 600;
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
            display: inline-block;
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
        }

        .gg-meta-badge {
            font-size: 0.65rem;
            border: 1px solid;
            padding: 0 6px;
            border-radius: 4px;
            margin-left: 8px;
            vertical-align: middle;
            font-weight: 700;
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

        #gg-settings-btn {
            padding: 4px 8px;
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
            --modal-spacing-xs: 8px;
            --modal-spacing-sm: 12px;
            --modal-spacing-md: 16px;
            --modal-spacing-lg: 24px;
            --modal-radius: 16px;
            --modal-btn-radius: 30px;
            --modal-btn-height: 42px;
            --modal-btn-font-size: 0.8rem;
            --modal-control-bg: rgba(0, 0, 0, 0.3);
            --modal-control-bg-active: rgba(0, 0, 0, 0.4);
            --modal-control-border: rgba(100, 90, 150, 0.4);
            --modal-control-radius: 8px;
            --gg-primary-green: #8cd45a;
            --gg-primary-border: #3d8c2a;
            --gg-primary-gradient: linear-gradient(180deg, #8cd45a 0%, #6cc04a 50%, #5ab840 100%);
        }

        /* Modal Base Styles - GeoGuessr Native Style */
        #gg-meta-modal,
        #gg-settings-modal .gg-modal-container {
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
            width: 550px;
            transition: all 0.3s ease-in-out;
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
            width: 360px;
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
            margin: var(--modal-spacing-lg) 0 var(--modal-spacing-md) 0;
            text-align: center;
        }

        /* Form Elements */
        .gg-form-group {
            margin-bottom: var(--modal-spacing-sm);
        }

        .gg-form-group-lg {
            margin-bottom: var(--modal-spacing-md);
        }

        .gg-form-label {
            display: block;
            margin-bottom: 4px;
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.5);
            font-weight: 600;
            text-align: center;
        }

        .gg-form-input {
            width: 100%;
            padding: var(--modal-spacing-sm) var(--modal-spacing-md);
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

        .gg-form-hint {
            font-size: 0.7rem;
            color: rgba(255, 255, 255, 0.4);
            margin-top: 4px;
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
            margin-top: var(--modal-spacing-xs);
            text-align: center;
        }

        .gg-pill-grid .gg-tag-pill {
            margin: 0;
        }

        /* Buttons - GeoGuessr Green Style */
        .gg-btn-primary {
            background: var(--gg-primary-gradient);
            color: #fff;
            border: none;
            border-bottom: 2px solid var(--gg-primary-border);
            padding: 10px 0; /* Consistent height */
            border-radius: var(--modal-btn-radius);
            cursor: pointer;
            width: 100%;
            font-weight: 800;
            font-size: var(--modal-btn-font-size);
            font-style: italic;
            text-transform: uppercase;
            letter-spacing: 0.03em;
            margin-top: 12px;
            transition: transform 0.1s, box-shadow 0.1s, border-bottom 0.1s;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
            box-sizing: border-box;
            height: var(--modal-btn-height); /* Fixed height for consistency */
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .gg-btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
        }

        .gg-btn-primary:active {
            transform: translateY(1px);
            border-bottom: 1px solid var(--gg-primary-border);
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
        }

        .gg-btn-secondary {
            background: var(--modal-control-bg);
            color: rgba(255, 255, 255, 0.7);
            border: 1px solid var(--modal-control-border);
            padding: 10px 0;
            cursor: pointer;
            margin-top: 12px;
            width: 100%;
            font-size: var(--modal-btn-font-size);
            font-weight: 700;
            border-radius: var(--modal-btn-radius); /* Match primary button */
            transition: background 0.2s, color 0.2s;
            box-sizing: border-box;
            height: var(--modal-btn-height); /* Fixed height for consistency */
            display: flex;
            align-items: center;
            justify-content: center;
            text-transform: uppercase; /* Match layout style */
            letter-spacing: 0.03em;
        }

        .gg-btn-secondary:hover {
            background: var(--modal-control-bg-active);
            color: #fff;
        }

        .gg-btn-danger {
            background: transparent;
            color: #f97316;
            border: 2px solid #f97316;
            padding: 10px 0;
            border-radius: var(--modal-btn-radius); /* Match primary button */
            cursor: pointer;
            width: 100%;
            font-size: var(--modal-btn-font-size);
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            transition: background 0.2s, color 0.2s;
            box-sizing: border-box;
            height: var(--modal-btn-height); /* Fixed height for consistency */
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .gg-btn-danger:hover {
            background: rgba(249, 115, 22, 0.15);
        }

        #gg-resize-window {
            margin-top: var(--modal-spacing-xs);
        }

        #gg-save-settings {
            margin-top: var(--modal-spacing-md);
        }

        #meta-details-btn {
            margin-top: 0;
        }

        /* Divider */
        .gg-modal-divider {
            border: 0;
            border-top: 1px solid rgba(100, 90, 150, 0.3);
            margin: var(--modal-spacing-md) 0; /* Reduced from lg to md */
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
            margin-top: 8px;
        }

        .gg-meta-list-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 12px;
            border-bottom: 1px solid rgba(255,255,255,0.06);
        }

        .gg-meta-list-main {
            display: flex;
            align-items: center;
            gap: 4px;
            flex: 1;
            overflow: hidden;
            height: 100%;
        }

        .gg-meta-list-item:last-child {
            border-bottom: none;
        }

        .gg-list-empty-state {
            padding: 8px 0;
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
            align-items: center;
            gap: 4px;
            overflow-x: auto;
            scrollbar-width: none;
            height: 100%;
            flex: 1;
            font-size: 0.65rem;
            color: rgba(255,255,255,0.4);
            margin-top: 2px;
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

        .gg-selection-actions {
            margin-top: 10px;
        }

        #gg-link-selected-btn {
            display: none;
            width: 100%;
            margin-bottom: 10px;
        }

        .gg-btn-link-meta {
            background: var(--gg-primary-gradient);
            color: #fff;
            border: none;
            border-bottom: 2px solid var(--gg-primary-border);
            padding: 4px 10px;
            border-radius: 12px;
            cursor: pointer;
            font-size: 0.7rem;
            font-weight: 800;
            font-style: italic;
            text-transform: uppercase;
            letter-spacing: 0.03em;
            transition: transform 0.1s, box-shadow 0.1s, border-bottom 0.1s;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
            text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
            flex-shrink: 0;
        }

        .gg-btn-link-meta:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.35);
        }

        .gg-btn-link-meta:active {
            transform: translateY(1px);
            border-bottom: 1px solid var(--gg-primary-border);
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        }

        .gg-btn-link-meta.gg-tag-selected {
            background: var(--gg-primary-green);
            border-color: var(--gg-primary-border);
        }

        /* JSON Output */
        #gg-json-output {
            margin-top: 12px;
            background: var(--modal-control-bg-active);
            padding: 10px;
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
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            z-index: 99999;
            display: none;
            opacity: 0;
            transition: opacity 0.3s;
        }

        #gg-modal-backdrop.gg-visible {
            display: block;
            opacity: 1;
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

        #gg-meta-preview-popup .gg-meta-image {
            width: 100%;
            height: 140px; /* Fixed height */
            object-fit: cover;
            border-radius: 6px;
            margin-bottom: 8px;
            background: rgba(255,255,255,0.1); /* Placeholder bg */
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

    function updateResetDatabaseButtonVisibility() {
        const resetButton = document.getElementById('gg-reset-db');
        if (!resetButton) return;

        resetButton.style.display = getSettingsTokenValue() ? 'flex' : 'none';
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
        showBackdrop();
    }

    function showSettingsModal() {
        setElementDisplay('gg-settings-modal', 'block');
        setElementDisplay('gg-meta-modal', 'none');
        showBackdrop();
    }

    function hideMetaModal() {
        setElementDisplay('gg-meta-modal', 'none');
    }

    function hideSettingsModal() {
        setElementDisplay('gg-settings-modal', 'none');
    }

    function hideAllModals({ hideBackdropOverlay = true } = {}) {
        hideMetaModal();
        hideSettingsModal();
        if (hideBackdropOverlay) hideBackdrop();
    }

    function hidePreviewPopup() {
        const previewPopup = document.getElementById('gg-meta-preview-popup');
        if (previewPopup) previewPopup.classList.remove('gg-visible');
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
                    <label class="gg-form-label">Additional Settings</label>
                    <button class="gg-btn-secondary" id="gg-resize-window">Resize Window</button>
                </div>
                
                <hr class="gg-modal-divider">
                
                <button class="gg-btn-danger" id="gg-reset-db">Clear Own Data</button>
                
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
        settingsModal.querySelector('#gg-gh-token').addEventListener('input', updateResetDatabaseButtonVisibility);

        // MODAL
        const modal = document.createElement('div');
        modal.id = 'gg-meta-modal';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div id="meta-main-view" class="gg-modal-subview">
                <div class="gg-modal-header">Add metas to location</div>
                
                <div class="gg-form-group">
                    <input type="text" id="meta-search" class="gg-form-input" placeholder="Filter by country, title or tags (e.g. Kenya;snorkel)">
                </div>
                <div id="gg-existing-metas"></div>

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
            document.getElementById('gg-json-output').style.display = 'none';
            selectedMetaIds.clear();
            updateLinkSelectedBtn();
            renderExistingMetas(); // Populate existing metas list
        });

        document.getElementById('gg-settings-btn').addEventListener('click', () => {
            const token = localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || '';
            document.getElementById('gg-gh-token').value = token;
            updateResetDatabaseButtonVisibility();
            
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

             hideSettingsModal();
             hideBackdrop();
        });

        document.getElementById('gg-close-settings').addEventListener('click', () => {
            hideSettingsModal();
            hideBackdrop();
        });

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

        document.getElementById('gg-reset-db').addEventListener('click', async () => {
             if (confirm("ARE YOU SURE? This will DELETE your own metas and own location links from GitHub. Plonkit data will stay untouched.")) {
                 if (confirm("Really sure? Your own data will be lost.")) {
                     await resetDatabase();
                 }
             }
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

    function renderExistingMetas(searchTerm = '') {
        const container = document.getElementById('gg-existing-metas');
        if (!container) return;

        // Support multi-term search (split by ';')
        const terms = searchTerm.toLowerCase().split(';').map(s => s.trim()).filter(s => s);

        const filtered = metasData.filter(m => {
            if (terms.length === 0) return true;

            const searchableContent = [
                m.country || '',
                m.title || '',
                m.description || '',
                (m.tags || []).join(' ')
            ].join(' ').toLowerCase();

            // All terms must be present
            return terms.every(term => searchableContent.includes(term));
        });

        // Deduplicate by signature (Country+Title+Desc+Tags)
        const groups = new Map();
        filtered.forEach(m => {
             const tagsSig = (m.tags || []).slice().sort().join(',');
             const sig = `${m.country}|${m.title}|${m.description}|${tagsSig}`;
             if (!groups.has(sig)) groups.set(sig, []);
             groups.get(sig).push(m);
        });

        const uniqueFiltered = [];
        groups.forEach(group => {
             // If any meta in this group is currently selected, prefer showing it
             const selected = group.find(m => selectedMetaIds.has(m.id));
             uniqueFiltered.push(selected || group[0]);
        });
        
        if (uniqueFiltered.length === 0) {
            container.innerHTML = '<div class="gg-form-hint gg-list-empty-state">No metas found.</div>';
            return;
        }

        container.innerHTML = uniqueFiltered.map(m => {
            const isSelected = selectedMetaIds.has(m.id);
            const countryCode = getCountryCode(m.country);
            return `
                <div class="gg-meta-list-item" data-meta-id="${escapeAttribute(m.id)}">
                    <div class="gg-meta-list-main">
                        <span class="gg-country-badge" title="${escapeAttribute(m.country || 'Unknown Country')}">${escapeHtml(countryCode)}</span>
                        <div class="gg-meta-list-title">${escapeHtml(m.title)}</div>
                        <div class="gg-meta-list-tags">
                            ${renderStaticTags(m.tags)}
                        </div>
                    </div>
                    <button class="gg-btn-link-meta ${isSelected ? 'gg-tag-selected' : ''}" data-meta-id="${escapeAttribute(m.id)}">
                        ${isSelected ? 'Selected' : 'Link'}
                    </button>
                </div>
            `;
        }).join('');

        // Hover Preview Logic
        const previewPopup = document.getElementById('gg-meta-preview-popup');
        const modal = document.getElementById('gg-meta-modal');
        
        container.querySelectorAll('.gg-meta-list-item').forEach(item => {
            item.addEventListener('mouseenter', (e) => {
                const metaId = item.dataset.metaId;
                const meta = metasData.find(m => m.id === metaId);
                if (!meta || !previewPopup) return;
                
                // Populate
                previewPopup.innerHTML = `
                    <div class="gg-meta-item-title">${escapeHtml(meta.title)}</div>
                    ${renderMetaImage(meta.imageUrl)}
                    <div class="gg-meta-description">${escapeHtml(meta.description)}</div>
                    <div class="gg-meta-tags">
                        ${renderStaticTags(meta.tags)}
                    </div>
                `;

                // Position (Left of Modal)
                if (modal) {
                    const modalRect = modal.getBoundingClientRect();
                    const itemRect = item.getBoundingClientRect();
                    
                    // X: Left of modal - width - padding
                    const leftPos = modalRect.left - 290; // 280 width + 10 gap
                    
                    // Y: Center of hovered item
                    // But keep it within screen bounds? 
                    // Let's just center it on the item first.
                    // Pointer is in the middle of popup (50%), so we want popup center to trigger item center
                    const topPos = itemRect.top + (itemRect.height / 2) - (previewPopup.offsetHeight / 2);
                    
                    previewPopup.style.left = `${leftPos}px`;
                    // Check bounds to ensure we don't calculate before display (offsetHeight might be 0 if hidden?)
                    // Actually, we need to show it to measure it? Or just set top based on itemRect.top
                    // Let's set it visible first?
                    
                    previewPopup.classList.add('gg-visible');
                    
                    // Re-adjust top after rendering content
                    const height = previewPopup.offsetHeight;
                    const adjustedTop = itemRect.top + (itemRect.height / 2) - (height / 2);
                    previewPopup.style.top = `${adjustedTop}px`;
                }
            });

            item.addEventListener('mouseleave', () => {
                hidePreviewPopup();
            });
        });

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
        if (count > 0) {
            btn.style.display = 'block';
            btn.textContent = `Link Selected Metas (${count})`;
        } else {
            btn.style.display = 'none';
        }
    }

    async function linkMultipleMetas(metaIds) {
        const panoid = syncPanoidForUserAction('link metas');
        if (!panoid || panoid === MISSING_PANOID_PLACEHOLDER) {
            alert("No location detected! Please try on a game result screen.");
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
            
            // Clear selection and close
            selectedMetaIds.clear();
            hideMetaModal();
            hideBackdrop();
            return;
        }

        // Mode: Admin (Token) - Direct API commit
        // Note: Sequential operations used for simplicity logic
        updateStatus(`Linking ${metaIds.length} metas...`);
        
        try {
            const unknownMetaIds = metaIds.filter(id => !systemMetaIds.has(id) && !userMetaIds.has(id));

            if (unknownMetaIds.length > 0) {
                throw new Error(`Unknown meta IDs: ${unknownMetaIds.join(', ')}`);
            }

            const locationsFile = await getGitHubJsonFile(API_USER_LOCATIONS_URL, token);
            const locations = normalizeLocationMap(locationsFile.content);
            addMetaIdsToLocationMap(locations, panoid, metaIds);

            await putGitHubJsonFile(
                API_USER_LOCATIONS_URL,
                token,
                locationsFile.sha,
                locations,
                `Link ${metaIds.length} metas to ${panoid} via BetterMetas`
            );

            applyLocalLocationLinks(panoid, metaIds);
            updateStatus('Linked!');
            selectedMetaIds.clear();
            hideMetaModal();
            hideBackdrop();
            setTimeout(fetchLocationData, DATA_REFRESH_AFTER_SAVE_MS);
        } catch (e) {
            console.error(e);
            alert(`Error: ${e.message}`);
            updateStatus('Link Failed');
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
            alert('Please fill in Title and Description');
            return;
        }

        const panoid = syncPanoidForUserAction('save meta') || MISSING_PANOID_PLACEHOLDER;
        if (panoid === MISSING_PANOID_PLACEHOLDER) {
            alert("No location detected! Please try again on a game result screen.");
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
            tags: tags
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
            
            if (confirm("No GitHub Token found. Submit this as a Community Contribution via GitHub Issues?")) {
                window.open(issueUrl, '_blank');
                hideMetaModal();
            } else {
                 // Fallback to copy-paste
                output.textContent = "Token missing. Copy this:\n" + jsonStr;
                output.style.display = 'block';
            }
            return;
        }

        // Mode: Admin (Token)
        btn.disabled = true;
        btn.innerHTML = '<span class="gg-spinner"></span>Saving...';
        output.style.display = 'none';

        try {
            // 1. Fetch both user files
            updateStatus('Fetching user_metas.json...');
            const metasFile = await getGitHubJsonFile(API_USER_METAS_URL, token);
            
            updateStatus('Fetching user_locations.json...');
            const locsFile = await getGitHubJsonFile(API_USER_LOCATIONS_URL, token);

            const metas = normalizeUserMetas(metasFile.content);
            const locations = normalizeLocationMap(locsFile.content);

            // 2. Add meta to user_metas.json
            metas.push(newMeta);

            // 3. Link panoid in user_locations.json
            addMetaIdsToLocationMap(locations, panoid, [newMeta.id]);

            // 4. Commit user_metas.json
            updateStatus('Saving user_metas.json...');
            await putGitHubJsonFile(API_USER_METAS_URL, token, metasFile.sha, metas, `Add meta ${newMeta.id} via BetterMetas`);

            // 5. Commit user_locations.json
            updateStatus('Saving user_locations.json...');
            await putGitHubJsonFile(API_USER_LOCATIONS_URL, token, locsFile.sha, locations, `Link ${panoid} to ${newMeta.id} via BetterMetas`);

            applyLocalSavedMeta(newMeta, panoid);
            updateStatus('Saved!');
            btn.innerHTML = 'Saved!';
            setTimeout(() => {
                hideMetaModal();
                btn.innerHTML = META_SAVE_BUTTON_LABEL;
                btn.disabled = false;
                setTimeout(fetchLocationData, DATA_REFRESH_AFTER_SAVE_MS);
            }, SAVE_COMPLETE_RESET_MS);

        } catch (err) {
            console.error('Save error:', err);
            btn.innerHTML = 'Error';
            btn.disabled = false;
            output.textContent = `Error saving to GitHub:\n${err.message}\n\nBackup JSON:\n${stringifyJsonContent(submission)}`;
            output.style.display = 'block';
            alert(`Error: ${err.message}`);
        }
    }

    async function resetDatabase() {
        const token = getSettingsTokenValue();
        if (!token) {
            alert("No token saved. Cannot clear own data.");
            return;
        }
        
        updateStatus('Clearing own data...');
        const btn = document.getElementById('gg-reset-db');
        const origText = btn.innerText;
        btn.innerText = "Clearing Own Data...";
        btn.disabled = true;

        try {
            // 1. Get SHAs
            const metasSha = await getGitHubFileSha(API_USER_METAS_URL, token);
            const locsSha = await getGitHubFileSha(API_USER_LOCATIONS_URL, token);

            // 2. Overwrite with empty
            await putGitHubJsonFile(API_USER_METAS_URL, token, metasSha, [], "Clear own BetterMetas metas");
            await putGitHubJsonFile(API_USER_LOCATIONS_URL, token, locsSha, {}, "Clear own BetterMetas location links");

            alert("Own BetterMetas data cleared!");
            location.reload();

        } catch (e) {
            console.error(e);
            alert("Error clearing own data: " + e.message);
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

        const renderMeta = (m, isPredicted = false) => {
             // Predicted metas get a click handler for Quick Link
             const titleAttr = isPredicted 
                 ? `class="gg-clickable-meta-title" data-meta-id="${escapeAttribute(m.id)}" data-meta-title="${escapeAttribute(m.title)}" title="Click to Link to this Location"`
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
                    <span ${titleAttr}>${escapeHtml(m.title)}</span>
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
                win.quickLinkMeta(titleEl.dataset.metaId, titleEl.dataset.metaTitle || '');
            });
        });
    }



    // Expose Quick Link Function globally so the inline onclick works
    win.quickLinkMeta = function(metaId, title) {
        // Prevent accidental clicks? simple confirm
        if (confirm(`Link "${title}" to this location?`)) {
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
        return JSON.parse(decodeURIComponent(escape(window.atob((content || '').replace(/\n/g, "")))));
    }

    function encodeGitHubJsonContent(content) {
        return window.btoa(unescape(encodeURIComponent(stringifyJsonContent(content))));
    }

    function parseGitHubApiError(response) {
        let details = response.statusText;
        try {
            details = JSON.parse(response.responseText).message || details;
        } catch(e) {}
        return new Error(`GitHub API ${response.status}: ${details}`);
    }

    function githubApiRequest(url, token, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'Content-Type': 'application/json'
                },
                timeout: DATA_FETCH_TIMEOUT_MS,
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
                ontimeout: () => reject(new Error(`GitHub API request timed out: ${url}`))
            });
        });
    }

    async function getGitHubJsonFile(apiUrl, token) {
        const data = await githubApiRequest(getApiUrlForBranch(apiUrl), token);
        return { sha: data.sha, content: decodeGitHubJsonContent(data.content) };
    }

    async function getGitHubFileSha(apiUrl, token) {
        try {
            const data = await githubApiRequest(getApiUrlForBranch(apiUrl), token);
            return data.sha;
        } catch (e) {
            return null;
        }
    }

    async function putGitHubJsonFile(apiUrl, token, sha, content, message) {
        const body = {
            message,
            content: encodeGitHubJsonContent(content),
            branch: REPO_BRANCH
        };
        if (sha) body.sha = sha;
        return githubApiRequest(apiUrl, token, 'PUT', body);
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

    async function loadUserLocationsData(token) {
        if (token) {
            try {
                const locations = await fetchGitHubContentJson(API_USER_LOCATIONS_URL, token);
                console.log(`[BetterMetas] Loaded ${Object.keys(normalizeLocationMap(locations)).length} user location mappings from GitHub API.`);
                return normalizeLocationMap(locations);
            } catch (err) {
                console.warn('[BetterMetas] GitHub API user_locations fetch failed, falling back to raw:', err);
            }
        }

        const locations = await fetchRawJsonWithRetry(getRawUserLocationsUrl, 'user_locations.json', normalizeLocationMap, {}, { allowMissing: true });
        console.log(`[BetterMetas] Loaded ${Object.keys(locations).length} user location mappings from raw.`);
        return locations;
    }

    async function loadUserMetasData(token) {
        if (token) {
            try {
                const metas = await fetchGitHubContentJson(API_USER_METAS_URL, token);
                console.log(`[BetterMetas] Loaded ${normalizeUserMetas(metas).length} user metas from GitHub API.`);
                return normalizeUserMetas(metas);
            } catch (err) {
                console.warn('[BetterMetas] GitHub API user_metas fetch failed, falling back to raw:', err);
            }
        }

        const metas = await fetchRawJsonWithRetry(getRawUserMetasUrl, 'user_metas.json', normalizeUserMetas, [], { allowMissing: true });
        console.log(`[BetterMetas] Loaded ${metas.length} user metas from raw.`);
        return metas;
    }

    async function loadSystemLocationsData() {
        const locations = await fetchRawJsonWithRetry(getRawSystemLocationsUrl, 'plonkit_locations.json', normalizeLocationMap, {});
        console.log(`[BetterMetas] Loaded ${Object.keys(locations).length} system location mappings.`);
        return locations;
    }

    async function loadSystemMetasData() {
        const metas = await fetchRawJsonWithRetry(getRawSystemMetasUrl, 'plonkit_metas.json', value => normalizeSystemMetas(value), []);
        console.log(`[BetterMetas] Loaded ${metas.length} system metas.`);
        return metas;
    }


    // --- Data Fetching ---
    async function fetchLocationData() {
        console.log('[BetterMetas] Fetching data...');
        updateStatus(metasData.length > 0 ? 'Refreshing DB...' : 'Loading DB...');
        const token = getSettingsTokenValue();
        const loadId = ++dataLoadSequence;

        try {
            const [loadedUserLocationMap, loadedSystemLocationMap, loadedUserMetas, loadedSystemMetas] = await Promise.all([
                loadUserLocationsData(token),
                loadSystemLocationsData(),
                loadUserMetasData(token),
                loadSystemMetasData()
            ]);

            if (loadId !== dataLoadSequence) {
                console.log('[BetterMetas] Ignoring stale DB load result.');
                return;
            }

            const applied = applyDataSnapshot({
                userLocationMap: loadedUserLocationMap,
                systemLocationMap: loadedSystemLocationMap,
                userMetas: loadedUserMetas,
                systemMetas: loadedSystemMetas
            }, { prunePending: true });

            saveDataSnapshotCache({
                userLocationMap: loadedUserLocationMap,
                systemLocationMap: loadedSystemLocationMap,
                userMetas: loadedUserMetas,
                systemMetas: loadedSystemMetas
            });

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
                  // Exclude: HUD, Settings Modal, Add Meta Modal
                  if (!button.closest('#gg-meta-hud') &&
                      !button.closest('#gg-settings-modal') &&
                      !button.closest('#gg-meta-modal')) {
                       
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
