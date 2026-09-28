import * as THREE from 'three';

const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

/** A simple open-wheel race car, ~5.6 m long, facing +X, sitting on y = 0. */
export function createCarModel(color: string): THREE.Group {
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3 });
  const car = new THREE.Group();

  // Floor and main body
  car.add(box(5.0, 0.05, 1.6, dark, 0, 0.08));             // floor
  car.add(box(3.0, 0.45, 0.7, body, 0.2, 0.4));            // chassis / cockpit
  car.add(box(1.8, 0.4, 1.4, body, -0.2, 0.35));           // sidepods
  car.add(box(1.4, 0.5, 0.4, body, -0.9, 0.75));           // engine cover
  car.add(box(0.6, 0.15, 0.5, dark, 0.6, 0.66));           // cockpit opening

  // Nose: a tapered cylinder lying along the X axis
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 1.6, 10), body);
  nose.rotation.z = -Math.PI / 2; // point the narrow end forward
  nose.position.set(2.2, 0.35, 0);
  car.add(nose);

  // Wings
  car.add(box(0.35, 0.05, 1.9, body, 2.75, 0.12));         // front wing
  car.add(box(0.35, 0.06, 1.0, body, -2.5, 0.95));         // rear wing main plane
  car.add(box(0.4, 0.6, 0.03, dark, -2.5, 0.7, 0.5));      // rear wing endplate (left)
  car.add(box(0.4, 0.6, 0.03, dark, -2.5, 0.7, -0.5));     // rear wing endplate (right)

  // Wheels: cylinders turned so their axles point sideways
  const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.4, 16);
  for (const [x, z] of [[1.8, 0.8], [1.8, -0.8], [-1.8, 0.8], [-1.8, -0.8]]) {
    const w = new THREE.Mesh(wheel, tyre);
    w.rotation.x = Math.PI / 2;
    w.position.set(x, 0.36, z);
    car.add(w);
  }

  return car;
}