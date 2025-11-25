import { app } from "../../scripts/app.js";

app.registerExtension({
	name: "WanVideoWrapper.CreateImageList",
	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name === 'CreateImageList') {
			// Helper function to ensure image_ref is at the bottom
			const ensureImageRefAtBottom = function() {
				const imageRefIndex = this.inputs.findIndex(inp => inp.name === 'image_ref');
				if (imageRefIndex !== -1 && imageRefIndex < this.inputs.length - 1) {
					// Move image_ref to the end
					const imageRefInput = this.inputs.splice(imageRefIndex, 1)[0];
					this.inputs.push(imageRefInput);
				}
			};

			// Override onConfigure to ensure image_ref stays at bottom after page refresh
			const originalOnConfigure = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function(info) {
				if (originalOnConfigure) {
					originalOnConfigure.apply(this, arguments);
				}
				// Ensure image_ref stays at the bottom after loading
				ensureImageRefAtBottom.call(this);
			};

			nodeType.prototype.onConnectionsChange = function (type, index, connected, link_info) {
				const stackTrace = new Error().stack;

				// Skip processing for subgraph operations
				if (stackTrace.includes('convertToSubgraph') || stackTrace.includes('Subgraph.configure')) {
					return;
				}

				// Skip for load operations
				if (stackTrace.includes('loadGraphData')) {
					return;
				}

				if (stackTrace.includes('pasteFromClipboard')) {
					return;
				}

				if (!link_info)
					return;

				// Only handle input connections (type 1)
				if (type !== 1) {
					return;
				}

				// Don't process specific inputs (widgets converted to inputs or color matching params)
				const input = this.inputs[index];
				if (input && (input.name === 'export_alpha' || input.name === 'image_ref' || input.name === 'method' || input.name === 'strength' || input.name === 'multithread')) {
					return;
				}

				// Count how many IMAGE type inputs we have (excluding image_ref, which is for color matching)
				const imageInputCount = this.inputs.filter(inp => inp.type === 'IMAGE' && inp.name !== 'image_ref').length;

				// When disconnecting, remove the input if there's more than one IMAGE input
				if (!connected && imageInputCount > 1) {
					if (
						!stackTrace.includes('LGraphNode.prototype.connect') &&
						!stackTrace.includes('LGraphNode.connect') &&
						!stackTrace.includes('loadGraphData')
					) {
						this.removeInput(index);
					}
				}

				// Ensure at least one IMAGE input exists (excluding image_ref)
				const remainingImageInputs = this.inputs.filter(inp => inp.type === 'IMAGE' && inp.name !== 'image_ref').length;
				if (remainingImageInputs === 0) {
					this.addInput("image1", "IMAGE");
				}

				// Renumber all IMAGE inputs sequentially (excluding image_ref)
				let slot_i = 1;
				for (let i = 0; i < this.inputs.length; i++) {
					const inp = this.inputs[i];
					if (inp.type === 'IMAGE' && inp.name !== 'image_ref') {
						inp.name = `image${slot_i}`;
						slot_i++;
					}
				}

				// When connecting, add a new input slot
				if (connected) {
					this.addInput(`image${slot_i}`, "IMAGE");
				}

				// Ensure image_ref stays at the bottom
				ensureImageRefAtBottom.call(this);
			}
		}
	}
});
