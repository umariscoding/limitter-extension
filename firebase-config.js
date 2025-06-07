// Firebase Configuration
// Replace these with your actual Firebase project configuration
const firebaseConfig = {
    apiKey: "AIzaSyCRcKOOzsp_nX8auUOhAFR-UVhGqIgmOjU",
    authDomain: "test-ext-ad0b2.firebaseapp.com",
    projectId: "test-ext-ad0b2",
    storageBucket: "test-ext-ad0b2.firebasestorage.app",
    messagingSenderId: "642984588666",
    appId: "1:642984588666:web:dd1fcd739567df3a4d92c3",
    measurementId: "G-B0MC8CDXCK"
};

// Initialize Firebase (will be done in the popup script)
const FIREBASE_CONFIG = firebaseConfig;

// Firebase Auth API endpoints
const FIREBASE_AUTH_BASE_URL = 'https://identitytoolkit.googleapis.com/v1/accounts';
const FIREBASE_FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;

// Firebase Authentication class
class FirebaseAuth {
  constructor(config) {
    this.config = config;
    this.apiKey = config.apiKey;
    this.currentUser = null;
  }

  // Authenticate user with email and password
  async signInWithEmailAndPassword(email, password) {
    const url = `${FIREBASE_AUTH_BASE_URL}:signInWithPassword?key=${this.apiKey}`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email,
          password: password,
          returnSecureToken: true
        })
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error?.message || 'Login failed');
      }

      this.currentUser = {
        uid: data.localId,
        email: data.email,
        idToken: data.idToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn
      };

      await this.storeAuthData(this.currentUser);
      
      return this.currentUser;
    } catch (error) {
      console.error('Firebase sign in error:', error);
      throw error;
    }
  }

  // Store user authentication data in Chrome storage
  async storeAuthData(userData) {
    return new Promise((resolve) => {
      chrome.storage.local.set({
        firebaseUser: userData,
        authTimestamp: Date.now()
      }, resolve);
    });
  }

  // Retrieve stored authentication data
  async getStoredAuthData() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['firebaseUser', 'authTimestamp'], (result) => {
        if (result.firebaseUser && result.authTimestamp) {
          const hourInMs = 60 * 60 * 1000;
          if (Date.now() - result.authTimestamp < hourInMs) {
            this.currentUser = result.firebaseUser;
            resolve(result.firebaseUser);
          } else {
            this.signOut();
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });
  }

  // Sign out current user
  async signOut() {
    this.currentUser = null;
    return new Promise((resolve) => {
      chrome.storage.local.remove(['firebaseUser', 'authTimestamp'], resolve);
    });
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
    if (!this.currentUser?.refreshToken) {
      throw new Error('No refresh token available');
    }

    const url = `https://securetoken.googleapis.com/v1/token?key=${this.apiKey}`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: this.currentUser.refreshToken
        })
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error?.message || 'Token refresh failed');
      }

      this.currentUser.idToken = data.id_token;
      this.currentUser.refreshToken = data.refresh_token;
      
      await this.storeAuthData(this.currentUser);
      
      return this.currentUser;
    } catch (error) {
      console.error('Token refresh error:', error);
      throw error;
    }
  }
}

// Firebase Firestore class
class FirebaseFirestore {
  constructor(config, authInstance) {
    this.config = config;
    this.auth = authInstance;
    this.baseUrl = FIREBASE_FIRESTORE_BASE_URL;
  }

  // Generate authorization headers for API requests
  getAuthHeaders() {
    const user = this.auth.getCurrentUser();
    if (!user || !user.idToken) {
      throw new Error('User not authenticated');
    }
    
    return {
      'Authorization': `Bearer ${user.idToken}`,
      'Content-Type': 'application/json'
    };
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
        result[key] = this.convertFirestoreDoc({ fields: value.mapValue.fields });
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
        method: 'GET',
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log('User profile not found (404)');
          return null;
        }
        const errorText = await response.text();
        console.error(`HTTP Error ${response.status}: ${errorText}`);
        throw new Error(`Failed to fetch user profile: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      return this.convertFirestoreDoc(data);
    } catch (error) {
      console.error('Get user profile error:', error);
      if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
        console.error('Network error - check internet connection and CORS permissions');
        throw new Error('Network error: Unable to connect to Firebase. Please check your internet connection.');
      }
      throw error;
    }
  }

  // Retrieve user's blocked sites from Firestore
  async getUserBlockedSites(userId) {
    try {
      const response = await fetch(`${this.baseUrl}:runQuery`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'blocked_sites' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'user_id' },
                op: 'EQUAL',
                value: { stringValue: userId }
              }
            },
            orderBy: [
              {
                field: { fieldPath: 'created_at' },
                direction: 'DESCENDING'
              }
            ]
          }
        })
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
      console.error('Get blocked sites error:', error);
      throw error;
    }
  }

  // Create or update user profile in Firestore
  async updateUserProfile(userId, profileData) {
    try {
      const firestoreData = {};
      
      for (const [key, value] of Object.entries(profileData)) {
        if (typeof value === 'string') {
          firestoreData[key] = { stringValue: value };
        } else if (typeof value === 'number') {
          if (Number.isInteger(value)) {
            firestoreData[key] = { integerValue: value.toString() };
          } else {
            firestoreData[key] = { doubleValue: value };
          }
        } else if (typeof value === 'boolean') {
          firestoreData[key] = { booleanValue: value };
        } else if (value instanceof Date) {
          firestoreData[key] = { timestampValue: value.toISOString() };
        } else if (value === null) {
          firestoreData[key] = { nullValue: null };
        }
      }

      const response = await fetch(`${this.baseUrl}/users/${userId}`, {
        method: 'PATCH',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          fields: firestoreData
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to update user profile: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Update user profile error:', error);
      throw error;
    }
  }

  // Create or update blocked site entry in Firestore
  async updateBlockedSite(siteId, siteData) {
    try {
      const firestoreData = {};
      
      for (const [key, value] of Object.entries(siteData)) {
        if (typeof value === 'string') {
          firestoreData[key] = { stringValue: value };
        } else if (typeof value === 'number') {
          if (Number.isInteger(value)) {
            firestoreData[key] = { integerValue: value.toString() };
          } else {
            firestoreData[key] = { doubleValue: value };
          }
        } else if (typeof value === 'boolean') {
          firestoreData[key] = { booleanValue: value };
        } else if (value instanceof Date) {
          firestoreData[key] = { timestampValue: value.toISOString() };
        } else if (value === null) {
          firestoreData[key] = { nullValue: null };
        }
      }

      const response = await fetch(`${this.baseUrl}/blocked_sites/${siteId}`, {
        method: 'PATCH',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          fields: firestoreData
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to update blocked site: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Update blocked site error:', error);
      throw error;
    }
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FirebaseAuth, FirebaseFirestore, FIREBASE_CONFIG };
}