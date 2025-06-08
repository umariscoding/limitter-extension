// Smart Tab Blocker Subscription Service

class SubscriptionService {
  constructor(firebaseAuth, firestore) {
    this.firebaseAuth = firebaseAuth;
    this.firestore = firestore;
    this.currentPlan = null;
    this.availablePlans = {}; // Will be loaded from database
    this.usageCache = {};
    this.plansLoaded = false;
    this.planLoadPromise = null;
  }

  // Default fallback plans (used if database is unavailable)
  static FALLBACK_PLANS = {
    FREE: {
      id: 'free',
      name: 'Free Plan',
      price: 0,
      billing: 'month',
      limits: {
        maxDomains: 3,
        lockoutDuration: 3600, // 1 hour in seconds
        customDuration: false,
        overrideCost: 1.99,
        freeOverrides: 0,
        journaling: false,
        usageHistory: 7, // days
        devices: 1
      },
      features: [
        'Track up to 3 websites/apps',
        '1-hour fixed lockout duration',
        '$1.99 per override'
      ]
    },
    PRO: {
      id: 'pro',
      name: 'Pro Plan',
      price: 4.99,
      billing: 'month',
      limits: {
        maxDomains: -1, // Unlimited
        lockoutDuration: -1, // Custom
        customDuration: true,
        overrideCost: 0,
        freeOverrides: 15,
        journaling: false,
        usageHistory: 30, // days
        devices: 3
      },
      features: [
        'Unlimited website tracking',
        'Custom lockout durations',
        '15 free overrides per month',
        'Up to 3 devices'
      ]
    },
    ELITE: {
      id: 'elite',
      name: 'Elite Plan',
      price: 11.99,
      billing: 'month',
      limits: {
        maxDomains: -1, // Unlimited
        lockoutDuration: -1, // Custom
        customDuration: true,
        overrideCost: 0,
        freeOverrides: -1, // Unlimited
        journaling: true,
        usageHistory: 90, // days
        devices: 10
      },
      features: [
        'All Pro features',
        'Unlimited overrides',
        'Journaling & override justification',
        '90-day encrypted usage history',
        'Up to 10 devices'
      ]
    }
  };

  // Load subscription plans from Firestore
  async loadPlansFromDatabase() {
    if (this.planLoadPromise) {
      return this.planLoadPromise;
    }

    this.planLoadPromise = this._loadPlansFromDatabase();
    return this.planLoadPromise;
  }

  async _loadPlansFromDatabase() {
    try {
      console.log('Loading subscription plans from database...');
      
      // Get all active plans from the subscription_plans collection
      const plansSnapshot = await this.firestore.getCollection('subscription_plans');
      
      if (plansSnapshot && plansSnapshot.length > 0) {
        // Convert array of plans to object keyed by plan ID
        this.availablePlans = {};
        plansSnapshot.forEach(planDoc => {
          if (planDoc.active !== false) { // Include plans that are active or don't have active field
            this.availablePlans[planDoc.id.toUpperCase()] = planDoc;
          }
        });
        
        console.log('Plans loaded from database:', Object.keys(this.availablePlans));
        this.plansLoaded = true;
        return this.availablePlans;
      } else {
        console.warn('No plans found in database, using fallback plans');
        this.availablePlans = SubscriptionService.FALLBACK_PLANS;
        this.plansLoaded = true;
        return this.availablePlans;
      }
      
    } catch (error) {
      console.error('Error loading plans from database:', error);
      console.warn('Using fallback plans due to database error');
      this.availablePlans = SubscriptionService.FALLBACK_PLANS;
      this.plansLoaded = true;
      return this.availablePlans;
    }
  }

  // Initialize user's current plan
  async initializePlan() {
    try {
      // First, ensure plans are loaded from database
      await this.loadPlansFromDatabase();
      
      const user = this.firebaseAuth.getCurrentUser();
      if (!user) {
        this.currentPlan = this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
        return;
      }

      // Start with free plan as default
      this.currentPlan = this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
      
      // The actual user plan will be set when loadUserDataFromFirestore() is called
      // This method just ensures we have a valid current plan initialized
      
    } catch (error) {
      console.error('Error initializing subscription plan:', error);
      this.currentPlan = this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
    }
  }

  async loadUserSubscription(userId) {
    try {
      // First get user's subscription status
      const subscriptionData = await this.firestore.getDocument(`subscriptions/${userId}`);
      if (subscriptionData && subscriptionData.status === 'active') {
        // Check if subscription is still valid
        if (subscriptionData.current_period_end && new Date(subscriptionData.current_period_end) > new Date()) {
          // Return the plan from our loaded plans
          const planId = subscriptionData.plan.toUpperCase();
          return this.availablePlans[planId] || this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
        }
      }
      
      // Also check user document for plan information (fallback)
      const userData = await this.firestore.getDocument(`users/${userId}`);
      if (userData && userData.plan) {
        const planId = userData.plan.toUpperCase();
        return this.availablePlans[planId] || this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
      }
      
      return this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
    } catch (error) {
      console.error('Error loading user subscription:', error);
      return this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
    }
  }

  // Wait for plans to be loaded
  async waitForPlansLoaded() {
    if (this.plansLoaded) {
      return true;
    }
    
    if (this.planLoadPromise) {
      await this.planLoadPromise;
      return true;
    }
    
    await this.loadPlansFromDatabase();
    return true;
  }

  // Update user's current plan based on user data
  async updateUserPlan(planId) {
    try {
      await this.waitForPlansLoaded(); // Ensure plans are loaded first
      
      const plan = this.availablePlans[planId.toUpperCase()];
      if (plan) {
        this.currentPlan = plan;
        console.log(`Updated user plan to: ${plan.name}`);
      } else {
        console.warn(`Plan ${planId} not found in available plans, keeping current plan`);
        this.currentPlan = this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
      }
    } catch (error) {
      console.error('Error updating user plan:', error);
      this.currentPlan = this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
    }
  }

  // Update user subscription data (for paid plans)
  async updateUserSubscription(subscriptionData) {
    try {
      await this.waitForPlansLoaded(); // Ensure plans are loaded first
      
      if (subscriptionData && subscriptionData.status === 'active') {
        // Check if subscription is still valid
        if (subscriptionData.current_period_end && new Date(subscriptionData.current_period_end) > new Date()) {
          const planId = subscriptionData.plan.toUpperCase();
          const plan = this.availablePlans[planId];
          if (plan) {
            this.currentPlan = plan;
            console.log(`Updated user subscription to: ${plan.name}`);
            return;
          }
        }
      }
      
      // If subscription is inactive or expired, fall back to free plan
      this.currentPlan = this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
      console.log('Subscription inactive or expired, using free plan');
      
    } catch (error) {
      console.error('Error updating user subscription:', error);
      this.currentPlan = this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
    }
  }

  getCurrentPlan() {
    return this.currentPlan || this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
  }

  getPlanById(planId) {
    return this.availablePlans[planId.toUpperCase()] || this.availablePlans.FREE || SubscriptionService.FALLBACK_PLANS.FREE;
  }

  getAllPlans() {
    return Object.values(this.availablePlans);
  }

  // Check if user can add more domains
  async canAddDomain(currentDomainCount) {
    const plan = this.getCurrentPlan();
    return plan.limits.maxDomains === -1 || currentDomainCount < plan.limits.maxDomains;
  }

  // Get maximum domain count for current plan
  getMaxDomains() {
    const plan = this.getCurrentPlan();
    return plan.limits.maxDomains;
  }

  // Check if custom duration is allowed
  canUseCustomDuration() {
    const plan = this.getCurrentPlan();
    return plan.limits.customDuration;
  }

  // Get default lockout duration
  getDefaultLockoutDuration() {
    const plan = this.getCurrentPlan();
    return plan.limits.lockoutDuration === -1 ? null : plan.limits.lockoutDuration;
  }

  // Check if user can override (considering cost and free overrides)
  async canOverride(userId) {
    const plan = this.getCurrentPlan();
    
    if (plan.limits.freeOverrides === -1) {
      return { allowed: true, cost: 0, reason: 'unlimited' };
    }

    try {
      // Fetch user's override credits from Firestore
      const userOverrides = await this.firestore.getUserOverrides(userId);
      const totalOverrides = userOverrides ? (userOverrides.overrides || 0) : 0;
      
      console.log(`User ${userId} has ${totalOverrides} overrides remaining`);
      
      // If user has overrides remaining, allow free override
      if (totalOverrides > 0) {
        return { allowed: true, cost: 0, reason: 'credit_override', remaining: totalOverrides };
      }
      
      // No overrides remaining - redirect to checkout
      return { allowed: false, cost: 0, reason: 'no_overrides', redirectUrl: 'http://localhost:3000/checkout?overrides=1' };
      
    } catch (error) {
      console.error('Error fetching user overrides:', error);
      // Fallback to monthly usage system if Firestore is unavailable
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM format
      const usage = await this.getMonthlyUsage(userId, currentMonth);
      
      if (usage.overrides < plan.limits.freeOverrides) {
        return { allowed: true, cost: 0, reason: 'free_remaining', remaining: plan.limits.freeOverrides - usage.overrides };
      }

      return { allowed: true, cost: plan.limits.overrideCost, reason: 'paid_override' };
    }
  }

  // Process an override
  async processOverride(userId, domain, reason = '') {
    const overrideCheck = await this.canOverride(userId);
    
    if (!overrideCheck.allowed) {
      throw new Error('Override not allowed');
    }

    const overrideData = {
      user_id: userId,
      domain: domain,
      timestamp: new Date(),
      cost: overrideCheck.cost,
      reason: reason,
      plan: this.currentPlan.id,
      override_type: overrideCheck.reason === 'credit_override' ? 'credit' : 'free'
    };

    try {
      // If using credit override, decrement user's override count
      if (overrideCheck.reason === 'credit_override') {
        const userOverrides = await this.firestore.getUserOverrides(userId);
        if (userOverrides && userOverrides.overrides > 0) {
          const updatedOverrides = {
            ...userOverrides,
            overrides: Math.max(0, userOverrides.overrides - 1),
            overrides_used_total: (userOverrides.overrides_used_total || 0) + 1,
            updated_at: new Date()
          };
          
          // Update user overrides in Firestore
          await this.firestore.updateDocument(`user_overrides/${userId}`, updatedOverrides);
          console.log(`Override credit used. Remaining: ${updatedOverrides.overrides}`);
        }
      }

      // Record the override in history
      await this.recordOverride(userId, overrideData);

      // Update monthly usage
      await this.updateMonthlyUsage(userId);

      return overrideData;
    } catch (error) {
      console.error('Error processing override:', error);
      throw error;
    }
  }

  async recordOverride(userId, overrideData) {
    try {
      const overrideId = `${userId}_${Date.now()}`;
      await this.firestore.updateDocument(`overrides/${overrideId}`, overrideData);
    } catch (error) {
      console.error('Error recording override:', error);
      throw error;
    }
  }

  async getMonthlyUsage(userId, month) {
    try {
      const usageData = await this.firestore.getDocument(`usage/${userId}_${month}`);
      return usageData || { overrides: 0, domains_added: 0, total_time_blocked: 0 };
    } catch (error) {
      console.error('Error getting monthly usage:', error);
      return { overrides: 0, domains_added: 0, total_time_blocked: 0 };
    }
  }

  async updateMonthlyUsage(userId) {
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const usage = await this.getMonthlyUsage(userId, currentMonth);
      usage.overrides = (usage.overrides || 0) + 1;
      usage.last_updated = new Date();
      
      await this.firestore.updateDocument(`usage/${userId}_${currentMonth}`, usage);
    } catch (error) {
      console.error('Error updating monthly usage:', error);
    }
  }

  // Check if journaling is available
  canUseJournaling() {
    const plan = this.getCurrentPlan();
    return plan.limits.journaling;
  }

  // Get usage history retention period
  getUsageHistoryDays() {
    const plan = this.getCurrentPlan();
    return plan.limits.usageHistory;
  }

  // Initiate subscription upgrade
  async upgradeSubscription(planId, userId) {
    const plan = this.getPlanById(planId);
    if (!plan) {
      throw new Error('Invalid plan selected');
    }

    // Return payment URL (redirect to localhost:3000)
    return `http://localhost:3000/payment?plan=${plan.id}&amount=${plan.price}&user=${userId}`;
  }

  // Handle successful payment
  async handlePaymentSuccess(userId, planId, paymentId) {
    try {
      const plan = this.getPlanById(planId);
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 1); // Add 1 month

      const subscriptionData = {
        user_id: userId,
        plan: plan.id,
        status: 'active',
        started_at: new Date(),
        expires_at: expiresAt,
        payment_id: paymentId,
        last_payment: new Date()
      };

      await this.firestore.updateDocument(`subscriptions/${userId}`, subscriptionData);
      
      // Update current plan
      this.currentPlan = plan;
      
      return true;
    } catch (error) {
      console.error('Error handling payment success:', error);
      throw error;
    }
  }

  // Get subscription status for UI
  getSubscriptionStatus() {
    const plan = this.getCurrentPlan();
    return {
      planId: plan.id,
      planName: plan.name,
      price: plan.price,
      features: plan.features,
      limits: plan.limits,
      isActive: plan.id !== 'free'
    };
  }

  // Get upgrade recommendations
  getUpgradeRecommendations(currentDomainCount, needsCustomDuration, needsMoreOverrides) {
    const current = this.getCurrentPlan();
    const recommendations = [];

    if (current.id === 'free') {
      if (currentDomainCount >= 3 || needsCustomDuration || needsMoreOverrides) {
        const proPlan = this.availablePlans.PRO || SubscriptionService.FALLBACK_PLANS.PRO;
        recommendations.push({
          plan: proPlan,
          reason: 'Unlock unlimited domains and custom timers'
        });
      }
    }

    if (current.id === 'pro' || current.id === 'free') {
      if (needsMoreOverrides) {
        const elitePlan = this.availablePlans.ELITE || SubscriptionService.FALLBACK_PLANS.ELITE;
        recommendations.push({
          plan: elitePlan,
          reason: 'Get unlimited overrides and advanced features'
        });
      }
    }

    return recommendations;
  }

  // Validate time input based on plan
  validateTimeInput(hours, minutes, seconds) {
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    const plan = this.getCurrentPlan();

    if (plan.id === 'free') {
      // Free plan: only allow 1 hour (3600 seconds)
      if (totalSeconds !== 3600) {
        return {
          valid: false,
          message: 'Free plan only allows 1-hour lockout duration. Upgrade to Pro for custom timers.',
          suggestedUpgrade: 'pro'
        };
      }
    }

    if (totalSeconds < 1) {
      return {
        valid: false,
        message: 'Timer must be at least 1 second'
      };
    }

    if (totalSeconds > 86400) { // 24 hours
      return {
        valid: false,
        message: 'Timer cannot exceed 24 hours'
      };
    }

    return { valid: true };
  }
}

// Make it available globally
if (typeof window !== 'undefined') {
  window.SubscriptionService = SubscriptionService;
}

// Export for Node.js environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SubscriptionService;
} 