"""Independent sample-film verification. Optional dependency: Pillow."""
from pathlib import Path
import json
from PIL import Image

sample = Path(__file__).resolve().parent.parent / 'sample' / 'five-ink-films'
ink_map = json.loads((sample / 'INK-MAP.json').read_text())
films = sorted(sample.glob('INK-*.tif'))
assert len(films) == len(ink_map['inks']) == 5
rasters = []
for filename in films:
    with Image.open(filename) as film:
        assert film.mode == '1', (filename.name, film.mode)
        assert film.size == (ink_map['width'], ink_map['height'])
        assert film.tag_v2[258] == (1,)
        assert abs(float(film.tag_v2[282]) - ink_map['dpi']) < 0.001
        assert abs(float(film.tag_v2[283]) - ink_map['dpi']) < 0.001
        assert film.tag_v2[262] == 1  # BlackIsZero: 0 black ink, 1 white clear
        rasters.append(film.convert('L').tobytes())
for pixels in zip(*rasters):
    assert sum(pixel == 0 for pixel in pixels) == 1
print('PASS: five true 1-bit TIFFs, original dimensions/DPI, one ink per source pixel.')
