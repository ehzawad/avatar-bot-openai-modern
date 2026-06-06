import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AvatarModelLoader } from './modelLoader.js';
import { ExpressionController } from './expressionController.js';

export class AvatarScene {
  constructor(root, audioPlayer) {
    this.root = root;
    this.audioPlayer = audioPlayer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 20);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.controls = null;
    this.clock = new THREE.Clock();
    this.loader = new AvatarModelLoader();
    this.expression = new ExpressionController();
    this.vrm = null;
    this.mouse = new THREE.Vector2(0, 0);
    this.targetLookAt = new THREE.Vector3();
    this.lastBlink = 0;
    this.nextBlink = 3.5;
    this.blinkState = 'open';
    this.blinkDuration = 0.16;
  }

  async init() {
    this.camera.position.set(0, 0.85, 1.85);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.root.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
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

    window.addEventListener('resize', () => this.#resize());
    window.addEventListener('mousemove', (event) => {
      this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    });

    this.useGeneratedAvatar();
    this.#animate();
  }

  async loadModel(url, fallbackUrl = null) {
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      this.#dispose(this.vrm.scene);
      this.vrm = null;
    }
    const vrm = await this.loader.load(url, fallbackUrl);
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    if (vrm.lookAt) {
      vrm.lookAt.target = new THREE.Object3D();
      this.scene.add(vrm.lookAt.target);
    }
    this.expression.bind(vrm);
    this.controls.target.set(0, 0.48, 0);
    this.camera.position.set(0, 0.86, 1.85);
    this.controls.update();
  }

  useGeneratedAvatar() {
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      this.#dispose(this.vrm.scene);
    }
    const vrm = this.loader.createFallbackAvatar();
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    if (vrm.lookAt) {
      vrm.lookAt.target = new THREE.Object3D();
      this.scene.add(vrm.lookAt.target);
    }
    this.expression.bind(vrm);
    this.controls.target.set(0, 0.56, 0);
    this.camera.position.set(0, 0.9, 1.85);
    this.controls.update();
  }

  async loadUploadedFile(file) {
    const url = URL.createObjectURL(file);
    try {
      await this.loadModel(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  setEmotion(emotion) {
    this.expression.setEmotion(emotion);
  }

  applyGesture(gesture) {
    if (!this.vrm) return;
    if (gesture === 'nod') this.#temporaryHeadRotation('x', 0.12);
    if (gesture === 'shake') this.#temporaryHeadRotation('y', 0.12);
    if (gesture === 'lean_in') this.vrm.scene.position.z = 0.04;
    if (gesture === 'wave') this.#wave();
    setTimeout(() => { if (this.vrm) this.vrm.scene.position.z = 0; }, 900);
  }

  #temporaryHeadRotation(axis, amount) {
    const head = this.vrm?.humanoid?.getNormalizedBoneNode?.('head');
    if (!head) return;
    const original = head.rotation[axis];
    head.rotation[axis] = original + amount;
    setTimeout(() => { head.rotation[axis] = original; }, 420);
  }

  #wave() {
    const upper = this.vrm?.humanoid?.getNormalizedBoneNode?.('rightUpperArm');
    const lower = this.vrm?.humanoid?.getNormalizedBoneNode?.('rightLowerArm');
    if (!upper || !lower) return;
    const z = upper.rotation.z;
    const y = lower.rotation.y;
    upper.rotation.z = -2.0;
    lower.rotation.y = -0.75;
    setTimeout(() => { upper.rotation.z = z; lower.rotation.y = y; }, 700);
  }

  #animate() {
    requestAnimationFrame(() => this.#animate());
    const delta = this.clock.getDelta();
    const elapsed = this.clock.getElapsedTime();

    if (this.vrm) {
      this.#idleMotion(elapsed);
      this.#blink(elapsed);
      this.#lookAtCursor();
      this.expression.setMouth(this.audioPlayer.mouthLevel());
      this.vrm.update(delta);
    }

    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
  }

  #idleMotion(elapsed) {
    const sway = Math.sin(elapsed * 0.8);
    const breathe = Math.sin(elapsed * 1.5);
    const hips = this.vrm.humanoid?.getNormalizedBoneNode?.('hips');
    const spine = this.vrm.humanoid?.getNormalizedBoneNode?.('spine');
    const neck = this.vrm.humanoid?.getNormalizedBoneNode?.('neck');
    const leftUpperArm = this.vrm.humanoid?.getNormalizedBoneNode?.('leftUpperArm');
    const rightUpperArm = this.vrm.humanoid?.getNormalizedBoneNode?.('rightUpperArm');
    const leftLowerArm = this.vrm.humanoid?.getNormalizedBoneNode?.('leftLowerArm');
    const rightLowerArm = this.vrm.humanoid?.getNormalizedBoneNode?.('rightLowerArm');

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

  #blink(elapsed) {
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
      const p = (elapsed - (this.lastBlink + this.blinkDuration / 2)) / (this.blinkDuration / 2);
      if (p >= 1) {
        this.expression.setBlink(0);
        this.blinkState = 'open';
      } else this.expression.setBlink(1 - p);
    }
  }

  #lookAtCursor() {
    if (!this.vrm.lookAt?.target) return;
    this.targetLookAt.set(this.mouse.x * 1.7, (this.vrm.headHeight || 1.4) + this.mouse.y * 0.8, 0.45);
    this.vrm.lookAt.target.position.copy(this.targetLookAt);
  }

  #resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  #dispose(root) {
    root.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry?.dispose?.();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of materials) mat?.dispose?.();
    });
  }
}
