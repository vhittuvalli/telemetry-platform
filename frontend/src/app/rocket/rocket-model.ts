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
  /** Animate the plume (its noise scrolls) and the canopies (they breathe as air spills). */
  animate(seconds: number): void;
}

// Gloss-painted model rocket: a clear coat over the color picks up the sky
const paint = (color: number, roughness = 0.35) =>
  new THREE.MeshPhysicalMaterial({ color, roughness, clearcoat: 1, clearcoatRoughness: 0.12 });
const NOSE = paint(0xd23c2c);
const FIN = paint(0x2f5fa8);
const NOZZLE = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.5, roughness: 0.55 });
const LUG = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.6 });
const CHUTE_COLORS = [0xe8542f, 0xf0b400, 0x3987e5];

/** The body's livery: white with a blue stripe, a roll-pattern band and a few panel lines. */
function bodyTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f4f4f2';
  ctx.fillRect(0, 0, w, h);
  // A stripe running the length, and black/white quarters near the tail (a classic roll pattern)
  ctx.fillStyle = '#2f5fa8';
  ctx.fillRect(w * 0.1, 0, w * 0.06, h);
  ctx.fillStyle = '#d23c2c';
  ctx.fillRect(w * 0.17, 0, w * 0.015, h);
  ctx.fillStyle = '#1c1c1c';
  for (let k = 0; k < 4; k += 2) ctx.fillRect((k * w) / 4, h * 0.78, w / 4, h * 0.08);
  for (let k = 1; k < 4; k += 2) ctx.fillRect((k * w) / 4, h * 0.86, w / 4, h * 0.05);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (const y of [0.04, 0.42, 0.74]) ctx.fillRect(0, h * y, w, 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

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
  root.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 48), NOSE));

  // One livery stretched over all the body tubes, so stripes line up across joints
  const livery = bodyTexture();
  const bodyStart = Math.min(...g.body_tubes.map((t) => t.position), g.length);
  const bodyEnd = Math.max(...g.body_tubes.map((t) => t.position + t.length), 0);
  for (const tube of g.body_tubes) {
    const map = livery.clone();
    map.repeat.set(1, tube.length / Math.max(bodyEnd - bodyStart, 1e-3));
    map.offset.set(0, 1 - (tube.position + tube.length - bodyStart) / Math.max(bodyEnd - bodyStart, 1e-3));
    map.needsUpdate = true;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(tube.diameter / 2, tube.diameter / 2, tube.length, 48, 1, true),
      new THREE.MeshPhysicalMaterial({ map, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1 }),
    );
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
    // Sanded, rounded edges: a small bevel catches the light like a real fin's airfoiled edge
    const bevel = fins.thickness * 0.35;
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: fins.thickness - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 2,
    });
    geometry.translate(0, at(fins.position), -fins.thickness / 2 + bevel);
    for (let k = 0; k < fins.count; k++) {
      const fin = new THREE.Mesh(geometry, FIN);
      fin.rotation.y = (2 * Math.PI * k) / fins.count;
      root.add(fin);
    }
  }

  // Launch lug on the rail's side (+X), a third of the way up from the tail
  const lugLength = Math.max(g.length * 0.06, 0.03);
  const lugR = Math.max(g.diameter * 0.06, 0.003);
  const lug = new THREE.Mesh(new THREE.CylinderGeometry(lugR, lugR, lugLength, 10), LUG);
  const lugX = g.length * 0.72;
  lug.position.set(bodyRadiusAt(lugX) + lugR, at(lugX), 0);
  root.add(lug);

  // Motor nozzle poking out of the tail
  const motor = g.motor;
  const aft = at(motor.aft_position);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(motor.diameter / 2, motor.diameter / 2.4, motor.diameter * 0.4, 16), NOZZLE);
  nozzle.position.y = aft + motor.diameter * 0.2;
  root.add(nozzle);

  const { group: flame, material: plume } = buildFlame(motor.diameter);
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

  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.parent !== flame) obj.castShadow = true;
  });

  const animate = (seconds: number) => {
    plume.uniforms['time'].value = seconds;
    chutes.forEach((chute, i) => {
      // Canopies breathe: air spills from under the skirt and it refills, a couple of times a second
      const canopy = chute.userData['canopy'] as THREE.Object3D;
      const b = 1 + 0.04 * Math.sin(seconds * 5.2 + i) + 0.025 * Math.sin(seconds * 8.7 + 2 * i);
      canopy.scale.set(b, 0.6 / b, b);
    });
  };
  return { root, flame, chutes, animate };
}

/**
 * Exhaust plume, 1 unit long pointing down (-Y) from its origin; scale.y sets its length.
 * A shader draws it: white-hot at the nozzle, through yellow to orange, with turbulence
 * scrolling down it and a ragged tip. It's bright enough to bloom.
 */
function buildFlame(diameter: number): { group: THREE.Group; material: THREE.ShaderMaterial } {
  const group = new THREE.Group();
  const material = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float time;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      void main() {
        float along = vUv.y;                     // 0 at the nozzle, 1 at the tip (the cone is flipped)
        float across = abs(vUv.x - 0.5) * 2.0;   // 0 on the axis, 1 at the plume's edge (around the cone)
        float n = noise(vec2(vUv.x * 10.0, along * 6.0 - time * 18.0)) * 0.6
                + noise(vec2(vUv.x * 23.0, along * 13.0 - time * 31.0)) * 0.4;
        float body = smoothstep(1.0, 0.25 + 0.35 * n, along);   // ragged, flickering tip
        vec3 hot = vec3(1.0, 0.97, 0.88);
        vec3 mid = vec3(1.0, 0.72, 0.25);
        vec3 cool = vec3(0.95, 0.32, 0.06);
        vec3 color = mix(hot, mid, smoothstep(0.0, 0.35, along));
        color = mix(color, cool, smoothstep(0.3, 0.9, along));
        float alpha = body * (0.75 + 0.25 * n) * (1.0 - 0.3 * across);
        gl_FragColor = vec4(color * (9.0 - 7.5 * along), alpha);  // far brighter than the sky near the nozzle: it blooms
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  for (const width of [1.0, 0.55]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry((diameter / 2) * width * 1.5, 1, 24, 8, true), material);
    cone.rotation.x = Math.PI; // tip pointing down
    cone.position.y = -0.5;
    group.add(cone);
  }
  return { group, material };
}

/** Alternating gore panels, like a real parachute's sewn sections. */
function goreTexture(color: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 8;
  const ctx = canvas.getContext('2d')!;
  const base = new THREE.Color(color);
  for (let k = 0; k < 12; k++) {
    ctx.fillStyle = k % 2 ? `#${base.getHexString()}` : '#f6f3ea';
    ctx.fillRect((k * 256) / 12, 0, 256 / 12 + 1, 8);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A canopy above the nose on shroud lines; its origin is where the lines meet. */
function buildChute(diameter: number, color: number): THREE.Group {
  const group = new THREE.Group();
  const radius = diameter / 2;
  const lineLength = diameter * 1.1;
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2.2),
    new THREE.MeshStandardMaterial({ map: goreTexture(color), side: THREE.DoubleSide, roughness: 0.85 }),
  );
  canopy.scale.y = 0.6;
  canopy.position.y = lineLength;
  canopy.castShadow = true;
  group.add(canopy);
  group.userData['canopy'] = canopy;

  const points: THREE.Vector3[] = [];
  const rimY = lineLength + radius * 0.6 * Math.cos(Math.PI / 2.2);
  const rimR = radius * Math.sin(Math.PI / 2.2);
  for (let k = 0; k < 12; k++) {
    const a = (2 * Math.PI * k) / 12;
    points.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * rimR, rimY, Math.sin(a) * rimR));
  }
  group.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: 0xeeeeee, transparent: true, opacity: 0.9 }),
  ));
  return group;
}
