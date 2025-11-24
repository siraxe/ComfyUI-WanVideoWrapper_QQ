import { app } from "../../scripts/app.js";

app.registerExtension({
	name: "WanVideoWrapper.CreateImageList",
	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (nodeData.name === 'CreateImageList') {
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

				// Don't process the export_alpha input (it's a widget converted to input)
				const input = this.inputs[index];
				if (input && input.name === 'export_alpha') {
					return;
				}

				// Count how many IMAGE type inputs we have (excluding export_alpha)
				const imageInputCount = this.inputs.filter(inp => inp.type === 'IMAGE').length;

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

				// Ensure at least one IMAGE input exists
				const remainingImageInputs = this.inputs.filter(inp => inp.type === 'IMAGE').length;
				if (remainingImageInputs === 0) {
					this.addInput("image1", "IMAGE");
				}

				// Renumber all IMAGE inputs sequentially
				let slot_i = 1;
				for (let i = 0; i < this.inputs.length; i++) {
					const inp = this.inputs[i];
					if (inp.type === 'IMAGE') {
						inp.name = `image${slot_i}`;
						slot_i++;
					}
				}

				// When connecting, add a new input slot
				if (connected) {
					this.addInput(`image${slot_i}`, "IMAGE");
				}
			}
		}
	}
});
