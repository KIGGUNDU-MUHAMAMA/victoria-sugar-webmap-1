// Prevent browser from opening dropped files in a new tab/window.
// Specific drop zones (map div, dropzone div) re-enable with their own handlers.
document.addEventListener('dragover', function (e) { e.preventDefault(); }, false);
document.addEventListener('drop', function (e) { e.preventDefault(); }, false);
