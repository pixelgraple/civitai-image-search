#!/usr/bin/env python3
"""Bounded worker child: create one still preview from an animated WebP."""
import sys
from PIL import Image

Image.MAX_IMAGE_PIXELS = 9_000_000
if len(sys.argv) != 4 or sys.argv[3] not in ('webp', 'jpeg', 'png'):
    raise SystemExit('Expected source, destination and output format.')
with Image.open(sys.argv[1]) as source:
    if source.format != 'WEBP' or source.width * source.height > 9_000_000 or max(source.size) > 4096:
        raise SystemExit('Image exceeds the collection limits.')
    source.seek(0)
    frame = source.convert('RGB' if sys.argv[3] == 'jpeg' else 'RGBA')
    frame.thumbnail((720, 720), Image.Resampling.LANCZOS)
    frame.save(sys.argv[2], format=sys.argv[3].upper(), quality=80)
