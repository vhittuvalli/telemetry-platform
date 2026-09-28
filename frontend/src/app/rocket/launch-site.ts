import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const PAD_HEIGHT = 0.3; // m, the pad's top surface above the ground

/** A round step for altitude marks: 1, 2 or 5 × 10ⁿ, giving about `count` marks up to `max`. */
export function niceStep(max: number, count = 6): number {
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

/** Height the flight's origin (the rocket's CG on the pad) sits above the ground. */
export function padLift(tailBelowCg: number): number {
  return PAD_HEIGHT + tailBelowCg;
}

/** Ground, pad, launch rail and blast deflector. */
export function buildLaunchSite(railDirection: THREE.Vector3, railLength: number, rocketDiameter: number): THREE.Group {
  const site = new THREE.Group();

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40000, 64),
    new THREE.MeshStandardMaterial({ color: 0x5f7d3f, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  site.add(ground);

  // Mown field around the pad, so the ground has some sense of scale
  const field = new THREE.Mesh(
    new THREE.CircleGeometry(60, 48),
    new THREE.MeshStandardMaterial({ color: 0x78964f, roughness: 1 }),
  );
  field.rotation.x = -Math.PI / 2;
  field.position.y = 0.02;
  site.add(field);

  const concrete = new THREE.MeshStandardMaterial({ color: 0xb8b4aa, roughness: 0.9 });
  const pad = new THREE.Mesh(new THREE.BoxGeometry(3, PAD_HEIGHT, 3), concrete);
  pad.position.y = PAD_HEIGHT / 2;
  site.add(pad);

  const steel = new THREE.MeshStandardMaterial({ color: 0x8a8d91, metalness: 0.7, roughness: 0.35 });
  const deflector = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.5), steel);
  deflector.position.y = PAD_HEIGHT + 0.01;
  site.add(deflector);

  // Rail: a slim rod along the launch direction, beside the rocket
  const offset = rocketDiameter / 2 + 0.01;
  const side = new THREE.Vector3(1, 0, 0).projectOnPlane(railDirection).normalize().multiplyScalar(offset);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, railLength, 0.02), steel);
  rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), railDirection);
  rail.position.copy(railDirection.clone().multiplyScalar(railLength / 2)).add(side);
  rail.position.y += PAD_HEIGHT;
  site.add(rail);

  return site;
}

/** A pole beside the pad marked every `step` meters up to `top`, with labels. */
export function buildAltitudeRuler(top: number, at: THREE.Vector3): { group: THREE.Group; labels: CSS2DObject[] } {
  const group = new THREE.Group();
  const labels: CSS2DObject[] = [];
  const step = niceStep(top);
  const height = Math.ceil(top / step) * step;

  const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
  const points = [at.clone(), at.clone().setY(height)];
  const tick = Math.max(height / 80, 0.5);
  for (let h = step; h <= height + 1e-6; h += step) {
    points.push(at.clone().setY(h), at.clone().setY(h).add(new THREE.Vector3(tick, 0, 0)));
    const el = document.createElement('div');
    el.className = 'altitude-label';
    el.textContent = `${Math.round(h).toLocaleString()} m`;
    const label = new CSS2DObject(el);
    label.position.copy(at).setY(h).add(new THREE.Vector3(tick * 1.5, 0, 0));
    label.center.set(0, 0.5);
    group.add(label);
    labels.push(label);
  }
  // Pairs of points: the pole, then each tick
  const segments = [points[0], points[1], ...points.slice(2)];
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segments), material));
  return { group, labels };
}
