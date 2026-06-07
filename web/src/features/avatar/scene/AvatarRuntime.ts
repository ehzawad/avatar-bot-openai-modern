// Imperative Three.js avatar engine. Ports, VERBATIM IN BEHAVIOR:
//   frontend/src/avatar/avatarScene.js        (scene/camera/lights/loop/blink/idle/gestures)
//   frontend/src/avatar/modelLoader.js         (VRM/GLB loader + procedural fallback + morph map)
//   frontend/src/avatar/expressionController.js (emotion presets, mouth/blink driving)
//
// This is the ONLY place (besides useAvatarScene which re-exports types) that imports
// three / @pixiv/three-vrm. All constants from the legacy app are preserved.
//
// Differences from legacy (robustness, per WEB_CONTRACT §7), NOT behavior changes:
//   - sizing via ResizeObserver on the container (not window.innerWidth)
//   - named listeners + full disposal checklist + loadSeq guard
//   - webglcontextlost/restored handling
//   - getMouthLevel() injected (read inside RAF) instead of an AudioPlayer reference

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

import type { Emotion, Gesture } from '../../../lib/api/types';

// ---------------------------------------------------------------------------
// Normalized avatar model shape (works for native VRM, plain GLB, and fallback).
// Mirrors the legacy modelLoader.#normalize / createFallbackAvatar return shape.
// ---------------------------------------------------------------------------

type BoneName =
  | 'hips'
  | 'spine'
  | 'neck'
  | 'head'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftLowerArm'
  | 'rightLowerArm';

interface ExpressionManagerLike {
  setValue(name: string, value: number): void;
}

interface HumanoidLike {
  getNormalizedBoneNode(name: string): THREE.Object3D | null;
}

interface LookAtLike {
  target?: THREE.Object3D | null;
}

interface MorphMapping {
  mouth: number[];
  blink: number[];
}

interface NormalizedModel {
  scene: THREE.Object3D;
  expressionManager: ExpressionManagerLike | null;
  humanoid: HumanoidLike;
  lookAt: LookAtLike | null;
  update: (delta: number) => void;
  headHeight: number;
  morphTargetMeshes: THREE.Mesh[];
  fallbackMappings: Map<THREE.Mesh, MorphMapping>;
}

// ---------------------------------------------------------------------------
// Model loader (port of modelLoader.js)
// ---------------------------------------------------------------------------

class AvatarModelLoader {
  private loader: GLTFLoader;

  constructor() {
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));
  }

  load(url: string, fallbackUrl: string | null = null): Promise<NormalizedModel> {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => resolve(this.normalize(gltf)),
        undefined,
        (error) => {
          if (!fallbackUrl) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          this.load(fallbackUrl).then(resolve).catch(reject);
        },
      );
    });
  }

  createFallbackAvatar(): NormalizedModel {
    const root = new THREE.Group();
    root.name = 'GeneratedAvatar';

    const skin = new THREE.MeshStandardMaterial({ color: 0xf0b994, roughness: 0.72 });
    const skinShadow = new THREE.MeshStandardMaterial({ color: 0xd79a76, roughness: 0.78 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x2b1d2f, roughness: 0.82 });
    const fabric = new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.64, metalness: 0.02 });
    const fabricDark = new THREE.MeshStandardMaterial({ color: 0x172554, roughness: 0.7 });
    const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x12131f });
    const mouthMaterial = new THREE.MeshBasicMaterial({ color: 0x55121c });
    const browMaterial = new THREE.MeshBasicMaterial({ color: 0x211629 });

    const bones: Record<BoneName, THREE.Group> = {
      hips: new THREE.Group(),
      spine: new THREE.Group(),
      neck: new THREE.Group(),
      head: new THREE.Group(),
      leftUpperArm: new THREE.Group(),
      rightUpperArm: new THREE.Group(),
      leftLowerArm: new THREE.Group(),
      rightLowerArm: new THREE.Group(),
    };

    root.add(bones.hips);
    bones.hips.position.set(0, 0.34, 0);
    bones.hips.add(bones.spine);
    bones.spine.position.set(0, 0.34, 0);
    bones.spine.add(bones.neck);
    bones.neck.position.set(0, 0.42, 0);
    bones.neck.add(bones.head);
    bones.head.position.set(0, 0.23, 0);

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 0.62, 32), fabric);
    torso.position.y = 0.08;
    bones.spine.add(torso);

    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.018, 8, 32), fabricDark);
    collar.position.y = 0.39;
    collar.rotation.x = Math.PI / 2;
    bones.spine.add(collar);

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.2, 20), skinShadow);
    neck.position.y = -0.04;
    bones.neck.add(neck);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 40, 32), skin);
    head.scale.set(0.92, 1.08, 0.86);
    bones.head.add(head);

    const hairCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.236, 40, 16, 0, Math.PI * 2, 0, Math.PI * 0.54),
      hair,
    );
    hairCap.position.y = 0.055;
    hairCap.scale.set(0.95, 0.72, 0.88);
    bones.head.add(hairCap);

    const bang = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 12), hair);
    bang.position.set(-0.08, 0.07, 0.17);
    bang.scale.set(1.25, 0.62, 0.45);
    bones.head.add(bang);

    const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 8), eyeMaterial);
    leftEye.position.set(-0.075, 0.018, 0.19);
    leftEye.scale.set(1.18, 1, 0.28);
    bones.head.add(leftEye);

    const rightEye = leftEye.clone();
    rightEye.position.x = 0.075;
    bones.head.add(rightEye);

    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.018, 0.012), mouthMaterial);
    mouth.position.set(0, -0.09, 0.195);
    bones.head.add(mouth);

    const leftBrow = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.012, 0.01), browMaterial);
    leftBrow.position.set(-0.075, 0.075, 0.2);
    leftBrow.rotation.z = 0.05;
    bones.head.add(leftBrow);

    const rightBrow = leftBrow.clone();
    rightBrow.position.x = 0.075;
    rightBrow.rotation.z = -0.05;
    bones.head.add(rightBrow);

    const leftCheek = new THREE.Mesh(
      new THREE.SphereGeometry(0.026, 16, 8),
      new THREE.MeshBasicMaterial({ color: 0xf59aa9, transparent: true, opacity: 0.52 }),
    );
    leftCheek.position.set(-0.12, -0.055, 0.185);
    leftCheek.scale.set(1.4, 0.7, 0.2);
    bones.head.add(leftCheek);

    const rightCheek = leftCheek.clone();
    rightCheek.position.x = 0.12;
    bones.head.add(rightCheek);

    this.addArm(bones.spine, bones.leftUpperArm, bones.leftLowerArm, -0.31, skin, fabric);
    this.addArm(bones.spine, bones.rightUpperArm, bones.rightLowerArm, 0.31, skin, fabric);

    const expressionState = new Map<string, number>();
    const setValue = (preset: string, value: number): void => {
      expressionState.set(preset, Math.max(0, Math.min(1, Number(value) || 0)));
      const aa = expressionState.get('aa') || 0;
      const blink = expressionState.get('blink') || 0;
      const joy = Math.max(
        expressionState.get('happy') || 0,
        expressionState.get('joy') || 0,
        expressionState.get('fun') || 0,
      );
      const sad = Math.max(expressionState.get('sad') || 0, expressionState.get('sorrow') || 0);
      const angry = expressionState.get('angry') || 0;
      const surprised = expressionState.get('surprised') || 0;

      mouth.scale.set(1 + joy * 0.28 + surprised * 0.22, 1 + aa * 3.1 + surprised * 2.4, 1);
      mouth.position.y = -0.09 - aa * 0.014 + joy * 0.012 - sad * 0.012;
      mouth.rotation.z = joy * 0.06 - sad * 0.05;

      const eyeHeight = Math.max(0.12, 1 - blink * 0.92 + surprised * 0.25 - sad * 0.16);
      leftEye.scale.y = eyeHeight;
      rightEye.scale.y = eyeHeight;

      leftBrow.position.y = 0.075 + surprised * 0.025 - sad * 0.02;
      rightBrow.position.y = leftBrow.position.y;
      leftBrow.rotation.z = 0.05 + joy * 0.12 - angry * 0.18 + sad * 0.14;
      rightBrow.rotation.z = -0.05 - joy * 0.12 + angry * 0.18 - sad * 0.14;
    };

    return {
      scene: root,
      expressionManager: { setValue },
      humanoid: { getNormalizedBoneNode: (name: string) => bones[name as BoneName] || null },
      lookAt: { target: new THREE.Object3D() },
      update: () => {},
      headHeight: 1.42,
      morphTargetMeshes: [],
      fallbackMappings: new Map(),
    };
  }

  private normalize(gltf: GLTF): NormalizedModel {
    const vrm = (gltf.userData as { vrm?: unknown }).vrm as
      | (Partial<NormalizedModel> & { scene: THREE.Object3D })
      | undefined;
    const nativeVrm = Boolean(vrm);

    const model: NormalizedModel = nativeVrm
      ? {
          scene: vrm!.scene,
          expressionManager:
            (vrm as { expressionManager?: ExpressionManagerLike }).expressionManager ?? null,
          humanoid:
            (vrm as { humanoid?: HumanoidLike }).humanoid ?? {
              getNormalizedBoneNode: () => null,
            },
          lookAt: (vrm as { lookAt?: LookAtLike }).lookAt ?? { target: new THREE.Object3D() },
          update:
            typeof (vrm as { update?: (d: number) => void }).update === 'function'
              ? (vrm as { update: (d: number) => void }).update.bind(vrm)
              : () => {},
          headHeight: 1.45,
          morphTargetMeshes: [],
          fallbackMappings: new Map(),
        }
      : {
          scene: gltf.scene,
          expressionManager: null,
          humanoid: { getNormalizedBoneNode: () => null },
          lookAt: { target: new THREE.Object3D() },
          update: () => {},
          headHeight: 1.45,
          morphTargetMeshes: [],
          fallbackMappings: new Map(),
        };

    model.scene.traverse((object) => {
      object.frustumCulled = false;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });

    model.scene.rotation.y = nativeVrm ? Math.PI : -Math.PI / 2;
    model.scene.position.set(0, 0, 0);
    model.scene.scale.setScalar(this.scaleFor(model.scene));
    model.headHeight = 1.45;
    model.morphTargetMeshes = this.findMorphTargets(model.scene);
    model.fallbackMappings = this.mapMorphTargets(model.morphTargetMeshes);
    return model;
  }

  private scaleFor(scene: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(scene);
    const height = box.max.y - box.min.y;
    if (Number.isFinite(height) && height > 5) return 1.7 / height;
    return 1;
  }

  private findMorphTargets(scene: THREE.Object3D): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
        meshes.push(mesh);
      }
    });
    return meshes;
  }

  private mapMorphTargets(meshes: THREE.Mesh[]): Map<THREE.Mesh, MorphMapping> {
    const mapping = new Map<THREE.Mesh, MorphMapping>();
    for (const mesh of meshes) {
      const dict = mesh.morphTargetDictionary || {};
      const mouth: number[] = [];
      const blink: number[] = [];
      for (const [name, index] of Object.entries(dict)) {
        const key = String(name).toLowerCase();
        if (
          key.includes('viseme_aa') ||
          key.includes('viseme_o') ||
          key.includes('mouthopen') ||
          key.includes('mouth_open') ||
          key.includes('jawopen') ||
          key.includes('jaw_open') ||
          key.includes('mouthfunnel')
        )
          mouth.push(index);
        if (
          key.includes('blink') ||
          key.includes('eyeclosed') ||
          key.includes('eye_closed') ||
          key.includes('eyesclosed')
        )
          blink.push(index);
      }
      mapping.set(mesh, { mouth, blink });
    }
    return mapping;
  }

  private addArm(
    parent: THREE.Object3D,
    upper: THREE.Group,
    lower: THREE.Group,
    x: number,
    skin: THREE.Material,
    fabric: THREE.Material,
  ): void {
    parent.add(upper);
    upper.position.set(x, 0.36, 0);
    upper.rotation.z = x < 0 ? 1.18 : -1.18;

    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.046, 0.28, 18), fabric);
    sleeve.position.y = -0.14;
    upper.add(sleeve);

    upper.add(lower);
    lower.position.y = -0.28;
    lower.rotation.z = x < 0 ? 0.12 : -0.12;

    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.033, 0.25, 18), skin);
    forearm.position.y = -0.125;
    lower.add(forearm);

    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 18, 12), skin);
    hand.position.y = -0.265;
    lower.add(hand);
  }
}

// ---------------------------------------------------------------------------
// Expression controller (port of expressionController.js)
// ---------------------------------------------------------------------------

const EMOTION_PRESET_NAMES = [
  'happy',
  'joy',
  'angry',
  'sad',
  'sorrow',
  'relaxed',
  'fun',
  'surprised',
] as const;

class ExpressionController {
  private model: NormalizedModel | null = null;
  activeEmotion: Emotion = 'neutral';
  private expressionTimeout: ReturnType<typeof setTimeout> | null = null;
  // Called when the 4.8s auto-reset fires so the engine can clear timers / re-apply neutral.
  onAutoReset: (() => void) | null = null;

  bind(model: NormalizedModel): void {
    this.model = model;
    this.activeEmotion = 'neutral';
  }

  clearTimer(): void {
    if (this.expressionTimeout !== null) {
      clearTimeout(this.expressionTimeout);
      this.expressionTimeout = null;
    }
  }

  setEmotion(emotion: Emotion | null): void {
    if (!this.model) return;
    this.activeEmotion = emotion || 'neutral';
    this.resetEmotionPresets();
    const value = 0.9;
    switch (this.activeEmotion) {
      case 'joy':
        this.set('happy', value);
        this.set('joy', value);
        break;
      case 'sorrow':
        this.set('sad', value);
        this.set('sorrow', value);
        break;
      case 'angry':
        this.set('angry', value);
        break;
      case 'fun':
        this.set('relaxed', value);
        this.set('fun', value);
        break;
      case 'surprised':
        this.set('surprised', value);
        break;
      default:
        break;
    }
    this.clearTimer();
    this.expressionTimeout = setTimeout(() => {
      this.setEmotion('neutral');
      this.onAutoReset?.();
    }, 4800);
  }

  setMouth(value: number): void {
    this.set('aa', Math.max(0, Math.min(1, value)));
  }

  setBlink(value: number): void {
    this.set('blink', Math.max(0, Math.min(1, value)));
  }

  private resetEmotionPresets(): void {
    for (const name of EMOTION_PRESET_NAMES) this.set(name, 0);
  }

  private set(preset: string, value: number): void {
    const model = this.model;
    if (!model) return;
    if (model.expressionManager) {
      try {
        model.expressionManager.setValue(preset, value);
      } catch {
        /* ignore unknown preset */
      }
      return;
    }

    const meshes = model.morphTargetMeshes || [];
    const fallback = model.fallbackMappings;
    if (!fallback) return;
    for (const mesh of meshes) {
      const influences = mesh.morphTargetInfluences;
      const mapping = fallback.get(mesh);
      if (!influences || !mapping) continue;
      if (preset === 'aa') {
        for (const idx of mapping.mouth) influences[idx] = Math.min(value * 1.8, 1);
      }
      if (preset === 'blink') {
        for (const idx of mapping.blink) influences[idx] = value;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AvatarRuntime — owns the renderer, scene, loop, and lifecycle.
// ---------------------------------------------------------------------------

export interface AvatarRuntimeOptions {
  getMouthLevel: () => number;
}

export class AvatarRuntime {
  private root: HTMLElement;
  private getMouthLevel: () => number;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls | null = null;
  private clock = new THREE.Clock();
  private loader = new AvatarModelLoader();
  private expression = new ExpressionController();

  private model: NormalizedModel | null = null;
  private mouse = new THREE.Vector2(0, 0);
  private targetLookAt = new THREE.Vector3();

  private lastBlink = 0;
  private nextBlink = 3.5;
  private blinkState: 'open' | 'closing' | 'opening' = 'open';
  private readonly blinkDuration = 0.16;

  private rafId: number | null = null;
  private disposed = false;
  private paused = false;
  private loadSeq = 0;

  // Bounded gesture/position timers (cleared on teardown).
  private gestureTimers = new Set<ReturnType<typeof setTimeout>>();

  private resizeObserver: ResizeObserver | null = null;

  // Named listeners so they can be removed precisely.
  private readonly onPointerMove = (event: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  };

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.paused = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  };

  private readonly onContextRestored = (): void => {
    if (this.disposed) return;
    this.resize();
    this.paused = false;
    if (this.rafId === null) this.animate();
  };

  private readonly onVisibilityChange = (): void => {
    // Reset the clock delta so the model doesn't jump after a long background pause.
    if (!document.hidden) this.clock.getDelta();
  };

  constructor(root: HTMLElement, options: AvatarRuntimeOptions) {
    this.root = root;
    this.getMouthLevel = options.getMouthLevel;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  }

  /** Synchronous boot (StrictMode-safe via the hook's runtimeRef guard). */
  init(): void {
    this.camera.position.set(0, 0.85, 1.85);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;

    const canvas = this.renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    this.root.appendChild(canvas);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.5, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 0.65;
    this.controls.maxDistance = 5;

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 4, 2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88ccff, 1.2);
    rim.position.set(-2, 2, -2);
    this.scene.add(rim);

    this.expression.onAutoReset = () => {
      /* presets already reset to neutral by the controller */
    };

    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('webglcontextlost', this.onContextLost as EventListener, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored as EventListener, false);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.root);
    this.resize();

    this.useGeneratedAvatar();
    this.animate();
  }

  // -- model swapping ---------------------------------------------------------

  async loadModel(url: string, fallbackUrl: string | null = null): Promise<void> {
    const seq = ++this.loadSeq;
    const next = await this.loader.load(url, fallbackUrl);
    // A newer load (or teardown) happened while we were fetching — discard this one.
    if (this.disposed || seq !== this.loadSeq) {
      this.disposeObject(next.scene);
      return;
    }
    this.swapModel(next);
    this.controls?.target.set(0, 0.48, 0);
    this.camera.position.set(0, 0.86, 1.85);
    this.controls?.update();
  }

  useGeneratedAvatar(): void {
    // Bump loadSeq so any in-flight loadModel() is ignored.
    this.loadSeq += 1;
    const next = this.loader.createFallbackAvatar();
    this.swapModel(next);
    this.controls?.target.set(0, 0.56, 0);
    this.camera.position.set(0, 0.9, 1.85);
    this.controls?.update();
  }

  async loadUploadedFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    try {
      await this.loadModel(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private swapModel(next: NormalizedModel): void {
    if (this.model) {
      this.scene.remove(this.model.scene);
      this.disposeObject(this.model.scene);
      // Remove any lookAt target object we added for the previous model.
      const prevTarget = this.model.lookAt?.target;
      if (prevTarget && prevTarget.parent === this.scene) this.scene.remove(prevTarget);
      this.model = null;
    }
    this.model = next;
    this.scene.add(next.scene);
    if (next.lookAt) {
      const target = new THREE.Object3D();
      next.lookAt.target = target;
      this.scene.add(target);
    }
    this.expression.bind(next);
  }

  // -- emotion / gesture ------------------------------------------------------

  setEmotion(emotion: Emotion | null): void {
    this.expression.setEmotion(emotion);
  }

  applyGesture(gesture: Gesture): void {
    if (!this.model) return;
    if (gesture === 'nod') this.temporaryHeadRotation('x', 0.12);
    if (gesture === 'shake') this.temporaryHeadRotation('y', 0.12);
    if (gesture === 'lean_in') this.model.scene.position.z = 0.04;
    if (gesture === 'wave') this.wave();
    this.addTimer(() => {
      if (this.model) this.model.scene.position.z = 0;
    }, 900);
  }

  private temporaryHeadRotation(axis: 'x' | 'y' | 'z', amount: number): void {
    const head = this.model?.humanoid?.getNormalizedBoneNode?.('head');
    if (!head) return;
    const original = head.rotation[axis];
    head.rotation[axis] = original + amount;
    this.addTimer(() => {
      head.rotation[axis] = original;
    }, 420);
  }

  private wave(): void {
    const upper = this.model?.humanoid?.getNormalizedBoneNode?.('rightUpperArm');
    const lower = this.model?.humanoid?.getNormalizedBoneNode?.('rightLowerArm');
    if (!upper || !lower) return;
    const z = upper.rotation.z;
    const y = lower.rotation.y;
    upper.rotation.z = -2.0;
    lower.rotation.y = -0.75;
    this.addTimer(() => {
      upper.rotation.z = z;
      lower.rotation.y = y;
    }, 700);
  }

  private addTimer(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.gestureTimers.delete(id);
      fn();
    }, ms);
    this.gestureTimers.add(id);
  }

  // -- render loop ------------------------------------------------------------

  private animate = (): void => {
    if (this.disposed || this.paused) return;
    this.rafId = requestAnimationFrame(this.animate);
    const delta = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();

    if (this.model) {
      this.idleMotion(elapsed);
      this.blink(elapsed);
      this.lookAtCursor();
      this.expression.setMouth(this.getMouthLevel());
      this.model.update(delta);
    }

    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
  };

  private idleMotion(elapsed: number): void {
    const model = this.model;
    if (!model) return;
    const sway = Math.sin(elapsed * 0.8);
    const breathe = Math.sin(elapsed * 1.5);
    const bone = (name: BoneName) => model.humanoid?.getNormalizedBoneNode?.(name);
    const hips = bone('hips');
    const spine = bone('spine');
    const neck = bone('neck');
    const leftUpperArm = bone('leftUpperArm');
    const rightUpperArm = bone('rightUpperArm');
    const leftLowerArm = bone('leftLowerArm');
    const rightLowerArm = bone('rightLowerArm');

    if (hips) {
      hips.position.x = sway * 0.01;
      hips.position.y = Math.sin(elapsed * 1.6) * 0.003;
    }
    if (spine) {
      spine.rotation.x = breathe * 0.01;
      spine.rotation.z = sway * 0.004;
    }
    if (neck) {
      neck.rotation.x = breathe * 0.006;
      neck.rotation.y = sway * 0.008;
    }
    const armSway = Math.sin(elapsed * 0.8) * 0.02;
    if (leftUpperArm) leftUpperArm.rotation.z = 1.22 + armSway;
    if (rightUpperArm) rightUpperArm.rotation.z = -1.22 - armSway;
    if (leftLowerArm) leftLowerArm.rotation.y = 0.12;
    if (rightLowerArm) rightLowerArm.rotation.y = -0.12;
  }

  private blink(elapsed: number): void {
    if (elapsed - this.lastBlink > this.nextBlink) {
      this.blinkState = 'closing';
      this.lastBlink = elapsed;
      this.nextBlink = 2 + Math.random() * 4;
    }
    if (this.blinkState === 'closing') {
      const p = (elapsed - this.lastBlink) / (this.blinkDuration / 2);
      if (p >= 1) {
        this.expression.setBlink(1);
        this.blinkState = 'opening';
      } else this.expression.setBlink(p);
    } else if (this.blinkState === 'opening') {
      const p =
        (elapsed - (this.lastBlink + this.blinkDuration / 2)) / (this.blinkDuration / 2);
      if (p >= 1) {
        this.expression.setBlink(0);
        this.blinkState = 'open';
      } else this.expression.setBlink(1 - p);
    }
  }

  private lookAtCursor(): void {
    const model = this.model;
    if (!model?.lookAt?.target) return;
    this.targetLookAt.set(
      this.mouse.x * 1.7,
      (model.headHeight || 1.4) + this.mouse.y * 0.8,
      0.45,
    );
    model.lookAt.target.position.copy(this.targetLookAt);
  }

  // -- sizing -----------------------------------------------------------------

  private resize(): void {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  // -- teardown (WEB_CONTRACT §7 cleanup checklist) ---------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // cancel RAF
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // clear all gesture/emotion/blink timers
    this.expression.clearTimer();
    for (const id of this.gestureTimers) clearTimeout(id);
    this.gestureTimers.clear();

    // increment loadSeq so late model loads are ignored + disposed
    this.loadSeq += 1;

    // disconnect ResizeObserver
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // remove named listeners
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('webglcontextlost', this.onContextLost as EventListener, false);
    canvas.removeEventListener(
      'webglcontextrestored',
      this.onContextRestored as EventListener,
      false,
    );
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    // controls
    this.controls?.dispose();
    this.controls = null;

    // remove + dispose current model scene (geometries, materials, textures, skeletons)
    if (this.model) {
      this.scene.remove(this.model.scene);
      const target = this.model.lookAt?.target;
      if (target && target.parent === this.scene) this.scene.remove(target);
      this.disposeObject(this.model.scene);
      this.model = null;
    }

    // renderer
    this.renderer.dispose();
    this.renderer.forceContextLoss();

    // remove canvas
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  private disposeObject(root: THREE.Object3D): void {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh & { skeleton?: THREE.Skeleton };
      // SkinnedMesh skeletons.
      if (mesh.skeleton) {
        mesh.skeleton.dispose?.();
      }
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose?.();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat) continue;
        // Dispose any texture maps referenced by the material.
        const record = mat as unknown as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          const value = record[key] as THREE.Texture | null | undefined;
          if (value && value.isTexture) value.dispose();
        }
        mat.dispose?.();
      }
    });
  }
}
