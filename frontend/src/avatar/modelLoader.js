import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

export class AvatarModelLoader {
  constructor() {
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));
  }

  load(url, fallbackUrl = null) {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => resolve(this.#normalize(gltf)),
        undefined,
        (error) => {
          if (!fallbackUrl) {
            reject(error);
            return;
          }
          this.load(fallbackUrl).then(resolve).catch(reject);
        },
      );
    });
  }

  createFallbackAvatar() {
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

    const bones = {
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

    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.236, 40, 16, 0, Math.PI * 2, 0, Math.PI * 0.54), hair);
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

    const leftCheek = new THREE.Mesh(new THREE.SphereGeometry(0.026, 16, 8), new THREE.MeshBasicMaterial({ color: 0xf59aa9, transparent: true, opacity: 0.52 }));
    leftCheek.position.set(-0.12, -0.055, 0.185);
    leftCheek.scale.set(1.4, 0.7, 0.2);
    bones.head.add(leftCheek);

    const rightCheek = leftCheek.clone();
    rightCheek.position.x = 0.12;
    bones.head.add(rightCheek);

    this.#addArm(bones.spine, bones.leftUpperArm, bones.leftLowerArm, -0.31, skin, fabric);
    this.#addArm(bones.spine, bones.rightUpperArm, bones.rightLowerArm, 0.31, skin, fabric);

    const expressionState = new Map();
    const setValue = (preset, value) => {
      expressionState.set(preset, Math.max(0, Math.min(1, Number(value) || 0)));
      const aa = expressionState.get('aa') || 0;
      const blink = expressionState.get('blink') || 0;
      const joy = Math.max(expressionState.get('happy') || 0, expressionState.get('joy') || 0, expressionState.get('fun') || 0);
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
      humanoid: { getNormalizedBoneNode: (name) => bones[name] || null },
      lookAt: { target: new THREE.Object3D() },
      update: () => {},
      headHeight: 1.42,
      morphTargetMeshes: [],
      fallbackMappings: new Map(),
    };
  }

  #normalize(gltf) {
    let vrm = gltf.userData.vrm;
    const nativeVrm = Boolean(vrm);

    if (!vrm) {
      vrm = {
        scene: gltf.scene,
        expressionManager: null,
        humanoid: { getNormalizedBoneNode: () => null },
        lookAt: { target: new THREE.Object3D() },
        update: () => {},
      };
    }

    vrm.scene.traverse((object) => {
      object.frustumCulled = false;
      if (object.isMesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });

    vrm.scene.rotation.y = nativeVrm ? Math.PI : -Math.PI / 2;
    vrm.scene.position.set(0, 0, 0);
    vrm.scene.scale.setScalar(this.#scaleFor(vrm.scene));
    vrm.headHeight = 1.45;
    vrm.morphTargetMeshes = this.#findMorphTargets(vrm.scene);
    vrm.fallbackMappings = this.#mapMorphTargets(vrm.morphTargetMeshes);
    return vrm;
  }

  #scaleFor(scene) {
    const box = new THREE.Box3().setFromObject(scene);
    const height = box.max.y - box.min.y;
    if (Number.isFinite(height) && height > 5) return 1.7 / height;
    return 1;
  }

  #findMorphTargets(scene) {
    const meshes = [];
    scene.traverse((object) => {
      if (object.isMesh && object.morphTargetDictionary && object.morphTargetInfluences) {
        meshes.push(object);
      }
    });
    return meshes;
  }

  #mapMorphTargets(meshes) {
    const mapping = new Map();
    for (const mesh of meshes) {
      const dict = mesh.morphTargetDictionary || {};
      const mouth = [];
      const blink = [];
      for (const [name, index] of Object.entries(dict)) {
        const key = String(name).toLowerCase();
        if (
          key.includes('viseme_aa') || key.includes('viseme_o') || key.includes('mouthopen') ||
          key.includes('mouth_open') || key.includes('jawopen') || key.includes('jaw_open') || key.includes('mouthfunnel')
        ) mouth.push(index);
        if (key.includes('blink') || key.includes('eyeclosed') || key.includes('eye_closed') || key.includes('eyesclosed')) blink.push(index);
      }
      mapping.set(mesh, { mouth, blink });
    }
    return mapping;
  }

  #addArm(parent, upper, lower, x, skin, fabric) {
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
