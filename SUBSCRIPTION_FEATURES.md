# Limitter - Subscription Features

## Overview
The Limitter extension now includes a comprehensive subscription system with three tiers designed to meet different user needs and usage patterns.

## Subscription Tiers

### Free Plan ($0/month)
- **1 device** support
- **Track up to 3 websites/apps**
- **1-hour fixed lockout** duration
- **$1.99 per override** when you need to bypass blocks
- Basic usage tracking (7 days)

**Perfect for**: Users who want to try the extension or have minimal blocking needs.

### Pro Plan ($4.99/month) - RECOMMENDED
- **Up to 3 devices**
- **Unlimited website tracking**
- **Custom lockout durations** (set any time from 1 second to 24 hours)
- **15 free overrides per month**
- Extended usage tracking (30 days)

**Perfect for**: Regular users who need flexibility and multiple site blocking.

### Elite Plan ($11.99/month)
- **Up to 10 devices**
- **Unlimited overrides** (no cost, no limits)
- **Journaling & override justification** features
- **90-day encrypted usage history**
- All Pro plan features included

**Perfect for**: Power users who need maximum flexibility and detailed tracking.

## Key Features Implemented

### 1. Plan-Based Restrictions
- **Domain Limits**: Free users can only add 3 domains, Pro/Elite have unlimited
- **Timer Restrictions**: Free users must use 1-hour timers, Pro/Elite can set custom durations
- **Override System**: Different override allowances and costs per plan

### 2. User Interface Integration
- **Plan Status Display**: Shows current plan and usage in the popup
- **Subscription Modal**: Beautiful plan comparison and upgrade interface
- **Plan Limit Warnings**: Clear messaging when users hit plan limits
- **Upgrade Prompts**: Contextual suggestions to upgrade when needed

### 3. Override System
- **Smart Override Button**: Appears on blocked sites
- **Plan-Aware Pricing**: Free users pay $1.99, Pro users get 15 free/month, Elite unlimited
- **Payment Integration**: Redirects to localhost:3000 for payment processing
- **Override Tracking**: Logs all overrides for usage analytics

### 4. Payment Integration
- **External Payment Processing**: Redirects to `http://localhost:3000/payment`
- **Plan Upgrade URLs**: Include plan details and user information
- **Payment Success Handling**: Updates user subscription status

## Technical Implementation

### Files Modified/Added:
1. **`subscription-service.js`** - Core subscription logic and plan management
2. **`popup.html`** - Added subscription UI elements and modals
3. **`popup.js`** - Integrated subscription checks and UI updates
4. **`content.js`** - Added override functionality to blocked sites
5. **`content.css`** - Styled override buttons and notifications
6. **`background.js`** - Added override request handling
7. **`manifest.json`** - Updated to include subscription service

### Key Classes and Methods:
- `SubscriptionService` - Main subscription management class
- `validateTimeInput()` - Enforces plan-based timer restrictions
- `canAddDomain()` - Checks domain limits
- `canOverride()` - Determines override availability and cost
- `upgradeSubscription()` - Handles plan upgrades

## User Experience Flow

### For Free Users:
1. Can add up to 3 domains with 1-hour timers only
2. When blocked, see override button with $1.99 cost
3. Clear upgrade prompts when hitting limits
4. Plan status shows usage (e.g., "2/3 domains used")

### For Pro Users:
1. Unlimited domains with custom timer durations
2. 15 free overrides per month, then paid
3. Enhanced plan status display
4. Access to all core features

### For Elite Users:
1. All Pro features plus unlimited overrides
2. Advanced features like journaling (when implemented)
3. Extended usage history
4. Maximum device support

## Payment Integration

The extension redirects users to `http://localhost:3000` for payment processing with the following URL structure:

```
http://localhost:3000/payment?plan=pro&amount=4.99&user=USER_ID
```

This allows for external payment processing while maintaining security and PCI compliance.

## Future Enhancements

### Planned Features:
1. **Journaling System**: Override reason tracking for Elite users
2. **Usage Analytics**: Detailed blocking and override statistics
3. **Device Management**: Sync across multiple devices
4. **Advanced Scheduling**: Time-based blocking rules
5. **Team Plans**: Family or organization subscriptions

### Technical Improvements:
1. **Real Firestore Integration**: Currently uses demo data
2. **Payment Webhooks**: Automatic subscription updates
3. **Offline Support**: Cached plan data for offline use
4. **Plan Downgrade**: Graceful handling of plan downgrades

## Testing the Subscription System

### To Test Different Plans:
1. Modify the `loadUserSubscription()` method in `subscription-service.js`
2. Return different plan objects to simulate Pro/Elite subscriptions
3. Test domain limits, timer restrictions, and override functionality

### Test Scenarios:
1. **Free Plan Limits**: Try adding 4+ domains, using custom timers
2. **Override Flow**: Block a site and test override button
3. **Plan Upgrades**: Click subscription button and test upgrade flow
4. **UI Updates**: Verify plan status updates correctly

## Security Considerations

- All subscription data should be validated server-side
- Payment processing is handled externally for security
- User plan verification should be done on each critical action
- Override costs should be confirmed before processing

## Support and Documentation

For users experiencing subscription issues:
1. Check plan status in the extension popup
2. Verify payment processing at localhost:3000
3. Contact support for plan-related questions
4. Review usage limits in the plan comparison modal

---

This subscription system provides a solid foundation for monetizing the Limitter extension while delivering clear value at each tier. 