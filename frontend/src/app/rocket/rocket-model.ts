import * as THREE from 'three';
import { RocketGeometry } from '../replay/replay.models';

/** Nose cone radius `x` meters behind the tip; the same profiles as the simulator (telemetry/rocket/rocket.py). */
function noseRadius(nose: RocketGeometry['nose'], x: number): number {
  const L = nose.length;
  const R = nose.diameter / 2;
  const k = nose.shape_parameter;
  x = Math.min(Math.max(x, 0), L);
  switch (nose.shape) {
    case 'ogive': {
      if (k < 1e-3) return (R * x) / L;
      const rho = Math.sqrt(((L * L + R * R) * (((2 - k) * L) ** 2 + (k * R) ** 2)) / (4 * (k * R) ** 2));
      const lEff = L / k;
      const y0 = Math.sqrt(Math.max(rho * rho - lEff * lEff, 0));
      return Math.sqrt(Math.max(rho * rho - (lEff - x) ** 2, 0)) - y0;
    }
    case 'ellipsoid':
      return R * Math.sqrt(Math.max((2 * x) / L - (x / L) ** 2, 0));
    case 'parabolic':
      return (R * ((2 * x) / L - k * (x / L) ** 2)) / (2 - k);
    case 'power':
      return R * (x / L) ** k;
    case 'haack': {
      const theta = Math.acos(1 - (2 * x) / L);
      return (R / Math.sqrt(Math.PI)) * Math.sqrt(Math.max(theta - Math.sin(2 * theta) / 2 + k * Math.sin(theta) ** 3, 0));
    }
    default: // cone
      return (R * x) / L;
  }
}

export interface RocketModel {
  root: THREE.Group;   // origin at the launch CG, +Y out of the nose
  flame: THREE.Group;  // scale.y with thrust; hidden when the motor is off
  chutes: THREE.Group[]; // one per recovery device, in the flight's recovery order
}

const WHITE = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 });
const NOSE = new THREE.MeshStandardMaterial({ color: 0xd23c2c, roughness: 0.4 });
const FIN = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 });
const NOZZLE = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.6, roughness: 0.4 });
const CHUTE_COLORS = [0xe8542f, 0xf0b400, 0x3987e5];

/** A 1:1 model of the simulated rocket, built from the flight's geometry. */
export function buildRocketModel(g: RocketGeometry): RocketModel {
  const root = new THREE.Group();
  const at = (x: number) => g.cg - x; // model y for a point x meters behind the nose tip

  // Nose cone: revolve its profile around the axis
  const nose = g.nose;
  const profile: THREE.Vector2[] = [];
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const x = (nose.length * i) / steps;
    profile.push(new THREE.Vector2(Math.max(noseRadius(nose, x), 1e-4), at(nose.position + x)));
  }
  profile.reverse(); // lathe points run bottom to top so the faces point outward
  root.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 32), NOSE));

  for (const tube of g.body_tubes) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(tube.diameter / 2, tube.diameter / 2, tube.length, 32), WHITE);
    mesh.position.y = at(tube.position + tube.length / 2);
    root.add(mesh);
  }

  const bodyRadiusAt = (x: number) =>
    (g.body_tubes.find((t) => t.position <= x && x <= t.position + t.length)?.diameter ?? g.diameter) / 2;

  for (const fins of g.fins) {
    const r = bodyRadiusAt(fins.position);
    const shape = new THREE.Shape();
    // In the fin's own plane: x outward from the axis, y along the rocket (up = toward the nose)
    shape.moveTo(r, 0);
    shape.lineTo(r + fins.span, -fins.sweep);
    shape.lineTo(r + fins.span, -fins.sweep - fins.tip_chord);
    shape.lineTo(r, -fins.root_chord);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: fins.thickness, bevelEnabled: false });
    geometry.translate(0, at(fins.position), -fins.thickness / 2);
    for (let k = 0; k < fins.count; k++) {
      const fin = new THREE.Mesh(geometry, FIN);
      fin.rotation.y = (2 * Math.PI * k) / fins.count;
      root.add(fin);
    }
  }

  // Motor nozzle poking out of the tail
  const motor = g.motor;
  const aft = at(motor.aft_position);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(motor.diameter / 2, motor.diameter / 2.4, motor.diameter * 0.4, 16), NOZZLE);
  nozzle.position.y = aft + motor.diameter * 0.2;
  root.add(nozzle);

  const flame = buildFlame(motor.diameter);
  flame.position.y = aft;
  flame.visible = false;
  root.add(flame);

  const chutes = g.recovery.map((device, i) => {
    const chute = buildChute(device.diameter, CHUTE_COLORS[i % CHUTE_COLORS.length]);
    chute.position.y = at(0); // lines meet at the nose tip
    chute.position.x = (i - (g.recovery.length - 1) / 2) * device.diameter * 0.6;
    chute.visible = false;
    root.add(chute);
    return chute;
  });

  return { root, flame, chutes };
}

/** Exhaust plume, 1 unit long pointing down (-Y) from its origin; scale.y sets its length. */
function buildFlame(diameter: number): THREE.Group {
  const group = new THREE.Group();
  const layers: [number, number, number][] = [
    [0.9, 0xff7a1a, 0.55], // outer glow
    [0.55, 0xffc640, 0.8],
    [0.25, 0xfff4d0, 1.0], // hot core
  ];
  for (const [width, color, opacity] of layers) {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry((diameter / 2) * width * 1.6, 1, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    cone.rotation.x = Math.PI; // tip pointing down
    cone.position.y = -0.5;
    group.add(cone);
  }
  return group;
}

/** A canopy above the nose on shroud lines; its origin is where the lines meet. */
function buildChute(diameter: number, color: number): THREE.Group {
  const group = new THREE.Group();
  const radius = diameter / 2;
  const lineLength = diameter * 1.1;
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2.2),
    new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.8 }),
  );
  canopy.scale.y = 0.6;
  canopy.position.y = lineLength;
  group.add(canopy);

  const points: THREE.Vector3[] = [];
  const rimY = lineLength + radius * 0.6 * Math.cos(Math.PI / 2.2);
  const rimR = radius * Math.sin(Math.PI / 2.2);
  for (let k = 0; k < 12; k++) {
    const a = (2 * Math.PI * k) / 12;
    points.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * rimR, rimY, Math.sin(a) * rimR));
  }
  group.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.8 }),
  ));
  return group;
}
