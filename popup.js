// Smart Tab Blocker Popup Script

// Check if extension context is valid
function isExtensionContextValid() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (error) {
    return false;
  }
}

// Safe chrome API wrapper
function safeChromeCall(apiCall, errorCallback) {
  if (!isExtensionContextValid()) {
    console.warn('Extension context invalidated, skipping chrome API call');
    if (errorCallback) errorCallback(new Error('Extension context invalidated'));
    return;
  }
  try {
    return apiCall();
  } catch (error) {
    console.error('Chrome API call failed:', error);
    if (errorCallback) errorCallback(error);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  // Initialize Firebase Auth and Firestore
  const firebaseAuth = new FirebaseAuth(FIREBASE_CONFIG);
  const firestore = new FirebaseFirestore(FIREBASE_CONFIG, firebaseAuth);
  
  // Initialize Subscription Service
  const subscriptionService = new SubscriptionService(firebaseAuth, firestore);
  
  // Authentication elements
  const authContent = document.getElementById('authContent');
  const userSection = document.getElementById('userSection');
  const mainContent = document.getElementById('mainContent');
  const emailInput = document.getElementById('emailInput');
  const passwordInput = document.getElementById('passwordInput');
  const loginBtn = document.getElementById('loginBtn');
  const registerBtn = document.getElementById('registerBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const userEmail = document.getElementById('userEmail');
  const authError = document.getElementById('authError');
  
  // Subscription elements
  const subscriptionBtn = document.getElementById('subscriptionBtn');
  const currentPlanSpan = document.getElementById('currentPlan');
  const subscriptionModal = document.getElementById('subscriptionModal');
  const closeSubscriptionModal = document.getElementById('closeSubscriptionModal');
  const subscriptionPlans = document.getElementById('subscriptionPlans');
  
  // Plan status elements
  const planStatusCard = document.getElementById('planStatusCard');
  const planBadge = document.getElementById('planBadge');
  const planLimits = document.getElementById('planLimits');
  const domainUsage = document.getElementById('domainUsage');
  
  // App elements
  const stats = document.getElementById('stats');
  const domainInput = document.getElementById('domainInput');
  const hoursInput = document.getElementById('hoursInput');
  const minutesInput = document.getElementById('minutesInput');
  const secondsInput = document.getElementById('secondsInput');
  const addBtn = document.getElementById('addBtn');
  const domainsList = document.getElementById('domainsList');
  
  let domains = {};
  let domainStates = {};
  let updateInterval = null;
  let previousDomainOrder = [];
  let userProfile = null;
  
  // Initialize authentication on startup
  initializeAuth();
  
  // Subscription event listeners
  if (subscriptionBtn) {
    subscriptionBtn.addEventListener('click', showSubscriptionModal);
  }
  
  if (closeSubscriptionModal) {
    closeSubscriptionModal.addEventListener('click', hideSubscriptionModal);
  }
  
  if (subscriptionModal) {
    subscriptionModal.addEventListener('click', (e) => {
      if (e.target === subscriptionModal) {
        hideSubscriptionModal();
      }
    });
  }
  
  // Firestore data functions
  async function loadUserDataFromFirestore() {
    try {
      const user = firebaseAuth.getCurrentUser();
      if (!user) {
        throw new Error('No authenticated user');
      }

      console.log('Loading user data from Firestore for user:', user.uid);
      
      // Show loading state
      if (stats) {
        stats.textContent = 'Loading your data...';
      }

      // Load user profile (contains plan information)
      try {
        userProfile = await firestore.getUserProfile(user.uid);
        console.log('User profile loaded:', userProfile);
        
        // If user profile has plan information, update subscription service
        if (userProfile && userProfile.plan) {
          await subscriptionService.updateUserPlan(userProfile.plan);
        }
      } catch (error) {
        console.log('User profile not found, will create on first site add');
        userProfile = null;
      }

      // Load user override data
      try {
        const userOverrides = await firestore.getUserOverrides(user.uid);
        if (userOverrides) {
          console.log('User overrides loaded:', userOverrides);
          // Store override data for use in UI - prioritize total overrides over individual fields
          if (userProfile) {
            userProfile.override_credits = userOverrides.override_credits || 0;
            userProfile.overrides = userOverrides.overrides || 0;
            userProfile.total_overrides = userOverrides.overrides || 0; // Total available overrides
            userProfile.monthly_stats = userOverrides.monthly_stats || {};
          } else {
            // Create temporary profile object if none exists
            userProfile = {
              override_credits: userOverrides.override_credits || 0,
              overrides: userOverrides.overrides || 0,
              total_overrides: userOverrides.overrides || 0
            };
          }
        }
      } catch (error) {
        console.log('User overrides not found, will create on first override usage');
      }

      // Load subscription data (for paid plans)
      try {
        const subscriptionData = await firestore.getDocument(`subscriptions/${user.uid}`);
        if (subscriptionData) {
          console.log('Subscription data loaded:', subscriptionData);
          await subscriptionService.updateUserSubscription(subscriptionData);
        }
      } catch (error) {
        console.log('No subscription data found for user');
      }

      // Load blocked sites from Firestore
      await loadDomainsFromFirestore();
      
      // Update UI
      updateDomainStates();
      updateStats();

      console.log('User data loaded successfully, domains:', domains);
      
      // Update subscription UI
      updateSubscriptionUI();
      
      // Update timer inputs for plan
      updateTimerInputsForPlan();
    } catch (error) {
      console.error('Error loading user data from Firestore:', error);
      // Fallback to local storage
      loadDomains();
      // Show user a subtle message that we're working offline
      showFeedback('Working offline - data will sync when connection is restored');
    }
  }

  async function syncDomainToFirestore(domain, timer) {
    try {
      const user = firebaseAuth.getCurrentUser();
      if (!user) return;

      const siteId = `${user.uid}_${domain}`;
      const now = new Date();
      const todayString = getTodayString();
      
      // Check if site already exists in Firestore
      const existingSite = await firestore.getBlockedSite(siteId);
      
      let siteData;
      if (existingSite) {
        // Site exists (either active or inactive) - update it
        console.log(`Updating existing site ${domain} in Firestore (was active: ${existingSite.is_active})`);
        
        siteData = {
          user_id: user.uid,
          url: domain,
          name: domain,
          time_limit: timer,
          time_remaining: timer,
          time_spent_today: 0,
          last_reset_date: todayString,
          is_blocked: false,
          is_active: true, // Reactivate if it was inactive
          blocked_until: null,
          schedule: null,
          // Keep original created_at if it exists
          created_at: existingSite.created_at || now,
          updated_at: now
        };
        
        if (!existingSite.is_active) {
          console.log(`Reactivating previously removed site: ${domain}`);
        }
      } else {
        // New site - create with all fields
        console.log(`Creating new site ${domain} in Firestore`);
        
        siteData = {
          user_id: user.uid,
          url: domain,
          name: domain,
          time_limit: timer,
          time_remaining: timer,
          time_spent_today: 0,
          last_reset_date: todayString,
          is_blocked: false,
          is_active: true,
          blocked_until: null,
          schedule: null,
          created_at: now,
          updated_at: now
        };
      }

      await firestore.updateBlockedSite(siteId, siteData);
      console.log(`Synced domain ${domain} to Firestore`);

      // Update user profile stats if we have one
      if (userProfile) {
        userProfile.total_sites_blocked = Object.keys(domains).length;
        userProfile.updated_at = now;
        await firestore.updateUserProfile(user.uid, userProfile);
      }
    } catch (error) {
      console.error('Error syncing domain to Firestore:', error);
    }
  }

  async function removeDomainFromFirestore(domain) {
    try {
      const user = firebaseAuth.getCurrentUser();
      if (!user) return;

      const siteId = `${user.uid}_${domain}`;
      
      // First, get the existing site data to preserve it
      const existingSite = await firestore.getBlockedSite(siteId);
      
      if (!existingSite) {
        console.log(`Site ${domain} not found in Firestore`);
        return;
      }

      // Mark site as inactive while preserving all other data
      const siteData = {
        ...existingSite, // Preserve all existing data
        is_active: false, // Only change the active status
        updated_at: new Date() // Update the timestamp
      };

      await firestore.updateBlockedSite(siteId, siteData);
      console.log(`Removed domain ${domain} from Firestore (marked as inactive)`);

      // Update user profile stats
      if (userProfile) {
        userProfile.total_sites_blocked = Math.max(0, Object.keys(domains).length);
        userProfile.updated_at = new Date();
        await firestore.updateUserProfile(user.uid, userProfile);
      }
    } catch (error) {
      console.error('Error removing domain from Firestore:', error);
    }
  }

  // Authentication functions
  async function initializeAuth() {
    try {
      const storedUser = await firebaseAuth.getStoredAuthData();
      if (storedUser) {
        // Show authenticated state but don't show main content yet
        showAuthenticatingState(storedUser);
        
        // Load plans and user data
        await Promise.all([
          subscriptionService.waitForPlansLoaded(),
          loadUserDataFromFirestore()
        ]);
        
        // Now show the full authenticated state
        showAuthenticatedState(storedUser);
        startPeriodicUpdates();
      } else {
        showUnauthenticatedState();
      }
    } catch (error) {
      console.error('Auth initialization error:', error);
      showUnauthenticatedState();
    }
  }
  
  function showAuthenticatingState(user) {
    authContent.classList.add('authenticated');
    userSection.style.display = 'block';
    userEmail.textContent = user.email;
    hideAuthError();
    
    // Show loading state in stats
    if (stats) {
      stats.textContent = 'Loading subscription plans...';
    }
    
    // Show loading indicator in plan status
    if (planStatusCard) {
      planStatusCard.style.display = 'block';
      if (planBadge) planBadge.textContent = 'Loading...';
      if (planLimits) planLimits.textContent = 'Fetching your plan data...';
    }
  }
  
  function showAuthenticatedState(user) {
    authContent.classList.add('authenticated');
    userSection.style.display = 'block';
    mainContent.classList.add('authenticated');
    userEmail.textContent = user.email;
    hideAuthError();
    updateSubscriptionUI();
    updateTimerInputsForPlan();
  }
  
  function showUnauthenticatedState() {
    authContent.classList.remove('authenticated');
    userSection.style.display = 'none';
    mainContent.classList.remove('authenticated');
    hideAuthError();
    
    // Clear app data when not authenticated
    domains = {};
    domainStates = {};
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
    
    // Clear UI
    if (domainsList) {
      domainsList.innerHTML = '';
    }
    if (stats) {
      stats.textContent = 'Please log in to start tracking domains';
    }
  }
  
  function showAuthError(message) {
    authError.textContent = message;
    authError.style.display = 'block';
  }
  
  function hideAuthError() {
    authError.style.display = 'none';
  }
  
  async function handleLogin() {
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();
    
    if (!email || !password) {
      showAuthError('Please enter both email and password');
      return;
    }
    
    try {
      loginBtn.disabled = true;
      loginBtn.textContent = 'Logging in...';
      hideAuthError();
      
      const user = await firebaseAuth.signInWithEmailAndPassword(email, password);
      
      // Show loading state first
      showAuthenticatingState(user);
      
      // Clear form
      emailInput.value = '';
      passwordInput.value = '';
      
      // Notify background script of login
      safeChromeCall(() => {
        chrome.runtime.sendMessage({ action: 'userLoggedIn' });
      });
      
      // Load plans and user data
      loginBtn.textContent = 'Loading your sites...';
      await Promise.all([
        subscriptionService.waitForPlansLoaded(),
        loadUserDataFromFirestore()
      ]);
      
      // Now show the full authenticated state
      showAuthenticatedState(user);
      startPeriodicUpdates();
      
    } catch (error) {
      console.error('Login error:', error);
      showAuthError(error.message || 'Login failed. Please check your credentials.');
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
    }
  }
  
  function handleRegister() {
    // Open the website for registration
    chrome.tabs.create({ url: 'http://localhost:3000/register' });
  }
  
  async function handleLogout() {
    try {
      await firebaseAuth.signOut();
      
      // Notify background script of logout (this will stop all timers)
      safeChromeCall(() => {
        chrome.runtime.sendMessage({ action: 'userLoggedOut' });
      });
      
      // Clear all Chrome storage data
      await clearAllChromeStorageData();
      
      showUnauthenticatedState();
      
      // Clear app data
      domains = {};
      domainStates = {};
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      
      // Clear UI
      domainsList.innerHTML = '';
      stats.textContent = 'Ready to help you stay focused!';
      
    } catch (error) {
      console.error('Logout error:', error);
    }
  }

  // Clear all Chrome storage data on logout
  async function clearAllChromeStorageData() {
    return new Promise((resolve) => {
      console.log('Smart Tab Blocker: Clearing all Chrome storage data on logout');
      
      // Clear sync storage (blocked domains)
      safeChromeCall(() => {
        chrome.storage.sync.clear(() => {
          console.log('Smart Tab Blocker: Sync storage cleared');
        });
      });
      
      // Clear local storage (timer states, daily blocks, etc.)
      safeChromeCall(() => {
        chrome.storage.local.clear(() => {
          console.log('Smart Tab Blocker: Local storage cleared');
          resolve();
        });
      });
    });
  }
  
  // Authentication event listeners
  loginBtn.addEventListener('click', handleLogin);
  registerBtn.addEventListener('click', handleRegister);
  logoutBtn.addEventListener('click', handleLogout);
  
  // Enter key handlers for auth inputs
  emailInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') handleLogin();
  });
  
  passwordInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') handleLogin();
  });
  
  // Add domain button handler
  addBtn.addEventListener('click', addDomain);
  
  // Enter key handler for inputs
  domainInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') addDomain();
  });
  
  hoursInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') addDomain();
  });
  
  minutesInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') addDomain();
  });
  
  secondsInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') addDomain();
  });
  
  // Event delegation for buttons
  domainsList.addEventListener('click', async function(e) {
    const domain = e.target.getAttribute('data-domain');
    if (!domain) return;
    
    if (e.target.classList.contains('remove-btn')) {
      await removeDomain(domain);
    } else if (e.target.classList.contains('override-btn')) {
      await handleOverride(domain);
    }
  });
  
  // Check if user is authenticated
  function isUserAuthenticated() {
    return firebaseAuth.getCurrentUser() !== null;
  }

  // Start periodic updates for timer states
  function startPeriodicUpdates() {
    updateDomainStates();
    updateInterval = setInterval(() => {
      if (!isExtensionContextValid()) {
        console.warn('Extension context invalid, clearing interval');
        if (updateInterval) {
          clearInterval(updateInterval);
          updateInterval = null;
        }
        return;
      }
      
      // Only update if user is authenticated
      if (!isUserAuthenticated()) {
        console.warn('User not authenticated, stopping timer updates');
        if (updateInterval) {
          clearInterval(updateInterval);
          updateInterval = null;
        }
        return;
      }
      
      updateDomainStates();
    }, 1000); // Update every second
  }
  
  // Get current active domain from tabs
  function getCurrentActiveDomain() {
    return new Promise((resolve) => {
      safeChromeCall(() => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0] && tabs[0].url) {
            try {
              const hostname = new URL(tabs[0].url).hostname.toLowerCase();
              // Check if this hostname matches any of our tracked domains
              for (const domain of Object.keys(domains)) {
                if (hostname === domain || hostname.endsWith('.' + domain)) {
                  resolve(domain);
                  return;
                }
              }
            } catch (error) {
              // Invalid URL
            }
          }
          resolve(null);
        });
      }, () => resolve(null));
    });
  }
  
  // Update domain states from storage
  function updateDomainStates() {
    // Only update if user is authenticated
    if (!isUserAuthenticated()) {
      return;
    }

    const domainKeys = Object.keys(domains);
    if (domainKeys.length === 0) return;
    
    // Get all timer states and daily blocks
    const storageKeys = domainKeys.flatMap(domain => [
      `timerState_${domain}`,
      `dailyBlock_${domain}`
    ]);
    
    safeChromeCall(() => {
      chrome.storage.local.get(storageKeys, (result) => {
        const newStates = {};
        
        domainKeys.forEach(domain => {
          const timerKey = `timerState_${domain}`;
          const blockKey = `dailyBlock_${domain}`;
          const timerState = result[timerKey];
          const blockState = result[blockKey];
          
          // Check if blocked for today
          const today = getTodayString();
          const isBlocked = blockState && blockState.date === today;
          
          if (isBlocked) {
            newStates[domain] = {
              status: 'blocked',
              timeRemaining: 0,
              isActive: false
            };
          } else if (timerState && timerState.date === today) {
            // Has timer state for today
            const timeDiff = Date.now() - timerState.timestamp;
            const shouldExpire = timeDiff > 5 * 60 * 1000; // 5 minutes
            
            if (shouldExpire) {
              newStates[domain] = {
                status: 'ready',
                timeRemaining: domains[domain],
                isActive: false
              };
            } else {
              // Calculate actual remaining time based on timestamp for running timers
              let actualTimeRemaining = timerState.timeRemaining || domains[domain];
              
              if (timerState.isActive && !timerState.isPaused) {
                // Timer is running, calculate how much time has passed
                const timeElapsed = Math.floor((Date.now() - timerState.timestamp) / 1000);
                actualTimeRemaining = Math.max(0, timerState.timeRemaining - timeElapsed);
              }
              
              newStates[domain] = {
                status: timerState.isActive ? (timerState.isPaused ? 'paused' : 'running') : 'ready',
                timeRemaining: actualTimeRemaining,
                isActive: timerState.isActive || false
              };
            }
          } else {
            // No state, ready to start
            newStates[domain] = {
              status: 'ready',
              timeRemaining: domains[domain],
              isActive: false
            };
          }
        });
        
        domainStates = newStates;
        renderDomainsList();
      });
    });
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

  // Convert total seconds to hours, minutes, seconds object
  function secondsToTimeComponents(totalSeconds) {
    return {
      hours: Math.floor(totalSeconds / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60
    };
  }

  // Get today's date string
  function getTodayString() {
    const today = new Date();
    return today.getFullYear() + '-' + 
           String(today.getMonth() + 1).padStart(2, '0') + '-' + 
           String(today.getDate()).padStart(2, '0');
  }
  
  function loadDomains() {
    safeChromeCall(() => {
      chrome.storage.sync.get(['blockedDomains'], function(result) {
        domains = result.blockedDomains || {};
        updateDomainStates();
        updateStats();
      });
    });
  }
  
  function saveDomains() {
    safeChromeCall(() => {
      chrome.storage.sync.set({
        blockedDomains: domains
      });
    });
  }

  async function loadDomainsFromFirestore() {
    try {
      const user = firebaseAuth.getCurrentUser();
      if (!user) {
        console.log('No authenticated user, falling back to local storage');
        loadDomains();
        return;
      }

      console.log('Loading blocked sites from Firestore for user:', user.uid);
      
      // Get user's blocked sites from Firestore
      const blockedSites = await firestore.getUserBlockedSites(user.uid);
      
      // Clear existing domains object
      domains = {};
      
      if (blockedSites && blockedSites.length > 0) {
        // Convert Firestore sites to local domains format
        blockedSites.forEach(site => {
          // Only load active sites
          if (site.is_active) {
            domains[site.url] = site.time_limit;
            console.log(`Loaded site from Firestore: ${site.url} with ${site.time_limit}s timer`);
          }
        });
        
        console.log(`Loaded ${Object.keys(domains).length} active sites from Firestore:`, Object.keys(domains));
      } else {
        console.log('No blocked sites found in Firestore');
      }
      
      // Save to local storage to sync with background script
      saveDomains();
      
    } catch (error) {
      console.error('Error loading domains from Firestore:', error);
      // Fallback to local storage
      console.log('Falling back to local storage due to error');
      loadDomains();
    }
  }

  function stopTrackingDomain(domain) {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.url) {
          try {
            const hostname = new URL(tab.url).hostname.toLowerCase();
            if (hostname === domain || hostname.endsWith('.' + domain)) {
              console.log(`Smart Tab Blocker: Sending stop tracking for removed domain ${domain} to tab ${tab.id}`);
              
              // Send explicit stopTracking message
              chrome.tabs.sendMessage(tab.id, {
                action: 'stopTracking',
                domain: domain
              }).catch(() => {
                // Tab might not have content script loaded, which is fine
                console.log(`Could not send stop tracking to tab ${tab.id} - content script may not be loaded`);
              });
            }
          } catch (error) {
            // Invalid URL, ignore
          }
        }
      });
    });

  }
  
  // Clear daily block for a specific domain
  function clearDailyBlock(domain) {
    const blockKey = `dailyBlock_${domain}`;
    const timerKey = `timerState_${domain}`;
    
    console.log(`Smart Tab Blocker: Clearing storage for domain: ${domain}`);
    
    safeChromeCall(() => {
      chrome.storage.local.remove([blockKey, timerKey], () => {
        if (chrome.runtime.lastError) {
          console.error('Storage clear error:', chrome.runtime.lastError);
        } else {
          console.log(`Smart Tab Blocker: Successfully cleared storage for ${domain}`);
        }
      });
    });
  }
  
  async function addDomain() {
    // Check if user is authenticated
    if (!isUserAuthenticated()) {
      showError('Please log in to add domains');
      return;
    }

    const domain = domainInput.value.trim().toLowerCase();
    const userPlan = subscriptionService.getCurrentPlan();
    
    let hours, minutes, seconds, totalSeconds;
    
    if (userPlan.id === 'free') {
      // Free plan: force 1 hour timer
      hours = 1;
      minutes = 0;
      seconds = 0;
      totalSeconds = 3600; // 1 hour
    } else {
      // Pro/Elite plans: use user input
      hours = parseInt(hoursInput.value) || 0;
      minutes = parseInt(minutesInput.value) || 0;
      seconds = parseInt(secondsInput.value) || 0;
      totalSeconds = hours * 3600 + minutes * 60 + seconds;
      
      // Validate time input for non-free plans
      if (totalSeconds < 1) {
        showError('Please enter a time greater than 0');
        return;
      }
      
      if (totalSeconds > 86400) { // 24 hours max
        showError('Timer cannot exceed 24 hours');
        return;
      }
    }
    
    if (!domain) {
      showError('Please enter a domain');
      return;
    }
    
    // Check subscription limits for domain count
    const currentDomainCount = Object.keys(domains).length;
    const canAdd = await subscriptionService.canAddDomain(currentDomainCount);
    
    if (!canAdd) {
      const maxDomains = subscriptionService.getMaxDomains();
      showPlanLimitError(`You've reached your limit of ${maxDomains} domains. Upgrade to Pro for unlimited domains.`, 'pro');
      return;
    }
    
    // Clean domain (remove protocol, www, etc.)
    const cleanDomain = domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
    
    // Check if domain already exists locally
    const isExistingDomain = domains.hasOwnProperty(cleanDomain);
    
    domains[cleanDomain] = totalSeconds;
    saveDomains();
    
    // Sync to Firestore (this will handle both new and existing sites)
    await syncDomainToFirestore(cleanDomain, totalSeconds);
    
    // Notify background script that a domain was added
    safeChromeCall(() => {
      chrome.runtime.sendMessage({ action: 'domainAdded', domain: cleanDomain });
    });
    
    // Clear any existing daily block for this domain to allow fresh timer
    clearDailyBlock(cleanDomain);
    
    // Reload existing tabs that match the new domain
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
          try {
            const hostname = new URL(tab.url).hostname.toLowerCase();
            if (hostname === cleanDomain || hostname.endsWith('.' + cleanDomain)) {
              // Reload the tab so the extension can start tracking immediately
              chrome.tabs.reload(tab.id).catch((error) => {
                console.log(`Could not reload tab ${tab.id}:`, error);
              });
              console.log(`Reloaded tab ${tab.id} for domain ${cleanDomain}`);
            }
          } catch (error) {
            // Invalid URL, ignore
          }
        }
      });
    });
    
    updateDomainStates();
    updateStats();
    
    // Clear inputs and reset to plan defaults
    domainInput.value = '';
    const planForClear = subscriptionService.getCurrentPlan();
    if (planForClear.id === 'free') {
      // Keep 1 hour for free plan (inputs are disabled)
      hoursInput.value = '1';
      minutesInput.value = '0';
      secondsInput.value = '0';
    } else {
      hoursInput.value = '';
      minutesInput.value = '';
      secondsInput.value = '';
    }
    
    const actionText = isExistingDomain ? 'Updated' : 'Added';
    showFeedback(`${actionText} ${cleanDomain} with ${formatTime(totalSeconds)} timer. Open tabs for this site will be reloaded.`);
  }
  
  async function removeDomain(domain) {
    // Check if user is authenticated
    if (!isUserAuthenticated()) {
      showError('Please log in to remove domains');
      return;
    }

    delete domains[domain];
    delete domainStates[domain];
    saveDomains();
    
    // Sync to Firestore
    await removeDomainFromFirestore(domain);
    
    clearDailyBlock(domain);
    stopTrackingDomain(domain);
    renderDomainsList();
    updateStats();
    showFeedback(`Removed ${domain}`);
  }
  
  async function renderDomainsList() {
    const domainKeys = Object.keys(domains);
    
    if (domainKeys.length === 0) {
      domainsList.innerHTML = '<div class="empty-domains">No domains added yet</div>';
      previousDomainOrder = [];
      return;
    }
    
    // Get current active domain
    const activeDomain = await getCurrentActiveDomain();
    
    // Sort domains: active domain first, then alphabetically
    const sortedDomains = domainKeys.sort((a, b) => {
      if (a === activeDomain) return -1;
      if (b === activeDomain) return 1;
      return a.localeCompare(b);
    });
    
    // Check for newly added domains
    const newDomains = sortedDomains.filter(domain => !previousDomainOrder.includes(domain));
    
    domainsList.innerHTML = sortedDomains.map(domain => {
      const state = domainStates[domain] || { status: 'ready', timeRemaining: domains[domain], isActive: false };
      const isActive = domain === activeDomain;
      const isNewlyAdded = newDomains.includes(domain);
      
      console.log('Domain state:', state);
      
      let statusText = '';
      let statusClass = '';
      
      switch (state.status) {
        case 'blocked':
          statusText = 'Blocked today';
          statusClass = 'status-blocked';
          break;
        case 'running':
          statusText = `⏱️ ${formatTime(state.timeRemaining)} left`;
          statusClass = 'status-running';
          break;
        case 'paused':
          statusText = `⏸️ ${formatTime(state.timeRemaining)} (paused)`;
          statusClass = 'status-paused';
          break;
        default:
          console.log(state);
          // For ready state, show the remaining time (which could be full limit or partial if previously used)
          statusText = `⏰ ${formatTime(state.timeRemaining)}`;
          statusClass = 'status-ready';
      }
      
      return `
        <div class="domain-item ${isActive ? 'active' : ''} ${isNewlyAdded ? 'new' : ''}">
          <div class="domain-info">
            <div class="domain-name">
              ${domain}
              ${isActive ? '<span class="active-indicator">● Active</span>' : ''}
            </div>
            <div class="domain-timer ${statusClass}">${statusText}</div>
          </div>
          <div class="domain-buttons">
            <button class="override-btn" data-domain="${domain}" title="Override block and access site">Override</button>
            <button class="remove-btn" data-domain="${domain}" title="Remove domain">Remove</button>
          </div>
        </div>
      `;
    }).join('');
    
    // Update previous order
    previousDomainOrder = [...sortedDomains];
    
    // Update subscription UI to reflect domain count changes
    updateSubscriptionUI();
    
    // Remove 'new' class after animation
    setTimeout(() => {
      const newItems = domainsList.querySelectorAll('.domain-item.new');
      newItems.forEach(item => item.classList.remove('new'));
    }, 300);
  }
  
  function updateStats() {
    const domainCount = Object.keys(domains).length;
    if (domainCount > 0) {
      stats.textContent = `Tracking ${domainCount} domain${domainCount > 1 ? 's' : ''}`;
    } else {
      stats.textContent = 'Add domains to start tracking!';
    }
  }
  
  function showFeedback(message) {
    const originalText = stats.textContent;
    stats.textContent = message;
    stats.style.fontWeight = 'bold';
    
    setTimeout(() => {
      updateStats();
      stats.style.fontWeight = 'normal';
    }, 2000);
  }
  
  function showError(message) {
    const originalText = stats.textContent;
    stats.textContent = message;
    stats.style.color = '#ffcccc';
    stats.style.fontWeight = 'bold';
    
    setTimeout(() => {
      stats.textContent = originalText;
      stats.style.color = '';
      stats.style.fontWeight = 'normal';
    }, 2000);
  }


  
  // Listen for storage changes
  let storageListener;
  safeChromeCall(() => {
    storageListener = function(changes, area) {
      if (!isExtensionContextValid()) {
        console.warn('Extension context invalid, removing storage listener');
        if (storageListener) {
          chrome.storage.onChanged.removeListener(storageListener);
        }
        return;
      }
      
      if (area === 'sync') {
        if (changes.blockedDomains) {
          domains = changes.blockedDomains.newValue || {};
          updateDomainStates();
          updateStats();
        }
      } else if (area === 'local') {
        // Timer states changed, update display
        updateDomainStates();
      }
    };
    chrome.storage.onChanged.addListener(storageListener);
  });
  
  // Clean up resources when popup closes
  window.addEventListener('beforeunload', () => {
    console.log('Popup closing, cleaning up resources');
    
    // Clear interval
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
    
    // Remove storage listener
    if (storageListener && isExtensionContextValid()) {
      try {
        chrome.storage.onChanged.removeListener(storageListener);
      } catch (error) {
        console.warn('Could not remove storage listener:', error);
      }
    }
  });
  
  // Also clean up if extension context becomes invalid
  function checkExtensionContext() {
    if (!isExtensionContextValid()) {
      console.warn('Extension context invalidated, cleaning up');
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      return false;
    }
    return true;
  }
  
  // Handle override based on subscription plan
  async function handleOverride(domain) {
    // Check if user is authenticated
    // if (!isUserAuthenticated()) {
    //   showError('Please log in to use overrides');
    //   return;
    // }

    try {
      const user = firebaseAuth.getCurrentUser();
      const currentPlan = subscriptionService.getCurrentPlan();
      
      // Check if user can override based on their plan
      const overrideCheck = await subscriptionService.canOverride(user.uid);
      
      if (!overrideCheck.allowed) {
        if (overrideCheck.reason === 'no_overrides') {
          // No overrides remaining, redirect to checkout
          window.open(overrideCheck.redirectUrl, '_blank');
          return;
        }
        showError('Override not available for your plan');
        return;
      }

      // Show override confirmation based on plan and remaining overrides
      let confirmMessage = '';
      let proceedWithOverride = false;

      if (currentPlan.id === 'elite' && overrideCheck.reason === 'unlimited') {
        // Elite plan: Unlimited overrides
        confirmMessage = `Override this block?\n\nElite plan includes unlimited overrides.\nDomain: ${domain}`;
        proceedWithOverride = confirm(confirmMessage);
      } else if (overrideCheck.reason === 'credit_override') {
        // User has override credits
        confirmMessage = `Use one of your override credits?\n\nRemaining: ${overrideCheck.remaining} credits\nDomain: ${domain}`;
        proceedWithOverride = confirm(confirmMessage);
      } else if (overrideCheck.cost === 0) {
        // Free overrides available (fallback)
        confirmMessage = `Use one of your free overrides?\n\nRemaining: ${overrideCheck.remaining || 'calculating...'} this month\nDomain: ${domain}`;
        proceedWithOverride = confirm(confirmMessage);
      } else {
        // Paid override required
        confirmMessage = `Override this block for $${overrideCheck.cost}?\n\nThis will allow immediate access to ${domain}.`;
        proceedWithOverride = confirm(confirmMessage);
        
        if (proceedWithOverride) {
          // Redirect to payment page
          window.open(`http://localhost:3000/checkout?overrides=1&domain=${domain}`, '_blank');
          return;
        }
      }

      if (proceedWithOverride) {
        // Process the override (for free overrides, credits, or unlimited)
        await processOverride(domain, currentPlan, overrideCheck);
      }

    } catch (error) {
      console.error('Error handling override:', error);
      showError('Failed to process override. Please try again.');
    }
  }

  // Process the actual override
  async function processOverride(domain, plan, overrideCheck) {
    try {
      console.log(`Processing override for ${domain} on ${plan.name}`);

      const user = firebaseAuth.getCurrentUser();
      if (!user) {
        throw new Error('User not authenticated');
      }

      const siteId = `${user.uid}_${domain}`;
      const siteData = await firestore.getBlockedSite(siteId);
      if (siteData) {
        // Generate unique device identifier for override initiation
        const deviceId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        await firestore.updateBlockedSite(siteId, {
          ...siteData,
          override_active: true,
          override_initiated_by: deviceId,
          override_initiated_at: new Date(),
          updated_at: new Date()
        });
        console.log(`Updated override_active to true for ${domain} by device ${deviceId}`);
        
        // Store device ID in browser for later clearing
        chrome.storage.local.set({
          [`override_device_${domain}`]: deviceId
        });
      }

      // Process the override and update user data first
      try {
        await subscriptionService.processOverride(user.uid, domain, 'User requested override from popup');
        console.log(`Override processed: ${domain}, plan: ${plan.id}, cost: ${overrideCheck.cost}`);
      } catch (error) {
        console.error('Error processing override in Firestore:', error);
        // Continue with local processing even if Firestore update fails
      }
      
      // Clear daily block and timer state for this domain
      clearDailyBlock(domain);
      
      // Update domain state to ready and reset timer to full amount
      domainStates[domain] = {
        status: 'ready',
        timeRemaining: domains[domain],
        isActive: false
      };
      
      // Immediately update the display
      renderDomainsList();
      
      // Notify content scripts that override was granted
      chrome.tabs.query({}, (tabs) => {
        let overrideSuccess = false;
        let tabsFound = 0;
        const promises = [];
        
        tabs.forEach(tab => {
          if (tab.url) {
            try {
              const hostname = new URL(tab.url).hostname.toLowerCase();
              if (hostname === domain || hostname.endsWith('.' + domain)) {
                tabsFound++;
                console.log(`Found matching tab ${tab.id} for domain ${domain}: ${tab.url}`);
                
                // Send override granted message to this tab
                const promise = chrome.tabs.sendMessage(tab.id, { 
                  action: 'overrideGranted',
                  domain: domain,
                  timer: domains[domain]
                }).then((response) => {
                  if (response && response.success) {
                    overrideSuccess = true;
                    console.log(`Override successful for tab ${tab.id}: ${response.message}`);
                  }
                }).catch((error) => {
                  console.log(`No content script in tab ${tab.id} or error:`, error);
                });
                
                promises.push(promise);
              }
            } catch (error) {
              // Invalid URL, ignore
            }
          }
        });
        
        
        console.log(`Smart Tab Blocker: Found ${tabsFound} tabs matching domain ${domain}`);
      
        // Wait for all tab messages to complete
        Promise.all(promises).then(async () => {
          if (overrideSuccess) {
            showFeedback(`✅ Override granted for ${domain} - timer restarted!`);
          } else if (tabsFound > 0) {
            showFeedback(`⚠️ Override sent to ${tabsFound} tab(s) - timer will restart`);
          } else {
            showFeedback(`Override granted for ${domain} - timer ready to start`);
          }
          
          // Update Firestore after successful override
          try {
            await updateFirestoreAfterOverride(domain, domains[domain]);
          } catch (error) {
            console.error('Error updating Firestore after override:', error);
          }
          
          // Reload user data to reflect updated override count
          try {
            await loadUserDataFromFirestore();
          } catch (error) {
            console.error('Error reloading user data after override:', error);
          }
        });
      });

    } catch (error) {
      console.error('Error processing override:', error);
      showError('Failed to process override');
    }
  }

  // Update Firestore after successful override
  async function updateFirestoreAfterOverride(domain, timerDuration) {
    try {
      const user = firebaseAuth.getCurrentUser();
      if (!user) {
        console.log('No authenticated user, skipping Firestore update');
        return;
      }

      const siteId = `${user.uid}_${domain}`;
      const now = new Date();
      const todayString = getTodayString();
      const siteData = await firestore.getBlockedSite(siteId);
      
      console.log(`Updating Firestore for ${domain} after override - resetting timer to ${timerDuration}s`);
      
      // Update the blocked site record to reflect override
      const siteUpdateData = {
        ...siteData,
        time_remaining: timerDuration, // Reset to full timer duration
        time_spent_today: 0, // Reset daily usage
        last_reset_date: todayString, // Update reset date
        is_blocked: false, // Site is no longer blocked
        blocked_until: null, // Clear any blocking timestamp
        updated_at: now
      };

      await firestore.updateBlockedSite(siteId, siteUpdateData);
      console.log(`Successfully updated Firestore for ${domain} after override`);

      // Also update user profile stats if we have one
      if (userProfile) {
        userProfile.updated_at = now;
        // Optionally track override usage in user profile
        userProfile.total_overrides_used = (userProfile.total_overrides_used || 0) + 1;
        await firestore.updateUserProfile(user.uid, userProfile);
        console.log('Updated user profile with override usage');
      }

    } catch (error) {
      console.error('Error updating Firestore after override:', error);
      // Don't throw error - this shouldn't block the override functionality
    }
  }


  
  // Subscription functions
  function showSubscriptionModal() {
    renderSubscriptionPlans();
    subscriptionModal.style.display = 'flex';
  }
  
  function hideSubscriptionModal() {
    subscriptionModal.style.display = 'none';
  }
  
  function renderSubscriptionPlans() {
    const currentPlan = subscriptionService.getCurrentPlan();
    const plans = subscriptionService.getAllPlans();
    
    subscriptionPlans.innerHTML = plans.map(plan => {
      const isCurrent = plan.id === currentPlan.id;
      const isRecommended = plan.id === 'pro';
      
      return `
        <div class="plan-card ${isCurrent ? 'current' : ''} ${isRecommended ? 'recommended' : ''}">
          <div class="plan-header">
            <div class="plan-name">${plan.name}</div>
            <div class="plan-price">$${plan.price}${plan.price > 0 ? '/month' : ''}</div>
          </div>
          <ul class="plan-features">
            ${plan.features.map(feature => `<li>${feature}</li>`).join('')}
          </ul>
          <button class="plan-action ${isCurrent ? 'current' : 'upgrade'}" 
                  onclick="handlePlanAction('${plan.id}', ${isCurrent})"
                  ${isCurrent ? 'disabled' : ''}>
            ${isCurrent ? 'Current Plan' : (plan.price > 0 ? `Upgrade - $${plan.price}/month` : 'Downgrade to Free')}
          </button>
        </div>
      `;
    }).join('');
  }
  
  async function handlePlanAction(planId, isCurrent) {
    if (isCurrent) return;
    
    try {
      const user = firebaseAuth.getCurrentUser();
      if (!user) {
        showError('Please log in to manage subscription');
        return;
      }
      
      if (planId === 'free') {
        // Handle downgrade to free (would need cancellation logic)
        showFeedback('Contact support to downgrade your plan');
        return;
      }
      
      // Redirect to payment page
      const paymentUrl = await subscriptionService.upgradeSubscription(planId, user.uid);
      window.open(paymentUrl, '_blank');
      hideSubscriptionModal();
      
    } catch (error) {
      console.error('Error upgrading subscription:', error);
      showError('Failed to process upgrade. Please try again.');
    }
  }
  
  function updateSubscriptionUI() {
    const status = subscriptionService.getSubscriptionStatus();
    const currentDomainCount = Object.keys(domains).length;
    
    // Update subscription button
    if (currentPlanSpan) {
      currentPlanSpan.textContent = status.planName;
    }
    
    // Update plan status card
    if (planStatusCard && planBadge && planLimits && domainUsage) {
      planStatusCard.style.display = 'block';
      
      // Update plan badge
      planBadge.textContent = status.planName;
      planBadge.className = `plan-badge ${status.planId}`;
      
      // Update plan limits
      const maxDomains = status.limits.maxDomains;
      let limitsText = '';
      
      if (maxDomains === -1) {
        limitsText = 'Unlimited domains';
        domainUsage.textContent = `${currentDomainCount} domains`;
      } else {
        limitsText = `${maxDomains} domains max`;
        domainUsage.textContent = `${currentDomainCount}/${maxDomains} domains`;
        
        // Add warning color if approaching limit
        if (currentDomainCount >= maxDomains * 0.8) {
          domainUsage.style.color = '#ffc107';
        } else {
          domainUsage.style.color = '';
        }
      }
      
      // Add custom duration info for free plan
      if (status.planId === 'free') {
        limitsText += ' • 1-hour timers only';
      }
      
      // Add override information
      if (userProfile) {
        const totalOverrides = userProfile.total_overrides || userProfile.overrides || 0;
        const freeOverrides = status.limits.freeOverrides;
        
        if (freeOverrides === -1) {
          limitsText += ' • Unlimited overrides';
        } else if (totalOverrides > 0) {
          limitsText += ` • ${totalOverrides} overrides remaining`;
        } else if (freeOverrides > 0) {
          limitsText += ` • ${freeOverrides} free overrides/month`;
        } else {
          limitsText += ' • No overrides remaining';
        }
      }
      
      planLimits.textContent = limitsText;
    }
    
    // Update timer inputs based on plan
    updateTimerInputsForPlan();
  }
  
  function showPlanLimitError(message, suggestedPlan) {
    // Create a plan limit error message with upgrade option
    const errorDiv = document.createElement('div');
    errorDiv.className = 'plan-limit-error';
    errorDiv.innerHTML = `
      <div>${message}</div>
      <button onclick="showSubscriptionModal()" style="margin-top: 8px; padding: 8px 16px; background: #00d4aa; color: white; border: none; border-radius: 6px; cursor: pointer;">
        View Plans
      </button>
    `;
    
    // Insert before the add domain card
    const addDomainCard = document.querySelector('.card');
    if (addDomainCard && addDomainCard.parentNode) {
      addDomainCard.parentNode.insertBefore(errorDiv, addDomainCard);
      
      // Remove after 10 seconds
      setTimeout(() => {
        if (errorDiv.parentNode) {
          errorDiv.parentNode.removeChild(errorDiv);
        }
      }, 10000);
    }
  }
  
  // Update timer inputs based on subscription plan
  function updateTimerInputsForPlan() {
    const plan = subscriptionService.getCurrentPlan();
    
    if (plan.id === 'free') {
      // Disable timer inputs for free plan
      hoursInput.disabled = true;
      minutesInput.disabled = true;
      secondsInput.disabled = true;
      
      // Set default values
      hoursInput.value = '1';
      minutesInput.value = '0';
      secondsInput.value = '0';
      
      // Add visual styling
      hoursInput.style.backgroundColor = 'rgba(255, 255, 255, 0.6)';
      minutesInput.style.backgroundColor = 'rgba(255, 255, 255, 0.6)';
      secondsInput.style.backgroundColor = 'rgba(255, 255, 255, 0.6)';
      
      // Update helper text
      const helperText = document.querySelector('.input-helper');
      if (helperText) {
        helperText.innerHTML = 'Free plan: 1-hour timer only. <button onclick="showSubscriptionModal()" style="background: none; border: none; color: #00d4aa; text-decoration: underline; cursor: pointer; font-size: inherit;">Upgrade to Pro</button> for custom timers.';
      }
    } else {
      // Enable timer inputs for paid plans
      hoursInput.disabled = false;
      minutesInput.disabled = false;
      secondsInput.disabled = false;
      
      // Reset styling
      hoursInput.style.backgroundColor = '';
      minutesInput.style.backgroundColor = '';
      secondsInput.style.backgroundColor = '';
      
      // Update helper text
      const helperText = document.querySelector('.input-helper');
      if (helperText) {
            helperText.textContent = 'Timer in hours, minutes, seconds';
  }
}

// Active Timer Display Functions
function updateActiveTimerDisplay(timerData) {
  const activeTimerCard = document.getElementById('activeTimerCard');
  const timerDomain = document.getElementById('timerDomain');
  const timerStatus = document.getElementById('timerStatus');
  const timerCountdown = document.getElementById('timerCountdown');
  const timerProgressFill = document.getElementById('timerProgressFill');
  const timerIcon = document.querySelector('.timer-icon');
  
  if (!activeTimerCard || !timerData) return;
  
  // Show the timer card
  activeTimerCard.style.display = 'block';
  
  // Update domain name
  if (timerDomain) {
    timerDomain.textContent = timerData.domain;
  }
  
  // Update countdown
  if (timerCountdown) {
    timerCountdown.textContent = formatTime(timerData.timeRemaining);
  }
  
  // Update status and styling based on timer state
  if (timerData.isPaused) {
    activeTimerCard.classList.add('paused');
    if (timerIcon) timerIcon.classList.add('paused');
    if (timerStatus) {
      timerStatus.textContent = `⏸️ Paused - ${formatTime(timerData.timeRemaining)} remaining`;
      timerStatus.classList.add('paused');
    }
  } else {
    activeTimerCard.classList.remove('paused');
    if (timerIcon) timerIcon.classList.remove('paused');
    if (timerStatus) {
      timerStatus.innerHTML = `Blocking in <span class="countdown">${formatTime(timerData.timeRemaining)}</span>`;
      timerStatus.classList.remove('paused');
    }
  }
  
  // Update progress bar
  if (timerProgressFill && timerData.gracePeriod) {
    const progressPercentage = (timerData.timeRemaining / timerData.gracePeriod) * 100;
    timerProgressFill.style.width = Math.max(0, progressPercentage) + '%';
  }
}

function hideActiveTimerDisplay() {
  const activeTimerCard = document.getElementById('activeTimerCard');
  if (activeTimerCard) {
    activeTimerCard.style.display = 'none';
  }
}

// Listen for timer updates from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TIMER_UPDATE') {
    // Only show timer for currently active tab
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs.length > 0 && sender.tab && sender.tab.id === tabs[0].id) {
        updateActiveTimerDisplay(message.data);
      }
    });
  } else if (message.type === 'TIMER_STOPPED') {
    // Only hide timer if it's from the currently active tab
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs.length > 0 && sender.tab && sender.tab.id === tabs[0].id) {
        hideActiveTimerDisplay();
      }
    });
  }
});

// Listen for tab changes and request timer update from new active tab
chrome.tabs.onActivated.addListener((activeInfo) => {
  // Clear current timer display when switching tabs
  hideActiveTimerDisplay();
  
  // Request timer update from the newly active tab after a short delay
  setTimeout(() => {
    chrome.tabs.sendMessage(activeInfo.tabId, {
      action: 'requestTimerUpdate'
    }).catch(() => {
      // Content script might not be loaded or no timer running, which is fine
    });
  }, 100);
});

// Also listen for window focus changes
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    // Window gained focus, refresh timer display
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs.length > 0) {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'requestTimerUpdate'
          }).catch(() => {
            // Content script might not be loaded, which is fine
          });
        }, 100);
      }
    });
  }
});

// Set up timer close button when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  const closeTimerBtn = document.getElementById('closeTimerDisplay');
  if (closeTimerBtn) {
    closeTimerBtn.addEventListener('click', hideActiveTimerDisplay);
  }
  
  // When popup opens, request timer update from current active tab
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'requestTimerUpdate'
      }).catch(() => {
        // Content script might not be loaded or no timer running, which is fine
      });
    }
  });
});
  }
  
  // Make functions available globally for onclick handlers
  window.handlePlanAction = handlePlanAction;
  window.showSubscriptionModal = showSubscriptionModal;
}); 