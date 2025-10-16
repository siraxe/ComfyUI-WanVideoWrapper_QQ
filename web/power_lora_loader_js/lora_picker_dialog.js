import { app } from "../../../scripts/app.js";

// Function to show context menu for LoRA list items
function showLoraListContextMenu(event, loraName) {
    console.log("[LoraPickerDialog] Opening context menu for:", loraName); // Debug log
    // Remove any existing context menu
    const existingMenu = document.getElementById('lora-list-context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.id = 'lora-list-context-menu';
    menu.className = 'litegraph litecontextmenu litemenubar-panel';
    menu.style.cssText = `
        position: absolute !important;
        left: ${event.clientX}px !important;
        top: ${event.clientY}px !important;
        background-color: #1a1a1a !important;
        border: 1px solid #000 !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
        z-index: 10000 !important;
        padding: 4px !important;
        border-radius: 0px !important;
        min-width: 120px !important;
        display: block !important;
        font-family: Arial, sans-serif !important;
        font-size: 11px !important;
    `;

    // Helper to create menu item
    const createMenuItem = (icon, text, onClick) => {
        const item = document.createElement('div');
        item.style.cssText = `
            padding: 4px 8px !important;
            cursor: pointer !important;
            color: #ddd !important;
            background-color: #1a1a1a !important;
            user-select: none !important;
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
        `;

        item.onmouseover = () => {
            item.style.backgroundColor = '#2a2a2a';
        };
        item.onmouseout = () => {
            item.style.backgroundColor = '#1a1a1a';
        };
        item.onclick = (e) => {
            e.stopPropagation();
            onClick();
            menu.remove();
            document.removeEventListener('click', hideMenu);
            document.removeEventListener('contextmenu', hideMenu);
        };

        const iconSpan = document.createElement('span');
        iconSpan.textContent = icon;
        iconSpan.style.cssText = `
            font-size: 12px !important;
            width: 16px !important;
            text-align: center !important;
        `;

        const textSpan = document.createElement('span');
        textSpan.textContent = text;

        item.appendChild(iconSpan);
        item.appendChild(textSpan);

        return item;
    };

    // Add menu items
    menu.appendChild(createMenuItem('ℹ️', 'Show Info', () => {
        showLoraInfoDialog(loraName);
    }));

    document.body.appendChild(menu);

    // Prevent menu close when interacting with menu
    menu.onclick = (e) => e.stopPropagation();
    menu.onmousedown = (e) => e.stopPropagation();

    // Hide menu when clicking outside
    const hideMenu = (e) => {
        if (menu && !menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', hideMenu);
            document.removeEventListener('contextmenu', hideMenu);
            document.removeEventListener('mousedown', hideMenu);
        }
    };

    // Add listeners after a short delay to prevent immediate closure
    setTimeout(() => {
        document.addEventListener('click', hideMenu);
        document.addEventListener('contextmenu', hideMenu);
        document.addEventListener('mousedown', hideMenu);
    }, 100);
}

// Function to show LoRA info dialog
function showLoraInfoDialog(loraName) {
    // Import and show the LoRA info dialog
    import("./dialog_info.js").then(({ WanLoraInfoDialog }) => {
        const infoDialog = new WanLoraInfoDialog(loraName).show();
        infoDialog.addEventListener("close", ((e) => {
            if (e.detail.dirty) {
                // Dialog was modified, could trigger refresh if needed
                console.log("LoRA info was modified");
            }
        }));
    }).catch(error => {
        // Fallback to simple alert if dialog fails to load
        console.error("Failed to load LoRA info dialog:", error);
        const loraInfo = `LoRA Information:

File: ${loraName}`;
        alert(loraInfo);
    });
}

const style = document.createElement('style');
style.textContent = `
.lora-picker-dialog {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translate(-50%, 0);
    background-color: #1a1a1a !important;
    border: 1px solid #000 !important;
    box-shadow: 0 2px 6px rgba(0,0,0,0.8) !important;
    z-index: 10000 !important;
    padding: 10px !important;
    border-radius: 0px !important;
    width: calc(25vw + 150px) !important; /* Width + sidebar width */
    min-width: 550px; /* Increased min-width */
    max-height: 80vh;
    display: flex !important;
    flex-direction: column !important;
    font-family: Arial, sans-serif !important;
    font-size: 12px !important;
    color: #ddd !important;
    overflow: hidden !important;
}

.lora-picker-content-wrapper {
    display: flex !important;
    flex: 1 !important;
    overflow: hidden !important;
}

.lora-picker-sidebar {
    width: 150px !important; /* Will be updated dynamically */
    background-color: #222 !important;
    border-right: 1px solid #000 !important;
    flex-shrink: 0 !important;
    display: flex !important;
    flex-direction: column !important;
    transition: width 0.2s ease !important;
}

.lora-picker-sidebar.collapsed {
    width: 0 !important;
    overflow: hidden !important;
}

.lora-picker-sidebar-content {
    flex: 1 !important;
    overflow-y: auto !important;
    padding: 2px 0px !important;
}

.lora-picker-folder-item {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    padding: 2px 4px !important;
    cursor: pointer !important;
    border-radius: 0px !important;
    transition: background-color 0.2s !important;
    margin: 0 !important;
    border-left: 2px solid transparent !important;
    border-right: 2px solid transparent !important;
}

.lora-picker-folder-item:hover {
    background-color: #333 !important;
}

.lora-picker-folder-item.selected {
    background-color: #2a2a2a !important;
    border-left: 2px solid #89B !important;
    border-right: 2px solid #89B !important;
}

.lora-picker-folder-icon {
    font-size: 12px !important;
    margin-right: 4px !important;
    color: #89B !important;
    flex-shrink: 0 !important;
}

.lora-picker-folder-name {
    font-size: 11px !important;
    text-align: left !important;
    color: #ddd !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    user-select: none !important;
    flex: 1 !important;
}

.lora-picker-main-content {
    flex: 1 !important;
    display: flex !important;
    flex-direction: column !important;
    overflow: hidden !important;
}

.lora-picker-header {
    display: flex !important;
    gap: 10px !important;
    margin-bottom: 10px !important;
}

.lora-picker-header input {
    width: 100% !important;
    padding: 4px 6px !important;
    background-color: #1a1a1a !important;
    border: 1px solid #333 !important;
    color: #ddd !important;
    font-family: Arial, sans-serif !important;
    font-size: 12px !important;
    outline: none !important;
}

.lora-picker-header select {
    width: 80px !important;
    padding: 4px 6px !important;
    background-color: #1a1a1a !important;
    border: 1px solid #333 !important;
    color: #ddd !important;
    font-family: Arial, sans-serif !important;
    font-size: 12px !important;
    outline: none !important;
}

.lora-picker-header input:focus, .lora-picker-header select:focus {
    border-color: #555 !important;
    background-color: #222 !important;
}

.lora-picker-content {
    display: flex !important;
    flex-direction: column !important;
    height: calc(100% - 40px) !important; /* Account for header height */
    overflow: hidden !important;
}

.lora-picker-folder-area {
    background-color: #222 !important;
    border: 1px solid #333 !important;
    padding: 8px !important;
    margin-bottom: 8px !important;
    overflow-y: auto !important;
    display: none !important;
    height: 100px !important; /* Fixed height in pixels */
    flex-shrink: 0 !important;
}

.lora-picker-folder-area.visible {
    display: block !important;
}

.lora-picker-folder-grid {
    display: grid !important;
    grid-template-columns: repeat(5, 1fr) !important;
    gap: 8px !important;
    padding: 4px !important;
    min-height: 0 !important;
}


.lora-picker-list-container {
    flex: 1 !important;
    overflow: hidden !important;
    min-height: 0 !important;
    display: flex !important;
    flex-direction: column !important;
}

.lora-picker-list {
    list-style: none !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow-y: auto !important;
    height: 100% !important;
    flex: 1 !important;
}

.lora-picker-list li {
    padding: 6px 8px !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    user-select: none !important;
}

.lora-picker-list li:hover {
    background-color: #2a2a2a !important;
}

.lora-picker-list .favorite-star {
    cursor: pointer !important;
    font-size: 16px !important;
    user-select: none !important;
}
`;
document.head.appendChild(style);

// Persistence functions for favorites only state
function saveFavoritesOnly(favoritesOnly) {
    localStorage.setItem("wanVideoPowerLoraLoader.favoritesOnly", JSON.stringify(favoritesOnly));
}

function loadFavoritesOnly() {
    const favoritesOnly = localStorage.getItem("wanVideoPowerLoraLoader.favoritesOnly");
    return favoritesOnly !== null ? JSON.parse(favoritesOnly) : false;
}

// Persistence functions for folder toggle state
function saveFoldersVisible(foldersVisible) {
    localStorage.setItem("wanVideoPowerLoraLoader.foldersVisible", JSON.stringify(foldersVisible));
}

function loadFoldersVisible() {
    const foldersVisible = localStorage.getItem("wanVideoPowerLoraLoader.foldersVisible");
    return foldersVisible !== null ? JSON.parse(foldersVisible) : false;
}

// Persistence functions for selected folder
function saveSelectedFolder(selectedFolder) {
    localStorage.setItem("wanVideoPowerLoraLoader.selectedFolder", JSON.stringify(selectedFolder));
}

function loadSelectedFolder() {
    const selectedFolder = localStorage.getItem("wanVideoPowerLoraLoader.selectedFolder");
    return selectedFolder !== null ? JSON.parse(selectedFolder) : null;
}

export class LoraPickerDialog {
    constructor(loras, options = {}) {
        // Filter out any "None" entries from the loras list
        this.loras = (loras || []).filter(l => {
            const name = typeof l === 'string' ? l : l.name;
            return name && name.toLowerCase() !== "none";
        });
        this.options = options;
        this.element = null;
        this.refreshCallback = options.refreshCallback || null;
        // Sidebar width configuration - change this value to adjust width
        this.sidebarWidth = 150;
        // Load favorites only state from persistence if not provided
        if (this.options.favoritesOnly === undefined) {
            this.options.favoritesOnly = loadFavoritesOnly();
        }
        // Load folders visible state from persistence if not provided
        if (this.options.foldersVisible === undefined) {
            this.options.foldersVisible = loadFoldersVisible();
        }
        // Load selected folder from persistence
        this.selectedFolder = loadSelectedFolder();
        // Extract folders from lora list
        this.folders = this.extractFolders();
    }

    show() {
        // Create overlay
        this.overlay = document.createElement("div");
        this.overlay.className = "lora-picker-overlay";
        this.overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 999;
        `;
        this.overlay.addEventListener("click", () => this.close());
        document.body.appendChild(this.overlay);

        // Create dialog element
        this.element = document.createElement("div");
        this.element.className = "lora-picker-dialog";

        // Add header
        const header = this.createHeader();
        this.element.appendChild(header);

        // Create content wrapper with sidebar and main content
        const contentWrapper = document.createElement("div");
        contentWrapper.className = "lora-picker-content-wrapper";
        
        // Create sidebar
        this.sidebar = document.createElement("div");
        this.sidebar.className = "lora-picker-sidebar";
        if (!this.options.foldersVisible) {
            this.sidebar.classList.add("collapsed");
        }
        
        // Set dynamic width
        this.sidebar.style.width = this.options.foldersVisible ? `${this.sidebarWidth}px` : '0px';
        
        // Create sidebar content with folders (no header)
        const sidebarContent = document.createElement("div");
        sidebarContent.className = "lora-picker-sidebar-content";
        this.renderFoldersInSidebar(sidebarContent);
        this.sidebar.appendChild(sidebarContent);
        
        // Create main content container
        this.mainContent = document.createElement("div");
        this.mainContent.className = "lora-picker-main-content";
        
        // Add content area with list (folder area removed)
        const content = this.createContentWithoutFolders();
        this.mainContent.appendChild(content);
        
        // Create invisible clickable zone between sidebar and main content
        const toggleZone = document.createElement("div");
        toggleZone.style.position = "absolute";
        toggleZone.style.left = this.options.foldersVisible ? `${this.sidebarWidth + 3}px` : "3px";
        toggleZone.style.top = "45px"; // Position below the header area
        toggleZone.style.width = "12px";
        toggleZone.style.height = "calc(100% - 50px)"; // Leave space at top for header
        toggleZone.style.zIndex = "10";
        toggleZone.style.cursor = "pointer";
        // Add click handler to toggle sidebar
        toggleZone.addEventListener("click", (e) => {
            e.stopPropagation(); // Prevent event bubbling
            this.options.foldersVisible = !this.options.foldersVisible;
            const foldersContainer = this.element.querySelector(".lora-picker-header > div:nth-child(4)");
            if (foldersContainer) {
                const foldersText = foldersContainer.querySelector("span");
                const indicatorLine = foldersContainer.querySelector("div[style*='position: absolute']");
                foldersText.style.color = this.options.foldersVisible ? "#4488bb" : "#aaa";
                foldersContainer.style.backgroundColor = this.options.foldersVisible ? "#2a2a2a" : "#1a1a1a";
                indicatorLine.style.display = (this.selectedFolder && this.selectedFolder !== "root" && !this.options.foldersVisible) ? "block" : "none";
            }
            saveFoldersVisible(this.options.foldersVisible);
            this.toggleSidebar();
        });

        // Assemble the dialog
        contentWrapper.appendChild(this.sidebar);
        contentWrapper.appendChild(this.mainContent);
        contentWrapper.appendChild(toggleZone);
        this.element.appendChild(contentWrapper);

        // Add to body
        document.body.appendChild(this.element);
        
        // Focus on the search input automatically
        setTimeout(() => {
            const searchInput = this.element.querySelector("input[type=text]");
            if (searchInput) {
                searchInput.focus();
            }
        }, 10);
        
        // Add keyboard listener for R key to refresh
        this.keydownHandler = (e) => {
            if (e.key === 'R' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                if (this.refreshCallback) {
                    this.refreshCallback();
                }
            }
        };
        document.addEventListener('keydown', this.keydownHandler);
    }

    createHeader() {
        const header = document.createElement("div");
        header.className = "lora-picker-header";

        // Search input
        const searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.placeholder = "Search (multiple words supported)...";
        searchInput.addEventListener("input", () => this.renderList());
        header.appendChild(searchInput);

        // Sort dropdown
        const sortDropdown = document.createElement("select");
        const sortOptions = ["Latest", "Oldest", "A-Z", "Z-A"];
        for (const option of sortOptions) {
            const opt = document.createElement("option");
            opt.value = option;
            opt.textContent = option;
            if (this.options.sort === option) {
                opt.selected = true;
            }
            sortDropdown.appendChild(opt);
        }
        sortDropdown.addEventListener("change", (e) => {
            this.options.sort = e.target.value;
            this.renderList();
        });
        header.appendChild(sortDropdown);

        // Add refresh button
        const refreshContainer = document.createElement("div");
        refreshContainer.style.display = "flex";
        refreshContainer.style.alignItems = "center";
        refreshContainer.style.gap = "5px";
        refreshContainer.style.cursor = "pointer";
        refreshContainer.style.margin = "0 10px";
        refreshContainer.style.padding = "4px 8px";
        refreshContainer.style.borderRadius = "4px";
        refreshContainer.style.backgroundColor = "#1a1a1a";
        refreshContainer.style.userSelect = "none";
        refreshContainer.title = "Refresh LoRA List (R)";
        
        const refreshIcon = document.createElement("span");
        refreshIcon.textContent = "↻";
        refreshIcon.style.fontSize = "14px";
        refreshIcon.style.color = "#aaa";
        refreshIcon.style.userSelect = "none";
        
        refreshContainer.appendChild(refreshIcon);
        
        refreshContainer.addEventListener("click", () => {
            if (this.refreshCallback) {
                this.refreshCallback();
            }
        });
        
        header.appendChild(refreshContainer);

        // Folders button
        const foldersContainer = document.createElement("div");
        foldersContainer.style.display = "flex";
        foldersContainer.style.alignItems = "center";
        foldersContainer.style.gap = "5px";
        foldersContainer.style.cursor = "pointer";
        foldersContainer.style.margin = "0 10px";
        foldersContainer.style.padding = "4px 8px";
        foldersContainer.style.borderRadius = "4px";
        foldersContainer.style.backgroundColor = this.options.foldersVisible ? "#2a2a2a" : "#1a1a1a";
        foldersContainer.style.userSelect = "none";
        foldersContainer.style.position = "relative";
        
        const foldersText = document.createElement("span");
        foldersText.textContent = "Folders";
        foldersText.style.color = this.options.foldersVisible ? "#4488bb" : "#aaa";
        foldersText.style.userSelect = "none";
        
        // Add blue gradient indicator line positioned at the bottom inside the button
        const indicatorLine = document.createElement("div");
        indicatorLine.style.position = "absolute";
        indicatorLine.style.bottom = "0";
        indicatorLine.style.left = "50%";
        indicatorLine.style.transform = "translateX(-50%)";
        indicatorLine.style.height = "1px";
        indicatorLine.style.width = "70%";
        indicatorLine.style.background = "linear-gradient(to right, transparent 0%, rgba(68, 136, 187, 0.2) 10%, rgba(68, 136, 187, 0.5) 20%, rgba(68, 136, 187, 0.8) 30%, #4488bb 40%, #4488bb 60%, rgba(68, 136, 187, 0.8) 70%, rgba(68, 136, 187, 0.5) 80%, rgba(68, 136, 187, 0.2) 90%, transparent 100%)";
        indicatorLine.style.borderRadius = "0.5px";
        indicatorLine.style.display = (this.selectedFolder && this.selectedFolder !== "root" && !this.options.foldersVisible) ? "block" : "none";
        
        foldersContainer.appendChild(foldersText);
        foldersContainer.appendChild(indicatorLine);
        
        foldersContainer.addEventListener("click", () => {
            this.options.foldersVisible = !this.options.foldersVisible;
            foldersText.style.color = this.options.foldersVisible ? "#4488bb" : "#aaa";
            foldersContainer.style.backgroundColor = this.options.foldersVisible ? "#2a2a2a" : "#1a1a1a";
            // Update indicator line visibility
            indicatorLine.style.display = (this.selectedFolder && this.selectedFolder !== "root" && !this.options.foldersVisible) ? "block" : "none";
            // Save to persistence
            saveFoldersVisible(this.options.foldersVisible);
            this.toggleSidebar();
        });
        
        header.appendChild(foldersContainer);

        // Favorites star
        const favoritesContainer = document.createElement("div");
        favoritesContainer.style.display = "flex";
        favoritesContainer.style.alignItems = "center";
        favoritesContainer.style.gap = "5px";
        favoritesContainer.style.cursor = "pointer";
        favoritesContainer.style.margin = "0 10px";
        favoritesContainer.style.padding = "4px 8px";
        favoritesContainer.style.borderRadius = "4px";
        favoritesContainer.style.backgroundColor = this.options.favoritesOnly ? "#2a2a2a" : "#1a1a1a";
        favoritesContainer.style.userSelect = "none";
        
        const favoritesStar = document.createElement("span");
        favoritesStar.className = "favorite-star";
        favoritesStar.textContent = "★";
        const isFavoritesOnly = this.options.favoritesOnly || false;
        favoritesStar.style.color = isFavoritesOnly ? "orange" : "#555";
        favoritesStar.style.userSelect = "none";
        
        const favoritesText = document.createElement("span");
        favoritesText.textContent = "Favorites";
        favoritesText.style.color = isFavoritesOnly ? "#89B" : "#aaa";
        favoritesText.style.userSelect = "none";
        
        favoritesContainer.appendChild(favoritesStar);
        favoritesContainer.appendChild(favoritesText);
        
        favoritesContainer.addEventListener("click", () => {
            this.options.favoritesOnly = !this.options.favoritesOnly;
            favoritesStar.style.color = this.options.favoritesOnly ? "orange" : "#555";
            favoritesText.style.color = this.options.favoritesOnly ? "#89B" : "#aaa";
            favoritesContainer.style.backgroundColor = this.options.favoritesOnly ? "#2a2a2a" : "#1a1a1a";
            // Save to persistence
            saveFavoritesOnly(this.options.favoritesOnly);
            this.renderList();
        });
        
        header.appendChild(favoritesContainer);

        return header;
    }

    createContent() {
        const content = document.createElement("div");
        content.className = "lora-picker-content";
        
        // Create list container
        const listContainer = document.createElement("div");
        listContainer.className = "lora-picker-list-container";
        
        // Create lora list
        this.list = document.createElement("ul");
        this.list.className = "lora-picker-list";
        this.renderList();
        listContainer.appendChild(this.list);
        
        content.appendChild(listContainer);
        
        return content;
    }
    
    createContentWithoutFolders() {
        const content = document.createElement("div");
        content.className = "lora-picker-content";
        
        // Create list container
        const listContainer = document.createElement("div");
        listContainer.className = "lora-picker-list-container";
        
        // Create lora list
        this.list = document.createElement("ul");
        this.list.className = "lora-picker-list";
        this.renderList();
        listContainer.appendChild(this.list);
        
        content.appendChild(listContainer);
        
        return content;
    }

    toggleSidebar() {
        if (this.options.foldersVisible) {
            this.sidebar.classList.remove("collapsed");
            this.sidebar.style.width = `${this.sidebarWidth}px`;
        } else {
            this.sidebar.classList.add("collapsed");
            this.sidebar.style.width = '0px';
        }
        // Update toggle zone position
        const toggleZone = this.element.querySelector("div[style*='z-index: 10']");
        if (toggleZone) {
            toggleZone.style.left = this.options.foldersVisible ? `${this.sidebarWidth + 3}px` : "3px";
        }
    }
    
    renderFoldersInSidebar(container) {
        container.innerHTML = "";
        
        for (const folder of this.folders) {
            const folderItem = document.createElement("div");
            folderItem.className = "lora-picker-folder-item";
            if (this.selectedFolder === folder) {
                folderItem.classList.add("selected");
            }
            
            // Folder icon
            const folderIcon = document.createElement("div");
            folderIcon.className = "lora-picker-folder-icon";
            folderIcon.textContent = "📁";
            
            // Folder name
            const folderName = document.createElement("div");
            folderName.className = "lora-picker-folder-name";
            folderName.textContent = folder;
            
            folderItem.appendChild(folderIcon);
            folderItem.appendChild(folderName);
            
            // Add click handler
            folderItem.addEventListener("click", () => {
                this.selectFolder(folder);
            });
            
            container.appendChild(folderItem);
        }
    }

    extractFolders() {
        const folderSet = new Set();
        // Always add "root" folder
        const folders = ["root"];
        
        // Extract folder names from lora list
        for (const lora of this.loras) {
            const name = typeof lora === 'string' ? lora : lora.name;
            // Check for both forward slash and backslash
            if (name && (name.includes('/') || name.includes('\\'))) {
                const folderName = name.split(/[\/\\]/)[0];
                if (folderName && !folderSet.has(folderName)) {
                    folderSet.add(folderName);
                    folders.push(folderName);
                }
            }
        }
        
        // Sort folders alphabetically (keeping "root" first)
        return folders.sort((a, b) => {
            if (a === "root") return -1;
            if (b === "root") return 1;
            return a.localeCompare(b);
        });
    }


    selectFolder(folderName) {
        // Check if clicking on already selected folder - if so, unselect it
        if (this.selectedFolder === folderName) {
            const prevSelected = this.sidebar.querySelector(".lora-picker-folder-item.selected");
            if (prevSelected) {
                prevSelected.classList.remove("selected");
            }
            this.selectedFolder = null;
            // Save to persistence
            saveSelectedFolder(null);
            // Update indicator line visibility
            this.updateFolderIndicator();
            this.renderList(); // Refresh the list
            return;
        }
        
        // Remove selection from previous folder
        const prevSelected = this.sidebar.querySelector(".lora-picker-folder-item.selected");
        if (prevSelected) {
            prevSelected.classList.remove("selected");
        }
        
        // Add selection to new folder
        const folderItems = this.sidebar.querySelectorAll(".lora-picker-folder-item");
        for (const item of folderItems) {
            const name = item.querySelector(".lora-picker-folder-name").textContent;
            if (name === folderName) {
                item.classList.add("selected");
                break;
            }
        }
        
        this.selectedFolder = folderName;
        // Save to persistence
        saveSelectedFolder(folderName);
        // Update indicator line visibility
        this.updateFolderIndicator();
        this.renderList(); // Refresh the list
    }

    renderList() {
        this.list.innerHTML = "";
        let loras = this.loras;
        loras = this.filterLoras(loras);
        loras = this.sortLoras(loras);

        for (const lora of loras) {
            const item = document.createElement("li");
            const name = typeof lora === 'string' ? lora : lora.name;
            
            // Remove folder prefix for display purposes only (first level only)
            let displayName = name;
            if (this.selectedFolder && this.selectedFolder !== "root") {
                const prefix = this.selectedFolder + "/";
                const altPrefix = this.selectedFolder + "\\";
                if (name.startsWith(prefix)) {
                    displayName = name.substring(prefix.length);
                } else if (name.startsWith(altPrefix)) {
                    displayName = name.substring(altPrefix.length);
                }
            }

            // Create a container for the star with extended clickable area
            const starContainer = document.createElement("div");
            starContainer.style.display = "flex";
            starContainer.style.alignItems = "center";
            starContainer.style.marginRight = "8px"; // Same as the gap
            starContainer.style.cursor = "pointer";
            
            const star = document.createElement("span");
            star.className = "favorite-star";
            star.textContent = "★";
            const isFavorite = this.options.favorites.includes(name);
            star.style.color = isFavorite ? "orange" : "gray";
            star.style.userSelect = "none";

            star.addEventListener("click", (e) => {
                e.stopPropagation();
                if (this.options.onFavoriteToggle) {
                    this.options.onFavoriteToggle(name);
                }
            });
            
            starContainer.appendChild(star);

            const nameSpan = document.createElement("span");
            nameSpan.textContent = displayName;
            nameSpan.style.userSelect = "none";
            
            item.appendChild(starContainer);
            item.appendChild(nameSpan);

            item.addEventListener("click", () => {
                if (this.options.callback) {
                    // Use the full name (including folder path) for the callback
                    // This ensures the Python code gets the complete path information
                    this.options.callback(name);
                }
                this.close();
            });
            
            // Add context menu event listener
            item.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                showLoraListContextMenu(e, name); // Use the full name for context menu
            });
            
            this.list.appendChild(item);
        }
    }

    sortLoras(loras) {
        const sort = this.options.sort || "Latest";
        
        // Sort the loras array directly based on the sort option
        const sortedLoras = [...loras];
        
        if (sort === "Latest") {
            sortedLoras.sort((a, b) => {
                const aMtime = (typeof a === 'object' && a.mtime) ? a.mtime : 0;
                const bMtime = (typeof b === 'object' && b.mtime) ? b.mtime : 0;
                return bMtime - aMtime; // Descending order (newest first)
            });
        } else if (sort === "Oldest") {
            sortedLoras.sort((a, b) => {
                const aMtime = (typeof a === 'object' && a.mtime) ? a.mtime : 0;
                const bMtime = (typeof b === 'object' && b.mtime) ? b.mtime : 0;
                return aMtime - bMtime; // Ascending order (oldest first)
            });
        } else if (sort === "A-Z") {
            sortedLoras.sort((a, b) => {
                const aName = typeof a === 'string' ? a : a.name;
                const bName = typeof b === 'string' ? b : b.name;
                return aName.localeCompare(bName);
            });
        } else if (sort === "Z-A") {
            sortedLoras.sort((a, b) => {
                const aName = typeof a === 'string' ? a : a.name;
                const bName = typeof b === 'string' ? b : b.name;
                return bName.localeCompare(aName);
            });
        }
        
        return sortedLoras;
    }

    filterLoras(loras) {
        const favoritesOnly = this.options.favoritesOnly || false;
        const favorites = this.options.favorites || [];
        const searchInput = this.element.querySelector("input[type=text]");
        const query = searchInput ? searchInput.value.toLowerCase() : "";

        let filteredLoras = loras;

        // Filter by selected folder
        if (this.selectedFolder && this.selectedFolder !== "root") {
            filteredLoras = filteredLoras.filter(l => {
                const name = typeof l === 'string' ? l : l.name;
                // Check if the lora is in the selected folder
                if (name && (name.includes('/') || name.includes('\\'))) {
                    const folderName = name.split(/[\/\\]/)[0];
                    return folderName === this.selectedFolder;
                }
                return false;
            });
        } else if (this.selectedFolder === "root") {
            // Show ALL items when root is selected (including those in subfolders)
            // No filtering needed - keep all loras
        }

        if (favoritesOnly) {
            filteredLoras = filteredLoras.filter(l => favorites.includes(typeof l === 'string' ? l : l.name));
        }

        if (query) {
            filteredLoras = filteredLoras.filter(l => this.matchesSearchQuery((typeof l === 'string' ? l : l.name), query));
        }

        return filteredLoras;
    }

    /**
     * Check if a LoRA name matches a multi-word search query
     * @param {string} loraName - The LoRA name to check
     * @param {string} query - The search query (can contain multiple words)
     * @returns {boolean} - True if the LoRA matches all words in the query
     */
    matchesSearchQuery(loraName, query) {
        if (!query || !loraName) return false;
        
        // Convert to lowercase for case-insensitive matching
        const lowerLoraName = loraName.toLowerCase();
        
        // Split the query into individual words, filtering out empty strings
        const searchWords = query.split(/\s+/).filter(word => word.length > 0);
        
        // If no valid words in query, don't filter
        if (searchWords.length === 0) return true;
        
        // Check if ALL search words are present in the LoRA name
        return searchWords.every(word => lowerLoraName.includes(word));
    }

    updateFolderIndicator() {
        // Find and update the indicator line in the folders button
        const foldersContainer = this.element.querySelector(".lora-picker-header > div:nth-child(4)");
        if (foldersContainer) {
            // Find the indicator line (it's now positioned absolutely at the bottom)
            const indicatorLine = foldersContainer.querySelector("div[style*='position: absolute']");
            if (indicatorLine) {
                // Show indicator only if a non-root folder is selected and sidebar is collapsed
                indicatorLine.style.display = (this.selectedFolder && this.selectedFolder !== "root" && !this.options.foldersVisible) ? "block" : "none";
            }
        }
    }

    close() {
        if (this.element) {
            this.element.remove();
        }
        if (this.overlay) {
            this.overlay.remove();
        }
        if (this.keydownHandler) {
            document.removeEventListener('keydown', this.keydownHandler);
        }
    }
    
    updateLoras(newLoras) {
        // Filter out any "None" entries from the new loras list
        this.loras = (newLoras || []).filter(l => {
            const name = typeof l === 'string' ? l : l.name;
            return name && name.toLowerCase() !== "none";
        });
        // Re-extract folders from the updated lora list
        this.folders = this.extractFolders();
        // Re-render folders in sidebar if it exists
        if (this.sidebar) {
            const sidebarContent = this.sidebar.querySelector(".lora-picker-sidebar-content");
            if (sidebarContent) {
                this.renderFoldersInSidebar(sidebarContent);
            }
        }
        // Re-render the list
        this.renderList();
    }
}
