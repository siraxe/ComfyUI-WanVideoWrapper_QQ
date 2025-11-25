// General utility functions for widget and callback management

/**
 * Chain a callback to an existing object property
 * Allows adding new behavior while preserving original functionality
 */
export function chainCallback(object, property, callback) {
  if (object == undefined) {
      //This should not happen.
      console.error("Tried to add callback to non-existant object")
      return;
  }
  if (property in object) {
      const callback_orig = object[property]
      object[property] = function () {
          const r = callback_orig.apply(this, arguments);
          callback.apply(this, arguments);
          return r
      };
  } else {
      object[property] = callback;
  }
}

/**
 * Permanently hide a widget from display and interaction
 * Useful for internal-only widgets that shouldn't be visible to users
 */
export function hideWidgetForGood(node, widget, suffix = '') {
  widget.origType = widget.type;
  widget.type = 'hidden' + suffix;
  widget.hidden = true;

  // Monkeypatch draw to do nothing
  widget.draw = () => {};

  // Monkeypatch computeSize to return [0, -4]
  // This is a hack to make the widget not take up any space
  // We need to return -4 instead of 0 because of how LiteGraph calculates node height
  // In recent versions of LiteGraph, it adds 4 to the widget height
  widget.computeSize = () => [0, -4];

  // Prevent the widget from being serialized
  if (!widget.options) {
    widget.options = {};
  }
  // widget.options.serialize = false;

  // Hide the widget from the node's list of widgets
  // This is another hack to prevent the widget from being drawn
  // We can't just remove it from the list, because other parts of the code
  // might still need to access it
  const index = node.widgets.indexOf(widget);
  if (index > -1) {
    node.widgets.splice(index, 1);
    node.widgets.push(widget);
  }
}
