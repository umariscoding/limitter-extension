(function() {
    'use strict';
    
    function isExtensionContextValid() {
        try {
            return !!(chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
        } catch (e) {
            return false;
        }
    }
    
    if (!isExtensionContextValid()) {
        console.log('Limitter: Extension context not available, content script will not initialize');
        return;
    }
    
    // Monitor extension context throughout execution
    function checkExtensionContext() {
        if (!isExtensionContextValid()) {
            console.log('Limitter: Extension context lost during execution');
            // Clean up any running timers
            if (countdownTimer) {
                clearInterval(countdownTimer);
                countdownTimer = null;
            }
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
    let isInitializing = true;
    
    // Override state variables
    let currentOverrideActive = false;
    let currentOverrideInitiatedBy = null;
    let currentOverrideInitiatedAt = null;
    let currentTimeLimit = null;
    let overrideClearTimeout = null; 
    
    // Add at the top with other variables
    let lastResetTimestamp = 0;
    
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
                    console.log("Limitter: Extension context invalidated, cannot check if domain is blocked");
                    resolve(false);
                    return;
                }
                
                chrome.storage.local.get([blockKey], (result) => {
                    if (chrome.runtime.lastError) {
                        console.log("Limitter: Error checking if domain is blocked:", chrome.runtime.lastError);
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
                console.log("Limitter: Extension context invalidated, cannot check if domain is blocked");
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
                    syncTimerToFirebase();
                }).catch((error) => {
                    if (error.message && error.message.includes('Extension context invalidated')) {
                        console.log("Limitter: Extension context invalidated, cannot mark domain as blocked");
                    } else {
                        console.error("Limitter: Error marking domain as blocked", error);
                    }
                });
            } else {
                console.log("Limitter: Extension context invalidated, cannot mark domain as blocked");
            }
        } catch (e) {
            console.log("Limitter: Extension context invalidated, cannot mark domain as blocked");
        }
        
    }
    
    function syncFromFirebaseOnTabSwitch() {
        return new Promise((resolve) => {
            if (!currentDomain) {
                resolve();
                return;
            }
            
            // Step 1: Load current state from Firebase
            loadTimerStateFromFirebase().then(firebaseState => {
                const storageKey = getStorageKey();
                if (!storageKey) {
                    if (firebaseState && firebaseState.timeRemaining >= 0) {
                        timeRemaining = firebaseState.timeRemaining;
                        gracePeriod = firebaseState.gracePeriod || gracePeriod;
                        updateTimerDisplay();
                    }
                    resolve();
                    return;
                }
                
                chrome.storage.local.get([storageKey], (result) => {
                    if (chrome.runtime.lastError) {
                        console.log("Limitter: Error loading Chrome storage for comparison:", chrome.runtime.lastError);
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
                    if (firebaseState && firebaseState.timeRemaining >= 0) {
                        const firebaseTime = firebaseState.timeRemaining;
                        
                        // Get timestamps
                        const firebaseResetTime = firebaseState.last_reset_timestamp || 0;
                        const chromeResetTime = chromeState?.last_reset_timestamp || 0;
                        const now = Date.now();
                        
                        console.log('Timer State Comparison:', {
                            firebaseTime,
                            chromeTimeRemaining,
                            firebaseResetTime: new Date(firebaseResetTime).toISOString(),
                            chromeResetTime: chromeResetTime ? new Date(chromeResetTime).toISOString() : 'none',
                            timeDifference: Math.abs(firebaseTime - chromeTimeRemaining),
                            resetTimeDifference: Math.abs(firebaseResetTime - chromeResetTime)
                        });
                        console.log("lastResetTimestamp", lastResetTimestamp, chromeResetTime)
                        // Case 1: Firebase has a more recent reset
                        if (firebaseResetTime > chromeResetTime) {
                            console.log('Using Firebase time due to more recent reset');
                            timeRemaining = firebaseTime;
                            // lastResetTimestamp = firebaseResetTime;
                        }
                        // Case 2: Chrome has a more recent reset
                        else if (chromeResetTime > firebaseResetTime) {
                            console.log('Using Chrome time due to more recent reset');
                            timeRemaining = chromeTimeRemaining;
                            // Update Firebase with our more recent reset
                            setTimeout(() => {
                                syncTimerToFirebase();
                            }, 500);
                        }
                        // Case 3: Same reset time or no resets - use minimum time
                        else {
                            if (firebaseTime <= chromeTimeRemaining) {
                                console.log('Using Firebase time (lower value)');
                                timeRemaining = firebaseTime;
                            } else {
                                console.log('Using Chrome time (lower value)');
                                timeRemaining = chromeTimeRemaining;
                                // Update Firebase with the lower time
                                setTimeout(() => {
                                    syncTimerToFirebase();
                                }, 500);
                            }
                        }
                        
                        // Always update grace period from Firebase if available
                        gracePeriod = firebaseState.gracePeriod || gracePeriod;
                    } else if (chromeTimeRemaining !== null) {
                        // Only Chrome storage has data
                        console.log('Using Chrome time (no Firebase data)');
                        timeRemaining = chromeTimeRemaining;
                        
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
                console.log('Limitter: Error loading from Firebase on tab switch:', error);
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
                        console.log("Limitter: Error syncing from shared state:", chrome.runtime.lastError);
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
                        
                        // console.log(`Limitter: Cross-tab sync - Current: ${currentTime}s, Shared: ${sharedTimeRemaining}s, Using minimum: ${minimumTime}s`);
                        
                        timeRemaining = minimumTime;
                        gracePeriod = sharedState.gracePeriod || gracePeriod;
                        lastSyncTime = now;
                        
                        // console.log(`Limitter: Synced from shared state - ${timeRemaining}s remaining (was ${sharedState.timeRemaining}s, ${timeDiff}s elapsed)`);
                        
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
                console.log("Limitter: Extension context invalidated during sync");
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
            
            console.log(`Limitter: Attempting to load timer state for ${getCurrentDomain()}`);
            
            // First, try to load from Firebase for cross-device syncing
            loadTimerStateFromFirebase().then(firebaseState => {
                console.log("firebaseState", firebaseState)
                if (firebaseState && firebaseState.timeRemaining > 0) {
                    console.log(`Limitter: Loaded timer state from Firebase (cross-device) with ${firebaseState.timeRemaining}s remaining`);
                    resolve(firebaseState);
                    return;
                }
                
                // If no Firebase state, fall back to Chrome storage
                try {
                    if (!chrome.runtime?.id) {
                        console.log("Limitter: Extension context invalidated, cannot load timer state");
                        resolve(null);
                        return;
                    }
                    
                    chrome.storage.local.get([storageKey], (result) => {
                        if (chrome.runtime.lastError) {
                            console.log("Limitter: Error loading timer state:", chrome.runtime.lastError);
                            resolve(null);
                            return;
                        }
                        
                        const state = result[storageKey];
                        console.log("Limitter: Retrieved state from Chrome storage:", state);
                        
                        if (state && state.date === getTodayString()) {
                            // Only restore if same day - we're more lenient about URL to handle subdomain variations
                            console.log(`Limitter: Found saved timer state with ${state.timeRemaining}s remaining`);
                            lastResetTimestamp = state.last_reset_timestamp;
                            // Update override state variables from Chrome storage
                            console.log("last reset timestamp ", state.last_reset_timestamp)
                            if (state.override_active) {
                                console.log("state.override_active", state.override_active)
                                setOverrideActive(state.override_initiated_by, state.override_initiated_at);
                            } else {
                                currentOverrideActive = false;
                                currentOverrideInitiatedBy = null;
                                currentOverrideInitiatedAt = null;
                            }
                            currentTimeLimit = state.time_limit || gracePeriod;
                            
                            resolve(state);
                            return;
                        }
                        
                        // Clean up old state
                        if (state && state.date !== getTodayString()) {
                            console.log("Limitter: Clearing outdated timer state");
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
                                    console.log("Limitter: Error checking domain tracking:", chrome.runtime.lastError);
                                    return;
                                }
                                
                                if (response && response.shouldTrack === false) {
                                    console.log("Limitter: Domain no longer tracked, clearing all state");
                                    clearAllStateForDomain();
                                }
                            });
                        }
                        
                        resolve(null);
                    });
                } catch (e) {
                    console.log("Limitter: Extension context invalidated, cannot load timer state");
                    resolve(null);
                }
            }).catch(error => {
                console.log("Limitter: Error loading from Firebase, falling back to Chrome storage:", error);
                // Fall back to Chrome storage if Firebase fails
                try {
                    if (!chrome.runtime?.id) {
                        resolve(null);
                        return;
                    }
                    
                    chrome.storage.local.get([storageKey], (result) => {
                        const state = result[storageKey];
                        if (state && state.date === getTodayString()) {
                            // Update override state variables from Chrome storage
                            if (state.override_active) {
                                console.log("state.override_active 2", state.override_active)
                                setOverrideActive(state.override_initiated_by, state.override_initiated_at);
                            } else {
                                currentOverrideActive = false;
                                currentOverrideInitiatedBy = null;
                                currentOverrideInitiatedAt = null;
                            }
                            currentTimeLimit = state.time_limit || gracePeriod;
                            
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
                        console.log('Limitter: Error loading timer from Firebase:', chrome.runtime.lastError);
                        resolve(null);
                        return;
                    }
                    
                    if (response && response.success && response.timerState) {
                        const firebaseState = response.timerState;
                        console.log("firebaseState ", firebaseState)
                        // Update reset timestamp if Firebase has a more recent one
                        if (firebaseState.last_reset_timestamp > lastResetTimestamp) {
                            lastResetTimestamp = firebaseState.last_reset_timestamp;
                            // If Firebase has a more recent reset, use its time
                            timeRemaining = firebaseState.timeRemaining;
                        }
                        
                        // Update override state variables
                        if (firebaseState.override_active) {
                            console.log("firebaseState.override_active 3", firebaseState.override_active)
                            setOverrideActive(firebaseState.override_initiated_by, firebaseState.override_initiated_at);
                        } else {
                            currentOverrideActive = false;
                            currentOverrideInitiatedBy = null;
                            currentOverrideInitiatedAt = null;
                        }
                        currentTimeLimit = firebaseState.time_limit || gracePeriod;
                        
                        resolve({
                            ...firebaseState,
                            timeRemaining: firebaseState.timeRemaining
                        });
                    } else {
                        console.log('Limitter: No timer state found in Firebase');
                        resolve(null);
                    }
                });
            } catch (error) {
                console.log('Limitter: Exception while loading from Firebase:', error);
                resolve(null);
            }
        });
    }
    
    // Save timer state to storage
    function saveTimerState() {
        const storageKey = getStorageKey();
        if (!storageKey) return;
        console.log("timeRemaining", timeRemaining)
        const state = {
            timeRemaining: timeRemaining,
            isActive: !!countdownTimer && isActiveTab, // Only active tab should be marked as running the timer
            isPaused: isTimerPaused,
            tabId: getTabId(),
            timestamp: Date.now(),
            url: window.location.href,
            gracePeriod: gracePeriod,
            date: getTodayString(),
            activeTabId: isActiveTab ? getTabId() : null, // Track which tab is currently active
            override_active: currentOverrideActive, // Preserve override state
            override_initiated_by: currentOverrideInitiatedBy,
            override_initiated_at: currentOverrideInitiatedAt,
            time_limit: currentTimeLimit,
            last_reset_timestamp: lastResetTimestamp // Add reset timestamp
        };
        console.log("state", state)
        console.log(`Limitter: Saving timer state with ${timeRemaining}s remaining (active: ${isActiveTab}, hasLoadedFromFirebase: ${hasLoadedFromFirebase})`);
        
        try {
            if (chrome.runtime?.id) {
                chrome.storage.local.set({
                    [storageKey]: state
                }).then(() => {
                    // Only sync to Firebase if we've loaded the current state first
                    // This prevents race conditions where new devices overwrite existing progress
                    // if (hasLoadedFromFirebase && !isInitializing) {
                    //     syncTimerToFirebase();
                    // } else {
                    //     console.log('Limitter: Skipping Firebase sync - still initializing or haven\'t loaded from Firebase yet');
                    // }
                }).catch((error) => {
                    if (error.message && error.message.includes('Extension context invalidated')) {
                        console.log("Limitter: Extension context invalidated, cannot save timer state");
                    } else {
                        console.error("Limitter: Error saving timer state", error);
                    }
                });
            } else {
                console.log("Limitter: Extension context invalidated, cannot save timer state");
            }
        } catch (e) {
            console.log("Limitter: Extension context invalidated, cannot save timer state");
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
                        console.log("Limitter: Extension context invalidated, cannot clear timer state");
                    } else {
                        console.log("Limitter: Error clearing timer state:", error);
                    }
                });
            } else {
                console.log("Limitter: Extension context invalidated, cannot clear timer state");
            }
        } catch (e) {
            console.log("Limitter: Extension context invalidated, cannot clear timer state");
        }
    }
    
    function clearDailyBlock() {
        const blockKey = getDailyBlockKey();
        if (!blockKey) return;
        
        try {
            if (chrome.runtime?.id) {
                chrome.storage.local.remove([blockKey]).catch((error) => {
                    if (error.message && error.message.includes('Extension context invalidated')) {
                        console.log("Limitter: Extension context invalidated, cannot clear daily block");
                    } else {
                        console.error("Limitter: Error clearing daily block", error);
                    }
                });
            } else {
                console.log("Limitter: Extension context invalidated, cannot clear daily block");
            }
        } catch (e) {
            console.log("Limitter: Extension context invalidated, cannot clear daily block");
        }
    }

    // Set override active and schedule automatic clearing
    function setOverrideActive(userId, initiatedAt) {
        currentOverrideActive = true;
        currentOverrideInitiatedBy = userId;
        currentOverrideInitiatedAt = initiatedAt;
        console.log("initiatedAt", initiatedAt, "currentOverrideActive", currentOverrideActive, "currentOverrideInitiatedBy", currentOverrideInitiatedBy, "currentOverrideInitiatedAt", currentOverrideInitiatedAt)
        // Clear any existing timeout
        if (overrideClearTimeout) {
            clearTimeout(overrideClearTimeout);
        }
        
        overrideClearTimeout = setTimeout(() => {
            console.log('Limitter: Automatically clearing override_active after timeout');
            clearOverrideActive();
        }, 6000);
    }

    // Clear override active state
    function clearOverrideActive() {
        if (!currentOverrideActive) return;
        
        console.log('Limitter: Clearing override_active state');
        currentOverrideActive = false;
        
        // Clear timeout if it exists
        if (overrideClearTimeout) {
            clearTimeout(overrideClearTimeout);
            overrideClearTimeout = null;
        }
        
        // Save updated state to Chrome storage
        saveTimerState();
        currentOverrideActive = false;
        // Sync to Firebase
        if (hasLoadedFromFirebase && !isInitializing) {
            syncTimerToFirebase();
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
        currentTimeLimit = gracePeriod; // Initialize time limit
        
        // console.log(`Limitter: Initializing for ${currentDomain} with ${gracePeriod}s timer`);
        
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
                    // console.log('Limitter: Timer state changed by another tab, syncing...');
                    syncFromSharedState();
                }
            }
        });
        
        // First check if domain is blocked for today
        isDomainBlockedToday().then(isBlocked => {
            if (isBlocked) {
                console.log(`Limitter: ${currentDomain} is already blocked for today`);
                showModal(true); // true = already blocked
                return;
            }
            
            // For cross-device syncing, ALWAYS check Firebase first (more aggressive)
            // console.log(`Limitter: Checking Firebase first for cross-device state...`);
            loadTimerStateFromFirebase().then(firebaseState => {
                // Mark that we've attempted to load from Firebase
                hasLoadedFromFirebase = true;
                
                // // Set up real-time listener for this specific blocked site
                // try {
                //     chrome.runtime.sendMessage({
                //         action: 'setupRealtimeListener',
                //         domain: currentDomain
                //     }, (response) => {
                //         if (response && response.success) {
                //             console.log(`Firebase Realtime Listener: Set up successfully for ${currentDomain}`);
                //         }
                //     });
                // } catch (error) {
                //     console.error('Failed to set up realtime listener:', error);
                // }
                
                // Check if we have local saved state first
                let localTimeRemaining = null;
                if (domainConfig.savedState && domainConfig.savedState.timeRemaining > 0) {
                    localTimeRemaining = domainConfig.savedState.timeRemaining;
                    console.log(`Limitter: Found local saved state: ${localTimeRemaining}s`);
                } else {
                    // Check Chrome storage as fallback
                    const storageKey = getStorageKey();
                    if (storageKey) {
                        try {
                            chrome.storage.local.get([storageKey], (result) => {
                                const state = result[storageKey];
                                if (state && state.timeRemaining > 0 && state.date === getTodayString()) {
                                    // Calculate elapsed time
                                    const now = Date.now();
                                    const timeDiff = Math.floor((now - state.timestamp) / 1000);
                                    const calculatedTime = state.isActive && !state.isPaused 
                                        ? Math.max(0, state.timeRemaining - timeDiff)
                                        : state.timeRemaining;
                                    
                                    if (calculatedTime > 0) {
                                        localTimeRemaining = calculatedTime;
                                        console.log(`Limitter: Found Chrome storage state: ${localTimeRemaining}s`);
                                    }
                                }
                            });
                        } catch (error) {
                            console.log('Limitter: Error reading Chrome storage:', error);
                        }
                    }
                }
                
                // If we have both Firebase and local time, or just local time, send site opened signal
                if (localTimeRemaining !== null || (firebaseState && firebaseState.timeRemaining > 0)) {
                    const timeToSend = localTimeRemaining || (firebaseState ? firebaseState.timeRemaining : null);
                    console.log("timeToSend", timeToSend, "firebaseState", firebaseState)
                    if (timeToSend && timeToSend > 0) {
                        console.log(`Limitter: Sending site opened signal with time: ${timeToSend}s`);
                        if(firebaseState!=null){
                        // Send site opened signal for cross-device sync
                        chrome.runtime.sendMessage({
                            action: 'siteOpened',
                            domain: currentDomain,
                            localTimeRemaining: timeToSend
                        }, (response) => {
                            if (response && response.success) {
                                console.log(`Limitter: Site opened signal sent successfully: ${response.result.message}`);
                            } else {
                                console.log('Limitter: Site opened signal failed:', response?.error);
                            }
                        });
                    }
                    console.log("localTimeRemaining", localTimeRemaining, "firebaseState", firebaseState)
                        // Use the local time if available, otherwise use Firebase time
                        if(firebaseState?.timeRemaining != 3600){
                        timeRemaining = localTimeRemaining || firebaseState.timeRemaining;
                        }
                        gracePeriod = (domainConfig.savedState?.gracePeriod) || 
                                     (firebaseState?.gracePeriod) || 
                                     gracePeriod;
                        isTimerPaused = (domainConfig.savedState?.isPaused) || 
                                       (firebaseState?.isPaused) || 
                                       document.hidden;
                        
                        // Wait a bit for cross-device sync, then start timer
                        setTimeout(() => {
                            isInitializing = false;
                            startCountdownTimer(true);
                        }, 1000); // Give time for cross-device sync
                        
                        return;
                    }
                }
                
                // Handle the rest of the cases as before
                if (firebaseState && firebaseState.timeRemaining > 0) {
                    // Firebase has valid state - use it (this handles cross-device syncing)
                    // console.log(`Limitter: Using Firebase state (cross-device) with ${firebaseState.timeRemaining}s remaining`);
                    timeRemaining = firebaseState.timeRemaining;
                    gracePeriod = firebaseState.gracePeriod || gracePeriod;
                    isTimerPaused = firebaseState.isPaused || document.hidden;
                    
                    // Finish initialization and start timer
                    isInitializing = false;
                    startCountdownTimer(true);
                    return;
                } else if (firebaseState && firebaseState.timeRemaining <= 0) {
                    // Firebase shows site is blocked
                    console.log(`Limitter: Firebase shows site is blocked`);
                    isInitializing = false;
                    showModal(true);
                    return;
                }
                
                // No Firebase state, check if we have local saved state
                if (domainConfig.savedState) {
                    // console.log(`Limitter: Using provided saved state with ${domainConfig.savedState.timeRemaining}s remaining`);
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
                            // console.log(`Limitter: Using Chrome storage state with ${savedState.timeRemaining}s remaining`);
                            timeRemaining = savedState.timeRemaining;
                            gracePeriod = savedState.gracePeriod || gracePeriod;
                            isTimerPaused = savedState.isPaused || document.hidden;
                            
                            // Finish initialization and start timer
                            isInitializing = false;
                            startCountdownTimer(true);
                        } else {
                            // console.log(`Limitter: Starting fresh timer with ${gracePeriod}s`);
                            // Finish initialization and start timer
                            isInitializing = false;
                            startCountdownTimer();
                        }
                    });
                }
            }).catch(error => {
                console.log('Limitter: Error loading from Firebase, falling back to local state:', error);
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
            // console.log('Limitter: Message received:', request);
            // console.log('request.action', request.action);
            if (request.action === 'updateConfig') {
                if (request.enabled && request.domainConfig) {
                    // Domain is still tracked, update config
                    gracePeriod = request.domainConfig.timer;
                    currentTimeLimit = gracePeriod; // Update time limit
                    
                    if (request.overrideActivated) {
                        // Override was activated - reset timer completely
                        console.log(`Limitter: Override activated, resetting timer to ${gracePeriod}s`);
                        timeRemaining = gracePeriod;
                        setOverrideActive(null, new Date().toISOString());
                        stopCountdownTimer();
                        startCountdownTimer();
                    } else if (!countdownTimer) {
                        // No existing timer, start new one
                        timeRemaining = gracePeriod;
                        startCountdownTimer();
                    }
                    sendResponse({ success: true });
                } else {
                    // Domain was removed from tracking or extension disabled
                    // console.log('Limitter: Domain removed from tracking or extension disabled');
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
                console.log(`Limitter: Received direct command to stop tracking ${getCurrentDomain()}`);
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
            } else if (request.action === 'overrideActiveChanged') {
                // Handle Firebase realtime update for override_active property
                console.log(`Firebase Realtime Update: override_active changed for ${request.domain}: ${request.override_active}`);
                
                if (request.override_active) {
                    console.log(`Override activated for ${request.domain} from another device - updating local state`);
                    console.log("request.data", request.data)
                    // Update local override state if this matches current domain
                        // Follow the EXACT same pattern as when override button is clicked
                        // Use the time_limit as the full timer value (like originalTimeLimit in popup)
                        const originalTimeLimit = request.data.time_limit;
                        
                        console.log(`Firebase override: resetting timer to full time_limit: ${originalTimeLimit}s`);
                        timeRemaining = originalTimeLimit; // Reset to full time like override button click
                        currentTimeLimit = originalTimeLimit;
                        gracePeriod = originalTimeLimit;
                        
                        console.log("setting override active 5")
                        // Set override active with automatic clearing after 4 seconds (same as override button)
                        setOverrideActive(null, new Date().toISOString());
                        
                        // Stop existing timer and start fresh (same as override button)
                        stopCountdownTimer();
                        startCountdownTimer();
                        
                        // Update timer display immediately to show the reset time
                        updateTimerDisplay();
                        
                        // Notify popup of timer update (same as override button)
                        sendTimerUpdateToPopup();
                        
                        // Save the new state (same as override button)
                        saveTimerState();
                        
                        // Also update Chrome sync storage to ensure domain is properly tracked
                        try {
                            chrome.storage.sync.get(['blockedDomains'], (result) => {
                                const domains = result.blockedDomains || {};
                                domains[request.domain] = originalTimeLimit;
                                chrome.storage.sync.set({
                                    blockedDomains: domains
                                }, () => {
                                    console.log(`Chrome sync storage updated for ${request.domain} with timer: ${domains[request.domain]}s`);
                                });
                            });
                        } catch (error) {
                            console.error('Error updating Chrome sync storage:', error);
                        }
                        
                        // Clear any daily block since override is active
                        clearDailyBlock();
                        clearOverrideActive();
                        console.log(`Timer reset to full time due to override from another device: ${timeRemaining}s remaining`);
                        console.log(`Chrome local and sync storage updated with Firebase override state`);
                    }
                // } else {
                //     console.log(`Override deactivated for ${request.domain} from another device`);
                    
                //     // Clear override state if this matches current domain
                //     if (getCurrentDomain() === request.domain) {
                //         clearOverrideActive();
                        
                //         // Update Chrome local storage after clearing override
                //         saveTimerState();
                        
                //         console.log(`Chrome local storage updated - override cleared`);
                //     }
                // }
                
                sendResponse({ success: true });
            } else if (request.action === 'getTimerState') {
                // Return current timer state for tab switch detection
                sendResponse({ 
                    timeRemaining: timeRemaining,
                    isActive: isEnabled,
                    gracePeriod: gracePeriod
                });
            } else if (request.action === 'updateTimer') {
                // Update timer from background script (for cross-device sync)
                if (typeof request.timeRemaining === 'number' && request.timeRemaining >= 0) {
                    console.log(`🔄 Updating timer from background script: ${timeRemaining}s → ${request.timeRemaining}s`);
                    timeRemaining = request.timeRemaining;
                    updateTimerDisplay();
                    
                    // Save the updated state
                    saveTimerState();
                    
                    // If timer expired, handle blocking
                    if (timeRemaining <= 0) {
                        stopCountdownTimer();
                        clearTimerState();
                        markDomainBlockedToday();
                        hideTimer();
                        showModal();
                    }
                }
                sendResponse({ success: true });
            } else if (request.action === 'domainDeactivated') {
                // Handle domain deactivation from Firebase realtime update
                console.log(`Firebase Realtime Update: Domain deactivated for ${request.domain}`);
                console.log("request.data", request.data);
                
                // Check if this matches current domain
                if (getCurrentDomain() === request.domain) {
                    console.log(`Domain ${request.domain} deactivated from another device - stopping tracking immediately`);
                    
                    // Immediately stop all tracking for this domain
                    isEnabled = false;
                    isInitialized = false;
                    stopCountdownTimer();
                    clearTimerState();
                    hideTimer();
                    hideModal();
                    
                    // Clear daily blocks for this domain
                    clearDailyBlock();
                    
                    // Clear from Chrome sync storage
                    try {
                        chrome.storage.sync.get(['blockedDomains'], (result) => {
                            const domains = result.blockedDomains || {};
                            delete domains[request.domain];
                            chrome.storage.sync.set({
                                blockedDomains: domains
                            }, () => {
                                console.log(`Chrome sync storage updated - removed ${request.domain}`);
                            });
                        });
                    } catch (error) {
                        console.error('Error updating Chrome sync storage:', error);
                    }
                    
                    console.log(`Domain ${request.domain} completely stopped tracking due to deactivation from another device`);
                }
                
                sendResponse({ success: true });
            }
            
            return true; // Keep message channel open for async response
        });
    }
    
    // Check if current domain should be tracked
    function checkDomainAndInitialize() {
        // console.log(`Limitter: Checking domain ${getCurrentDomain()}`);
        
        // Check extension context before proceeding
        if (!checkExtensionContext()) {
            console.log('Limitter: Extension context not available, cannot initialize');
            return;
        }
        
        // Notify background script that we're checking this domain
        chrome.runtime.sendMessage({ 
            action: 'contentScriptLoaded', 
            domain: getCurrentDomain() 
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.log('Limitter: Error communicating with background script:', chrome.runtime.lastError);
                // Retry after a delay if there's a communication error
                setTimeout(() => {
                    console.log('Limitter: Retrying domain check...');
                    checkDomainAndInitialize();
                }, 3000);
                return;
            }
            
            // If background responds that authentication is still initializing, wait for retry
            // if (response && response.initializing) {
            //     console.log(`Limitter: Background script is still initializing for ${getCurrentDomain()}, waiting for retry`);
            //     return; // Background will send updateConfig message when ready
            // }
            
            // If background responds that domain should not be tracked, stop initialization
            if (response && response.shouldTrack === false) {
                // console.log('Response:', response);
                console.log(`Limitter: Background script says not to track ${getCurrentDomain()}`);
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
                console.log(`Limitter: ${getCurrentDomain()} is already blocked for today`);
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
                            console.log(`Limitter: Domain no longer tracked, ignoring saved state`);
                            clearAllStateForDomain();
                            return;
                        }
                        
                        console.log(`Limitter: Restoring from saved timer state with ${savedState.timeRemaining}s remaining`);
                        // We have saved state, initialize with it
                        initializeWithConfig({ 
                            timer: savedState.gracePeriod || 20,
                            savedState: savedState
                        });
                    });
                } else {
                    // No saved state, proceed with normal initialization
                    // console.log(`Limitter: No saved state, requesting domain config`);
                    chrome.runtime.sendMessage({ action: 'getDomainConfig' }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error("Limitter: Error getting domain config", chrome.runtime.lastError);
                            // Retry after delay if there's an error
                            setTimeout(() => {
                                console.log('Limitter: Retrying domain config request...');
                                initializeDomainTracking();
                            }, 3000);
                            return;
                        }
                        
                        if (response && response.domainConfig) {
                            initializeWithConfig(response.domainConfig);
                        } else if (response && response.shouldTrack === false) {
                            // console.log(`Limitter: Domain ${getCurrentDomain()} should not be tracked`);
                            clearAllStateForDomain();
                        } else {
                            // console.log('Limitter: No domain config received, may need to retry');
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
        console.log(`Limitter: Cleaning up all state for ${getCurrentDomain()}`);
        
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
            // console.log('Limitter: Firebase syncing enabled');
        }, 1000); // 1 second delay to prevent race conditions
    }

    function startCountdownTimer(isResuming = false) {
        if (!isEnabled || !checkExtensionContext()) return;
        
        // If timer is already running, don't start a new one
        if (countdownTimer) {
            console.log('Limitter: Timer already running, not starting new one');
            return;
        }
        
        // Only set initial time if we're not resuming and haven't loaded from Firebase
        if (!isResuming && !hasLoadedFromFirebase) {
            console.log('Limitter: Starting fresh timer - waiting for Firebase load');
            return; // Don't start timer until we've loaded from Firebase
        }
        
        // If starting fresh (not resuming), set initial time
        // if (!isResuming) {
        //     // timeRemaining = gracePeriod;
        //     // If starting fresh, enable Firebase sync after a delay
        //     // enableFirebaseSync();
        // }
        
        isTimerPaused = document.hidden;
        isActiveTab = !document.hidden; // Set active status based on visibility
        
        showTimer();
        updateTimerDisplay();
        
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
                    
                    if (timeRemaining <= 0) {
                        stopCountdownTimer();
                        clearTimerState();
                        markDomainBlockedToday(); // Mark as blocked for the day
                        syncTimerToFirebase(); // Final sync when timer completes
                        hideTimer();
                        showModal();
                        return;
                    }
                }
            } else {
                updateTimerDisplay();
            }
        }, 1000);
        
        // Immediate save when timer starts
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
            return Promise.resolve();
        }
        
        // Extra protection: Don't sync during initialization
        if (isInitializing || !hasLoadedFromFirebase) {
            console.log('Limitter: Skipping Firebase sync - initialization not complete');
            return Promise.resolve();
        }
        
        // console.log(`Limitter: Syncing timer to Firebase for ${currentDomain} - ${timeRemaining}s remaining`);
        
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({
                    action: 'syncTimerToFirebase',
                    domain: currentDomain,
                    timeRemaining: timeRemaining,
                    gracePeriod: gracePeriod,
                    isActive: true,
                    isPaused: isTimerPaused,
                    timestamp: Date.now(),
                    override_active: currentOverrideActive,
                    override_initiated_by: currentOverrideInitiatedBy,
                    override_initiated_at: currentOverrideInitiatedAt,
                    time_limit: currentTimeLimit,
                }, (response) => {
                    console.log("response", response)
                    if (chrome.runtime.lastError) {
                        console.log('Limitter: Error syncing timer to Firebase:', chrome.runtime.lastError);
                        resolve();
                        return;
                    }
                    
                    if (response && response.success) {
                        // console.log(`Limitter: Timer synced to Firebase successfully for ${currentDomain}`);
                    } else {
                        console.log('Limitter: Failed to sync timer to Firebase:', response?.error);
                    }
                    resolve();
                });
            } catch (error) {
                console.log('Limitter: Exception while syncing timer to Firebase:', error);
                resolve();
            }
        });
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
                </div>
                
                <div class="smart-blocker-footer">
                    <p>💡 Manage your blocked domains in the extension settings</p>
                </div>
            </div>
        `;
        
        
        
        return modal;
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
                console.log(`Limitter: Received delayed initialization for ${getCurrentDomain()}`);
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
            // console.log(`Limitter: Saving timer state before unload - ${timeRemaining}s remaining`);
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
                    console.error("Limitter: Error saving state to localStorage", e);
                }
                
                // Also try the async API
                try {
                    if (chrome.runtime?.id && chrome.storage?.local?.set) {
                        chrome.storage.local.set({
                            [storageKey]: state
                        }).catch((error) => {
                            if (error.message && error.message.includes('Extension context invalidated')) {
                                console.log("Limitter: Extension context invalidated during beforeunload save");
                            } else {
                                console.log("Limitter: Error saving during beforeunload:", error);
                            }
                        });
                    }
                } catch (e) {
                    console.log("Limitter: Extension context invalidated, cannot save to chrome.storage");
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
                    // console.log("Limitter: Found temporary state in localStorage, restoring to chrome.storage");
                    try {
                        if (chrome.runtime?.id) {
                            chrome.storage.local.set({
                                [parsed.key]: parsed.state
                            });
                        }
                    } catch (e) {
                        console.log("Limitter: Extension context invalidated, cannot restore to chrome.storage");
                    }
                }
                // Clear the temporary storage
                localStorage.removeItem('_smartBlockerTemp');
            }
        } catch (e) {
            console.error("Limitter: Error checking localStorage", e);
        }
    }
    
    // Check for temporary state on initialization
    checkLocalStorageTemp();
    
    // Periodic extension context check to handle developer tools being opened
    setInterval(() => {
        if (isInitialized && !checkExtensionContext()) {
            console.log('Limitter: Extension context lost, cleaning up');
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
    

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // console.log('Limitter: Message received:', message);
        
        if (message.action === 'startTracking') {
            const currentHostname = getCurrentDomain();
            console.log(`Limitter: Start tracking request - Current: ${currentHostname}, Tracking: ${message.domain}`);
            
            const cleanCurrentHostname = currentHostname.replace(/^www\./, '');
            const cleanMessageDomain = message.domain.replace(/^www\./, '');
            if (cleanCurrentHostname === cleanMessageDomain || currentHostname === message.domain) {
                console.log(`Limitter: Starting tracking for ${message.domain} with ${message.timer}s timer`);
                
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
                console.log(`Limitter: Domain mismatch - current: ${currentHostname}, tracking: ${message.domain}`);
                sendResponse({ success: false, message: 'Domain does not match current page' });
            }
            
            return true; // Indicates we will send a response asynchronously
        }
        
        // Handle timer update requests from popup
        if (message.action === 'requestTimerUpdate') {
            console.log('Limitter: Timer update requested by popup');
            if (isEnabled && currentDomain) {
                updateTimerDisplay();
                sendResponse({ success: true, message: 'Timer update sent' });
            } else {
                sendResponse({ success: false, message: 'No active timer' });
            }
            return true;
        }
    });
    
    // Listen for storage changes (when daily blocks are cleared)
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
            const blockKey = getDailyBlockKey();
            if (blockKey && changes[blockKey] && changes[blockKey].newValue === undefined) {
                // Daily block was removed - hide modal and reset
                // console.log('Limitter: Daily block cleared, restoring access');
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
    
    function checkForCrossDeviceUpdates() {
        if (!isEnabled || !currentDomain) return;
        
        loadTimerStateFromFirebase().then(firebaseState => {
            if (firebaseState) {
                const currentTime = timeRemaining;
                const firebaseTime = firebaseState.timeRemaining;
                const minimumTime = Math.min(currentTime, firebaseTime);
                const timeDifference = Math.abs(firebaseTime - currentTime);
                
                console.log(`Limitter: Cross-device comparison - Current: ${currentTime}s, Firebase: ${firebaseTime}s, Minimum: ${minimumTime}s`);
                
                // Update if there's a difference and use minimum time
                if (timeDifference > 1) {
                    console.log(`Limitter: Cross-device update detected - using minimum time: ${minimumTime}s (difference: ${timeDifference}s)`);
                    
                    // Use minimum time to prevent inflation
                    timeRemaining = minimumTime;
                    gracePeriod = firebaseState.gracePeriod || gracePeriod;
                    
                    // Update display immediately
                    updateTimerDisplay();
                    
                    // If timer has expired, handle blocking immediately
                    if (timeRemaining <= 0) {
                        console.log('Limitter: Timer expired - blocking now');
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
                    console.log('Limitter: Either Firebase or current state shows blocked - enforcing block');
                    timeRemaining = 0;
                    stopCountdownTimer();
                    clearTimerState();
                    markDomainBlockedToday();
                    hideTimer();
                    showModal();
                }
            }
        }).catch(error => {
            console.log('Limitter: Error checking for cross-device updates:', error);
        });
    }
    
    // Add Firestore polling function for timer synchronization
    let pollingInterval;
    
    function startTimerPolling() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
        }
            pollingInterval = setInterval(async () => {
                if(document.visibilityState == "hidden") {
                    return;
                }
                if (!currentDomain || !isEnabled || isInitializing || !hasLoadedFromFirebase) {
                    return;
                }
                
                try {
                    // Load current Firestore state
                    const response = await chrome.runtime.sendMessage({
                        action: 'loadTimerFromFirestore',
                        domain: currentDomain
                    });
                    
                    if (!response || !response.success || !response.timerState) {
                        return;
                    }

                    if(!response.timerState.isActive) {
                        clearDailyBlock(currentDomain);
                        stopCountdownTimer();
                        clearTimerState();
                        hideTimer();
                        hideModal();
                        chrome.runtime.sendMessage({
                            action: 'triggerDomainListRefresh'
                        });
                        pollingInterval = null;
                        return;
                        
                    }
                    const firestoreState = response.timerState;
                    const firestoreTime = firestoreState.time_remaining;
                    
                    // Compare with local time
                    if (typeof firestoreTime === 'number' && typeof timeRemaining === 'number') {
                        console.log(`Timer Polling - Local: ${timeRemaining}s, Firestore: ${firestoreTime}s`);
                    
                        if(currentOverrideActive || response.timerState.override_active || ((response.timerState.last_reset_timestamp > lastResetTimestamp) && (lastResetTimestamp !== undefined)) ) {
                            currentOverrideActive = response.timerState.override_active;
                            currentOverrideInitiatedBy = response.timerState.override_initiated_by;
                            currentOverrideInitiatedAt = response.timerState.override_initiated_at;
                            lastResetTimestamp = response.timerState.last_reset_timestamp;
                            timeRemaining = firestoreTime;
                            saveTimerState();
                            updateTimerDisplay();
                            startCountdownTimer();
                            return;
                        }

                        if (timeRemaining < firestoreTime) {
                            // Local time is less than Firestore - update Firestore
                            if(firestoreTime - timeRemaining > 4) {
                                console.log('Local time is less - updating Firestore');
                                chrome.runtime.sendMessage({
                                    action: 'syncTimerToFirestore',
                                    domain: currentDomain,
                                    timeRemaining: timeRemaining,
                                    gracePeriod: gracePeriod,
                                    isActive: true,
                                    isPaused: isTimerPaused,
                                    timestamp: Date.now(),
                                    override_active: currentOverrideActive,
                                    override_initiated_by: currentOverrideInitiatedBy,
                                    override_initiated_at: currentOverrideInitiatedAt,
                                    time_limit: currentTimeLimit,
                                    last_reset_timestamp: lastResetTimestamp
                                });
                            }
                        } else if (firestoreTime < timeRemaining) {
                            // Firestore time is less than local - update local
                            console.log('Firestore time is less - updating local');
                            timeRemaining = firestoreTime;
                            updateTimerDisplay();
                        }
                    }
                } catch (error) {
                    console.error('Timer polling error:', error);
                }
        }, 5000); // 5 seconds interval
        
    }
    
    function stopTimerPolling() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
    }
    
    // Start polling when the timer starts
    const originalStartCountdownTimer = startCountdownTimer;
    startCountdownTimer = function() {
        originalStartCountdownTimer();
        startTimerPolling();
    };
    
    // Stop polling when the timer stops
    const originalStopCountdownTimer = stopCountdownTimer;
    stopCountdownTimer = function() {
        originalStopCountdownTimer();
        stopTimerPolling();
    };

})(); // End of IIFE 