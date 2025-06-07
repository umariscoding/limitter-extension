// Smart Tab Blocker Subscription Service

class SubscriptionService {
  constructor(firebaseAuth, firestore) {
    this.firebaseAuth = firebaseAuth;
    this.firestore = firestore;
    this.currentPlan = null;
    this.usageCache = {};
    this.initializePlan();
  }

  // Subscription Plans Configuration
  static PLANS = {
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

  async initializePlan() {
    try {
      const user = this.firebaseAuth.getCurrentUser();
      if (!user) {
        this.currentPlan = SubscriptionService.PLANS.FREE;
        return;
      }

      // Load user's subscription from Firestore
      const subscription = await this.loadUserSubscription(user.uid);
      this.currentPlan = subscription || SubscriptionService.PLANS.FREE;
    } catch (error) {
      console.error('Error initializing subscription plan:', error);
      this.currentPlan = SubscriptionService.PLANS.FREE;
    }
  }



  async loadUserSubscription(userId) {
    try {
      const subscriptionData = await this.firestore.getDocument(`subscriptions/${userId}`);
      if (subscriptionData && subscriptionData.status === 'active' && new Date(subscriptionData.expires_at) > new Date()) {
        return SubscriptionService.PLANS[subscriptionData.plan.toUpperCase()] || SubscriptionService.PLANS.FREE;
      }
      return SubscriptionService.PLANS.FREE;
    } catch (error) {
      console.error('Error loading user subscription:', error);
      return SubscriptionService.PLANS.FREE;
    }
  }

  getCurrentPlan() {
    return this.currentPlan || SubscriptionService.PLANS.FREE;
  }

  getPlanById(planId) {
    return SubscriptionService.PLANS[planId.toUpperCase()] || SubscriptionService.PLANS.FREE;
  }

  getAllPlans() {
    return Object.values(SubscriptionService.PLANS);
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

    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM format
    const usage = await this.getMonthlyUsage(userId, currentMonth);
    
    if (usage.overrides < plan.limits.freeOverrides) {
      return { allowed: true, cost: 0, reason: 'free_remaining', remaining: plan.limits.freeOverrides - usage.overrides };
    }

    return { allowed: true, cost: plan.limits.overrideCost, reason: 'paid_override' };
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
      plan: this.currentPlan.id
    };

    // Record the override
    await this.recordOverride(userId, overrideData);

    // Update monthly usage
    await this.updateMonthlyUsage(userId);

    return overrideData;
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
    const plan = SubscriptionService.PLANS[planId.toUpperCase()];
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
        recommendations.push({
          plan: SubscriptionService.PLANS.PRO,
          reason: 'Unlock unlimited domains and custom timers'
        });
      }
    }

    if (current.id === 'pro' || current.id === 'free') {
      if (needsMoreOverrides) {
        recommendations.push({
          plan: SubscriptionService.PLANS.ELITE,
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