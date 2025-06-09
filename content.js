// Smart Tab Blocker Content Script
(function() {
    'use strict';
    
    // Early extension context validation
    function isExtensionContextValid() {
        try {
            return !!(chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
        } catch (e) {
            return false;
        }
    }
    
    // Check if extension context is valid before proceeding
    if (!isExtensionContextValid()) {
        console.log('Smart Tab Blocker: Extension context not available, content script will not initialize');
        return;
    }
    
    // Monitor extension context throughout execution
    function checkExtensionContext() {
        if (!isExtensionContextValid()) {
            console.log('Smart Tab Blocker: Extension context lost during execution');
            // Clean up any running timers
            if (countdownTimer) {
                clearInterval(countdownTimer);
                countdownTimer = null;
            }
            // Hide any UI elements
            if (modal) {
                hideModal();
            }
            if (timerElement) {
                hideTimer();
            }
            return false;
        }
        return true;
    }
    
    let modal = null;
    let timerElement = null;
    let isEnabled = false;
    let isInitialized = false;
    let countdownTimer = null;
    let timeRemaining = 20;
    let isTimerPaused = false;
    let tabId = null;
    let currentDomain = null;
    let gracePeriod = 20;
    let isActiveTab = true; // Track if this is the currently active tab
    let lastSyncTime = 0; // Track when we last synced with shared state
    let hasLoadedFromFirebase = false; // Prevent writing to Firebase until we've loaded current state
    let isInitializing = true; // Track if we're still in initialization phase
    
    // Get unique tab identifier
    function getTabId() {
        if (!tabId) {
            tabId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }
        return tabId;
    }
    
    // Get current domain info
    function getCurrentDomain() {
        try {
            return window.location.hostname.toLowerCase();
        } catch {
            return null;
        }
    }
    
    // Get today's date string for blocking logic
    function getTodayString() {
        const today = new Date();
        return today.getFullYear() + '-' + 
               String(today.getMonth() + 1).padStart(2, '0') + '-' + 
               String(today.getDate()).padStart(2, '0');
    }

    // Format seconds into hours, minutes, and seconds
    function formatTime(seconds) {
        if (seconds <= 0) return '0s';
        
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = seconds % 60;
        
        const parts = [];
        
        if (hours > 0) {
            parts.push(`${hours}h`);
        }
        if (minutes > 0) {
            parts.push(`${minutes}m`);
        }
        if (remainingSeconds > 0 || parts.length === 0) {
            parts.push(`${remainingSeconds}s`);
        }
        
        return parts.join(' ');
    }
    
    // Storage key for this domain's timer state
    function getStorageKey() {
        const domain = getCurrentDomain();
        return domain ? `timerState_${domain}` : null;
    }
    
    // Storage key for daily blocks
    function getDailyBlockKey() {
        const domain = getCurrentDomain();
        return domain ? `dailyBlock_${domain}` : null;
    }
    
    // Check if domain is blocked for today
    function isDomainBlockedToday() {
        return new Promise((resolve) => {
            const blockKey = getDailyBlockKey();
            if (!blockKey) {
                resolve(false);
                return;
            }
            
            try {
                if (!chrome.runtime?.id) {
                    console.log("Smart Tab Blocker: Extension context invalidated, cannot check if domain is blocked");
                    resolve(false);
                    return;
                }
                
                chrome.storage.local.get([blockKey], (result) => {
                    if (chrome.runtime.lastError) {
                        console.log("Smart Tab Blocker: Error checking if domain is blocked:", chrome.runtime.lastError);
                        resolve(false);
                        return;
                    }
                    
                    const blockData = result[blockKey];
                    console.log("Block check result:", blockKey, blockData);
                    if (blockData && blockData.date === getTodayString()) {
                        resolve(true);
                    } else {
                        // Clean up old block data if it exists
                        if (blockData && blockData.date !== getTodayString() && chrome.runtime?.id) {
                            chrome.storage.local.remove([blockKey]);
                        }
                        resolve(false);
                    }
                });
            } catch (e) {
                console.log("Smart Tab Blocker: Extension context invalidated, cannot check if domain is blocked");
                resolve(false);
            }
        });
    }
    
    // Mark domain as blocked for today
    function markDomainBlockedToday() {
        const blockKey = getDailyBlockKey();
        if (!blockKey) return;
        
        try {
            if (chrome.runtime?.id) {
                chrome.storage.local.set({
                    [blockKey]: {
                        date: getTodayString(),
                        timestamp: Date.now(),
                        domain: getCurrentDomain()
                    }
                }).then(() => {
                    // After successfully saving to Chrome storage, also sync to Firebase
                    // This will update the blocked site with is_blocked = true and blocked_until
                    syncTimerToFirebase();
                }).catch((error) => {
                    if (error.message && error.message.includes('Extension context invalidated')) {
                        console.log("Smart Tab Blocker: Extension context invalidated, cannot mark domain as blocked");
                    } else {
                        console.error("Smart Tab Blocker: Error marking domain as blocked", error);
                    }
                });
            } else {
                console.log("Smart Tab Blocker: Extension context invalidated, cannot mark domain as blocked");
            }
        } catch (e) {
            console.log("Smart Tab Blocker: Extension context invalidated, cannot mark domain as blocked");
        }
        
        console.log(`Smart Tab Blocker: ${getCurrentDomain()} blocked for the rest of the day`);
    }
    
    // Sync timer state from shared storage (for tab switching)
    // New function for tab switching: Load Firebase first, compare with Chrome storage
    function syncFromFirebaseOnTabSwitch() {
        return new Promise((resolve) => {
            if (!currentDomain) {
                resolve();
                return;
            }
            
            console.log('Smart Tab Blocker: Tab became active - loading from Firebase first');
            
            // Step 1: Load current state from Firebase
            loadTimerStateFromFirebase().then(firebaseState => {
                const storageKey = getStorageKey();
                if (!storageKey) {
                    if (firebaseState && firebaseState.timeRemaining >= 0) {
                        timeRemaining = firebaseState.timeRemaining;
                        gracePeriod = firebaseState.gracePeriod || gracePeriod;
                        console.log(`Smart Tab Blocker: Using Firebase time: ${timeRemaining}s (no Chrome storage key)`);
                        updateTimerDisplay();
                    }
                    resolve();
                    return;
                }
                
                // Step 2: Load current state from Chrome storage
                chrome.storage.local.get([storageKey], (result) => {
                    if (chrome.runtime.lastError) {
                        console.log("Smart Tab Blocker: Error loading Chrome storage for comparison:", chrome.runtime.lastError);
                        if (firebaseState && firebaseState.timeRemaining >= 0) {
                            timeRemaining = firebaseState.timeRemaining;
                            gracePeriod = firebaseState.gracePeriod || gracePeriod;
                            updateTimerDisplay();
                        }
                        resolve();
                        return;
                    }
                    
                    const chromeState = result[storageKey];
                    let chromeTimeRemaining = null;
                    
                    if (chromeState && chromeState.date === getTodayString()) {
                        // Calculate elapsed time for Chrome storage
                        const now = Date.now();
                        const timeDiff = Math.floor((now - chromeState.timestamp) / 1000);
                        
                        chromeTimeRemaining = chromeState.timeRemaining;
                        if (chromeState.isActive && !chromeState.isPaused) {
                            chromeTimeRemaining = Math.max(0, chromeState.timeRemaining - timeDiff);
                        }
                    }
                    
                    // Step 3: Compare and decide
                    if (firebaseState && firebaseState.timeRemaining >= 0 && chromeTimeRemaining !== null) {
                        const firebaseTime = firebaseState.timeRemaining;
                        
                        console.log(`Smart Tab Blocker: Tab switch comparison - Firebase: ${firebaseTime}s, Chrome: ${chromeTimeRemaining}s`);
                        
                        if (firebaseTime <= chromeTimeRemaining) {
                            // Firebase has lower or equal time - use Firebase
                            console.log(`Smart Tab Blocker: Using Firebase time (${firebaseTime}s) - lower than Chrome (${chromeTimeRemaining}s)`);
                            timeRemaining = firebaseTime;
                            gracePeriod = firebaseState.gracePeriod || gracePeriod;
                        } else {
                            // Chrome storage has lower time - use Chrome and update Firebase
                            console.log(`Smart Tab Blocker: Using Chrome time (${chromeTimeRemaining}s) and updating Firebase - lower than Firebase (${firebaseTime}s)`);
                            timeRemaining = chromeTimeRemaining;
                            gracePeriod = chromeState.gracePeriod || gracePeriod;
                            
                            // Update Firebase with the lower Chrome storage time
                            setTimeout(() => {
                                syncTimerToFirebase();
                            }, 500); // Small delay to avoid race conditions
                        }
                    } else if (firebaseState && firebaseState.timeRemaining >= 0) {
                        // Only Firebase has data
                        console.log(`Smart Tab Blocker: Using Firebase time only: ${firebaseState.timeRemaining}s`);
                        timeRemaining = firebaseState.timeRemaining;
                        gracePeriod = firebaseState.gracePeriod || gracePeriod;
                    } else if (chromeTimeRemaining !== null) {
                        // Only Chrome storage has data
                        console.log(`Smart Tab Blocker: Using Chrome time only: ${chromeTimeRemaining}s`);
                        timeRemaining = chromeTimeRemaining;
                        gracePeriod = chromeState.gracePeriod || gracePeriod;
                        
                        // Update Firebase with Chrome storage data
                        setTimeout(() => {
                            syncTimerToFirebase();
                        }, 500);
                    }
                    
                    // Update display and handle blocking if needed
                    updateTimerDisplay();
                    
                    if (timeRemaining <= 0) {
                        stopCountdownTimer();
                        clearTimerState();
                        markDomainBlockedToday();
                        hideTimer();
                        showModal();
                    }
                    
                    resolve();
                });
            }).catch(error => {
                console.log('Smart Tab Blocker: Error loading from Firebase on tab switch:', error);
                // Fall back to Chrome storage only
                syncFromSharedState().then(() => {
                    resolve();
                });
            });
        });
    }

    function syncFromSharedState() {
        return new Promise((resolve) => {
            const storageKey = getStorageKey();
            if (!storageKey) {
                resolve();
                return;
            }
            
            try {
                if (!chrome.runtime?.id) {
                    resolve();
                    return;
                }
                
                chrome.storage.local.get([storageKey], (result) => {
                    if (chrome.runtime.lastError) {
                        console.log("Smart Tab Blocker: Error syncing from shared state:", chrome.runtime.lastError);
                        resolve();
                        return;
                    }
                    
                    const sharedState = result[storageKey];
                    if (sharedState && sharedState.date === getTodayString()) {
                        // Calculate elapsed time since last update
                        const now = Date.now();
                        const timeDiff = Math.floor((now - sharedState.timestamp) / 1000);
                        
                        // Update shared state time with elapsed time
                        let sharedTimeRemaining = sharedState.timeRemaining;
                        if (sharedState.isActive && !sharedState.isPaused) {
                            sharedTimeRemaining = Math.max(0, sharedState.timeRemaining - timeDiff);
                        }
                        
                        // Always select the MINIMUM time between current and shared state to prevent time inflation
                        const currentTime = timeRemaining;
                        const minimumTime = Math.min(currentTime, sharedTimeRemaining);
                        
                        console.log(`Smart Tab Blocker: Cross-tab sync - Current: ${currentTime}s, Shared: ${sharedTimeRemaining}s, Using minimum: ${minimumTime}s`);
                        
                        timeRemaining = minimumTime;
                        gracePeriod = sharedState.gracePeriod || gracePeriod;
                        lastSyncTime = now;
                        
                        console.log(`Smart Tab Blocker: Synced from shared state - ${timeRemaining}s remaining (was ${sharedState.timeRemaining}s, ${timeDiff}s elapsed)`);
                        
                        updateTimerDisplay();
                        
                        // If timer has expired, handle blocking
                        if (timeRemaining <= 0) {
                            stopCountdownTimer();
                            clearTimerState();
                            markDomainBlockedToday();
                            hideTimer();
                            showModal();
                        }
                    }
                    
                    resolve();
                });
            } catch (e) {
                console.log("Smart Tab Blocker: Extension context invalidated during sync");
                resolve();
            }
        });
    }

    // Load timer state from storage
    function loadTimerState() {
        return new Promise((resolve) => {
            const storageKey = getStorageKey();
            if (!storageKey) {
                resolve(null);
                return;
            }
            
            console.log(`Smart Tab Blocker: Attempting to load timer state for ${getCurrentDomain()}`);
            
            // First, try to load from Firebase for cross-device syncing
            loadTimerStateFromFirebase().then(firebaseState => {
                if (firebaseState && firebaseState.timeRemaining > 0) {
                    console.log(`Smart Tab Blocker: Loaded timer state from Firebase (cross-device) with ${firebaseState.timeRemaining}s remaining`);
                    resolve(firebaseState);
                    return;
                }
                
                // If no Firebase state, fall back to Chrome storage
                try {
                    if (!chrome.runtime?.id) {
                        console.log("Smart Tab Blocker: Extension context invalidated, cannot load timer state");
                        resolve(null);
                        return;
                    }
                    
                    chrome.storage.local.get([storageKey], (result) => {
                        if (chrome.runtime.lastError) {
                            console.log("Smart Tab Blocker: Error loading timer state:", chrome.runtime.lastError);
                            resolve(null);
                            return;
                        }
                        
                        const state = result[storageKey];
                        console.log("Smart Tab Blocker: Retrieved state from Chrome storage:", state);
                        
                        if (state && state.date === getTodayString()) {
                            // Only restore if same day - we're more lenient about URL to handle subdomain variations
                            console.log(`Smart Tab Blocker: Found saved timer state with ${state.timeRemaining}s remaining`);
                            resolve(state);
                            return;
                        }
                        
                        // Clean up old state
                        if (state && state.date !== getTodayString()) {
                            console.log("Smart Tab Blocker: Clearing outdated timer state");
                            if (chrome.runtime?.id) {
                                chrome.storage.local.remove([storageKey]);
                            }
                        }
                        
                        // If the domain shouldn't be tracked, we'll also clean up any remaining state
                        if (chrome.runtime?.id) {
                            chrome.runtime.sendMessage({ 
                                action: 'checkDomainTracking',
                                domain: getCurrentDomain()
                            }, (response) => {
                                if (chrome.runtime.lastError) {
                                    console.log("Smart Tab Blocker: Error checking domain tracking:", chrome.runtime.lastError);
                                    return;
                                }
                                
                                if (response && response.shouldTrack === false) {
                                    console.log("Smart Tab Blocker: Domain no longer tracked, clearing all state");
                                    if (chrome.runtime?.id) {
                                        chrome.storage.local.remove([storageKey]);
                                        // Also clear any daily blocks for this domain
                                        const blockKey = getDailyBlockKey();
                                        if (blockKey) {
                                            chrome.storage.local.remove([blockKey]);
                                        }
                                    }
                                }
                            });
                        }
                        
                        resolve(null);
                    });
                } catch (e) {
                    console.log("Smart Tab Blocker: Extension context invalidated, cannot load timer state");
                    resolve(null);
                }
            }).catch(error => {
                console.log("Smart Tab Blocker: Error loading from Firebase, falling back to Chrome storage:", error);
                // Fall back to Chrome storage if Firebase fails
                try {
                    if (!chrome.runtime?.id) {
                        resolve(null);
                        return;
                    }
                    
                    chrome.storage.local.get([storageKey], (result) => {
                        const state = result[storageKey];
                        if (state && state.date === getTodayString()) {
                            resolve(state);
                        } else {
                            resolve(null);
                        }
                    });
                } catch (e) {
                    resolve(null);
                }
            });
        });
    }

    // Load timer state from Firebase for cross-device syncing
    function loadTimerStateFromFirebase() {
        return new Promise((resolve) => {
            if (!currentDomain) {
                resolve(null);
                return;
            }
            
            try {
                chrome.runtime.sendMessage({
                    action: 'loadTimerFromFirebase',
                    domain: currentDomain
                }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.log('Smart Tab Blocker: Error loading timer from Firebase:', chrome.runtime.lastError);
                        resolve(null);
                        return;
                    }
                    
                    if (response && response.success && response.timerState) {
                        const firebaseState = response.timerState;
                        
                        // Calculate elapsed time since last Firebase update
                        const now = Date.now();
                        const timeDiff = Math.floor((now - firebaseState.timestamp) / 1000);
                        
                        // Adjust time remaining based on elapsed time
                        let adjustedTimeRemaining = firebaseState.timeRemaining;
                        if (firebaseState.isActive && !firebaseState.isPaused) {
                            adjustedTimeRemaining = Math.max(0, firebaseState.timeRemaining - timeDiff);
                        }
                        
                        console.log(`Smart Tab Blocker: Firebase state - was ${firebaseState.timeRemaining}s, ${timeDiff}s elapsed, now ${adjustedTimeRemaining}s`);
                        
                        resolve({
                            ...firebaseState,
                            timeRemaining: adjustedTimeRemaining
                        });
                    } else {
                        console.log('Smart Tab Blocker: No timer state found in Firebase');
                        resolve(null);
                    }
                });
            } catch (error) {
                console.log('Smart Tab Blocker: Exception while loading from Firebase:', error);
                resolve(null);
            }
        });
    }
    
    // Save timer state to storage
    function saveTimerState() {
        const storageKey = getStorageKey();
        if (!storageKey) return;
        
        const state = {
            timeRemaining: timeRemaining,
            isActive: !!countdownTimer && isActiveTab, // Only active tab should be marked as running the timer
            isPaused: isTimerPaused,
            tabId: getTabId(),
            timestamp: Date.now(),
            url: window.location.href,
            gracePeriod: gracePeriod,
            date: getTodayString(),
            activeTabId: isActiveTab ? getTabId() : null // Track which tab is currently active
        };
        
        console.log(`Smart Tab Blocker: Saving timer state with ${timeRemaining}s remaining (active: ${isActiveTab}, hasLoadedFromFirebase: ${hasLoadedFromFirebase})`);
        
        try {
            if (chrome.runtime?.id) {
                chrome.storage.local.set({
                    [storageKey]: state
                }).then(() => {
                    // Only sync to Firebase if we've loaded the current state first
                    // This prevents race conditions where new devices overwrite existing progress
                    if (hasLoadedFromFirebase && !isInitializing) {
                        syncTimerToFirebase();
                    } else {
                        console.log('Smart Tab Blocker: Skipping Firebase sync - still initializing or haven\'t loaded from Firebase yet');
                    }
                }).catch((error) => {
                    if (error.message && error.message.includes('Extension context invalidated')) {
                        console.log("Smart Tab Blocker: Extension context invalidated, cannot save timer state");
                    } else {
                        console.error("Smart Tab Blocker: Error saving timer state", error);
                    }
                });
            } else {
                console.log("Smart Tab Blocker: Extension context invalidated, cannot save timer state");
            }
        } catch (e) {
            console.log("Smart Tab Blocker: Extension context invalidated, cannot save timer state");
        }
    }
    
    // Clear timer state from storage
    function clearTimerState() {
        const storageKey = getStorageKey();
        if (!storageKey) return;
        
        try {
            if (chrome.runtime?.id) {
                chrome.storage.local.remove([storageKey]).catch((error) => {
                    if (error.message && error.message.includes('Extension context invalidated')) {
                        console.log("Smart Tab Blocker: Extension context invalidated, cannot clear timer state");
                    } else {
                        console.log("Smart Tab Blocker: Error clearing timer state:", error);
                    }
                });
            } else {
                console.log("Smart Tab Blocker: Extension context invalidated, cannot clear timer state");
            }
        } catch (e) {
            console.log("Smart Tab Blocker: Extension context invalidated, cannot clear timer state");
        }
    }
    
    function clearDailyBlock() {
        const blockKey = getDailyBlockKey();
        if (!blockKey) return;
        
        try {
            if (chrome.runtime?.id) {
                chrome.storage.local.remove([blockKey]).catch((error) => {
                    if (error.message && error.message.includes('Extension context invalidated')) {
                        console.log("Smart Tab Blocker: Extension context invalidated, cannot clear daily block");
                    } else {
                        console.error("Smart Tab Blocker: Error clearing daily block", error);
                    }
                });
            } else {
                console.log("Smart Tab Blocker: Extension context invalidated, cannot clear daily block");
            }
        } catch (e) {
            console.log("Smart Tab Blocker: Extension context invalidated, cannot clear daily block");
        }
    }
    
    // Handle page visibility changes
    function handleVisibilityChange() {
        if (!isEnabled || !countdownTimer) return;
        
        if (document.hidden) {
            // Tab became inactive - pause timer and mark as inactive
            isActiveTab = false;
            pauseTimer();
        } else {
            // Tab became active - load from Firebase first, then compare with Chrome storage
            isActiveTab = true;
            syncFromFirebaseOnTabSwitch().then(() => {
                resumeTimer();
            });
        }
    }
    
    // Pause the timer
    function pauseTimer() {
        if (countdownTimer && !isTimerPaused) {
            isTimerPaused = true;
            saveTimerState();
            updateTimerDisplay();
        }
    }
    
    // Resume the timer
    function resumeTimer() {
        if (countdownTimer && isTimerPaused) {
            isTimerPaused = false;
            // If this tab is becoming active, sync with shared state first
            if (isActiveTab) {
                syncFromSharedState().then(() => {
                    saveTimerState();
                    updateTimerDisplay();
                });
            } else {
                saveTimerState();
                updateTimerDisplay();
            }
        }
    }
    
    // Initialize with domain configuration
    function initializeWithConfig(domainConfig) {
        if (isInitialized) return;
        
        currentDomain = getCurrentDomain();
        gracePeriod = domainConfig ? domainConfig.timer : 20;
        timeRemaining = gracePeriod;
        
        console.log(`Smart Tab Blocker: Initializing for ${currentDomain} with ${gracePeriod}s timer`);
        
        isInitialized = true;
        isEnabled = true;
        isActiveTab = !document.hidden; // Set initial active status
        
        // Set up visibility change listener
        document.addEventListener('visibilitychange', handleVisibilityChange);
        
        // Add storage change listener for cross-tab syncing
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local') {
                const storageKey = getStorageKey();
                if (storageKey && changes[storageKey] && !isActiveTab) {
                    // Another tab updated the timer state, sync from it
                    console.log('Smart Tab Blocker: Timer state changed by another tab, syncing...');
                    syncFromSharedState();
                }
            }
        });
        
        // First check if domain is blocked for today
        isDomainBlockedToday().then(isBlocked => {
            if (isBlocked) {
                console.log(`Smart Tab Blocker: ${currentDomain} is already blocked for today`);
                showModal(true); // true = already blocked
                return;
            }
            
            // For cross-device syncing, ALWAYS check Firebase first (more aggressive)
            console.log(`Smart Tab Blocker: Checking Firebase first for cross-device state...`);
            loadTimerStateFromFirebase().then(firebaseState => {
                // Mark that we've attempted to load from Firebase
                hasLoadedFromFirebase = true;
                
                if (firebaseState && firebaseState.timeRemaining > 0) {
                    // Firebase has valid state - use it (this handles cross-device syncing)
                    console.log(`Smart Tab Blocker: Using Firebase state (cross-device) with ${firebaseState.timeRemaining}s remaining`);
                    timeRemaining = firebaseState.timeRemaining;
                    gracePeriod = firebaseState.gracePeriod || gracePeriod;
                    isTimerPaused = firebaseState.isPaused || document.hidden;
                    
                    // Finish initialization and start timer
                    isInitializing = false;
                    startCountdownTimer(true);
                    return;
                } else if (firebaseState && firebaseState.timeRemaining <= 0) {
                    // Firebase shows site is blocked
                    console.log(`Smart Tab Blocker: Firebase shows site is blocked`);
                    isInitializing = false;
                    showModal(true);
                    return;
                }
                
                // No Firebase state, check if we have local saved state
                if (domainConfig.savedState) {
                    console.log(`Smart Tab Blocker: Using provided saved state with ${domainConfig.savedState.timeRemaining}s remaining`);
                    timeRemaining = domainConfig.savedState.timeRemaining;
                    gracePeriod = domainConfig.savedState.gracePeriod || gracePeriod;
                    isTimerPaused = domainConfig.savedState.isPaused || document.hidden;
                    
                    // Finish initialization and start timer
                    isInitializing = false;
                    startCountdownTimer(true);
                } else {
                    // Check Chrome storage as last resort
                    loadTimerState().then(savedState => {
                        if (savedState && savedState.timeRemaining > 0) {
                            console.log(`Smart Tab Blocker: Using Chrome storage state with ${savedState.timeRemaining}s remaining`);
                            timeRemaining = savedState.timeRemaining;
                            gracePeriod = savedState.gracePeriod || gracePeriod;
                            isTimerPaused = savedState.isPaused || document.hidden;
                            
                            // Finish initialization and start timer
                            isInitializing = false;
                            startCountdownTimer(true);
                        } else {
                            console.log(`Smart Tab Blocker: Starting fresh timer with ${gracePeriod}s`);
                            // Finish initialization and start timer
                            isInitializing = false;
                            startCountdownTimer();
                        }
                    });
                }
            }).catch(error => {
                console.log('Smart Tab Blocker: Error loading from Firebase, falling back to local state:', error);
                hasLoadedFromFirebase = true; // Mark as attempted even if failed
                
                // Fall back to local state if Firebase fails
                if (domainConfig.savedState) {
                    timeRemaining = domainConfig.savedState.timeRemaining;
                    gracePeriod = domainConfig.savedState.gracePeriod || gracePeriod;
                    isTimerPaused = domainConfig.savedState.isPaused || document.hidden;
                    isInitializing = false;
                    startCountdownTimer(true);
                } else {
                    loadTimerState().then(savedState => {
                        if (savedState && savedState.timeRemaining > 0) {
                            timeRemaining = savedState.timeRemaining;
                            gracePeriod = savedState.gracePeriod || gracePeriod;
                            isTimerPaused = savedState.isPaused || document.hidden;
                            isInitializing = false;
                            startCountdownTimer(true);
                        } else {
                            isInitializing = false;
                            startCountdownTimer();
                        }
                    });
                }
            });
        });
        
        // Listen for messages from background script
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            console.log('Smart Tab Blocker: Message received:', request);
            console.log('request.action', request.action);
            if (request.action === 'updateConfig') {
                if (request.enabled && request.domainConfig) {
                    // Domain is still tracked, update config
                    gracePeriod = request.domainConfig.timer;
                    if (!countdownTimer) {
                        timeRemaining = gracePeriod;
                        startCountdownTimer();
                    }
                    sendResponse({ success: true });
                } else {
                    // Domain was removed from tracking or extension disabled
                    console.log('Smart Tab Blocker: Domain removed from tracking or extension disabled');
                    clearAllStateForDomain();
                    sendResponse({ success: true });
                }
            } else if (request.action === 'checkDomainTracking') {
                sendResponse({ 
                    isTracking: isEnabled && isInitialized,
                    domain: getCurrentDomain()
                });
            } else if (request.action === 'stopTracking') {
                // Direct command to stop tracking this domain
                console.log(`Smart Tab Blocker: Received direct command to stop tracking ${getCurrentDomain()}`);
                isEnabled = false;
                isInitialized = false;
                stopCountdownTimer();
                clearTimerState();
                hideTimer();
                hideModal();
                
                // Also clear any daily blocks for this domain
                const blockKey = getDailyBlockKey();
                if (blockKey) {
                    chrome.storage.local.remove([blockKey]);
                }
                
                sendResponse({ success: true });
            } else if (request.action === 'requestTimerUpdate') {
                // Popup is requesting a timer update (usually after tab switch)
                if (isEnabled && countdownTimer) {
                    sendTimerUpdateToPopup();
                }
                sendResponse({ success: true });
            }
            
            return true; // Keep message channel open for async response
        });
    }
    
    // Check if current domain should be tracked
    function checkDomainAndInitialize() {
        console.log(`Smart Tab Blocker: Checking domain ${getCurrentDomain()}`);
        
        // Check extension context before proceeding
        if (!checkExtensionContext()) {
            console.log('Smart Tab Blocker: Extension context not available, cannot initialize');
            return;
        }
        
        // Notify background script that we're checking this domain
        chrome.runtime.sendMessage({ 
            action: 'contentScriptLoaded', 
            domain: getCurrentDomain() 
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.log('Smart Tab Blocker: Error communicating with background script:', chrome.runtime.lastError);
                // Retry after a delay if there's a communication error
                setTimeout(() => {
                    console.log('Smart Tab Blocker: Retrying domain check...');
                    checkDomainAndInitialize();
                }, 3000);
                return;
            }
            
            // If background responds that authentication is still initializing, wait for retry
            // if (response && response.initializing) {
            //     console.log(`Smart Tab Blocker: Background script is still initializing for ${getCurrentDomain()}, waiting for retry`);
            //     return; // Background will send updateConfig message when ready
            // }
            
            // If background responds that domain should not be tracked, stop initialization
            if (response && response.shouldTrack === false) {
                console.log('Response:', response);
                console.log(`Smart Tab Blocker: Background script says not to track ${getCurrentDomain()}`);
                // Ensure we clean up any state for this domain
                clearAllStateForDomain();
                return;
            }
            
            // Continue with initialization if tracking is allowed
            initializeDomainTracking();
        });
    }
    
    // Separate function for domain tracking initialization
    function initializeDomainTracking() {
        // First check if domain is already blocked today
        isDomainBlockedToday().then(isBlocked => {
            if (isBlocked) {
                console.log(`Smart Tab Blocker: ${getCurrentDomain()} is already blocked for today`);
                // Initialize with config so we can show the blocked modal
                initializeWithConfig({ timer: 20 });
                return;
            }
            
            // If not blocked, check if we have saved timer state
            loadTimerState().then(savedState => {
                if (savedState && savedState.timeRemaining > 0) {
                    // Double-check that domain should still be tracked before using saved state
                    chrome.runtime.sendMessage({ action: 'checkDomainTracking', domain: getCurrentDomain() }, (trackingResponse) => {
                        if (trackingResponse && trackingResponse.shouldTrack === false) {
                            console.log(`Smart Tab Blocker: Domain no longer tracked, ignoring saved state`);
                            clearAllStateForDomain();
                            return;
                        }
                        
                        console.log(`Smart Tab Blocker: Restoring from saved timer state with ${savedState.timeRemaining}s remaining`);
                        // We have saved state, initialize with it
                        initializeWithConfig({ 
                            timer: savedState.gracePeriod || 20,
                            savedState: savedState
                        });
                    });
                } else {
                    // No saved state, proceed with normal initialization
                    console.log(`Smart Tab Blocker: No saved state, requesting domain config`);
                    chrome.runtime.sendMessage({ action: 'getDomainConfig' }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error("Smart Tab Blocker: Error getting domain config", chrome.runtime.lastError);
                            // Retry after delay if there's an error
                            setTimeout(() => {
                                console.log('Smart Tab Blocker: Retrying domain config request...');
                                initializeDomainTracking();
                            }, 3000);
                            return;
                        }
                        
                        if (response && response.domainConfig) {
                            initializeWithConfig(response.domainConfig);
                        } else if (response && response.shouldTrack === false) {
                            console.log(`Smart Tab Blocker: Domain ${getCurrentDomain()} should not be tracked`);
                            clearAllStateForDomain();
                        } else {
                            console.log('Smart Tab Blocker: No domain config received, may need to retry');
                            // Wait a bit and check again
                            setTimeout(() => {
                                initializeDomainTracking();
                            }, 5000);
                        }
                    });
                }
            });
        });
    }
    
    // Helper function to clean up all state for a domain
    function clearAllStateForDomain() {
        console.log(`Smart Tab Blocker: Cleaning up all state for ${getCurrentDomain()}`);
        
        // Clear timer state
        const storageKey = getStorageKey();
        if (storageKey) {
            chrome.storage.local.remove([storageKey]);
        }
        
        // Clear daily block
        const blockKey = getDailyBlockKey();
        if (blockKey) {
            chrome.storage.local.remove([blockKey]);
        }
        
        // Clean up UI and variables
        stopCountdownTimer();
        hideTimer();
        hideModal();
        isEnabled = false;
        isInitialized = false;
        
        // Try to clean up localStorage temp data too
        try {
            localStorage.removeItem('_smartBlockerTemp');
        } catch (e) {
            // Ignore localStorage errors
        }
    }
    
    function createTimer() {
        if (timerElement) return timerElement;
        
        timerElement = document.createElement('div');
        timerElement.id = 'smart-blocker-timer';
        timerElement.className = 'smart-blocker-timer';
        
        timerElement.innerHTML = `
            <div class="smart-blocker-timer-content">
                <div class="smart-blocker-timer-icon">⏰</div>
                <div class="smart-blocker-timer-text">
                    <h3>${currentDomain}</h3>
                    <p class="timer-status">Blocking in <span class="countdown">${formatTime(timeRemaining)}</span></p>
                    <div class="progress-bar">
                        <div class="progress-fill"></div>
                    </div>
                </div>
                <div class="smart-blocker-timer-close">×</div>
            </div>
        `;
        
        // Add event listener for close button
        const closeButton = timerElement.querySelector('.smart-blocker-timer-close');
        if (closeButton) {
            closeButton.addEventListener('click', function() {
                if (timerElement) {
                    timerElement.style.display = 'none';
                }
            });
        }
        
        return timerElement;
    }
    
    function showTimer() {
        if (!isEnabled) return;
        
        hideTimer();
        
        // Send timer data to extension popup instead of showing on page
        sendTimerUpdateToPopup();
        
        // Note: Timer is now displayed in the extension popup
        // No longer appending to document.body
        
        // Add timer styles
        if (!document.getElementById('smart-blocker-timer-styles')) {
            const styles = document.createElement('style');
            styles.id = 'smart-blocker-timer-styles';
            styles.textContent = `
                .smart-blocker-timer {
                    position: fixed !important;
                    top: 20px !important;
                    right: 20px !important;
                    z-index: 2147483646 !important;
                    background: linear-gradient(135deg, #1e3c72, #2a5298) !important;
                    color: white !important;
                    border-radius: 15px !important;
                    box-shadow: 0 10px 30px rgba(46, 82, 152, 0.4) !important;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif !important;
                    animation: timerSlideIn 0.5s ease-out !important;
                    border: 2px solid rgba(255, 255, 255, 0.3) !important;
                }
                
                .smart-blocker-timer.paused {
                    background: linear-gradient(135deg, #6b7280, #4b5563) !important;
                    animation: timerPaused 2s ease-in-out infinite !important;
                }
                
                @keyframes timerSlideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                
                @keyframes timerPaused {
                    0%, 100% { opacity: 0.7; }
                    50% { opacity: 1; }
                }
                
                .smart-blocker-timer-content {
                    display: flex !important;
                    align-items: center !important;
                    padding: 15px 20px !important;
                    gap: 15px !important;
                    position: relative !important;
                }
                
                .smart-blocker-timer-icon {
                    font-size: 24px !important;
                    animation: timerPulse 1s ease-in-out infinite !important;
                }
                
                .smart-blocker-timer-icon.paused {
                    animation: none !important;
                    opacity: 0.6 !important;
                }
                
                @keyframes timerPulse {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.1); }
                }
                
                .smart-blocker-timer-text h3 {
                    margin: 0 !important;
                    font-size: 16px !important;
                    font-weight: bold !important;
                    color: white !important;
                }
                
                .timer-status {
                    margin: 5px 0 8px 0 !important;
                    font-size: 14px !important;
                    color: rgba(255, 255, 255, 0.9) !important;
                }
                
                .timer-status.paused {
                    color: #ffd700 !important;
                    font-weight: bold !important;
                }
                
                .countdown {
                    font-weight: bold !important;
                    font-size: 16px !important;
                    color: #fff !important;
                }
                
                .progress-bar {
                    width: 120px !important;
                    height: 4px !important;
                    background: rgba(255, 255, 255, 0.3) !important;
                    border-radius: 2px !important;
                    overflow: hidden !important;
                }
                
                .progress-fill {
                    height: 100% !important;
                    background: linear-gradient(135deg, #00d4aa, #00a3ff) !important;
                    width: 100% !important;
                    transition: width 1s linear !important;
                }
                
                .smart-blocker-timer-close {
                    position: absolute !important;
                    top: 5px !important;
                    right: 8px !important;
                    cursor: pointer !important;
                    font-size: 18px !important;
                    font-weight: bold !important;
                    color: rgba(255, 255, 255, 0.7) !important;
                    line-height: 1 !important;
                    padding: 2px !important;
                    border-radius: 50% !important;
                    transition: all 0.3s ease !important;
                }
                
                .smart-blocker-timer-close:hover {
                    color: white !important;
                    background: rgba(255, 255, 255, 0.2) !important;
                }
            `;
            document.head.appendChild(styles);
        }
    }
    
    function hideTimer() {
        // Send message to popup to hide timer
        sendTimerStoppedToPopup();
        
        if (timerElement && timerElement.parentNode) {
            timerElement.parentNode.removeChild(timerElement);
            timerElement = null;
        }
    }
    
    function sendTimerUpdateToPopup() {
        const timerData = {
            domain: currentDomain,
            timeRemaining: timeRemaining,
            gracePeriod: gracePeriod,
            isPaused: isTimerPaused
        };
        
        chrome.runtime.sendMessage({
            type: 'TIMER_UPDATE',
            data: timerData
        });
    }
    
    function sendTimerStoppedToPopup() {
        chrome.runtime.sendMessage({
            type: 'TIMER_STOPPED'
        });
    }
    
    function updateTimerDisplay() {
        if (!isEnabled) return;
        
        // Send updated timer data to popup instead of updating on-page elements
        sendTimerUpdateToPopup();
    }
    
    // Safely enable Firebase syncing after initialization
    function enableFirebaseSync() {
        // Small delay to ensure initialization is completely finished
        setTimeout(() => {
            hasLoadedFromFirebase = true;
            isInitializing = false;
            console.log('Smart Tab Blocker: Firebase syncing enabled');
        }, 1000); // 1 second delay to prevent race conditions
    }

    function startCountdownTimer(isResuming = false) {
        if (!isEnabled || !checkExtensionContext()) return;
        
        stopCountdownTimer();
        
        if (!isResuming) {
            timeRemaining = gracePeriod;
            // If starting fresh, enable Firebase sync after a delay
            enableFirebaseSync();
        }
        
        isTimerPaused = document.hidden;
        isActiveTab = !document.hidden; // Set active status based on visibility
        
        showTimer();
        updateTimerDisplay();
        
        // Much more frequent syncing for smooth experience
        let secondsCounter = 0;
        let localSyncCounter = 0; // For inactive tab syncing
        let firebaseSyncCounter = 0; // For cross-device syncing
        
        countdownTimer = setInterval(() => {
            // Check extension context on each tick
            if (!checkExtensionContext()) {
                stopCountdownTimer();
                return;
            }
            
            if (!isTimerPaused) {
                // Only decrement time if this is the active tab
                if (isActiveTab) {
                    timeRemaining--;
                    updateTimerDisplay();
                    
                    secondsCounter++;
                    firebaseSyncCounter++;
                    
                    // Very frequent Firebase sync for smooth cross-device experience (every 3 seconds)
                    if (secondsCounter >= 3) {
                        syncTimerToFirebase();
                        secondsCounter = 0;
                    }
                    
                    // Check for cross-device updates every 6 seconds
                    if (firebaseSyncCounter >= 6) {
                        checkForCrossDeviceUpdates();
                        firebaseSyncCounter = 0;
                    }
                    
                    if (timeRemaining <= 0) {
                        stopCountdownTimer();
                        clearTimerState();
                        markDomainBlockedToday(); // Mark as blocked for the day
                        syncTimerToFirebase(); // Final sync when timer completes
                        hideTimer();
                        showModal();
                        return;
                    }
                } else {
                    // Inactive tab - sync more frequently for smoother updates
                    localSyncCounter++;
                    firebaseSyncCounter++;
                    
                    // Sync from local storage every 3 seconds for inactive tabs
                    if (localSyncCounter >= 3) {
                        syncFromSharedState();
                        localSyncCounter = 0;
                    }
                    
                    // Check Firebase every 4 seconds for cross-device updates on inactive tabs
                    if (firebaseSyncCounter >= 4) {
                        checkForCrossDeviceUpdates();
                        firebaseSyncCounter = 0;
                    }
                }
            } else {
                updateTimerDisplay();
            }
        }, 1000);
        
        // Immediate save when timer starts (but won't sync to Firebase until enabled)
        saveTimerState();
    }
    
    function stopCountdownTimer() {
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        isTimerPaused = false;
    }
    
    // Sync current timer state to Firebase via background script
    function syncTimerToFirebase() {
        if (!checkExtensionContext() || !currentDomain || !isEnabled) {
            return;
        }
        
        // Extra protection: Don't sync during initialization
        if (isInitializing || !hasLoadedFromFirebase) {
            console.log('Smart Tab Blocker: Skipping Firebase sync - initialization not complete');
            return;
        }
        
        console.log(`Smart Tab Blocker: Syncing timer to Firebase for ${currentDomain} - ${timeRemaining}s remaining`);
        
        try {
            chrome.runtime.sendMessage({
                action: 'syncTimerToFirebase',
                domain: currentDomain,
                timeRemaining: timeRemaining,
                gracePeriod: gracePeriod,
                isActive: true,
                isPaused: isTimerPaused,
                timestamp: Date.now()
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.log('Smart Tab Blocker: Error syncing timer to Firebase:', chrome.runtime.lastError);
                    return;
                }
                
                if (response && response.success) {
                    console.log(`Smart Tab Blocker: Timer synced to Firebase successfully for ${currentDomain}`);
                } else {
                    console.log('Smart Tab Blocker: Failed to sync timer to Firebase:', response?.error);
                }
            });
        } catch (error) {
            console.log('Smart Tab Blocker: Exception while syncing timer to Firebase:', error);
        }
    }
    
    function createModal(alreadyBlocked = false) {
        if (modal) return modal;
        
        modal = document.createElement('div');
        modal.id = 'smart-blocker-modal';
        modal.className = 'smart-blocker-modal';
        
        const message = alreadyBlocked ? 
            `<strong>${currentDomain}</strong> is blocked for the rest of today` :
            `Your ${gracePeriod}-second allowance for <strong>${currentDomain}</strong> has ended`;
        
        modal.innerHTML = `
            <div class="smart-blocker-content">
                <div class="smart-blocker-header">
                    <div class="smart-blocker-icon">
                        <svg viewBox="0 0 100 100" width="60" height="60">
                            <circle cx="50" cy="50" r="45" fill="#2a5298" stroke="#fff" stroke-width="3"/>
                            <circle cx="50" cy="50" r="35" fill="none" stroke="#ff4444" stroke-width="5"/>
                            <line x1="30" y1="30" x2="70" y2="70" stroke="#ff4444" stroke-width="5" stroke-linecap="round"/>
                        </svg>
                    </div>
                    <h1>${alreadyBlocked ? 'Site Blocked Today' : 'Time Limit Reached'}</h1>
                    <p>${message}</p>
                    ${alreadyBlocked ? '<p><small>Access will reset at midnight</small></p>' : '<p><small>Site blocked until midnight</small></p>'}
                </div>
                
                <div class="smart-blocker-actions">
                    <button id="overrideBlockBtn" class="smart-blocker-btn override-btn">
                        Override Block
                    </button>
                </div>
                
                <div class="smart-blocker-footer">
                    <p>💡 Manage your blocked domains in the extension settings</p>
                </div>
            </div>
        `;
        
        // Add override button event listener
        const overrideBtn = modal.querySelector('#overrideBlockBtn');
        if (overrideBtn) {
            overrideBtn.addEventListener('click', handleOverrideRequest);
        }
        
        return modal;
    }
    
    function handleOverrideRequest() {
        // Send message to background script to handle override
        chrome.runtime.sendMessage({
            action: 'requestOverride',
            domain: currentDomain,
            url: window.location.href
        }, (response) => {
            if (response && response.success) {
                if (response.requiresPayment) {
                    // Redirect to payment/checkout page
                    if (response.redirectUrl) {
                        window.open(response.redirectUrl, '_blank');
                    } else {
                        showPaymentModal(response.cost);
                    }
                } else {
                    // Override granted, hide modal and allow access
                    hideModal();
                    clearDailyBlock();
                }
            } else {
                if (response && response.reason === 'no_overrides' && response.redirectUrl) {
                    // No overrides remaining, redirect to checkout
                    window.open(response.redirectUrl, '_blank');
                } else {
                    showOverrideError(response ? response.error : 'Override failed');
                }
            }
        });
    }
    
    function showPaymentModal(cost) {
        const paymentModal = document.createElement('div');
        paymentModal.className = 'smart-blocker-payment-modal';
        paymentModal.innerHTML = `
            <div class="smart-blocker-content">
                <h2>Override Block - $${cost}</h2>
                <p>This override will cost $${cost}. Do you want to proceed?</p>
                <div class="payment-actions">
                    <button id="proceedPayment" class="smart-blocker-btn primary">Pay $${cost}</button>
                    <button id="cancelPayment" class="smart-blocker-btn secondary">Cancel</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(paymentModal);
        
        paymentModal.querySelector('#proceedPayment').addEventListener('click', () => {
            // Redirect to payment page
            window.open(`http://localhost:3000/override-payment?domain=${currentDomain}&cost=${cost}`, '_blank');
            document.body.removeChild(paymentModal);
        });
        
        paymentModal.querySelector('#cancelPayment').addEventListener('click', () => {
            document.body.removeChild(paymentModal);
        });
    }
    
    function showOverrideSuccessNotification(domain) {
        // Create beautiful floating notification
        const notification = document.createElement('div');
        notification.className = 'smart-blocker-success-notification';
        notification.innerHTML = `
            <div class="notification-content">
                <div class="success-icon">🎉</div>
                <div class="notification-text">
                    <div class="main-text">Access Granted!</div>
                    <div class="sub-text">Enjoy browsing ${domain}</div>
                </div>
            </div>
        `;
        
        // Add styles for the notification
        const style = document.createElement('style');
        style.textContent = `
            .smart-blocker-success-notification {
                position: fixed !important;
                top: 20px !important;
                right: 20px !important;
                z-index: 2147483647 !important;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
                animation: slideInNotification 0.5s ease-out !important;
            }
            
            @keyframes slideInNotification {
                from {
                    opacity: 0;
                    transform: translateX(100px);
                }
                to {
                    opacity: 1;
                    transform: translateX(0);
                }
            }
            
            .notification-content {
                background: linear-gradient(135deg, #00c851, #007e33) !important;
                color: white !important;
                padding: 16px 20px !important;
                border-radius: 12px !important;
                box-shadow: 0 8px 25px rgba(0, 200, 81, 0.3) !important;
                display: flex !important;
                align-items: center !important;
                gap: 12px !important;
                min-width: 280px !important;
                backdrop-filter: blur(10px) !important;
            }
            
            .success-icon {
                font-size: 24px !important;
                animation: bounce 0.6s ease-out 0.3s both !important;
            }
            
            @keyframes bounce {
                0%, 20%, 50%, 80%, 100% {
                    transform: translateY(0);
                }
                40% {
                    transform: translateY(-10px);
                }
                60% {
                    transform: translateY(-5px);
                }
            }
            
            .notification-text {
                flex: 1 !important;
            }
            
            .main-text {
                font-size: 16px !important;
                font-weight: 600 !important;
                margin-bottom: 2px !important;
            }
            
            .sub-text {
                font-size: 13px !important;
                opacity: 0.9 !important;
            }
        `;
        
        document.head.appendChild(style);
        document.body.appendChild(notification);
        
        // Auto-remove after 3 seconds with fade out
        setTimeout(() => {
            notification.style.animation = 'slideInNotification 0.3s ease-out reverse';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                    style.remove();
                }
            }, 300);
        }, 2700);
    }
    
    function showOverrideError(error) {
        const message = document.createElement('div');
        message.className = 'smart-blocker-override-message error';
        message.innerHTML = `
            <div class="override-error">
                ❌ ${error}
            </div>
        `;
        document.body.appendChild(message);
        
        setTimeout(() => {
            if (message.parentNode) {
                message.parentNode.removeChild(message);
            }
        }, 5000);
    }
    
    function showModal(alreadyBlocked = false) {
        if (!isEnabled) return;
        
        hideModal();
        hideTimer();
        
        const modalElement = createModal(alreadyBlocked);
        
        if (!document.documentElement) {
            setTimeout(() => showModal(alreadyBlocked), 100);
            return;
        }
        
        document.documentElement.appendChild(modalElement);
        document.documentElement.style.overflow = 'hidden';
        
        if (document.body) {
            document.body.style.display = 'none';
        }
        
        // Add modal styles
        if (!document.getElementById('smart-blocker-modal-styles')) {
            const modalStyles = document.createElement('style');
            modalStyles.id = 'smart-blocker-modal-styles';
            modalStyles.textContent = `
                .smart-blocker-modal {
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%) !important;
                    z-index: 2147483647 !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif !important;
                    color: white !important;
                    animation: modalFadeIn 0.5s ease-out !important;
                }
                
                @keyframes modalFadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                
                .smart-blocker-content {
                    max-width: 500px !important;
                    padding: 40px !important;
                    text-align: center !important;
                    background: rgba(255, 255, 255, 0.1) !important;
                    border-radius: 20px !important;
                    backdrop-filter: blur(10px) !important;
                    border: 1px solid rgba(255, 255, 255, 0.2) !important;
                    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3) !important;
                }
                
                .smart-blocker-header h1 {
                    margin: 20px 0 10px 0 !important;
                    font-size: 28px !important;
                    font-weight: 700 !important;
                    color: white !important;
                }
                
                .smart-blocker-header p {
                    margin: 0 0 15px 0 !important;
                    font-size: 16px !important;
                    opacity: 0.9 !important;
                }
                
                .smart-blocker-header small {
                    font-size: 14px !important;
                    opacity: 0.7 !important;
                    font-style: italic !important;
                }
                
                .smart-blocker-footer {
                    margin-top: 30px !important;
                    padding-top: 20px !important;
                    border-top: 1px solid rgba(255, 255, 255, 0.2) !important;
                }
                
                .smart-blocker-footer p {
                    margin: 0 !important;
                    font-size: 12px !important;
                    opacity: 0.7 !important;
                }
            `;
            document.head.appendChild(modalStyles);
        }
        
        chrome.runtime.sendMessage({ action: 'incrementCount' }).catch(() => {});
    }
    
    function hideModal() {
        if (modal && modal.parentNode) {
            modal.parentNode.removeChild(modal);
            modal = null;
        }
        
        if (document.documentElement) {
            document.documentElement.style.overflow = '';
        }
        
        if (document.body) {
            document.body.style.display = '';
        }
    }
    
    // Global initialization function for background script injection
    window.smartBlockerInitialize = initializeWithConfig;
    
    // Global message listener for delayed initialization (when authentication is still initializing)
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'updateConfig' && !isInitialized) {
            // Handle delayed initialization when authentication completes
            if (request.enabled && request.domainConfig) {
                console.log(`Smart Tab Blocker: Received delayed initialization for ${getCurrentDomain()}`);
                initializeWithConfig(request.domainConfig);
                sendResponse({ success: true });
            }
            return true;
        }
        return false; // Let other handlers process the message
    });

    // Check if we have injected config
    if (window.smartBlockerConfig && checkExtensionContext()) {
        initializeWithConfig(window.smartBlockerConfig);
    } else if (checkExtensionContext()) {
        // Check with background script
        checkDomainAndInitialize();
    }
    
    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            if (!isInitialized && checkExtensionContext()) {
                checkDomainAndInitialize();
            }
        });
    }
    
    // Handle page unload to save state
    window.addEventListener('beforeunload', () => {
        if (isEnabled && isInitialized) {
            console.log(`Smart Tab Blocker: Saving timer state before unload - ${timeRemaining}s remaining`);
            // Force immediate save to ensure it completes before page closes
            const storageKey = getStorageKey();
            if (storageKey) {
                const state = {
                    timeRemaining: timeRemaining,
                    isActive: !!countdownTimer,
                    isPaused: isTimerPaused,
                    tabId: getTabId(),
                    timestamp: Date.now(),
                    url: window.location.href,
                    gracePeriod: gracePeriod,
                    date: getTodayString()
                };
                
                try {
                    // Use synchronous storage API for beforeunload
                    localStorage.setItem('_smartBlockerTemp', JSON.stringify({
                        key: storageKey,
                        state: state
                    }));
                } catch (e) {
                    console.error("Smart Tab Blocker: Error saving state to localStorage", e);
                }
                
                // Also try the async API
                try {
                    if (chrome.runtime?.id && chrome.storage?.local?.set) {
                        chrome.storage.local.set({
                            [storageKey]: state
                        }).catch((error) => {
                            if (error.message && error.message.includes('Extension context invalidated')) {
                                console.log("Smart Tab Blocker: Extension context invalidated during beforeunload save");
                            } else {
                                console.log("Smart Tab Blocker: Error saving during beforeunload:", error);
                            }
                        });
                    }
                } catch (e) {
                    console.log("Smart Tab Blocker: Extension context invalidated, cannot save to chrome.storage");
                }
            }
        }
    });
    
    // Check for temporary state in localStorage on startup
    function checkLocalStorageTemp() {
        try {
            const tempData = localStorage.getItem('_smartBlockerTemp');
            if (tempData) {
                const parsed = JSON.parse(tempData);
                if (parsed && parsed.key && parsed.state) {
                    console.log("Smart Tab Blocker: Found temporary state in localStorage, restoring to chrome.storage");
                    try {
                        if (chrome.runtime?.id) {
                            chrome.storage.local.set({
                                [parsed.key]: parsed.state
                            });
                        }
                    } catch (e) {
                        console.log("Smart Tab Blocker: Extension context invalidated, cannot restore to chrome.storage");
                    }
                }
                // Clear the temporary storage
                localStorage.removeItem('_smartBlockerTemp');
            }
        } catch (e) {
            console.error("Smart Tab Blocker: Error checking localStorage", e);
        }
    }
    
    // Check for temporary state on initialization
    checkLocalStorageTemp();
    
    // Periodic extension context check to handle developer tools being opened
    setInterval(() => {
        if (isInitialized && !checkExtensionContext()) {
            console.log('Smart Tab Blocker: Extension context lost, cleaning up');
            isInitialized = false;
            isEnabled = false;
        }
    }, 5000); // Check every 5 seconds
    
    // Prevent escape key from closing modal
    document.addEventListener('keydown', (event) => {
        if (isEnabled && modal && (event.key === 'Escape' || event.keyCode === 27)) {
            event.preventDefault();
            event.stopPropagation();
            return false;
        }
    }, true);
    
    // Listen for messages from popup (for override functionality)
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log('Smart Tab Blocker: Message received:', message);
        
        if (message.action === 'overrideGranted') {
            const currentHostname = getCurrentDomain();
            console.log(`Smart Tab Blocker: Current hostname: ${currentHostname}, Override granted for: ${message.domain}`);
            
            if (currentHostname === message.domain || currentHostname.endsWith('.' + message.domain)) {
                console.log(`Smart Tab Blocker: Override granted for ${message.domain} - allowing access`);
                
                // Clear state and hide any blocking UI
                clearTimerState();
                hideModal();
                hideTimer();
                
                // IMPORTANT: Clear daily block directly in content script
                const blockKey = getDailyBlockKey();
                if (blockKey) {
                    chrome.storage.local.remove([blockKey], () => {
                        console.log(`Smart Tab Blocker: Daily block cleared via override for ${message.domain}`);
                    });
                }
                
                // Ensure page is visible and accessible
                if (document.documentElement) {
                    document.documentElement.style.overflow = '';
                }
                if (document.body) {
                    document.body.style.display = '';
                }
                
                // Stop any running timer
                if (countdownTimer) {
                    clearInterval(countdownTimer);
                    countdownTimer = null;
                }
                
                // Reset flags to allow fresh restart
                isInitialized = false;
                isEnabled = false;
                
                console.log(`Smart Tab Blocker: Override processed for ${message.domain} - restarting timer`);
                
                // Restart the timer immediately with fresh duration
                setTimeout(() => {
                    console.log(`Smart Tab Blocker: Starting fresh ${message.timer}s timer for ${message.domain} after override`);
                    initializeWithConfig({ timer: message.timer });
                }, 300);
                
                // Send response to confirm override was processed
                sendResponse({ success: true, message: 'Override granted successfully' });
            } else {
                console.log(`Smart Tab Blocker: Domain mismatch - current: ${currentHostname}, override: ${message.domain}`);
                sendResponse({ success: false, message: 'Domain does not match' });
            }
            
            return true; // Indicates we will send a response asynchronously
        }
        
        if (message.action === 'startTracking') {
            const currentHostname = getCurrentDomain();
            console.log(`Smart Tab Blocker: Start tracking request - Current: ${currentHostname}, Tracking: ${message.domain}`);
            
            if (currentHostname === message.domain || currentHostname.endsWith('.' + message.domain)) {
                console.log(`Smart Tab Blocker: Starting tracking for ${message.domain} with ${message.timer}s timer`);
                
                // Clear any existing state first
                if (isInitialized) {
                    clearTimerState();
                    hideModal();
                    hideTimer();
                    if (countdownTimer) {
                        clearInterval(countdownTimer);
                        countdownTimer = null;
                    }
                }
                
                // Reset initialization flags
                isInitialized = false;
                isEnabled = false;
                
                // Initialize tracking with the new domain config
                setTimeout(() => {
                    initializeWithConfig({ timer: message.timer });
                }, 100);
                
                sendResponse({ success: true, message: `Started tracking ${message.domain}` });
            } else {
                console.log(`Smart Tab Blocker: Domain mismatch - current: ${currentHostname}, tracking: ${message.domain}`);
                sendResponse({ success: false, message: 'Domain does not match current page' });
            }
            
            return true; // Indicates we will send a response asynchronously
        }
    });
    
    // Listen for storage changes (when daily blocks are cleared)
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
            const blockKey = getDailyBlockKey();
            if (blockKey && changes[blockKey] && changes[blockKey].newValue === undefined) {
                // Daily block was removed - hide modal and reset
                console.log('Smart Tab Blocker: Daily block cleared, restoring access');
                hideModal();
                hideTimer();
                
                // Reset timer state
                if (countdownTimer) {
                    clearInterval(countdownTimer);
                    countdownTimer = null;
                }
                
                // Reset values and restart timer
                timeRemaining = gracePeriod;
                isTimerPaused = false;
                clearTimerState();
                
                // Restart the timer if we're initialized
                if (isInitialized && isEnabled) {
                    startCountdownTimer();
                }
            }
        }
    });
    
    // Listen for messages from background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'overrideGranted' && message.domain === getCurrentDomain()) {
            console.log('Smart Tab Blocker: Override granted, restoring access');
            hideModal();
            hideTimer();
            
            // Reset timer state
            if (countdownTimer) {
                clearInterval(countdownTimer);
                countdownTimer = null;
            }
            
            // Clear daily block and timer state
            clearDailyBlock();
            clearTimerState();
            
                            // Override processed - no additional message needed
            
            sendResponse({ success: true });
        }
    });
    
    // Check for updates from other devices
    function checkForCrossDeviceUpdates() {
        if (!isEnabled || !currentDomain) return;
        
        loadTimerStateFromFirebase().then(firebaseState => {
            if (firebaseState) {
                // Always select the MINIMUM time between current state and Firebase to prevent time inflation
                const currentTime = timeRemaining;
                const firebaseTime = firebaseState.timeRemaining;
                const minimumTime = Math.min(currentTime, firebaseTime);
                
                const timeDifference = Math.abs(firebaseTime - currentTime);
                
                console.log(`Smart Tab Blocker: Cross-device comparison - Current: ${currentTime}s, Firebase: ${firebaseTime}s, Minimum: ${minimumTime}s`);
                
                // Update if there's a difference and use minimum time
                if (timeDifference > 1) {
                    console.log(`Smart Tab Blocker: Cross-device update detected - using minimum time: ${minimumTime}s (difference: ${timeDifference}s)`);
                    
                    // Use minimum time to prevent inflation
                    timeRemaining = minimumTime;
                    gracePeriod = firebaseState.gracePeriod || gracePeriod;
                    
                    // Update display immediately
                    updateTimerDisplay();
                    
                    // If timer has expired, handle blocking immediately
                    if (timeRemaining <= 0) {
                        console.log('Smart Tab Blocker: Timer expired - blocking now');
                        stopCountdownTimer();
                        clearTimerState();
                        markDomainBlockedToday();
                        hideTimer();
                        showModal();
                        return;
                    }
                    
                    // If this tab becomes active and we've updated the time, sync to Chrome storage
                    if (isActiveTab && timeDifference > 2) {
                        saveTimerState();
                    }
                }
                
                // Special case: If either source shows blocked, enforce blocking
                if (firebaseTime <= 0 || currentTime <= 0) {
                    console.log('Smart Tab Blocker: Either Firebase or current state shows blocked - enforcing block');
                    timeRemaining = 0;
                    stopCountdownTimer();
                    clearTimerState();
                    markDomainBlockedToday();
                    hideTimer();
                    showModal();
                }
            }
        }).catch(error => {
            console.log('Smart Tab Blocker: Error checking for cross-device updates:', error);
        });
    }
    
})(); 