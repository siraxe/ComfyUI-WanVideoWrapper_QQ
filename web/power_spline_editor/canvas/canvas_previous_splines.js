export function attachPreviousSplineHelpers(editor) {
  editor.renderPreviousSplines = () => {
    if (editor.previousSplinesLayer) {
      editor.vis.children = editor.vis.children.filter(child => child !== editor.previousSplinesLayer);
      editor.previousSplinesLayer = null;
    }

    if ((!editor.previousSplineData || editor.previousSplineData.length === 0) &&
        (!editor.previousPCoordinates || editor.previousPCoordinates.length === 0)) {
      return;
    }

    editor.previousSplinesLayer = editor.vis.add(pv.Panel).events("none");

    if (editor.previousSplineData && editor.previousSplineData.length > 0) {
      editor.previousSplineData.forEach((splineCoords) => {
        editor.previousSplinesLayer.add(pv.Line)
          .data(splineCoords)
          .left(d => {
            if (editor.originalImageWidth && editor.originalImageHeight && editor.scale > 0) {
              return (d.x * editor.scale) + editor.offsetX;
            }
            return d.x;
          })
          .top(d => {
            if (editor.originalImageWidth && editor.originalImageHeight && editor.scale > 0) {
              return (d.y * editor.scale) + editor.offsetY;
            }
            return d.y;
          })
          .events("none")
          .strokeStyle("rgba(255, 255, 255, 0.5)")
          .lineWidth(3)
          .interpolate("linear");

        const midIndex = Math.floor(splineCoords.length / 2);
        if (splineCoords.length > 0) {
          const midPoint = splineCoords[midIndex];
          editor.previousSplinesLayer.add(pv.Dot)
            .data([midPoint])
            .left(d => {
              if (editor.originalImageWidth && editor.originalImageHeight && editor.scale > 0) {
                return (d.x * editor.scale) + editor.offsetX;
              }
              return d.x;
            })
            .top(d => {
              if (editor.originalImageWidth && editor.originalImageHeight && editor.scale > 0) {
                return (d.y * editor.scale) + editor.offsetY;
              }
              return d.y;
            })
            .radius(6)
            .shape("circle")
            .strokeStyle("rgba(255, 255, 255, 0.5)")
            .fillStyle("rgba(255, 255, 255, 0.3)");
        }
      });
    }

    if (editor.previousPCoordinates && editor.previousPCoordinates.length > 0) {
      editor.previousPCoordinates.forEach((pointList) => {
        editor.previousSplinesLayer.add(pv.Dot)
          .data(pointList)
          .left(d => {
            if (editor.originalImageWidth && editor.originalImageHeight && editor.scale > 0) {
              return (d.x * editor.scale) + editor.offsetX;
            }
            return d.x;
          })
          .top(d => {
            if (editor.originalImageWidth && editor.originalImageHeight && editor.scale > 0) {
              return (d.y * editor.scale) + editor.offsetY;
            }
            return d.y;
          })
          .events("none")
          .radius(6)
          .shape("circle")
          .strokeStyle("rgba(255, 255, 255, 0.5)")
          .fillStyle("rgba(255, 255, 255, 0.3)");
      });
    }
  };

  editor.drawPreviousSpline = (coord_in) => {
    try {
      const coordInData = JSON.parse(coord_in);
      let previousSplinePoints = [];
      let previousPPoints = [];

      if (Array.isArray(coordInData)) {
        previousSplinePoints = [coordInData];
      } else if (typeof coordInData === 'object' && coordInData !== null) {
        if ('coordinates' in coordInData) {
          if (Array.isArray(coordInData.coordinates) && coordInData.coordinates.length > 0 && !Array.isArray(coordInData.coordinates[0])) {
            previousSplinePoints = [coordInData.coordinates];
          } else {
            previousSplinePoints = coordInData.coordinates;
          }
        }

        if ('p_coordinates' in coordInData) {
          if (Array.isArray(coordInData.p_coordinates) && coordInData.p_coordinates.length > 0 && !Array.isArray(coordInData.p_coordinates[0])) {
            previousPPoints = [coordInData.p_coordinates];
          } else {
            previousPPoints = coordInData.p_coordinates;
          }
        }
      }

      editor.previousSplineData = previousSplinePoints;
      editor.previousPCoordinates = previousPPoints;

      editor.renderPreviousSplines();
      editor.vis.render();

    } catch (e) {
      console.error("Error parsing coord_in:", e);
      editor.previousSplineData = null;
      editor.previousPCoordinates = null;
    }
  };
}
