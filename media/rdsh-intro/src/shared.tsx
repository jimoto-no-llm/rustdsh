import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame } from 'remotion';
import { linearTiming } from '@remotion/transitions';
import { DepthField } from './depth';
import './original.css';
import './sharp.css';

export const FPS=60, TOTAL=1800;
// Palette: slate-900 ink + slate paper + sky accent (single blue family).
// Body text is always ink-on-light or paper-on-ink (AAA); sky is graphics-only.
export const ink='#0F172A',accent='#0284C7',accentLight='#38BDF8',paper='#F8FAFC',grey='#E2E8F0',skyTint='#E0F2FE',green='#047857',amber='#B45309';
export const muted='#475569',lightMuted='#CBD5E1',cliGrey='#E2E8F0';
export const clamp={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
export const lin=(f:number,a:number[],b:number[])=>interpolate(f,a,b,clamp);
// Fixed-time overdamped spring: smooth ease-out entrance, no bounce, done at dur.
export const springIn=(f:number,at=0,dur=18)=>spring({fps:FPS,frame:f-at,config:{damping:200},durationInFrames:dur});
export const rise=(v:number,px=26)=>interpolate(v,[0,1],[px,0],clamp);
export const FADE=linearTiming({durationInFrames:12});
// No idle motion: elements settle after entrance and stay still.
export const floatY=(_f:number,_e:number,_amp=7,_period=45,_phase=0)=>0;
export const tiltX=(f:number,e:number,from=14,_phase=0)=>interpolate(e,[0,1],[from,0],clamp);
export const extrude=(color:string,depth=7,glow:string|null=null)=>Array.from({length:depth},(_,i)=>`0 ${i+1}px 0 ${color}`).concat(glow?[glow]:[]).join(',');

// Full-scene wrapper: far particle layer, slow dolly-in, shared 3D space.
export function Stage({children,bg,len,dark=false,seed=1}:{children:React.ReactNode;bg:string;len:number;dark?:boolean;seed?:number}){
  const f=useCurrentFrame();
  const p=f/len;
  return <AbsoluteFill style={{background:bg}}>
    <div style={{position:'absolute',inset:-130,transform:'translateZ(-160px) scale(1.12)'}}><DepthField dark={dark} seed={seed}/></div>
    <div className="q-scene3d" style={{transform:`scale(${1+0.035*p}) translateY(${-12*p}px)`,transformStyle:'preserve-3d'}}>{children}</div>
  </AbsoluteFill>;
}

export function Title({children,detail,light=false}:{children:string;detail?:string;light?:boolean}){
  const f=useCurrentFrame();
  const e=springIn(f,0),d=springIn(f,7);
  return <div style={{position:'absolute',left:88,top:65,transform:`translateY(${rise(e)}px) translateZ(80px)`,opacity:e}}>
    <h1 className="q-title" style={{color:light?paper:ink}}>{children}</h1>
    {detail&&<div className="q-detail" style={{color:light?lightMuted:muted,opacity:d,transform:`translateY(${rise(d,14)}px)`}}>{detail}</div>}
  </div>;
}

export function Prompt({children}:{children:string}){
  const f=useCurrentFrame();
  // 30-frame typing matches the key sounds in sharp-audio.py (local frames 1..30).
  const typed=children.slice(0,Math.floor(lin(f,[0,30],[0,children.length])));
  const caret=f<34?(f%16<8?1:0.2):0;
  return <div className="o-command" style={{fontSize:59,lineHeight:1.7,color:paper}}><span style={{color:accentLight}}>$</span> {typed}<span style={{color:accentLight,opacity:caret}}>▍</span></div>;
}

// Floating UI card: tilt entrance, idle hover, ground shadow for lift.
// Crop the actual captured UI without raster resizing. DPR-6 source pixels are
// at least as dense as the final 4K display for all desktop close-ups.
export function Ui({file,x=88,y=315,width=1744,cropX=0,cropY=0,cropWidth=910,cropHeight,at=10,phase=0,style={}}:{file:string;x?:number;y?:number;width?:number;cropX?:number;cropY?:number;cropWidth?:number;cropHeight:number;at?:number;phase?:number;style?:React.CSSProperties}){
  const f=useCurrentFrame();
  const e=springIn(f,at,20);
  const scale=width/cropWidth;
  const h=cropHeight*scale;
  const fy=floatY(f,e,7,45,phase), tx=tiltX(f,e,13,phase);
  return <>
    <div className="q-ground" style={{left:x+40,width:width-80,top:y+h+26,opacity:e*0.9,transform:`scaleX(${1-e*0.06+Math.abs(fy)/220})`}}/>
    <div style={{position:'absolute',left:x,top:y,width,height:h,opacity:e,transform:`translateY(${rise(e,34)+fy}px) rotateX(${tx}deg)`,transformStyle:'preserve-3d',...style}}>
      <div style={{position:'absolute',inset:0,overflow:'hidden',borderRadius:14,background:paper,boxShadow:'0 30px 70px #0F172A26,0 4px 14px #0F172A14'}}>
        <Img src={staticFile(`sharp/${file}`)} style={{position:'absolute',left:-cropX*scale,top:-cropY*scale,width:1216*scale,maxWidth:'none',display:'block'}}/>
      </div>
    </div>
  </>;
}

export function Pointer({x,y,click}:{x:number;y:number;click:number}){
  return <div style={{position:'absolute',left:x,top:y,pointerEvents:'none',filter:'drop-shadow(0 6px 8px #0F172A55)'}}>
    {click>0&&<div style={{position:'absolute',left:-20,top:-20,width:76,height:76,border:`4px solid ${accentLight}`,borderRadius:50,transform:`scale(${0.5+click})`,opacity:Math.max(0,1-click*1.2)}}/>}
    <svg width="42" height="50" viewBox="0 0 32 38"><path d="M3 2L4 30L12 22L18 35L24 32L18 20L29 19Z" fill="white" stroke={ink} strokeWidth="2"/></svg>
  </div>;
}


export function Console({label,children}:{label:string;children:React.ReactNode}){
  const f=useCurrentFrame();
  const e=springIn(f,8,20);
  const fy=floatY(f,e,6,48,0.7), tx=tiltX(f,e,10,0.7);
  return <>
    <div className="q-ground" style={{left:128,width:1664,top:876,opacity:e*0.9,transform:`scaleX(${1-e*0.05+Math.abs(fy)/240})`}}/>
    <div style={{position:'absolute',left:88,top:330,width:1744,height:520,borderRadius:14,background:ink,opacity:e,transform:`translateY(${rise(e,30)+fy}px) rotateX(${tx}deg)`,boxShadow:'0 30px 70px #0F172A30,0 4px 14px #0F172A18',overflow:'hidden'}}>
      <div style={{display:'flex',alignItems:'center',gap:14,padding:'22px 43px 0'}}>
        {['#FF5F57','#FEBC2E','#28C840'].map(c=><div key={c} style={{width:18,height:18,borderRadius:9,background:c,opacity:0.85}}/>)}
        <div className="o-command" style={{marginLeft:14,fontSize:26,color:lightMuted}}>{label}</div>
      </div>
      <div style={{padding:'14px 43px 30px'}}>{children}</div>
    </div>
  </>;
}

