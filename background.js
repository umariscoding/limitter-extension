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

// Check if all required classes are loaded
console.log('Smart Tab Blocker Background: Checking class availability:', {
  FirebaseAuth: typeof FirebaseAuth,
  FirebaseFirestore: typeof FirebaseFirestore,
  SubscriptionService: typeof SubscriptionService,
  FirebaseSyncService: typeof FirebaseSyncService
});

// Initialize authentication with better error handling
async function initializeAuth() {
  try {
    // console.log('Smart Tab Blocker Background: Starting authentication initialization...');
    
    try {
      firebaseAuth = new FirebaseAuth(FIREBASE_CONFIG);
      console.log('Smart Tab Blocker Background: FirebaseAuth created');
    } catch (authError) {
      console.warn('Smart Tab Blocker Background: FirebaseAuth creation failed, working in offline mode:', authError);
      firebaseAuth = null;
    }
    
    try {
      firestore = new FirebaseFirestore(FIREBASE_CONFIG, firebaseAuth);
      console.log('Smart Tab Blocker Background: FirebaseFirestore created');
    } catch (firestoreError) {
      console.warn('Smart Tab Blocker Background: FirebaseFirestore creation failed, working in offline mode:', firestoreError);
      firestore = null;
    }
    
    try {
      subscriptionService = new SubscriptionService(firebaseAuth, firestore);
      console.log('Smart Tab Blocker Background: SubscriptionService created');
    } catch (subError) {
      console.warn('Smart Tab Blocker Background: SubscriptionService creation failed:', subError);
      subscriptionService = null;
    }
    
    try {
      if (firestore && firebaseAuth) {
        firebaseSyncService = new FirebaseSyncService(firestore, firebaseAuth);
        console.log('Smart Tab Blocker Background: FirebaseSyncService created successfully');
      } else {
        console.log('Smart Tab Blocker Background: Skipping FirebaseSyncService creation - dependencies not available');
        firebaseSyncService = null;
      }
    } catch (syncServiceError) {
      console.warn('Smart Tab Blocker Background: Error creating FirebaseSyncService, continuing without sync:', syncServiceError);
      firebaseSyncService = null;
    }
    
    let storedUser = null;
    if (firebaseAuth) {
      try {
        storedUser = await firebaseAuth.getStoredAuthData();
      } catch (error) {
        console.warn('Smart Tab Blocker Background: Error checking stored auth data:', error);
      }
    }
    isAuthenticated = !!storedUser;
    // console.log('Smart Tab Blocker Background: Auth check completed, isAuthenticated:', isAuthenticated);
    
    // If user is authenticated, initialize subscription service and sync service
    if (subscriptionService) {
      console.log('Smart Tab Blocker Background: User is authenticated, initializing services...');
      
      try {
        await subscriptionService.initializePlan();
        // console.log('Smart Tab Blocker Background: SubscriptionService initialized');
      } catch (subError) {
        console.warn('Smart Tab Blocker Background: Error initializing subscription service, continuing without subscription features:', subError);
      }
      
      // Initialize Firebase sync service for cross-device syncing
      if (firebaseSyncService) {
        try {
          firebaseSyncService.init();
          // console.log('Smart Tab Blocker Background: Firebase sync service initialized successfully');
        } catch (initError) {
          console.warn('Smart Tab Blocker Background: Error initializing Firebase sync service, continuing without sync:', initError);
          firebaseSyncService = null;
        }
      } else {
        console.log('Smart Tab Blocker Background: FirebaseSyncService not available, extension will work in offline mode');
      }
      
      // Load user's actual plan data if available
      try {
        if (firebaseAuth && firestore && subscriptionService) {
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
        }
      } catch (error) {
        console.warn('Error loading user plan data in background, continuing with default plan:', error);
      }
    } else {
      console.log('Smart Tab Blocker Background: User not authenticated or subscription service not available');
    }
    
    console.log('Smart Tab Blocker Background: Authentication initialized, isAuthenticated:', isAuthenticated, 'syncService available:', !!firebaseSyncService);
  } catch (error) {
    console.warn('Smart Tab Blocker Background: Auth initialization failed, extension will work in offline mode:', error);
    isAuthenticated = false;
    firebaseSyncService = null;
    firebaseAuth = null;
    firestore = null;
    subscriptionService = null;
  }
}

// Initialize extension
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Smart Tab Blocker installed');
  
  // Wait for complete initialization before doing anything else
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
    
    // Only update tabs AFTER everything is fully initialized
    if (firebaseSyncService) {
      // console.log('Smart Tab Blocker: Authentication and Firebase ready - updating tracked tabs');
      setTimeout(() => {
        updateAllTrackedTabs();
      }, 2000); // Extra delay to ensure everything is ready
    } else {
      console.log('Smart Tab Blocker: Authentication or Firebase not ready - skipping tab updates');
    }
  });
});

// Initialize on startup
chrome.runtime.onStartup.addListener(async () => {
  // console.log('Smart Tab Blocker startup - initializing...');
  await initializeAuth();
  await loadConfiguration();
  
  // Only update tabs AFTER everything is fully initialized
  if (firebaseSyncService) {
    // console.log('Smart Tab Blocker: Startup complete - updating tracked tabs');
    setTimeout(() => {
      updateAllTrackedTabs();
    }, 2000);
  } else {
    console.log('Smart Tab Blocker: Startup - authentication or Firebase not ready');
  }
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
    // Remove www. prefix from hostname for comparison
    const cleanHostname = hostname.replace(/^www\./, '');
    
    for (const domain of Object.keys(blockedDomains)) {
      // Check exact match only (including www. handling)
      if (cleanHostname === domain || hostname === domain) {
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
    
    // Only inject timers if user is authenticated, extension is enabled, domain is tracked, AND Firebase is ready
    if (domainInfo && isEnabled && isAuthenticated && firebaseSyncService) {
      // console.log(`Smart Tab Blocker: Tracked domain detected - ${domainInfo.domain} (${domainInfo.timer}s) - Firebase ready`);
      
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
    } else if (domainInfo && (!isAuthenticated || !isEnabled || !firebaseSyncService)) {
      // Log why we're not tracking
      console.log(`Smart Tab Blocker: Not tracking ${domainInfo.domain} - isAuthenticated: ${isAuthenticated}, isEnabled: ${isEnabled}, firebaseSyncService: ${!!firebaseSyncService}`);
      
      // Send message to stop tracking if not authenticated, disabled, or Firebase not ready
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
  console.log('Smart Tab Blocker: Initializing timer for domain:', domainInfo);
  
  // Set domain configuration for the content script
  window.smartBlockerConfig = domainInfo;
  
  // Trigger initialization if content script is already loaded
  if (window.smartBlockerInitialize) {
    console.log('Smart Tab Blocker: Content script found, initializing...');
    window.smartBlockerInitialize(domainInfo);
  } else {
    console.log('Smart Tab Blocker: Content script not found, config set for when it loads');
  }
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // console.log('Smart Tab Blocker: Background received message:', request);
  
  switch (request.action) {
    case 'showNotification':
      // console.log('Smart Tab Blocker Background: Forwarding notification to popup:', request);
      // Forward the notification to any open popup windows
      chrome.runtime.sendMessage({
        action: 'displayNotification',
        message: request.message,
        isError: request.isError,
        source: request.source
      }).catch(() => {
        // Ignore if no popup is listening
        console.log('Smart Tab Blocker Background: No popup available for notification');
      });
      sendResponse({ received: true });
      break;
      
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
      // // Reload configuration to get latest domains
      // console.log('blockedDomains:', blockedDomains);
      // console.log('domain:', domain);
      // console.log('isAuthenticated:', isAuthenticated);
      // console.log('isEnabled:', isEnabled);
      // console.log('blockedDomains[domain]:', blockedDomains[domain]);
      loadConfiguration();
      const shouldTrack = isAuthenticated && isEnabled && domain && blockedDomains[domain];
      // console.log(`Smart Tab Blocker Background: checkDomainTracking for ${domain}, shouldTrack: ${shouldTrack}, blockedDomains:`, Object.keys(blockedDomains));
      sendResponse({ shouldTrack: shouldTrack });
      break;
      
    case 'userLoggedIn':
      isAuthenticated = true;
      // console.log('Smart Tab Blocker Background: User logged in, initializing services...');
    
      // Re-initialize all services for the new user
      (async () => {
        try {
          if (subscriptionService) {
            await subscriptionService.initializePlan();
            console.log('Smart Tab Blocker Background: Subscription service reinitialized');
          }
          
          // Ensure Firebase sync service is initialized
          if (!firebaseSyncService && firebaseAuth && firestore) {
            console.log('Smart Tab Blocker Background: Creating Firebase sync service after login...');
            firebaseSyncService = new FirebaseSyncService(firestore, firebaseAuth);
            firebaseSyncService.init();
            console.log('Smart Tab Blocker Background: Firebase sync service initialized after login');
          }
          
          // Only proceed with tab updates if everything is ready
          if (firebaseSyncService) {
            console.log('Smart Tab Blocker Background: All services ready - loading configuration and updating tabs');
            
            // Load configuration first, then update tabs
            await loadConfiguration();
            console.log('Smart Tab Blocker Background: Configuration loaded, blocked domains:', Object.keys(blockedDomains));
            
            // Update tabs immediately
            updateAllTrackedTabs();
            
            // Also reload tabs after a delay to ensure everything is synced
            setTimeout(() => {
              console.log('Smart Tab Blocker Background: Reloading all tabs for fresh start');
              reloadAllTabs();
            }, 3000);
          } else {
            console.error('Smart Tab Blocker Background: Firebase sync service still not available after login');
          }
          
        } catch (error) {
          console.error('Smart Tab Blocker Background: Error during login initialization:', error);
        }
      })();
      
      sendResponse({ success: true });
      break;
      
    case 'requestOverride':
      if (!subscriptionService) {
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
      // console.log('Smart Tab Blocker Background: Domain added, reloading configuration');
      loadConfiguration();
      sendResponse({ success: true });
      break;
      
    case 'domainRemoved':
      // Popup notifies background that a domain was removed
      // Reload all tabs for this domain to ensure inactive tabs stop tracking
      console.log('Smart Tab Blocker Background: Domain removed, reloading tabs for:', request.domain);
      loadConfiguration(); // Refresh configuration
      reloadTabsForDomain(request.domain);
      sendResponse({ success: true });
      break;
      
    case 'checkDomainActive':
     
      const userId = firebaseAuth?.getCurrentUser()?.uid;
      if (!userId) {
        sendResponse({ isActive: false });
        break;
      }
      
      const normalizedDomain = request.domain.replace(/^www\./, '').toLowerCase();
      const siteId = `${userId}_${normalizedDomain}`;
      
      firestore.getBlockedSite(siteId)
        .then(siteData => {
          const isActive = siteData && (siteData.is_active);
          console.log(`Smart Tab Blocker Background: checkDomainActive for ${request.domain}, isActive: ${isActive}`);
          sendResponse({ isActive: isActive });
        })
        .catch(error => {
          console.log('Smart Tab Blocker Background: Error checking domain active status:', error);
          sendResponse({ isActive: false });
        });
        
      return true; // Keep message channel open for async response
      
    case 'contentScriptLoaded':
      // Content script is asking if this domain should be tracked
      const contentDomain = request.domain;
      
      // If authentication is still initializing, wait a bit and retry
      if (firebaseAuth === null || firebaseSyncService === null) {
        console.log(`Smart Tab Blocker Background: Authentication still initializing, retrying for ${contentDomain}`);
        setTimeout(() => {
          // Reload configuration to get latest domains
          loadConfiguration();
          const contentShouldTrack = isEnabled && contentDomain && blockedDomains[contentDomain];
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
      // console.log(`Smart Tab Blocker Background: Content script loaded for ${contentDomain}, shouldTrack: ${contentShouldTrack}, isAuthenticated: ${isAuthenticated}, isEnabled: ${isEnabled}, blockedDomains:`, Object.keys(blockedDomains));
      sendResponse({ shouldTrack: contentShouldTrack });
      break;
      
    case 'syncTimerToFirebase':
      // Content script requesting to sync timer state to Firebase
      // if (!isAuthenticated) {
      //   console.log('Smart Tab Blocker Background: Sync request denied - user not authenticated');
      //   sendResponse({ success: false, error: 'User not authenticated' });
      //   break;
      // }
      
      if (!firebaseSyncService) {
        console.error('Smart Tab Blocker Background: Sync request denied - FirebaseSyncService not available');
        console.error('Smart Tab Blocker Background: Debug info:', {
          isAuthenticated,
          hasFirebaseAuth: !!firebaseAuth,
          hasFirestore: !!firestore,
          hasSubscriptionService: !!subscriptionService,
          hasSyncService: !!firebaseSyncService
        });
        
        // Try to reinitialize the sync service
        // console.log('Smart Tab Blocker Background: Attempting to reinitialize sync service...');
        try {
          if (firebaseAuth && firestore) {
            firebaseSyncService = new FirebaseSyncService(firestore, firebaseAuth);
            firebaseSyncService.init();
            // console.log('Smart Tab Blocker Background: Sync service reinitialized successfully');
          } else {
            console.error('Smart Tab Blocker Background: Cannot reinitialize - missing dependencies');
            sendResponse({ success: false, error: 'Sync service not available and cannot reinitialize' });
            break;
          }
        } catch (reinitError) {
          console.error('Smart Tab Blocker Background: Failed to reinitialize sync service:', reinitError);
          sendResponse({ success: false, error: 'Sync service not available and reinitialize failed' });
          break;
        }
      }
      
      // console.log('Smart Tab Blocker Background: Processing sync request for domain:', request.domain);
      firebaseSyncService.syncDomainImmediately(
        request.domain,
        request.timeRemaining,
        request.gracePeriod,
        request.isOverride || false
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
      if (!firebaseSyncService) {
        sendResponse({ success: false, error: 'Not authenticated or sync service not available' });
        break;
      }
      
      // console.log('Smart Tab Blocker Background: Loading timer from Firebase for domain:', request.domain);
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
      
    case 'clearOverrideActive':
      // Clear override_active flag in Firebase
      if (!firebaseSyncService) {
        sendResponse({ success: false, error: 'Not authenticated or sync service not available' });
        break;
      }
      
      console.log('Smart Tab Blocker Background: Clearing override_active flag for domain:', request.domain);
      clearOverrideActiveInFirebase(request.domain)
        .then(() => {
          sendResponse({ success: true });
        })
        .catch(error => {
          console.error('Smart Tab Blocker Background: Error clearing override_active flag:', error);
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
      // console.log('Smart Tab Blocker: Enabled state changed to', isEnabled);
      
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

// Reload tabs for a specific domain (used when domain is removed)
function reloadTabsForDomain(domain) {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Smart Tab Blocker: Extension context invalidated, skipping tab reload for domain');
    return;
  }

  chrome.tabs.query({}, (tabs) => {
    let reloadedCount = 0;
    tabs.forEach(tab => {
      if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        try {
          const hostname = new URL(tab.url).hostname.toLowerCase();
          const cleanHostname = hostname.replace(/^www\./, '');
          
          // Check if this tab matches the removed domain (exact match only)
          if (cleanHostname === domain || hostname === domain) {
            console.log(`Smart Tab Blocker: Reloading tab ${tab.id} for removed domain ${domain}`);
            chrome.tabs.reload(tab.id).catch((error) => {
              if (error.message && error.message.includes('Extension context invalidated')) {
                console.log('Smart Tab Blocker: Extension context invalidated during tab reload');
                return;
              }
              console.log(`Smart Tab Blocker: Could not reload tab ${tab.id}:`, error);
            });
            reloadedCount++;
          }
        } catch (error) {
          // Invalid URL, ignore
        }
      }
    });
    
    if (reloadedCount > 0) {
      console.log(`Smart Tab Blocker: Reloaded ${reloadedCount} tabs for removed domain: ${domain}`);
    } else {
      console.log(`Smart Tab Blocker: No tabs found to reload for domain: ${domain}`);
    }
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
            // Domain is tracked, extension is enabled, and user is authenticated
            console.log(`Smart Tab Blocker: Initializing tracked domain - ${domainInfo.domain} on tab ${tab.id}`);
            
            // Always inject the content script (it will check if already loaded)
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: initializeTimer,
              args: [domainInfo]
            }).catch((injectionError) => {
              if (injectionError.message && injectionError.message.includes('Extension context invalidated')) {
                console.log('Smart Tab Blocker: Extension context invalidated during script injection');
                return;
              }
              console.log(`Smart Tab Blocker: Could not inject script into tab ${tab.id}:`, injectionError);
            });
          } else {
            // Either domain is no longer tracked, extension is disabled, or user is not authenticated
            // First try to send a message to stop tracking
            console.log('Smart Tab Blocker: Sending stop tracking to tab', tab.id, 'for hostname:', hostname);
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
    if (!firestore || !firebaseAuth) {
      console.log('Smart Tab Blocker Background: Not authenticated or services not available for Firebase load');
      return null;
    }
    
    const user = firebaseAuth.getCurrentUser();
    if (!user) {
      // Try stored auth data as fallback
      const storedUser = await firebaseAuth.getStoredAuthData();
      if (!storedUser) {
        // console.log('Smart Tab Blocker Background: No current user for Firebase load');
        return null;
      }
      // console.log('Smart Tab Blocker Background: Using stored auth for Firebase load');
    }
    
    const userId = user?.uid || user?.id;
    if (!userId) {
      console.log('Smart Tab Blocker Background: No user ID available for Firebase load');
      return null;
    }
    
    // Normalize domain for consistency
    const normalizedDomain = domain.replace(/^www\./, '').toLowerCase();
    const siteId = `${userId}_${normalizedDomain}`;
    
    // console.log(`Smart Tab Blocker Background: Loading timer state for ${normalizedDomain} from Firebase (siteId: ${siteId})`);
    
    const siteData = await firestore.getBlockedSite(siteId);
    
    if (siteData) {
      // console.log('Smart Tab Blocker Background: Firebase site data:', {
      //   time_remaining: siteData.time_remaining,
      //   is_active: siteData.is_active,
      //   is_blocked: siteData.is_blocked,
      //   time_limit: siteData.time_limit,
      //   updated_at: siteData.updated_at
      // });
      
      // Check if site is blocked for today
      const today = getTodayString();
      const lastResetDate = siteData.last_reset_date;
      
      // If it's a new day, reset the timer
      if (lastResetDate !== today) {
        // console.log(`Smart Tab Blocker Background: New day detected (${today} vs ${lastResetDate}), timer should reset`);
        return null; // Let the timer start fresh for the new day
      }
      
      // Check if site is currently blocked
      if (siteData.is_blocked && siteData.time_remaining <= 0) {
        // console.log(`Smart Tab Blocker Background: Site is blocked in Firebase with ${siteData.time_remaining}s remaining`);
        return {
          timeRemaining: 0,
          gracePeriod: siteData.time_limit || 20,
          isActive: false,
          isPaused: false,
          timestamp: siteData.updated_at ? siteData.updated_at.getTime() : Date.now(),
          url: siteData.url,
          date: today,
          domain: normalizedDomain
        };
      }
      
      // Return active timer state if available
      if (siteData.is_active && siteData.time_remaining > 0) {
        const timerState = {
          timeRemaining: siteData.time_remaining,
          gracePeriod: siteData.time_limit || 20,
          isActive: true,
          isPaused: false, // Firebase doesn't track pause state
          timestamp: siteData.updated_at ? siteData.updated_at.getTime() : Date.now(),
          url: siteData.url,
          date: today,
          domain: normalizedDomain,
          override_active: siteData.override_active,
          override_initiated_by: siteData.override_initiated_by,
          override_initiated_at: siteData.override_initiated_at,
          time_limit: siteData.time_limit
        };
        // console.log(`Smart Tab Blocker Background: Loaded active timer state from Firebase - ${timerState.timeRemaining}s remaining`);
        return timerState;
      }
    }
    
    // console.log(`Smart Tab Blocker Background: No active timer state found in Firebase for ${normalizedDomain}`);
    return null;
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

// Clear override_active flag in Firebase
async function clearOverrideActiveInFirebase(domain) {
  try {
    if (!firestore || !firebaseAuth) {
      throw new Error('Firebase services not available');
    }
    
    const user = firebaseAuth.getCurrentUser();
    if (!user) {
      const storedUser = await firebaseAuth.getStoredAuthData();
      if (!storedUser) {
        throw new Error('No authenticated user');
      }
    }
    
    const userId = user?.uid || user?.id;
    if (!userId) {
      throw new Error('No user ID available');
    }
    
    // Normalize domain for consistency
    const normalizedDomain = domain.replace(/^www\./, '').toLowerCase();
    const siteId = `${userId}_${normalizedDomain}`;
    
    console.log(`Smart Tab Blocker Background: Clearing override_active for ${normalizedDomain} (siteId: ${siteId})`);
    
    const siteData = await firestore.getBlockedSite(siteId);
    
    if (siteData) {
      const updatedData = {
        ...siteData,
        override_active: false,
        override_initiated_by: null,
        override_initiated_at: null,
        updated_at: new Date()
      };
      
      await firestore.updateBlockedSite(siteId, updatedData);
      console.log(`Smart Tab Blocker Background: Successfully cleared override_active for ${normalizedDomain}`);
    } else {
      console.log(`Smart Tab Blocker Background: No site data found for ${normalizedDomain}`);
    }
    
  } catch (error) {
    console.error('Smart Tab Blocker Background: Error clearing override_active:', error);
    throw error;
  }
}

// Decrement user's override count in background script
async function processBackgroundOverrideDecrement(userId, domain, userOverrides) {
  try {
    if (userOverrides.overrides <= 0) {
      throw new Error('No overrides remaining to decrement');
    }
    
    // Get current month for monthly stats
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM format
    
    // Update override data
    const updatedOverrides = {
      ...userOverrides,
      overrides: Math.max(0, userOverrides.overrides - 1), // Decrement override count
      overrides_used_total: (userOverrides.overrides_used_total || 0) + 1, // Increment total used
      updated_at: new Date(),
      // Update monthly stats
      monthly_stats: {
        ...userOverrides.monthly_stats,
        [currentMonth]: {
          ...userOverrides.monthly_stats?.[currentMonth],
          overrides_used: ((userOverrides.monthly_stats?.[currentMonth]?.overrides_used) || 0) + 1,
          credit_overrides_used: ((userOverrides.monthly_stats?.[currentMonth]?.credit_overrides_used) || 0) + 1
        }
      }
    };
    
    // Update in Firebase
    await firestore.updateUserOverrides(userId, updatedOverrides);
    
    // Also record in override history
    const historyRecord = {
      user_id: userId,
      site_url: domain,
      timestamp: new Date(),
      amount: 0, // Free override
      override_type: 'credit',
      month: currentMonth,
      plan: 'unknown', // We don't have user profile in background
      reason: 'User requested override from content script',
      created_at: new Date()
    };
    
    // Create override history entry (if the method exists)
    try {
      await firestore.createOverrideHistory(`${userId}_${Date.now()}`, historyRecord);
      console.log('Smart Tab Blocker Background: Override history recorded');
    } catch (error) {
      console.log('Smart Tab Blocker Background: Override history recording failed (non-critical):', error);
    }
    
    console.log(`Smart Tab Blocker Background: Override decremented: ${userOverrides.overrides} -> ${updatedOverrides.overrides}`);
    
  } catch (error) {
    console.error('Smart Tab Blocker Background: Error processing override decrement:', error);
    throw error;
  }
}

// Handle override requests from content scripts
async function handleOverrideRequest(domain, tabId) {
  try {
    if (!firestore || !firebaseAuth) {
      throw new Error('Firebase services not initialized');
    }
    
    const user = firebaseAuth.getCurrentUser();
    if (!user) {
      throw new Error('User not authenticated');
    }
    
    // Check user's plan first
    const userProfile = await firestore.getUserProfile(user.uid);
    const isElitePlan = userProfile && userProfile.plan === 'elite';
    
    if (isElitePlan) {
      console.log('Smart Tab Blocker Background: Elite plan user - granting unlimited override');
      
      // Elite plan users get unlimited overrides - skip all balance checks
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
        reason: 'elite_unlimited',
        remaining: 'unlimited'
      };
    }
    
    // For non-elite users, check override balance
    const userOverrides = await firestore.getUserOverrides(user.uid);
    
    if (!userOverrides) {
      // No override record found - user has no overrides
      return {
        success: false,
        requiresPayment: true,
        redirectUrl: 'http://localhost:3000/checkout?overrides=1',
        reason: 'no_overrides'
      };
    }

    const availableOverrides = userOverrides.overrides || 0;
    
    if (availableOverrides <= 0) {
      // No overrides remaining
      return {
        success: false,
        requiresPayment: true,
        redirectUrl: 'http://localhost:3000/checkout?overrides=1',
        reason: 'no_overrides'
      };
    }

    // User has overrides available - proceed with override
    try {
      // Decrement override count and update user_overrides
      await processBackgroundOverrideDecrement(user.uid, domain, userOverrides);
      
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
        reason: 'credit_override',
        remaining: availableOverrides - 1
      };
    } catch (error) {
      throw new Error('Failed to process override: ' + error.message);
    }
  } catch (error) {
    console.error('Override request failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
} 