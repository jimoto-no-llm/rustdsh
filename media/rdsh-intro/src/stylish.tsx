import React, {useEffect, useState} from 'react';
import {AbsoluteFill, Audio, Composition, Easing, Img, Sequence, continueRender, delayRender, interpolate, registerRoot, spring, staticFile, useCurrentFrame} from 'remotion';
import {Ribbon} from './Ribbon';
import cli from '../public/cli.json';
import './stylish.css';

const FPS = 60;
const TOTAL = 52 * FPS;
const blue = '#075cbe';
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const mix = (f: number, a: number[], b: number[]) => interpolate(f, a, b, {...clamp, easing: Easing.bezier(.22, 1, .36, 1)});
const linear = (f: number, a: number[], b: number[]) => interpolate(f, a, b, clamp);
const enter = (f: number, at = 0) => spring({fps: FPS, frame: f - at, config: {damping: 23, stiffness: 105}});

function Shot({children, length, style = {}}: {children: React.ReactNode; length: number; style?: React.CSSProperties}) {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{opacity: linear(f, [0, 14, length - 14, length - 1], [0, 1, 1, 0]), ...style}}>{children}</AbsoluteFill>;
}

function Words({children, at = 0, size = 84, style = {}}: {children: string; at?: number; size?: number; style?: React.CSSProperties}) {
  const f = useCurrentFrame();
  return <div style={{position: 'relative', fontSize: size, fontWeight: 400, letterSpacing: '-.045em', lineHeight: 1.48, ...style}}>{children.split('').map((letter, i) => {
    const p = enter(f, at + i * 2.2);
    return <span key={i} style={{display: 'inline-block', overflow: 'hidden', verticalAlign: 'bottom', paddingBottom: 6}}><span style={{display: 'inline-block', transform: `translateY(${(1 - p) * 125}%)`, opacity: p}}>{letter === ' ' ? '\u00a0' : letter}</span></span>;
  })}</div>;
}

function Mist({strength = 1}: {strength?: number}) {
  const f = useCurrentFrame();
  return <div className="s-mist" style={{opacity: strength, transform: `translate(${Math.sin(f / 120) * 90}px,${Math.cos(f / 170) * 30}px) rotate(-14deg)`}}/>;
}

function Dots({x = 960, y = 540, radius = 230, disperse = 0, count = 520}: {x?: number; y?: number; radius?: number; disperse?: number; count?: number}) {
  const f = useCurrentFrame();
  const points = Array.from({length: count}, (_, i) => {
    const v = 1 - 2 * (i + .5) / count;
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const r = Math.sqrt(1 - v * v);
    const a = angle + f * .004;
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    const rotate = f * .001;
    const py = v * Math.cos(rotate) - pz * Math.sin(rotate);
    const z = v * Math.sin(rotate) + pz * Math.cos(rotate);
    const perspective = 1 / (1 - z * .25);
    const scale = radius * (1 + disperse * (1 + (i % 11) / 4));
    return {i, z, x: x + px * scale * perspective, y: y + py * scale * perspective, r: (1.5 + (z + 1) * 1.4) * perspective, opacity: (.12 + (z + 1) * .25) * (1 - disperse * .8)};
  }).sort((a, b) => a.z - b.z);
  return <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, overflow: 'visible'}}>{points.map(p => <circle key={p.i} cx={p.x} cy={p.y} r={p.r} fill={p.i % 7 === 0 ? blue : '#405c77'} opacity={p.opacity}/>)}</svg>;
}

function Intro() {
  const f = useCurrentFrame();
  return <Shot length={120}><div className="s-center" style={{opacity: linear(f, [0, 20, 90, 119], [0, 1, 1, 0]), fontSize: 37, fontWeight: 400, letterSpacing: '-.025em'}}>いつものDSHを、もっと軽く。</div></Shot>;
}

function Brand() {
  const f = useCurrentFrame();
  return <Shot length={240} style={{background: '#eff6ff'}}><Ribbon/><div className="s-brand s-center" style={{transform: `translate(-50%,-50%) scale(${mix(f, [0, 200], [.82, 1.05])})`, color: '#ffffff', textShadow: '0 2px 18px #24568b22'}}><Img src={staticFile('icon.png')} style={{width: 74, height: 74, marginRight: 23}}/><span>rdsh</span></div></Shot>;
}

function TimeCopy() {
  const f = useCurrentFrame();
  return <Shot length={180}><Mist strength={.6}/><div style={{position: 'absolute', left: 0, right: 0, top: 362, textAlign: 'center'}}><Words at={0}>待つ時間を、</Words><Words at={45}>作る時間へ。</Words></div><div style={{position: 'absolute', left: 685, top: 668, width: 550, height: 3, background: blue, transform: `scaleX(${enter(f, 75)})`, transformOrigin: 'left', opacity: .22}}/></Shot>;
}

function Console() {
  const f = useCurrentFrame();
  const first = 'rdsh search TODO --dir .';
  const second = 'rdsh tokens README.md';
  const command = (text: string, start: number) => text.slice(0, Math.floor(linear(f, [start, start + 60], [0, text.length])));
  return <Shot length={360}><Mist strength={.68}/><div style={{position: 'absolute', top: 144, width: '100%', textAlign: 'center'}}><Words size={61}>必要な処理だけ、すばやく。</Words></div>
    <div className="s-perspective"><div className="s-console" style={{transform: `translateY(${mix(f, [0, 320], [105, -20])}px) scale(${mix(f, [0, 300], [.83, 1.04])}) rotateX(${mix(f, [0, 160], [13, 2])}deg) rotateY(${mix(f, [0, 250], [-6, 1])}deg)`}}>
      <div className="s-console-top"><svg width="26" height="23" viewBox="0 0 26 23"><path d="M3 4L10 11L3 18M13 18H23" fill="none" stroke={blue} strokeWidth="2.3"/></svg><span>rdsh-demo</span><span className="s-console-version">{cli.version}</span></div>
      <div className="s-console-body"><div className="s-command"><span>$</span> {command(first, 22)}<span className="s-caret" style={{opacity: f < 86 && f % 40 < 23 ? 1 : 0}}/></div><div className="s-output" style={{opacity: enter(f, 88)}}>{cli.search}</div><div className="s-command" style={{marginTop: 54, opacity: enter(f, 155)}}><span>$</span> {command(second, 168)}<span className="s-caret" style={{opacity: f > 168 && f < 232 && f % 40 < 23 ? 1 : 0}}/></div><div className="s-output" style={{opacity: enter(f, 234)}}>{cli.tokens}</div></div>
    </div></div><div className="s-demo">デモデータ</div></Shot>;
}

function Speed() {
  const f = useCurrentFrame();
  return <Shot length={240}><Mist strength={.7}/><div style={{opacity: mix(f, [0, 90], [1, .46])}}><Dots x={960} y={540} radius={250 + mix(f, [0, 170], [0, 140])} disperse={mix(f, [110, 235], [0, .52])}/></div>
    <div className="s-center" style={{textAlign: 'center', top: '48%'}}><div style={{transform: `scale(${mix(f, [0, 110], [.78, 1])})`, opacity: enter(f, 16)}}><span style={{fontSize: 188, fontWeight: 500, letterSpacing: '-.075em', color: blue}}>0.90</span><span style={{fontSize: 64, marginLeft: 18, color: blue}}>ms</span></div><Words at={45} size={46}>始めるまでを、短く。</Words></div>
    <div style={{position: 'absolute', bottom: 116, width: '100%', textAlign: 'center', color: '#6e7b8b', fontSize: 23, lineHeight: 1.7}}>--version の起動中央値<br/>Linux x86_64 · READMEに記載の5回計測</div>
  </Shot>;
}

function ProgressCopy() {
  const f = useCurrentFrame();
  return <Shot length={180}><Mist strength={.5}/><div className="s-center"><div style={{position: 'relative'}}><div style={{position: 'absolute', bottom: 24, left: 0, width: '100%', height: 81, background: '#cde2fa', transform: `scaleX(${enter(f, 55)})`, transformOrigin: 'left', opacity: .62}}/><Words>進捗に、見通しを。</Words></div></div></Shot>;
}

function Dashboard() {
  const f = useCurrentFrame();
  const zoom = mix(f, [0, 420], [.85, 1.03]);
  const pan = mix(f, [180, 370], [0, -285]);
  return <Shot length={480}><Mist strength={.85}/><div style={{position: 'absolute', top: 123, width: '100%', textAlign: 'center', opacity: linear(f, [0, 35, 140, 190], [0, 1, 1, 0])}}><Words size={58}>タスクと指標を、ひとつに。</Words></div>
    <div className="s-perspective"><div className="s-dashboard" style={{transform: `translateY(${pan + mix(f, [0, 120], [100, 0])}px) scale(${zoom}) rotateX(${mix(f, [0, 260], [12, 0])}deg) rotateY(${mix(f, [0, 340], [-5, 2])}deg)`}}>
      <div className="s-app-heading"><Img src={staticFile('icon.png')} style={{width: 34, height: 34}}/>rdsh-demo<span>プロジェクト</span></div>
      <Img src={staticFile('project-tasks.png')} style={{width: 1540, display: 'block'}}/>
      <Img src={staticFile('project-metrics.png')} style={{width: 1540, display: 'block', marginTop: 26}}/>
    </div></div><div className="s-demo">タスクと指標はデモデータ</div></Shot>;
}

function AnswerCopy() {
  const f = useCurrentFrame();
  return <Shot length={180}><Mist strength={.56}/><div style={{opacity: mix(f, [0, 130], [.8, .2])}}><Dots x={1470} y={570} radius={118} disperse={mix(f, [90, 175], [0, .7])} count={300}/></div><div className="s-center"><Words>問いかけに、答える。</Words></div></Shot>;
}

function Cursor({x, y, click}: {x: number; y: number; click: number}) {
  return <div style={{position: 'absolute', left: x, top: y}}>{click > 0 && <div style={{position: 'absolute', left: -26, top: -26, border: '2px solid #1c6aca', borderRadius: '50%', width: 76, height: 76, transform: `scale(${1 + click})`, opacity: 1 - click}}/>}<svg width="36" height="42" viewBox="0 0 32 38" style={{filter: 'drop-shadow(0 2px 2px #37537335)'}}><path d="M3 2L4 30L12 22L18 35L24 32L18 20L29 19Z" fill="#fff" stroke="#214369" strokeWidth="2"/></svg></div>;
}

function Answer() {
  const f = useCurrentFrame();
  const saved = f >= 246;
  return <Shot length={420}><Mist strength={.9}/><div style={{position: 'absolute', top: 124, width: '100%', textAlign: 'center'}}><Words size={59}>{saved ? '方針が、ひとつに。' : '質問から、次の一歩へ。'}</Words></div>
    <div className="s-perspective"><div className="s-answer" style={{transform: `translateY(${mix(f, [0, 100], [80, 0])}px) scale(${mix(f, [0, 400], [.86, 1.05])}) rotateY(${mix(f, [0, 300], [5, -1])}deg)`, height: mix(f, [246, 290], [429, 210])}}>
      <Img src={staticFile(saved ? 'question-saved.png' : 'question-draft.png')} style={{width: 1500, display: 'block'}}/>
      {!saved && f > 96 && <Cursor x={mix(f, [96, 223], [1240, 82])} y={mix(f, [96, 223], [485, 317])} click={f >= 225 ? linear(f, [225, 245], [0, 1]) : 0}/>}
    </div></div>
    {saved && <div style={{position: 'absolute', top: 708, width: '100%', textAlign: 'center', opacity: enter(f, 258), transform: `translateY(${(1 - enter(f, 258)) * 16}px)`, color: blue, fontSize: 31}}>✓ 回答を保存しました</div>}
    <div className="s-demo">架空の質問と回答</div>
  </Shot>;
}

function Mobile() {
  const f = useCurrentFrame();
  return <Shot length={360}><Mist strength={.7}/><div style={{position: 'absolute', left: 220, top: 360, width: 740}}><Words size={79}>机を離れても。</Words><div style={{opacity: enter(f, 75), marginTop: 26, fontSize: 35, color: '#6e7b8b', fontWeight: 400}}>進捗と質問を、手元で。</div><div style={{marginTop: 82, fontSize: 21, color: '#7c8998', opacity: enter(f, 90)}}>Tailscaleの接続設定が必要です。</div></div>
    <div className="s-perspective"><div className="s-phone" style={{transform: `translateY(${mix(f, [0, 240], [80, -12])}px) rotateY(${mix(f, [0, 280], [-21, -8])}deg) rotateZ(${mix(f, [0, 320], [8, -5])}deg) scale(${mix(f, [0, 300], [.88, 1])})`}}>
      <div className="s-phone-screen"><Img src={staticFile('project-mobile.png')} style={{width: 390, height: 844, position: 'absolute', opacity: 1 - linear(f, [165, 195], [0, 1])}}/><Img src={staticFile('project-mobile-question.png')} style={{width: 390, height: 844, position: 'absolute', opacity: linear(f, [165, 195], [0, 1])}}/></div><div className="s-phone-camera"/>
    </div></div><div className="s-demo">スマホ幅での表示デモ</div></Shot>;
}

function Closing() {
  const f = useCurrentFrame();
  return <Shot length={360} style={{background: '#eff6ff'}}><div style={{opacity: mix(f, [0, 200], [1, .75])}}><Ribbon close/></div><div className="s-close-content" style={{opacity: enter(f, 30)}}><div className="s-brand" style={{color: '#174e7a'}}><Img src={staticFile('icon.png')} style={{width: 74, height: 74, marginRight: 22}}/><span>rdsh</span></div><div style={{marginTop: 25, color: '#174e7a', fontSize: 43}}>軽やかに、始めよう。</div></div>
    <div style={{position: 'absolute', bottom: 122, width: '100%', textAlign: 'center', opacity: enter(f, 90)}}><div className="s-install">rdsh setup --web</div><div style={{fontSize: 27, marginTop: 23, color: '#174e7a'}}>github.com/jimoto-no-llm/rustdsh</div></div><div style={{position: 'absolute', bottom: 36, width: '100%', textAlign: 'center', fontSize: 17, color: '#587997'}}>独立したコミュニティプロジェクト</div>
  </Shot>;
}

function StylishIntro() {
  const [handle] = useState(() => delayRender('Typography for the new film'));
  useEffect(() => {
    Promise.all([document.fonts.load('400 50px NotoFilm'), document.fonts.load('500 100px InstrumentFilm')]).then(() => continueRender(handle));
  }, [handle]);
  return <AbsoluteFill className="s-film">
    <Sequence from={0} durationInFrames={120}><Intro/></Sequence>
    <Sequence from={120} durationInFrames={240}><Brand/></Sequence>
    <Sequence from={360} durationInFrames={180}><TimeCopy/></Sequence>
    <Sequence from={540} durationInFrames={360}><Console/></Sequence>
    <Sequence from={900} durationInFrames={240}><Speed/></Sequence>
    <Sequence from={1140} durationInFrames={180}><ProgressCopy/></Sequence>
    <Sequence from={1320} durationInFrames={480}><Dashboard/></Sequence>
    <Sequence from={1800} durationInFrames={180}><AnswerCopy/></Sequence>
    <Sequence from={1980} durationInFrames={420}><Answer/></Sequence>
    <Sequence from={2400} durationInFrames={360}><Mobile/></Sequence>
    <Sequence from={2760} durationInFrames={360}><Closing/></Sequence>
    <Audio src={staticFile('stylish-soundtrack.wav')}/>
  </AbsoluteFill>;
}

registerRoot(() => <Composition id="RdshStylish" component={StylishIntro} width={1920} height={1080} fps={FPS} durationInFrames={TOTAL}/>);
