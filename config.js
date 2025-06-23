const ENV = {
  development: {
    apiUrl: 'http://localhost:3000',
    debug: true,
    // Add other development-specific config here
  },
  production: {
    apiUrl: 'https://api.yourservice.com',
    debug: false,
    // Add other production-specific config here
  }
};

// Determine current environment
const isDevelopment = !chrome.runtime.getManifest().update_url;
const currentEnv = isDevelopment ? 'development' : 'production';

// Export the configuration
const config = ENV[currentEnv];
export default config; 