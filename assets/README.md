# rdsh artwork

`icon.png` is the user-provided rushDSH.png (1254 × 1254 PNG), preserved byte for
byte. The common artwork is used in README images, browser page headers and
favicons, the Windows Dashboard notification-area icon, and the Windows
`rdsh.exe` resource. No external asset host or model call is involved.

`icon-256.png` is the smaller browser/binary asset. `icon.svg` contains that
same PNG for existing SVG consumers. `icon.ico` contains 16, 24, 32, 48, 64,
128 and 256px sizes; its largest entry uses PNG compression.

Regenerate the derived formats with Python 3 and ImageMagick:

```sh
python3 scripts/generate-icons.py
```

Windows builds require the resource compiler supplied by the Windows SDK
(or the equivalent resource compiler for cross builds). Compilation includes
the icon automatically; existing published archives are unchanged.
