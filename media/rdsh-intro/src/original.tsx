import React,{useEffect,useState} from 'react';
import {AbsoluteFill,Audio,Composition,Easing,Img,Sequence,continueRender,delayRender,interpolate,registerRoot,staticFile,useCurrentFrame} from 'remotion';
import cli from '../public/cli.json';
import './original.css';

const FPS=60;
const DURATION=2640;
const ink='#382c46', orange='#e8743b', grey='#e8e9e6', violet='#ded7e7', paper='#f8f9f6', green='#337a67';
const clamp={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;
const lin=(f:number,a:number[],b:number[])=>interpolate(f,a,b,clamp);
const ease=(f:number,a:number[],b:number[])=>interpolate(f,a,b,{...clamp,easing:Easing.bezier(.65,0,.2,1)});

function Block({x,y,size=20,color=orange,style={}}:{x:number;y:number;size?:number;color?:string;style?:React.CSSProperties}){
  return <div style={{position:'absolute',left:x,top:y,width:size,height:size,background:color,...style}}/>;
}
function Line({path,progress,color=orange,width=5}:{path:string;progress:number;color?:string;width?:number}){
  return <svg width="1920" height="1080" style={{position:'absolute',inset:0,pointerEvents:'none'}}><path d={path} pathLength={1} fill="none" stroke={color} strokeWidth={width} strokeLinejoin="round" strokeDasharray={1} strokeDashoffset={1-progress}/></svg>;
}
function Footer({children}:{children:string}){return <div className="o-footer">{children}</div>;}
function Reveal({children,at=0,duration=38,style={}}:{children:React.ReactNode;at?:number;duration?:number;style?:React.CSSProperties}){
  const f=useCurrentFrame(),p=ease(f,[at,at+duration],[0,1]);
  return <div style={{clipPath:`inset(0 ${(1-p)*100}% 0 0)`,...style}}>{children}</div>;
}
function Panel({children,style={}}:{children:React.ReactNode;style?:React.CSSProperties}){
  return <div className="o-panel" style={style}>{children}</div>;
}
function Heading(){return <div className="o-panel-header"><Img src={staticFile('icon.png')}/>rdsh-demo<span style={{marginLeft:'auto',fontWeight:400,color:'#8d8592',fontSize:18}}>プロジェクト</span></div>;}

function Opening(){
  const f=useCurrentFrame();
  const typed='rdsh'.slice(0,Math.floor(lin(f,[32,94],[0,4])));
  const travel=ease(f,[126,198],[0,1]);
  return <AbsoluteFill style={{background:ink,color:paper}}>
    <div style={{position:'absolute',left:112,top:94,fontSize:27,color:'#b5a8c0',opacity:lin(f,[12,40],[0,1])}}>Rust製のDSHラッパー</div>
    <div style={{position:'absolute',left:112,top:320,display:'flex',alignItems:'center',gap:43}}>
      <svg width="73" height="110" viewBox="0 0 73 110"><path d="M10 12L57 55L10 98" fill="none" stroke={orange} strokeWidth="13"/></svg>
      <div className="o-brand" style={{fontSize:275,minWidth:577}}>{typed}<span style={{display:'inline-block',width:32,height:209,marginLeft:14,background:orange,verticalAlign:-6,opacity:f<118?(f%44<30?1:0):0}}/></div>
    </div>
    <Line path="M112 681 H891 V444 H1072" progress={travel} width={7}/>
    <Block x={1072} y={434} style={{opacity:travel}}/>
    <div style={{position:'absolute',left:1152,top:370}}><Reveal at={137}><h1 className="o-head" style={{fontSize:70,color:paper}}>その一行から、<br/>作業がつながる。</h1></Reveal></div>
    <div style={{position:'absolute',left:112,top:800,fontSize:30,color:'#d0c5d8',opacity:lin(f,[170,206],[0,1])}}>コマンドも。進捗も。次の判断も。</div>
    <div style={{position:'absolute',right:112,bottom:56,fontSize:22,color:'#b5a8c0'}}>{cli.version}</div>
  </AbsoluteFill>;
}

function Commands(){
  const f=useCurrentFrame();
  const second=f>=213;
  const text=second?'rdsh tokens README.md':'rdsh search TODO --dir .';
  const chars=Math.floor(lin(f,second?[213,286]:[23,104],[0,text.length]));
  const show=lin(f,second?[299,320]:[120,144],[0,1]);
  return <AbsoluteFill style={{background:grey}}>
    <div style={{position:'absolute',left:112,top:114}}><Reveal><h1 className="o-head" style={{fontSize:77}}>一行で、<br/>探す。見積もる。</h1></Reveal></div>
    <div style={{position:'absolute',left:112,top:459,width:774,height:226,background:ink,borderRadius:8,color:paper,padding:'35px 32px'}}>
      <div className="o-command" style={{fontSize:30,lineHeight:1.6}}><span style={{color:orange}}>$</span> {text.slice(0,chars)}<span style={{color:orange,opacity:chars<text.length&&f%36<24?1:0}}>▍</span></div>
      <div style={{fontSize:25,color:'#bcaec8',marginTop:36}}>{second?'入力の大きさを、トークンで把握。':'ファイルから、必要な箇所だけ。'}</div>
    </div>
    <Line path="M884 571 H987 V406 H1060" progress={ease(f,[96,135],[0,1])}/>
    <Panel style={{position:'absolute',left:1076,top:240,width:732,height:553,transform:`translateX(${ease(f,[0,46],[110,0])}px)`}}>
      <div style={{padding:'35px 38px',borderBottom:'1px solid #ded7e7',fontSize:25}}>README.md</div>
      <div style={{padding:'36px 38px',color:'#827888',fontSize:31,lineHeight:1.8}}># rdsh demo<br/><span style={{display:'inline-block',height:28}}/>
      <div style={{background:!second&&show>0?`${orange}35`:'transparent',color:ink}}>TODO: add a welcome screen</div></div>
      <div style={{position:'absolute',left:38,right:38,bottom:35,background:violet,padding:'23px 24px',opacity:show,borderRadius:6}}>
        {second?<div className="o-row"><span style={{fontSize:63,fontWeight:600,letterSpacing:-4}}>10</span><span style={{fontSize:24}}>トークン見積もり</span></div>:<div className="o-command" style={{fontSize:18,letterSpacing:-.2,lineHeight:1.7}}>{cli.search}</div>}
      </div>
    </Panel>
    <Block x={1039} y={397} style={{opacity:show}}/>
    <div style={{position:'absolute',left:112,top:761,fontSize:27,color:'#736779',opacity:lin(f,[141,160],[0,1])}}>search と tokens は、Rustで直接処理。</div>
    <Footer>実際のCLI出力 / 架空のREADMEを使用</Footer>
  </AbsoluteFill>;
}

function Native(){
  const f=useCurrentFrame();
  return <AbsoluteFill style={{background:violet}}>
    <div style={{position:'absolute',left:112,top:116}}><Reveal><h1 className="o-head">軽い処理は、<br/>Rustで。</h1></Reveal><div className="o-note" style={{marginTop:38}}>いつものDSHに、<br/>軽量なコマンドを添える。</div></div>
    <div style={{position:'absolute',left:903,top:162,width:867}}>{['search','tokens','prune'].map((name,i)=>{
      const p=ease(f,[24+i*23,73+i*23],[0,1]);
      return <div key={name} style={{height:142,marginBottom:24,background:paper,borderRadius:8,padding:'29px 36px',position:'relative',transform:`translateX(${(1-p)*170}px)`,opacity:p}}>
        <div className="o-command" style={{fontSize:46}}><span style={{color:'#9c92a3'}}>rdsh </span>{name}</div>
        <div style={{position:'absolute',right:36,top:42,color:green,fontSize:31,opacity:lin(f,[87+i*23,103+i*23],[0,1])}}>native</div>
        <div style={{position:'absolute',left:0,bottom:0,width:`${p*100}%`,height:7,background:orange,borderRadius:'0 0 8px 8px'}}/>
      </div>;
    })}</div>
    <div style={{position:'absolute',left:903,top:725,opacity:lin(f,[146,176],[0,1])}}><div style={{fontSize:31}}>CLI起動中央値 <span style={{fontSize:57,fontWeight:650,letterSpacing:-3,marginLeft:18}}>0.90<span style={{fontSize:27,letterSpacing:0,marginLeft:8}}>ms</span></span></div><div className="o-note" style={{fontSize:20,marginTop:18}}>--version / Linux x86_64 / READMEの5回計測</div></div>
    <Footer>会話は本家DSHへ委譲。ネイティブ処理をRustで実行。</Footer>
  </AbsoluteFill>;
}

function Tasks(){
  const f=useCurrentFrame(), pan=ease(f,[155,380],[0,-52]);
  return <AbsoluteFill style={{background:paper}}>
    <div style={{position:'absolute',left:112,top:130}}><Reveal><h1 className="o-head" style={{fontSize:73}}>いま何が、<br/>進んでいる？</h1></Reveal>
      <div className="o-note" style={{marginTop:33,fontSize:27}}>タスクと指標を、<br/>同じ場所で確認。</div>
    </div>
    <div style={{position:'absolute',left:112,top:595,width:475}}>{['doing','todo','done'].map((label,i)=>{
      const p=ease(f,[75+i*30,165+i*30],[0,1]);
      return <div key={label} style={{height:75,display:'flex',alignItems:'center',gap:24}}><div className="o-command" style={{fontSize:24,width:90,color:ink}}>{label}</div><div style={{width:246,height:12,background:'#e4e1e7',borderRadius:4}}><div style={{width:`${p*100}%`,height:12,background:[orange,'#b0a6b8',green][i],borderRadius:4}}/></div><div style={{fontSize:26,opacity:p}}>1</div></div>;
    })}</div>
    <Line path="M590 424 H673 V363 H745" progress={ease(f,[14,67],[0,1])}/>
    <div style={{position:'absolute',left:763,top:122,width:1060,height:645,overflow:'hidden',borderRadius:16,background:'#edeee9',boxShadow:'0 25px 55px #382c4612'}}>
      <div style={{transform:`translateY(${pan}px)`}}><Heading/><Img src={staticFile('project-tasks.png')} style={{display:'block',width:1060}}/><Img src={staticFile('project-metrics.png')} style={{display:'block',width:1060,marginTop:22}}/></div>
    </div>
    <Block x={732} y={354} style={{opacity:lin(f,[55,76],[0,1])}}/>
    <Footer>プロジェクトDashboard / タスクと指標はデモデータ</Footer>
  </AbsoluteFill>;
}

function Pointer({x,y,click}:{x:number;y:number;click:number}){
  return <div style={{position:'absolute',left:x,top:y}}><div style={{position:'absolute',left:-17,top:-17,width:58,height:58,border:`3px solid ${orange}`,borderRadius:30,transform:`scale(${1+click*1.2})`,opacity:click>0?1-click:0}}/><svg width="34" height="40" viewBox="0 0 32 38"><path d="M3 2L4 30L12 22L18 35L24 32L18 20L29 19Z" fill="white" stroke={ink} strokeWidth="2"/></svg></div>;
}
function Answer(){
  const f=useCurrentFrame(), saved=f>=253;
  return <AbsoluteFill style={{background:grey}}>
    <div style={{position:'absolute',left:112,top:117}}><Reveal><h1 className="o-head">迷ったら、<br/>答える。</h1></Reveal><div className="o-note" style={{marginTop:30}}>質問に答えて、<br/>次の方針を渡す。</div></div>
    <Line path="M110 725 H599 V545 H726" progress={ease(f,[27,85],[0,1])}/>
    <Panel style={{position:'absolute',left:746,top:219,width:1062,height:ease(f,[253,286],[367,219])}}>
      <Heading/>
      <Img src={staticFile(saved?'question-saved.png':'question-draft.png')} style={{display:'block',width:1062}}/>
      {!saved&&f>110&&<Pointer x={ease(f,[110,228],[924,59])} y={ease(f,[110,228],[375,291])} click={f>230?lin(f,[230,252],[0,1]):0}/>}
    </Panel>
    <div style={{position:'absolute',left:746,top:654,display:'flex',alignItems:'center',gap:28,opacity:lin(f,[264,293],[0,1])}}>
      <div style={{width:46,height:46,background:green,borderRadius:6,color:paper,textAlign:'center',fontSize:32,lineHeight:'46px'}}>✓</div><div style={{fontSize:44,fontWeight:600}}>方針を保存。</div>
    </div>
    <div style={{position:'absolute',left:746,top:749,fontSize:29,color:'#706778',opacity:lin(f,[278,305],[0,1])}}>ブルーを基調に、シンプルな配色で進めてください。</div>
    <Block x={710} y={535} color={saved?green:orange} style={{opacity:lin(f,[75,98],[0,1])}}/>
    <Footer>架空の質問と回答 / 送信と保存を実際に確認した画面</Footer>
  </AbsoluteFill>;
}

function Handheld(){
  const f=useCurrentFrame();
  return <AbsoluteFill style={{background:violet}}>
    <div style={{position:'absolute',left:112,top:128}}><Reveal><h1 className="o-head">状況は、<br/>手元でも。</h1></Reveal><div className="o-note" style={{fontSize:29,marginTop:27}}>作業の場所が変わっても、<br/>進捗と質問を確認。</div></div>
    <Panel style={{position:'absolute',left:112,top:619,width:740,height:229}}><div style={{position:'absolute',top:-25,width:740}}><Img src={staticFile('project-tasks.png')} style={{width:740}}/></div></Panel>
    <Line path="M852 725 H981 V544 H1171" progress={ease(f,[28,93],[0,1])}/>
    <Block x={1152} y={535} style={{opacity:lin(f,[81,95],[0,1])}}/>
    <div className="o-handheld" style={{position:'absolute',left:1246,top:113,transform:`translateX(${ease(f,[0,49],[120,0])}px)`}}><Img src={staticFile('project-mobile-question.png')}/></div>
    <div style={{position:'absolute',right:111,top:475,fontSize:24,color:'#877a90',writingMode:'vertical-rl',letterSpacing:5}}>同じプロジェクト</div>
    <Footer>スマホ幅での表示デモ / 外出先の接続にはTailscaleの設定が必要</Footer>
  </AbsoluteFill>;
}

function Closing(){
  const f=useCurrentFrame();
  return <AbsoluteFill style={{background:ink,color:paper}}>
    <Line path="M112 846 H1798 V532 H976" progress={ease(f,[0,110],[0,1])} color="#72617e" width={4}/>
    <div style={{position:'absolute',left:112,top:280,display:'flex',gap:34,alignItems:'center'}}><svg width="62" height="94" viewBox="0 0 73 110"><path d="M10 12L57 55L10 98" fill="none" stroke={orange} strokeWidth="13"/></svg><div className="o-brand" style={{fontSize:238}}>rdsh</div></div>
    <div style={{position:'absolute',left:1117,top:286}}><Reveal at={12}><h1 className="o-head" style={{fontSize:72,color:paper}}>思考を止めない、<br/>道具に。</h1></Reveal></div>
    <div style={{position:'absolute',left:112,top:582,opacity:lin(f,[47,78],[0,1])}}><div className="o-command" style={{fontSize:39}}><span style={{color:orange}}>$</span> rdsh setup --web</div><div style={{fontSize:28,color:'#c8bdd2',marginTop:29}}>github.com/jimoto-no-llm/rustdsh</div></div>
    <div style={{position:'absolute',left:112,bottom:142,fontSize:22,color:'#b5a8c0'}}>Rust製のDSHラッパー / 独立したコミュニティプロジェクト</div>
    <div style={{position:'absolute',left:112,bottom:48,fontSize:19,lineHeight:1.65,color:'#c8bdd2'}}>Music: “Chill Wave” — Kevin MacLeod · incompetech.com<br/>CC BY 4.0 · creativecommons.org/licenses/by/4.0/ · 抜粋・音量調整・効果音追加</div>
    <Block x={ease(f,[95,156],[1768,981])} y={522} style={{opacity:lin(f,[62,85],[0,1])}}/>
  </AbsoluteFill>;
}

function OriginalFilm(){
  const [handle]=useState(()=>delayRender('Original film typography'));
  useEffect(()=>{Promise.all([document.fonts.load('650 80px NotoOriginal'),document.fonts.load('650 200px InstrumentOriginal'),document.fonts.load('400 32px CommandOriginal')]).then(()=>continueRender(handle));},[handle]);
  return <AbsoluteFill className="o-film">
    <Sequence from={0} durationInFrames={270}><Opening/></Sequence>
    <Sequence from={270} durationInFrames={450}><Commands/></Sequence>
    <Sequence from={720} durationInFrames={300}><Native/></Sequence>
    <Sequence from={1020} durationInFrames={480}><Tasks/></Sequence>
    <Sequence from={1500} durationInFrames={480}><Answer/></Sequence>
    <Sequence from={1980} durationInFrames={300}><Handheld/></Sequence>
    <Sequence from={2280} durationInFrames={360}><Closing/></Sequence>
    <Audio src={staticFile('original-mix.wav')}/>
  </AbsoluteFill>;
}
registerRoot(()=> <Composition id="RdshOriginal" component={OriginalFilm} width={1920} height={1080} fps={FPS} durationInFrames={DURATION}/>);
