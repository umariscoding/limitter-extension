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

      // Load user profile
      try {
        userProfile = await firestore.getUserProfile(user.uid);
        console.log('User profile loaded:', userProfile);
      } catch (error) {
        console.log('User profile not found, will create on first site add');
        userProfile = null;
      }

      // Load domains from local storage instead of Firestore
      loadDomains();
      
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

      // Create or update the site in Firestore
      const siteId = `${user.uid}_${domain}`;
      const now = new Date();
      const todayString = getTodayString();
      
      const siteData = {
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

      // Mark site as inactive in Firestore
      const siteId = `${user.uid}_${domain}`;
      const siteData = {
        is_active: false,
        updated_at: new Date()
      };

      await firestore.updateBlockedSite(siteId, siteData);
      console.log(`Removed domain ${domain} from Firestore`);

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
        showAuthenticatedState(storedUser);
        await loadUserDataFromFirestore();
        startPeriodicUpdates();
      } else {
        showUnauthenticatedState();
      }
    } catch (error) {
      console.error('Auth initialization error:', error);
      showUnauthenticatedState();
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
      showAuthenticatedState(user);
      
      // Clear form
      emailInput.value = '';
      passwordInput.value = '';
      
      // Notify background script of login
      safeChromeCall(() => {
        chrome.runtime.sendMessage({ action: 'userLoggedIn' });
      });
      
      // Load app data after successful login
      await loadUserDataFromFirestore();
      startPeriodicUpdates();
      
    } catch (error) {
      console.error('Login error:', error);
      showAuthError(error.message || 'Login failed. Please check your credentials.');
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login';
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
    } else if (e.target.classList.contains('reset-btn')) {
      resetDomain(domain);
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
    
    domains[cleanDomain] = totalSeconds;
    saveDomains();
    
    // Sync to Firestore
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
    
    showFeedback(`Added ${cleanDomain} with ${formatTime(totalSeconds)} timer. Open tabs for this site will be reloaded.`);
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
            <button class="reset-btn" data-domain="${domain}" title="Reset today's limit">Reset</button>
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
  
  function resetDomain(domain) {
    // Check if user is authenticated
    if (!isUserAuthenticated()) {
      showError('Please log in to reset domains');
      return;
    }

    console.log(`Smart Tab Blocker: Initiating reset for domain: ${domain}`);
    
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
    
    // Force refresh of content scripts by sending a message
    chrome.tabs.query({}, (tabs) => {
      let resetSuccess = false;
      let tabsFound = 0;
      const promises = [];
      
      tabs.forEach(tab => {
        if (tab.url) {
          try {
            const hostname = new URL(tab.url).hostname.toLowerCase();
            if (hostname === domain || hostname.endsWith('.' + domain)) {
              tabsFound++;
              console.log(`Smart Tab Blocker: Found matching tab ${tab.id} for domain ${domain}: ${tab.url}`);
              
              // Send reset message to this tab
              const promise = chrome.tabs.sendMessage(tab.id, { 
                action: 'domainReset',
                domain: domain,
                timer: domains[domain]
              }).then((response) => {
                if (response && response.success) {
                  resetSuccess = true;
                  console.log(`Reset successful for tab ${tab.id}: ${response.message}`);
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
      Promise.all(promises).then(() => {
        if (resetSuccess) {
          showFeedback(`✅ ${domain} reset - timer restarted and site unblocked`);
        } else if (tabsFound > 0) {
          showFeedback(`⚠️ ${domain} reset sent to ${tabsFound} tab(s) - refresh page if needed`);
        } else {
          showFeedback(`Reset ${domain} - timer ready to start (no active tabs found)`);
        }
      });
    });
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
      if (maxDomains === -1) {
        planLimits.textContent = 'Unlimited domains';
        domainUsage.textContent = `${currentDomainCount} domains`;
      } else {
        planLimits.textContent = `${maxDomains} domains max`;
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
        planLimits.textContent += ' • 1-hour timers only';
      }
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
  }
  
  // Make functions available globally for onclick handlers
  window.handlePlanAction = handlePlanAction;
  window.showSubscriptionModal = showSubscriptionModal;
}); 