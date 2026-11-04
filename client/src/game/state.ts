// The game's shared state: what screen it is on, the player's tank, the keys held. One object each, imported by every part
// that needs them (the original kept them as variables in one big closure).
import type { TransformNode } from '@babylonjs/core';

// 'intro': the name form over the orbiting city (the browser's own city); 'drive': in the game (the city comes from the server)
export const G = {
  state: 'intro' as 'intro' | 'drive',
  camMode: 0,                       // 0: behind the tank, 1: high above it (C or the camera button)
  realSec: 0,                       // seconds since driving out (the start hint shows for the first few)
};

// the player's vehicle: a tank or (World of DODO, issue #14) a plane. k: what it is now (0 a tank, 1 a plane), next: what the next
// (re)spawn gives, swT: switching to it (a countdown, game/tank.ts switchVehicle); y, p: a plane's altitude and pitch (a tank stays
// on the ground, gy). slowT: slowed after a hit; topT: destroyed, until it respawns (a tank lies on its side); roll/rollDir: a tank's
// tilt while destroyed, a plane's bank; immT: immune after a (re)spawn (it blinks); hitLog: when the last hits came and their weight
// (worth three parcels within 8 s destroy it, game/tank.ts HIT_W)
export const car = {
  k: 0 as 0 | 1, next: 0 as 0 | 1, swT: 0,
  x: 0, z: 0, h: Math.PI, v: 0, steer: 0, gy: 0, y: 0, p: 0,   // (game/tank.ts reset puts it at the depot before the first frame)
  slowT: 0, topT: 0, roll: 0, rollDir: 1, immT: 0, hitLog: [] as [number, number][],
};
export type Tank = typeof car;

// keys held (keyboard and the touch buttons; alt: the second weapon, a tank's anti-aircraft gun or a plane's parcel), the touch steering
// pad (-1 left .. 1 right; pitchAxis -1 up .. 1 down, for a plane), the mouse moved since the last frame while locked to the game (a
// plane's aim) and its buttons held. HELD: the keyboard's keys held by code (a plane reads W/S and the arrows apart)
export const K = { up: false, down: false, left: false, right: false, brake: false, fire: false, alt: false };
export const input = { steerAxis: 0, pitchAxis: 0, mx: 0, my: 0, lmb: false, rmb: false };
export const HELD = new Set<string>();

// the player's tank and plane meshes (game/tank.ts and game/plane.ts build them)
export const view = { van: null as TransformNode | null, plane: null as TransformNode | null };
