
## Firebase Collections and Fields

### 1. **users** Collection
**Document ID**: Firebase Auth UID
- `id` - User ID (same as document ID)
- `profile_name` - User's display name
- `profile_email` - User's email address  
- `profile_image` - Profile image URL (nullable)
- `plan` - Subscription plan ('free', 'pro', 'elite')
- `total_time_saved` - Total minutes saved by blocking sites
- `total_sites_blocked` - Count of blocked sites
- `daily_stats` - Object containing daily usage statistics
- `weekly_stats` - Object containing weekly usage statistics  
- `monthly_stats` - Object containing monthly usage statistics
- `override_credits` - Available override credits balance
- `credits_purchased_total` - Lifetime purchased credits
- `created_at` - Document creation timestamp
- `updated_at` - Last modification timestamp

### 2. **subscriptions** Collection
**Document ID**: User ID
- `user_id` - Reference to user ID
- `plan` - Subscription plan ('free', 'pro', 'elite')
- `status` - Subscription status ('active', 'canceled', etc.)
- `stripe_customer_id` - Stripe customer ID (nullable)
- `stripe_subscription_id` - Stripe subscription ID (nullable)
- `current_period_start` - Billing period start
- `current_period_end` - Billing period end
- `created_at` - Subscription creation timestamp
- `updated_at` - Last modification timestamp

### 3. **blocked_sites** Collection
**Document ID**: Auto-generated
- `user_id` - Reference to user ID
- `url` - Website URL
- `name` - Display name for the site
- `time_limit` - Daily time limit in seconds (default: 1800)
- `time_remaining` - Current remaining time in seconds
- `time_spent_today` - Time spent today in seconds
- `last_reset_date` - Date of last reset (YYYY-MM-DD format)
- `is_blocked` - Boolean indicating if site is currently blocked
- `is_active` - Boolean indicating if monitoring is enabled
- `blocked_until` - ISO timestamp when blocking expires
- `schedule` - Time-based blocking schedule (nullable)
- `daily_usage` - Object tracking daily usage by date
- `total_time_spent` - Lifetime time spent on site
- `access_count` - Number of times site was accessed
- `last_accessed` - Last access timestamp
- `created_at` - Site addition timestamp
- `updated_at` - Last modification timestamp

### 4. **user_overrides** Collection  
**Document ID**: User ID
- `user_id` - Reference to user ID
- `overrides` - Current override balance (all types combined)
- `override_credits` - Available purchased credits
- `total_overrides_purchased` - Lifetime purchased overrides
- `credits_purchased_total` - Lifetime purchased credits  
- `overrides_used_total` - Total overrides ever used
- `total_spent` - Total amount spent on overrides
- `monthly_stats` - Object containing monthly usage:
  - `{YYYY-MM}` - Monthly key containing:
    - `free_overrides_used` - Free overrides used this month
    - `credit_overrides_used` - Credit overrides used this month  
    - `overrides_used` - Total overrides used this month
    - `total_spent_this_month` - Amount spent this month
    - `monthly_grant_given` - Boolean if monthly free overrides granted
    - `free_overrides_granted` - Number of free overrides granted
    - `grant_date` - Timestamp of grant
- `created_at` - Document creation timestamp
- `updated_at` - Last modification timestamp

### 5. **override_history** Collection
**Document ID**: Auto-generated
- `user_id` - Reference to user ID
- `site_url` - URL of site override was used on
- `timestamp` - When override was used
- `amount` - Amount paid for override (0 for free/credit overrides)
- `override_type` - Type of override ('free', 'credit', 'paid')
- `month` - Month key (YYYY-MM)
- `plan` - User's plan when override was used
- `reason` - Description of override usage
- `created_at` - Entry creation timestamp

### 6. **override_purchases** Collection (Credit Purchases)
**Document ID**: Auto-generated  
- `user_id` - Reference to user ID
- `overrides_purchased` - Number of overrides/credits purchased
- `amount_paid` - Total amount paid
- `price_per_override` - Price per override at time of purchase
- `transaction_id` - Unique transaction identifier
- `payment_method` - Payment method used
- `package_type` - Credit package purchased ('small', 'medium', 'large', 'xl')
- `timestamp` - Purchase timestamp
- `created_at` - Entry creation timestamp

### 7. **credit_purchases** Collection
**Document ID**: Auto-generated
- `user_id` - Reference to user ID  
- `credits_purchased` - Number of credits purchased
- `package_size` - Package purchased (1, 5, 10, 20)
- `amount_paid` - Total amount paid
- `price_per_credit` - Price per credit
- `package_name` - Package name ('Small', 'Medium', 'Large', 'XL')
- `transaction_id` - Unique transaction identifier
- `payment_method` - Payment method used
- `timestamp` - Purchase timestamp
- `created_at` - Entry creation timestamp

### 8. **subscription_plans** Collection
**Document ID**: Plan ID ('free', 'pro', 'elite')
- `id` - Plan identifier (same as document ID)
- `name` - Display name of the plan
- `price` - Monthly price in USD
- `billing` - Billing period ('month')
- `limits` - Object containing plan limitations:
  - `maxDomains` - Maximum domains (-1 for unlimited)
  - `lockoutDuration` - Lockout duration in seconds (-1 for custom)
  - `customDuration` - Boolean for custom duration support
  - `overrideCost` - Cost per override (0 for free)
  - `freeOverrides` - Free overrides per month (-1 for unlimited)
  - `journaling` - Boolean for journaling feature
  - `usageHistory` - Usage history retention in days
  - `devices` - Maximum devices allowed
- `features` - Array of feature descriptions
- `active` - Boolean indicating if plan is available
- `created_at` - Plan creation timestamp
- `updated_at` - Last modification timestamp

### Database Indexes
- **blocked_sites** collection has a composite index on:
  - `user_id` (ASCENDING)
  - `created_at` (DESCENDING)
- **subscription_plans** collection should have an index on:
  - `active` (ASCENDING)
  - `price` (ASCENDING)

This comprehensive structure supports the complete override credit system with site-specific time tracking, subscription management, and detailed usage analytics. The subscription plans are now stored in the database for dynamic management.