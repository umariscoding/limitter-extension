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
            // Try to get stored device ID first
            const storedId = await this.getStoredDeviceId();
            if (storedId) {
                return {
                    device_id: storedId,
                    device_name: await this.getDeviceName(),
                    timestamp: Date.now()
                };
            }

            // Generate new device ID if none exists
            const newId = await this.generateNewDeviceId();
            return {
                device_id: newId,
                device_name: await this.getDeviceName(),
                timestamp: Date.now()
            };
        } catch (error) {
            console.error('Error getting device info:', error);
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
        const displayInfo = await this.getDisplayInfo();

        // Only use pure hardware identifiers
        const hardwareComponents = {
            cpu: {
                archName: systemInfo.cpu?.archName,
                modelName: systemInfo.cpu?.modelName,
                numOfProcessors: systemInfo.cpu?.numOfProcessors
            },
            memory: {
                totalCapacity: systemInfo.memory?.capacity
            },
            display: displayInfo ? {
                width: displayInfo[0]?.resolution?.width,
                height: displayInfo[0]?.resolution?.height,
                dpiX: displayInfo[0]?.dpiX,
                dpiY: displayInfo[0]?.dpiY
            } : null,
            gpu: {
                vendor: hardwareInfo.gpuVendor,
                renderer: hardwareInfo.gpuRenderer
            },
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory
        };

        // Generate a stable hash from hardware-specific components
        const deviceId = await this.createStableHash(hardwareComponents);
        
        // Store the device ID
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

    async getDisplayInfo() {
        try {
            if (chrome.system && chrome.system.display) {
                return new Promise((resolve) => {
                    chrome.system.display.getInfo((displays) => {
                        resolve(displays);
                    });
                });
            }
            return null;
        } catch (error) {
            console.warn('Error getting display info:', error);
            return null;
        }
    }

    async getDeviceName() {
        try {
            const systemInfo = await this.getSystemInfo();
            
            // Create a descriptive name using only hardware info
            const parts = [];
            
            // Add CPU info if available
            if (systemInfo.cpu?.modelName) {
                parts.push(systemInfo.cpu.modelName.split('@')[0].trim());
            }
            
            // Add memory
            if (systemInfo.memory?.capacity) {
                const gbRam = Math.round(systemInfo.memory.capacity / (1024 * 1024 * 1024));
                parts.push(`${gbRam}GB RAM`);
            }
            
            // Add GPU info if available
            const hardwareInfo = await this.getHardwareInfo();
            if (hardwareInfo.gpuVendor) {
                parts.push(hardwareInfo.gpuVendor);
            }
            
            return parts.join(' - ') || 'Unknown Device';
        } catch (error) {
            console.warn('Error generating device name:', error);
            return 'Unknown Device';
        }
    }

    async createStableHash(components) {
        // Convert components to a stable string (sort keys to ensure consistency)
        const stableString = JSON.stringify(components, Object.keys(components).sort());
        
        // Use SHA-256 for a stable, deterministic hash
        const encoder = new TextEncoder();
        const data = encoder.encode(stableString);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        
        // Convert to hex string
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async getBrowserInfo() {
        try {
            const screenInfo = await chrome.system.display.getInfo();
            const primaryDisplay = screenInfo.find(d => d.isPrimary) || screenInfo[0];
            
            return {
                screen: {
                    width: primaryDisplay.bounds.width,
                    height: primaryDisplay.bounds.height,
                    colorDepth: primaryDisplay.colorDepth,
                    pixelRatio: primaryDisplay.deviceScaleFactor,
                    orientation: primaryDisplay.rotation,
                    refreshRate: primaryDisplay.refreshRate,
                    dpiX: primaryDisplay.dpiX,
                    dpiY: primaryDisplay.dpiY
                }
            };
        } catch (error) {
            console.warn('Error getting display info:', error);
            return {};
        }
    }

    async getNetworkInfo() {
        try {
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            const networkInterfaces = await chrome.system.network.getNetworkInterfaces();
            
            return {
                connection: connection ? {
                    type: connection.type,
                    effectiveType: connection.effectiveType,
                    downlink: connection.downlink,
                    rtt: connection.rtt,
                    saveData: connection.saveData
                } : null,
                interfaces: networkInterfaces.map(net => ({
                    name: net.name,
                    type: net.type,
                    address: net.address,
                    prefixLength: net.prefixLength
                }))
            };
        } catch (error) {
            console.warn('Error getting network info:', error);
            return {};
        }
    }

    async getAudioFingerprint() {
        try {
            const audioCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
            const oscillator = audioCtx.createOscillator();
            const analyser = audioCtx.createAnalyser();
            const gainNode = audioCtx.createGain();
            const scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);

            gainNode.gain.value = 0;
            oscillator.type = 'triangle';
            oscillator.connect(analyser);
            analyser.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            oscillator.start(0);

            const audioData = new Float32Array(analyser.frequencyBinCount);
            analyser.getFloatFrequencyData(audioData);
            
            oscillator.stop();
            audioCtx.close();

            return Array.from(audioData.slice(0, 30));
        } catch (error) {
            console.warn('Error getting audio fingerprint:', error);
            return null;
        }
    }

    async getCanvasFingerprint() {
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 200;
            canvas.height = 200;

            // Draw various shapes and text
            ctx.textBaseline = 'top';
            ctx.font = '14px Arial';
            ctx.fillStyle = '#f60';
            ctx.fillRect(125, 1, 62, 20);
            ctx.fillStyle = '#069';
            ctx.fillText('Fingerprint', 2, 15);
            ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
            ctx.fillRect(30, 30, 80, 50);

            return canvas.toDataURL();
        } catch (error) {
            console.warn('Error getting canvas fingerprint:', error);
            return null;
        }
    }

    async getWebGLFingerprint() {
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            
            if (!gl) return null;

            return {
                vendor: gl.getParameter(gl.VENDOR),
                renderer: gl.getParameter(gl.RENDERER),
                version: gl.getParameter(gl.VERSION),
                shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
                extensions: gl.getSupportedExtensions()
            };
        } catch (error) {
            console.warn('Error getting WebGL fingerprint:', error);
            return null;
        }
    }

    async getSystemFonts() {
        try {
            // Use new Font API if available
            if (window.queryLocalFonts) {
                const fonts = await window.queryLocalFonts();
                return fonts.map(font => font.family);
            }
            
            // Fallback to checking common fonts
            const commonFonts = [
                'Arial', 'Times New Roman', 'Courier New', 'Helvetica',
                'Verdana', 'Georgia', 'Palatino', 'Garamond', 'Bookman',
                'Comic Sans MS', 'Trebuchet MS', 'Impact'
            ];

            const foundFonts = [];
            const testString = 'mmmmmmmmmmlli';
            const testSize = '72px';
            const baseFonts = ['monospace', 'sans-serif', 'serif'];
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            for (const font of commonFonts) {
                let matched = 0;
                for (const baseFont of baseFonts) {
                    ctx.font = `${testSize} ${baseFont}`;
                    const baseFontWidth = ctx.measureText(testString).width;
                    
                    ctx.font = `${testSize} ${font}, ${baseFont}`;
                    const testFontWidth = ctx.measureText(testString).width;
                    
                    if (baseFontWidth !== testFontWidth) {
                        matched++;
                    }
                }
                if (matched >= 2) {
                    foundFonts.push(font);
                }
            }
            
            return foundFonts;
        } catch (error) {
            console.warn('Error getting system fonts:', error);
            return null;
        }
    }

    async forceNewDeviceId() {
        // Clear any stored device ID
        await new Promise((resolve) => {
            chrome.storage.local.remove(['device_id', 'device_id_metadata'], resolve);
        });

        // Generate new device components with timestamp
        const timestamp = Date.now();
        const deviceComponents = await this.generateNewDeviceId();
        
        // Create a unique suffix
        const uniqueSuffix = Array.from(crypto.getRandomValues(new Uint8Array(8)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        
        // Combine components with timestamp and suffix
        const combinedComponents = {
            ...deviceComponents,
            timestamp,
            uniqueSuffix
        };

        // Generate new hash
        const deviceId = await this.createStableHash(combinedComponents);
        
        // Store the new device ID
        await this.storeDeviceId(deviceId);
        
        return deviceId;
    }
} 