let fpPromise = null;

export class DeviceFingerprint {
    constructor() {
        if (!fpPromise) {
            fpPromise = this.initializeFingerprint();
        }
    }

    async initializeFingerprint() {
        // Only try to load FingerprintJS in window context
        if (typeof window !== 'undefined' && typeof document !== 'undefined') {
            return new Promise((resolve) => {
                const script = document.createElement('script');
                script.src = chrome.runtime.getURL('lib/fp.min.js');
                script.async = true;
                script.onload = () => {
                    // @ts-ignore
                    resolve(FingerprintJS.load());
                };
                document.head.appendChild(script);
            });
        }
        return Promise.resolve(null);
    }

    async getDeviceInfo() {
        try {
            // First, try to get the stored device ID
            let deviceId = await this.getStoredDeviceId();
            
            if (!deviceId) {
                // If no stored ID, generate a new one based on hardware
                deviceId = await this.generateNewDeviceId();
                // Store it for future use
                await this.storeDeviceId(deviceId);
            }

            // Get hardware and OS info for device name
            const hardwareInfo = await this.getHardwareInfo();
            const osInfo = this.getDetailedOSInfo();

            return {
                device_id: deviceId,
                device_type: osInfo.name,
                device_name: this.generateDeviceName(osInfo, hardwareInfo),
                last_logged_in: new Date().toISOString()
            };
        } catch (error) {
            console.error('Error getting device fingerprint:', error);
            throw error;
        }
    }

    async getStoredDeviceId() {
        try {
            // Try to get from system-wide storage first
            const systemId = await this.getSystemDeviceId();
            if (systemId) {
                return systemId;
            }

            // Fallback to chrome.storage.local
            return new Promise((resolve) => {
                chrome.storage.local.get(['device_id'], (result) => {
                    resolve(result.device_id || null);
                });
            });
        } catch (error) {
            console.warn('Error getting stored device ID:', error);
            return null;
        }
    }

    async getSystemDeviceId() {
        try {
            // Try to get system-specific identifiers
            const systemInfo = await this.getSystemInfo();
            if (systemInfo.machineId) {
                return systemInfo.machineId;
            }
            return null;
        } catch (error) {
            console.warn('Error getting system device ID:', error);
            return null;
        }
    }

    async getSystemInfo() {
        try {
            // Use chrome.system APIs if available
            const info = {};
            
            if (chrome.system && chrome.system.cpu) {
                const cpu = await new Promise(resolve => chrome.system.cpu.getInfo(resolve));
                info.cpu = {
                    archName: cpu.archName,
                    modelName: cpu.modelName,
                    numOfProcessors: cpu.numOfProcessors,
                    processors: cpu.processors.map(p => ({
                        usage: p.usage
                    }))
                };
            }

            if (chrome.system && chrome.system.memory) {
                const memory = await new Promise(resolve => chrome.system.memory.getInfo(resolve));
                info.memory = {
                    capacity: memory.capacity,
                    availableCapacity: memory.availableCapacity
                };
            }

            if (chrome.system && chrome.system.storage) {
                const storage = await new Promise(resolve => chrome.system.storage.getInfo(resolve));
                info.storage = storage.map(unit => ({
                    id: unit.id,
                    capacity: unit.capacity,
                    type: unit.type
                }));
            }

            return info;
        } catch (error) {
            console.warn('Error getting system info:', error);
            return {};
        }
    }

    async storeDeviceId(deviceId) {
        try {
            // Store in chrome.storage.local
            await new Promise((resolve) => {
                chrome.storage.local.set({ 
                    device_id: deviceId,
                    device_id_timestamp: Date.now()
                }, resolve);
            });
        } catch (error) {
            console.error('Error storing device ID:', error);
            throw error;
        }
    }

    async generateNewDeviceId() {
        // Get system-specific components that should be consistent across browsers
        const systemInfo = await this.getSystemInfo();
        const hardwareInfo = await this.getHardwareInfo();
        const osInfo = this.getDetailedOSInfo();

        const deviceComponents = {
            system: {
                cpu: systemInfo.cpu || {},
                memory: systemInfo.memory || {},
                storage: systemInfo.storage || []
            },
            hardware: {
                platform: navigator.platform,
                architecture: hardwareInfo.architecture,
                model: hardwareInfo.model
            },
            os: {
                name: osInfo.name,
                version: osInfo.version,
                architecture: osInfo.architecture
            }
        };

        // Generate a stable hash from system-specific components
        const deviceId = await this.createStableHash(deviceComponents);
        
        // Store the new device ID
        await this.storeDeviceId(deviceId);
        
        return deviceId;
    }

    async getHardwareInfo() {
        const info = {
            architecture: '',
            model: '',
            gpuVendor: '',
            gpuRenderer: ''
        };

        try {
            // Try to get CPU architecture and model
            if (navigator.userAgentData) {
                const platformInfo = await navigator.userAgentData.getHighEntropyValues(['architecture', 'platform', 'model']);
                info.architecture = platformInfo.architecture;
                info.model = platformInfo.model;
            }

            // Get system-specific GPU info if available
            if (chrome.system && chrome.system.display) {
                const displays = await new Promise(resolve => chrome.system.display.getInfo(resolve));
                if (displays && displays.length > 0) {
                    info.gpuVendor = displays[0].name || '';
                }
            }
        } catch (error) {
            console.warn('Error getting detailed hardware info:', error);
        }

        return info;
    }

    getDetailedOSInfo() {
        const userAgent = navigator.userAgent;
        const platform = navigator.platform;
        const info = {
            name: 'Unknown',
            version: '',
            architecture: ''
        };

        // Extract OS info from platform and userAgent
        if (platform.includes('Win')) {
            info.name = 'Windows';
            const match = userAgent.match(/Windows NT (\d+\.\d+)/);
            if (match) {
                info.version = match[1];
            }
        } else if (platform.includes('Mac')) {
            info.name = 'macOS';
            const match = userAgent.match(/Mac OS X (\d+[._]\d+[._]\d+)/);
            if (match) {
                info.version = match[1].replace(/_/g, '.');
            }
        } else if (platform.includes('Linux')) {
            info.name = 'Linux';
            if (userAgent.includes('Ubuntu')) {
                info.name = 'Ubuntu';
            } else if (userAgent.includes('Fedora')) {
                info.name = 'Fedora';
            }
        }

        // Get architecture from userAgentData if available
        if (navigator.userAgentData) {
            navigator.userAgentData.getHighEntropyValues(['architecture'])
                .then(ua => {
                    info.architecture = ua.architecture;
                })
                .catch(() => {
                    info.architecture = platform.includes('64') ? 'x86_64' : 'x86';
                });
        } else {
            info.architecture = platform.includes('64') ? 'x86_64' : 'x86';
        }

        return info;
    }

    generateDeviceName(osInfo, hardwareInfo) {
        const parts = [];
        
        // Add OS name and version
        if (osInfo.name !== 'Unknown') {
            parts.push(osInfo.name);
            if (osInfo.version) {
                parts.push(osInfo.version);
            }
        }
        
        // Add hardware model if available
        if (hardwareInfo.model) {
            parts.push(hardwareInfo.model);
        }
        
        // Add architecture
        if (osInfo.architecture) {
            parts.push(`(${osInfo.architecture})`);
        }
        
        return parts.join(' ') || 'Unknown Device';
    }

    async createStableHash(components) {
        // Convert components to a stable string representation
        const str = JSON.stringify(components, Object.keys(components).sort());
        
        // Use SubtleCrypto for consistent hashing
        const msgBuffer = new TextEncoder().encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        
        // Convert hash to hex string
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
} 