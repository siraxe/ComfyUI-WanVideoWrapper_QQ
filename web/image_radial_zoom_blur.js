// Mode control for ImageRadialZoomBlur_GPU node
// Note: Widget visibility is handled by users understanding which parameters apply to each mode
// Radial mode: uses center_x, center_y, offset_x, frames
// Directional mode: these parameters are ignored (will be implemented in future)

import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "WanVideoWrapper.ImageRadialZoomBlur",
    async setup() {
        console.log("Image Radial Zoom Blur extension loaded - mode selector available");
    }
});

