# App icons

Put small icon files here (PNG, ICO, SVG, JPG or WEBP, max 256 KB each) and
reference them by file name in `../apps.json`:

```json
{ "id": "chrome", "label": "Chrome", "icon": "chrome.png", "exe": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }
```

Only plain file names are accepted (no folders, no `..`). Apps without an icon
show a glowing monogram of their label. No third-party logos are shipped with
this project; use icons you have the right to use.
