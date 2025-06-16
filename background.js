// Limitter Background Script
let blockedDomains = {};
let isEnabled = true;
let isAuthenticated = false;
let firebaseAuth = null;
let firestore = null;
let realtimeDB = null;
let subscriptionService = null;
let firebaseSyncService = null;

// Import Firebase configuration
importScripts('firebase-config.js');
importScripts('subscription-service.js');
importScripts('firebase-sync-service.js');

// Check if all required classes are loaded
console.log('Limitter Background: Checking class availability:', {
  FirebaseAuth: typeof FirebaseAuth,
  FirebaseFirestore: typeof FirebaseFirestore,
  SubscriptionService: typeof SubscriptionService,
  FirebaseSyncService: typeof FirebaseSyncService
});

// Add at the top with other variables
const lastUpdateTimestamps = new Map();
const UPDATE_DEBOUNCE_INTERVAL = 2000; // 2 seconds

async function initializeAuth() {
  try {
    try {
      firebaseAuth = new FirebaseAuth(FIREBASE_CONFIG);
      console.log('Limitter Background: FirebaseAuth created');
    } catch (authError) {
      console.warn('Limitter Background: FirebaseAuth creation failed, working in offline mode:', authError);
      firebaseAuth = null;
    }
    
    try {
      firestore = new FirebaseFirestore(FIREBASE_CONFIG, firebaseAuth);
      console.log('Limitter Background: FirebaseFirestore created');
    } catch (firestoreError) {
      console.warn('Limitter Background: FirebaseFirestore creation failed, working in offline mode:', firestoreError);
      firestore = null;
    }
    
    try {
      subscriptionService = new SubscriptionService(firebaseAuth, firestore);
      console.log('Limitter Background: SubscriptionService created');
    } catch (subError) {
      console.warn('Limitter Background: SubscriptionService creation failed:', subError);
      subscriptionService = null;
    }
    
    try {
      if (firestore && firebaseAuth) {
        firebaseSyncService = new FirebaseSyncService(firestore, firebaseAuth);
        console.log('Limitter Background: FirebaseSyncService created successfully');
      } else {
        console.log('Limitter Background: Skipping FirebaseSyncService creation - dependencies not available');
        firebaseSyncService = null;
      }
    } catch (syncServiceError) {
      console.warn('Limitter Background: Error creating FirebaseSyncService, continuing without sync:', syncServiceError);
      firebaseSyncService = null;
    }

    try {
      if (firebaseAuth) {
        realtimeDB = new FirebaseRealtimeDB(FIREBASE_CONFIG, firebaseAuth);
        console.log('Limitter Background: FirebaseRealtimeDB created successfully');
      } else {
        console.log('Limitter Background: Skipping FirebaseRealtimeDB creation - auth not available');
        realtimeDB = null;
      }
    } catch (realtimeError) {
      console.warn('Limitter Background: Error creating FirebaseRealtimeDB, continuing without realtime features:', realtimeError);
      realtimeDB = null;
    }
    
    let storedUser = null;
    if (firebaseAuth) {
      try {
        storedUser = await firebaseAuth.getStoredAuthData();
      } catch (error) {
        console.warn('Limitter Background: Error checking stored auth data:', error);
      }
    }
    isAuthenticated = !!storedUser;
    if (subscriptionService) {
      console.log('Limitter Background: User is authenticated, initializing services...');
      
      try {
        await subscriptionService.initializePlan();
        // console.log('Limitter Background: SubscriptionService initialized');
      } catch (subError) {
        console.warn('Limitter Background: Error initializing subscription service, continuing without subscription features:', subError);
      }
      
      // Initialize Firebase sync service for cross-device syncing
      if (firebaseSyncService) {
        try {
          firebaseSyncService.init();
          // console.log('Limitter Background: Firebase sync service initialized successfully');
        } catch (initError) {
          console.warn('Limitter Background: Error initializing Firebase sync service, continuing without sync:', initError);
          firebaseSyncService = null;
        }
      } else {
        console.log('Limitter Background: FirebaseSyncService not available, extension will work in offline mode');
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
      console.log('Limitter Background: User not authenticated or subscription service not available');
    }
    
    console.log('Limitter Background: Authentication initialized, isAuthenticated:', isAuthenticated, 'syncService available:', !!firebaseSyncService, 'realtimeDB available:', !!realtimeDB);
  } catch (error) {
    console.warn('Limitter Background: Auth initialization failed, extension will work in offline mode:', error);
    isAuthenticated = false;
    firebaseSyncService = null;
    firebaseAuth = null;
    firestore = null;
    subscriptionService = null;
    realtimeDB = null;
  }
}

// Initialize extension
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Limitter installed');
  
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
      setTimeout(() => {
        updateAllTrackedTabs();
      }, 2000); // Extra delay to ensure everything is ready
    } else {
      console.log('Limitter: Authentication or Firebase not ready - skipping tab updates');
    }
  });
});

// Initialize on startup
chrome.runtime.onStartup.addListener(async () => {
  // console.log('Limitter startup - initializing...');
  await initializeAuth();
  await loadConfiguration();
  
  // Only update tabs AFTER everything is fully initialized
  if (firebaseSyncService) {
    // console.log('Limitter: Startup complete - updating tracked tabs');
    setTimeout(() => {
      updateAllTrackedTabs();
    }, 2000);
  } else {
    console.log('Limitter: Startup - authentication or Firebase not ready');
  }
});

// Load configuration from storage
async function loadConfiguration() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['smartBlockerEnabled', 'blockedDomains'], (result) => {
      isEnabled = result.smartBlockerEnabled !== false;
      blockedDomains = result.blockedDomains || {};
      console.log('Limitter: Configuration loaded', { isEnabled, blockedDomains, isAuthenticated });
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
    console.log('Limitter: Invalid URL', url);
  }
  
  return null;
}

// Handle tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Limitter: Extension context invalidated, skipping tab update');
    return;
  }

  if (changeInfo.status === 'loading' && tab.url) {
    const domainInfo = isTrackedDomain(tab.url);
    
    // Only inject timers if user is authenticated, extension is enabled, domain is tracked, AND Firebase is ready
    if (domainInfo && isEnabled && isAuthenticated && firebaseSyncService) {
      // console.log(`Limitter: Tracked domain detected - ${domainInfo.domain} (${domainInfo.timer}s) - Firebase ready`);
      
      // Inject content script with domain configuration
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: initializeTimer,
        args: [domainInfo]
      }).catch((error) => {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.log('Limitter: Extension context invalidated during script injection');
          return;
        }
        console.log('Limitter: Could not inject script:', error);
      });
    } else if (domainInfo && (!isAuthenticated || !isEnabled || !firebaseSyncService)) {
      // Log why we're not tracking
      console.log(`Limitter: Not tracking ${domainInfo.domain} - isAuthenticated: ${isAuthenticated}, isEnabled: ${isEnabled}, firebaseSyncService: ${!!firebaseSyncService}`);
      
      // Send message to stop tracking if not authenticated, disabled, or Firebase not ready
      chrome.tabs.sendMessage(tabId, {
        action: 'stopTracking'
      }).catch((error) => {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.log('Limitter: Extension context invalidated during stop tracking message');
          return;
        }
        // Content script might not be loaded, which is fine
      });
    }
  }
});

// Function to inject into pages
function initializeTimer(domainInfo) {
  console.log('Limitter: Initializing timer for domain:', domainInfo);
  
  // Set domain configuration for the content script
  window.smartBlockerConfig = domainInfo;
  
  // Trigger initialization if content script is already loaded
  if (window.smartBlockerInitialize) {
    console.log('Limitter: Content script found, initializing...');
    window.smartBlockerInitialize(domainInfo);
  } else {
    console.log('Limitter: Content script not found, config set for when it loads');
  }
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // console.log('Limitter: Background received message:', request);
  
  switch (request.action) {
    case 'showNotification':
      // console.log('Limitter Background: Forwarding notification to popup:', request);
      // Forward the notification to any open popup windows
      chrome.runtime.sendMessage({
        action: 'displayNotification',
        message: request.message,
        isError: request.isError,
        source: request.source
      }).catch(() => {
        // Ignore if no popup is listening
        console.log('Limitter Background: No popup available for notification');
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
      console.log(`Limitter Background: getDomainConfig for ${sender.tab?.url}, domainInfo:`, domainInfo, 'isAuthenticated:', isAuthenticated);
      sendResponse({ domainConfig: domainInfo, isAuthenticated: isAuthenticated });
      break;
      
    case 'checkDomainTracking':
      const domain = request.domain;
      loadConfiguration();
      const shouldTrack = isAuthenticated && isEnabled && domain && blockedDomains[domain];
      sendResponse({ shouldTrack: shouldTrack });
      break;
      
    case 'userLoggedIn':
      isAuthenticated = true;
      console.log('Limitter Background: User logged in, reinitializing all Firebase services...');
      
      (async () => {
        try {
          // Reinitialize all Firebase services after login
          console.log('Limitter Background: Reinitializing Firebase services...');
          
          firebaseAuth = new FirebaseAuth(FIREBASE_CONFIG);
          firestore = new FirebaseFirestore(FIREBASE_CONFIG, firebaseAuth);
          realtimeDB = new FirebaseRealtimeDB(FIREBASE_CONFIG, firebaseAuth);
          
          // Initialize sync service
          firebaseSyncService = new FirebaseSyncService(firestore, firebaseAuth);
          firebaseSyncService.init();
          
          // Initialize subscription service
          subscriptionService = new SubscriptionService(firebaseAuth, firestore);
          await subscriptionService.initializePlan();
          
          console.log('Limitter Background: All Firebase services reinitialized successfully');
          console.log('Limitter Background: Service status after login:', {
            hasFirebaseAuth: !!firebaseAuth,
            hasFirestore: !!firestore,
            hasRealtimeDB: !!realtimeDB,
            hasFirebaseSyncService: !!firebaseSyncService,
            hasSubscriptionService: !!subscriptionService
          });
          
          // Only proceed with tab updates if everything is ready
          if (firebaseSyncService && realtimeDB) {
            console.log('Limitter Background: All services ready - loading configuration and updating tabs');
            
            // Load configuration first, then update tabs
            await loadConfiguration();
            console.log('Limitter Background: Configuration loaded, blocked domains:', Object.keys(blockedDomains));
            
            // Update tabs immediately
            updateAllTrackedTabs();
            
            // Also reload tabs after a delay to ensure everything is synced
            setTimeout(() => {
              console.log('Limitter Background: Reloading all tabs for fresh start');
              reloadAllTabs();
            }, 3000);
          } else {
            console.error('Limitter Background: Firebase services still not available after login');
            console.error('Limitter Background: Service status:', {
              hasFirebaseSyncService: !!firebaseSyncService,
              hasRealtimeDB: !!realtimeDB,
              hasFirebaseAuth: !!firebaseAuth,
              hasFirestore: !!firestore
            });
          }
          
        } catch (error) {
          console.error('Limitter Background: Error during login initialization:', error);
        }
      })();
      
      sendResponse({ success: true });
      break;
      
      
    case 'userLoggedOut':
      isAuthenticated = false;
      console.log('Limitter Background: User logged out, stopping all timers and clearing data');
      stopAllTimers();
      
      // Clear background script's cached data
      blockedDomains = {};
      isEnabled = true; // Reset to default
      
      sendResponse({ success: true });
      break;
      
    case 'domainAdded':
      // Popup notifies background that a new domain was added
      // console.log('Limitter Background: Domain added, reloading configuration');
      loadConfiguration();
      sendResponse({ success: true });
      break;
      
    case 'domainRemoved':
      // Popup notifies background that a domain was removed
      // Reload all tabs for this domain to ensure inactive tabs stop tracking
      console.log('Limitter Background: Domain removed, reloading tabs for:', request.domain);
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
          console.log(`Limitter Background: checkDomainActive for ${request.domain}, isActive: ${isActive}`);
          sendResponse({ isActive: isActive });
        })
        .catch(error => {
          console.log('Limitter Background: Error checking domain active status:', error);
          sendResponse({ isActive: false });
        });
        
      return true; // Keep message channel open for async response
      
    case 'contentScriptLoaded':
      // Content script is asking if this domain should be tracked
      const contentDomain = request.domain;
      
      // If authentication is still initializing, wait a bit and retry
      if (firebaseAuth === null || firebaseSyncService === null) {
        console.log(`Limitter Background: Authentication still initializing, retrying for ${contentDomain}`);
        setTimeout(() => {
          // Reload configuration to get latest domains
          loadConfiguration();
          const contentShouldTrack = isEnabled && contentDomain && blockedDomains[contentDomain];
          console.log(`Limitter Background: Content script loaded for ${contentDomain} (retry), shouldTrack: ${contentShouldTrack}, isAuthenticated: ${isAuthenticated}, isEnabled: ${isEnabled}, blockedDomains:`, Object.keys(blockedDomains));
          
          // Send message to content script to initialize if it should be tracked
          if (contentShouldTrack && sender.tab) {
            chrome.tabs.sendMessage(sender.tab.id, {
              action: 'updateConfig',
              enabled: isEnabled,
              domainConfig: { timer: blockedDomains[contentDomain] }
            }).catch(error => {
              console.log('Limitter Background: Could not send update to content script:', error);
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
      // console.log(`Limitter Background: Content script loaded for ${contentDomain}, shouldTrack: ${contentShouldTrack}, isAuthenticated: ${isAuthenticated}, isEnabled: ${isEnabled}, blockedDomains:`, Object.keys(blockedDomains));
      sendResponse({ shouldTrack: contentShouldTrack });
      break;
      
    case 'syncTimerToFirebase':
      // Sync timer state to Firebase for cross-device syncing
      if (!firebaseSyncService) {
        console.log('Limitter Background: Not authenticated or sync service not available');
        sendResponse({ success: false, error: 'Not authenticated' });
        break;
      }

      // Format domain and create site ID
      const timerDomain = request.domain.replace(/^www\./, '').toLowerCase();
      const formattedTimerDomain = realtimeDB.formatDomainForFirebase(timerDomain);
      const user = firebaseAuth.getCurrentUser();
      if (!user) {
        sendResponse({ success: false, error: 'Not authenticated' });
        break;
      }
      const timerSiteId = `${user.uid}_${formattedTimerDomain}`;

      // First get existing site data to compare times
      realtimeDB.getBlockedSite(timerSiteId).then(existingSite => {
        // Only proceed if:
        // 1. No existing site (new site)
        // 2. Override is active (allowed to increase time)
        // 3. New time is less than existing time (normal decrease)
        if (!existingSite || 
            request.override_active || 
            !existingSite.time_remaining || 
            request.timeRemaining <= existingSite.time_remaining) {
            
          // Create site data for Realtime Database
          const now = new Date();
          const siteData = {
            user_id: user.uid,
            url: timerDomain,
            time_remaining: request.timeRemaining,
            time_limit: request.time_limit || request.gracePeriod,
            is_active: true,
            override_active: request.override_active || false,
            override_initiated_by: request.override_initiated_by || null,
            override_initiated_at: request.override_initiated_at || null,
            is_blocked: request.timeRemaining <= 0,
            last_accessed: now.toISOString(),
            updated_at: now.toISOString(),
            last_reset_date: getTodayString(),
            is_paused: request.isPaused || false,
            last_reset_timestamp: existingSite?.last_reset_timestamp 
          };

          // If timer has reached zero, mark as blocked
          if (request.timeRemaining <= 0) {
            siteData.is_blocked = true;
            siteData.blocked_until = new Date(now.setHours(23, 59, 59, 999)).toISOString();
          }

          // Preserve any existing fields we want to keep
          if (existingSite) {
            siteData.created_at = existingSite.created_at;
            siteData.name = existingSite.name;
            if (existingSite.schedule) siteData.schedule = existingSite.schedule;
            if (existingSite.time_spent_today !== undefined) {
              siteData.time_spent_today = existingSite.time_spent_today;
            }
          }

          // Sync to Realtime Database
          realtimeDB.addBlockedSite(timerSiteId, siteData)
            .then(() => {
              sendResponse({ success: true });
            })
            .catch(error => {
              console.error('Limitter Background: Error syncing timer:', error);
              sendResponse({ success: false, error: error.message });
            });
        } else {
          // Time increase detected - reject update
          console.log(`Limitter Background: Rejected time increase - Current: ${existingSite.time_remaining}s, New: ${request.timeRemaining}s`);
          sendResponse({ 
            success: false, 
            error: 'Time increase not allowed',
            currentTime: existingSite.time_remaining 
          });
        }
      }).catch(error => {
        console.error('Limitter Background: Error checking existing site:', error);
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
      
      // console.log('Limitter Background: Loading timer from Firebase for domain:', request.domain);
      loadTimerStateFromFirebase(request.domain)
        .then(timerState => {
          if (timerState) {
            sendResponse({ success: true, timerState });
          } else {
            sendResponse({ success: true, timerState: null });
          }
        })
        .catch(error => {
          console.error('Limitter Background: Error loading timer from Firebase:', error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep message channel open for async response
      
    case 'domainOverrideActivated':
      // Handle domain override activation - notify content scripts
      const overrideDomain = request.domain;
      const overrideTimeLimit = request.timeLimit;
      
      console.log(`Limitter Background: Domain override activated for ${overrideDomain} with ${overrideTimeLimit}s`);
      
      // Find and update tabs with this domain
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
            try {
              const hostname = new URL(tab.url).hostname.toLowerCase();
              const cleanHostname = hostname.replace(/^www\./, '');
              
              // Check if this tab matches the override domain
              if (cleanHostname === overrideDomain || hostname === overrideDomain) {
                console.log(`Limitter Background: Sending override update to tab ${tab.id} for domain ${overrideDomain}`);
                chrome.tabs.sendMessage(tab.id, {
                  action: 'updateConfig',
                  enabled: isEnabled,
                  domainConfig: { timer: overrideTimeLimit },
                  overrideActivated: true
                }).catch((error) => {
                  console.log(`Limitter Background: Could not send override update to tab ${tab.id}:`, error);
                });
              }
            } catch (error) {
              // Invalid URL, ignore
            }
          }
        });
      });
      
      sendResponse({ success: true });
      break;

    case 'setupRealtimeListener':
      // Set up a persistent listener for a specific domain
      if (request.domain && isAuthenticated) {
        setupDomainListener(request.domain);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Domain not provided or not authenticated' });
      }
      break;

    case 'siteOpened':
      // Handle site opened event (fresh tab/reload) with cross-device sync
      if (!firebaseSyncService || !isAuthenticated) {
        sendResponse({ success: false, error: 'Not authenticated or sync service not available' });
        break;
      }
      
      console.log('Limitter Background: Site opened event for domain:', request.domain);
      handleSiteOpened(request.domain, request.localTimeRemaining)
        .then(result => {
          console.log('Limitter Background: Site opened handling completed:', result);
          sendResponse({ success: true, result });
        })
        .catch(error => {
          console.error('Limitter Background: Error handling site opened:', error);
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
      // console.log('Limitter: Enabled state changed to', isEnabled);
      
      // Update all tracked tabs
      updateAllTrackedTabs();
    }
    
    if (changes.blockedDomains) {
      const oldDomains = blockedDomains || {};
      const newDomains = changes.blockedDomains.newValue || {};
      blockedDomains = newDomains;
      
      console.log('Limitter: Domains configuration changed', blockedDomains);
      
      // Set up listeners for newly added domains
      if (isAuthenticated && realtimeDB) {
        Object.keys(newDomains).forEach(domain => {
          if (!oldDomains[domain]) {
            console.log(`🔄 Setting up listener for newly added domain: ${domain}`);
            setupDomainListener(domain);
          }
        });
        
        // Clean up listeners for removed domains
        Object.keys(oldDomains).forEach(domain => {
          if (!newDomains[domain]) {
            console.log(`🧹 Cleaning up listener for removed domain: ${domain}`);
            const user = firebaseAuth.getCurrentUser();
            if (user) {
              const cleanDomain = domain.replace(/^www\./, '').toLowerCase();
              const formattedDomain = realtimeDB.formatDomainForFirebase(cleanDomain);
              const siteId = `${user.uid}_${formattedDomain}`;
              
              const listener = activeListeners.get(siteId);
              if (listener) {
                try {
                  listener.eventSource.close();
                  activeListeners.delete(siteId);
                  console.log(`✅ Cleaned up listener for ${domain}`);
                } catch (error) {
                  console.error(`Error cleaning up listener for ${domain}:`, error);
                }
              }
            }
          }
        });
      }
    
      updateAllTrackedTabs();
    }
  }
});

// Stop all timers (used when user logs out)
function stopAllTimers() {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Limitter: Extension context invalidated, skipping stop timers');
    return;
  }

  // Clean up Firebase listeners
  cleanupListeners();

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'stopTracking'
      }).catch((error) => {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.log('Limitter: Extension context invalidated during stop tracking message');
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
    console.log('Limitter: Extension context invalidated, skipping tab reload for domain');
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
            console.log(`Limitter: Reloading tab ${tab.id} for removed domain ${domain}`);
            chrome.tabs.reload(tab.id).catch((error) => {
              if (error.message && error.message.includes('Extension context invalidated')) {
                console.log('Limitter: Extension context invalidated during tab reload');
                return;
              }
              console.log(`Limitter: Could not reload tab ${tab.id}:`, error);
            });
            reloadedCount++;
          }
        } catch (error) {
          // Invalid URL, ignore
        }
      }
    });
    
    if (reloadedCount > 0) {
      console.log(`Limitter: Reloaded ${reloadedCount} tabs for removed domain: ${domain}`);
    } else {
      console.log(`Limitter: No tabs found to reload for domain: ${domain}`);
    }
  });
}

// Reload all tabs (used when user logs in)
function reloadAllTabs() {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Limitter: Extension context invalidated, skipping tab reload');
    return;
  }

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        chrome.tabs.reload(tab.id).catch((error) => {
          if (error.message && error.message.includes('Extension context invalidated')) {
            console.log('Limitter: Extension context invalidated during tab reload');
            return;
          }
          console.log('Limitter: Could not reload tab:', error);
        });
      }
    });
  });
}

// Update all currently open tracked tabs
function updateAllTrackedTabs() {
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('Limitter: Extension context invalidated, skipping tab updates');
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
            console.log(`Limitter: Initializing tracked domain - ${domainInfo.domain} on tab ${tab.id}`);
            
            // Always inject the content script (it will check if already loaded)
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: initializeTimer,
              args: [domainInfo]
            }).catch((injectionError) => {
              if (injectionError.message && injectionError.message.includes('Extension context invalidated')) {
                console.log('Limitter: Extension context invalidated during script injection');
                return;
              }
              console.log(`Limitter: Could not inject script into tab ${tab.id}:`, injectionError);
            });
          } else {
            // Either domain is no longer tracked, extension is disabled, or user is not authenticated
            // First try to send a message to stop tracking
            console.log('Limitter: Sending stop tracking to tab', tab.id, 'for hostname:', hostname);
            chrome.tabs.sendMessage(tab.id, {
              action: 'stopTracking'
            }).catch((error) => {
              if (error.message && error.message.includes('Extension context invalidated')) {
                console.log('Limitter: Extension context invalidated during stop tracking message');
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
    if (!realtimeDB || !firebaseAuth) {
      console.log('Limitter Background: Not authenticated or services not available for Firebase load');
      return null;
    }
    
    const user = firebaseAuth.getCurrentUser();
    if (!user) {
      // Try stored auth data as fallback
      const storedUser = await firebaseAuth.getStoredAuthData();
      if (!storedUser) {
        // console.log('Limitter Background: No current user for Firebase load');
        return null;
      }
      // console.log('Limitter Background: Using stored auth for Firebase load');
    }
    
    const userId = user?.uid || user?.id;
    if (!userId) {
      console.log('Limitter Background: No user ID available for Firebase load');
      return null;
    }
    
    // Normalize domain for consistency
    const timerDomain = domain.replace(/^www\./, '').toLowerCase();
    const formattedTimerDomainForLoad = realtimeDB.formatDomainForFirebase(timerDomain);
    const timerSiteId = `${userId}_${formattedTimerDomainForLoad}`;
    
    // console.log(`Limitter Background: Loading timer state for ${timerDomain} from Firebase (siteId: ${timerSiteId})`);
    
    const siteData = await realtimeDB.getBlockedSite(timerSiteId);
    
    if (siteData) {
      // Check if site is blocked for today
      const today = getTodayString();
      const lastResetDate = siteData.last_reset_date;
      
      // If it's a new day, reset the timer
      if (lastResetDate !== today) {
        // console.log(`Limitter Background: New day detected (${today} vs ${lastResetDate}), timer should reset`);
        return null; // Let the timer start fresh for the new day
      }
      
      // Check if site is currently blocked
      if (siteData.is_blocked && siteData.time_remaining <= 0) {
        // console.log(`Limitter Background: Site is blocked in Firebase with ${siteData.time_remaining}s remaining`);
        return {
          timeRemaining: 0,
          gracePeriod: siteData.time_limit || 20,
          isActive: false,
          isPaused: false,
          timestamp: new Date(siteData.updated_at).getTime(),
          url: siteData.url,
          date: today,
          domain: timerDomain
        };
      }
      
      // Return active timer state if available
      if (siteData.is_active && siteData.time_remaining > 0) {
        const timerState = {
          timeRemaining: siteData.time_remaining,
          gracePeriod: siteData.time_limit || 20,
          isActive: true,
          isPaused: false, // Firebase doesn't track pause state
          timestamp: new Date(siteData.updated_at).getTime(),
          url: siteData.url,
          date: today,
          domain: timerDomain,
          override_active: siteData.override_active,
          override_initiated_by: siteData.override_initiated_by,
          override_initiated_at: siteData.override_initiated_at,
          time_limit: siteData.time_limit
        };
        // console.log(`Limitter Background: Loaded active timer state from Firebase - ${timerState.timeRemaining}s remaining`);
        return timerState;
      }
    }
    
    // console.log(`Limitter Background: No active timer state found in Firebase for ${timerDomain}`);
    return null;
  } catch (error) {
    console.error('Limitter Background: Error loading timer state from Firebase:', error);
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


// Store active Firebase listeners
const activeListeners = new Map();

// Initialize Firebase services
async function initializeAuth() {
  try {
    firebaseAuth = new FirebaseAuth(FIREBASE_CONFIG);
    const user = await firebaseAuth.getStoredAuthData();
    
    if (user) {
      isAuthenticated = true;
      firestore = new FirebaseFirestore(FIREBASE_CONFIG, firebaseAuth);
      realtimeDB = new FirebaseRealtimeDB(FIREBASE_CONFIG, firebaseAuth);
      firebaseSyncService = new FirebaseSyncService(firestore, firebaseAuth);
      
      // Set up persistent listeners for all tracked domains
      await setupPersistentListeners();
      
      return true;
    }
  } catch (error) {
    console.error('Firebase initialization error:', error);
  }
  return false;
}

// Set up persistent Firebase listeners for all tracked domains
async function setupPersistentListeners() {
  try {
    console.log('🔄 Setting up persistent Firebase listeners for all tracked domains...');
    
    // Load current blocked domains configuration
    await loadConfiguration();
    
    const user = firebaseAuth.getCurrentUser();
    if (!user || !blockedDomains) {
      console.log('❌ Cannot set up listeners - no user or domains');
      return;
    }
    
    // Set up listeners for each tracked domain
    Object.keys(blockedDomains).forEach(domain => {
      setupDomainListener(domain);
    });
    
    console.log(`✅ Set up persistent listeners for ${Object.keys(blockedDomains).length} domains`);
  } catch (error) {
    console.error('Error setting up persistent listeners:', error);
  }
}

// Set up listener for a specific domain
function setupDomainListener(domain) {
  const user = firebaseAuth.getCurrentUser();
  if (!user || !realtimeDB) return;
  
  const cleanDomain = domain.replace(/^www\./, '').toLowerCase();
  const formattedDomain = realtimeDB.formatDomainForFirebase(cleanDomain);
  const siteId = `${user.uid}_${formattedDomain}`;
  
  // Don't set up duplicate listeners
  if (activeListeners.has(siteId)) {
    console.log(`🔄 Listener already exists for ${cleanDomain}`);
    return;
  }
  
  try {
    console.log(`🔄 Setting up persistent listener for domain: ${cleanDomain} (${siteId})`);
    
    const eventSource = realtimeDB.listenToBlockedSite(siteId, (updatedData) => {
      console.log(`🔥 Firebase Update: ${cleanDomain}`, updatedData);
      
      // Handle override changes
      if (updatedData.override_active !== undefined) {
        handleOverrideChange(cleanDomain, updatedData);
        // Skip other handlers when handling override to prevent loops
        return;
      }
      
      // Handle tab switch changes
      if (updatedData.tab_switch_active === true) {
        handleTabSwitchSync(cleanDomain, updatedData);
      }
      
      // Handle site opened changes
      if (updatedData.site_opened_active === true) {
        handleSiteOpenedSync(cleanDomain, updatedData);
      }
      
      // Handle domain deactivation (is_active becomes false)
      if (updatedData.is_active === false) {
        handleDomainDeactivation(cleanDomain, updatedData);
      }
    });
    
    // Store the listener for cleanup later
    activeListeners.set(siteId, {
      eventSource,
      domain: cleanDomain,
      siteId
    });
    
    console.log(`✅ Persistent listener active for ${cleanDomain}`);
  } catch (error) {
    console.error(`❌ Failed to set up listener for ${cleanDomain}:`, error);
  }
}

// Handle override changes
async function handleOverrideChange(domain, updatedData) {
  const now = Date.now();
  const lastUpdate = lastUpdateTimestamps.get(domain) || 0;
  
  // Debounce updates
  if (now - lastUpdate < UPDATE_DEBOUNCE_INTERVAL) {
    console.log(`🔄 Skipping override update for ${domain}, too soon after last update`);
    return;
  }
  
  lastUpdateTimestamps.set(domain, now);
  
  // Rest of override handling logic
  console.log(`🔄 OVERRIDE: Override change detected for ${domain}`);
  console.log("updatedData", updatedData);
  
  // Get local timer state
  const localTimerState = await getTimerStateForDomain(domain);
  
  if (localTimerState) {
    // Update local timer state with override data
    localTimerState.override_active = updatedData.override_active;
    localTimerState.override_initiated_by = updatedData.override_initiated_by;
    localTimerState.override_initiated_at = updatedData.override_initiated_at;
    
    // Update time remaining only if override is active
    if (updatedData.override_active) {
      localTimerState.timeRemaining = updatedData.time_limit;
      localTimerState.gracePeriod = updatedData.time_limit;
    }
    
    // Update local timer state
    await updateLocalTimers(domain, localTimerState.timeRemaining);
  }
}

// Handle tab switch synchronization (simplified with unified functions)
async function handleTabSwitchSync(domain, updatedData) {
  console.log(`🔄 TAB SWITCH: Tab switch detected for ${domain}`);
  console.log("updatedData", updatedData);

  // Timer synchronization logic
  const firebaseTimeRemaining = updatedData.time_remaining;
  console.log(`Firebase time_remaining: ${firebaseTimeRemaining} (type: ${typeof firebaseTimeRemaining})`);
  
  if (firebaseTimeRemaining !== undefined && firebaseTimeRemaining !== null && typeof firebaseTimeRemaining === 'number') {
    // Get local timer state using unified function
    const localTimerState = await getTimerStateForDomain(domain);
    
    if (localTimerState && typeof localTimerState.timeRemaining === 'number') {
      // Use unified sync logic
      const user = firebaseAuth.getCurrentUser();
      if (user) {
        const formattedDomain = realtimeDB.formatDomainForFirebase(domain);
        const siteId = `${user.uid}_${formattedDomain}`;
        
        console.log(`🔄 Syncing timers - Local: ${localTimerState.timeRemaining}s, Firebase: ${firebaseTimeRemaining}s`);
        
        await syncTimerStates(domain, localTimerState.timeRemaining, firebaseTimeRemaining, siteId, {
          updateFirebase: true, // May update Firebase if large difference
          updateLocal: true,
          timeDifferenceThreshold: 5,
          source: 'cross-device'
        });
        
        console.log(`✅ Cross-device timer sync completed for ${domain}`);
      } else {
        console.error('❌ No authenticated user for Firebase update');
      }
    } else {
      console.log(`⚠️ No valid local timer state found for ${domain}`);
      console.log(`  Will use Firebase time as reference: ${firebaseTimeRemaining}s`);
      
      // No local timer found, but we have Firebase time - update local timers directly
      console.log(`🔄 Updating local timers with Firebase time: ${firebaseTimeRemaining}s`);
      await updateLocalTimers(domain, firebaseTimeRemaining);
      console.log(`✅ Local timers updated with Firebase time for cross-device sync`);
    }
  } else {
    console.log(`⚠️ Invalid Firebase time_remaining: ${firebaseTimeRemaining} (type: ${typeof firebaseTimeRemaining})`);
    console.log(`  Tab switch event processed but no valid timer data to sync`);
  }
}

// ===== UNIFIED TIMER SYNCHRONIZATION FUNCTIONS =====

// Unified function to get timer state for a domain
async function getTimerStateForDomain(domain, preferredTabId = null) {
  console.log(`🔍 Getting timer state for domain: ${domain}, preferredTab: ${preferredTabId}`);
  
  // Try specific tab first if provided
  if (preferredTabId) {
    try {
      const response = await chrome.tabs.sendMessage(preferredTabId, { action: 'getTimerState' });
      if (response && typeof response.timeRemaining === 'number') {
        console.log(`✅ Got timer state from preferred tab ${preferredTabId}: ${response.timeRemaining}s`);
        return { timeRemaining: response.timeRemaining, source: 'content-script', tabId: preferredTabId };
      }
    } catch (error) {
      console.log(`❌ Could not get timer from preferred tab ${preferredTabId}: ${error.message}`);
    }
  }
  
  // Try all tabs for this domain
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url) {
      try {
        const hostname = new URL(tab.url).hostname.toLowerCase().replace(/^www\./, '');
        if (hostname === domain) {
          try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getTimerState' });
            if (response && typeof response.timeRemaining === 'number') {
              console.log(`✅ Got timer state from tab ${tab.id}: ${response.timeRemaining}s`);
              return { timeRemaining: response.timeRemaining, source: 'content-script', tabId: tab.id };
            }
          } catch (error) {
            // Content script might not be loaded, continue
          }
        }
      } catch (error) {
        // Invalid URL, continue
      }
    }
  }
  
  // Fallback to storage
  const timerKey = `timerState_${domain}`;
  return new Promise((resolve) => {
    chrome.storage.local.get([timerKey], (result) => {
      if (result[timerKey] && typeof result[timerKey].timeRemaining === 'number') {
        console.log(`✅ Got timer state from storage: ${result[timerKey].timeRemaining}s`);
        resolve({ 
          timeRemaining: result[timerKey].timeRemaining, 
          source: 'storage', 
          timerState: result[timerKey] 
        });
      } else {
        console.log(`❌ No timer state found for domain: ${domain}`);
        resolve(null);
      }
    });
  });
}

// Unified function to update local timers (both content scripts and storage)
async function updateLocalTimers(domain, timeRemaining) {
  console.log(`🔄 Updating local timers for ${domain} to ${timeRemaining}s`);
  
  // Update all tabs for this domain
  const tabs = await chrome.tabs.query({});
  let updatedTabs = 0;
  
  tabs.forEach(tab => {
    if (tab.url) {
      try {
        const hostname = new URL(tab.url).hostname.toLowerCase().replace(/^www\./, '');
        if (hostname === domain) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'updateTimer',
            timeRemaining: timeRemaining
          }).then(() => {
            updatedTabs++;
          }).catch(() => {
            // Content script might not be loaded, ignore
          });
        }
      } catch (error) {
        // Invalid URL, ignore
      }
    }
  });
  
  // Update storage
  const timerKey = `timerState_${domain}`;
  return new Promise((resolve) => {
    chrome.storage.local.get([timerKey], (result) => {
      if (result[timerKey]) {
        const updatedTimerState = {
          ...result[timerKey],
          timeRemaining: timeRemaining,
          timestamp: Date.now()
        };
        chrome.storage.local.set({ [timerKey]: updatedTimerState }, () => {
          console.log(`✅ Updated storage and ${updatedTabs} tabs for ${domain}`);
          resolve();
        });
      } else {
        console.log(`⚠️ No storage state to update for ${domain}`);
        resolve();
      }
    });
  });
}

// Sync timer states between local and Firebase
async function syncTimerStates(domain, localTime, firebaseTime, siteId, options = {}) {
  const {
    updateFirebase = true,
    updateLocal = true,
    timeDifferenceThreshold = 5,
    source = 'unknown'
  } = options;

  console.log(`🔄 SYNC: Syncing timers for ${domain} (source: ${source})`);
  console.log(`Local: ${localTime}s, Firebase: ${firebaseTime}s`);

  try {
    // Get current site data to check override status
    const siteData = await realtimeDB.getSiteData(siteId);
    const isOverrideActive = siteData?.override_active === true;

    // If this is not an override, never increase time in Firebase
    if (!isOverrideActive) {
      // Use the minimum time between local and Firebase
      const minTime = Math.min(localTime, firebaseTime);
      console.log(`Using minimum time: ${minTime}s (override not active)`);

      if (updateLocal) {
        await updateLocalTimers(domain, minTime);
      }

      if (updateFirebase && Math.abs(firebaseTime - minTime) > timeDifferenceThreshold) {
        await realtimeDB.updateSiteSyncedTimer(siteId, minTime);
      }

      return minTime;
    } else {
      // For overrides, allow time increase but still sync between devices
      console.log(`Override active - allowing time increase`);
      const syncedTime = localTime;

      if (updateLocal) {
        await updateLocalTimers(domain, syncedTime);
      }

      if (updateFirebase && Math.abs(firebaseTime - syncedTime) > timeDifferenceThreshold) {
        await realtimeDB.updateSiteSyncedTimer(siteId, syncedTime);
      }

      return syncedTime;
    }
  } catch (error) {
    console.error(`❌ Error during timer sync for ${domain}:`, error);
    return localTime; // Default to local time on error
  }
}

// Helper function for backward compatibility
function notifyTabsOfTimerUpdate(domain, timeRemaining) {
  updateLocalTimers(domain, timeRemaining);
}

// Clean up listeners when user logs out
function cleanupListeners() {
  console.log(`🧹 Cleaning up ${activeListeners.size} Firebase listeners`);
  
  activeListeners.forEach((listener, siteId) => {
    try {
      if (listener.eventSource) {
        listener.eventSource.close();
      }
    } catch (error) {
      console.error(`Error closing listener for ${siteId}:`, error);
    }
  });
  
  activeListeners.clear();
  console.log('✅ All Firebase listeners cleaned up');
}

// Tab switch detection
let currentDeviceId = null;

async function getDeviceId() {
  if (currentDeviceId) return currentDeviceId;
  
  return new Promise((resolve) => {
    chrome.storage.local.get(['deviceId'], (result) => {
      if (result.deviceId) {
        currentDeviceId = result.deviceId;
        resolve(result.deviceId);
      } else {
        const newDeviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        currentDeviceId = newDeviceId;
        chrome.storage.local.set({ deviceId: newDeviceId }, () => {
          resolve(newDeviceId);
        });
      }
    });
  });
}

// Handle tab switch to a tracked domain (simplified with unified functions)
async function handleTabSwitch(tabId) {
  console.log(`🔍 handleTabSwitch called for tabId: ${tabId}`);
  try {
    if (!realtimeDB || !firebaseAuth || !isAuthenticated) {
      console.log(`❌ Prerequisites failed - realtimeDB: ${!!realtimeDB}, firebaseAuth: ${!!firebaseAuth}, isAuthenticated: ${isAuthenticated}`);
      return;
    }
    
    const tab = await chrome.tabs.get(tabId);
    console.log(`Tab info:`, { url: tab?.url, title: tab?.title });
    
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      console.log(`❌ Tab filtered out - invalid URL: ${tab?.url}`);
      return;
    }
    
    const user = firebaseAuth.getCurrentUser();
    if (!user) {
      console.log(`❌ No authenticated user`);
      return;
    }
    
    const domainInfo = isTrackedDomain(tab.url);
    console.log(`Domain check for ${tab.url}:`, domainInfo);
    
    if (!domainInfo) {
      console.log(`❌ Domain not tracked: ${tab.url}`);
      return; // Only track sites that are being monitored
    }
    
    console.log(`✅ Processing tab switch for tracked domain: ${domainInfo.domain}`);
    
    const formattedDomain = realtimeDB.formatDomainForFirebase(domainInfo.domain);
    const siteId = `${user.uid}_${formattedDomain}`;
    
    // Get current Firebase state
    console.log(`🔍 Getting current Firebase state for ${domainInfo.domain}`);
    const firebaseData = await realtimeDB.getSiteData(siteId);
    const firebaseTimeRemaining = firebaseData?.time_remaining;
    
    console.log(`Firebase time_remaining: ${firebaseTimeRemaining} (type: ${typeof firebaseTimeRemaining})`);
    
    // Get local timer state using unified function (prefer the specific tab)
    const localTimerState = await getTimerStateForDomain(domainInfo.domain, tabId);
    
    if (localTimerState && typeof localTimerState.timeRemaining === 'number') {
      const localTimeRemaining = localTimerState.timeRemaining;
      console.log(`✅ Got local timer state: ${localTimeRemaining}s`);
      
      // If we have both local and Firebase times, sync them
      if (firebaseTimeRemaining !== undefined && firebaseTimeRemaining !== null && typeof firebaseTimeRemaining === 'number') {
        // Use unified sync logic with device ID for tab switch updates
        const syncedTime = await syncTimerStates(domainInfo.domain, localTimeRemaining, firebaseTimeRemaining, siteId, {
          updateFirebase: true,
          updateLocal: true,
          timeDifferenceThreshold: 5,
          source: 'individual-tab-switch'
        });
        
        console.log(`✅ Tab switch sync completed with time: ${syncedTime}s`);
      } else {
        // No Firebase time, just send tab switch update with local time
        console.log(`📤 No Firebase time found, sending tab switch with local time: ${localTimeRemaining}s`);
        await realtimeDB.updateSiteTabSwitch(siteId, { 
          timeRemaining: localTimeRemaining // Explicitly pass local time
        });
      }
    } else {
      console.log(`❌ No timer state found for ${domainInfo.domain}, just creating tab switch event`);
      
      console.log(`🚀 Calling updateSiteTabSwitch with:`, { timeRemaining: undefined });
      await realtimeDB.updateSiteTabSwitch(siteId, { 
        timeRemaining: undefined // Explicitly pass undefined 
      });
      console.log(`✅ updateSiteTabSwitch completed successfully`);
    }
    
  } catch (error) {
    console.error('Error handling tab switch:', error);
  }
}

// Track previous tab for better tab switch detection
let previousTabId = null;

// Initialize tab switch listener
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Handle switching TO the new tab
  await handleTabSwitch(activeInfo.tabId);
  
  // Handle switching FROM the previous tab (if any)
  if (previousTabId && previousTabId !== activeInfo.tabId) {
    await handleTabSwitch(previousTabId);
  }
  
  // Update previous tab
  previousTabId = activeInfo.tabId;
});

// Handle site opened event (fresh tab/reload) with cross-device sync
async function handleSiteOpened(domain, localTimeRemaining) {
  console.log(`🔄 SITE OPENED: Fresh site opening detected for ${domain} with local time: ${localTimeRemaining}s`);
  
  try {
    if (!realtimeDB || !firebaseAuth || !isAuthenticated) {
      console.log(`❌ Prerequisites failed for site opened event`);
      return { success: false, message: 'Not authenticated or services not available' };
    }
    
    const user = firebaseAuth.getCurrentUser();
    if (!user) {
      console.log(`❌ No authenticated user for site opened event`);
      return { success: false, message: 'No authenticated user' };
    }
    
    const formattedDomain = realtimeDB.formatDomainForFirebase(domain);
    const siteId = `${user.uid}_${formattedDomain}`;
    
    // Get current Firebase state
    console.log(`🔍 Getting current Firebase state for ${domain}`);
    const firebaseData = await realtimeDB.getSiteData(siteId);
    const firebaseTimeRemaining = firebaseData?.time_remaining;
    
    console.log(`Firebase time_remaining: ${firebaseTimeRemaining} (type: ${typeof firebaseTimeRemaining})`);
    console.log(`Local time_remaining: ${localTimeRemaining} (type: ${typeof localTimeRemaining})`);
    
    // If we have both local and Firebase times, send site opened signal for cross-device sync
    if (typeof localTimeRemaining === 'number' && firebaseTimeRemaining !== undefined && firebaseTimeRemaining !== null && typeof firebaseTimeRemaining === 'number') {
      console.log(`🔄 Both times available - sending site opened signal for cross-device sync`);
      
      // Send site opened signal with local time
      await realtimeDB.updateSiteOpened(siteId, { 
        timeRemaining: localTimeRemaining , 
        site_opened_active: true
      });
      
      // Wait a bit for other devices to respond, then sync using min logic
      setTimeout(async () => {
        try {
          // Get updated Firebase data after other devices had a chance to respond
          const updatedFirebaseData = await realtimeDB.getSiteData(siteId);
          const updatedFirebaseTime = updatedFirebaseData?.time_remaining;
          
          if (updatedFirebaseTime !== undefined && updatedFirebaseTime !== null && typeof updatedFirebaseTime === 'number') {
            console.log(`🔄 Syncing after site opened signal - Local: ${localTimeRemaining}s, Firebase: ${updatedFirebaseTime}s`);
            
            await syncTimerStates(domain, localTimeRemaining, updatedFirebaseTime, siteId, {
              updateFirebase: true,
              updateLocal: true,
              timeDifferenceThreshold: 2, // More sensitive for fresh opens
              source: 'site-opened'
            });
          }
        } catch (error) {
          console.error('❌ Error during post-site-opened sync:', error);
        }
      }, 2000); // Wait 2 seconds for other devices to respond
      
      return { success: true, message: 'Site opened signal sent, cross-device sync initiated' };
    } else if (typeof localTimeRemaining === 'number') {
      // Only local time available, send signal anyway
      console.log(`📤 Only local time available, sending site opened signal: ${localTimeRemaining}s`);
      await realtimeDB.updateSiteOpened(siteId, { 
        timeRemaining: localTimeRemaining ,
        site_opened_active: true
      });
      
      return { success: true, message: 'Site opened signal sent with local time' };
    } else {
      console.log(`⚠️ No valid local time for site opened signal`);
      return { success: false, message: 'No valid local time available' };
    }
    
  } catch (error) {
    console.error('❌ Error handling site opened:', error);
    return { success: false, message: error.message };
  }
}

// Handle site opened synchronization from other devices
async function handleSiteOpenedSync(domain, updatedData) {
  console.log(`🔄 SITE OPENED SYNC: Site opened detected from another device for ${domain}`);
  console.log("updatedData", updatedData);
  
  // Timer synchronization logic
  const firebaseTimeRemaining = updatedData.time_remaining;
  console.log(`Firebase time_remaining from other device: ${firebaseTimeRemaining} (type: ${typeof firebaseTimeRemaining})`);
  
  if (firebaseTimeRemaining !== undefined && firebaseTimeRemaining !== null && typeof firebaseTimeRemaining === 'number') {
    // Get local timer state
    const localTimerState = await getTimerStateForDomain(domain);
    
    if (localTimerState && typeof localTimerState.timeRemaining === 'number') {
      // Use unified sync logic to respond with our local time
      const user = firebaseAuth.getCurrentUser();
      if (user) {
        const formattedDomain = realtimeDB.formatDomainForFirebase(domain);
        const siteId = `${user.uid}_${formattedDomain}`;
        
        console.log(`🔄 Responding to site opened with our local time - Local: ${localTimerState.timeRemaining}s, Other device: ${firebaseTimeRemaining}s`);
        
        await syncTimerStates(domain, localTimerState.timeRemaining, firebaseTimeRemaining, siteId, {
          updateFirebase: true,
          updateLocal: true,
          timeDifferenceThreshold: 2, // More sensitive for site opened events
          source: 'cross-device-site-opened'
        });
        
        console.log(`✅ Cross-device site opened sync completed for ${domain}`);
      } else {
        console.error('❌ No authenticated user for Firebase update');
      }
    } else {
      console.log(`⚠️ No valid local timer state found for ${domain} during site opened sync`);
    }
  } else {
    console.log(`⚠️ Invalid Firebase time_remaining from site opened: ${firebaseTimeRemaining} (type: ${typeof firebaseTimeRemaining})`);
  }
}

// Handle domain deactivation (is_active becomes false)
function handleDomainDeactivation(domain, updatedData) {
  console.log(`🔄 DOMAIN DEACTIVATION: Domain deactivation detected for ${domain}`);
  console.log("updatedData", updatedData);
  
  // Update local domains object in background script
  if (blockedDomains[domain]) {
    delete blockedDomains[domain];
    console.log(`Removed ${domain} from background script's blocked domains`);
  }
  
  // Notify content scripts on tabs with this domain
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        try {
          const hostname = new URL(tab.url).hostname.toLowerCase();
          const cleanHostname = hostname.replace(/^www\./, '');
          
          if (cleanHostname === domain || hostname === domain) {
            console.log(`Notifying tab ${tab.id} of domain deactivation for ${domain}`);
            chrome.tabs.sendMessage(tab.id, {
              action: 'domainDeactivated',
              domain: domain,
              data: updatedData
            }).catch((error) => {
              console.log(`Could not notify tab ${tab.id}:`, error);
            });
          }
        } catch (error) {
          // Invalid URL, ignore
        }
      }
    });
  });
  
  // Notify any open popups about the domain deactivation
  try {
    chrome.runtime.sendMessage({
      type: 'DOMAIN_DEACTIVATED',
      domain: domain,
      data: updatedData
    }).catch(() => {
      // Popup might not be open, that's fine
      console.log(`No popup to notify about ${domain} deactivation`);
    });
  } catch (error) {
    // Popup not open, that's fine
    console.log(`No popup to notify about ${domain} deactivation`);
  }
}