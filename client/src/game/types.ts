// The things the city and the network share between modules. The fields are those the original game used; an index
// signature lets a module keep a few of its own on the same object (the original added fields freely).
import type { TransformNode } from '@babylonjs/core';

// a networked row: the moment it shows (server clock, ms) and where the thing was. World of DODO, issue #20: a ship's row also has the
// yaw of its fore and aft turret against the hull (a, b)
export interface Row { t: number; x: number; z: number; h: number; v: number; r?: number; s?: number; k?: number; y?: number; p?: number; a?: number; b?: number }

// a car of the traffic or a parked car (world/traffic.ts)
export interface Car {
  x: number; z: number;
  ang: number; hx: number; hz: number;   // heading as an angle and as a unit vector
  v: number; vx: number; vz: number; w: number;
  gy: number;
  g: TransformNode | null;               // its mesh (null for the parked cars: they are instances)
  dyn: boolean;                          // moving by body physics (shoved), not along its lane
  parked: boolean;
  hold?: number;                         // a traffic car: waiting time (the parcels shove only these)
  cl?: number; cr?: number;              // collision circles: half distance between them, radius
  hl?: number; hw?: number; hh?: number; // half length, half width, height (parcels)
  // World of DODO: the shared city
  ni: number;                            // its index in the server's messages
  nb: Row[];                             // rows from the server
  net: number;                           // id of another player pushing it (0: nobody else)
  mine: boolean;                         // this tank pushes it (claimed)
  rel: boolean;                          // just let go: the next state tells the server
  calm: number;
  claimAt?: number; ackAt?: number;
  tow?: boolean; moved?: boolean;
  [more: string]: any;
}

// a pedestrian (world/peds.ts)
export interface Ped {
  id: number;
  x: number; z: number; h: number;
  state: 'walk' | 'down' | string;
  th: number; fx: number; fz: number;    // tilt while down, the direction of the fall
  phase: number;
  pred: { t: number; x: number; z: number; fx: number; fz: number; sp: number } | null;   // knocked over here, ahead of the server
  sentAt?: number;
  [more: string]: any;
}

// a tree or a lamp the tanks can knock down (world/props.ts)
export interface Prop {
  i: number;                             // its index: the same on every client (the city is built from one seed)
  x: number; z: number; r: number;       // a solid circle while it stands
  state: 'up' | 'fall' | 'down';
  th: number; w: number; th0: number; w0: number; acc: number;   // tilt, its speed, how far it falls, how it starts, how it speeds up
  fx: number; fz: number;                // the direction it falls
  bounced: boolean;
  breakV: number; slow: number;          // impact speed that topples it, how much speed the tank keeps
  apply: (p: Prop) => void;              // shows its tilt
  [more: string]: any;
}

// another player (or a bot), drawn from the server's rows (net/net.ts). World of DODO, issue #14: k 1 flies a plane (pg, made when
// first needed) at height y with pitch p; s 2 is destroyed. Issue #20: k 2 sails a ship (sg), y its heave and sinking, a and b the
// yaw of its turrets
export interface Other {
  id: number; name: string; color: number; pts: number; bot: boolean;
  team: number;                          // World of DODO, issue #24: 0 A, 1 B (-1: a server without teams)
  g: TransformNode;                      // the tank
  pg: TransformNode | null;              // the plane
  sg: TransformNode | null;              // the ship
  k: number; y: number; p: number; a: number; b: number;
  tag: HTMLElement;                      // the name tag (a DOM element over the canvas)
  buf: Row[];
  on: boolean;
  x: number; z: number; h: number; hx: number; hz: number; v: number; r: number; s: number;
  seen?: boolean; seenAt?: number; seenX?: number; seenZ?: number; losAt?: number;
  [more: string]: any;
}
