// The tram's track as a smooth closed curve: the parts of three.js r128's CatmullRomCurve3 (and of its base class Curve) that
// the tram uses, ported operation for operation. The server builds the same curve with three.js itself (server/world.js) and
// sends only the tram's distance along it, so the points here must come out exactly as there: keep the order of every
// operation as in three.js (r128, src/extras/curves/CatmullRomCurve3.js and src/extras/core/Curve.js).
//
// No imports and only erasable TypeScript, so that Node can load this file as it is to compare it with three.js.

export interface XYZ { x: number; y: number; z: number }
export type CurveType = 'centripetal' | 'chordal' | 'catmullrom';

// a cubic between two values, from their tangents (three's CubicPoly)
class CubicPoly {
  c0 = 0; c1 = 0; c2 = 0; c3 = 0;
  private init(x0: number, x1: number, t0: number, t1: number) {
    this.c0 = x0;
    this.c1 = t0;
    this.c2 = -3 * x0 + 3 * x1 - 2 * t0 - t1;
    this.c3 = 2 * x0 - 2 * x1 + t0 + t1;
  }
  initCatmullRom(x0: number, x1: number, x2: number, x3: number, tension: number) {
    this.init(x1, x2, tension * (x2 - x0), tension * (x3 - x1));
  }
  initNonuniformCatmullRom(x0: number, x1: number, x2: number, x3: number, dt0: number, dt1: number, dt2: number) {
    // tangents when parameterised in [t1, t2]
    let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
    let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
    // rescaled for the parameterisation in [0, 1]
    t1 *= dt1;
    t2 *= dt1;
    this.init(x1, x2, t1, t2);
  }
  calc(t: number) { const t2 = t * t; return this.c0 + this.c1 * t + this.c2 * t2 + this.c3 * (t2 * t); }
}

const px = new CubicPoly(), py = new CubicPoly(), pz = new CubicPoly();
const tmp: XYZ = { x: 0, y: 0, z: 0 };
// three's Vector3.distanceToSquared / distanceTo
const distSq = (a: XYZ, b: XYZ) => { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; };
const dist = (a: XYZ, b: XYZ) => Math.sqrt(distSq(a, b));

export class CatmullRomCurve3 {
  points: XYZ[];
  closed: boolean;
  curveType: CurveType;
  tension: number;
  arcLengthDivisions = 200;                          // three's default: the arc lengths are sampled at 201 points
  private cacheArcLengths: number[] | null = null;

  constructor(points: XYZ[] = [], closed = false, curveType: CurveType = 'centripetal', tension = 0.5) {
    this.points = points; this.closed = closed; this.curveType = curveType; this.tension = tension;
  }

  // the point at t (0..1 over the control points, not over the length)
  getPoint(t: number, out: XYZ = { x: 0, y: 0, z: 0 }): XYZ {
    const points = this.points, l = points.length;
    const p = (l - (this.closed ? 0 : 1)) * t;
    let intPoint = Math.floor(p), weight = p - intPoint;
    if (this.closed) intPoint += intPoint > 0 ? 0 : (Math.floor(Math.abs(intPoint) / l) + 1) * l;
    else if (weight === 0 && intPoint === l - 1) { intPoint = l - 2; weight = 1; }
    let p0: XYZ, p3: XYZ;                            // the 4 points (p1 and p2 below)
    if (this.closed || intPoint > 0) p0 = points[(intPoint - 1) % l];
    else {                                           // extrapolate the first point
      tmp.x = points[0].x - points[1].x + points[0].x; tmp.y = points[0].y - points[1].y + points[0].y; tmp.z = points[0].z - points[1].z + points[0].z;
      p0 = tmp;
    }
    const p1 = points[intPoint % l], p2 = points[(intPoint + 1) % l];
    if (this.closed || intPoint + 2 < l) p3 = points[(intPoint + 2) % l];
    else {                                           // extrapolate the last point
      tmp.x = points[l - 1].x - points[l - 2].x + points[l - 1].x; tmp.y = points[l - 1].y - points[l - 2].y + points[l - 1].y; tmp.z = points[l - 1].z - points[l - 2].z + points[l - 1].z;
      p3 = tmp;
    }
    if (this.curveType === 'centripetal' || this.curveType === 'chordal') {
      const pow = this.curveType === 'chordal' ? 0.5 : 0.25;
      let dt0 = Math.pow(distSq(p0, p1), pow), dt1 = Math.pow(distSq(p1, p2), pow), dt2 = Math.pow(distSq(p2, p3), pow);
      // safety check for repeated points
      if (dt1 < 1e-4) dt1 = 1.0;
      if (dt0 < 1e-4) dt0 = dt1;
      if (dt2 < 1e-4) dt2 = dt1;
      px.initNonuniformCatmullRom(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2);
      py.initNonuniformCatmullRom(p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2);
      pz.initNonuniformCatmullRom(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2);
    } else if (this.curveType === 'catmullrom') {
      px.initCatmullRom(p0.x, p1.x, p2.x, p3.x, this.tension);
      py.initCatmullRom(p0.y, p1.y, p2.y, p3.y, this.tension);
      pz.initCatmullRom(p0.z, p1.z, p2.z, p3.z, this.tension);
    }
    out.x = px.calc(weight); out.y = py.calc(weight); out.z = pz.calc(weight);
    return out;
  }

  // the point at u (0..1 over the length)
  getPointAt(u: number, out?: XYZ): XYZ { return this.getPoint(this.getUtoTmapping(u), out); }

  // divisions + 1 points evenly spaced along the length (the last one is the first again on a closed curve)
  getSpacedPoints(divisions = 5): XYZ[] {
    const points: XYZ[] = [];
    for (let d = 0; d <= divisions; d++) points.push(this.getPointAt(d / divisions));
    return points;
  }

  getLength(): number { const lengths = this.getLengths(); return lengths[lengths.length - 1]; }

  // the length from the start at divisions + 1 evenly spaced t, measured along the chords between them (cached)
  getLengths(divisions = this.arcLengthDivisions): number[] {
    if (this.cacheArcLengths && this.cacheArcLengths.length === divisions + 1) return this.cacheArcLengths;
    const cache = [0];
    let last = this.getPoint(0), sum = 0;
    for (let p = 1; p <= divisions; p++) {
      const current = this.getPoint(p / divisions);
      sum += dist(current, last);
      cache.push(sum);
      last = current;
    }
    this.cacheArcLengths = cache;
    return cache;
  }

  // u (or a distance along the curve) → t, by a binary search in the arc lengths and a straight line between two of them
  getUtoTmapping(u: number, distance?: number): number {
    const arcLengths = this.getLengths(), il = arcLengths.length;
    const targetArcLength = distance ? distance : u * arcLengths[il - 1];
    let i = 0, low = 0, high = il - 1;
    while (low <= high) {
      i = Math.floor(low + (high - low) / 2);
      const comparison = arcLengths[i] - targetArcLength;
      if (comparison < 0) low = i + 1;
      else if (comparison > 0) high = i - 1;
      else { high = i; break; }
    }
    i = high;
    if (arcLengths[i] === targetArcLength) return i / (il - 1);
    const lengthBefore = arcLengths[i], lengthAfter = arcLengths[i + 1], segmentLength = lengthAfter - lengthBefore;
    const segmentFraction = (targetArcLength - lengthBefore) / segmentLength;
    return (i + segmentFraction) / (il - 1);
  }
}
