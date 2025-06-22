// Firebase Configuration
import { DeviceFingerprint } from './device-fingerprint.js';
import { FIREBASE_SECRET_CONFIG } from './firebase.config.secret.js';

export const FIREBASE_CONFIG = FIREBASE_SECRET_CONFIG;

// Firebase API endpoints
export const FIREBASE_AUTH_BASE_URL = "https://identitytoolkit.googleapis.com/v1/accounts";
export const FIREBASE_FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;
export const FIREBASE_REALTIME_DB_URL = FIREBASE_CONFIG.databaseURL;

// Firebase Authentication class
export class FirebaseAuth {
  constructor(config) {
    this.config = config;
    this.apiKey = config.apiKey;
    this.currentUser = null;
    this.deviceFingerprint = new DeviceFingerprint();
    this.deviceListener = null;
    this.failedAuthAttempts = 0;
    this.tokenRefreshInterval = null;
    this.TOKEN_REFRESH_INTERVAL = 45 * 60 * 1000; // 45 minutes
  }

  // Reset failed attempts counter
  resetFailedAttempts() {
    this.failedAuthAttempts = 0;
  }

  // Increment failed attempts and check if max reached
  incrementFailedAttempts() {
    this.failedAuthAttempts++;
    return this.failedAuthAttempts >= 3;
  }

  // Start token refresh interval
  startTokenRefresh() {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
    }
    
    this.tokenRefreshInterval = setInterval(async () => {
      await this.refreshAuthToken();
    }, this.TOKEN_REFRESH_INTERVAL);
  }

  // Stop token refresh interval
  stopTokenRefresh() {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
      this.tokenRefreshInterval = null;
    }
  }

  async saveDeviceToRealtimeDb(userId) {
    try {
      if (!this.currentUser || !this.currentUser.idToken) {
        throw new Error('No authentication token available');
      }

      // Get current device info
      const deviceInfo = await this.deviceFingerprint.getDeviceInfo();
      
      // First check if this specific device ID exists for this user
      const deviceCheckResponse = await fetch(
        `${FIREBASE_REALTIME_DB_URL}/users/${userId}/devices/${deviceInfo.device_id}.json?auth=${this.currentUser.idToken}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      if (!deviceCheckResponse.ok) {
        if (deviceCheckResponse.status === 401) {
          // Try refreshing the token
          await this.refreshAuthToken();
          // Retry the request with new token
          return this.saveDeviceToRealtimeDb(userId);
        }
        throw new Error('Failed to check device existence');
      }

      const existingDevice = await deviceCheckResponse.json();
      if (existingDevice) {
        console.log('Device already registered:', deviceInfo.device_id);
        // Update last seen timestamp
        const updateResponse = await fetch(
          `${FIREBASE_REALTIME_DB_URL}/users/${userId}/devices/${deviceInfo.device_id}.json?auth=${this.currentUser.idToken}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              last_seen: Date.now()
            })
          }
        );

        if (!updateResponse.ok) {
          throw new Error('Failed to update device last seen timestamp');
        }

        return existingDevice;
      }

      // If device doesn't exist, proceed with normal save
      const canAddDevice = await this.canAddDevice(userId);
      if (!canAddDevice.allowed) {
        throw new Error(canAddDevice.message);
      }

      // Store both device IDs consistently
      await new Promise(resolve => {
        chrome.storage.local.set({
          current_device_id: deviceInfo.device_id,
          device_id: deviceInfo.device_id,
          device_id_timestamp: Date.now()
        }, resolve);
      });

      // Add additional device metadata
      deviceInfo.last_seen = Date.now();
      deviceInfo.first_registered = Date.now();
      deviceInfo.user_id = userId;

      const response = await fetch(
        `${FIREBASE_REALTIME_DB_URL}/users/${userId}/devices/${deviceInfo.device_id}.json?auth=${this.currentUser.idToken}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(deviceInfo)
        }
      );

      if (!response.ok) {
        throw new Error('Failed to save device info');
      }

      console.log('Device saved successfully:', deviceInfo);
      return deviceInfo;
    } catch (error) {
      console.error('Error saving device to Realtime DB:', error);
      throw error;
    }
  }

  async canAddDevice(userId) {
    try {
      if (!this.currentUser || !this.currentUser.idToken) {
        throw new Error('No authentication token available');
      }

      // Get user's subscription plan
      const userDoc = await fetch(
        `${FIREBASE_FIRESTORE_BASE_URL}/users/${userId}`,
        {
          method: 'GET',
          headers: this.getAuthHeaders()
        }
      );

      if (!userDoc.ok) {
        throw new Error('Failed to fetch user data');
      }

      const userData = await userDoc.json();
      console.log('User data:', userData);
      const userPlan = userData.fields?.plan?.stringValue || 'free';

      // Get device limits based on plan
      const deviceLimits = {
        'free': 1,
        'pro': 3,
        'elite': 10
      };

      const maxDevices = deviceLimits[userPlan] || 1;

      // Get all devices for this user
      const devicesResponse = await fetch(
        `${FIREBASE_REALTIME_DB_URL}/users/${userId}/devices.json?auth=${this.currentUser.idToken}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      if (!devicesResponse.ok) {
        if (devicesResponse.status === 401) {
          // Try refreshing the token
          await this.refreshAuthToken();
          // Retry the request
          return this.canAddDevice(userId);
        }
        throw new Error('Failed to fetch devices');
      }

      const devices = await devicesResponse.json() || {};
      const currentDeviceCount = Object.keys(devices).length;

      // Check if user can add more devices
      if (currentDeviceCount >= maxDevices) {
        return {
          allowed: false,
          message: `Device limit reached for ${userPlan} plan (${currentDeviceCount}/${maxDevices}). Please upgrade your plan or remove a device.`,
          currentCount: currentDeviceCount,
          maxDevices: maxDevices,
          plan: userPlan, 
          devices: devices
        };
      }

      return {
        allowed: true,
        currentCount: currentDeviceCount,
        maxDevices: maxDevices,
        plan: userPlan,
        devices: devices
      };
    } catch (error) {
      console.error('Error checking device limit:', error);
      throw error;
    }
  }

  getAuthHeaders() {
    if (!this.currentUser || !this.currentUser.idToken) {
      throw new Error('No authentication token available');
    }
    return {
      'Authorization': `Bearer ${this.currentUser.idToken}`,
      'Content-Type': 'application/json',
    };
  }

  async isDeviceTracked(userId) {
    try {
      // Get current device info
      const deviceInfo = await this.deviceFingerprint.getDeviceInfo();
      const deviceId = deviceInfo.device_id;

      // Try up to 3 times with a delay between attempts
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // Check if device exists in realtime db
          const response = await fetch(
            `${FIREBASE_REALTIME_DB_URL}/users/${userId}/devices/${deviceId}.json?auth=${this.currentUser.idToken}`,
            {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
              }
            }
          );

          if (!response.ok) {
            throw new Error('Failed to check device tracking status');
          }

          const data = await response.json();
          const isTracked = data !== null;
          console.log('Device tracking status:', { deviceId, isTracked, attempt });
          
          if (isTracked) {
            return true;
          }
          
          // If not tracked and not last attempt, wait before retrying
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (error) {
          console.warn(`Device tracking check attempt ${attempt} failed:`, error);
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          } else {
            throw error;
          }
        }
      }
      
      return false;
    } catch (error) {
      console.error('Error checking device tracking status:', error);
      return false;
    }
  }

  async removeDeviceFromRealtimeDb(userId, deviceId) {
    try {
      const response = await fetch(
        `${FIREBASE_REALTIME_DB_URL}/users/${userId}/devices/${deviceId}.json?auth=${this.currentUser.idToken}`,
        {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to remove device info');
      }

      return true;
    } catch (error) {
      console.error('Error removing device from Realtime DB:', error);
      throw error;
    }
  }

  listenToDeviceChanges(userId) {
    if (this.deviceListener) {
      this.deviceListener.close();
      this.deviceListener = null;
    }

    const url = `${FIREBASE_REALTIME_DB_URL}/users/${userId}/devices.json`;
    this.deviceListener = new EventSource(`${url}?auth=${this.currentUser.idToken}`);

    this.deviceListener.addEventListener('open', () => {
      console.log('Device listener connection established');
      this.lastConnectionTime = Date.now();
      this.isConnected = true;
    });

    this.deviceListener.addEventListener('put', async (event) => {
      this.lastConnectionTime = Date.now(); // Update last activity time
      const data = JSON.parse(event.data);
      console.log('Device change detected:', data);

      const deviceInfo = await this.deviceFingerprint.getDeviceInfo();
      const deviceLimitCheck = await this.canAddDevice(userId);
      
      if (data.path === `/${deviceInfo.device_id}` && data.data === null) {
        chrome.notifications.create('device-removed', {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Device Removed',
          message: 'This device has been removed. Logging out...',
          priority: 2,
          requireInteraction: true
        });

        // Clear both storages immediately on device removal
        await Promise.all([
          new Promise(r => chrome.storage.local.clear(r)),
          new Promise(r => chrome.storage.sync.clear(r))
        ]);

        await this.signOut();
        
        // First notify background script to reset state
        await chrome.runtime.sendMessage({
          action: 'resetBackgroundState'
        }).catch(() => {
          // Background script might be restarting, which is fine
        });

        // Then notify popup to show unauthenticated state
        chrome.runtime.sendMessage({
          action: 'forceLogout',
          message: 'This device has been removed from your account.'
        }).catch(() => {
          // Popup might not be open, which is fine
        });

        // Finally notify all tabs
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
              action: 'forceLogout',
              message: 'This device has been removed from your account.'
            }).catch(err => console.log('Tab might not be ready:', err));
          });
        });
      } 
      else if (data.data && data.path !== '/') {
        let deviceId = data.path.replace('/', '');
        deviceId = deviceId.split('/')[0];
        if (deviceId !== deviceInfo.device_id) {
          chrome.notifications.create('new-device-added', {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: `${data.data?.device_name ? 'New Device Added': `Device Info Changed`} `,
            requireInteraction: true,
            eventTime: Date.now(),
            message: `${data.data?.device_name ? `A new device "${data.data.device_name}" has been added to your account. (${deviceLimitCheck.currentCount}/${deviceLimitCheck.maxDevices} devices)`: `Device info has been updated`}`,
            priority: 2
          }, () => {
          });
        }
      }
    });

    // // Listen for specific device changes
    // this.deviceListener.addEventListener('patch', (event) => {

    //   this.lastConnectionTime = Date.now(); // Update last activity time
    //   const data = JSON.parse(event.data);
    //   console.log('Device patch detected:', data);
      
    //   chrome.notifications.create('device-updated', {
    //     type: 'basic',
    //     iconUrl: 'icons/icon128.png',
    //     title: 'Device Updated',
    //     message: 'Device information has been updated.',
    //     priority: 1
    //   });
    // });

    // // Handle connection errors
    this.deviceListener.onerror = (error) => {
      console.error('Device listener error:', error);
      this.isConnected = false;
      
      // Close the existing connection
      if (this.deviceListener) {
        this.deviceListener.close();
        this.deviceListener = null;
      }

      // Try to reconnect if token expired
      if (this.currentUser) {
        this.refreshAuthToken(this.currentUser.refreshToken)
          .then(() => {
            // Restart listener with new token
            this.listenToDeviceChanges(userId);
          })
          .catch((refreshError) => {
            console.error('Failed to refresh token for device listener:', refreshError);
            chrome.notifications.create('device-listener-error', {
              type: 'basic',
              iconUrl: 'icons/icon128.png',
              title: 'Connection Error',
              message: 'Lost connection to device tracking. Attempting to reconnect...',
              priority: 1
            });
          });
      }
    };
  }

  isDeviceListenerActive() {
    if (!this.deviceListener) return false;
    
    // Check if we have a recent connection (within last 10 seconds)
    const isRecentlyActive = Date.now() - (this.lastConnectionTime || 0) < 10000;
    
    // Check if connection is open and we've received activity recently
    return this.isConnected && isRecentlyActive && this.deviceListener.readyState === EventSource.OPEN;
  }

  // Authenticate user with email and password with better error handling
  async signInWithEmailAndPassword(email, password) {
    const url = `${FIREBASE_AUTH_BASE_URL}:signInWithPassword?key=${this.apiKey}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email,
          password: password,
          returnSecureToken: true,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        console.warn("Firebase sign in failed:", data.error?.message);
        
        // Increment failed attempts and check if max reached
        if (this.incrementFailedAttempts()) {
          // Force logout after 3 failed attempts
          await this.handleForceLogout();
          throw new Error("Maximum login attempts reached. Please try again later.");
        }
        
        throw new Error(data.error?.message || "Login failed");
      }

      // Reset failed attempts on successful login
      this.resetFailedAttempts();

      this.currentUser = {
        uid: data.localId,
        email: data.email,
        idToken: data.idToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
      };

      try {
        // First store auth data
        await this.storeAuthData(this.currentUser);
        
        // Then save device info and wait for it to complete
        await this.saveDeviceToRealtimeDb(this.currentUser.uid);
        
        // Start listening for device changes
        this.listenToDeviceChanges(this.currentUser.uid);
        
        // Add a small delay to ensure the device info is properly saved
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Verify device was properly saved
        const isTracked = await this.isDeviceTracked(this.currentUser.uid);
        if (!isTracked) {
          throw new Error('Failed to save device info');
        }
      } catch (storageError) {
        console.warn(
          "Firebase auth: Failed to store auth data or save device:",
          storageError
        );
        // Force logout if device tracking failed
        await this.signOut();
        throw new Error(storageError);
      }

      return this.currentUser;
    } catch (error) {
      throw error;
    }
  }

  // Store user authentication data in Chrome storage
  async storeAuthData(userData) {
    return new Promise((resolve) => {
      const authData = {
        firebaseUser: userData,
        authTimestamp: Date.now(),
        isExplicitLogout: false,
        lastTokenRefresh: Date.now()
      };
      
      // Store in both local and sync storage for persistence
      Promise.all([
        new Promise(r => chrome.storage.local.set(authData, r)),
        new Promise(r => chrome.storage.sync.set(authData, r))
      ]).then(() => resolve());
    });
  }

  // Retrieve stored authentication data with token refresh check
  async getStoredAuthData() {
    return new Promise((resolve) => {
      // Try local storage first, then sync storage as backup
      chrome.storage.local.get(["firebaseUser", "authTimestamp", "isExplicitLogout", "lastTokenRefresh"], async (localResult) => {
        try {
          if (localResult.firebaseUser && !localResult.isExplicitLogout) {
            // Check if token needs refresh (if last refresh was more than 45 minutes ago)
            const now = Date.now();
            const lastRefresh = localResult.lastTokenRefresh || 0;
            const timeSinceLastRefresh = now - lastRefresh;

            // Set current user first to enable API calls
            this.currentUser = localResult.firebaseUser;

            // If token is older than 45 minutes or no lastTokenRefresh, try to refresh
            if (timeSinceLastRefresh > this.TOKEN_REFRESH_INTERVAL || !lastRefresh) {
              try {
                console.log('Token needs refresh, attempting refresh...');
                const refreshedUser = await this.refreshAuthToken();
                if (refreshedUser) {
                  this.startTokenRefresh(); // Start refresh interval
                  resolve(refreshedUser);
                  return;
                }
              } catch (error) {
                console.warn('Token refresh failed during auth restore:', error);
                // Don't immediately fail - try sync storage or continue with current token
              }
            }

            // If token is still valid or refresh failed but token might still work
            if (timeSinceLastRefresh <= this.TOKEN_REFRESH_INTERVAL || this.currentUser.idToken) {
              this.startTokenRefresh(); // Start refresh interval
              resolve(this.currentUser);
              return;
            }
          }

          // Try sync storage if local storage is empty or token refresh failed
          chrome.storage.sync.get(["firebaseUser", "authTimestamp", "isExplicitLogout", "lastTokenRefresh"], async (syncResult) => {
            if (syncResult.firebaseUser && !syncResult.isExplicitLogout) {
              const now = Date.now();
              const lastRefresh = syncResult.lastTokenRefresh || 0;
              const timeSinceLastRefresh = now - lastRefresh;

              // Set current user to enable API calls
              this.currentUser = syncResult.firebaseUser;

              // If token is older than 45 minutes or no lastTokenRefresh, try to refresh
              if (timeSinceLastRefresh > this.TOKEN_REFRESH_INTERVAL || !lastRefresh) {
                try {
                  console.log('Token needs refresh (sync storage), attempting refresh...');
                  const refreshedUser = await this.refreshAuthToken();
                  if (refreshedUser) {
                    // Restore to local storage
                    await new Promise(r => chrome.storage.local.set({
                      firebaseUser: refreshedUser,
                      authTimestamp: Date.now(),
                      isExplicitLogout: false,
                      lastTokenRefresh: Date.now()
                    }, r));
                    this.startTokenRefresh(); // Start refresh interval
                    resolve(refreshedUser);
                    return;
                  }
                } catch (error) {
                  console.warn('Token refresh failed during auth restore from sync:', error);
                }
              }

              // If token is still valid or we couldn't refresh but token might work
              if (timeSinceLastRefresh <= this.TOKEN_REFRESH_INTERVAL || this.currentUser.idToken) {
                // Restore to local storage
                await new Promise(r => chrome.storage.local.set({
                  firebaseUser: this.currentUser,
                  authTimestamp: syncResult.authTimestamp,
                  isExplicitLogout: false,
                  lastTokenRefresh: syncResult.lastTokenRefresh
                }, r));
                this.startTokenRefresh(); // Start refresh interval
                resolve(this.currentUser);
                return;
              }
            }
            
            // If we get here, we couldn't restore auth from either storage
            this.currentUser = null;
            resolve(null);
          });
        } catch (error) {
          console.error('Error during auth data retrieval:', error);
          this.currentUser = null;
          resolve(null);
        }
      });
    });
  }

  // Clear auth data only during explicit logout
  async clearAuthData() {
    console.log("clearAuthData")
    return new Promise((resolve) => {
      const clearData = {
        firebaseUser: null,
        authTimestamp: null,
        isExplicitLogout: true
      };
      
      Promise.all([
        new Promise(r => chrome.storage.local.set(clearData, r)),
        new Promise(r => chrome.storage.sync.set(clearData, r))
      ]).then(() => resolve());
    });
  }

  // Sign out current user
  async signOut() {
    try {
      this.stopTokenRefresh(); // Stop token refresh interval
      if (this.deviceListener) {
        this.deviceListener.close();
        this.deviceListener = null;
      }

      if (this.currentUser) {
        // Get the device ID from storage
        const result = await new Promise((resolve) => {
          chrome.storage.local.get(['current_device_id', 'device_id'], resolve);
        });

        const deviceId = result.current_device_id || result.device_id;
        if (deviceId) {
          await this.removeDeviceFromRealtimeDb(this.currentUser.uid, deviceId);
          // Clear device IDs from storage
          await new Promise(resolve => {
            chrome.storage.local.remove(['current_device_id', 'device_id', 'device_id_timestamp'], resolve);
          });
        }
      }
    } catch (error) {
      console.warn('Error during sign out:', error);
    }

    this.currentUser = null;
    // Only clear auth data, not entire storage
    return this.clearAuthData();
  }

  // Handle force logout (e.g., device removed)
  async handleForceLogout() {
    try {
      this.stopTokenRefresh(); // Stop token refresh interval
      if (this.deviceListener) {
        this.deviceListener.close();
        this.deviceListener = null;
      }

      if (this.currentUser) {
        await this.removeDeviceFromRealtimeDb(this.currentUser.uid, this.currentUser.uid);
      }
    } catch (error) {
      console.warn('Error during force logout:', error);
    }

    this.currentUser = null;
    // Only clear auth data, not entire storage
    return this.clearAuthData();
  }

  // Check if user is signed in
  isSignedIn() {
    return this.currentUser !== null;
  }

  // Get current authenticated user
  getCurrentUser() {
    return this.currentUser;
  }

  // Refresh expired authentication token
  async refreshAuthToken() {
    try {
      if (!this.currentUser?.refreshToken) {
        console.warn('No refresh token available');
        return null;
      }

      const url = `${FIREBASE_AUTH_BASE_URL}:token?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: this.currentUser.refreshToken,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Only throw if it's a critical error
        if (response.status === 400 || response.status === 401) {
          throw new Error(data.error?.message || 'Token refresh failed');
        }
        // For other errors, log warning but don't throw
        console.warn('Non-critical token refresh error:', data.error?.message);
        return null;
      }

      // Update current user with new tokens
      this.currentUser = {
        ...this.currentUser,
        idToken: data.id_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
      };

      // Store updated auth data
      await this.storeAuthData(this.currentUser);
      
      return this.currentUser;
    } catch (error) {
      console.error('Token refresh failed:', error);
      // Only force logout for critical auth errors
      if (error.message.includes('TOKEN_EXPIRED') || 
          error.message.includes('USER_NOT_FOUND') ||
          error.message.includes('INVALID_REFRESH_TOKEN')) {
        await this.handleForceLogout();
      }
      throw error;
    }
  }
}

// Firebase Firestore class
export class FirebaseFirestore {
  constructor(config, authInstance) {
    this.config = config;
    this.auth = authInstance;
    this.baseUrl = FIREBASE_FIRESTORE_BASE_URL;
  }

  // Generate authorization headers for API requests with better error handling
  getAuthHeaders() {
    try {
      const user = this.auth.getCurrentUser();
      if (!user || !user.idToken) {
        console.warn("Firestore: User not authenticated for API request");
        throw new Error("User not authenticated");
      }

      return {
        Authorization: `Bearer ${user.idToken}`,
        "Content-Type": "application/json",
      };
    } catch (error) {
      console.warn("Firestore: Error generating auth headers:", error);
      throw error;
    }
  }

  // Convert Firestore document format to plain JavaScript object
  convertFirestoreDoc(doc) {
    if (!doc.fields) return {};

    const result = {};
    for (const [key, value] of Object.entries(doc.fields)) {
      if (value.stringValue !== undefined) {
        result[key] = value.stringValue;
      } else if (value.integerValue !== undefined) {
        result[key] = parseInt(value.integerValue);
      } else if (value.doubleValue !== undefined) {
        result[key] = parseFloat(value.doubleValue);
      } else if (value.booleanValue !== undefined) {
        result[key] = value.booleanValue;
      } else if (value.timestampValue !== undefined) {
        result[key] = new Date(value.timestampValue);
      } else if (value.nullValue !== undefined) {
        result[key] = null;
      } else if (value.mapValue && value.mapValue.fields) {
        result[key] = this.convertFirestoreDoc({
          fields: value.mapValue.fields,
        });
      }
    }
    return result;
  }

  // Fetch user profile from Firestore
  async getUserProfile(userId) {
    try {
      console.log(`Fetching user profile for userId: ${userId}`);
      console.log(`Request URL: ${this.baseUrl}/users/${userId}`);

      const response = await fetch(`${this.baseUrl}/users/${userId}`, {
        method: "GET",
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log("User profile not found (404)");
          return null;
        }
        const errorText = await response.text();
        console.error(`HTTP Error ${response.status}: ${errorText}`);
        throw new Error(
          `Failed to fetch user profile: ${response.status} - ${errorText}`
        );
      }

      const data = await response.json();
      return this.convertFirestoreDoc(data);
    } catch (error) {
      console.error("Get user profile error:", error);
      if (
        error.name === "TypeError" &&
        error.message.includes("Failed to fetch")
      ) {
        console.error(
          "Network error - check internet connection and CORS permissions"
        );
        throw new Error(
          "Network error: Unable to connect to Firebase. Please check your internet connection."
        );
      }
      throw error;
    }
  }

  // Retrieve user's blocked sites from Firestore
  async getUserBlockedSites(userId) {
    try {
      const response = await fetch(`${this.baseUrl}:runQuery`, {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "blocked_sites" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "user_id" },
                op: "EQUAL",
                value: { stringValue: userId },
              },
            },
            orderBy: [
              {
                field: { fieldPath: "created_at" },
                direction: "DESCENDING",
              },
            ],
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch blocked sites: ${response.status}`);
      }

      const data = await response.json();
      const sites = [];

      if (data.length) {
        for (const item of data) {
          if (item.document) {
            sites.push(this.convertFirestoreDoc(item.document));
          }
        }
      }

      return sites;
    } catch (error) {
      console.error("Get blocked sites error:", error);
      throw error;
    }
  }

  // Create or update user profile in Firestore
  async updateUserProfile(userId, profileData) {
    try {
      const firestoreData = {};

      for (const [key, value] of Object.entries(profileData)) {
        if (typeof value === "string") {
          firestoreData[key] = { stringValue: value };
        } else if (typeof value === "number") {
          if (Number.isInteger(value)) {
            firestoreData[key] = { integerValue: value.toString() };
          } else {
            firestoreData[key] = { doubleValue: value };
          }
        } else if (typeof value === "boolean") {
          firestoreData[key] = { booleanValue: value };
        } else if (value instanceof Date) {
          firestoreData[key] = { timestampValue: value.toISOString() };
        } else if (value === null) {
          firestoreData[key] = { nullValue: null };
        }
      }

      const response = await fetch(`${this.baseUrl}/users/${userId}`, {
        method: "PATCH",
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          fields: firestoreData,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to update user profile: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error("Update user profile error:", error);
      throw error;
    }
  }

  // Get a single blocked site from Firestore
  async getBlockedSite(siteId) {
    try {
      const response = await fetch(`${this.baseUrl}/blocked_sites/${siteId}`, {
        method: "GET",
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null; // Site doesn't exist
        }
        throw new Error(`Failed to fetch blocked site: ${response.status}`);
      }

      const data = await response.json();
      return this.convertFirestoreDoc(data);
    } catch (error) {
      console.error("Get blocked site error:", error);
      throw error;
    }
  }

  // Create or update blocked site entry in Firestore
  async updateBlockedSite(siteId, siteData, excludeFields = []) {
    try {
      // 1) Filter out any excluded keys
      const filtered = { ...siteData };
      excludeFields.forEach((f) => delete filtered[f]);

      // 2) Convert to Firestore "fields" JSON
      const firestoreData = {};
      for (const [key, value] of Object.entries(filtered)) {
        if (typeof value === "string") {
          firestoreData[key] = { stringValue: value };
        } else if (typeof value === "number") {
          if (Number.isInteger(value)) {
            firestoreData[key] = { integerValue: value.toString() };
          } else {
            firestoreData[key] = { doubleValue: value };
          }
        } else if (typeof value === "boolean") {
          firestoreData[key] = { booleanValue: value };
        } else if (value instanceof Date) {
          firestoreData[key] = { timestampValue: value.toISOString() };
        } else if (value === null) {
          firestoreData[key] = { nullValue: null };
        }
      }

      // 3) Build updateMask query params
      const fieldsToUpdate = Object.keys(firestoreData);
      const params = new URLSearchParams();
      fieldsToUpdate.forEach((f) => params.append("updateMask.fieldPaths", f));

      // 4) Fire the PATCH with both mask and body
      const url = `${
        this.baseUrl
      }/blocked_sites/${siteId}?${params.toString()}`;
      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          ...this.getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: firestoreData }),
      });

      if (!response.ok) {
        throw new Error(`Failed to update blocked site: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error("Update blocked site error:", error);
      throw error;
    }
  }

  // Get entire collection from Firestore
  async getCollection(collectionName) {
    try {
      const response = await fetch(`${this.baseUrl}:runQuery`, {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: collectionName }],
          },
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch collection ${collectionName}: ${response.status}`
        );
      }

      const data = await response.json();
      const documents = [];

      if (data.length) {
        for (const item of data) {
          if (item.document) {
            const convertedDoc = this.convertFirestoreDoc(item.document);
            // Extract document ID from the document path
            const pathParts = item.document.name.split("/");
            convertedDoc.id = pathParts[pathParts.length - 1];
            documents.push(convertedDoc);
          }
        }
      }

      return documents;
    } catch (error) {
      console.error(`Get collection ${collectionName} error:`, error);
      throw error;
    }
  }

  // Get user override data from Firestore
  async getUserOverrides(userId) {
    try {
      console.log(`Fetching user overrides for userId: ${userId}`);

      const response = await fetch(`${this.baseUrl}/user_overrides/${userId}`, {
        method: "GET",
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log("User overrides not found (404)");
          return null;
        }
        const errorText = await response.text();
        console.error(`HTTP Error ${response.status}: ${errorText}`);
        throw new Error(
          `Failed to fetch user overrides: ${response.status} - ${errorText}`
        );
      }

      const data = await response.json();
      return this.convertFirestoreDoc(data);
    } catch (error) {
      console.error("Get user overrides error:", error);
      if (
        error.name === "TypeError" &&
        error.message.includes("Failed to fetch")
      ) {
        console.error(
          "Network error - check internet connection and CORS permissions"
        );
        throw new Error(
          "Network error: Unable to connect to Firebase. Please check your internet connection."
        );
      }
      throw error;
    }
  }

  // Update user overrides data in Firestore
  async updateUserOverrides(userId, overrideData) {
    try {
      const firestoreData = {};

      for (const [key, value] of Object.entries(overrideData)) {
        if (typeof value === "string") {
          firestoreData[key] = { stringValue: value };
        } else if (typeof value === "number") {
          if (Number.isInteger(value)) {
            firestoreData[key] = { integerValue: value.toString() };
          } else {
            firestoreData[key] = { doubleValue: value };
          }
        } else if (typeof value === "boolean") {
          firestoreData[key] = { booleanValue: value };
        } else if (value instanceof Date) {
          firestoreData[key] = { timestampValue: value.toISOString() };
        } else if (value === null) {
          firestoreData[key] = { nullValue: null };
        } else if (typeof value === "object") {
          // Handle nested objects (like monthly_stats)
          firestoreData[key] = {
            mapValue: { fields: this.convertToFirestoreFields(value) },
          };
        }
      }

      const response = await fetch(`${this.baseUrl}/user_overrides/${userId}`, {
        method: "PATCH",
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          fields: firestoreData,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to update user overrides: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error("Update user overrides error:", error);
      throw error;
    }
  }

  // Create override history record in Firestore
  async createOverrideHistory(historyId, historyData) {
    try {
      const firestoreData = {};

      for (const [key, value] of Object.entries(historyData)) {
        if (typeof value === "string") {
          firestoreData[key] = { stringValue: value };
        } else if (typeof value === "number") {
          if (Number.isInteger(value)) {
            firestoreData[key] = { integerValue: value.toString() };
          } else {
            firestoreData[key] = { doubleValue: value };
          }
        } else if (typeof value === "boolean") {
          firestoreData[key] = { booleanValue: value };
        } else if (value instanceof Date) {
          firestoreData[key] = { timestampValue: value.toISOString() };
        } else if (value === null) {
          firestoreData[key] = { nullValue: null };
        }
      }

      const response = await fetch(
        `${this.baseUrl}/override_history?documentId=${historyId}`,
        {
          method: "POST",
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            fields: firestoreData,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(
          `Failed to create override history: ${response.status}`
        );
      }

      return await response.json();
    } catch (error) {
      console.error("Create override history error:", error);
      throw error;
    }
  }

  // Helper method to convert nested objects to Firestore fields
  convertToFirestoreFields(obj) {
    const fields = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        fields[key] = { stringValue: value };
      } else if (typeof value === "number") {
        if (Number.isInteger(value)) {
          fields[key] = { integerValue: value.toString() };
        } else {
          fields[key] = { doubleValue: value };
        }
      } else if (typeof value === "boolean") {
        fields[key] = { booleanValue: value };
      } else if (value instanceof Date) {
        fields[key] = { timestampValue: value.toISOString() };
      } else if (value === null) {
        fields[key] = { nullValue: null };
      } else if (typeof value === "object") {
        fields[key] = {
          mapValue: { fields: this.convertToFirestoreFields(value) },
        };
      }
    }
    return fields;
  }
}
