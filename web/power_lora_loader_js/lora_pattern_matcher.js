// LoRA Pattern Matching Utility
// Handles matching between high and low LoRA variants with various naming conventions

export class LoRaPatternMatcher {
    constructor() {
        // Define high and low tokens once
        this.highTokens = ['High', 'high', 'HIGH', 'h', 'H'];
        this.lowTokens = ['Low', 'low', 'LOW', 'l', 'L'];
        this.separators = ['-', '_', ' '];
    }

    /**
     * Main method to check if a LoRA has a corresponding low variant
     * @param {string} loraName - The name of the LoRA to check
     * @param {Array} loraNames - Array of all available LoRA names
     * @returns {Object} - Object with found status and variant name
     */
    checkLowLoraVariant(loraName, loraNames) {
        if (!loraName || loraName === "None") {
            return { found: false, variantName: null };
        }

        if (!loraNames || !loraNames.length) {
            return { found: false, variantName: null };
        }

        // Extract just the names from the cache objects for checking
        const loraNamesList = loraNames.map(l => typeof l === 'string' ? l : l.name);

        // Try different matching strategies in order
        let result = this.checkStandardPatterns(loraName, loraNamesList);
        if (result.found) return result;

        result = this.checkEmbeddedPatterns(loraName, loraNamesList);
        if (result.found) return result;

        result = this.checkSuffixIgnoringPatterns(loraName, loraNamesList);
        if (result.found) return result;

        return { found: false, variantName: null };
    }

    /**
     * Check standard prefix, suffix, and infix patterns
     * @param {string} loraName - The name of the LoRA to check
     * @param {Array} loraNames - Array of all available LoRA names
     * @returns {Object} - Object with found status and variant name
     */
    checkStandardPatterns(loraName, loraNames) {
        // Normalize backslashes to forward slashes for consistent path handling
        const normalizedLoraName = loraName.replace(/\\/g, '/');
        const normalizedLoraNames = loraNames.map(name => name.replace(/\\/g, '/'));
        
        const patterns = this.generatePatterns(this.highTokens);
        const lowPatterns = this.generatePatterns(this.lowTokens);

        // Check for infix patterns
        for (const highPattern of patterns.infixes) {
            if (normalizedLoraName.includes(highPattern)) {
                for (const lowPattern of lowPatterns.infixes) {
                    const expectedLowName = normalizedLoraName.replace(highPattern, lowPattern);
                    if (normalizedLoraName !== expectedLowName && normalizedLoraNames.includes(expectedLowName)) {
                        // Find the original name with the correct backslashes
                        const originalIndex = normalizedLoraNames.indexOf(expectedLowName);
                        return { found: true, variantName: loraNames[originalIndex] };
                    }
                }
            }
        }

        // Check for prefix patterns
        for (const highPattern of patterns.prefixes) {
            if (normalizedLoraName.startsWith(highPattern)) {
                for (const lowPattern of lowPatterns.prefixes) {
                    const expectedLowName = normalizedLoraName.replace(highPattern, lowPattern);
                    if (normalizedLoraName !== expectedLowName && normalizedLoraNames.includes(expectedLowName)) {
                        // Find the original name with the correct backslashes
                        const originalIndex = normalizedLoraNames.indexOf(expectedLowName);
                        return { found: true, variantName: loraNames[originalIndex] };
                    }
                }
            }
        }

        // Check for suffix patterns
        const nameWithoutExt = normalizedLoraName.substring(0, normalizedLoraName.lastIndexOf('.'));
        for (const highPattern of patterns.suffixes) {
            if (nameWithoutExt.endsWith(highPattern)) {
                for (const lowPattern of lowPatterns.suffixes) {
                    const expectedLowName = normalizedLoraName.replace(highPattern, lowPattern);
                    if (normalizedLoraName !== expectedLowName && normalizedLoraNames.includes(expectedLowName)) {
                        // Find the original name with the correct backslashes
                        const originalIndex = normalizedLoraNames.indexOf(expectedLowName);
                        return { found: true, variantName: loraNames[originalIndex] };
                    }
                }
            }
        }

        return { found: false, variantName: null };
    }

    /**
     * Check for embedded high/low tokens in compound words
     * @param {string} loraName - The name of the LoRA to check
     * @param {Array} loraNames - Array of all available LoRA names
     * @returns {Object} - Object with found status and variant name
     */
    checkEmbeddedPatterns(loraName, loraNames) {
        // Normalize backslashes to forward slashes for consistent path handling
        const normalizedLoraName = loraName.replace(/\\/g, '/');
        const normalizedLoraNames = loraNames.map(name => name.replace(/\\/g, '/'));
        
        for (const highToken of this.highTokens) {
            // Create regex that matches the high token with optional word boundaries and separators
            // This will match patterns like:
            // - _HighNoise- (separator before, none after)
            // - MainHigh (no separator before, word boundary after)
            // - -High- (separator before and after)
            const highRegex = new RegExp(`([\\/_\\-\\s]?|^)${highToken}([\\/_\\-\\s]?|$)`);
            
            if (highRegex.test(normalizedLoraName)) {
                for (const lowToken of this.lowTokens) {
                    // Replace the high token with low token while preserving separators
                    const expectedLowName = normalizedLoraName.replace(highRegex, `$1${lowToken}$2`);
                    
                    if (normalizedLoraName !== expectedLowName && normalizedLoraNames.includes(expectedLowName)) {
                        // Find the original name with the correct backslashes
                        const originalIndex = normalizedLoraNames.indexOf(expectedLowName);
                        return { found: true, variantName: loraNames[originalIndex] };
                    }
                }
            }
        }

        return { found: false, variantName: null };
    }

    /**
     * Check for matches by ignoring suffix differences (like rank numbers)
     * @param {string} loraName - The name of the LoRA to check
     * @param {Array} loraNames - Array of all available LoRA names
     * @returns {Object} - Object with found status and variant name
     */
    checkSuffixIgnoringPatterns(loraName, loraNames) {
        // Normalize backslashes to forward slashes for consistent path handling
        const normalizedLoraName = loraName.replace(/\\/g, '/');
        const nameWithoutExt = normalizedLoraName.substring(0, normalizedLoraName.lastIndexOf('.'));
        
        // Extract base name by removing common suffix patterns
        const baseNameMatch = nameWithoutExt.match(/^(.+?)(?:[_-]?rank\d+|[_-]v\d+|[_-]\d+|[_-]?[a-z]+\d+)?$/i);
        const baseName = baseNameMatch ? baseNameMatch[1] : nameWithoutExt;
        
        // First try the original method for backward compatibility
        for (const highToken of this.highTokens) {
            // Check if base name contains high token
            const highRegex = new RegExp(`([\\/_\\-\\s]?|^)${highToken}([\\/_\\-\\s]?|$)`);
            
            if (highRegex.test(baseName)) {
                for (const lowToken of this.lowTokens) {
                    // Replace high with low in base name
                    const lowBaseName = baseName.replace(highRegex, `$1${lowToken}$2`);
                    
                    // Now try to find actual LoRA files that start with this low base name
                    for (const loraFullName of loraNames) {
                        // Normalize backslashes to forward slashes for consistent path handling
                        const normalizedFullName = loraFullName.replace(/\\/g, '/');
                        const loraWithoutExt = normalizedFullName.substring(0, normalizedFullName.lastIndexOf('.'));
                        
                        // Check if this LoRA starts with our low base name
                        if (loraWithoutExt.startsWith(lowBaseName) && normalizedFullName !== normalizedLoraName) {
                            return { found: true, variantName: loraFullName };
                        }
                    }
                }
            }
        }
        
        // New method: Extract the prefix before HIGH/LOW and match with different suffixes
        // This handles cases like I2V_HIGH_kj and I2V_LOW_default
        for (const highToken of this.highTokens) {
            // Create regex to capture the prefix before the high token
            // This ensures we only check for the suffix once after HIGH
            const highPrefixRegex = new RegExp(`^(.+?)${highToken}(.*)$`, 'i');
            const highMatch = nameWithoutExt.match(highPrefixRegex);
            
            if (highMatch) {
                const prefix = highMatch[1];
                const suffix = highMatch[2]; // This captures everything after HIGH, like _kj
                
                // Check if we have multiple prefixes (indicated by multiple separators)
                const hasMultiplePrefixes = prefix.split(/[\\/_\\-\s]+/).filter(part => part.length > 0).length > 1;
                
                // Only apply this special matching for multiple prefixes
                if (hasMultiplePrefixes) {
                    for (const lowToken of this.lowTokens) {
                        // Try to find a LoRA with the same prefix but LOW token and potentially different suffix
                        for (const loraFullName of loraNames) {
                            // Normalize backslashes to forward slashes for consistent path handling
                            const normalizedFullName = loraFullName.replace(/\\/g, '/');
                            const loraWithoutExt = normalizedFullName.substring(0, normalizedFullName.lastIndexOf('.'));
                            
                            // Create regex to match the same prefix with LOW token and any suffix
                            // Using non-greedy match for prefix to ensure we only check suffix once after LOW
                            const lowRegex = new RegExp(`^${prefix}${lowToken}(.*)$`, 'i');
                            const lowMatch = loraWithoutExt.match(lowRegex);
                            
                            if (lowMatch && normalizedFullName !== normalizedLoraName) {
                                // We found a match with the same prefix but LOW token
                                return { found: true, variantName: loraFullName };
                            }
                        }
                    }
                }
            }
        }

        return { found: false, variantName: null };
    }

    /**
     * Generate pattern arrays for matching
     * @param {Array} tokens - Array of tokens to generate patterns for
     * @returns {Object} - Object with infixes, prefixes, and suffixes arrays
     */
    generatePatterns(tokens) {
        const infixes = [], prefixes = [], suffixes = [];
        
        for (const token of tokens) {
            for (const sep of this.separators) {
                prefixes.push(token + sep);
                suffixes.push(sep + token);
                infixes.push(sep + token + sep);
            }
        }
        
        return { infixes, prefixes, suffixes };
    }
}

// Create a singleton instance for reuse across the application
export const loraPatternMatcher = new LoRaPatternMatcher();