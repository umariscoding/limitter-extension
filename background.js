// Smart Tab Blocker Background Script
let blockedDomains = {};
let isEnabled = true;
let isAuthenticated = false;
let firebaseAuth = null;
let firestore = null;
let subscriptionService = null;
let firebaseSyncService = null;

// Import Firebase configuration
importScripts('firebase-config.js');
importScripts('subscription-service.js');
importScripts('firebase-sync-service.js');

// Initialize authentication
async function initializeAuth() {
  try {
    firebaseAuth = new FirebaseAuth(FIREBASE_CONFIG);
    firestore = new FirebaseFirestore(FIREBASE_CONFIG, firebaseAuth);
    subscriptionService = new SubscriptionService(firebaseAuth, firestore);
    firebaseSyncService = new FirebaseSyncService(firestore, firebaseAuth);
    
    const storedUser = await firebaseAuth.getStoredAuthData();
    isAuthenticated = !!storedUser;
    
    // If user is authenticated, initialize subscription service and sync service
    if (isAuthenticated && subscriptionService) {
      await subscriptionService.initializePlan();
      
      // Initialize Firebase sync service for cross-device syncing
      if (firebaseSyncService) {
        firebaseSyncService.init();
        console.log('Smart Tab Blocker Background: Firebase sync service initialized');
      }
      
      // Load user's actual plan data if available
      try {
        const user = firebaseAuth.getCurrentUser();
        if (user) {
          const userProfile = await firestore.getUserProfile(user.uid);
          if (userProfile && userProfile.plan) {
            await subscriptionService.updateUserPlan(userProfile.plan);
          }
          
          const subscriptionData = await firestore.getDocument(`subscriptions/${user.uid}`);
          if (subscriptionData) {
            await subscriptionService.updateUserSubscription(subscriptionData);
          }
        }
      } catch (error) {
        console.error('Error loading user plan data in background:', error);
      }
    }
    
    console.log('Smart Tab Blocker Background: Authentication initialized, isAuthenticated:', isAuthenticated);
  } catch (error) {
    console.error('Smart Tab Blocker Background: Auth initialization failed:', error);
    isAuthenticated = false;
  }
}

// Initialize extension
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Smart Tab Blocker installed');
  
  // Initialize authentication first and wait for it to complete
  await initializeAuth();
  await loadConfiguration();
  
  chrome.storage.sync.get(['smartBlockerEnabled', 'blockedDomains'], async (result) => {
    if (result.smartBlockerEnabled === undefined) {
      chrome.storage.sync.set({ smartBlockerEnabled: true });
    }
    if (!result.blockedDomains) {
      chrome.storage.sync.set({
        blockedDomains: {}
      });
    }
    
    // After initialization is complete, update all tracked tabs
    setTimeout(() => {
      updateAllTrackedTabs();
    }, 1000);
  });
});

// Initialize on startup
chrome.runtime.onStartup.addListener(async () => {
  await initializeAuth();
  await loadConfiguration();
  
  // After initialization is complete, update all tracked tabs
  setTimeout(() => {
    updateAllTrackedTabs();
  }, 1000);
});

// Load configuration from storage
async function loadConfiguration() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['smartBlockerEnabled', 'blockedDomains'], (result) => {
      isEnabled = result.smartBlockerEnabled !== false;
      blockedDomains = result.blockedDomains || {};
      console.log('Smart Tab Blocker: Configuration loaded', { isEnabled, blockedDomains, isAuthenticated });
      resolve();
    });
  });
}

// Check if URL matches any tracked domain
function isTrackedDomain(url) {
  if (!url) return null;
  
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    
    for (const domain of Object.keys(blockedDomains)) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return {
          domain: domain,
          timer: blockedDomains[domain]
        };
      }
    }
  } catch (error) {
    console.log('Smart Tab Blocker: Invalid URL', url);
  }
  
  return null;
}

// Handle tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Smart Tab Blocker: Extension context invalidated, skipping tab update');
    return;
  }

  if (changeInfo.status === 'loading' && tab.url) {
    const domainInfo = isTrackedDomain(tab.url);
    
    // Only inject timers if user is authenticated, extension is enabled, and domain is tracked
    if (domainInfo && isEnabled && isAuthenticated) {
      console.log(`Smart Tab Blocker: Tracked domain detected - ${domainInfo.domain} (${domainInfo.timer}s)`);
      
      // Inject content script with domain configuration
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: initializeTimer,
        args: [domainInfo]
      }).catch((error) => {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.log('Smart Tab Blocker: Extension context invalidated during script injection');
          return;
        }
        console.log('Smart Tab Blocker: Could not inject script:', error);
      });
    } else if (domainInfo && (!isAuthenticated || !isEnabled)) {
      // Send message to stop tracking if not authenticated or disabled
      console.log('stopTracking Domain Info' + domainInfo + "isAuthenticated: " + isAuthenticated + "isEnabled: " + isEnabled );
      chrome.tabs.sendMessage(tabId, {
        action: 'stopTracking'
      }).catch((error) => {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.log('Smart Tab Blocker: Extension context invalidated during stop tracking message');
          return;
        }
        // Content script might not be loaded, which is fine
      });
    }
  }
});

// Function to inject into pages
function initializeTimer(domainInfo) {
  // Set domain configuration for the content script
  window.smartBlockerConfig = domainInfo;
  
  // Trigger initialization if content script is already loaded
  if (window.smartBlockerInitialize) {
    window.smartBlockerInitialize(domainInfo);
  }
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Smart Tab Blocker: Background received message:', request);
  
  switch (request.action) {
    case 'checkEnabled':
      sendResponse({ 
        enabled: isEnabled && isAuthenticated,
        domainConfig: (sender.tab && isAuthenticated) ? isTrackedDomain(sender.tab.url) : null,
        isAuthenticated: isAuthenticated
      });
      break;
      
    case 'incrementCount':
      if (!isAuthenticated) {
        sendResponse({ success: false, error: 'Not authenticated' });
        break;
      }
      chrome.storage.local.get(['blockedCount'], (result) => {
        const newCount = (result.blockedCount || 0) + 1;
        chrome.storage.local.set({ blockedCount: newCount });
      });
      sendResponse({ success: true });
      break;
      
    case 'getDomainConfig':
      // Ensure we have the latest configuration
      loadConfiguration();
      const domainInfo = (sender.tab && isAuthenticated) ? isTrackedDomain(sender.tab.url) : null;
      console.log(`Smart Tab Blocker Background: getDomainConfig for ${sender.tab?.url}, domainInfo:`, domainInfo, 'isAuthenticated:', isAuthenticated);
      sendResponse({ domainConfig: domainInfo, isAuthenticated: isAuthenticated });
      break;
      
    case 'checkDomainTracking':
      const domain = request.domain;
      // Reload configuration to get latest domains
      console.log('blockedDomains:', blockedDomains);
      console.log('domain:', domain);
      console.log('isAuthenticated:', isAuthenticated);
      console.log('isEnabled:', isEnabled);
      console.log('blockedDomains[domain]:', blockedDomains[domain]);
      loadConfiguration();
      const shouldTrack = isAuthenticated && isEnabled && domain && blockedDomains[domain];
      console.log(`Smart Tab Blocker Background: checkDomainTracking for ${domain}, shouldTrack: ${shouldTrack}, blockedDomains:`, Object.keys(blockedDomains));
      sendResponse({ shouldTrack: shouldTrack });
      break;
      
    case 'userLoggedIn':
      isAuthenticated = true;
      console.log('Smart Tab Blocker Background: User logged in, initializing subscription service and updating tabs');
    
      // Re-initialize subscription service for the new user
      if (subscriptionService) {
        subscriptionService.initializePlan().catch(error => {
          console.error('Error initializing subscription service after login:', error);
        });
      }
      
      updateAllTrackedTabs();
  
      // Also update tracked tabs after reload
      setTimeout(() => {
        reloadAllTabs();
      }, 1000); // Give tabs time to reload before updating
      sendResponse({ success: true });
      break;
      
    case 'requestOverride':
      if (!isAuthenticated || !subscriptionService) {
        sendResponse({ success: false, error: 'Not authenticated' });
        break;
      }
      
      handleOverrideRequest(request.domain, sender.tab?.id)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep message channel open for async response
      
    case 'userLoggedOut':
      isAuthenticated = false;
      console.log('Smart Tab Blocker Background: User logged out, stopping all timers and clearing data');
      stopAllTimers();
      
      // Clear background script's cached data
      blockedDomains = {};
      isEnabled = true; // Reset to default
      
      sendResponse({ success: true });
      break;
      
    case 'domainAdded':
      // Popup notifies background that a new domain was added
      console.log('Smart Tab Blocker Background: Domain added, reloading configuration');
      loadConfiguration();
      sendResponse({ success: true });
      break;
      
    case 'contentScriptLoaded':
      // Content script is asking if this domain should be tracked
      const contentDomain = request.domain;
      
      // If authentication is still initializing, wait a bit and retry
      if (firebaseAuth === null || firebaseSyncService === null) {
        console.log(`Smart Tab Blocker Background: Authentication still initializing, retrying for ${contentDomain}`);
        setTimeout(() => {
          // Reload configuration to get latest domains
          loadConfiguration();
          const contentShouldTrack = isAuthenticated && isEnabled && contentDomain && blockedDomains[contentDomain];
          console.log(`Smart Tab Blocker Background: Content script loaded for ${contentDomain} (retry), shouldTrack: ${contentShouldTrack}, isAuthenticated: ${isAuthenticated}, isEnabled: ${isEnabled}, blockedDomains:`, Object.keys(blockedDomains));
          
          // Send message to content script to initialize if it should be tracked
          if (contentShouldTrack && sender.tab) {
            chrome.tabs.sendMessage(sender.tab.id, {
              action: 'updateConfig',
              enabled: isEnabled,
              domainConfig: { timer: blockedDomains[contentDomain] }
            }).catch(error => {
              console.log('Smart Tab Blocker Background: Could not send update to content script:', error);
            });
          }
        }, 1500); // Wait 1.5 seconds for auth to complete
        
        // Send initial response indicating we're still initializing
        sendResponse({ shouldTrack: false, initializing: true });
        break;
      }
      
      // Reload configuration to get latest domains
      loadConfiguration();
      const contentShouldTrack = isAuthenticated && isEnabled && contentDomain && blockedDomains[contentDomain];
      console.log(`Smart Tab Blocker Background: Content script loaded for ${contentDomain}, shouldTrack: ${contentShouldTrack}, isAuthenticated: ${isAuthenticated}, isEnabled: ${isEnabled}, blockedDomains:`, Object.keys(blockedDomains));
      sendResponse({ shouldTrack: contentShouldTrack });
      break;
      
    case 'syncTimerToFirebase':
      // Content script requesting to sync timer state to Firebase
      if (!isAuthenticated || !firebaseSyncService) {
        console.log('Smart Tab Blocker Background: Sync request denied - isAuthenticated:', isAuthenticated, 'syncService:', !!firebaseSyncService);
        sendResponse({ success: false, error: 'Not authenticated or sync service not available' });
        break;
      }
      
      console.log('Smart Tab Blocker Background: Processing sync request for domain:', request.domain);
      firebaseSyncService.syncDomainImmediately(
        request.domain,
        request.timeRemaining,
        request.gracePeriod
      ).then(() => {
        sendResponse({ success: true });
      }).catch(async (error) => {
        console.error('Smart Tab Blocker Background: Error syncing timer to Firebase:', error);
        
        // If error contains authentication issue, debug auth status
        if (error.message.includes('authenticated') || error.message.includes('auth')) {
          console.log('Smart Tab Blocker Background: Authentication error detected, debugging...');
          const authStatus = await firebaseSyncService.checkAuthStatus();
          console.log('Smart Tab Blocker Background: Auth debug result:', authStatus);
        }
        
        sendResponse({ success: false, error: error.message });
      });
      return true; // Keep message channel open for async response
      
    case 'debugFirebaseAuth':
      // Debug Firebase authentication status
      if (!firebaseSyncService) {
        sendResponse({ success: false, error: 'Sync service not available' });
        break;
      }
      
      firebaseSyncService.checkAuthStatus().then(authStatus => {
        sendResponse({ success: true, authStatus });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
      return true; // Keep message channel open for async response
      
    case 'loadTimerFromFirebase':
      // Load timer state from Firebase for cross-device syncing
      if (!isAuthenticated || !firebaseSyncService) {
        sendResponse({ success: false, error: 'Not authenticated or sync service not available' });
        break;
      }
      
      console.log('Smart Tab Blocker Background: Loading timer from Firebase for domain:', request.domain);
      loadTimerStateFromFirebase(request.domain)
        .then(timerState => {
          if (timerState) {
            sendResponse({ success: true, timerState });
          } else {
            sendResponse({ success: true, timerState: null });
          }
        })
        .catch(error => {
          console.error('Smart Tab Blocker Background: Error loading timer from Firebase:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep message channel open for async response
      
    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }
  
  return true; // Keep message channel open
});

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    if (changes.smartBlockerEnabled) {
      isEnabled = changes.smartBlockerEnabled.newValue;
      console.log('Smart Tab Blocker: Enabled state changed to', isEnabled);
      
      // Update all tracked tabs
      updateAllTrackedTabs();
    }
    
    if (changes.blockedDomains) {
      blockedDomains = changes.blockedDomains.newValue || {};
      console.log('Smart Tab Blocker: Domains configuration changed', blockedDomains);
      
      // Update all tabs to reflect new configuration
      updateAllTrackedTabs();
    }
  }
});

// Stop all timers (used when user logs out)
function stopAllTimers() {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Smart Tab Blocker: Extension context invalidated, skipping stop timers');
    return;
  }

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'stopTracking'
      }).catch((error) => {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.log('Smart Tab Blocker: Extension context invalidated during stop tracking message');
          return;
        }
        // Content script might not be loaded, which is fine
      });
    });
  });
}

// Reload all tabs (used when user logs in)
function reloadAllTabs() {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Smart Tab Blocker: Extension context invalidated, skipping tab reload');
    return;
  }

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        chrome.tabs.reload(tab.id).catch((error) => {
          if (error.message && error.message.includes('Extension context invalidated')) {
            console.log('Smart Tab Blocker: Extension context invalidated during tab reload');
            return;
          }
          console.log('Smart Tab Blocker: Could not reload tab:', error);
        });
      }
    });
  });
}

// Update all currently open tracked tabs
function updateAllTrackedTabs() {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Smart Tab Blocker: Extension context invalidated, skipping tab updates');
    return;
  }

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.url) {
        try {
          const hostname = new URL(tab.url).hostname.toLowerCase();
          const domainInfo = isTrackedDomain(tab.url);
          
          if (domainInfo && isEnabled && isAuthenticated) {
            // Domain is still tracked, extension is enabled, and user is authenticated
            const message = {
              action: 'updateConfig',
              enabled: true,
              domainConfig: domainInfo
            };
            
            chrome.tabs.sendMessage(tab.id, message).catch((error) => {
              // Check if it's a context invalidation error
              if (error.message && error.message.includes('Extension context invalidated')) {
                console.log('Smart Tab Blocker: Extension context invalidated during message send');
                return;
              }
              
              // If content script not loaded, inject it
              chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: initializeTimer,
                args: [domainInfo]
              }).catch((injectionError) => {
                if (injectionError.message && injectionError.message.includes('Extension context invalidated')) {
                  console.log('Smart Tab Blocker: Extension context invalidated during script injection');
                  return;
                }
                // Ignore other injection errors
              });
            });
          } else {
            // Either domain is no longer tracked, extension is disabled, or user is not authenticated
            // First try to send a message to stop tracking
            console.log('stopTracking tab.id', tab.id);
            chrome.tabs.sendMessage(tab.id, {
              action: 'stopTracking'
            }).catch((error) => {
              if (error.message && error.message.includes('Extension context invalidated')) {
                console.log('Smart Tab Blocker: Extension context invalidated during stop tracking message');
                return;
              }
              // Content script might not be loaded, which is fine
            });
          }
        } catch (error) {
          // Invalid URL, ignore
        }
      }
    });
  });
}

// Load timer state from Firebase for cross-device syncing
async function loadTimerStateFromFirebase(domain) {
  try {
    if (!isAuthenticated || !firestore || !firebaseAuth) {
      console.log('Smart Tab Blocker Background: Not authenticated or services not available for Firebase load');
      return null;
    }
    
    const user = firebaseAuth.getCurrentUser();
    if (!user) {
      console.log('Smart Tab Blocker Background: No current user for Firebase load');
      return null;
    }
    
    // Normalize domain for consistency
    const normalizedDomain = domain.replace(/^www\./, '').toLowerCase();
    const siteId = `${user.uid}_${normalizedDomain}`;
    
    console.log(`Smart Tab Blocker Background: Loading timer state for ${normalizedDomain} from Firebase`);
    
    const siteData = await firestore.getBlockedSite(siteId);
    
    if (siteData && siteData.is_active && !siteData.is_blocked) {
      // Convert Firestore data back to timer state format
      const timerState = {
        timeRemaining: siteData.time_remaining || 0,
        gracePeriod: siteData.time_limit || 20,
        isActive: !siteData.is_blocked,
        isPaused: false, // Firebase doesn't track pause state
        timestamp: siteData.updated_at ? siteData.updated_at.getTime() : Date.now(),
        url: siteData.url,
        date: getTodayString(),
        domain: normalizedDomain
      };
      
      console.log(`Smart Tab Blocker Background: Loaded timer state from Firebase - ${timerState.timeRemaining}s remaining`);
      return timerState;
    } else {
      console.log(`Smart Tab Blocker Background: No active timer state found in Firebase for ${normalizedDomain}`);
      return null;
    }
  } catch (error) {
    console.error('Smart Tab Blocker Background: Error loading timer state from Firebase:', error);
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

// Handle override requests from content scripts
async function handleOverrideRequest(domain, tabId) {
  try {
    if (!subscriptionService || !firebaseAuth) {
      throw new Error('Services not initialized');
    }
    
    const user = firebaseAuth.getCurrentUser();
    if (!user) {
      throw new Error('User not authenticated');
    }
    
    // Check if user can override based on their subscription plan
    const overrideCheck = await subscriptionService.canOverride(user.uid);
    
    if (!overrideCheck.allowed) {
      throw new Error('Override not allowed for your subscription plan');
    }
    
    if (!overrideCheck.allowed) {
      if (overrideCheck.reason === 'no_overrides') {
        // No overrides remaining, redirect to checkout
        return {
          success: false,
          requiresPayment: true,
          redirectUrl: overrideCheck.redirectUrl,
          reason: overrideCheck.reason
        };
      }
      throw new Error('Override not allowed');
    }

    if (overrideCheck.cost > 0) {
      // Requires payment
      return {
        success: true,
        requiresPayment: true,
        cost: overrideCheck.cost,
        reason: overrideCheck.reason,
        redirectUrl: `http://localhost:3000/checkout?overrides=1&domain=${domain}`
      };
    } else {
      // Free override available (either credits or unlimited)
      try {
        await subscriptionService.processOverride(user.uid, domain, 'User requested override from content script');
        
        // Clear the daily block for this domain
        const blockKey = `dailyBlock_${domain}`;
        chrome.storage.local.remove([blockKey]);
        
        // Send message to content script to hide modal and allow access
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            action: 'overrideGranted',
            domain: domain
          }).catch(error => {
            console.log('Could not send override granted message:', error);
          });
        }
        
        return {
          success: true,
          requiresPayment: false,
          reason: overrideCheck.reason,
          remaining: overrideCheck.remaining
        };
      } catch (error) {
        throw new Error('Failed to process override: ' + error.message);
      }
    }
  } catch (error) {
    console.error('Override request failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
} 