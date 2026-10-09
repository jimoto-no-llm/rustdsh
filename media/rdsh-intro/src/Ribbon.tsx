import React, {useMemo} from 'react';
import {ThreeCanvas} from '@remotion/three';
import {useCurrentFrame} from 'remotion';
import * as THREE from 'three';

function ribbonGeometry(offset: number) {
  const longitudinal = 150;
  const transverse = 18;
  const points: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= longitudinal; i++) {
    const t = i / longitudinal * 2 - 1;
    for (let j = 0; j <= transverse; j++) {
      const u = j / transverse * 2 - 1;
      const twist = t * Math.PI * 0.77 + offset;
      const width = 1.12 + Math.cos(t * Math.PI) * 0.32;
      points.push(
        t * 16,
        0.85 * Math.sin(t * 2.8 + offset) + u * width * Math.cos(twist),
        0.6 * Math.cos(t * 3.2) + u * width * Math.sin(twist) + u * u * 0.18,
      );
    }
  }
  for (let i = 0; i < longitudinal; i++) for (let j = 0; j < transverse; j++) {
    const a = i * (transverse + 1) + j;
    const b = a + transverse + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function reflectionTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  for (const [at, color] of [[0, '#e4efff'], [.12, '#8ca8c8'], [.2, '#153f77'], [.27, '#243a53'], [.33, '#ffffff'], [.39, '#8bbeee'], [.45, '#0e3c78'], [.54, '#082c60'], [.62, '#badbff'], [.66, '#ffffff'], [.71, '#427eab'], [.81, '#123e77'], [.9, '#cbe6ff'], [1, '#ecfaff']] as [number, string][]) gradient.addColorStop(at, color);
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(48, 0, 28, 256); ctx.fillRect(336, 0, 82, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function RibbonMeshes({close}: {close: boolean}) {
  const f = useCurrentFrame();
  const geometry = useMemo(() => ribbonGeometry(.18), []);
  const secondary = useMemo(() => ribbonGeometry(1.3), []);
  const env = useMemo(reflectionTexture, []);
  const drift = f / 60;
  return <>
    <ambientLight intensity={.35}/>
    <directionalLight position={[-6, 8, 9]} intensity={1.2} color="#ffffff"/>
    <directionalLight position={[6, -2, 5]} intensity={.8} color="#b0d4ff"/>
    <group rotation={[.3 + Math.sin(drift * .65) * .13, drift * .045, -.58]} position={[0, close ? -.7 : .6, -1]}>
      <mesh geometry={geometry} rotation={[drift * .11, .05, 0]}>
        <meshPhysicalMaterial color="#1879d9" metalness={.92} roughness={.13} clearcoat={1} clearcoatRoughness={.08} envMap={env} envMapIntensity={1.6} side={THREE.DoubleSide}/>
      </mesh>
      <mesh geometry={secondary} position={[0, 3.6, -2.2]} rotation={[-.15, .1, -.04]}>
        <meshPhysicalMaterial color="#a6cbfa" metalness={.84} roughness={.17} clearcoat={1} envMap={env} envMapIntensity={1.3} side={THREE.DoubleSide}/>
      </mesh>
    </group>
  </>;
}

export function Ribbon({close = false}: {close?: boolean}) {
  return <ThreeCanvas width={1920} height={1080} camera={{fov: 42, position: [0, 0, 11.5]}} gl={{alpha: true, antialias: true, preserveDrawingBuffer: true}} style={{position: 'absolute', inset: 0}}>
    <RibbonMeshes close={close}/>
  </ThreeCanvas>;
}
