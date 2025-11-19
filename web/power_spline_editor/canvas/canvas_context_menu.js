export function attachContextMenuHandlers(editor) {
  editor.createContextMenu = () => {
    editor.node.menuItems.forEach((menuItem, index) => {
      menuItem.addEventListener('click', (e) => {
        e.preventDefault();
        const hideOpenMenus = (ev) => {
          const target = ev && ev.target;
          const withinDialog = target && (target.closest?.('.litegraph .dialog') || target.closest?.('.litegraph.liteprompt') || target.closest?.('.litedialog'));
          if (withinDialog) return;
          document.querySelectorAll('.spline-editor-context-menu').forEach(menu => {
            menu.style.display = 'none';
          });
          document.removeEventListener('click', hideOpenMenus, true);
          document.removeEventListener('contextmenu', hideOpenMenus, true);
        };
        document.addEventListener('click', hideOpenMenus, true);
        document.addEventListener('contextmenu', hideOpenMenus, true);
        switch (index) {
          case 0: {
            const aw = editor.getActiveWidget?.();
            const isHand = !!(aw && aw.value && aw.value.type === 'handdraw');
            if (isHand) {
              try { editor.enterHanddrawMode('edit', aw); } catch {}
              try { editor.layerRenderer?.render(); } catch {}
            } else {
              editor.points.reverse();
              editor.updatePath();
            }
            editor.node.contextMenu.style.display = 'none';
            break;
          }
          case 1:
            editor.smoothActiveHanddraw?.();
            editor.node.contextMenu.style.display = 'none';
            break;
          case 2: {
            const activeWidget = editor.getActiveWidget();
            if (activeWidget) {
              editor.node.layerManager.removeSpline(activeWidget);
            }
            editor.node.contextMenu.style.display = 'none';
            break;
          }
          case 3: {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.addEventListener('change', (event) => {
              const file = event.target.files[0];
              if (file) {
                const imageUrl = URL.createObjectURL(file);
                const img = new Image();
                img.src = imageUrl;
                img.onload = () => editor.handleImageLoad(img, file, null);
              }
            });
            fileInput.click();
            editor.node.contextMenu.style.display = 'none';
            break;
          }
          case 4:
            editor.backgroundImage.visible(false);
            editor.layerRenderer.render();
            editor.originalImageWidth = null;
            editor.originalImageHeight = null;
            editor.scale = 1;
            editor.offsetX = 0;
            editor.offsetY = 0;
            editor.node.imgData = null;
            sessionStorage.removeItem(`spline-editor-img-${editor.node.uuid}`);
            editor.node.contextMenu.style.display = 'none';
            editor.updatePath();
            break;
          case 5:
            editor.node.layerManager.removeAllSplines();
            editor.node.contextMenu.style.display = 'none';
            break;
        }
      });
    });
  };
}
