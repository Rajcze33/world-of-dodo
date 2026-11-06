# World of DODO, issue #27: the material library's textures, made from the CC0 sources (Poly Haven, ambientCG).
#
#   python -I -X utf8 tools/assets/materials.py <asset-src folder> [--only key,key] [--sheet out.jpg]
#
# For every material of MATS below it reads the source maps (Poly Haven: _diff, _nor_gl, _arm = ambient occlusion, roughness,
# metal; ambientCG: _Color, _NormalGL, _Roughness, _AmbientOcclusion, _Displacement) and writes into client/public/assets/mat/:
#   1024/<key>_c.webp (most), 512/<key>_c.webp   colour: the ambient occlusion multiplied in, the plasters and the concrete made nearly
#                                         grey (the game tints them with the house's colour), the average brightness brought to
#                                         about a half (matlib.ts scales it back with the texture's level, so a dark texture keeps
#                                         its 8 bits of detail and the tint alone decides how bright the surface looks); for the
#                                         surfaces with joints (h) its ALPHA the height (0.5..1, never near 0: a browser that premultiplies alpha would ruin the colour
#                                         under it), from ambientCG's displacement or, for Poly Haven (no height map downloaded), from
#                                         the occlusion and the colour's fine detail: matlib.ts lets the snow settle and the puddles
#                                         stand in the low parts, read with the colour in one texture fetch, on every quality level
#   512/<key>_n.webp (+ 1024/ with n1k)     normal map (OpenGL: green up)
# and index.json: per key the source, its licence and URL, the size of one tile in game units, the colour's average (for the
# tint), the roughness's average (how wet it looks) and which files exist. There is no separate roughness file: the roughness is
# one number per material (index.json), the height sits in the colour map's alpha, the occlusion in its colour: one texture
# fewer per material on the GPU, and one texture read fewer a pixel. Seamless as the sources are: every map is shrunk from a wrapped copy, so its edges still meet.
# Needs Pillow (12) only. The sources are not in the repository (ASSETS.md says where each one comes from).
import json, os, sys
from PIL import Image, ImageChops, ImageFilter, ImageStat, ImageDraw

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.path.join(ROOT, 'client', 'public', 'assets', 'mat')

# key, site, source id, metres one tile covers (estimated from the picture: bricks, setts, tiles), options:
#   grey: how much of the colour's own chroma stays (1 natural; the game tints the rest)   raw: no brightness normalising (the
#   lit-office facades: their colour is their light)   n1k: a 1024 normal map too (the surfaces seen closest)   c1k=False: no 1024
#   colour map (512 is all the high level loads then: the ground, seen from the tank's camera 5 units up, never needs more than 512
#   texels a tile, and on a weak GPU the 1024 maps of the whole ground cost a fifth of the frame; plain walls, roofs seen small)   h: the height in the colour map's alpha (the surfaces with
#   joints, where the snow settles first; it costs file size, so not for the plain ones)   ao: occlusion strength   use: what it is for
MATS = [
    # ground (world/roads.ts, world/land.ts)
    ('asphalt', 'polyhaven', 'asphalt_02', 3.0, dict(c1k=False, use='streets, dry and wet')),
    ('asphaltSnow', 'polyhaven', 'asphalt_snow', 2.0, dict(c1k=False, use='streets under trodden snow (blended in by the weather)')),
    ('mosaic', 'ambientcg', 'PavingStones151', 2.4, dict(c1k=False, h=True, use='pavements: the Prague mosaic')),
    ('slabs', 'polyhaven', 'concrete_pavement', 2.6, dict(c1k=False, h=True, grey=0.4, use='pavements: concrete slabs, tram stops')),
    ('setts', 'polyhaven', 'square_cobblestone', 1.7, dict(h=True, c1k=False, use='squares: granite setts; the tram track in the street')),
    ('granite', 'polyhaven', 'granite_tile_03', 1.6, dict(h=True, c1k=False, use='kerbs, plinths')),
    ('gravel', 'polyhaven', 'gravel_stones', 1.3, dict(c1k=False, use='the tracks\' gravel bed')),
    ('rails', 'ambientcg', 'Rails001', 1.9, dict(h=True, c1k=False, use='tram rails set in the street (one tile = one track across)')),
    ('snow', 'polyhaven', 'snow_02', 3.5, dict(c1k=False, grey=0.25, use='the snow layer on everything facing up; snowy land')),
    ('snowTracks', 'polyhaven', 'snow_04', 4.0, dict(c1k=False, grey=0.4, use='snow with wheel tracks (side streets, yards)')),
    ('ice', 'ambientcg', 'Ice002', 3.0, dict(c1k=False, grey=0.35, use='river floes and frozen ponds (only in frost)')),
    # walls (world/buildings.ts, world/landmarks.ts, the embankment and the bridges)
    ('plaster', 'polyhaven', 'plastered_wall_02', 3.0, dict(c1k=False, grey=0.12, use='facades: smooth plaster')),
    ('plasterYellow', 'polyhaven', 'yellow_plaster_02', 3.0, dict(c1k=False, grey=0.12, use='facades: plaster with lesenes')),
    ('plasterBeige', 'polyhaven', 'beige_wall_001', 2.5, dict(c1k=False, grey=0.12, use='facades: fine plaster')),
    ('stucco', 'polyhaven', 'white_stucco', 2.5, dict(c1k=False, grey=0.12, use='facades: stucco')),
    ('plasterGrey', 'polyhaven', 'grey_plaster_02', 3.0, dict(c1k=False, grey=0.2, use='facades: weathered plaster')),
    ('plasterWorn', 'polyhaven', 'worn_plaster_wall', 3.0, dict(c1k=False, grey=0.3, use='facades: worn plaster (yards, firewalls)')),
    ('sandstone', 'polyhaven', 'large_sandstone_blocks', 3.5, dict(h=True, use='embankment walls, plinths, bridge piers')),
    ('sandstoneOld', 'polyhaven', 'old_sandstone_02', 3.0, dict(h=True, use='rusticated plinths, the church, the viaduct')),
    ('brick', 'polyhaven', 'brick_wall_10', 2.0, dict(h=True, use='brick buildings, the synagogue, chimneys')),
    ('concrete', 'polyhaven', 'concrete_wall_008', 3.0, dict(c1k=False, grey=0.3, use='bridge decks, modern buildings')),
    ('concreteTiles', 'polyhaven', 'concrete_tile_facade', 3.0, dict(h=True, c1k=False, grey=0.5, use='modern facades (panels)')),
    ('glassOffice', 'ambientcg', 'Facade009', 30.0, dict(raw=True, use='glass office facade, its lit offices (the colour is also the glow)')),
    ('glassOffice2', 'ambientcg', 'Facade011', 30.0, dict(raw=True, use='glass office facade, finer (the colour is also the glow)')),
    # roofs (world/buildings.ts: far houses and where the orthophoto does not reach)
    ('roofClay', 'polyhaven', 'clay_roof_tiles_02', 2.6, dict(h=True, c1k=False, use='roofs: red clay tiles')),
    ('roofSlate', 'polyhaven', 'roof_slates_02', 2.2, dict(h=True, c1k=False, use='roofs: slate (mansards)')),
    ('roofTiles', 'polyhaven', 'grey_roof_tiles', 2.4, dict(h=True, c1k=False, use='roofs: old grey tiles')),
    ('corrugated', 'polyhaven', 'corrugated_iron', 2.2, dict(h=True, c1k=False, use='roofs and walls of sheds, garages, yards')),
]
SIZES = (1024, 512)
PAD = 32                       # wrapped margin (source pixels) round a map before it is shrunk: the edges stay seamless
Q_C, Q_N = 80, 78              # WebP quality: colour, normal (+ height in alpha)


def src_paths(src, site, sid):
    d = os.path.join(src, site, sid)
    if site == 'polyhaven':
        return dict(c=f'{d}/{sid}_diff_2k.jpg', n=f'{d}/{sid}_nor_gl_2k.jpg', arm=f'{d}/{sid}_arm_2k.jpg')
    p = f'{d}/{sid}_2K-JPG_'
    out = dict(c=p + 'Color.jpg', n=p + 'NormalGL.jpg', r=p + 'Roughness.jpg', ao=p + 'AmbientOcclusion.jpg', h=p + 'Displacement.jpg')
    return {k: v for k, v in out.items() if os.path.exists(v)}


def wrap_resize(im, size):
    # shrink a tileable map to size × size so that it still tiles: shrink a copy with a wrapped margin, cut the margin off
    w, h = im.size
    big = Image.new(im.mode, (w + 2 * PAD, h + 2 * PAD))
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            big.paste(im, (PAD + dx * w, PAD + dy * h))
    k = size / w
    m = round(PAD * k)
    return big.resize((size + 2 * m, size + 2 * m), Image.LANCZOS).crop((m, m, m + size, m + size))


def wrap_blur(im, r):
    # a Gaussian blur that wraps round the edges (for the height's high-pass)
    w, h = im.size
    p = int(r * 3)
    big = Image.new(im.mode, (w + 2 * p, h + 2 * p))
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            big.paste(im, (p + dx * w, p + dy * h))
    return big.filter(ImageFilter.GaussianBlur(r)).crop((p, p, p + w, p + h))


def percentile(hist, q):
    total = sum(hist); acc = 0
    for i, v in enumerate(hist):
        acc += v
        if acc >= total * q:
            return i
    return 255


def stretch(L, lo=0.01, hi=0.99):
    h = L.histogram(); a, b = percentile(h, lo), percentile(h, hi)
    if b <= a: return L
    return L.point(lambda v: max(0, min(255, round((v - a) * 255 / (b - a)))))


def build(src, key, site, sid, metres, opt, sheet):
    P = src_paths(src, site, sid)
    col = Image.open(P['c']).convert('RGB')
    # occlusion and roughness
    ao = rough = None
    if 'arm' in P:
        arm = Image.open(P['arm']).convert('RGB'); ao, rough, _ = arm.split()
    else:
        if 'ao' in P: ao = Image.open(P['ao']).convert('L')
        if 'r' in P: rough = Image.open(P['r']).convert('L')
    rough_mean = ImageStat.Stat(rough).mean[0] / 255 if rough else 0.8
    # colour: occlusion in (softened), chroma kept as asked, the average brightness to ~0.5 (not past the brightest 0.4 %)
    if ao is not None and not opt.get('raw'):
        k = opt.get('ao', 0.6)
        col = ImageChops.multiply(col, ao.point(lambda v: round(255 * (v / 255) ** k)).convert('RGB'))
    g = opt.get('grey', 1.0)
    if g < 1:
        col = Image.blend(col.convert('L').convert('RGB'), col, g)
    if not opt.get('raw'):
        L = col.convert('L'); mean = ImageStat.Stat(L).mean[0] / 255; top = percentile(L.histogram(), 0.996) / 255
        s = min(0.5 / max(mean, 1e-3), 0.99 / max(top, 1e-3))
        col = col.point(lambda v: max(0, min(255, round(v * s))))
    mean_rgb = [round(v / 255, 4) for v in ImageStat.Stat(col).mean]
    # height: ambientCG's displacement; else from the occlusion and the colour's fine detail (joints dark and occluded = low)
    if 'h' in P:
        H = stretch(Image.open(P['h']).convert('L'))
    else:
        lum = col.convert('L')
        hp = stretch(ImageChops.subtract(lum, wrap_blur(lum, 12), 1, 128))
        H = Image.blend(stretch(ao), hp, 0.45) if ao is not None else hp
    nrm = Image.open(P['n']).convert('RGB')
    files = {'c': [], 'n': []}
    for size in SIZES:
        d = os.path.join(OUT, str(size)); os.makedirs(d, exist_ok=True)
        if not (size == 1024 and opt.get('c1k') is False):
            c = wrap_resize(col, size)
            if opt.get('h'):                       # softened a little and coarser in the file: the snow's edges are soft anyway
                c.putalpha(wrap_resize(H, size).filter(ImageFilter.GaussianBlur(1)).point(lambda v: 128 + v // 2))
                c.save(os.path.join(d, f'{key}_c.webp'), 'WEBP', quality=Q_C, alpha_quality=20, method=6)
            else:
                c.save(os.path.join(d, f'{key}_c.webp'), 'WEBP', quality=Q_C, method=6)
            files['c'].append(size)
        if size == 1024 and not opt.get('n1k'):
            continue
        wrap_resize(nrm, size).save(os.path.join(d, f'{key}_n.webp'), 'WEBP', quality=Q_N, method=6)
        files['n'].append(size)
    if sheet is not None:
        sheet.append((key, col.resize((256, 256), Image.LANCZOS), H.resize((256, 256), Image.LANCZOS)))
    url = f'https://polyhaven.com/a/{sid}' if site == 'polyhaven' else f'https://ambientcg.com/view?id={sid}'
    return dict(site='Poly Haven' if site == 'polyhaven' else 'ambientCG', id=sid, url=url, licence='CC0 1.0', metres=metres,
                texel=metres, mean=mean_rgb, rough=round(rough_mean, 3), raw=bool(opt.get('raw')), height=bool(opt.get('h')), use=opt['use'], files=files)


def main():
    src = sys.argv[1]
    sheet_out = sys.argv[sys.argv.index('--sheet') + 1] if '--sheet' in sys.argv else None
    only = sys.argv[sys.argv.index('--only') + 1].split(',') if '--only' in sys.argv else None
    sheet = [] if sheet_out else None
    idx_path = os.path.join(OUT, 'index.json')
    keys = {}
    if only and os.path.exists(idx_path):
        keys = json.load(open(idx_path, encoding='utf-8'))['keys']
    elif os.path.isdir(OUT):                       # a full run starts clean: no file of a size or key no longer made stays behind
        for size in SIZES:
            d = os.path.join(OUT, str(size))
            for f in os.listdir(d) if os.path.isdir(d) else []:
                if f.endswith('.webp'): os.remove(os.path.join(d, f))
    for key, site, sid, metres, opt in MATS:
        if only and key not in only: continue
        keys[key] = build(src, key, site, sid, metres, opt, sheet)
        print(key, keys[key]['mean'], keys[key]['rough'], flush=True)
    keys = {k: keys[k] for k, *_ in MATS if k in keys}
    idx = dict(version=1, about='World of DODO material library (issue #27): made by tools/assets/materials.py, read by '
               'client/src/core/matlib.ts. texel: game units one tile covers; mean: the colour map\'s average (0..1); rough: the '
               'average roughness; files: the sizes of <size>/<key>_c.webp (colour) and <size>/<key>_n.webp (normal, height in alpha).',
               keys=keys)
    with open(idx_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(idx, f, indent=1, ensure_ascii=False); f.write('\n')
    if sheet:
        S = Image.new('RGB', (8 * 256, ((len(sheet) + 3) // 4) * 272), (30, 30, 30)); D = ImageDraw.Draw(S)
        for i, (k, c, h) in enumerate(sheet):
            x, y = (i % 4) * 512, (i // 4) * 272
            S.paste(c, (x, y + 16)); S.paste(h.convert('RGB'), (x + 256, y + 16)); D.text((x + 4, y + 2), k, fill=(255, 255, 255))
        S.save(sheet_out, quality=85)


if __name__ == '__main__':
    main()
