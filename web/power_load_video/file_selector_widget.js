/**
 * File Selector Widget for Power Load Video
 * Row 2 UI: [◀ name.mp4 ▶] [📤 Upload]
 *
 * Provides prev/next cycling, dropdown for file selection, and upload.
 * The hidden combo widget is the source of truth; this widget syncs with it.
 */
import { api } from '../../../scripts/api.js';
import { app } from '../../../scripts/app.js';
import { RgthreeBaseWidget, fitString } from '../power_spline_editor/drawing_utils.js';

export class PowerLoadVideoFileSelectorWidget extends RgthreeBaseWidget {
    constructor(node) {
        super("PowerLoadVideoFileSelector");
        this.type = "custom";
        this.options = { serialize: false };
        this.node = node;
        this.currentFilename = "";
        this.dropdownOpen = false;
        this.dropdownElement = null;
        this.uploadButtonMouseDown = false;
        this.showButtonMouseDown = false;
        this._closeDropdownHandler = null;

        this.hitAreas = {
            prevButton: { bounds: [0, 0], onClick: null },
            fileSelector: { bounds: [0, 0], onClick: null },
            nextButton: { bounds: [0, 0], onClick: null },
            showButton: { bounds: [0, 0], onClick: null, onDown: null, onUp: null },
            uploadButton: { bounds: [0, 0], onClick: null, onDown: null, onUp: null },
        };
    }

    /**
     * Update displayed filename (called from onConfigure after workflow load)
     */
    setCurrentFilename(filename) {
        this.currentFilename = filename || "";
    }

    /**
     * Get the hidden combo widget from the node
     */
    getComboWidget() {
        return this.node.widgets.find(w => w.type === 'combo');
    }

    /**
     * Get available video files from the combo widget's options
     */
    getAvailableFiles() {
        const combo = this.getComboWidget();
        if (combo && combo.options && combo.options.values) {
            return combo.options.values;
        }
        return [];
    }

    /**
     * Get current index in the file list (-1 if not found)
     */
    getCurrentFileIndex() {
        const files = this.getAvailableFiles();
        return files.indexOf(this.currentFilename);
    }

    /**
     * Select a file: update combo widget, file selector display, and load video
     */
    selectFile(filename) {
        this.currentFilename = filename;

        // Update the combo widget value (source of truth for backend)
        const combo = this.getComboWidget();
        if (combo) {
            combo.value = filename;
        }

        // Update node's videoFilename and widgets_values for serialization
        this.node.videoFilename = filename;
        if (!this.node.widgets_values || this.node.widgets_values.length === 0) {
            this.node.widgets_values = [filename];
        } else {
            this.node.widgets_values[0] = filename;
        }

        // Load the video into display
        if (typeof this.node.loadVideoIntoDisplay === 'function') {
            this.node.loadVideoIntoDisplay(filename);
        }

        this.closeDropdown();
        this.node.setDirtyCanvas(true, true);
    }

    /**
     * Select previous file in the list (wraps around)
     */
    selectPrevFile() {
        const files = this.getAvailableFiles();
        if (files.length === 0) return;
        let idx = this.getCurrentFileIndex();
        idx = idx <= 0 ? files.length - 1 : idx - 1;
        this.selectFile(files[idx]);
    }

    /**
     * Select next file in the list (wraps around)
     */
    selectNextFile() {
        const files = this.getAvailableFiles();
        if (files.length === 0) return;
        let idx = this.getCurrentFileIndex();
        idx = idx < 0 || idx >= files.length - 1 ? 0 : idx + 1;
        this.selectFile(files[idx]);
    }

    /**
     * Upload a video file via ComfyUI's API
     */
    async handleUpload(node) {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'video/*';
        fileInput.style.display = 'none';

        fileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file || !file.type.startsWith('video/')) return;

            try {
                const formData = new FormData();
                formData.append('image', file);
                formData.append('type', 'input');

                const resp = await api.fetchApi('/upload/image', {
                    method: 'POST', body: formData
                });

                if (resp.ok || resp.status === 200) {
                    const data = await resp.json();
                    const uploadedName = data.name || data.filename || file.name;

                    // Add to combo widget options if not already there
                    const combo = this.getComboWidget();
                    if (combo && combo.options && combo.options.values) {
                        if (!combo.options.values.includes(uploadedName)) {
                            combo.options.values.push(uploadedName);
                            combo.options.values.sort();
                        }
                    }

                    this.selectFile(uploadedName);
                } else {
                    console.error('[PowerLoadVideo] Upload failed:', resp.status, resp.statusText);
                }
            } catch (err) {
                console.error('[PowerLoadVideo] Upload error:', err);
            }
        };

        document.body.appendChild(fileInput);
        fileInput.click();
        document.body.removeChild(fileInput);
    }

    /**
     * Open the input directory in Windows Explorer
     */
    async openInputDir() {
        try {
            await api.fetchApi('/power_load_video/open_input_dir', { method: 'POST' });
        } catch (err) {
            console.error('[PowerLoadVideo] Failed to open input directory:', err);
        }
    }

    /**
     * Create/show the HTML dropdown overlay
     */
    openDropdown() {
        if (this.dropdownOpen) {
            this.closeDropdown();
            return;
        }

        const files = this.getAvailableFiles();
        if (files.length === 0) return;

        const dropdown = document.createElement('div');
        dropdown.className = 'power-load-video-dropdown';
        dropdown.style.cssText = `
            position: fixed;
            background-color: #1a1a1a;
            border: 1px solid #555;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 10000;
            min-width: 200px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        `;

        files.forEach(filename => {
            const item = document.createElement('div');
            item.textContent = filename;
            const isCurrent = filename === this.currentFilename;
            item.style.cssText = `
                padding: 6px 12px;
                cursor: pointer;
                color: ${isCurrent ? '#2cc6ff' : '#ccc'};
                font-size: 13px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                ${isCurrent ? 'background-color: #0d3b4a;' : ''}
            `;
            item.onmouseenter = () => {
                item.style.backgroundColor = '#333';
            };
            item.onmouseleave = () => {
                item.style.backgroundColor = isCurrent ? '#0d3b4a' : 'transparent';
            };
            item.onclick = (e) => {
                e.stopPropagation();
                this.selectFile(filename);
            };
            dropdown.appendChild(item);
        });

        // Position the dropdown below the file selector area on screen
        const screenBounds = this._getSelectorScreenBounds();
        dropdown.style.left = screenBounds.x + 'px';
        dropdown.style.top = screenBounds.y + 'px';
        dropdown.style.width = Math.max(screenBounds.width, 200) + 'px';

        document.body.appendChild(dropdown);
        this.dropdownElement = dropdown;
        this.dropdownOpen = true;

        // Close on outside click (delayed to prevent immediate close from the same click)
        setTimeout(() => {
            this._closeDropdownHandler = (e) => {
                if (!this.dropdownElement || !this.dropdownElement.contains(e.target)) {
                    this.closeDropdown();
                }
            };
            document.addEventListener('mousedown', this._closeDropdownHandler);
        }, 10);
    }

    /**
     * Get the file selector area's screen bounds for dropdown positioning
     */
    _getSelectorScreenBounds() {
        const canvas = app.canvas;
        const node = this.node;
        const margin = 15;
        const arrowWidth = 26;
        const spacing = 4;
        const showButtonWidth = 80;
        const uploadButtonWidth = 100;

        // Selector starts after left arrow
        const selectorX = margin + arrowWidth + spacing;

        // Get canvas transform (pan + zoom)
        const canvasEl = canvas.canvas;
        const rect = canvasEl.getBoundingClientRect();
        const ds = canvas.ds;

        // Convert node-local coordinates to screen coordinates
        const scale = ds?.scale || 1;
        const offsetX = ds?.offset?.[0] || 0;
        const offsetY = ds?.offset?.[1] || 0;

        const selectorWidth = node.size[0] - margin * 2 - arrowWidth * 2 - spacing * 4 - showButtonWidth - uploadButtonWidth;

        const screenX = rect.left + (node.pos[0] + selectorX + offsetX) * scale;
        const screenY = rect.top + (node.pos[1] + (this.last_y || 0) + offsetY) * scale + scale;
        const screenW = selectorWidth * scale;

        return { x: screenX, y: screenY, width: Math.max(screenW, 200) };
    }

    closeDropdown() {
        if (this.dropdownElement) {
            this.dropdownElement.remove();
            this.dropdownElement = null;
        }
        this.dropdownOpen = false;
        // Always remove the close handler when closing
        if (this._closeDropdownHandler) {
            document.removeEventListener('mousedown', this._closeDropdownHandler);
            this._closeDropdownHandler = null;
        }
    }

    draw(ctx, node, w, posY, height) {
        const margin = 15;
        const spacing = 4;
        const midY = posY + height * 0.5;
        const arrowWidth = 26;
        const showButtonWidth = 80;
        const uploadButtonWidth = 100;

        ctx.save();

        const assignBounds = (name, bounds) => {
            const area = this.hitAreas[name];
            if (!area) return;
            area.bounds = bounds;
            area.onClick = null;
            area.onDown = null;
            area.onUp = null;
        };

        // === LEFT ARROW (◀) ===
        const leftArrowX = margin;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = '#ccc';
        ctx.font = `${Math.max(14, height * 0.7)}px Sans-Serif`;
        ctx.fillText("\u25C4", leftArrowX + arrowWidth * 0.5, midY);
        assignBounds("prevButton", [leftArrowX, posY, arrowWidth, height]);

        // === FILE SELECTOR AREA (combo-style box with dropdown) ===
        const selectorX = leftArrowX + arrowWidth + spacing;
        const selectorWidth = node.size[0] - margin * 2 - arrowWidth * 2 - spacing * 4 - showButtonWidth - uploadButtonWidth;

        // Draw rounded background
        ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(selectorX, posY, selectorWidth, height, [height * 0.5]);
        ctx.fill();
        ctx.stroke();

        // Draw filename text (clipped)
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = this.currentFilename ? LiteGraph.WIDGET_TEXT_COLOR : '#888';
        ctx.font = `${Math.max(12, height * 0.6)}px Sans-Serif`;

        const displayText = this.currentFilename || "Select video...";
        const maxTextWidth = selectorWidth - 30;
        const fittedText = fitString(ctx, displayText, maxTextWidth);
        ctx.fillText(fittedText, selectorX + 12, midY);

        // Draw dropdown arrow
        ctx.textAlign = "right";
        ctx.fillStyle = '#aaa';
        ctx.font = `${Math.max(10, height * 0.5)}px Sans-Serif`;
        ctx.fillText("\u25BC", selectorX + selectorWidth - 10, midY);

        assignBounds("fileSelector", [selectorX, posY, selectorWidth, height]);

        // === RIGHT ARROW (▶) ===
        const rightArrowX = selectorX + selectorWidth + spacing;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = '#ccc';
        ctx.font = `${Math.max(14, height * 0.7)}px Sans-Serif`;
        ctx.fillText("\u25BA", rightArrowX + arrowWidth * 0.5, midY);
        assignBounds("nextButton", [rightArrowX, posY, arrowWidth, height]);

        // === SHOW BUTTON (opens input directory in Explorer) ===
        const showButtonX = rightArrowX + arrowWidth + spacing;
        ctx.fillStyle = this.showButtonMouseDown ? '#1a4a6a' : LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(showButtonX, posY, showButtonWidth, height);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.font = `${Math.max(12, height * 0.6)}px Sans-Serif`;
        ctx.fillText("\u{1F4C1} Show", showButtonX + showButtonWidth * 0.5, midY + (this.showButtonMouseDown ? 1 : 0));
        assignBounds("showButton", [showButtonX, posY, showButtonWidth, height]);

        // === UPLOAD BUTTON (right side) ===
        const uploadButtonX = showButtonX + showButtonWidth + spacing;
        ctx.fillStyle = this.uploadButtonMouseDown ? '#1a4a6a' : LiteGraph.WIDGET_BGCOLOR;
        ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(uploadButtonX, posY, uploadButtonWidth, height);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        ctx.font = `${Math.max(12, height * 0.6)}px Sans-Serif`;
        ctx.fillText("\u{1F4E4} Upload", uploadButtonX + uploadButtonWidth * 0.5, midY + (this.uploadButtonMouseDown ? 1 : 0));
        assignBounds("uploadButton", [uploadButtonX, posY, uploadButtonWidth, height]);

        // === EVENT HANDLERS ===
        this.hitAreas.prevButton.onClick = () => this.selectPrevFile();
        this.hitAreas.nextButton.onClick = () => this.selectNextFile();
        this.hitAreas.fileSelector.onClick = () => this.openDropdown();
        this.hitAreas.showButton.onClick = () => this.openInputDir();
        this.hitAreas.showButton.onDown = () => {
            this.showButtonMouseDown = true;
            node.setDirtyCanvas(true, false);
        };
        this.hitAreas.showButton.onUp = () => {
            this.showButtonMouseDown = false;
            node.setDirtyCanvas(true, false);
        };

        this.hitAreas.uploadButton.onClick = async () => {
            await this.handleUpload(node);
        };
        this.hitAreas.uploadButton.onDown = () => {
            this.uploadButtonMouseDown = true;
            node.setDirtyCanvas(true, false);
        };
        this.hitAreas.uploadButton.onUp = () => {
            this.uploadButtonMouseDown = false;
            node.setDirtyCanvas(true, false);
        };

        ctx.restore();
    }

    onMouseUp(event, pos, node) {
        super.onMouseUp(event, pos, node);
        this.uploadButtonMouseDown = false;
        this.showButtonMouseDown = false;
    }

    computeSize(width) {
        return [width, LiteGraph.NODE_WIDGET_HEIGHT];
    }
}
