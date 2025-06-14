// Smart Tab Blocker Background Script
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
console.log('Smart Tab Blocker Background: Checking class availability:', {
  FirebaseAuth: typeof FirebaseAuth,
  FirebaseFirestore: typeof FirebaseFirestore,
  SubscriptionService: typeof SubscriptionService,
  FirebaseSyncService: typeof FirebaseSyncService
});

async function initializeAuth() {
  try {
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
      loadConfiguration();
      const shouldTrack = isAuthenticated && isEnabled && domain && blockedDomains[domain];
      sendResponse({ shouldTrack: shouldTrack });
      break;
      
    case 'userLoggedIn':
      isAuthenticated = true;
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
      if (!firebaseSyncService || !realtimeDB) {
        console.error('Smart Tab Blocker Background: Sync request denied - Services not available');
        console.error('Smart Tab Blocker Background: Debug info:', {
          isAuthenticated,
          hasFirebaseAuth: !!firebaseAuth,
          hasFirestore: !!firestore,
          hasRealtimeDB: !!realtimeDB,
          hasSyncService: !!firebaseSyncService
        });
        
        // Try to reinitialize the services
        console.log('Smart Tab Blocker Backgrouilable');

        try {
          if (firebaseAuth && firestore) {
            firebaseSyncService = new FirebaseSyncService(firestore, firebaseAuth);
            firebaseSyncService.init();
            realtimeDB = new FirebaseRealtimeDB(FIREBASE_CONFIG, firebaseAuth);
          } else {
            console.error('Smart Tab Blocker Background: Cannot reinitialize - missing dependencies');
            sendResponse({ success: false, error: 'Services not available and cannot reinitialize' });
            break;
          }
        } catch (reinitError) {
          console.error('Smart Tab Blocker Background: Failed to reinitialize services:', reinitError);
          sendResponse({ success: false, error: 'Services not available and reinitialize failed' });
          break;
        }
      }
      
      // Get current user
      const currentUser = firebaseAuth.getCurrentUser();
      if (!currentUser) {
        console.log('Smart Tab Blocker Background: No authenticated user');
        sendResponse({ success: false, error: 'Not authenticated' });
        break;
      }
      console.log('Smart Tab Blocker Background: Sync request denied - Services not available');

      // Format domain and create site ID
      const timerDomain = request.domain.replace(/^www\./, '').toLowerCase();
      const formattedTimerDomain = realtimeDB.formatDomainForFirebase(timerDomain);
      const timerSiteId = `${currentUser.uid}_${formattedTimerDomain}`;

      // Create site data for Realtime Database
      const now = new Date();
      const siteData = {
        user_id: currentUser.uid,
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
        last_reset_date: new Date().toLocaleDateString('en-US'),
        is_paused: request.isPaused || false
      };

      // If timer has reached zero, mark as blocked
      if (request.timeRemaining <= 0) {
        siteData.is_blocked = true;
        siteData.blocked_until = new Date(now.setHours(23, 59, 59, 999)).toISOString();
      }
      console.log("wokring")
      // Sync to both Firestore and Realtime Database
      Promise.all([
        realtimeDB.addBlockedSite(timerSiteId, siteData)
      ]).then(([realtimeSuccess]) => {
        sendResponse({ success: realtimeSuccess });
      }).catch(async (error) => {
        console.error('Smart Tab Blocker Background: Error syncing timer:', error);
        
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
      
    case 'domainOverrideActivated':
      // Handle domain override activation - notify content scripts
      const overrideDomain = request.domain;
      const overrideTimeLimit = request.timeLimit;
      
      console.log(`Smart Tab Blocker Background: Domain override activated for ${overrideDomain} with ${overrideTimeLimit}s`);
      
      // Find and update tabs with this domain
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
            try {
              const hostname = new URL(tab.url).hostname.toLowerCase();
              const cleanHostname = hostname.replace(/^www\./, '');
              
              // Check if this tab matches the override domain
              if (cleanHostname === overrideDomain || hostname === overrideDomain) {
                console.log(`Smart Tab Blocker Background: Sending override update to tab ${tab.id} for domain ${overrideDomain}`);
                chrome.tabs.sendMessage(tab.id, {
                  action: 'updateConfig',
                  enabled: isEnabled,
                  domainConfig: { timer: overrideTimeLimit },
                  overrideActivated: true
                }).catch((error) => {
                  console.log(`Smart Tab Blocker Background: Could not send override update to tab ${tab.id}:`, error);
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
      // Set up Firebase realtime listener for a specific blocked site
      if (!realtimeDB || !firebaseAuth) {
        sendResponse({ success: false, error: 'Firebase services not available' });
        break;
      }
      
      const authUser = firebaseAuth.getCurrentUser();
      if (!authUser) {
        sendResponse({ success: false, error: 'User not authenticated' });
        break;
      }
      
      const listenerDomain = request.domain.replace(/^www\./, '').toLowerCase();
      const formattedListenerDomain = realtimeDB.formatDomainForFirebase(listenerDomain);
      const listenerSiteId = `${authUser.uid}_${formattedListenerDomain}`;
      
      try {
        console.log(`Firebase Realtime Listener: Setting up listener for site ${listenerSiteId}`);
        
        const eventSource = realtimeDB.listenToBlockedSite(listenerSiteId, (updatedData) => {
          console.log(`Firebase Realtime Update: Site ${listenerDomain}, Data:`, updatedData);
          
          // Check specifically for override_active changes
          if (updatedData.override_active !== undefined) {
            console.log(`Firebase Realtime Update: override_active changed for ${listenerDomain}: ${updatedData.override_active}`);
            
            // Notify content scripts on tabs with this domain
            chrome.tabs.query({}, (tabs) => {
              tabs.forEach(tab => {
                if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
                  try {
                    const hostname = new URL(tab.url).hostname.toLowerCase();
                    const cleanHostname = hostname.replace(/^www\./, '');
                    
                    if (cleanHostname === listenerDomain || hostname === listenerDomain) {
                      console.log(`Notifying tab ${tab.id} of override_active change for ${listenerDomain}`);
                      chrome.tabs.sendMessage(tab.id, {
                        action: 'overrideActiveChanged',
                        domain: listenerDomain,
                        override_active: updatedData.override_active,
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
          }
        });
        
        sendResponse({ success: true });
      } catch (error) {
        console.error(`Failed to set up realtime listener for ${listenerDomain}:`, error);
        sendResponse({ success: false, error: error.message });
      }
      
      return true;
      
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
    if (!realtimeDB || !firebaseAuth) {
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
    const timerDomain = domain.replace(/^www\./, '').toLowerCase();
    const formattedTimerDomainForLoad = realtimeDB.formatDomainForFirebase(timerDomain);
    const timerSiteId = `${userId}_${formattedTimerDomainForLoad}`;
    
    // console.log(`Smart Tab Blocker Background: Loading timer state for ${timerDomain} from Firebase (siteId: ${timerSiteId})`);
    
    const siteData = await realtimeDB.getBlockedSite(timerSiteId);
    
    if (siteData) {
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
        // console.log(`Smart Tab Blocker Background: Loaded active timer state from Firebase - ${timerState.timeRemaining}s remaining`);
        return timerState;
      }
    }
    
    // console.log(`Smart Tab Blocker Background: No active timer state found in Firebase for ${timerDomain}`);
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
      return true;
    }
  } catch (error) {
    console.error('Firebase initialization error:', error);
  }
  return false;
}