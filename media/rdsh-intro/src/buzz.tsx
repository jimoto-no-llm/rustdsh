import React,{useEffect,useState} from 'react';
import {AbsoluteFill,Composition,continueRender,delayRender,interpolate,registerRoot,spring,useCurrentFrame} from 'remotion';
import {TransitionSeries,linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
// 既存コンポーネントを流用: Stage/Title/Prompt/Console/Ui + トークン類は sharp が正とする
import {Stage,Title,Prompt,Console,springIn,rise,lin,ink,paper,grey,accent,accentLight,muted,lightMuted,cliGrey} from './shared';
import './original.css';
import './sharp.css';

const FPS=60;
const FADE=linearTiming({durationInFrames:12});
const clamp={extrapolateLeft:'clamp',extrapolateRight:'clamp'} as const;

// 0-3s: フック。結論を先に言う。Stage(DepthField付き)をそのまま使う。
function B1(){
  const f=useCurrentFrame();
  const e=springIn(f,4,18);
  return <Stage bg={ink} len={180} dark seed={11}>
    <div style={{position:'absolute',left:88,top:78,fontSize:36,color:lightMuted,opacity:e}}>dshが重いと感じたら</div>
    <div style={{position:'absolute',left:78,top:258,fontSize:200,fontWeight:700,color:paper,opacity:e,transform:`translateY(${rise(e,40)}px)`}}>待ち時間を消した。</div>
    <div className="o-command" style={{position:'absolute',left:88,top:620,fontSize:66,color:accentLight,opacity:lin(f,[18,28],[0,1])}}>72ms → 0.86ms で起動する。</div>
    <div style={{position:'absolute',left:88,bottom:120,fontSize:32,color:lightMuted,opacity:lin(f,[28,40],[0,1])}}>rdshは引数そのままで動く高速ランチャーです。</div>
  </Stage>;
}

// 3-7s: 実測バー。Title + Stage を流用。数字は手元benchの中央値。
function B2(){
  const f=useCurrentFrame();
  const e=springIn(f,8,20);
  const b1=springIn(f,30,26), b2=springIn(f,44,26);
  const row=(label:string,name:string,w:number,color:string,value:string)=>(
    <div style={{display:'flex',alignItems:'center',gap:20,height:60}}>
      <span style={{width:132,fontSize:31,color:lightMuted}}>{label}</span>
      <span className="o-command" style={{width:92,fontSize:31,color:paper}}>{name}</span>
      <div style={{width:950}}><div style={{width:Math.max(10,w),height:30,borderRadius:8,background:color}}/></div>
      <span style={{fontSize:31,fontWeight:700,color:paper,whiteSpace:'nowrap'}}>{value}</span>
    </div>);
  return <Stage bg={paper} len={240} seed={17}>
    <Title detail="手元で5回測った中央値。短い起動の実測です。">あなたは待たずに打てる。</Title>
    <div style={{position:'absolute',left:88,top:320,width:1744,height:530,borderRadius:14,background:ink,opacity:e,transform:`translateY(${rise(e,30)}px)`,boxShadow:'0 30px 70px #0F172A30',overflow:'hidden'}}>
      <div style={{padding:'30px 43px 26px'}}>
        <Prompt>rdsh bench --n 5</Prompt>
        <div style={{marginTop:26,opacity:lin(f,[30,40],[0,1])}}>
          {row('起動','dsh',b1*950,'#64748B','72ms')}
          {row('起動','rdsh',b1*11,accentLight,'0.86ms・約84倍')}
          {row('常駐','dsh',b2*950,'#64748B','68MB')}
          {row('常駐','rdsh',b2*39,accentLight,'2.8MB・約1/24')}
        </div>
        <div style={{marginTop:14,fontSize:29,color:lightMuted,opacity:lin(f,[60,70],[0,1])}}>モデル通信は本家に渡すので速さは変わりません。</div>
      </div>
    </div>
  </Stage>;
}

// 7-11s: Console + Prompt を流用。一文一意味に直した。
function B3(){
  const f=useCurrentFrame();
  return <Stage bg={grey} len={240} seed={23}>
    <Title detail="会話は本家に任せます。">探す・数えるはNodeなしで終わる。</Title>
    <Console label="rdsh — console">
      <Prompt>rdsh search TODO --dir .</Prompt>
      <div className="o-command" style={{fontSize:45,lineHeight:1.7,color:cliGrey,marginTop:36,opacity:lin(f,[30,38],[0,1])}}>
        ./README.md:3: <span style={{color:ink,background:accentLight,padding:'5px 9px'}}>TODO</span>: welcome画面を追加する
      </div>
      <div style={{marginTop:30,fontSize:34,color:lightMuted,opacity:lin(f,[38,48],[0,1])}}>3行目で見つけた。トークン見積もりもその場で返る。</div>
    </Console>
  </Stage>;
}

// 11-15s: CTA。次の一手だけ。
function B4(){
  const f=useCurrentFrame();
  const e=springIn(f,6,16);
  return <Stage bg={ink} len={240} dark seed={79}>
    <div style={{position:'absolute',left:88,top:200,opacity:e,transform:`translateY(${rise(e)}px)`}}>
      <div style={{fontSize:110,fontWeight:700,color:paper}}>使い方は変えない。</div>
      <div className="o-command" style={{fontSize:72,marginTop:30,color:paper}}><span style={{color:accentLight}}>$</span> rdsh setup --web</div>
      <div style={{fontSize:36,marginTop:24,color:lightMuted}}>この1行ではじめる。詳細はREADMEへ。</div>
      <div className="o-command" style={{fontSize:30,marginTop:44,color:lightMuted}}>github.com/jimoto-no-llm/rustdsh</div>
    </div>
  </Stage>;
}

function BuzzFilm(){
  const [h]=useState(()=>delayRender('fonts'));
  useEffect(()=>{Promise.all([document.fonts.load('700 96px NotoOriginal'),document.fonts.load('500 38px NotoOriginal'),document.fonts.load('400 59px CommandOriginal')]).then(()=>continueRender(h));},[h]);
  return <AbsoluteFill style={{background:ink}}><div className="o-film q-stage">
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={180}><B1/></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={FADE}/>
      <TransitionSeries.Sequence durationInFrames={240}><B2/></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={FADE}/>
      <TransitionSeries.Sequence durationInFrames={240}><B3/></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={FADE}/>
      <TransitionSeries.Sequence durationInFrames={240}><B4/></TransitionSeries.Sequence>
    </TransitionSeries>
  </div></AbsoluteFill>;
}

registerRoot(()=><Composition id="RdshBuzz" component={BuzzFilm} width={3840} height={2160} fps={FPS} durationInFrames={900}/>);
