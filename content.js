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
    
    // Save timer state to storage
    function saveTimerState() {
        const storageKey = getStorageKey();
        if (!storageKey) return;
        
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
        
        console.log(`Smart Tab Blocker: Saving timer state with ${timeRemaining}s remaining`);
        
        try {
            if (chrome.runtime?.id) {
                chrome.storage.local.set({
                    [storageKey]: state
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
    
    // Load timer state from storage
    function loadTimerState() {
        return new Promise((resolve) => {
            const storageKey = getStorageKey();
            if (!storageKey) {
                resolve(null);
                return;
            }
            
            console.log(`Smart Tab Blocker: Attempting to load timer state for ${getCurrentDomain()}`);
            
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
                    console.log("Smart Tab Blocker: Retrieved state:", state);
                    
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
        });
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
    
    // Handle page visibility changes
    function handleVisibilityChange() {
        if (!isEnabled || !countdownTimer) return;
        
        if (document.hidden) {
            pauseTimer();
        } else {
            resumeTimer();
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
            saveTimerState();
            updateTimerDisplay();
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
        
        // Set up visibility change listener
        document.addEventListener('visibilitychange', handleVisibilityChange);
        
        // First check if domain is blocked for today
        isDomainBlockedToday().then(isBlocked => {
            if (isBlocked) {
                console.log(`Smart Tab Blocker: ${currentDomain} is already blocked for today`);
                showModal(true); // true = already blocked
                return;
            }
            
            // Not blocked, try to restore timer state
            if (domainConfig.savedState) {
                // Use the saved state that was passed in
                console.log(`Smart Tab Blocker: Using provided saved state with ${domainConfig.savedState.timeRemaining}s remaining`);
                timeRemaining = domainConfig.savedState.timeRemaining;
                gracePeriod = domainConfig.savedState.gracePeriod || gracePeriod;
                isTimerPaused = domainConfig.savedState.isPaused || document.hidden;
                startCountdownTimer(true);
            } else {
                // No saved state provided, check storage
                loadTimerState().then(savedState => {
                    if (savedState && savedState.timeRemaining > 0) {
                        console.log(`Smart Tab Blocker: Loaded timer state from storage with ${savedState.timeRemaining}s remaining`);
                        timeRemaining = savedState.timeRemaining;
                        gracePeriod = savedState.gracePeriod || gracePeriod;
                        isTimerPaused = savedState.isPaused || document.hidden;
                        startCountdownTimer(true);
                    } else {
                        console.log(`Smart Tab Blocker: Starting fresh timer with ${gracePeriod}s`);
                        startCountdownTimer();
                    }
                });
            }
        });
        
        // Listen for messages from background script
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            console.log('Smart Tab Blocker: Message received:', request);
            
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
                // Background script is checking if this domain is still being tracked
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
                return;
            }
            // If background responds that domain should not be tracked, stop initialization
            if (response!={} && response.shouldTrack === false) {
                console.log('Response:', response);
                console.log(`Smart Tab Blocker: ${response} Background script says not to track ${getCurrentDomain()}`);
                // Ensure we clean up any state for this domain
                clearAllStateForDomain();
                return;
            }
            
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
                                return;
                            }
                            
                            if (response && response.domainConfig) {
                                initializeWithConfig(response.domainConfig);
                            } else if (response && response.shouldTrack === false) {
                                console.log(`Smart Tab Blocker: Domain ${getCurrentDomain()} should not be tracked`);
                                clearAllStateForDomain();
                            }
                        });
                    }
                });
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
        const timer = createTimer();
        
        if (!document.body) {
            setTimeout(showTimer, 100);
            return;
        }
        
        document.body.appendChild(timer);
        
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
        if (timerElement && timerElement.parentNode) {
            timerElement.parentNode.removeChild(timerElement);
            timerElement = null;
        }
    }
    
    function updateTimerDisplay() {
        if (!timerElement || !isEnabled) return;
        
        const countdownElement = timerElement.querySelector('.countdown');
        const progressFill = timerElement.querySelector('.progress-fill');
        const statusElement = timerElement.querySelector('.timer-status');
        const iconElement = timerElement.querySelector('.smart-blocker-timer-icon');
        
        if (countdownElement) {
            countdownElement.textContent = formatTime(timeRemaining);
        }
        
        if (progressFill) {
            const progressPercentage = (timeRemaining / gracePeriod) * 100;
            progressFill.style.width = progressPercentage + '%';
        }
        
        if (isTimerPaused) {
            timerElement.classList.add('paused');
            if (statusElement) {
                statusElement.textContent = `⏸️ Paused - ${formatTime(timeRemaining)} remaining`;
                statusElement.classList.add('paused');
            }
            if (iconElement) {
                iconElement.classList.add('paused');
            }
        } else {
            timerElement.classList.remove('paused');
            if (statusElement) {
                statusElement.textContent = `Blocking in ${formatTime(timeRemaining)}`;
                statusElement.classList.remove('paused');
            }
            if (iconElement) {
                iconElement.classList.remove('paused');
            }
        }
        
        if (timeRemaining <= 5 && !isTimerPaused) {
            timerElement.style.background = 'linear-gradient(135deg, #dc2626, #991b1b) !important';
            timerElement.style.animation = 'timerUrgent 0.5s ease-in-out infinite alternate !important';
            
            if (!document.getElementById('timer-urgent-styles')) {
                const urgentStyles = document.createElement('style');
                urgentStyles.id = 'timer-urgent-styles';
                urgentStyles.textContent = `
                    @keyframes timerUrgent {
                        from { transform: scale(1); }
                        to { transform: scale(1.05); }
                    }
                `;
                document.head.appendChild(urgentStyles);
            }
        }
    }
    
    function startCountdownTimer(isResuming = false) {
        if (!isEnabled || !checkExtensionContext()) return;
        
        stopCountdownTimer();
        
        if (!isResuming) {
            timeRemaining = gracePeriod;
        }
        
        isTimerPaused = document.hidden;
        
        showTimer();
        updateTimerDisplay();
        
        countdownTimer = setInterval(() => {
            // Check extension context on each tick
            if (!checkExtensionContext()) {
                stopCountdownTimer();
                return;
            }
            
            if (!isTimerPaused) {
                timeRemaining--;
                updateTimerDisplay();
                
                if (timeRemaining <= 0) {
                    stopCountdownTimer();
                    clearTimerState();
                    markDomainBlockedToday(); // Mark as blocked for the day
                    hideTimer();
                    showModal();
                }
            } else {
                updateTimerDisplay();
            }
        }, 1000);
        
        saveTimerState();
    }
    
    function stopCountdownTimer() {
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        isTimerPaused = false;
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
    
    // Listen for messages from popup (for reset functionality)
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log('Smart Tab Blocker: Message received:', message);
        
        if (message.action === 'domainReset') {
            const currentHostname = getCurrentDomain();
            console.log(`Smart Tab Blocker: Current hostname: ${currentHostname}, Reset for: ${message.domain}`);
            
            if (currentHostname === message.domain || currentHostname.endsWith('.' + message.domain)) {
                console.log(`Smart Tab Blocker: Domain ${message.domain} reset received - restoring access`);
                
                // Clear state and hide any blocking UI
                clearTimerState();
                hideModal();
                hideTimer();
                
                // IMPORTANT: Clear daily block directly in content script
                const blockKey = getDailyBlockKey();
                if (blockKey) {
                    chrome.storage.local.remove([blockKey], () => {
                        console.log(`Smart Tab Blocker: Daily block cleared for ${message.domain}`);
                    });
                }
                
                // Ensure page is visible (in case modal was blocking it)
                if (document.documentElement) {
                    document.documentElement.style.overflow = '';
                }
                if (document.body) {
                    document.body.style.display = '';
                }
                
                // Reset timer values
                timeRemaining = message.timer;
                gracePeriod = message.timer;
                isTimerPaused = false;
                
                // Stop any running timer
                if (countdownTimer) {
                    clearInterval(countdownTimer);
                    countdownTimer = null;
                }
                
                // Reset initialization flags for clean restart
                isInitialized = false;
                isEnabled = false;
                
                console.log(`Smart Tab Blocker: Starting fresh ${message.timer}s timer for ${message.domain}`);
                
                // Re-initialize with fresh timer after ensuring daily block is cleared
                setTimeout(() => {
                    initializeWithConfig({ timer: message.timer });
                }, 300);
                
                // Send response to confirm reset was processed
                sendResponse({ success: true, message: 'Domain reset successfully' });
            } else {
                console.log(`Smart Tab Blocker: Domain mismatch - current: ${currentHostname}, reset: ${message.domain}`);
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
    
})(); 