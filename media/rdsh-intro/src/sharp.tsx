import React,{useEffect,useState} from 'react';
import {AbsoluteFill,Audio,Composition,Img,continueRender,delayRender,interpolate,registerRoot,spring,staticFile,useCurrentFrame} from 'remotion';
import {TransitionSeries,linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {Ribbon} from './Ribbon';
import {DepthField} from './depth';
import './original.css';
import './sharp.css';

const FPS=60, TOTAL=1800;
// Palette: slate-900 ink + slate paper + sky accent (single blue family).
// Body text is always ink-on-light or paper-on-ink (AAA); sky is graphics-only.
const ink='#0F172A',accent='#0284C7',accentLight='#38BDF8',paper='#F8FAFC',grey='#E2E8F0',skyTint='#E0F2FE',green='#047857',amber='#B45309';
const muted='#475569',lightMuted='#CBD5E1',cliGrey='#E2E8F0';
const clamp={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
const lin=(f:number,a:number[],b:number[])=>interpolate(f,a,b,clamp);
// Fixed-time overdamped spring: smooth ease-out entrance, no bounce, done at dur.
const springIn=(f:number,at=0,dur=18)=>spring({fps:FPS,frame:f-at,config:{damping:200},durationInFrames:dur});
const rise=(v:number,px=26)=>interpolate(v,[0,1],[px,0],clamp);
const FADE=linearTiming({durationInFrames:12});
// No idle motion: elements settle after entrance and stay still.
const floatY=(_f:number,_e:number,_amp=7,_period=45,_phase=0)=>0;
const tiltX=(f:number,e:number,from=14,_phase=0)=>interpolate(e,[0,1],[from,0],clamp);
const extrude=(color:string,depth=7,glow:string|null=null)=>Array.from({length:depth},(_,i)=>`0 ${i+1}px 0 ${color}`).concat(glow?[glow]:[]).join(',');

// Full-scene wrapper: far particle layer, slow dolly-in, shared 3D space.
function Stage({children,bg,len,dark=false,seed=1}:{children:React.ReactNode;bg:string;len:number;dark?:boolean;seed?:number}){
  const f=useCurrentFrame();
  const p=f/len;
  return <AbsoluteFill style={{background:bg}}>
    <div style={{position:'absolute',inset:-130,transform:'translateZ(-160px) scale(1.12)'}}><DepthField dark={dark} seed={seed}/></div>
    <div className="q-scene3d" style={{transform:`scale(${1+0.035*p}) translateY(${-12*p}px)`,transformStyle:'preserve-3d'}}>{children}</div>
  </AbsoluteFill>;
}

function Title({children,detail,light=false}:{children:string;detail?:string;light?:boolean}){
  const f=useCurrentFrame();
  const e=springIn(f,0),d=springIn(f,7);
  return <div style={{position:'absolute',left:88,top:65,transform:`translateY(${rise(e)}px) translateZ(80px)`,opacity:e}}>
    <h1 className="q-title" style={{color:light?paper:ink}}>{children}</h1>
    {detail&&<div className="q-detail" style={{color:light?lightMuted:muted,opacity:d,transform:`translateY(${rise(d,14)}px)`}}>{detail}</div>}
  </div>;
}

function Prompt({children}:{children:string}){
  const f=useCurrentFrame();
  // 30-frame typing matches the key sounds in sharp-audio.py (local frames 1..30).
  const typed=children.slice(0,Math.floor(lin(f,[0,30],[0,children.length])));
  const caret=f<34?(f%16<8?1:0.2):0;
  return <div className="o-command" style={{fontSize:59,lineHeight:1.7,color:paper}}><span style={{color:accentLight}}>$</span> {typed}<span style={{color:accentLight,opacity:caret}}>▍</span></div>;
}

// Floating UI card: tilt entrance, idle hover, ground shadow for lift.
// Crop the actual captured UI without raster resizing. DPR-6 source pixels are
// at least as dense as the final 4K display for all desktop close-ups.
function Ui({file,x=88,y=315,width=1744,cropX=0,cropY=0,cropWidth=910,cropHeight,at=10,phase=0,style={}}:{file:string;x?:number;y?:number;width?:number;cropX?:number;cropY?:number;cropWidth?:number;cropHeight:number;at?:number;phase?:number;style?:React.CSSProperties}){
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

function Pointer({x,y,click}:{x:number;y:number;click:number}){
  return <div style={{position:'absolute',left:x,top:y,pointerEvents:'none',filter:'drop-shadow(0 6px 8px #0F172A55)'}}>
    {click>0&&<div style={{position:'absolute',left:-20,top:-20,width:76,height:76,border:`4px solid ${accentLight}`,borderRadius:50,transform:`scale(${0.5+click})`,opacity:Math.max(0,1-click*1.2)}}/>}
    <svg width="42" height="50" viewBox="0 0 32 38"><path d="M3 2L4 30L12 22L18 35L24 32L18 20L29 19Z" fill="white" stroke={ink} strokeWidth="2"/></svg>
  </div>;
}

function Intro(){
  const f=useCurrentFrame();
  const brand=springIn(f,0,22),sub=springIn(f,12,18),eye=springIn(f,0,14);
  const sway=0;
  return <Stage bg={ink} len={156} dark seed={11}>
    <div style={{position:'absolute',inset:-130,transform:'translateZ(-120px) scale(1.09)',opacity:0.55}}><Ribbon/></div>
    <div style={{position:'absolute',left:88,top:78,fontSize:36,color:lightMuted,opacity:eye,transform:`translateZ(60px)`}}>rdsh紹介・30秒デモ</div>
    <div className="o-brand" style={{position:'absolute',left:78,top:258,fontSize:278,color:paper,transform:`translateX(${rise(brand,54)}px) rotateY(${sway}deg)`,opacity:brand,textShadow:extrude('#060B18',7,`0 16px 46px ${accentLight}55`)}}><span style={{color:accentLight,fontWeight:400,marginRight:38,textShadow:extrude('#06283F',7,`0 16px 46px ${accentLight}88`)}}>›</span>rdsh</div>
    <div style={{position:'absolute',left:88,top:660,opacity:sub,transform:`translateY(${rise(sub,20)}px) translateZ(80px)`}}><div className="q-title" style={{fontSize:93,color:paper,textShadow:extrude('#060B18',5)}}>コマンドの結果を、<br/>ブラウザで見る。</div></div>
  </Stage>;
}

function Perf(){
  const f=useCurrentFrame();
  const e=springIn(f,8,20);
  const b1=springIn(f,40,30), b2=springIn(f,54,30);
  const row=(label:string,name:string,w:number,color:string,value:string,pill?:string)=>{
    return <div style={{display:'flex',alignItems:'center',gap:20,height:60}}>
      <span style={{width:132,fontSize:31,color:lightMuted}}>{label}</span>
      <span className="o-command" style={{width:92,fontSize:31,color:paper}}>{name}</span>
      <div style={{width:950}}><div style={{width:Math.max(10,w),height:30,borderRadius:8,background:color}}/></div>
      <span style={{fontSize:31,fontWeight:700,color:paper,whiteSpace:'nowrap'}}>{value}</span>
      {pill&&<span style={{fontSize:27,fontWeight:700,color:paper,background:accent,borderRadius:20,padding:'6px 18px',whiteSpace:'nowrap'}}>{pill}</span>}
    </div>;
  };
  return <Stage bg={paper} len={228} seed={17}>
    <Title detail="本家dshは約88ミリ秒。benchで再現できる。">約0.90ミリ秒で起動</Title>
    <div className="q-ground" style={{left:128,width:1664,top:876,opacity:e*0.9}}/>
    <div style={{position:'absolute',left:88,top:320,width:1744,height:530,borderRadius:14,background:ink,opacity:e,transform:`translateY(${rise(e,30)}px) rotateX(${tiltX(f,e,10,1.1)}deg)`,boxShadow:'0 30px 70px #0F172A30,0 4px 14px #0F172A18',overflow:'hidden'}}>
      <div style={{padding:'30px 43px 26px'}}>
        <Prompt>rdsh bench --n 5</Prompt>
        <div style={{marginTop:26,opacity:lin(f,[40,48],[0,1])}}>
          {row('起動時間','dsh',b1*950,'#64748B','約88ms')}
          {row('起動時間','rdsh',b1*10,accentLight,'約0.90ms','約98倍')}
          {row('メモリ','dsh',b2*950,'#64748B','約66MB')}
          {row('メモリ','rdsh',b2*42,accentLight,'約2.9MB','約1/23')}
        </div>
        <div style={{marginTop:14,fontSize:29,color:lightMuted,opacity:lin(f,[70,80],[0,1])}}>短いCLI呼び出しの実測（Linux x86_64）。</div>
      </div>
    </div>
  </Stage>;
}

// Physical console: chrome bar, tilt entrance, idle hover, ground shadow.
function Console({label,children}:{label:string;children:React.ReactNode}){
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

function Search(){
  const f=useCurrentFrame(), result=f>=34;
  return <Stage bg={grey} len={228} seed={23}>
    <Title detail="プロジェクト内をまとめて探す。">残りのTODOを全件検索</Title>
    <Console label="rdsh — console">
      <Prompt>rdsh search TODO --dir .</Prompt>
      <div className="o-command" style={{fontSize:45,lineHeight:1.7,color:cliGrey,marginTop:36,opacity:lin(f,[34,40],[0,1])}}>
        ./README.md:3: <span style={{color:ink,background:accentLight,padding:'5px 9px'}}>TODO</span>: add a welcome screen
      </div>
      <div style={{marginTop:30,fontSize:34,color:lightMuted,opacity:result?1:0}}>READMEの3行目にTODOを発見。</div>
    </Console>
  </Stage>;
}

function Tokens(){
  const f=useCurrentFrame();
  return <Stage bg={grey} len={156} seed={37}>
    <Title detail="README.mdは10トークン。">トークン数を数える</Title>
    <Console label="rdsh — console">
      <Prompt>rdsh tokens README.md</Prompt>
      <div style={{marginTop:30,display:'flex',alignItems:'center',gap:42,opacity:lin(f,[34,40],[0,1])}}><span style={{fontSize:176,fontWeight:700,lineHeight:1,color:paper}}>10</span><div style={{fontSize:45,lineHeight:1.7,color:cliGrey}}>トークン<br/><span className="o-command" style={{fontSize:32}}>軽いファイル。すぐ送れる。</span></div></div>
    </Console>
  </Stage>;
}

function Progress(){
  const f=useCurrentFrame(), metrics=f>=158;
  return <Stage bg={paper} len={264} seed={41}>
    <Title detail={metrics?'$1.28使用・70%を再利用。':'進行中・次の作業・完了'}>{metrics?'料金と節約率を確認する':'タスクの進み具合を一覧にする'}</Title>
    {!metrics&&<><Ui file="project-tasks.png" y={323} cropY={123} cropHeight={215}/>
      <div style={{position:'absolute',left:88,top:794,display:'flex',gap:55,fontSize:36}}>{['進行中','次の作業','完了'].map((text,i)=>{const e=springIn(f,22+i*6,14);return <div key={text} style={{borderLeft:`8px solid ${[accent,amber,green][i]}`,paddingLeft:23,opacity:e}}>{text}</div>;})}</div>
    </>}
    {metrics&&<><Ui file="project-metrics.png" y={323} width={788} cropWidth={292} cropHeight={172} at={8} phase={1.3}/><Ui file="project-metrics.png" x={1014} y={323} width={788} cropX={617} cropWidth={292} cropHeight={172} at={18} phase={2.1}/></>}
  </Stage>;
}

function Answer(){
  const f=useCurrentFrame(),saved=f>=126;
  const scale=1744/910;
  // Pointer path matches the click sound at local frame 104 (global 860).
  const px=interpolate(springIn(f,49,44),[0,1],[1583,155],clamp);
  const py=interpolate(springIn(f,49,44),[0,1],[842,317+255*scale],clamp);
  const click=f>=104?spring({fps:FPS,frame:f-104,config:{damping:13,stiffness:180},durationInFrames:22}):0;
  const pop=saved?spring({fps:FPS,frame:f-126,config:{damping:13,stiffness:180}}):0;
  return <Stage bg={grey} len={336} seed={53}>
    <Title detail={saved?'状態が回答済みに変わる。':'書いて、回答を返すを押す。'}>{saved?'回答を保存しました':'AIの質問にブラウザで答える'}</Title>
    <Ui file={saved?'question-saved.png':'question-draft.png'} y={317} cropHeight={saved?146:288} phase={0.9}/>
    {!saved&&f>=49&&<Pointer x={px} y={py} click={click}/>}
    {saved&&<div style={{position:'absolute',left:88,top:680,display:'flex',alignItems:'center',gap:24,opacity:pop,transform:`scale(${interpolate(pop,[0,1],[0.7,1],clamp)}) translateZ(60px)`}}><div style={{width:68,height:68,background:green,borderRadius:9,color:paper,textAlign:'center',fontSize:49,lineHeight:'68px'}}>✓</div><span style={{fontSize:53,fontWeight:700}}>回答済み</span></div>}
  </Stage>;
}

function Mobile(){
  const f=useCurrentFrame(), scale=2.1;
  const e=springIn(f,8,22);
  const fy=floatY(f,e,9,52,1.9);
  const ry=interpolate(e,[0,1],[-12,-4],clamp);
  const W=390*scale,H=354*scale;
  return <Stage bg={skyTint} len={156} seed={67}>
    <div style={{position:'absolute',left:88,top:155,opacity:springIn(f,0,18),transform:`translateY(${rise(springIn(f,0,18))}px) translateZ(80px)`}}><h1 className="q-title" style={{fontSize:99}}>スマホでも<br/>同じ画面を見る。</h1><div className="q-detail" style={{marginTop:55,color:muted}}>続きを手元で確認する。</div></div>
    <div className="q-ground" style={{left:1035+40,width:W-80,top:198+H+30,opacity:e*0.9}}/>
    <div style={{position:'absolute',left:1035,top:198,width:W,opacity:e,transform:`translateY(${rise(e,40)+fy}px) rotateY(${ry}deg)`,transformStyle:'preserve-3d'}}>
      <div style={{borderRadius:34,padding:15,background:'linear-gradient(135deg,#FFFFFF,#C9D8E8 38%,#8FA5BB 50%,#DBE6F2 62%,#FFFFFF)',boxShadow:'30px 44px 80px #0F172A30,4px 2px 2px #BDD0E4'}}>
        <div style={{position:'relative',width:W-30,height:H-30,borderRadius:22,overflow:'hidden',background:paper,boxShadow:'0 0 0 2px #16283C'}}>
          <Img src={staticFile('sharp/project-mobile-question.png')} style={{position:'absolute',left:0,top:-248*scale,width:390*scale}}/>
          <div style={{position:'absolute',width:82*scale/2.1,height:17*scale/2.1,left:(W-30)/2-41*scale/2.1,top:12,borderRadius:20,background:'#162433'}}/>
        </div>
      </div>
    </div>
  </Stage>;
}

function Closing(){
  const f=useCurrentFrame();
  const sway=0;
  const line=(at:number,z=0)=>{const e=springIn(f,at,16);return {opacity:e,transform:`translateY(${rise(e,18)}px) translateZ(${z}px)`} as const;};
  return <Stage bg={ink} len={360} dark seed={79}>
    <div className="o-brand" style={{position:'absolute',left:80,top:97,fontSize:213,color:paper,...line(0),transform:`${line(0).transform} rotateY(${sway}deg)`,textShadow:extrude('#060B18',6,`0 14px 40px ${accentLight}44`)}}><span style={{color:accentLight,fontWeight:400,marginRight:28}}>›</span>rdsh</div>
    <div style={{position:'absolute',left:88,top:385,fontSize:59,fontWeight:700,color:paper,...line(8,80)}}>次のコマンドで始める。</div>
    <div className="o-command" style={{position:'absolute',left:88,top:507,fontSize:66,color:paper,...line(16,40)}}><span style={{color:accentLight}}>$</span> rdsh setup --web</div>
    <div style={{position:'absolute',left:88,top:651,fontSize:39,color:lightMuted,...line(24)}}>github.com/jimoto-no-llm/rustdsh</div>
    <div style={{position:'absolute',left:88,bottom:120,fontSize:27,color:lightMuted,...line(30)}}>引数はそのまま本家へ。使い方は変えない。</div>
    <div style={{position:'absolute',left:88,bottom:42,fontSize:26,lineHeight:1.65,color:lightMuted,...line(36)}}>Music: “Chill Wave” · Kevin MacLeod (CC BY 4.0)</div>
  </Stage>;
}

function SharpFilm(){
  const [handle]=useState(()=>delayRender('4K typography'));
  useEffect(()=>{Promise.all([document.fonts.load('700 96px NotoOriginal'),document.fonts.load('500 38px NotoOriginal'),document.fonts.load('700 200px InstrumentOriginal'),document.fonts.load('400 59px CommandOriginal')]).then(()=>continueRender(handle));},[handle]);
  // Scene lengths include a 12-frame fade tail; starts stay on the 30-second
  // grid (0/144/360/576/720/972/1296/1440) so the timed UI sounds keep sync.
  return <AbsoluteFill style={{background:ink}}><div className="o-film q-stage">
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={156}><Intro/></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={FADE}/>
      <TransitionSeries.Sequence durationInFrames={228}><Perf/></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={FADE}/>
      <TransitionSeries.Sequence durationInFrames={228}><Search/></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={FADE}/>
      <TransitionSeries.Sequence durationInFrames={156}><Tokens/></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={FADE}/>
      <TransitionSeries.Sequence durationInFrames={264}><Progress/></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={FADE}/>
      <TransitionSeries.Sequence durationInFrames={336}><Answer/></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={FADE}/>
      <TransitionSeries.Sequence durationInFrames={156}><Mobile/></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={FADE}/>
      <TransitionSeries.Sequence durationInFrames={360}><Closing/></TransitionSeries.Sequence>
    </TransitionSeries>
    <Audio src={staticFile('sharp-mix.wav')}/>
  </div></AbsoluteFill>;
}

registerRoot(()=> <Composition id="RdshSharp" component={SharpFilm} width={3840} height={2160} fps={FPS} durationInFrames={TOTAL}/>);
