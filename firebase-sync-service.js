// Firebase Sync Service
// Handles periodic syncing of timer states and blocked site data to Firestore

class FirebaseSyncService {
  constructor(firestore, auth) {
    this.firestore = firestore;
    this.auth = auth;
    this.syncInterval = null;
    this.pendingSyncs = new Map(); // Track pending sync operations
    this.lastSyncTime = 0;
    this.syncIntervalMs = 10000; // 10 seconds
    this.consecutiveErrors = 0; // Track consecutive errors
    this.maxConsecutiveErrors = 5; // Show reinstall message after 5 consecutive errors
    this.isInitializationFailed = false;
  }

  // Initialize the sync service with better error handling
  init() {
    try {
      console.log('Firebase Sync Service: Initializing...');
      this.consecutiveErrors = 0; // Reset error count on init
      this.isInitializationFailed = false;
      this.startPeriodicSync();
    } catch (error) {
      console.error('Firebase Sync Service: Initialization failed:', error);
      this.isInitializationFailed = true;
      this.handleInitializationError(error);
    }
  }

  // Handle initialization errors
  handleInitializationError(error) {
    console.warn('Firebase Sync Service: Working in degraded mode due to initialization failure');
    // Don't throw error, just log and continue without sync
    this.showUserNotification('Firebase sync is temporarily unavailable. Your data will be saved locally.');
  }

  // Show user notification (this will be called from background or popup)
  showUserNotification(message, isError = false) {
    try {
      // Try to send message to popup if available
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'showNotification',
          message: message,
          isError: isError,
          source: 'firebase-sync'
        }).catch(() => {
          // Ignore if popup is not available
          console.log('Firebase Sync Service: Popup not available for notification');
        });
      }
    } catch (error) {
      // Silently handle notification errors
      console.log('Firebase Sync Service: Unable to show notification:', message);
    }
  }

  // Start periodic sync every 10 seconds with improved error handling
  startPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    // Don't start sync if initialization failed
    if (this.isInitializationFailed) {
      console.log('Firebase Sync Service: Not starting periodic sync due to initialization failure');
      return;
    }

    this.syncInterval = setInterval(() => {
      this.performPeriodicSync();
    }, this.syncIntervalMs);

    console.log('Firebase Sync Service: Started periodic sync every 10 seconds');
  }

  // Stop periodic sync
  stopPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('Firebase Sync Service: Stopped periodic sync');
    }
  }

  // Perform periodic sync of all timer states with better error recovery
  async performPeriodicSync() {
    try {
      // Skip sync if too many consecutive errors
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        console.log('Firebase Sync Service: Skipping sync due to too many consecutive errors');
        return;
      }

      // Try multiple ways to get the authenticated user (be more lenient)
      let user = null;
      try {
        user = this.auth.getCurrentUser();
      } catch (error) {
        console.log('Firebase Sync Service: getCurrentUser failed, trying stored auth data');
      }
      
      // If getCurrentUser doesn't work, try getting stored auth data
      if (!user) {
        try {
          const storedUser = await this.auth.getStoredAuthData();
          if (storedUser) {
            user = storedUser;
          }
        } catch (error) {
          console.log('Firebase Sync Service: getStoredAuthData failed, continuing without sync');
        }
      }
      
      if (!user) {
        console.log('Firebase Sync Service: No authenticated user, skipping periodic sync');
        this.consecutiveErrors = 0; // Reset error count if just no user
        return;
      }

      // Get all timer states from Chrome storage
      const timerStates = await this.getAllTimerStates();
      
      if (timerStates.length === 0) {
        console.log('Firebase Sync Service: No active timer states to sync');
        this.consecutiveErrors = 0; // Reset error count for successful operations
        return;
      }

      console.log(`Firebase Sync Service: Syncing ${timerStates.length} timer states...`);

      // Sync each timer state to Firestore (use Promise.allSettled to continue even if some fail)
      const syncPromises = timerStates.map(state => 
        this.syncTimerStateToFirestore(user.uid, state)
      );

      const results = await Promise.allSettled(syncPromises);
      
      // Check if all syncs failed
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length === results.length && results.length > 0) {
        throw new Error(`All ${failures.length} sync operations failed`);
      }
      
      this.lastSyncTime = Date.now();
      this.consecutiveErrors = 0; // Reset error count on successful sync
      console.log('Firebase Sync Service: Periodic sync completed');

    } catch (error) {
      console.error('Firebase Sync Service: Error during periodic sync:', error);
      this.handleSyncError(error);
    }
  }

  // Handle sync errors with progressive response
  handleSyncError(error) {
    this.consecutiveErrors++;
    
    console.warn(`Firebase Sync Service: Consecutive error count: ${this.consecutiveErrors}/${this.maxConsecutiveErrors}`);
    
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      console.error('Firebase Sync Service: Too many consecutive errors, recommending extension reinstall');
      this.showUserNotification(
        'Firebase sync has failed multiple times. Please try reinstalling the extension to fix sync issues.',
        true
      );
      
      // Stop trying to sync to prevent further errors
      this.stopPeriodicSync();
    } else if (this.consecutiveErrors >= 3) {
      // Show warning after 3 consecutive errors
      this.showUserNotification(
        'Firebase sync is experiencing issues. Your data is saved locally and will sync when connection is restored.',
        false
      );
    }
  }

  // Get all timer states from Chrome storage
  async getAllTimerStates() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (allStorage) => {
        const timerStates = [];
        
        for (const [key, value] of Object.entries(allStorage)) {
          // Look for timer state keys
          if (key.startsWith('timerState_') && value && value.domain) {
            // Calculate actual time remaining based on timestamp
            const now = Date.now();
            const timeDiff = Math.floor((now - value.timestamp) / 1000);
            
            // Only include active timers with time remaining
            if (value.isActive && value.timeRemaining > 0) {
              let actualTimeRemaining = value.timeRemaining;
              
              // If timer is not paused, subtract elapsed time
              if (!value.isPaused) {
                actualTimeRemaining = Math.max(0, value.timeRemaining - timeDiff);
              }
              
              timerStates.push({
                ...value,
                actualTimeRemaining,
                storageKey: key
              });
            }
          }
        }
        
        resolve(timerStates);
      });
    });
  }

  // Sync a specific timer state to Firestore
  async syncTimerStateToFirestore(userId, timerState) {
    try {
      // Normalize domain for consistency - do this outside try block to ensure availability
      const normalizedDomain = this.normalizeDomain(timerState.domain);
      const siteId = `${userId}_${normalizedDomain}`;
      
      const now = new Date();
      
      // Prevent duplicate syncs for the same site
      if (this.pendingSyncs.has(siteId)) {
        console.log(`Firebase Sync Service: Sync already pending for ${normalizedDomain}`);
        return;
      }

      this.pendingSyncs.set(siteId, true);

      // Get existing site data from Firestore
      const existingSite = await this.firestore.getBlockedSite(siteId);
      
      if (!existingSite) {
        console.log(`Firebase Sync Service: Site ${normalizedDomain} not found in Firestore, creating new entry`);
        // Create a new site entry if it doesn't exist
        const todayString = this.getTodayString();
        const newSiteData = {
          user_id: userId,
          url: normalizedDomain,
          name: normalizedDomain,
          time_limit: timerState.gracePeriod,
          time_remaining: timerState.actualTimeRemaining,
          time_spent_today: Math.max(0, timerState.gracePeriod - timerState.actualTimeRemaining),
          last_reset_date: todayString,
          is_blocked: timerState.actualTimeRemaining <= 0,
          is_active: true,
          blocked_until: timerState.actualTimeRemaining <= 0 ? this.getEndOfDay() : null,
          schedule: null,
          daily_usage: {},
          total_time_spent: Math.max(0, timerState.gracePeriod - timerState.actualTimeRemaining),
          access_count: 1,
          last_accessed: now,
          created_at: now,
          updated_at: now
        };

        await this.firestore.updateBlockedSite(siteId, newSiteData);
        console.log(`Firebase Sync Service: Created new site entry for ${normalizedDomain} - ${timerState.actualTimeRemaining}s remaining`);
        return;
      }

      // Calculate time spent today
      const timeSpentToday = Math.max(0, timerState.gracePeriod - timerState.actualTimeRemaining);
      
      // Update site data with current timer state
      const updatedSiteData = {
        ...existingSite,
        time_remaining: timerState.actualTimeRemaining,
        time_spent_today: timeSpentToday,
        last_accessed: now,
        updated_at: now
      };

      // If timer has reached zero, mark as blocked
      if (timerState.actualTimeRemaining <= 0) {
        updatedSiteData.is_blocked = true;
        updatedSiteData.blocked_until = this.getEndOfDay();
      }

      await this.firestore.updateBlockedSite(siteId, updatedSiteData);
      
      console.log(`Firebase Sync Service: Synced ${normalizedDomain} - ${timerState.actualTimeRemaining}s remaining`);

    } catch (error) {
      console.error(`Firebase Sync Service: Error syncing ${normalizedDomain}:`, error);
    } finally {
      this.pendingSyncs.delete(siteId);
    }
  }

  // Normalize domain by removing www prefix
  normalizeDomain(domain) {
    if (!domain) return domain;
    return domain.replace(/^www\./, '').toLowerCase();
  }

  // Sync specific domain immediately (for event-based syncing) with better error handling
  async syncDomainImmediately(domain, timeRemaining, gracePeriod) {
    try {
      // Skip if too many consecutive errors
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        console.log('Firebase Sync Service: Skipping immediate sync due to too many consecutive errors');
        return false;
      }

      // Normalize domain to ensure consistency
      const normalizedDomain = this.normalizeDomain(domain);
      console.log(`Firebase Sync Service: Normalized domain from "${domain}" to "${normalizedDomain}"`);
      
      // Try multiple ways to get the authenticated user (be more lenient)
      let user = null;
      try {
        user = this.auth.getCurrentUser();
      } catch (error) {
        console.log('Firebase Sync Service: getCurrentUser failed for immediate sync, trying stored auth data');
      }
      
      // If getCurrentUser doesn't work, try getting stored auth data
      if (!user) {
        try {
          const storedUser = await this.auth.getStoredAuthData();
          if (storedUser) {
            user = storedUser;
            console.log('Firebase Sync Service: Using stored auth data for immediate sync');
          }
        } catch (error) {
          console.log('Firebase Sync Service: getStoredAuthData failed for immediate sync');
        }
      }
      
      if (!user) {
        console.log('Firebase Sync Service: No authenticated user for immediate sync - working offline');
        return false;
      }
      
      console.log('Firebase Sync Service: User authenticated for immediate sync:', user.uid || user.id);

      const userId = user.uid || user.id;
      if (!userId) {
        console.warn('Firebase Sync Service: User object has no uid or id field, but continuing');
        return false;
      }

      const siteId = `${userId}_${normalizedDomain}`;
      const now = new Date();
      
      // Get existing site data
      const existingSite = await this.firestore.getBlockedSite(siteId);
      console.log('existingSite', existingSite);
      if (!existingSite) {
        console.log(`Firebase Sync Service: Site ${normalizedDomain} not found in Firestore, creating new entry for sync`);
        // Create a new site entry if it doesn't exist
        const todayString = this.getTodayString();
        const newSiteData = {
          user_id: userId,
          url: normalizedDomain,
          name: normalizedDomain,
          time_limit: gracePeriod,
          time_remaining: timeRemaining,
          time_spent_today: Math.max(0, gracePeriod - timeRemaining),
          last_reset_date: todayString,
          is_blocked: timeRemaining <= 0,
          is_active: true,
          blocked_until: timeRemaining <= 0 ? this.getEndOfDay() : null,
          schedule: null,
          daily_usage: {},
          total_time_spent: Math.max(0, gracePeriod - timeRemaining),
          access_count: 1,
          last_accessed: now,
          created_at: now,
          updated_at: now,
          override_active: false // Ensure new sites don't have override_active set
        };

        await this.firestore.updateBlockedSite(siteId, newSiteData);
        console.log(`Firebase Sync Service: Created new site entry for ${normalizedDomain} - ${timeRemaining}s remaining`);
        
        // Reset error count on successful sync
        this.consecutiveErrors = 0;
        return true;
      }

      // Calculate time spent today
      const timeSpentToday = Math.max(0, gracePeriod - timeRemaining);
      console.log('timeSpentToday', timeSpentToday);
      console.log('timeRemaining', timeRemaining);
      console.log('gracePeriod', gracePeriod);
      // Update site data
      const updatedSiteData = {
        ...existingSite,
        time_remaining: timeRemaining,
        time_spent_today: timeSpentToday,
        last_accessed: now,
        updated_at: now
      };

      // If timer has reached zero, mark as blocked
      if (timeRemaining <= 0) {
        updatedSiteData.is_blocked = true;
        updatedSiteData.blocked_until = this.getEndOfDay();
      }

      await this.firestore.updateBlockedSite(siteId, updatedSiteData);
      
      console.log(`Firebase Sync Service: Immediate sync completed for ${normalizedDomain} - ${timeRemaining}s remaining`);
      
      // Reset error count on successful sync
      this.consecutiveErrors = 0;
      return true;

    } catch (error) {
      console.error(`Firebase Sync Service: Error in immediate sync for ${normalizedDomain}:`, error);
      this.handleSyncError(error);
      return false;
    }
  }

  // Get end of day timestamp
  getEndOfDay() {
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    return endOfDay;
  }

  // Get today's date string
  getTodayString() {
    const today = new Date();
    return today.getFullYear() + '-' + 
           String(today.getMonth() + 1).padStart(2, '0') + '-' + 
           String(today.getDate()).padStart(2, '0');
  }

  // Check authentication status for debugging
  async checkAuthStatus() {
    console.log('Firebase Sync Service: Checking authentication status...');
    
    const currentUser = this.auth.getCurrentUser();
    console.log('Firebase Sync Service: getCurrentUser() result:', currentUser);
    
    const storedUser = await this.auth.getStoredAuthData();
    console.log('Firebase Sync Service: getStoredAuthData() result:', storedUser);
    
    return {
      currentUser,
      storedUser,
      hasAuth: !!currentUser || !!storedUser
    };
  }

  // Cleanup method
  destroy() {
    this.stopPeriodicSync();
    this.pendingSyncs.clear();
    console.log('Firebase Sync Service: Destroyed');
  }
}

// Export for use in other scripts - Chrome extension compatible
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FirebaseSyncService };
}

// Make FirebaseSyncService available globally for Chrome extension context
if (typeof window !== 'undefined') {
  window.FirebaseSyncService = FirebaseSyncService;
} else if (typeof self !== 'undefined') {
  // For service workers
  self.FirebaseSyncService = FirebaseSyncService;
}