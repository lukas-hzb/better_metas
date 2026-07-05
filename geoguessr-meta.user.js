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
    const API_SYSTEM_LOCATIONS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${SYSTEM_LOCATIONS_FILE}`;
    const API_USER_METAS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${USER_METAS_FILE}`;
    const API_METAS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${USER_METAS_FILE}`; // Alias for reset
    const getApiUrlForBranch = (apiUrl) => `${apiUrl}?ref=${encodeURIComponent(REPO_BRANCH)}`;
    
    const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const HUD_SIZE_STORAGE_KEY = 'gg_hud_size';
    const PENDING_LOCAL_CHANGES_STORAGE_KEY = 'gg_pending_local_changes';
    const DEFAULT_HUD_WIDTH = '320px';
    const DEFAULT_HUD_HEIGHT = '75.6vh';

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

    function getLocationMetaIds(entry) {
        if (!entry) return [];
        if (Array.isArray(entry)) return entry;
        return Array.isArray(entry.metas) ? entry.metas : [];
    }

    function mergeLocationEntries(systemEntry, userEntry) {
        if (!systemEntry) return userEntry;
        if (!userEntry) return systemEntry;

        const systemEntryMetaIds = getLocationMetaIds(systemEntry);
        const userEntryMetaIds = getLocationMetaIds(userEntry);
        const mergedMetaIds = Array.from(new Set([...systemEntryMetaIds, ...userEntryMetaIds]));

        if (Array.isArray(systemEntry) && Array.isArray(userEntry)) {
            return mergedMetaIds;
        }

        const systemData = Array.isArray(systemEntry) ? { metas: systemEntryMetaIds } : { ...systemEntry };
        const userData = Array.isArray(userEntry) ? { metas: userEntryMetaIds } : { ...userEntry };
        return { ...systemData, ...userData, metas: mergedMetaIds };
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
            locations[panoid] = {
                metas: [],
                lat: currentLocationData.lat,
                lng: currentLocationData.lng,
                country: currentLocationData.country,
                nominatimCountry: currentLocationData.nominatimCountry,
                region: currentLocationData.region,
                city: currentLocationData.city,
                road: currentLocationData.road
            };
        } else if (Array.isArray(locations[panoid])) {
            locations[panoid] = {
                metas: locations[panoid],
                lat: currentLocationData.lat,
                lng: currentLocationData.lng,
                country: currentLocationData.country,
                nominatimCountry: currentLocationData.nominatimCountry,
                region: currentLocationData.region,
                city: currentLocationData.city,
                road: currentLocationData.road
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
    
    let currentPanoid = null;
    let selectedMetaIds = new Set();
    
    const ALL_SCOPES = ['countrywide', 'region', 'longitude', '1000km', '100km', '10km', '1km', 'road', 'unique'];
    let activeScopes = new Set(JSON.parse(localStorage.getItem('gg_active_scopes') || JSON.stringify(ALL_SCOPES)));
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
        road: null,
        lat: null,
        lng: null
    };



    // --- Styles ---
    const STYLES = `
        #gg-meta-hud {
            --gg-meta-divider-gap: 12px;

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
            min-width: 260px;
            min-height: 220px;
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
            margin-bottom: 8px; /* Spacing above status */
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
            background: #8cd45a; /* GeoGuessr Green */
            color: #fff;
            border-color: #3d8c2a;
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
        .gg-meta-item-title {
            font-size: 1.1rem;
            font-weight: 800;
            color: #fff;
            margin-bottom: 6px;
            line-height: 1.3;
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
            margin-top: 8px;
            font-style: normal;
            text-align: right;
        }

        /* Modal Spacing System */
        :root {
            --modal-spacing-xs: 8px;
            --modal-spacing-sm: 12px;
            --modal-spacing-md: 16px;
            --modal-spacing-lg: 24px;
            --modal-radius: 16px;
            --modal-btn-radius: 25px;
        }

        /* Modal Base Styles - GeoGuessr Native Style */
        #gg-meta-modal {
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
            z-index: 100000;
            max-height: 85vh;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.3) transparent;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            text-align: center;
            width: 550px;
            padding: var(--modal-spacing-lg);
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
            z-index: 100001;
            max-height: 85vh;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.3) transparent;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            text-align: center;
            width: 360px;
            padding: var(--modal-spacing-lg);
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
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(100, 90, 150, 0.4);
            color: white;
            border-radius: 8px;
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
            background: rgba(0, 0, 0, 0.4);
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

        /* Buttons - GeoGuessr Green Style */
        .gg-btn-primary {
            background: linear-gradient(180deg, #8cd45a 0%, #6cc04a 50%, #5ab840 100%);
            color: #fff;
            border: none;
            border-bottom: 2px solid #3d8c2a;
            padding: 10px 0; /* Consistent height */
            border-radius: 30px;
            cursor: pointer;
            width: 100%;
            font-weight: 800;
            font-size: 0.85rem;
            font-style: italic;
            text-transform: uppercase;
            letter-spacing: 0.03em;
            margin-top: 12px;
            transition: transform 0.1s, box-shadow 0.1s, border-bottom 0.1s;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
            box-sizing: border-box;
            height: 42px; /* Fixed height for consistency */
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
            border-bottom: 1px solid #3d8c2a;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
        }

        .gg-btn-secondary {
            background: rgba(0, 0, 0, 0.3);
            color: rgba(255, 255, 255, 0.7);
            border: 1px solid rgba(100, 90, 150, 0.4);
            padding: 10px 0;
            cursor: pointer;
            margin-top: 12px;
            width: 100%;
            font-size: 0.8rem;
            font-weight: 700;
            border-radius: 30px; /* Match primary button */
            transition: background 0.2s, color 0.2s;
            box-sizing: border-box;
            height: 42px; /* Fixed height for consistency */
            display: flex;
            align-items: center;
            justify-content: center;
            text-transform: uppercase; /* Match layout style */
            letter-spacing: 0.03em;
        }

        .gg-btn-secondary:hover {
            background: rgba(0, 0, 0, 0.4);
            color: #fff;
        }

        .gg-btn-danger {
            background: transparent;
            color: #f97316;
            border: 2px solid #f97316;
            padding: 10px 0;
            border-radius: 30px; /* Match primary button */
            cursor: pointer;
            width: 100%;
            font-size: 0.8rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            transition: background 0.2s, color 0.2s;
            box-sizing: border-box;
            height: 42px; /* Fixed height for consistency */
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .gg-btn-danger:hover {
            background: rgba(249, 115, 22, 0.15);
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
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(100, 90, 150, 0.4);
            border-radius: 8px;
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

        .gg-meta-list-item:last-child {
            border-bottom: none;
        }

        .gg-meta-list-title {
            font-size: 0.8rem;
            font-weight: 600;
            color: #fff;
        }

        .gg-meta-list-tags {
            font-size: 0.65rem;
            color: rgba(255,255,255,0.4);
            margin-top: 2px;
        }

        .gg-btn-link-meta {
            background: linear-gradient(180deg, #8cd45a 0%, #6cc04a 50%, #5ab840 100%);
            color: #fff;
            border: none;
            border-bottom: 2px solid #3d8c2a;
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
            border-bottom: 1px solid #3d8c2a;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        }

        /* JSON Output */
        #gg-json-output {
            margin-top: 12px;
            background: rgba(0, 0, 0, 0.4);
            padding: 10px;
            border-radius: 8px;
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
        document.head.appendChild(style);
    }

    function getSavedHudSize() {
        try {
            const savedSize = JSON.parse(localStorage.getItem(HUD_SIZE_STORAGE_KEY) || 'null');
            if (
                savedSize &&
                Number.isFinite(savedSize.width) &&
                Number.isFinite(savedSize.height) &&
                savedSize.width >= 260 &&
                savedSize.height >= 220
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
        return (tokenInput?.value || localStorage.getItem('gg_gh_token') || '').trim();
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

        if (Array.isArray(value.metas)) {
            normalized.metas = value.metas.filter(meta => meta && meta.id);
        }

        if (value.locations && typeof value.locations === 'object' && !Array.isArray(value.locations)) {
            normalized.locations = value.locations;
        }

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
                <div class="gg-normal-controls" style="display:flex; align-items:center;">
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
            <div id="gg-location-info" style="display:none;">
                <!-- Filled by JS -->
            </div>

            <div id="gg-meta-container" class="gg-meta-content">
                <div style="color: #ccc; font-style: italic;">Waiting for location...</div>
            </div>
            <div id="gg-status" class="gg-status-msg" style="cursor:pointer;" title="Click to retry finding location">Waiting for location...</div>
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
                previewPopup.classList.remove('gg-visible');
            }
        });

        // SETTINGS MODAL
        const settingsModal = document.createElement('div');
        settingsModal.id = 'gg-settings-modal';
        settingsModal.style.display = 'none';
        settingsModal.innerHTML = `
            <div class="gg-modal-container">
                <div class="gg-modal-header">Settings</div>
                
                <div class="gg-form-group" style="margin-bottom: 16px;">
                    <label class="gg-form-label">Scope Filter</label>
                    <div id="gg-settings-scope-filter" style="display: flex; flex-wrap: wrap; justify-content: center; margin-top: 8px;">
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
                    <button class="gg-btn-secondary" id="gg-resize-window" style="margin-top: 8px;">Resize Window</button>
                </div>
                
                <hr class="gg-modal-divider">
                
                <button class="gg-btn-danger" id="gg-reset-db">Clear Own Data</button>
                
                <button class="gg-btn-primary" id="gg-save-settings" style="margin-top: 16px;">Save Changes</button>
                
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

                <div id="gg-selection-actions" style="margin-top: 10px;">
                    <button class="gg-btn-primary" id="gg-link-selected-btn" style="display: none; width: 100%; margin-bottom: 10px; background: linear-gradient(180deg, #8cd45a 0%, #6cc04a 50%, #5ab840 100%);">
                        Link Selected Metas (0)
                    </button>
                </div>

                <hr class="gg-modal-divider">

                <div>
                    <button class="gg-btn-primary" id="meta-details-btn" style="margin-top: 0;">
                        Add another meta
                    </button>
                </div>

                <div id="gg-json-output"></div>

                <button class="gg-btn-secondary" id="meta-close-btn">Close</button>
            </div>

            <div id="meta-details-view" class="gg-modal-subview gg-hidden">
                <div class="gg-modal-header" style="position: relative; display: flex; align-items: center; justify-content: center;">
                    <button id="meta-back-btn" style="background:none; border:none; color:rgba(255,255,255,0.5); cursor:pointer; position:absolute; left:0; display: flex; align-items: center; padding: 0;">
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
                    <input type="text" id="meta-scope" class="gg-form-input" style="display:none;">
                    <div id="meta-scope-presets" style="margin-top: 8px; text-align: center;">
                        <span class="gg-tag-pill" data-value="countrywide">Countrywide</span>
                        <span class="gg-tag-pill" data-value="region">Region</span>
                        <span class="gg-tag-pill" data-value="city">City</span>
                        <span class="gg-tag-pill" data-value="road">Road</span>
                        <span class="gg-tag-pill" data-value="1000km">1000km</span>
                        <span class="gg-tag-pill" data-value="100km">100km</span>
                        <span class="gg-tag-pill" data-value="10km">10km</span>
                        <span class="gg-tag-pill" data-value="1km">1km</span>
                        <span class="gg-tag-pill" data-value="unique">Unique</span>
                    </div>
                </div>

                <div class="gg-form-group">
                    <label class="gg-form-label">Tags</label>
                    <!-- Input hidden, using pills only -->
                    <input type="text" id="meta-tags" class="gg-form-input" placeholder="" style="display:none;">
                    <div id="meta-tag-presets" style="margin-top: 8px; text-align: center;">
                        <span class="gg-tag-pill">plants</span>
                        <span class="gg-tag-pill">bollards</span>
                        <span class="gg-tag-pill">poles</span>
                        <span class="gg-tag-pill">signs</span>
                        <span class="gg-tag-pill">plates</span>
                        <span class="gg-tag-pill">cars</span>
                        <span class="gg-tag-pill">soil</span>
                        <span class="gg-tag-pill">structures</span>
                        <span class="gg-tag-pill">road</span>
                        <span class="gg-tag-pill">camera</span>
                        <span class="gg-tag-pill">language</span>
                        <span class="gg-tag-pill">architecture</span>
                    </div>
                </div>

                <button class="gg-btn-primary" id="meta-generate-btn">Save Meta</button>
            </div>
        `;

        // Presets Logic (Multi-select)
        const presetContainer = modal.querySelector('#meta-tag-presets');
        
        const updateHiddenInput = () => {
            const selected = Array.from(presetContainer.querySelectorAll('.gg-tag-selected'))
                                  .map(el => el.textContent.trim());
            document.getElementById('meta-tags').value = selected.join(', ');
        };

        presetContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('gg-tag-pill')) {
                e.target.classList.toggle('gg-tag-selected');
                updateHiddenInput();
            }
        });

        // Scope Logic (Single-select)
        const scopeContainer = modal.querySelector('#meta-scope-presets');
        
        scopeContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('gg-tag-pill')) {
                // Deselect all others
                Array.from(scopeContainer.querySelectorAll('.gg-tag-pill')).forEach(el => {
                   if (el !== e.target) el.classList.remove('gg-tag-selected');
                });
                
                // Toggle clicked
                const wasSelected = e.target.classList.contains('gg-tag-selected');
                if (!wasSelected) {
                    e.target.classList.add('gg-tag-selected');
                } else {
                    e.target.classList.remove('gg-tag-selected');
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
            document.getElementById('gg-meta-modal').style.display = 'block';
            document.getElementById('gg-settings-modal').style.display = 'none'; // Close settings
            document.getElementById('gg-modal-backdrop').classList.add('gg-visible');
            document.getElementById('meta-main-view').classList.remove('gg-hidden');
            document.getElementById('meta-details-view').classList.add('gg-hidden');
            document.getElementById('gg-json-output').style.display = 'none';
            selectedMetaIds.clear();
            updateLinkSelectedBtn();
            renderExistingMetas(); // Populate existing metas list
        });

        document.getElementById('gg-settings-btn').addEventListener('click', () => {
            const token = localStorage.getItem('gg_gh_token') || '';
            document.getElementById('gg-gh-token').value = token;
            updateResetDatabaseButtonVisibility();
            
            // Render Scope Filter
            const scopeContainer = document.getElementById('gg-settings-scope-filter');
            scopeContainer.innerHTML = ALL_SCOPES.map(scope => {
                const isActive = activeScopes.has(scope);
                const label = scope.charAt(0).toUpperCase() + scope.slice(1);
                return `<span class="gg-tag-pill ${isActive ? 'gg-tag-selected' : ''}" data-value="${scope}" style="cursor:pointer; margin:3px;">${label}</span>`;
            }).join('');

            // Add listeners
            scopeContainer.querySelectorAll('.gg-tag-pill').forEach(pill => {
                pill.addEventListener('click', (e) => {
                    // Only toggle UI state, do NOT save yet
                    e.target.classList.toggle('gg-tag-selected');
                });
            });

            document.getElementById('gg-settings-modal').style.display = 'block';
            document.getElementById('gg-meta-modal').style.display = 'none'; // Close meta modal
            const previewPopup = document.getElementById('gg-meta-preview-popup');
            if (previewPopup) previewPopup.classList.remove('gg-visible');
            document.getElementById('gg-modal-backdrop').classList.add('gg-visible');
        });

        document.getElementById('gg-save-settings').addEventListener('click', () => {
             const token = document.getElementById('gg-gh-token').value.trim();
             
             // Save Token
             if (token) {
                 localStorage.setItem('gg_gh_token', token);
             } else if (localStorage.getItem('gg_gh_token')) {
                 // If field is empty but we had one, do we clear it? 
                 // Current logic implies empty field = no change if we don't want to clear.
                 // But typically empty input means user wants to clear if they deleted it.
                 // Let's stick to existing behavior or safest approach:
                 // If user explicitly clears it, maybe they want to clear it?
                 // For now, let's assume they might.
                 localStorage.setItem('gg_gh_token', ''); 
             }

             // Save Scopes from UI state
             const scopeContainer = document.getElementById('gg-settings-scope-filter');
             const selectedFromUI = Array.from(scopeContainer.querySelectorAll('.gg-tag-pill.gg-tag-selected'))
                                         .map(el => el.dataset.value);
             
             activeScopes = new Set(selectedFromUI);
             localStorage.setItem('gg_active_scopes', JSON.stringify(Array.from(activeScopes)));
             
             // Refresh HUD
             if (currentPanoid) refreshDisplay();

             document.getElementById('gg-settings-modal').style.display = 'none';
             document.getElementById('gg-modal-backdrop').classList.remove('gg-visible');
        });

        document.getElementById('gg-close-settings').addEventListener('click', () => {
             document.getElementById('gg-settings-modal').style.display = 'none';
            document.getElementById('gg-modal-backdrop').classList.remove('gg-visible');
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

            document.getElementById('gg-settings-modal').style.display = 'none';
            document.getElementById('gg-meta-modal').style.display = 'none';
            document.getElementById('gg-modal-backdrop').classList.remove('gg-visible');

            const previewPopup = document.getElementById('gg-meta-preview-popup');
            if (previewPopup) previewPopup.classList.remove('gg-visible');

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
                const width = Math.min(maxWidth, Math.max(260, startSize.width + moveEvent.clientX - startX));
                const height = Math.min(maxHeight, Math.max(220, startSize.height + moveEvent.clientY - startY));

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
            document.getElementById('gg-meta-modal').style.display = 'none';
            document.getElementById('gg-modal-backdrop').classList.remove('gg-visible');
            const previewPopup = document.getElementById('gg-meta-preview-popup');
            if (previewPopup) previewPopup.classList.remove('gg-visible');
        });

        // Close when clicking backdrop
        document.getElementById('gg-link-selected-btn').addEventListener('click', () => {
            if (selectedMetaIds.size > 0) {
                linkMultipleMetas(Array.from(selectedMetaIds));
            }
        });

        backdrop.addEventListener('click', () => {
            document.getElementById('gg-meta-modal').style.display = 'none';
            document.getElementById('gg-settings-modal').style.display = 'none';
            backdrop.classList.remove('gg-visible');
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
            'us minor outlying islands': 'UM', 'us virgin islands': 'VI', 'uganda': 'UG', 'ukraine': 'UA',
            'united arab emirates': 'AE', 'united kingdom': 'GB', 'united states of america': 'US',
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
            container.innerHTML = '<div class="gg-form-hint" style="padding:8px 0;">No metas found.</div>';
            return;
        }

        container.innerHTML = uniqueFiltered.map(m => {
            const isSelected = selectedMetaIds.has(m.id);
            const countryCode = getCountryCode(m.country);
            return `
                <div class="gg-meta-list-item" data-meta-id="${m.id}">
                    <div style="display: flex; align-items: center; gap: 4px; flex: 1; overflow: hidden; height: 100%;">
                        <span class="gg-country-badge" title="${m.country || 'Unknown Country'}">${countryCode}</span>
                        <div class="gg-meta-list-title" style="white-space: nowrap; line-height: 1; overflow: hidden; text-overflow: ellipsis; padding: 0 4px; flex-shrink: 0;">${m.title}</div>
                        <div class="gg-meta-list-tags" style="display: flex; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none; height: 100%; flex: 1;">
                            ${(m.tags || []).map(t => `<span class="gg-tag-static">${t}</span>`).join('')}
                        </div>
                    </div>
                    <button class="gg-btn-link-meta ${isSelected ? 'gg-tag-selected' : ''}" data-meta-id="${m.id}" style="${isSelected ? 'background: #8cd45a; border-color: #3d8c2a;' : ''}">
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
                    <div class="gg-meta-item-title">${meta.title}</div>
                    ${meta.imageUrl ? `<img src="${meta.imageUrl}" class="gg-meta-image">` : ''}
                    <div class="gg-meta-description">${meta.description}</div>
                    <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">
                        ${(meta.tags || []).map(t => `<span class="gg-tag-static" style="font-size: 0.6rem; padding: 1px 4px; margin: 0;">${t}</span>`).join('')}
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
                if (previewPopup) previewPopup.classList.remove('gg-visible');
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
        if (!panoid || panoid === "YOUR_PANOID_HERE") {
            alert("No location detected! Please try on a game result screen.");
            return;
        }

        const token = localStorage.getItem('gg_gh_token');
        if (!token) {
            // Mode: Community (No Token) - Submit via GitHub Issue
            const submission = { 
                action: "link_metas",
                panoid: panoid, 
                metaIds: metaIds,
                targetFiles: {
                    userLocations: metaIds
                },
                lat: currentLocationData.lat,
                lng: currentLocationData.lng,
                country: currentLocationData.country,
                nominatimCountry: currentLocationData.nominatimCountry,
                region: currentLocationData.region,
                road: currentLocationData.road
            };
            const jsonStr = JSON.stringify(submission, null, 2);
            const repo = `${REPO_OWNER}/${REPO_NAME}`;
            const issueTitle = encodeURIComponent(`[Meta Submission] ${panoid.substring(0,15)} (Multi-Link)`);
            const body = encodeURIComponent(`## Link Multiple Metas\n\n\`\`\`json\n${jsonStr}\n\`\`\`\n\n_(Automated submission via BetterMetas Script)_`);
            const issueUrl = `https://github.com/${repo}/issues/new?title=${issueTitle}&body=${body}`;
            window.open(issueUrl, '_blank');
            
            // Clear selection and close
            selectedMetaIds.clear();
            document.getElementById('gg-meta-modal').style.display = 'none';
            document.getElementById('gg-modal-backdrop').classList.remove('gg-visible');
            return;
        }

        // Mode: Admin (Token) - Direct API commit
        // Note: Sequential operations used for simplicity logic
        updateStatus(`Linking ${metaIds.length} metas...`);
        
        try {
            // Helper for GitHub API via GM_xmlhttpRequest
            const ghAPI = (url, method = 'GET', body = null) => {
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
                        data: body ? JSON.stringify(body) : null,
                        onload: (res) => {
                            if (res.status >= 200 && res.status < 300) {
                                try {
                                    const data = JSON.parse(res.responseText);
                                    resolve(data);
                                } catch(e) { resolve(res.responseText); }
                            } else {
                                let details = res.statusText;
                                try {
                                    details = JSON.parse(res.responseText).message || details;
                                } catch(e) {}
                                reject(new Error(`GitHub API ${res.status}: ${details}`));
                            }
                        },
                        onerror: (err) => reject(err)
                    });
                });
            };

            const unknownMetaIds = metaIds.filter(id => !systemMetaIds.has(id) && !userMetaIds.has(id));

            if (unknownMetaIds.length > 0) {
                throw new Error(`Unknown meta IDs: ${unknownMetaIds.join(', ')}`);
            }

            const data = await ghAPI(getApiUrlForBranch(API_USER_LOCATIONS_URL));
            const locations = JSON.parse(decodeURIComponent(escape(window.atob(data.content.replace(/\n/g, "")))));
            addMetaIdsToLocationMap(locations, panoid, metaIds);

            const contentBase64 = window.btoa(unescape(encodeURIComponent(JSON.stringify(locations, null, 2))));
            await ghAPI(API_USER_LOCATIONS_URL, 'PUT', {
                message: `Link ${metaIds.length} metas to ${panoid} via BetterMetas`,
                content: contentBase64,
                sha: data.sha,
                branch: REPO_BRANCH
            });

            applyLocalLocationLinks(panoid, metaIds);
            updateStatus('Linked!');
            selectedMetaIds.clear();
            document.getElementById('gg-meta-modal').style.display = 'none';
            document.getElementById('gg-modal-backdrop').classList.remove('gg-visible');
            setTimeout(fetchLocationData, 2500);
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
        const tags = tagsStr.split(',').map(t => t.trim()).filter(t => t);
        const imageUrl = document.getElementById('meta-image').value;
        const scope = document.getElementById('meta-scope').value;
        
        if (!title || !desc) {
            alert('Please fill in Title and Description');
            return;
        }

        const panoid = syncPanoidForUserAction('save meta') || "YOUR_PANOID_HERE";
        if (panoid === "YOUR_PANOID_HERE") {
            alert("No location detected! Please try again on a game result screen.");
            return;
        }

        // Generate unique meta ID
        const metaId = `meta_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

        const newMeta = {
            id: metaId,
            country: currentLocationData.country || "Unknown",
            nominatimCountry: currentLocationData.nominatimCountry || null,
            region: currentLocationData.region || null,
            city: currentLocationData.city || null,
            road: currentLocationData.road || null,
            lat: currentLocationData.lat,
            lng: currentLocationData.lng,
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
        const token = localStorage.getItem('gg_gh_token');
        
        // Mode: Community (No Token)
        if (!token) {
            const jsonStr = JSON.stringify(submission, null, 2);
            
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
                document.getElementById('gg-meta-modal').style.display = 'none';
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
            // Helper for GitHub API via GM_xmlhttpRequest
            const ghAPI = (url, method = 'GET', body = null) => {
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
                        data: body ? JSON.stringify(body) : null,
                        onload: (res) => {
                            if (res.status >= 200 && res.status < 300) {
                                try {
                                    const data = JSON.parse(res.responseText);
                                    resolve(data);
                                } catch(e) { resolve(res.responseText); }
                            } else {
                                let details = res.statusText;
                                try {
                                    details = JSON.parse(res.responseText).message || details;
                                } catch(e) {}
                                reject(new Error(`GitHub API ${res.status}: ${details}`));
                            }
                        },
                        onerror: (err) => reject(err)
                    });
                });
            };

            const getFile = async (apiUrl) => {
                const data = await ghAPI(getApiUrlForBranch(apiUrl));
                const content = decodeURIComponent(escape(window.atob(data.content.replace(/\n/g, ""))));
                return { sha: data.sha, content: JSON.parse(content) };
            };

            const putFile = async (apiUrl, sha, content, message) => {
                const contentBase64 = window.btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2))));
                return await ghAPI(apiUrl, 'PUT', { message, content: contentBase64, sha, branch: REPO_BRANCH });
            };

            // 1. Fetch both user files
            updateStatus('Fetching user_metas.json...');
            const metasFile = await getFile(API_USER_METAS_URL);
            
            updateStatus('Fetching user_locations.json...');
            const locsFile = await getFile(API_USER_LOCATIONS_URL);

            // 2. Add meta to user_metas.json
            metasFile.content.push(newMeta);

            // 3. Link panoid in user_locations.json
            addMetaIdsToLocationMap(locsFile.content, panoid, [newMeta.id]);

            // 4. Commit user_metas.json
            updateStatus('Saving user_metas.json...');
            await putFile(API_USER_METAS_URL, metasFile.sha, metasFile.content, `Add meta ${newMeta.id} via BetterMetas`);

            // 5. Commit user_locations.json
            updateStatus('Saving user_locations.json...');
            await putFile(API_USER_LOCATIONS_URL, locsFile.sha, locsFile.content, `Link ${panoid} to ${newMeta.id} via BetterMetas`);

            applyLocalSavedMeta(newMeta, panoid);
            updateStatus('Saved!');
            btn.innerHTML = 'Saved!';
            setTimeout(() => {
                document.getElementById('gg-meta-modal').style.display = 'none';
                btn.innerHTML = 'Generate JSON';
                btn.disabled = false;
                setTimeout(fetchLocationData, 2500);
            }, 1000);

        } catch (err) {
            console.error('Save error:', err);
            btn.innerHTML = 'Error';
            btn.disabled = false;
            output.textContent = `Error saving to GitHub:\n${err.message}\n\nBackup JSON:\n${JSON.stringify(submission, null, 2)}`;
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
             // Helper for GitHub API
             const ghAPI = (url, method = 'GET', body = null) => {
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
                        data: body ? JSON.stringify(body) : null,
                        onload: (res) => {
                            if (res.status >= 200 && res.status < 300) {
                                try {
                                    const data = JSON.parse(res.responseText);
                                    resolve(data);
                                } catch(e) { resolve(res.responseText); }
                            } else {
                                let details = res.statusText;
                                try {
                                    details = JSON.parse(res.responseText).message || details;
                                } catch(e) {}
                                reject(new Error(`GitHub API ${res.status}: ${details}`));
                            }
                        },
                        onerror: (err) => reject(err)
                    });
                });
            };

            const getSha = async (apiUrl) => {
                try {
                    const data = await ghAPI(getApiUrlForBranch(apiUrl));
                    return data.sha;
                } catch (e) { return null; }
            };

            const putFile = async (apiUrl, sha, content, message) => {
                const contentBase64 = window.btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2))));
                const body = { message, content: contentBase64, branch: REPO_BRANCH };
                if (sha) body.sha = sha;
                return await ghAPI(apiUrl, 'PUT', body);
            };

            // 1. Get SHAs
            const metasSha = await getSha(API_METAS_URL);
            const locsSha = await getSha(API_USER_LOCATIONS_URL);

            // 2. Overwrite with empty
            await putFile(API_METAS_URL, metasSha, [], "Clear own BetterMetas metas");
            await putFile(API_USER_LOCATIONS_URL, locsSha, {}, "Clear own BetterMetas location links");

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
            container.innerHTML = '<div style="opacity:0.6; font-style:italic;">No active hints for this location.</div>';
            return;
        }

        const renderMeta = (m, isPredicted = false) => {
             // Predicted metas get a click handler for Quick Link
             const titleAttr = isPredicted 
                 ? `onclick="window.quickLinkMeta('${m.id}', '${m.title.replace(/'/g, "\\'")}')" style="cursor:pointer;" title="Click to Link to this Location"`
                 : '';
             
             // Badge logic
             let badge = '';
             if (isPredicted) {
                 // Predicted badge - Styled EXACTLY like Linked but Grey
                 badge = '<span style="font-size: 0.65rem; background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.2); padding: 0px 6px; border-radius: 4px; margin-left: 8px; vertical-align: middle; color: rgba(255,255,255,0.7); font-weight: 700;">PREDICTED</span>';
             } else {
                 // Linked badge - Styled with Green to match theme
                 badge = '<span style="font-size: 0.65rem; background: rgba(140, 212, 90, 0.15); border: 1px solid rgba(140, 212, 90, 0.4); padding: 0px 6px; border-radius: 4px; margin-left: 8px; vertical-align: middle; color: #8cd45a; font-weight: 700;">LINKED</span>';
             }

             return `
            <div class="gg-meta-row" ${isPredicted ? 'style="border-left: 2px solid rgba(255,255,255,0.2); padding-left: 10px; margin-left: -12px;"' : ''}>
                <div class="gg-meta-item-title">
                    <span ${titleAttr}>${m.title}</span>
                    ${badge}
                </div>
                ${m.imageUrl ? `<img src="${m.imageUrl}" class="gg-meta-image">` : ''}
                <div class="gg-meta-description">${m.description}</div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; margin-left: 1px;">${m.tags.map(t => `<span class="gg-tag-static" style="margin-right: 0;">${t}</span>`).join('')}</div>
            </div>
            `;
        };

        const exactHtml = (metas || []).map(m => renderMeta(m, false)).join('');
        const predictedHtml = (predicted || []).map(m => renderMeta(m, true)).join('');

        container.innerHTML = exactHtml + predictedHtml;
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
            const scope = (m.scope || 'countrywide').toLowerCase();
            const s = scope === '' ? 'countrywide' : scope;
            return activeScopes.has(s);
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
        setTimeout(() => readPanoidFromStreetView(instance, `${reason} settled`), 500);
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
        const s = (scope || '').toLowerCase();
        if (s === '1km') return 1;
        if (s === '10km') return 10;
        if (s === '25km') return 25;
        if (s === '50km') return 50;
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
        "France": (lat, lng) => {
            // Reunion Check
            if (lat < -19 && lat > -22 && lng > 54 && lng < 57) return "Reunion";
            return "France";
        },
        "China": (lat, lng) => {
            // Hong Kong / Macau Check
            if (lat > 22 && lat < 23 && lng > 113.8 && lng < 114.5) return "Hong Kong";
            if (lat > 22 && lat < 22.3 && lng > 113.5 && lng < 113.6) return "Macau";
            return "China";
        },
        "United States": "USA",
        "United Kingdom": "UK",
        "Virgin Islands, U.S.": "US Virgin Islands",
        "United Arab Emirates": "UAE"
    };

    function normalizeCountry(name, lat, lng) {
        if (!name) return "Unknown";
        let target = name;
        if (COUNTRY_ALIAS_MAP[name]) {
            const mapping = COUNTRY_ALIAS_MAP[name];
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
        const curLat = parseFloat(currentLocationData.lat);
        const curLng = parseFloat(currentLocationData.lng);
        const curCountry = normalizeCountry(currentLocationData.country, curLat, curLng);
        const curNomCountry = normalizeCountry(currentLocationData.nominatimCountry, curLat, curLng);
        const curRegion = currentLocationData.region;
        const curCity = currentLocationData.city;
        const curRoad = (currentLocationData.road || '').toLowerCase().trim();
        
        const curRoads = [];
        if (currentLocationData.road) {
            if (Array.isArray(currentLocationData.road)) {
                currentLocationData.road.forEach(r => curRoads.push(r.toLowerCase().trim()));
            } else {
                curRoads.push(String(currentLocationData.road).toLowerCase().trim());
            }
        }

        if (isNaN(curLat) || isNaN(curLng)) return [];

        const matchedMetaIds = new Set();
        const matches = [];

        // Helper: Check meta match against location
        const checkMatch = (scope, entryLat, entryLng, entryCountry, entryRegion, entryCity, entryRoads) => {
             scope = (scope || '').toLowerCase();
             
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
            const eLat = entry.lat ? parseFloat(entry.lat) : null;
            const eLng = entry.lng ? parseFloat(entry.lng) : null;
            const eCountry = normalizeCountry(entry.country, eLat, eLng); 
            // entry.nominatimCountry might exist
            const finalECountry = normalizeCountry(entry.nominatimCountry || eCountry, eLat, eLng);
            
            const eRegion = entry.region;
            const eCity = entry.city; // New field, might be undefined in old entries
            
            const eRoads = [];
            if (entry.road) {
                if (Array.isArray(entry.road)) {
                    entry.road.forEach(r => eRoads.push(String(r).toLowerCase().trim()));
                } else {
                    eRoads.push(String(entry.road).toLowerCase().trim());
                }
            }

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
             const mLat = meta.lat ? parseFloat(meta.lat) : null;
             const mLng = meta.lng ? parseFloat(meta.lng) : null;
             const mCountry = normalizeCountry(meta.country, mLat, mLng);
             const mRegion = meta.region;
             const mCity = meta.city;
             const mRoads = [];
             if (meta.road) {
                 if (Array.isArray(meta.road)) {
                     meta.road.forEach(r => mRoads.push(String(r).toLowerCase().trim()));
                 } else {
                     mRoads.push(String(meta.road).toLowerCase().trim());
                 }
             }

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
        
        // Sticky True: Return true if we saw it recently (500ms grace period)
        return visible || (Date.now() - lastResultSeenTime < 500);
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
                setTimeout(() => extractLocationData(attempt + 1), 500);
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
        }, 500); 
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
        
        if (!lat || !lng) {
            console.log('[BetterMetas] updateLocationUI: Missing lat/lng, hiding box.');
            box.style.display = 'none';
            return;
        }

        box.innerHTML = `
            <div class="gg-loc-row">
                <div class="gg-loc-label">Address:</div>
                <div class="gg-loc-val">${address || 'N/A'}</div>
            </div>
             <div class="gg-loc-row">
                <div class="gg-loc-label">Country:</div>
                <div class="gg-loc-val" style="color: #8cd45a;">${country || 'N/A'}</div>
            </div>
            ${region ? `
            <div class="gg-loc-row">
                <div class="gg-loc-label">Region:</div>
                <div class="gg-loc-val">${region}</div>
            </div>` : ''}
            ${currentLocationData.city ? `
            <div class="gg-loc-row">
                <div class="gg-loc-label">City:</div>
                <div class="gg-loc-val">${currentLocationData.city}</div>
            </div>` : ''}
            ${road ? `
            <div class="gg-loc-row">
                <div class="gg-loc-label">Road:</div>
                <div class="gg-loc-val">${Array.isArray(road) ? road.join(', ') : road}</div>
            </div>` : ''}
        `;
        box.style.display = 'block';
    }




    function decodeGitHubJsonContent(content) {
        return JSON.parse(decodeURIComponent(escape(window.atob((content || '').replace(/\n/g, "")))));
    }

    function fetchGitHubContentJson(apiUrl, token) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: getApiUrlForBranch(apiUrl),
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                onload: function(response) {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            const data = JSON.parse(response.responseText);
                            resolve(decodeGitHubJsonContent(data.content));
                        } catch (e) {
                            reject(e);
                        }
                    } else {
                        let details = response.statusText;
                        try {
                            details = JSON.parse(response.responseText).message || details;
                        } catch (e) {}
                        reject(new Error(`GitHub API ${response.status}: ${details}`));
                    }
                },
                onerror: reject
            });
        });
    }


    // --- Data Fetching ---
    function fetchLocationData() {
        console.log('[BetterMetas] Fetching data...');
        updateStatus('Loading DB...');
        const token = getSettingsTokenValue();

        let userLocLoaded = false;
        let systemLocLoaded = false;
        let userMetasLoaded = false;
        let systemMetasLoaded = false;

        let tempUserMetas = [];
        let tempSystemMetas = [];

        // Fetch User Locations Map
        loadUserLocations();

        // Fetch System Locations Map (Plonkit links)
        GM_xmlhttpRequest({
            method: "GET",
            url: getRawSystemLocationsUrl(),
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        systemLocationMap = JSON.parse(response.responseText);
                        console.log(`[BetterMetas] Loaded ${Object.keys(systemLocationMap).length} system location mappings.`);
                        systemLocLoaded = true;
                        checkAllLoaded();
                    } catch (e) {
                        console.error('[BetterMetas] Error parsing plonkit_locations.json:', e);
                        useFallback("System Locations Parse Error");
                    }
                } else {
                    console.warn('[BetterMetas] System locations file missing, continuing without Plonkit location links.');
                    systemLocationMap = {};
                    systemLocLoaded = true;
                    checkAllLoaded();
                }
            },
            onerror: function(err) {
                console.error('[BetterMetas] System locations request error:', err);
                useFallback("Network Error (System Locations)");
            }
        });

        // Fetch User Metas Collection
        loadUserMetas();

        // Fetch System Metas Collection (Plonkit)
        GM_xmlhttpRequest({
            method: "GET",
            url: getRawSystemMetasUrl(),
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        const rawData = JSON.parse(response.responseText);
                        tempSystemMetas = [];
                        rawData.forEach(countryObj => {
                            if (countryObj.metas) {
                                tempSystemMetas.push(...countryObj.metas);
                            }
                        });
                        console.log(`[BetterMetas] Loaded ${tempSystemMetas.length} system metas.`);
                        systemMetasLoaded = true;
                        checkAllLoaded();
                    } catch (e) {
                        console.error('[BetterMetas] Error parsing plonkit_metas.json:', e);
                        useFallback("System Metas Parse Error");
                    }
                } else {
                    console.error('[BetterMetas] Failed to fetch system metas:', response.statusText);
                    useFallback("System Metas 404");
                }
            }
        });

        function loadUserLocations() {
            if (token) {
                fetchGitHubContentJson(API_USER_LOCATIONS_URL, token)
                    .then(locations => {
                        userLocationMap = locations && typeof locations === 'object' && !Array.isArray(locations) ? locations : {};
                        console.log(`[BetterMetas] Loaded ${Object.keys(userLocationMap).length} user location mappings from GitHub API.`);
                        userLocLoaded = true;
                        checkAllLoaded();
                    })
                    .catch(err => {
                        console.warn('[BetterMetas] GitHub API user_locations fetch failed, falling back to raw:', err);
                        loadRawUserLocations();
                    });
                return;
            }

            loadRawUserLocations();
        }

        function loadRawUserLocations() {
            GM_xmlhttpRequest({
                method: "GET",
                url: getRawUserLocationsUrl(),
                onload: function(response) {
                    if (response.status === 200) {
                        try {
                            userLocationMap = JSON.parse(response.responseText);
                            console.log(`[BetterMetas] Loaded ${Object.keys(userLocationMap).length} user location mappings from raw.`);
                            userLocLoaded = true;
                            checkAllLoaded();
                        } catch (e) {
                            console.error('[BetterMetas] Error parsing user_locations.json:', e);
                            useFallback("User Locations Parse Error");
                        }
                    } else {
                        console.log('[BetterMetas] User locations file empty or 404, proceeding...');
                        userLocationMap = {};
                        userLocLoaded = true;
                        checkAllLoaded();
                    }
                },
                onerror: function(err) {
                    console.error('[BetterMetas] User locations request error:', err);
                    useFallback("Network Error (User Locations)");
                }
            });
        }

        function loadUserMetas() {
            if (token) {
                fetchGitHubContentJson(API_USER_METAS_URL, token)
                    .then(metas => {
                        tempUserMetas = Array.isArray(metas) ? metas : [];
                        console.log(`[BetterMetas] Loaded ${tempUserMetas.length} user metas from GitHub API.`);
                        userMetasLoaded = true;
                        checkAllLoaded();
                    })
                    .catch(err => {
                        console.warn('[BetterMetas] GitHub API user_metas fetch failed, falling back to raw:', err);
                        loadRawUserMetas();
                    });
                return;
            }

            loadRawUserMetas();
        }

        function loadRawUserMetas() {
            GM_xmlhttpRequest({
                method: "GET",
                url: getRawUserMetasUrl(),
                onload: function(response) {
                    if (response.status === 200) {
                        try {
                            tempUserMetas = JSON.parse(response.responseText);
                            console.log(`[BetterMetas] Loaded ${tempUserMetas.length} user metas from raw.`);
                            userMetasLoaded = true;
                            checkAllLoaded();
                        } catch (e) {
                            console.error('[BetterMetas] Error parsing user_metas.json:', e);
                            useFallback("User Metas Parse Error");
                        }
                    } else {
                        console.log('[BetterMetas] User metas file empty or 404, proceeding...');
                        userMetasLoaded = true;
                        checkAllLoaded();
                    }
                },
                onerror: function(err) {
                    console.error('[BetterMetas] User metas request error:', err);
                    useFallback("Network Error (User Metas)");
                }
            });
        }

        function checkAllLoaded() {
            if (userLocLoaded && systemLocLoaded && userMetasLoaded && systemMetasLoaded) {
                const rawUserMetas = tempUserMetas.slice();
                const rawUserLocationMap = { ...userLocationMap };
                pruneConfirmedPendingLocalChanges(rawUserMetas, rawUserLocationMap);
                const pending = mergePendingLocalChangesInto(tempUserMetas, userLocationMap);

                locationMap = mergeLocationMaps(systemLocationMap, userLocationMap);
                userMetaIds = new Set(tempUserMetas.map(m => m.id).filter(Boolean));
                systemMetaIds = new Set(tempSystemMetas.map(m => m.id).filter(Boolean));

                const combined = [...tempUserMetas, ...tempSystemMetas];
                const seen = new Set();
                metasData = combined.filter(m => {
                    if (!m.id || seen.has(m.id)) return false;
                    seen.add(m.id);
                    return true;
                });

                const locCount = Object.keys(locationMap).length;
                const userLocCount = Object.keys(userLocationMap).length;
                const systemLocCount = Object.keys(systemLocationMap).length;
                const pendingLocCount = Object.keys(pending.locations).length;
                console.log(`[BetterMetas] DB Ready: ${locCount} locs (${userLocCount} user, ${systemLocCount} system), ${metasData.length} unique metas (${tempUserMetas.length} user, ${tempSystemMetas.length} system). Pending local merge: ${pending.metas.length} metas, ${pendingLocCount} locs.`);

                syncPanoidForUserAction('DB ready');
                
                if (currentPanoid) {
                     updateStatus(`ID: ${currentPanoid.substring(0,12)}...`);
                     refreshDisplay();
                } else {
                     updateStatus(`DB Ready (${metasData.length} metas)`);
                }
            }
        }
    }

    function useFallback(reason) {
        console.warn(`[BetterMetas] Could not load data. Reason: ${reason}`);
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
         }, 200);

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
                 const activeTag = document.activeElement.tagName.toLowerCase();
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
             const target = e.target;
             if (target.tagName !== 'BUTTON' && !target.closest('button')) return;
             
             // Check if we are on result screen
             if (isRoundResult()) {
                  // If we click ANY button on result screen that isn't inside our HUD or modals, hide HUD
                  // Exclude: HUD, Settings Modal, Add Meta Modal
                  // Exclude: HUD, Settings Modal, Add Meta Modal
                  if (!target.closest('#gg-meta-hud') && 
                      !target.closest('#gg-settings-modal') && 
                      !target.closest('#gg-meta-modal')) {
                       
                       // Close HUD
                       const hud = document.getElementById('gg-meta-hud');
                       if (hud && hud.classList.contains('gg-visible')) {
                           hud.classList.remove('gg-visible');
                           userDismissed = true;
                       }

                       // Close Modals
                       const metaModal = document.getElementById('gg-meta-modal');
                       if (metaModal) metaModal.style.display = 'none';

                       const settingsModal = document.getElementById('gg-settings-modal');
                       if (settingsModal) settingsModal.style.display = 'none';
                  }
             }
         }, true); // Capture phase to catch it early

         console.log('[BetterMetas] Observer started.');
    }

    // --- Initialization ---
    function init() {
        console.log('[Geoguessr Meta] Initializing UI...');
        addStyles();
        createHUD();
        startObserver();
        fetchLocationData();
    }

    init();

})();
