# World of DODO, issue #27: the roof atlas, the arena's roofs cut out of the IPR Praha orthophoto (CC BY 4.0, "data base © IPR Praha",
# summer 2024) and packed into one texture page, for world/facade.ts.
#
#   python -I -X utf8 tools/assets/roofs.py <asset-src folder> [--check out-folder]
#
# Reads <asset-src>/ipr/ortho_1.jpg (north) and ortho_2.jpg (south) and client/shared/karlin.json; writes client/public/assets/roofs/:
#   roofs_0.webp       the atlas page (2048²): every arena house's footprint box (+ a margin of real photo around it) as the camera
#                      saw it from above, in the winter-neutral look: the summer's greens (trees over the roofs, green roofs) toned
#                      down to grey-brown, the shadows lifted a little, the tiles' red and the metal's grey kept. No snow in it: the
#                      game's weather (core/matlib.ts setWeatherLook) puts the snow on, and can take it away again (issue #29).
#   roofs_0_low.webp   the same at 1024² (the low quality level)
#   roofs_0_n.webp     1024²: a gentle normal map from the photo's light and dark (chimneys, dormers, skylights catch the moon), its
#                      alpha the snow mask as the material library reads it (a height, 0.5..1: the low parts take snow first): flat
#                      roofs low (they fill with snow first), pitched ones higher, mansards' steep slopes highest, and what stands up
#                      on a roof (the photo's edges) higher than the plain roof around it
# and client/src/world/roofs.json (bundled with the game, so the roofs get their uvs as they are built):
#   per arena house (its index in karlin.json's buildings) [page, u0, v0, u1, v1, x0, z0, x1, z1, rot]: the house's box in game
#   units (x0..x1, z0..z1) and where it lies in the page (uv 0..1, v from the top; rot 1: stored turned, x down the page), the page
#   files and sizes, the atlas's average brightness (matlib's mean).
#
# The orthophoto's frame. ortho_N.json gives the WGS84 box each half was asked for, but the image service kept that box's width and
# made the picture's pixels square in degrees (it adjusts the box to the image's aspect ratio): each half is north up, its columns
# linear in longitude over the box's width, its rows in latitude at the same degrees per pixel, centred on the box: some 1.55 times
# taller (0.2 m a pixel across, 0.31 m down) than the box says. The two halves therefore overlap: ortho_2's first row is ortho_1's
# row MOSAIC_ROW. This was found by fitting karlin.json's houses, streets, water and parks to the photo (mutual information) and by
# correlating the halves, and is then simply what frame() below computes; load() checks that the halves agree where they overlap.
# Game units -> WGS84 is karlin.json's frame (rotated metres, then longitude and latitude), as tools/karlin/lib/frame.mjs.
# The footprints then lie on their roofs within a pixel or two (--check draws them over the photo); only tall towers lean a little
# (the orthophoto is not a "true ortho"), which a margin of photo round every box covers.
# --check writes overlays of the footprints on the photo (registration) into out-folder.
# Needs Pillow (12) only.
import json, math, os, sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat, ImageOps

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.path.join(ROOT, 'client', 'public', 'assets', 'roofs')
# game (x, z) -> mosaic pixel (u, v): u = A[0] x + A[1] z + A[2], v = A[3] x + A[4] z + A[5] (frame(): affine, as the whole chain is)
A = None
MOSAIC_ROW = None
PAGE = 2048           # the page (one page: 22 MB on the GPU with its mip maps, the budget is two)
MARGIN = 0.8          # game units of photo around each box (mip maps and filtering then sample real roof, not a neighbour's)


def frame(src, D):
    # the halves' real extents (see the top) and the affine map game units -> mosaic pixels
    global A, MOSAIC_ROW
    m1 = json.load(open(os.path.join(src, 'ipr', 'ortho_1.json'))); m2 = json.load(open(os.path.join(src, 'ipr', 'ortho_2.json')))
    W, H = m1['size']
    dpp = (m1['bbox'][2] - m1['bbox'][0]) / W                       # degrees per pixel, both ways
    lonc = (m1['bbox'][0] + m1['bbox'][2]) / 2
    latc1, latc2 = (m1['bbox'][1] + m1['bbox'][3]) / 2, (m2['bbox'][1] + m2['bbox'][3]) / 2
    MOSAIC_ROW = round((latc1 - latc2) / dpp)
    F = D['frame']; R = math.radians(F['rotDeg']); C, S = math.cos(R), math.sin(R); KX = 111320 * math.cos(math.radians(F['lat0']))
    def px(x, z):
        xr, zr = x * F['unitM'] + F['cx'], z * F['unitM'] + F['cz']
        xm, zm = xr * C + zr * S, -xr * S + zr * C
        lon, lat = F['lon0'] + xm / KX, F['lat0'] - zm / 110540
        return W / 2 + (lon - lonc) / dpp, H / 2 - (lat - latc1) / dpp
    o, ex, ez = px(0, 0), px(1, 0), px(0, 1)
    A = [ex[0] - o[0], ez[0] - o[0], o[0], ex[1] - o[1], ez[1] - o[1], o[1]]


def load(src):
    a = Image.open(os.path.join(src, 'ipr', 'ortho_1.jpg')).convert('RGB')
    b = Image.open(os.path.join(src, 'ipr', 'ortho_2.jpg')).convert('RGB')
    m = Image.new('RGB', (a.width, MOSAIC_ROW + b.height)); m.paste(b, (0, MOSAIC_ROW)); m.paste(a, (0, 0))
    # the overlap must agree (else the halves are not what this file expects)
    o1 = a.crop((0, MOSAIC_ROW, a.width, a.height)).convert('L').resize((a.width // 8, (a.height - MOSAIC_ROW) // 8))
    o2 = b.crop((0, 0, b.width, a.height - MOSAIC_ROW)).convert('L').resize(o1.size)
    diff = ImageStat.Stat(ImageChops.difference(o1, o2)).mean[0]
    print('roofs: halves overlap by %d rows, mean difference there %.1f' % (a.height - MOSAIC_ROW, diff))
    if diff > 12: raise SystemExit('roofs.py: the two orthophoto halves do not overlap as expected (mean difference %.1f)' % diff)
    return m


def P(x, z, du=0.0, dv=0.0):
    return A[0] * x + A[1] * z + A[2] + du, A[3] * x + A[4] * z + A[5] + dv


def area(p):
    return sum(p[i] * p[(i + 3) % len(p)] - p[(i + 2) % len(p)] * p[i + 1] for i in range(0, len(p), 2)) / 2


def bbox(p):
    xs, zs = p[0::2], p[1::2]
    return min(xs), min(zs), max(xs), max(zs)


# ---------- the winter-neutral look ----------
def winter(im):
    # greens (trees over the roofs, green roofs, moss) toned down to a grey-brown; everything a little less saturated; the summer's
    # deep shadows lifted
    h, s, v = im.convert('HSV').split()
    green = h.point(lambda x: 255 if 30 <= x <= 125 else 0).filter(ImageFilter.GaussianBlur(1))
    s2 = ImageChops.subtract(s, ImageChops.multiply(s, green).point(lambda x: x * 0.8))
    s2 = s2.point(lambda x: int(x * 0.82))
    v2 = ImageChops.subtract(v, ImageChops.multiply(v, green).point(lambda x: x * 0.18))
    v2 = v2.point(lambda x: int(255 * (x / 255) ** 0.82))
    rgb = Image.merge('HSV', (h, s2, v2)).convert('RGB')
    return rgb


def normal_and_snow(page, base):
    # base: per pixel the house's snow propensity (L: 255 takes snow most); the photo's local relief (its light and dark, gently)
    L = page.convert('L').filter(ImageFilter.GaussianBlur(1))
    gx = L.filter(ImageFilter.Kernel((3, 3), [-1, 0, 1, -2, 0, 2, -1, 0, 1], 8, 128))
    gy = L.filter(ImageFilter.Kernel((3, 3), [-1, -2, -1, 0, 0, 0, 1, 2, 1], 8, 128))
    blue = Image.new('L', page.size, 235)
    nrm = Image.merge('RGB', (gx, ImageOps.invert(gy), blue))
    edge = page.convert('L').filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(2))
    # height 0.5..1 (alpha 128..255): low where snow settles first
    prop = ImageChops.subtract(base, edge.point(lambda x: min(255, x * 3) * 0.35))
    height = prop.point(lambda x: int(255 - x * 0.5))
    r, g, b = nrm.split()
    return Image.merge('RGBA', (r, g, b, height))


def pack(rects, size):
    # shelves, the tallest first; rects: (key, w, h); returns key -> (x, y) or None if it does not fit
    pos, x, y, sh = {}, 1, 1, 0
    for k, w, h in sorted(rects, key=lambda r: -r[2]):
        if x + w + 1 > size: x, y, sh = 1, y + sh + 1, 0
        if y + h + 1 > size or w + 2 > size: return None
        pos[k] = (x, y); x += w + 1; sh = max(sh, h)
    return pos


def main():
    src = sys.argv[1]
    check = sys.argv[sys.argv.index('--check') + 1] if '--check' in sys.argv else None
    D = json.load(open(os.path.join(ROOT, 'client', 'shared', 'karlin.json'), encoding='utf8'))
    frame(src, D)
    print('roofs: game -> photo', [round(a, 4) for a in A], 'mosaic row', MOSAIC_ROW)
    m = load(src)
    idx = [i for i, b in enumerate(D['buildings']) if not b.get('far') and len(b['p']) >= 6]
    B = [D['buildings'][i] for i in idx]
    print('roofs: %d houses' % len(B))
    if check: overlays(m, D, B, check)
    # the boxes, at the largest density that fits one page
    dens = 4.2
    while True:
        rects = []
        for k, b in enumerate(B):
            x0, z0, x1, z1 = bbox(b['p'])
            w, h = math.ceil((x1 - x0 + 2 * MARGIN) * dens), math.ceil((z1 - z0 + 2 * MARGIN) * dens)
            rects.append((k, max(w, h), min(w, h)))          # stored with its long side across (rot when the box is taller than wide)
        pos = pack(rects, PAGE)
        if pos: break
        dens *= 0.96
    print('roofs: density %.2f px per unit (%.2f m per px)' % (dens, 1.5 / dens))
    page = Image.new('RGB', (PAGE, PAGE), (120, 115, 110))
    base = Image.new('L', (PAGE, PAGE), 160)
    out = {}
    for k, b in enumerate(B):
        x0, z0, x1, z1 = bbox(b['p']); x0 -= MARGIN; z0 -= MARGIN
        w, h = math.ceil((x1 + MARGIN - x0) * dens), math.ceil((z1 + MARGIN - z0) * dens)
        rot = 1 if h > w else 0
        du, dv = 0, 0
        # output pixel (i, j) -> game (x, z) -> mosaic (u, v); rot: i runs along z, j along x
        if not rot:
            a, bb = A[0] / dens, A[1] / dens; d, e = A[3] / dens, A[4] / dens
        else:
            a, bb = A[1] / dens, A[0] / dens; d, e = A[4] / dens, A[3] / dens
        c0 = A[0] * x0 + A[1] * z0 + A[2] + du; f0 = A[3] * x0 + A[4] * z0 + A[5] + dv
        pw, ph = (h, w) if rot else (w, h)
        patch = m.transform((pw, ph), Image.AFFINE, (a, bb, c0, d, e, f0), resample=Image.BICUBIC, fillcolor=(120, 115, 110))
        px, py = pos[k]
        page.paste(winter(patch), (px, py))
        prop = 235 if b['r'] == 0 else 150 if b['r'] == 1 else 120
        base.paste(prop, (px, py, px + pw, py + ph))
        X1, Z1 = x0 + w / dens, z0 + h / dens
        out[str(idx[k])] = [0, round(px / PAGE, 6), round(py / PAGE, 6), round((px + pw) / PAGE, 6), round((py + ph) / PAGE, 6),
                            round(x0, 3), round(z0, 3), round(X1, 3), round(Z1, 3), rot]
    os.makedirs(OUT, exist_ok=True)
    page.save(os.path.join(OUT, 'roofs_0.webp'), quality=82, method=6)
    page.resize((PAGE // 2, PAGE // 2), Image.LANCZOS).save(os.path.join(OUT, 'roofs_0_low.webp'), quality=80, method=6)
    nm = normal_and_snow(page, base).resize((PAGE // 2, PAGE // 2), Image.LANCZOS)
    nm.save(os.path.join(OUT, 'roofs_0_n.webp'), quality=85, alpha_quality=90, method=6)
    mean = sum(ImageStat.Stat(page.convert('L')).mean) / 255
    J = {'v': 1, 'about': 'World of DODO roof atlas (issue #27), made by tools/assets/roofs.py from the IPR Praha orthophoto: per arena house '
         '(karlin.json buildings index) [page, u0, v0, u1, v1 (v from the top), x0, z0, x1, z1 (game units), rot (1: x runs down the page)]',
         'attribution': 'data base © IPR Praha (CC BY 4.0), Ortofotomapa Prahy 2024', 'density': round(dens, 3), 'mean': round(mean, 4),
         'pages': [{'file': 'roofs_0.webp', 'size': [PAGE, PAGE], 'low': 'roofs_0_low.webp', 'lowSize': [PAGE // 2, PAGE // 2], 'n': 'roofs_0_n.webp'}],
         'b': out}
    js = os.path.join(ROOT, 'client', 'src', 'world', 'roofs.json')
    with open(js, 'w', encoding='utf8', newline='\n') as fh:
        json.dump(J, fh, separators=(',', ':'), ensure_ascii=False)
    for f in ('roofs_0.webp', 'roofs_0_low.webp', 'roofs_0_n.webp'):
        print('  %-18s %7.1f KB' % (f, os.path.getsize(os.path.join(OUT, f)) / 1024))
    print('  %-18s %7.1f KB' % ('roofs.json', os.path.getsize(js) / 1024))


def overlays(m, D, B, out):
    os.makedirs(out, exist_ok=True)
    L = D['landmarks']
    spots = {'church': (L['church']['x'], L['church']['z']), 'kasarna': (L['kasarna']['x'], L['kasarna']['z']), 'forum': (L['forum']['x'], L['forum']['z']),
             'synagogue': (L['synagogue']['x'], L['synagogue']['z']), 'west': (-250, -60), 'north': (60, -170), 'east': (300, 0), 'south': (120, 170)}
    for name, (x, z) in spots.items():
        u, v = P(x, z); R = 380
        cr = m.crop((int(u) - R, int(v) - R, int(u) + R, int(v) + R)); d = ImageDraw.Draw(cr)
        for k, b in enumerate(B):
            p = b['p']
            q = [P(p[i], p[i + 1]) for i in range(0, len(p), 2)]
            if not any(abs(a - u) < R and abs(c - v) < R for a, c in q): continue
            d.line([(a - u + R, c - v + R) for a, c in q + [q[0]]], fill=(255, 40, 40), width=2)
        for e in D['roads']['edges']:
            q = [P(e['pts'][i], e['pts'][i + 1]) for i in range(0, len(e['pts']), 2)]
            d.line([(a - u + R, c - v + R) for a, c in q], fill=(255, 0, 255), width=2)
        cr.save(os.path.join(out, 'reg_%s.jpg' % name), quality=88)


if __name__ == '__main__':
    main()
