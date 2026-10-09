import React,{useMemo} from 'react';
import {ThreeCanvas} from '@remotion/three';
import {useCurrentFrame} from 'remotion';
import * as THREE from 'three';

// Deterministic RNG so geometry is stable across frames.
function mulberry32(seed:number){
  let a=seed>>>0;
  return ()=>{
    a|=0;a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}

function Field({dark,seed}:{dark:boolean;seed:number}){
  const f=useCurrentFrame();
  const positions=useMemo(()=>{
    const rand=mulberry32(seed);
    const arr=new Float32Array(700*3);
    for(let i=0;i<700;i++){
      // Wide box covering the fov-42 frustum at z=0, with real z spread for parallax.
      arr[i*3]=(rand()*2-1)*11;
      arr[i*3+1]=(rand()*2-1)*6.2;
      arr[i*3+2]=(rand()*2-1)*4.5;
    }
    return arr;
  },[seed]);
  const drift=f/60;
  return <>
    <fog attach="fog" args={[dark?'#0F172A':'#E2E8F0',9,24]}/>
    <ambientLight intensity={1}/>
    <points rotation={[Math.sin(drift*.22+seed)*.06,drift*.03+seed*.13,0]} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions,3]}/>
      </bufferGeometry>
      <pointsMaterial size={dark?0.055:0.05} color={dark?'#7cc4ff':'#8fa9c9'} transparent opacity={dark?0.8:0.55} sizeAttenuation depthWrite={false} blending={dark?THREE.AdditiveBlending:THREE.NormalBlending}/>
    </points>
    <points rotation={[Math.sin(drift*.17+seed*2)*.09,-drift*.02-seed*.07,0]} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions,3]}/>
      </bufferGeometry>
      <pointsMaterial size={0.11} color={dark?'#38BDF8':'#0284C7'} transparent opacity={dark?0.28:0.16} sizeAttenuation depthWrite={false} blending={dark?THREE.AdditiveBlending:THREE.NormalBlending}/>
    </points>
  </>;
}

// Full-stage particle depth behind the HTML content. Cheap: two point clouds.
export function DepthField({dark=false,seed=1}:{dark?:boolean;seed?:number}){
  return <ThreeCanvas width={1920} height={1080} camera={{fov:42,position:[0,0,11.5]}} gl={{alpha:true,antialias:true}} style={{position:'absolute',inset:0}}>
    <Field dark={dark} seed={seed}/>
  </ThreeCanvas>;
}
