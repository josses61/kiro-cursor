# Build Icons

Place your app icons here before running `npm run build`:

| File | Used for |
|---|---|
| `icon.ico` | Windows installer + taskbar |
| `icon.icns` | macOS DMG |
| `icon.png` | Linux AppImage (512×512 recommended) |

## Quick way to generate icons

If you have ImageMagick installed:

```powershell
# Convert a 1024x1024 PNG to ICO (multi-res)
magick icon-source.png -define icon:auto-resize="256,128,64,48,32,16" icon.ico
```

Or use an online tool like https://realfavicongenerator.net/ — upload a 512×512 PNG and download the `.ico`.

Without icons, electron-builder will use a default Electron icon.
