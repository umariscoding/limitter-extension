// Limitter Popup Script

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
  const realtimeDB = new FirebaseRealtimeDB(FIREBASE_CONFIG, firebaseAuth);
  
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
  
  // Active Timer Display Functions (moved to top for availability)
  function updateActiveTimerDisplay(timerData) {
    // console.log('Popup: updateActiveTimerDisplay called with:', timerData);
    
    const activeTimerCard = document.getElementById('activeTimerCard');
    const timerDomain = document.getElementById('timerDomain');
    const timerStatus = document.getElementById('timerStatus');
    const timerCountdown = document.getElementById('timerCountdown');
    const timerProgressFill = document.getElementById('timerProgressFill');
    const timerIcon = document.querySelector('.timer-icon');
    
    // console.log('Popup: Timer elements found:', {
      // activeTimerCard: !!activeTimerCard,
      // timerDomain: !!timerDomain,
      // timerStatus: !!timerStatus,
      // timerCountdown: !!timerCountdown,
      // timerProgressFill: !!timerProgressFill,
      // timerIcon: !!timerIcon
    // });
    
    if (!activeTimerCard || !timerData) {
      // console.log('Popup: Missing activeTimerCard or timerData, returning');
      return;
    }
    
    // Show the timer card
    activeTimerCard.style.display = 'block';
    // console.log('Popup: Timer card set to display: block');
    
    // Update domain name
    if (timerDomain) {
      timerDomain.textContent = timerData.domain;
    }
    
    // Update countdown
    if (timerCountdown) {
      timerCountdown.textContent = formatTime(timerData.timeRemaining);
    }
    
    // Update status and styling based on timer state
    if (timerData.isResetting) {
      activeTimerCard.classList.add('resetting');
      activeTimerCard.classList.remove('paused');
      if (timerIcon) {
        timerIcon.classList.add('resetting');
        timerIcon.classList.remove('paused');
      }
      if (timerStatus) {
        timerStatus.innerHTML = `🔄 <span class="resetting-text">Resetting Timer...</span>`;
        timerStatus.classList.remove('paused');
        timerStatus.classList.add('resetting');
      }
    } else if (timerData.isPaused) {
      activeTimerCard.classList.add('paused');
      activeTimerCard.classList.remove('resetting');
      if (timerIcon) {
        timerIcon.classList.add('paused');
        timerIcon.classList.remove('resetting');
      }
      if (timerStatus) {
        timerStatus.textContent = `⏸️ Paused - ${formatTime(timerData.timeRemaining)} remaining`;
        timerStatus.classList.add('paused');
        timerStatus.classList.remove('resetting');
      }
    } else {
      activeTimerCard.classList.remove('paused', 'resetting');
      if (timerIcon) {
        timerIcon.classList.remove('paused', 'resetting');
      }
      if (timerStatus) {
        timerStatus.innerHTML = `Blocking in <span class="countdown">${formatTime(timerData.timeRemaining)}</span>`;
        timerStatus.classList.remove('paused', 'resetting');
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
  
  // Listen for notification messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'displayNotification') {
      // console.log('Limitter Popup: Received notification:', message);
      
             if (message.isError) {
         showError(message.message);
         
         // If it's a Firebase sync error suggesting reinstall, show reinstall instructions
         if (message.message.includes('reinstall')) {
           showReinstallInstructions();
         }
       } else if (message.message.includes('experiencing issues') || message.message.includes('temporarily unavailable')) {
         // Show warnings for sync issues
         showWarning(message.message);
       } else {
         showFeedback(message.message);
       }
      
      sendResponse({ displayed: true });
    } else if (message.action === 'triggerDomainListRefresh') {
      // console.log('Limitter Popup: Refreshing domain list due to deactivation');
      loadDomainsFromFirestore().then(() => {
        renderDomainsList();
      }).catch(error => {
        console.log('Error refreshing domain list:', error);
      });
      sendResponse({ refreshed: true });
    } else if (message.type === 'TIMER_UPDATE') {
      // Only show timer for currently active tab
      // console.log('Popup: Received TIMER_UPDATE message:', message.data);
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (tabs.length > 0 && sender.tab && sender.tab.id === tabs[0].id) {
          // console.log('Popup: Updating timer display for active tab:', tabs[0].id);
          updateActiveTimerDisplay(message.data);
        } else {
          // console.log('Popup: Timer update not for active tab, ignoring');
        }
      });
    } else if (message.type === 'TIMER_STOPPED') {
      // Only hide timer if it's from the currently active tab
      // console.log('Popup: Received TIMER_STOPPED message');
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (tabs.length > 0 && sender.tab && sender.tab.id === tabs[0].id) {
          // console.log('Popup: Hiding timer display for active tab:', tabs[0].id);
          hideActiveTimerDisplay();
        } else {
          // console.log('Popup: Timer stop not for active tab, ignoring');
        }
      });
    } else if (message.type === 'DOMAIN_DEACTIVATED') {
      // Handle domain deactivation from another device
      // console.log(`Popup: Domain deactivated from another device: ${message.domain}`);
      
      // Remove from local domains object and save
      if (domains[message.domain]) {
        delete domains[message.domain];
        delete domainStates[message.domain];
        saveDomains();
        
        // console.log(`Popup: Removed ${message.domain} from local storage`);
        
        // Update UI immediately
        renderDomainsList();
        updateStats();
        
        // Show notification to user
        showFeedback(`${message.domain} was removed from another device`);
      }
    }
  });
  
  // Function to show reinstall instructions
  function showReinstallInstructions() {
    const reinstallModal = document.createElement('div');
    reinstallModal.id = 'reinstallModal';
    reinstallModal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      backdrop-filter: blur(5px);
    `;
    
    const reinstallContent = document.createElement('div');
    reinstallContent.style.cssText = `
      background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
      padding: 24px;
      border-radius: 16px;
      color: white;
      max-width: 380px;
      text-align: center;
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    `;
    
    reinstallContent.innerHTML = `
      <h3 style="margin: 0 0 16px 0; color: #ff6b6b;">⚠️ Extension Reinstall Required</h3>
      <p style="margin: 0 0 16px 0; line-height: 1.5;">
        Firebase sync has failed multiple times. To fix this issue, please:
      </p>
      <ol style="text-align: left; margin: 0 0 20px 0; padding-left: 20px;">
        <li>Close this popup</li>
        <li>Go to chrome://extensions/</li>
        <li>Find "Limitter" and click "Remove"</li>
        <li>Reinstall the extension from the Chrome Web Store</li>
        <li>Sign in again with your account</li>
      </ol>
      <p style="margin: 0 0 20px 0; font-size: 14px; opacity: 0.8;">
        Your data will be restored from the cloud after reinstalling.
      </p>
      <button id="closeReinstallModal" style="
        background: rgba(255, 255, 255, 0.2);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.3);
        padding: 8px 16px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        margin-right: 8px;
      ">I Understand</button>
      <button id="openExtensionsPage" style="
        background: #ff6b6b;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
      ">Open Extensions Page</button>
    `;
    
    reinstallModal.appendChild(reinstallContent);
    document.body.appendChild(reinstallModal);
    
    // Add event listeners
    document.getElementById('closeReinstallModal').addEventListener('click', () => {
      document.body.removeChild(reinstallModal);
    });
    
    document.getElementById('openExtensionsPage').addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/' });
      document.body.removeChild(reinstallModal);
      window.close();
    });
    
    // Close on outside click
    reinstallModal.addEventListener('click', (e) => {
      if (e.target === reinstallModal) {
        document.body.removeChild(reinstallModal);
      }
    });
  }
  
  // Subscription event listeners
  if (subscriptionBtn) {
    subscriptionBtn.addEventListener('click', () => {
      // Redirect to localhost:3000 instead of showing modal
      chrome.tabs.create({ url: 'http://localhost:3000' });
    });
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

      // console.log('Loading user data from Firestore for user:', user.uid);
      
      // Show loading state
      if (stats) {
        stats.textContent = 'Loading your data...';
      }

      // Load user profile (contains plan information)
      try {
        userProfile = await firestore.getUserProfile(user.uid);
        // console.log('User profile loaded:', userProfile);
        
        // If user profile has plan information, update subscription service
        if (userProfile && userProfile.plan) {
          await subscriptionService.updateUserPlan(userProfile.plan);
        }
      } catch (error) {
        // console.log('User profile not found, will create on first site add');
        userProfile = null;
      }

      // Override functionality removed - can be recreated later

      // Load subscription data (for paid plans)
      try {
        const subscriptionData = await firestore.getDocument(`subscriptions/${user.uid}`);
        if (subscriptionData) {
          // console.log('Subscription data loaded:', subscriptionData);
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
      await updateSubscriptionUI();
      
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

      const formattedDomain = realtimeDB.formatDomainForFirebase(domain);
      const siteId = `${user.uid}_${formattedDomain}`;
      const now = new Date();
      const todayString = getTodayString();
      
      // This function now only handles creating new sites
      console.log(`Creating new site ${domain} in Firebase`);
      
      const siteData = {
        user_id: user.uid,
        url: domain,
        name: domain,
        time_limit: timer,
        time_remaining: timer,
        time_spent_today: 0,
        last_reset_date: todayString,
        is_blocked: false,
        override_active: false,
        is_active: true,
        blocked_until: null,
        schedule: null,
        created_at: now,
        updated_at: now
      };

      console.log('Syncing site data:', {
        siteId,
        data: siteData
      });

      // Add to both Firestore and Realtime Database
      await Promise.all([
        // firestore.updateBlockedSite(siteId, siteData),
        realtimeDB.addBlockedSite(siteId, siteData)
      ]);

      // Update user profile stats if we have one
      if (userProfile) {
        userProfile.total_sites_blocked = Object.keys(domains).length;
        userProfile.updated_at = now;
        await firestore.updateUserProfile(user.uid, userProfile);
      }
    } catch (error) {
      console.error('Error syncing domain to Firebase:', error);
    }
  }

  async function removeDomainFromFirestore(domain) {
    try {
      const user = firebaseAuth.getCurrentUser();
      if (!user) return;

      const formattedDomain = realtimeDB.formatDomainForFirebase(domain);
      const siteId = `${user.uid}_${formattedDomain}`;
      
      // First, get the existing site data to preserve it
      const existingSite = await firestore.getBlockedSite(siteId);
      
      if (!existingSite) {
        console.log(`Site ${domain} not found in Firestore`);
        return;
      }

      // Mark site as inactive while preserving all other data
      const siteData = {
        // Preserve existing data but be selective about which properties
        user_id: existingSite.user_id,
        url: existingSite.url,
        time_limit: existingSite.time_limit,
        time_remaining: existingSite.time_remaining,
        last_reset_date: existingSite.last_reset_date,
        // Only include these if they exist and are not null/undefined
        ...(existingSite.override_active !== undefined && { override_active: existingSite.override_active }),
        ...(existingSite.override_initiated_by && { override_initiated_by: existingSite.override_initiated_by }),
        ...(existingSite.override_initiated_at && { override_initiated_at: existingSite.override_initiated_at }),
        ...(existingSite.blocked_until && { blocked_until: existingSite.blocked_until }),
        ...(existingSite.last_accessed && { last_accessed: existingSite.last_accessed }),
        // Override the fields we're specifically updating
        is_active: false, // Only change the active status
        updated_at: new Date() // Update the timestamp
      };

      // Update both Firestore and Realtime Database
      await Promise.all([
        realtimeDB.addBlockedSite(siteId, siteData)
      ]);

      console.log(`Removed domain ${domain} from Firebase (marked as inactive)`);

      // Update user profile stats
      if (userProfile) {
        userProfile.total_sites_blocked = Math.max(0, Object.keys(domains).length);
        userProfile.updated_at = new Date();
        await firestore.updateUserProfile(user.uid, userProfile);
      }
    } catch (error) {
      console.error('Error removing domain from Firebase:', error);
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
        // startPeriodicUpdates();
          updateDomainStates();
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
  
  async function showAuthenticatedState(user) {
    authContent.classList.add('authenticated');
    userSection.style.display = 'block';
    mainContent.classList.add('authenticated');
    userEmail.textContent = user.email;
    hideAuthError();
    await updateSubscriptionUI();
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
      showAuthError('Please enter both email and password.');
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
      updateDomainStates();
      showAuthenticatedState(user);
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
      // startPeriodicUpdates();
      
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
    chrome.tabs.create({ url: 'http://localhost:3000/signup' });
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
      // console.log('Limitter: Clearing all Chrome storage data on logout');
      
      // Clear sync storage (blocked domains)
      safeChromeCall(() => {
        chrome.storage.sync.clear(() => {
          console.log('Limitter: Sync storage cleared');
        });
      });
      
      // Clear local storage (timer states, daily blocks, etc.)
      safeChromeCall(() => {
        chrome.storage.local.clear(() => {
          console.log('Limitter: Local storage cleared');
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
      await handleOverrideClick(domain);
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
              // Check if this hostname matches any of our tracked domains (exact match only)
              for (const domain of Object.keys(domains)) {
                const cleanHostname = hostname.replace(/^www\./, '');
                if (cleanHostname === domain || hostname === domain) {
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
  
    // Override button state function removed

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

  // Validate domain format - must have proper TLD structure
  function isValidDomainFormat(domain) {
    if (!domain) return false;
    
    // Check if domain has at least one dot
    if (!domain.includes('.')) {
      return false;
    }
    
    // Split domain into parts
    const parts = domain.split('.');
    
    // Must have at least 2 parts (domain.tld)
    if (parts.length < 2) {
      return false;
    }
    
    // Check each part is valid (no empty parts, no special characters except hyphens)
    for (const part of parts) {
      if (!part || part.length === 0) {
        return false;
      }
      
      // Check for valid characters (letters, numbers, hyphens, but not starting/ending with hyphen)
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(part)) {
        return false;
      }
    }
    
    // Last part (TLD) should be at least 2 characters and only letters
    const tld = parts[parts.length - 1];
    if (tld.length < 2 || !/^[a-z]+$/i.test(tld)) {
      return false;
    }
    
    // Domain name part (before TLD) should not be empty
    if (parts[0].length === 0) {
      return false;
    }
    
    return true;
  }

  // Clean domain from URL input
  function cleanDomainFromUrl(input) {
    if (!input) return '';
    
    let domain = input.trim().toLowerCase();
    
    try {
      // If it looks like a URL, parse it properly
      if (domain.includes('://') || domain.startsWith('www.')) {
        // Add protocol if missing for URL parsing
        if (!domain.includes('://')) {
          domain = 'http://' + domain;
        }
        
        const url = new URL(domain);
        domain = url.hostname;
      }
      
      // Remove www. prefix if present
      domain = domain.replace(/^www\./, '');
      
      // Remove any remaining path, query params, or fragments
      domain = domain.split('/')[0].split('?')[0].split('#')[0];
      
      return domain;
    } catch (error) {
      // If URL parsing fails, do manual cleaning
      console.log('URL parsing failed, doing manual cleaning:', error);
      
      // Remove protocol
      domain = domain.replace(/^https?:\/\//, '');
      
      // Remove www. prefix
      domain = domain.replace(/^www\./, '');
      
      // Remove path and query parameters
      domain = domain.split('/')[0].split('?')[0].split('#')[0];
      
      return domain;
    }
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
        // console.log('No authenticated user, falling back to local storage');
        loadDomains();
        return;
      }

      console.log('Loading blocked sites from Firebase Realtime Database');
      
      // Get user's blocked sites from Realtime Database
      const blockedSites = await realtimeDB.getBlockedSites();
      
      // Clear existing domains object
      domains = {};
      
      if (blockedSites && blockedSites.length > 0) {
        // Convert sites to local domains format
        blockedSites.forEach(site => {
          // Only load active sites
          if (site.is_active) {
            // The url is already decoded by getBlockedSites
            domains[site.url] = site.time_limit;
            console.log(`Loaded site from Firebase: ${site.url} with ${site.time_limit}s timer`);
            
            // Set up real-time listener for each blocked site
            const formattedDomain = realtimeDB.formatDomainForFirebase(site.url);
            const siteId = `${user.uid}_${formattedDomain}`;
            
            try {
              realtimeDB.listenToBlockedSite(siteId, (updatedSiteData) => {
                console.log(`🔥 Firebase Update: ${site.url}`, updatedSiteData);
                
                // Handle override changes
                if (updatedSiteData.override_active !== undefined) {
                  console.log(`Override active changed for ${site.url}: ${updatedSiteData.override_active}`);
                  
                  if (updatedSiteData.override_active) {
                    console.log(`Override activated for ${site.url} from another device`);
                    
                    // Update Chrome local storage with reset timer state
                    console.log("updatedSiteData", updatedSiteData)
                    const timerKey = `timerState_${site.url}`;
                    const resetTimerState = {
                      timeRemaining: updatedSiteData.time_limit,
                      gracePeriod: updatedSiteData.time_limit,
                      isActive: true,
                      isPaused: false,
                      timestamp: Date.now(),
                      date: getTodayString(),
                      url: site.url,
                      override_active: true,
                      override_initiated_by: updatedSiteData.override_initiated_by,
                      override_initiated_at: updatedSiteData.override_initiated_at,
                      time_limit: updatedSiteData.time_limit
                    };

                    safeChromeCall(() => {
                      chrome.storage.local.set({
                        [timerKey]: resetTimerState
                      }, () => {
                        console.log(`Chrome local storage updated for ${site.url} - override activated`);
                      });
                    });

                    // Clear daily block
                    clearDailyBlock(site.url);
                    
                    // Update domains object for Chrome sync storage
                    domains[site.url] = updatedSiteData.time_limit;
                    saveDomains(); // This saves to Chrome sync storage
                    
                    // Update domain states for UI
                    domainStates[site.url] = {
                      status: 'running',
                      timeRemaining: updatedSiteData.time_remaining || updatedSiteData.time_limit,
                      isActive: true
                    };
                    
                    // Re-render the domains list with skipSubscriptionUpdate=true to prevent loops
                    renderDomainsList(true);
                    
                    console.log(`Domains object and Chrome sync storage updated for ${site.url}`);
                    
                  } else {
                    console.log(`Override deactivated for ${site.url} from another device`);
                    
                    // Update Chrome local storage to clear override state
                    const timerKey = `timerState_${site.url}`;
                    safeChromeCall(() => {
                      chrome.storage.local.get([timerKey], (result) => {
                        if (result[timerKey]) {
                          const updatedState = {
                            ...result[timerKey],
                            override_active: false,
                            override_initiated_by: null,
                            override_initiated_at: null,
                            timestamp: Date.now()
                          };
                          
                          chrome.storage.local.set({
                            [timerKey]: updatedState
                          }, () => {
                            console.log(`Chrome local storage updated for ${site.url} - override cleared`);
                          });
                        }
                      });
                    });
                    
                    // Update domain states for UI
                    if (domainStates[site.url]) {
                      domainStates[site.url] = {
                        ...domainStates[site.url],
                        // Keep existing state but ensure override is cleared
                      };
                    }
                    
                    // Re-render the domains list
                    renderDomainsList();
                  }
                }
              });
            } catch (error) {
              console.error(`Failed to set up listener for ${site.url}:`, error);
            }
          }
        });
        
        console.log(`Loaded ${Object.keys(domains).length} active sites from Firebase:`, Object.keys(domains));
      } else {
        console.log('No blocked sites found in Firebase');
      }
      
      // Save to local storage to sync with background script
      saveDomains();
      
      // Clean up leftover storage entries from auto-added domains
      await cleanupLeftoverStorageEntries();
      
    } catch (error) {
      console.error('Error loading domains from Firebase:', error);
      // Fallback to local storage
      console.log('Falling back to local storage due to error');
      loadDomains();
    }
  }

  // Clean up leftover storage entries from domains that were auto-added but aren't in legitimate domains list
  async function cleanupLeftoverStorageEntries() {
    try {
      const legitimateDomains = Object.keys(domains);
      
      // Get all storage keys
      safeChromeCall(() => {
        chrome.storage.local.get(null, (allStorage) => {
          const keysToRemove = [];
          
          // Find timer and block keys for domains not in legitimate list
          Object.keys(allStorage).forEach(key => {
            if (key.startsWith('timerState_') || key.startsWith('dailyBlock_')) {
              const domain = key.replace(/^(timerState_|dailyBlock_)/, '');
              
              // If this domain is not in our legitimate domains list, mark for removal
              if (!legitimateDomains.includes(domain)) {
                keysToRemove.push(key);
                console.log(`Limitter: Marking leftover storage key for removal: ${key}`);
              }
            }
          });
          
          // Remove leftover keys
          if (keysToRemove.length > 0) {
            chrome.storage.local.remove(keysToRemove, () => {
              console.log(`Limitter: Cleaned up ${keysToRemove.length} leftover storage entries`);
            });
          }
        });
      });
    } catch (error) {
      console.error('Error cleaning up leftover storage entries:', error);
    }
  }

  function stopTrackingDomain(domain) {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.url) {
          try {
            const hostname = new URL(tab.url).hostname.toLowerCase();
            const cleanHostname = hostname.replace(/^www\./, '');
            if (cleanHostname === domain || hostname === domain) {
              console.log(`Limitter: Sending stop tracking for removed domain ${domain} to tab ${tab.id}`);
              
              // Send explicit stopTracking message
              chrome.tabs.sendMessage(tab.id, {
                action: 'stopTracking',
                domain: domain
              }).catch((error) => {
                // Tab might not have content script loaded, which is fine
                console.log(`Could not send stop tracking to tab ${tab.id} - content script may not be loaded`);
                if (error.message && (error.message.includes('Could not establish connection') || 
                    error.message.includes('Receiving end does not exist'))) {
                  showContentScriptError('domain removal');
                }
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
    
    // console.log(`Limitter: Clearing storage for domain: ${domain}`);
    
    safeChromeCall(() => {
      chrome.storage.local.remove([blockKey, timerKey], () => {
        if (chrome.runtime.lastError) {
          console.error('Storage clear error:', chrome.runtime.lastError);
        } else {
          console.log(`Limitter: Successfully cleared storage for ${domain}`);
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
    
    // Clean domain (remove everything before www, then remove www, then remove path)
    const cleanDomain = cleanDomainFromUrl(domain);
    
    // Validate the cleaned domain format
    if (!isValidDomainFormat(cleanDomain)) {
      showError('Please enter a valid domain (e.g., google.com, facebook.net, amazon.co.uk)');
      return;
    }
    
    // Check if domain already exists in Firestore
    const user = firebaseAuth.getCurrentUser();
    if (!user) {
      showError('Please log in to add domains');
      return;
    }

    const formattedDomain = realtimeDB.formatDomainForFirebase(cleanDomain);
    const siteId = `${user.uid}_${formattedDomain}`;
    const existingSite = await realtimeDB.getBlockedSite(siteId);
    
    if (existingSite) {
      if (existingSite.is_active) {
        // Site already exists and is active - show message and return
        showWarning(`${cleanDomain} is already being tracked`);
        return;
      } else {
        // Site exists but is inactive - reactivate it without changing time_limit or time_remaining
        console.log(`Reactivating inactive site: ${cleanDomain}`);
        const now = new Date();
        const reactivatedSiteData = {
          ...existingSite,
          is_active: true,
          updated_at: now,
          last_accessed: now.toISOString()
        };
        
        await realtimeDB.addBlockedSite(siteId, reactivatedSiteData);
        
        // Add to local domains with existing time_limit
        domains[cleanDomain] = existingSite.time_limit;
        saveDomains();
        
        showFeedback(`Reactivated ${cleanDomain} with existing ${formatTime(existingSite.time_limit)} timer`);
      }
    } else {
      // New site - add normally
      domains[cleanDomain] = totalSeconds;
      saveDomains();
      
      // Sync to Firestore (create new site)
      await syncDomainToFirestore(cleanDomain, totalSeconds);
      
      showFeedback(`Added ${cleanDomain} with ${formatTime(totalSeconds)} timer. Open tabs for this site will be reloaded.`);
    }
    
    // Common actions for both new and reactivated sites
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
            const cleanHostname = hostname.replace(/^www\./, '');
            if (cleanHostname === cleanDomain || hostname === cleanDomain) {
              // Reload the tab so the extension can start tracking immediately
              chrome.tabs.reload(tab.id).catch((error) => {
                console.log(`Could not reload tab ${tab.id}:`, error);
              });
              // console.log(`Reloaded tab ${tab.id} for domain ${cleanDomain}`);
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
  }
  
  async function removeDomain(domain) {
    // Check if user is authenticated
    if (!isUserAuthenticated()) {
      showError('Please log in to remove domains');
      return;
    }

    try {
      const user = firebaseAuth.getCurrentUser();
      if (!user) {
        showError('Please log in to remove domains');
        return;
      }

      // Format domain for Firebase
      const formattedDomain = realtimeDB.formatDomainForFirebase(domain);
      const siteId = `${user.uid}_${formattedDomain}`;

      console.log(`Removing domain ${domain} from both local storage and Firebase (siteId: ${siteId})`);

      // Remove from local storage first
      delete domains[domain];
      delete domainStates[domain];
      saveDomains();

      // Remove from both Firestore (mark as inactive) and Realtime Database (delete completely)
      await Promise.all([
        // Mark as inactive in Firestore
        // removeDomainFromFirestore(domain),
        
        // Set is_active: false in Realtime Database so other devices can detect the change
        (async () => {
          try {
            const existingSite = await realtimeDB.getBlockedSite(siteId);
            if (existingSite) {
              const updatedSiteData = {
                ...existingSite,
                is_active: false,
                updated_at: new Date().toISOString()
              };
              
              await realtimeDB.addBlockedSite(siteId, updatedSiteData);
              console.log(`Successfully set is_active: false for ${domain} in Realtime Database`);
            } else {
              console.log(`No existing site found for ${domain} in Realtime Database`);
            }
          } catch (error) {
            console.error(`Error setting is_active: false for ${domain} in Realtime Database:`, error);
            // Don't throw here - we still want to continue with other cleanup
          }
        })()
      ]);

      // Clear local timer states
      clearDailyBlock(domain);
      stopTrackingDomain(domain);

      // Notify background script to reload tabs for this domain across all devices
      // This ensures inactive tabs also stop tracking the removed domain
      safeChromeCall(() => {
        chrome.runtime.sendMessage({ 
          action: 'domainRemoved', 
          domain: domain 
        });
      });

      renderDomainsList();
      updateStats();
      showFeedback(`Deactivated ${domain} - all devices will immediately stop tracking this domain`);
      
    } catch (error) {
      console.error('Error removing domain:', error);
      showError(`Failed to remove ${domain}. Please try again.`);
    }
  }

  async function handleOverrideClick(domain) {
    // Check if user is authenticated
    if (!isUserAuthenticated()) {
      showError('Please log in to use override');
      return;
    }

    try {
      const user = await firebaseAuth.getCurrentUser();
      if (!user) {
        showError('Please log in to use override');
        return;
      }

      // Get user's profile to check plan
      const userProfile = await firestore.getUserProfile(user.uid);
      if (!userProfile) {
        showError('Could not fetch user data');
        return;
      }

      const userPlan = userProfile.plan || 'free';
      
      // If user is elite, no need to check overrides
      if (userPlan === 'elite') {
        console.log('Elite user - unlimited overrides available');
        await processOverride(domain, user.uid, userPlan, user);
        return;
      }

      // Get user's overrides from user_overrides collection
      const userOverrides = await firestore.getUserOverrides(user.uid);
      if (!userOverrides) {
        showError('Could not fetch override data');
        return;
      }

      // Check if user has overrides availabl
      // e
      console.log("userOverrides", userOverrides)
      if (userOverrides.overrides <= 0) {
        // No overrides available - redirect to checkout
        console.log("No overrides available - opening checkout in new tab")
        chrome.tabs.create({ url: 'http://localhost:3001/checkout?overrides=1' });
        window.close(); // Close the popup after opening the new tab
        return;
      }

      console.log(`User has ${userOverrides.overrides} overrides remaining`);
      
      // Process the override if we get here
      await processOverride(domain, user.uid, userPlan, user);

    } catch (error) {
      console.log('Error handling override:', error);
      showError('Failed to process override');
    }
  }

  async function processOverride(domain, userId, userPlan, user = {}) {
    // Get the original time limit for this domain
    const originalTimeLimit = domains[domain];
    if (!originalTimeLimit) {
      showError('Domain not found');
      return;
    }

    // Format domain for Firebase
    const formattedDomain = realtimeDB.formatDomainForFirebase(domain);
    const siteId = `${userId}_${formattedDomain}`;

    try {
      // Get existing site data
      const existingSite = await realtimeDB.getBlockedSite(siteId);
      if (!existingSite) {
        showError('Site not found in database');
        return;
      }

      console.log("setting override");
      // Create updated site data with reset timer and override active
      const now = new Date();
      const updatedSiteData = {
        ...existingSite,
        time_remaining: originalTimeLimit, // Reset to original time limit
        time_limit: originalTimeLimit,
        override_active: true, // Set override active
        override_initiated_by: userId,
        override_initiated_at: now.toISOString(),
        is_blocked: false, // Unblock the site
        blocked_until: null, // Clear blocked until
        updated_at: now.toISOString(),
        last_accessed: now.toISOString()
      };

      // First update local state
      // Reset timer state in Chrome storage
      const timerKey = `timerState_${domain}`;
      const resetTimerState = {
        timeRemaining: originalTimeLimit,
        gracePeriod: originalTimeLimit,
        isActive: true,
        isPaused: false,
        timestamp: Date.now(),
        date: getTodayString(),
        url: domain,
        override_active: true,
        override_initiated_by: userId,
        override_initiated_at: now.toISOString(),
        time_limit: originalTimeLimit
      };

      // Update Chrome storage first
      await new Promise((resolve) => {
        safeChromeCall(() => {
          chrome.storage.local.set({
            [timerKey]: resetTimerState
          }, resolve);
        });
      });

      // Clear daily block in Chrome storage
      await clearDailyBlock(domain);

      // Update Firebase Realtime Database
      await realtimeDB.addBlockedSite(siteId, updatedSiteData);

      // Create override history record
      const historyId = crypto.randomUUID();
      const historyData = {
        user_id: userId,
        site_url: domain,
        timestamp: now.toISOString(),
        month: now.toISOString().slice(0, 7),
        override_type: userPlan === 'elite' ? 'unlimited' : 'override',
        plan: userPlan,
        created_at: now.toISOString()
      };

      await firestore.createOverrideHistory(historyId, historyData);

      // Update user overrides if not elite
      if (userPlan !== 'elite') {
        const userOverrides = await firestore.getUserOverrides(userId);
        const currentMonth = now.toISOString().slice(0, 7);
        const monthlyStats = userOverrides?.monthly_stats || {};
        const thisMonthStats = monthlyStats[currentMonth] || {
          overrides_used: 0,
          total_spent_this_month: 0
        };

        // Update stats
        thisMonthStats.overrides_used++;
        
        await firestore.updateUserOverrides(userId, {
          overrides: Math.max(0, (userOverrides?.overrides || 0) - 1),
          overrides_used_total: (userOverrides?.overrides_used_total || 0) + 1,
          monthly_stats: {
            ...monthlyStats,
            [currentMonth]: thisMonthStats
          },
          updated_at: now.toISOString()
        });
      }

      // Update the domains object and save to Chrome sync storage
      domains[domain] = originalTimeLimit;
      await saveDomains();

      domainStates[domain] = {
        status: 'running',
        timeRemaining: originalTimeLimit,
        isActive: true
      };

      // Notify content script about override
      await new Promise((resolve) => {
        safeChromeCall(() => {
          chrome.runtime.sendMessage({
            action: 'domainOverrideActivated',
            domain: domain,
            timeLimit: originalTimeLimit
          }, resolve);
        });
      });

      // Set timeout to clear override after 3 seconds
      setTimeout(async () => {
        try {
          console.log("clearing override");
          const clearedOverrideData = {
            ...updatedSiteData,
            override_active: false,
            override_initiated_by: null,
            override_initiated_at: null,
            updated_at: new Date().toISOString()
          };

          // Update Firebase first
          await realtimeDB.addBlockedSite(siteId, clearedOverrideData);

          // Then update local storage
          await new Promise((resolve) => {
            safeChromeCall(() => {
              chrome.storage.local.get([timerKey], (result) => {
                if (result[timerKey]) {
                  const updatedState = {
                    ...result[timerKey],
                    override_active: false,
                    override_initiated_by: null,
                    override_initiated_at: null,
                    timestamp: Date.now()
                  };
                  
                  chrome.storage.local.set({
                    [timerKey]: updatedState
                  }, () => {
                    console.log(`Chrome local storage updated for ${domain} - override cleared`);
                    resolve();
                  });
                } else {
                  resolve();
                }
              });
            });
          });

          console.log(`Override cleared for ${domain} after 3 seconds`);
        } catch (error) {
          console.error('Error clearing override:', error);
        }
      }, 2000);

      renderDomainsList();
      updateStats();
      
      showFeedback(`Override activated for ${domain} - timer reset to ${formatTime(originalTimeLimit)}`);

    } catch (error) {
      console.error('Error in processOverride:', error);
      showError('Failed to process override');
    }
  }






  
  async function renderDomainsList(skipSubscriptionUpdate = false) {
    console.log("rendering domains list")
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
      const state = domainStates[domain] || { status: 'unknown', timeRemaining: 0 };
      const isActive = domain === activeDomain;
      const isNewlyAdded = newDomains.includes(domain);
      
      let statusText = '';
      let statusClass = '';
      
      if (state.status === 'blocked') {
        statusText = 'Blocked';
        statusClass = 'blocked';
      } else if (state.status === 'running') {
        statusText = formatTime(state.timeRemaining);
        statusClass = state.timeRemaining <= 300 ? 'warning' : '';
      } else {
        statusText = 'Unknown';
        statusClass = 'unknown';
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
            <button class="override-btn" data-domain="${domain}" title="Reset timer and override block">Override</button>
            <button class="remove-btn" data-domain="${domain}" title="Remove domain">Remove</button>
          </div>
        </div>
      `;
    }).join('');
    
    // Update previous order
    previousDomainOrder = [...sortedDomains];
    
    // Update subscription UI only if not skipped
    if (!skipSubscriptionUpdate) {
      await updateSubscriptionUI();
    }
    
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
    showGlobalNotification(message, 'success', 3000);
  }
  
  function showError(message) {
    showGlobalNotification(message, 'error', 5000);
  }

  function showWarning(message) {
    showGlobalNotification(message, 'warning', 4000);
  }

  // Show content script error with instructions to reload extension and page
  function showContentScriptError(operation = 'operation') {
    const message = `⚠️ Extension communication error during ${operation}. Please:\n1. Reload this page (Ctrl+R)\n2. If issue persists, disable and re-enable the extension`;
    showGlobalNotification(message, 'error', 8000);
  }

  function showGlobalNotification(message, type = 'success', duration = 3000) {
    const notification = document.getElementById('globalNotification');
    if (!notification) {
      // Fallback to old method if global notification not available
      if (stats) {
        const originalText = stats.textContent;
        stats.textContent = message;
        stats.style.color = type === 'error' ? '#ffcccc' : '#00d4aa';
        stats.style.fontWeight = 'bold';
        
        setTimeout(() => {
          stats.textContent = originalText;
          stats.style.color = '';
          stats.style.fontWeight = 'normal';
        }, 2000);
      }
      return;
    }

    // Clear existing classes
    notification.className = 'global-notification';
    notification.classList.add(type);
    notification.textContent = message;
    notification.style.display = 'block';

    // Auto-hide after duration
    setTimeout(() => {
      notification.style.display = 'none';
    }, duration);
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
  
  // All override functions removed - can be recreated later




  
  // Subscription functions
  async function showSubscriptionModal() {
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
  
  async function updateSubscriptionUI() {
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
      console.log("userProfile", userProfile)
      
      const user = firebaseAuth.getCurrentUser();
      const userOverrides = await firestore.getUserOverrides(user.uid);
      // Add override information
      console.log("userOverrides", userOverrides)
      if (userProfile) {
        if (userOverrides.overrides === -1) {
          limitsText += ' • Unlimited overrides';
        } else if (userOverrides.overrides > 0) {
          limitsText += ` • ${userOverrides.overrides} overrides remaining`;
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
      <button onclick="chrome.tabs.create({ url: 'http://localhost:3000' })" style="margin-top: 8px; padding: 8px 16px; background: #00d4aa; color: white; border: none; border-radius: 6px; cursor: pointer;">
        Upgrade Plan
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
        helperText.innerHTML = 'Free plan: 1-hour timer only. <button onclick="chrome.tabs.create({ url: \'http://localhost:3000\' })" style="background: none; border: none; color: #00d4aa; text-decoration: underline; cursor: pointer; font-size: inherit;">Upgrade to Pro</button> for custom timers.';
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

// Listen for tab changes and request timer update from new active tab
chrome.tabs.onActivated.addListener((activeInfo) => {
  // Clear current timer display when switching tabs
  hideActiveTimerDisplay();
  
  // Request timer update from the newly active tab after a short delay
  setTimeout(() => {
    chrome.tabs.sendMessage(activeInfo.tabId, {
      action: 'requestTimerUpdate'
    }).catch((error) => {
      // Content script might not be loaded or no timer running, which is fine
      if (error.message && (error.message.includes('Could not establish connection') || 
          error.message.includes('Receiving end does not exist'))) {
        showContentScriptError('timer update');
      }
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
          }).catch((error) => {
            // Content script might not be loaded, which is fine
            if (error.message && (error.message.includes('Could not establish connection') || 
                error.message.includes('Receiving end does not exist'))) {
              showContentScriptError('timer update');
            }
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
      // console.log('Popup: DOM loaded, requesting timer update from tab:', tabs[0].id);
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'requestTimerUpdate'
      }).then((response) => {
        // console.log('Popup: Timer update request response:', response);
      }).catch((error) => {
        // console.log('Popup: Timer update request error:', error);
        // Content script might not be loaded or no timer running, which is fine
        if (error.message && (error.message.includes('Could not establish connection') || 
            error.message.includes('Receiving end does not exist'))) {
          showContentScriptError('timer update');
        }
      });
    } else {
      // console.log('Popup: No active tabs found');
    }
  });
});
  }
  
  // Make functions available globally for onclick handlers
  window.handlePlanAction = handlePlanAction;
  window.showSubscriptionModal = showSubscriptionModal;
}); 