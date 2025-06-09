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
  }

  // Initialize the sync service
  init() {
    console.log('Firebase Sync Service: Initializing...');
    this.startPeriodicSync();
  }

  // Start periodic sync every 10 seconds
  startPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
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

  // Perform periodic sync of all timer states
  async performPeriodicSync() {
    try {
      // Try multiple ways to get the authenticated user
      let user = this.auth.getCurrentUser();
      
      // If getCurrentUser doesn't work, try getting stored auth data
      if (!user) {
        const storedUser = await this.auth.getStoredAuthData();
        if (storedUser) {
          user = storedUser;
        }
      }
      
      if (!user) {
        console.log('Firebase Sync Service: No authenticated user, skipping periodic sync');
        return;
      }

      // Get all timer states from Chrome storage
      const timerStates = await this.getAllTimerStates();
      
      if (timerStates.length === 0) {
        console.log('Firebase Sync Service: No active timer states to sync');
        return;
      }

      console.log(`Firebase Sync Service: Syncing ${timerStates.length} timer states...`);

      // Sync each timer state to Firestore
      const syncPromises = timerStates.map(state => 
        this.syncTimerStateToFirestore(user.uid, state)
      );

      await Promise.allSettled(syncPromises);
      
      this.lastSyncTime = Date.now();
      console.log('Firebase Sync Service: Periodic sync completed');

    } catch (error) {
      console.error('Firebase Sync Service: Error during periodic sync:', error);
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

  // Sync specific domain immediately (for event-based syncing)
  async syncDomainImmediately(domain, timeRemaining, gracePeriod, clearOverrideActive = false) {
    try {
      // Normalize domain to ensure consistency
      const normalizedDomain = this.normalizeDomain(domain);
      console.log(`Firebase Sync Service: Normalized domain from "${domain}" to "${normalizedDomain}"`);
      
      // Try multiple ways to get the authenticated user
      let user = this.auth.getCurrentUser();
      
      // If getCurrentUser doesn't work, try getting stored auth data
      if (!user) {
        const storedUser = await this.auth.getStoredAuthData();
        if (storedUser) {
          user = storedUser;
          console.log('Firebase Sync Service: Using stored auth data for sync');
        }
      }
      
      if (!user) {
        console.log('Firebase Sync Service: No authenticated user for immediate sync');
        console.log('Firebase Sync Service: Auth instance:', this.auth);
        console.log('Firebase Sync Service: Stored auth check failed');
        return;
      }
      
      console.log('Firebase Sync Service: User authenticated for sync:', user.uid || user.id);

      const userId = user.uid || user.id;
      if (!userId) {
        console.error('Firebase Sync Service: User object has no uid or id field:', user);
        return;
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
        return;
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

      // Clear override_active flag if requested
      if (clearOverrideActive) {
        updatedSiteData.override_active = false;
        console.log(`Firebase Sync Service: Cleared override_active flag for ${normalizedDomain}`);
      }

      // If timer has reached zero, mark as blocked
      if (timeRemaining <= 0) {
        updatedSiteData.is_blocked = true;
        updatedSiteData.blocked_until = this.getEndOfDay();
      }

      await this.firestore.updateBlockedSite(siteId, updatedSiteData);
      
      console.log(`Firebase Sync Service: Immediate sync completed for ${normalizedDomain} - ${timeRemaining}s remaining`);

    } catch (error) {
      console.error(`Firebase Sync Service: Error in immediate sync for ${normalizedDomain}:`, error);
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