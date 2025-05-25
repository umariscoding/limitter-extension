// Smart Tab Blocker Popup Script
document.addEventListener('DOMContentLoaded', function() {
  const stats = document.getElementById('stats');
  const domainInput = document.getElementById('domainInput');
  const timerInput = document.getElementById('timerInput');
  const addBtn = document.getElementById('addBtn');
  const domainsList = document.getElementById('domainsList');
  
  let domains = {};
  let domainStates = {};
  let updateInterval = null;
  let previousDomainOrder = [];
  
  // Load domains on startup
  loadDomains();
  
  // Start periodic updates
  startPeriodicUpdates();
  
  // Add domain button handler
  addBtn.addEventListener('click', addDomain);
  
  // Enter key handler for inputs
  domainInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') addDomain();
  });
  
  timerInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') addDomain();
  });
  
  // Event delegation for buttons
  domainsList.addEventListener('click', function(e) {
    const domain = e.target.getAttribute('data-domain');
    if (!domain) return;
    
    if (e.target.classList.contains('remove-btn')) {
      removeDomain(domain);
    } else if (e.target.classList.contains('reset-btn')) {
      resetDomain(domain);
    }
  });
  
  // Start periodic updates for timer states
  function startPeriodicUpdates() {
    updateDomainStates();
    updateInterval = setInterval(updateDomainStates, 1000); // Update every second
  }
  
  // Get current active domain from tabs
  function getCurrentActiveDomain() {
    return new Promise((resolve) => {
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
    });
  }
  
  // Update domain states from storage
  function updateDomainStates() {
    const domainKeys = Object.keys(domains);
    if (domainKeys.length === 0) return;
    
    // Get all timer states and daily blocks
    const storageKeys = domainKeys.flatMap(domain => [
      `timerState_${domain}`,
      `dailyBlock_${domain}`
    ]);
    
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
            newStates[domain] = {
              status: timerState.isActive ? (timerState.isPaused ? 'paused' : 'running') : 'ready',
              timeRemaining: timerState.timeRemaining || domains[domain],
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
  }
  
  // Get today's date string
  function getTodayString() {
    const today = new Date();
    return today.getFullYear() + '-' + 
           String(today.getMonth() + 1).padStart(2, '0') + '-' + 
           String(today.getDate()).padStart(2, '0');
  }
  
  function loadDomains() {
    chrome.storage.sync.get(['blockedDomains'], function(result) {
      domains = result.blockedDomains || {};
      updateDomainStates();
      updateStats();
    });
  }
  
  function saveDomains() {
    chrome.storage.sync.set({
      blockedDomains: domains
    });
  }
  
  // Clear daily block for a specific domain
  function clearDailyBlock(domain) {
    const blockKey = `dailyBlock_${domain}`;
    const timerKey = `timerState_${domain}`;
    
    console.log(`Smart Tab Blocker: Clearing storage for domain: ${domain}`);
    
    chrome.storage.local.remove([blockKey, timerKey], () => {
      if (chrome.runtime.lastError) {
        console.error('Storage clear error:', chrome.runtime.lastError);
      } else {
        console.log(`Smart Tab Blocker: Successfully cleared storage for ${domain}`);
      }
    });
  }
  
  function addDomain() {
    const domain = domainInput.value.trim().toLowerCase();
    const timer = parseInt(timerInput.value);
    
    if (!domain) {
      showError('Please enter a domain');
      return;
    }
    
    if (!timer || timer < 1 || timer > 300) {
      showError('Timer must be between 1-300 seconds');
      return;
    }
    
    // Clean domain (remove protocol, www, etc.)
    const cleanDomain = domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
    
    domains[cleanDomain] = timer;
    saveDomains();
    
    // Clear any existing daily block for this domain to allow fresh timer
    clearDailyBlock(cleanDomain);
    
    // Notify existing tabs about the new domain
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.url) {
          try {
            const hostname = new URL(tab.url).hostname.toLowerCase();
            if (hostname === cleanDomain || hostname.endsWith('.' + cleanDomain)) {
              // Send message to start tracking on this tab
              chrome.tabs.sendMessage(tab.id, {
                action: 'startTracking',
                domain: cleanDomain,
                timer: timer
              }).then((response) => {
                console.log(`Started tracking on tab ${tab.id}:`, response);
              }).catch(() => {
                // Tab might not have content script yet, inject it
                chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  files: ['content.js']
                }).then(() => {
                  // Try sending message again after injection
                  setTimeout(() => {
                    chrome.tabs.sendMessage(tab.id, {
                      action: 'startTracking',
                      domain: cleanDomain,
                      timer: timer
                    }).catch(() => {
                      // Still failed, user may need to refresh
                      console.log(`Could not start tracking on tab ${tab.id}, may need refresh`);
                    });
                  }, 100);
                }).catch(() => {
                  console.log(`Could not inject script into tab ${tab.id}`);
                });
              });
            }
          } catch (error) {
            // Invalid URL, ignore
          }
        }
      });
    });
    
    updateDomainStates();
    updateStats();
    
    // Clear inputs
    domainInput.value = '';
    timerInput.value = '';
    
    showFeedback(`Added ${cleanDomain} with ${timer}s timer`);
  }
  
  function removeDomain(domain) {
    delete domains[domain];
    delete domainStates[domain];
    saveDomains();
    
    // Clear daily block when domain is removed
    clearDailyBlock(domain);
    
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
      
      let statusText = '';
      let statusClass = '';
      
      switch (state.status) {
        case 'blocked':
          statusText = 'Blocked today';
          statusClass = 'status-blocked';
          break;
        case 'running':
          statusText = `${state.timeRemaining}s remaining`;
          statusClass = 'status-running';
          break;
        case 'paused':
          statusText = `${state.timeRemaining}s (paused)`;
          statusClass = 'status-paused';
          break;
        default:
          statusText = `${domains[domain]} seconds`;
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
  chrome.storage.onChanged.addListener(function(changes, area) {
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
  });
  
  // Clean up interval when popup closes
  window.addEventListener('beforeunload', () => {
    if (updateInterval) {
      clearInterval(updateInterval);
    }
  });
  
  function resetDomain(domain) {
    console.log(`Smart Tab Blocker: Initiating reset for domain: ${domain}`);
    
    // Clear daily block and timer state for this domain
    clearDailyBlock(domain);
    
    // Update domain state to ready
    if (domainStates[domain]) {
      domainStates[domain] = {
        status: 'ready',
        timeRemaining: domains[domain],
        isActive: false
      };
    }
    
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
        renderDomainsList();
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
}); 