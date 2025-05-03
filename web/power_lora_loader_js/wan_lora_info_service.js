// Simple LoRA info service for WanVideo extension
// Provides basic LoRA information without rgthree API dependency

class WanLoraInfoService {
    constructor() {
        this.fileToInfo = new Map();
    }

    async getInfo(file) {
        if (this.fileToInfo.has(file)) {
            return this.fileToInfo.get(file);
        }
        return this.fetchInfo(file);
    }

    async fetchInfo(file) {
        try {
            // Use ComfyUI's object_info endpoint to get available models
            const response = await fetch("/object_info");
            const objectInfo = await response.json();

            // Basic info structure
            const info = {
                file: file,
                name: file ? file.replace(/\.(safetensors|ckpt|pth)$/i, '') : '',
                type: 'LoRA',
                baseModel: '',
                sha256: '',
                strengthMin: '',
                strengthMax: '',
                userNote: '',
                trainedWords: [],
                images: [],
                raw: {
                    metadata: {}
                }
            };

            // Try to get more specific info if available
            // This is a simplified version - could be enhanced with metadata parsing
            this.fileToInfo.set(file, info);
            return info;
        } catch (error) {
            console.error("Error fetching LoRA info:", error);
            // Return basic info even on error
            const basicInfo = {
                file: file,
                name: file ? file.replace(/\.(safetensors|ckpt|pth)$/i, '') : '',
                type: 'LoRA',
                baseModel: '',
                sha256: '',
                strengthMin: '',
                strengthMax: '',
                userNote: '',
                trainedWords: [],
                images: [],
                raw: {
                    metadata: {}
                }
            };
            this.fileToInfo.set(file, basicInfo);
            return basicInfo;
        }
    }

    async savePartialInfo(file, data) {
        let info = this.fileToInfo.get(file);
        if (info) {
            // Update the info with new data
            Object.assign(info, data);
            this.fileToInfo.set(file, info);
        }
        return info;
    }
}

export const WAN_LORA_INFO_SERVICE = new WanLoraInfoService();