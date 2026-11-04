// World of DODO, issue #16: the downloads, each cached in tools/karlin/cache/ (gitignored) so that a re-run is offline and
// gives the same file. `--refresh` (or deleting a cache file) downloads again. One request at a time, a User-Agent that says
// who we are, and a pause between pages: the services are free and shared.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outerBBox } from './frame.mjs';
import { readTiff } from './tiff.mjs';

export const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cache');
const UA = 'WorldOfDODO-karlin-generator/1.0 (+https://github.com/Rajcze33/world-of-dodo)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REFRESH = process.argv.includes('--refresh');

async function cached(name, get) {
  const f = path.join(CACHE, name);
  if (!REFRESH && fs.existsSync(f)) return fs.readFileSync(f);
  fs.mkdirSync(CACHE, { recursive: true });
  console.log('download', name);
  const buf = await get();
  fs.writeFileSync(f, buf);
  return buf;
}
async function req(url, opt = {}, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { ...opt, headers: { 'User-Agent': UA, ...(opt.headers || {}) }, signal: AbortSignal.timeout(400000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      const t = (await r.text()).slice(0, 300);
      if (i + 1 >= tries || (r.status !== 429 && r.status < 500)) throw new Error(`${r.status} ${url}\n${t}`);
    } catch (e) { if (i + 1 >= tries) throw e; console.log('  retry after', e.message.split('\n')[0]); }
    await sleep(15000 * (i + 1));
  }
}

// ---- OpenStreetMap (ODbL) through Overpass: one combined query over the bbox of the outer square ----
export function overpassQuery() {
  const b = outerBBox(), bb = [b.s, b.w, b.n, b.e].map(v => v.toFixed(5)).join(',');
  // `out body geom` keeps the node ids (the road graph is noded at shared OSM nodes) and the coordinates
  return `[out:json][timeout:600][maxsize:1073741824][bbox:${bb}];
(way["building"];relation["building"]["type"="multipolygon"];);out body geom;
(way["building:part"];relation["building:part"]["type"="multipolygon"];);out body geom;
way["highway"];out body geom;
(way["area:highway"];way["place"="square"];relation["place"="square"];);out body geom;
way["railway"];out body geom;
(way["man_made"="bridge"];relation["man_made"="bridge"];);out body geom;
node["railway"~"^(tram_stop|stop|halt|station)$"];out body;
node["public_transport"~"^(stop_position|platform)$"];out body;
node["natural"="tree"];out body;
way["natural"="tree_row"];out body geom;
(way["leisure"~"^(park|garden|playground|pitch)$"];relation["leisure"~"^(park|garden)$"];
 way["landuse"~"^(grass|forest|recreation_ground|meadow|village_green|cemetery)$"];relation["landuse"~"^(grass|forest|recreation_ground|cemetery)$"];
 way["natural"~"^(wood|scrub|grassland)$"];relation["natural"~"^(wood|scrub)$"];);out body geom;
(way["natural"="water"];relation["natural"="water"];way["waterway"="riverbank"];relation["waterway"="riverbank"];
 way["landuse"~"^(basin|reservoir)$"];);out body geom;
(nwr["amenity"~"^(theatre|place_of_worship)$"];nwr["historic"~"^(memorial|monument)$"];nwr["tourism"="attraction"];);out tags center;
`;
}
export async function overpass() {
  const q = overpassQuery();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'overpass.overpassql'), q);
  const buf = await cached('overpass.json', async () => {
    let last;
    for (const ep of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
      try {
        return await req(ep, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 2);
      } catch (e) { last = e; console.log('  overpass endpoint failed:', ep, e.message.split('\n')[0]); }
    }
    throw last;
  });
  return JSON.parse(buf.toString('utf8'));
}

// ---- IPR Praha "Podlažnost budov" (CC BY 4.0): floors and roof shape, paged by resultOffset ----
const IPR = 'https://mp.iprpraha.cz/arcgis/rest/services/Hosted/URK_CUR_URK_SS_PODLAZNOST_P/FeatureServer/0';
export async function ipr() {
  const meta = JSON.parse((await cached('ipr-meta.json', () => req(IPR + '?f=json'))).toString('utf8'));
  const per = Math.min(meta.maxRecordCount || 1000, 2000), b = outerBBox();
  const feats = [];
  for (let off = 0, page = 0; ; off += per, page++) {
    const buf = await cached(`ipr-${String(page).padStart(3, '0')}.json`, async () => {
      await sleep(400);
      return req(IPR + '/query', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          f: 'json', where: '1=1', outFields: 'objectid,typ,podlaz_celk,pocet_podlazi,strecha,ustup_stres,nova_budova',
          geometry: JSON.stringify({ xmin: b.w, ymin: b.s, xmax: b.e, ymax: b.n, spatialReference: { wkid: 4326 } }),
          geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
          returnGeometry: 'true', orderByFields: 'objectid', resultOffset: String(off), resultRecordCount: String(per),
        }),
      });
    });
    const j = JSON.parse(buf.toString('utf8'));
    if (j.error) throw new Error('IPR: ' + JSON.stringify(j.error));
    feats.push(...j.features);
    if (!j.exceededTransferLimit && j.features.length < per) break;
    if (!j.features.length) break;
  }
  return { meta, feats };
}

// ---- terrain: ČÚZK DMR 5G (CC BY 4.0) through its ImageServer exportImage (getSamples is forbidden there) ----
const DMR = 'https://ags.cuzk.cz/arcgis2/rest/services/dmr5g/ImageServer';
export async function dmr(px = 5) {
  const b = outerBBox(60);
  const wm = (b.e - b.w) * 111320 * Math.cos(50.09 * Math.PI / 180), hm = (b.n - b.s) * 110540;
  const W = Math.round(wm / px), H = Math.round(hm / px);
  const meta = JSON.parse((await cached('dmr-export.json', () => req(DMR + '/exportImage?' + new URLSearchParams({
    bbox: [b.w, b.s, b.e, b.n].join(','), bboxSR: '4326', imageSR: '4326', size: `${W},${H}`, format: 'tiff',
    pixelType: 'F32', compression: 'None', interpolation: 'RSP_BilinearInterpolation', f: 'json',
  })))).toString('utf8'));
  if (!meta.href) throw new Error('DMR exportImage: ' + JSON.stringify(meta).slice(0, 300));
  const tif = await cached('dmr.tif', () => req(meta.href));
  return { ...readTiff(tif), extent: meta.extent };
}
