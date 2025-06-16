// Firebase Sync Service
// Handles syncing of timer states and blocked site data to Firebase

class FirebaseSyncService {
  constructor(firestore, auth) {
    this.firestore = firestore;
    this.auth = auth;
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
    } catch (error) {
      console.error('Firebase Sync Service: Initialization failed:', error);
      this.isInitializationFailed = true;
      this.handleInitializationError(error);
    }
  }

  // Handle initialization errors
  handleInitializationError(error) {
    console.warn('Firebase Sync Service: Working in degraded mode due to initialization failure');
    this.showUserNotification('Firebase sync is temporarily unavailable. Your data will be saved locally.');
  }

  // Show user notification
  showUserNotification(message, isError = false) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'displayNotification',
          message: message,
          isError: isError,
          source: 'firebase-sync'
        }).catch(() => {
          console.log('Firebase Sync Service: Could not show notification');
        });
      }
    } catch (error) {
      console.log('Firebase Sync Service: Unable to show notification:', message);
    }
  }

  // Sync timer state to Realtime Database
  async syncTimerStateToRealtimeDB(userId, timerState) {
    try {
      const realtimeDB = chrome.extension.getBackgroundPage()?.realtimeDB;
      if (!realtimeDB) {
        throw new Error('Realtime Database not available');
      }
      const normalizedDomain = this.normalizeDomain(timerState.domain);
      const formattedDomain = realtimeDB.formatDomainForFirebase(normalizedDomain);
      const siteId = `${userId}_${formattedDomain}`;

      const now = new Date();
      const siteData = {
        user_id: userId,
        url: normalizedDomain,
        time_remaining: timerState.actualTimeRemaining,
        time_limit: timerState.gracePeriod,
        is_active: true,
        override_active: false,
        is_blocked: timerState.actualTimeRemaining <= 0,
        last_accessed: now.toISOString(),
        updated_at: now.toISOString(),
        last_reset_date: this.getTodayString(),
        last_reset_timestamp: timerState.lastResetTimestamp || 0,
        last_sync_timestamp: Date.now()
      };

      // If timer has reached zero, mark as blocked
      if (timerState.actualTimeRemaining <= 0) {
        siteData.is_blocked = true;
        siteData.blocked_until = new Date(now.setHours(23, 59, 59, 999)).toISOString();
      }

      await realtimeDB.addBlockedSite(siteId, siteData);
      return true;
    } catch (error) {
      console.error('Firebase Sync Service: Realtime DB sync error:', error);
      throw error;
    }
  }

  // Get today's date string in YYYY-MM-DD format
  getTodayString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  // Handle sync errors with progressive error tracking
  handleSyncError(error) {
    this.consecutiveErrors++;
    console.warn(`Firebase Sync Service: Consecutive errors: ${this.consecutiveErrors}`);

    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.showUserNotification(
        'Limitter is experiencing sync issues. Please try reinstalling the extension.',
        true
      );
    } else if (this.consecutiveErrors >= 3) {
      this.showUserNotification(
        'Limitter sync is temporarily unavailable. Your data will be saved locally.',
        false
      );
    }
  }

  // Check authentication status
  async checkAuthStatus() {
    try {
      const user = this.auth.getCurrentUser();
      return {
        isAuthenticated: !!user,
        userId: user?.uid,
        hasValidToken: !!user?.idToken,
        lastTokenRefresh: user?.tokenTimestamp
      };
    } catch (error) {
      console.error('Firebase Sync Service: Auth status check error:', error);
      return {
        isAuthenticated: false,
        error: error.message
      };
    }
  }

  // Normalize domain for consistency
  normalizeDomain(domain) {
    return domain.replace(/^www\./, '').toLowerCase();
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