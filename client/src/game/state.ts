// The game's shared state: what screen it is on, the player's tank, the keys held. One object each, imported by every part
// that needs them (the original kept them as variables in one big closure).
import type { TransformNode } from '@babylonjs/core';

// 'intro': the name form over the orbiting city (the browser's own city); 'drive': in the game (the city comes from the server)
export const G = {
  state: 'intro' as 'intro' | 'drive',
  camMode: 0,                       // 0: behind the tank, 1: high above it (C or the camera button)
  realSec: 0,                       // seconds since driving out (the start hint shows for the first few)
};

// the player's tank. slowT: slowed after a hit; topT: destroyed, lying on its side until it respawns; roll/rollDir: the tilt
// while destroyed; immT: immune after a (re)spawn (it blinks); hitLog: when the last hits came (three within 8 s destroy it)
export const car = {
  x: -107.5, z: -130, h: Math.PI, v: 0, steer: 0, gy: 0,
  slowT: 0, topT: 0, roll: 0, rollDir: 1, immT: 0, hitLog: [] as number[],
};
export type Tank = typeof car;

// keys held (keyboard and the touch buttons), and the touch steering pad (-1 left .. 1 right)
export const K = { up: false, down: false, left: false, right: false, brake: false, fire: false };
export const input = { steerAxis: 0 };

// the player's tank mesh (game/tank.ts builds it)
export const view = { van: null as TransformNode | null };
