// Smart Tab Blocker Background Script
let blockedDomains = {};
let isEnabled = true;

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('Smart Tab Blocker installed');
  
  // Set default configuration
  chrome.storage.sync.get(['smartBlockerEnabled', 'blockedDomains'], (result) => {
    if (result.smartBlockerEnabled === undefined) {
      chrome.storage.sync.set({ smartBlockerEnabled: true });
    }
    
    if (!result.blockedDomains) {
      chrome.storage.sync.set({
        blockedDomains: {}
      });
    }
    
    loadConfiguration();
  });
});

// Load configuration from storage
function loadConfiguration() {
  chrome.storage.sync.get(['smartBlockerEnabled', 'blockedDomains'], (result) => {
    isEnabled = result.smartBlockerEnabled !== false;
    blockedDomains = result.blockedDomains || {};
    console.log('Smart Tab Blocker: Configuration loaded', { isEnabled, blockedDomains });
  });
}

// Check if URL matches any tracked domain
function isTrackedDomain(url) {
  if (!url) return null;
  
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    
    for (const domain of Object.keys(blockedDomains)) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return {
          domain: domain,
          timer: blockedDomains[domain]
        };
      }
    }
  } catch (error) {
    console.log('Smart Tab Blocker: Invalid URL', url);
  }
  
  return null;
}

// Handle tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) {
    const domainInfo = isTrackedDomain(tab.url);
    
    if (domainInfo && isEnabled) {
      console.log(`Smart Tab Blocker: Tracked domain detected - ${domainInfo.domain} (${domainInfo.timer}s)`);
      
      // Inject content script with domain configuration
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: initializeTimer,
        args: [domainInfo]
      }).catch((error) => {
        console.log('Smart Tab Blocker: Could not inject script:', error);
      });
    }
  }
});

// Function to inject into pages
function initializeTimer(domainInfo) {
  // Set domain configuration for the content script
  window.smartBlockerConfig = domainInfo;
  
  // Trigger initialization if content script is already loaded
  if (window.smartBlockerInitialize) {
    window.smartBlockerInitialize(domainInfo);
  }
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Smart Tab Blocker: Background received message:', request);
  
  switch (request.action) {
    case 'checkEnabled':
      sendResponse({ 
        enabled: isEnabled,
        domainConfig: sender.tab ? isTrackedDomain(sender.tab.url) : null
      });
      break;
      
    case 'incrementCount':
      chrome.storage.local.get(['blockedCount'], (result) => {
        const newCount = (result.blockedCount || 0) + 1;
        chrome.storage.local.set({ blockedCount: newCount });
      });
      sendResponse({ success: true });
      break;
      
    case 'getDomainConfig':
      const domainInfo = sender.tab ? isTrackedDomain(sender.tab.url) : null;
      sendResponse({ domainConfig: domainInfo });
      break;
      
    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }
  
  return true; // Keep message channel open
});

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    if (changes.smartBlockerEnabled) {
      isEnabled = changes.smartBlockerEnabled.newValue;
      console.log('Smart Tab Blocker: Enabled state changed to', isEnabled);
      
      // Update all tracked tabs
      updateAllTrackedTabs();
    }
    
    if (changes.blockedDomains) {
      blockedDomains = changes.blockedDomains.newValue || {};
      console.log('Smart Tab Blocker: Domains configuration changed', blockedDomains);
      
      // Update all tabs to reflect new configuration
      updateAllTrackedTabs();
    }
  }
});

// Update all currently open tracked tabs
function updateAllTrackedTabs() {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.url) {
        try {
          const hostname = new URL(tab.url).hostname.toLowerCase();
          const domainInfo = isTrackedDomain(tab.url);
          
          if (domainInfo && isEnabled) {
            // Domain is still tracked and extension is enabled
            const message = {
              action: 'updateConfig',
              enabled: true,
              domainConfig: domainInfo
            };
            
            chrome.tabs.sendMessage(tab.id, message).catch(() => {
              // If content script not loaded, inject it
              chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: initializeTimer,
                args: [domainInfo]
              }).catch(() => {
                // Ignore injection errors
              });
            });
          } else {
            // Either domain is no longer tracked or extension is disabled
            // First try to send a message to stop tracking
            chrome.tabs.sendMessage(tab.id, {
              action: 'stopTracking'
            }).catch(() => {
              // Content script might not be loaded, which is fine
            });
          }
        } catch (error) {
          // Invalid URL, ignore
        }
      }
    });
  });
} 