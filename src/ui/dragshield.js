'use strict';

// The press began in another window; this shield only carries moves and the
// release. Routed to whichever drag is active in the main process.
document.addEventListener('mousemove', (e) => {
  shapeday.call('overlay:dragMove', { sx: e.screenX, sy: e.screenY });
});
document.addEventListener('mouseup', () => {
  shapeday.call('overlay:dragEnd', {});
});
