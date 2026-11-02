'use strict';
// Offscreen documents need a worker clock to keep the caption/audio pipeline
// independent from the visibility and lifecycle of the side-panel document.
setInterval(()=>postMessage('tick'),250);
