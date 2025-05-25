# Smart Tab Blocker Chrome Extension

A Chrome extension that helps you stay focused by blocking any website with configurable timers. Features smart tracking that pauses when you switch tabs and resumes when you return, with individual timers for each domain.

## Features

- 🌐 **Multi-Domain Support**: Add any website with custom timer durations
- ⏰ **Configurable Timers**: Set individual time limits (1-300 seconds) for each domain
- 🔄 **Smart Tab Tracking**: Timer pauses when you switch away and resumes when you return
- 💾 **State Persistence**: Remembers remaining time even if you close and reopen tabs
- 🚫 **Modern Blocking Modal**: Beautiful, non-closable modal that matches the extension design
- 🎯 **Focus-oriented**: Motivational messages and productivity suggestions
- 📊 **Usage Tracking**: Keeps count of blocked sessions across all domains
- 🔄 **Easy Management**: Simple interface to add/remove domains and adjust timers
- 🎨 **Beautiful UI**: Modern gradient design with smooth animations
- 📱 **Responsive**: Works on all screen sizes

## How It Works

This extension provides smart, fair time management for any website:

1. **Domain Configuration**: Add any website (e.g., youtube.com, twitter.com, reddit.com) with custom timer
2. **Individual Timers**: Each domain gets its own timer duration (e.g., 10s for YouTube, 20s for Google)
3. **Smart Tracking**: Timer only counts down when the specific domain tab is active
4. **Independent Timers**: Multiple domains can run simultaneously with separate timers
5. **Auto Pause/Resume**: When you switch between domain tabs, their timers pause/resume accordingly
6. **State Memory**: Each domain remembers its remaining time across sessions

## Configuration

### Adding Domains
1. Click the extension icon in your Chrome toolbar
2. Enter a domain name (e.g., `youtube.com`, `twitter.com`)
3. Set timer duration in seconds (1-300)
4. Click "Add" to start tracking

### Managing Domains
- View all tracked domains in the popup
- See each domain's timer duration
- Remove domains with the "Remove" button
- Toggle all blocking on/off with the main switch

### Example Configurations
- `youtube.com` → 30 seconds (for entertainment)
- `twitter.com` → 15 seconds (for social media)
- `reddit.com` → 45 seconds (for discussions)
- `news.com` → 60 seconds (for news browsing)

## Timer Features

### Smart Tracking
- 🕒 **Domain-Specific**: Each website has its own independent timer
- ⏸️ **Auto-Pause**: Timer pauses when you switch to other tabs
- ▶️ **Auto-Resume**: Timer continues exactly where it left off
- 💾 **Cross-Session Memory**: Remembers time for up to 5 minutes after leaving
- 🔄 **Multi-Domain**: Track multiple websites simultaneously

### Visual Indicators
- 📊 **Progress Bar**: Visual indicator of time remaining
- 🎨 **Dynamic Status**: Different colors and text for active/paused states
- ⚠️ **Urgency Alert**: Last 5 seconds highlighted with red color and animation
- 🎭 **Pause Animation**: Gray color and pulsing effect when paused
- 📱 **Mobile Responsive**: Timer adapts to different screen sizes

### Modern Modal Design
- 🎨 **Gradient Background**: Matches the extension's modern aesthetic
- 🔍 **Backdrop Blur**: Professional glassmorphism effect
- 📝 **Domain-Specific**: Shows which domain was blocked and for how long
- 💡 **Motivational Content**: Focus tips and productivity quotes
- 🚫 **Non-Closable**: Cannot be easily dismissed to maintain focus

## Installation

### Method 1: Load as Unpacked Extension

1. **Download or Clone** this repository to your computer
2. **Open Chrome** and navigate to `chrome://extensions/`
3. **Enable Developer Mode** by toggling the switch in the top-right corner
4. **Click "Load unpacked"** and select the folder containing the extension files
5. **Pin the extension** to your toolbar for easy access

## Usage

1. **Open the popup** by clicking the extension icon
2. **Add domains** you want to track:
   - Enter domain name (e.g., `youtube.com`)
   - Set timer duration (e.g., `20` seconds)
   - Click "Add"
3. **Enable blocking** with the main toggle switch
4. **Visit tracked websites** - you'll see domain-specific countdown timers
5. **Switch tabs freely** - each domain's timer pauses/resumes independently
6. **Get blocked** when time runs out - modern modal appears
7. **Manage domains** anytime in the popup interface

## Advanced Features

### Multi-Domain Management
- **Simultaneous Tracking**: Multiple domains can be active at once
- **Independent Timers**: Each domain has its own countdown
- **Domain Matching**: Supports subdomains (e.g., `youtube.com` matches `www.youtube.com`)
- **Flexible Configuration**: Different time limits for different site types

### Smart State Management
- **Per-Domain Storage**: Each domain saves its state separately
- **URL Preservation**: Timer continues for the same page across sessions
- **Automatic Cleanup**: Expired states are cleaned up automatically
- **Cross-Tab Sync**: Domain timers work across multiple tabs of the same site

## Files Structure

```
smart-tab-blocker/
├── manifest.json          # Extension configuration (v3)
├── background.js          # Background service worker
├── content.js            # Domain-agnostic content script
├── content.css           # Styles for blocking modal
├── popup.html            # Modern domain management interface
├── popup.js              # Domain configuration functionality
├── icons/                # Extension icons
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md            # This file
```

## Technical Details

- **Manifest Version**: 3 (latest Chrome extension standard)
- **Domain Detection**: Works with any valid domain or subdomain
- **Timer Range**: 1-300 seconds per domain
- **Content Script**: Injected into all URLs, activates only for tracked domains
- **Storage**: Chrome sync storage for domain configuration, local storage for timer states
- **Permissions**: 
  - `tabs` - to detect domain visits and manage existing tabs
  - `storage` - to save domain configurations and timer states
  - `notifications` - for blocking notifications
  - `scripting` - to inject scripts into existing tabs
- **Background Script**: Manages domain configuration and handles cross-tab communication

## Supported Domain Types

- **Standard domains**: `example.com`
- **Subdomains**: `www.example.com`, `mail.google.com`
- **Popular sites**: `youtube.com`, `twitter.com`, `reddit.com`, `facebook.com`
- **Any valid domain**: The extension works with any website

## Customization

You can customize the extension by:

1. **Domain-Specific Timers**: Set different time limits for different types of sites
2. **Batch Configuration**: Add multiple domains with similar time limits
3. **Time Ranges**: Use short timers (5s) for highly distracting sites, longer (60s) for useful ones
4. **Regular Review**: Adjust timer durations based on your usage patterns

## Privacy & Security

This extension:
- ✅ Works completely offline after initial setup
- ✅ Only tracks domains you explicitly add
- ✅ Does not collect any personal data
- ✅ Does not send data to external servers
- ✅ Stores configuration locally in your browser
- ✅ No analytics or tracking

## Troubleshooting

### Timer doesn't start for a domain
- Check if the domain is correctly added (no protocols like `https://`)
- Ensure the extension is enabled with the main toggle
- Try refreshing the page after adding a new domain

### Timer shows wrong time
- Check if you're on the exact domain you configured
- Subdomains inherit parent domain settings
- Timer state expires after 5 minutes of inactivity

### Modal doesn't appear
- Ensure JavaScript is enabled on the website
- Check if other extensions are interfering
- Try disabling and re-enabling the extension

## Contributing

Feel free to:
- Add support for more domain patterns
- Suggest improvements to the timer logic
- Submit pull requests for better UI/UX
- Report bugs with domain detection
- Propose new productivity features

## Future Enhancements

Potential features:
- **Domain Categories**: Group similar sites with shared time limits
- **Time Banking**: Earn extra time through productive activities
- **Scheduling**: Different time limits based on time of day
- **Import/Export**: Share domain configurations
- **Statistics Dashboard**: Detailed usage analytics per domain

## License

This project is open source and available under the MIT License.

---

**Stay focused across the entire web! 🌐⏰**

*Now with configurable domains and individual timers - your productivity, your rules!* 