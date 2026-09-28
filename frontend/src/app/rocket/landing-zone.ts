import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Dispersion, LandingZone } from '../replay/replay.models';
import { toScene } from '../engine/viewer-engine';

const GROUND = 0.08; // m, just above the ground so the marks don't flicker into it

/** Points around a landing ellipse, in scene coordinates on the ground. */
function ellipsePoints(zone: LandingZone, segments = 96): THREE.Vector3[] {
  const a = THREE.MathUtils.degToRad(zone.angle);
  const [cx, cy] = zone.center;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (2 * Math.PI * i) / segments;
    const u = zone.semi_major * Math.cos(t);
    const w = zone.semi_minor * Math.sin(t);
    const p = toScene([cx + u * Math.cos(a) - w * Math.sin(a), cy + u * Math.sin(a) + w * Math.cos(a), 0]);
    p.y = GROUND;
    points.push(p);
  }
  return points;
}

/** Every Monte Carlo landing as a dot, and the 50% and 95% landing ellipses with labels. */
export function buildLandingZone(d: Dispersion): { group: THREE.Group; labels: CSS2DObject[]; bounds: THREE.Box3 } {
  const group = new THREE.Group();
  const labels: CSS2DObject[] = [];

  const dots = d.landings.map(([x, y]) => toScene([x, y, 0]).setY(GROUND + 0.02));
  group.add(new THREE.Points(
    new THREE.BufferGeometry().setFromPoints(dots),
    new THREE.PointsMaterial({ color: 0xffffff, size: 4, sizeAttenuation: false, transparent: true, opacity: 0.75 }),
  ));

  const bounds = new THREE.Box3().setFromPoints(dots);
  for (const zone of d.landing.zones) {
    const outer = zone.probability >= 0.9;
    const points = ellipsePoints(zone);
    bounds.expandByPoint(points[0]).union(new THREE.Box3().setFromPoints(points));

    // A faint wash inside, a crisp edge around it
    const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, -p.z)));
    const fill = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color: 0xffd28a, transparent: true, opacity: outer ? 0.12 : 0.18, depthWrite: false }),
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = GROUND - 0.01;
    group.add(fill);
    group.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0xffd28a, transparent: true, opacity: outer ? 0.7 : 1 }),
    ));

    // Label at the ellipse's northernmost point, so the two labels don't sit on each other
    const top = points.reduce((best, p) => (p.z < best.z ? p : best));
    const el = document.createElement('div');
    el.className = 'zone-label';
    el.textContent = `${Math.round(zone.probability * 100)}% land inside`;
    const label = new CSS2DObject(el);
    label.position.copy(top);
    label.center.set(0.5, 1.2);
    group.add(label);
    labels.push(label);
  }
  return { group, labels, bounds };
}
