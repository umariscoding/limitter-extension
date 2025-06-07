# Firebase Setup Instructions

## 1. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Create a project" or "Add project"
3. Enter your project name (e.g., "smart-tab-blocker")
4. Optionally enable Google Analytics
5. Click "Create project"

## 2. Enable Authentication

1. In your Firebase project console, click on "Authentication" in the left sidebar
2. Click on "Get started"
3. Go to the "Sign-in method" tab
4. Enable "Email/Password" sign-in method
5. Optionally enable "Email link (passwordless sign-in)" if desired

## 3. Get Your Firebase Configuration

1. In your Firebase project console, click on the gear icon (⚙️) next to "Project Overview"
2. Select "Project settings"
3. Scroll down to "Your apps" section
4. Click "Add app" and select the web icon (</>) 
5. Enter an app nickname (e.g., "Tab Blocker Extension")
6. Click "Register app"
7. Copy the Firebase configuration object

## 4. Update the Extension Configuration

1. Open `firebase-config.js` in your extension folder
2. Replace the placeholder values with your actual Firebase configuration:

```javascript
const firebaseConfig = {
  apiKey: "your-actual-api-key",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-actual-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "your-actual-sender-id",
  appId: "your-actual-app-id"
};
```

## 5. Configure Firebase Security Rules (Optional)

For better security, you can set up Firestore security rules if you plan to store user data:

1. Go to "Firestore Database" in Firebase Console
2. Click "Create database"
3. Choose "Start in production mode"
4. Select a location for your database
5. Update security rules as needed

## 6. Test the Extension

1. Load the extension in Chrome:
   - Go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select your extension folder

2. Test authentication:
   - Click on the extension icon
   - Try logging in with test credentials
   - The register button should open `localhost:3000/register`

## 7. Set Up Your Website Registration

Make sure your website at `localhost:3000` has a registration page that:
1. Collects user email and password
2. Uses Firebase Authentication to create new users
3. Handles registration success/error states

## Troubleshooting

### Common Issues:

1. **CORS Errors**: Make sure your Firebase project allows the extension's origin
2. **Authentication Errors**: Check that Email/Password is enabled in Firebase Auth
3. **Permission Errors**: Verify that the manifest.json has the correct host permissions

### Debug Steps:

1. Open Chrome DevTools on the extension popup
2. Check the Console tab for any error messages
3. Verify that `firebase-config.js` is loaded correctly
4. Test authentication with a known working email/password

## Next Steps

Once Firebase is configured:
1. Create test users through your website registration
2. Test login functionality in the extension
3. Verify that user sessions persist across extension popup opens/closes
4. Test logout functionality

The extension will now require authentication before showing the main tab blocking interface!