// World of DODO, issue #27: the material library. Real materials (Poly Haven and ambientCG, CC0; tools/assets/materials.py makes
// the game's textures of them, ASSETS.md lists every file) for the ground, the walls and the roofs, and the weather on them.
//
// matTex(key, opts) gives a StandardMaterial with the key's colour map (diffuse) and normal map (bump), shared by everyone who asks
// for the same key and options. Three things are added to Babylon's standard shader by a material plugin (WodSurface below):
//   - world uvs: by default a material needs no uvs at all; every face is textured from its world position (the ground from above,
//     a wall along itself and upwards, a roof along its slope), one tile every `texel` game units (index.json, × opts.scale), so a
//     street, a wall or a roof is seamless across its triangles and every surface has the same texel size. opts.uv 'mesh' uses the
//     mesh's own uvs instead (moving things, atlases), read as game units.
//   - the weather: setWeatherLook({ snow, wet, frost }) changes every material at once, by uniforms only (nothing is rebuilt).
//     snow (0..1): snow settles on whatever faces up, in the low parts first (the joints of the setts, the mosaic's gaps: the height
//     in the colour map's alpha, where the key has joints), in drifts (a noise), flattening the bumps under it; the streets fade from dry asphalt to trodden
//     snow (opts.alt). wet (0..1): darker, and a sheen of the night sky and the moon's glint, puddles in the low parts when very wet;
//     snow hides it. frost: the river's floes and the frozen ponds (world/land.ts listens with onWeather). Today's look (a snowy,
//     frosty, dry winter night) is the default; issue #29 will drive it from the real weather in Karlín.
//   - a large-scale variation (opts.macro) so that a tiled texture does not repeat visibly over a whole street or the land.
// Before its textures have loaded (and on the low quality level with opts.flatLow) a material shows its tint alone: the average
// colour of the texture as it will look, so the city reads the same in every state. The textures follow the quality level
// (setMatLevel, called by game/quality.ts): high the biggest colour map index.json lists (1024 only for a few walls seen close: the
// ground from the tank's camera never needs more than 512 texels a tile, and 1024 maps on the whole ground cost a weak GPU a fifth
// of its frame), 512 normal maps, 4× anisotropic filtering. Medium, a real step down: the 512 colour map only (one texture read; no
// normal map, no noise, no snow map), the snow as a flat white settling by the face's slope and the map's height (its alpha, free), the
// streets' map itself switched between dry and snowy asphalt by the weather (no second map), the wet sheen as on high (no texture).
// Low, the level a weak device falls back to, costs
// what the flat look of before did: no texture of the library's at all, no world uvs, no noise, no height; the weather only moves the
// tint (snow whitens what faces up, the streets turn to the trodden snow's colour, the rain darkens), in a few shader instructions.
// Babylon shares a texture's GPU memory between all materials that load the same file.
// At boot every material is compiled once, for its final look: until a map has arrived a 1×1 stand-in of its average takes its place
// (a map that arrives later changes no shader, only what is bound), so the boot does not wait for them (World of DODO, issue #31:
// they are fetched as soon as index.json is in, beside the city's build in slices; the loading screen waits for them, up to a time
// limit, before the game starts). The night stays: the textures are tinted towards the palette
// (core/colors.ts), the lights are the scene's (the moon, the sky), the lit windows are emissive as before.
// World of DODO, issue #34: the files come from core/assets.ts. A material wants its files for every level (and medium's dry and
// snowy street) the moment it is made (wantAll), so they are all downloaded before the game; only the current level's are decoded and
// uploaded. A level change in the game (Q, or the automatic quality's texture step, game/quality.ts) then decodes Blobs held in memory
// and makes no request. The maps a change takes off a material are retired, not disposed at once (retire): Babylon keeps their
// upload while they live, so a map that comes back (the streets' snowy asphalt, alt on high and the colour map on medium) is found
// there, and they go once the change has settled.
import {
  StandardMaterial, Texture, RawTexture, Color3, Vector3, MaterialPluginBase, type BaseTexture, type UniformBuffer, type MaterialDefines,
  type Nullable,
} from '@babylonjs/core';
import { scene, moon } from './engine';
import { c3 } from './colors';
import { want, blob, retryLater } from './assets';

// ---------- the keys ----------
// What each material is (and what the game uses it for). index.json (client/public/assets/mat) has its source, licence, texel size
// and average colour; the table below its look in the game: the tint (the average colour it shows: the palette's, or white for a
// mesh whose vertex colours carry the colour, e.g. a house's), how much of the weather's snow it takes (0..1; only what faces up gets
// any) and how wet it gets (0..1).
export const MAT_KEYS = {
  asphalt: 'streets: dry asphalt (the weather fades in asphaltSnow and wetness)',
  asphaltSnow: 'streets under trodden, salted snow (the alt layer of asphalt)',
  mosaic: 'pavements: the Prague mosaic of small stones',
  slabs: 'pavements: concrete slabs',
  setts: 'squares: setts (Karlínské náměstí)',
  granite: 'kerbs, copings, plinths: granite',
  gravel: 'the tracks\' gravel bed; the bare land and the parks under the snow',
  rails: 'tram rails set in the street (mesh uvs: one tile across = one track)',
  snow: 'snow: the weather\'s snow layer on everything facing up',
  snowTracks: 'snow with wheel tracks',
  ice: 'ice: the river\'s floes, frozen ponds',
  plaster: 'facades: smooth plaster (tint white: the house\'s colour comes as vertex colour)',
  plasterYellow: 'facades: plaster with lesenes',
  plasterBeige: 'facades: fine plaster',
  stucco: 'facades: stucco',
  plasterGrey: 'facades: weathered plaster',
  plasterWorn: 'facades: worn plaster (yards, firewalls)',
  sandstone: 'embankment walls, bridge piers, plinths: sandstone blocks',
  sandstoneOld: 'rusticated plinths, the church, the viaduct: old sandstone',
  brick: 'brick walls',
  concrete: 'bridge decks, modern buildings: cast concrete',
  concreteTiles: 'modern facades: concrete panels',
  glassOffice: 'glass office facade at night (its colour map is also its glow: emissiveMap \'self\')',
  glassOffice2: 'glass office facade at night, finer (emissiveMap \'self\')',
  roofClay: 'roofs: red clay tiles',
  roofSlate: 'roofs: slate',
  roofTiles: 'roofs: old grey tiles',
  corrugated: 'sheds, garages: corrugated iron',
} as const;
export type MatKey = keyof typeof MAT_KEYS;
// tint, snow, wet
const LOOK: Record<MatKey, [number, number, number]> = {
  asphalt: [0x555c5a, 0.35, 1], asphaltSnow: [0x737a78, 0.35, 1], mosaic: [0x9a9c97, 0.7, 0.9], slabs: [0xa6a8a4, 0.6, 0.8],
  setts: [0x8e8d88, 0.65, 0.9], granite: [0xb4b8b6, 0.7, 0.8], gravel: [0x8f8d87, 1, 0.6], rails: [0x6a6e6c, 0.3, 1],
  snow: [0xf5f7f6, 1, 0], snowTracks: [0xe6e9e7, 1, 0.3], ice: [0xc8dcdb, 0.6, 0.5],
  plaster: [0xffffff, 0.8, 0.35], plasterYellow: [0xffffff, 0.8, 0.35], plasterBeige: [0xffffff, 0.8, 0.35],
  stucco: [0xffffff, 0.8, 0.35], plasterGrey: [0xffffff, 0.8, 0.35], plasterWorn: [0xffffff, 0.8, 0.35],
  sandstone: [0xaaa498, 0.9, 0.6], sandstoneOld: [0xb8ad9a, 0.9, 0.6], brick: [0xa4644e, 0.8, 0.5],
  concrete: [0xa7aaa5, 0.9, 0.6], concreteTiles: [0x8f9593, 0.8, 0.5], glassOffice: [0xffffff, 0.3, 0.3], glassOffice2: [0xffffff, 0.3, 0.3],
  roofClay: [0x9a5d48, 1, 0.8], roofSlate: [0x4a5150, 1, 0.8], roofTiles: [0x6d7270, 1, 0.8], corrugated: [0x8a908e, 1, 0.9],
};
// the biggest colour map of a key at a level (high: the biggest there is; else 512)
const cSize = (info: KeyInfo, lv: number) => (lv === 0 ? Math.max(...info.files.c) : 512);

export interface MatOpts {
  tint?: number;            // the colour it averages to (default: the key's); vertex colours multiply on top, so 0xffffff lets them decide
  scale?: number;           // one tile covers texel × scale game units (default 1)
  uv?: 'world' | 'mesh';    // world (default): projected from the world position, no uvs needed; mesh: the mesh's uvs, in game units
  snow?: number;            // how much of the weather's snow it takes, 0..1 (default: the key's)
  wet?: number;             // how wet it gets, 0..1 (default: the key's)
  alt?: MatKey;             // a second colour map the weather's snow fades in (the streets: asphalt → asphaltSnow), its low parts last
  macro?: number;           // 0..1: large-scale light and dark patches against a visible repeat (ground: 0.3)
  bump?: number;            // the normal map's strength (default 1; 0: no normal map)
  emissive?: number;        // a glow colour added after lighting (as core/mat.ts lambert)
  emissiveIntensity?: number;
  emissiveMap?: BaseTexture | 'self';   // a glow map ('self': the colour map glows, the lit offices of glassOffice)
  double?: boolean;         // both sides drawn and lit
  flatLow?: boolean;        // (kept for compatibility: on the low quality level every material is its tint only, no textures at all)
  zOffset?: number;         // a decal lying on another surface: drawn in front of it (polygon offset units, as roads.ts decal)
}
// weatherMat: a material of textures of your own (the roofs' orthophoto atlas) with the same weather; uv 'mesh' and scale 1
// (the uvs as they are) unless given, map/bumpMap your textures, mean the map's average brightness (its level becomes 1 / mean, so
// that tint decides how bright it looks; default 0.5)
// (height: the bumpMap's alpha is the height, 0.5..1 as in the library's maps, now or whenever a bumpMap is set later; baked: the
// vertex colours already show today's snowy look (the city's merged 'vc' tiles): no snow layer on top, but what is snow-white and faces
// up thaws to a bare grey as the weather's snow goes, and wetness darkens it; at the default weather it looks exactly as before)
export interface WeatherOpts extends MatOpts { map?: BaseTexture; bumpMap?: BaseTexture; mean?: number; height?: boolean; baked?: boolean }

// ---------- the weather (issue #29 will set it from the real weather) ----------
export const WEATHER = { snow: 1, wet: 0, frost: true };
const WEATHER_FN: ((w: typeof WEATHER) => void)[] = [];
export function setWeatherLook(w: Partial<typeof WEATHER>) {
  if (w.snow !== undefined) WEATHER.snow = Math.max(0, Math.min(1, w.snow));
  if (w.wet !== undefined) WEATHER.wet = Math.max(0, Math.min(1, w.wet));
  if (w.frost !== undefined) WEATHER.frost = !!w.frost;
  for (const f of WEATHER_FN) f(WEATHER);
}
// called now and on every change (things that come and go with the weather: the floes, the frozen ponds)
export function onWeather(f: (w: typeof WEATHER) => void) { WEATHER_FN.push(f); f(WEATHER); }
// (medium: a material with an alt map shows the alt's map itself once the snow is half way; its maps follow the weather)
WEATHER_FN.push(() => { if (LEVEL === 1 && INDEX) for (const e of ALL) if (e.key && e.o.alt) apply(e); });

// ---------- the index (client/public/assets/mat/index.json, fetched at boot) ----------
interface KeyInfo { texel: number; mean: number[]; rough: number; raw: boolean; height: boolean; files: { c: number[]; n: number[] } }
let INDEX: Record<string, KeyInfo> | null = null, INDEX_FAILED = false;
const WAITING: (() => void)[] = [];
const BASE = 'assets/mat/';
// World of DODO, issue #31: the maps are asked for as soon as the index is in (they used to wait for the page's first idle moment
// after the boot). The city is built in slices now while the player fills in the form (main.ts), so the downloads run beside the
// build, and the loading screen after the start waits for them (matIssued, the scene's waiting items) up to its time limit.
// World of DODO, issue #34: tried again after a wait as core/assets.ts tries a texture (retryLater): its one try, refused during a
// deploy's restart or a dropped link, left the whole visit without textures. Meanwhile matIssued is false, so the loading screen
// waits for it (up to its time limit); a 404 or 410 (no such file) is final at once.
function getIndex(tries: number) {
  let status = 0;
  fetch(BASE + 'index.json').then(r => { status = r.status; if (!r.ok) throw new Error('index.json: ' + r.status); return r.json(); }).then((j: { keys: Record<string, KeyInfo> }) => {
    INDEX = j.keys; for (const f of WAITING.splice(0)) f();
  }).catch(() => {
    if (INDEX) return;                     // (a material's build after the index threw: not the download's fault; nothing waits)
    if (status !== 404 && status !== 410 && retryLater(tries, () => getIndex(tries + 1))) return;
    INDEX_FAILED = true;                   // no textures: every material keeps its tint
  });
}
getIndex(1);
// Issue #31: has every map the materials want been asked for? Then the scene's waiting items (Babylon counts every texture until it
// has loaded or failed) say how many are still on their way. True when the index failed.
// (World of DODO, issue #34: every level's files, wanted from core/assets.ts, so also on the low level, which shows none of them:
// a level change in the game must find them all in memory.)
export const matIssued = () => INDEX_FAILED || (!!INDEX && !WAITING.length);
const lum = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

// ---------- the quality level (game/quality.ts: 0 high, 1 medium, 2 low) ----------
// read at boot from the browser as quality.ts remembers it, so a weak device does not load the big maps first
// (World of DODO, issue #34: 'wod-q', its m: the preset chosen. The automatic texture step is never remembered, and the old
// 'wod-quality', which remembered it, is ignored: game/quality.ts removes it)
let LEVEL = 0;
try {
  const q = JSON.parse(localStorage.getItem('wod-q') ?? 'null') as { m?: unknown } | null;
  LEVEL = Math.max(0, Math.min(2, Number(q?.m) | 0));
} catch (_) { /* storage blocked or garbled: high */ }
export const matLevel = () => LEVEL;

// ---------- the plugin: world uvs, snow, wetness, macro variation ----------
const SKY_LO = new Color3(0.24, 0.27, 0.265), TO_MOON = new Vector3();
class WodSurface extends MaterialPluginBase {
  // height: 'c' the colour map's alpha (the library's maps), 'n' the normal map's alpha (a weatherMat's own maps), '' none
  world = true; snowK = 0; wetK = 0; macro = 0; altK = 0; height: '' | 'c' | 'n' = ''; rough = 0.8; baked = false;
  snowCol = new Color3(1, 1, 1);           // the snow's colour relative to the material's tint (the shader multiplies the tint back in)
  alt: Texture | null = null; altMul = new Color3(1, 1, 1); altScale = 1;
  altOld: Texture | null = null;           // issue #34: the alt map a level change took off, bound until it is disposed (retire)
  altRel = new Color3(1, 1, 1);            // the alt layer's tint relative to this one (the low level's flat alt)
  heightOn = 0;                            // 1: the colour map's alpha is a height (index.json), 0: it is not (a constant 0.5)
  constructor(m: StandardMaterial) {
    super(m, 'WodSurface', 200, {
      WODWORLD: false, WODSNOW: false, WODSNOWTEX: false, WODWET: false, WODMACRO: false, WODALT: false, WODHEIGHT: false, WODHEIGHTN: false,
      WODBAKED: false, WODLOW: false, WODLOWSNOW: false, WODLOWALT: false, WODMIDSNOW: false,
    }, true, true);
  }
  override getClassName() { return 'WodSurface'; }
  override prepareDefines(d: MaterialDefines) {
    const m = this._material as StandardMaterial;
    // (the low level: none of the textured work, the weather as a tint; the snow map always has something bound, a stand-in at first)
    // (medium: no snow map, noise or alt map, the snow by slope and height only)
    const low = LEVEL === 2, mid = LEVEL === 1, full = LEVEL === 0;
    d.WODLOW = low; d.WODLOWSNOW = low && this.snowK > 0 && !this.baked; d.WODLOWALT = low && this.altK > 0;
    d.WODMIDSNOW = mid && this.snowK > 0 && !this.baked;
    d.WODWORLD = this.world && !low; d.WODSNOW = full && this.snowK > 0 && !this.baked; d.WODSNOWTEX = d.WODSNOW; d.WODWET = this.wetK > 0;
    d.WODBAKED = this.baked && this.snowK > 0;
    d.WODMACRO = full && this.macro > 0; d.WODALT = full && !!this.alt && !!m.diffuseTexture;
    d.WODHEIGHT = !low && this.height === 'c' && !!m.diffuseTexture; d.WODHEIGHTN = !low && this.height === 'n' && !!m.bumpTexture;
  }
  override getSamplers(s: string[]) { s.push('wodSnowSampler', 'wodAltSampler', 'wodNoiseSampler'); }
  override getUniforms() {
    return {
      ubo: [{ name: 'wodW', size: 4, type: 'vec4' }, { name: 'wodS', size: 4, type: 'vec4' }, { name: 'wodA', size: 4, type: 'vec4' }, { name: 'wodM', size: 4, type: 'vec4' }, { name: 'wodX', size: 4, type: 'vec4' }],
      fragment: 'uniform vec4 wodW;\nuniform vec4 wodS;\nuniform vec4 wodA;\nuniform vec4 wodM;\nuniform vec4 wodX;\n',
    };
  }
  override getActiveTextures(a: BaseTexture[]) { if (this.alt) a.push(this.alt); if (SNOW_TEX.t) a.push(SNOW_TEX.t); }
  override hasTexture(t: BaseTexture) { return t === this.alt || t === SNOW_TEX.t; }
  override bindForSubMesh(ubo: UniformBuffer) {
    const W = WEATHER;
    // wodW: snow cover, wetness, macro strength, the alt layer's share; wodS: snow colour, 1 / snow tile; wodA: alt colour, alt uv scale;
    // wodM: towards the moon, roughness
    ubo.updateFloat4('wodW', W.snow * this.snowK, W.wet * this.wetK, this.macro, W.snow * this.altK);
    ubo.updateFloat4('wodS', this.snowCol.r, this.snowCol.g, this.snowCol.b, 1 / SNOW_TEX.texel);
    const low = LEVEL === 2, a = low ? this.altRel : this.altMul;
    ubo.updateFloat4('wodA', a.r, a.g, a.b, this.altScale);
    TO_MOON.copyFrom(moon.direction).normalize().scaleInPlace(-1);
    ubo.updateFloat4('wodM', TO_MOON.x, TO_MOON.y, TO_MOON.z, this.rough);
    ubo.updateFloat4('wodX', this.heightOn, 0, 0, 0);
    // (medium and low sample none of these; World of DODO, issue #34: but they are bound on every level. After a level change the
    // material is drawn with its old shader while the new one compiles (Babylon's shader hot swapping), and the old one of high
    // samples them: unbound, a sampler reads whatever the unit held last, for the compile's 0.3-0.8 s. An effect without the sampler
    // ignores the call.)
    if (this.snowK > 0 && !this.baked) ubo.setTexture('wodSnowSampler', SNOW_TEX.t);
    if (NOISE && ((this.snowK > 0 && !this.baked) || this.macro > 0)) ubo.setTexture('wodNoiseSampler', NOISE);
    else if (LEVEL === 0 && ((this.snowK > 0 && !this.baked) || this.macro > 0)) ubo.setTexture('wodNoiseSampler', noiseTex());
    const alt = this.alt ?? this.altOld; if (alt) ubo.setTexture('wodAltSampler', alt);
  }
  override getCustomCode(type: string): Nullable<{ [p: string]: string }> {
    if (type === 'vertex') return {
      // every face's uvs from its world position: from above for what faces (nearly) up or down, else along the face and up it
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `
#if defined(WODWORLD) && defined(UV1) && defined(NORMAL)
{
  vec3 wodN = normalize(mat3(finalWorld) * normalUpdated);
  if (wodN.y > 0.75) uvUpdated = vec2(worldPos.x, -worldPos.z);
  else if (wodN.y < -0.75) uvUpdated = vec2(worldPos.x, worldPos.z);
  else { vec3 wodT = normalize(vec3(wodN.z, 0.0, -wodN.x)); uvUpdated = vec2(dot(worldPos.xyz, wodT), dot(worldPos.xyz, cross(wodN, wodT))); }
}
#endif
`,
    };
    if (type !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef WODSNOWTEX
uniform sampler2D wodSnowSampler;
#endif
#ifdef WODALT
uniform sampler2D wodAltSampler;
#endif
#if defined(WODSNOW) || defined(WODMACRO)
uniform sampler2D wodNoiseSampler;
#endif
`,
      // after the colour map and the vertex colours: the macro patches, the alt layer, the snow, the wet darkening
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
#ifdef NORMAL
vec3 wodGn = normalize(vNormalW);
#else
vec3 wodGn = vec3(0.0, 1.0, 0.0);
#endif
float wodUp = smoothstep(0.45, 0.9, wodGn.y), wodH = 0.5, wodSm = 0.0, wodGloss = 0.0, wodPud = 0.0;
#ifdef WODLOW
// the low level: the weather as a tint (the alt layer's colour as the snow comes, the snow on what faces up, the rain darker)
#ifdef WODLOWALT
baseColor.rgb = mix(baseColor.rgb, wodA.rgb, clamp(wodW.w, 0.0, 1.0));
#endif
#ifdef WODLOWSNOW
baseColor.rgb = mix(baseColor.rgb, wodS.rgb, smoothstep(0.25, 0.75, wodW.x * wodUp));
#endif
#ifdef WODWET
baseColor.rgb *= 1.0 - 0.3 * wodW.y;
#endif
#endif
#if defined(WODHEIGHT) && defined(DIFFUSE)
wodH = mix(0.5, clamp(baseColor.a * 2.0 - 1.0, 0.0, 1.0), wodX.x);   // the colour map's alpha (vertex colours touch only rgb)
#elif defined(WODHEIGHTN) && defined(BUMP)
wodH = clamp(texture2D(bumpSampler, vBumpUV).a * 2.0 - 1.0, 0.0, 1.0);
#endif
#if defined(WODSNOW) || defined(WODMACRO)
vec3 wodNz = texture2D(wodNoiseSampler, vPositionW.xz * ${(1 / NOISE_U).toFixed(6)}).rgb;   // three octaves of noise: ${NOISE_U / 4}, ${NOISE_U / 8}, ${NOISE_U / 16} units
#endif
#ifdef WODMACRO
baseColor.rgb *= 1.0 + (wodNz.r * 0.65 + wodNz.b * 0.35 - 0.5) * wodW.z;
#endif
#if defined(WODALT) && defined(DIFFUSE)
{
  vec3 wodAc = texture2D(wodAltSampler, vDiffuseUV * wodA.w).rgb;
  float wodAt = 1.0 - clamp(dot(wodAc, vec3(0.333)), 0.0, 1.0);
  float wodAm = smoothstep(wodAt - 0.2, wodAt + 0.2, wodW.w * 1.5 - 0.25);
  baseColor.rgb = mix(baseColor.rgb, wodAc * wodA.rgb, wodAm);
  normalW = normalize(mix(normalW, wodGn, wodAm * 0.6));          // the trodden snow smooths the asphalt's cracks
}
#endif
#ifdef WODBAKED
{
  // today's snow is in the vertex colours: what is near white and faces up thaws to a bare grey as the weather's snow goes (no change at
  // snow 1, the default)
  float wodWhite = smoothstep(0.84, 0.92, min(baseColor.r, min(baseColor.g, baseColor.b)));
  baseColor.rgb = mix(baseColor.rgb, baseColor.rgb * vec3(0.4, 0.4, 0.41), (1.0 - wodW.x) * wodWhite * wodUp);
}
#endif
#ifdef WODMIDSNOW
// medium: the snow flat white, on what faces up, in the low parts of the map first; no drifts
wodSm = smoothstep(wodH - 0.18, wodH + 0.18, wodW.x * wodUp * 1.5 - 0.3);
baseColor.rgb = mix(baseColor.rgb, wodS.rgb * (1.0 - 0.3 * wodW.y), wodSm);
#endif
#ifdef WODSNOW
{
  float wodCov = wodW.x * wodUp * (0.7 + 0.6 * wodNz.g);
  wodSm = smoothstep(wodH - 0.18, wodH + 0.18, wodCov * 1.5 - 0.3);
#ifdef WODSNOWTEX
  vec3 wodSc = mix(vec3(1.0), texture2D(wodSnowSampler, vPositionW.xz * wodS.w).rgb * 2.0, 0.5) * wodS.rgb;   // the map at half its contrast
#else
  vec3 wodSc = wodS.rgb;
#endif
  wodSc *= 1.0 - 0.3 * wodW.y;
  baseColor.rgb = mix(baseColor.rgb, wodSc, wodSm);
  normalW = normalize(mix(normalW, wodGn, wodSm * 0.85));
}
#endif
#if defined(WODWET) && !defined(WODLOW)
{
  float wodWet = wodW.y * (1.0 - wodSm);
  wodPud = smoothstep(0.55, 0.9, wodW.y) * (1.0 - smoothstep(0.12, 0.38, wodH)) * wodUp * (1.0 - wodSm);
  baseColor.rgb *= 1.0 - wodWet * (0.22 + 0.28 * wodM.w) - wodPud * 0.2;
  wodGloss = wodWet * (0.25 + 0.5 * (1.0 - wodM.w)) + wodPud * 0.6;
}
#endif
`,
      // after lighting, before the fog: a wet surface mirrors the night sky (more at a grazing view) and the moon where it is lit
      CUSTOM_FRAGMENT_BEFORE_FOG: `
#if defined(WODWET) && !defined(WODLOW)
if (wodGloss > 0.001) {
  vec3 wodNs = normalize(mix(normalW, wodGn, clamp(wodPud * 1.5, 0.0, 1.0)));
  float wodFr = pow(1.0 - max(dot(wodNs, viewDirectionW), 0.0), 5.0);
  vec3 wodR = reflect(-viewDirectionW, wodNs);
  vec3 wodSky = mix(vec3(${SKY_LO.r}, ${SKY_LO.g}, ${SKY_LO.b}), vec3(0.035, 0.05, 0.05), smoothstep(0.0, 0.5, wodR.y));
  float wodGl = pow(max(dot(wodR, wodM.xyz), 0.0), 90.0) * shadow;
  color.rgb = mix(color.rgb, wodSky, clamp(wodGloss * (0.12 + 0.75 * wodFr), 0.0, 1.0)) + vec3(0.7, 0.76, 0.76) * wodGl * wodGloss;
}
#endif
`,
    };
  }
}

// ---------- the textures ----------
// one Texture per material and slot (its own scale and level); Babylon keeps one GPU copy of each file
// World of DODO, issue #31: the file is decoded beside the page before Babylon gets it. A map given to Babylon as a URL is decoded
// when it is uploaded, on the page's own thread and in one go (up to ~110 ms for one map on a laptop, ~280 ms for all the city's):
// the maps come now while the player types the name or the loading screen runs, so each was a stall there. So the file is fetched
// and made an ImageBitmap, which the browser decodes on another thread: turned upside down as it is made (WebGL ignores
// UNPACK_FLIP_Y for a bitmap; Babylon's own bitmap path does the same), its alpha not premultiplied (an alpha here is a height or a
// snow mask), its colours as stored. Babylon uploads it when its turn comes (the queue below) and the bitmap is let go (a lost GL
// context reloads the file by its URL). A file asked for again before its upload gets the same bitmap (DECODING), and after it finds
// that upload in Babylon's cache. Where the browser cannot do this (BITMAP_OK), or the file fails, Babylon loaded the URL itself (no
// longer: issue #34 below). Until it is in, the scene counts it
// as waiting (the loading screen's texture step reads getWaitingItemsCount).
// World of DODO, issue #34: the bytes are core/assets.ts's (downloaded before the game, kept for the visit), never fetched here: a
// level change in the game made requests, and on a slow connection the streets waited seconds for them. Where the browser cannot
// make the bitmap, the file is decoded as an image from its Blob (an object URL: the page's CSP allows img-src blob:), not loaded by
// its URL. A file that failed (assets.ts tried it twice) keeps its stand-in: no request in the game.
const BITMAP_OPT: ImageBitmapOptions = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
// does this browser make such a bitmap, turned? (a picture one wide and two high, red over blue: blue on top once turned)
const BITMAP_OK: Promise<boolean> = (async () => {
  try {
    if (typeof createImageBitmap !== 'function') return false;
    const b = await createImageBitmap(new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]), 1, 2), BITMAP_OPT);
    const c = document.createElement('canvas'); c.width = 1; c.height = 2;
    const g = c.getContext('2d', { willReadFrequently: true }); if (!g) return false;   // (a canvas in memory: read back at once)
    g.drawImage(b, 0, 0); b.close();
    const p = g.getImageData(0, 0, 1, 1).data;
    return p[2] > 200 && p[0] < 50;
  } catch (_) { return false; }
})();
// the files being decoded or waiting for their upload, so that a file asked for twice is fetched and decoded once
// (World of DODO, issue #31: kept until the last queued Texture of that decode is uploaded, upload(). The uploads wait for main.ts
// (startUploads), and until the first one Babylon's cache does not have the file, so a material made later in the build (the land's
// gravel after the roads') or a level Q went back to fetched and decoded it again, and held a second bitmap until the uploads.)
// (issue #34: the pixels, a bitmap or, without BITMAP_OK, an image)
type Pix = ImageBitmap | HTMLImageElement;
const DECODING = new Map<string, Promise<Pix | null>>();
// a file Babylon has already: the Texture finds it in Babylon's cache (upload(), which also handles Babylon letting it go meanwhile)
const IN_CACHE: Promise<Pix | null> = Promise.resolve(null);
const inCache = (url: string) => scene.getEngine().getLoadedTexturesCache().some(it => it.url === url);
function decoded(url: string): Promise<Pix | null> {
  let p = DECODING.get(url);
  if (p) return p;
  if (inCache(url)) return IN_CACHE;
  p = blob(url).then(async (b): Promise<Pix | null> => (!b ? null : (await BITMAP_OK) ? createImageBitmap(b, BITMAP_OPT) : imageOf(b))).catch(() => null);
  DECODING.set(url, p);
  return p;
}
// World of DODO, issue #34: a Blob as an image (decoded beside the page where the browser can; Babylon uploads an image with WebGL's
// own flip, as one it loads by URL), its object URL let go with it (pixGone)
function imageOf(b: Blob): Promise<HTMLImageElement | null> {
  const u = URL.createObjectURL(b), im = new Image();
  im.src = u;
  return im.decode().then(() => im, () => { URL.revokeObjectURL(u); return null; });
}
function pixGone(b: Pix | null) {
  if (!b) return;
  if (b instanceof HTMLImageElement) { if (b.src.startsWith('blob:')) URL.revokeObjectURL(b.src); b.removeAttribute('src'); } else b.close();
}
function load(url: string, onLoad: (t: Texture) => void): Texture {
  const t: Texture = new Texture(null, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  scene.addPendingData(t);
  queue(t, url, onLoad);
  return t;
}
// the file decoded (or found in Babylon's cache), then the Texture waits in the queue below
function queue(t: Texture, url: string, onLoad: (t: Texture) => void) {
  const d = decoded(url);
  void d.then(b => { UPLOADS.push({ t, url, d, b, onLoad, px: b ? b.width * b.height : 0 }); pumpSoon(); });
}
// World of DODO, issue #31: the uploads, queued. A decoded map used to be uploaded the moment it arrived, in the middle of the
// city's build behind the join form. An upload is quick on its own (on a laptop's GPU a 512 map 1-3 ms, the 2048 roof atlas
// 11-18 ms), but it hands its texels to the GPU process, and when that process is busy the page waits for it. During the build
// (one WebGL bufferData of the build's kept it busy 412 ms in a traced load) the atlas's upload took 170-400 ms in 7 loads of 27:
// the build's longest task (LOAD.longest, meant to stay under 50 ms) while the player types. Started at the city's end instead, the
// uploads met the pre-warm's shaders (main.ts): the atlas 13-142 ms, a 512 map once 344 ms, once 561 ms. So none goes before
// main.ts says so (startUploads): when the pre-warm is done and the intro is drawn (there the atlas took 21-57 ms, beside the
// frame, while the picture still fades in), or at a Start once the city is built (the loading screen covers the page then; nobody
// types; a start that ends before the pre-warm's end holds them again, stopUploads: main.ts abortRun). The build needs none: every
// material shows its stand-in until its map is in, so the intro's first frames show the stand-ins' tints while its picture fades
// in (client/index.html, html.city). Then at most one a frame, in an animation frame, the smallest first and the roof atlas last
// (the map a near view needs least). Each stays counted as waiting (the scene's pending data) until it is uploaded, so the loading
// screen's texture step still waits for them all; the stand-in is swapped as before (onLoad: no shader changes). Meanwhile a
// decoded map is held as a bitmap (outside the JS heap; on high 28 maps, 52 MB, the atlas 16 MB) until its last queued upload, from
// its arrival during the build to at most ~0.7 s after the intro's first frame.
// (d: the decode it shares with the other Textures of that file, b its bitmap)
interface Upload { t: Texture; url: string; d: Promise<Pix | null>; b: Pix | null; onLoad: (t: Texture) => void; px: number }
const UPLOADS: Upload[] = [];
let UPLOADS_ON = false, PUMP = false, RAF = 0;
// ?test: every upload of texels [file, texels, ms, when] (tools/browser-test.js, issue #31's report)
const UP_LOG: [string, number, number, number][] | null = new URLSearchParams(location.search).has('test') ? [] : null;
// main.ts: the queued maps may go now (and every later one as it comes), one a frame
export function startUploads() { UPLOADS_ON = true; pumpSoon(); }
// World of DODO, issue #31: a start that ends before the pre-warm is done (main.ts abortRun) holds them again: the form is back and
// the player types, while the pre-warm still keeps the GPU process busy (boot lets them go at the pre-warm's end, a new Start at once)
export function stopUploads() { UPLOADS_ON = false; }
// (a hidden tab has no animation frames: its uploads go on a timer meanwhile, slowly, as nothing is drawn there anyway; also when the
// tab is hidden while a frame is asked for, see below)
function pumpSoon() {
  if (PUMP || !UPLOADS_ON || !UPLOADS.length) return;
  PUMP = true;
  if (document.hidden) setTimeout(pump, 100); else RAF = requestAnimationFrame(pump);
}
// World of DODO, issue #31: a frame asked for while the tab was visible does not come while it is hidden, and PUMP keeps every later
// pumpSoon out, so hiding the tab during the uploads stopped the queue until it was shown (a Start's TEX_MS then ran out and the maps
// went in during the game's first frames). The frame is cancelled and the queue goes on on the timer instead: still one callback
// pending at a time, so pump never runs twice over. (A timer still pending when the tab is shown runs once; the next pumpSoon asks
// for frames again.)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && RAF) { cancelAnimationFrame(RAF); RAF = 0; setTimeout(pump, 100); }
});
function pump() {
  PUMP = false; RAF = 0;
  if (!UPLOADS_ON) return;                                           // (held again meanwhile, stopUploads; startUploads asks again)
  try {
    while (UPLOADS.length) {
      let k = 0; for (let i = 1; i < UPLOADS.length; i++) if (UPLOADS[i].px < UPLOADS[k].px) k = i;
      if (upload(UPLOADS.splice(k, 1)[0])) break;                   // (one real upload a frame; a map found in the cache costs nothing)
    }
  } finally { pumpSoon(); }                                          // (a map that threw does not stop the others)
}
// puts one map in; true if its texels were uploaded now
function upload(u: Upload): boolean {
  const { t, url, d, b, onLoad } = u, cached = inCache(url);
  // World of DODO, issue #31: Babylon had the file when this Texture asked for it (decoded), but has let it go since: a level change
  // asks for each material's new maps before the next material disposes its old ones (prime, apply; from high to medium in the snow,
  // the streets' alt map asphaltSnow becomes their colour map), and a stale map's onLoad throws its upload away. Babylon would load the
  // URL itself now, decoded on the page's thread (a stall; every such switch did it): decoded beside the page after all, queued again.
  if (d === IN_CACHE && !cached) { queue(t, url, onLoad); return false; }
  // (a file already in Babylon's cache, uploaded by another Texture of it, needs no upload: this one finds it there and costs no
  // frame; a bitmap already let go has no size)
  const bmp = b && b.width && !cached ? b : null;
  // World of DODO, issue #34: no pixels and no upload of the file in Babylon's cache. Before, Babylon then loaded the URL itself (a
  // request and a decode on the page's thread, in the game). Pixels let go meanwhile (a bitmap closed) are decoded again from the
  // file's Blob; a file that failed (its download, assets.ts, or its decode) keeps the material's stand-in (one that failed on the
  // network is fetched again by the next Texture of it: assets.ts blob(), a level change).
  if (!bmp && !cached) {
    if (DECODING.get(url) === d && (b || !UPLOADS.some(o => o.d === d))) DECODING.delete(url);
    if (b) queue(t, url, onLoad);
    else { scene.removePendingData(t); t.dispose(); }
    return false;
  }
  const t0 = UP_LOG ? performance.now() : 0;
  try { t.updateURL(url, bmp, () => onLoad(t)); }                  // (a bitmap is uploaded here and now; a URL as Babylon does)
  finally {
    scene.removePendingData(t);
    if (bmp) { const it = t.getInternalTexture(); if (it) it._buffer = null; t._buffer = null; }
    // World of DODO, issue #31: the bitmap and the shared decode stay while another queued Texture of this decode waits for them: if
    // this one's onLoad threw its map away (a level or weather changed meanwhile), Babylon's cache lost the file with it, and the
    // next one uploads the bitmap rather than load the URL itself (a decode on the page's thread, the stall this library avoids).
    // After the last one a file asked for again finds the upload in Babylon's cache (decoded).
    if (!UPLOADS.some(o => o.d === d)) { pixGone(b); if (DECODING.get(url) === d) DECODING.delete(url); }
  }
  if (UP_LOG && bmp) UP_LOG.push([url.replace(/^.*\//, ''), u.px, Math.round((performance.now() - t0) * 10) / 10, Math.round(t0)]);
  return !!bmp;
}
// World of DODO, issue #34: a map taken off a material (a level change, a newer map, a weather's swap on medium), kept a while
// before it is disposed. While it lives, Babylon keeps its upload in its cache, so a Texture of the same file made meanwhile finds it
// there (decoded: IN_CACHE) with no decode and no upload: on high to medium in the snow the streets' alt map, asphaltSnow, becomes
// their colour map; it used to be disposed first and loaded again (the dark dry asphalt for up to 1.4 s). It goes once the change has
// settled (no upload queued, nothing the scene waits for, every mesh drawn last frame with its final shader) or after RETIRE_MS.
// A stand-in (no file) goes at once. off: called when it is disposed (whoever still binds it lets go).
const RETIRE_MS = 3000;
const RETIRED: { t: BaseTexture; at: number; off?: () => void }[] = [];
let SWEEP = 0;
export function retire(t: Nullable<BaseTexture> | undefined, off?: () => void) {
  if (!t) return;
  if (!(t as Texture).url) { t.dispose(); off?.(); return; }
  if (RETIRED.some(r => r.t === t)) return;
  RETIRED.push({ t, at: performance.now(), off });
  if (!SWEEP) SWEEP = window.setTimeout(sweep, 250);
}
// (a material whose shader is compiling is drawn with its old one meanwhile, its defines left dirty: Babylon's hot swapping)
function settled(): boolean {
  if (UPLOADS.length || scene.getWaitingItemsCount()) return false;
  const a = scene.getActiveMeshes();
  for (let i = 0; i < a.length; i++) {
    for (const sm of a.data[i].subMeshes ?? []) { const d = sm.materialDefines, f = sm.effect; if (d?.isDirty || (f && !f.isReady())) return false; }
  }
  return true;
}
function sweep() {
  SWEEP = 0;
  const t = performance.now(); let ok: boolean;
  try { ok = settled(); } catch (_) { ok = false; }                  // (a mesh disposed meanwhile: the time limit decides)
  for (let i = RETIRED.length; i--;) {
    const r = RETIRED[i];
    if (t - r.at >= RETIRE_MS || (ok && t - r.at >= 200)) { RETIRED.splice(i, 1); r.t.dispose(); r.off?.(); }
  }
  if (RETIRED.length) SWEEP = window.setTimeout(sweep, 250);
}
// World of DODO, issue #31: a map for a material that already shows a stand-in (standIn): the file is fetched, and onLoad puts it in
// (and sets its scale, level, filtering) once it has arrived. A map put into a material while it loads keeps the material from being
// drawn at all (Babylon waits for a loading map), so nothing outside this library assigns one before it has loaded. Repeating, as
// load(); the caller may set another wrap mode at once. A file that fails keeps the stand-in.
// (World of DODO, issue #34: the file's bytes come from core/assets.ts: its owner wants it when the material is made, for every
// level the material can show, or a level change in the game downloads it, ASSET.miss)
export const loadSwap = load;
const ANISO = [4, 2, 1];
// The noise of the macro patches and the snow's drifts: smooth value noise that tiles, three octaves in r, g, b (4, 8 and 16 cells
// across), sampled once a pixel at the world position, one texture over NOISE_U units (a texture read is cheaper than hashing
// the noise in the shader). Made once, from hashes (the same in every browser).
const NOISE_U = 96;
let NOISE: RawTexture | null = null;
function noiseTex(): RawTexture {
  if (NOISE) return NOISE;
  const S = 128, d = new Uint8Array(S * S * 4), h = (i: number, j: number, k: number) => {
    let x = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 2147483587); x = Math.imul(x ^ (x >>> 13), 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  for (let c = 0; c < 3; c++) {
    const n = 4 << c, cell = S / n;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = x / cell, fy = y / cell, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
      const a = h(i % n, j % n, c), b = h((i + 1) % n, j % n, c), e = h(i % n, (j + 1) % n, c), f = h((i + 1) % n, (j + 1) % n, c);
      d[(y * S + x) * 4 + c] = Math.round(255 * (a + (b - a) * su + (e - a) * sv + (a - b - e + f) * su * sv));
    }
  }
  for (let k = 3; k < d.length; k += 4) d[k] = 255;
  NOISE = RawTexture.CreateRGBATexture(d, S, S, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  NOISE.wrapU = NOISE.wrapV = Texture.WRAP_ADDRESSMODE;
  return NOISE;
}
// A 1×1 stand-in for a map that has not arrived yet: its average (colour maps are 0.5 on average, their alpha 0.75: a height of 0.5),
// a flat normal, or no glow. The material is compiled once with it, as with the real map, which then only replaces it.
// (World of DODO, issue #31: 'nh' a flat normal whose alpha is a middling height, for a normal map that carries a height or a snow
// mask in its alpha: the roof atlas's; 'n' keeps 255, the library's normal maps have no height, and the roof tiles' 255 is "no joint".)
const STAND = { c: [128, 128, 128, 192], n: [128, 128, 255, 255], nh: [128, 128, 255, 192], e: [0, 0, 0, 255] };
export type StandKind = keyof typeof STAND;
function stand(k: StandKind, level: number, ident = false): Texture {
  const t = RawTexture.CreateRGBATexture(new Uint8Array(STAND[k]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE; t.level = level;
  // a texture matrix that is the identity or not changes the shader (Babylon's DIFFUSEDIRECTUV and the like): the stand-in has the
  // real map's. The library's maps are scaled (not the identity); a map on the mesh's own uvs (an atlas) is the identity: ident
  t.uScale = t.vScale = ident ? 1 : 0.5;
  return t;
}
// World of DODO, issue #31: a stand-in for a map of one's own (world/facade.ts, world/buildings.ts), as the library's own: ready at
// once, so the material compiles for its final look before the start and is drawn from the first frame; loadSwap puts the map in.
export const standIn = stand;
// the snow layer's texture, one for all (sampled at the world position, no matrix): its stand-in until the real one is in
// (World of DODO, issue #34: on the high level only: medium and low sample no snow map, medium used to load it all the same. Leaving
// high, the map is retired and the stand-in takes its place.)
const SNOW_TEX: { t: Texture; url: string; texel: number } = { t: stand('c', 1), url: '', texel: 3.5 };
const snowUrl = () => (INDEX && INDEX.snow ? BASE + Math.max(...INDEX.snow.files.c) + '/snow_c.webp' : '');
function snowTex() {
  if (!INDEX || !INDEX.snow) return;
  const url = LEVEL === 0 ? snowUrl() : '';
  if (SNOW_TEX.url === url) return;
  SNOW_TEX.url = url; SNOW_TEX.texel = INDEX.snow.texel;
  if (!url) { const old = SNOW_TEX.t; SNOW_TEX.t = stand('c', 1); retire(old); return; }
  const t = load(url, () => {
    if (SNOW_TEX.url !== url) { retire(t); return; }
    const old = SNOW_TEX.t; SNOW_TEX.t = t; retire(old);
    t.anisotropicFilteringLevel = 1;                                     // soft: plain trilinear filtering will do
  });
}

// ---------- the materials ----------
interface Entry { key: MatKey | null; o: WeatherOpts; m: StandardMaterial; p: WodSurface; on: { c: string; n: string; a: string }; want: { c: string; n: string; a: string }; tint: Color3 }
const ALL: Entry[] = [];
const SHARED = new Map<string, StandardMaterial>();

function baseMat(name: string, o: WeatherOpts, tint: number): { m: StandardMaterial; p: WodSurface } {
  const m = new StandardMaterial(name, scene);
  m.specularColor = Color3.Black();                    // the scene's lights have no specular; the wet sheen is the plugin's own
  m.diffuseColor = c3(tint);
  if (o.double) { m.backFaceCulling = false; m.twoSidedLighting = true; }
  if (o.zOffset) { m.zOffset = -o.zOffset / 4; m.zOffsetUnits = -o.zOffset; }
  if (o.emissive !== undefined || o.emissiveMap) {
    m.useEmissiveAsIllumination = true;               // the glow after the colour and the vertex colours, as core/mat.ts lambert
    if (o.emissiveMap && o.emissiveMap !== 'self') { m.emissiveTexture = o.emissiveMap; m.emissiveTexture.level = o.emissiveIntensity ?? 1; m.emissiveColor = Color3.Black(); }
    else if (o.emissive !== undefined) m.emissiveColor = c3(o.emissive).scale(o.emissiveIntensity ?? 1);
  }
  const p = new WodSurface(m);
  p.world = (o.uv ?? 'world') === 'world';
  p.macro = o.macro ?? 0;
  return { m, p };
}
// the snow's colour, relative to the tint (the shader's lighting multiplies the tint back in; the snow map's average is 0.5, as
// tools/assets/materials.py makes every colour map, and the shader doubles it)
function setSnowCol(e: Entry) {
  const t = e.m.diffuseColor, s = c3(LOOK.snow[0]);
  e.p.snowCol.set(s.r / Math.max(0.05, t.r), s.g / Math.max(0.05, t.g), s.b / Math.max(0.05, t.b));
}
// the key whose colour map a material shows: its own, or on medium its alt's once the weather's snow is half way (one map, no blend)
const mapKey = (e: Entry): MatKey => (LEVEL === 1 && e.o.alt && WEATHER.snow >= 0.5 ? e.o.alt : e.key!);
// the files a material wants at a level (World of DODO, issue #34: any level, and on medium in a weather with snow or without)
function filesFor(e: Entry, lv: number, snowy: boolean): { c: string; n: string; a: string } {
  const w = { c: '', n: '', a: '' };
  if (!e.key || !INDEX || lv === 2) return w;                          // the low level: no maps at all (its tint, the weather as a tint)
  const k = lv === 1 && e.o.alt && snowy ? e.o.alt : e.key, info = INDEX[k]; if (!info) return w;
  w.c = BASE + cSize(info, lv) + '/' + k + '_c.webp';
  if (lv === 0 && (e.o.bump ?? 1) > 0 && info.files.n.length) {        // normal maps on high only
    w.n = BASE + (info.files.n.includes(1024) ? 1024 : 512) + '/' + k + '_n.webp';
  }
  if (lv === 0 && e.o.alt && INDEX[e.o.alt]) w.a = BASE + cSize(INDEX[e.o.alt], lv) + '/' + e.o.alt + '_c.webp';
  return w;
}
// the files a material wants now (mapKey's choice)
const wantFor = (e: Entry) => filesFor(e, LEVEL, WEATHER.snow >= 0.5);
// World of DODO, issue #34: every file the material can show, at every level and in every weather, wanted now from core/assets.ts
// (downloaded before the game), and the snow map, which high shows on everything that takes snow
function wantAll(e: Entry) {
  for (const lv of [0, 1]) for (const snowy of [false, true]) { const w = filesFor(e, lv, snowy); for (const u of [w.c, w.n, w.a]) if (u) want(u); }
  const s = snowUrl(); if (s) want(s);
}
// load what is wanted and put each map in when it has arrived (the old one stays until then)
// the stand-ins a library material has at this level before its maps come (none on low): the shader is compiled for its final look
function prime(e: Entry) {
  if (!e.key) return;
  const low = LEVEL === 2, glow = e.o.emissiveMap === 'self';
  if (low) {
    const d = e.m.diffuseTexture, b = e.m.bumpTexture;
    e.m.diffuseTexture = null; e.m.bumpTexture = null; e.on = { c: '', n: '', a: '' };
    retire(d); retire(b); altOff(e);                                   // (issue #34: retired, see retire)
    if (glow && e.m.emissiveTexture) { const g = e.m.emissiveTexture; e.m.emissiveTexture = null; retire(g); }
    return;
  }
  if (!e.m.diffuseTexture) e.m.diffuseTexture = stand('c', glow ? 0.3 : 2);   // (0.5 × 2: the tint itself; a glass facade dark)
  if (glow && !e.m.emissiveTexture) { e.m.emissiveTexture = stand('e', 1); e.m.emissiveColor = Color3.Black(); }
  const full = LEVEL === 0;                                              // (normal and alt maps on high only)
  if (full && (e.o.bump ?? 1) > 0 && !e.m.bumpTexture) e.m.bumpTexture = stand('n', 1);
  if (!full && e.m.bumpTexture) { const b = e.m.bumpTexture; e.m.bumpTexture = null; e.on.n = ''; retire(b); }
  if (full && e.o.alt && !e.p.alt) { e.p.alt = stand('c', 1); e.p.altMul.copyFrom(e.p.altRel).scaleInPlace(2); }
  if (!full && e.p.alt) altOff(e);
}
// World of DODO, issue #34: the alt map off the material, retired; the plugin still binds it until it is disposed (the old shader of a
// level change samples it while the new one compiles)
function altOff(e: Entry) {
  const a = e.p.alt; if (!a) return;
  e.p.alt = null; e.on.a = ''; e.p.altOld = a;
  retire(a, () => { if (e.p.altOld === a) e.p.altOld = null; });
}
// swap a map in when it has arrived (the stand-in or the old map stays until then); no shader changes
function apply(e: Entry) {
  prime(e);
  const w = wantFor(e), k = e.key ? mapKey(e) : null, info = k && INDEX ? INDEX[k] : null;
  e.want = w;
  if (!info || !k) return;
  const tile = info.texel * (e.o.scale ?? 1);
  // World of DODO, issue #34: a map kept across the change (the same file at both levels: most colour maps are 512 on high and
  // medium) gets this level's filtering: it kept the level's it was loaded on
  if (w.c && w.c === e.on.c && e.m.diffuseTexture) e.m.diffuseTexture.anisotropicFilteringLevel = ANISO[LEVEL];
  if (w.a && w.a === e.on.a && e.p.alt) e.p.alt.anisotropicFilteringLevel = ANISO[LEVEL];
  if (w.c && w.c !== e.on.c) {
    const url = w.c;
    const t = load(url, () => {
      if (e.want.c !== url) { retire(t); return; }
      t.uScale = t.vScale = 1 / tile; t.anisotropicFilteringLevel = ANISO[LEVEL];
      t.level = !info.raw ? 1 / lum(info.mean) : 1;                    // the average back to 1: the tint decides the brightness
      const old = e.m.diffuseTexture; e.m.diffuseTexture = t; e.on.c = url; retire(old);   // (issue #34: retired)
      // the tint of the key shown (medium's snowy street: the alt's, relative to the base as given), its height, the snow against it
      e.m.diffuseColor.copyFrom(e.tint); if (k !== e.key) e.m.diffuseColor.multiplyInPlace(e.p.altRel);
      e.p.heightOn = info.height ? 1 : 0; setSnowCol(e);
      if (e.o.emissiveMap === 'self') {                                  // the same file as the glow (its own Texture: its own level)
        const g = load(url, () => { if (e.want.c !== url) { retire(g); return; } g.uScale = g.vScale = 1 / tile; g.level = e.o.emissiveIntensity ?? 1; const og = e.m.emissiveTexture; e.m.emissiveTexture = g; if (og !== g) retire(og); });
      }
    });
  }
  if (w.n && w.n !== e.on.n) {
    const url = w.n;
    const t = load(url, () => {
      if (e.want.n !== url) { retire(t); return; }
      t.uScale = t.vScale = 1 / tile; t.level = e.o.bump ?? 1;      // no anisotropic filtering: at a grazing view the bumps may blur
      const old = e.m.bumpTexture; e.m.bumpTexture = t; e.on.n = url; retire(old);
    });
  }
  if (w.a && w.a !== e.on.a) {
    const url = w.a, ai = INDEX![e.o.alt!];
    const t = load(url, () => {
      if (e.want.a !== url) { retire(t); return; }
      t.anisotropicFilteringLevel = ANISO[LEVEL];
      // the alt colour: its tint relative to this material's, its map's average back to 1; its tiles in this one's uvs
      e.p.altMul.copyFrom(e.p.altRel).scaleInPlace(1 / lum(ai.mean));
      e.p.altScale = tile / (ai.texel * (e.o.scale ?? 1));
      const old = e.p.alt; e.p.alt = t; e.on.a = url; retire(old);
    });
  }
}
function register(key: MatKey | null, o: WeatherOpts, m: StandardMaterial, p: WodSurface): Entry {
  const e: Entry = { key, o, m, p, on: { c: '', n: '', a: '' }, want: { c: '', n: '', a: '' }, tint: m.diffuseColor.clone() };
  ALL.push(e); setSnowCol(e);
  if (key && o.alt) { const at = c3(LOOK[o.alt][0]), mt = m.diffuseColor; p.altRel.set(at.r / Math.max(0.05, mt.r), at.g / Math.max(0.05, mt.g), at.b / Math.max(0.05, mt.b)); }
  if (key) p.height = 'c';                                               // (whether the alpha is a height: wodX, from index.json)
  prime(e);
  const go = () => { wantAll(e); snowTex(); if (key) { const info = INDEX![key]; if (info) p.rough = info.rough; } setSnowCol(e); apply(e); };
  if (INDEX) go(); else WAITING.push(go);
  return e;
}

// A material of the library: the key's maps, tinted, with the weather. The same key and options give the same material.
export function matTex(key: MatKey, o: MatOpts = {}): StandardMaterial {
  const id = key + JSON.stringify(o, (k, v) => (k === 'emissiveMap' && v && typeof v === 'object' ? 'tex' + (v as BaseTexture).uniqueId : v));
  const had = SHARED.get(id); if (had) return had;
  const [tint, snow, wet] = LOOK[key];
  const { m, p } = baseMat('mat_' + key, o, o.tint ?? tint);
  p.snowK = o.snow ?? snow; p.wetK = o.wet ?? wet; p.altK = o.alt ? 1 : 0;
  register(key, o, m, p);
  SHARED.set(id, m);
  return m;
}
// A material of your own maps with the library's weather (see WeatherOpts). Not shared: one per call.
export function weatherMat(o: WeatherOpts): StandardMaterial {
  const { m, p } = baseMat('weather', { uv: 'mesh', ...o }, o.tint ?? 0xffffff);
  p.world = (o.uv ?? 'mesh') === 'world';
  p.snowK = o.snow ?? 1; p.wetK = o.wet ?? 0.8;
  if (o.map) { m.diffuseTexture = o.map; o.map.level = 1 / (o.mean ?? 0.5); if (o.scale) { (o.map as Texture).uScale = (o.map as Texture).vScale = 1 / o.scale; } }
  if (o.bumpMap) m.bumpTexture = o.bumpMap;
  // the height from the normal map's alpha whenever there is one: a page that starts on the low level (no normal map) and gets one
  // later (onMatLevel) has its snow mask from then on, and loses it again without (the shader's defines follow bumpTexture)
  p.height = o.height ? 'n' : '';
  p.baked = !!o.baked;
  const e = register(null, o, m, p);
  e.o = { ...o, uv: o.uv ?? 'mesh' };
  return m;
}
// A material's snow, wetness or macro afterwards (e.g. less snow on a steep roof's material), by uniforms
export function setMatWeather(m: StandardMaterial, w: { snow?: number; wet?: number; macro?: number }) {
  const e = ALL.find(x => x.m === m); if (!e) return;
  if (w.snow !== undefined) { const was = e.p.snowK > 0; e.p.snowK = w.snow; if (was !== w.snow > 0) e.p.markAllDefinesAsDirty(); }
  if (w.wet !== undefined) { const was = e.p.wetK > 0; e.p.wetK = w.wet; if (was !== w.wet > 0) e.p.markAllDefinesAsDirty(); }
  if (w.macro !== undefined) { const was = e.p.macro > 0; e.p.macro = w.macro; if (was !== w.macro > 0) e.p.markAllDefinesAsDirty(); }
}

// The quality level changed (game/quality.ts): every material loads its maps for it, then lets the old ones go; then whoever
// listens (onMatLevel: the owners of weatherMat maps, e.g. the roof atlas) swaps theirs.
const LEVEL_FN: ((l: number) => void)[] = [];
export function onMatLevel(f: (level: number) => void) { LEVEL_FN.push(f); }
export function setMatLevel(level: number) {
  const l = Math.max(0, Math.min(2, level | 0)); if (l === LEVEL) return;
  LEVEL = l;
  if (INDEX) snowTex();
  for (const e of ALL) { if (e.key) apply(e); e.p.markAllDefinesAsDirty(); }   // (the low level's defines, or back)
  for (const f of LEVEL_FN) f(l);
}
// the library's GPU memory (MB, texels × 4 bytes + a third for the mip maps), each file once
export function matVramMB(): number {
  const seen = new Set<string>(); let mb = 0;
  const add = (t: Nullable<BaseTexture>) => {
    const it = t?.getInternalTexture(); if (!it || !it.url || seen.has(it.url)) return; seen.add(it.url);
    mb += it.width * it.height * 4 * (it.generateMipMaps ? 4 / 3 : 1) / 1048576;
  };
  for (const e of ALL) { add(e.m.diffuseTexture); add(e.m.bumpTexture); add(e.p.alt); add(e.m.emissiveTexture); }
  add(SNOW_TEX.t);
  return Math.round(mb * 10) / 10;
}
// the tests' handle (?test, as main.ts's WOD): the weather, the level, the memory (issue #31: the uploads, the queue's length)
if (new URLSearchParams(location.search).has('test')) {
  (window as unknown as { wodMat: unknown }).wodMat = { setWeatherLook, setMatLevel, matVramMB, WEATHER, uploads: UP_LOG, queued: () => UPLOADS.length,
    retired: () => RETIRED.length };                                    // issue #34: the maps retired, not yet disposed
}
