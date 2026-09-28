import * as THREE from 'three';

/** A soft round sprite texture: white in the middle fading to transparent. */
export function softDot(size = 64, inner = 'rgba(255,255,255,1)'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.4, inner.replace(/[\d.]+\)$/, '0.5)'));
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** One puff of smoke: where and when it was left behind, and how it grows. */
export interface Puff {
  position: THREE.Vector3;
  born: number;      // flight time, s
  size: number;      // m, starting diameter
  growth: number;    // m/s, how fast it spreads
  life: number;      // s until it has faded away
  rise: number;      // m/s, drift upward (warm exhaust)
}

/**
 * Exhaust smoke as a function of flight time, not simulated frame by frame, so it is
 * right wherever you seek: each puff is born at a fixed time and place, then drifts
 * with the wind, grows and fades by its age.
 */
export class Smoke {
  readonly points: THREE.Points;
  private material: THREE.ShaderMaterial;

  constructor(puffs: Puff[], wind: THREE.Vector3) {
    const n = puffs.length;
    const position = new Float32Array(n * 3);
    const born = new Float32Array(n);
    const shape = new Float32Array(n * 4); // size, growth, life, rise
    puffs.forEach((p, i) => {
      position.set([p.position.x, p.position.y, p.position.z], i * 3);
      born[i] = p.born;
      shape.set([p.size, p.growth, p.life, p.rise], i * 4);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('born', new THREE.BufferAttribute(born, 1));
    geometry.setAttribute('shape', new THREE.BufferAttribute(shape, 4));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        wind: { value: wind },
        pixelsPerMeter: { value: 800 },
        map: { value: softDot() },
      },
      vertexShader: `
        attribute float born;
        attribute vec4 shape;
        uniform float time;
        uniform vec3 wind;
        uniform float pixelsPerMeter;
        varying float vAlpha;
        void main() {
          float age = time - born;
          float life = shape.z;
          if (age < 0.0 || age > life) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // not born yet, or gone: off screen
            gl_PointSize = 0.0;
            vAlpha = 0.0;
            return;
          }
          vec3 p = position + wind * age + vec3(0.0, shape.w * age, 0.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float size = shape.x + shape.y * sqrt(age);
          gl_PointSize = clamp(size * pixelsPerMeter / -mv.z, 1.0, 512.0);
          gl_Position = projectionMatrix * mv;
          float fadeIn = smoothstep(0.0, 0.02, age); // appears at the nozzle; the rocket outruns anything slower
          float fadeOut = 1.0 - smoothstep(0.35 * life, life, age);
          vAlpha = 0.55 * fadeIn * fadeOut;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying float vAlpha;
        void main() {
          float a = texture2D(map, gl_PointCoord).a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.92, 0.92, 0.9), a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false; // puffs move in the shader; the static bounds don't cover them
  }

  update(time: number, camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    this.material.uniforms['time'].value = time;
    // Point sizes are in pixels: convert meters at unit distance to pixels for this camera
    const fov = THREE.MathUtils.degToRad(camera.fov);
    this.material.uniforms['pixelsPerMeter'].value = viewportHeight / (2 * Math.tan(fov / 2));
  }
}

/** A glowing halo at the nozzle; scale and opacity follow thrust. */
export function buildGlow(): THREE.Sprite {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDot(64, 'rgba(255,170,80,1)'),
    color: 0xff9a40,
    opacity: 0.8,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  sprite.visible = false;
  return sprite;
}

/** Smooth flicker between about 0.85 and 1.15, from a few mixed sine waves. */
export function flicker(seconds: number): number {
  return 1 + 0.07 * Math.sin(seconds * 37) + 0.05 * Math.sin(seconds * 61 + 1.3) + 0.03 * Math.sin(seconds * 113 + 2.1);
}
