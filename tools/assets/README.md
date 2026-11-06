# The game's textures (issue #27)

The materials and the roofs of Karlín are made from downloaded sources that are **not** in the repository (about 300 MB of raw
maps); the scripts here turn them into the small files the game loads from `client/public/assets/`. Every committed file, its
source and its licence is listed in [ASSETS.md](../../ASSETS.md). Python 3.12 with Pillow (12) is all they need.

## The material library: `materials.py`

```sh
python -I -X utf8 tools/assets/materials.py <asset-src>              # all materials
python -I -X utf8 tools/assets/materials.py <asset-src> --only snow,ice   # some of them (index.json keeps the others)
python -I -X utf8 tools/assets/materials.py <asset-src> --sheet sheet.jpg  # and a contact sheet to look at (colour, height)
```

`<asset-src>` is a folder with the downloaded CC0 sets as their sites ship them:

- `polyhaven/<id>/<id>_diff_2k.jpg`, `<id>_nor_gl_2k.jpg`, `<id>_arm_2k.jpg` (2K JPG from [Poly Haven](https://polyhaven.com/textures):
  the diffuse, the OpenGL normal map and the packed ambient occlusion, roughness and metal);
- `ambientcg/<Id>/<Id>_2K-JPG_Color.jpg`, `_NormalGL.jpg`, `_Roughness.jpg` and, where the set has them, `_AmbientOcclusion.jpg` and
  `_Displacement.jpg` (the 2K-JPG zip of [ambientCG](https://ambientcg.com), unpacked).

The list of materials, their game names (keys), the size of one tile in game units and how each is treated is `MATS` at the top of
the script; ASSETS.md has the download URL of every source. The script writes into `client/public/assets/mat/`:

| File | What |
| --- | --- |
| `1024/<key>_c.webp`, `512/<key>_c.webp` | colour: the occlusion multiplied in, plasters and concrete made nearly grey (the game tints them), the average brightness brought to about 0.5 (the game scales it back, so the tint decides how bright a surface looks). For the surfaces with joints (`h`: mosaic, setts, slabs, granite, rails, sandstone, brick, concrete panels, roofs) the **height in its alpha** (0.5 to 1): the weather's snow settles in the low parts first, puddles stand there. The 1024 one only for a few walls seen close (the keys not marked `c1k=False`): the ground, seen from the tank's camera, never needs more than 512 texels a tile, and 1024 maps over the whole ground cost a weak GPU a fifth of its frame |
| `512/<key>_n.webp` (and `1024/` for a key marked `n1k`; none is now) | the normal map (OpenGL, green up) |
| `index.json` | per key: the tile size (`texel`, game units), the colour's average (`mean`), the average roughness (`rough`), source, licence, URL and which files exist |

All maps are shrunk from a wrapped copy, so they tile as seamlessly as the sources. There is no separate roughness map: the roughness
is one number per material, the height and the occlusion sit in the colour map, which saves the GPU a texture per material and the
shader a texture read a pixel (and the medium quality level, which loads no normal maps, keeps the snow in the joints; the low
level loads no maps at all). WebP quality 80
(colour; the height alpha lossy at 20, softened by a pixel) and 78 (normal); about 3.4 MB for all 28 materials.

The game side is `client/src/core/matlib.ts` (the materials, the quality levels, the weather on them); its keys are `MAT_KEYS`.

## The roofs: `roofs.py`

```sh
python -I -X utf8 tools/assets/roofs.py <asset-src>                  # the atlas and its index
python -I -X utf8 tools/assets/roofs.py <asset-src> --check <out>    # and the footprints drawn over the photo, to check the fit
```

It reads `<asset-src>/ipr/ortho_1.jpg` (the north half) and `ortho_2.jpg` (the south half) of the IPR Praha orthophoto (CC BY 4.0,
"data base © IPR Praha"; each with its `ortho_N.json`) and `client/shared/karlin.json`, and writes the roof atlas
`client/public/assets/roofs/roofs_0.webp` (2048², 0.37 m a pixel), `roofs_0_low.webp` (1024², the low quality level),
`roofs_0_n.webp` (1024², a normal map with the snow mask in its alpha) and `client/src/world/roofs.json` (bundled with the game: where
each house's roof lies in the atlas). The script's header says how the roofs are cut, toned and packed.

**The orthophoto's frame.** The IPR image service (WMS / ImageServer export) keeps the width that was asked for and makes the pixels
square in degrees, so the `bbox` in `ortho_N.json` is the box that was **requested**, not what the picture covers (each half covers some
1.55 times more latitude than its box says, and the two halves overlap). `roofs.py` derives the real frame from the requested width and
the box's centre and checks that the halves agree where they overlap. For a new download, ask for an image size that keeps the box's
aspect ratio in degrees, or pass `adjustAspectRatio=false`, and the `bbox` will then be the coverage.
