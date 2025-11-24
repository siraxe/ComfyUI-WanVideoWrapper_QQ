export function attachBackgroundHandlers(editor) {
  editor.recenterBackgroundImage = () => {
    if (editor.originalImageWidth && editor.originalImageHeight) {
      const targetWidth = editor.width - 80;
      const targetHeight = editor.height - 80;
      const scale = Math.min(targetWidth / editor.originalImageWidth, targetHeight / editor.originalImageHeight);
      editor.scale = scale;
      const newWidth = editor.originalImageWidth * editor.scale;
      const newHeight = editor.originalImageHeight * editor.scale;
      editor.offsetX = (editor.width - newWidth) / 2;
      editor.offsetY = (editor.height - newHeight) / 2;

      editor.backgroundImage
        .width(newWidth)
        .height(newHeight)
        .left(editor.offsetX)
        .top(editor.offsetY)
        .visible(true)
        .root.render();
    }
  };

  editor.handleImageLoad = (img, file, base64String) => {
    editor.drawRuler = false;
    editor.originalImageWidth = img.width;
    editor.originalImageHeight = img.height;

    const imageUrl = file ? URL.createObjectURL(file) : `data:${editor.node.imgData.type};base64,${base64String}`;

    editor.backgroundImage.url(imageUrl);
    editor.recenterBackgroundImage();

    const activeWidget = editor.getActiveWidget();
    if (activeWidget && activeWidget.value.points_store) {
      try {
        const storedPoints = JSON.parse(activeWidget.value.points_store);
        editor.points = editor.denormalizePoints(storedPoints);
      } catch (e) {
        console.error("Error parsing points from active widget during image load:", e);
      }
    }

    editor.updatePath();

    if (editor.vis) {
      editor.vis.render();
    }

    if (editor.layerRenderer) {
      editor.layerRenderer.render();
    }
  };

  editor.processImage = (img, file) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const width = img.width;
    const height = img.height;

    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0, width, height);

    const base64String = canvas.toDataURL('image/jpeg', 0.5).replace('data:', '').replace(/^.+,/, '');

    editor.node.imgData = {
      name: file.name,
      lastModified: file.lastModified,
      size: file.size,
      type: file.type,
      base64: base64String
    };
    try {
      sessionStorage.setItem(`spline-editor-img-${editor.node.uuid}`, JSON.stringify(editor.node.imgData));
    } catch (e) {
      console.error("Spline Editor: Could not save image to session storage", e);
    }
    editor.handleImageLoad(img, file, base64String);
  };

  editor.handleImageFile = (file) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const img = new Image();
      img.src = reader.result;
      img.onload = () => editor.processImage(img, file);
    };
    reader.readAsDataURL(file);

    const imageUrl = URL.createObjectURL(file);
    const img = new Image();
    img.src = imageUrl;
    img.onload = () => editor.handleImageLoad(img, file, null);
  };

  editor.refreshBackgroundImage = () => {
    return new Promise((resolve, reject) => {
      if (editor.node.imgData && editor.node.imgData.base64) {
        const base64String = editor.node.imgData.base64;
        const imageUrl = `data:${editor.node.imgData.type};base64,${base64String}`;
        const img = new Image();
        img.src = imageUrl;
        img.onload = () => {
          editor.handleImageLoad(img, null, base64String);
          editor.renderPreviousSplines();
          editor.layerRenderer.render();
          resolve();
        };
        img.onerror = (error) => {
          console.error(`refreshBackgroundImage: Failed to load image:`, error);
          reject(error);
        };
      } else {
        // No image data available, resolve immediately
        resolve();
      }
    });
  };
}
